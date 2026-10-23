import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { ulid } from '@substrat-run/kernel';
import { platformActorId, scopeId, tenantId } from '@substrat-run/contracts';
import { createControlPlaneApi, DEV_ACTOR_HEADER, UNSAFE_devPlatformActorAuth } from '../src/index.js';

/**
 * `POST /scopes` takes the vertical in the registry's grammar (`verticalSlug`). An empty string
 * used to be accepted at provisioning and then failed to parse when scopes were listed.
 */
describe('POST /scopes — the vertical is a vertical slug', () => {
  let dir: string;
  let host: SqliteScopeHost;
  let app: ReturnType<typeof createControlPlaneApi>;

  const staff = platformActorId.parse(ulid());
  const tenant = tenantId.parse(ulid());
  const auth = { [DEV_ACTOR_HEADER]: staff, 'content-type': 'application/json' };
  const post = (body: unknown) => app.request('/scopes', { method: 'POST', headers: auth, body: JSON.stringify(body) });

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'cp-provision-vertical-'));
    host = new SqliteScopeHost({ dir });
    app = createControlPlaneApi({ host, authenticate: UNSAFE_devPlatformActorAuth() });
    await host.admin.createTenant(staff, { id: tenant, slug: 'acme', name: 'Acme' });
  });

  afterAll(async () => {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it.each(['', '   ', 'Housing', 'a/b/c', 'housing/'])('refuses %j with a validation_failed problem naming the field', async (vertical) => {
    const scope = scopeId.parse(ulid());
    const provision = vi.spyOn(host, 'provisionScope');
    try {
      const res = await post({ tenantId: tenant, scopeId: scope, vertical });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { code?: string; errors?: { path: string }[] };
      expect(body.code).toBe('validation_failed');
      expect(body.errors?.map((e) => e.path)).toContain('vertical');
      // Refused by the body parse, before the host is asked. The kernel holds the same rule and
      // answers the same problem, so the call count is what tells the two layers apart.
      expect(provision).not.toHaveBeenCalled();
    } finally {
      provision.mockRestore();
    }
    expect(await host.admin.getScopeRecord(staff, tenant, scope)).toBeUndefined();
  });

  it.each([
    ['a bare slug', 'housing', 'housing'],
    ['digits', 'ticket0', 'ticket0'],
    ['an owner prefix', 'acme/housing', 'acme/housing'],
    ['null', null, null],
    ['no vertical', undefined, null],
  ] as const)('provisions with %s', async (_name, vertical, stored) => {
    const scope = scopeId.parse(ulid());
    const res = await post({ tenantId: tenant, scopeId: scope, ...(vertical === undefined ? {} : { vertical }) });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ id: scope, vertical: stored });
  });

  it('lists every scope it provisioned', async () => {
    const res = await app.request(`/scopes?tenantId=${tenant}`, { headers: auth });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { entries: unknown[] }).entries).toHaveLength(5);
  });
});
