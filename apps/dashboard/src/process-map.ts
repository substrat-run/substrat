import type { EmittedLifecycle, EmittedModel, LifecycleFlowResult } from '@substrat-run/contracts';

/**
 * The process map's windows (#1744) — which lifecycle an app declares, and the two
 * periods the screen compares: the one asked for and the one just before it.
 *
 * Pure, so the arithmetic is tested without a worker: the replay itself is the kernel's
 * `readLifecycleFlow`, reached through the control plane like every outbox read.
 */
export const PROCESS_PERIODS = { '24h': 24 * 3_600_000, '7d': 7 * 86_400_000, '30d': 30 * 86_400_000 } as const;
export type ProcessPeriod = keyof typeof PROCESS_PERIODS;

export const isProcessPeriod = (v: unknown): v is ProcessPeriod =>
  typeof v === 'string' && Object.prototype.hasOwnProperty.call(PROCESS_PERIODS, v);

/** The two half-open windows: `[now − p, now)` and the equal one before it. */
export function processWindows(period: ProcessPeriod, now: number) {
  const span = PROCESS_PERIODS[period];
  const iso = (t: number) => new Date(t).toISOString();
  return {
    current: { since: iso(now - span), until: iso(now) },
    previous: { since: iso(now - 2 * span), until: iso(now - span) },
  };
}

/** One declared lifecycle as the screen lists it: the entity, and how big its machine is. */
export interface DeclaredProcess {
  entity: string;
  initial: string;
  states: number;
  edges: number;
}

export function declaredProcesses(model: EmittedModel | null): DeclaredProcess[] {
  return Object.entries(model?.lifecycles ?? {})
    .map(([entity, lc]) => ({
      entity,
      initial: lc.initial,
      states: Object.keys(lc.states).length,
      edges: Object.values(lc.states).reduce((n, s) => n + Object.keys(s.on ?? {}).length, 0),
    }))
    .sort((a, b) => a.entity.localeCompare(b.entity));
}

/**
 * Why there is no replay to show. Each is a different next step for the reader, so they
 * are kept apart rather than rendered as one empty map:
 * - `no-version`: nothing is running, so there is no model to read a lifecycle from;
 * - `no-lifecycles`: the running version declares none (#844 is opt-in per entity);
 * - `not-yet-available`: the app's deployed code predates the read — re-push it.
 */
export type ProcessUnavailable = 'no-version' | 'no-lifecycles' | 'not-yet-available';

export interface ProcessMapAnswer {
  versionId: string | null;
  processes: DeclaredProcess[];
  entity: string | null;
  /** The machine the counts were replayed against — what the screen lays out. */
  lifecycle: EmittedLifecycle | null;
  period: ProcessPeriod;
  current: LifecycleFlowResult | null;
  previous: LifecycleFlowResult | null;
  unavailable: ProcessUnavailable | null;
}
