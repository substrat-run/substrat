import { describe, expect, it } from 'vitest';
import type { StoreDriverReleaseUpload } from '@substrat-run/contracts';
import type { StoreDriverView } from '@substrat-run/control-plane-client';
import { parseWaitMs, publishStoreDriver } from '../src/store-driver.js';

const SHA = 'a'.repeat(64);
const body = { sourceCommit: 'b'.repeat(40), entry: 'driver_x/m.py', modules: [] } as unknown as StoreDriverReleaseUpload;
const approval = (revokedAt: string | null = null) => ({ sha256: SHA, revokedAt }) as StoreDriverView['approvals'] extends (infer A)[] | undefined ? A : never;
const rollout = (state: string, extra = {}) => ({ seq: 1, state, detail: null, ...extra });

/** A fake plane: `views` are the successive status reads, `rollouts` the successive rollout replies. */
function fake(views: Partial<StoreDriverView>[], rollouts: { state: string; moved: number; complete: boolean; remaining: number; detail?: string }[]) {
  const calls: string[] = [];
  let v = 0;
  let r = 0;
  const client = {
    uploadStoreDriverRelease: async () => (calls.push('upload'), { release: { sha256: SHA, sourceCommit: body.sourceCommit } }),
    getStoreDriver: async () => (calls.push('status'), { rollouts: [], ...views[Math.min(v++, views.length - 1)] } as StoreDriverView),
    rollOutStoreDriver: async () => {
      calls.push('rollout');
      const x = rollouts[Math.min(r++, rollouts.length - 1)]!;
      return { rollout: rollout(x.state, { detail: x.detail ?? null }), moved: Array(x.moved).fill('v'), complete: x.complete, remaining: x.remaining };
    },
  } as never;
  const lines: string[] = [];
  const slept: number[] = [];
  const run = (waitMs: number) => publishStoreDriver({ client, driver: 'graph', body, waitMs, pollMs: 10, sleep: async (ms) => void slept.push(ms), log: (l) => void lines.push(l) });
  return { run, calls, lines, slept };
}

describe('store-driver publish (#2297)', () => {
  it('uploads, rolls out an approved release and resumes a partial rollout until it is good', async () => {
    const f = fake([{ approvals: [approval()] }], [{ state: 'rolling', moved: 0, complete: false, remaining: 5 }, { state: 'good', moved: 0, complete: true, remaining: 0 }]);
    expect(await f.run(0)).toEqual({ outcome: 'published', sha256: SHA });
    expect(f.calls).toEqual(['upload', 'status', 'rollout', 'rollout']);
  });

  it('without --wait, an unapproved release is reported and nothing is rolled out', async () => {
    const f = fake([{ approvals: [] }], []);
    expect((await f.run(0)).outcome).toBe('awaiting-approval');
    expect(f.calls).toEqual(['upload', 'status']);
    expect(f.lines.join('\n')).toContain('substrat store-driver approve --driver graph --sha256 ' + SHA);
  });

  it('with --wait, polls until the approval appears, then rolls out; a revoked one does not count', async () => {
    const f = fake([{ approvals: [approval('2026-01-01')] }, { approvals: [] }, { approvals: [approval()] }], [{ state: 'good', moved: 1, complete: true, remaining: 0 }]);
    expect((await f.run(100)).outcome).toBe('published');
    expect(f.slept).toEqual([10, 10]);
  });

  it('with --wait, gives up as awaiting-approval once the wait is spent', async () => {
    const f = fake([{ approvals: [] }], []);
    expect((await f.run(30)).outcome).toBe('awaiting-approval');
    expect(f.slept).toEqual([10, 10, 10]);
    expect(f.calls).not.toContain('rollout');
  });

  it('an already-current release rolls nothing out', async () => {
    const f = fake([{ current: { sha256: SHA, seq: 1, previousGoodSha256: null }, approvals: [] }], []);
    expect((await f.run(0)).outcome).toBe('published');
    expect(f.calls).toEqual(['upload', 'status']);
  });

  it.each(['paused', 'diverged', 'failed'])('a rollout that ends %s is an error, not a success', async (state) => {
    const f = fake([{ approvals: [approval()] }], [{ state, moved: 1, complete: true, remaining: 0, detail: 'why' }]);
    await expect(f.run(0)).rejects.toThrow(new RegExp(`ended ${state}: why`));
  });

  it('a rollout whose remaining count stops falling is refused rather than looped on, though it moves nothing while it walks', async () => {
    const f = fake([{ approvals: [approval()] }], [{ state: 'paused', moved: 0, complete: false, remaining: 4 }]);
    await expect(f.run(0)).rejects.toThrow(/walked no further in 3 requests/);
    expect(f.calls.filter((c) => c === 'rollout')).toHaveLength(4);
  });

  it('a current release with a paused rollout since it is not reported as done: it is posted again to converge', async () => {
    const current = { sha256: SHA, seq: 1, previousGoodSha256: null };
    const f = fake([{ current, approvals: [approval()], rollouts: [{ seq: 2, state: 'paused' }] as never }], [{ state: 'good', moved: 1, complete: true, remaining: 0 }]);
    expect((await f.run(0)).outcome).toBe('published');
    expect(f.calls).toContain('rollout');
  });

  it('the last sleep is cut to what is left of --wait', async () => {
    const f = fake([{ approvals: [] }], []);
    await f.run(15);
    expect(f.slept).toEqual([10, 5]);
  });

  it('--wait takes seconds, minutes or hours and refuses anything else', () => {
    expect([parseWaitMs('90s'), parseWaitMs('30m'), parseWaitMs('2h')]).toEqual([90_000, 1_800_000, 7_200_000]);
    expect(() => parseWaitMs('soon')).toThrow(/--wait takes a duration/);
    expect(() => parseWaitMs('')).toThrow(/--wait takes a duration/); // what a bare --wait hands it
  });
});
