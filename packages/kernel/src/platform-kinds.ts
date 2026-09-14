/**
 * Platform intent kinds only the platform itself may author (#1474).
 *
 * `ctx.requestPlatform` takes any non-empty `kind`, and the drain dispatches on
 * `kind` alone with no check of who enqueued the row. That is right for the kinds a
 * vertical is meant to raise (`provision-sibling`, `model-usage`, …), and wrong for
 * one the platform writes into the same journal on its own behalf: `sweep-runs`
 * (#1232) is the CP-less scope sweeper's batched schedule outcomes, and its handler
 * lands every entry into `_substrat_sweep_runs`. Enqueued from module code, it
 * forges the vertical's own schedule and freshness verdicts — a stale schedule
 * reads green on the dashboard and in the fleet rollup.
 *
 * So the refusal lives where the journal is handed to module code: both adapters
 * call `assertModuleEnqueueableKind` first in `ctx.requestPlatform`, before the
 * backpressure count and the insert. The sweeper's own road (`enqueueSweepRuns` on
 * the ScopeDO) writes the journal directly and never passes through here.
 *
 * `model-usage` is deliberately NOT listed: a vertical's model host raises it from
 * module code by design (#1054), and the drain attributes it from the scope the
 * intent lives in rather than from the payload.
 */
import { SWEEP_RUNS_KIND, substratError } from '@substrat-run/contracts';

/** Kinds `ctx.requestPlatform` refuses: the platform enqueues these itself. */
export const PLATFORM_AUTHORED_KINDS: ReadonlySet<string> = new Set([SWEEP_RUNS_KIND]);

/**
 * Refuse a platform-authored kind from module code. Throws a `forbidden`
 * (`reason: 'platform_authored_kind'`) naming the kind, before anything is written.
 */
export function assertModuleEnqueueableKind(kind: string): void {
  if (!PLATFORM_AUTHORED_KINDS.has(kind)) return;
  throw substratError(
    'forbidden',
    `ctx.requestPlatform cannot enqueue '${kind}': the platform authors that intent kind itself.`,
    { reason: 'platform_authored_kind' },
  );
}
