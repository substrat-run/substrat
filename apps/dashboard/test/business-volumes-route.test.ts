import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { platformActorId, principalId, scopeId, tenantId, type EmittedModel, type ScopeId } from '@substrat-run/contracts';
import { manualClock, ulid, type ManualClock, type OperationHandler } from '@substrat-run/kernel';
import { MODULES, provisionDashboard } from '../src/index.js';
import { SERVICE_TOKEN, tenantPlane } from './tenant-plane.js';
import type { BusinessVolumesAnswer } from '../src/business-volumes.js';

/**
 * `GET /api/observability/business-volumes` (#1750), end to end: the worker driven the way a
 * request reaches it, the real control plane over a SQLite host behind the service binding
 * (the `processes-route.test.ts` harness), and real events in the app scopes' outboxes counted
 * by the kernel's own `readOperationSeries`. `business-volumes.test.ts` pins the arithmetic;
 * this pins the wiring — the running version's moves, today against yesterday from one read,
 * and that another tenant's moves are never counted, never reachable, never asked for.
 *
 * Events are stamped by the host's manual clock, set back before each emit, so which day an
 * event falls in is decided here rather than by how fast the suite runs.
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
const staff = platformActorId.parse(ulid());
const SLUG = 'acme/shop';
const EMPTY_SLUG = 'acme/empty';
const OWNER_SUB = 'sub-owner';
const HOUR = 3_600_000;

// Every operation here is an edge into one state, so each is counted: `ship` leaves the
// initial state, `close` and `cancel` end the order.
const MODEL: EmittedModel = {
  entities: {},
  lifecycles: {
    order: {
      field: 'state',
      initial: 'open',
      states: {
        open: { on: { 'shop/ship': 'shipped', 'shop/cancel': 'cancelled' } },
        shipped: { on: { 'shop/close': 'closed', 'shop/cancel': 'cancelled' } },
        closed: { terminal: true },
        cancelled: { terminal: true },
      },
    },
  },
};

const emitOrder = (op: string) =>
  ((ctx, input: { id: string }) =>
    ctx.emit({ type: `order.${op}`, schemaVersion: 1, entity: { entityType: 'order', entityId: input.id }, piiClass: 'none', payload: { id: input.id } })) as OperationHandler<never, unknown>;

describe('the business volumes route (#1750)', () => {
  let dir: string;
  let host: SqliteScopeHost;
  let clock: ManualClock;
  const tenant = tenantId.parse(ulid());
  const otherTenant = tenantId.parse(ulid());
  const dashScope = scopeId.parse(ulid());
  let appScope: ScopeId;
  let emptyScope: ScopeId;
  let otherScope: ScopeId;
  let owner: ReturnType<typeof principalId.parse>;
  let env: Record<string, unknown>;
  let sabotage: ((path: string) => Response | undefined) | null;
  /** Every operation-series path that reached the plane. */
  let seriesPaths: string[];
  const version = ulid();

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'substrat-business-route-'));
    clock = manualClock(new Date());
    host = new SqliteScopeHost({ dir, clock: clock.read });
    shared.host = host;
    for (const m of MODULES) host.registerModule(m);
    for (const op of ['ship', 'close', 'cancel']) host.defineOperation(`shop/${op}`, emitOrder(op));
    sabotage = null;
    seriesPaths = [];

    owner = principalId.parse(ulid());
    await provisionDashboard(host, { tenantId: tenant, scopeId: dashScope, owner, slug: 'business', name: 'Business' });
    await host.admin.registerIdentityPool(staff, { provider: PROVIDER, topology: 'central', tenantId: null });
    await host.admin.linkIdentity(staff, { provider: PROVIDER, externalId: OWNER_SUB, principal: owner, tenantId: tenant, scopeId: dashScope });

    await host.admin.registerVertical(staff, { slug: SLUG, name: 'Shop', source: 'cli', ownerTenant: tenant });
    await host.admin.publishVersion(staff, {
      id: version,
      verticalSlug: SLUG,
      version: '1.0.0',
      manifestDigest: 'manifest',
      permissionDigest: 'perm',
      migrationDigest: 'mig',
      deploymentRef: null,
      manifestJson: JSON.stringify({
        version: '1.0.0',
        entry: 'index.js',
        compatibilityDate: '2026-07-01',
        registry: { permissions: [], roles: [], entityGrants: [] },
        digests: { manifest: 'manifest', permission: 'perm', migration: 'mig' },
        model: MODEL,
      }),
    });
    await host.admin.admitVersion(staff, version);
    await host.admin.promoteVersion(staff, SLUG, 'prod', version);
    const install = async (t: typeof tenant, slug: string, name: string, listed: boolean): Promise<ScopeId> => {
      const s = scopeId.parse(ulid());
      await host.provisionScope(staff, { tenantId: t, scopeId: s, vertical: slug });
      await host.admin.activateScope(staff, t, s);
      if (listed) await (await host.getScope(owner, tenant, dashScope)).invoke('dashboard/provision-app', { appScopeId: s, verticalSlug: slug, name });
      return s;
    };
    appScope = await install(tenant, SLUG, 'Shop', true);
    await host.admin.registerVertical(staff, { slug: EMPTY_SLUG, name: 'Empty', source: 'cli', ownerTenant: tenant });
    emptyScope = await install(tenant, EMPTY_SLUG, 'Empty', true);
    // Another tenant runs the same vertical; its scope is in no list this owner can read.
    await host.admin.createTenant(staff, { id: otherTenant, slug: 'other', name: 'Other' });
    otherScope = await install(otherTenant, SLUG, 'Other shop', false);

    const plane = tenantPlane(host, staff);
    env = {
      SCOPE: {},
      CONTROL_PLANE: {},
      SESSION_SECRET: 'test-session-secret',
      CP_SERVICE_TOKEN: SERVICE_TOKEN,
      CONTROL_PLANE_SVC: {
        fetch: async (url: string | URL | Request, init?: RequestInit) => {
          const u = new URL(String(url));
          const path = u.pathname.replace(/^\/api/, '');
          if (path.endsWith('/operation-series')) seriesPaths.push(path);
          const bad = sabotage?.(path);
          if (bad) return bad;
          return plane.request(path + u.search, init);
        },
      },
    };
  });

  afterEach(async () => {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const get = (sub: string | null, query = '') =>
    app.request(`/api/observability/business-volumes${query}`, { method: 'GET', headers: sub ? { cookie: `sb_session=${sub}` } : {} }, env);
  const read = async (query = ''): Promise<BusinessVolumesAnswer> => {
    const res = await get(OWNER_SUB, query);
    expect(res.status).toBe(200);
    return (await res.json()) as BusinessVolumesAnswer;
  };
  /** Run `ops` in a scope with the host's clock `agoMs` in the past, then restore it. */
  const at = async (agoMs: number, ops: Array<[string, string]>, t = tenant, s?: ScopeId) => {
    clock.set(new Date(Date.now() - agoMs));
    const stub = await host.getScope(owner, t, s ?? appScope);
    for (const [op, id] of ops) await stub.invoke(op, { id });
    clock.set(new Date());
  };
  const row = (body: BusinessVolumesAnswer, state: string) => body.rows.find((r) => r.scopeId === appScope && r.state === state)!;

  it("counts the running version's moves today and yesterday, with a series over the card's window", async () => {
    await at(HOUR, [['shop/ship', 'o1'], ['shop/close', 'o1']]);
    await at(2 * HOUR, [['shop/ship', 'o2']]);
    await at(30 * HOUR, [['shop/ship', 'o3'], ['shop/cancel', 'o4']]);
    await at(50 * HOUR, [['shop/ship', 'o5']]);

    const body = await read();
    expect(body.rows.filter((r) => r.scopeId === appScope).map((r) => [r.state, r.terminal, r.fromInitial, r.operations])).toEqual([
      ['cancelled', true, false, ['shop/cancel']],
      ['closed', true, false, ['shop/close']],
      ['shipped', false, true, ['shop/ship']],
    ]);
    expect(row(body, 'shipped')).toMatchObject({ today: 2, yesterday: 1 });
    expect(row(body, 'closed')).toMatchObject({ today: 1, yesterday: 0 });
    expect(row(body, 'cancelled')).toMatchObject({ today: 0, yesterday: 1 });
    // The series is the card's own 24 hours: today's moves, on Pulse's bins.
    expect(body.bucketMinutes).toBe(60);
    expect(row(body, 'shipped').buckets.reduce((n, b) => n + b.count, 0)).toBe(2);
    expect(body.apps).toContainEqual({ scopeId: appScope, unavailable: null });
    // One read for the app, never one per bucket or per day.
    expect(seriesPaths).toEqual([`/tenants/${tenant}/scopes/${appScope}/operation-series`]);
  });

  it("never counts, reaches or asks for another tenant's moves — while its own still count", async () => {
    await at(HOUR, [['shop/ship', 'mine']]);
    await at(HOUR, [['shop/ship', 'theirs-1'], ['shop/ship', 'theirs-2'], ['shop/close', 'theirs-1']], otherTenant, otherScope);

    // The positive twin: this tenant's own move is counted, and only it.
    const body = await read();
    expect(row(body, 'shipped').today).toBe(1);
    expect(row(body, 'closed').today).toBe(0);
    expect(body.rows.every((r) => r.scopeId !== otherScope)).toBe(true);
    expect(body.apps.map((a) => a.scopeId)).not.toContain(otherScope);
    // Naming the other tenant's app is a 404, never an empty series.
    expect((await get(OWNER_SUB, `?scopeId=${otherScope}`)).status).toBe(404);
    // Every read that reached the plane named this tenant and its own app.
    expect(seriesPaths.length).toBeGreaterThan(0);
    for (const p of seriesPaths) expect(p).toBe(`/tenants/${tenant}/scopes/${appScope}/operation-series`);
  });

  it('narrows to one named app', async () => {
    const body = await read(`?scopeId=${appScope}`);
    expect(body.apps).toEqual([{ scopeId: appScope, unavailable: null }]);
  });

  describe('an app with no rows says why', () => {
    it('no-version: nothing is running, so nothing is read', async () => {
      const body = await read(`?scopeId=${emptyScope}`);
      expect(body).toMatchObject({ rows: [], apps: [{ scopeId: emptyScope, unavailable: 'no-version' }] });
      expect(seriesPaths).toEqual([]);
    });

    for (const status of [404, 502]) {
      it(`not-yet-available: the series read answering ${status}, beside the apps that answered`, async () => {
        sabotage = (p) => (p.endsWith('/operation-series') ? Response.json({ error: 'no such route' }, { status }) : undefined);
        const body = await read();
        expect(body.apps).toContainEqual({ scopeId: appScope, unavailable: 'not-yet-available' });
        expect(body.apps).toContainEqual({ scopeId: emptyScope, unavailable: 'no-version' });
      });
    }

    it('any other failure of the series read fails the route', async () => {
      sabotage = (p) => (p.endsWith('/operation-series') ? Response.json({ error: 'boom' }, { status: 500 }) : undefined);
      expect((await get(OWNER_SUB)).status).toBe(500);
    });
  });

  it('refuses a request without a session, and a window past the cap', async () => {
    expect((await get(null)).status).toBe(401);
    const until = new Date().toISOString();
    const since = new Date(Date.now() - 80 * HOUR).toISOString();
    expect((await get(OWNER_SUB, `?since=${since}&until=${until}`)).status).toBe(400);
  });
});
