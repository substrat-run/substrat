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

/** What a module's `onSubjectErased` hook is handed — and all it is handed. */
export interface SubjectErasureContext {
  /**
   * The module's own tables, and only those: a statement naming any other table in the scope
   * — another module's, the spine, SQLite's own — is refused before it runs, reads included.
   * Only `SELECT`, `WITH`, `UPDATE`, `DELETE`, `INSERT` and `REPLACE`; no DDL, no `PRAGMA`.
   */
  readonly sql: ScopedSql;
  /** The erasure's instant, the same one the spine's tombstones carry. */
  now(): string;
}

/**
 * A module's own erasure step (#2068). Synchronous — a returned promise is refused — and
 * idempotent: an erasure is re-run after any failure, so a second call for the same subject
 * must find nothing left to do.
 */
export type OnSubjectErased = (ctx: SubjectErasureContext, subject: { readonly subjectId: string }) => void;

/** One registered module's erasure, validated once at registration. */
export interface ModuleErasurePlan {
  readonly moduleId: string;
  readonly declaration: SubjectErasureDeclaration;
  readonly hook?: OnSubjectErased;
}

/** What the module half of one erasure did — the receipt's three new lines. */
export interface ModuleErasureCounts {
  verticalRows: ErasedEntityCount[];
  hookRows: ErasureHookCount[];
  unreachedEntities: UnreachedEntity[];
}

/**
 * The erasure plan for one registration, or undefined when it has nothing to erase. Throws,
 * at registration, for the two ways a module can claim an erasure it cannot deliver:
 *
 * - a hook with no `manifest.erasure` — the hook's reach IS that block's `tables`, and a hook
 *   with no reach declared is refused rather than handed the whole scope;
 * - an entity declared `custom` with no hook to reach it.
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
  return { moduleId: manifest.id, declaration, ...(hook ? { hook } : {}) };
}

/** The statements a hook may run. Everything else — DDL, PRAGMA, ATTACH, VACUUM — is refused. */
const HOOK_VERBS = new Set(['select', 'with', 'update', 'delete', 'insert', 'replace']);

/**
 * Refuse a hook statement that reaches past the module's own tables.
 *
 * Judged by exclusion rather than by parsing where a table sits in the grammar: `foreign` is
 * every table and view the scope holds that the module does not own, and a statement naming
 * any of them ANYWHERE — a FROM, a JOIN, a subquery, a CTE body — is refused, as is any name
 * carrying the spine's or SQLite's prefix. That over-refuses a column or a string literal
 * spelled like another module's table, which fails closed and says why; it cannot
 * under-refuse, because a table the statement does not name is a table it cannot read.
 */
export function assertWithinErasureReach(
  moduleId: string,
  sql: string,
  foreign: ReadonlySet<string>,
): void {
  const tokens = tokenizeSql(sql, { punctuation: true });
  let start = true;
  for (const token of tokens) {
    if (token.punct) {
      // A statement after a `;` is judged from its own first word: the DO's `exec` runs every
      // statement in the string, so a PRAGMA chained after a SELECT must not slip past.
      if (token.text === ';') start = true;
      continue;
    }
    if (start) {
      start = false;
      if (token.quoted || !HOOK_VERBS.has(token.text.toLowerCase())) {
        throw substratError(
          'forbidden',
          `${moduleId}: onSubjectErased runs SELECT, UPDATE, DELETE and INSERT on its own tables only, not: ${sql.slice(0, 60)}`,
          { reason: 'erasure_reach' },
        );
      }
    }
    for (const part of token.text.split('.')) {
      const name = part.toLowerCase();
      if (namesSpineTable(name) || name.startsWith('sqlite_') || foreign.has(name)) {
        throw substratError(
          'forbidden',
          `${moduleId}: onSubjectErased reaches its own module's tables only, and '${part}' is not one of them`,
          { reason: 'erasure_reach' },
        );
      }
    }
  }
}

/** Every table and view in the scope, lowercased — what a hook's reach is judged against. */
function scopeTables(sql: ScopedSql): string[] {
  return sql
    .query<{ name: string }>("SELECT name FROM sqlite_master WHERE type IN ('table', 'view')")
    .map((r) => r.name.toLowerCase());
}

/**
 * The rows the statement just run changed, as SQLite counts them: `changes()`, which counts
 * the statement's own rows and never a trigger's. Read rather than taken from the handle's
 * exec result because the two adapters disagree there — a Durable Object's `rowsWritten`
 * counts every index and FTS trigger write too — and a receipt must say the same number
 * whichever host erased.
 */
function changedRows(sql: ScopedSql): number {
  return sql.query<{ n: number }>('SELECT changes() AS n')[0]?.n ?? 0;
}

/** The connection's running write count — compared, never reported (it counts trigger writes). */
function totalChanges(sql: ScopedSql): number {
  return sql.query<{ n: number }>('SELECT total_changes() AS n')[0]?.n ?? 0;
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

/** A table name the kernel interpolates — re-checked here, never trusted from a manifest. */
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
function ident(name: string): string {
  if (!IDENT.test(name)) throw substratError('internal', `erasure: '${name}' is not a plain SQL identifier`);
  return name;
}

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
}): ModuleErasureCounts {
  const { sql, plans, subjectId, at } = input;
  const out: ModuleErasureCounts = { verticalRows: [], hookRows: [], unreachedEntities: [] };
  let tables: string[] | undefined;

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
    indexesOf.set(key, [...(indexesOf.get(key) ?? []), ident(p.indexTable)]);
  }
  const secured: string[] = [];
  const secure = (table: string): void => {
    for (const idx of indexesOf.get(table.toLowerCase()) ?? []) {
      if (secured.includes(idx)) continue;
      enableSecureDelete(sql, idx);
      secured.push(idx);
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
      const blanks = entity.fields.map((f) => f.blank);
      const where =
        entity.mode === 'delete'
          ? { sql: match, params: subjectParams }
          : {
              sql: `${match} AND (${entity.fields.map((f) => `${ident(f.name)} IS NOT ?`).join(' OR ')})`,
              params: [...subjectParams, ...blanks],
            };
      let rows = 0;
      if (sql.query(`SELECT 1 FROM ${table} WHERE ${where.sql} LIMIT 1`, where.params).length > 0) {
        secure(table);
        if (entity.mode === 'delete') {
          sql.exec(`DELETE FROM ${table} WHERE ${where.sql}`, where.params);
        } else {
          const sets = entity.fields.map((f) => `${ident(f.name)} = ?`).join(', ');
          sql.exec(`UPDATE ${table} SET ${sets} WHERE ${where.sql}`, [...blanks, ...where.params]);
        }
        rows = changedRows(sql);
      }
      out.verticalRows.push({ module: plan.moduleId, entityType: entity.entityType, mode: entity.mode, rows });
    }
  }

  for (const plan of plans) {
    if (!plan.hook) continue;
    tables ??= scopeTables(sql);
    const own = new Set(plan.declaration.tables.map((t) => t.toLowerCase()));
    const foreign = new Set(tables.filter((t) => !own.has(t)));
    let rows = 0;
    const reach = (statement: string): void => assertWithinErasureReach(plan.moduleId, statement, foreign);
    const guarded = guardSpine(sql, input.statefulTables);
    const hookSql: ScopedSql = {
      query: <T = Record<string, SqlValue>>(statement: string, params?: readonly SqlValue[]): T[] => {
        reach(statement);
        return guarded.query<T>(statement, params);
      },
      exec: (statement: string, params?: readonly SqlValue[]) => {
        reach(statement);
        // Any statement the hook runs may change any of its tables; secure their indexes first.
        for (const t of own) secure(t);
        // `changes()` is the last WRITE's count, so a read run through `exec` would repeat the
        // previous one; `total_changes()` moving at all is what says this statement wrote.
        const before = totalChanges(sql);
        guarded.exec(statement, params);
        const changes = totalChanges(sql) === before ? 0 : changedRows(sql);
        rows += changes;
        return { changes };
      },
    };
    const returned: unknown = plan.hook({ sql: hookSql, now: () => at }, { subjectId });
    if (returned !== undefined && typeof (returned as { then?: unknown }).then === 'function') {
      // Its rejection, if any, is the module's — swallowed so it does not surface unhandled
      // after the erasure it belonged to has already been refused and rolled back.
      (returned as Promise<unknown>).then(undefined, () => undefined);
      throw substratError(
        'precondition_failed',
        `${plan.moduleId}: onSubjectErased returned a promise — it must be synchronous, so it runs inside the erasure's one transaction`
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
