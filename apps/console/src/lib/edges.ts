import {
  REPLAY_EFFECT,
  SKIP_EFFECT,
  type EdgeHealth,
  type EdgeHealthReport,
  type EdgeHealthState,
  type ImportCursorMove,
} from '@substrat-run/contracts';
import { switchCardState, type SwitchCardState } from './schedules';

/**
 * The Edges card's state (#1705 PR 3), from the tenant's live edge-health read. It is the
 * switches' three-outcome fetch, so a control plane that predates the route (501) reads as its
 * own state and never as "no edges".
 */
export type EdgesCardState = SwitchCardState<EdgeHealth>;

/** This scope's edges out of the tenant's report: the ones into it and the ones out of it. */
export function edgesCardState(report: EdgeHealthReport | null, error: unknown, scopeId: string): EdgesCardState {
  if (report !== null && report.unavailable !== null) return { kind: 'error', message: report.unavailable };
  const mine =
    report === null
      ? null
      : report.edges.filter((e) => e.consumer.scopeId === scopeId || e.producer.scopeId === scopeId);
  return switchCardState(mine, error);
}

/**
 * Badge tone per state. `unavailable` is a side nobody could ask, so it is never `success`, and
 * only a caught-up edge is green. A test holds both halves.
 */
export function edgeBadgeStatus(state: EdgeHealthState): 'success' | 'warning' | 'danger' {
  if (state === 'caught-up') return 'success';
  if (state === 'paused' || state === 'unavailable') return 'danger';
  return 'warning';
}

export function edgeStateLabel(state: EdgeHealthState): string {
  return {
    'caught-up': 'Caught up',
    behind: 'Behind',
    paused: 'Paused',
    unresolved: 'Unresolved',
    unavailable: 'Unavailable',
  }[state];
}

/** The lever sits on an edge INTO this scope whose two ends resolved and could be asked. */
export function leverOffered(edge: EdgeHealth, scopeId: string): boolean {
  return (
    edge.consumer.scopeId === scopeId &&
    edge.producer.scopeId !== null &&
    edge.state !== 'unresolved' &&
    edge.state !== 'unavailable'
  );
}

export type LeverKind = 'replay' | 'skip';

/** What a lever does, in the words the platform refuses a missing acknowledgement in. */
export const LEVER_EFFECT: Record<LeverKind, string> = { replay: REPLAY_EFFECT, skip: SKIP_EFFECT };

export function leverRequest(kind: LeverKind, from: string, reason: string): ImportCursorMove {
  return kind === 'replay'
    ? { mode: 'replay', from, after: null, acknowledge: 'rerun-handlers', reason: reason.trim() }
    : { mode: 'skip', from, through: 'now', acknowledge: 'skip-events', reason: reason.trim() };
}
