import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { ulid } from '@substrat-run/kernel';
import { platformActorId, tenantId, type FindingEntry, type TenantId } from '@substrat-run/contracts';
import {
  createControlPlaneApi,
  firstBuilderAuth,
  mintPushToken,
  pushActorFor,
  pushTokenBuilderAuth,
  tenantTokenAuth,
  DEV_ACTOR_HEADER,
  SERVICE_TOKEN_HEADER,
  UNSAFE_devPlatformActorAuth,
} from '../src/index.js';

/**
 * Findings over HTTP (#1748): who reaches the inbox, and whose rows it answers with.
 *
 * Staff read the fleet. A tenant's own credential — the dashboard's — reads only its own tenant,
 * whatever `tenantId` it asks for, and acts only under its own path. A builder's push token
 * reaches none of it: a finding is the tenant's, not the vertical author's. Each refusal checks
 * that nothing moved, since a 403 that had already written would pass a status-only check.
 */
describe('the findings routes (#1748)', () => {
  const TENANT_SECRET = 'test-tenant-token-secret';
  const PUSH_SECRET = 'test-push-token-secret';
  const t = tenantId.parse(ulid());
  const other = tenantId.parse(ulid());
  const staff = platformActorId.parse(ulid());
  const serviceActor = platformActorId.parse('01JZ00000000000000000000SV');
  const asStaff = { [DEV_ACTOR_HEADER]: staff, 'content-type': 'application/json' };
  let asTenant: Record<string, string>;
  let asOtherTenant: Record<string, string>;
  let asBuilder: Record<string, string>;
  let dir: string;
  let host: SqliteScopeHost;
  let app: ReturnType<typeof createControlPlaneApi>;
  const inADay = () => new Date(Date.now() + 86_400_000).toISOString();

  const fail = (tenant: TenantId, operation: string) =>
    host.admin.recordOpsFailure({ actor: staff, operation, stage: 'terminal', tenantId: tenant, message: 'x' });
  /** A tenant credential names its own tenant (the plane's query pin); staff may name any, or none. */
  const findingsOf = async (headers: Record<string, string>, query = ''): Promise<FindingEntry[]> => {
    const tenant = headers === asTenant ? t : headers === asOtherTenant ? other : null;
    const res = await app.request(`/findings${query || (tenant ? `?tenantId=${tenant}` : '')}`, { headers });
    expect(res.status).toBe(200);
    return ((await res.json()) as { entries: FindingEntry[] }).entries;
  };
  const tokenFor = async (tenant: string) => {
    const minted = await app.request('/tenant-tokens', {
      method: 'POST',
      headers: asStaff,
      body: JSON.stringify({ tenantId: tenant }),
    });
    expect(minted.status).toBe(201);
    return { [SERVICE_TOKEN_HEADER]: ((await minted.json()) as { token: string }).token, 'content-type': 'application/json' };
  };

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'cp-findings-'));
    host = new SqliteScopeHost({ dir });
    app = createControlPlaneApi({
      host,
      authenticate: UNSAFE_devPlatformActorAuth(),
      authenticateTenantService: tenantTokenAuth(TENANT_SECRET, serviceActor),
      authenticateBuilder: firstBuilderAuth(pushTokenBuilderAuth(PUSH_SECRET)),
      tenantTokenSecret: TENANT_SECRET,
      pushTokenSecret: PUSH_SECRET,
    });
    for (const [tenant, slug] of [
      [t, 'acme'],
      [other, 'other'],
    ] as const) {
      await host.admin.createTenant(staff, { id: tenant, slug, name: slug });
    }
    await fail(t, 'deploy.mine');
    await fail(other, 'deploy.theirs');
    asTenant = await tokenFor(t);
    asOtherTenant = await tokenFor(other);
    const push = await mintPushToken(PUSH_SECRET, { actor: await pushActorFor(t), tenantId: t, tenantSlug: 'acme' });
    asBuilder = { [SERVICE_TOKEN_HEADER]: push, 'content-type': 'application/json' };
  });

  afterAll(async () => {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('answers a tenant credential with its own findings only, and refuses it any other tenant', async () => {
    const mine = await findingsOf(asTenant);
    expect(mine.map((f) => f.operation)).toEqual(['deploy.mine']);
    // Naming the other tenant, or none, is refused before the handler runs.
    expect((await app.request(`/findings?tenantId=${other}`, { headers: asTenant })).status).toBe(403);
    expect((await app.request('/findings', { headers: asTenant })).status).toBe(403);
    // Staff read the fleet, and narrow it when they ask.
    const fleet = await findingsOf(asStaff);
    expect(new Set(fleet.map((f) => f.tenantId))).toEqual(new Set([t, other]));
    expect((await findingsOf(asStaff, `?tenantId=${other}`)).map((f) => f.operation)).toEqual(['deploy.theirs']);
  });

  it("refuses a verdict under another tenant's path, and the finding does not move; its own moves it", async () => {
    const [theirs] = await findingsOf(asOtherTenant);
    const refused = await app.request(`/tenants/${other}/findings/${theirs!.id}/status`, {
      method: 'PUT',
      headers: asTenant,
      body: JSON.stringify({ status: 'resolved' }),
    });
    expect(refused.status).toBe(403);
    // Under its OWN path, another tenant's id is unknown — never a write.
    const unknown = await app.request(`/tenants/${t}/findings/${theirs!.id}/status`, {
      method: 'PUT',
      headers: asTenant,
      body: JSON.stringify({ status: 'resolved' }),
    });
    expect(unknown.status).toBe(404);
    expect((await findingsOf(asOtherTenant))[0]!.status).toBe('open');

    const moved = await app.request(`/tenants/${other}/findings/${theirs!.id}/status`, {
      method: 'PUT',
      headers: asOtherTenant,
      body: JSON.stringify({ status: 'acked' }),
    });
    expect(moved.status).toBe(200);
    expect(((await moved.json()) as FindingEntry).status).toBe('acked');
  });

  it('refuses `suppressed` as a verdict: suppressing is a rule', async () => {
    const [mine] = await findingsOf(asTenant);
    const res = await app.request(`/tenants/${t}/findings/${mine!.id}/status`, {
      method: 'PUT',
      headers: asTenant,
      body: JSON.stringify({ status: 'suppressed' }),
    });
    expect(res.status).toBe(400);
    expect((await findingsOf(asTenant))[0]!.status).toBe('open');
  });

  it('creates, lists and revokes a rule under the tenant’s own path, and refuses a bad one with 400', async () => {
    const created = await app.request(`/tenants/${t}/finding-rules`, {
      method: 'POST',
      headers: asTenant,
      body: JSON.stringify({ operation: 'deploy.mine', expiresAt: inADay(), reason: 'known' }),
    });
    expect(created.status).toBe(201);
    const { rule, suppressed } = (await created.json()) as { rule: { id: string }; suppressed: number };
    expect(suppressed).toBe(1);
    expect((await findingsOf(asTenant))[0]!.status).toBe('suppressed');

    // Another tenant can neither list nor revoke it under the first tenant's path.
    expect((await app.request(`/tenants/${t}/finding-rules`, { headers: asOtherTenant })).status).toBe(403);
    expect(
      (await app.request(`/tenants/${t}/finding-rules/${rule.id}`, { method: 'DELETE', headers: asOtherTenant })).status,
    ).toBe(403);
    const listed = await app.request(`/tenants/${t}/finding-rules?active=true`, { headers: asTenant });
    expect(((await listed.json()) as { entries: { id: string }[] }).entries.map((r) => r.id)).toEqual([rule.id]);

    const revoked = await app.request(`/tenants/${t}/finding-rules/${rule.id}`, { method: 'DELETE', headers: asTenant });
    expect(revoked.status).toBe(200);
    const after = await app.request(`/tenants/${t}/finding-rules?active=true`, { headers: asTenant });
    expect(((await after.json()) as { entries: unknown[] }).entries).toEqual([]);

    // A rule naming nothing would silence the whole tenant; one already expired suppresses nothing.
    for (const body of [
      { expiresAt: inADay(), reason: 'everything' },
      { operation: 'deploy.mine', expiresAt: new Date(Date.now() - 1000).toISOString(), reason: 'past' },
    ]) {
      const bad = await app.request(`/tenants/${t}/finding-rules`, { method: 'POST', headers: asTenant, body: JSON.stringify(body) });
      expect(bad.status).toBe(400);
    }
  });

  it('refuses a builder push token on every findings route', async () => {
    const [mine] = await findingsOf(asTenant);
    for (const [method, path] of [
      ['GET', `/findings?tenantId=${t}`],
      ['PUT', `/tenants/${t}/findings/${mine!.id}/status`],
      ['GET', `/tenants/${t}/finding-rules`],
      ['POST', `/tenants/${t}/finding-rules`],
    ] as const) {
      const res = await app.request(path, {
        method,
        headers: asBuilder,
        ...(method === 'GET' ? {} : { body: JSON.stringify({ status: 'resolved', operation: 'x', expiresAt: inADay(), reason: 'r' }) }),
      });
      expect(res.status, `${method} ${path}`).toBe(403);
    }
    expect((await findingsOf(asTenant))[0]!.status).not.toBe('resolved');
  });
});
