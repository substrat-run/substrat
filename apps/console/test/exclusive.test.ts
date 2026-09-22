import { describe, expect, it } from 'vitest';
import { runExclusive } from '../src/lib/exclusive';

/**
 * The "Load more" guard (#1690 review). Two activations before the first page
 * lands must fetch once, or the same rows are appended twice.
 */
describe('runExclusive', () => {
  it('a second call while the first is in flight is skipped', async () => {
    const flag = { current: false };
    let calls = 0;
    let release!: () => void;
    const fn = () => {
      calls += 1;
      return new Promise<void>((r) => (release = r));
    };
    const first = runExclusive(flag, fn);
    const second = runExclusive(flag, fn);
    expect(await second).toBe(false);
    release();
    expect(await first).toBe(true);
    expect(calls).toBe(1);
  });

  it('its twin: once the first settles, the next call runs', async () => {
    const flag = { current: false };
    let calls = 0;
    const fn = async () => void (calls += 1);
    expect(await runExclusive(flag, fn)).toBe(true);
    expect(await runExclusive(flag, fn)).toBe(true);
    expect(calls).toBe(2);
  });

  it('a throwing run releases the flag and still rejects', async () => {
    const flag = { current: false };
    await expect(runExclusive(flag, async () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    expect(flag.current).toBe(false);
  });
});
