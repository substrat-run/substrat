import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { runPlatformSweep, ulid, type FetchLike } from '@substrat-run/kernel';
import { platformActorId, scopeId, tenantId } from '@substrat-run/contracts';
import {
  createControlPlaneApi,
  mintTenantToken,
  tenantTokenAuth,
  DEV_ACTOR_HEADER,
  SERVICE_TOKEN_HEADER,
  UNSAFE_devPlatformActorAuth,
} from '../src/index.js';

/**
 * `GET /meters/days` (#2501): the daily meter snapshots the platform sweep takes into the
 * directory, served back. The sweep runs for real over a real SQLite directory, so the route is
 * held to what the snapshot actually wrote, not to a fixture of it.
 */

describe('the daily meter snapshot end to end, and GET /meters/days (#2501)', () => {
  const SECRET = 'meter-days-tenant-secret';
  const serviceActor = platformActorId.parse('01JZ00000000000000000000SV');
  const staff = platformActorId.parse(ulid());
  const builderActor = platformActorId.parse(ulid());
  const BUILDER_HEADER = 'x-test-builder';
  const asStaff = { [DEV_ACTOR_HEADER]: staff };
  const FETCH = (() => Promise.reject(new Error('unused'))) as unknown as FetchLike;
  const A = tenantId.parse(ulid());
  const B = tenantId.parse(ulid());

  let dir: string;
  let host: SqliteScopeHost;
  let app: ReturnType<typeof createControlPlaneApi>;
  const pass = (now: string) =>
    runPlatformSweep(host, { actor: staff, fetch: FETCH, sweepers: {}, drainRetries: false, meterSnapshot: { now: () => now } });

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'cp-meter-days-'));
    host = new SqliteScopeHost({ dir });
    app = createControlPlaneApi({
      host,
      authenticate: UNSAFE_devPlatformActorAuth(),
      authenticateTenantService: tenantTokenAuth(SECRET, serviceActor),
      authenticateBuilder: (req: Request) =>
        req.headers.get(BUILDER_HEADER) === A ? { actor: builderActor, tenantId: A, tenantSlug: 'acme' } : null,
    });
    await host.admin.createTenant(staff, { id: A, slug: 'acme', name: 'Acme' });
    await host.admin.createTenant(staff, { id: B, slug: 'globex', name: 'Globex' });
    for (const [t, vertical] of [[A, 'acme-crm'], [A, 'acme-crm'], [B, 'acme-desk']] as const) {
      const s = scopeId.parse(ulid());
      await host.provisionScope(staff, { tenantId: t, scopeId: s, vertical });
      await host.admin.activateScope(staff, t, s);
    }
    await host.admin.grantEntitlement(staff, A, 'acme-crm', { plan: 'pro' });

    // Three days, each taken by its first pass; the later passes of a day take nothing.
    for (const now of ['2026-10-20T00:04:00.000Z', '2026-10-21T00:04:00.000Z', '2026-10-21T00:19:00.000Z', '2026-10-22T00:04:00.000Z']) {
      const report = await pass(now);
      expect(report.errors).toEqual([]);
    }
  });
  afterAll(async () => {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('serves what the sweep took, one row per (day, tenant), with the record of each day', async () => {
    const res = await app.request('/meters/days?since=2026-10-19&until=2026-10-21', { headers: asStaff });
    expect(res.status).toBe(200);
    const body = await res.json();
    const none = { suspended: 0, provisioning: 0, archived: 0, reaped: 0 };
    const rowOf = (day: string, t: string) => body.rows.find((r: { day: string; tenantId: string }) => r.day === day && r.tenantId === t);
    expect(rowOf('2026-10-21', A)).toEqual({
      day: '2026-10-21',
      tenantId: A,
      // The first pass of the day, not the later one.
      readAt: '2026-10-21T00:04:00.000Z',
      status: 'active',
      billable: true,
      scopes: { total: 2, active: 2, ...none },
      verticals: [{ vertical: 'acme-crm', total: 2, active: 2, ...none }],
      entitlements: [{ entitlementKey: 'acme-crm', plan: 'pro', expiresAt: null, live: true }],
    });
    expect(rowOf('2026-10-21', B)).toMatchObject({ verticals: [{ vertical: 'acme-desk', total: 1, active: 1 }], entitlements: [] });
    expect(body).toMatchObject({ since: '2026-10-19', until: '2026-10-21', truncated: false });
    expect(body.rows.map((r: { day: string }) => r.day)).toEqual(['2026-10-20', '2026-10-20', '2026-10-21', '2026-10-21']);
    // The day before the first pass has no record, so its missing rows say nothing.
    expect(body.days).toEqual([
      { day: '2026-10-20', attemptedAt: '2026-10-20T00:04:00.000Z', takenAt: '2026-10-20T00:04:00.000Z', tenants: 2, error: null, failingSince: null, failingCount: null },
      { day: '2026-10-21', attemptedAt: '2026-10-21T00:04:00.000Z', takenAt: '2026-10-21T00:04:00.000Z', tenants: 2, error: null, failingSince: null, failingCount: null },
    ]);
  });

  it('narrows by tenant, defaults to the 31 days ending today, and says when a page is cut short', async () => {
    const by = async (q: string) => (await (await app.request(`/meters/days?since=2026-10-01&until=2026-10-31&${q}`, { headers: asStaff })).json()).rows;
    expect((await by(`tenantId=${B}`)).map((r: { day: string }) => r.day)).toEqual(['2026-10-20', '2026-10-21', '2026-10-22']);

    const page = await (await app.request('/meters/days?since=2026-10-01&until=2026-10-31&limit=5', { headers: asStaff })).json();
    expect(page.rows).toHaveLength(5);
    expect(page.truncated).toBe(true);
    const whole = await (await app.request('/meters/days?since=2026-10-01&until=2026-10-31&limit=6', { headers: asStaff })).json();
    expect(whole.rows).toHaveLength(6);
    expect(whole.truncated).toBe(false);

    const recent = await (await app.request('/meters/days', { headers: asStaff })).json();
    const today = new Date().toISOString().slice(0, 10);
    expect(recent.until).toBe(today);
    expect(recent.since).toBe(new Date(Date.parse(`${today}T00:00:00Z`) - 30 * 86_400_000).toISOString().slice(0, 10));
  });

  it('refuses a window that is not one', async () => {
    for (const q of ['since=2026-10-22&until=2026-10-21', 'since=yesterday', 'until=2026-13-01', 'limit=0', 'limit=5001', 'tenantId=nope']) {
      expect((await app.request(`/meters/days?${q}`, { headers: asStaff })).status, q).toBe(400);
    }
    // Its positive twin: the largest page allowed is served.
    expect((await app.request('/meters/days?limit=5000', { headers: asStaff })).status).toBe(200);
  });

  it('is staff-only: a builder and a tenant token are refused, even for their own tenant', async () => {
    const url = `/meters/days?tenantId=${A}`;
    expect((await app.request(url, { headers: { [BUILDER_HEADER]: A } })).status).toBe(403);
    const token = await mintTenantToken(SECRET, { tenantId: A });
    expect((await app.request(url, { headers: { [SERVICE_TOKEN_HEADER]: token } })).status).toBe(403);
    expect((await app.request(url)).status).toBe(401);
    // The positive twins: both credentials are real and reach a route their allowlist names.
    expect((await app.request('/scopes', { headers: { [BUILDER_HEADER]: A } })).status).toBe(200);
    expect((await app.request(`/tenants/${A}`, { headers: { [SERVICE_TOKEN_HEADER]: token } })).status).toBe(200);
  });

  it('answers 501 on a host that keeps no snapshots, never an empty reading', async () => {
    const bare = Object.create(host, {
      admin: { value: { ...host.admin, listMeterDays: undefined, listMeterDayTakes: undefined } },
    }) as SqliteScopeHost;
    const plain = createControlPlaneApi({ host: bare, authenticate: UNSAFE_devPlatformActorAuth() });
    expect((await plain.request('/meters/days', { headers: asStaff })).status).toBe(501);
  });
});
