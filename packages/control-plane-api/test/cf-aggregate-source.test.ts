import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCfObservabilityReader } from '../src/cf-observability.js';
import { memoryCubeStore } from '../src/aggregate-source.js';
import { ControlPlaneError } from '../src/client.js';

/**
 * The Cloudflare side of the aggregate seam (#1877), against a stubbed telemetry API: what
 * a cube costs to count, and how the reader tells a caller the store could not answer.
 */
afterEach(() => vi.unstubAllGlobals());

const T = '01TENANTOURS';
const from = Date.parse('2026-09-27T10:00:00Z');
const to = from + 60 * 60_000;

type Body = { view: string; granularity?: number; offsetBy?: number; timeframe: { from: number; to: number }; parameters: { filters: Array<Record<string, unknown>>; groupBys?: Array<{ value: string }>; limit?: number } };

/** Stub the telemetry API; `reply` answers each body with a status and a text. */
function stub(reply: (body: Body) => { status?: number; body: unknown }) {
  const bodies: Body[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_u: unknown, init: { body?: string }) => {
      const body = JSON.parse(init.body ?? '{}') as Body;
      bodies.push(body);
      const r = reply(body);
      const text = typeof r.body === 'string' ? r.body : JSON.stringify({ success: true, result: r.body });
      return new Response(text, { status: r.status ?? 200 });
    }),
  );
  return bodies;
}

const reader = (cubeStore?: ReturnType<typeof memoryCubeStore>) =>
  createCfObservabilityReader({ accountId: 'acct', apiToken: 'tok', ...(cubeStore ? { cubeStore } : {}) });

/** The filter a script family is scoped by: its stem, then the exact family pattern. */
const family = (stem: string) => ({
  kind: 'group',
  filterCombination: 'and',
  filters: [
    { key: '$metadata.service', operation: 'starts_with', type: 'string', value: stem },
    { key: '$metadata.service', operation: 'regex', type: 'string', value: `^${stem}(-[0-9a-hjkmnp-tv-z]{26})?(-(eu|us))?$` },
  ],
});

const point = (groups: Record<string, unknown>, value: number) => ({
  groups: Object.entries(groups).map(([key, v]) => ({ key, value: v })),
  value,
  count: value,
  interval: 1,
  sampleInterval: 1,
});

describe('the telemetry source (#1877)', () => {
  it('counts one script, every tenant, grouped by every facet, cut into the grain', async () => {
    const bodies = stub(() => ({
      body: {
        calculations: [
          {
            series: [
              {
                time: '2026-09-27T10:05:00Z',
                data: [
                  point({ tenantId: T, scopeId: 'A', level: 'warn', operation: 'acme/assign', problemCode: 'conflict', principalKind: 'principal', surface: 'app', status: 409 }, 3),
                  point({ tenantId: 'OTHER', scopeId: 'B', level: 'info', operation: 'acme/reply', status: 200 }, 50),
                ],
              },
            ],
          },
        ],
      },
    }));
    const v = await reader().tenantRequestVolume!({ tenantId: T, services: ['acme-widgets'], from, to, buckets: 12 });
    const q = bodies[0]!;
    expect(q.view).toBe('calculations');
    // The script is the scan boundary; the tenant is NOT in the query — the cube serves all.
    expect(q.parameters.filters).toEqual([
      family('acme-widgets'),
      { key: 'substrat', operation: 'eq', type: 'string', value: 'invocation' },
    ]);
    expect(q.parameters.groupBys!.map((g) => g.value)).toEqual([
      'tenantId', 'scopeId', 'level', 'operation', 'problemCode', 'principalKind', 'surface', 'status',
    ]);
    // An hour at the one-minute grain.
    expect(q.granularity).toBe(60);
    // …and only ours comes back.
    expect(v.buckets).toEqual([{ start: '2026-09-27T10:05:00.000Z', info: 0, warn: 3, error: 0, unrecorded: 0 }]);
  });

  it('splits a full span in two rather than paging it — no order to trust', async () => {
    const full = Array.from({ length: 2000 }, (_, i) => point({ tenantId: T, operation: `op-${i}`, level: 'info' }, 1));
    const bodies = stub((b) => {
      // The whole hour is full; each half fits.
      const span = b.timeframe.to - b.timeframe.from;
      const data = span >= 60 * 60_000 ? full : [point({ tenantId: T, operation: `half-${b.timeframe.from}`, level: 'info' }, 1)];
      return { body: { calculations: [{ series: [{ time: new Date(b.timeframe.from).toISOString(), data }] }] } };
    });
    const old = Date.parse('2026-09-20T10:00:00Z');
    // No store, so the hour is one span (a cache would already have cut it into blocks).
    const f = await reader().tenantRequestFacets!({ tenantId: T, services: ['acme-widgets'], from: old, to: old + 60 * 60_000 });
    expect(bodies.some((b) => b.offsetBy)).toBe(false);
    expect(bodies.map((b) => b.timeframe.to - b.timeframe.from).sort((a, b) => b - a)).toEqual([60 * 60_000, 30 * 60_000, 30 * 60_000]);
    expect(f.total).toBe(2);
  });

  it('pages a single grain that is still full, and does not keep what it could not vouch for', async () => {
    const full = Array.from({ length: 2000 }, (_, i) => point({ tenantId: T, operation: `op-${i}`, level: 'info' }, 1));
    const bodies = stub((b) => ({
      body: { calculations: [{ series: [{ time: new Date(b.timeframe.from).toISOString(), data: b.offsetBy ? [point({ tenantId: T, operation: 'last', level: 'info' }, 1)] : full }] }] },
    }));
    const store = memoryCubeStore();
    const old = Date.parse('2026-09-20T10:00:00Z');
    // Ten minutes: the ten-second grain, so the span halves down to one grain before paging.
    const f = await reader(store).tenantRequestFacets!({ tenantId: T, services: ['acme-widgets'], from: old, to: old + 10 * 60_000 });
    expect(bodies.some((b) => b.offsetBy === 2000)).toBe(true);
    expect(f.total).toBeGreaterThan(0);
    expect(store.size()).toBe(0);
  });

  it('reports a timeout as a 504 that says so — not a parse error behind a 500', async () => {
    stub(() => ({ status: 504, body: 'error code: 504\n' }));
    const err = await reader()
      .tenantLogPatterns!({ tenantId: T, services: ['acme-widgets'], from, to, buckets: 30 })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ControlPlaneError);
    expect(err).toMatchObject({ status: 504, message: expect.stringContaining('timed out') });
  });

  it('reports a throttle as a 503', async () => {
    stub(() => ({ status: 429, body: { errors: [{ message: 'rate limited' }] } }));
    const err = await reader().tenantRequestFacets!({ tenantId: T, services: ['s'], from, to }).catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 503 });
  });

  it('with a store, counts a closed hour once for every later reader', async () => {
    const old = Date.parse('2026-09-20T10:00:00Z');
    const bodies = stub(() => ({ body: { calculations: [{ series: [] }] } }));
    const store = memoryCubeStore();
    const r = reader(store);
    await r.tenantRequestVolume!({ tenantId: T, services: ['acme-widgets'], from: old, to: old + 60 * 60_000, buckets: 12 });
    const counted = bodies.length;
    await r.tenantRequestFacets!({ tenantId: T, services: ['acme-widgets'], from: old, to: old + 60 * 60_000 });
    await r.tenantRequestVolume!({ tenantId: 'SOMEONE-ELSE', services: ['acme-widgets'], from: old, to: old + 60 * 60_000, buckets: 12 });
    expect(bodies).toHaveLength(counted);
    expect(store.size()).toBeGreaterThan(0);
  });
});

describe('raw reads are scoped to the app’s scripts (#1877)', () => {
  it('puts the scripts on the request list query', async () => {
    const bodies = stub(() => ({ body: { events: { events: [] } } }));
    await reader().tenantRequests!({ tenantId: T, services: ['acme-widgets'], from, to, limit: 10 });
    expect(bodies[0]!.parameters.filters).toContainEqual(family('acme-widgets'));
  });

  it('puts them on every query of the log read, as alternatives when there are several', async () => {
    const bodies = stub(() => ({ body: { events: { events: [] } } }));
    await reader().tenantLogs!({ tenantId: T, services: ['a', 'b'], hours: 24, limit: 10 });
    expect(bodies.length).toBeGreaterThan(0);
    for (const b of bodies) {
      expect(b.parameters.filters).toContainEqual({ kind: 'group', filterCombination: 'or', filters: [family('a'), family('b')] });
    }
  });

  it('matches nothing when the tenant has no script, rather than searching the account', async () => {
    const bodies = stub(() => ({ body: { events: { events: [] } } }));
    await reader().tenantLogs!({ tenantId: T, services: [], hours: 24, limit: 10 });
    for (const b of bodies) {
      expect(b.parameters.filters.some((f) => f['key'] === '$metadata.service')).toBe(true);
    }
  });
});
