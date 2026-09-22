import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { ulid } from '@substrat-run/kernel';
import {
  PREVIEW_CLIENT_PATH,
  SHARED_ISSUER_CONFIG_KEY,
  oidcCallbackUrl,
  platformActorId,
  previewClientCheck,
  previewClientMint,
  previewClientRetire,
  scopeId,
  tenantId,
  type PreviewAuth,
  type ScopeDumpTable,
  type ScopeId,
  type TenantId,
} from '@substrat-run/contracts';
import { createControlPlaneApi, DEV_ACTOR_HEADER, UNSAFE_devPlatformActorAuth, VerticalClient } from '../src/index.js';

/**
 * A preview's own login, over HTTP (#1704).
 *
 * Every property the issue and its decisions name, each with the twin that would pass if it
 * were broken:
 *
 *   - a preview of an app that signs in at a team auth-server gets a `substrat:auth` naming
 *     ITS OWN client, delivered into the PR version's own config store;
 *   - prod's client is never read, written or taught the preview's callback;
 *   - the reap deletes the preview's client, and a failed or partial create leaks none;
 *   - nothing is minted on a callback match alone, at another tenant's issuer, at a fork of an
 *     issuer, or where two issuers claim the app;
 *   - an issuer that predates the routes reads as "redeploy", never as "external";
 *   - an external issuer's preview says what to register, and that no login was delivered;
 *   - concurrent pushes: an older push never deletes a newer push's client, a push whose
 *     version was re-bound never retires, and a vanished client is retried, not reported;
 *   - the secret appears in no output, admin-log row or ops-failure row;
 *   - only whoever may create the preview triggers any of it.
 *
 * The issuer is a faithful fake of `demos/auth-server`'s three routes, speaking through the
 * REAL `VerticalClient` (so the skew handling under test is the shipped one) and parsing every
 * request with the contract's own schemas. The issuer's real implementation is proven against
 * the same schemas in its own package, on node and on workerd.
 */

const staff = platformActorId.parse(ulid());
const asStaff = { [DEV_ACTOR_HEADER]: staff, 'content-type': 'application/json' };
const BUILDER_HEADER = 'x-test-builder';

const APP = 'acme/desk';
const PARENT_HOST = 'desk-acme.global.substrat.run';
const PREVIEW_HOST = (tag: string) => `desk-acme--${tag}.global.substrat.run`;

// ── the fake issuer deployment: one per auth-server vertical, every install one instance ──

interface FakeClient {
  redirectUris: string[];
  postLogout: string[];
  /** Stored as the real issuer stores it — never the secret itself. */
  secretHash: string;
  disabled: boolean;
  preview?: string;
  generation?: number;
}

interface FakeInstance {
  tenantId: string;
  /** Apps the PLATFORM bound here (#1619 / #1670). */
  bindings: Set<string>;
  clients: Map<string, FakeClient>;
}

class FakeIssuers {
  readonly instances = new Map<string, FakeInstance>();
  readonly calls: Array<{ method: string; path: string; body: Record<string, unknown> }> = [];
  /** Answer every preview-client path as a deployment built before them would. */
  predates = false;
  /** Fail the next call to `path` with this status. */
  failNext = new Map<string, number>();
  /** Awaited just after a mint lands, before it answers — to interleave pushes. */
  afterMint: ((clientId: string, body: Record<string, unknown>) => Promise<void>) | null = null;
  /** Awaited just before a retire runs. */
  beforeRetire: ((body: Record<string, unknown>) => Promise<void>) | null = null;
  private gen = 0;
  private n = 0;

  install(scope: string, tenant: string, opts: { bind?: string[]; clients?: Record<string, string[]> } = {}): void {
    const clients = new Map<string, FakeClient>();
    for (const [id, uris] of Object.entries(opts.clients ?? {})) {
      clients.set(id, { redirectUris: uris, postLogout: [], secretHash: `hash-${id}`, disabled: false });
    }
    this.instances.set(scope, { tenantId: tenant, bindings: new Set(opts.bind ?? []), clients });
  }

  tagged(scope: string, preview: string): string[] {
    return [...(this.instances.get(scope)?.clients ?? new Map<string, FakeClient>())]
      .filter(([, c]) => c.preview === preview)
      .map(([id]) => id);
  }

  readonly fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const body = (init?.body ? JSON.parse(String(init.body)) : {}) as Record<string, unknown>;
    this.calls.push({ method, path: url.pathname, body });
    const json = (status: number, value: unknown) =>
      new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
    if (!url.pathname.startsWith(PREVIEW_CLIENT_PATH) || this.predates) {
      return json(501, { error: `auth-server does not implement ${method} ${url.pathname}` });
    }
    const fail = this.failNext.get(`${method} ${url.pathname}`);
    if (fail) {
      this.failNext.delete(`${method} ${url.pathname}`);
      return json(fail, { error: `injected ${fail}` });
    }
    const inst = this.instances.get(String(body.scopeId));
    if (!inst || inst.tenantId !== body.tenantId) return json(403, { error: 'not an issuer of that tenant' });
    const claims = (b: { parentScopeId: string; parentRedirectUris: string[] }) =>
      inst.bindings.has(b.parentScopeId) &&
      [...inst.clients.values()].some((c) => !c.disabled && c.redirectUris.some((u) => b.parentRedirectUris.includes(u)));

    if (url.pathname === `${PREVIEW_CLIENT_PATH}/check`) {
      return json(200, { claimed: claims(previewClientCheck.parse(body)) });
    }
    if (method === 'POST') {
      const b = previewClientMint.parse(body);
      if (!claims(b)) return json(409, { error: 'does not sign in that scope' });
      if (b.parentRedirectUris.includes(b.redirectUri) || b.parentRedirectUris.includes(b.postLogoutRedirectUri)) {
        return json(400, { error: 'never the parent' });
      }
      const clientId = `preview-client-${++this.n}`;
      const clientSecret = `SECRET-${ulid()}`;
      const generation = ++this.gen;
      inst.clients.set(clientId, {
        redirectUris: [b.redirectUri],
        postLogout: [b.postLogoutRedirectUri],
        secretHash: `hash-of-${clientSecret.length}`,
        disabled: false,
        preview: b.previewScopeId,
        generation,
      });
      if (this.afterMint) await this.afterMint(clientId, body);
      return json(201, { clientId, clientSecret, generation });
    }
    const b = previewClientRetire.parse(body);
    if (this.beforeRetire) await this.beforeRetire(body);
    const rows = [...inst.clients].filter(([, c]) => c.preview === b.previewScopeId).map(([id, c]) => ({ id, g: c.generation! }));
    let targets = rows;
    let kept: boolean | null = null;
    let superseded = false;
    if (b.only) targets = rows.filter((r) => r.id === b.only);
    else if (b.keep) {
      const k = rows.find((r) => r.id === b.keep);
      kept = k !== undefined;
      targets = k ? rows.filter((r) => r.g < k.g) : [];
      superseded = k ? rows.some((r) => r.g > k.g) : false;
    }
    for (const t of targets) inst.clients.delete(t.id);
    return json(200, { deleted: targets.map((t) => t.id), kept, superseded });
  }) as typeof fetch;
}

// ── the vertical being previewed: one deployment (and so one config store) per version ──

class AppDeployments {
  /** version → scope → delivered config. */
  readonly stores = new Map<string, Map<string, Record<string, string>>>();
  readonly deliveries: Array<{ version: string; scopeId: string; keys: string[] }> = [];
  /** Throw from the next delivery into `version`. */
  failDelivery = new Set<string>();
  /** Awaited inside a delivery, after it landed. */
  duringDelivery: ((version: string) => Promise<void>) | null = null;
  readonly clients = new Map<string, VerticalClient>();

  client(version: string): VerticalClient {
    const existing = this.clients.get(version);
    if (existing) return existing;
    const c = {
      exportScope: async (): Promise<ScopeDumpTable[]> => [
        { name: 't', ddl: 'CREATE TABLE t(id TEXT)', columns: ['id'], rows: [['a']] },
      ],
      restoreScope: async (_t: string, _s: string, tables: ScopeDumpTable[]) => ({ tables: tables.length }),
      deleteScope: async () => {},
      configureInstance: async (input: { scopeId: string; entries: Array<{ key: string; value: string }> }) => {
        if (this.failDelivery.delete(version)) throw new Error('vertical refused configure: 400');
        const store = this.stores.get(version) ?? new Map<string, Record<string, string>>();
        this.stores.set(version, store);
        const cfg = store.get(input.scopeId) ?? {};
        for (const e of input.entries) cfg[e.key] = e.value;
        store.set(input.scopeId, cfg);
        this.deliveries.push({ version, scopeId: input.scopeId, keys: input.entries.map((e) => e.key) });
        if (this.duringDelivery) await this.duringDelivery(version);
      },
    } as unknown as VerticalClient;
    this.clients.set(version, c);
    return c;
  }

  auth(version: string, scope: string): { mode: string; issuer: string; clientId: string; clientSecret: string } | undefined {
    const raw = this.stores.get(version)?.get(scope)?.['substrat:auth'];
    return raw ? JSON.parse(raw) : undefined;
  }
}

/** A gate one side of an interleaving waits on and the other opens. */
function gate(): { wait: Promise<void>; open: () => void } {
  let open!: () => void;
  const wait = new Promise<void>((r) => (open = r));
  return { wait, open };
}

let dir: string;
let host: SqliteScopeHost;
let issuers: FakeIssuers;
let deployments: AppDeployments;
let app: ReturnType<typeof createControlPlaneApi>;
let tenant: TenantId;
let prod: ScopeId;
let issuerScope: ScopeId;
let versions: string[];
const PROD_CLIENT = 'prod-client';

async function world(): Promise<void> {
  tenant = tenantId.parse(ulid());
  await host.admin.createTenant(staff, { id: tenant, slug: 'acme', name: 'Acme' });
  await host.admin.registerVertical(staff, { slug: APP, name: 'Desk', source: 'cli', ownerTenant: tenant });
  versions = [];
  for (const v of ['1.0.0', '1.0.1', '1.0.2', '1.0.3']) {
    const id = ulid();
    await host.admin.publishVersion(staff, {
      id, verticalSlug: APP, version: v, manifestDigest: `m-${v}`, permissionDigest: 'p', migrationDigest: 'g', deploymentRef: null,
    });
    await host.admin.admitVersion(staff, id);
    versions.push(id);
  }
  prod = scopeId.parse(ulid());
  await host.provisionScope(staff, { tenantId: tenant, scopeId: prod, vertical: APP, name: 'Desk' });
  await host.admin.activateScope(staff, tenant, prod);
  await host.admin.bindScopeVersion(staff, tenant, prod, versions[0]!);
  await host.admin.bindHostname(staff, { hostname: PARENT_HOST, tenantId: tenant, scopeId: prod, surface: 'app', region: null, canonical: true });

  // The team's auth server: an install of a vertical that provides `oidc-issuer`, holding
  // prod's client and the platform's binding for prod.
  if (!(await host.admin.listVerticals(staff)).some((v) => v.slug === 'auth-server')) {
    await host.admin.registerVertical(staff, { slug: 'auth-server', name: 'Auth Server', source: 'builtin', ownerTenant: null, provides: ['oidc-issuer'] });
  }
  issuerScope = await issuerInstall(tenant, 'auth-acme.global.substrat.run');
  issuers.install(issuerScope, tenant, { bind: [prod], clients: { [PROD_CLIENT]: [oidcCallbackUrl(PARENT_HOST)] } });
}

async function issuerInstall(t: TenantId, hostname: string): Promise<ScopeId> {
  const s = scopeId.parse(ulid());
  await host.provisionScope(staff, { tenantId: t, scopeId: s, vertical: 'auth-server' });
  await host.admin.activateScope(staff, t, s);
  await host.admin.bindHostname(staff, { hostname, tenantId: t, scopeId: s, surface: 'app', region: null, canonical: true });
  return s;
}

function api(extra: Partial<Parameters<typeof createControlPlaneApi>[0]> = {}) {
  return createControlPlaneApi({
    host,
    authenticate: UNSAFE_devPlatformActorAuth(),
    verticals: { 'auth-server': new VerticalClient({ fetch: issuers.fetch, platformSecret: 'test' }) },
    resolveVerticalVersion: async (slug, versionId) => (slug === APP ? deployments.client(versionId) : undefined),
    platformBaseDomains: ['global.substrat.run'],
    provisionRetryDelaysMs: [],
    ...extra,
  });
}

interface Created {
  scopeId: ScopeId;
  hostname: string;
  versionId: string;
  reused: boolean;
  auth: PreviewAuth;
  notes: string[];
}

const create = (body: Record<string, unknown>, headers: Record<string, string> = asStaff) =>
  app.request(`/verticals/${encodeURIComponent(APP)}/previews`, { method: 'POST', headers, body: JSON.stringify(body) });

async function created(body: Record<string, unknown>): Promise<Created & { text: string }> {
  const res = await create(body);
  const text = await res.text();
  expect(res.status, text).toBeLessThan(300);
  return { ...(JSON.parse(text) as Created), text };
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'cp-preview-auth-'));
  host = new SqliteScopeHost({ dir });
  issuers = new FakeIssuers();
  deployments = new AppDeployments();
  await world();
  app = api();
});

afterEach(async () => {
  await host.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('a preview of an app on a team auth server gets its own login (#1704)', () => {
  it('delivers a substrat:auth naming the preview’s OWN client into the PR version’s store — and prod’s client is untouched', async () => {
    const prodBefore = JSON.stringify(issuers.instances.get(issuerScope)!.clients.get(PROD_CLIENT));
    const out = await created({ tag: 'pr-7', versionId: versions[1] });

    expect(out.auth.status).toBe('wired');
    expect(out.auth.issuer).toBe('https://auth-acme.global.substrat.run');
    expect(out.auth.callbackUrl).toBe(oidcCallbackUrl(PREVIEW_HOST('pr-7')));
    const [minted] = issuers.tagged(issuerScope, out.scopeId);
    expect(out.auth.clientId).toBe(minted);
    expect(minted).not.toBe(PROD_CLIENT);

    const delivered = deployments.auth(versions[1]!, out.scopeId)!;
    expect(delivered).toMatchObject({ mode: 'oidc', issuer: 'https://auth-acme.global.substrat.run', clientId: minted });
    expect(delivered.clientSecret).toMatch(/^SECRET-/);
    expect(deployments.stores.get(versions[1]!)!.get(out.scopeId)![SHARED_ISSUER_CONFIG_KEY]).toBe('true');

    // Its URIs are the preview's and nothing else; prod's client row is exactly as it was.
    const c = issuers.instances.get(issuerScope)!.clients.get(minted!)!;
    expect(c.redirectUris).toEqual([oidcCallbackUrl(PREVIEW_HOST('pr-7'))]);
    expect(c.postLogout).toEqual([`https://${PREVIEW_HOST('pr-7')}/`]);
    expect(JSON.stringify(issuers.instances.get(issuerScope)!.clients.get(PROD_CLIENT))).toBe(prodBefore);
    // Nothing was delivered anywhere but the preview.
    expect(deployments.deliveries.every((d) => d.scopeId === out.scopeId)).toBe(true);
  });

  it('the secret reaches the preview’s store and nowhere else — not the output, the admin log, or an ops-failure row', async () => {
    const out = await created({ tag: 'pr-7', versionId: versions[1] });
    const secret = deployments.auth(versions[1]!, out.scopeId)!.clientSecret;
    expect(out.text).not.toContain(secret);
    expect(out.text).not.toContain('SECRET-');
    const log = JSON.stringify(await host.admin.auditLog(staff, { limit: 500 }));
    expect(log).not.toContain(secret);
    // A failing create records a row; it names no secret either.
    deployments.failDelivery.add(versions[2]!);
    const failed = await create({ tag: 'pr-7', versionId: versions[2] });
    expect(failed.status).toBe(502);
    const failures = JSON.stringify(await host.admin.listOpsFailures(staff, { limit: 50 }));
    expect(failures).toContain('NO working login');
    expect(failures).not.toContain('SECRET-');
    expect(JSON.stringify(await host.admin.auditLog(staff, { limit: 500 }))).not.toContain('SECRET-');
  });

  it('every push re-wires the login into ITS version’s empty store and removes the client before it', async () => {
    const first = await created({ tag: 'pr-7', versionId: versions[1] });
    const [a] = issuers.tagged(issuerScope, first.scopeId);
    const again = await created({ tag: 'pr-7', versionId: versions[2] });
    expect(again.reused).toBe(true);
    expect(again.scopeId).toBe(first.scopeId);
    const tagged = issuers.tagged(issuerScope, first.scopeId);
    expect(tagged).toHaveLength(1);
    expect(tagged[0]).not.toBe(a);
    expect(deployments.auth(versions[2]!, first.scopeId)!.clientId).toBe(tagged[0]);
    expect(again.auth.status).toBe('wired');
  });

  it('--refresh never leaks the old preview’s client and never leaves the fresh one without a login', async () => {
    const first = await created({ tag: 'pr-7', versionId: versions[1] });
    const fresh = await created({ tag: 'pr-7', versionId: versions[2], refresh: true });
    expect(fresh.scopeId).not.toBe(first.scopeId);
    expect(issuers.tagged(issuerScope, first.scopeId)).toEqual([]);
    expect(issuers.tagged(issuerScope, fresh.scopeId)).toHaveLength(1);
    expect(deployments.auth(versions[2]!, fresh.scopeId)!.clientId).toBe(issuers.tagged(issuerScope, fresh.scopeId)[0]);
  });

  it('the list names every preview’s callback', async () => {
    const out = await created({ tag: 'pr-7', versionId: versions[1] });
    const rows = (await (await app.request(`/verticals/${encodeURIComponent(APP)}/previews`, { headers: asStaff })).json()) as Array<{
      scopeId: string;
      callbackUrl: string | null;
    }>;
    expect(rows.find((r) => r.scopeId === out.scopeId)?.callbackUrl).toBe(oidcCallbackUrl(PREVIEW_HOST('pr-7')));
  });
});

describe('the reap deletes the preview’s client (#1704)', () => {
  it('DELETE removes the preview’s clients before the preview, and prod’s survives', async () => {
    const out = await created({ tag: 'pr-7', versionId: versions[1] });
    expect(issuers.tagged(issuerScope, out.scopeId)).toHaveLength(1);
    const del = await app.request(`/verticals/${encodeURIComponent(APP)}/previews/pr-7`, { method: 'DELETE', headers: asStaff });
    expect(del.status).toBe(200);
    expect(issuers.tagged(issuerScope, out.scopeId)).toEqual([]);
    expect(issuers.instances.get(issuerScope)!.clients.has(PROD_CLIENT)).toBe(true);
  });

  it('a reap whose client delete fails keeps the preview, so the retry still finds it', async () => {
    const out = await created({ tag: 'pr-7', versionId: versions[1] });
    issuers.failNext.set(`DELETE ${PREVIEW_CLIENT_PATH}`, 503);
    const failed = await app.request(`/verticals/${encodeURIComponent(APP)}/previews/pr-7`, { method: 'DELETE', headers: asStaff });
    expect(failed.ok).toBe(false);
    expect(await host.admin.getScopeRecord(staff, tenant, out.scopeId)).toBeDefined();
    const retried = await app.request(`/verticals/${encodeURIComponent(APP)}/previews/pr-7`, { method: 'DELETE', headers: asStaff });
    expect(retried.status).toBe(200);
    expect(issuers.tagged(issuerScope, out.scopeId)).toEqual([]);
    expect(await host.admin.getScopeRecord(staff, tenant, out.scopeId)).toBeUndefined();
  });
});

describe('a failed or partial create leaks no client (#1704)', () => {
  it('a delivery that fails deletes the client it minted and answers 502 — never success', async () => {
    deployments.failDelivery.add(versions[1]!);
    const res = await create({ tag: 'pr-7', versionId: versions[1] });
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: string }).error).toContain('NO working login');
    const preview = (await host.admin.listScopes(staff, { tenantId: tenant })).find((s) => s.kind === 'preview')!;
    expect(issuers.tagged(issuerScope, preview.id)).toEqual([]);
    // The retry CI makes heals it.
    const retried = await created({ tag: 'pr-7', versionId: versions[2] });
    expect(retried.auth.status).toBe('wired');
    expect(issuers.tagged(issuerScope, preview.id)).toHaveLength(1);
  });

  it('a mint the issuer refuses answers 502 with nothing minted and nothing delivered', async () => {
    issuers.failNext.set(`POST ${PREVIEW_CLIENT_PATH}`, 500);
    const res = await create({ tag: 'pr-7', versionId: versions[1] });
    expect(res.status).toBe(502);
    expect([...issuers.instances.get(issuerScope)!.clients.keys()]).toEqual([PROD_CLIENT]);
    expect(deployments.deliveries).toEqual([]);
  });
});

describe('nothing is minted where the platform cannot vouch for the issuer (#1704)', () => {
  it('an external issuer: says which callback to register and that no login was delivered — and mints nothing', async () => {
    issuers.instances.get(issuerScope)!.bindings.clear();
    const out = await created({ tag: 'pr-7', versionId: versions[1] });
    expect(out.auth.status).toBe('unregistered');
    expect(out.auth.callbackUrl).toBe(oidcCallbackUrl(PREVIEW_HOST('pr-7')));
    expect(out.auth.note).toContain(oidcCallbackUrl(PREVIEW_HOST('pr-7')));
    expect(out.auth.note).toContain('no login config');
    expect(out.notes.join(' ')).toContain('Env tab');
    expect([...issuers.instances.get(issuerScope)!.clients.keys()]).toEqual([PROD_CLIENT]);
    expect(deployments.auth(versions[1]!, out.scopeId)).toBeUndefined();
  });

  it('a callback match alone (anybody can DCR one) is no claim — the binding is the positive twin', async () => {
    issuers.instances.get(issuerScope)!.bindings.clear();
    expect((await created({ tag: 'pr-7', versionId: versions[1] })).auth.status).toBe('unregistered');
    issuers.instances.get(issuerScope)!.bindings.add(prod);
    expect((await created({ tag: 'pr-7', versionId: versions[2] })).auth.status).toBe('wired');
  });

  it('never asks another tenant’s issuer, even one that holds a matching binding and client', async () => {
    const other = tenantId.parse(ulid());
    await host.admin.createTenant(staff, { id: other, slug: 'other', name: 'Other' });
    const theirs = await issuerInstall(other, 'auth-other.global.substrat.run');
    issuers.install(theirs, other, { bind: [prod], clients: { 'their-client': [oidcCallbackUrl(PARENT_HOST)] } });
    issuers.instances.get(issuerScope)!.bindings.clear();
    const out = await created({ tag: 'pr-7', versionId: versions[1] });
    expect(out.auth.status).toBe('unregistered');
    expect(issuers.calls.some((c) => c.body.scopeId === theirs)).toBe(false);
    expect([...issuers.instances.get(theirs)!.clients.keys()]).toEqual(['their-client']);
  });

  it('never asks a fork or a preview of an auth server — they hold copies of prod’s clients', async () => {
    const copy = scopeId.parse(ulid());
    await host.provisionScope(staff, {
      tenantId: tenant, scopeId: copy, vertical: 'auth-server', kind: 'preview', slug: 'auth-server--pr-1',
      forkedFrom: issuerScope, forkedAt: new Date().toISOString(),
    });
    await host.admin.activateScope(staff, tenant, copy);
    issuers.install(copy, tenant, { bind: [prod], clients: { 'copied-prod': [oidcCallbackUrl(PARENT_HOST)] } });
    const out = await created({ tag: 'pr-7', versionId: versions[1] });
    expect(out.auth.status).toBe('wired');
    expect(out.auth.issuerScopeId).toBe(issuerScope);
    expect(issuers.calls.some((c) => c.body.scopeId === copy)).toBe(false);
  });

  it('two issuers claiming the app is ambiguous: nothing minted at either', async () => {
    const second = await issuerInstall(tenant, 'auth2-acme.global.substrat.run');
    issuers.install(second, tenant, { bind: [prod], clients: { 'second-prod': [oidcCallbackUrl(PARENT_HOST)] } });
    const out = await created({ tag: 'pr-7', versionId: versions[1] });
    expect(out.auth.status).toBe('ambiguous');
    expect(issuers.tagged(issuerScope, out.scopeId)).toEqual([]);
    expect(issuers.tagged(second, out.scopeId)).toEqual([]);
    expect(deployments.auth(versions[1]!, out.scopeId)).toBeUndefined();
  });

  it('a clean-room preview has no parent: nothing asked, nothing minted', async () => {
    const out = await created({ tag: 'sandbox', versionId: versions[1], empty: true });
    expect(out.auth.status).toBe('not-applicable');
    expect(issuers.calls).toEqual([]);
  });
});

describe('version skew and transients read as what they are (#1704)', () => {
  it('an auth server built before the routes is "redeploy", never "external" — and the preview is still created', async () => {
    issuers.predates = true;
    const out = await created({ tag: 'pr-7', versionId: versions[1] });
    expect(out.auth.status).toBe('unknown');
    expect(out.auth.note).toContain('redeploy');
    expect(out.auth.issuers).toEqual([{ issuerScopeId: issuerScope, problem: expect.stringContaining('predates preview clients') }]);
    expect(deployments.deliveries).toEqual([]);
  });

  it('an auth server that does not answer is "could not be asked", never "external"', async () => {
    issuers.failNext.set(`POST ${PREVIEW_CLIENT_PATH}/check`, 503);
    const out = await created({ tag: 'pr-7', versionId: versions[1] });
    expect(out.auth.status).toBe('unknown');
    expect(out.auth.note).not.toContain('EXTERNAL');
  });

  it('the reap skips an auth server that predates the routes — it cannot have minted', async () => {
    await created({ tag: 'pr-7', versionId: versions[1] });
    issuers.predates = true;
    const del = await app.request(`/verticals/${encodeURIComponent(APP)}/previews/pr-7`, { method: 'DELETE', headers: asStaff });
    expect(del.status).toBe(200);
  });
});

describe('concurrent pushes to one preview (#1704)', () => {
  it('an older push that is superseded never deletes the newer push’s client', async () => {
    const base = await created({ tag: 'pr-7', versionId: versions[1] });
    // Push A (v2) mints, then stalls before delivering. Push B (v3) runs to completion.
    const stall = gate();
    const aMinted = gate();
    let aClient = '';
    issuers.afterMint = async (clientId) => {
      if (!aClient) {
        aClient = clientId;
        aMinted.open();
        await stall.wait;
      }
    };
    const pushA = create({ tag: 'pr-7', versionId: versions[2] });
    await aMinted.wait;
    issuers.afterMint = null;
    const b = await created({ tag: 'pr-7', versionId: versions[3] });
    expect(b.auth.status).toBe('wired');
    const bClient = b.auth.clientId!;
    stall.open();
    const a = (await (await pushA).json()) as Created;
    expect(a.auth.status).toBe('superseded');

    // The newer client lives, it is the one the SERVED version holds, and it is the only one left.
    expect(issuers.tagged(issuerScope, base.scopeId)).toEqual([bClient]);
    expect(deployments.auth(versions[3]!, base.scopeId)!.clientId).toBe(bClient);
    expect((await host.admin.getScopeRecord(staff, tenant, base.scopeId))!.verticalVersionId).toBe(versions[3]);
    // A never retired with keep — only its own client, which lived in its own unserved store.
    const aRetires = issuers.calls.filter((c) => c.method === 'DELETE' && c.body.keep === aClient);
    expect(aRetires).toEqual([]);
  });

  it('a push whose version was re-bound mid-flight never retires the others', async () => {
    const base = await created({ tag: 'pr-7', versionId: versions[1] });
    const [older] = issuers.tagged(issuerScope, base.scopeId);
    const from = issuers.calls.length;
    // Push A (v2) delivers, and while it does another push re-binds the preview to v3.
    deployments.duringDelivery = async (version) => {
      if (version === versions[2]) await host.admin.bindScopeVersion(staff, tenant, base.scopeId, versions[3]!);
    };
    const a = await created({ tag: 'pr-7', versionId: versions[2] });
    expect(a.auth.status).toBe('superseded');
    // The older client (the one v1's push left) was not A's to delete, and A's own is gone.
    expect(issuers.tagged(issuerScope, base.scopeId)).toEqual([older]);
    const aDeletes = issuers.calls.slice(from).filter((c) => c.method === 'DELETE');
    expect(aDeletes).toHaveLength(1);
    expect(aDeletes[0]!.body.only).toBeDefined();
    expect(aDeletes[0]!.body.keep).toBeUndefined();
  });

  it('a client that vanished while its version is still bound is retried, and converges', async () => {
    const base = await created({ tag: 'pr-7', versionId: versions[1] });
    // A same-version sibling's retire removes this push's client just before it retires.
    let stolen = false;
    issuers.beforeRetire = async (body) => {
      if (body.keep && !stolen) {
        stolen = true;
        issuers.instances.get(issuerScope)!.clients.delete(String(body.keep));
      }
    };
    const out = await created({ tag: 'pr-7', versionId: versions[2] });
    expect(out.auth.status).toBe('wired');
    const tagged = issuers.tagged(issuerScope, base.scopeId);
    expect(tagged).toEqual([out.auth.clientId]);
    expect(deployments.auth(versions[2]!, base.scopeId)!.clientId).toBe(out.auth.clientId);
  });

  it('running out of attempts is a failure, never a success', async () => {
    issuers.beforeRetire = async (body) => {
      if (body.keep) issuers.instances.get(issuerScope)!.clients.delete(String(body.keep));
    };
    const res = await create({ tag: 'pr-7', versionId: versions[1] });
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: string }).error).toContain('NO working login');
  });
});

describe('only whoever may create the preview triggers any of it (#1704)', () => {
  const builderApp = () =>
    api({
      authenticateBuilder: (req: Request) => {
        const t = req.headers.get(BUILDER_HEADER);
        if (t === tenant) return { actor: platformActorId.parse(ulid()), tenantId: tenant, tenantSlug: 'acme' };
        if (t === 'stranger') return { actor: platformActorId.parse(ulid()), tenantId: strangerTenant, tenantSlug: 'stranger' };
        return null;
      },
    });
  let strangerTenant: TenantId;

  beforeEach(async () => {
    strangerTenant = tenantId.parse(ulid());
    await host.admin.createTenant(staff, { id: strangerTenant, slug: 'stranger', name: 'Stranger' });
  });

  it('another tenant’s builder is refused before any issuer is asked; the owner is the positive twin', async () => {
    app = builderApp();
    const stranger = await app.request(`/verticals/${encodeURIComponent(APP)}/previews`, {
      method: 'POST',
      headers: { [BUILDER_HEADER]: 'stranger', 'content-type': 'application/json' },
      body: JSON.stringify({ tag: 'pr-7', versionId: versions[1] }),
    });
    expect([403, 404]).toContain(stranger.status);
    expect(issuers.calls).toEqual([]);

    const owner = await app.request('/verticals/desk/previews', {
      method: 'POST',
      headers: { [BUILDER_HEADER]: tenant, 'content-type': 'application/json' },
      body: JSON.stringify({ tag: 'pr-7', versionId: versions[1] }),
    });
    expect(owner.status).toBe(201);
    expect(((await owner.json()) as Created).auth.status).toBe('wired');
  });

  it('no builder can reach an issuer’s preview-client route through the control plane', async () => {
    app = builderApp();
    for (const path of [`/tenants/${tenant}/scopes/${issuerScope}/configure`, '/internal/preview-client']) {
      const res = await app.request(path, {
        method: 'POST',
        headers: { [BUILDER_HEADER]: tenant, 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect([403, 404]).toContain(res.status);
    }
    expect(issuers.calls).toEqual([]);
  });
});
