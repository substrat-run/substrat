/**
 * K-74: a scope's handoff state on the Durable Object — what it keeps between commits in storage KV
 * (`DELIVERY_HANDOFF_KEY`), and the retry decision its alarm runs on. The decision is here, with no
 * I/O, so a test runs it on its own clock, as `scope-wake.ts` does for the wake.
 */
import { HANDOFF_RETRY_MS, retryAfter, type HandoffMarks } from '@substrat-run/kernel';

/** The storage key. Storage KV, never SQL: dumps and module SQL cannot see it. */
export const DELIVERY_HANDOFF_KEY = 'delivery-handoff';

export interface HandoffState {
  /** The scope's ids, as the commit that last handed off knew them: what the alarm retries under. */
  tenantId?: string;
  scopeId?: string;
  /** The greatest id the broker acknowledged, per kind. Absent: ask the broker (`marks`). */
  marks?: HandoffMarks;
  /** Handoffs failed in a row, for the back-off. */
  retries?: number;
  /** Epoch ms the alarm retries at. Absent: nothing to retry. */
  due?: number;
}

/** After a failed handoff: keep what is known, count the failure, and say when to retry. */
export function handoffAfterFailure(
  prior: HandoffState | null,
  marks: HandoffMarks | undefined,
  now: number,
  ids?: { tenantId: string; scopeId: string },
): HandoffState {
  const retries = (prior?.retries ?? 0) + 1;
  const known = marks ?? prior?.marks;
  const tenantId = ids?.tenantId ?? prior?.tenantId;
  const scopeId = ids?.scopeId ?? prior?.scopeId;
  return {
    ...(tenantId && scopeId ? { tenantId, scopeId } : {}),
    ...(known ? { marks: known } : {}),
    retries,
    due: now + retryAfter(HANDOFF_RETRY_MS, retries),
  };
}

/** Is a retry due at `now`? */
export function handoffDue(state: HandoffState | null, now: number): boolean {
  return state?.due !== undefined && state.due <= now;
}

/**
 * The state to store: `next`, with each mark the greater of it and what `fresh` (read just now)
 * holds, since another commit's handoff may have stored a later one meanwhile. A mark never moves
 * backwards, and no marks are invented where neither side has any.
 */
export function mergeHandoff(fresh: HandoffState | null, next: HandoffState): HandoffState {
  const marks: HandoffMarks = { ...(fresh?.marks ?? {}) };
  for (const [kind, mark] of Object.entries(next.marks ?? {}) as [keyof HandoffMarks, string][]) {
    if (marks[kind] === undefined || mark > marks[kind]!) marks[kind] = mark;
  }
  const { marks: _drop, ...rest } = next;
  return fresh?.marks || next.marks ? { ...rest, marks } : rest;
}
