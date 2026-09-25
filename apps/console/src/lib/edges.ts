import type { EdgeHealth, EdgeHealthReport } from '@substrat-run/contracts';
import { switchCardState, type SwitchCardState } from './schedules';

/**
 * The Edges card's state (#1705 PR 3), from the tenant's live edge-health read. It is the
 * switches' three-outcome fetch, so a control plane that predates the route (501) reads as its
 * own state and never as "no edges". The labels, tones, lag and lever request are
 * `@substrat-run/contracts`' own, shared with the dashboard.
 */
export type EdgesCardState = SwitchCardState<EdgeHealth>;

/** This scope's edges out of the report: the ones into it and the ones out of it. */
export function edgesCardState(report: EdgeHealthReport | null, error: unknown, scopeId: string): EdgesCardState {
  if (report !== null && report.unavailable !== null) return { kind: 'error', message: report.unavailable };
  const mine =
    report === null
      ? null
      : report.edges.filter((e) => e.consumer.scopeId === scopeId || e.producer.scopeId === scopeId);
  return switchCardState(mine, error);
}
