import { describe, it, expect, vi, afterEach } from 'vitest';
import { createCfObservabilityReader } from '../src/cf-observability.js';

/**
 * The bucketed series read (#1236) against a stubbed GraphQL endpoint. The thing worth
 * testing without a real account is the page ceiling: `workersInvocationsAdaptive`
 * answers at most 5,000 rows, a bucketed read is scripts × buckets, and the query orders
 * ASCENDING — so a truncated answer is missing its NEWEST buckets, which the caller's
 * zero-fill would then draw as an outage that never happened. Batching keeps the ask
 * under the ceiling; refusing covers the ask that cannot be batched (fleet-wide).
 */
afterEach(() => vi.unstubAllGlobals());

const reader = () => createCfObservabilityReader({ accountId: 'acct', apiToken: 'tok' });

/** One GraphQL answer, shaped as Cloudflare returns it. */
function answer(rows: Array<{ scriptName: string; datetimeHour: string; requests: number; errors: number }>) {
  return {
    data: {
      viewer: {
        accounts: [
          {
            workersInvocationsAdaptive: rows.map((r) => ({
              sum: { requests: r.requests, errors: r.errors },
              dimensions: { scriptName: r.scriptName, dispatchNamespaceName: 'verticals', datetimeHour: r.datetimeHour },
            })),
          },
        ],
      },
    },
  };
}

/** Stub `fetch`, recording the `scripts` variable each request asked for. */
function stub(reply: (scripts: string[] | null) => unknown) {
  const asked: Array<string[] | null> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: unknown, init: { body?: string }) => {
      const body = JSON.parse(init.body ?? '{}') as { variables?: { scripts?: string[] | null } };
      const scripts = body.variables?.scripts ?? null;
      asked.push(scripts);
      return new Response(JSON.stringify(reply(scripts)), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
  return asked;
}

describe('cf observability serviceMetricsSeries (#1236) — the page ceiling', () => {
  it('batches a long service list so no single ask can reach the row limit', async () => {
    // 24h at hourly buckets is 25 rows per script, so a batch is 199 scripts (4,975
    // rows) — 250 must therefore arrive as two asks, and every name in exactly one.
    const services = Array.from({ length: 250 }, (_, i) => `acme-crm-${i}`);
    const asked = stub((scripts) =>
      answer((scripts ?? []).map((s) => ({ scriptName: s, datetimeHour: '2026-09-08T11:00:00', requests: 1, errors: 0 }))),
    );
    const rows = await reader().serviceMetricsSeries!({ hours: 24, services });

    expect(asked).toHaveLength(2);
    expect(asked.flatMap((a) => a ?? [])).toEqual(services);
    // The batches are merged, not raced — every script still has its row.
    expect(rows).toHaveLength(250);
    // And the bucket instant is normalised to UTC, as the axis reads it.
    expect(rows[0]).toMatchObject({ start: '2026-09-08T11:00:00Z', bucketMinutes: 60, namespace: 'verticals' });
  });

  it('resolves a batch whose every script filled every bucket — the busiest legitimate answer', async () => {
    // The batch size has to be STRICTLY under the ceiling, not equal to it: at exactly
    // the limit a complete answer is indistinguishable from a truncated page, and the
    // refusal below would report a full series as unavailable. This is the case that
    // catches that off-by-one — a whole batch of maximally busy scripts.
    // 200 is the number that breaks a `floor(LIMIT / buckets)` batch: one ask of 200
    // maximally busy scripts is 200 × 25 = exactly 5,000 rows, which the refusal cannot
    // distinguish from a truncated page. Strict sizing splits it 199 + 1 instead.
    const services = Array.from({ length: 200 }, (_, i) => `acme-crm-${i}`);
    const hourly = Array.from({ length: 25 }, (_, h) => `2026-09-08T${String(h % 24).padStart(2, '0')}:00:00`);
    const asked = stub((scripts) =>
      answer(
        (scripts ?? []).flatMap((s) => hourly.map((datetimeHour) => ({ scriptName: s, datetimeHour, requests: 1, errors: 0 }))),
      ),
    );
    const rows = await reader().serviceMetricsSeries!({ hours: 24, services });
    expect(asked.map((a) => (a ?? []).length)).toEqual([199, 1]);
    // No page reached the ceiling, so nothing was refused and every row came back.
    expect(rows).toHaveLength(5000);
  });

  it('refuses a saturated answer rather than returning a prefix the caller would zero-fill', async () => {
    // The fleet-wide ask (no services) cannot be batched, so the ceiling is all that
    // stands between a truncated prefix and a chart showing a fabricated outage.
    stub(() =>
      answer(
        Array.from({ length: 5000 }, (_, i) => ({
          scriptName: `s-${i}`,
          datetimeHour: '2026-09-08T11:00:00',
          requests: 1,
          errors: 0,
        })),
      ),
    );
    await expect(reader().serviceMetricsSeries!({ hours: 24 })).rejects.toThrow(/saturated/);
  });

  it('asks once, for every script, when no service list narrows it', async () => {
    const asked = stub(() => answer([{ scriptName: 'acme-crm', datetimeHour: '2026-09-08T11:00:00', requests: 7, errors: 1 }]));
    const rows = await reader().serviceMetricsSeries!({ hours: 24 });
    expect(asked).toEqual([null]);
    expect(rows).toEqual([
      {
        service: 'acme-crm',
        namespace: 'verticals',
        start: '2026-09-08T11:00:00Z',
        bucketMinutes: 60,
        requests: 7,
        errors: 1,
      },
    ]);
  });
});

/**
 * #1746: the request reads against a stubbed telemetry endpoint. What is worth pinning
 * without a real account is the QUERY each one sends — the tenant predicate first and
 * always, the facet exclusion, the bucket count — and how each answer is folded, because a
 * wrong fold here is a histogram or a facet panel that is quietly off.
 */
describe('cf observability request reads (#1746)', () => {
  const T = '01JZ0000000000000000TEN001';
  const from = Date.parse('2026-09-27T10:00:00Z');
  const to = Date.parse('2026-09-27T13:00:00Z');

  type Body = {
    view: string;
    granularity?: number;
    chartType?: string;
    parameters: { filters: Array<Record<string, unknown>>; groupBys?: Array<{ value: string }>; limit?: number };
  };

  /** Stub the telemetry endpoint: `reply` answers each request body; bodies are recorded. */
  function telemetry(reply: (body: Body) => unknown) {
    const bodies: Body[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: unknown, init: { body?: string }) => {
        const body = JSON.parse(init.body ?? '{}') as Body;
        bodies.push(body);
        return new Response(JSON.stringify({ success: true, result: reply(body) }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }),
    );
    return bodies;
  }

  const point = (groups: Record<string, unknown>, value: number, sampleInterval = 1) => ({
    groups: Object.entries(groups).map(([key, v]) => ({ key, value: v })),
    value,
    count: value / sampleInterval,
    interval: 1,
    sampleInterval,
  });

  it('asks for a level histogram in the requested bucket count, tenant predicate first', async () => {
    const bodies = telemetry(() => ({
      calculations: [
        {
          calculation: 'count',
          aggregates: [],
          series: [
            {
              time: '2026-09-27T10:00:00Z',
              data: [point({ level: 'info' }, 40), point({ level: 'error' }, 2), point({}, 5)],
            },
            { time: '2026-09-27T10:02:00Z', data: [point({ level: 'warn' }, 3)] },
            // A bucket the backend listed with nothing in it is dropped, not drawn as zero.
            { time: '2026-09-27T10:04:00Z', data: [] },
          ],
        },
      ],
    }));
    const volume = await reader().tenantRequestVolume!({ tenantId: T, scopeId: '01SCOPE', from, to, buckets: 90 });
    expect(bodies[0]).toMatchObject({ view: 'calculations', granularity: 90, chartType: 'timeseries' });
    expect(bodies[0]!.parameters.groupBys).toEqual([{ type: 'string', value: 'level' }]);
    expect(bodies[0]!.parameters.filters.slice(0, 3)).toEqual([
      { key: 'tenantId', operation: 'eq', type: 'string', value: T },
      { key: 'substrat', operation: 'eq', type: 'string', value: 'invocation' },
      { key: 'scopeId', operation: 'eq', type: 'string', value: '01SCOPE' },
    ]);
    expect(volume).toEqual({
      // Read back from the series, not assumed from 3h / 90.
      bucketMs: 120_000,
      buckets: [
        // A line with no `level` predates it — counted, as `unrecorded`.
        { start: '2026-09-27T10:00:00.000Z', info: 40, warn: 0, error: 2, unrecorded: 5 },
        { start: '2026-09-27T10:02:00.000Z', info: 0, warn: 3, error: 0, unrecorded: 0 },
      ],
      estimated: false,
    });
  });

  it('says a sampled count is an estimate', async () => {
    telemetry(() => ({
      calculations: [{ aggregates: [], series: [{ time: '2026-09-27T10:00:00Z', data: [point({ level: 'info' }, 400, 10)] }] }],
    }));
    const volume = await reader().tenantRequestVolume!({ tenantId: T, from, to, buckets: 90 });
    expect(volume.estimated).toBe(true);
    expect(volume.buckets[0]!.info).toBe(400);
  });

  it("counts each facet with every other filter applied and its own left out", async () => {
    const bodies = telemetry((body) => {
      const key = body.parameters.groupBys?.[0]?.value;
      if (key === undefined) return { calculations: [{ aggregates: [point({}, 12)], series: [] }] };
      if (key === 'level') {
        return { calculations: [{ aggregates: [point({ level: 'warn' }, 9), point({ level: 'error' }, 3)], series: [] }] };
      }
      if (key === 'operation') {
        // A request that is not an operation carries no value — not something to filter on.
        return { calculations: [{ aggregates: [point({ operation: 'acme/create' }, 7), point({}, 5)], series: [] }] };
      }
      return { calculations: [] };
    });
    const facets = await reader().tenantRequestFacets!({
      tenantId: T,
      from,
      to,
      where: { level: ['warn', 'error'], operation: ['acme/create'] },
      keys: ['level', 'operation'],
    });
    expect(facets.total).toBe(12);
    expect(facets.facets.level).toEqual([
      { value: 'warn', count: 9 },
      { value: 'error', count: 3 },
    ]);
    expect(facets.facets.operation).toEqual([{ value: 'acme/create', count: 7 }]);
    // Facets not asked for are present and empty, so a caller can index any key.
    expect(facets.facets.status).toEqual([]);

    const levelFilter = { kind: 'group', filterCombination: 'or', filters: [
      { key: 'level', operation: 'eq', type: 'string', value: 'warn' },
      { key: 'level', operation: 'eq', type: 'string', value: 'error' },
    ] };
    const operationFilter = { key: 'operation', operation: 'eq', type: 'string', value: 'acme/create' };
    const byKey = (k: string | undefined) => bodies.find((b) => b.parameters.groupBys?.[0]?.value === k)!;
    // The total: every filter.
    expect(bodies.find((b) => !b.parameters.groupBys)!.parameters.filters).toEqual(
      expect.arrayContaining([levelFilter, operationFilter]),
    );
    // The level facet: the operation filter, and NOT its own.
    expect(byKey('level').parameters.filters).toContainEqual(operationFilter);
    expect(byKey('level').parameters.filters).not.toContainEqual(levelFilter);
    // And the other way round.
    expect(byKey('operation').parameters.filters).toContainEqual(levelFilter);
    expect(byKey('operation').parameters.filters).not.toContainEqual(operationFilter);
    // The tenant predicate is on every one of them.
    for (const b of bodies) {
      expect(b.parameters.filters[0]).toEqual({ key: 'tenantId', operation: 'eq', type: 'string', value: T });
    }
  });

  it('keeps ten real values when the missing-value group ranks among them', async () => {
    // The lines with no operation — older ones, or routes that are not operations —
    // outnumber every value, so the backend ranks them first. The stub truncates at the
    // asked limit AFTER ranking, the way the backend does.
    const ranked = [
      point({}, 1000),
      point({ operation: '' }, 900),
      ...Array.from({ length: 10 }, (_, i) => point({ operation: `acme/op-${i}` }, 100 - i)),
    ];
    telemetry((body) => ({
      calculations: [{ aggregates: ranked.slice(0, body.parameters.limit ?? ranked.length), series: [] }],
    }));
    const facets = await reader().tenantRequestFacets!({ tenantId: T, from, to, keys: ['operation'] });
    expect(facets.facets.operation).toHaveLength(10);
    expect(facets.facets.operation.map((v) => v.value)).not.toContain('');
  });

  it('filters status as a number', async () => {
    const bodies = telemetry(() => ({ calculations: [] }));
    await reader().tenantRequestFacets!({ tenantId: T, from, to, where: { status: ['409'] }, keys: ['level'] });
    expect(bodies[0]!.parameters.filters).toContainEqual({ key: 'status', operation: 'eq', type: 'number', value: 409 });
  });

  it('lists the stamped lines as request records, newest first', async () => {
    const bodies = telemetry(() => ({
      events: {
        events: [
          { timestamp: 1, source: { substrat: 'invocation', tenantId: T, status: 200, method: 'GET', path: '/a' } },
          {
            timestamp: 2,
            source: {
              substrat: 'invocation',
              tenantId: T,
              invocationId: '01JZ0000000000000000INV001',
              status: 409,
              threw: false,
              level: 'warn',
              operation: 'acme/create',
              problemCode: 'conflict',
              principalKind: 'principal',
              eventCount: 0,
              eventTypes: [],
              entities: [],
            },
          },
        ],
      },
    }));
    const rows = await reader().tenantRequests!({ tenantId: T, from, to, limit: 50 });
    expect(bodies[0]).toMatchObject({ view: 'events' });
    expect(rows.map((r) => r.timestamp)).toEqual([2, 1]);
    expect(rows[0]).toMatchObject({ status: 409, level: 'warn', operation: 'acme/create', problemCode: 'conflict', eventCount: 0 });
    // An older line: every #1746 field reads as not recorded.
    expect(rows[1]).toMatchObject({ level: null, operation: null, eventCount: null, eventTypes: [], entities: [] });
  });
});
