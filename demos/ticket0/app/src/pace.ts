/**
 * How often each screen polls, with the live feed (#938) open and without it.
 *
 * Its own module, free of the DOM, so the node suite can pin these numbers without
 * compiling the hook that uses them (`live.ts`).
 */
/** How often a screen still polls while it is being pushed to, unless it says otherwise. */
export const LIVE_FLOOR_MS = 60_000;

/** How often a screen polls: without a socket, and with one open. */
export interface Pace {
  everyMs: number;
  connectedMs: number;
}

/**
 * Each screen's pace, in one place so a test can pin it.
 *
 * The conversation view does NOT slow down while connected, and that is a stopgap with
 * a named end. A follower (`conversation:read` narrowed onto one thread) is never pushed
 * an assistant turn today: the scope's permission walk throws on the camelCase `aiTurn`
 * type and the fan-out reads that as a refusal (#1856). At the 60s floor a follower
 * would see a new draft up to a minute late, where the 5s poll showed it within five
 * seconds. So the view keeps its old pace until #1856 lands, and the push there only
 * makes things sooner. The inbox has no such gap, since a list is staff-only and staff
 * hold the key scope-wide, so it takes the floor.
 */
export const PACE = {
  inbox: { everyMs: 10_000, connectedMs: LIVE_FLOOR_MS },
  conversation: { everyMs: 5_000, connectedMs: 5_000 },
} as const satisfies Record<string, Pace>;

/**
 * The interval a screen polls at, given whether the feed is open.
 *
 * Never faster with the feed open than without it: a `connectedMs` below `everyMs` is
 * read as `everyMs`, so a mistyped pace cannot turn a push into more polling.
 */
export function pollPace(pace: Pace, open: boolean): number {
  return open ? Math.max(pace.everyMs, pace.connectedMs) : pace.everyMs;
}
