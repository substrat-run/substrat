import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { runPlatformSweep, ulid, type FetchLike } from '@substrat-run/kernel';
import { ROUTER_REQUEST_POINT, platformActorId, scopeId, tenantId } from '@substrat-run/contracts';
import {
  createControlPlaneApi,
  createRouterRequestDayReader,
  mintTenantToken,
  tenantTokenAuth,
  DEV_ACTOR_HEADER,
  REQUEST_ROLLUP_ROW_LIMIT,
  SERVICE_TOKEN_HEADER,
  UNSAFE_devPlatformActorAuth,
} from '../src/index.js';

/**
 * The daily request rollup's reader and route (#2501). The reader's SQL is not matched against a
 * string here: a small stand-in for Analytics Engine EVALUATES it, over datapoints laid out the
 * way the router writes them (`ROUTER_REQUEST_POINT`, which the router's own test pins to what it
 * writes). So a reader that grouped the wrong blob, counted rows instead of weights, or let one
 * day's bounds overlap the next would read wrong numbers here, not merely different text.
 */

afterEach(() => vi.unstubAllGlobals());

/** One datapoint as Analytics Engine stores it: the router's arrays, its timestamp, and its sample weight. */
interface StoredPoint {
  indexes: string[];
  blobs: string[];
  doubles: number[];
  timestamp: number;
  sampleInterval: number;
}

const NAMES = Object.keys(ROUTER_REQUEST_POINT) as (keyof typeof ROUTER_REQUEST_POINT)[];

/** A datapoint with the fields the router writes, each at the ordinal the published layout gives it. */
function point(fields: { tenantId: string; vertical: string; scopeId: string }, at: string, sampleInterval = 1): StoredPoint {
  const p: StoredPoint = { indexes: [], blobs: [], doubles: [], timestamp: Date.parse(at), sampleInterval };
  const values: Record<string, string | number> = {
    surface: 'app',
    statusClass: '2xx',
    rayId: '',
    operation: '',
    problemCode: '',
    principalKind: '',
    level: 'info',
    durationMs: 12,
    status: 200,
    ...fields,
  };
  for (const name of NAMES) {
    const [, kind, n] = /^(index|blob|double)(\d+)$/.exec(ROUTER_REQUEST_POINT[name])!;
    const list = kind === 'index' ? p.indexes : kind === 'blob' ? p.blobs : p.doubles;
    list[Number(n) - 1] = values[name] as never;
  }
  return p;
}

/**
 * Analytics Engine, for exactly the shape of query the rollup sends: plain columns by ordinal,
 * `sum`/`max` of `_sample_interval`, a half-open `timestamp` window, GROUP BY the column aliases,
 * and a LIMIT. Sums come back as strings, as the real API answers 64-bit aggregates.
 */
function evaluate(sql: string, points: readonly StoredPoint[]): Array<Record<string, unknown>> {
  const select = /SELECT([\s\S]*?)FROM/.exec(sql)![1]!.split(',').map((s) => s.trim());
  const columns: { alias: string; read: (p: StoredPoint) => string }[] = [];
  const aggregates: { alias: string; fn: 'sum' | 'max' }[] = [];
  for (const item of select) {
    const col = /^(index|blob|double)(\d+) AS (\w+)$/.exec(item);
    const agg = /^(sum|max)\(_sample_interval\) AS (\w+)$/.exec(item);
    if (col) {
      const [, kind, n, alias] = col;
      const i = Number(n) - 1;
      columns.push({ alias: alias!, read: (p) => String((kind === 'index' ? p.indexes : kind === 'blob' ? p.blobs : p.doubles)[i] ?? '') });
    } else if (agg) {
      aggregates.push({ alias: agg[2]!, fn: agg[1] as 'sum' | 'max' });
    } else {
      throw new Error(`the stand-in cannot evaluate select item ${JSON.stringify(item)}`);
    }
  }
  const from = Number(/timestamp >= toDateTime\((\d+)\)/.exec(sql)![1]) * 1000;
  const to = Number(/timestamp < toDateTime\((\d+)\)/.exec(sql)![1]) * 1000;
  const groupBy = /GROUP BY ([\w, ]+)\n/.exec(sql)![1]!.split(',').map((s) => s.trim());
  expect(groupBy).toEqual(columns.map((c) => c.alias));
  const limit = Number(/LIMIT (\d+)/.exec(sql)![1]);
  const groups = new Map<string, Record<string, unknown>>();
  for (const p of points) {
    if (p.timestamp < from || p.timestamp >= to) continue;
    const key = columns.map((c) => c.read(p)).join('\u0000');
    const row = groups.get(key) ?? Object.fromEntries(columns.map((c) => [c.alias, c.read(p)]));
    for (const a of aggregates) {
      const prior = Number(row[a.alias] ?? 0);
      row[a.alias] = a.fn === 'sum' ? String(prior + p.sampleInterval) : Math.max(prior, p.sampleInterval);
    }
    groups.set(key, row);
  }
  return [...groups.values()].slice(0, limit);
}

/** Stub `fetch` as the Analytics Engine SQL endpoint over `points`; returns every SQL it was sent. */
function analyticsEngine(points: () => readonly StoredPoint[], answer?: (sql: string) => Array<Record<string, unknown>>) {
  const sqls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: { body?: string; headers?: Record<string, string> }) => {
      expect(String(url)).toBe('https://api.cloudflare.com/client/v4/accounts/acct/analytics_engine/sql');
      expect(init.headers?.authorization).toBe('Bearer tok');
      const sql = init.body ?? '';
      sqls.push(sql);
      return new Response(JSON.stringify({ data: answer ? answer(sql) : evaluate(sql, points()) }));
    }),
  );
  return sqls;
}

const reader = () => createRouterRequestDayReader({ accountId: 'acct', apiToken: 'tok', routerDataset: 'substrat_router' });

const A = tenantId.parse(ulid());
const B = tenantId.parse(ulid());
const S1 = scopeId.parse(ulid());
const S2 = scopeId.parse(ulid());

describe('the request rollup reader (#2501)', () => {
  it("counts one UTC day per (tenant, vertical, scope), weighted by the sample interval, and nothing of the days beside it", async () => {
    const sqls = analyticsEngine(() => [
      point({ tenantId: A, vertical: 'acme-crm', scopeId: S1 }, '2026-10-21T00:00:00.000Z'),
      // One datapoint that stood for forty requests: counted as forty, and the day is `sampled`.
      point({ tenantId: A, vertical: 'acme-crm', scopeId: S1 }, '2026-10-21T13:00:00.000Z', 40),
      point({ tenantId: A, vertical: 'acme-crm', scopeId: S2 }, '2026-10-21T23:59:59.999Z'),
      // A request that resolved to no vertical.
      point({ tenantId: B, vertical: '', scopeId: S2 }, '2026-10-21T08:00:00.000Z'),
      // The instants either side of the day belong to the days either side.
      point({ tenantId: A, vertical: 'acme-crm', scopeId: S1 }, '2026-10-20T23:59:59.999Z'),
      point({ tenantId: A, vertical: 'acme-crm', scopeId: S1 }, '2026-10-22T00:00:00.000Z'),
    ]);
    const counts = await reader()('2026-10-21');

    expect(counts).toEqual(
      expect.arrayContaining([
        { tenantId: A, vertical: 'acme-crm', scopeId: S1, requests: 41, sampled: true },
        { tenantId: A, vertical: 'acme-crm', scopeId: S2, requests: 1, sampled: false },
        { tenantId: B, vertical: null, scopeId: S2, requests: 1, sampled: false },
      ]),
    );
    expect(counts).toHaveLength(3);
    expect(sqls).toHaveLength(1);
    // One query for the whole fleet that day: no tenant narrows it, and it never counts rows.
    expect(sqls[0]).toContain('FROM substrat_router');
    expect(sqls[0]).not.toContain('index1 =');
    expect(sqls[0]).not.toMatch(/count\(/i);
  });

  it('refuses a saturated answer rather than handing back part of the day', async () => {
    const full = Array.from({ length: REQUEST_ROLLUP_ROW_LIMIT }, (_, i) => ({
      tenantId: A,
      vertical: 'acme-crm',
      scopeId: String(i),
      requests: '1',
      maxInterval: 1,
    }));
    analyticsEngine(() => [], () => full);
    await expect(reader()('2026-10-21')).rejects.toThrow(/saturated at 50000 rows for 2026-10-21/);
    // Its positive twin: one row fewer is a whole day, and every row of it comes back.
    analyticsEngine(() => [], () => full.slice(1));
    await expect(reader()('2026-10-21')).resolves.toHaveLength(REQUEST_ROLLUP_ROW_LIMIT - 1);
  });

  it('throws on a failed query, a day that is not a day, and a dataset that is not a bare name', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('denied', { status: 403 })));
    await expect(reader()('2026-10-21')).rejects.toThrow(/HTTP 403/);
    for (const bad of ['2026-02-30', '21-10-2026', '2026-10-21T00:00:00Z']) {
      await expect(reader()(bad)).rejects.toThrow(/not a UTC day/);
    }
    const unsafe = createRouterRequestDayReader({ accountId: 'acct', apiToken: 'tok', routerDataset: 'x; DROP' });
    await expect(unsafe('2026-10-21')).rejects.toThrow(/bare identifier/);
  });
});

describe('the rollup end to end, and GET /meters/requests (#2501)', () => {
  const SECRET = 'request-rollup-tenant-secret';
  const serviceActor = platformActorId.parse('01JZ00000000000000000000SV');
  const staff = platformActorId.parse(ulid());
  const builderActor = platformActorId.parse(ulid());
  const BUILDER_HEADER = 'x-test-builder';
  const asStaff = { [DEV_ACTOR_HEADER]: staff };
  const NOW = '2026-10-23T12:00:00.000Z';
  const FETCH = (() => Promise.reject(new Error('unused'))) as unknown as FetchLike;

  let dir: string;
  let host: SqliteScopeHost;
  let app: ReturnType<typeof createControlPlaneApi>;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'cp-request-rollup-'));
    host = new SqliteScopeHost({ dir });
    app = createControlPlaneApi({
      host,
      authenticate: UNSAFE_devPlatformActorAuth(),
      authenticateTenantService: tenantTokenAuth(SECRET, serviceActor),
      authenticateBuilder: (req: Request) =>
        req.headers.get(BUILDER_HEADER) === A ? { actor: builderActor, tenantId: A, tenantSlug: 'acme' } : null,
    });
    await host.admin.createTenant(staff, { id: A, slug: 'acme', name: 'Acme' });

    // The sweep reads the router's datapoints through the real reader, into this directory.
    const points = [
      point({ tenantId: A, vertical: 'acme-crm', scopeId: S1 }, '2026-10-21T10:00:00.000Z', 3),
      point({ tenantId: A, vertical: 'acme-crm', scopeId: S1 }, '2026-10-22T10:00:00.000Z'),
      point({ tenantId: B, vertical: 'acme-desk', scopeId: S2 }, '2026-10-22T11:00:00.000Z'),
    ];
    analyticsEngine(() => points);
    const report = await runPlatformSweep(host, {
      actor: staff,
      fetch: FETCH,
      sweepers: {},
      drainRetries: false,
      requestRollup: { read: reader(), lookbackDays: 3, now: () => NOW },
    });
    expect(report.errors).toEqual([]);
    expect(report.requestRollup).toMatchObject({ due: 3, read: 3, failed: 0, recorded: 3 });
    vi.unstubAllGlobals();
  });
  afterAll(async () => {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('serves what the sweep rolled up, every count marked an estimate, with the record of each day', async () => {
    const res = await app.request('/meters/requests?since=2026-10-20&until=2026-10-22', { headers: asStaff });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      estimated: true,
      since: '2026-10-20',
      until: '2026-10-22',
      truncated: false,
      rows: [
        { day: '2026-10-21', tenantId: A, vertical: 'acme-crm', scopeId: S1, requests: 3, sampled: true, estimated: true },
        { day: '2026-10-22', tenantId: A, vertical: 'acme-crm', scopeId: S1, requests: 1, sampled: false, estimated: true },
        { day: '2026-10-22', tenantId: B, vertical: 'acme-desk', scopeId: S2, requests: 1, sampled: false, estimated: true },
      ].sort((x, y) => (x.day + x.tenantId < y.day + y.tenantId ? -1 : 1)),
      // The first day had no traffic, and says so by being read with no rows.
      days: [
        { day: '2026-10-20', attemptedAt: NOW, readAt: NOW, rows: 0, error: null },
        { day: '2026-10-21', attemptedAt: NOW, readAt: NOW, rows: 1, error: null },
        { day: '2026-10-22', attemptedAt: NOW, readAt: NOW, rows: 2, error: null },
      ],
    });
  });

  it('narrows by tenant, vertical and scope, defaults to the thirty days to today, and says when a page is cut short', async () => {
    const by = async (q: string) => (await (await app.request(`/meters/requests?since=2026-10-01&until=2026-10-31&${q}`, { headers: asStaff })).json()).rows;
    expect((await by(`tenantId=${B}`)).map((r: { scopeId: string }) => r.scopeId)).toEqual([S2]);
    expect(await by('vertical=acme-crm')).toHaveLength(2);
    expect(await by(`scopeId=${S1}`)).toHaveLength(2);

    const page = await (await app.request('/meters/requests?since=2026-10-01&until=2026-10-31&limit=2', { headers: asStaff })).json();
    expect(page.rows).toHaveLength(2);
    expect(page.truncated).toBe(true);
    const whole = await (await app.request('/meters/requests?since=2026-10-01&until=2026-10-31&limit=3', { headers: asStaff })).json();
    expect(whole.truncated).toBe(false);

    const recent = await (await app.request('/meters/requests', { headers: asStaff })).json();
    const today = new Date().toISOString().slice(0, 10);
    expect(recent.until).toBe(today);
    expect(recent.since).toBe(new Date(Date.parse(`${today}T00:00:00Z`) - 30 * 86_400_000).toISOString().slice(0, 10));
  });

  it('refuses a window that is not one', async () => {
    for (const q of ['since=2026-10-22&until=2026-10-21', 'since=yesterday', 'until=2026-13-01', 'limit=0', 'limit=5001', 'tenantId=nope']) {
      expect((await app.request(`/meters/requests?${q}`, { headers: asStaff })).status, q).toBe(400);
    }
  });

  it('is staff-only: a builder and a tenant token are refused, even for their own tenant', async () => {
    const url = `/meters/requests?tenantId=${A}`;
    expect((await app.request(url, { headers: { [BUILDER_HEADER]: A } })).status).toBe(403);
    const token = await mintTenantToken(SECRET, { tenantId: A });
    expect((await app.request(url, { headers: { [SERVICE_TOKEN_HEADER]: token } })).status).toBe(403);
    expect((await app.request(url)).status).toBe(401);
    // The positive twins: both credentials are real and reach a route their allowlist names.
    expect((await app.request('/scopes', { headers: { [BUILDER_HEADER]: A } })).status).toBe(200);
    expect((await app.request(`/tenants/${A}`, { headers: { [SERVICE_TOKEN_HEADER]: token } })).status).toBe(200);
  });

  it('answers 501 on a host that keeps no rollup, never an empty reading', async () => {
    const bare = Object.create(host, {
      admin: { value: { ...host.admin, listRequestDays: undefined, listRequestRollupDays: undefined } },
    }) as SqliteScopeHost;
    const plain = createControlPlaneApi({ host: bare, authenticate: UNSAFE_devPlatformActorAuth() });
    expect((await plain.request('/meters/requests', { headers: asStaff })).status).toBe(501);
  });
});
