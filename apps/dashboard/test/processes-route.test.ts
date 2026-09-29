import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { createControlPlaneApi, UNSAFE_devPlatformActorAuth } from '@substrat-run/control-plane-api';
import { platformActorId, principalId, scopeId, tenantId, type EmittedModel, type ScopeId } from '@substrat-run/contracts';
import { manualClock, ulid, type ManualClock, type OperationHandler } from '@substrat-run/kernel';
import { MODULES, provisionDashboard } from '../src/index.js';
import { PROCESS_PERIODS, type ProcessMapAnswer } from '../src/process-map.js';

/**
 * `GET /api/apps/:scopeId/processes` (#1744), end to end: the worker driven the way a request
 * reaches it, the real control plane over a SQLite host behind the service binding (the
 * `promote-review-route.test.ts` harness), and real events in the app scope's outbox replayed
 * by the kernel's own `readLifecycleFlow`. `process-map.test.ts` pins the window arithmetic;
 * this pins the wiring around it — that the lifecycle replayed is the one the RUNNING version
 * declares (not prod's head), that the previous window is the one before, and that each reason
 * there is no map answers as itself rather than as an error.
 *
 * Events are stamped by the host's manual clock, set back before each emit, so which window an
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
const SLUG = 'acme/desk';
const EMPTY_SLUG = 'acme/empty';
const OWNER_SUB = 'sub-owner';
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

// `order` is declared AFTER `ticket` on purpose: the default is the first of the list the
// screen shows (sorted by entity), not the first key in the file.
const RUNNING_MODEL: EmittedModel = {
  entities: {},
  lifecycles: {
    ticket: { field: 'status', initial: 'new', states: { new: { on: { 'desk/solve': 'solved' } }, solved: { terminal: true } } },
    order: {
      field: 'state',
      initial: 'open',
      states: {
        open: { on: { 'desk/advance': 'shipped' } },
        shipped: { on: { 'desk/advance': 'closed' } },
        closed: { terminal: true },
      },
    },
  },
};
// What prod's head declares — a different machine, so a route reading it would show.
const PROD_MODEL: EmittedModel = {
  entities: {},
  lifecycles: { shipment: { field: 'state', initial: 'packed', states: { packed: { terminal: true } } } },
};
const BARE_MODEL: EmittedModel = { entities: {} };

// Harness operations, defined bare on the host: they exist to put rows in the outbox, and the
// replay reads the operation name each row carries — which is all a declared edge matches on.
const emitOrder = (ctx: Parameters<OperationHandler<never, unknown>>[0], id: string, state: string) =>
  ctx.emit({ type: 'order.moved', schemaVersion: 1, entity: { entityType: 'order', entityId: id }, piiClass: 'none', payload: { id, state } });
const openOrder = ((ctx, input: { id: string }) => emitOrder(ctx, input.id, 'open')) as OperationHandler<never, unknown>;
const advanceOrder = ((ctx, input: { id: string; to: string }) => emitOrder(ctx, input.id, input.to)) as OperationHandler<never, unknown>;

describe('the process map route (#1744)', () => {
  let dir: string;
  let host: SqliteScopeHost;
  let clock: ManualClock;
  const tenant = tenantId.parse(ulid());
  const dashScope = scopeId.parse(ulid());
  let appScope: ScopeId;
  let emptyScope: ScopeId;
  let owner: ReturnType<typeof principalId.parse>;
  let env: Record<string, unknown>;
  /** Set per test to make the plane misbehave on a path. */
  let sabotage: ((path: string) => Response | Promise<Response> | undefined) | null;
  /** Every lifecycle-flow body that reached the plane. */
  let flowBodies: Array<Record<string, unknown>>;
  const v = { running: ulid(), prod: ulid(), bare: ulid() };

  const publish = async (id: string, version: string, model: EmittedModel) => {
    await host.admin.publishVersion(staff, {
      id,
      verticalSlug: SLUG,
      version,
      manifestDigest: `manifest-${version}`,
      permissionDigest: 'perm',
      migrationDigest: 'mig',
      deploymentRef: null,
      manifestJson: JSON.stringify({
        version,
        entry: 'index.js',
        compatibilityDate: '2026-07-01',
        registry: { permissions: [], roles: [], entityGrants: [] },
        digests: { manifest: `manifest-${version}`, permission: 'perm', migration: 'mig' },
        model,
      }),
    });
    await host.admin.admitVersion(staff, id);
  };
  const install = async (slug: string, name: string): Promise<ScopeId> => {
    const s = scopeId.parse(ulid());
    await host.provisionScope(staff, { tenantId: tenant, scopeId: s, vertical: slug });
    await host.admin.activateScope(staff, tenant, s);
    await (await host.getScope(owner, tenant, dashScope)).invoke('dashboard/provision-app', { appScopeId: s, verticalSlug: slug, name });
    return s;
  };

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'substrat-processes-route-'));
    clock = manualClock(new Date());
    host = new SqliteScopeHost({ dir, clock: clock.read });
    shared.host = host;
    for (const m of MODULES) host.registerModule(m);
    host.defineOperation('desk/open', openOrder);
    host.defineOperation('desk/advance', advanceOrder);
    sabotage = null;
    flowBodies = [];

    owner = principalId.parse(ulid());
    await provisionDashboard(host, { tenantId: tenant, scopeId: dashScope, owner, slug: 'processes', name: 'Processes' });
    await host.admin.registerIdentityPool(staff, { provider: PROVIDER, topology: 'central', tenantId: null });
    await host.admin.linkIdentity(staff, { provider: PROVIDER, externalId: OWNER_SUB, principal: owner, tenantId: tenant, scopeId: dashScope });

    await host.admin.registerVertical(staff, { slug: SLUG, name: 'Desk', source: 'cli', ownerTenant: tenant });
    await publish(v.running, '1.0.0', RUNNING_MODEL);
    await publish(v.prod, '2.0.0', PROD_MODEL);
    await publish(v.bare, '0.9.0', BARE_MODEL);
    // Prod has moved on; the app is still pinned to the version it was installed at.
    await host.admin.promoteVersion(staff, SLUG, 'prod', v.prod);
    appScope = await install(SLUG, 'Desk');
    await host.admin.bindScopeVersion(staff, tenant, appScope, v.running);
    // A vertical with nothing published: no pin and no prod channel, so nothing runs.
    await host.admin.registerVertical(staff, { slug: EMPTY_SLUG, name: 'Empty', source: 'cli', ownerTenant: tenant });
    emptyScope = await install(EMPTY_SLUG, 'Empty');

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
          if (u.pathname.endsWith('/lifecycle-flow')) flowBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
          const bad = sabotage?.(u.pathname.replace(/^\/api/, ''));
          if (bad) return bad;
          return plane.request(path, init);
        },
      },
    };
  });

  afterEach(async () => {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const get = (sub: string | null, path: string) =>
    app.request(path, { method: 'GET', headers: sub ? { cookie: `sb_session=${sub}` } : {} }, env);
  const processes = (scope: ScopeId, query = '') => `/api/apps/${scope}/processes${query}`;
  const read = async (scope: ScopeId, query = ''): Promise<ProcessMapAnswer> => {
    const res = await get(OWNER_SUB, processes(scope, query));
    expect(res.status).toBe(200);
    return (await res.json()) as ProcessMapAnswer;
  };
  /** Run `ops` in the app scope with the host's clock `agoMs` in the past, then restore it. */
  const at = async (agoMs: number, ops: Array<[string, object]>) => {
    clock.set(new Date(Date.now() - agoMs));
    const stub = await host.getScope(owner, tenant, appScope);
    for (const [op, input] of ops) await stub.invoke(op, input);
    clock.set(new Date());
  };

  it('replays the lifecycle the RUNNING version declares, defaulting to the first one listed', async () => {
    const body = await read(appScope);
    expect(body.versionId).toBe(v.running);
    // Not prod's `shipment`: the machine is the one the running code was built from.
    expect(body.processes).toEqual([
      { entity: 'order', initial: 'open', states: 3, edges: 2 },
      { entity: 'ticket', initial: 'new', states: 2, edges: 1 },
    ]);
    expect(body.entity).toBe('order');
    // The machine the screen lays out is the one the counts were replayed against.
    expect(body.lifecycle).toEqual(RUNNING_MODEL.lifecycles!.order);
    expect(body.period).toBe('7d');
    expect(body.unavailable).toBeNull();
    expect(body.current!.entityType).toBe('order');
    expect(body.previous!.entityType).toBe('order');
  });

  it('names another declared lifecycle with `entity`', async () => {
    const body = await read(appScope, '?entity=ticket');
    expect(body.entity).toBe('ticket');
    expect(body.lifecycle).toEqual(RUNNING_MODEL.lifecycles!.ticket);
    expect(body.current!.entityType).toBe('ticket');
    expect(body.current!.edges.map((e) => [e.from, e.to, e.count])).toEqual([['new', 'solved', 0]]);
  });

  it('answers the asked period and the one before it, from real events', async () => {
    // Previous window: o0 runs to the end; o8 and o9 open and stay open.
    await at(8 * DAY, [
      ['desk/open', { id: 'o0' }],
      ['desk/advance', { id: 'o0', to: 'shipped' }],
      ['desk/advance', { id: 'o0', to: 'closed' }],
      ['desk/open', { id: 'o8' }],
      ['desk/open', { id: 'o9' }],
    ]);
    // Current window: o1 opens and ships; o2 only opens.
    await at(HOUR, [
      ['desk/open', { id: 'o1' }],
      ['desk/advance', { id: 'o1', to: 'shipped' }],
      ['desk/open', { id: 'o2' }],
    ]);

    const { current, previous } = await read(appScope);
    const edge = (r: typeof current, from: string, to: string) => r!.edges.find((e) => e.from === from && e.to === to)!.count;
    const state = (r: typeof current, s: string) => r!.states.find((x) => x.state === s)!;

    expect(edge(current, 'open', 'shipped')).toBe(1);
    expect(edge(current, 'shipped', 'closed')).toBe(0);
    expect(current!.totals).toMatchObject({ started: 2, finished: 0, inFlight: 4 });
    // "Current" is as of `until`: o0 closed in the previous window and is still counted there.
    expect(state(current, 'closed').current).toBe(1);
    expect(state(current, 'open').current).toBe(3);
    expect(state(current, 'open').stuck.map((s) => s.entityId)).toEqual(['o8', 'o9', 'o2']);

    expect(edge(previous, 'open', 'shipped')).toBe(1);
    expect(edge(previous, 'shipped', 'closed')).toBe(1);
    expect(previous!.totals).toMatchObject({ started: 3, finished: 1, inFlight: 2 });
    // `stuckLimit: 1` on the previous window: the comparison needs the counts, not the list.
    expect(state(previous, 'open').current).toBe(2);
    expect(state(previous, 'open').stuck.map((s) => s.entityId)).toEqual(['o8']);
  });

  it('sends the two windows back to back, each as long as the period', async () => {
    for (const period of ['24h', '7d', '30d'] as const) {
      flowBodies = [];
      const body = await read(appScope, `?period=${period}`);
      expect(body.period).toBe(period);
      expect(flowBodies).toHaveLength(2);
      const [cur, prev] = flowBodies as Array<{ since: string; until: string; stuckLimit?: number; entityType: string; lifecycle: unknown }>;
      const span = (w: { since: string; until: string }) => Date.parse(w.until) - Date.parse(w.since);
      expect(span(cur!)).toBe(PROCESS_PERIODS[period]);
      expect(span(prev!)).toBe(PROCESS_PERIODS[period]);
      expect(prev!.until).toBe(cur!.since);
      expect(cur!.stuckLimit).toBeUndefined();
      expect(prev!.stuckLimit).toBe(1);
      // The declaration travels in the body, exactly as the running model emits it.
      expect(cur!.entityType).toBe('order');
      expect(cur!.lifecycle).toEqual(RUNNING_MODEL.lifecycles!.order);
      expect(body.current!.since).toBe(cur!.since);
      expect(body.previous!.until).toBe(prev!.until);
    }
  });

  it('refuses an entity the running version declares no lifecycle for, and a period it does not know', async () => {
    expect((await get(OWNER_SUB, processes(appScope, '?entity=nope'))).status).toBe(404);
    // Declared by prod's head, not by what runs.
    expect((await get(OWNER_SUB, processes(appScope, '?entity=shipment'))).status).toBe(404);
    expect((await get(OWNER_SUB, processes(appScope, '?period=1y'))).status).toBe(400);
    expect(flowBodies).toEqual([]);
  });

  describe('no map, each for its own reason', () => {
    it('no-version: nothing runs', async () => {
      const body = await read(emptyScope);
      expect(body).toEqual({
        versionId: null,
        processes: [],
        entity: null,
        lifecycle: null,
        period: '7d',
        current: null,
        previous: null,
        unavailable: 'no-version',
      });
      expect(flowBodies).toEqual([]);
    });

    it('no-lifecycles: the running version declares none — even with an entity named', async () => {
      await host.admin.bindScopeVersion(staff, tenant, appScope, v.bare);
      for (const query of ['', '?entity=order']) {
        const body = await read(appScope, query);
        expect(body).toMatchObject({ versionId: v.bare, processes: [], entity: null, current: null, previous: null, unavailable: 'no-lifecycles' });
      }
      expect(flowBodies).toEqual([]);
    });

    // The model is there and names the lifecycle; only the app's deployed code predates the
    // read. The processes still list, so the screen can say what a re-push would draw.
    for (const status of [404, 502]) {
      it(`not-yet-available: the lifecycle read answering ${status}`, async () => {
        sabotage = (p) => (p.endsWith('/lifecycle-flow') ? Response.json({ error: 'no such route' }, { status }) : undefined);
        const body = await read(appScope);
        expect(body).toMatchObject({ versionId: v.running, entity: 'order', current: null, previous: null, unavailable: 'not-yet-available' });
        // Still carried, so the screen can draw the machine a re-push would fill in.
        expect(body.lifecycle).toEqual(RUNNING_MODEL.lifecycles!.order);
        expect(body.processes.map((p) => p.entity)).toEqual(['order', 'ticket']);
      });
    }

    it('any other failure of the lifecycle read fails the route', async () => {
      sabotage = (p) => (p.endsWith('/lifecycle-flow') ? Response.json({ error: 'boom' }, { status: 500 }) : undefined);
      expect((await get(OWNER_SUB, processes(appScope))).status).toBe(500);
    });
  });

  it('is refused without a session, and for a scope the team has no app on', async () => {
    expect((await get(null, processes(appScope))).status).toBe(401);
    expect((await get(OWNER_SUB, processes(scopeId.parse(ulid())))).status).toBe(404);
  });
});
