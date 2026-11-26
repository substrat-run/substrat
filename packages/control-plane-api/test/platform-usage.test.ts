import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { platformActorId, scopeId, tenantId, type CloudflareUsageDay } from '@substrat-run/contracts';
import { ulid } from '@substrat-run/kernel';
import { createControlPlaneApi, DEV_ACTOR_HEADER, mintTenantToken, SERVICE_TOKEN_HEADER, tenantTokenAuth, UNSAFE_devPlatformActorAuth } from '../src/index.js';

/**
 * Platform usage, priced (#3316): the tenant's reading (price only) and staff's (cost, markup,
 * price, residual), over fixtures planted through the same paths production takes: a usage day
 * loaded and attributed by the directory, object ids recorded, request and storage rows.
 *
 * List prices: rows written $1/M, requests $0.30/M, storage $0.20/GB-month, router CPU $0.02/M ms.
 * The seeded schedule: 100% over cost, previews at cost.
 */

const secret = 'platform-usage-secret';
const staff = platformActorId.parse(ulid());
const service = platformActorId.parse(ulid());
const A = tenantId.parse(ulid());
const B = tenantId.parse(ulid());
const C = tenantId.parse(ulid());
const LIVE = scopeId.parse(ulid());
const PREVIEW = scopeId.parse(ulid());
const OTHER = scopeId.parse(ulid());

const dayOf = (offset: number) => new Date(Date.now() - offset * 86_400_000).toISOString().slice(0, 10);
/** The read day, and the closed day after it, which the rollup has not read. */
const READ = dayOf(2);
const UNREAD = dayOf(1);
const [y, m] = READ.split('-').map(Number) as [number, number];
const DAYS_IN_MONTH = new Date(Date.UTC(y, m, 0)).getUTCDate();
const hex = (c: string) => c.repeat(64);

let dir: string;
let host: SqliteScopeHost;
let app: ReturnType<typeof createControlPlaneApi>;
const asStaff = { [DEV_ACTOR_HEADER]: staff, 'content-type': 'application/json' };
const asTenant: Record<string, string> = {};

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'cp-platform-usage-'));
  host = new SqliteScopeHost({ dir });
  app = createControlPlaneApi({ host, authenticate: UNSAFE_devPlatformActorAuth(), authenticateTenantService: tenantTokenAuth(secret, service) });
  for (const [id, slug] of [[A, 'acme'], [B, 'tenant-b'], [C, 'tenant-c']] as const) await host.admin.createTenant(staff, { id, slug, name: slug });
  asTenant[SERVICE_TOKEN_HEADER] = await mintTenantToken(secret, { tenantId: A });
  // A storage sample is kept only for a scope the directory holds.
  await host.provisionScope(staff, { tenantId: A, scopeId: LIVE, vertical: null });
  await host.admin.activateScope(staff, A, LIVE);

  const usage: CloudflareUsageDay = {
    day: READ,
    workers: [{ script: 'substrat-router', cpuTimeUs: 1_000_000_000 }],
    doInvocations: [],
    doObjects: [
      { namespaceId: 'ns', objectId: hex('a'), rowsRead: 0, rowsWritten: 2_000_000, storageWriteUnits: 9, duration: 0 },
      { namespaceId: 'ns', objectId: hex('b'), rowsRead: 0, rowsWritten: 3_000_000, storageWriteUnits: 0, duration: 0 },
      { namespaceId: 'ns', objectId: hex('c'), rowsRead: 0, rowsWritten: 1_000_000, storageWriteUnits: 0, duration: 0 },
      { namespaceId: 'ns', objectId: hex('d'), rowsRead: 0, rowsWritten: 500_000, storageWriteUnits: 0, duration: 0 },
    ],
    namespaces: [],
  };
  expect((await app.request('/meters/cloudflare-costs/days', { method: 'POST', headers: asStaff, body: JSON.stringify(usage) })).status).toBe(201);
  const at = `${READ}T06:00:00.000Z`;
  const target = { script: 'acme-crm', versionId: null, previewTag: null, attemptedAt: at };
  await host.admin.recordScopeObject!(staff, { ...target, tenantId: A, scopeId: LIVE, vertical: 'acme/crm', kind: 'live', objectId: hex('a') });
  await host.admin.recordScopeObject!(staff, { ...target, tenantId: A, scopeId: PREVIEW, vertical: 'acme/crm', kind: 'preview', previewTag: 'pr-7', objectId: hex('b') });
  await host.admin.recordScopeObject!(staff, { ...target, tenantId: B, scopeId: OTHER, vertical: 'tenant-b/todo', kind: 'live', objectId: hex('c') });
  await host.admin.recordRequestDay!(staff, {
    day: READ,
    attemptedAt: at,
    counts: [{ tenantId: A, vertical: 'acme/crm', scopeId: LIVE, requests: 1_000_000, class2xx: 1_000_000, class3xx: 0, class4xx: 0, class5xx: 0, rateLimited: 0, sampled: true }],
  });
  // One GB-month's worth on one day of the month: $0.20.
  await host.admin.recordScopeStorage!(staff, [{ tenantId: A, scopeId: LIVE, bytes: DAYS_IN_MONTH * 1_000_000_000, readAt: at }]);
});

afterAll(async () => {
  await host.close();
  rmSync(dir, { recursive: true, force: true });
});

const window = `days=2&until=${UNREAD}`;

describe('/tenants/:tenantId/platform-usage (#3316)', () => {
  it("prices the team's apps per day, live and preview apart, and carries no cost or markup", async () => {
    const res = await app.request(`/tenants/${A}/platform-usage?${window}`, { headers: asTenant });
    expect(res.status, await res.clone().text()).toBe(200);
    const text = await res.text();
    // Price only: nothing named a cost, a markup or a list rate reaches the tenant.
    expect(text).not.toMatch(/"(costUsd|markupUsd|priceUsd|previewCostUsd|rates|residual)"/);
    const body = JSON.parse(text);
    expect(body).toMatchObject({
      state: 'partial',
      readDays: 1,
      totalDays: 2,
      // live: rows written 2 + requests 0.3 + storage 0.2 = 2.5 at cost, 5 at 100%; preview 3 at cost.
      wouldCostUsd: '8',
      liveWouldCostUsd: '5',
      previewWouldCostUsd: '3',
      chargedUsd: '0',
      quantities: { rowsWritten: '5000000', requests: '1000000', storage: String(DAYS_IN_MONTH * 1_000_000_000), cpu: '0' },
    });
    expect(body.apps.map((a: { vertical: string; kind: string; wouldCostUsd: string }) => [a.vertical, a.kind, a.wouldCostUsd])).toEqual([
      ['acme/crm', 'live', '5'],
      ['acme/crm', 'preview', '3'],
    ]);
    expect(body.days).toEqual([
      expect.objectContaining({ day: READ, read: true, wouldCostUsd: '8', previewWouldCostUsd: '3' }),
      { day: UNREAD, read: false, wouldCostUsd: null, liveWouldCostUsd: null, previewWouldCostUsd: null, quantities: null, wouldCostByDimension: null, byApp: [] },
    ]);
    // Which usage made the day cost what it did: the day's price per dimension, and each app's.
    expect(body.days[0].wouldCostByDimension).toMatchObject({ rowsWritten: '7', requests: '0.6', storage: '0.4', cpu: '0' });
    expect(body.days[0].byApp.map((a: { kind: string; wouldCostByDimension: Record<string, string> }) => [a.kind, a.wouldCostByDimension.rowsWritten, a.wouldCostByDimension.requests])).toEqual([
      ['live', '4', '0.6'],
      ['preview', '3', '0'],
    ]);
  });

  it('tells a window the rollup has not read from one the team used nothing in', async () => {
    const notRead = await (await app.request(`/tenants/${A}/platform-usage?days=1&until=${UNREAD}`, { headers: asTenant })).json();
    expect(notRead).toMatchObject({ state: 'not-read', readDays: 0, wouldCostUsd: '0' });
    const res = await app.request(`/tenants/${C}/platform-usage?${window}`, { headers: asStaff });
    expect(await res.json()).toMatchObject({ state: 'empty', readDays: 1, wouldCostUsd: '0', apps: [] });
  });

  it("refuses another tenant's usage, the staff reading, and a day that has not ended", async () => {
    expect((await app.request(`/tenants/${B}/platform-usage`, { headers: asTenant })).status).toBe(403);
    expect((await app.request(`/meters/platform-costs`, { headers: asTenant })).status).toBe(403);
    expect((await app.request(`/tenants/${A}/platform-usage?until=${dayOf(0)}`, { headers: asTenant })).status).toBe(400);
  });
});

describe('/meters/platform-costs (#3316)', () => {
  it('sets cost, markup and price side by side per tenant and day, with the residual apart', async () => {
    const res = await app.request(`/meters/platform-costs?${window}`, { headers: asStaff });
    expect(res.status, await res.clone().text()).toBe(200);
    const body = await res.json();
    expect(body.totals).toEqual({ costUsd: '6.5', markupUsd: '3.5', priceUsd: '10', previewCostUsd: '3', residualCostUsd: '0.52' });
    expect(body.tenants).toEqual([
      {
        tenantId: A,
        costUsd: '5.5',
        markupUsd: '2.5',
        priceUsd: '8',
        previewCostUsd: '3',
        topVerticals: [{ vertical: 'acme/crm', costUsd: '5.5', markupUsd: '2.5', priceUsd: '8', previewCostUsd: '3' }],
        days: [{ day: READ, costUsd: '5.5', markupUsd: '2.5', priceUsd: '8', previewCostUsd: '3' }],
      },
      expect.objectContaining({ tenantId: B, costUsd: '1', markupUsd: '1', priceUsd: '2', previewCostUsd: '0' }),
    ]);
    // An object no scope owns, and the router's own CPU: a cost with no tenant and no price.
    expect(body.residual).toEqual({
      costUsd: '0.52',
      unmapped: '0',
      platform: '0.02',
      unknown: '0.5',
      days: [{ day: READ, costUsd: '0.52', unmapped: '0', platform: '0.02', unknown: '0.5' }],
    });
    expect(body.days.map((d: { day: string; read: boolean }) => [d.day, d.read])).toEqual([[READ, true], [UNREAD, false]]);
    expect(body.rates.find((r: { dimension: string }) => r.dimension === 'rows-written')).toEqual({ dimension: 'rows-written', usd: '1.00', per: 1_000_000, unit: 'rows written' });
  });
});
