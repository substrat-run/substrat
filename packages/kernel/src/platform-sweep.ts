import type { ConnectionId, PlatformActorId } from '@substrat-run/contracts';
import type { ExecutorDrainReport, FetchLike, ScopeHost } from './scope-host.js';

// setTimeout/clearTimeout are web-standard (Node, Workers, browsers) but the
// kernel pulls in no platform lib typings; declared locally, returning an opaque
// handle, the same move `api.ts` makes for `AbortSignal`.
declare const setTimeout: (cb: () => void, ms: number) => unknown;
declare const clearTimeout: (handle: unknown) => void;

/**
 * A connector's reconcile sweep — the unit `runPlatformSweep` calls per live
 * connection of a given provider (`sweepScriveReconciliations` is one).
 *
 * INJECTED, never imported: the driver — and the deployment that runs it —
 * depends on no specific connector. A connector contributes `{ [provider]: its
 * sweeper }` to the registry, and a provider with no entry is simply skipped.
 */
export interface ConnectorSweeper {
  (host: ScopeHost, connectionId: ConnectionId, opts: { fetch: FetchLike }): Promise<unknown>;
}

export interface PlatformSweepOptions {
  /** The platform actor the enumeration reads run as (`listScopes`/`listConnections`). */
  actor: PlatformActorId;
  /** Sanctioned egress handed to each connector sweeper. */
  fetch: FetchLike;
  /** provider slug → its reconcile sweeper. A connection whose provider is absent is skipped. */
  sweepers: Record<string, ConnectorSweeper>;
  /** Max scope drains / connection sweeps in flight at once. Default 8. */
  concurrency?: number;
  /**
   * Also drain each active scope's due executor deliveries — the retry driver
   * (connections.md §2.1), which has been landed and equally lacks a caller.
   * Default `true`; set `false` to sweep only connectors.
   */
  drainRetries?: boolean;
  /**
   * Also reap expired snapshots (preview-and-snapshots.md §3/§9): any FORK
   * (`forkedFrom` set) whose `expiresAt` has passed is hard-deleted via
   * `deleteSnapshot`. Default `true` — an expiry is only ever present because the
   * snapshot's creator asked for one, so sweeping it is honoring that request, and
   * `deleteSnapshot` refuses non-forks regardless. Set `false` to skip the phase.
   */
  gcSnapshots?: boolean;
}

export interface PlatformSweepReport {
  /** Active scopes `drainDue` ran on. */
  scopesDrained: number;
  /** Drain outcomes summed across scopes. */
  drainTotals: ExecutorDrainReport;
  /** Connections a sweeper ran for. */
  connectionsSwept: number;
  /** Connections skipped — revoked, or their provider has no registered sweeper. */
  connectionsSkipped: number;
  /** Expired forks reaped by `deleteSnapshot` this pass. */
  snapshotsReaped: number;
  /** Per-unit failures; the pass records and steps over each rather than aborting. */
  errors: { kind: 'drain' | 'sweep' | 'gc'; id: string; error: string }[];
}

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * Run `fn` over `items` with at most `limit` in flight. `fn` owns its errors —
 * this never rejects, so one unit's failure cannot abort the pass.
 */
async function mapBounded<T>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      await fn(items[next++]!);
    }
  });
  await Promise.all(workers);
}

/**
 * One pass of the platform's scheduled work: drain every active scope's due
 * executor deliveries, then reconcile every live connection against its provider.
 *
 * This is the SCHEDULER'S UNIT OF WORK — a Cloudflare cron, a Durable Object
 * alarm, or a node timer calls it; it holds no timer itself (see
 * `startPlatformSweeper`, and docs/design/scheduler.md). Both halves are code
 * that landed but had no caller: `drainDue` (the retry driver) and the
 * connectors' reconcile sweeps.
 *
 * Robust because a scheduled pass must be: bounded concurrency, so one slow
 * provider cannot delay the fleet, and a failure on any one scope or connection
 * is recorded in the report and stepped over — never allowed to sink the pass.
 *
 * Provider-agnostic: connections are discovered via `listConnections` and
 * dispatched to `sweepers[provider]`, so this imports no connector. A connection
 * whose provider has no sweeper, or that is revoked, is skipped (and counted),
 * not an error.
 */
export async function runPlatformSweep(
  host: ScopeHost,
  options: PlatformSweepOptions,
): Promise<PlatformSweepReport> {
  const concurrency = options.concurrency ?? 8;
  const report: PlatformSweepReport = {
    scopesDrained: 0,
    drainTotals: { attempted: 0, delivered: 0, retrying: 0, deadLettered: 0 },
    connectionsSwept: 0,
    connectionsSkipped: 0,
    snapshotsReaped: 0,
    errors: [],
  };

  if (options.drainRetries !== false) {
    const scopes = await host.admin.listScopes(options.actor, { status: 'active' });
    await mapBounded(scopes, concurrency, async (s) => {
      try {
        const r = await host.drainDue(s.tenantId, s.id);
        report.scopesDrained += 1;
        report.drainTotals.attempted += r.attempted;
        report.drainTotals.delivered += r.delivered;
        report.drainTotals.retrying += r.retrying;
        report.drainTotals.deadLettered += r.deadLettered;
      } catch (err) {
        report.errors.push({ kind: 'drain', id: s.id, error: message(err) });
      }
    });
  }

  if (options.gcSnapshots !== false) {
    // Reap expired forks (§3/§9). Enumerate every scope regardless of status — a fork
    // is `active` in the directory — and compare ISO instants lexically, the same
    // move the tuple checker's `live()` makes. `deleteSnapshot` re-checks fork-ness,
    // so a mislabeled row fails closed there, never silently deletes.
    const now = new Date().toISOString();
    const scopes = await host.admin.listScopes(options.actor);
    const expired = scopes.filter(
      (s) => s.forkedFrom !== null && s.expiresAt !== null && s.expiresAt <= now,
    );
    await mapBounded(expired, concurrency, async (s) => {
      try {
        await host.deleteSnapshot(options.actor, s.tenantId, s.id);
        report.snapshotsReaped += 1;
      } catch (err) {
        report.errors.push({ kind: 'gc', id: s.id, error: message(err) });
      }
    });
  }

  const connections = await host.admin.listConnections(options.actor, {});
  await mapBounded(connections, concurrency, async (c) => {
    if (c.revokedAt !== null) {
      report.connectionsSkipped += 1; // terminal — nothing to reconcile through it
      return;
    }
    const sweeper = options.sweepers[c.provider];
    if (!sweeper) {
      report.connectionsSkipped += 1;
      return;
    }
    try {
      await sweeper(host, c.id, { fetch: options.fetch });
      report.connectionsSwept += 1;
    } catch (err) {
      report.errors.push({ kind: 'sweep', id: c.id, error: message(err) });
    }
  });

  return report;
}

/** A running sweeper; `stop()` prevents the next pass and cancels the pending timer. */
export interface PlatformSweeperHandle {
  stop(): void;
}

export interface StartPlatformSweeperOptions extends PlatformSweepOptions {
  /**
   * Milliseconds between the END of one pass and the START of the next — a gap,
   * not a fixed rate. Rescheduling only after a pass settles means two passes can
   * never overlap, even when a pass runs longer than the interval.
   */
  intervalMs: number;
  /** Observe each pass — for logging or a health metric. Never throws into the loop. */
  onPass?: (outcome: PlatformSweepReport | { error: string }) => void;
  /** Injected for tests; default to the runtime's timer. */
  setTimer?: (cb: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

/**
 * Drive `runPlatformSweep` on a self-rescheduling timer — the node/long-lived
 * runtime's trigger. (A Cloudflare deployment uses `scheduled()`/an alarm instead
 * and calls `runPlatformSweep` directly; both share the one unit of work.)
 *
 * Non-overlapping by construction: the next pass is scheduled only once the
 * current one settles, so a slow pass delays the next rather than stacking on it.
 */
export function startPlatformSweeper(
  host: ScopeHost,
  options: StartPlatformSweeperOptions,
): PlatformSweeperHandle {
  const setTimer = options.setTimer ?? ((cb, ms) => setTimeout(cb, ms));
  const clearTimer = options.clearTimer ?? ((h) => clearTimeout(h));
  let stopped = false;
  let handle: unknown;

  const tick = async (): Promise<void> => {
    if (stopped) return;
    try {
      options.onPass?.(await runPlatformSweep(host, options));
    } catch (err) {
      options.onPass?.({ error: message(err) });
    }
    if (!stopped) handle = setTimer(() => void tick(), options.intervalMs);
  };

  handle = setTimer(() => void tick(), options.intervalMs);
  return {
    stop() {
      stopped = true;
      if (handle !== undefined) clearTimer(handle);
    },
  };
}
