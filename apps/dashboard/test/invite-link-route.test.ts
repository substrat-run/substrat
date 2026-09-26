import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { orgId, platformActorId, principalId, scopeId, tenantId } from '@substrat-run/contracts';
import { manualClock, ulid } from '@substrat-run/kernel';
import { MODULES, provisionDashboard } from '../src/index.js';
import { INVITE_TOKEN_PURPOSE, verifyClaim } from '../src/signed-token.js';

/**
 * `POST /api/members/invite-link` — the roster's "Copy link". It hands back a pending
 * invite's accept link WITHOUT emailing, and asks the same things a resend does.
 *
 * Driven through the WORKER, over a SQLite host (the seams the worker cannot run in Node
 * are replaced exactly as in deployments-role-gate.test.ts). `env.EMAIL` is a spy, so "no
 * email" is something a test can fail on; resend-invite is its positive twin.
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
  verifySession: async (_env: unknown, token: string | undefined) => (token ? { id: token, name: 'Inviter' } : null),
}));

const workerModule = '../src/worker.js';
const { default: app } = (await import(/* @vite-ignore */ workerModule)) as {
  default: { request(path: string, init: RequestInit, env: unknown): Response | Promise<Response> };
};

const PROVIDER = 'authhero';
const SECRET = 'test-session-secret';
const staff = platformActorId.parse(ulid());

describe('POST /api/members/invite-link', () => {
  let dir: string;
  let host: SqliteScopeHost;
  let send: ReturnType<typeof vi.fn>;
  let clock: ReturnType<typeof manualClock>;
  let org: ReturnType<typeof orgId.parse>;
  let ownerPrincipal: ReturnType<typeof principalId.parse>;
  let env: Record<string, unknown>;
  const tenant = tenantId.parse(ulid());
  const dashScope = scopeId.parse(ulid());
  const subs = { owner: 'sub-owner', admin: 'sub-admin', member: 'sub-member', viewer: 'sub-viewer' } as const;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'substrat-invite-link-'));
    clock = manualClock(new Date());
    host = new SqliteScopeHost({ dir, clock: clock.read });
    shared.host = host;
    for (const m of MODULES) host.registerModule(m);
    send = vi.fn(async () => ({ delivered: ['x'], queued: [], permanent_bounces: [] }));
    env = {
      SCOPE: {},
      CONTROL_PLANE: {},
      SESSION_SECRET: SECRET,
      EMAIL: { send },
    };

    await host.admin.registerIdentityPool(staff, { provider: PROVIDER, topology: 'central', tenantId: null });
    const owner = principalId.parse(ulid());
    ownerPrincipal = owner;
    await provisionDashboard(host, { tenantId: tenant, scopeId: dashScope, owner, slug: 'links', name: 'Links' });
    org = orgId.parse(ulid());
    await host.admin.createOrg(staff, { id: org, tenantId: tenant, slug: 'team', name: 'Links' });
    await (await host.getScope(owner, tenant, dashScope)).invoke('dashboard/init-team', { orgId: org, ownerEmail: 'owner@links.test' });
    const link = (sub: string, principal: typeof owner) =>
      host.admin.linkIdentity(staff, { provider: PROVIDER, externalId: sub, principal, tenantId: tenant, scopeId: dashScope });
    await link(subs.owner, owner);
    for (const role of ['admin', 'member', 'viewer'] as const) {
      const p = principalId.parse(ulid());
      await host.admin.assignRole(staff, { principalId: p, roleKey: role, node: { tenantId: tenant, scopeId: null } });
      await link(subs[role], p);
    }
  });

  afterEach(async () => {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const asRole = (role: keyof typeof subs, path: string, body: unknown, method = 'POST') =>
    app.request(
      path,
      { method, headers: { cookie: `sb_session=${subs[role]}`, 'content-type': 'application/json' }, body: JSON.stringify(body) },
      env,
    );

  /** A pending invite made through the real route, then the mail spy cleared. */
  async function invite(email = 'rae@links.test', role: 'admin' | 'member' | 'viewer' = 'member'): Promise<string> {
    const res = await asRole('owner', '/api/members/invite', { email, roleKey: role });
    expect(res.status).toBe(201);
    send.mockClear();
    return ((await res.json()) as { invitationId: string }).invitationId;
  }

  const tokenOf = (acceptUrl: string) => acceptUrl.split('/invite/')[1]!;

  it('owner and admin get the link, and its token verifies for that invitation', async () => {
    const invitationId = await invite();
    for (const role of ['owner', 'admin'] as const) {
      const res = await asRole(role, '/api/members/invite-link', { invitationId });
      expect(res.status, `${role}: ${await res.clone().text()}`).toBe(200);
      const body = (await res.json()) as { invitationId: string; acceptUrl: string };
      expect(body.invitationId).toBe(invitationId);
      const claim = await verifyClaim<{ tenantId: string; scopeId: string; invitationId: string; exp: number }>(
        SECRET,
        INVITE_TOKEN_PURPOSE,
        tokenOf(body.acceptUrl),
        Date.now(),
      );
      expect(claim).toMatchObject({ tenantId: tenant, scopeId: dashScope, invitationId });
    }
  });

  it('the link is the producer’s: the real preview route reads the invitee from it', async () => {
    const invitationId = await invite('ivy@links.test', 'viewer');
    const { acceptUrl } = (await (await asRole('owner', '/api/members/invite-link', { invitationId })).json()) as { acceptUrl: string };
    const res = await app.request(`/api/invites/preview?token=${encodeURIComponent(tokenOf(acceptUrl))}`, {}, env);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ email: 'ivy@links.test', roleKey: 'viewer' });
  });

  it('sends no email — and its twin, resend, does', async () => {
    const invitationId = await invite();
    expect((await asRole('owner', '/api/members/invite-link', { invitationId })).status).toBe(200);
    expect(send).not.toHaveBeenCalled();

    expect((await asRole('owner', '/api/members/resend-invite', { invitationId })).status).toBe(200);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('a member or viewer is refused, and gets no link', async () => {
    const invitationId = await invite();
    for (const role of ['member', 'viewer'] as const) {
      const res = await asRole(role, '/api/members/invite-link', { invitationId });
      expect(res.status, role).toBe(403);
      expect(await res.text()).not.toContain('/invite/');
    }
    expect(send).not.toHaveBeenCalled();
  });

  it('an unknown, revoked or accepted invite is a 404', async () => {
    expect((await asRole('owner', '/api/members/invite-link', { invitationId: ulid() })).status).toBe(404);

    const revoked = await invite('gone@links.test');
    expect((await asRole('owner', '/api/members/revoke-invite', { invitationId: revoked })).status).toBeLessThan(300);
    expect((await asRole('owner', '/api/members/invite-link', { invitationId: revoked })).status).toBe(404);

    const accepted = await invite('sam@links.test');
    const sam = principalId.parse(ulid());
    await (await host.getScope(sam, tenant, dashScope)).invoke('dashboard/accept-invite', { invitationId: accepted, identifier: 'sam@links.test' });
    expect((await asRole('owner', '/api/members/invite-link', { invitationId: accepted })).status).toBe(404);
  });

  const invitationsOf = async (): Promise<string[]> => {
    const scope = await host.getScope(ownerPrincipal, tenant, dashScope);
    const page = await scope.invoke<{ entries: { id: string }[] }>('invites/list', { orgId: org });
    return page.entries.map((e) => e.id).sort();
  };

  it('is a pure read: no invitation is created, and an admin at the open-invite cap still gets the link', async () => {
    const first = await invite('cap0@links.test');
    for (let i = 1; i <= 25; i++) {
      expect((await asRole('admin', '/api/members/invite', { email: `cap${i}@links.test`, roleKey: 'viewer' })).status).toBe(201);
    }
    // The cap is real: a 26th send by this admin is refused …
    expect((await asRole('admin', '/api/members/invite', { email: 'over@links.test', roleKey: 'viewer' })).status).toBeGreaterThanOrEqual(400);
    const before = await invitationsOf();
    // … and looking at a link is not a send.
    for (const id of [first, before[0]!]) {
      expect((await asRole('admin', '/api/members/invite-link', { invitationId: id })).status).toBe(200);
    }
    expect(await invitationsOf()).toEqual(before);
  });

  it('a lapsed invite is a 409 pointing at Resend, and nothing is inserted', async () => {
    const invitationId = await invite();
    clock.advance(15 * 24 * 60 * 60 * 1000);
    const before = await invitationsOf();
    const res = await asRole('owner', '/api/members/invite-link', { invitationId });
    expect(res.status).toBe(409);
    expect(await res.text()).toMatch(/use Resend/);
    expect(await invitationsOf()).toEqual(before);
    expect(send).not.toHaveBeenCalled();
  });

  it('the token never outlives the invitation', async () => {
    clock.advance(-10 * 24 * 60 * 60 * 1000); // sent ten days ago: four days left
    const invitationId = await invite();
    clock.advance(10 * 24 * 60 * 60 * 1000);
    const body = (await (await asRole('owner', '/api/members/invite-link', { invitationId })).json()) as { acceptUrl: string; expiresAt: string };
    const claim = await verifyClaim<{ exp: number }>(SECRET, INVITE_TOKEN_PURPOSE, tokenOf(body.acceptUrl), Date.now());
    expect(claim!.exp).toBeLessThanOrEqual(Date.parse(body.expiresAt));
    expect(Date.parse(body.expiresAt)).toBeLessThan(Date.now() + 5 * 24 * 60 * 60 * 1000);
  });

  it('team A’s invite gets no link from team B, and team B’s scope cannot preview it', async () => {
    const invitationId = await invite();
    const tenantB = tenantId.parse(ulid());
    const scopeB = scopeId.parse(ulid());
    const ownerB = principalId.parse(ulid());
    await provisionDashboard(host, { tenantId: tenantB, scopeId: scopeB, owner: ownerB, slug: 'other', name: 'Other' });
    const orgB = orgId.parse(ulid());
    await host.admin.createOrg(staff, { id: orgB, tenantId: tenantB, slug: 'team', name: 'Other' });
    await (await host.getScope(ownerB, tenantB, scopeB)).invoke('dashboard/init-team', { orgId: orgB, ownerEmail: 'owner@other.test' });
    await host.admin.linkIdentity(staff, { provider: PROVIDER, externalId: 'sub-owner-b', principal: ownerB, tenantId: tenantB, scopeId: scopeB });

    const asB = await app.request(
      '/api/members/invite-link',
      { method: 'POST', headers: { cookie: 'sb_session=sub-owner-b', 'content-type': 'application/json' }, body: JSON.stringify({ invitationId }) },
      env,
    );
    expect(asB.status).toBe(404);
    const preview = await (await host.getScope(principalId.parse(ulid()), tenantB, scopeB)).invoke('dashboard/preview-invite', { invitationId });
    expect(preview).toBeNull();
  });

  it('no session is a 401', async () => {
    const invitationId = await invite();
    const res = await app.request(
      '/api/members/invite-link',
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ invitationId }) },
      env,
    );
    expect(res.status).toBe(401);
  });
});
