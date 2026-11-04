import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { ulid } from '@substrat-run/kernel';
import { platformActorId, tenantId, type StoreDriverRegistration } from '@substrat-run/contracts';
import { createControlPlaneApi, DEV_ACTOR_HEADER, UNSAFE_devPlatformActorAuth } from '../src/index.js';

/**
 * `GET /store-drivers?vertical=` (#2813): the registry a push judges its scope stores by, for ONE
 * vertical. A builder reads it; what it reads names no vertical but its own.
 */
describe('control-plane API — the store drivers one vertical may use (#2813)', () => {
  let dir: string;
  let host: SqliteScopeHost;
  const staff = platformActorId.parse(ulid());
  const T = tenantId.parse(ulid());
  const graphFor = (...verticals: string[]): StoreDriverRegistration => ({
    driver: 'graph',
    isolationBasis: { kind: 'decisionRecord', decisionRecord: 'D-67' },
    verticals,
  });
  const appWith = (storeDrivers: StoreDriverRegistration[]) =>
    createControlPlaneApi({
      host,
      authenticate: UNSAFE_devPlatformActorAuth(),
      authenticateBuilder: (req: Request) =>
        req.headers.get('x-test-builder') ? { actor: platformActorId.parse(ulid()), tenantId: T, tenantSlug: 'acme' } : null,
      storeDrivers,
    });
  const asBuilder = { 'x-test-builder': '1' };
  const read = async (app: ReturnType<typeof appWith>, vertical: string, headers: Record<string, string> = asBuilder) =>
    (await app.request(`/store-drivers?vertical=${vertical}`, { headers })).json();

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'cp-store-drivers-list-'));
    host = new SqliteScopeHost({ dir });
    await host.admin.createTenant(staff, { id: T, slug: 'acme', name: 'Acme' });
  });
  afterAll(async () => {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("judges a builder's vertical by its tenant-prefixed id, and names no other vertical", async () => {
    const app = appWith([graphFor('acme/helpdesk', 'rival/crm')]);
    // Served: reduced to the asked slug. Not served: `[]`, so the CLI says "does not serve".
    expect(await read(app, 'helpdesk')).toEqual({ drivers: [graphFor('helpdesk')] });
    expect(await read(app, 'crm')).toEqual({ drivers: [graphFor()] });
    // A registration naming the BARE slug is not what the deploy judges for builder `acme`.
    expect(await read(appWith([graphFor('helpdesk')]), 'helpdesk')).toEqual({ drivers: [graphFor()] });
  });

  it("judges a staff push pinned to a workspace as the deploy forms the id", async () => {
    const app = appWith([graphFor('acme/helpdesk')]);
    const pinned = { [DEV_ACTOR_HEADER]: staff, 'x-substrat-tenant': 'acme' };
    expect(await read(app, 'helpdesk', pinned)).toEqual({ drivers: [graphFor('helpdesk')] });
    expect(await read(app, 'helpdesk', { [DEV_ACTOR_HEADER]: staff })).toEqual({ drivers: [graphFor()] });
  });

  it('needs the vertical, and leaves the staff-only per-driver read closed to a builder', async () => {
    const app = appWith([graphFor('acme/helpdesk')]);
    expect((await app.request('/store-drivers', { headers: asBuilder })).status).toBe(400);
    // The id is formed from the bare slug; a tenant-prefixed value is not accepted.
    expect((await app.request('/store-drivers?vertical=acme/helpdesk', { headers: asBuilder })).status).toBe(400);
    expect((await app.request('/store-drivers/graph', { headers: asBuilder })).status).toBe(403);
  });
});
