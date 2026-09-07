import { DurableObject } from 'cloudflare:workers';
import { scopeId as scopeIdSchema, tenantId as tenantIdSchema } from '@substrat-run/contracts';
import type { ScopeId, TenantId, SweepRunsPayload } from '@substrat-run/contracts';
import type {
  ExecutorDrainReport,
  ScheduleRegistration,
  ScheduleRunReport,
  ScheduleSweepReport,
  FreshnessRegistration,
  FreshnessReport,
} from '@substrat-run/kernel';

/**
 * The singleton's name: every caller reaches the ONE scope sweeper via
 * `env.SWEEPER.get(env.SWEEPER.idFromName(SCOPE_SWEEPER_NAME))` — one roster,
 * one alarm, one pass at a time for the whole deployment, the same guarantee
 * `PLATFORM_SWEEPER_NAME` gives the directory-backed trigger.
 */
export const SCOPE_SWEEPER_NAME = 'scope-sweeper';

/** Roster keys in the sweeper's own storage: `scope:<scopeId>` → tenantId. */
const ROSTER_PREFIX = 'scope:';

/**
 * What one scope-local pass did. `scopes` is the roster size at the start of the
 * pass — every entry is visited; `schedules.scopes` keeps the kernel report's
 * narrower meaning (scopes a schedule actually fired or failed on).
 */
export interface ScopeSweepReport {
  /** Scopes on the roster this pass — each one was drained and schedule-checked. */
  scopes: number;
  /** Executor-drain outcomes summed across the roster (the retry driver). */
  drainTotals: ExecutorDrainReport;
  /** The recurring-schedule outcomes summed across the roster (#383/#461). */
  schedules: ScheduleSweepReport;
  /** Per-unit failures; the pass records and steps over each, never aborts. */
  errors: { kind: 'drain' | 'schedule' | 'freshness'; id: string; error: string }[];
}

/** One settled pass: the report, or the error that sank the whole pass. */
export type ScopeSweepOutcome = ScopeSweepReport | { error: string };

/**
 * The slice of `CloudflareScopeHost` a scope-local pass drives — structural, so
 * tests can hand in a fake and the DO depends on no host internals. All three
 * are CP-less-safe: `drainDue` gates through `validateScopeAccess` (a null-CP
 * passthrough) and `runDueSchedules` skips the directory read on a CP-less host
 * (#461); neither needs a platform actor.
 */
export interface ScopeSweepHost {
  drainDue(tenantId: TenantId, scopeId: ScopeId): Promise<ExecutorDrainReport>;
  registeredSchedules(): ScheduleRegistration[];
  runDueSchedules(
    moduleId: ScheduleRegistration['moduleId'],
    tenantId: TenantId,
    scopeId: ScopeId,
  ): Promise<ScheduleRunReport>;
  /**
   * #1232: hand one pass's schedule outcomes to the scope's intent journal, for
   * the platform drain to land in `_substrat_sweep_runs`. Optional so a fake
   * host (and a pre-widening deployment) keeps compiling; a pass on a host
   * without it simply reports nothing, exactly as every pass did before.
   */
  enqueueSweepRuns?(scopeId: ScopeId, payload: SweepRunsPayload): Promise<unknown>;
  /** #1232: declared freshness expectations + their evaluator — optional, like the two above. */
  registeredFreshness?(): FreshnessRegistration[];
  checkFreshness?(
    moduleId: FreshnessRegistration['moduleId'],
    tenantId: TenantId,
    scopeId: ScopeId,
  ): Promise<FreshnessReport>;
}

export interface ScopeSweeperDoConfig<Env> {
  /**
   * Milliseconds between the END of one pass and the START of the next — a gap,
   * not a fixed rate. The next alarm is set only once the current pass settles,
   * so a slow pass delays the next rather than stacking on it.
   */
  intervalMs: number;
  /**
   * The deployment's host — build it from the env's bindings per invocation,
   * never cached (a `CloudflareScopeHost` holds DO stubs, which are owned by
   * the event that created them). CODE-TIME, closed over like `defineScopeDO`'s
   * module set: a Durable Object cannot receive closures over RPC, and the
   * worker entry that exports this class is the one place that legitimately
   * assembles the module registry.
   */
  host(env: Env): ScopeSweepHost;
  /**
   * Also drain each scope's due executor deliveries (the retry driver) — the
   * other half of the vertical's own recurring work, with the same "no directory
   * to enumerate" gap as schedules. Default `true`; set `false` to sweep
   * schedules only.
   */
  drainRetries?: boolean;
  /** Max scopes worked concurrently per pass. Default 8. */
  concurrency?: number;
  /** Observe each pass — logging or a health metric. Never throws into the loop. */
  onPass?(outcome: ScopeSweepOutcome, env: Env): void;
  /**
   * #1232: the version identity the pass reports — read `env.SUBSTRAT_VERSION_ID`
   * here (an accessor rather than a widened Env constraint, so existing workers
   * compile untouched). Unset or null ⇒ the drain falls back to the scope's
   * bound version, its documented approximation.
   */
  versionId?(env: Env): string | null | undefined;
}

/** The RPC surface a `defineScopeSweeperDO` class exposes over its stub. */
export interface ScopeSweeperDo {
  /**
   * Put one scope on the roster and (re)arm the loop. Idempotent — call it on
   * every `/internal/provision` and `/internal/reconcile`; re-noting a known
   * scope is a cheap overwrite.
   */
  noteScope(tenantId: TenantId, scopeId: ScopeId): Promise<{ scopes: number }>;
  /** Drop one scope from the roster (the `/internal/delete-scope` mirror). */
  forgetScope(scopeId: ScopeId): Promise<{ scopes: number }>;
  /** Arm the loop if it is not armed — idempotent, safe on every request. */
  ensureArmed(): Promise<{ armed: boolean; alarmAt: number }>;
  /** Run a pass now (joining any in-flight pass), then re-arm. */
  sweepNow(): Promise<ScopeSweepOutcome>;
}

/**
 * `defineScopeSweeperDO` — the timer a CP-LESS vertical owns (#461): a singleton
 * Durable Object that keeps a roster of this deployment's scopes and, on an
 * alarm, runs each one's due recurring work — `drainDue` (executor retries) and
 * `runDueSchedules` (#383) — through the deployment's own host.
 *
 * Why it exists: `runPlatformSweep`'s schedule and drain phases enumerate scopes
 * via the control-plane directory (`admin.listScopes`), which a CP-less host
 * does not have — so a pushed vertical's declared schedules parsed, granted, and
 * never ran (#461's "unfalsifiable zero"). The scopes a CP-less deployment
 * serves are exactly the ones the platform provisions into it, so the roster IS
 * knowable locally: `/internal/provision` and `/internal/reconcile` call
 * `noteScope`, `/internal/delete-scope` calls `forgetScope`, and no directory is
 * needed. Scopes provisioned before this sweeper shipped join the roster on
 * their next platform reconcile (repair is the roster's backfill).
 *
 * Deliberately NOT noted: snapshot targets (`/internal/snapshot`) and other
 * forks. The platform sweep excludes forks from schedules — recurring side
 * effects must not run off a preview copy — and fork-ness lives only in the
 * directory, so the CP-less roster keeps forks out by never learning them:
 * provision and reconcile are called for primaries only. Do not "self-heal" the
 * roster from routed request traffic — a routed preview would smuggle a fork in.
 *
 * Trigger mechanics — alarm, singleton, non-overlap, never-dies — are exactly
 * `definePlatformSweeperDO`'s (see its docstring for why an alarm and not a
 * cron; `platform-sweeper.test.ts` pins the shared loop shape, including a pass
 * that sinks whole still re-arming). One difference: the alarm re-arms only
 * while the roster is non-empty, so a deployment with no scopes costs nothing —
 * `noteScope` (re)arms when the first scope arrives.
 *
 * Wire-up (the create-substrat template is the reference):
 *
 * ```ts
 * export const SweeperDO = defineScopeSweeperDO<Env>({
 *   intervalMs: 120_000,
 *   host: hostFor, // the same builder the routes use
 * });
 * // package.json substrat.runtimeNeeds.stores: add { binding: 'SWEEPER', class: 'SweeperDO' }
 * // /internal/provision + /internal/reconcile → stub.noteScope(tenantId, scopeId)
 * // /internal/delete-scope                    → stub.forgetScope(scopeId)
 * ```
 */
export function defineScopeSweeperDO<Env>(
  config: ScopeSweeperDoConfig<Env>,
): new (ctx: DurableObjectState, env: Env) => DurableObject<Env> & ScopeSweeperDo {
  return class ScopeSweeperDO extends DurableObject<Env> {
    /** The in-flight pass, when one is running — the overlap guard. */
    #pass: Promise<ScopeSweepOutcome> | null = null;

    async noteScope(tenantId: TenantId, scopeId: ScopeId): Promise<{ scopes: number }> {
      // Parse, don't trust: RPC delivers plain strings; a malformed id must fail
      // loudly here, not surface as a stuck roster entry that never sweeps.
      const t = tenantIdSchema.parse(tenantId);
      const s = scopeIdSchema.parse(scopeId);
      await this.ctx.storage.put(`${ROSTER_PREFIX}${s}`, t);
      await this.ensureArmed();
      return { scopes: await this.#rosterSize() };
    }

    async forgetScope(scopeId: ScopeId): Promise<{ scopes: number }> {
      await this.ctx.storage.delete(`${ROSTER_PREFIX}${scopeIdSchema.parse(scopeId)}`);
      // The alarm is left as-is: an empty-roster pass simply does not re-arm.
      return { scopes: await this.#rosterSize() };
    }

    /**
     * Arm the loop if it is not armed. Idempotent: an already-set alarm is left
     * exactly where it is, so this is safe to call on every request.
     */
    async ensureArmed(): Promise<{ armed: boolean; alarmAt: number }> {
      const existing = await this.ctx.storage.getAlarm();
      if (existing !== null) return { armed: false, alarmAt: existing };
      const alarmAt = Date.now() + config.intervalMs;
      await this.ctx.storage.setAlarm(alarmAt);
      return { armed: true, alarmAt };
    }

    /**
     * Run a pass NOW (a manual kick, a just-provisioned scope's first tick, a
     * test). Joins the in-flight pass if one is running — never a second one —
     * and re-arms afterwards while scopes remain.
     */
    async sweepNow(): Promise<ScopeSweepOutcome> {
      return this.#run();
    }

    /** The loop: one pass, then re-arm. Never throws (see the class doc). */
    async alarm(): Promise<void> {
      await this.#run();
    }

    async #rosterSize(): Promise<number> {
      return (await this.ctx.storage.list({ prefix: ROSTER_PREFIX })).size;
    }

    async #run(): Promise<ScopeSweepOutcome> {
      if (this.#pass) return this.#pass;
      this.#pass = (async (): Promise<ScopeSweepOutcome> => {
        try {
          const report = await this.#sweep();
          config.onPass?.(report, this.env);
          return report;
        } catch (err) {
          const outcome = { error: err instanceof Error ? err.message : String(err) };
          config.onPass?.(outcome, this.env);
          return outcome;
        }
      })();
      try {
        return await this.#pass;
      } finally {
        this.#pass = null;
        // Gap, not rate — and only while there is anything to sweep: the alarm
        // lapses on an empty roster, and `noteScope` restarts the loop.
        if ((await this.#rosterSize()) > 0) {
          await this.ctx.storage.setAlarm(Date.now() + config.intervalMs);
        }
      }
    }

    /** One pass over the roster: drain + due schedules per scope, errors contained. */
    async #sweep(): Promise<ScopeSweepReport> {
      const host = config.host(this.env);
      const roster = await this.ctx.storage.list<string>({ prefix: ROSTER_PREFIX });
      const report: ScopeSweepReport = {
        scopes: roster.size,
        drainTotals: { attempted: 0, delivered: 0, retrying: 0, deadLettered: 0 },
        schedules: { scopes: 0, fired: 0, skipped: 0, failed: 0 },
        errors: [],
      };
      const registrations = host.registeredSchedules().filter((r) => r.schedules.length > 0);
      const entries = [...roster].map(([key, tenant]) => ({
        scopeId: key.slice(ROSTER_PREFIX.length) as ScopeId,
        tenantId: tenant as TenantId,
      }));
      const concurrency = config.concurrency ?? 8;
      let next = 0;
      const worker = async (): Promise<void> => {
        while (next < entries.length) {
          const { tenantId, scopeId } = entries[next++]!;
          if (config.drainRetries !== false) {
            try {
              const r = await host.drainDue(tenantId, scopeId);
              report.drainTotals.attempted += r.attempted;
              report.drainTotals.delivered += r.delivered;
              report.drainTotals.retrying += r.retrying;
              report.drainTotals.deadLettered += r.deadLettered;
            } catch (err) {
              report.errors.push({ kind: 'drain', id: scopeId, error: message(err) });
            }
          }
          let touched = false;
          // #1232: the pass's outcomes, batched for ONE intent per scope — a pass every
          // couple of minutes times N schedules cannot be one intent each against the
          // journal cap. Stamped with pass time here; the drain runs a window later.
          const passAt = new Date().toISOString();
          const passRuns: SweepRunsPayload['entries'] = [];
          for (const reg of registrations) {
            try {
              const r = await host.runDueSchedules(reg.moduleId, tenantId, scopeId);
              if (r.fired > 0 || r.failed > 0) touched = true;
              report.schedules.fired += r.fired;
              report.schedules.skipped += r.skipped;
              report.schedules.failed += r.failed;
              for (const e of r.errors) {
                report.errors.push({
                  kind: 'schedule',
                  id: `${scopeId}:${e.operation}`,
                  error: e.error,
                });
              }
              for (const run of r.runs ?? []) {
                passRuns.push({
                  kind: 'schedule',
                  operation: run.operation,
                  outcome: run.outcome,
                  at: passAt as SweepRunsPayload['entries'][number]['at'],
                  ...(run.outcome === 'failed'
                    ? { error: r.errors.find((e) => e.operation === run.operation)?.error ?? null }
                    : {}),
                });
              }
            } catch (err) {
              report.errors.push({
                kind: 'schedule',
                id: `${scopeId}:${reg.moduleId}`,
                error: message(err),
              });
            }
          }
          if (touched) report.schedules.scopes += 1;
          // #1232: freshness verdicts join the same batch — ONCE per scope, since
          // the evaluator aggregates every module's expectations (per-module calls
          // would fight over shared gating state and dedupe units). Change-gated +
          // heartbeat, so most passes contribute nothing here.
          if (host.registeredFreshness && host.checkFreshness) {
            const freshRegs = host.registeredFreshness().filter((r) => r.freshness.length > 0);
            if (freshRegs.length > 0) {
              try {
                const r = await host.checkFreshness(freshRegs[0]!.moduleId, tenantId, scopeId);
                for (const check of r.checks) {
                  passRuns.push({
                    kind: 'freshness',
                    eventType: check.eventType,
                    outcome: check.outcome,
                    at: passAt as SweepRunsPayload['entries'][number]['at'],
                    observedAt: check.observedAt as SweepRunsPayload['entries'][number]['observedAt'],
                  });
                }
              } catch (err) {
                report.errors.push({ kind: 'freshness', id: scopeId, error: message(err) });
              }
            }
          }
          if (passRuns.length > 0 && host.enqueueSweepRuns) {
            try {
              await host.enqueueSweepRuns(scopeId, {
                version: config.versionId?.(this.env) ?? null,
                // The payload caps its batch; a pathological schedule count truncates
                // rather than refusing the whole report.
                entries: passRuns.slice(0, 64),
              });
            } catch {
              // Telemetry never sinks a pass — a failed report is the next pass's to retry.
            }
          }
        }
      };
      await Promise.all(
        Array.from({ length: Math.max(1, Math.min(concurrency, entries.length)) }, worker),
      );
      return report;
    }
  };
}

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));
