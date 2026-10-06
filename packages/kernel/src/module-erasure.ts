/**
 * Subject erasure inside a module's OWN tables (#2068) — the half of open question 17 that
 * K-37 left named and unbuilt.
 *
 * `shredSubject` redacts the spine and destroys the key that seals the platform's copies. A
 * module's rows were outside that, and §13.1 said so (limit 2). This file brings them in, two
 * ways, both run by the kernel in the SAME transaction as the spine redaction and before the
 * key is destroyed:
 *
 * - **Declared.** An entity names its subject columns beside its `erasable` fields
 *   (`erasure: { subjects }`, `subject-erasure.ts` in contracts), and the kernel blanks those
 *   fields — or deletes the row — wherever a subject column equals the id. No module code
 *   runs, so a vertical gets the right behaviour by declaring, and a declaration cannot forget
 *   a column the way a hand-written UPDATE can.
 * - **A hook.** `onSubjectErased(ctx, { subjectId })` on the registration, for a link the row
 *   does not hold itself (a rating reached through its conversation). It is narrow on purpose:
 *   a `sql` that reaches the module's own tables and nothing else, and `now()`. No emit — an
 *   event about the erasure would be a new immutable copy of what is being erased — no
 *   check, grant, link or platform request, and no await: it is synchronous, so it runs inside
 *   the erasure's one transaction and nothing interleaves with it.
 *
 * **Failure is all or nothing.** A hook that throws rolls the whole scope-side unit back, the
 * spine redaction with it, and the erasure throws before the key is touched or a receipt is
 * written. Nothing claims an erasure that did not happen, and a re-run converges: a declared
 * blank skips rows already blank, and a hook is idempotent by contract.
 *
 * **Derived stores.** A search index over an erased column is kept in step by its own triggers,
 * but FTS5 keeps a deleted row's terms in older index segments until they merge — the words
 * are still in the database file, findable by anyone reading the shadow tables. So the erasure
 * runs with FTS5's `secure-delete` on for the indexes over the erasing modules' tables, which
 * removes each entry where it sits rather than recording its deletion. A list index is an ordinary b-tree and loses the old value with the
 * UPDATE. What neither reaches — free pages SQLite has not reused, and attachment text — is
 * written down in kernel-design.md §13.1 rather than implied.
 */
import {
  namesSpineTable,
  substratError,
  subjectErasureDeclaration,
  tokenizeSql,
  type ErasedEntityCount,
  type ErasureHookCount,
  type SubjectErasureDeclaration,
  type UnreachedEntity,
} from '@substrat-run/contracts';
import type { ModuleRegistration, ScopedSql, SqlValue } from './scope-host.js';
import type { SearchIndexPlan } from './search-index.js';
import { guardSpine } from './spine-guard.js';
import { assertSqlIdentifier } from './sql-identifier.js';
import { assertTablesOwned, migrationDdl } from './table-ownership.js';

/** What a module's `onSubjectErased` hook is handed — and all it is handed. */
export interface SubjectErasureContext {
  /**
   * The module's own tables, and only those — the ones its migrations create: a statement
   * naming any other table in the scope (another module's, a view, a TEMP object, the spine)
   * is refused before it runs, reads included. Only `SELECT`, `UPDATE`, `DELETE`, `INSERT` and
   * `REPLACE`; no `WITH`, no DDL, no `PRAGMA`. Revoked when the hook returns: a call after that
   * throws and writes nothing.
   */
  readonly sql: ScopedSql;
  /** The erasure's instant, the same one the spine's tombstones carry. Revoked with `sql`. */
  now(): string;
}

/**
 * A module's own erasure step (#2068). Synchronous and returning nothing — a promise, an
 * iterator or any other returned value refuses the whole erasure — and
 * idempotent: an erasure is re-run after any failure, so a second call for the same subject
 * must find nothing left to do.
 */
export type OnSubjectErased = (ctx: SubjectErasureContext, subject: { readonly subjectId: string }) => void;

/** One registered module's erasure, validated once at registration. */
export interface ModuleErasurePlan {
  readonly moduleId: string;
  readonly declaration: SubjectErasureDeclaration;
  readonly hook?: OnSubjectErased;
  /**
   * The tables this module's erasure may touch, lowercased: the declaration's, each one VERIFIED
   * at registration to be created by the module's own migrations. The hook's whole reach.
   */
  readonly ownTables: ReadonlySet<string>;
}

/** What the module half of one erasure did — the receipt's three new lines. */
export interface ModuleErasureCounts {
  verticalRows: ErasedEntityCount[];
  hookRows: ErasureHookCount[];
  unreachedEntities: UnreachedEntity[];
}

/**
 * The tables a module's own migration TEXT creates, lowercased — read at registration, where no
 * scope exists yet, as early feedback only: it can refuse a module whose erasure names a table it
 * plainly never creates, and it never grants anything. `CREATE TABLE IF NOT EXISTS` on another
 * module's table reads as a creation here and creates nothing in a scope, which is why the
 * authority is the ownership each scope RECORDS as its migrations run (`table-ownership.ts`),
 * checked by the erasure itself before it writes.
 */
export function tablesCreatedBy(migrations: readonly { readonly sql: string }[]): Set<string> {
  const owned = new Set<string>();
  for (const migration of migrations) {
    const ddl = migrationDdl(migration.sql);
    for (const t of ddl.creates) owned.add(t);
    for (const r of ddl.renames) if (owned.delete(r.from)) owned.add(r.to);
    for (const t of ddl.drops) owned.delete(t);
  }
  return owned;
}

/**
 * The erasure plan for one registration, or undefined when it has nothing to erase. Throws,
 * at registration, for every way a module can claim an erasure it cannot deliver, or one that
 * would reach past itself:
 *
 * - a hook with no `manifest.erasure` — the hook's reach IS that block's `tables`, and a hook
 *   with no reach declared is refused rather than handed the whole scope;
 * - an entity declared `custom` with no hook to reach it;
 * - an entity the erasure would write (`blank`, `delete`, `custom`) on a table the module's own
 *   migrations do not create, and — when there is a hook — any table in its reach that they do
 *   not create. The declaration is a claim; the migrations are what the kernel ran. A misdeclared
 *   entity naming another module's table would otherwise have that table erased through the
 *   kernel's own handle. An `unreached` entity writes nothing and is not held to it.
 */
export function moduleErasurePlan(registration: ModuleRegistration): ModuleErasurePlan | undefined {
  const { manifest, onSubjectErased: hook } = registration;
  if (hook !== undefined && typeof hook !== 'function') {
    throw new Error(`${manifest.id}: onSubjectErased must be a function`);
  }
  if (!manifest.erasure) {
    if (hook) {
      throw new Error(
        `${manifest.id}: onSubjectErased is registered but the manifest declares no \`erasure\` — the ` +
          "hook's reach is that block's `tables`. Spread `manifestEntities(...)` into the manifest",
      );
    }
    return undefined;
  }
  const declaration = subjectErasureDeclaration.parse(manifest.erasure);
  const custom = declaration.entities.filter((e) => e.mode === 'custom');
  if (custom.length && !hook) {
    throw new Error(
      `${manifest.id}: ${custom.map((e) => e.entityType).join(', ')} declare${custom.length === 1 ? 's' : ''} ` +
        "`erasure: { mode: 'custom' }` but the module registers no onSubjectErased hook to reach them",
    );
  }
  const created = tablesCreatedBy(registration.migrations ?? []);
  const claimed = [
    ...declaration.entities.filter((e) => e.mode !== 'unreached').map((e) => e.table),
    ...(hook ? declaration.tables : []),
  ];
  const foreign = [...new Set(claimed.filter((t) => !created.has(t.toLowerCase())))];
  if (foreign.length) {
    throw new Error(
      `${manifest.id}: its erasure names ${foreign.map((t) => `'${t}'`).join(', ')}, which its own migrations ` +
        'do not create — an erasure reaches only the tables a module owns. Create the table in this ' +
        "module's migrations, or leave the entity without an `erasure`",
    );
  }
  return {
    moduleId: manifest.id,
    declaration,
    ...(hook ? { hook } : {}),
    ownTables: new Set(claimed.map((t) => t.toLowerCase())),
  };
}

/** The statements a hook may run. Everything else — DDL, PRAGMA, ATTACH, VACUUM, WITH — is refused. */
const HOOK_VERBS = new Set(['select', 'update', 'delete', 'insert', 'replace']);

/** The only table-valued functions a hook may name in a FROM: they read the row's own JSON. */
const TABLE_FUNCTIONS = new Set(['json_each', 'json_tree']);

/** Words that end a FROM list (or an UPDATE / INTO target) — what follows them is no table. */
const ENDS_TABLE_LIST = new Set([
  'set', 'where', 'on', 'using', 'group', 'order', 'limit', 'values', 'select', 'returning',
  'union', 'except', 'intersect', 'default', 'having', 'window', 'left', 'right', 'full',
  'inner', 'cross', 'natural', 'outer',
]);

/** The conflict clause words between `UPDATE` and its table: `UPDATE OR IGNORE t`. */
const CONFLICT_WORDS = new Set(['or', 'rollback', 'abort', 'replace', 'fail', 'ignore']);

/**
 * Refuse a hook statement that reaches past the module's own tables (#2068).
 *
 * An ALLOWLIST, judged where a table can stand: every name in a table position — after `FROM`,
 * `JOIN`, `INTO` and `UPDATE`, and each further name in a comma-joined `FROM` list, at any
 * nesting depth — must be one of `own`, unqualified. Whatever else the scope holds — another
 * module's table, a view, a TEMP object, the spine — is refused without having to be listed,
 * so nothing the schema grows later widens the reach. Also refused: a qualified name
 * (`main.x`, `temp.x`), a table-valued function other than `json_each`/`json_tree`, `WITH`
 * (a CTE could shadow an own table's name), and any spine- or `sqlite_`-prefixed name
 * anywhere. Every statement chained after a `;` starts with an allowed verb.
 *
 * It errs toward refusing: a name in a table position that is not a table at all
 * (`a IS DISTINCT FROM b`) is held to the allowlist too, and fails closed with a message.
 */
export function assertWithinErasureReach(moduleId: string, sql: string, own: ReadonlySet<string>): void {
  const refuse = (what: string): never => {
    throw substratError(
      'forbidden',
      `${moduleId}: onSubjectErased reaches its own module's tables only — refused ${what}`,
      { reason: 'erasure_reach' },
    );
  };
  interface Frame {
    expect: boolean;
    clause: 'from' | 'into' | 'update' | null;
    inList: boolean;
  }
  const tokens = tokenizeSql(sql, { punctuation: true });
  const stack: Frame[] = [];
  let f: Frame = { expect: false, clause: null, inList: false };
  let start = true;
  let prev = '';
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]!;
    if (token.punct) {
      if (token.text === ';') {
        start = true;
        stack.length = 0;
        f = { expect: false, clause: null, inList: false };
      } else if (token.text === '(') {
        // A subquery in a FROM position stands where a table would: once it closes, the outer
        // list continues after it, so a `, other` that follows is still judged.
        stack.push(f.expect ? { expect: false, clause: f.clause, inList: true } : { ...f, expect: false });
        f = { expect: false, clause: null, inList: false };
      } else if (token.text === ')') {
        f = stack.pop() ?? { expect: false, clause: null, inList: false };
      } else if (token.text === ',' && f.inList && f.clause === 'from') {
        f = { ...f, expect: true, inList: false };
      }
      continue;
    }
    const word = token.quoted ? '' : token.text.toLowerCase();
    for (const part of token.text.split('.')) {
      const name = part.toLowerCase();
      if (namesSpineTable(name) || name.startsWith('sqlite_')) refuse(`'${part}'`);
    }
    if (start) {
      start = false;
      if (!HOOK_VERBS.has(word)) refuse(`the statement: ${sql.slice(0, 60)}`);
    }
    if (word === 'with') refuse('WITH — a common table expression could shadow a table name');
    if (f.expect) {
      if (f.clause === 'update' && CONFLICT_WORDS.has(word)) continue;
      const next = tokens[i + 1];
      if (f.clause === 'from' && next?.punct && next.text === '(') {
        if (!TABLE_FUNCTIONS.has(word)) refuse(`the table-valued function '${token.text}'`);
      } else if (token.text.includes('.')) {
        refuse(`the qualified name '${token.text}'`);
      } else if (!own.has(token.text.toLowerCase())) {
        refuse(`'${token.text}', which is not one of its tables`);
      }
      f = { ...f, expect: false, inList: true };
    } else if (word === 'from' || word === 'join') {
      f = { expect: true, clause: 'from', inList: false };
    } else if (word === 'into') {
      f = { expect: true, clause: 'into', inList: false };
    } else if (word === 'update' && prev !== 'do') {
      f = { expect: true, clause: 'update', inList: false };
    } else if (f.inList && ENDS_TABLE_LIST.has(word)) {
      f = { ...f, inList: false };
    }
    prev = word;
  }
}

/**
 * Refuse the erasure when a TEMP object carries the name of a table it is about to touch: an
 * unqualified name resolves to the temp schema first, so the declared write or the hook would
 * land on the shadow. A host whose SQLite will not show its temp schema (a Durable Object) has
 * none for anything to have made.
 */
function assertNoTempShadow(sql: ScopedSql, tables: ReadonlySet<string>): void {
  let temp: { name: string }[];
  try {
    temp = sql.query<{ name: string }>('SELECT name FROM temp.sqlite_master');
  } catch {
    return;
  }
  const shadow = temp.map((r) => r.name).find((n) => tables.has(n.toLowerCase()));
  if (shadow) {
    throw substratError(
      'precondition_failed',
      `erasure: a TEMP object '${shadow}' shadows a module table this erasure would touch — nothing was erased`,
    );
  }
}

/**
 * What the statement just run changed, as SQLite counts it: `changes()` is that statement's own
 * rows and never a trigger's; `total_changes()` is the connection's running count, compared and
 * never reported. Read rather than taken from the handle's exec result because the two adapters
 * disagree there — a Durable Object's `rowsWritten` counts every index and FTS trigger write
 * too — and a receipt must say the same number whichever host erased.
 */
function changeCounts(sql: ScopedSql): { changes: number; total: number } {
  const row = sql.query<{ c: number; t: number }>('SELECT changes() AS c, total_changes() AS t')[0];
  return { changes: row?.c ?? 0, total: row?.t ?? 0 };
}

/**
 * The oldest SQLite that may run an erasure over a search index (#2068): FTS5 `secure-delete`
 * arrived in 3.42.0, and an index deleted from under it is recorded at FTS5 format version 5,
 * which no older SQLite can read. A dump never carries a search index (it is rebuilt on load),
 * so the reader that matters is the runtime holding the scope's own file.
 */
export const SECURE_DELETE_MIN_SQLITE = '3.42.0';

/**
 * Switch `secure-delete` on for one index, or refuse the erasure if this SQLite cannot.
 *
 * A capability probe rather than a version check, because a Durable Object will not run
 * `sqlite_version()`. The probe is exact anyway: an FTS5 older than 3.42.0 has no
 * `secure-delete` command and rejects it, and that rejection comes before anything is written
 * to the index's table, so the erasure fails closed — nothing erased, and no index left at a
 * format the runtime holding it could not read back.
 */
function enableSecureDelete(sql: ScopedSql, idx: string): void {
  try {
    sql.exec(`INSERT INTO ${idx}(${idx}, rank) VALUES('secure-delete', 1)`);
  } catch (err) {
    throw substratError(
      'precondition_failed',
      `erasure: erasing from a search index needs FTS5 secure-delete (SQLite ${SECURE_DELETE_MIN_SQLITE}+), ` +
        `which this host's SQLite refused (${err instanceof Error ? err.message : String(err)}) — nothing was erased`,
    );
  }
}

/** A name the kernel interpolates — re-checked here, never trusted from a manifest. */
const ident = (name: string): string => assertSqlIdentifier('erasure', 'an identifier', name, 'a module erasure');

/**
 * Run the module half of one erasure: every declared entity, then every hook, with FTS5's
 * `secure-delete` on for the search indexes over those modules' tables. `sql` is the kernel's
 * own handle on the scope — never module code's — and the caller holds it inside the
 * transaction the spine redaction runs in, so a throw from here rolls both back.
 *
 * Order between the two halves: declared first, hooks after, so a hook reading a declared
 * entity sees it already blank and a hook that deletes cannot strand a declared blank. Order
 * between modules is registration order, which nothing here depends on: each touches its own
 * tables only.
 */
export function eraseSubjectFromModules(input: {
  readonly sql: ScopedSql;
  readonly plans: readonly ModuleErasurePlan[];
  readonly searchPlans: Iterable<SearchIndexPlan>;
  /** The module tables carrying archive/trash columns (#119), lowercased — `guardSpine`'s. */
  readonly statefulTables?: ReadonlySet<string>;
  readonly subjectId: string;
  readonly at: string;
  /** A registered module's migration text, for backfilling a scope migrated before ownership was recorded. */
  readonly migrationSqlOf: (moduleId: string, version: string) => string | undefined;
}): ModuleErasureCounts {
  const { sql, plans, subjectId, at } = input;
  const out: ModuleErasureCounts = { verticalRows: [], hookRows: [], unreachedEntities: [] };
  // Before anything is written: every table this erasure would touch must be recorded, in THIS
  // scope, as created by the erasing module's own migrations.
  for (const plan of plans) assertTablesOwned(sql, plan.moduleId, plan.ownTables, input.migrationSqlOf, at);
  if (plans.some((p) => p.ownTables.size > 0)) {
    assertNoTempShadow(sql, new Set(plans.flatMap((p) => [...p.ownTables])));
  }

  // FTS5 keeps a deleted row's terms in the older index segments until they merge, so an
  // erased word stays in the database file after search stops finding it. `secure-delete`
  // makes a delete remove the entry from the segment it sits in instead — at the cost of that
  // one entry, where a full merge ('optimize') rewrites the whole index (0.5 s at 100k rows,
  // measured). It is switched on lazily, for an index whose table this erasure is about to
  // change and no other, and off again at the end; a throw rolls the switch back with
  // everything else. Lazily because the switch leaves a row in the index's own config, which
  // SQLite will not let anyone remove: an erasure that holds nothing for the subject — the
  // common case, every scope it is not about — leaves every index exactly as it found it.
  const indexesOf = new Map<string, string[]>();
  for (const p of input.searchPlans) {
    const key = p.table.toLowerCase();
    const list = indexesOf.get(key) ?? [];
    list.push(ident(p.indexTable));
    indexesOf.set(key, list);
  }
  const secured = new Set<string>();
  const secure = (table: string): void => {
    for (const idx of indexesOf.get(table.toLowerCase()) ?? []) {
      if (secured.has(idx)) continue;
      enableSecureDelete(sql, idx);
      secured.add(idx);
    }
  };

  for (const plan of plans) {
    for (const entity of plan.declaration.entities) {
      if (entity.mode === 'unreached') {
        out.unreachedEntities.push({ module: plan.moduleId, entityType: entity.entityType });
        continue;
      }
      if (entity.mode === 'custom') continue;
      const table = ident(entity.table);
      const subjects = (entity.subjects ?? []).map(ident);
      const match = `(${subjects.map((s) => `${s} = ?`).join(' OR ')})`;
      const subjectParams = subjects.map(() => subjectId);
      // Only rows still holding something: a re-run changes nothing and counts zero.
      const cols = entity.fields.map((f) => ident(f.name));
      const blanks = entity.fields.map((f) => f.blank);
      const isDelete = entity.mode === 'delete';
      const filter = isDelete ? match : `${match} AND (${cols.map((c) => `${c} IS NOT ?`).join(' OR ')})`;
      const params = isDelete ? subjectParams : [...subjectParams, ...blanks];
      // The probe exists only to switch an index's secure-delete on lazily; a table no index
      // covers goes straight to its write.
      const indexed = indexesOf.has(table.toLowerCase());
      let rows = 0;
      if (!indexed || sql.query(`SELECT 1 FROM ${table} WHERE ${filter} LIMIT 1`, params).length > 0) {
        secure(table);
        if (isDelete) {
          sql.exec(`DELETE FROM ${table} WHERE ${filter}`, params);
        } else {
          sql.exec(`UPDATE ${table} SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE ${filter}`, [...blanks, ...params]);
        }
        rows = changeCounts(sql).changes;
      }
      out.verticalRows.push({ module: plan.moduleId, entityType: entity.entityType, mode: entity.mode, rows });
    }
  }

  const guarded = guardSpine(sql, input.statefulTables);
  for (const plan of plans) {
    if (!plan.hook) continue;
    const own = plan.ownTables;
    let rows = 0;
    // The hook's capability lives exactly as long as its synchronous run. A hook that kept
    // `ctx` — an async continuation, a handle stored on a global — and used it later would
    // write outside the erasure's transaction, after a refusal had rolled it back; revoked,
    // every later call throws and writes nothing.
    let live = true;
    const alive = (): void => {
      if (!live) {
        throw substratError(
          'forbidden',
          `${plan.moduleId}: onSubjectErased's ctx was used after the hook returned — it is valid only while the hook runs`,
          { reason: 'erasure_revoked' },
        );
      }
    };
    // `changes()` is the last WRITE's count, so a read run through `exec` would repeat the
    // previous one; `total_changes()` moving at all is what says a statement wrote.
    let total = changeCounts(sql).total;
    const hookSql: ScopedSql = {
      query: <T = Record<string, SqlValue>>(statement: string, params?: readonly SqlValue[]): T[] => {
        alive();
        assertWithinErasureReach(plan.moduleId, statement, own);
        return guarded.query<T>(statement, params);
      },
      exec: (statement: string, params?: readonly SqlValue[]) => {
        alive();
        assertWithinErasureReach(plan.moduleId, statement, own);
        // Any statement the hook runs may change any of its tables; secure their indexes first.
        for (const t of own) secure(t);
        guarded.exec(statement, params);
        const after = changeCounts(sql);
        const changes = after.total === total ? 0 : after.changes;
        total = after.total;
        rows += changes;
        return { changes };
      },
    };
    const ctx: SubjectErasureContext = {
      sql: hookSql,
      now: () => {
        alive();
        return at;
      },
    };
    let returned: unknown;
    try {
      returned = plan.hook(ctx, { subjectId });
    } finally {
      live = false;
    }
    if (returned !== undefined) {
      // Anything but `undefined` is a hook that did not finish in its synchronous run: a promise
      // (an async hook), an iterator (a generator hook, whose body has not even started), or a
      // value it meant as a result. Each refuses the whole erasure, before the key. A promise's
      // rejection is the module's — swallowed so it does not surface unhandled after the erasure
      // it belonged to has been refused and rolled back; its continuation can do nothing, `ctx`
      // being revoked above.
      if (returned !== null && typeof (returned as { then?: unknown }).then === 'function') {
        (returned as Promise<unknown>).then(undefined, () => undefined);
      }
      throw substratError(
        'precondition_failed',
        `${plan.moduleId}: onSubjectErased returned a value — it must run to completion synchronously and ` +
          "return nothing (no async, no generator), so it runs inside the erasure's one transaction",
      );
    }
    out.hookRows.push({ module: plan.moduleId, rows });
  }

  for (const idx of secured) sql.exec(`INSERT INTO ${idx}(${idx}, rank) VALUES('secure-delete', 0)`);
  return out;
}

/** Every row the module half changed — what the access log adds to "how much evidence this destroyed". */
export function moduleRowsErased(counts: ModuleErasureCounts): number {
  return [...counts.verticalRows, ...counts.hookRows].reduce((n, c) => n + c.rows, 0);
}

/**
 * Whether a host's reply carries the module half (#2068) in the shape this kernel wrote — what a
 * coordinator checks before destroying the key, so a host built before the half existed is
 * refused rather than read as having reached nothing.
 */
export function isModuleErasureCounts(value: unknown): value is ModuleErasureCounts {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return Array.isArray(v.verticalRows) && Array.isArray(v.hookRows) && Array.isArray(v.unreachedEntities);
}
