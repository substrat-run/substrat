import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { runPlatformSweep, ulid } from '@substrat-run/kernel';
import {
  MCP_RESOURCES_CONFIG_PREFIX,
  PREVIEW_CLIENT_PATH,
  SHARED_ISSUER_CONFIG_KEY,
  mcpResourceOf,
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
import {
  createControlPlaneApi,
  retireClientsOfReapedScope,
  firstBuilderAuth,
  mintPushToken,
  pushActorFor,
  pushTokenBuilderAuth,
  tenantTokenAuth,
  DEV_ACTOR_HEADER,
  SERVICE_TOKEN_HEADER,
  UNSAFE_devPlatformActorAuth,
  VerticalClient,
} from '../src/index.js';

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
 *   - the issuer that signs the preview in mints for the preview's MCP endpoint too, from
 *     create until the reap, and prod's registration is never touched;
 *   - nothing is minted on a callback match alone, at another tenant's issuer, at a fork of an
 *     issuer, or where two issuers claim the app;
 *   - an issuer that predates the routes reads as "redeploy", never as "external";
 *   - an external issuer's preview says what to register, and that no login was delivered;
 *   - concurrent pushes: an older push never deletes a newer push's client, a push whose
 *     version was re-bound never retires, and a vanished client is retried, not reported;
 *   - the secret appears in no output, admin-log row or ops-failure row;
 *   - only whoever may create the preview triggers any of it.
 *
 * The issuer is a faithful fake of `demos/auth-server`'s three routes and its resources
 * delivery, speaking through the REAL `VerticalClient` (so the skew handling under test is the
 * shipped one) and parsing every request with the contract's own schemas. The issuer's real
 * implementation is proven against the same schemas in its own package, on node and on workerd.
 */

const staff = platformActorId.parse(ulid());
const asStaff = { [DEV_ACTOR_HEADER]: staff, 'content-type': 'application/json' };
const BUILDER_HEADER = 'x-test-builder';

const APP = 'acme/desk';
const PARENT_HOST = 'desk-acme.global.substrat.run';
const PREVIEW_HOST = (tag: string) => `desk-acme--${tag}.global.substrat.run`;
const PARENT_MCP = mcpResourceOf(`https://${PARENT_HOST}`);
const PREVIEW_MCP = (tag: string) => mcpResourceOf(`https://${PREVIEW_HOST(tag)}`);

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
  /** The resource registry (#1619): identifier → the scope whose delivery owns it. */
  resources: Map<string, string>;
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
  /** Awaited after a check answers — before the caller can mint. */
  afterCheck: (() => Promise<void>) | null = null;
  /** Awaited when a configure delivery arrives, before it applies. */
  beforeConfigure: ((body: Record<string, unknown>) => Promise<void>) | null = null;
  private gen = 0;
  private n = 0;

  install(
    scope: string,
    tenant: string,
    opts: { bind?: string[]; clients?: Record<string, string[]>; resources?: Record<string, string> } = {},
  ): void {
    const clients = new Map<string, FakeClient>();
    for (const [id, uris] of Object.entries(opts.clients ?? {})) {
      clients.set(id, { redirectUris: uris, postLogout: [], secretHash: `hash-${id}`, disabled: false });
    }
    const resources = new Map(Object.entries(opts.resources ?? {}));
    this.instances.set(scope, { tenantId: tenant, bindings: new Set(opts.bind ?? []), clients, resources });
  }

  /** The identifiers registered for `owner` at `scope` — what this issuer would mint for. */
  registered(scope: string, owner: string): string[] {
    return [...(this.instances.get(scope)?.resources ?? [])]
      .filter(([, o]) => o === owner)
      .map(([identifier]) => identifier);
  }

  /**
   * The platform's `/internal/configure`, as `demos/auth-server/src/resources.ts` applies a
   * resources entry: the owner's whole set. Operator-owned rows are not modelled.
   */
  private configure(inst: FakeInstance, entries: Array<{ key: string; value: string }>): void {
    for (const { key, value } of entries) {
      if (!key.startsWith(MCP_RESOURCES_CONFIG_PREFIX)) continue;
      const owner = key.slice(MCP_RESOURCES_CONFIG_PREFIX.length);
      const wanted = new Set(value === '' ? [] : (JSON.parse(value) as string[]));
      for (const [identifier, o] of [...inst.resources]) if (o === owner && !wanted.has(identifier)) inst.resources.delete(identifier);
      for (const identifier of wanted) inst.resources.set(identifier, owner);
    }
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
    // `/internal/configure` predates the preview-client routes (#1619), so even a deployment
    // built before those takes it.
    const isConfigure = url.pathname === '/internal/configure';
    if (!isConfigure && (!url.pathname.startsWith(PREVIEW_CLIENT_PATH) || this.predates)) {
      return json(501, { error: `auth-server does not implement ${method} ${url.pathname}` });
    }
    const fail = this.failNext.get(`${method} ${url.pathname}`);
    if (fail) {
      this.failNext.delete(`${method} ${url.pathname}`);
      return json(fail, { error: `injected ${fail}` });
    }
    const inst = this.instances.get(String(body.scopeId));
    if (!inst || inst.tenantId !== body.tenantId) return json(403, { error: 'not an issuer of that tenant' });
    if (isConfigure) {
      if (this.beforeConfigure) await this.beforeConfigure(body);
      this.configure(inst, body.entries as Array<{ key: string; value: string }>);
      return json(200, { applied: (body.entries as unknown[]).length });
    }
    const claims = (b: { parentScopeId: string; parentRedirectUris: string[] }) =>
      inst.bindings.has(b.parentScopeId) &&
      [...inst.clients.values()].some((c) => !c.disabled && c.redirectUris.some((u) => b.parentRedirectUris.includes(u)));

    if (url.pathname === `${PREVIEW_CLIENT_PATH}/check`) {
      const claimed = claims(previewClientCheck.parse(body));
      if (this.afterCheck) await this.afterCheck();
      return json(200, { claimed });
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
  // prod's client, the platform's binding for prod, and prod's MCP endpoint as the dashboard
  // registered it at install.
  if (!(await host.admin.listVerticals(staff)).some((v) => v.slug === 'auth-server')) {
    await host.admin.registerVertical(staff, { slug: 'auth-server', name: 'Auth Server', source: 'builtin', ownerTenant: null, provides: ['oidc-issuer'] });
  }
  issuerScope = await issuerInstall(tenant, 'auth-acme.global.substrat.run');
  issuers.install(issuerScope, tenant, {
    bind: [prod],
    clients: { [PROD_CLIENT]: [oidcCallbackUrl(PARENT_HOST)] },
    resources: { [PARENT_MCP]: prod },
  });
}

/** Every configure delivery the platform made to any issuer. */
const configures = () => issuers.calls.filter((c) => c.path === '/internal/configure');

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
  it('DELETE removes the preview’s clients and MCP registration before the preview, and prod’s survive', async () => {
    const out = await created({ tag: 'pr-7', versionId: versions[1] });
    expect(issuers.tagged(issuerScope, out.scopeId)).toHaveLength(1);
    const del = await app.request(`/verticals/${encodeURIComponent(APP)}/previews/pr-7`, { method: 'DELETE', headers: asStaff });
    expect(del.status).toBe(200);
    expect(issuers.tagged(issuerScope, out.scopeId)).toEqual([]);
    expect(issuers.instances.get(issuerScope)!.clients.has(PROD_CLIENT)).toBe(true);
    expect(issuers.registered(issuerScope, out.scopeId)).toEqual([]);
    expect(issuers.registered(issuerScope, prod)).toEqual([PARENT_MCP]);
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

describe('the expiry sweep retires an expired preview’s client too (#1704)', () => {
  it('as apps/control-plane composes it: the preview’s client and MCP registration go with it, a snapshot is left alone', async () => {
    const out = await created({ tag: 'pr-7', versionId: versions[1], ttlHours: 1 });
    await host.admin.setScopeExpiresAt(staff, tenant, out.scopeId, new Date(Date.now() - 1000).toISOString());
    const issuerClient = new VerticalClient({ fetch: issuers.fetch, platformSecret: 'test' });
    const deps = { admin: host.admin, actor: staff, issuerClient: async () => issuerClient };
    const report = await runPlatformSweep(host, {
      actor: staff,
      drainRetries: false,
      deleteSnapshotFn: async (t, s) => {
        await retireClientsOfReapedScope(deps, await host.admin.getScopeRecord(staff, t, s));
        await host.deleteSnapshot(staff, t, s);
      },
    });
    expect(report.snapshotsReaped).toBeGreaterThanOrEqual(1);
    expect(issuers.tagged(issuerScope, out.scopeId)).toEqual([]);
    expect(issuers.instances.get(issuerScope)!.clients.has(PROD_CLIENT)).toBe(true);
    expect(issuers.registered(issuerScope, out.scopeId)).toEqual([]);
    expect(issuers.registered(issuerScope, prod)).toEqual([PARENT_MCP]);
    // Anything that is not a preview fork has no client to retire, and is never asked about.
    const before = issuers.calls.length;
    expect(await retireClientsOfReapedScope(deps, (await host.admin.getScopeRecord(staff, tenant, prod))!)).toEqual([]);
    expect(await retireClientsOfReapedScope(deps, undefined)).toEqual([]);
    expect(issuers.calls.length).toBe(before);
  });
});

describe('a preview’s MCP endpoint is registered where its login is (#1704)', () => {
  it('create registers it at the issuer that signs the preview in, keyed by the preview — prod’s registration untouched', async () => {
    const out = await created({ tag: 'pr-7', versionId: versions[1] });
    expect(out.auth.status).toBe('wired');
    // What the issuer will now mint for: the preview's endpoint, owned by the PREVIEW's key.
    expect(issuers.registered(issuerScope, out.scopeId)).toEqual([PREVIEW_MCP('pr-7')]);
    expect(issuers.registered(issuerScope, prod)).toEqual([PARENT_MCP]);
    // One delivery, to the issuer's own (tenant, scope), naming no other app's key.
    expect(configures()).toEqual([
      {
        method: 'POST',
        path: '/internal/configure',
        body: {
          tenantId: tenant,
          scopeId: issuerScope,
          entries: [{ key: `${MCP_RESOURCES_CONFIG_PREFIX}${out.scopeId}`, value: JSON.stringify([PREVIEW_MCP('pr-7')]) }],
        },
      },
    ]);
    expect(out.auth.note).toContain(`MCP: ${PREVIEW_MCP('pr-7')} registered there`);
  });

  it('registers every hostname the preview actively answers on, as the dashboard counts them — never a pending one', async () => {
    const first = await created({ tag: 'pr-7', versionId: versions[1] });
    const bind = (hostname: string) =>
      host.admin.bindHostname(staff, { hostname, tenantId: tenant, scopeId: first.scopeId, surface: 'app', region: null, canonical: false });
    await bind('desk-acme--pr-7.alt.example');
    await host.admin.setHostnameStatus(staff, 'desk-acme--pr-7.alt.example', 'active');
    await bind('desk-acme--pr-7.pending.example');
    await created({ tag: 'pr-7', versionId: versions[2] });
    expect(issuers.registered(issuerScope, first.scopeId).sort()).toEqual(
      [PREVIEW_MCP('pr-7'), mcpResourceOf('https://desk-acme--pr-7.alt.example')].sort(),
    );
  });

  it('every push re-asserts the same set, and --refresh moves it to the fresh preview', async () => {
    const first = await created({ tag: 'pr-7', versionId: versions[1] });
    const again = await created({ tag: 'pr-7', versionId: versions[2] });
    expect(again.reused).toBe(true);
    expect(configures()).toHaveLength(2);
    expect(issuers.registered(issuerScope, first.scopeId)).toEqual([PREVIEW_MCP('pr-7')]);

    const fresh = await created({ tag: 'pr-7', versionId: versions[3], refresh: true });
    expect(issuers.registered(issuerScope, first.scopeId)).toEqual([]);
    expect(issuers.registered(issuerScope, fresh.scopeId)).toEqual([PREVIEW_MCP('pr-7')]);
    expect(issuers.registered(issuerScope, prod)).toEqual([PARENT_MCP]);
  });

  it('a reap whose un-registration fails keeps the preview, and its clients, so the retry still finds both', async () => {
    const out = await created({ tag: 'pr-7', versionId: versions[1] });
    issuers.failNext.set('POST /internal/configure', 503);
    const failed = await app.request(`/verticals/${encodeURIComponent(APP)}/previews/pr-7`, { method: 'DELETE', headers: asStaff });
    expect(failed.ok).toBe(false);
    expect(await host.admin.getScopeRecord(staff, tenant, out.scopeId)).toBeDefined();
    expect(issuers.registered(issuerScope, out.scopeId)).toEqual([PREVIEW_MCP('pr-7')]);
    // Cleared BEFORE retired: a registration never outlives the clients that make the issuer
    // read the preview as one (`claimsParent`), even when the clear is what failed.
    expect(issuers.tagged(issuerScope, out.scopeId)).toHaveLength(1);
    const retried = await app.request(`/verticals/${encodeURIComponent(APP)}/previews/pr-7`, { method: 'DELETE', headers: asStaff });
    expect(retried.status).toBe(200);
    expect(issuers.registered(issuerScope, out.scopeId)).toEqual([]);
    expect(issuers.tagged(issuerScope, out.scopeId)).toEqual([]);
  });

  it('a registration that fails once is retried like the delivery beside it', async () => {
    app = api({ provisionRetryDelaysMs: [0] });
    issuers.failNext.set('POST /internal/configure', 503);
    const out = await created({ tag: 'pr-7', versionId: versions[1] });
    expect(issuers.registered(issuerScope, out.scopeId)).toEqual([PREVIEW_MCP('pr-7')]);
    expect(out.auth.note).toContain(`MCP: ${PREVIEW_MCP('pr-7')} registered there`);
  });

  it('a registration that fails does not fail the login — the note says so, and the next push registers it', async () => {
    issuers.failNext.set('POST /internal/configure', 503);
    const out = await created({ tag: 'pr-7', versionId: versions[1] });
    expect(out.auth.status).toBe('wired');
    expect(deployments.auth(versions[1]!, out.scopeId)!.clientId).toBe(out.auth.clientId);
    expect(out.auth.note).toContain("the preview's endpoint could not be registered there");
    expect(out.auth.note).toContain('invalid_target');
    expect(issuers.registered(issuerScope, out.scopeId)).toEqual([]);

    await created({ tag: 'pr-7', versionId: versions[2] });
    expect(issuers.registered(issuerScope, out.scopeId)).toEqual([PREVIEW_MCP('pr-7')]);
  });

});

/**
 * The real reap racing a push (#1704): the DELETE route's own `reapPreview`, which keeps the
 * preview's row until its last step, `deleteSnapshot`. Each test holds that last step until
 * the push has answered, so the push meets the row still there — the case a row-only look
 * cannot tell from a live preview.
 */
describe('a reap racing a push leaves nothing at the issuer (#1704)', () => {
  const del = () => app.request(`/verticals/${encodeURIComponent(APP)}/previews/pr-7`, { method: 'DELETE', headers: asStaff });

  /** Hold the reap's `deleteSnapshot` until released; `reached` resolves when the reap gets there. */
  function holdRowDelete(): { reached: Promise<void>; release: () => void; restore: () => void } {
    const reached = gate();
    const release = gate();
    const original = host.deleteSnapshot.bind(host);
    host.deleteSnapshot = async (...args) => {
      reached.open();
      await release.wait;
      return original(...args);
    };
    return { reached: reached.wait, release: release.open, restore: () => (host.deleteSnapshot = original) };
  }

  it('archives the preview before its first issuer call, and clears before it retires', async () => {
    const out = await created({ tag: 'pr-7', versionId: versions[1] });
    let statusAtFirstCall: string | undefined;
    issuers.beforeConfigure = async () => {
      statusAtFirstCall ??= (await host.admin.getScopeRecord(staff, tenant, out.scopeId))?.status;
    };
    const from = issuers.calls.length;
    expect((await del()).status).toBe(200);
    expect(statusAtFirstCall).toBe('archived');
    expect(issuers.calls.slice(from).map((c) => c.method)).toEqual(['POST', 'DELETE']);
  });

  it('a reap whose issuer step lands between a push’s mint and its next look: the push removes nothing it keeps', async () => {
    const base = await created({ tag: 'pr-7', versionId: versions[1] });
    const rowDelete = holdRowDelete();
    const minted = gate();
    const resume = gate();
    let stalled = false;
    issuers.afterMint = async () => {
      if (stalled) return;
      stalled = true;
      minted.open();
      await resume.wait;
    };
    try {
      const push = create({ tag: 'pr-7', versionId: versions[2] });
      await minted.wait;
      const reap = del();
      await rowDelete.reached; // the reap's issuer step is done; its row is still there
      resume.open();
      const pushed = (await (await push).json()) as Created;
      expect(pushed.auth.status).toBe('superseded');
      rowDelete.release();
      expect((await reap).status).toBe(200);
    } finally {
      rowDelete.restore();
    }
    expect(await host.admin.getScopeRecord(staff, tenant, base.scopeId)).toBeUndefined();
    expect(issuers.registered(issuerScope, base.scopeId)).toEqual([]);
    expect(issuers.tagged(issuerScope, base.scopeId)).toEqual([]);
    expect(issuers.registered(issuerScope, prod)).toEqual([PARENT_MCP]);
    expect(issuers.instances.get(issuerScope)!.clients.has(PROD_CLIENT)).toBe(true);
  });

  it('a push whose registration lands after the reap’s clear removes it itself, registration first', async () => {
    const base = await created({ tag: 'pr-7', versionId: versions[1] });
    const rowDelete = holdRowDelete();
    const registering = gate();
    const resume = gate();
    let stalled = false;
    issuers.beforeConfigure = async (body) => {
      const [entry] = body.entries as Array<{ key: string; value: string }>;
      if (stalled || entry?.value === '') return;
      stalled = true;
      registering.open();
      await resume.wait;
    };
    let from = 0;
    try {
      const push = create({ tag: 'pr-7', versionId: versions[2] });
      await registering.wait;
      const reap = del();
      await rowDelete.reached; // the reap cleared and retired; this push's registration is next
      from = issuers.calls.length;
      resume.open();
      expect(((await (await push).json()) as Created).auth.status).toBe('superseded');
      rowDelete.release();
      expect((await reap).status).toBe(200);
    } finally {
      rowDelete.restore();
    }
    expect(issuers.registered(issuerScope, base.scopeId)).toEqual([]);
    expect(issuers.tagged(issuerScope, base.scopeId)).toEqual([]);
    // After its own late registration, the push cleared before it retired.
    const own = issuers.calls.slice(from + 1);
    const clear = own.findIndex((c) => c.path === '/internal/configure');
    const retireAll = own.findIndex((c) => c.method === 'DELETE' && !c.body.keep && !c.body.only);
    expect(clear).toBeGreaterThanOrEqual(0);
    expect(clear).toBeLessThan(retireAll);
  });

  it('a push that registers and retires between the reap’s clear and its retire is caught by its last look', async () => {
    const base = await created({ tag: 'pr-7', versionId: versions[1] });
    const rowDelete = holdRowDelete();
    const pushRegistering = gate();
    const resumePush = gate();
    const reapRetiring = gate();
    const resumeReap = gate();
    let pushStalled = false;
    let reapStalled = false;
    issuers.beforeConfigure = async (body) => {
      const [entry] = body.entries as Array<{ key: string; value: string }>;
      if (pushStalled || entry?.value === '') return;
      pushStalled = true;
      pushRegistering.open();
      await resumePush.wait;
    };
    issuers.beforeRetire = async (body) => {
      if (reapStalled || body.keep || body.only) return;
      reapStalled = true; // the reap's own retire, after its clear
      reapRetiring.open();
      await resumeReap.wait;
    };
    try {
      const push = create({ tag: 'pr-7', versionId: versions[2] });
      await pushRegistering.wait; // past its look after the delivery
      const reap = del();
      await reapRetiring.wait; // archived and cleared; its retire is held
      resumePush.open(); // registers after that clear, and keeps its own client
      expect(((await (await push).json()) as Created).auth.status).toBe('superseded');
      resumeReap.open();
      await rowDelete.reached;
      rowDelete.release();
      expect((await reap).status).toBe(200);
    } finally {
      rowDelete.restore();
    }
    expect(issuers.registered(issuerScope, base.scopeId)).toEqual([]);
    expect(issuers.tagged(issuerScope, base.scopeId)).toEqual([]);
  });

  it('a push’s LAST attempt that loses its client to a reap looks before it gives up, and removes what it left', async () => {
    const base = await created({ tag: 'pr-7', versionId: versions[1] });
    const rowDelete = holdRowDelete();
    // Attempts 1 and 2 lose their kept client as to a same-version sibling; attempt 3 loses it to the reap.
    let keeps = 0;
    issuers.beforeRetire = async (body) => {
      if (body.keep && ++keeps <= 2) issuers.instances.get(issuerScope)!.clients.delete(String(body.keep));
    };
    const registering = gate();
    const resume = gate();
    let registrations = 0;
    issuers.beforeConfigure = async (body) => {
      const [entry] = body.entries as Array<{ key: string; value: string }>;
      if (entry?.value === '' || ++registrations !== 3) return;
      registering.open();
      await resume.wait;
    };
    try {
      const push = create({ tag: 'pr-7', versionId: versions[2] });
      await registering.wait; // the third attempt, past its looks, about to register
      const reap = del();
      await rowDelete.reached;
      resume.open();
      expect(((await (await push).json()) as Created).auth.status).toBe('superseded');
      rowDelete.release();
      expect((await reap).status).toBe(200);
    } finally {
      rowDelete.restore();
    }
    expect(issuers.registered(issuerScope, base.scopeId)).toEqual([]);
    expect(issuers.tagged(issuerScope, base.scopeId)).toEqual([]);
  });

  it('a push for a reaped preview hands back the row it moved off the NEWER preview of the same tag', async () => {
    const a = await created({ tag: 'pr-7', versionId: versions[1] });
    // A push to A registers its set, read while A still held the hostname; the delivery is held.
    const registering = gate();
    const resume = gate();
    let stalled = false;
    issuers.beforeConfigure = async (body) => {
      const [entry] = body.entries as Array<{ key: string; value: string }>;
      if (stalled || entry?.value === '' || entry?.key !== `${MCP_RESOURCES_CONFIG_PREFIX}${a.scopeId}`) return;
      stalled = true;
      registering.open();
      await resume.wait;
    };
    const push = create({ tag: 'pr-7', versionId: versions[2] });
    await registering.wait;
    // A is reaped and B, a fresh preview of the same tag, takes the same hostname and registers it.
    const b = await created({ tag: 'pr-7', versionId: versions[3], refresh: true });
    expect(b.scopeId).not.toBe(a.scopeId);
    expect(issuers.registered(issuerScope, b.scopeId)).toEqual([PREVIEW_MCP('pr-7')]);
    // A's held delivery lands last, so the issuer moves the row onto A's key...
    resume.open();
    expect(((await (await push).json()) as Created).auth.status).toBe('superseded');
    // ...and A's own removal hands it back to B, the preview that holds the hostname.
    expect(issuers.registered(issuerScope, a.scopeId)).toEqual([]);
    expect(issuers.registered(issuerScope, b.scopeId)).toEqual([PREVIEW_MCP('pr-7')]);
    expect(issuers.tagged(issuerScope, b.scopeId)).toEqual([b.auth.clientId]);
  });

  it('hands back only to a preview of the same app: another holder of the hostname is never registered for', async () => {
    const a = await created({ tag: 'pr-7', versionId: versions[1] });
    const registering = gate();
    const resume = gate();
    let stalled = false;
    issuers.beforeConfigure = async (body) => {
      const [entry] = body.entries as Array<{ key: string; value: string }>;
      if (stalled || entry?.value === '' || entry?.key !== `${MCP_RESOURCES_CONFIG_PREFIX}${a.scopeId}`) return;
      stalled = true;
      registering.open();
      await resume.wait;
    };
    const push = create({ tag: 'pr-7', versionId: versions[2] });
    await registering.wait;
    expect((await del()).status).toBe(200);
    // The freed hostname goes to a scope that is no preview at all.
    await host.admin.bindHostname(staff, { hostname: PREVIEW_HOST('pr-7'), tenantId: tenant, scopeId: prod, surface: 'app', region: null, canonical: false });
    await host.admin.setHostnameStatus(staff, PREVIEW_HOST('pr-7'), 'active');
    resume.open();
    expect(((await (await push).json()) as Created).auth.status).toBe('superseded');
    expect(issuers.registered(issuerScope, a.scopeId)).toEqual([]);
    expect(issuers.registered(issuerScope, prod)).toEqual([PARENT_MCP]);
  });

  it('registers only what the directory says the preview holds — never the hostname it was made with, once that is gone', async () => {
    const out = await created({ tag: 'pr-7', versionId: versions[1] });
    expect(issuers.registered(issuerScope, out.scopeId)).toEqual([PREVIEW_MCP('pr-7')]);
    deployments.duringDelivery = async (version) => {
      if (version === versions[2]) await host.admin.unbindHostname(staff, PREVIEW_HOST('pr-7'));
    };
    const again = await created({ tag: 'pr-7', versionId: versions[2] });
    expect(again.auth.status).toBe('wired');
    expect(again.auth.note).toContain('no active hostname');
    expect(issuers.registered(issuerScope, out.scopeId)).toEqual([]);
  });

  it('a removal that fails after the preview was reaped mid-push is said — a 502 and an ops-failure row', async () => {
    await created({ tag: 'pr-7', versionId: versions[1] });
    const rowDelete = holdRowDelete();
    const minted = gate();
    const resume = gate();
    let stalled = false;
    issuers.afterMint = async () => {
      if (stalled) return;
      stalled = true;
      minted.open();
      await resume.wait;
    };
    try {
      const push = create({ tag: 'pr-7', versionId: versions[2] });
      await minted.wait;
      const reap = del();
      await rowDelete.reached;
      issuers.failNext.set('POST /internal/configure', 503);
      resume.open();
      const res = await push;
      expect(res.status).toBe(502);
      expect(((await res.json()) as { error: string }).error).toContain('reaped while this push ran');
      rowDelete.release();
      expect((await reap).status).toBe(200);
    } finally {
      rowDelete.restore();
    }
    expect(JSON.stringify(await host.admin.listOpsFailures(staff, { limit: 50 }))).toContain('reaped while this push ran');
  });
});

describe('every door that reaps a preview fork runs its issuer step (#1704)', () => {
  it('the generic fork DELETE (the console’s Prune/Retire, the dashboard’s Retire): archived, cleared, retired', async () => {
    const out = await created({ tag: 'pr-7', versionId: versions[1] });
    let statusAtFirstCall: string | undefined;
    issuers.beforeConfigure = async () => {
      statusAtFirstCall ??= (await host.admin.getScopeRecord(staff, tenant, out.scopeId))?.status;
    };
    const from = issuers.calls.length;
    const res = await app.request(`/tenants/${tenant}/scopes/${out.scopeId}`, { method: 'DELETE', headers: asStaff });
    expect(res.status).toBe(200);
    expect(statusAtFirstCall).toBe('archived');
    expect(issuers.calls.slice(from).map((c) => `${c.method} ${c.path}`)).toEqual([
      'POST /internal/configure',
      `DELETE ${PREVIEW_CLIENT_PATH}`,
    ]);
    expect(await host.admin.getScopeRecord(staff, tenant, out.scopeId)).toBeUndefined();
    expect(issuers.registered(issuerScope, out.scopeId)).toEqual([]);
    expect(issuers.tagged(issuerScope, out.scopeId)).toEqual([]);
    expect(issuers.registered(issuerScope, prod)).toEqual([PARENT_MCP]);
    expect(issuers.instances.get(issuerScope)!.clients.has(PROD_CLIENT)).toBe(true);
  });

  it('the staff reap of an archived preview fork: cleared and retired', async () => {
    const out = await created({ tag: 'pr-7', versionId: versions[1] });
    expect((await app.request(`/tenants/${tenant}/scopes/${out.scopeId}/archive`, { method: 'POST', headers: asStaff })).status).toBe(200);
    for (const h of await host.admin.listHostnames(staff, { scopeId: out.scopeId })) await host.admin.unbindHostname(staff, h.hostname);
    const res = await app.request(`/tenants/${tenant}/scopes/${out.scopeId}/reap`, { method: 'POST', headers: asStaff });
    expect(res.status).toBe(200);
    expect(issuers.registered(issuerScope, out.scopeId)).toEqual([]);
    expect(issuers.tagged(issuerScope, out.scopeId)).toEqual([]);
    expect(issuers.registered(issuerScope, prod)).toEqual([PARENT_MCP]);
  });

  it('a primary scope deleted or reaped through these doors asks no issuer', async () => {
    const snapshot = scopeId.parse(ulid());
    await host.provisionScope(staff, { tenantId: tenant, scopeId: snapshot, vertical: APP, forkedFrom: prod, forkedAt: new Date().toISOString() });
    await host.admin.activateScope(staff, tenant, snapshot);
    const from = issuers.calls.length;
    expect((await app.request(`/tenants/${tenant}/scopes/${snapshot}`, { method: 'DELETE', headers: asStaff })).status).toBe(200);
    expect(issuers.calls.length).toBe(from);
  });
});

describe('the reap’s archive tolerates a reaper that raced it there (#1704)', () => {
  const issuerClient = () => new VerticalClient({ fetch: issuers.fetch, platformSecret: 'test' });

  it('archived by another reaper between its read and its archive: it goes on to clear and retire', async () => {
    const out = await created({ tag: 'pr-7', versionId: versions[1] });
    const racing = new Proxy(host.admin, {
      get: (target, key, receiver) =>
        key === 'archiveScope'
          ? async (a: typeof staff, t: TenantId, s: ScopeId) => {
              await target.archiveScope(a, t, s); // the other reaper's archive lands first
              throw new Error('illegal scope transition for archiveScope: archived → archived');
            }
          : Reflect.get(target, key, receiver),
    });
    const client = issuerClient();
    const rec = (await host.admin.getScopeRecord(staff, tenant, out.scopeId))!;
    await retireClientsOfReapedScope({ admin: racing, actor: staff, issuerClient: async () => client }, rec);
    expect((await host.admin.getScopeRecord(staff, tenant, out.scopeId))?.status).toBe('archived');
    expect(issuers.registered(issuerScope, out.scopeId)).toEqual([]);
    expect(issuers.tagged(issuerScope, out.scopeId)).toEqual([]);
  });

  it('the twin: an archive that fails while the preview is still live stops the reap before any issuer call', async () => {
    const out = await created({ tag: 'pr-7', versionId: versions[1] });
    const failing = new Proxy(host.admin, {
      get: (target, key, receiver) =>
        key === 'archiveScope'
          ? async () => {
              throw new Error('directory unavailable');
            }
          : Reflect.get(target, key, receiver),
    });
    const client = issuerClient();
    const from = issuers.calls.length;
    const rec = (await host.admin.getScopeRecord(staff, tenant, out.scopeId))!;
    await expect(retireClientsOfReapedScope({ admin: failing, actor: staff, issuerClient: async () => client }, rec)).rejects.toThrow(
      'directory unavailable',
    );
    expect(issuers.calls.length).toBe(from);
    expect(issuers.registered(issuerScope, out.scopeId)).toEqual([PREVIEW_MCP('pr-7')]);
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
    // Nor is its MCP endpoint registered at a team issuer that does not sign it in.
    expect(configures()).toEqual([]);
    expect(out.auth.note).not.toContain('MCP');
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
    expect(configures()).toEqual([]);
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
    expect(configures()).toEqual([]);
  });

  it('an auth server that does not answer is "could not be asked", never "external"', async () => {
    issuers.failNext.set(`POST ${PREVIEW_CLIENT_PATH}/check`, 503);
    const out = await created({ tag: 'pr-7', versionId: versions[1] });
    expect(out.auth.status).toBe('unknown');
    expect(out.auth.note).not.toContain('EXTERNAL');
  });

  it('the reap at an auth server that predates the routes: its 501 retire is skipped, and the clear is a no-op', async () => {
    const out = await created({ tag: 'pr-7', versionId: versions[1] });
    issuers.predates = true;
    const del = await app.request(`/verticals/${encodeURIComponent(APP)}/previews/pr-7`, { method: 'DELETE', headers: asStaff });
    expect(del.status).toBe(200);
    expect(issuers.registered(issuerScope, out.scopeId)).toEqual([]);
    expect(issuers.registered(issuerScope, prod)).toEqual([PARENT_MCP]);
  });

  it('the reap skips a deployment that takes no delivery — it cannot hold a registration', async () => {
    await created({ tag: 'pr-7', versionId: versions[1] });
    issuers.failNext.set('POST /internal/configure', 501);
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
    // Nor did it take the preview's MCP endpoint away from the push that owns its login.
    expect(issuers.registered(issuerScope, base.scopeId)).toEqual([PREVIEW_MCP('pr-7')]);
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

  it('superseded while its own version is still bound means stop: no re-mint, and the newer client survives', async () => {
    const base = await created({ tag: 'pr-7', versionId: versions[1] });
    // A sibling push of the SAME version mints just before this one retires — the one case in
    // which a newer client can exist while this push's version is still the bound one.
    let sibling = '';
    issuers.beforeRetire = async (body) => {
      if (body.keep && !sibling) {
        sibling = 'sibling-client';
        issuers.instances.get(issuerScope)!.clients.set(sibling, {
          redirectUris: [oidcCallbackUrl(PREVIEW_HOST('pr-7'))],
          postLogout: [],
          secretHash: 'h',
          disabled: false,
          preview: base.scopeId,
          generation: 10_000,
        });
      }
    };
    const from = issuers.calls.length;
    const out = await created({ tag: 'pr-7', versionId: versions[2] });
    expect(out.auth.status).toBe('wired');
    const mints = issuers.calls.slice(from).filter((c) => c.method === 'POST' && c.path === PREVIEW_CLIENT_PATH);
    expect(mints).toHaveLength(1);
    expect(issuers.tagged(issuerScope, base.scopeId)).toContain(sibling);
    expect(issuers.tagged(issuerScope, base.scopeId)).toContain(out.auth.clientId);
  });

  it('a push whose version was re-bound before it minted mints nothing at all', async () => {
    const base = await created({ tag: 'pr-7', versionId: versions[1] });
    const tagged = issuers.tagged(issuerScope, base.scopeId);
    issuers.afterCheck = async () => {
      await host.admin.bindScopeVersion(staff, tenant, base.scopeId, versions[3]!);
    };
    const from = issuers.calls.length;
    const out = await created({ tag: 'pr-7', versionId: versions[2] });
    expect(out.auth.status).toBe('superseded');
    expect(issuers.calls.slice(from).filter((c) => c.method !== 'POST' || c.path !== `${PREVIEW_CLIENT_PATH}/check`)).toEqual([]);
    expect(issuers.tagged(issuerScope, base.scopeId)).toEqual(tagged);
    expect(deployments.stores.get(versions[2]!)?.get(base.scopeId)).toBeUndefined();
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
  const TENANT_SECRET = 'test-tenant-token-secret';
  const PUSH_SECRET = 'test-push-token-secret';
  const serviceActor = platformActorId.parse(ulid());
  let strangerTenant: TenantId;
  let asStranger: Record<string, string>;
  let asOwner: Record<string, string>;

  beforeEach(async () => {
    app = api({
      authenticateTenantService: tenantTokenAuth(TENANT_SECRET, serviceActor),
      authenticateBuilder: firstBuilderAuth(pushTokenBuilderAuth(PUSH_SECRET)),
      tenantTokenSecret: TENANT_SECRET,
      pushTokenSecret: PUSH_SECRET,
    });
    strangerTenant = tenantId.parse(ulid());
    await host.admin.createTenant(staff, { id: strangerTenant, slug: 'stranger', name: 'Stranger' });
    // The dashboard's tenant token of ANOTHER team: confined, and it may name any slug —
    // so it is the caller that actually reaches the preview gate with someone else's app.
    const minted = await app.request('/tenant-tokens', { method: 'POST', headers: asStaff, body: JSON.stringify({ tenantId: strangerTenant }) });
    expect(minted.status).toBe(201);
    asStranger = { [SERVICE_TOKEN_HEADER]: ((await minted.json()) as { token: string }).token, 'content-type': 'application/json' };
    const push = await mintPushToken(PUSH_SECRET, { actor: await pushActorFor(tenant), tenantId: tenant, tenantSlug: 'acme' });
    asOwner = { [SERVICE_TOKEN_HEADER]: push, 'content-type': 'application/json' };
  });

  it('another team is refused before any issuer is asked; the owner’s push token is the positive twin', async () => {
    const stranger = await create({ tag: 'pr-7', versionId: versions[1] }, asStranger);
    expect(stranger.status).toBe(403);
    expect(issuers.calls).toEqual([]);
    expect((await host.admin.listScopes(staff, { tenantId: tenant })).some((s) => s.kind === 'preview')).toBe(false);

    const owner = await app.request('/verticals/desk/previews', {
      method: 'POST',
      headers: asOwner,
      body: JSON.stringify({ tag: 'pr-7', versionId: versions[1] }),
    });
    expect(owner.status).toBe(201);
    expect(((await owner.json()) as Created).auth.status).toBe('wired');
  });

  it('another team cannot reap the preview, so it cannot delete its client either', async () => {
    const out = await created({ tag: 'pr-7', versionId: versions[1] });
    const del = await app.request(`/verticals/${encodeURIComponent(APP)}/previews/pr-7`, { method: 'DELETE', headers: asStranger });
    expect(del.status).toBe(403);
    expect(issuers.tagged(issuerScope, out.scopeId)).toHaveLength(1);
  });

  it('no builder reaches a configure delivery or an issuer route through the control plane', async () => {
    for (const path of [`/tenants/${tenant}/scopes/${issuerScope}/configure`, '/internal/preview-client']) {
      const res = await app.request(path, { method: 'POST', headers: asOwner, body: JSON.stringify({}) });
      expect([403, 404]).toContain(res.status);
    }
    expect(issuers.calls).toEqual([]);
  });
});
