import { DurableObject } from 'cloudflare:workers';
import type { PlatformSweepReport } from '@substrat-run/kernel';

/**
 * The singleton's name: every caller reaches the ONE sweeper via
 * `env.SWEEPER.get(env.SWEEPER.idFromName(PLATFORM_SWEEPER_NAME))`, so the whole
 * deployment shares a single alarm — one pass at a time, fleet-wide, the same
 * guarantee `startPlatformSweeper` gives a node process.
 */
export const PLATFORM_SWEEPER_NAME = 'platform-sweeper';

/** One settled pass: the report, or the error that sank the whole pass. */
export type PlatformSweepOutcome = PlatformSweepReport | { error: string };

export interface PlatformSweeperDoConfig<Env> {
  /**
   * Milliseconds between the END of one pass and the START of the next — a gap,
   * not a fixed rate (the exact contract `startPlatformSweeper.intervalMs` has).
   * The next alarm is set only once the current pass settles, so a slow pass
   * delays the next rather than stacking on it.
   */
  intervalMs: number;
  /**
   * One pass — build the host from the deployment's bindings and call
   * `runPlatformSweep` (kernel). CODE-TIME, closed over like `defineScopeDO`'s
   * module set: a Durable Object cannot receive closures over RPC, and the
   * deployment that owns the call site is the one place that legitimately
   * assembles the connector-sweeper registry (scheduler.md §3.1).
   *
   * Built per invocation, never cached — a `CloudflareScopeHost` holds DO stubs,
   * which are owned by the event that created them.
   */
  sweep(env: Env): Promise<PlatformSweepReport>;
  /** Observe each pass — logging or a health metric. Never throws into the loop. */
  onPass?(outcome: PlatformSweepOutcome, env: Env): void;
}

/** The RPC surface a `definePlatformSweeperDO` class exposes over its stub. */
export interface PlatformSweeperDo {
  /** Arm the loop if it is not armed — idempotent, safe on every request. */
  ensureArmed(): Promise<{ armed: boolean; alarmAt: number }>;
  /** Run a pass now (joining any in-flight pass), then re-arm. */
  sweepNow(): Promise<PlatformSweepOutcome>;
}

/**
 * `definePlatformSweeperDO` — the Cloudflare trigger for `runPlatformSweep`
 * (docs/architecture/scheduler.md §3.0): a singleton Durable Object whose `alarm()`
 * runs one sweep pass and re-arms itself, the workerd analogue of
 * `startPlatformSweeper`'s self-rescheduling timer.
 *
 * Why an alarm and not a cron `scheduled()` handler:
 *
 *   - **Dispatch user-workers get no cron.** A hosted vertical is pushed into a
 *     Workers-for-Platforms dispatch namespace (`substrat push`), where
 *     `triggers.crons` is not honoured — a DO alarm is the only timer such a
 *     deployment can own. A standalone deployment (own account, `wrangler
 *     deploy`) can ALSO use a cron, but then only as the safety net below.
 *   - **Non-overlap by construction.** Overlapping cron invocations are possible
 *     when a pass outruns the interval; here the next alarm is set only after
 *     the pass settles, and concurrent kicks (`sweepNow` during a pass) join the
 *     in-flight pass instead of starting a second one.
 *   - **No config.** An alarm self-arms from code (`ensureArmed`); there is no
 *     `triggers` entry to forget, and nothing for an upload path to drop.
 *
 * Arming: an alarm exists only once something sets it, so call `ensureArmed()`
 * from a spot every deployment passes through — the provisioning route
 * (`/internal/provision`) and/or fire-and-forget on ordinary requests
 * (`ctx.waitUntil(stub.ensureArmed())`). It is idempotent and does not move an
 * alarm that is already set, so calling it per-request is safe and cheap. Where
 * a cron IS available, point `scheduled()` at `ensureArmed()` — the cron then
 * only recovers a lost alarm (scheduler.md §4's safety-net shape), never runs
 * the work itself.
 *
 * Failure: the pass's own per-unit errors are already contained in the report
 * (`runPlatformSweep` never lets one scope or connection sink a pass); a throw
 * of the whole pass (e.g. the directory being unreachable) is caught, reported
 * via `onPass`, and the alarm is STILL re-armed — the loop never dies, and the
 * alarm is never left to workerd's own retry (which would tighten the interval
 * we promised to keep).
 *
 * Wire-up (mirror of the node call site in `demos/meridian/src/server.ts`):
 *
 * ```ts
 * export const SweeperDO = definePlatformSweeperDO<Env>({
 *   intervalMs: 120_000,
 *   sweep: (env) =>
 *     runPlatformSweep(hostFor(env), {
 *       actor: SWEEP_ACTOR,
 *       fetch: globalThis.fetch as unknown as FetchLike,
 *       sweepers: { scrive: sweepScriveReconciliations },
 *     }),
 * });
 * // wrangler.jsonc: bind it (e.g. SWEEPER) + a migration tag; then arm it:
 * // await env.SWEEPER.get(env.SWEEPER.idFromName(PLATFORM_SWEEPER_NAME)).ensureArmed()
 * ```
 */
export function definePlatformSweeperDO<Env>(
  config: PlatformSweeperDoConfig<Env>,
): new (ctx: DurableObjectState, env: Env) => DurableObject<Env> & PlatformSweeperDo {
  return class PlatformSweeperDO extends DurableObject<Env> {
    /** The in-flight pass, when one is running — the overlap guard. */
    #pass: Promise<PlatformSweepOutcome> | null = null;

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
     * Run a pass NOW (a manual kick, a webhook's "reconcile sooner" nudge, a
     * test). Joins the in-flight pass if one is running — never a second one —
     * and re-arms the alarm afterwards, so a kick also (re)starts the loop.
     */
    async sweepNow(): Promise<PlatformSweepOutcome> {
      return this.#run();
    }

    /** The loop: one pass, then re-arm. Never throws (see the class doc). */
    async alarm(): Promise<void> {
      await this.#run();
    }

    async #run(): Promise<PlatformSweepOutcome> {
      if (this.#pass) return this.#pass;
      this.#pass = (async (): Promise<PlatformSweepOutcome> => {
        try {
          const report = await config.sweep(this.env);
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
        // Gap, not rate: scheduled only after the pass settled — success or not.
        await this.ctx.storage.setAlarm(Date.now() + config.intervalMs);
      }
    }
  };
}
