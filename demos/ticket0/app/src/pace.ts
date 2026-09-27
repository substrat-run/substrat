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
 * Both screens slow to the floor while connected, because everything either one shows
 * is pushed to everyone who could poll it. The conversation view used to keep its 5s
 * pace: a follower (`conversation:read` narrowed onto one thread) was never pushed an
 * assistant turn, because the permission walk up from the camelCase `aiTurn` type threw
 * and the fan-out read the throw as a refusal. With #1856 fixed, the walk answers and the
 * follower hears the turn on the push.
 */
export const PACE = {
  inbox: { everyMs: 10_000, connectedMs: LIVE_FLOOR_MS },
  conversation: { everyMs: 5_000, connectedMs: LIVE_FLOOR_MS },
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
