/**
 * The migration journal — derived, and the one artifact that stays a file.
 *
 * The manifest and the route table are pure functions of live objects, so they
 * are computed when the module loads. A journal cannot be: it is append-only,
 * frozen once shipped, and read by a human in a pull request.
 *
 * **Nobody writes the version number.** The model states the current shape; the
 * journal states what has already been applied. Reconstruct the second, diff
 * against the first, and if the diff is non-empty append exactly ONE entry with
 * a derived counter. Declaring a version is declaring a fact a diff already
 * knows — and hand-numbering has failed in practice: a production journal in a
 * real app ships two entries numbered 0010, because two people numbered by hand
 * in two branches.
 *
 * Two branches both generating `0003` collide in `journal.json`, which is the
 * right signal on an ordered append-only list. Resolution is mechanical: merge
 * the model, re-run, it renumbers.
 *
 * **One journal, or several.** A vertical composed of surfaces runs one
 * concatenated migration list built from several journals, and the kernel never
 * sorts it — so which journal an entry goes into IS the execution order, and the
 * counter is shared across all of them rather than derived from any one's
 * length. `MigrationPlanOptions.journals` is how that is stated; passing nothing
 * is the single-surface vertical, unchanged.
 *
 * **What this refuses.** Anything that would rewrite history or lose data: a
 * dropped table or column, a retyped column, a moved primary key, or a required
 * column added to a table that may already hold rows. Those are real decisions
 * (expand/contract, a rebuild, a backfill, a `renamedFrom` declaration) and a
 * generator that guessed at them would be guessing with somebody's data.
 */
import { z } from 'zod';
import { columnsOf, emitTables, primaryKeyConstraint, uniqueConstraints } from './emit-sql.js';
import { primaryKeyOf, type EntityDef } from '@substrat-run/contracts';
import { journalColumns, journalPrimaryKeys, journalUniques } from './journal.js';

export interface JournalEntry {
  /** Derived, monotonic, zero-padded: `0001`. Never authored. */
  readonly version: string;
  /** Human label for the diff, derived from what changed. */
  readonly slug: string;
  readonly sql: string;
  /**
   * Shipped. A released entry is frozen — the planner appends after it and never
   * touches it. Set by whatever ships the package, not by the generator.
   */
  readonly released?: boolean;
}

export interface Journal {
  readonly entries: readonly JournalEntry[];
}

/**
 * A vertical composed of surfaces does not have one journal, and the difference
 * is not cosmetic: the kernel runs `mod.migrations` in the order it is handed
 * them and never sorts by version, so **which journal an entry goes into is the
 * execution order**.
 *
 * Both options are optional, and a vertical with one journal passes neither —
 * that is the same call it makes today, answered the same way.
 */
export interface MigrationPlanOptions {
  /**
   * Every journal this vertical runs, by surface name, in the order the kernel
   * runs them. Given this, the planner reads the applied schema across ALL of
   * them (so a table another surface created is not diffed as missing) and
   * derives the next version from the highest prefix it can see anywhere (so a
   * six-journal vertical cannot mint a version one of the other five already
   * holds — a duplicate is a boot failure, not a renumbering).
   *
   * `entities` is then the WHOLE model, not one surface's slice: parent edges
   * resolve against the full registry, and a slice would read every other
   * surface's tables as dropped. The set must be whole too — including the
   * journal being appended to, and including a surface you are only now
   * starting (as an empty journal). A partial set is refused rather than
   * repaired: the order is the caller's, not the planner's.
   */
  readonly journals?: Readonly<Record<string, Journal>>;
  /**
   * Which journal in that set the new entry lands in. Required once a plan
   * creates a table, and refused rather than guessed — see `journals`.
   */
  readonly surface?: string;
}

export type MigrationPlan =
  | { readonly kind: 'up-to-date' }
  | { readonly kind: 'append'; readonly entry: JournalEntry }
  | { readonly kind: 'refused'; readonly reasons: readonly string[] };

const pad = (n: number) => String(n).padStart(4, '0');

/** The counter a version states, or `undefined` for something that is not one. */
const counterOf = (version: string): number | undefined => {
  if (!/^\d+$/.test(version)) return undefined;
  return Number.parseInt(version, 10);
};

/**
 * What one entry would have to say to bring the journal up to the model.
 *
 * Pure: same model + same journal → same plan, every time. It reads no clock and
 * mints no id, which is what lets the result be committed and diffed.
 */
export function planMigration<T extends Record<string, EntityDef>>(
  entities: T,
  journal: Journal,
  opts?: MigrationPlanOptions,
): MigrationPlan {
  // The set actually read, in the order the kernel runs it. With no `journals`
  // that is the one journal handed in, which is every caller that exists today.
  const named = opts?.journals ? Object.values(opts.journals) : undefined;
  const set = named ?? [journal];

  // `journals` IS the execution order, so the planner will not repair a partial
  // one by putting the stray journal somewhere. Appending it to the end would
  // replay an ALTER from a later surface before the CREATE it depends on, and
  // the reader would report a table it cannot see. Refused before the diff runs,
  // because a diff missing this journal's history proposes creating its tables.
  if (named && !named.includes(journal)) {
    return {
      kind: 'refused',
      reasons: [
        'the journal being appended to is not one of `journals`, and the set is the execution ' +
          'order — a planner that slotted it in somewhere would be picking that order for you. ' +
          'Pass the member itself: `planMigration(entities, journals[surface], { journals, ' +
          'surface })`',
      ],
    };
  }

  const journalSql = set.flatMap((j) => j.entries.map((e) => e.sql)).join('\n');
  const applied = journalColumns(journalSql);
  const desired = journalColumns(emitTables(entities));
  const appliedUniques = journalUniques(journalSql);
  const appliedKeys = journalPrimaryKeys(journalSql);

  // table name → the entity that owns it, so a diff can be reported in the
  // vocabulary the model uses rather than in raw table names.
  const owner = new Map<string, { name: string; entity: EntityDef }>();
  for (const [name, entity] of Object.entries(entities)) owner.set(entity.table, { name, entity });

  const statements: string[] = [];
  const changes: string[] = [];
  const created: string[] = [];
  const refusals: string[] = [];

  // -- gone from the model, still in the journal ------------------------------
  for (const table of applied.keys()) {
    if (desired.has(table)) continue;
    refusals.push(
      `table '${table}' is in the journal but no longer in the model — dropping a table is ` +
        'expand/contract, not a diff: retire it deliberately, or restore the entity',
    );
  }

  for (const [table, wanted] of desired) {
    const have = applied.get(table);

    // -- new table ------------------------------------------------------------
    if (!have) {
      const o = owner.get(table);
      if (!o) continue;
      // Built here rather than by re-emitting a one-entity registry: parent
      // edges resolve against the FULL model, and a subset would silently drop
      // the REFERENCES clause of every foreign key pointing outside it.
      const cols = [
        ...columnsOf(o.name, o.entity, entities).map((c) => `  ${c.ddl}`),
        ...primaryKeyConstraint(o.name, o.entity).map((k) => `  ${k}`),
        ...uniqueConstraints(o.name, o.entity).map((u) => `  ${u}`),
      ];
      statements.push(`CREATE TABLE ${table} (\n${cols.join(',\n')}\n);`);
      changes.push(`add-${table}`);
      created.push(table);
      continue;
    }

    // -- new columns on an existing table -------------------------------------
    const o = owner.get(table);
    if (!o) continue;
    const emitted = columnsOf(o.name, o.entity, entities);

    // `{ current: previous }`, kept only for names the journal still holds. A
    // declaration whose old name has already gone is spent, not wrong — the
    // rename shipped, and the entry is now a gravestone the model may delete.
    const renames = new Map<string, string>();
    for (const [current, previous] of Object.entries(o.entity.renamedFrom ?? {})) {
      if (typeof previous !== 'string') continue;
      if (!emitted.some((c) => c.name === current)) {
        refusals.push(
          `'${table}.${current}' is declared as renamed from '${previous}', but no such field ` +
            'exists in the model — a rename names the field it renamed TO',
        );
        continue;
      }
      if (have.has(previous) && !have.has(current)) renames.set(current, previous);
    }

    for (const [current, previous] of renames) {
      statements.push(`ALTER TABLE ${table} RENAME COLUMN ${previous} TO ${current};`);
      changes.push(`rename-${table}-${previous}-to-${current}`);
    }

    for (const col of emitted) {
      if (have.has(col.name)) continue;
      // A renamed column is not a new one — emitting both would add it twice.
      if (renames.has(col.name)) continue;
      if (col.requiredWithoutDefault) {
        refusals.push(
          `'${table}.${col.name}' is required and has no default, and '${table}' already exists — ` +
            'SQLite cannot add such a column to a table that may hold rows. Make the field ' +
            'nullable, give it a default, or backfill it in a hand-written entry',
        );
        continue;
      }
      statements.push(`ALTER TABLE ${table} ADD COLUMN ${col.ddl};`);
      changes.push(`add-${table}-${col.name}`);
    }

    // -- columns the model dropped --------------------------------------------
    const renamedAway = new Set(renames.values());
    for (const name of have) {
      if (emitted.some((c) => c.name === name)) continue;
      // Accounted for: it did not go away, it got a new name.
      if (renamedAway.has(name)) continue;
      refusals.push(
        `'${table}.${name}' is in the journal but no longer in the model — a diff cannot tell a ` +
          'rename from a drop-plus-add, and guessing wrong loses the data. Declare it with ' +
          `\`renamedFrom: { <newName>: '${name}' }\` on the entity, or retire the column deliberately`,
      );
    }

    // -- the primary key moved -------------------------------------------------
    // SQLite cannot alter a primary key at all: it needs the table rebuilt,
    // copied and renamed, which is a decision about live data rather than a
    // diff. Refused LOUDLY for the same reason as a late UNIQUE — a schema that
    // silently identifies rows differently than the journal does is how a
    // duplicate gets in, and #804 is exactly that failure going unseen.
    //
    // Both comparisons below translate the journal's column names through any
    // rename THIS plan is about to emit: the journal still names the old column,
    // and SQLite rewrites keys and constraints along with it. Comparing
    // untranslated makes a renamed key look like one the journal never had, and
    // refuses the very change that would fix it. Built from `renames`, not from
    // `renamedFrom`, so a spent declaration cannot translate a name the journal
    // is not actually renaming.
    const previousToCurrent = new Map([...renames].map(([current, previous]) => [previous, current]));
    const wantKey = primaryKeyOf(o.name, o.entity).join(', ');
    const haveKey = (appliedKeys.get(table) ?? []).map((c) => previousToCurrent.get(c) ?? c).join(', ');
    if (haveKey !== wantKey) {
      refusals.push(
        haveKey === ''
          ? `'${table}' exists in the journal with NO primary key, and the model identifies a row ` +
            `by (${wantKey}) — SQLite cannot add a primary key to an existing table. Rebuild it in ` +
            'a hand-written entry (create, copy, drop, rename), after deciding what to do with any ' +
            'duplicate rows it already holds'
          : `'${table}' is keyed by (${haveKey}) in the journal and by (${wantKey}) in the model — ` +
            'SQLite cannot change a primary key in place. Rebuild the table in a hand-written ' +
            'entry, or restore the declared key',
      );
    }

    // -- a key declared after the table already exists ------------------------
    // SQLite cannot ADD a UNIQUE constraint in place; it needs the table
    // rebuilt, copied and renamed. That is a decision about live data, not a
    // diff, so it is refused rather than guessed — and refused LOUDLY, because
    // silently reporting "up to date" over a missing uniqueness guarantee is
    // how a duplicate gets in.
    const wantUniques = uniqueConstraints(o.name, o.entity).map((u) =>
      (/UNIQUE\s*\(([^)]*)\)/i.exec(u)?.[1] ?? '')
        .split(',')
        .map((c) => c.trim())
        .filter(Boolean)
        .join(', '),
    );
    const haveUniques = new Set(
      [...(appliedUniques.get(table) ?? new Set<string>())].map((c) =>
        c
          .split(', ')
          .map((col) => previousToCurrent.get(col) ?? col)
          .join(', '),
      ),
    );
    for (const want of wantUniques) {
      if (haveUniques.has(want)) continue;
      refusals.push(
        `'${table}' declares a key over (${want}) that the journal does not have — SQLite ` +
          'cannot add a UNIQUE constraint to an existing table without rebuilding it. Rebuild ' +
          'it in a hand-written entry, or drop the key',
      );
    }
  }

  // -- a new table in a composed vertical, with no surface named ---------------
  // A `parents` edge emits a REFERENCES, and SQLite will happily create a child
  // before its parent: the migration passes and the first insert fails. Which
  // journal the CREATE lands in decides that, and it is not something a diff can
  // read off the model — so it is refused rather than guessed, the same way a
  // dropped column is. An ALTER needs no such choice, which is why only a
  // CREATE asks. Naming the surface is the caller saying they decided; the
  // planner does not check the decision (that would need the concatenation
  // order, which is the vertical's, not the model's).
  if (opts?.journals && created.length > 0 && opts.surface === undefined) {
    const names = Object.keys(opts.journals);
    refusals.push(
      `${created.map((t) => `'${t}'`).join(', ')} would be created, and this vertical runs ` +
        `${names.length} journals (${names.join(', ')}) — which one an entry goes into IS the ` +
        'execution order, and a generator that guessed could put a table before the parent it ' +
        "REFERENCES. State it: `planMigration(entities, journal, { journals, surface: '…' })`",
    );
  }
  // `hasOwn`, not `in`: `in` accepts every name on Object.prototype, so
  // `surface: 'toString'` would pass a check whose whole job is to make a typo
  // loud — and then name a journal `Object.keys` does not list.
  if (opts?.journals && opts.surface !== undefined && !Object.hasOwn(opts.journals, opts.surface)) {
    refusals.push(
      `surface '${opts.surface}' is not one of this vertical's journals ` +
        `(${Object.keys(opts.journals).join(', ') || 'none'}) — a surface you are starting is ` +
        'still one of them, so give it an empty journal rather than leaving it out: the set has ' +
        'to name every journal for a typo to be loud',
    );
  }

  if (refusals.length > 0) return { kind: 'refused', reasons: refusals };
  if (statements.length === 0) return { kind: 'up-to-date' };

  // The count is not the number. Six surfaces numbering from one shared counter
  // leave gaps in each journal, and a position-derived version would re-mint one
  // another surface already holds — which the adapter rejects at boot. Highest
  // seen anywhere, plus one. For a single contiguous journal that is the count,
  // so nothing about a one-surface vertical changes.
  const highest = set.reduce(
    (max, j) => j.entries.reduce((m, e) => Math.max(m, counterOf(e.version) ?? 0), max),
    0,
  );
  const version = pad(highest + 1);
  // One change names itself; several get a count, so the slug stays readable.
  const slug = changes.length === 1 ? (changes[0] as string) : `${changes[0]}-and-${changes.length - 1}-more`;
  return { kind: 'append', entry: { version, slug, sql: statements.join('\n\n') } };
}

export interface ParseJournalOptions {
  /**
   * The name of the surface this journal belongs to — say it, and the journal is
   * read as ONE of several sharing a counter rather than as the whole vertical's.
   *
   * That is the only thing it relaxes. A shared counter puts gaps in every
   * journal it feeds (`0043` then `0055`, because the numbers between went to
   * other surfaces), so position cannot derive the counter any more. What stays
   * is the detector that matters: **strictly increasing, never repeating**. Two
   * entries numbered `0010` in one surface is still the bad merge it always was;
   * `0010` in two different surfaces is history, from when they numbered
   * independently, and parses.
   */
  readonly surface?: string;
}

/** Parsed hostilely: it is our file, and it is also somebody's merge resolution. */
export function parseJournal(raw: unknown, opts?: ParseJournalOptions): Journal {
  const entry = z.object({
    version: z.string().regex(/^\d{4}$/, 'version is a derived four-digit counter'),
    slug: z.string().min(1),
    sql: z.string().min(1),
    released: z.boolean().optional(),
  });
  const parsed = z.object({ entries: z.array(entry) }).parse(raw);

  const where = opts?.surface === undefined ? 'journal' : `journal '${opts.surface}'`;
  let previous = 0;
  parsed.entries.forEach((e, i) => {
    if (opts?.surface === undefined) {
      if (e.version !== pad(i + 1)) {
        throw new Error(
          `${where}: entry ${i + 1} is numbered '${e.version}' — the counter is derived from ` +
            'position, so a gap or a duplicate means a bad merge, not a renumbering',
        );
      }
      return;
    }
    const counter = counterOf(e.version) ?? 0;
    if (counter <= previous) {
      throw new Error(
        `${where}: entry ${i + 1} is numbered '${e.version}'` +
          (previous === 0 ? '' : `, after '${pad(previous)}'`) +
          ' — a surface shares its counter with the other surfaces, so it may skip, but it ' +
          'must still climb from 0001: a repeat or a step backwards means a bad merge',
      );
    }
    previous = counter;
  });
  return parsed;
}
