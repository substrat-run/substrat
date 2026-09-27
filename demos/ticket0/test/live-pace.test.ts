/**
 * How often each screen still polls once the live feed is open (#938).
 *
 * The conversation view keeps its five-second pace while connected, because a follower
 * is not pushed an assistant turn until #1856 is fixed, and at the inbox's one-minute
 * floor a follower would see a new draft a minute late. This pins that choice, so it
 * moves only when #1856 does: relax `PACE.conversation.connectedMs` in the same change
 * that makes the follower's pinned `[]` in `test/workerd/sweeper.test.ts` a turn id.
 */
import { describe, expect, it } from 'vitest';
import { LIVE_FLOOR_MS, PACE, pollPace } from '../app/src/pace.js';

describe('the poll pace behind the live feed', () => {
  it('keeps the conversation view at five seconds with the feed open (#1856)', () => {
    expect(pollPace(PACE.conversation, true)).toBe(5_000);
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
