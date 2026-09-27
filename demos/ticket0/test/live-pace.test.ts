/**
 * How often each screen still polls once the live feed is open (#938).
 *
 * Both screens take the floor while connected. The conversation view kept its
 * five-second pace until #1856, because a follower was not pushed an assistant turn.
 * It relaxed in the same change that made the follower's feed in
 * `test/workerd/sweeper.test.ts` carry the turn, and that test is what this pace rests on.
 */
import { describe, expect, it } from 'vitest';
import { LIVE_FLOOR_MS, PACE, pollPace } from '../app/src/pace.js';

describe('the poll pace behind the live feed', () => {
  it('slows the conversation view to the floor while the feed is open, and keeps its old pace without one (#1856)', () => {
    expect(pollPace(PACE.conversation, true)).toBe(LIVE_FLOOR_MS);
    expect(pollPace(PACE.conversation, false)).toBe(5_000);
  });

  it('slows the inbox to the floor while the feed is open, and keeps its old pace without one', () => {
    expect(pollPace(PACE.inbox, true)).toBe(LIVE_FLOOR_MS);
    expect(pollPace(PACE.inbox, false)).toBe(10_000);
  });

  it('never polls faster with the feed open than without it', () => {
    expect(pollPace({ everyMs: 10_000, connectedMs: 1_000 }, true)).toBe(10_000);
  });
});
