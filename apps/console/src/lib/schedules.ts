import type { SystemGrantsStatusEntry } from '@substrat-run/contracts';
import { provesNothingChanged } from '@substrat-run/control-plane-api/browser';
import { ApiError } from './api';
import { runExclusive } from './exclusive';

/**
 * The Schedules card's state (#1675), derived from the status read
 * (`GET .../system-grants`, #1674). Three fetch outcomes, not two: a `501` is the
 * deployment's own proof that it predates the switch/status route (#1666's
 * `VerticalClient.systemSwitch`/`systemGrantsStatus` normalize exactly that shape to
 * 501, "redeploy the vertical") and gets its own state — never rendered as an error,
 * and never confused with `on`. Everything else that failed (503 "no delegation
 * configured" among them) is `error`, likewise never read as `on`.
 */
export type SwitchCardState<T> =
  | { kind: 'loading' }
  | { kind: 'ready'; entries: T[] }
  | { kind: 'predates' }
  | { kind: 'error'; message: string };

/**
 * The three-outcome fetch above, for ANY of the platform's switches — the schedule switch
 * here and the peer switch (#1706), which normalize the same shapes for the same reasons.
 * Written once so the two cards cannot come to disagree about what a 501 means.
 */
export function switchCardState<T>(entries: T[] | null, error: unknown): SwitchCardState<T> {
  if (error !== null && error !== undefined) {
    if (error instanceof ApiError && error.status === 501) return { kind: 'predates' };
    return { kind: 'error', message: error instanceof Error ? error.message : String(error) };
  }
  if (entries === null) return { kind: 'loading' };
  return { kind: 'ready', entries };
}

export type SchedulesCardState = SwitchCardState<SystemGrantsStatusEntry>;

export function schedulesCardState(
  entries: SystemGrantsStatusEntry[] | null,
  error: unknown,
): SchedulesCardState {
  return switchCardState(entries, error);
}

/** Badge tone for one module's position — the same three-way split the kernel's
 *  `systemScheduleState` enumerates. */
export function scheduleBadgeStatus(schedules: SystemGrantsStatusEntry['schedules']): 'success' | 'danger' | 'neutral' {
  if (schedules === 'on') return 'success';
  if (schedules === 'off') return 'danger';
  return 'neutral';
}

/**
 * The reason a switch call requires, checked client-side before the request leaves the
 * browser — mirrors the server's own `z.string().trim().min(1).max(500)` (#1676) so a
 * blank or over-long reason is refused here rather than round-tripped for a 400.
 */
export function validReason(reason: string): boolean {
  const trimmed = reason.trim();
  return trimmed.length > 0 && trimmed.length <= 500;
}

/**
 * Move one module's switch, guarded against a double submit (#1702 review: two clicks
 * in the same tick both read a `useState` flag as `false`, because the setter only
 * lands on the next render — so the guard here is a ref the CALLER owns across
 * renders, via `runExclusive`). Returns `null` when a submit was already in flight and
 * this call was skipped rather than sent; the underlying request throws straight
 * through when it runs and fails, exactly as `runExclusive` does.
 */
export async function submitSwitch<T>(flag: { current: boolean }, run: () => Promise<T>): Promise<T | null> {
  let result: T | null = null;
  await runExclusive(flag, async () => {
    result = await run();
  });
  return result;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The two-step shape one switch confirm is (Copilot review, #1707): the write, and the
 * re-read that confirms it — kept SEPARATE, because the two can fail independently and
 * an operator must never read one failure as the other.
 *
 * - `refused`: the switch itself failed in a way that proves nothing moved
 *   (`provesNothingChanged`: a 4xx, or a 501 from a deployment that predates the route). This is the only branch that should ever read as "Refused" — the
 *   naive single `try/catch` this replaces caught BOTH steps together, so a switch that
 *   succeeded but whose follow-up read failed also said "Refused", with the card left
 *   showing the stale (now wrong) position. An operator reading that would retry a switch
 *   that had already happened.
 * - `unknown` (#2010): the switch call failed in a way that does NOT prove that — its answer
 *   was lost — so the position is read again, which is the confirmation the failure itself
 *   asks for. `entries` is that read, or null with `readError` when it failed too.
 * - `unconfirmed`: the switch applied (`result` is real), but the read that would
 *   prove it — and show the fresh position — failed. The card must show neither the
 *   stale entries nor a false "Refused"; it shows `error`, same as any other read
 *   failure (`schedulesCardState`), so the operator sees "unknown, go look" rather
 *   than a wrong answer in either direction.
 * - `applied`: both steps landed. `entries` is the fresh read to render.
 */
export type SwitchAttempt<T, E> =
  | { kind: 'applied'; result: T; entries: E }
  | { kind: 'refused'; error: unknown }
  | { kind: 'unknown'; error: unknown; entries: E; readError?: never }
  | { kind: 'unknown'; error: unknown; entries: null; readError: unknown }
  | { kind: 'unconfirmed'; result: T; error: unknown };

export async function performSwitch<T, E>(
  runSwitch: () => Promise<T>,
  refresh: () => Promise<E>,
): Promise<SwitchAttempt<T, E>> {
  let result: T;
  try {
    result = await runSwitch();
  } catch (error) {
    if (provesNothingChanged(error)) return { kind: 'refused', error };
    try {
      return { kind: 'unknown', error, entries: await refresh() };
    } catch (readError) {
      return { kind: 'unknown', error, entries: null, readError };
    }
  }
  try {
    const entries = await refresh();
    return { kind: 'applied', result, entries };
  } catch (error) {
    return { kind: 'unconfirmed', result, error };
  }
}

/**
 * The toast for an `unknown` switch (#2010), one wording for every switch card: never
 * "Refused", which would send an operator to retry a switch that may have moved.
 */
/**
 * #2089: the toast for a switch that MOVED but whose outcome row the admin log could not take —
 * the answer's `auditWarning`. Shown beside the success, never instead of it: the switch is where
 * the card says, and nothing should be done again. Null when the row landed.
 */
export function auditWarningToast(
  subject: string,
  slug: string,
  result: { auditWarning?: string },
): [title: string, body: string] | null {
  return result.auditWarning
    ? [
        'Switched, but not recorded in the admin log',
        `${subject} on ${slug} · ${result.auditWarning}. Staff are told; there is nothing to redo.`,
      ]
    : null;
}

export function unknownSwitchToast<E>(
  subject: string,
  slug: string,
  attempt: Extract<SwitchAttempt<unknown, E>, { kind: 'unknown' }>,
): [title: string, body: string] {
  return [
    'Not confirmed — the switch may or may not have moved',
    `${subject} on ${slug} · ${errorMessage(attempt.error)} · ` +
      (attempt.entries === null
        ? 'Its position could not be re-read either; read it before trying again.'
        : 'The card now shows its position, read just now; check it before trying again.'),
  ];
}
