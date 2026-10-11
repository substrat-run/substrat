/**
 * The storage-side fence (#1638 Q2): a stale holder's write is refused INSIDE its own
 * transaction, by the scope's files, whatever SQL made it (short of DDL that removes the
 * fence, below). It needs the new holder to reach the stale holder's live files under a
 * write lock both honour, which one filesystem gives and node-local volumes across nodes do
 * not (FINDINGS.md §2).
 *
 * Each SQLite file of a scope carries one row, `_k3s_fence(epoch)`, and on every table a
 * trigger for INSERT, UPDATE and DELETE:
 *
 *   WHEN k3s_holder_epoch() IS NOT (SELECT epoch FROM _k3s_fence) → RAISE(ABORT, 'k3s fence: …')
 *
 * `k3s_holder_epoch()` is a SQL function this process registers on every better-sqlite3
 * connection it opens. It answers the epoch under which THIS process holds the scope the
 * file belongs to, or NULL, and NULL never equals an epoch. A takeover stamps the new epoch
 * into the previous holder's files under their write lock, before copying them. From that
 * moment a holder that still believes it holds the scope, woken from a freeze, aborts at its
 * first write. That holds even when it wakes inside a handler that writes without emitting
 * anything, because the trigger sits on every table, not on the outbox. A connection that
 * never registered the function fails closed too ("no such function").
 *
 * Every table, not the outbox, because the host guarantees no row per invocation: an event
 * is emitted only if the handler emits one, and the idempotency record is written only when
 * the caller sent a key (`packages/adapter-sqlite/src/index.ts`, the `BEGIN IMMEDIATE` …
 * `COMMIT` of `invoke`). Tables are those that exist when the fence is stamped: a scope is
 * stamped after the host migrated it. A table a later migration adds is not covered until
 * the next stamp. Virtual tables and their shadow tables carry no trigger; their writes come
 * from writes to tables that do.
 *
 * The fence row guards itself too: triggers on `_k3s_fence` refuse any change from a
 * connection `stampFence` did not open (a second function, `k3s_stamping()`). What no trigger
 * can stop is DDL: code that drops the triggers or the table. A real adapter reserves the
 * name, as `ctx.sql` reserves `_substrat_*`; the spike does not.
 *
 * How it reaches the connection: `SqliteScopeHost` opens its own connections and offers no
 * hook, so this patches better-sqlite3's `prepare`/`exec` to register the function on a
 * connection's first statement, as `tools/vitest/like-pattern-limit.cjs` does for its limit.
 * That makes this a demonstration of the mechanism a real adapter would build in (a function
 * or a check on its own connection), not something to ship as is.
 */
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';

/** scope id → the epoch this process holds it under. */
const holding = new Map<string, number>();

/** Record that this process now holds `scope` under `epoch`. Set before the scope is opened. */
export function holdEpoch(scope: string, epoch: number): void {
  holding.set(scope, epoch);
}

/** A scope file lives at `…/scopes/<scopeId>/<file>.sqlite`. */
const SCOPE_IN_PATH = /[\\/]scopes[\\/]([^\\/]+)[\\/][^\\/]+$/;

/** The connections `stampFence` opened: the only ones allowed to change `_k3s_fence`. */
const stampers = new WeakSet<object>();

let installed = false;

/** Register `k3s_holder_epoch()` on every connection this process opens, from now on. */
export function installEpochFunction(): void {
  if (installed) return;
  installed = true;
  const proto = Database.prototype as unknown as Record<'prepare' | 'exec', (...a: unknown[]) => unknown>;
  const registered = new WeakSet<object>();
  for (const method of ['prepare', 'exec'] as const) {
    const original = proto[method];
    proto[method] = function (this: Database.Database, ...args: unknown[]) {
      if (!registered.has(this)) {
        registered.add(this);
        const scope = SCOPE_IN_PATH.exec(this.name)?.[1];
        this.function('k3s_holder_epoch', { deterministic: false }, () =>
          scope === undefined ? null : (holding.get(scope) ?? null),
        );
        this.function('k3s_stamping', { deterministic: false }, () => (stampers.has(this) ? 1 : 0));
      }
      return original.apply(this, args);
    };
  }
}

export const FENCE_REFUSAL = 'k3s fence: stale holder';
export const FENCE_GUARD_REFUSAL = 'k3s fence: only a takeover stamp may change the fence';

/**
 * The stamp could not take a file's write lock in time: a holder is inside a write
 * transaction there. Retryable: the caller has placed nothing and served nothing.
 */
export class StampBusy extends Error {}

/** A newer epoch is already stamped in the file: the caller's grant has been superseded. */
export class StaleStamp extends Error {}

/** How long one stamp waits for a file's write lock before giving up with {@link StampBusy}. */
export const STAMP_LOCK_WAIT_MS = 1_000;

/** Whether `e` is the fence refusing a write. */
export function isFenceRefusal(e: unknown): boolean {
  return e instanceof Error && e.message.includes(FENCE_REFUSAL);
}

/**
 * Stamp `epoch` into every SQLite file of the scope directory `dir` and make sure every table
 * carries the fence triggers. One `BEGIN IMMEDIATE` per file, so it waits for, and then
 * excludes, any write in flight there. After it returns, a write by a holder of an older
 * epoch aborts.
 *
 * A holder frozen INSIDE a write transaction keeps that lock for as long as it is frozen, so
 * the stamp cannot complete until it wakes or dies. The stamp waits {@link STAMP_LOCK_WAIT_MS}
 * and then throws {@link StampBusy}; the takeover is retried, and the scope is unavailable for
 * as long as the freeze lasts. That is safe — the frozen transaction commits before the stamp
 * or not at all, its acknowledgement is withheld, and the copy taken after the stamp carries
 * it — but it is not bounded by the lease TTL. Only stopping the old holder bounds it.
 */
export function stampFence(dir: string, epoch: number): void {
  for (const name of readdirSync(dir).filter((n) => n.endsWith('.sqlite'))) {
    const db = new Database(join(dir, name), { fileMustExist: true, timeout: STAMP_LOCK_WAIT_MS });
    stampers.add(db);
    try {
      db.exec('BEGIN IMMEDIATE');
      db.exec('CREATE TABLE IF NOT EXISTS _k3s_fence (epoch INTEGER NOT NULL)');
      // The fence row guards itself: only a connection this function opened may change it, so
      // a stale holder cannot write its own epoch into the row and then write past it.
      for (const op of ['INSERT', 'UPDATE', 'DELETE']) {
        db.exec(
          `CREATE TRIGGER IF NOT EXISTS "_k3s_fence_guard_${op.toLowerCase()}" BEFORE ${op} ON _k3s_fence ` +
            `WHEN k3s_stamping() IS NOT 1 BEGIN SELECT RAISE(ABORT, '${FENCE_GUARD_REFUSAL}'); END`,
        );
      }
      // Only ever upward. A takeover that lost the race to a newer one learns here that it is
      // stale, instead of lowering the epoch under the newer holder's feet.
      const current = db.prepare<[], { epoch: number }>('SELECT MAX(epoch) AS epoch FROM _k3s_fence').get()?.epoch ?? null;
      if (current !== null && current > epoch) {
        throw new StaleStamp(`${join(dir, name)} is already fenced at epoch ${current}, newer than ${epoch}`);
      }
      db.exec('DELETE FROM _k3s_fence');
      db.prepare('INSERT INTO _k3s_fence (epoch) VALUES (?)').run(epoch);
      const rows = db
        .prepare<[], { name: string; sql: string | null }>("SELECT name, sql FROM sqlite_master WHERE type = 'table'")
        .all();
      const virtual = rows.filter((r) => /^CREATE VIRTUAL TABLE/i.test(r.sql ?? '')).map((r) => r.name);
      const fenced = rows
        .map((r) => r.name)
        .filter((t) => !t.startsWith('sqlite_') && t !== '_k3s_fence')
        .filter((t) => !virtual.some((v) => t === v || t.startsWith(`${v}_`)));
      for (const table of fenced) {
        for (const op of ['INSERT', 'UPDATE', 'DELETE']) {
          db.exec(
            `CREATE TRIGGER IF NOT EXISTS "_k3s_fence_${table}_${op.toLowerCase()}" BEFORE ${op} ON "${table}" ` +
              `WHEN k3s_holder_epoch() IS NOT (SELECT epoch FROM _k3s_fence) ` +
              `BEGIN SELECT RAISE(ABORT, '${FENCE_REFUSAL}'); END`,
          );
        }
      }
      db.exec('COMMIT');
    } catch (e) {
      if (db.inTransaction) db.exec('ROLLBACK');
      if ((e as { code?: string }).code === 'SQLITE_BUSY') {
        throw new StampBusy(`${join(dir, name)} is locked by a write in flight; the takeover waits for it`);
      }
      throw e;
    } finally {
      db.close();
    }
  }
}
