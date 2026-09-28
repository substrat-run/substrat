import { describe, expect, it } from 'vitest';
import { aggregateReads, barWidth } from '../src/aggregate-reads.js';
import { scriptFamiliesOfScopes } from '../src/tenant-request-query.js';
import {
  blockMsFor,
  cachedSource,
  grainFor,
  memoryCubeStore,
  type AggregateSource,
  type CubeQuery,
  type PatternCubeRow,
  type RequestCubeRow,
} from '../src/aggregate-source.js';

/**
 * The contract every aggregate source is held to (#1877). The same cases run over the
 * source answering directly and over the cache wrapping it — closed blocks and an open one
 * — because the cache's whole promise is that it changes how often counts are taken and
 * nothing about what they say.
 *
 * The world: one script, two tenants, one of them with two apps. Only OURS may ever reach
 * an answer; THEIRS is in every cube precisely because a cube is script-wide.
 */
const OURS = '01TENANTOURS';
const THEIRS = '01TENANTTHEIRS';
const APP = '01SCOPEAPP';
const OTHER_APP = '01SCOPEOTHER';
const SERVICE = 'acme-widgets';

const T0 = Date.parse('2026-09-27T10:00:00Z');
const MIN = 60_000;

const req = (over: Partial<RequestCubeRow>): RequestCubeRow => ({
  bucket: T0,
  tenantId: OURS,
  scopeId: APP,
  level: 'info',
  operation: 'acme/reply',
  problemCode: null,
  principalKind: 'principal',
  surface: 'app',
  status: 200,
  count: 1,
  ...over,
});

const REQUESTS: RequestCubeRow[] = [
  req({ bucket: T0, count: 40 }),
  req({ bucket: T0 + 5 * MIN, level: 'warn', operation: 'acme/assign', problemCode: 'conflict', status: 409, count: 9 }),
  req({ bucket: T0 + 5 * MIN, level: 'error', operation: 'acme/assign', problemCode: 'unavailable', status: 502, count: 1 }),
  // Written before `level` existed: counted, as unrecorded, and on no facet value.
  req({ bucket: T0 + 10 * MIN, level: null, operation: null, principalKind: null, surface: null, count: 6 }),
  // A scheduled job.
  req({ bucket: T0 + 10 * MIN, principalKind: 'system', operation: 'acme/sweep', count: 4 }),
  // Our other app: in a tenant-wide read, not in an app read.
  req({ scopeId: OTHER_APP, bucket: T0, count: 100 }),
  // Somebody else's, on the same script: never in any answer of ours.
  req({ tenantId: THEIRS, scopeId: 'X', bucket: T0, level: 'error', operation: 'acme/assign', count: 1000 }),
];

const pat = (over: Partial<PatternCubeRow>): PatternCubeRow => ({
  bucket: T0,
  tenantId: OURS,
  scopeId: APP,
  template: 'reply to {id} sent',
  level: 'info',
  operation: 'acme/reply',
  count: 1,
  ...over,
});

const PATTERNS: PatternCubeRow[] = [
  pat({ bucket: T0, count: 30 }),
  pat({ bucket: T0 + 5 * MIN, template: 'assignment of {id} refused: {reason}', level: 'warn', operation: 'acme/assign', count: 8 }),
  pat({ bucket: T0 + 5 * MIN, template: 'assignment of {id} refused: {reason}', level: 'error', operation: 'acme/assign', count: 2 }),
  pat({ tenantId: THEIRS, scopeId: 'X', template: 'their secret {thing}', count: 500 }),
];

/** A source answering from fixed rows, honestly: only the rows inside the asked span. */
function fixedSource(estimated = false): AggregateSource & { asked: CubeQuery[] } {
  const asked: CubeQuery[] = [];
  const within = <R extends { bucket: number }>(rows: R[], q: CubeQuery) =>
    rows.filter((r) => r.bucket >= q.from && r.bucket < q.to && q.service === SERVICE);
  return {
    asked,
    async requests(q) {
      asked.push(q);
      return { rows: within(REQUESTS, q), estimated };
    },
    async patterns(q) {
      asked.push(q);
      return { rows: within(PATTERNS, q), estimated };
    },
  };
}

const window = { from: T0, to: T0 + 60 * MIN };
const scope = { tenantId: OURS, scopeId: APP, services: [SERVICE], ...window };

const SOURCES: Array<[string, () => AggregateSource]> = [
  ['the source answering directly', () => fixedSource()],
  // Every block long closed: all of it through the store.
  ['a cache with every block closed', () => cachedSource(fixedSource(), memoryCubeStore(), { now: () => T0 + 24 * 60 * MIN })],
  // "Now" inside the window: the tail of it is read live, the head from the store.
  ['a cache with the last block still open', () => cachedSource(fixedSource(), memoryCubeStore(), { now: () => T0 + 40 * MIN, lagMs: 0 })],
];

describe.each(SOURCES)('aggregate reads over %s (#1877)', (_name, make) => {
  it('draws the histogram from the caller’s app alone, with unrecorded lines counted', async () => {
    const v = await aggregateReads(make()).tenantRequestVolume({ ...scope, buckets: 12 });
    expect(v.bucketMs).toBe(5 * MIN);
    expect(v.buckets).toEqual([
      { start: new Date(T0).toISOString(), info: 40, warn: 0, error: 0, unrecorded: 0 },
      { start: new Date(T0 + 5 * MIN).toISOString(), info: 0, warn: 9, error: 1, unrecorded: 0 },
      { start: new Date(T0 + 10 * MIN).toISOString(), info: 4, warn: 0, error: 0, unrecorded: 6 },
    ]);
  });

  it('widens to the tenant’s apps when no app is named — and never to another tenant', async () => {
    const v = await aggregateReads(make()).tenantRequestVolume({ tenantId: OURS, services: [SERVICE], ...window, buckets: 12 });
    const total = v.buckets.reduce((n, b) => n + b.info + b.warn + b.error + b.unrecorded, 0);
    expect(total).toBe(40 + 9 + 1 + 6 + 4 + 100);
  });

  it('counts each facet with the other filters applied and its own left out', async () => {
    const f = await aggregateReads(make()).tenantRequestFacets({ ...scope, where: { operation: ['acme/assign'], level: ['warn'] } });
    expect(f.total).toBe(9);
    // Level: every level acme/assign was written at, since level's own filter is left out.
    expect(f.facets.level).toEqual([
      { value: 'warn', count: 9 },
      { value: 'error', count: 1 },
    ]);
    // Operation: every operation that was a warning.
    expect(f.facets.operation).toEqual([{ value: 'acme/assign', count: 9 }]);
    expect(f.facets.status).toEqual([{ value: 409, count: 9 }]);
    // Nothing of theirs, whatever the filters.
    expect(JSON.stringify(f)).not.toContain('1000');
  });

  it('lists a facet’s values by count, and leaves out lines with no value', async () => {
    const f = await aggregateReads(make()).tenantRequestFacets({ ...scope });
    expect(f.total).toBe(60);
    expect(f.facets.operation).toEqual([
      { value: 'acme/reply', count: 40 },
      { value: 'acme/assign', count: 10 },
      { value: 'acme/sweep', count: 4 },
    ]);
    expect(f.facets.principalKind).toEqual([
      { value: 'principal', count: 50 },
      { value: 'system', count: 4 },
    ]);
  });

  it('groups patterns by template, with shares of every matching line', async () => {
    const p = await aggregateReads(make()).tenantLogPatterns({ ...scope, buckets: 12 });
    expect(p.total).toBe(40);
    expect(p.patterns.map((x) => [x.template, x.count, x.share, x.dominant])).toEqual([
      ['reply to {id} sent', 30, 0.75, 'info'],
      ['assignment of {id} refused: {reason}', 10, 0.25, 'warn'],
    ]);
    expect(JSON.stringify(p)).not.toContain('their secret');
  });

  it('narrows patterns by level and operation, keeping shares of what matched', async () => {
    const p = await aggregateReads(make()).tenantLogPatterns({ ...scope, buckets: 12, level: ['error'] });
    expect(p.total).toBe(2);
    expect(p.patterns).toEqual([
      expect.objectContaining({ template: 'assignment of {id} refused: {reason}', count: 2, share: 1, dominant: 'error' }),
    ]);
  });

  it('answers nothing over no script, rather than the account', async () => {
    const reads = aggregateReads(make());
    expect((await reads.tenantRequestVolume({ ...scope, services: [], buckets: 12 })).buckets).toEqual([]);
    expect((await reads.tenantRequestFacets({ ...scope, services: [] })).total).toBe(0);
  });
});

describe('the cube cache (#1877)', () => {
  it('counts a closed block once, whoever asks and however often', async () => {
    const inner = fixedSource();
    const store = memoryCubeStore();
    const source = cachedSource(inner, store, { now: () => T0 + 24 * 60 * MIN });
    const reads = aggregateReads(source);
    await reads.tenantRequestVolume({ ...scope, buckets: 12 });
    const first = inner.asked.length;
    expect(first).toBeGreaterThan(0);
    // The facet panel beside it, a refresh, another tenant on the same script: no new counts.
    await reads.tenantRequestFacets({ ...scope });
    await reads.tenantRequestVolume({ ...scope, buckets: 12 });
    await reads.tenantRequestVolume({ tenantId: THEIRS, services: [SERVICE], ...window, buckets: 12 });
    expect(inner.asked).toHaveLength(first);
  });

  it('reads the open block live every time, and never keeps it', async () => {
    const inner = fixedSource();
    const store = memoryCubeStore();
    let now = T0 + 30 * MIN;
    const source = cachedSource(inner, store, { now: () => now, lagMs: 0 });
    const q = { service: SERVICE, from: T0, to: T0 + 60 * MIN, grainMs: 5 * MIN };
    await source.requests(q);
    const kept = store.size();
    const asked = inner.asked.length;
    await source.requests(q);
    // Only the live span was asked again.
    expect(inner.asked.length).toBe(asked + 1);
    expect(store.size()).toBe(kept);
    // Once the hour closes, it is kept and not asked again.
    now = T0 + 3 * 60 * MIN;
    await source.requests(q);
    const settled = inner.asked.length;
    await source.requests(q);
    expect(inner.asked.length).toBe(settled);
  });

  it('waits the ingestion lag before a block counts as closed', async () => {
    const inner = fixedSource();
    const store = memoryCubeStore();
    const blockMs = blockMsFor(5 * MIN);
    // The block has ended, but by less than the lag: it must not be kept yet.
    const source = cachedSource(inner, store, { now: () => T0 + blockMs + 60_000, lagMs: 5 * MIN });
    await source.requests({ service: SERVICE, from: T0, to: T0 + blockMs, grainMs: 5 * MIN });
    expect(store.size()).toBe(0);
  });

  it('keeps blocks per grain — a five-minute block is not an hour one', async () => {
    const inner = fixedSource();
    const store = memoryCubeStore();
    const source = cachedSource(inner, store, { now: () => T0 + 7 * 24 * 60 * MIN });
    await source.requests({ service: SERVICE, from: T0, to: T0 + 60 * MIN, grainMs: 5 * MIN });
    await source.requests({ service: SERVICE, from: T0, to: T0 + 12 * 60 * MIN, grainMs: 60 * MIN });
    expect(new Set(inner.asked.map((q) => q.grainMs))).toEqual(new Set([5 * MIN, 60 * MIN]));
  });

  it('says a count is an estimate when any block was sampled', async () => {
    const source = cachedSource(fixedSource(true), memoryCubeStore(), { now: () => T0 + 24 * 60 * MIN });
    expect((await aggregateReads(source).tenantRequestVolume({ ...scope, buckets: 12 })).estimated).toBe(true);
  });
});

describe('grains (#1877)', () => {
  it('follows the window, and a bar is never finer than its grain', () => {
    expect(grainFor(10 * MIN)).toBe(10_000);
    expect(grainFor(60 * MIN)).toBe(60_000);
    expect(grainFor(24 * 60 * MIN)).toBe(300_000);
    expect(grainFor(72 * 60 * MIN)).toBe(3_600_000);
    expect(barWidth(24 * 60 * MIN, 90, 5 * MIN)).toBe(20 * MIN);
    expect(barWidth(30 * MIN, 90, 10_000)).toBe(20_000);
    expect(barWidth(60 * MIN, 240, 60_000)).toBe(60_000);
  });
});

describe('which script families serve an app (#1877)', () => {
  const scopes = [
    { id: 'A', vertical: 'acme/widgets' },
    { id: 'B', vertical: 'acme/widgets' },
    { id: 'C', vertical: 'acme/crm' },
    { id: 'D', vertical: null },
  ];

  it('is the vertical’s stem — every script it runs as, whichever one the scope is on today', () => {
    expect(scriptFamiliesOfScopes(scopes, { scopeId: 'A' })).toEqual(['acme-widgets']);
    expect(scriptFamiliesOfScopes(scopes, { scopeId: 'B' })).toEqual(['acme-widgets']);
  });

  it('is every app’s with no scope named, narrowed by vertical when one is', () => {
    expect(scriptFamiliesOfScopes(scopes, {}).sort()).toEqual(['acme-crm', 'acme-widgets']);
    expect(scriptFamiliesOfScopes(scopes, { vertical: 'acme/crm' })).toEqual(['acme-crm']);
  });

  it('is nothing for a scope that is not among the tenant’s', () => {
    expect(scriptFamiliesOfScopes(scopes, { scopeId: 'SOMEONE-ELSES' })).toEqual([]);
  });
});

describe('what the reads refuse (#1877)', () => {
  it('refuses an absent script list, rather than answering "no traffic"', async () => {
    const reads = aggregateReads(fixedSource());
    await expect(reads.tenantRequestVolume({ tenantId: OURS, ...window, buckets: 12 })).rejects.toThrow(/script families/);
    await expect(reads.tenantRequestFacets({ tenantId: OURS, ...window })).rejects.toThrow(/script families/);
    await expect(reads.tenantLogPatterns({ tenantId: OURS, ...window, buckets: 12 })).rejects.toThrow(/script families/);
  });
});

describe('an incomplete cube (#1877)', () => {
  it('is answered but never kept', async () => {
    let calls = 0;
    const inner: AggregateSource = {
      async requests(q) {
        calls++;
        return { rows: REQUESTS.filter((r) => r.bucket >= q.from && r.bucket < q.to), estimated: false, complete: false };
      },
      async patterns() {
        return { rows: [], estimated: false };
      },
    };
    const store = memoryCubeStore();
    const source = cachedSource(inner, store, { now: () => T0 + 24 * 60 * MIN });
    const v1 = await aggregateReads(source).tenantRequestVolume({ ...scope, buckets: 12 });
    expect(v1.buckets.length).toBeGreaterThan(0);
    expect(store.size()).toBe(0);
    const before = calls;
    await aggregateReads(source).tenantRequestVolume({ ...scope, buckets: 12 });
    expect(calls).toBeGreaterThan(before);
  });
});
