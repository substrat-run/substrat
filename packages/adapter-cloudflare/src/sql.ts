import { guardSpine, type RedactionSql, type ScopedSql, type SqlValue } from '@substrat-run/kernel';

/**
 * Adapts a Durable Object's `SqlStorage` to the kernel's `ScopedSql` contract
 * (`query`/`exec`). DO SQL is synchronous — `exec` returns a cursor eagerly —
 * so this mirrors the better-sqlite3 wrapper in `adapter-sqlite` one-to-one.
 *
 * Note (from the spikes): the DO runtime FORBIDS manual `BEGIN`/`COMMIT` via SQL.
 * Use `ctx.storage.transaction(async () => …)` — the ASYNC transaction API — which
 * commits on success and rolls back on a throw EVEN ACROSS an `await` (verified in
 * workerd). The ScopeDO therefore wraps each operation exactly like the pure
 * adapter's `BEGIN IMMEDIATE … COMMIT/ROLLBACK`: domain writes and outbox emits
 * commit or roll back together, with read-your-own-writes intact and no buffering.
 * (`transactionSync` also exists but is synchronous-only — it commits at the first
 * await, so it is not used for the async operation body.)
 *
 * `guardSpine` wraps it because this is the connection MODULE code holds (#954):
 * "never write `_substrat_*`" was a lint rule only, and lint never runs on the
 * hosted push path. The DO's own spine writes go through `this.sql` directly and
 * never pass through here.
 */
export function doScopedSql(
  sql: SqlStorage,
  /** #119: the module tables carrying archive/trash columns — `guardSpine` refuses positional writes to them. */
  statefulTables?: ReadonlySet<string>,
  /** #119: the kernel's integrity check, run after any runtime DDL — see `guardSpine`. */
  afterDdl?: () => void,
): ScopedSql {
  return guardSpine({
    query: <T = Record<string, SqlValue>>(q: string, params: readonly SqlValue[] = []): T[] =>
      sql.exec(q, ...(params as SqlValue[])).toArray() as T[],
    exec: (q: string, params: readonly SqlValue[] = []) => {
      const cursor = sql.exec(q, ...(params as SqlValue[]));
      return { changes: cursor.rowsWritten };
    },
  }, statefulTables, afterDdl);
}

/**
 * The kernel's OWN spine access (#1672) — `doScopedSql` without `guardSpine`, because these
 * are the kernel's writes to `_substrat_capabilities`, which module code may never make.
 * Never handed to module code.
 */
export function doSpineSql(sql: SqlStorage): ScopedSql {
  return {
    query: <T = Record<string, SqlValue>>(q: string, params: readonly SqlValue[] = []): T[] =>
      sql.exec(q, ...(params as SqlValue[])).toArray() as T[],
    exec: (q: string, params: readonly SqlValue[] = []) => {
      const cursor = sql.exec(q, ...(params as SqlValue[]));
      return { changes: cursor.rowsWritten };
    },
  };
}

/** The kernel's erasure walks over a DO's storage (#1632) — `redactionSqlOf`'s twin on the SQLite host. */
export function doRedactionSql(sql: SqlStorage): RedactionSql {
  return (q, params) => sql.exec(q, ...(params as SqlValue[])).toArray();
}

/**
 * The columns of table `name` as this DO built it, or `undefined` when it built no such table —
 * what a restore judges a dump's spine tables against (#1883), on a scope and on the directory
 * (#1898) alike, and on the directory every other table too (#1912). Read off an empty `SELECT`,
 * because DO SQLite restricts PRAGMA. The name is matched without case, as SQLite resolves a
 * table name: a dump's `_Substrat_tuples` is the kernel's tuples table.
 */
export function doBuiltColumnsOf(sql: SqlStorage, name: string): string[] | undefined {
  // SQLite's own tables and workerd's (`_cf_*`) are never ones this DO built, and an export never
  // dumps them, so a dump naming one is refused by name rather than failing on its SELECT (#1912).
  const built = sql
    .exec(
      `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? COLLATE NOCASE
          AND name NOT GLOB 'sqlite_*' AND name NOT GLOB '_cf_*'`,
      name,
    )
    .toArray();
  return built.length === 0 ? undefined : sql.exec(`SELECT * FROM "${name}" LIMIT 0`).columnNames;
}
