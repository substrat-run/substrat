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
 * **What this refuses.** Anything that would rewrite history or lose data: a
 * dropped table or column, a retyped column, or a required column added to a
 * table that may already hold rows. Those are real decisions (expand/contract,
 * a backfill, a `renamedFrom` declaration) and a generator that guessed at them
 * would be guessing with somebody's data.
 */
import { z } from 'zod';
import { columnsOf, emitTables, uniqueConstraints } from './emit-sql.js';
import type { EntityDef } from '@substrat-run/contracts';
import { journalColumns } from './journal.js';

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

export type MigrationPlan =
  | { readonly kind: 'up-to-date' }
  | { readonly kind: 'append'; readonly entry: JournalEntry }
  | { readonly kind: 'refused'; readonly reasons: readonly string[] };

const pad = (n: number) => String(n).padStart(4, '0');

/**
 * What one entry would have to say to bring the journal up to the model.
 *
 * Pure: same model + same journal → same plan, every time. It reads no clock and
 * mints no id, which is what lets the result be committed and diffed.
 */
export function planMigration<T extends Record<string, EntityDef>>(
  entities: T,
  journal: Journal,
): MigrationPlan {
  const applied = journalColumns(journal.entries.map((e) => e.sql).join('\n'));
  const desired = journalColumns(emitTables(entities));

  // table name → the entity that owns it, so a diff can be reported in the
  // vocabulary the model uses rather than in raw table names.
  const owner = new Map<string, { name: string; entity: EntityDef }>();
  for (const [name, entity] of Object.entries(entities)) owner.set(entity.table, { name, entity });

  const statements: string[] = [];
  const changes: string[] = [];
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
        ...uniqueConstraints(o.name, o.entity).map((u) => `  ${u}`),
      ];
      statements.push(`CREATE TABLE ${table} (\n${cols.join(',\n')}\n);`);
      changes.push(`add-${table}`);
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

    // A key added after the fact needs a table rebuild in SQLite, which is a
    // decision rather than a diff.
    if (uniqueConstraints(o.name, o.entity).length > 0 && !have.has('__unique_checked__')) {
      // Nothing to do: the constraint shipped with the CREATE. Declared here so
      // the omission is visible rather than silent — SQLite cannot ADD a UNIQUE
      // constraint to an existing table without rebuilding it.
    }
  }

  if (refusals.length > 0) return { kind: 'refused', reasons: refusals };
  if (statements.length === 0) return { kind: 'up-to-date' };

  const version = pad(journal.entries.length + 1);
  // One change names itself; several get a count, so the slug stays readable.
  const slug = changes.length === 1 ? (changes[0] as string) : `${changes[0]}-and-${changes.length - 1}-more`;
  return { kind: 'append', entry: { version, slug, sql: statements.join('\n\n') } };
}

/** Parsed hostilely: it is our file, and it is also somebody's merge resolution. */
export function parseJournal(raw: unknown): Journal {
  const entry = z.object({
    version: z.string().regex(/^\d{4}$/, 'version is a derived four-digit counter'),
    slug: z.string().min(1),
    sql: z.string().min(1),
    released: z.boolean().optional(),
  });
  const parsed = z.object({ entries: z.array(entry) }).parse(raw);

  parsed.entries.forEach((e, i) => {
    if (e.version !== pad(i + 1)) {
      throw new Error(
        `journal: entry ${i + 1} is numbered '${e.version}' — the counter is derived from ` +
          'position, so a gap or a duplicate means a bad merge, not a renumbering',
      );
    }
  });
  return parsed;
}
