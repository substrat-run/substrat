import { guardSpine, type ScopedSql, type SqlValue } from '@substrat-run/kernel';

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
export function doScopedSql(sql: SqlStorage): ScopedSql {
  return guardSpine({
    query: <T = Record<string, SqlValue>>(q: string, params: readonly SqlValue[] = []): T[] =>
      sql.exec(q, ...(params as SqlValue[])).toArray() as T[],
    exec: (q: string, params: readonly SqlValue[] = []) => {
      const cursor = sql.exec(q, ...(params as SqlValue[]));
      return { changes: cursor.rowsWritten };
    },
  });
}
