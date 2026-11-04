import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import type { LakeQueryEngine } from '@substrat-run/control-plane-api';
import { platformActorId, principalId, scopeId, tenantId } from '@substrat-run/contracts';
import { ulid } from '@substrat-run/kernel';
import { MODULES, provisionDashboard } from '../src/index.js';
import { SERVICE_TOKEN, tenantPlane } from './tenant-plane.js';

/**
 * The team's lake events (#1334): `dashboard:read-event-lake` is checked in the dashboard's own
 * scope before the plane is asked, and the plane is asked for the team the URL names. Drives the
 * WORKER, as `findings-role-gate.test.ts` does, because the fact under test is that the route
 * calls its gate.
 */

const shared = vi.hoisted(() => ({ host: null as unknown }));

vi.mock('cloudflare:workers', () => ({ DurableObject: class {} }));
vi.mock('@substrat-run/adapter-cloudflare', () => ({
  defineScopeDO: () => class {},
  defineScopeSweeperDO: () => class {},
  SCOPE_SWEEPER_NAME: 'scope-sweeper',
  ControlPlaneDO: class {},
  CloudflareScopeHost: class {
    constructor() {
      const target = shared.host as object;
      return new Proxy(target, {
        get(t, key) {
          if (key === 'registerModule' || key === 'registerExecutor') return () => undefined;
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

// Through a variable: `tsconfig.json` excludes `src/worker.ts` (see findings-role-gate.test.ts).
const workerModule = '../src/worker.js';
const { default: app } = (await import(/* @vite-ignore */ workerModule)) as {
  default: { request(path: string, init: RequestInit, env: unknown): Response | Promise<Response> };
};

const PROVIDER = 'authhero';
const staff = platformActorId.parse(ulid());
const WINDOW = `since=${encodeURIComponent('2026-10-01T00:00:00.000Z')}&until=${encodeURIComponent('2026-10-31T00:00:00.000Z')}`;

describe('GET /api/teams/:team/lake/events (#1334)', () => {
  let dir: string;
  let host: SqliteScopeHost;
  const tenant = tenantId.parse(ulid());
  const dashScope = scopeId.parse(ulid());
  const appScope = scopeId.parse(ulid());
  const eventId = ulid();
  const subs = { owner: 'sub-owner', admin: 'sub-admin', member: 'sub-member', viewer: 'sub-viewer' } as const;
  /** Every SQL statement the lake was asked. A refused route leaves this empty. */
  let asked: string[];
  /** Every request that reached the plane, the token mint included. */
  let planeCalls: number;
  const engine: LakeQueryEngine = {
    async query(sql) {
      asked.push(sql);
      return [{
        id: eventId, type: 'todo.item-created', schema_version: 1, occurred_at: '2026-10-02T00:00:00.000Z',
        tenant_id: tenant, scope_id: appScope, actor: principalId.parse(ulid()), entity_type: 'item', entity_id: 'item-1',
        pii_class: 'none', operation: 'todo/create-item', version: null, caused_by: null, invocation_id: null, impersonated: false,
      }];
    },
  };
  const envWith = (lakeQuery?: LakeQueryEngine) => {
    const plane = tenantPlane(host, staff, lakeQuery ? { lakeQuery } : {});
    return {
      SCOPE: {},
      CONTROL_PLANE: {},
      SESSION_SECRET: 'test-session-secret',
      CP_SERVICE_TOKEN: SERVICE_TOKEN,
      CONTROL_PLANE_SVC: {
        fetch: async (url: string | URL | Request, init?: RequestInit) => {
          planeCalls += 1;
          const u = new URL(String(url));
          return plane.request(u.pathname.replace(/^\/api/, '') + u.search, init);
        },
      },
    };
  };
  const get = (role: keyof typeof subs, query: string, env = envWith(engine)) =>
    app.request(`/api/teams/${tenant}/lake/events?${query}`, { headers: { cookie: `sb_session=${subs[role]}` } }, env);

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'substrat-lake-route-'));
    host = new SqliteScopeHost({ dir });
    shared.host = host;
    for (const m of MODULES) host.registerModule(m);
    const owner = principalId.parse(ulid());
    await provisionDashboard(host, { tenantId: tenant, scopeId: dashScope, owner, slug: 'lake', name: 'Lake' });
    await host.admin.registerIdentityPool(staff, { provider: PROVIDER, topology: 'central', tenantId: null });
    const link = (sub: string, principal: typeof owner) =>
      host.admin.linkIdentity(staff, { provider: PROVIDER, externalId: sub, principal, tenantId: tenant, scopeId: dashScope });
    await link(subs.owner, owner);
    for (const role of ['admin', 'member', 'viewer'] as const) {
      const p = principalId.parse(ulid());
      await host.admin.assignRole(staff, { principalId: p, roleKey: role, node: { tenantId: tenant, scopeId: null } });
      await link(subs[role], p);
    }
  });
  afterAll(async () => {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  });
  beforeEach(() => {
    asked = [];
    planeCalls = 0;
  });

  it("an owner and an admin read the team's events, asked of the lake for this team only", async () => {
    for (const role of ['owner', 'admin'] as const) {
      const res = await get(role, WINDOW);
      expect(res.status, role).toBe(200);
      expect(await res.json()).toMatchObject({
        available: true,
        events: [{ id: eventId, scopeId: appScope }],
        nextCursor: null,
        consistency: 'eventual',
      });
    }
    expect(asked).toHaveLength(2);
    for (const sql of asked) expect(sql).toContain(`WHERE tenant_id = '${tenant}'`);
  });

  it('a member and a viewer are refused before the lake is asked', async () => {
    for (const role of ['member', 'viewer'] as const) expect((await get(role, WINDOW)).status, role).toBe(403);
    expect(asked).toEqual([]);
  });

  it('a read naming a tenant is refused before the lake is asked', async () => {
    expect((await get('owner', `${WINDOW}&tenantId=${tenantId.parse(ulid())}`)).status).toBe(400);
    expect(asked).toEqual([]);
  });

  it("a read with no since is the declaration's 400, before the plane is asked anything", async () => {
    expect((await get('owner', '')).status).toBe(400);
    expect(planeCalls).toBe(0);
  });

  it('a plane with no lake answers available: false, not an empty history', async () => {
    const res = await get('owner', WINDOW, envWith());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ available: false, events: [], nextCursor: null, consistency: 'eventual' });
  });
});
