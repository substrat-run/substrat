import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { orgId, platformActorId, principalId, scopeId, tenantId, type TenantId } from '@substrat-run/contracts';
import { ulid } from '@substrat-run/kernel';
import { MODULES, provisionDashboard } from '../src/index.js';

const shared = vi.hoisted(() => ({
  host: null as unknown,
  scopesOpened: [] as string[],
}));

vi.mock('cloudflare:workers', () => ({ DurableObject: class {} }));
vi.mock('@substrat-run/adapter-cloudflare', () => ({
  defineScopeDO: () => class {},
  defineScopeSweeperDO: () => class {},
  SCOPE_SWEEPER_NAME: 'scope-sweeper',
  ControlPlaneDO: class {},
  CloudflareScopeHost: class {
    constructor() {
      return new Proxy(shared.host as SqliteScopeHost, {
        get(t, key) {
          if (key === 'registerModule' || key === 'registerExecutor') return () => undefined;
          if (key === 'getScope') {
            return (...args: Parameters<SqliteScopeHost['getScope']>) => {
              shared.scopesOpened.push(args[1]);
              return t.getScope(...args);
            };
          }
          const value = Reflect.get(t, key) as unknown;
          return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(t) : value;
        },
      });
    }
  },
}));
vi.mock('@substrat-run/oidc-rp', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@substrat-run/oidc-rp')>()),
  mountOidcRoutes: () => undefined,
  verifySession: async (_env: unknown, token: string | undefined) => (token ? { id: token, email: `${token}@test.invalid`, emailVerified: true } : null),
}));

const workerModule = '../src/worker.js';
const { default: app } = (await import(/* @vite-ignore */ workerModule)) as {
  default: { request(path: string, init: RequestInit, env: unknown): Response | Promise<Response> };
};

const staff = platformActorId.parse(ulid());
let dir: string;
let host: SqliteScopeHost;
let env: Record<string, unknown>;
let planeFetch: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'substrat-settings-delete-'));
  host = new SqliteScopeHost({ dir });
  shared.host = host;
  shared.scopesOpened.length = 0;
  for (const module of MODULES) host.registerModule(module);
  await host.admin.registerIdentityPool(staff, { provider: 'authhero', topology: 'central', tenantId: null });
  planeFetch = vi.fn(async () => new Response('unavailable', { status: 503 }));
  env = {
    SCOPE: {}, CONTROL_PLANE: {}, SESSION_SECRET: 'test-session-secret',
    CONTROL_PLANE_SVC: { fetch: planeFetch }, CP_SERVICE_TOKEN: 'test-service-token',
  };
});

afterEach(async () => {
  await host.close();
  rmSync(dir, { recursive: true, force: true });
});

async function team(sub: string, name: string) {
  const tenant = tenantId.parse(ulid());
  const dashScope = scopeId.parse(ulid());
  const owner = principalId.parse(ulid());
  await provisionDashboard(host, { tenantId: tenant, scopeId: dashScope, owner, slug: `t-${tenant.slice(-6).toLowerCase()}`, name });
  const org = orgId.parse(ulid());
  await host.admin.createOrg(staff, { id: org, tenantId: tenant, slug: 'team', name });
  await (await host.getScope(owner, tenant, dashScope)).invoke('dashboard/init-team', { orgId: org, ownerEmail: `${sub}@test.invalid` });
  await host.admin.linkIdentity(staff, { provider: 'authhero', externalId: sub, principal: owner, tenantId: tenant, scopeId: dashScope });
  return { tenant, dashScope, owner };
}

function deleteTeam(pathTeam: TenantId, confirm: string, sub = 'owner', cookieTeam?: TenantId) {
  const cookie = `sb_session=${sub}${cookieTeam ? `; sb_team=${cookieTeam}` : ''}`;
  return app.request(`/api/teams/${pathTeam}/delete`, {
    method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ confirm }),
  }, env);
}

describe('Settings delete on the team path (#2170)', () => {
  it('a second tab changing the cookie cannot change which team is deleted', async () => {
    const a = await team('owner', 'Team A');
    const b = await team('owner', 'Team B');
    const res = await deleteTeam(b.tenant, 'Team B', 'owner', a.tenant);
    expect(res.status, await res.clone().text()).toBe(200);
    expect(await res.json()).toEqual({ deleted: true });
    expect((await host.admin.getTenant(staff, b.tenant))?.status).toBe('deleting');
    expect((await host.admin.getTenant(staff, a.tenant))?.status).not.toBe('deleting');
    expect(res.headers.get('set-cookie')).toMatch(/sb_team=;/);
  });

  it('refuses a non-owner before platform effects, even with the correct name', async () => {
    const t = await team('owner', 'Team A');
    const member = principalId.parse(ulid());
    await host.admin.linkIdentity(staff, { provider: 'authhero', externalId: 'member', principal: member, tenantId: t.tenant, scopeId: t.dashScope });
    await host.admin.grant(staff, { principalId: member, permission: 'dashboard:read', node: { tenantId: t.tenant, scopeId: null }, grantedBy: t.owner });
    const res = await deleteTeam(t.tenant, 'Team A', 'member');
    expect(res.status, await res.clone().text()).toBe(403);
    expect((await host.admin.getTenant(staff, t.tenant))?.status).not.toBe('deleting');
    expect(planeFetch).not.toHaveBeenCalled();
  });

  it('refuses a path team the caller is not in with 404 before its scope or the plane is touched', async () => {
    const a = await team('owner', 'Team A');
    const b = await team('other', 'Team B');
    shared.scopesOpened.length = 0;
    const res = await deleteTeam(b.tenant, 'Team B', 'owner', a.tenant);
    expect(res.status, await res.clone().text()).toBe(404);
    expect(shared.scopesOpened).not.toContain(b.tenant);
    expect(planeFetch).not.toHaveBeenCalled();
    expect((await host.admin.getTenant(staff, b.tenant))?.status).not.toBe('deleting');
  });

  it('checks confirmation against the path team, not the cookie team', async () => {
    const a = await team('owner', 'Team A');
    const b = await team('owner', 'Team B');
    const res = await deleteTeam(b.tenant, 'Team A', 'owner', a.tenant);
    expect(res.status, await res.clone().text()).toBe(400);
    expect((await host.admin.getTenant(staff, b.tenant))?.status).not.toBe('deleting');
    expect(planeFetch).not.toHaveBeenCalled();
  });

  it('the old cookie-scoped endpoint is gone', async () => {
    await team('owner', 'Team A');
    const res = await app.request('/api/teams/delete', {
      method: 'POST', headers: { cookie: 'sb_session=owner', 'content-type': 'application/json' }, body: JSON.stringify({ confirm: 'Team A' }),
    }, env);
    expect(res.status).toBe(404);
  });
});
