import { createControlPlaneApi } from './setup/build-fixtures.js';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { platformActorId, tenantId } from '@substrat-run/contracts';
import { ulid } from '@substrat-run/kernel';
import { createWfpUploader, DEV_ACTOR_HEADER, UNSAFE_devPlatformActorAuth } from '../src/index.js';

/**
 * #2430: the deploy manifest's `ownerGrants` (package.json `substrat.ownerGrants`) are granted to a
 * fresh install's owner, a person, so the push route refuses one holding a key the registry's rows
 * reserve to a system principal — before anything is uploaded. Driven through the real `/deploy`
 * route and uploader (Cloudflare stubbed at `fetch`), so a route that stopped asking is red here and
 * not only in the contracts suite that holds the rule itself.
 */
describe('POST /verticals/:slug/deploy holds ownerGrants to the registry’s reservations (#2430)', () => {
  let dir: string;
  let host: SqliteScopeHost;
  let app: ReturnType<typeof createControlPlaneApi>;
  const staff = platformActorId.parse(ulid());
  const auth = { [DEV_ACTOR_HEADER]: staff };
  const uploads: string[] = [];

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'cp-deploy-owner-grants-'));
    host = new SqliteScopeHost({ dir });
    app = createControlPlaneApi({
      host,
      authenticate: UNSAFE_devPlatformActorAuth(),
      deployVertical: createWfpUploader({ accountId: 'acct', namespace: 'ns', apiToken: 'tok' }),
    });
  });
  afterAll(async () => {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  });
  afterEach(() => vi.unstubAllGlobals());

  const push = async (manifest: { ownerGrants?: string[]; marked: boolean; modules?: unknown[]; omitRegistry?: boolean; connectors?: unknown[]; registryConnectors?: unknown[] }, slugged?: (slug: string, tenant: string) => void) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: { method?: string }) => {
        if (init?.method === 'PUT') uploads.push(url);
        return new Response('{}', { status: 200 });
      }),
    );
    const slug = `owner-grants-${ulid().toLowerCase()}`;
    const tenant = tenantId.parse(ulid());
    slugged?.(slug, tenant);
    await host.admin.createTenant(staff, { id: tenant, slug, name: slug });
    const fd = new FormData();
    fd.set(
      'manifest',
      JSON.stringify({
        version: '0.1.0',
        entry: 'worker.js',
        compatibilityDate: '2025-01-01',
        doClasses: ['ScopeDO'],
        bindings: [{ type: 'durable_object_namespace', name: 'SCOPE', class_name: 'ScopeDO' }],
        digests: { manifest: 'm1', permission: 'p1', migration: 'g1' },
        ...(!manifest.omitRegistry ? { registry: {
          permissions: [
            { key: 'crm:contact-read', description: 'Read a contact', declaredBy: ['crm'] },
            { key: 'crm:sync-run', description: 'Run a sync', declaredBy: ['crm'], ...(manifest.marked ? { holder: 'system' } : {}) },
          ],
          roles: [],
          entityGrants: [],
          // As the CLI sends it: each connector's standing grants join the registry.
          ...(manifest.connectors
            ? { connectors: manifest.registryConnectors ?? (manifest.connectors as { provider: string; grants: string[] }[]).map(({ provider, grants }) => ({ provider, grants })) }
            : {}),
        } } : {}),
        ...(manifest.ownerGrants ? { ownerGrants: manifest.ownerGrants } : {}),
        ...(manifest.modules ? { modules: manifest.modules } : {}),
        ...(manifest.connectors ? { connectors: manifest.connectors } : {}),
      }),
    );
    fd.set('tenant', slug);
    fd.set('worker.js', new Blob(['export default {}'], { type: 'application/javascript+module' }), 'worker.js');
    return app.request('/verticals/crm/deploy', { method: 'POST', headers: auth, body: fd });
  };

  it('refuses owner grants holding a reserved key with the boundary’s words, and uploads nothing', async () => {
    const before = uploads.length;
    const res = await push({ ownerGrants: ['crm:contact-read', 'crm:sync-run'], marked: true });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      code: 'validation_failed',
      error:
        'manifest ownerGrants: owner grants (substrat.ownerGrants) → crm:sync-run: ' +
        "reserved to a system principal (`holder: 'system'` on its registry row)",
    });
    expect(uploads.length).toBe(before);
  });

  it('accepts its twins: person keys only, a manifest from a CLI that sends none, and a registry that marks nothing', async () => {
    for (const manifest of [
      { ownerGrants: ['crm:contact-read'], marked: true },
      { marked: true },
      { ownerGrants: ['crm:sync-run'], marked: false },
    ]) {
      const res = await push(manifest);
      expect(res.status, `${JSON.stringify(manifest)}: ${await res.clone().text()}`).toBe(201);
    }
  });

  it('checks the same declarations on the upload path before upload (#2446)', async () => {
    const modules = [{ id: 'crm', permissions: [
      { key: 'crm:contact-read', description: 'Read a contact' },
      { key: 'crm:sync-run', description: 'Run a sync', holder: 'system' },
    ] }];
    const before = uploads.length;
    const bad = await push({ marked: false, modules });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toContain('crm:sync-run: registry holder disagrees with module declarations');
    expect(uploads.length).toBe(before);
    const reservedGrant = await push({ marked: true, modules: [{ ...modules[0], ownerGrants: ['crm:sync-run'] }] });
    expect(reservedGrant.status).toBe(400);
    expect(((await reservedGrant.json()) as { error: string }).error).toContain('owner grants of crm → crm:sync-run');
    expect(uploads.length).toBe(before);
    expect((await push({ marked: true, modules })).status).toBe(201);
  });

  it('requires a registry when modules are sent before uploading a bundle', async () => {
    const modules = [{ id: 'crm', permissions: [
      { key: 'crm:contact-read', description: 'Read a contact' },
      { key: 'crm:sync-run', description: 'Run a sync', holder: 'system' },
    ] }];
    const before = uploads.length;
    const refused = await push({ marked: true, modules, omitRegistry: true });
    expect(refused.status).toBe(400);
    expect(await refused.json()).toMatchObject({
      code: 'validation_failed',
      error: 'manifest registry: required when modules are present',
    });
    expect(uploads.length).toBe(before);
    expect((await push({ marked: true, modules })).status).toBe(201);
  });

  it('refuses a connector whose standing grant the registry does not declare, and registers a declared one (vertical-connectors.md §7.1)', async () => {
    const connector = (grants: string[]) => ({
      provider: 'acme.box', label: 'Box', description: 'A document box.', fields: [{ key: 'token', label: 'Token', secret: true }],
      grants, events: [], sweeps: true, binds: false, dispatches: false,
    });
    const before = uploads.length;
    // The registry's own parse holds its rows to its keys; what only this route can see is a
    // connector the registry rows disagree with.
    const bad = await push({ marked: true, connectors: [connector(['crm:nope'])], registryConnectors: [{ provider: 'acme.box', grants: ['crm:contact-read'] }] });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toBe(
      'manifest connectors: connector acme.box: its grants disagree with registry.connectors; ' +
        'connector acme.box → crm:nope: a standing grant the registry does not declare',
    );
    expect(uploads.length).toBe(before);

    let slug = '';
    let owner = '';
    const good = await push({ marked: true, connectors: [connector(['crm:contact-read'])] }, (s, t) => ((slug = s), (owner = t)));
    expect(good.status).toBe(201);
    // Read back as the dashboard's install catalog reads it (`listCatalog`): the registry route.
    const listed = await app.request(`/verticals?visibleTo=${owner}`, { headers: auth });
    const { entries } = (await listed.json()) as { entries: { slug: string; connectors?: unknown }[] };
    const registered = entries.find((v) => v.slug === `${slug}/crm`);
    expect(registered?.connectors).toEqual([connector(['crm:contact-read'])]);
  });
});
