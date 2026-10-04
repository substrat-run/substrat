import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { orgId, platformActorId, principalId, scopeId, tenantId, type OrgId, type PrincipalId } from '@substrat-run/contracts';
import { ulid, type HostAdmin, type ScopeHost } from '@substrat-run/kernel';
import { MODULES, provisionDashboard } from '../src/index.js';
import { DASHBOARD_CP_ACTOR, registerDashboardMembership } from '../src/membership.js';

/**
 * `POST /api/invites/accept` once the membership executor effects the join (#1184), driven
 * through the WORKER over a SQLite host (the seams the worker cannot run in Node replaced as
 * in invite-link-route.test.ts). The accept answers what the executor did inline: 200 joined,
 * 202 accepted with access pending on the backstop, 409 refused because whoever sent the
 * invite no longer holds what it grants. A refusal is also in the executor journal, with the
 * missing permissions, for an admin to read.
 */
const shared = vi.hoisted(() => ({
  host: null as unknown,
  sessions: new Map<string, { id: string; email: string; name: string; emailVerified: boolean }>(),
}));

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
  verifySession: async (_env: unknown, token: string | undefined) => (token ? (shared.sessions.get(token) ?? null) : null),
}));

const workerModule = '../src/worker.js';
const { default: app } = (await import(/* @vite-ignore */ workerModule)) as {
  default: { request(path: string, init: RequestInit, env: unknown): Response | Promise<Response> };
};

const PROVIDER = 'authhero';
const staff = platformActorId.parse(ulid());

let dir: string;
let host: SqliteScopeHost;
let env: Record<string, unknown>;
let noteScope: ReturnType<typeof vi.fn>;
/** How many of the executor's next `addMember` calls fail — the transient failure the backstop absorbs. */
let failNextAdds = 0;

/**
 * The host the executor is mounted on: the SQLite host, except that its attributed view's
 * `addMember` can be made to fail. Everything else is the host's own.
 */
function flakyHost(real: SqliteScopeHost): ScopeHost {
  const flaky = (admin: HostAdmin): HostAdmin =>
    new Proxy(admin, {
      get(t, key) {
        if (key === 'addMember' && failNextAdds > 0) {
          return async () => {
            failNextAdds -= 1;
            throw new Error('directory unavailable');
          };
        }
        return Reflect.get(t, key) as unknown;
      },
    });
  return new Proxy(real, {
    get(t, key) {
      if (key === 'attributed') return (o: Parameters<NonNullable<ScopeHost['attributed']>>[0]) => ({ admin: flaky(t.attributed(o).admin) });
      const v = Reflect.get(t, key) as unknown;
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(t) : v;
    },
  }) as unknown as ScopeHost;
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'substrat-accept-membership-'));
  host = new SqliteScopeHost({ dir });
  shared.host = host;
  shared.sessions.clear();
  failNextAdds = 0;
  for (const m of MODULES) host.registerModule(m);
  // The worker mounts it on every per-request host; the proxy above no-ops that, so once here.
  registerDashboardMembership(flakyHost(host));
  noteScope = vi.fn(async () => ({ scopes: 1 }));
  env = {
    SCOPE: {},
    CONTROL_PLANE: {},
    SESSION_SECRET: 'test-session-secret',
    EMAIL: { send: vi.fn(async () => ({ delivered: ['x'], queued: [], permanent_bounces: [] })) },
    SWEEPER: { idFromName: (name: string) => name, get: () => ({ noteScope }) },
    // `/api/members/remove` severs the shared plane's mirrored link best-effort; a plane that
    // answers nothing useful is enough for that, and nothing here reads it.
    CONTROL_PLANE_SVC: { fetch: async () => new Response('unavailable', { status: 503 }) },
    CP_SERVICE_TOKEN: 'test-service-token',
  };
  await host.admin.registerIdentityPool(staff, { provider: PROVIDER, topology: 'central', tenantId: null });
});

afterEach(async () => {
  await host.close();
  rmSync(dir, { recursive: true, force: true });
});

interface Team {
  tenant: ReturnType<typeof tenantId.parse>;
  dashScope: ReturnType<typeof scopeId.parse>;
  owner: PrincipalId;
  org: OrgId;
}

/** A seeded team whose owner is signed in as `sub-owner`. */
async function team(): Promise<Team> {
  const tenant = tenantId.parse(ulid());
  const dashScope = scopeId.parse(ulid());
  const owner = principalId.parse(ulid());
  await provisionDashboard(host, { tenantId: tenant, scopeId: dashScope, owner, slug: `t-${tenant.slice(-6).toLowerCase()}`, name: 'Team' });
  const org = orgId.parse(ulid());
  await host.admin.createOrg(staff, { id: org, tenantId: tenant, slug: 'team', name: 'Team' });
  await (await host.getScope(owner, tenant, dashScope)).invoke('dashboard/init-team', { orgId: org, ownerEmail: 'owner@team.test' });
  await host.admin.linkIdentity(staff, { provider: PROVIDER, externalId: 'sub-owner', principal: owner, tenantId: tenant, scopeId: dashScope });
  shared.sessions.set('sub-owner', { id: 'sub-owner', email: 'owner@team.test', name: 'Owner', emailVerified: true });
  return { tenant, dashScope, owner, org };
}

const json = (sub: string) => ({ cookie: `sb_session=${sub}`, 'content-type': 'application/json' });

/** `from` invites `email` at `roleKey`; returns the token in the accept link. */
async function invite(from: string, email: string, roleKey: string): Promise<{ token: string; invitationId: string }> {
  const sent = await app.request('/api/members/invite', { method: 'POST', headers: json(from), body: JSON.stringify({ email, roleKey }) }, env);
  expect(sent.status, await sent.clone().text()).toBe(201);
  const { invitationId, acceptUrl } = (await sent.json()) as { invitationId: string; acceptUrl: string };
  return { token: acceptUrl.split('/invite/')[1]!, invitationId };
}

/** `sub` signs in at `email` and accepts. */
async function accept(sub: string, email: string, token: string): Promise<Response> {
  shared.sessions.set(sub, { id: sub, email, name: sub, emailVerified: true });
  return app.request('/api/invites/accept', { method: 'POST', headers: json(sub), body: JSON.stringify({ token }) }, env);
}

const principalOf = (t: Team, sub: string) => host.admin.resolveIdentity(t.tenant, PROVIDER, sub);

const roster = async (t: Team) =>
  (await (await host.getScope(t.owner, t.tenant, t.dashScope)).invoke('dashboard/list-members', {})) as {
    email: string;
    status: string;
    principal: string | null;
  }[];

/** Whether `p` can read the team — what any dashboard role confers. */
async function canRead(t: Team, p: PrincipalId): Promise<boolean> {
  try {
    await (await host.getScope(p, t.tenant, t.dashScope)).invoke('dashboard/list-members', {});
    return true;
  } catch {
    return false;
  }
}

describe('POST /api/invites/accept — the membership executor answers the accept (#1184)', () => {
  it('200: joined inline — role, org membership and identity link, with the trail correlated', async () => {
    const t = await team();
    const { token } = await invite('sub-owner', 'rae@team.test', 'member');
    const res = await accept('sub-rae', 'rae@team.test', token);
    expect(res.status, await res.clone().text()).toBe(200);
    expect(await res.json()).toEqual({ teamId: t.tenant });

    const rae = (await principalOf(t, 'sub-rae'))!.principal;
    expect(await canRead(t, rae)).toBe(true);
    expect((await host.admin.listMembers(staff, t.tenant, t.org)).map((m) => m.principal)).toContain(rae);
    // The executor's rows: the dashboard's actor executed them, for the owner who invited.
    const rows = (await host.admin.auditLog(staff, { tenantId: t.tenant, limit: 500 })).filter(
      (r) => (r.action === 'addMember' || r.action === 'assignRole') && JSON.stringify(r.after).includes(rae),
    );
    expect(rows.map((r) => r.action).sort()).toEqual(['addMember', 'assignRole']);
    for (const r of rows) {
      expect(r.actor).toBe(DASHBOARD_CP_ACTOR);
      expect(r.causedBy).toEqual(expect.any(String));
      expect(r.onBehalfOf).toMatchObject({ principal: t.owner });
    }
    expect(new Set(rows.map((r) => r.causedBy)).size).toBe(1);
  });

  it('409: refused when the inviter was demoted before the accept — no access, no link, roster withdrawn, journal says why', async () => {
    const t = await team();
    // An admin joins, invites a second admin, and is then demoted to viewer.
    const first = await invite('sub-owner', 'ada@team.test', 'admin');
    expect((await accept('sub-ada', 'ada@team.test', first.token)).status).toBe(200);
    const ada = (await principalOf(t, 'sub-ada'))!.principal;
    const second = await invite('sub-ada', 'ben@team.test', 'admin');
    await host.admin.unassignRole(staff, { principalId: ada, roleKey: 'admin', node: { tenantId: t.tenant, scopeId: null } });
    await host.admin.assignRole(staff, { principalId: ada, roleKey: 'viewer', node: { tenantId: t.tenant, scopeId: null } });

    const res = await accept('sub-ben', 'ben@team.test', second.token);
    expect(res.status).toBe(409);
    expect(await res.text()).toMatch(/no longer has the access it grants/);
    expect(await principalOf(t, 'sub-ben')).toBeFalsy();
    // Off the roster (the withdrawn row reads as neither active nor invited), and in no org.
    expect((await roster(t)).map((m) => m.email)).not.toContain('ben@team.test');
    expect((await host.admin.listMembers(staff, t.tenant, t.org)).map((m) => m.principal)).toEqual([ada]);

    // What an admin reads: a terminal refusal naming the permissions the inviter lacks.
    const dead = await host.executorDeadLetters(t.tenant, t.dashScope);
    expect(dead).toHaveLength(1);
    expect(dead[0]!.error).toMatch(/^refused: the inviter .* no longer holds .*dashboard/);
    expect(dead[0]!.attempts).toBe(1);
  });

  it('409: refused when the inviter was removed from the team before the accept', async () => {
    const t = await team();
    const first = await invite('sub-owner', 'ada@team.test', 'admin');
    expect((await accept('sub-ada', 'ada@team.test', first.token)).status).toBe(200);
    const second = await invite('sub-ada', 'ben@team.test', 'member');
    const adaRow = (await (await host.getScope(t.owner, t.tenant, t.dashScope)).invoke('dashboard/list-members', {}) as { id: string; email: string }[])
      .find((m) => m.email === 'ada@team.test')!;
    const removed = await app.request('/api/members/remove', { method: 'POST', headers: json('sub-owner'), body: JSON.stringify({ memberId: adaRow.id }) }, env);
    expect(removed.status).toBe(204);

    const res = await accept('sub-ben', 'ben@team.test', second.token);
    expect(res.status).toBe(409);
    expect(await principalOf(t, 'sub-ben')).toBeFalsy();
  });

  it('removing a member also ends the org membership the executor added', async () => {
    const t = await team();
    const { token } = await invite('sub-owner', 'rae@team.test', 'member');
    expect((await accept('sub-rae', 'rae@team.test', token)).status).toBe(200);
    const rae = (await principalOf(t, 'sub-rae'))!.principal;
    const row = (await (await host.getScope(t.owner, t.tenant, t.dashScope)).invoke('dashboard/list-members', {}) as { id: string; email: string }[])
      .find((m) => m.email === 'rae@team.test')!;
    expect((await app.request('/api/members/remove', { method: 'POST', headers: json('sub-owner'), body: JSON.stringify({ memberId: row.id }) }, env)).status).toBe(204);
    expect((await host.admin.listMembers(staff, t.tenant, t.org)).map((m) => m.principal)).not.toContain(rae);
    expect(await canRead(t, rae)).toBe(false);
  });

  it('202: accepted with access pending when the inline attempt fails — and the backstop lands it', async () => {
    const t = await team();
    const { token } = await invite('sub-owner', 'rae@team.test', 'member');
    failNextAdds = 1;
    const res = await accept('sub-rae', 'rae@team.test', token);
    expect(res.status, await res.clone().text()).toBe(202);
    expect(await res.json()).toEqual({ teamId: t.tenant, pending: true });
    // Linked, so the next sign-in lands in the team; no role yet.
    const rae = (await principalOf(t, 'sub-rae'))!.principal;
    expect(await canRead(t, rae)).toBe(false);
    // The scope is on the sweeper's roster — what drives the backstop in a deployment.
    expect(noteScope).toHaveBeenCalledWith(t.tenant, t.dashScope);

    // The sweeper's pass, as `defineScopeSweeperDO` runs it.
    await new Promise((r) => setTimeout(r, 1_300)); // past the first backoff step (1s ± 20% jitter)
    const pass = await host.drainDue(t.tenant, t.dashScope);
    expect(pass.delivered).toBe(1);
    expect(await canRead(t, rae)).toBe(true);
  });

  it('enrolls the team scope with the sweeper when a team invites', async () => {
    const t = await team();
    await invite('sub-owner', 'rae@team.test', 'member');
    expect(noteScope).toHaveBeenCalledWith(t.tenant, t.dashScope);
  });
});
