import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCfObservabilityReader } from '../src/cf-observability.js';
import { cutOverSource, type AggregateSource, type CubeQuery, type RequestCubeRow } from '../src/aggregate-source.js';

/**
 * #1904: the request histogram and facets read from the router's Analytics Engine
 * datapoints from a configured instant on, and from the telemetry cube before it.
 */
afterEach(() => vi.unstubAllGlobals());

const T = '01TENANTOURS';
const SINCE = '2026-09-28T12:00:00Z';
const since = Date.parse(SINCE);

/** The async-only telemetry query (#1901): its filters carry the `kind` group. */
const isAsyncQuery = (b: { parameters: { filters: unknown[] } }) => JSON.stringify(b.parameters.filters).includes('"key":"kind"');

/** Stub both APIs: Analytics Engine SQL gets `ae`, the telemetry query answers `logs` (empty). */
function stub(
  ae: (sql: string) => Array<Record<string, unknown>>,
  logs: (body: { parameters: { filters: unknown[] } }) => unknown[] = () => [],
) {
  const sqls: string[] = [];
  const telemetry: Array<{ timeframe: { from: number; to: number }; parameters: { filters: unknown[] } }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: { body?: string }) => {
      if (String(url).includes('/analytics_engine/sql')) {
        sqls.push(init.body ?? '');
        return new Response(JSON.stringify({ data: ae(init.body ?? '') }));
      }
      const body = JSON.parse(init.body ?? '{}');
      telemetry.push(body);
      return new Response(JSON.stringify({ success: true, result: { calculations: [{ series: logs(body) }] } }));
    }),
  );
  return { sqls, telemetry };
}

const reader = (extra: { requestsFromRouterSince?: string; routerDataset?: string } = {}) =>
  createCfObservabilityReader({ accountId: 'acct', apiToken: 'tok', routerDataset: 'substrat_router', ...extra });

const aeRow = (r: Partial<Record<string, unknown>>) => ({
  vertical: 'acme-widgets',
  scopeId: 'A',
  surface: 'app',
  status: 200,
  operation: 'acme/assign',
  problemCode: '',
  principalKind: 'user',
  level: 'info',
  bucket: '2026-09-28 13:05:00',
  requests: '1',
  maxInterval: 1,
  ...r,
});

describe('the router request cube (#1904)', () => {
  it('reads one tenant from Analytics Engine, weighted by the sample interval, for one family', async () => {
    const { sqls, telemetry } = stub(() => [
      aeRow({ requests: '3', status: 409, problemCode: 'conflict', level: 'warn' }),
      aeRow({ requests: '40', maxInterval: 10, operation: 'acme/reply' }),
      // Another vertical of the same tenant — a different family, not this read's.
      aeRow({ vertical: 'other-app', requests: '99' }),
      // A request that reached no operation: blobs 6–8 unwritten.
      aeRow({ operation: '', principalKind: '', requests: '2' }),
    ]);
    const from = since + 60 * 60_000;
    const f = await reader({ requestsFromRouterSince: SINCE }).tenantRequestFacets!({
      tenantId: T,
      services: ['acme-widgets'],
      from,
      to: from + 60 * 60_000,
    });

    // #1901: past the cut the only log read is the async lines', which no route meters.
    expect(telemetry.filter((b) => !isAsyncQuery(b))).toHaveLength(0);
    expect(telemetry.filter(isAsyncQuery)).toHaveLength(1);
    expect(sqls).toHaveLength(1);
    expect(sqls[0]).toContain(`index1 = '${T}'`);
    expect(sqls[0]).toContain('FROM substrat_router');
    expect(sqls[0]).toContain('sum(_sample_interval)');
    expect(f.total).toBe(45);
    expect(f.estimated).toBe(true);
    expect(f.facets.operation).toEqual(
      expect.arrayContaining([
        { value: 'acme/reply', count: 40 },
        { value: 'acme/assign', count: 3 },
      ]),
    );
    expect(f.facets.status).toEqual(expect.arrayContaining([{ value: 409, count: 3 }]));
  });

  it('#1901: past the cut, adds the async lines the router never sees', async () => {
    const at = '2026-09-28T13:05:00Z';
    const { telemetry } = stub(
      () => [aeRow({ requests: '3' })],
      (b) =>
        isAsyncQuery(b)
          ? [
              {
                time: at,
                data: [
                  {
                    groups: [
                      { key: 'tenantId', value: T },
                      { key: 'level', value: 'warn' },
                      { key: 'operation', value: 'executor:notify' },
                      { key: 'kind', value: 'consumer' },
                    ],
                    value: 2,
                    count: 2,
                  },
                ],
              },
            ]
          : [],
    );
    const from = since + 60 * 60_000;
    const f = await reader({ requestsFromRouterSince: SINCE }).tenantRequestFacets!({
      tenantId: T,
      services: ['acme-widgets'],
      from,
      to: from + 60 * 60_000,
    });
    expect(telemetry.every(isAsyncQuery)).toBe(true);
    expect(f.total).toBe(5);
    expect(f.facets.kind).toEqual([
      { value: 'request', count: 3 },
      { value: 'consumer', count: 2 },
    ]);
  });

  it('asks Analytics Engine once for a tenant-wide read, however many families the tenant runs', async () => {
    // The datapoint names no family, so every family's answer is the same tenant scan; one
    // query per family would scan the tenant N times.
    const { sqls } = stub(() => [
      aeRow({ requests: '3' }),
      aeRow({ vertical: 'other-app', requests: '4' }),
      aeRow({ vertical: 'third-app', requests: '5' }),
    ]);
    const from = since + 60 * 60_000;
    const r = reader({ requestsFromRouterSince: SINCE });
    const q = { tenantId: T, services: ['acme-widgets', 'other-app', 'third-app'], from, to: from + 60 * 60_000 };
    const f = await r.tenantRequestFacets!(q);
    expect(sqls).toHaveLength(1);
    // Each family's rows counted once — the shared answer is partitioned, not repeated.
    expect(f.total).toBe(12);
    // Nothing outlives the read: the next one asks again.
    await r.tenantRequestFacets!(q);
    expect(sqls).toHaveLength(2);
  });

  it('reads the part of a window before the cut-over from the telemetry cube', async () => {
    const { sqls, telemetry } = stub(() => [aeRow({ bucket: '2026-09-28 12:30:00', requests: '5' })]);
    const v = await reader({ requestsFromRouterSince: SINCE }).tenantRequestVolume!({
      tenantId: T,
      services: ['acme-widgets'],
      from: since - 60 * 60_000,
      to: since + 60 * 60_000,
      buckets: 24,
    });
    expect(sqls).toHaveLength(1);
    expect(sqls[0]).toContain(`toDateTime(${since / 1000})`);
    expect(telemetry.length).toBeGreaterThan(0);
    // Requests come from the router past the cut; only the async read reaches beyond it.
    expect(Math.max(...telemetry.filter((b) => !isAsyncQuery(b)).map((b) => b.timeframe.to))).toBeLessThanOrEqual(since);
    expect(Math.min(...telemetry.filter(isAsyncQuery).map((b) => b.timeframe.from))).toBeGreaterThanOrEqual(since);
    expect(v.buckets.reduce((n, b) => n + b.info, 0)).toBe(5);
  });

  it('is off without the instant, or without the dataset — Workers Logs only, as before', async () => {
    const { sqls } = stub(() => []);
    const q = { tenantId: T, services: ['acme-widgets'], from: since + 60_000, to: since + 60 * 60_000 };
    await reader().tenantRequestFacets!(q);
    await createCfObservabilityReader({ accountId: 'acct', apiToken: 'tok', requestsFromRouterSince: SINCE }).tenantRequestFacets!(q);
    expect(sqls).toHaveLength(0);
  });

  it('refuses the request reads, and only them, on an instant that does not parse', async () => {
    stub(() => []);
    const r = reader({ requestsFromRouterSince: 'last tuesday' });
    const q = { tenantId: T, services: ['acme-widgets'], from: Date.now() - 60 * 60_000, to: Date.now() };
    await expect(r.tenantRequestFacets!(q)).rejects.toThrow(/requestsFromRouterSince/);
    await expect(r.tenantLogPatterns!(q)).resolves.toBeDefined();
  });

  it('refuses a saturated answer rather than presenting a prefix as the whole', async () => {
    stub(() => Array.from({ length: 50_000 }, () => aeRow({})));
    await expect(
      reader({ requestsFromRouterSince: SINCE }).tenantRequestFacets!({
        tenantId: T,
        services: ['acme-widgets'],
        from: since,
        to: since + 60 * 60_000,
      }),
    ).rejects.toThrow(/saturated/);
  });
});

describe('cutOverSource (#1904)', () => {
  const row = (bucket: number, count: number): RequestCubeRow => ({
    bucket, tenantId: T, scopeId: null, level: 'info', operation: null, problemCode: null, principalKind: null, surface: null, status: 200, count,
  });
  const recording = (label: string, calls: Array<[string, CubeQuery]>, estimated = false): AggregateSource => ({
    requests: async (q) => {
      calls.push([label, q]);
      return { rows: [row(q.from, 1)], estimated };
    },
    patterns: async (q) => {
      calls.push([`${label}:patterns`, q]);
      return { rows: [], estimated: false };
    },
  });
  const H = 3_600_000;

  it('asks one side for a window wholly on it, and both for one that straddles', async () => {
    const calls: Array<[string, CubeQuery]> = [];
    const s = cutOverSource(recording('logs', calls), recording('router', calls, true), 10 * H);
    await s.requests({ service: 'x', from: 0, to: 10 * H, grainMs: H });
    await s.requests({ service: 'x', from: 10 * H, to: 12 * H, grainMs: H });
    const both = await s.requests({ service: 'x', from: 8 * H, to: 12 * H, grainMs: H });
    expect(calls.map(([l, q]) => [l, q.from / H, q.to / H])).toEqual([
      ['logs', 0, 10],
      ['router', 10, 12],
      ['logs', 8, 10],
      ['router', 10, 12],
    ]);
    expect(both.rows.map((r) => r.bucket / H)).toEqual([8, 10]);
    expect(both.estimated).toBe(true);
  });

  it('counts the grain the instant falls inside wholly from before, and patterns always', async () => {
    const calls: Array<[string, CubeQuery]> = [];
    const s = cutOverSource(recording('logs', calls), recording('router', calls), 10 * H + 60_000);
    await s.requests({ service: 'x', from: 9 * H, to: 12 * H, grainMs: H });
    await s.patterns({ service: 'x', from: 11 * H, to: 12 * H, grainMs: H });
    expect(calls.map(([l, q]) => [l, q.from / H, q.to / H])).toEqual([
      ['logs', 9, 11],
      ['router', 11, 12],
      ['logs:patterns', 11, 12],
    ]);
  });
});
