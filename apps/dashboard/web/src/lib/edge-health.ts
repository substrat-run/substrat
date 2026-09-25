import {
  REPLAY_EFFECT,
  SKIP_EFFECT,
  type EdgeHealth,
  type EdgeHealthState,
  type ImportCursorMove,
} from '@substrat-run/contracts';

/**
 * How an edge's state reads on a pill (#1705 PR 3). `unavailable` is a side the platform could
 * not ask. It says nothing about whether events move, so it is never `success`. A test holds
 * that, because a green pill over an edge nobody could read is how a stalled integration hides.
 */
export const EDGE_STATE: Record<EdgeHealthState, { kind: 'success' | 'warning' | 'danger' | 'neutral'; label: string }> = {
  'caught-up': { kind: 'success', label: 'Caught up' },
  behind: { kind: 'warning', label: 'Behind' },
  paused: { kind: 'danger', label: 'Paused' },
  unresolved: { kind: 'warning', label: 'Unresolved' },
  unavailable: { kind: 'danger', label: 'Unavailable' },
};

/** How long the oldest waiting event has waited, in a person's words. */
export function lagText(ms: number | null): string | null {
  if (ms === null) return null;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} h`;
  return `${Math.floor(h / 24)} days`;
}

/**
 * Whether this app may pull the lever on an edge: only on an edge INTO it (the watermark is the
 * consumer's), and only where both ends resolved. On an unresolved edge there is no watermark the
 * sweep would read, and on an unavailable one the consumer could not be reached to move it.
 */
export function leverOffered(edge: EdgeHealth, appScopeId: string): boolean {
  return (
    edge.consumer.scopeId === appScopeId &&
    edge.producer.scopeId !== null &&
    edge.state !== 'unresolved' &&
    edge.state !== 'unavailable'
  );
}

export type LeverKind = 'replay' | 'skip';

/** What the dialog says a lever does, before the person agrees to it. The same words the platform refuses in. */
export const LEVER_EFFECT: Record<LeverKind, string> = { replay: REPLAY_EFFECT, skip: SKIP_EFFECT };

/** The request a dialog sends once the person has ticked the acknowledgement. */
export function leverRequest(kind: LeverKind, from: string, reason: string): ImportCursorMove {
  return kind === 'replay'
    ? { mode: 'replay', from, after: null, acknowledge: 'rerun-handlers', reason: reason.trim() }
    : { mode: 'skip', from, through: 'now', acknowledge: 'skip-events', reason: reason.trim() };
}
