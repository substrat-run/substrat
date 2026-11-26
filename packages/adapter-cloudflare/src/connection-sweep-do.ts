import { DurableObject } from 'cloudflare:workers';

/**
 * K-69 (no scheduled walk over tenants), step 4.2 (rfc/tenant-scale.md §7.4, §8.8, §12; #3376): a
 * connection's connector sweep driven by that connection's own alarm, rather than by a phase of the
 * `*\/15` pass that walks every connection.
 *
 * One object per connection (`connectionSweepName`). It holds the connection's address and its
 * alarm, nothing else: no credential, no authority, no data. Each alarm runs the deployment's sweep
 * for the one connection (`run`, closed over at code time like `defineKickCoalescerDO`'s), and then
 * arms the next: at the connection's interval from the end of this run, or at the time the sweep
 * itself said is worth another try (a crash back-off's end, a provider's poll interval). Its sweep is
 * the pass's own, so the attempt rows, the crash back-off, the per-connection budget, the landings
 * and the operator's pause (#3324) all hold unchanged. What changes is that one connection's sweep is
 * its own invocation: a slow or failing one holds no other connection behind it.
 *
 * Nothing is kept at rest (D-79): an object whose connection is revoked or gone clears its storage
 * and arms nothing, and so does one whose deployment has handed the sweep back to the pass (`owned`
 * false). A handed-back object is woken again only by `ensure`.
 */

/** Which connection an object sweeps: what the deployment needs to read it back. */
export interface ConnectionSweepRef {
  id: string;
  tenantId: string;
  vertical: string;
  provider: string;
}

/** What one run of a connection's sweep said, so the object knows when to run again. */
export interface ConnectionSweepRun {
  /** The connection is revoked or no longer exists: clear, and arm nothing. */
  gone?: boolean;
  /** Epoch ms: the sweep waited the connection out (back-off, poll interval) until then. */
  notBefore?: number;
  /** This connection's interval between runs, ms. Absent, the object's default. */
  intervalMs?: number;
}

/**
 * What the pass's check found for one connection (`ensure`):
 * - `held`: armed, on time. The connection's own alarm has it.
 * - `started`: nothing was armed, so the check armed it. The first time for a connection, or one the
 *   pass handed over this pass; on any later pass, an alarm that was lost.
 * - `overdue`: armed for a time more than `overdueAfterMs` gone, so the check armed it for now.
 */
export type ConnectionSweepCheck = 'held' | 'started' | 'overdue';

/** The RPC surface a `defineConnectionSweepDO` class exposes over its stub. */
export interface ConnectionSweepDo {
  ensure(connection: ConnectionSweepRef): Promise<ConnectionSweepCheck>;
}

/** The one object per connection: `ns.get(ns.idFromName(connectionSweepName(connectionId)))`. */
export function connectionSweepName(connectionId: string): string {
  return `connection:${connectionId}`;
}

/** A connection's default interval between runs: the pass's cadence, as each connection had. */
export const CONNECTION_SWEEP_INTERVAL_MS = 15 * 60_000;

/** How far past its time an armed alarm may be before the check calls it overdue: K-69's hour. */
export const CONNECTION_SWEEP_OVERDUE_MS = 60 * 60_000;

/**
 * The window a connection's first run is spread over, by its id. Handing every connection over in one
 * pass would otherwise start every sweep in the same second.
 */
export const CONNECTION_SWEEP_FIRST_SPREAD_MS = 5 * 60_000;

/** The least gap between two runs, so a sweep that answers a time already gone never spins. */
const MIN_GAP_MS = 60_000;

/** A stable spread of `[0, spreadMs)` by a connection's id. */
export function spreadOf(connectionId: string, spreadMs: number): number {
  // FNV-1a, then a finalizing mix: ids that differ only in a last character still land far apart.
  let h = 0x811c9dc5;
  for (let i = 0; i < connectionId.length; i += 1) h = Math.imul(h ^ connectionId.charCodeAt(i), 0x01000193);
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h = (h ^ (h >>> 16)) >>> 0;
  return spreadMs > 0 ? h % spreadMs : 0;
}

export interface ConnectionSweepConfig<Env> {
  /**
   * Whether this deployment's connections are swept by their own objects. Read on every alarm, so
   * handing the sweep back to the pass needs no call to each object: each clears on its next wake.
   */
  owned(env: Env): boolean;
  /**
   * One run of one connection's sweep. CODE-TIME, as `defineKickCoalescerDO`'s `run`: the authority
   * is the deployment's, so this object decides only WHEN. A throw is logged and the next run armed
   * at the interval; it is never rethrown, since the runtime's own alarm retries would run the sweep
   * again at once, which the sweep's crash back-off exists to prevent.
   */
  run(env: Env, connection: ConnectionSweepRef): Promise<ConnectionSweepRun>;
  /** Default {@link CONNECTION_SWEEP_INTERVAL_MS}. */
  intervalMs?: number;
  /** Default {@link CONNECTION_SWEEP_OVERDUE_MS}. */
  overdueAfterMs?: number;
  /** Delay before a connection's first run. Default: spread over {@link CONNECTION_SWEEP_FIRST_SPREAD_MS} by id. */
  firstDelayMs?(connectionId: string): number;
  onError?(err: unknown, env: Env): void;
}

const KEY = 'connection';

const sameRef = (a: ConnectionSweepRef, b: ConnectionSweepRef): boolean =>
  a.id === b.id && a.tenantId === b.tenantId && a.vertical === b.vertical && a.provider === b.provider;

export function defineConnectionSweepDO<Env>(
  config: ConnectionSweepConfig<Env>,
): new (ctx: DurableObjectState, env: Env) => DurableObject<Env> & ConnectionSweepDo {
  const intervalMs = config.intervalMs ?? CONNECTION_SWEEP_INTERVAL_MS;
  const overdueAfterMs = config.overdueAfterMs ?? CONNECTION_SWEEP_OVERDUE_MS;
  const firstDelayMs = config.firstDelayMs ?? ((id: string) => spreadOf(id, CONNECTION_SWEEP_FIRST_SPREAD_MS));
  return class ConnectionSweepDO extends DurableObject<Env> {
    /**
     * The pass's check (K-69): make sure this connection's alarm is armed, and say what was found.
     * Never runs the sweep itself, so the pass is never held by a connection's provider.
     */
    async ensure(connection: ConnectionSweepRef): Promise<ConnectionSweepCheck> {
      const stored = await this.ctx.storage.get<ConnectionSweepRef>(KEY);
      if (stored && stored.id !== connection.id) {
        throw new Error(`this object sweeps connection ${stored.id}, not ${connection.id}`);
      }
      if (!stored || !sameRef(stored, connection)) await this.ctx.storage.put(KEY, connection);
      const at = await this.ctx.storage.getAlarm();
      const now = Date.now();
      if (at === null) {
        await this.ctx.storage.setAlarm(now + Math.max(0, firstDelayMs(connection.id)));
        return 'started';
      }
      if (at < now - overdueAfterMs) {
        await this.ctx.storage.setAlarm(now);
        return 'overdue';
      }
      return 'held';
    }

    async alarm(): Promise<void> {
      const connection = await this.ctx.storage.get<ConnectionSweepRef>(KEY);
      if (!connection || !config.owned(this.env)) {
        await this.#clear();
        return;
      }
      let run: ConnectionSweepRun = {};
      try {
        run = await config.run(this.env, connection);
      } catch (err) {
        if (config.onError) config.onError(err, this.env);
        else console.error('connection sweep: the run failed; the next is armed at the interval', { connectionId: connection.id, err });
      }
      if (run.gone) {
        await this.#clear();
        return;
      }
      // From the run's end: a provider's poll interval is judged against the outcome row its sweep
      // writes as it ends, so an interval from the start would wake the object only to wait it out.
      const next = run.notBefore ?? Date.now() + (run.intervalMs ?? intervalMs);
      await this.ctx.storage.setAlarm(Math.max(next, Date.now() + MIN_GAP_MS));
    }

    async #clear(): Promise<void> {
      await this.ctx.storage.deleteAlarm();
      await this.ctx.storage.deleteAll();
    }
  };
}
