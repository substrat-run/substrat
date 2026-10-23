import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { ulid } from '@substrat-run/kernel';
import { platformActorId, tenantId } from '@substrat-run/contracts';
import {
  createControlPlaneApi,
  mintTenantToken,
  tenantTokenAuth,
  DEV_ACTOR_HEADER,
  SERVICE_TOKEN_HEADER,
  UNSAFE_devPlatformActorAuth,
} from '../src/index.js';

/**
 * `GET /verticals/:slug/owners` (#2501): who owned a vertical slug when, served from a real SQLite
 * directory whose registrations and deletes wrote the periods. Staff-only: the builder who owns the
 * slug today is refused like anyone else, since the history names earlier owners too.
 */
describe('GET /verticals/:slug/owners (#2501)', () => {
  const SECRET = 'vertical-owners-tenant-secret';
  const serviceActor = platformActorId.parse('01JZ00000000000000000000SV');
  const staff = platformActorId.parse(ulid());
  const builderActor = platformActorId.parse(ulid());
  const BUILDER_HEADER = 'x-test-builder';
  const asStaff = { [DEV_ACTOR_HEADER]: staff };
  const [A, B] = [tenantId.parse(ulid()), tenantId.parse(ulid())];
  const SLUG = 'acme/crm';

  let dir: string;
  let host: SqliteScopeHost;
  let app: ReturnType<typeof createControlPlaneApi>;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'cp-vertical-owners-'));
    host = new SqliteScopeHost({ dir });
    app = createControlPlaneApi({
      host,
      authenticate: UNSAFE_devPlatformActorAuth(),
      authenticateTenantService: tenantTokenAuth(SECRET, serviceActor),
      authenticateBuilder: (req: Request) =>
        req.headers.get(BUILDER_HEADER) === B ? { actor: builderActor, tenantId: B, tenantSlug: 'acme' } : null,
    });
    await host.admin.createTenant(staff, { id: A, slug: 'globex', name: 'Globex' });
    await host.admin.createTenant(staff, { id: B, slug: 'acme', name: 'Acme' });
    // Owned by one tenant, deleted, then registered again by another.
    await host.admin.registerVertical(staff, { slug: SLUG, name: 'CRM', source: 'cli', ownerTenant: A });
    await host.admin.deleteVertical(staff, SLUG);
    await host.admin.registerVertical(staff, { slug: SLUG, name: 'CRM', source: 'cli', ownerTenant: B });
  });
  afterAll(async () => {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('serves every period of the slug, oldest first, the closed one and the one that stands', async () => {
    const res = await app.request(`/verticals/${encodeURIComponent(SLUG)}/owners`, { headers: asStaff });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.slug).toBe(SLUG);
    expect(body.owners).toEqual([
      { slug: SLUG, owner: A, since: expect.any(String), until: expect.any(String) },
      { slug: SLUG, owner: B, since: expect.any(String), until: null },
    ]);
    expect(body.owners[0].until <= body.owners[1].since).toBe(true);
  });

  it('a slug never registered has no period, and a slug that is not one is refused', async () => {
    expect(await (await app.request('/verticals/never-registered/owners', { headers: asStaff })).json()).toEqual({
      slug: 'never-registered',
      owners: [],
    });
    expect((await app.request('/verticals/Not%20A%20Slug/owners', { headers: asStaff })).status).toBe(400);
  });

  it('is staff-only: the builder that owns the slug today and a tenant token are refused', async () => {
    const url = `/verticals/${encodeURIComponent(SLUG)}/owners`;
    expect((await app.request(url, { headers: { [BUILDER_HEADER]: B } })).status).toBe(403);
    const token = await mintTenantToken(SECRET, { tenantId: B });
    expect((await app.request(url, { headers: { [SERVICE_TOKEN_HEADER]: token } })).status).toBe(403);
    expect((await app.request(url)).status).toBe(401);
    // The positive twins: both credentials are real and reach a route their allowlist names.
    expect((await app.request('/verticals', { headers: { [BUILDER_HEADER]: B } })).status).toBe(200);
    expect((await app.request(`/tenants/${B}`, { headers: { [SERVICE_TOKEN_HEADER]: token } })).status).toBe(200);
  });

  it('answers 501 on a host that keeps no ownership history', async () => {
    const bare = Object.create(host, { admin: { value: { ...host.admin, listVerticalOwners: undefined } } }) as SqliteScopeHost;
    const plain = createControlPlaneApi({ host: bare, authenticate: UNSAFE_devPlatformActorAuth() });
    expect((await plain.request(`/verticals/${encodeURIComponent(SLUG)}/owners`, { headers: asStaff })).status).toBe(501);
  });
});
