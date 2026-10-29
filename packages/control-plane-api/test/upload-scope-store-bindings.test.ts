import { createControlPlaneApi } from './setup/build-fixtures.js';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { ulid } from '@substrat-run/kernel';
import { generateScopeStoreKeyPair } from '@substrat-run/contracts/scope-store-envelope';
import {
  platformActorId,
  scopeStoreScriptName,
  STORE_DRIVER_PLATFORM_REPOSITORY,
  storeDriverReleaseDigest,
  tenantId,
  type StoreDriverRegistration,
} from '@substrat-run/contracts';
import {
  createWfpUploader,
  createScopeStoreEnsurer,
  deploymentRefFor,
  STORE_RELEASE_VAR,
  DEV_ACTOR_HEADER,
  stableDeploymentRefFor,
  UNSAFE_devPlatformActorAuth,
} from '../src/index.js';

/**
 * L1 (RFC scope-stores §10.7) at the call sites (#2210): with a driver registered, neither upload
 * `api.ts` sends for a vertical that declares a scope store, the per-version push or the serving
 * upload, carries a `SUBSTRAT_STORE_*` binding. Driven through the real routes and the real
 * uploader (`createWfpUploader`, Cloudflare stubbed at `fetch`), so the bindings asserted are the
 * ones in the multipart metadata Cloudflare would be sent. A binding added beside either call
 * fails here, not only one added inside `verticalUploadBindings`.
 */
describe('a vertical upload carries no scope-store binding, and its store script goes first (#2210)', () => {
  let dir: string;
  let host: SqliteScopeHost;
  let app: ReturnType<typeof createControlPlaneApi>;
  let bare: ReturnType<typeof createControlPlaneApi>;
  let unregistered: ReturnType<typeof createControlPlaneApi>;
  const staff = platformActorId.parse(ulid());
  const auth = { [DEV_ACTOR_HEADER]: staff };

  /** Cloudflare, as far as these uploads reach it: scripts PUT and their settings read back. */
  const scripts = new Map<string, { name: string; text?: string }[]>();
  const puts: { url: string; script: string; meta: Record<string, any> }[] = [];
  let failStorePut = false;

  const release = {
    entry: 'driver_counter/store.py',
    sourceCommit: 'f'.repeat(40),
    modules: [{ name: 'driver_counter/store.py', content: new TextEncoder().encode('class Store:\n    pass\n') }],
  };
  let rolledOut: typeof release | undefined = release;

  /**
   * One test driver, handed to the control plane and the store uploader as their registry
   * (`storeDrivers`, `drivers`). The reviewed `STORE_DRIVERS` is never written to. The release above
   * is recorded and approved in the directory, which is what makes it runnable (D-65).
   */
  const testDriver: StoreDriverRegistration = { driver: 'graph', isolationBasis: { kind: 'writtenInRepo' } };
  let releaseSha: string;

  beforeAll(async () => {
    releaseSha = await storeDriverReleaseDigest(release);
    const caller = await generateScopeStoreKeyPair();
    const platform = await generateScopeStoreKeyPair();
    dir = mkdtempSync(join(tmpdir(), 'cp-upload-scope-store-'));
    host = new SqliteScopeHost({ dir });
    await host.admin.recordStoreDriverRelease(staff, { driver: 'graph', sha256: releaseSha, sourceCommit: release.sourceCommit });
    await host.admin.approveStoreDriverRelease(staff, {
      driver: 'graph',
      sha256: releaseSha,
      reason: 'Reviewed the release bundle',
      sourceReferences: [{ repository: STORE_DRIVER_PLATFORM_REPOSITORY, commit: release.sourceCommit }],
      isolationReview: {},
      schema: 0,
      className: 'Store',
      operations: ['read'],
    });
    const common = {
      host,
      authenticate: UNSAFE_devPlatformActorAuth(),
      storeDrivers: [testDriver],
      deployVertical: createWfpUploader({ accountId: 'acct', namespace: 'ns', apiToken: 'tok' }),
      fetchVerticalModules: async () => [
        { name: 'worker.js', content: new TextEncoder().encode('export default {}'), contentType: 'application/javascript+module' },
      ],
    };
    app = createControlPlaneApi({
      ...common,
      // The approvals are the ones the push read from the directory under its hold.
      ensureScopeStores: ({ approvals, ...input }) => createScopeStoreEnsurer({
        accountId: 'acct',
        namespace: 'ns',
        apiToken: 'tok',
        callerPublicKeys: [caller.publicKey],
        platformPublicKeys: [platform.publicKey],
        drivers: [testDriver],
        approvals,
        loadRelease: async ({ sha256 }) => (sha256 === undefined || sha256 === releaseSha ? rolledOut : undefined),
      })(input),
    });
    // A control plane with no store uploader configured.
    bare = createControlPlaneApi(common);
    // A control plane whose registry holds no driver.
    unregistered = createControlPlaneApi({ ...common, storeDrivers: [] });
  });
  afterAll(async () => {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  });
  afterEach(() => {
    scripts.clear();
    failStorePut = false;
    rolledOut = release;
    vi.unstubAllGlobals();
  });

  const scriptOf = (url: string) => decodeURIComponent(url.split('/scripts/')[1]!.split('/')[0]!);
  function stubCloudflare() {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: { method?: string; body?: FormData }) => {
        const script = url.includes('/scripts/') ? scriptOf(url) : '';
        if (url.endsWith('/settings') && (init?.method ?? 'GET') === 'GET') {
          const bindings = scripts.get(script);
          return bindings ? Response.json({ result: { bindings } }) : new Response('{}', { status: 404 });
        }
        if (init?.method === 'PUT' && init.body instanceof FormData) {
          const meta = JSON.parse(await (init.body.get('metadata') as File).text());
          puts.push({ url, script, meta });
          if (failStorePut && script.startsWith('substrat-store-')) return new Response('{}', { status: 500 });
          scripts.set(script, meta.bindings ?? []);
        }
        return new Response('{}', { status: 200 });
      }),
    );
  }

  const OWN = [
    { type: 'durable_object_namespace', name: 'SCOPE', class_name: 'ScopeDO' },
    { type: 'kv_namespace', name: 'CACHE', id: 'kv-1' },
  ];
  const push = (tenant: string, to = app) => {
    const fd = new FormData();
    fd.set(
      'manifest',
      JSON.stringify({
        version: '0.1.0',
        entry: 'worker.js',
        compatibilityDate: '2025-01-01',
        doClasses: ['ScopeDO'],
        bindings: OWN,
        scopeStores: [{ binding: 'GRAPH', driver: 'graph' }],
        digests: { manifest: 'm1', permission: 'p1', migration: 'g1' },
        registry: { permissions: [], roles: [], entityGrants: [] },
      }),
    );
    fd.set('tenant', tenant);
    fd.set('worker.js', new Blob(['export default {}'], { type: 'application/javascript+module' }), 'worker.js');
    return to.request('/verticals/crm/deploy', { method: 'POST', headers: auth, body: fd });
  };
  const putTo = (script: string) => [...puts].reverse().find((p) => p.script === script);
  const names = (meta: Record<string, any> | undefined): string[] =>
    ((meta?.['bindings'] ?? []) as { name: string }[]).map((b) => b.name);
  const tenantIds = new Map<string, string>();
  const tenant = async (slug: string) => {
    const id = tenantId.parse(ulid());
    await host.admin.createTenant(staff, { id, slug, name: slug });
    tenantIds.set(slug, id);
    return slug;
  };
  const failuresOf = async (vertical: string) => {
    // The recorder is fire-and-forget: let its write settle before reading.
    await new Promise((r) => setTimeout(r, 20));
    return host.admin.listOpsFailures(staff, { vertical });
  };

  it('the per-version push and the serving upload send the vertical’s bindings and no store binding', async () => {
    stubCloudflare();
    const res = await push(await tenant('store-upload'));
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
      // RFC wire-signing step 2: this control plane is given no rollout (`wireUpload`), so no key
      // list, audience or state reaches either upload, and the deployment stays legacy-only
      // (upload-wire-keys.test.ts holds the rollouts that give them).
      expect(sent.filter((name) => name.startsWith('SUBSTRAT_WIRE_')), script).toEqual([]);
      // The twin: the vertical's own declared bindings are in that same upload.
      expect(sent, script).toEqual(expect.arrayContaining(['SCOPE', 'CACHE']));
    }
  });

  it('uploads the store script before the vertical, once, at the release rolled out', async () => {
    stubCloudflare();
    const before = puts.length;
    const res = await push(await tenant('store-order'));
    expect(res.status, await res.clone().text()).toBe(201);
    const { id, verticalSlug } = (await res.json()) as { id: string; verticalSlug: string };
    const store = scopeStoreScriptName(verticalSlug, 'graph');
    expect(puts.slice(before).map((p) => p.script)).toEqual([store, deploymentRefFor(verticalSlug, id)]);
    expect(putTo(store)!.meta.bindings).toEqual(
      expect.arrayContaining([{ type: 'plain_text', name: STORE_RELEASE_VAR, text: releaseSha }]),
    );

    // A serve puts the store script in place first too: with it gone, the promote re-creates it
    // before the serving upload. (A script already built from the same inputs is left alone;
    // store-script.test.ts holds that.)
    scripts.delete(store);
    const served = puts.length;
    const promoted = await app.request(`/verticals/${encodeURIComponent(verticalSlug)}/channels/prod/promote`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ versionId: id }),
    });
    expect(promoted.status, await promoted.clone().text()).toBe(200);
    expect(puts.slice(served).map((p) => p.script)).toEqual([store, stableDeploymentRefFor(verticalSlug)]);
  });

  it('a failed store upload stops the push before the vertical is uploaded, and is recorded', async () => {
    stubCloudflare();
    failStorePut = true;
    const before = puts.length;
    const res = await push(await tenant('store-fails'));
    expect(res.status).toBe(502);
    const sent = puts.slice(before).map((p) => p.script);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatch(/^substrat-store-graph-/);
    expect(await failuresOf('store-fails/crm')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          operation: 'deploy.store-upload',
          stage: 'store-upload',
          status: 502,
          tenantId: tenantIds.get('store-fails'),
        }),
      ]),
    );
  });

  it('a failed store upload stops a promote before the serving upload, and is recorded for the owner', async () => {
    stubCloudflare();
    const res = await push(await tenant('store-serve-fails'));
    expect(res.status, await res.clone().text()).toBe(201);
    const { id, verticalSlug } = (await res.json()) as { id: string; verticalSlug: string };
    // The script is gone and its upload now fails: the promote must not serve without it.
    scripts.delete(scopeStoreScriptName(verticalSlug, 'graph'));
    failStorePut = true;
    const before = puts.length;
    const promoted = await app.request(`/verticals/${encodeURIComponent(verticalSlug)}/channels/prod/promote`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ versionId: id }),
    });
    expect(promoted.ok, await promoted.clone().text()).toBe(false);
    const sent = puts.slice(before).map((p) => p.script);
    expect(sent).toEqual([scopeStoreScriptName(verticalSlug, 'graph')]);
    expect(sent).not.toContain(stableDeploymentRefFor(verticalSlug));
    expect(await failuresOf(verticalSlug)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          operation: 'serve.store-upload',
          stage: 'store-upload',
          status: 502,
          tenantId: tenantIds.get('store-serve-fails'),
        }),
      ]),
    );
  });

  it('a driver with no release rolled out is refused (409) before any upload, and is recorded', async () => {
    stubCloudflare();
    rolledOut = undefined;
    const before = puts.length;
    const res = await push(await tenant('store-unreleased'));
    expect(res.status).toBe(409);
    expect(await res.text()).toMatch(/no release rolled out/);
    expect(puts.length).toBe(before);
    expect(await failuresOf('store-unreleased/crm')).toEqual(
      expect.arrayContaining([expect.objectContaining({ stage: 'store-upload', status: 409 })]),
    );
  });

  it('a push waits out a rollout of its driver (409), naming no other vertical, and holds nothing after (#2300)', async () => {
    stubCloudflare();
    const rollout = ulid();
    expect(await host.admin.holdStoreDriver(staff, { driver: 'graph', holder: rollout, mode: 'exclusive', ttlMs: 60_000 })).toBe(true);
    const before = puts.length;
    const res = await push(await tenant('store-held'));
    expect(res.status).toBe(409);
    const body = await res.text();
    expect(body).toMatch(/driver 'graph' is being rolled out; try again/);
    // The vertical asking is the only one a push answer names.
    expect(body).not.toMatch(/store-order|store-fails|store-upload\/|acme/);
    expect(puts.length).toBe(before);
    expect(await failuresOf('store-held/crm')).toEqual(
      expect.arrayContaining([expect.objectContaining({ stage: 'store-upload', status: 409 })]),
    );
    await host.admin.releaseStoreDriverHold(staff, { driver: 'graph', holder: rollout });
    const retried = await push('store-held');
    expect(retried.status, await retried.clone().text()).toBe(201);
    // The push let its shared hold go: a rollout can hold the driver now.
    expect(await host.admin.holdStoreDriver(staff, { driver: 'graph', holder: rollout, mode: 'exclusive', ttlMs: 60_000 })).toBe(true);
    await host.admin.releaseStoreDriverHold(staff, { driver: 'graph', holder: rollout });
  });

  it('a control plane with no store uploader refuses the push (501) and uploads nothing', async () => {
    stubCloudflare();
    const before = puts.length;
    const res = await push(await tenant('store-bare'), bare);
    expect(res.status).toBe(501);
    expect(await res.text()).toMatch(/uploads no store script/);
    expect(puts.length).toBe(before);
    expect(await failuresOf('store-bare/crm')).toEqual(
      expect.arrayContaining([expect.objectContaining({ stage: 'store-upload', status: 501 })]),
    );
  });

  it('with no driver registered, the same push is refused before anything is uploaded', async () => {
    stubCloudflare();
    const before = puts.length;
    const res = await push(await tenant('store-refused'), unregistered);
    expect(res.status).toBe(403);
    expect(await res.text()).toMatch(/not registered/);
    expect(puts.length).toBe(before);
  });
});
