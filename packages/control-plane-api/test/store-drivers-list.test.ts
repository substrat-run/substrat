import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { ulid } from '@substrat-run/kernel';
import { platformActorId, tenantId, type StoreDriverRegistration } from '@substrat-run/contracts';
import { createControlPlaneApi, UNSAFE_devPlatformActorAuth } from '../src/index.js';

/**
 * `GET /store-drivers?vertical=` (#2813): the registry a push judges its scope stores by, for ONE
 * vertical. A builder reads it; what it reads names no vertical but its own.
 */
describe('control-plane API — the store drivers one vertical may use (#2813)', () => {
  let dir: string;
  let host: SqliteScopeHost;
  const staff = platformActorId.parse(ulid());
  const T = tenantId.parse(ulid());
  const graph: StoreDriverRegistration = {
    driver: 'graph',
    isolationBasis: { kind: 'decisionRecord', decisionRecord: 'D-67' },
    verticals: ['helpdesk', 'rival-app'],
  };
  const app = () =>
    createControlPlaneApi({
      host,
      authenticate: UNSAFE_devPlatformActorAuth(),
      authenticateBuilder: (req: Request) =>
        req.headers.get('x-test-builder') ? { actor: platformActorId.parse(ulid()), tenantId: T, tenantSlug: 'acme' } : null,
      storeDrivers: [graph],
    });
  const asBuilder = { 'x-test-builder': '1' };

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'cp-store-drivers-list-'));
    host = new SqliteScopeHost({ dir });
    await host.admin.createTenant(staff, { id: T, slug: 'acme', name: 'Acme' });
  });
  afterAll(async () => {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('answers a builder with the drivers its vertical may use, naming no other vertical', async () => {
    const served = await app().request('/store-drivers?vertical=helpdesk', { headers: asBuilder });
    expect(served.status).toBe(200);
    expect(await served.json()).toEqual({ drivers: [{ ...graph, verticals: ['helpdesk'] }] });
    const unserved = await app().request('/store-drivers?vertical=other', { headers: asBuilder });
    expect(await unserved.json()).toEqual({ drivers: [] });
  });

  it('needs the vertical, and leaves the staff-only per-driver read closed to a builder', async () => {
    expect((await app().request('/store-drivers', { headers: asBuilder })).status).toBe(400);
    expect((await app().request('/store-drivers/graph', { headers: asBuilder })).status).toBe(403);
  });
});
