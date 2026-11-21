import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { ulid } from '@substrat-run/kernel';
import { platformActorId, scopeId, tenantId } from '@substrat-run/contracts';
import { createControlPlaneApi, DEV_ACTOR_HEADER, SERVICE_TOKEN_HEADER, tenantTokenAuth, UNSAFE_devPlatformActorAuth } from '../src/index.js';

/**
 * `PUT /tenants/:t/scopes/:s/expires-at` (#3314): move a copy's GC deadline, or pin it. It is how
 * the pre-promote snapshots taken before they were born expiring get an end, and how one worth
 * keeping is pinned. The snapshot GC reaps a fork or a source-less preview once its instant
 * passes, so that is exactly what the route admits.
 */
describe('a copy’s expiry, moved by staff', () => {
  const SECRET = 'test-tenant-token-secret';
  const staff = platformActorId.parse(ulid());
  const headers = { [DEV_ACTOR_HEADER]: staff, 'content-type': 'application/json' };
  const t = tenantId.parse(ulid());
  const primary = scopeId.parse(ulid());
  let dir: string;
  let host: SqliteScopeHost;
  let app: ReturnType<typeof createControlPlaneApi>;
  let fork: string;

  const put = (scope: string, body: string, h: Record<string, string> = headers) =>
    app.request(`/tenants/${t}/scopes/${scope}/expires-at`, { method: 'PUT', headers: h, body });

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'cp-expires-at-'));
    host = new SqliteScopeHost({ dir });
    app = createControlPlaneApi({
      host,
      authenticate: UNSAFE_devPlatformActorAuth(),
      authenticateTenantService: tenantTokenAuth(SECRET, platformActorId.parse('01JZ00000000000000000000SV')),
      tenantTokenSecret: SECRET,
    });
    await host.admin.createTenant(staff, { id: t, slug: 'acme', name: 'acme' });
    await host.provisionScope(staff, { tenantId: t, scopeId: primary });
    await host.admin.activateScope(staff, t, primary);
    const res = await app.request(`/tenants/${t}/scopes/${primary}/snapshots`, { method: 'POST', headers, body: '{}' });
    expect(res.status).toBe(201);
    fork = ((await res.json()) as { id: string }).id;
  });

  afterAll(async () => {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('gives a fork an end, in UTC whatever offset it was sent in, and pins it again with null', async () => {
    const set = await put(fork, JSON.stringify({ expiresAt: '2030-01-02T03:04:05+02:00' }));
    expect(set.status).toBe(200);
    // The GC compares instants as text, so an offset kept as sent would reap at the wrong time.
    expect(((await set.json()) as { expiresAt: string }).expiresAt).toBe('2030-01-02T01:04:05.000Z');

    const pinned = await put(fork, JSON.stringify({ expiresAt: null }));
    expect(pinned.status).toBe(200);
    expect((await host.admin.getScopeRecord(staff, t, scopeId.parse(fork)))?.expiresAt).toBeNull();
  });

  it.each([
    ['a primary scope', () => primary, JSON.stringify({ expiresAt: '2030-01-01T00:00:00Z' }), 409],
    ['an unknown scope', () => ulid(), JSON.stringify({ expiresAt: '2030-01-01T00:00:00Z' }), 404],
    ['a body without the key', () => fork, '{}', 400],
  ])('refuses %s, and moves no expiry', async (_what, scope, body, status) => {
    expect((await put(scope(), body)).status).toBe(status);
    expect((await host.admin.getScopeRecord(staff, t, primary))?.expiresAt).toBeNull();
  });

  it('is not open to a tenant credential', async () => {
    const minted = await app.request('/tenant-tokens', { method: 'POST', headers, body: JSON.stringify({ tenantId: t }) });
    const { token } = (await minted.json()) as { token: string };
    const res = await put(fork, JSON.stringify({ expiresAt: '2030-01-01T00:00:00Z' }), {
      [SERVICE_TOKEN_HEADER]: token,
      'content-type': 'application/json',
    });
    expect(res.status).toBe(403);
  });
});
