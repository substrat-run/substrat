import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { ulid } from '@substrat-run/kernel';
import { platformActorId, STORE_KINDS, tenantId, type StoreKindRegistration } from '@substrat-run/contracts';
import {
  createControlPlaneApi,
  createWfpUploader,
  createScopeStoreEnsurer,
  deploymentRefFor,
  DEV_ACTOR_HEADER,
  stableDeploymentRefFor,
  UNSAFE_devPlatformActorAuth,
} from '../src/index.js';

/**
 * L1 (RFC scope-stores §10.7) at the call sites (#2210): with a kind registered, neither upload
 * `api.ts` sends for a vertical that declares a scope store, the per-version push or the serving
 * upload, carries a `SUBSTRAT_STORE_*` binding. Driven through the real routes and the real
 * uploader (`createWfpUploader`, Cloudflare stubbed at `fetch`), so the bindings asserted are the
 * ones in the multipart metadata Cloudflare would be sent. A binding added beside either call
 * fails here, not only one added inside `verticalUploadBindings`.
 */
describe('a vertical upload carries no scope-store binding, with a kind registered (#2210)', () => {
  let dir: string;
  let host: SqliteScopeHost;
  let app: ReturnType<typeof createControlPlaneApi>;
  const staff = platformActorId.parse(ulid());
  const auth = { [DEV_ACTOR_HEADER]: staff };
  const puts: { url: string; meta: Record<string, any> }[] = [];

  /**
   * The push check reads {@link STORE_KINDS}. `graph` is registered. The refusal test
   * empties that array for one call and puts the entry back, so a later file still sees it.
   */
  const registry = STORE_KINDS as StoreKindRegistration[];

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'cp-upload-scope-store-'));
    host = new SqliteScopeHost({ dir });
    app = createControlPlaneApi({
      host,
      authenticate: UNSAFE_devPlatformActorAuth(),
      deployVertical: createWfpUploader({ accountId: 'acct', namespace: 'ns', apiToken: 'tok' }),
      ensureScopeStores: createScopeStoreEnsurer({
        accountId: 'acct',
        namespace: 'ns',
        apiToken: 'tok',
        callerPublicKey: 'caller-pub',
        platformPublicKey: 'platform-pub',
        loadRelease: async () => ({
          release: '1.0.0',
          entry: 'kind_counter.py',
          modules: [{ name: 'kind_counter.py', content: new TextEncoder().encode('class Store:\n    pass\n') }],
        }),
      }),
      fetchVerticalModules: async () => [
        { name: 'worker.js', content: new TextEncoder().encode('export default {}'), contentType: 'application/javascript+module' },
      ],
    });
  });
  afterAll(async () => {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  });
  afterEach(() => {
    registry.length = 0;
    vi.unstubAllGlobals();
  });

  function stubCloudflare() {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: { method?: string; body?: FormData }) => {
        if (init?.method === 'PUT' && init.body instanceof FormData) {
          puts.push({ url, meta: JSON.parse(await (init.body.get('metadata') as File).text()) });
        }
        return new Response('{}', { status: 200 });
      }),
    );
  }

  const OWN = [
    { type: 'durable_object_namespace', name: 'SCOPE', class_name: 'ScopeDO' },
    { type: 'kv_namespace', name: 'CACHE', id: 'kv-1' },
  ];
  const push = (tenant: string) => {
    const fd = new FormData();
    fd.set(
      'manifest',
      JSON.stringify({
        version: '0.1.0',
        entry: 'worker.js',
        compatibilityDate: '2025-01-01',
        doClasses: ['ScopeDO'],
        bindings: OWN,
        scopeStores: [{ binding: 'GRAPH', kind: 'graph' }],
        digests: { manifest: 'm1', permission: 'p1', migration: 'g1' },
        registry: { permissions: [], roles: [], entityGrants: [] },
      }),
    );
    fd.set('tenant', tenant);
    fd.set('worker.js', new Blob(['export default {}'], { type: 'application/javascript+module' }), 'worker.js');
    return app.request('/verticals/crm/deploy', { method: 'POST', headers: auth, body: fd });
  };
  const putTo = (script: string) => [...puts].reverse().find((p) => p.url.endsWith(`/scripts/${encodeURIComponent(script)}`));
  const names = (meta: Record<string, any> | undefined): string[] =>
    ((meta?.['bindings'] ?? []) as { name: string }[]).map((b) => b.name);

  it('the per-version push and the serving upload send the vertical’s bindings and no store binding', async () => {
    stubCloudflare();
    await host.admin.createTenant(staff, { id: tenantId.parse(ulid()), slug: 'store-upload', name: 'store-upload' });
    const res = await push('store-upload');
    expect(res.status, await res.clone().text()).toBe(201);
    const { id, verticalSlug } = (await res.json()) as { id: string; verticalSlug: string };

    const promoted = await app.request(`/verticals/${encodeURIComponent(verticalSlug)}/channels/prod/promote`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ versionId: id }),
    });
    expect(promoted.status, await promoted.clone().text()).toBe(200);

    for (const script of [deploymentRefFor(verticalSlug, id), stableDeploymentRefFor(verticalSlug)]) {
      const sent = names(putTo(script)?.meta);
      expect(sent.filter((name) => name.startsWith('SUBSTRAT_STORE_')), script).toEqual([]);
      // The twin: the vertical's own declared bindings are in that same upload.
      expect(sent, script).toEqual(expect.arrayContaining(['SCOPE', 'CACHE']));
    }
  });

  it('with the kind taken out of the registry, the same push is refused before anything is uploaded', async () => {
    stubCloudflare();
    const before = puts.length;
    const saved = registry.splice(0, registry.length);
    try {
      await host.admin.createTenant(staff, { id: tenantId.parse(ulid()), slug: 'store-refused', name: 'store-refused' });
      const res = await push('store-refused');
      expect(res.status).toBe(403);
      expect(await res.text()).toMatch(/not registered/);
      expect(puts.length).toBe(before);
    } finally {
      registry.push(...saved);
    }
  });
});
