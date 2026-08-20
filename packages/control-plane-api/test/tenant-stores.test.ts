import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { ulid } from '@substrat-run/kernel';
import {
  blobStoreBindingName,
  platformActorId,
  tenantId,
  scopeId,
  substratError,
  tenantStoreBindingName,
} from '@substrat-run/contracts';
import {
  createControlPlaneApi,
  createWfpBindingsPatcher,
  DEV_ACTOR_HEADER,
  UNSAFE_devPlatformActorAuth,
  VerticalClient,
  stableDeploymentRefFor,
  type ScriptBindingSpec,
} from '../src/index.js';

/**
 * Per-tenant relational stores through the API surface (#301 PR-2): the provision
 * endpoint mints what the vertical's SERVING manifest declares, hands the K-31 callback
 * the handles, attaches the request-time D1 bindings, and every in-place serving upload
 * re-derives those bindings from the ledger — driven end-to-end against the pure adapter
 * with the Cloudflare edges (uploader, patcher) faked at their seams.
 */
describe('control-plane API — per-tenant stores (#301)', () => {
  let dir: string;
  let host: SqliteScopeHost;
  let app: ReturnType<typeof createControlPlaneApi>;

  const staff = platformActorId.parse(ulid());
  const auth = { [DEV_ACTOR_HEADER]: staff };

  /** Every serving upload the fake uploader received: ref → bindings sent. */
  const uploads: { ref: string; bindings: { type: string; name: string; [k: string]: unknown }[] }[] = [];
  /** Every attach the fake patcher received. */
  const patches: { script: string; ensure: ScriptBindingSpec[] }[] = [];
  /** The provision callbacks the fake vertical received. */
  const provisioned: { tenantId: string; tenantStores?: { binding: string; kind: string; ref: string }[] }[] = [];
  /** The reconcile callbacks the fake vertical received (#825's backfill rides these). */
  const reconciled: { tenantId: string; tenantStores?: { binding: string; kind: string; ref: string }[] }[] = [];

  const fakeVertical = {
    provisionInstance: async (input: (typeof provisioned)[number]) => {
      provisioned.push(input);
      return { tenantId: input.tenantId };
    },
    reconcileInstance: async (input: (typeof reconciled)[number] & { scopeId?: string }) => {
      reconciled.push(input);
      return { tenantId: input.tenantId, scopeId: input.scopeId, owner: '01JZ00000000000000000000OW' };
    },
    listScopeTables: async () => [{ name: '_substrat_roles', rowCount: 4, system: true }],
  } as unknown as VerticalClient;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'cp-tstore-'));
    host = new SqliteScopeHost({ dir });
    app = createControlPlaneApi({
      host,
      authenticate: UNSAFE_devPlatformActorAuth(),
      deployVertical: async (ref, bundle) => {
        uploads.push({ ref, bindings: bundle.bindings as never });
      },
      fetchVerticalModules: async () => [
        { name: 'worker.js', content: new Uint8Array([1]), contentType: 'application/javascript+module' },
      ],
      resolveVertical: async () => fakeVertical,
      patchScriptBindings: async (script, ensure) => {
        patches.push({ script, ensure });
      },
    });
  });
  afterAll(async () => {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const manifest = (over: Record<string, unknown> = {}) => ({
    version: '0.1.0',
    entry: 'worker.js',
    compatibilityDate: '2025-01-01',
    doClasses: ['ScopeDO'],
    bindings: [{ type: 'durable_object_namespace', name: 'SCOPE', class_name: 'ScopeDO' }],
    tenantStores: [{ binding: 'AUTH_DB', kind: 'relational' }],
    digests: { manifest: 'm1', permission: 'p1', migration: 'g1' },
    registry: { permissions: [], roles: [], entityGrants: [] },
    ...over,
  });
  const push = (pin: string, m: Record<string, unknown>) => {
    const fd = new FormData();
    fd.set('manifest', JSON.stringify(m));
    fd.set('tenant', pin);
    fd.set('worker.js', new Blob(['export default {}'], { type: 'application/javascript+module' }), 'worker.js');
    return app.request('/verticals/authy/deploy', { method: 'POST', headers: auth, body: fd });
  };
  const promote = (slug: string, versionId: string) =>
    app.request(`/verticals/${encodeURIComponent(slug)}/channels/prod/promote`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ versionId }),
    });

  it('mints the declared store at provision, hands the handle over, and attaches the binding', async () => {
    // A pushed vertical whose manifest declares one per-tenant store, served in place.
    const t = tenantId.parse(ulid());
    await host.admin.createTenant(staff, { id: t, slug: 'store-co', name: 'Store Co' });
    const v1 = await (await push('store-co', manifest())).json();
    const slug: string = v1.verticalSlug;
    expect((await promote(slug, v1.id)).status).toBe(200);

    const res = await app.request(`/verticals/${encodeURIComponent(slug)}/instances`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ tenantId: t, scopeId: scopeId.parse(ulid()), owner: '01JZ00000000000000000000OW', slug: 'main', name: 'Main' }),
    });
    expect(res.status).toBe(201);

    // The ledger holds the platform-minted store…
    const ledger = await host.admin.listTenantStores(staff, { tenantId: t, vertical: slug });
    expect(ledger).toHaveLength(1);
    expect(ledger[0]!.binding).toBe('AUTH_DB');
    // …the K-31 callback carried its handle…
    const cb = provisioned.at(-1)!;
    expect(cb.tenantStores).toEqual([{ binding: 'AUTH_DB', kind: 'relational', ref: ledger[0]!.ref }]);
    // …and the serving script was patched with the worker-side binding, ledger-derived.
    const patch = patches.at(-1)!;
    expect(patch.script).toBe(stableDeploymentRefFor(slug));
    expect(patch.ensure).toEqual([{ type: 'd1', name: tenantStoreBindingName('AUTH_DB', t), id: ledger[0]!.ref }]);

    // Idempotent: a re-provision re-resolves the SAME handle and mints nothing new.
    const again = await app.request(`/verticals/${encodeURIComponent(slug)}/instances`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ tenantId: t, scopeId: scopeId.parse(ulid()), owner: '01JZ00000000000000000000OW', slug: 'second', name: 'Second' }),
    });
    expect(again.status).toBe(201);
    expect(await host.admin.listTenantStores(staff, { tenantId: t, vertical: slug })).toHaveLength(1);
    expect(provisioned.at(-1)!.tenantStores).toEqual(cb.tenantStores);

    // A later in-place serve re-derives the store bindings from the ledger, so a
    // re-deploy cannot drop them: the serving upload carries the d1 binding alongside
    // the bundle's own.
    const v2 = await (await push('store-co', manifest({ version: '0.2.0' }))).json();
    expect((await promote(slug, v2.id)).status).toBe(200);
    const serving = uploads.filter((u) => u.ref === stableDeploymentRefFor(slug)).at(-1)!;
    expect(serving.bindings).toContainEqual({
      type: 'd1',
      name: tenantStoreBindingName('AUTH_DB', t),
      id: ledger[0]!.ref,
    });
    expect(serving.bindings).toContainEqual({ type: 'durable_object_namespace', name: 'SCOPE', class_name: 'ScopeDO' });
  });

  it('leaves verticals that declare no stores untouched — no mint, no patch, no payload field', async () => {
    const before = patches.length;
    const t = tenantId.parse(ulid());
    await host.admin.createTenant(staff, { id: t, slug: 'plain-co', name: 'Plain Co' });
    const v1 = await (await push('plain-co', manifest({ tenantStores: [] }))).json();
    const slug: string = v1.verticalSlug;
    expect((await promote(slug, v1.id)).status).toBe(200);

    const res = await app.request(`/verticals/${encodeURIComponent(slug)}/instances`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ tenantId: t, scopeId: scopeId.parse(ulid()), owner: '01JZ00000000000000000000OW', slug: 'main', name: 'Main' }),
    });
    expect(res.status).toBe(201);
    expect(await host.admin.listTenantStores(staff, { tenantId: t })).toHaveLength(0);
    expect(provisioned.at(-1)!.tenantStores).toBeUndefined();
    expect(patches.length).toBe(before);
  });

  it('mints a declared BLOB store at provision, attaches its r2_bucket binding, and re-derives it on serve (#473)', async () => {
    const t = tenantId.parse(ulid());
    await host.admin.createTenant(staff, { id: t, slug: 'blob-co', name: 'Blob Co' });
    // A vertical declaring a per-tenant blob store instead of a relational one.
    const v1 = await (
      await push('blob-co', manifest({ tenantStores: [], blobStores: [{ binding: 'ATTACHMENTS', kind: 'blob' }] }))
    ).json();
    const slug: string = v1.verticalSlug;
    expect((await promote(slug, v1.id)).status).toBe(200);

    const res = await app.request(`/verticals/${encodeURIComponent(slug)}/instances`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ tenantId: t, scopeId: scopeId.parse(ulid()), owner: '01JZ00000000000000000000OW', slug: 'main', name: 'Main' }),
    });
    expect(res.status).toBe(201);

    // The blob-store ledger holds the platform-minted bucket…
    const ledger = await host.admin.listBlobStores(staff, { tenantId: t, vertical: slug });
    expect(ledger).toHaveLength(1);
    expect(ledger[0]!.binding).toBe('ATTACHMENTS');
    expect(ledger[0]!.kind).toBe('blob');
    // …the serving script was patched with the worker-side r2_bucket binding, ledger-derived.
    expect(patches.at(-1)!.ensure).toContainEqual({
      type: 'r2_bucket',
      name: blobStoreBindingName('ATTACHMENTS', t),
      bucketName: ledger[0]!.ref,
    });

    // A later in-place serve re-derives the r2_bucket binding from the ledger — a re-deploy
    // cannot drop a tenant's attachment bucket.
    const v2 = await (
      await push('blob-co', manifest({ version: '0.2.0', tenantStores: [], blobStores: [{ binding: 'ATTACHMENTS', kind: 'blob' }] }))
    ).json();
    expect((await promote(slug, v2.id)).status).toBe(200);
    const serving = uploads.filter((u) => u.ref === stableDeploymentRefFor(slug)).at(-1)!;
    expect(serving.bindings).toContainEqual({
      type: 'r2_bucket',
      name: blobStoreBindingName('ATTACHMENTS', t),
      bucket_name: ledger[0]!.ref,
    });
  });

  /**
   * #825, the per-scope retry. Promote reconciles the fleet from the DIRECTORY's inventory,
   * so a tenant it could not see — a row written after the sweep, or a mint that failed
   * against the store API — is still left without the store it was declared. That tenant
   * used to have no lever at all and no signal either: the vertical simply threw at first
   * use, in production. Health must name it, and the repair an operator already reaches for
   * must close it.
   */
  it('reports a store the promote sweep missed, and mints it on re-provision (#825)', async () => {
    const t = tenantId.parse(ulid());
    const s = scopeId.parse(ulid());
    await host.admin.createTenant(staff, { id: t, slug: 'late-co', name: 'Late Co' });
    // Installed while the vertical declared NO per-tenant stores.
    const v1 = await (await push('late-co', manifest({ tenantStores: [] }))).json();
    const slug: string = v1.verticalSlug;
    expect((await promote(slug, v1.id)).status).toBe(200);
    const install = await app.request(`/verticals/${encodeURIComponent(slug)}/instances`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ tenantId: t, scopeId: s, owner: '01JZ00000000000000000000OW', slug: 'main', name: 'Main' }),
    });
    expect(install.status).toBe(201);

    // The version that first declares the stores is promoted while this install is still
    // invisible to the directory (K-31 is two-phase: the vertical first, the row after) —
    // so the fleet sweep cannot mint for it.
    const v2 = await (
      await push(
        'late-co',
        manifest({
          version: '0.2.0',
          tenantStores: [{ binding: 'AUTH_DB', kind: 'relational' }],
          blobStores: [{ binding: 'ATTACHMENTS', kind: 'blob' }],
        }),
      )
    ).json();
    const promoted = await promote(slug, v2.id);
    expect(promoted.status).toBe(200);
    expect((await promoted.json()).storeBackfill).toBeUndefined();

    // The row lands, and the scope is now a tenant with no stores against a version that
    // declares two.
    await host.provisionScope(staff, { tenantId: t, scopeId: s, vertical: slug } as never);
    await host.admin.activateScope(staff, t, s);
    expect(await host.admin.listBlobStores(staff, { tenantId: t })).toHaveLength(0);

    // Health names both declared-but-unminted stores — before this, it reported green while
    // the first upload was guaranteed to throw.
    const before = await (await app.request(`/tenants/${t}/scopes/${s}/health`, { headers: auth })).json();
    expect(before.roleProjectionEmpty).toBe(false);
    expect(before.missingStores).toEqual([
      { binding: 'AUTH_DB', kind: 'relational' },
      { binding: 'ATTACHMENTS', kind: 'blob' },
    ]);

    // The repair lever an operator already reaches for mints and binds them.
    const repair = await app.request(`/tenants/${t}/scopes/${s}/provision`, { method: 'POST', headers: auth });
    expect(repair.status).toBe(200);
    const relational = await host.admin.listTenantStores(staff, { tenantId: t, vertical: slug });
    const blobs = await host.admin.listBlobStores(staff, { tenantId: t, vertical: slug });
    expect(relational.map((r) => r.binding)).toEqual(['AUTH_DB']);
    expect(blobs.map((r) => r.binding)).toEqual(['ATTACHMENTS']);
    // A store minted HERE has never been migrated, so its handle rides the reconcile into
    // the vertical's ready-gate exactly as it would at provision.
    expect(reconciled.at(-1)!.tenantStores).toEqual([
      { binding: 'AUTH_DB', kind: 'relational', ref: relational[0]!.ref },
    ]);
    // …and both worker-side bindings landed on the serving script.
    const ensured = patches.filter((p) => p.script === stableDeploymentRefFor(slug)).flatMap((p) => p.ensure);
    expect(ensured).toContainEqual({ type: 'd1', name: tenantStoreBindingName('AUTH_DB', t), id: relational[0]!.ref });
    expect(ensured).toContainEqual({
      type: 'r2_bucket',
      name: blobStoreBindingName('ATTACHMENTS', t),
      bucketName: blobs[0]!.ref,
    });

    // Health is clean afterwards, and re-running the repair converges rather than duplicating.
    const after = await (await app.request(`/tenants/${t}/scopes/${s}/health`, { headers: auth })).json();
    expect(after.missingStores).toEqual([]);
    expect((await app.request(`/tenants/${t}/scopes/${s}/provision`, { method: 'POST', headers: auth })).status).toBe(200);
    expect(await host.admin.listBlobStores(staff, { tenantId: t, vertical: slug })).toHaveLength(1);
    expect(await host.admin.listTenantStores(staff, { tenantId: t, vertical: slug })).toHaveLength(1);
  });

  /**
   * #825, the deploy-time half: promoting the version that FIRST declares a store mints it
   * for every tenant already installed. Without this the declaration reaches nobody and
   * adoption is an ops step someone has to remember per tenant — which is exactly how a
   * store stayed unminted for three weeks and became a production outage.
   */
  it('mints a newly declared store for every already-installed tenant on promote (#825)', async () => {
    const a = tenantId.parse(ulid());
    const b = tenantId.parse(ulid());
    await host.admin.createTenant(staff, { id: a, slug: 'fleet-a', name: 'Fleet A' });
    await host.admin.createTenant(staff, { id: b, slug: 'fleet-b', name: 'Fleet B' });
    // The vertical ships declaring nothing, and both tenants install it.
    const v1 = await (await push('fleet-a', manifest({ tenantStores: [] }))).json();
    const slug: string = v1.verticalSlug;
    expect((await promote(slug, v1.id)).status).toBe(200);
    for (const t of [a, b]) {
      const s = scopeId.parse(ulid());
      const res = await app.request(`/verticals/${encodeURIComponent(slug)}/instances`, {
        method: 'POST',
        headers: { ...auth, 'content-type': 'application/json' },
        body: JSON.stringify({ tenantId: t, scopeId: s, owner: '01JZ00000000000000000000OW', slug: 'main', name: 'Main' }),
      });
      expect(res.status).toBe(201);
      await host.provisionScope(staff, { tenantId: t, scopeId: s, vertical: slug } as never);
      await host.admin.activateScope(staff, t, s);
    }
    expect(await host.admin.listBlobStores(staff, { vertical: slug })).toHaveLength(0);

    // Now a version declares an attachment bucket, and is promoted.
    const v2 = await (
      await push('fleet-a', manifest({ version: '0.2.0', tenantStores: [], blobStores: [{ binding: 'ATTACHMENTS', kind: 'blob' }] }))
    ).json();
    const promoted = await promote(slug, v2.id);
    expect(promoted.status).toBe(200);

    // Both installed tenants were minted a bucket by the promote itself — no per-tenant
    // ops step — and the promote REPORTS it, so the builder sees the adoption happen.
    const ledger = await host.admin.listBlobStores(staff, { vertical: slug });
    expect(ledger.map((r) => r.tenantId).sort()).toEqual([a, b].sort());
    const body = await promoted.json();
    expect(body.storeBackfill.minted.map((m: { tenantId: string }) => m.tenantId).sort()).toEqual([a, b].sort());
    expect(body.storeBackfill.minted[0]).toMatchObject({ binding: 'ATTACHMENTS', kind: 'blob' });
    // One ledger-derived PATCH carries BOTH tenants' bindings — not one attach per tenant.
    const patch = patches.at(-1)!;
    expect(patch.script).toBe(stableDeploymentRefFor(slug));
    for (const t of [a, b]) {
      expect(patch.ensure).toContainEqual({
        type: 'r2_bucket',
        name: blobStoreBindingName('ATTACHMENTS', t),
        bucketName: ledger.find((r) => r.tenantId === t)!.ref,
      });
    }

    // Health on those scopes is green, with nothing left for an operator to do…
    const scopes = await host.admin.listScopes(staff, { vertical: slug });
    const health = await (
      await app.request(`/tenants/${scopes[0]!.tenantId}/scopes/${scopes[0]!.id}/health`, { headers: auth })
    ).json();
    expect(health.missingStores).toEqual([]);

    // …and re-promoting the same version mints nothing and says nothing: the fleet already
    // matches the declaration, so the backfill is silent rather than noisy.
    const again = await promote(slug, v2.id);
    expect(again.status).toBe(200);
    expect((await again.json()).storeBackfill).toBeUndefined();
    expect(await host.admin.listBlobStores(staff, { vertical: slug })).toHaveLength(2);
  });

  /**
   * #828. The repair lever is the one path that must not be fragile: it is what an
   * operator reaches for when something is already wrong, and #826 made it mint before
   * reconciling — so a mint that failed for reasons unrelated to this scope (a credential
   * without the permission, a store client the deployment never configured, the store API
   * refusing) took the whole call down. The caller lost the owner re-grant and role
   * re-projection they came for, and got `500 internal error` with no way to tell a
   * missing credential from a bad scope id.
   *
   * Drives the exact production fault: the host refuses `provisionBlobStore` because it
   * has no R2 client, which is what shipped to prod for #473's whole life.
   */
  it('reconciles anyway when a store cannot be minted, and says what failed (#828)', async () => {
    const t = tenantId.parse(ulid());
    const s = scopeId.parse(ulid());
    await host.admin.createTenant(staff, { id: t, slug: 'unwired-co', name: 'Unwired Co' });
    const v1 = await (
      await push(
        'unwired-co',
        manifest({
          tenantStores: [{ binding: 'AUTH_DB', kind: 'relational' }],
          blobStores: [{ binding: 'ATTACHMENTS', kind: 'blob' }],
        }),
      )
    ).json();
    const slug: string = v1.verticalSlug;
    expect((await promote(slug, v1.id)).status).toBe(200);
    await host.provisionScope(staff, { tenantId: t, scopeId: s, vertical: slug } as never);
    await host.admin.activateScope(staff, t, s);

    // The blob half cannot mint — the shape a host with no R2 client throws.
    const refusal = substratError(
      'unavailable',
      'per-tenant blob stores are not configured on this host (#473): pass ' +
        "CloudflareScopeHostOptions.blobStores (createR2BlobStores with the platform's " +
        'Cloudflare credential) — refused provisionBlobStore(...)',
    );
    const spy = vi.spyOn(host, 'provisionBlobStore').mockRejectedValue(refusal);

    const repair = await app.request(`/tenants/${t}/scopes/${s}/provision`, { method: 'POST', headers: auth });
    // 200, not 500: the half that could run, ran.
    expect(repair.status).toBe(200);
    const body = await repair.json();
    expect(body.owner).toBe('01JZ00000000000000000000OW');
    // …and the diagnosis is the platform's own message, naming what to configure — the
    // thing `internal error` threw away.
    expect(body.storeError).toMatch(/blob stores are not configured on this host/);

    // The RELATIONAL store still minted: one substrate failing must not skip the other,
    // or a scope declaring both needs a second run to discover the second fault.
    expect(reconciled.at(-1)!.tenantStores).toEqual([
      { binding: 'AUTH_DB', kind: 'relational', ref: (await host.admin.listTenantStores(staff, { tenantId: t }))[0]!.ref },
    ]);

    // The failure is durable, not just a response field: an operator who was not at the
    // terminal finds it in the ops-failure list, stage-tagged.
    const failures = await host.admin.listOpsFailures(staff, { tenantId: t });
    expect(failures.map((f) => f.operation)).toContain('scope.provision.stores');
    expect(failures.find((f) => f.operation === 'scope.provision.stores')!.stage).toBe('blob-stores');

    // And health still reports the gap — the repair reported honestly rather than
    // reporting success on a scope that will throw at first upload.
    const health = await (await app.request(`/tenants/${t}/scopes/${s}/health`, { headers: auth })).json();
    expect(health.missingStores).toEqual([{ binding: 'ATTACHMENTS', kind: 'blob' }]);

    // Once the host is wired, the same command converges and stops complaining.
    spy.mockRestore();
    const again = await app.request(`/tenants/${t}/scopes/${s}/provision`, { method: 'POST', headers: auth });
    expect(again.status).toBe(200);
    expect((await again.json()).storeError).toBeUndefined();
    expect(await host.admin.listBlobStores(staff, { tenantId: t, vertical: slug })).toHaveLength(1);
  });

  /**
   * The deliberate other half of #828: a NEW install keeps the fail-loud posture. Its store
   * is handed into the K-31 ready-gate, so an install that proceeds without one is simply
   * broken — better to refuse than to hand back a half-built scope that reports success.
   * What changes is only the ANSWER: 503 naming the deployment fact, not a bare 500.
   */
  it('still fails a new install when its store cannot be minted — with a diagnosis (#828)', async () => {
    const t = tenantId.parse(ulid());
    await host.admin.createTenant(staff, { id: t, slug: 'newinstall-co', name: 'New Install Co' });
    const v1 = await (
      await push('newinstall-co', manifest({ tenantStores: [], blobStores: [{ binding: 'ATTACHMENTS', kind: 'blob' }] }))
    ).json();
    const slug: string = v1.verticalSlug;
    expect((await promote(slug, v1.id)).status).toBe(200);

    const spy = vi
      .spyOn(host, 'provisionBlobStore')
      .mockRejectedValue(substratError('unavailable', 'per-tenant blob stores are not configured on this host (#473)'));
    const res = await app.request(`/verticals/${encodeURIComponent(slug)}/instances`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ tenantId: t, scopeId: scopeId.parse(ulid()), owner: '01JZ00000000000000000000OW', slug: 'main', name: 'Main' }),
    });
    // 503 — a deployment fact, not a fault in this payload — carrying the message that
    // names what to configure. Before #828 this was `500 {"error":"internal error"}`.
    expect(res.status).toBe(503);
    expect((await res.json()).error).toMatch(/not configured on this host/);
    spy.mockRestore();
  });
});

/**
 * The WfP settings patcher (#301): read → merge → PATCH, additive-only, never
 * round-tripping secrets. Driven against a stubbed global fetch, like the uploader tests.
 */
describe('createWfpBindingsPatcher', () => {
  afterEach(() => vi.unstubAllGlobals());

  const patcher = () =>
    createWfpBindingsPatcher({ accountId: 'acct', namespace: 'ns', apiToken: 'tok' });

  const settingsUrl =
    'https://api.cloudflare.com/client/v4/accounts/acct/workers/dispatch/namespaces/ns/scripts/authy/settings';

  it('adds only the missing bindings, carrying non-secret bindings and keeping secrets via keep_bindings', async () => {
    const sent: { method: string; settings?: Record<string, unknown> }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: { method?: string; body?: FormData }) => {
        expect(url).toBe(settingsUrl);
        if (!init?.method || init.method === 'GET') {
          sent.push({ method: 'GET' });
          return new Response(
            JSON.stringify({
              result: {
                bindings: [
                  { type: 'durable_object_namespace', name: 'SCOPE', class_name: 'ScopeDO' },
                  { type: 'secret_text', name: 'PLATFORM_SECRET' },
                  { type: 'd1', name: 'AUTH_DB__01OLD', id: 'db-old' },
                ],
              },
            }),
            { status: 200 },
          );
        }
        const settings = JSON.parse(await (init.body!.get('settings') as File).text()) as Record<string, unknown>;
        sent.push({ method: init.method!, settings });
        return new Response('{}', { status: 200 });
      }),
    );

    await patcher()('authy', [
      { type: 'd1', name: 'AUTH_DB__01OLD', id: 'db-old' }, // already present — must not resend needlessly
      { type: 'd1', name: 'AUTH_DB__01NEW', id: 'db-new' },
    ]);

    const patch = sent.find((s) => s.method === 'PATCH')!;
    const bindings = patch.settings!['bindings'] as { type: string; name: string }[];
    // The new binding landed; the DO binding and the existing d1 rode along; the secret
    // did NOT (a valueless resend would wipe it) — it rides keep_bindings instead.
    expect(bindings).toContainEqual({ type: 'd1', name: 'AUTH_DB__01NEW', id: 'db-new' });
    expect(bindings).toContainEqual({ type: 'd1', name: 'AUTH_DB__01OLD', id: 'db-old' });
    expect(bindings).toContainEqual({ type: 'durable_object_namespace', name: 'SCOPE', class_name: 'ScopeDO' });
    expect(bindings.some((b) => b.type === 'secret_text')).toBe(false);
    expect(patch.settings!['keep_bindings']).toEqual(['secret_text', 'secret_key']);
  });

  it('no-ops without a PATCH when every wanted binding is already attached', async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: { method?: string }) => {
        calls.push(init?.method ?? 'GET');
        return new Response(
          JSON.stringify({ result: { bindings: [{ type: 'd1', name: 'AUTH_DB__01T', id: 'db-1' }] } }),
          { status: 200 },
        );
      }),
    );
    await patcher()('authy', [{ type: 'd1', name: 'AUTH_DB__01T', id: 'db-1' }]);
    expect(calls).toEqual(['GET']);
  });

  it('makes no request at all for an empty ensure set', async () => {
    const spy = vi.fn();
    vi.stubGlobal('fetch', spy);
    await patcher()('authy', []);
    expect(spy).not.toHaveBeenCalled();
  });

  it('surfaces an upstream refusal with the script named', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 403 })));
    await expect(patcher()('authy', [{ type: 'd1', name: 'A__T', id: 'db' }])).rejects.toThrow(
      /settings read failed \(403\) for 'authy'/,
    );
  });
});
