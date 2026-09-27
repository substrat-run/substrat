/**
 * Only the latest of several overlapping reads may land.
 *
 * A screen with a poll and a push both calling its read will have two in flight
 * sometimes, and they can answer out of order: a slow read started before a change
 * would then overwrite the fast one started after it, and the screen would show the
 * old state until the next tick. Each read takes a ticket when it starts and asks
 * before every write whether it is still the latest. The inbox does the same with its
 * own counter; this is that counter, where a node test can reach it.
 */
export function latestOnly(): () => () => boolean {
  let current = 0;
  return () => {
    const mine = ++current;
    return () => mine === current;
  };
}
