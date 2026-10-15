import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { ulid, webCryptoSecretBox } from '@substrat-run/kernel';
import { connectionId, type ConnectionId, permissionKey, platformActorId, principalId, scopeId, tenantId } from '@substrat-run/contracts';
import {
  createControlPlaneApi, DEV_ACTOR_HEADER, SERVICE_TOKEN_HEADER,
  UNSAFE_devPlatformActorAuth, tenantTokenAuth, firstBuilderAuth,
  pushTokenBuilderAuth, mintPushToken, pushActorFor,
} from '../src/index.js';
import type { ConnectionInspector } from '../src/index.js';

// Real directory and scope tuples: the route must check the delivered grant, not just
// accept a request or find a grant on a different scope. No provider credentials are read.
describe('poll connector binding door', () => {
  const actor = platformActorId.parse(ulid());
  const tenant = tenantId.parse(ulid()), other = tenantId.parse(ulid());
  const scope = scopeId.parse(ulid()), wrongVertical = scopeId.parse(ulid()), preview = scopeId.parse(ulid());
  const createdBy = principalId.parse(ulid());
  const headers = { [DEV_ACTOR_HEADER]: actor, 'content-type': 'application/json' };
  const input = { operation: 'maintenance/record-plan', permission: 'plan:record', organizationId: null, currency: 'SEK', window: null, horizonYears: 50 };
  let dir: string, host: SqliteScopeHost, connection: ConnectionId, fortnox: ConnectionId;
  let app: ReturnType<typeof createControlPlaneApi>;
  const bind = vi.fn<NonNullable<ConnectionInspector['bindScope']>>();
  const bindings = vi.fn<NonNullable<ConnectionInspector['bindings']>>();
  const path = (id = connection, t = tenant, s = scope) => `/tenants/${t}/connections/${id}/bindings/${s}`;
  const write = (body: unknown = input, url = path(), auth = headers) => app.request(url, { method: 'PUT', headers: auth, body: JSON.stringify(body) });
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'connection-bindings-'));
    host = new SqliteScopeHost({ dir, secretBox: webCryptoSecretBox('k1', new Uint8Array(32).fill(7)) });
    await host.admin.createTenant(actor, { id: tenant, slug: 'acme', name: 'Acme' });
    await host.admin.createTenant(actor, { id: other, slug: 'other', name: 'Other' });
    await host.provisionScope(actor, { tenantId: tenant, scopeId: scope, vertical: 'acme-crm' });
    await host.provisionScope(actor, { tenantId: tenant, scopeId: wrongVertical, vertical: 'other-crm' });
    await host.provisionScope(actor, { tenantId: tenant, scopeId: preview, vertical: 'acme-crm', kind: 'preview' });
    await host.admin.activateScope(actor, tenant, scope);
    await host.admin.activateScope(actor, tenant, wrongVertical);
    connection = connectionId.parse(ulid());
    await host.admin.createConnection(actor, { id: connection, scopes: [], tenantId: tenant, vertical: 'acme-crm', provider: 'planima', label: 'Planima', secret: { apiToken: 'never-return-this' }, createdBy });
    fortnox = connectionId.parse(ulid());
    await host.admin.createConnection(actor, { id: fortnox, scopes: [], tenantId: tenant, vertical: 'acme-crm', provider: 'fortnox', label: 'Fortnox', secret: { apiToken: 'never-return-this-either' }, createdBy });
    bind.mockImplementation(async (_h, row, target) => {
      const value = { ...target, boundAt: '2026-10-15T12:00:00.000Z' };
      await host.admin.putConnectorState(row.id, `${row.provider}:binding:${target.scopeId}`, value);
      return value;
    });
    bindings.mockImplementation(async (_h, row) => (await host.admin.listConnectorState(row.id, `${row.provider}:binding:`)).map((r) => r.value as Awaited<ReturnType<NonNullable<ConnectionInspector['bindScope']>>>));
    app = createControlPlaneApi({ host, authenticate: UNSAFE_devPlatformActorAuth(),
      authenticateTenantService: tenantTokenAuth('tenant-secret', actor),
      authenticateBuilder: firstBuilderAuth(pushTokenBuilderAuth('push-secret')),
      tenantTokenSecret: 'tenant-secret',
      connectionInspectors: { planima: { bindScope: bind, bindings }, fortnox: { bindScope: bind, bindings } },
    });
  });
  afterAll(async () => { await host.close(); rmSync(dir, { recursive: true, force: true }); });

  it('refuses a missing grant without creating a binding or granting authority', async () => {
    const response = await write();
    expect(response.status).toBe(409);
    expect(await response.text()).toContain('plan:record');
    expect(bind).not.toHaveBeenCalled();
    expect(await host.admin.listConnectionGrants(actor, tenant)).toEqual([]);
  });
  it('refuses a foreign connection, mismatched vertical, and preview', async () => {
    expect((await write(input, path(connection, other))).status).toBe(404);
    expect((await write(input, path(connection, tenant, wrongVertical))).status).toBe(409);
    expect((await write(input, path(connection, tenant, preview))).status).toBe(403);
    expect(bind).not.toHaveBeenCalled();
  });
  it('rejects caller-supplied tenant/vertical, reversed windows, and fractional horizons', async () => {
    for (const body of [{ ...input, vertical: 'forged' }, { ...input, tenantId: other }, { ...input, window: { fromYear: 2050, toYear: 2026 } }, { ...input, horizonYears: 1.5 }]) {
      expect((await write(body)).status).toBe(400);
    }
    expect(bind).not.toHaveBeenCalled();
  });
  it('does not accept Planima-only configuration for Fortnox', async () => {
    expect((await write(input, path(fortnox))).status).toBe(400);
    expect(bind).not.toHaveBeenCalled();
  });
  it('keeps binding reads and writes staff/service-only', async () => {
    const minted = await app.request('/tenant-tokens', { method: 'POST', headers, body: JSON.stringify({ tenantId: tenant }) });
    expect(minted.status).toBe(201);
    const token = (await minted.json() as { token: string }).token;
    const push = await mintPushToken('push-secret', { actor: await pushActorFor(tenant), tenantId: tenant, tenantSlug: 'acme' });
    for (const credential of [token, push]) {
      const auth = { [SERVICE_TOKEN_HEADER]: credential, 'content-type': 'application/json' };
      expect((await write(input, path(), auth as typeof headers)).status).toBe(403);
      expect((await app.request(path().slice(0, -scope.length - 1), { headers: auth })).status).toBe(403);
    }
    expect(bind).not.toHaveBeenCalled();
  });
  it('binds only after the scoped grant, derives identity, and logs actor and target', async () => {
    await host.admin.grantToConnection(actor, { connectionId: connection, permission: permissionKey.parse('plan:record'), node: { tenantId: tenant, scopeId: scope }, grantedBy: actor });
    const response = await write();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ...input, tenantId: tenant, scopeId: scope, vertical: 'acme-crm' });
    expect(bind).toHaveBeenCalledTimes(1);
    const read = await app.request(`/tenants/${tenant}/connections/${connection}/bindings`, { headers });
    expect(read.status).toBe(200);
    const text = await read.text();
    expect(JSON.parse(text)).toHaveLength(1);
    expect(text).not.toContain('never-return-this');
    const log = (await host.admin.auditLog(actor, { tenantId: tenant })).filter((r) => r.action === 'bindConnectionScope');
    expect(log.map((r) => r.after?.phase)).toEqual(['intent', 'applied']);
    expect(log[0]).toMatchObject({ actor, scopeId: scope, after: { connectionId: connection, permission: 'plan:record' } });
  });
  it('will not write a binding when recording its audit intent fails', async () => {
    const before = bind.mock.calls.length;
    const audit = vi.spyOn(host.admin, 'recordConnectionBindingChange').mockRejectedValueOnce(new Error('audit unavailable'));
    try {
      expect((await write()).status).toBe(500);
      expect(bind.mock.calls.length).toBe(before);
    } finally { audit.mockRestore(); }
  });
  it('reports an applied binding with an audit warning when the outcome log fails', async () => {
    const original = host.admin.recordConnectionBindingChange;
    const audit = vi.spyOn(host.admin, 'recordConnectionBindingChange').mockImplementation(async (actor, entry) => {
      if (entry.phase === 'applied') throw new Error('outcome unavailable');
      return original(actor, entry);
    });
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const response = await write();
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ scopeId: scope, auditWarning: 'outcome unavailable' });
    } finally { audit.mockRestore(); log.mockRestore(); }
  });
  it('binds Fortnox through the same gate and preserves unrelated connector state', async () => {
    await host.admin.grantToConnection(actor, { connectionId: fortnox, permission: permissionKey.parse('ledger:record'), node: { tenantId: tenant, scopeId: scope }, grantedBy: actor });
    await host.admin.putConnectorState(fortnox, 'unrelated', { keep: true });
    const response = await write({ operation: 'ledger/record-period', permission: 'ledger:record' }, path(fortnox));
    expect(response.status).toBe(200);
    expect(await host.admin.getConnectorState(fortnox, 'unrelated')).toEqual({ keep: true });
  });
});
