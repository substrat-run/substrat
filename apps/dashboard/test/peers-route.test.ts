import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { platformActorId, principalId, scopeId, tenantId, type ScopeId } from '@substrat-run/contracts';
import { ulid } from '@substrat-run/kernel';
import { MODULES, provisionDashboard } from '../src/index.js';
import { SERVICE_TOKEN, tenantPlane } from './tenant-plane.js';

/**
 * The app's peer panel (#1706), driven through the route over a real control plane (#2252).
 *
 * A push pinned to a tenant registers `<tenantSlug>/<slug>`, and a version declares the bare
 * `<slug>`. The panel used to read `GET /scopes?vertical=<slug>`, whose exact filter never
 * returns the pinned row, so the picker was empty and the call read "not installed". This
 * drives the route end to end — the directory read it makes, not a list a test built.
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

// Named through a variable: `tsconfig.json` excludes `src/worker.ts` (see findings-role-gate).
const workerModule = '../src/worker.js';
const { default: app } = (await import(/* @vite-ignore */ workerModule)) as {
  default: { request(path: string, init: RequestInit, env: unknown, ctx?: unknown): Response | Promise<Response> };
};

const PROVIDER = 'authhero';
const staff = platformActorId.parse(ulid());

interface PeersBody {
  calls: Array<{ state: string; vertical: string; scopeId?: string }>;
  bindingChoices: Array<{ vertical: string; boundScopeId: string | null; candidates: Array<{ scopeId: string }> }>;
}

describe('the peer panel reads a tenant-pinned install (#2252)', () => {
  let dir: string;
  let host: SqliteScopeHost;
  let env: Record<string, unknown>;
  let background: Promise<unknown>[];
  const tenant = tenantId.parse(ulid());
  const dashScope = scopeId.parse(ulid());
  const caller = scopeId.parse(ulid());
  const pinned = scopeId.parse(ulid());
  const foreign = scopeId.parse(ulid());

  const install = async (id: ScopeId, vertical: string) => {
    await host.provisionScope(staff, { tenantId: tenant, scopeId: id, vertical });
    await host.admin.activateScope(staff, tenant, id);
  };

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'substrat-peers-route-'));
    host = new SqliteScopeHost({ dir });
    shared.host = host;
    background = [];
    for (const m of MODULES) host.registerModule(m);
    await host.admin.registerIdentityPool(staff, { provider: PROVIDER, topology: 'central', tenantId: null });
    const p = principalId.parse(ulid());
    const node = await provisionDashboard(host, { tenantId: tenant, scopeId: dashScope, owner: p, slug: 'first', name: 'first' });
    await host.admin.linkIdentity(staff, { provider: PROVIDER, externalId: 'sub-owner', principal: p, tenantId: tenant, scopeId: dashScope });
    const dash = await host.getScope(node.principal, node.tenantId, node.scopeId);
    await dash.invoke('dashboard/provision-app', { appScopeId: caller, verticalSlug: 'first/board-room', name: 'board' });
    await install(caller, 'first/board-room');
    await install(pinned, 'first/crm');
    // Another tenant's listed vertical of the same name, installed here: another vertical.
    await install(foreign, 'acme/crm');

    const plane = tenantPlane(host, staff);
    env = {
      SCOPE: {},
      CONTROL_PLANE: {},
      SESSION_SECRET: 'test-session-secret',
      CP_SERVICE_TOKEN: SERVICE_TOKEN,
      CONTROL_PLANE_SVC: {
        fetch: async (url: string | URL | Request, init?: RequestInit) => {
          const u = new URL(String(url));
          return plane.request(u.pathname.replace(/^\/api/, '') + u.search, init);
        },
      },
    };
  });

  afterEach(async () => {
    await Promise.allSettled(background);
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const peers = async (): Promise<PeersBody> => {
    const res = await app.request(
      `/api/apps/${caller}/peers`,
      { headers: { cookie: `sb_session=sub-owner; sb_team=${tenant}` } },
      env,
      { waitUntil: (p: Promise<unknown>) => void background.push(p), passThroughOnException: () => undefined },
    );
    expect(res.status).toBe(200);
    return (await res.json()) as PeersBody;
  };

  it('the bare name binds to the pinned install, which the picker offers and the panel resolves', async () => {
    // The binding write takes the same rule: the pinned install is a live instance of `crm`.
    await host.admin.setPeerBinding(staff, tenant, caller, 'crm', pinned);
    const body = await peers();
    const choice = body.bindingChoices.find((c) => c.vertical === 'crm')!;
    // The pinned install is offered; another tenant's `acme/crm` is not.
    expect(choice.candidates.map((c) => c.scopeId)).toEqual([pinned]);
    expect(choice.boundScopeId).toBe(pinned);
    const call = body.calls.find((c) => c.vertical === 'crm')!;
    expect(call.state).not.toBe('not-installed');
    expect(call.state).not.toBe('bound-unavailable');
  });

  it('another tenant\'s prefix cannot be bound for the bare name', async () => {
    await expect(host.admin.setPeerBinding(staff, tenant, caller, 'crm', foreign)).rejects.toThrow();
  });
});
