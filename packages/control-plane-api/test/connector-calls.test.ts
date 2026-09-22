import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { ulid, webCryptoSecretBox } from '@substrat-run/kernel';
import { platformActorId, tenantId } from '@substrat-run/contracts';
import {
  createCfObservabilityReader,
  createControlPlaneApi,
  firstBuilderAuth,
  mintPushToken,
  pushActorFor,
  pushTokenBuilderAuth,
  tenantTokenAuth,
  DEV_ACTOR_HEADER,
  SERVICE_TOKEN_HEADER,
  UNSAFE_devPlatformActorAuth,
  type ConnectorCallsBucket,
  type ObservabilityReader,
} from '../src/index.js';

/**
 * Connector calls per provider over time (#1691): the Analytics Engine read, and the
 * staff-only route over it.
 */

describe('cf observability connectorCallsSeries (#1691)', () => {
  afterEach(() => vi.unstubAllGlobals());

  const stubSql = (rows: Array<Record<string, unknown>>) => {
    const asked: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: unknown, init: { body?: string }) => {
        asked.push(init.body ?? '');
        return new Response(JSON.stringify({ data: rows }), { status: 200 });
      }),
    );
    return asked;
  };

  it('is absent unless the dataset is named — never defaulted', () => {
    expect(createCfObservabilityReader({ accountId: 'a', apiToken: 't' }).connectorCallsSeries).toBeUndefined();
    expect(
      createCfObservabilityReader({ accountId: 'a', apiToken: 't', connectorCallsDataset: 'substrat_connector_calls' })
        .connectorCallsSeries,
    ).toBeTypeOf('function');
  });

  it('reads the named dataset by the published ordinals, sampling-weighted', async () => {
    const asked = stubSql([]);
    const reader = createCfObservabilityReader({ accountId: 'a', apiToken: 't', connectorCallsDataset: 'cc_ds' });
    await reader.connectorCallsSeries!({ hours: 48, provider: 'fortnox' });
    const sql = asked[0]!;
    expect(sql).toContain('FROM cc_ds');
    expect(sql).toContain(`blob1 = 'fortnox'`); // blob1 = provider
    expect(sql).toContain('sum(_sample_interval) AS calls'); // weighted, never count()
    expect(sql).not.toMatch(/count\(\)/);
    expect(sql).toContain(`sum(if(blob3 = 'ok', _sample_interval, 0)) AS ok`); // blob3 = outcome
    // An untimed call (double1 = -1) weighs nothing in the latency quantiles.
    expect(sql).toContain('quantileWeighted(0.95)(double1, if(double1 >= 0, _sample_interval, 0))');
    expect(sql).toContain(`INTERVAL '60' MINUTE`);
  });

  it('splits each bucket into segments that sum to its calls', async () => {
    stubSql([
      {
        provider: 'scrive',
        start: '2026-09-22 10:00:00',
        calls: '40',
        ok: '30',
        class4xx: '4',
        class5xx: '3',
        timeouts: '1',
        durationP50: 120,
        durationP95: 900,
      },
      // A bucket of only untimed calls: the quantile has nothing to weigh.
      { provider: 'fortnox', start: '2026-09-22 10:00:00', calls: '2', ok: '2', class4xx: '0', class5xx: '0', timeouts: '0', durationP50: Number.NaN, durationP95: -1 },
    ]);
    const reader = createCfObservabilityReader({ accountId: 'a', apiToken: 't', connectorCallsDataset: 'cc_ds' });
    const [scrive, fortnox] = (await reader.connectorCallsSeries!({ hours: 6 })) as [
      ConnectorCallsBucket,
      ConnectorCallsBucket,
    ];
    expect(scrive).toEqual({
      provider: 'scrive',
      start: '2026-09-22T10:00:00Z',
      bucketMinutes: 15,
      calls: 40,
      errors: 10,
      ok: 30,
      class4xx: 4,
      class5xx: 3,
      timeouts: 1,
      failed: 2,
      durationP50: 120,
      durationP95: 900,
    });
    expect(scrive.ok + scrive.class4xx + scrive.class5xx + scrive.timeouts + scrive.failed).toBe(scrive.calls);
    expect(fortnox.durationP50).toBe(0);
    expect(fortnox.durationP95).toBe(0);
  });
});

describe('GET /connections/calls (#1691) — staff only', () => {
  const TENANT_SECRET = 'test-tenant-token-secret';
  const PUSH_SECRET = 'test-push-token-secret';
  const staff = platformActorId.parse(ulid());
  const serviceActor = platformActorId.parse('01JZ00000000000000000000SV');
  const acme = tenantId.parse(ulid());
  const asStaff = { [DEV_ACTOR_HEADER]: staff };
  let asTenant: Record<string, string>;
  let asBuilder: Record<string, string>;
  let dir: string;
  let host: SqliteScopeHost;
  const asked: Array<{ hours: number; provider?: string }> = [];

  const bucket: ConnectorCallsBucket = {
    provider: 'scrive',
    start: '2026-09-22T10:00:00Z',
    bucketMinutes: 60,
    calls: 3,
    errors: 1,
    ok: 2,
    class4xx: 0,
    class5xx: 1,
    timeouts: 0,
    failed: 0,
    durationP50: 100,
    durationP95: 300,
  };
  const reader = {
    serviceMetrics: async () => [],
    recentLogs: async () => [],
    connectorCallsSeries: async (input: { hours: number; provider?: string }) => {
      asked.push(input);
      return [bucket];
    },
  } as unknown as ObservabilityReader;

  const apiWith = (observability?: ObservabilityReader) =>
    createControlPlaneApi({
      host,
      authenticate: UNSAFE_devPlatformActorAuth(),
      authenticateTenantService: tenantTokenAuth(TENANT_SECRET, serviceActor),
      authenticateBuilder: firstBuilderAuth(pushTokenBuilderAuth(PUSH_SECRET)),
      tenantTokenSecret: TENANT_SECRET,
      pushTokenSecret: PUSH_SECRET,
      ...(observability ? { observability } : {}),
    });
  let app: ReturnType<typeof apiWith>;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'cp-connector-calls-'));
    host = new SqliteScopeHost({ dir, secretBox: webCryptoSecretBox('k1', new Uint8Array(32).fill(7)) });
    app = apiWith(reader);
    await host.admin.createTenant(staff, { id: acme, slug: 'acme', name: 'Acme' });
    const minted = await app.request('/tenant-tokens', {
      method: 'POST',
      headers: { ...asStaff, 'content-type': 'application/json' },
      body: JSON.stringify({ tenantId: acme }),
    });
    expect(minted.status).toBe(201);
    asTenant = { [SERVICE_TOKEN_HEADER]: ((await minted.json()) as { token: string }).token };
    const push = await mintPushToken(PUSH_SECRET, { actor: await pushActorFor(acme), tenantId: acme, tenantSlug: 'acme' });
    asBuilder = { [SERVICE_TOKEN_HEADER]: push };
  });

  afterAll(async () => {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('staff reads it (the positive twin), with the window and provider passed through', async () => {
    const res = await app.request('/connections/calls?hours=168&provider=scrive', { headers: asStaff });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ hours: 168, buckets: [bucket] });
    expect(asked.at(-1)).toEqual({ hours: 168, provider: 'scrive' });
  });

  it('a tenant token is refused — with or without naming its own tenant', async () => {
    expect((await app.request('/connections/calls', { headers: asTenant })).status).toBe(403);
    expect((await app.request(`/connections/calls?tenantId=${acme}`, { headers: asTenant })).status).toBe(403);
    // …while the same token still reaches a route on its allowlist, so the 403 is this route's.
    expect((await app.request(`/tenants/${acme}/connections`, { headers: asTenant })).status).toBe(200);
  });

  it('a builder token is refused — with or without naming its own tenant', async () => {
    expect((await app.request('/connections/calls', { headers: asBuilder })).status).toBe(403);
    expect((await app.request(`/connections/calls?tenantId=${acme}`, { headers: asBuilder })).status).toBe(403);
    // …while the same token still reaches a builder route, so the 403 is this route's.
    expect((await app.request('/sweep-runs', { headers: asBuilder })).status).toBe(200);
  });

  it('no credential at all is 401', async () => {
    expect((await app.request('/connections/calls')).status).toBe(401);
  });

  it('refuses a window past a week, and a provider the dataset literal would refuse', async () => {
    expect((await app.request('/connections/calls?hours=169', { headers: asStaff })).status).toBe(400);
    expect((await app.request(`/connections/calls?provider=${encodeURIComponent("x' OR 1=1")}`, { headers: asStaff })).status).toBe(400);
  });

  it('501s when no dataset is configured, rather than an empty series', async () => {
    expect((await apiWith().request('/connections/calls', { headers: asStaff })).status).toBe(501);
  });
});
