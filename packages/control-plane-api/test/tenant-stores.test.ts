import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { ulid } from '@substrat-run/kernel';
import { platformActorId, tenantId, scopeId, tenantStoreBindingName } from '@substrat-run/contracts';
import {
  createControlPlaneApi,
  createWfpBindingsPatcher,
  DEV_ACTOR_HEADER,
  UNSAFE_devPlatformActorAuth,
  VerticalClient,
  stableDeploymentRefFor,
  type D1BindingSpec,
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
  const uploads: { ref: string; bindings: { type: string; name: string; id?: string }[] }[] = [];
  /** Every attach the fake patcher received. */
  const patches: { script: string; ensure: D1BindingSpec[] }[] = [];
  /** The provision callbacks the fake vertical received. */
  const provisioned: { tenantId: string; tenantStores?: { binding: string; kind: string; ref: string }[] }[] = [];

  const fakeVertical = {
    provisionInstance: async (input: (typeof provisioned)[number]) => {
      provisioned.push(input);
      return { tenantId: input.tenantId };
    },
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
    expect(patch.ensure).toEqual([{ name: tenantStoreBindingName('AUTH_DB', t), id: ledger[0]!.ref }]);

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
      { name: 'AUTH_DB__01OLD', id: 'db-old' }, // already present — must not resend needlessly
      { name: 'AUTH_DB__01NEW', id: 'db-new' },
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
    await patcher()('authy', [{ name: 'AUTH_DB__01T', id: 'db-1' }]);
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
    await expect(patcher()('authy', [{ name: 'A__T', id: 'db' }])).rejects.toThrow(
      /settings read failed \(403\) for 'authy'/,
    );
  });
});
