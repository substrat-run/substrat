import { describe, expect, it } from 'vitest';
import { verticalSlug, type SystemSwitchRecord, type VerticalChannel } from '@substrat-run/contracts';
import { countTrailingPromotes, PENDING_STALE_MINUTES, pendingCaption, readPending, summarizeSystemSwitches } from '../src/lib/services';

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

/**
 * The kill-switch tile's fleet totals (#1690 §2). One row per (scope, module) held off —
 * `GET /system-switches`'s own shape (`systemSwitchRecord`, packages/contracts/src/permission.ts) —
 * so a scope with two modules off must count once toward `scopes`, and two tenants with one
 * switch each must count as two.
 */
const switchRow = (over: Partial<Pick<SystemSwitchRecord, 'tenantId' | 'scopeId' | 'moduleId'>>) =>
  ({
    tenantId: 't-1',
    scopeId: 's-1',
    moduleId: '@substrat-run/engine-workorder',
    vertical: 'callout',
    position: 'off',
    actor: '01J00000000000000000000000',
    reason: 'incident #42',
    operationId: '01J00000000000000000000001',
    at: '2026-09-01T12:00:00.000Z',
    ...over,
  }) as unknown as SystemSwitchRecord;

describe('summarizeSystemSwitches', () => {
  it('the zero twin: no rows, no scopes, no tenants', () => {
    expect(summarizeSystemSwitches([])).toEqual({ scopes: 0, tenants: 0 });
  });

  it('the non-zero twin: counts distinct scopes and tenants, not rows', () => {
    const rows = [
      switchRow({ tenantId: 't-1', scopeId: 's-1', moduleId: '@substrat-run/engine-workorder' }),
      // Same scope, a second module off — must not double the scope count.
      switchRow({ tenantId: 't-1', scopeId: 's-1', moduleId: '@substrat-run/engine-invoicing' }),
      // A different tenant and scope entirely.
      switchRow({ tenantId: 't-2', scopeId: 's-2', moduleId: '@substrat-run/engine-workorder' }),
    ];
    expect(summarizeSystemSwitches(rows)).toEqual({ scopes: 2, tenants: 2 });
  });
});

describe('Services pending platform requests (#1840)', () => {
  const at = (minutesAgo: number) => new Date(now - minutesAgo * 60_000).toISOString();

  it('no pass on record reads as none — never as 0', () => {
    expect(readPending(null, now)).toEqual({ kind: 'none' });
    // A control plane older than the field sends nothing at all: the same fact.
    expect(readPending(undefined, now)).toEqual({ kind: 'none' });
  });

  it('a recorded 0 is a count — the positive twin of none', () => {
    expect(readPending({ count: 0, asOf: at(10), floor: false }, now)).toEqual({
      kind: 'count',
      count: 0,
      floor: false,
      minutesAgo: 10,
      stale: false,
    });
  });

  it('carries the pass age, and flags it stale past three missed passes', () => {
    expect(readPending({ count: 3, asOf: at(PENDING_STALE_MINUTES), floor: false }, now)).toMatchObject({ stale: false });
    expect(readPending({ count: 3, asOf: at(PENDING_STALE_MINUTES + 1), floor: true }, now)).toMatchObject({
      count: 3,
      floor: true,
      minutesAgo: PENDING_STALE_MINUTES + 1,
      stale: true,
    });
  });
});

describe('the pending caption (#1840)', () => {
  it('says none, never zero, with nothing on record', () => {
    expect(pendingCaption({ kind: 'none' })).toMatch(/no sweep pass on record/);
  });
  it('always carries the age, and says stale and floor when they hold', () => {
    const plain = pendingCaption({ kind: 'count', count: 2, floor: false, minutesAgo: 7, stale: false });
    expect(plain).toMatch(/7 min ago — not live\.$/);
    const both = pendingCaption({ kind: 'count', count: 2, floor: true, minutesAgo: 90, stale: true });
    expect(both).toMatch(/has not recorded a pass since/);
    expect(both).toMatch(/At least this many/);
  });
});
