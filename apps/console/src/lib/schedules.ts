import type { SystemGrantsStatusEntry } from '@substrat-run/contracts';
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
export type SchedulesCardState =
  | { kind: 'loading' }
  | { kind: 'ready'; entries: SystemGrantsStatusEntry[] }
  | { kind: 'predates' }
  | { kind: 'error'; message: string };

export function schedulesCardState(
  entries: SystemGrantsStatusEntry[] | null,
  error: unknown,
): SchedulesCardState {
  if (error !== null && error !== undefined) {
    if (error instanceof ApiError && error.status === 501) return { kind: 'predates' };
    return { kind: 'error', message: error instanceof Error ? error.message : String(error) };
  }
  if (entries === null) return { kind: 'loading' };
  return { kind: 'ready', entries };
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
