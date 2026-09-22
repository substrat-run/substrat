import { describe, expect, it } from 'vitest';
import { verticalSlug, type VerticalChannel } from '@substrat-run/contracts';
import { countTrailingPromotes } from '../src/lib/services';

const now = Date.parse('2026-09-22T12:00:00Z');
const vertical = (slug: string, servingRef: string | null = 'worker') => ({ slug: verticalSlug.parse(slug), servingRef });
const channel = (minutes: number, serving = '01JZ0000000000000000000001'): VerticalChannel => ({
  verticalSlug: verticalSlug.parse('acme'),
  channel: 'prod',
  versionId: '01JZ0000000000000000000002',
  servingVersionId: serving,
  updatedAt: new Date(now - minutes * 60_000).toISOString() as VerticalChannel['updatedAt'],
});

describe('Services deploy reads', () => {
  it('overlaps independent reads with at most four in flight', async () => {
    const releases: (() => void)[] = [];
    let active = 0;
    let peak = 0;
    let started = 0;
    const result = countTrailingPromotes(
      Array.from({ length: 9 }, (_, i) => vertical(`vertical-${i}`)),
      async () => {
        started += 1;
        peak = Math.max(peak, ++active);
        await new Promise<void>((resolve) => releases.push(resolve));
        active -= 1;
        return { entries: [channel(11)] };
      },
      now,
    );
    expect(started).toBe(4);
    while (releases.length) {
      releases.shift()!();
      // Let a completed read start its next queued vertical.
      await Promise.resolve();
      await Promise.resolve();
    }
    expect(await result).toBe(9);
    expect(peak).toBe(4);
  });

  it('ignores legacy dispatch, healthy channels and promotes no older than ten minutes', async () => {
    const seen: string[] = [];
    const pages: Record<string, VerticalChannel[]> = {
      healthy: [channel(30, '01JZ0000000000000000000002')],
      recent: [channel(9)],
      boundary: [channel(10)],
      trailing: [channel(11)],
      absent: [],
    };
    expect(await countTrailingPromotes(
      [...Object.keys(pages).map((slug) => vertical(slug)), vertical('legacy', null)],
      async (slug) => { seen.push(slug); return { entries: pages[slug]! }; },
      now,
    )).toBe(1);
    expect(seen).not.toContain('legacy');
  });

  it('rejects a failed channel read so the tile shows unavailable, not a partial count', async () => {
    await expect(countTrailingPromotes([vertical('failed')], async () => {
      throw new Error('offline');
    }, now)).rejects.toThrow('offline');
    expect(await countTrailingPromotes([], async () => { throw new Error('unused'); }, now)).toBe(0);
  });
});
