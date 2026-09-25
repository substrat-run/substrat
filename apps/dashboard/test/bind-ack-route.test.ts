import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { createControlPlaneApi, UNSAFE_devPlatformActorAuth } from '@substrat-run/control-plane-api';
import { platformActorId, principalId, scopeId, tenantId, type ScopeId } from '@substrat-run/contracts';
import { ulid } from '@substrat-run/kernel';
import { MODULES, provisionDashboard } from '../src/index.js';
import { problemDetail } from '@substrat-run/contracts';
import { exportBreaksIn, sendWithExportBreakAck, type BrokenApp } from '../web/src/lib/bind-ack.js';

/**
 * An Update or a Bind refused for the apps it would break (#1756), end to end: the worker driven
 * the way a request reaches it, the real control plane over a SQLite host behind the service
 * binding (the `promote-review-route.test.ts` harness), and the answer read with the parse the web
 * client's `call()` uses (`problemDetail`, `exportBreaksIn`) — `api.ts` itself is browser code.
 * What is asserted is what the person pressing the button is shown: the apps by name,
 * not only a count, and no Activity line for an Update they did not make.
 */

const shared = vi.hoisted(() => ({ host: null as unknown }));

vi.mock('cloudflare:workers', () => ({ DurableObject: class {} }));
vi.mock('@substrat-run/adapter-cloudflare', () => ({
  defineScopeDO: () => class {},
  ControlPlaneDO: class {},
  CloudflareScopeHost: class {
    constructor() {
      const target = shared.host as object;
      return new Proxy(target, {
        get(t, key) {
          if (key === 'registerModule') return () => undefined;
          const v = Reflect.get(t, key) as unknown;
          return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(t) : v;
        },
      });
    }
  },
}));
vi.mock('@substrat-run/oidc-rp', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@substrat-run/oidc-rp')>()),
  mountOidcRoutes: () => undefined,
  verifySession: async (_env: unknown, token: string | undefined) => (token ? { id: token } : null),
}));

const workerModule = '../src/worker.js';
const { default: app } = (await import(/* @vite-ignore */ workerModule)) as {
  default: { request(path: string, init: RequestInit, env: unknown): Response | Promise<Response> };
};

const PROVIDER = 'authhero';
const PRODUCER = 'acme/ledger';
const CONSUMER = 'acme/desk';
const TYPE = 'ledger.entry-made';
const staff = platformActorId.parse(ulid());
const OWNER_SUB = 'sub-owner';

describe('an Update or a Bind refused for what it would break (#1756)', () => {
  let dir: string;
  let host: SqliteScopeHost;
  const tenant = tenantId.parse(ulid());
  const dashScope = scopeId.parse(ulid());
  let appScope: ScopeId;
  let deskScope: ScopeId;
  let env: Record<string, unknown>;
  let owner: ReturnType<typeof principalId.parse>;
  const v = { exporting: ulid(), dropping: ulid(), desk: ulid() };

  const registry = (extra: object) => JSON.stringify({ registry: { permissions: [], roles: [], entityGrants: [], ...extra } });
  const publish = async (slug: string, id: string, manifestJson: string) => {
    await host.admin.publishVersion(staff, {
      id, verticalSlug: slug, version: `1.0.${id.slice(-4).toLowerCase()}`, manifestDigest: `m-${id}`,
      permissionDigest: 'p', migrationDigest: 'g', deploymentRef: null, manifestJson,
    });
    await host.admin.admitVersion(staff, id);
  };
  const install = async (slug: string, versionId: string): Promise<ScopeId> => {
    const s = scopeId.parse(ulid());
    await host.provisionScope(staff, { tenantId: tenant, scopeId: s, vertical: slug });
    await host.admin.activateScope(staff, tenant, s);
    await host.admin.bindScopeVersion(staff, tenant, s, versionId);
    return s;
  };

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'substrat-bind-ack-'));
    host = new SqliteScopeHost({ dir });
    shared.host = host;
    for (const m of MODULES) host.registerModule(m);

    owner = principalId.parse(ulid());
    await provisionDashboard(host, { tenantId: tenant, scopeId: dashScope, owner, slug: 'bind-ack', name: 'Bind ack' });
    await host.admin.registerIdentityPool(staff, { provider: PROVIDER, topology: 'central', tenantId: null });
    await host.admin.linkIdentity(staff, { provider: PROVIDER, externalId: OWNER_SUB, principal: owner, tenantId: tenant, scopeId: dashScope });

    for (const slug of [PRODUCER, CONSUMER]) await host.admin.registerVertical(staff, { slug, name: slug, source: 'cli' });
    const exportRow = { type: TYPE, schemaVersion: 1, readPermission: 'ledger:read', declaredBy: ['@test/ledger'] };
    await publish(PRODUCER, v.exporting, registry({ exports: [exportRow] }));
    await publish(PRODUCER, v.dropping, registry({}));
    await publish(CONSUMER, v.desk, registry({ imports: [{ from: PRODUCER, type: TYPE, schemaVersion: 1, declaredBy: ['@test/desk'] }] }));
    // Prod moves to the version that drops the export (acknowledged at the promote, which judges
    // it too); the team's app still runs the exporting one, beside an app that imports it.
    await host.admin.promoteVersion(staff, PRODUCER, 'prod', v.dropping, { exportBreak: true });
    appScope = await install(PRODUCER, v.exporting);
    deskScope = await install(CONSUMER, v.desk);
    const dash = await host.getScope(owner, tenant, dashScope);
    await dash.invoke('dashboard/provision-app', { appScopeId: appScope, verticalSlug: PRODUCER, name: 'Ledger' });

    const plane = createControlPlaneApi({ host, authenticate: UNSAFE_devPlatformActorAuth() });
    env = {
      SCOPE: {},
      CONTROL_PLANE: {},
      SESSION_SECRET: 'test-session-secret',
      CP_SERVICE_TOKEN: 'service-token',
      CONTROL_PLANE_SVC: {
        fetch: async (url: string | URL | Request, init?: RequestInit) => {
          const u = new URL(String(url));
          const path = u.pathname.replace(/^\/api/, '') + u.search;
          if (path === '/tenant-tokens') return Response.json({ token: 'tenant-token' });
          return plane.request(path, init);
        },
      },
    };
  });

  afterEach(async () => {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  });

  // What the web client's `call()` does with an answer, minus the browser: the sentence, the
  // apps, and an Error carrying both, as `ApiError` does.
  const post = async (path: string, body: object): Promise<unknown> => {
    const res = await app.request(
      `/api${path}`,
      { method: 'POST', headers: { 'content-type': 'application/json', cookie: `sb_session=${OWNER_SUB}` }, body: JSON.stringify(body) },
      env,
    );
    if (res.ok) return res.status === 204 ? undefined : res.json();
    const parsed = await res.json().catch(() => null);
    throw Object.assign(new Error(problemDetail(parsed) ?? `${res.status}`), { status: res.status, exportBreaks: exportBreaksIn(parsed) });
  };
  const ack = (on: boolean) => (on ? { acknowledge: { exportBreak: true } } : {});
  const boundTo = async () => (await host.admin.getScopeRecord(staff, tenant, appScope))?.verticalVersionId;
  // The Activity trail's "a → b" lines for the app.
  const updatedLines = async () =>
    ((await (await host.getScope(owner, tenant, dashScope)).invoke('dashboard/app-events', { appScopeId: appScope })) as {
      kind: string;
    }[]).filter((e) => e.kind === 'updated').length;

  it('an Update refused names the apps it would break, and moves nothing', async () => {
    const refused = (await post(`/apps/${appScope}/update`, {}).then(() => null, (e: unknown) => e)) as {
      status: number;
      message: string;
      exportBreaks?: unknown;
    };
    expect(refused.status).toBe(409);
    expect(refused.message).toMatch(/^this bind drops or re-versions 1 exported event type/);
    expect(refused.exportBreaks).toMatchObject([{ scopeId: deskScope, vertical: CONSUMER, type: TYPE, incoming: null }]);
    expect(await boundTo()).toBe(v.exporting);
    expect(await updatedLines()).toBe(0);
  });

  it('a Bind refused names them too; the confirm is shown them, and a yes binds', async () => {
    const shown: BrokenApp[][] = [];
    const r = await sendWithExportBreakAck(
      (on) => post(`/apps/${appScope}/bind`, { versionId: v.dropping, ...ack(on) }),
      (_refusal, apps) => (shown.push([...apps]), true),
    );
    expect(r).toBeUndefined();
    expect(shown).toHaveLength(1);
    expect(shown[0]).toMatchObject([{ vertical: CONSUMER, type: TYPE, schemaVersion: 1, incoming: null }]);
    expect(await boundTo()).toBe(v.dropping);
  });

  it('the twin: a bind that breaks nothing is never refused, so nothing is shown', async () => {
    await host.admin.bindScopeVersion(staff, tenant, deskScope, v.desk);
    const other = ulid();
    await publish(PRODUCER, other, registry({ exports: [{ type: TYPE, schemaVersion: 1, readPermission: 'ledger:read', declaredBy: ['@test/ledger'] }] }));
    let asked = 0;
    await sendWithExportBreakAck(
      (on) => post(`/apps/${appScope}/bind`, { versionId: other, ...ack(on) }),
      () => (asked++, true),
    );
    expect(asked).toBe(0);
    expect(await boundTo()).toBe(other);
  });

  it('an acknowledgement of something a bind has no gate for is refused as a malformed body, and binds nothing', async () => {
    const refused = (await post(`/apps/${appScope}/bind`, { versionId: v.dropping, acknowledge: { permissionChange: true } }).then(
      () => null,
      (e: unknown) => e,
    )) as { status: number };
    expect(refused.status).toBe(400);
    expect(await boundTo()).toBe(v.exporting);
    // The twin: the acknowledgement a bind does have is accepted.
    await post(`/apps/${appScope}/bind`, { versionId: v.dropping, acknowledge: { exportBreak: true } });
    expect(await boundTo()).toBe(v.dropping);
  });
});
