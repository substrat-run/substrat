import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { platformActorId, scopeId, tenantId } from '@substrat-run/contracts';
import { ulid } from '@substrat-run/kernel';
import { createControlPlaneApi, DEV_ACTOR_HEADER, mintTenantToken, SERVICE_TOKEN_HEADER, tenantTokenAuth, UNSAFE_devPlatformActorAuth } from '../src/index.js';

const secret = 'metered-usage-tenant-secret';
const actor = platformActorId.parse(ulid());
const serviceActor = platformActorId.parse(ulid());
const own = tenantId.parse(ulid());
const other = tenantId.parse(ulid());
const scope = scopeId.parse(ulid());
const otherScope = scopeId.parse(ulid());
let dir: string;
let host: SqliteScopeHost;
let app: ReturnType<typeof createControlPlaneApi>;
let headers: Record<string, string>;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'cp-tenant-usage-'));
  host = new SqliteScopeHost({ dir });
  app = createControlPlaneApi({
    host,
    authenticate: UNSAFE_devPlatformActorAuth(),
    authenticateTenantService: tenantTokenAuth(secret, serviceActor),
  });
  await host.admin.createTenant(actor, { id: own, slug: 'own', name: 'Own' });
  await host.admin.createTenant(actor, { id: other, slug: 'other', name: 'Other' });
  await host.provisionScope(actor, { tenantId: own, scopeId: scope, vertical: null });
  await host.admin.activateScope(actor, own, scope);
  await host.provisionScope(actor, { tenantId: other, scopeId: otherScope, vertical: null });
  headers = { [SERVICE_TOKEN_HEADER]: await mintTenantToken(secret, { tenantId: own }) };
});

afterAll(async () => {
  await host.close();
  rmSync(dir, { recursive: true, force: true });
});

it('pins the new read to its own tenant and leaves all staff meter routes closed', async () => {
  const allowed = await app.request(`/tenants/${own}/metered-usage`, { headers });
  expect(allowed.status, await allowed.clone().text()).toBe(200);
  expect((await allowed.json()).models.state).toBe('empty');
  expect((await app.request(`/tenants/${other}/metered-usage`, { headers })).status).toBe(403);
  expect((await app.request(`/tenants/${own}/metered-usage?tenantId=${other}`, { headers })).status).toBe(403);
  for (const path of ['/meters', '/meters/requests', '/model-usage', '/model-usage/summary']) {
    expect((await app.request(`${path}?tenantId=${own}`, { headers })).status, path).toBe(403);
  }
  expect((await app.request(`/tenants/${own}/status`, { headers })).status).toBe(403);
});

it('projects stored usage with coverage and age, with no price or person or scope ids', async () => {
  const day = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  const at = `${day}T12:00:00.000Z`;
  await host.admin.recordScopeStorage!(actor, [{ tenantId: own, scopeId: scope, bytes: 65_536, readAt: at }]);
  await host.admin.recordRequestDay!(actor, { day, attemptedAt: at, counts: [{ tenantId: own, vertical: 'app', scopeId: scope, requests: 7, class2xx: 7, class3xx: 0, class4xx: 0, class5xx: 0, rateLimited: 0, sampled: true }] });
  await host.admin.recordModelUsage({ requestId: 'model-usage-1', line: {
    attribution: { tenant: own, scope, vertical: 'app', version: '1', operation: 'ask' },
    model: 'provider:model', provider: 'provider', modelId: 'model', reported: true,
    inputTokens: 11, outputTokens: 3, cachedInputTokens: 0, cacheWriteTokens: 0,
    listUsd: '9.99', at, elapsedMs: 10,
  } });
  const response = await app.request(`/tenants/${own}/metered-usage`, { headers });
  expect(response.status, await response.clone().text()).toBe(200);
  const body = await response.json();
  expect(body.storage).toMatchObject({ bytes: 65_536, sampled: 1, total: 1, estimated: false });
  expect(body.requests).toMatchObject({ requests: 7, estimated: true, coveredDays: 1 });
  expect(body.models).toMatchObject({ state: 'complete', calls: 1, inputTokens: 11, outputTokens: 3, estimated: false, lowerBound: false });
  expect(body.models.byVerticalModel).toContainEqual(expect.objectContaining({ vertical: 'app', model: 'provider:model', calls: 1 }));
  expect(body.retention).toMatchObject({ storageMonths: 13, modelDays: 400, requestMonths: null });
  expect(JSON.stringify(body)).not.toMatch(/price|margin|usd|cost|amount|tenantId|scopeId|principal|person|listUsd|billedUsd/i);
  expect(JSON.stringify(body)).not.toContain(scope);
  expect(JSON.stringify(body)).not.toContain(other);
});

it('labels a capped model ledger scan as an at-least lower bound', async () => {
  const real = host.admin.listModelUsage.bind(host.admin);
  let pages = 0;
  const spy = vi.spyOn(host.admin, 'listModelUsage').mockImplementation(async (who, filter) => {
    pages++;
    const seed = (await real(who, { ...filter, cursor: undefined, limit: 1 }))[0]!;
    return Array.from({ length: 501 }, (_, i) => ({ ...seed, id: `${String(10_000 - pages).padStart(8, '0')}-${String(500 - i).padStart(3, '0')}` }));
  });
  try {
    const response = await app.request(`/tenants/${own}/metered-usage`, { headers });
    expect(response.status, await response.clone().text()).toBe(200);
    const body = await response.json();
    expect(pages).toBeLessThanOrEqual(25);
    expect(body.models).toMatchObject({ state: 'truncated', lowerBound: true, calls: 12_500 });
    expect(body.models.oldestRecordedAt).toBeTruthy();
  } finally {
    spy.mockRestore();
  }
});

it('labels a capped request-row scan as a partial sum of estimates', async () => {
  const real = host.admin.listRequestDays!.bind(host.admin);
  const spy = vi.spyOn(host.admin, 'listRequestDays').mockImplementation(async (who, filter) => {
    const seed = (await real(who, { ...filter, limit: 1 }))[0]!;
    return Array.from({ length: 10_000 }, (_, i) => ({ ...seed, vertical: `app-${i % 60}` }));
  });
  try {
    const response = await app.request(`/tenants/${own}/metered-usage`, { headers });
    expect(response.status, await response.clone().text()).toBe(200);
    const body = await response.json();
    expect(body.requests).toMatchObject({ state: 'truncated', lowerBound: true, requests: 69_993 });
    expect(body.requests.byVertical).toHaveLength(50);
    expect(body.requests.breakdownTruncated).toBe(true);
  } finally {
    spy.mockRestore();
  }
});

it('keeps provider-unreported token counts unavailable instead of displaying zero', async () => {
  const day = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  await host.admin.recordModelUsage({ requestId: 'model-usage-unreported', line: {
    attribution: { tenant: other, scope: otherScope, vertical: 'other-app', version: '1', operation: 'ask' },
    model: 'provider:other', provider: 'provider', modelId: 'other', reported: false,
    inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0,
    listUsd: null, at: `${day}T12:00:00.000Z`, elapsedMs: 10,
  } });
  const asOther = { [SERVICE_TOKEN_HEADER]: await mintTenantToken(secret, { tenantId: other }) };
  const response = await app.request(`/tenants/${other}/metered-usage`, { headers: asOther });
  expect(response.status, await response.clone().text()).toBe(200);
  const body = await response.json();
  expect(body.models).toMatchObject({ calls: 1, inputTokens: null, outputTokens: null });
  expect(body.models.byVerticalModel).toContainEqual(expect.objectContaining({ calls: 1, inputTokens: null, outputTokens: null }));
});
