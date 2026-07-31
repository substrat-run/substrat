import { instant } from '@substrat-run/contracts';
import type {
  ConnectionId,
  MigrationProgress,
  MigrationStraggler,
  PlatformActorId,
  Scope,
  ScopeId,
  TenantId,
} from '@substrat-run/contracts';
import type { ExecutorDrainReport, FetchLike, ScopeHost } from './scope-host.js';
import { backoffAt } from './scope-host.js';
import { MIGRATION_FLAG_THRESHOLD, migrationFleet, migrationProgress, scopeMigrationState } from './migration-progress.js';

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
   * Also drain each active scope's pending PLATFORM INTENTS (platform-intents.md) — the requests a
   * vertical enqueued via `ctx.requestPlatform`. Injected like `reapScopeFn`: the kernel cannot
   * reach a vertical's scope DO (it lives in the vertical's own deployment), so the control plane
   * supplies a fn that pulls + executes each intent over the vertical's `/internal` surface. UNSET
   * (the default) skips the phase; returns per-scope counts, summed into `platformRequestTotals`.
   */
  drainPlatformRequestsFn?: (
    tenantId: TenantId,
    scopeId: ScopeId,
  ) => Promise<{ drained: number; done: number; failed: number; pending: number }>;
  /**
   * Also reap expired snapshots (preview-and-snapshots.md §3/§9): any FORK
   * (`forkedFrom` set) whose `expiresAt` has passed is hard-deleted via
   * `deleteSnapshot`. Default `true` — an expiry is only ever present because the
   * snapshot's creator asked for one, so sweeping it is honoring that request, and
   * `deleteSnapshot` refuses non-forks regardless. Set `false` to skip the phase.
   */
  gcSnapshots?: boolean;
  /**
   * How the GC phase deletes one expired fork. Defaults to `host.deleteSnapshot` —
   * right whenever the host and the scope's storage share a deployment (self-host,
   * a vertical's own sweep). The CONTROL-PLANE cron overrides it with the
   * orchestrated delete (§9): wipe the fork's storage in the vertical deployment
   * that actually holds it, then the in-process delete for directory row + audit.
   */
  deleteSnapshotFn?: (tenantId: TenantId, scopeId: ScopeId) => Promise<void>;
  /**
   * Also reap long-archived scopes (control-plane.md §4.4): any scope in `archived`
   * whose `archivedAt` is older than this many days has its DO storage wiped and moves
   * to `reaped` (Cloudflare never GCs a Durable Object, so nothing else frees it). The
   * directory row survives as a tombstone. UNSET (the default) skips the phase entirely
   * — auto-reap is opt-in, and irreversible, so a deployment must name a retention
   * window before the sweep will ever delete an app's data. A scope with a null
   * `archivedAt` (archived before this column shipped) is never auto-reaped — it has no
   * knowable age — and must be reaped by hand.
   */
  reapArchivedAfterDays?: number;
  /**
   * How the reap phase reaps one archived scope. Defaults to `host.admin.reapScope` —
   * right when host and storage share a deployment (self-host, a vertical's own sweep).
   * The CONTROL-PLANE cron overrides it with the orchestrated reap (§4.4): wipe the
   * scope's storage in the vertical deployment that actually holds it (its DO is
   * CP-less), then the in-process reap for the directory transition + audit.
   */
  reapScopeFn?: (tenantId: TenantId, scopeId: ScopeId) => Promise<void>;
  /**
   * Also reap tenants past their grace window (control-plane.md §4.8): any tenant in
   * `deleting` whose `deletingAt` is older than this many days has every scope reaped
   * and its PII/config directory rows cleared, moving it to `reaped` (a tombstone).
   * UNSET (the default) skips the phase entirely — like `reapArchivedAfterDays`, the
   * reap is irreversible, so a deployment must name a retention window before the sweep
   * will ever destroy a tenant's data. A tenant with a null `deletingAt` (flipped before
   * the column shipped) is never auto-reaped and must be reaped by hand.
   */
  reapDeletingAfterDays?: number;
  /**
   * How the reap phase reaps one due tenant. The default composes the existing
   * `reapScopeFn` seam: for each of the tenant's non-reaped scopes it archives (if
   * needed) then reaps via `reapScopeFn`, and finally clears the directory via
   * `host.admin.reapTenant`. Because it rides `reapScopeFn`, the CONTROL-PLANE cron
   * gets the orchestrated per-scope reap (wipe each DO in its vertical deployment) for
   * free just by setting `reapScopeFn` — it need not override this. Supplied only to
   * fully replace the tenant-reap behavior.
   */
  reapTenantFn?: (tenantId: TenantId) => Promise<void>;
  /**
   * Also reconcile migrations (kernel-design §5.3, #49): walk the directory for
   * live scopes behind this host's frontier or failed, wake each with
   * `migrateScope`, back off between retries of a failing scope, and report
   * "release N: X/Y migrated, P pending, F failed". Default `true`; the phase
   * also quietly skips itself on a host that predates `migrateScope`.
   */
  reconcileMigrations?: boolean;
  /**
   * Backoff between retries of a FAILED scope, keyed off the directory's
   * consecutive-attempt count: `baseDelayMs * 2^(attempts-1)`, capped at
   * `maxDelayMs`, jittered ±20% (the same curve executor retries use). There is
   * no max-attempts: a broken migration heals only by a patched forward release,
   * so the sweep retries at the capped cadence until one arrives — flagging past
   * `migrationFlagThreshold` is the human signal, not a stop. Defaults: 60s
   * base, 1h cap. Never-attempted stragglers are always due — waking them IS the
   * sweep's job.
   */
  migrationBackoff?: { baseDelayMs?: number; maxDelayMs?: number };
  /** Consecutive failures before a scope is flagged/paged. Default 3. */
  migrationFlagThreshold?: number;
  /**
   * The paging seam (§5.3 "pages past a threshold"): called once per pass with
   * the failed scopes at/over the threshold, only when there are any. The
   * deployment wires it to whatever alerting it has; the same list always rides
   * `report.migrations.stragglers` (`flagged: true`), so ignoring the callback
   * loses nothing but immediacy. A throwing pager is caught — it must never
   * sink the pass it is reporting on.
   */
  onMigrationsFlagged?: (flagged: MigrationStraggler[]) => void;
}

/**
 * What the migration-reconciliation phase did in one pass: the fleet progress
 * AFTER the pass (the §5.3 "release N: X/Y migrated…" numbers, shared shape
 * with the ops-console view), plus the pass's own work.
 */
export interface MigrationSweepReport extends MigrationProgress {
  /** `migrateScope` calls made this pass (stragglers that were due). */
  attempted: number;
  /** Stragglers this pass brought to the frontier. */
  repaired: number;
  /** Failed scopes skipped this pass — their backoff window has not elapsed. */
  deferred: number;
  /** Attempts where this host had nothing pending — the scope's modules run in another deployment. */
  noops: number;
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
  /** Long-archived primary scopes reaped by `reapScope` this pass (§4.4). */
  archivedScopesReaped: number;
  /** Tenants past their grace window reaped this pass (§4.8). */
  tenantsReaped: number;
  /** Platform-intent drain outcomes summed across scopes (platform-intents.md). */
  platformRequestTotals: PlatformRequestDrainTotals;
  /**
   * The migration-reconciliation phase's report (§5.3, #49), or null when the
   * phase was disabled or the host predates `migrateScope`. Note null vs a
   * report saying "everything migrated" are different facts — the first is
   * "nobody looked", which is exactly the unfalsifiable state the sweep exists
   * to end.
   */
  migrations: MigrationSweepReport | null;
  /** Per-unit failures; the pass records and steps over each rather than aborting. */
  errors: {
    kind: 'drain' | 'sweep' | 'gc' | 'reap' | 'reap-tenant' | 'migrate' | 'platform-request';
    id: string;
    error: string;
  }[];
}

/** Platform-intent drain counts, summed across scopes in one pass. */
export interface PlatformRequestDrainTotals {
  /** Active scopes that had at least one intent drained. */
  scopes: number;
  /** Intents seen across all scopes. */
  drained: number;
  /** Executed successfully. */
  done: number;
  /** Terminally failed (unknown kind, or a handler that gave up). */
  failed: number;
  /** Left pending for a later drain (transient failure). */
  pending: number;
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
    archivedScopesReaped: 0,
    tenantsReaped: 0,
    platformRequestTotals: { scopes: 0, drained: 0, done: 0, failed: 0, pending: 0 },
    migrations: null,
    errors: [],
  };

  // -- migration reconciliation (kernel-design §5.3, #49) ---------------------
  // FIRST, deliberately: `drainDue` wakes scopes (and wake migrates lazily), so
  // running this phase after it would mean every failed scope gets its attempt
  // counted twice per pass — once here, once as a drain error. Feature-detected
  // so a fake or pre-#49 host degrades to `migrations: null`, never a crash.
  //
  // The scopes this phase leaves in a FAILED state are skipped by the drain
  // phase below: they fail closed, so draining them would only re-throw the
  // same migration error as noise and advance the attempt counter a second time.
  const failedThisPass = new Set<string>();
  if (
    options.reconcileMigrations !== false &&
    typeof host.migrateScope === 'function' &&
    typeof host.migrationFrontier === 'function'
  ) {
    const frontier = host.migrationFrontier();
    const flagThreshold = options.migrationFlagThreshold ?? MIGRATION_FLAG_THRESHOLD;
    const retry = {
      maxAttempts: Number.MAX_SAFE_INTEGER, // no give-up: recovery is a patched forward release
      baseDelayMs: options.migrationBackoff?.baseDelayMs ?? 60_000,
      maxDelayMs: options.migrationBackoff?.maxDelayMs ?? 3_600_000,
    };
    const now = new Date().toISOString();
    // `provisioning` included: a scope stuck there because its migration failed
    // is precisely a straggler (the pure adapter's getScope makes the same call).
    const listed = await host.admin.listScopes(options.actor, {
      status: ['active', 'provisioning'],
    });
    const fleet = migrationFleet(listed);

    // Due = behind and never-failed (wake it — that IS the sweep's job), or
    // failed with its backoff window elapsed. A failed scope inside its window
    // is deferred, not forgotten: it stays in the report as `failed`.
    const due: Scope[] = [];
    let deferred = 0;
    for (const s of fleet) {
      const state = scopeMigrationState(s, frontier);
      if (state === 'migrated') continue;
      const failure = s.migrationFailure;
      if (
        failure &&
        backoffAt(failure.attempts, retry, new Date(failure.lastAttemptAt)) > now
      ) {
        deferred += 1;
        continue;
      }
      due.push(s);
    }

    // Attempt each due straggler, then report progress over a SHADOW fleet that
    // reflects this pass's outcomes — computed by the same `migrationProgress`
    // the ops view uses, so the two shapes cannot drift. The shadow is the
    // pass's honest summary; the next pass re-reads the directory for truth.
    const after = new Map<string, Scope>(fleet.map((s) => [s.id, s]));
    let attempted = 0;
    let repaired = 0;
    let noops = 0;
    await mapBounded(due, concurrency, async (s) => {
      attempted += 1;
      try {
        const outcome = await host.migrateScope(s.tenantId, s.id);
        if (outcome.status === 'migrated') {
          repaired += 1;
          after.set(s.id, { ...s, schemaVersion: outcome.schemaVersion, migrationFailure: null });
        } else if (outcome.status === 'failed') {
          after.set(s.id, {
            ...s,
            migrationFailure: {
              version: outcome.failure.version,
              error: outcome.failure.error,
              attempts: (s.migrationFailure?.attempts ?? 0) + 1,
              lastAttemptAt: instant.parse(now),
            },
          });
        } else {
          // noop: this host had nothing pending for the scope — its modules run
          // in another deployment. State untouched, classification unchanged.
          noops += 1;
        }
      } catch (err) {
        // A throw is transport/gating trouble (DO unreachable, K-3 mismatch),
        // not a migration verdict — recorded and stepped over like every unit.
        report.errors.push({ kind: 'migrate', id: s.id, error: message(err) });
      }
    });

    const progress = migrationProgress(frontier, [...after.values()], { flagThreshold });
    report.migrations = { ...progress, attempted, repaired, deferred, noops };
    // From the shadow fleet, not `progress.stragglers` — that list is capped.
    for (const s of after.values()) {
      if (scopeMigrationState(s, frontier) === 'failed') failedThisPass.add(s.id);
    }
    const flagged = progress.stragglers.filter((f) => f.flagged);
    if (flagged.length > 0 && options.onMigrationsFlagged) {
      try {
        options.onMigrationsFlagged(flagged);
      } catch (err) {
        report.errors.push({ kind: 'migrate', id: 'onMigrationsFlagged', error: message(err) });
      }
    }
  }

  if (options.drainRetries !== false) {
    const scopes = await host.admin.listScopes(options.actor, { status: 'active' });
    await mapBounded(scopes, concurrency, async (s) => {
      if (failedThisPass.has(s.id)) return; // fails closed — draining is only noise
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

  // Platform-intent drain (platform-intents.md): pull + execute each active scope's pending
  // intents. Injected because the kernel can't reach a vertical's DO (§ the control plane supplies
  // a fn that goes over the vertical's /internal surface). Skips scopes whose migration failed this
  // pass — draining a fail-closed scope is only noise, exactly like the executor drain above.
  if (options.drainPlatformRequestsFn) {
    const drain = options.drainPlatformRequestsFn;
    const scopes = await host.admin.listScopes(options.actor, { status: 'active' });
    await mapBounded(scopes, concurrency, async (s) => {
      if (failedThisPass.has(s.id)) return;
      try {
        const r = await drain(s.tenantId, s.id);
        if (r.drained > 0) report.platformRequestTotals.scopes += 1;
        report.platformRequestTotals.drained += r.drained;
        report.platformRequestTotals.done += r.done;
        report.platformRequestTotals.failed += r.failed;
        report.platformRequestTotals.pending += r.pending;
      } catch (err) {
        report.errors.push({ kind: 'platform-request', id: s.id, error: message(err) });
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
    const reap =
      options.deleteSnapshotFn ??
      ((tenantId: TenantId, scopeId: ScopeId) =>
        host.deleteSnapshot(options.actor, tenantId, scopeId));
    await mapBounded(expired, concurrency, async (s) => {
      try {
        await reap(s.tenantId, s.id);
        report.snapshotsReaped += 1;
      } catch (err) {
        report.errors.push({ kind: 'gc', id: s.id, error: message(err) });
      }
    });
  }

  // -- reap long-archived scopes (control-plane.md §4.4) ----------------------
  // Free the storage of scopes archived longer than the retention window — Cloudflare
  // never garbage-collects a Durable Object, so an archived app's bytes persist forever
  // otherwise. Opt-in: skipped unless a retention window is configured, because the reap
  // is irreversible. A null `archivedAt` (archived before the column shipped) has no
  // knowable age and is left for a manual reap. `reapScope` re-checks the `archived`
  // status below the seam, so a row that changed underneath fails closed there.
  if (options.reapArchivedAfterDays !== undefined && options.reapArchivedAfterDays >= 0) {
    const cutoff = new Date(
      Date.now() - options.reapArchivedAfterDays * 86_400_000,
    ).toISOString();
    const archived = await host.admin.listScopes(options.actor, { status: ['archived'] });
    const due = archived.filter((s) => s.archivedAt !== null && s.archivedAt <= cutoff);
    const reap =
      options.reapScopeFn ??
      ((tenantId: TenantId, scopeId: ScopeId) => host.admin.reapScope(options.actor, tenantId, scopeId));
    await mapBounded(due, concurrency, async (s) => {
      try {
        await reap(s.tenantId, s.id);
        report.archivedScopesReaped += 1;
      } catch (err) {
        report.errors.push({ kind: 'reap', id: s.id, error: message(err) });
      }
    });
  }

  // -- reap tenants past their grace window (control-plane.md §4.8) ------------
  // A tenant flipped to `deleting` sits in a reversible grace window; once it is older
  // than the retention window, reclaim it. Runs AFTER the scope reap above so a tenant's
  // scopes are gone before the tenant row becomes a tombstone. Opt-in and irreversible,
  // exactly like the scope reap. The default `reapTenantFn` composes the same
  // `reapScopeFn` seam used above (archive-if-needed → reap each scope), then clears the
  // directory via `reapTenant` — so the control-plane cron's orchestrated per-scope reap
  // applies here for free. `reapTenant` re-checks the `deleting` status below the seam,
  // so a row that changed underneath fails closed there.
  if (options.reapDeletingAfterDays !== undefined && options.reapDeletingAfterDays >= 0) {
    const cutoff = new Date(
      Date.now() - options.reapDeletingAfterDays * 86_400_000,
    ).toISOString();
    const tenants = await host.admin.listTenants(options.actor);
    const due = tenants.filter(
      (t) => t.status === 'deleting' && t.deletingAt !== null && t.deletingAt <= cutoff,
    );
    const reapOneScope =
      options.reapScopeFn ??
      ((tenantId: TenantId, scopeId: ScopeId) =>
        host.admin.reapScope(options.actor, tenantId, scopeId));
    const reapTenant =
      options.reapTenantFn ??
      (async (tenantId: TenantId) => {
        // Co-located default: reap every one of the tenant's scopes through the scope
        // seam (archive-if-needed first — reapScope only accepts `archived`), then clear
        // the tenant's directory rows. A scope already `reaped` is skipped.
        const scopes = await host.admin.listScopes(options.actor, { tenantId });
        for (const s of scopes) {
          if (s.status === 'reaped') continue;
          if (s.status !== 'archived') {
            await host.admin.archiveScope(options.actor, tenantId, s.id);
          }
          await reapOneScope(tenantId, s.id);
        }
        await host.admin.reapTenant(options.actor, tenantId);
      });
    await mapBounded(due, concurrency, async (t) => {
      try {
        await reapTenant(t.id);
        report.tenantsReaped += 1;
      } catch (err) {
        report.errors.push({ kind: 'reap-tenant', id: t.id, error: message(err) });
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
