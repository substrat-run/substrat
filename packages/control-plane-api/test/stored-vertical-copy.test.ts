import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { ulid } from '@substrat-run/kernel';
import { platformActorId, principalId, scopeId, tenantId, type ScopeId } from '@substrat-run/contracts';
import { createControlPlaneApi, DEV_ACTOR_HEADER, UNSAFE_devPlatformActorAuth, type VerticalClient } from '../src/index.js';

/**
 * Provisioning holds a vertical a caller names to the registry's grammar, but a copy takes the
 * vertical its source already stores. A scope whose stored vertical reads but is not a slug (one
 * stored before the grammar was held at provisioning) is snapshotted and given a sibling as
 * before, while the same value sent to `POST /scopes` is refused.
 */
describe('a stored vertical that is not a slug is copied as stored', () => {
  /** Values the `scope` schema reads (non-empty) that the registry grammar does not admit. */
  const STORED = ['Todo', 'my_vertical', 'a/b/c', ' spaced '];

  let dir: string;
  let host: SqliteScopeHost;
  const staff = platformActorId.parse(ulid());
  const tenant = tenantId.parse(ulid());
  const owner = principalId.parse(ulid());
  const auth = { [DEV_ACTOR_HEADER]: staff, 'content-type': 'application/json' };

  /** A vertical deployment that copies and provisions whatever it is asked to. */
  const fakeVertical = {
    snapshotScope: async () => ({ tables: 0 }),
    provisionInstance: async (input: { scopeId: string }) => ({ tenantId: tenant, scopeId: input.scopeId, owner }),
  } as unknown as VerticalClient;

  /** Co-located: no deployment, so a snapshot runs the adapter's own `snapshotScope`. */
  let colocated: ReturnType<typeof createControlPlaneApi>;
  /** Each stored value has a deployment, so a snapshot and a sibling run the route's own provision. */
  let deployed: ReturnType<typeof createControlPlaneApi>;

  /** An active scope whose directory row stores `vertical` as given, past the provisioning boundary. */
  const storedWith = async (vertical: string): Promise<ScopeId> => {
    const s = scopeId.parse(ulid());
    await host.provisionScope(staff, { tenantId: tenant, scopeId: s, vertical: 'todo' });
    await host.admin.activateScope(staff, tenant, s);
    (host as unknown as { directory: { prepare(q: string): { run(...a: unknown[]): unknown } } }).directory
      .prepare('UPDATE scopes SET vertical = ? WHERE scope_id = ?')
      .run(vertical, s);
    return s;
  };

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'cp-stored-vertical-'));
    host = new SqliteScopeHost({ dir });
    colocated = createControlPlaneApi({ host, authenticate: UNSAFE_devPlatformActorAuth() });
    deployed = createControlPlaneApi({
      host,
      authenticate: UNSAFE_devPlatformActorAuth(),
      verticals: Object.fromEntries(STORED.map((v) => [v, fakeVertical])),
    });
    await host.admin.createTenant(staff, { id: tenant, slug: 'acme', name: 'Acme' });
  });

  afterAll(async () => {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it.each(STORED)('snapshots a scope storing %j in-process, carrying it', async (vertical) => {
    const source = await storedWith(vertical);
    const res = await colocated.request(`/tenants/${tenant}/scopes/${source}/snapshots`, { method: 'POST', headers: auth, body: '{}' });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ forkedFrom: source, vertical });
  });

  it.each(STORED)('snapshots a scope storing %j through its deployment, carrying it', async (vertical) => {
    const source = await storedWith(vertical);
    const res = await deployed.request(`/tenants/${tenant}/scopes/${source}/snapshots`, { method: 'POST', headers: auth, body: '{}' });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ forkedFrom: source, vertical });
  });

  it.each(STORED)('gives a scope storing %j a sibling that inherits it', async (vertical) => {
    const parent = await storedWith(vertical);
    const sibling = scopeId.parse(ulid());
    const res = await deployed.request(`/tenants/${tenant}/scopes`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ scopeId: sibling, parentScopeId: parent, owner, slug: `site-${sibling.slice(-8).toLowerCase()}`, name: 'Site' }),
    });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ id: sibling, vertical, status: 'active' });
  });

  it.each(STORED)('refuses %j named by a caller, even one claiming it is a copy', async (vertical) => {
    const scope = scopeId.parse(ulid());
    const res = await colocated.request('/scopes', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ tenantId: tenant, scopeId: scope, vertical, verticalSource: 'copy' }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { errors?: { path: string }[] }).errors?.map((e) => e.path)).toContain('vertical');
    expect(await host.admin.getScopeRecord(staff, tenant, scope)).toBeUndefined();
  });
});
