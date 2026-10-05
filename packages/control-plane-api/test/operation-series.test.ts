import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { ulid, webCryptoSecretBox } from '@substrat-run/kernel';
import { platformActorId, scopeId, tenantId } from '@substrat-run/contracts';
import {
  createControlPlaneApi,
  tenantTokenAuth,
  DEV_ACTOR_HEADER,
  SERVICE_TOKEN_HEADER,
  UNSAFE_devPlatformActorAuth,
} from '../src/index.js';

/**
 * Business volumes per bucket (#1750) at the plane: the route a tenant credential reaches,
 * pinned to its own tenant by the path, exactly as #1956's connector series is. The
 * counting and the scope-level K-3 check are the contract suite's; this is the door.
 */
describe('POST /tenants/:t/scopes/:s/operation-series (#1750)', () => {
  const TENANT_SECRET = 'test-tenant-token-secret';
  const staff = platformActorId.parse(ulid());
  const serviceActor = platformActorId.parse('01JZ00000000000000000000SV');
  const acme = tenantId.parse(ulid());
  const other = tenantId.parse(ulid());
  const acmeScope = scopeId.parse(ulid());
  const otherScope = scopeId.parse(ulid());
  const asStaff = { [DEV_ACTOR_HEADER]: staff };
  let asAcme: Record<string, string>;
  let dir: string;
  let host: SqliteScopeHost;
  let app: ReturnType<typeof createControlPlaneApi>;

  const body = JSON.stringify({
    moves: [{ entityType: 'conversation', operation: 'desk/close' }],
    since: '2026-10-03T00:00:00.000Z',
    until: '2026-10-04T00:00:00.000Z',
    bucketMinutes: 30,
  });
  const post = (t: string, s: string, headers: Record<string, string>) =>
    app.request(`/tenants/${t}/scopes/${s}/operation-series`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body,
    });

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'cp-operation-series-'));
    host = new SqliteScopeHost({ dir, secretBox: webCryptoSecretBox('k1', new Uint8Array(32).fill(7)) });
    app = createControlPlaneApi({
      host,
      authenticate: UNSAFE_devPlatformActorAuth(),
      authenticateTenantService: tenantTokenAuth(TENANT_SECRET, serviceActor),
      tenantTokenSecret: TENANT_SECRET,
    });
    for (const [t, s, slug] of [[acme, acmeScope, 'acme'], [other, otherScope, 'other']] as const) {
      await host.admin.createTenant(staff, { id: t, slug, name: slug });
      await host.provisionScope(staff, { tenantId: t, scopeId: s, vertical: 'demo-vert' });
      await host.admin.activateScope(staff, t, s);
    }
    const minted = await app.request('/tenant-tokens', {
      method: 'POST',
      headers: { ...asStaff, 'content-type': 'application/json' },
      body: JSON.stringify({ tenantId: acme }),
    });
    expect(minted.status).toBe(201);
    asAcme = { [SERVICE_TOKEN_HEADER]: ((await minted.json()) as { token: string }).token };
  });

  afterAll(async () => {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("a tenant token reads its own scope's series (the positive twin)", async () => {
    const res = await post(acme, acmeScope, asAcme);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ series: [{ entityType: 'conversation', operation: 'desk/close', total: 0, buckets: [] }] });
  });

  it("a tenant token cannot name another tenant, nor reach another tenant's scope under its own", async () => {
    // The path pin: another tenant in the path is refused before any scope is resolved.
    expect((await post(other, otherScope, asAcme)).status).toBe(403);
    // Its own tenant in the path with a foreign scope: the pair is absent, never an empty series.
    expect((await post(acme, otherScope, asAcme)).status).toBe(404);
    // …while staff reach the other tenant's scope, so the refusals are the credential's.
    expect((await post(other, otherScope, asStaff)).status).toBe(200);
  });

  it('refuses a window past the cap before it reaches the scope', async () => {
    const res = await app.request(`/tenants/${acme}/scopes/${acmeScope}/operation-series`, {
      method: 'POST',
      headers: { ...asAcme, 'content-type': 'application/json' },
      body: JSON.stringify({ ...JSON.parse(body), until: '2026-10-11T00:00:00.000Z' }),
    });
    expect(res.status).toBe(400);
  });
});
