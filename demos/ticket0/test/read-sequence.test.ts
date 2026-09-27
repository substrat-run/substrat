/**
 * A read that answers late never overwrites one that started after it (#938). The
 * conversation view is read by a poll and by a push, so two can be in flight, and
 * `latestOnly` is what decides which of them may write.
 */
import { describe, expect, it } from 'vitest';
import { latestOnly } from '../app/src/sequence.js';

describe('only the latest read lands', () => {
  it('lets the later read write and the earlier one not, whichever answers last', async () => {
    const reads = latestOnly();
    let shown = 'nothing';
    const deferred = () => {
      let resolve!: (v: string) => void;
      const promise = new Promise<string>((r) => (resolve = r));
      return { promise, resolve };
    };
    // The same shape as `load()`: take a ticket, await, write only if still the latest.
    const load = async (answer: Promise<string>) => {
      const isLatest = reads();
      const value = await answer;
      if (isLatest()) shown = value;
    };

    const slow = deferred();
    const fast = deferred();
    const first = load(slow.promise); // started before the change
    const second = load(fast.promise); // started after it
    fast.resolve('after the change');
    await second;
    slow.resolve('before the change');
    await first;
    expect(shown).toBe('after the change');
  });

  it('lets a lone read write', async () => {
    const reads = latestOnly();
    const isLatest = reads();
    expect(isLatest()).toBe(true);
  });
});
