import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { orgId, platformActorId, principalId, scopeId, tenantId } from '@substrat-run/contracts';
import { ulid } from '@substrat-run/kernel';
import { MODULES, provisionDashboard } from '../src/index.js';
import { registerDashboardMembership } from '../src/membership.js';

/**
 * Every dashboard route where a session's ADDRESS becomes who someone is (#1359), driven
 * through the WORKER over a SQLite host (the seams the worker cannot run in Node are
 * replaced exactly as in invite-link-route.test.ts). Each caller is held to the default:
 * an address the issuer called unverified, or said nothing about, is refused — even when
 * it is exactly the address invited or rostered — and a verified one is accepted. A route
 * that went back to reading `user.email` directly fails here.
 *
 * Sessions are a table keyed by the cookie value, so a test names the claim it presents.
 */
const shared = vi.hoisted(() => ({
  host: null as unknown,
  sessions: new Map<string, { id: string; email?: string; name: string; emailVerified?: boolean }>(),
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
const SECRET = 'test-session-secret';
const staff = platformActorId.parse(ulid());

/** The three states a session's claim can be in, as the table every caller runs. */
const REFUSED = [
  ['false', false],
  ['absent', undefined],
] as const;

/** Present a session with this address and claim; returns the cookie header for it. */
function session(sub: string, email: string, emailVerified: boolean | undefined): string {
  shared.sessions.set(sub, { id: sub, email, name: sub, ...(emailVerified === undefined ? {} : { emailVerified }) });
  return `sb_session=${sub}`;
}

let dir: string;
let host: SqliteScopeHost;
let env: Record<string, unknown>;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'substrat-email-identity-'));
  host = new SqliteScopeHost({ dir });
  shared.host = host;
  shared.sessions.clear();
  for (const m of MODULES) host.registerModule(m);
  // The worker's host mounts it per request; the proxy above no-ops that, so it is mounted once here.
  registerDashboardMembership(host);
  env = {
    SCOPE: {},
    CONTROL_PLANE: {},
    SESSION_SECRET: SECRET,
    EMAIL: { send: vi.fn(async () => ({ delivered: ['x'], queued: [], permanent_bounces: [] })) },
    SUPPORT_DESK_ORIGIN: 'https://desk.test',
    SUPPORT_WIDGET_SECRET: 'support-secret',
  };
  await host.admin.registerIdentityPool(staff, { provider: PROVIDER, topology: 'central', tenantId: null });
});

afterEach(async () => {
  await host.close();
  rmSync(dir, { recursive: true, force: true });
});

/** A seeded team with an owner signed in as `sub-owner`; returns its ids. */
async function team(tenant = tenantId.parse(ulid()), seedRoster = true) {
  const dashScope = scopeId.parse(ulid());
  const owner = principalId.parse(ulid());
  await provisionDashboard(host, { tenantId: tenant, scopeId: dashScope, owner, slug: `t-${tenant.slice(-6).toLowerCase()}`, name: 'Team' });
  const org = orgId.parse(ulid());
  await host.admin.createOrg(staff, { id: org, tenantId: tenant, slug: 'team', name: 'Team' });
  if (seedRoster) {
    await (await host.getScope(owner, tenant, dashScope)).invoke('dashboard/init-team', { orgId: org, ownerEmail: 'owner@team.test' });
  }
  await host.admin.linkIdentity(staff, { provider: PROVIDER, externalId: 'sub-owner', principal: owner, tenantId: tenant, scopeId: dashScope });
  shared.sessions.set('sub-owner', { id: 'sub-owner', email: 'owner@team.test', name: 'Owner', emailVerified: true });
  return { tenant, dashScope, owner };
}

const membersOf = async (node: { tenant: string; dashScope: string; owner: string }) =>
  (await (await host.getScope(principalId.parse(node.owner), tenantId.parse(node.tenant), scopeId.parse(node.dashScope))).invoke(
    'dashboard/list-members',
    {},
  )) as { email: string; role_key: string; status: string }[];

describe('POST /api/invites/accept — the invite is addressed to an email', () => {
  const INVITEE = 'rae@team.test';

  async function inviteToken(): Promise<string> {
    const asOwner = { cookie: 'sb_session=sub-owner', 'content-type': 'application/json' };
    const sent = await app.request('/api/members/invite', { method: 'POST', headers: asOwner, body: JSON.stringify({ email: INVITEE, roleKey: 'member' }) }, env);
    expect(sent.status).toBe(201);
    const { invitationId } = (await sent.json()) as { invitationId: string };
    const link = await app.request('/api/members/invite-link', { method: 'POST', headers: asOwner, body: JSON.stringify({ invitationId }) }, env);
    return ((await link.json()) as { acceptUrl: string }).acceptUrl.split('/invite/')[1]!;
  }

  const accept = (cookie: string, token: string) =>
    app.request('/api/invites/accept', { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ token }) }, env);

  it('a verified session at the invited address joins the team', async () => {
    await team();
    const res = await accept(session('sub-rae', INVITEE, true), await inviteToken());
    expect(res.status, await res.clone().text()).toBe(200);
  });

  it.each(REFUSED)('a session at the invited address whose claim is %s is refused, and told why', async (_l, verified) => {
    const node = await team();
    const res = await accept(session('sub-rae', INVITEE, verified), await inviteToken());
    expect(res.status).toBe(403);
    expect(await res.text()).toMatch(verified === false ? /not verified/ : /sign in again/);
    // Nothing was joined: the invite is still outstanding, nobody new is active.
    expect((await membersOf(node)).filter((m) => m.status === 'active')).toHaveLength(1);
  });
});

describe('GET /api/support/identity — the desk is handed a signed address', () => {
  const identity = (cookie: string) => app.request('/api/support/identity', { headers: { cookie } }, env);

  it('a verified address is signed', async () => {
    const res = await identity(session('sub-sam', 'sam@team.test', true));
    expect(await res.json()).toMatchObject({ desk: 'https://desk.test', user: 'sam@team.test', signature: expect.any(String) });
  });

  it.each(REFUSED)('an address whose claim is %s is not vouched for', async (_l, verified) => {
    const res = await identity(session('sub-sam', 'sam@team.test', verified));
    expect(await res.json()).toEqual({ desk: null });
  });
});

describe('the legacy owner-row heal — the resolving session becomes the owner row', () => {
  // A team from before the roster existed: its tenant id predates the roster epoch, and it
  // has no members until a resolve heals it. Each case needs its own tenant, because the
  // heal remembers per isolate which teams it has already checked.
  let legacy = 0;
  const legacyTenant = () => tenantId.parse(`01JZ00000000000000000000${(++legacy).toString().padStart(2, '0')}`);

  async function resolveAs(emailVerified: boolean | undefined) {
    const node = await team(legacyTenant(), false);
    shared.sessions.set('sub-owner', { id: 'sub-owner', email: 'owner@team.test', name: 'Owner', ...(emailVerified === undefined ? {} : { emailVerified }) });
    await app.request('/api/members', { headers: { cookie: 'sb_session=sub-owner' } }, env);
    return membersOf(node);
  }

  it('a verified address is seeded as the owner', async () => {
    expect(await resolveAs(true)).toMatchObject([{ email: 'owner@team.test', role_key: 'owner', status: 'active' }]);
  });

  it.each(REFUSED)('an address whose claim is %s seeds nothing, so the heal waits for a verified one', async (_l, verified) => {
    expect(await resolveAs(verified)).toEqual([]);
  });
});

describe('POST /api/teams — the new team’s owner row', () => {
  async function createAs(emailVerified: boolean | undefined) {
    const cookie = session('sub-new', 'new@team.test', emailVerified);
    const res = await app.request('/api/teams', { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Fresh' }) }, env);
    expect(res.status, await res.clone().text()).toBeLessThan(300);
    const t = /sb_team=([^;]+)/.exec(res.headers.get('set-cookie') ?? '')![1]!;
    const owner = (await host.admin.resolveIdentity(tenantId.parse(t), PROVIDER, 'sub-new'))!;
    return membersOf({ tenant: t, dashScope: owner.scopeId!, owner: owner.principal });
  }

  it('a verified address is stored on the owner row', async () => {
    expect(await createAs(true)).toMatchObject([{ email: 'new@team.test', role_key: 'owner' }]);
  });

  it.each(REFUSED)('an address whose claim is %s never enters the roster row', async (_l, verified) => {
    expect(await createAs(verified)).toMatchObject([{ email: '', role_key: 'owner', status: 'active' }]);
  });
});
