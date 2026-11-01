import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { orgId, platformActorId, principalId, scopeId, tenantId, type ScopeId, type TenantId } from '@substrat-run/contracts';
import { ulid, type HostAdmin, type ScopeHost } from '@substrat-run/kernel';
import { MODULES, provisionDashboard } from '../src/index.js';
import { registerDashboardMembership } from '../src/membership.js';
import { dashboardRoutes } from '../src/routes.js';

/**
 * The members & invites area on the declared, team-scoped surface (#2170): the roster,
 * invite, resend, copy-link, revoke, remove and leave, each under `/api/teams/:teamId`.
 *
 * Driven through the WORKER over a SQLite host (the seams the worker cannot run in Node
 * replaced as in accept-membership-route.test.ts). Every scope the worker reaches is
 * recorded, so "a team the caller is not in is a 404 before its scope is touched" is
 * something a test can fail on — and so is "the cookie names A, the path names B, and B is
 * what moved".
 */
const shared = vi.hoisted(() => ({
  host: null as unknown,
  sessions: new Map<string, { id: string; email: string; name: string; emailVerified: boolean }>(),
  /** The tenant of every scope the worker opened, in order. */
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
      const target = shared.host as object;
      return new Proxy(target, {
        get(t, key) {
          // The SQLite host underneath is shared across requests: modules and the membership
          // executor are registered on it once, in `beforeEach`.
          if (key === 'registerModule' || key === 'registerExecutor') return () => undefined;
          if (key === 'getScope') {
            return (...a: Parameters<SqliteScopeHost['getScope']>) => {
              shared.scopesOpened.push(a[1]);
              return (t as SqliteScopeHost).getScope(...a);
            };
          }
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
  default: { request(path: string, init: RequestInit, env: unknown, executionCtx?: { waitUntil(p: Promise<unknown>): void; passThroughOnException(): void }): Response | Promise<Response> };
};

const PROVIDER = 'authhero';
const staff = platformActorId.parse(ulid());

let dir: string;
let host: SqliteScopeHost;
let env: Record<string, unknown>;
let send: ReturnType<typeof vi.fn>;
/**
 * What the executor's next REMOVE does in the directory: apply it (the real host), fail
 * transiently (the retry backstop owns it — the route's `pending: true`), or answer the
 * refusal the directory gives when the remover's bound fails inside its unit (the 409).
 */
let removeMode: 'apply' | 'fail' | 'refuse' = 'apply';

/**
 * The host the membership executor is mounted on: the SQLite host, except that a remove
 * (`applyMembership` with `op: 'remove'`) through the admin an executor is handed, or an
 * attributed view of it, follows `removeMode`. Everything else is the host's own.
 */
function removeSeam(real: SqliteScopeHost): ScopeHost {
  const seam = (admin: HostAdmin): HostAdmin =>
    new Proxy(admin, {
      get(t, key) {
        if (key === 'applyMembership') {
          return async (...args: Parameters<HostAdmin['applyMembership']>) => {
            if (args[1].op !== 'remove' || removeMode === 'apply') return t.applyMembership(...args);
            if (removeMode === 'fail') throw new Error('directory unavailable');
            return { applied: false, missing: ['dashboard:manage-members'] };
          };
        }
        if (key === 'attributed') return (...a: Parameters<NonNullable<HostAdmin['attributed']>>) => seam(t.attributed!(...a));
        return Reflect.get(t, key) as unknown;
      },
    });
  return new Proxy(real, {
    get(t, key) {
      if (key === 'registerExecutor') {
        return (...[id, type, handler, retry]: Parameters<ScopeHost['registerExecutor']>) =>
          t.registerExecutor(id, type, (admin, event, scope) => handler(seam(admin), event, scope), retry);
      }
      const v = Reflect.get(t, key) as unknown;
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(t) : v;
    },
  }) as unknown as ScopeHost;
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'substrat-members-team-'));
  host = new SqliteScopeHost({ dir });
  shared.host = host;
  shared.sessions.clear();
  shared.scopesOpened.length = 0;
  for (const m of MODULES) host.registerModule(m);
  removeMode = 'apply';
  registerDashboardMembership(removeSeam(host));
  send = vi.fn(async () => ({ delivered: ['x'], queued: [], permanent_bounces: [] }));
  env = {
    SCOPE: {},
    CONTROL_PLANE: {},
    SESSION_SECRET: 'test-session-secret',
    EMAIL: { send },
    SWEEPER: { idFromName: (name: string) => name, get: () => ({ noteScope: async () => ({ scopes: 1 }) }) },
    // Removing or leaving severs the shared plane's mirrored link best-effort; a plane that
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
  tenant: TenantId;
  dashScope: ScopeId;
}

const signIn = (sub: string, email: string) => shared.sessions.set(sub, { id: sub, email, name: sub, emailVerified: true });

/** A seeded team owned by `ownerSub`. */
async function team(ownerSub: string, name = 'Team'): Promise<Team> {
  const tenant = tenantId.parse(ulid());
  const dashScope = scopeId.parse(ulid());
  const owner = principalId.parse(ulid());
  await provisionDashboard(host, { tenantId: tenant, scopeId: dashScope, owner, slug: `t-${tenant.slice(-6).toLowerCase()}`, name });
  const org = orgId.parse(ulid());
  await host.admin.createOrg(staff, { id: org, tenantId: tenant, slug: 'team', name });
  await (await host.getScope(owner, tenant, dashScope)).invoke('dashboard/init-team', { orgId: org, ownerEmail: `${ownerSub}@team.test` });
  await host.admin.linkIdentity(staff, { provider: PROVIDER, externalId: ownerSub, principal: owner, tenantId: tenant, scopeId: dashScope });
  signIn(ownerSub, `${ownerSub}@team.test`);
  return { tenant, dashScope };
}

/** One request through the worker, as `sub`, optionally with `sb_team` pinned. */
function req(method: string, path: string, opts: { sub?: string | null; cookieTeam?: string; body?: unknown } = {}) {
  const sub = opts.sub === undefined ? 'sub-owner' : opts.sub;
  const cookie = [sub ? `sb_session=${sub}` : '', opts.cookieTeam ? `sb_team=${opts.cookieTeam}` : ''].filter(Boolean).join('; ');
  const headers: Record<string, string> = { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) };
  const body = opts.body === undefined || method === 'GET' ? {} : { body: JSON.stringify(opts.body) };
  return app.request(path, { method, headers, ...body }, env, {
    waitUntil() {},
    passThroughOnException() {},
  });
}

const inTeam = (t: Team | TenantId, rest: string) => `/api/teams/${typeof t === 'string' ? t : t.tenant}${rest}`;

/** `from` invites `email` at `roleKey` through the team route; the mail spy is cleared after. */
async function invite(t: Team, email: string, roleKey = 'member', from = 'sub-owner'): Promise<{ invitationId: string; token: string }> {
  const res = await req('POST', inTeam(t, '/members/invites'), { sub: from, body: { email, roleKey } });
  expect(res.status, await res.clone().text()).toBe(201);
  const { invitationId, acceptUrl } = (await res.json()) as { invitationId: string; acceptUrl: string };
  send.mockClear();
  return { invitationId, token: acceptUrl.split('/invite/')[1]! };
}

/** `sub` joins `t` at `roleKey` the real way: invited, then accepted at the invited address. */
async function join_(t: Team, sub: string, roleKey: string): Promise<void> {
  const email = `${sub}@team.test`;
  const { token } = await invite(t, email, roleKey);
  signIn(sub, email);
  const res = await req('POST', '/api/invites/accept', { sub, body: { token } });
  expect(res.status, await res.clone().text()).toBe(200);
}

type Row = { id: string; email: string; status: string; role_key: string; invitation_id: string | null };
async function roster(t: Team, sub = 'sub-owner'): Promise<Row[]> {
  const res = await req('GET', inTeam(t, '/members?limit=100'), { sub });
  expect(res.status, await res.clone().text()).toBe(200);
  return ((await res.json()) as { entries: Row[] }).entries;
}
const rowOf = async (t: Team, email: string) => (await roster(t)).find((m) => m.email === email);

/** Every declared member route, with a path and a body that would otherwise be refused at parse (400). */
const routesOf = (t: TenantId, id = ulid()) =>
  [
    ['list-members', 'GET', inTeam(t, '/members?limit=0')],
    ['invite-member', 'POST', inTeam(t, '/members/invites'), { email: 'x@team.test', roleKey: 'owner' }],
    ['resend-invite', 'POST', inTeam(t, `/members/invites/${id}/resend`)],
    ['invite-link', 'POST', inTeam(t, `/members/invites/${id}/link`)],
    ['revoke-invite', 'DELETE', inTeam(t, `/members/invites/${id}`)],
    ['remove-member', 'DELETE', inTeam(t, `/members/${id}`)],
    ['leave-team', 'POST', inTeam(t, '/leave')],
  ] as const;

describe('members & invites under /api/teams/:teamId (#2170)', () => {
  it('/api/me heals a pre-roster team before returning the caller’s role', async () => {
    const legacy = await provisionDashboard(host, {
      tenantId: tenantId.parse('01KY54SRTR' + ulid().slice(10)),
      scopeId: scopeId.parse(ulid()),
      owner: principalId.parse(ulid()),
      slug: 'legacy',
      name: 'Legacy',
    });
    await host.admin.linkIdentity(staff, {
      provider: PROVIDER, externalId: 'sub-owner', principal: legacy.principal,
      tenantId: legacy.tenantId, scopeId: legacy.scopeId,
    });
    signIn('sub-owner', 'owner@legacy.test');
    const scope = await host.getScope(legacy.principal, legacy.tenantId, legacy.scopeId);
    expect(await scope.invoke('dashboard/my-role', {})).toBeNull();

    const res = await req('GET', '/api/me');
    expect(res.status, await res.clone().text()).toBe(200);
    expect(((await res.json()) as { roleKey: string }).roleKey).toBe('owner');
    expect(await scope.invoke('dashboard/my-role', {})).toBe('owner');
  });

  it('/api/me reads the caller’s own dashboard/my-role, independent of the roster page', async () => {
    const t = await team('sub-owner');
    await join_(t, 'sub-viewer', 'viewer');
    const owner = await req('GET', '/api/me');
    const viewer = await req('GET', '/api/me', { sub: 'sub-viewer' });
    expect(owner.status, await owner.clone().text()).toBe(200);
    expect(viewer.status, await viewer.clone().text()).toBe(200);
    expect(((await owner.json()) as { roleKey: string }).roleKey).toBe('owner');
    expect(((await viewer.json()) as { roleKey: string }).roleKey).toBe('viewer');
  });
  it('/api/teams/switch pins a team the caller is in, and refuses one they are not without touching the cookie', async () => {
    const mine = await team('sub-owner');
    const other = await team('sub-stranger', 'Other');
    const ok = await req('POST', '/api/teams/switch', { body: { teamId: mine.tenant } });
    expect([ok.status, await ok.json()]).toEqual([200, { teamId: mine.tenant }]);
    expect(ok.headers.get('set-cookie')).toContain(`sb_team=${mine.tenant}`);
    const refused = await req('POST', '/api/teams/switch', { body: { teamId: other.tenant } });
    expect(refused.status).toBe(403);
    expect(refused.headers.get('set-cookie')).toBeNull();
  });

  it('a team the caller is not in is a 404 on every route — before its input is parsed, and before its scope is opened', async () => {
    await team('sub-owner');
    const other = await team('sub-stranger', 'Other');
    shared.scopesOpened.length = 0;
    for (const [name, method, path, body] of routesOf(other.tenant)) {
      const res = await req(method, path, { body: body ?? {} });
      expect(res.status, name).toBe(404);
    }
    expect(shared.scopesOpened).not.toContain(other.tenant);
    // A team that does not exist answers the same.
    for (const [name, method, path, body] of routesOf(tenantId.parse(ulid()))) {
      expect((await req(method, path, { body: body ?? {} })).status, name).toBe(404);
    }
  });

  it('no session is a 401 on every route', async () => {
    const t = await team('sub-owner');
    for (const [name, method, path, body] of routesOf(t.tenant)) {
      expect((await req(method, path, { sub: null, body: body ?? {} })).status, name).toBe(401);
    }
  });

  it('the cookie routes are gone', async () => {
    await team('sub-owner');
    for (const [method, path] of [
      ['GET', '/api/members'],
      ['POST', '/api/members/invite'],
      ['POST', '/api/members/resend-invite'],
      ['POST', '/api/members/invite-link'],
      ['POST', '/api/members/revoke-invite'],
      ['POST', '/api/members/remove'],
      ['POST', '/api/teams/leave'],
    ] as const) {
      expect((await req(method, path, { body: {} })).status, `${method} ${path}`).toBe(404);
    }
  });

  it('bad input is a 400 in a team the caller is in — the twin of the 404 above', async () => {
    const t = await team('sub-owner');
    expect((await req('POST', inTeam(t, '/members/invites'), { body: { email: 'x@team.test', roleKey: 'owner' } })).status).toBe(400);
    expect((await req('GET', inTeam(t, '/members?limit=0'))).status).toBe(400);
  });

  it('with sb_team pinned to A, the path names B and B is what is read and written', async () => {
    const a = await team('sub-owner', 'A');
    const b = await team('sub-other', 'B');
    // The owner of A also owns B (one login, two teams).
    const ownerOfB = principalId.parse(ulid());
    await host.admin.assignRole(staff, { principalId: ownerOfB, roleKey: 'owner', node: { tenantId: b.tenant, scopeId: null } });
    await host.admin.linkIdentity(staff, { provider: PROVIDER, externalId: 'sub-owner', principal: ownerOfB, tenantId: b.tenant, scopeId: b.dashScope });

    const sent = await req('POST', inTeam(b, '/members/invites'), { cookieTeam: a.tenant, body: { email: 'rae@b.test', roleKey: 'viewer' } });
    expect(sent.status, await sent.clone().text()).toBe(201);
    const { invitationId } = (await sent.json()) as { invitationId: string };
    const listed = async (t: Team) =>
      ((await (await req('GET', inTeam(t, '/members'), { cookieTeam: a.tenant })).json()) as { entries: Row[] }).entries.map((m) => m.email);
    expect(await listed(b)).toContain('rae@b.test');
    expect(await listed(a)).not.toContain('rae@b.test');

    expect((await req('POST', inTeam(b, `/members/invites/${invitationId}/link`), { cookieTeam: a.tenant })).status).toBe(200);
    // B's invitation through A's path is not A's: no such pending invite.
    expect((await req('POST', inTeam(a, `/members/invites/${invitationId}/link`), { cookieTeam: b.tenant })).status).toBe(404);
    const revoked = await req('DELETE', inTeam(b, `/members/invites/${invitationId}`), { cookieTeam: a.tenant });
    expect(revoked.status).toBe(200);
    expect(await revoked.json()).toEqual({ revoked: true });
    expect(await listed(b)).not.toContain('rae@b.test');
  });

  describe('the roster', () => {
    it('any member reads it — a viewer included — paged with a cursor', async () => {
      const t = await team('sub-owner');
      await join_(t, 'sub-viewer', 'viewer');
      await invite(t, 'p1@team.test');
      await invite(t, 'p2@team.test');
      const first = await req('GET', inTeam(t, '/members?limit=2'), { sub: 'sub-viewer' });
      expect(first.status).toBe(200);
      const page = (await first.json()) as { entries: Row[]; nextCursor: string | null };
      expect(page.entries).toHaveLength(2);
      expect(page.nextCursor).not.toBeNull();
      const rest = (await (await req('GET', inTeam(t, `/members?cursor=${page.nextCursor}`), { sub: 'sub-viewer' })).json()) as { entries: Row[] };
      const emails = [...page.entries, ...rest.entries].map((m) => m.email).sort();
      expect(emails).toEqual(['p1@team.test', 'p2@team.test', 'sub-owner@team.test', 'sub-viewer@team.test']);
    });
  });

  describe('invites', () => {
    it('the owner invites: 201 with the link, the email sent, the invite on the roster', async () => {
      const t = await team('sub-owner');
      const res = await req('POST', inTeam(t, '/members/invites'), { body: { email: 'rae@team.test', roleKey: 'admin' } });
      expect(res.status).toBe(201);
      const body = (await res.json()) as { invitationId: string; acceptUrl: string; emailDelivered: boolean };
      expect(body).toMatchObject({ emailDelivered: true, acceptUrl: expect.stringContaining('/invite/') });
      expect(send).toHaveBeenCalledTimes(1);
      expect(await rowOf(t, 'rae@team.test')).toMatchObject({ status: 'invited', role_key: 'admin', invitation_id: body.invitationId });
    });

    it('a member or viewer may not invite, resend, copy a link or revoke — and nothing is sent or changed', async () => {
      const t = await team('sub-owner');
      await join_(t, 'sub-member', 'member');
      await join_(t, 'sub-viewer', 'viewer');
      const { invitationId } = await invite(t, 'rae@team.test');
      for (const sub of ['sub-member', 'sub-viewer']) {
        expect((await req('POST', inTeam(t, '/members/invites'), { sub, body: { email: 'x@team.test', roleKey: 'viewer' } })).status, sub).toBe(403);
        expect((await req('POST', inTeam(t, `/members/invites/${invitationId}/resend`), { sub })).status, sub).toBe(403);
        expect((await req('POST', inTeam(t, `/members/invites/${invitationId}/link`), { sub })).status, sub).toBe(403);
        expect((await req('DELETE', inTeam(t, `/members/invites/${invitationId}`), { sub })).status, sub).toBe(403);
      }
      expect(send).not.toHaveBeenCalled();
      expect(await rowOf(t, 'x@team.test')).toBeUndefined();
      expect(await rowOf(t, 'rae@team.test')).toMatchObject({ status: 'invited' });
    });

    it('an admin may invite, resend and revoke — the positive twin', async () => {
      const t = await team('sub-owner');
      await join_(t, 'sub-admin', 'admin');
      const sent = await req('POST', inTeam(t, '/members/invites'), { sub: 'sub-admin', body: { email: 'rae@team.test', roleKey: 'viewer' } });
      expect(sent.status, await sent.clone().text()).toBe(201);
      const { invitationId } = (await sent.json()) as { invitationId: string };
      const resent = await req('POST', inTeam(t, `/members/invites/${invitationId}/resend`), { sub: 'sub-admin' });
      expect(resent.status).toBe(200);
      expect(await resent.json()).toMatchObject({ invitationId, emailDelivered: true });
      expect((await req('DELETE', inTeam(t, `/members/invites/${invitationId}`), { sub: 'sub-admin' })).status).toBe(200);
      expect(await rowOf(t, 'rae@team.test')).toBeUndefined();
    });

    it('resend of no pending invite is a 404, and sends nothing', async () => {
      const t = await team('sub-owner');
      expect((await req('POST', inTeam(t, `/members/invites/${ulid()}/resend`))).status).toBe(404);
      expect(send).not.toHaveBeenCalled();
    });
  });

  describe('removing a member', () => {
    it('the owner removes a member: 200 not pending, off the roster, and their login leaves the team', async () => {
      const t = await team('sub-owner');
      await join_(t, 'sub-rae', 'member');
      const row = (await rowOf(t, 'sub-rae@team.test'))!;
      const res = await req('DELETE', inTeam(t, `/members/${row.id}`));
      expect(res.status, await res.clone().text()).toBe(200);
      expect(await res.json()).toEqual({ removed: true, pending: false });
      expect(await rowOf(t, 'sub-rae@team.test')).toBeUndefined();
      expect(await host.admin.resolveIdentity(t.tenant, PROVIDER, 'sub-rae')).toBeUndefined();
      // Their own requests into the team are refused: this was their only team, so their
      // login resolves to none at all (onboarding) — 401, as for any teamless login.
      expect((await req('GET', inTeam(t, '/members'), { sub: 'sub-rae' })).status).toBe(401);
    });

    it('a member or viewer may not remove anyone, and the member stays', async () => {
      const t = await team('sub-owner');
      await join_(t, 'sub-member', 'member');
      await join_(t, 'sub-viewer', 'viewer');
      await join_(t, 'sub-rae', 'member');
      const row = (await rowOf(t, 'sub-rae@team.test'))!;
      for (const sub of ['sub-member', 'sub-viewer']) {
        expect((await req('DELETE', inTeam(t, `/members/${row.id}`), { sub })).status, sub).toBe(403);
      }
      expect(await rowOf(t, 'sub-rae@team.test')).toMatchObject({ status: 'active' });
      expect(await host.admin.resolveIdentity(t.tenant, PROVIDER, 'sub-rae')).toBeDefined();
    });

    it('the owner row is not removable: `removed: false`, and the owner is still active and linked', async () => {
      const t = await team('sub-owner');
      await join_(t, 'sub-admin', 'admin');
      const owner = (await rowOf(t, 'sub-owner@team.test'))!;
      const res = await req('DELETE', inTeam(t, `/members/${owner.id}`), { sub: 'sub-admin' });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ removed: false, pending: false });
      expect(await rowOf(t, 'sub-owner@team.test')).toMatchObject({ status: 'active', role_key: 'owner' });
      expect(await host.admin.resolveIdentity(t.tenant, PROVIDER, 'sub-owner')).toBeDefined();
    });
  });

  describe('removing a member: what the executor reports', () => {
    it('a remove the directory could not effect yet is `pending: true` — committed, off the roster, login severed', async () => {
      const t = await team('sub-owner');
      await join_(t, 'sub-rae', 'member');
      const row = (await rowOf(t, 'sub-rae@team.test'))!;
      removeMode = 'fail';
      const res = await req('DELETE', inTeam(t, `/members/${row.id}`));
      expect(res.status, await res.clone().text()).toBe(200);
      expect(await res.json()).toEqual({ removed: true, pending: true });
      expect(await rowOf(t, 'sub-rae@team.test')).toBeUndefined();
      expect(await host.admin.resolveIdentity(t.tenant, PROVIDER, 'sub-rae')).toBeUndefined();
    });

    it('a remove the directory refuses is a 409 with the reason — and the login is severed anyway, as on the cookie route', async () => {
      const t = await team('sub-owner');
      await join_(t, 'sub-rae', 'member');
      const row = (await rowOf(t, 'sub-rae@team.test'))!;
      removeMode = 'refuse';
      const res = await req('DELETE', inTeam(t, `/members/${row.id}`));
      expect(res.status).toBe(409);
      expect(await res.text()).toMatch(/the removal was refused: .*no longer holds dashboard:manage-members/);
      expect(await rowOf(t, 'sub-rae@team.test')).toBeUndefined();
      expect(await host.admin.resolveIdentity(t.tenant, PROVIDER, 'sub-rae')).toBeUndefined();
    });
  });

  describe('the §5.1 bound, through the routes', () => {
    /**
     * A caller who holds `dashboard:manage-members` but not every permission of the role at
     * stake: a custom tenant role, since every shipped role that manages members also holds
     * all of `member` and `viewer`. It holds `viewer`'s permissions and not `member`'s
     * (`dashboard:provision-app`, `dashboard:manage-findings`).
     */
    async function recruiter(t: Team): Promise<void> {
      await host.admin.defineRole(staff, t.tenant, {
        key: 'recruiter',
        permissions: ['dashboard:read', 'dashboard:read-findings', 'dashboard:manage-members', 'invites:send', 'invites:read', 'invites:revoke'] as never,
        source: 'vertical',
      });
      const p = principalId.parse(ulid());
      await host.admin.assignRole(staff, { principalId: p, roleKey: 'recruiter', node: { tenantId: t.tenant, scopeId: null } });
      await host.admin.linkIdentity(staff, { provider: PROVIDER, externalId: 'sub-recruiter', principal: p, tenantId: t.tenant, scopeId: t.dashScope });
      signIn('sub-recruiter', 'sub-recruiter@team.test');
    }

    it('invite: refused at a role whose permissions the caller lacks, allowed at one it holds', async () => {
      const t = await team('sub-owner');
      await recruiter(t);
      const refused = await req('POST', inTeam(t, '/members/invites'), { sub: 'sub-recruiter', body: { email: 'm@team.test', roleKey: 'member' } });
      expect(refused.status).toBe(403);
      expect(await rowOf(t, 'm@team.test')).toBeUndefined();
      expect(send).not.toHaveBeenCalled();
      const allowed = await req('POST', inTeam(t, '/members/invites'), { sub: 'sub-recruiter', body: { email: 'v@team.test', roleKey: 'viewer' } });
      expect(allowed.status, await allowed.clone().text()).toBe(201);
      expect(await rowOf(t, 'v@team.test')).toMatchObject({ status: 'invited', role_key: 'viewer' });
    });

    it('remove: refused for a member whose role the caller lacks, allowed for a viewer', async () => {
      const t = await team('sub-owner');
      await join_(t, 'sub-mem', 'member');
      await join_(t, 'sub-view', 'viewer');
      await recruiter(t);
      const mem = (await rowOf(t, 'sub-mem@team.test'))!;
      const refused = await req('DELETE', inTeam(t, `/members/${mem.id}`), { sub: 'sub-recruiter' });
      expect(refused.status).toBe(403);
      expect(await refused.text()).toMatch(/you cannot remove a 'member'/);
      expect(await rowOf(t, 'sub-mem@team.test')).toMatchObject({ status: 'active' });
      expect(await host.admin.resolveIdentity(t.tenant, PROVIDER, 'sub-mem')).toBeDefined();
      const view = (await rowOf(t, 'sub-view@team.test'))!;
      const allowed = await req('DELETE', inTeam(t, `/members/${view.id}`), { sub: 'sub-recruiter' });
      expect(allowed.status, await allowed.clone().text()).toBe(200);
      expect(await allowed.json()).toEqual({ removed: true, pending: false });
    });
  });

  describe('leaving', () => {
    it('a member leaves: 200, off the roster, unlinked, and sb_team cleared', async () => {
      const t = await team('sub-owner');
      await join_(t, 'sub-rae', 'viewer');
      const res = await req('POST', inTeam(t, '/leave'), { sub: 'sub-rae', cookieTeam: t.tenant });
      expect(res.status, await res.clone().text()).toBe(200);
      expect(await res.json()).toEqual({ left: true });
      expect(res.headers.get('set-cookie')).toMatch(/sb_team=;/);
      expect(await rowOf(t, 'sub-rae@team.test')).toBeUndefined();
      expect(await host.admin.resolveIdentity(t.tenant, PROVIDER, 'sub-rae')).toBeUndefined();
    });

    it('leaving team B through its path leaves A, the team the cookie names, alone', async () => {
      const a = await team('sub-owner', 'A');
      const b = await team('sub-other', 'B');
      await join_(a, 'sub-rae', 'member');
      // sub-rae is in B too.
      const email = 'sub-rae@team.test';
      const { token } = await invite(b, email, 'member', 'sub-other');
      expect((await req('POST', '/api/invites/accept', { sub: 'sub-rae', body: { token } })).status).toBe(200);
      const res = await req('POST', inTeam(b, '/leave'), { sub: 'sub-rae', cookieTeam: a.tenant });
      expect(res.status).toBe(200);
      // The cookie names A, the team still being used: it is not cleared.
      expect(res.headers.get('set-cookie') ?? '').not.toMatch(/sb_team=/);
      expect(await host.admin.resolveIdentity(b.tenant, PROVIDER, 'sub-rae')).toBeUndefined();
      expect(await host.admin.resolveIdentity(a.tenant, PROVIDER, 'sub-rae')).toBeDefined();
      expect(await rowOf(a, email)).toMatchObject({ status: 'active' });
    });
  });

  it('the declared surface carries exactly these seven member routes', () => {
    const members = Object.entries(dashboardRoutes)
      .filter(([, d]) => d.http.path.startsWith('/members') || d.http.path === '/leave')
      .map(([name, d]) => `${d.http.method} ${d.http.path} ${name}`)
      .sort();
    expect(members).toEqual([
      'DELETE /members/invites/{invitationId} dashboard/revoke-invite',
      'DELETE /members/{memberId} dashboard/remove-member',
      'GET /members dashboard/list-members',
      'POST /leave dashboard/leave-team',
      'POST /members/invites dashboard/invite-member',
      'POST /members/invites/{invitationId}/link dashboard/invite-link',
      'POST /members/invites/{invitationId}/resend dashboard/resend-invite',
    ]);
  });

  it('reads only the path team’s grants and returns only display fields, even when the cookie names another team', async () => {
    const a = await team('sub-owner', 'A');
    const b = await team('sub-owner', 'B');
    const paths: string[] = [];
    env.CONTROL_PLANE_SVC = { fetch: async (url: string | URL | Request) => {
      const path = new URL(String(url)).pathname;
      paths.push(path);
      if (path === '/api/tenant-tokens') return Response.json({ token: 'test-token' }, { status: 201 });
      if (path === `/api/tenants/${b.tenant}/entitlements`) return Response.json([
        { entitlementKey: 'app', quota: 7, expiresAt: null, plan: 'pro', grantedAt: '2026-01-01T00:00:00Z', grantedBy: staff },
        { entitlementKey: 'reports', quota: null, expiresAt: '2027-01-01T00:00:00Z', plan: null, grantedAt: null, grantedBy: null },
      ]);
      return Response.json({ error: 'unexpected request' }, { status: 500 });
    } };
    const res = await req('GET', inTeam(b, '/entitlements'), { cookieTeam: a.tenant });
    expect(res.status, await res.clone().text()).toBe(200);
    expect(await res.json()).toEqual([
      { key: 'app', quota: 7 },
      { key: 'reports', expiresAt: '2027-01-01T00:00:00Z' },
    ]);
    expect(paths).toContain(`/api/tenants/${b.tenant}/entitlements`);
    expect(paths).not.toContain(`/api/tenants/${a.tenant}/entitlements`);
  });

  it('refuses a member before asking the plane for grants, while an admin may read them', async () => {
    const t = await team('sub-owner');
    await join_(t, 'sub-member', 'member');
    await join_(t, 'sub-admin', 'admin');
    const fetch = vi.fn(async (url: string | URL | Request) =>
      new URL(String(url)).pathname === '/api/tenant-tokens'
        ? Response.json({ token: 'test-token' }, { status: 201 })
        : Response.json([]));
    env.CONTROL_PLANE_SVC = { fetch };
    const res = await req('GET', inTeam(t, '/entitlements'), { sub: 'sub-member' });
    expect(res.status).toBe(403);
    expect(fetch).not.toHaveBeenCalled();
    expect((await req('GET', inTeam(t, '/entitlements'), { sub: 'sub-admin' })).status).toBe(200);
  });

  it('refuses a team the caller has not joined before opening its scope or asking the plane', async () => {
    await team('sub-stranger');
    const t = await team('sub-other');
    const fetch = vi.fn(async () => Response.json([]));
    env.CONTROL_PLANE_SVC = { fetch };
    shared.scopesOpened.length = 0;
    const res = await req('GET', inTeam(t, '/entitlements'), { sub: 'sub-stranger' });
    expect(res.status).toBe(404);
    expect(shared.scopesOpened).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('reads metered usage for the path team and projects no price even if the directory sends one', async () => {
    const a = await team('sub-owner', 'A');
    const b = await team('sub-owner', 'B');
    const paths: string[] = [];
    env.CONTROL_PLANE_SVC = { fetch: async (url: string | URL | Request) => {
      const path = new URL(String(url)).pathname;
      paths.push(path);
      if (path === '/api/tenant-tokens') return Response.json({ token: 'test-token' }, { status: 201 });
      if (path === `/api/tenants/${b.tenant}/metered-usage`) return Response.json({
        readAt: '2026-10-29T00:00:00Z',
        retention: { storageMonths: 13, modelDays: 400, requestMonths: null },
        storage: { state: 'new-storage-state', bytes: 8, estimated: 'new-estimate-mode', basis: 'scope-databases', lowerBound: false, truncatedReason: 'new-storage-reason', sampled: 1, total: 1, failing: 0, oldestReadAt: '2026-10-28T00:00:00Z', excluded: ['attachments', 'new-exclusion'], priceUsd: '99' },
        requests: { state: 'new-request-state', requests: 7, estimated: 'new-estimate-mode', lowerBound: true, coveredDays: 1, totalDays: 30, sinceDay: '2026-09-29', untilDay: '2026-10-28', lastReadAt: '2026-10-29T00:00:00Z', byVertical: [{ vertical: 'app', requests: 7 }], breakdownTruncated: false },
        models: { state: 'new-model-state', calls: 2, reportedCalls: 1, inputTokens: 14, outputTokens: 7, estimated: 'new-estimate-mode', lowerBound: false, truncatedReason: 'new-model-reason', since: '2026-09-29T00:00:00Z', until: '2026-10-29T00:00:00Z', oldestRecordedAt: null, newestRecordedAt: null, byVerticalModel: [{ vertical: 'app', model: 'provider:model', calls: 2, reportedCalls: 1, inputTokens: 14, outputTokens: 7 }], breakdownTruncated: false, marginPercent: 20 },
      });
      return Response.json({ error: 'unexpected request' }, { status: 500 });
    } };
    const res = await req('GET', inTeam(b, '/metered-usage'), { cookieTeam: a.tenant });
    expect(res.status, await res.clone().text()).toBe(200);
    const body = await res.json() as {
      storage: { bytes: number; state: string; excluded: string[] };
      requests: { requests: number; estimated: boolean | string; state: string };
      models: { state: string; calls: number; reportedCalls: number; byVerticalModel: { calls: number; reportedCalls: number }[] };
    };
    expect(body.storage).toMatchObject({ bytes: 8 });
    expect(body.requests).toMatchObject({ requests: 7, estimated: 'new-estimate-mode' });
    expect(body.storage).toMatchObject({ state: 'new-storage-state', excluded: ['attachments', 'new-exclusion'] });
    expect(body.requests.state).toBe('new-request-state');
    expect(body.models).toMatchObject({ state: 'new-model-state', calls: 2, reportedCalls: 1, byVerticalModel: [{ calls: 2, reportedCalls: 1 }] });
    expect(JSON.stringify(body)).not.toMatch(/price|margin|usd|cost|amount/i);
    expect(paths).toContain(`/api/tenants/${b.tenant}/metered-usage`);
    expect(paths).not.toContain(`/api/tenants/${a.tenant}/metered-usage`);
  });

  it('accepts null and absent estimate metadata from the plane', async () => {
    const t = await team('sub-owner');
    env.CONTROL_PLANE_SVC = { fetch: async (url: string | URL | Request) => {
      if (new URL(String(url)).pathname === '/api/tenant-tokens') return Response.json({ token: 'test-token' }, { status: 201 });
      return Response.json({
        readAt: '2026-10-29T00:00:00Z',
        retention: { storageMonths: 13, modelDays: 400, requestMonths: null },
        storage: { state: 'complete', bytes: 8, estimated: null, basis: 'scope-databases', lowerBound: false, truncatedReason: null, sampled: 1, total: 1, failing: 0, oldestReadAt: '2026-10-28T00:00:00Z', excluded: [] },
        requests: { state: 'complete', requests: 7, lowerBound: false, coveredDays: 30, totalDays: 30, sinceDay: '2026-09-29', untilDay: '2026-10-28', lastReadAt: '2026-10-29T00:00:00Z', byVertical: [], breakdownTruncated: false },
        models: { state: 'complete', calls: 1, reportedCalls: 1, inputTokens: 11, outputTokens: 3, estimated: null, lowerBound: false, truncatedReason: null, since: '2026-09-29T00:00:00Z', until: '2026-10-29T00:00:00Z', oldestRecordedAt: '2026-10-28T12:00:00Z', newestRecordedAt: '2026-10-28T12:00:00Z', byVerticalModel: [], breakdownTruncated: false },
      });
    } };
    const res = await req('GET', inTeam(t, '/metered-usage'));
    expect(res.status, await res.clone().text()).toBe(200);
    const body = await res.json() as { storage: { estimated: unknown }; requests: { estimated?: unknown }; models: { estimated: unknown } };
    expect(body.storage.estimated).toBeNull();
    expect(body.requests).not.toHaveProperty('estimated');
    expect(body.models.estimated).toBeNull();
  });

  it('parses odd scalar vocabulary and drops object or array scalar fields', async () => {
    const t = await team('sub-owner');
    env.CONTROL_PLANE_SVC = { fetch: async (url: string | URL | Request) => {
      if (new URL(String(url)).pathname === '/api/tenant-tokens') return Response.json({ token: 'test-token' }, { status: 201 });
      return Response.json({
        readAt: '2026-10-29T00:00:00Z', retention: { storageMonths: 13, modelDays: 400, requestMonths: null },
        storage: { state: 0, bytes: 8, estimated: 0, basis: false, lowerBound: false, truncatedReason: ' ', sampled: 1, total: 1, failing: 0, oldestReadAt: '2026-10-28T00:00:00Z', excluded: [0, 'new-exclusion'] },
        requests: { state: true, requests: 7, estimated: 'maybe', lowerBound: 0, truncatedReason: 0, coveredDays: 30, totalDays: 30, sinceDay: '2026-09-29', untilDay: '2026-10-28', lastReadAt: '2026-10-29T00:00:00Z', byVertical: [], breakdownTruncated: false },
        models: { state: { new: 'shape' }, calls: 1, reportedCalls: 1, inputTokens: 11, outputTokens: 3, estimated: ['new-shape'], lowerBound: null, truncatedReason: { new: 'reason' }, since: '2026-09-29T00:00:00Z', until: '2026-10-29T00:00:00Z', oldestRecordedAt: '2026-10-28T12:00:00Z', newestRecordedAt: '2026-10-28T12:00:00Z', byVerticalModel: [], breakdownTruncated: false },
      });
    } };
    const res = await req('GET', inTeam(t, '/metered-usage'));
    expect(res.status, await res.clone().text()).toBe(200);
    const body = await res.json() as { storage: Record<string, unknown>; requests: Record<string, unknown>; models: Record<string, unknown> };
    expect(body.storage).toMatchObject({ state: 0, estimated: 0, basis: false, truncatedReason: ' ', excluded: [0, 'new-exclusion'] });
    expect(body.requests).toMatchObject({ state: true, estimated: 'maybe', lowerBound: 0, truncatedReason: 0 });
    expect(body.models).toMatchObject({ state: null, estimated: null, lowerBound: null, truncatedReason: null });
  });

  it('refuses metered usage to a member before calling the plane, while an admin may read it', async () => {
    const t = await team('sub-owner');
    await join_(t, 'sub-member', 'member');
    await join_(t, 'sub-admin', 'admin');
    const fetch = vi.fn(async (url: string | URL | Request) =>
      new URL(String(url)).pathname === '/api/tenant-tokens'
        ? Response.json({ token: 'test-token' }, { status: 201 })
        : Response.json({
          readAt: '2026-10-29T00:00:00Z', retention: { storageMonths: 13, modelDays: 400, requestMonths: null },
          storage: { state: 'unavailable', bytes: null, estimated: false, basis: 'scope-databases', lowerBound: false, truncatedReason: null, sampled: 0, total: 0, failing: 0, oldestReadAt: null, excluded: [] },
          requests: { state: 'unavailable', requests: null, estimated: true, lowerBound: false, coveredDays: 0, totalDays: 30, sinceDay: '2026-09-29', untilDay: '2026-10-28', lastReadAt: null, byVertical: [], breakdownTruncated: false },
          models: { state: 'empty', calls: null, reportedCalls: 0, inputTokens: null, outputTokens: null, estimated: false, lowerBound: false, truncatedReason: null, since: '2026-09-29T00:00:00Z', until: '2026-10-29T00:00:00Z', oldestRecordedAt: null, newestRecordedAt: null, byVerticalModel: [], breakdownTruncated: false },
        }));
    env.CONTROL_PLANE_SVC = { fetch };
    const res = await req('GET', inTeam(t, '/metered-usage'), { sub: 'sub-member' });
    expect(res.status).toBe(403);
    expect(fetch).not.toHaveBeenCalled();
    expect((await req('GET', inTeam(t, '/metered-usage'), { sub: 'sub-admin' })).status).toBe(200);
  });

  it('refuses a foreign team metered-usage read before opening its scope or plane', async () => {
    await team('sub-stranger');
    const t = await team('sub-other');
    const fetch = vi.fn(async () => Response.json({}));
    env.CONTROL_PLANE_SVC = { fetch };
    shared.scopesOpened.length = 0;
    const res = await req('GET', inTeam(t, '/metered-usage'), { sub: 'sub-stranger' });
    expect(res.status).toBe(404);
    expect(shared.scopesOpened).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });
});
