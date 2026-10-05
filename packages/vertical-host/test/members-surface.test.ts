/**
 * An installed vertical's members, managed on the platform's instruction (#1150), end to end:
 * `/internal/members*` over a REAL pure scope host (the kernel's bounded verbs)
 * and a REAL identity directory (the `invite` and `identity` rows over SQLite, the functions the
 * IdentityDO delegates to), with vertical-auth's `membersHook` and `mintMemberInvite` and the
 * vertical's own `/api/accept-invite` mounted on the same app — so an invite the platform mints
 * is accepted exactly where a vertical's own invite is.
 *
 * Who may do what is the kernel's §5.1 bound, at the vertical's scope, asked about the caller the
 * platform names: the owner holds `lead` and manages everyone; an `agent` may invite and remove
 * agents and nobody above; a principal holding nothing in the scope changes nothing.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  PLATFORM_SECRET_HEADER,
  permissionKey,
  platformActorId,
  principalId,
  scopeId,
  tenantId,
  type PrincipalId,
} from '@substrat-run/contracts';
import { ulid } from '@substrat-run/kernel';
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { permMod } from '@substrat-run/contract-tests';
import * as invites from '@substrat-run/vertical-auth/member-directory';
import { MEMBER_DIRECTORY_DDL, migrateOwnerSeat, unbindPrincipal, type RegistrySql } from '@substrat-run/vertical-auth/member-directory';
import { membersHook, mountInviteRoutes } from '@substrat-run/vertical-auth/invite-routes';
import { mountPlatformSurface, type VerticalScopeHost } from '../src/index.js';

const SECRET = 'sekret';
type Env = { PLATFORM_SECRET: string };
const ENV: Env = { PLATFORM_SECRET: SECRET };
const PERM_USE = permissionKey.parse('perm:use');
const PERM_READ = permissionKey.parse('perm:read');

function sqlOver(db: InstanceType<typeof Database>): RegistrySql {
  return {
    exec(query, ...params) {
      const stmt = db.prepare(query);
      if (stmt.reader) return stmt.all(...(params as never[])) as Record<string, unknown>[];
      stmt.run(...(params as never[]));
      return [];
    },
  };
}

describe('/internal/members — an installed vertical’s members, managed from the platform', () => {
  const dir = mkdtempSync(join(tmpdir(), 'substrat-members-'));
  const host = new SqliteScopeHost({ dir });
  const staff = platformActorId.parse(ulid());
  const t1 = tenantId.parse(ulid());
  const s1 = scopeId.parse(ulid());
  const t2 = tenantId.parse(ulid());
  const s2 = scopeId.parse(ulid());
  const owner = principalId.parse(ulid()); // the installer: `lead` at s1, the owner of record
  const agent = principalId.parse(ulid()); // `agent` at s1
  const nobody = principalId.parse(ulid()); // a tenant principal holding nothing at s1
  const robot = principalId.parse(ulid()); // a service principal: `service`, not a member role
  const otherOwner = principalId.parse(ulid()); // `lead` in ANOTHER tenant's scope

  // The tenant's identity directory: the IdentityDO's own rows, over SQLite.
  const sql = (() => {
    const db = new Database(':memory:');
    const over = sqlOver(db);
    for (const stmt of MEMBER_DIRECTORY_DDL) over.exec(stmt);
    migrateOwnerSeat(over);
    return over;
  })();
  const directory = {
    listInvites: async (scope: string) => invites.listInvites(sql, scope),
    getInvite: async (scope: string, p: string) => invites.getInvite(sql, scope, p),
    createInvite: async (scope: string, p: string, r: string, e: string | null, h: string) => invites.createInvite(sql, scope, p, r, e, h),
    revokeInvite: async (scope: string, p: string) => invites.revokeInvite(sql, scope, p),
    claimInvite: async (scope: string, sub: string, h: string) => invites.claimInvite(sql, scope, sub, h),
    listMemberBindings: async (scope: string) => invites.listMemberBindings(sql, scope),
    unbindPrincipal: async (scope: string, p: string) => unbindPrincipal(sql, scope, p),
  };

  // The deployment's host as the platform surface sees it: the pure host's real verbs, and the
  // unbounded revoke the invite's rollback uses (the Cloudflare host's `revokeScopeRole`).
  const surfaceHost = {
    canAssign: host.canAssign.bind(host),
    assignScopeRoleBounded: host.assignScopeRoleBounded.bind(host),
    listScopeRoleHolders: host.listScopeRoleHolders.bind(host),
    changeScopeRoleBounded: host.changeScopeRoleBounded.bind(host),
    revokeScopeRolesBounded: host.revokeScopeRolesBounded.bind(host),
    revokeScopeRole: async (scope: string, p: PrincipalId, roleKey: string) => {
      await host.admin.unassignRole(staff, { principalId: p, roleKey, node: { tenantId: t1, scopeId: scopeId.parse(scope) } });
      return true;
    },
  } as unknown as VerticalScopeHost;

  const owners = new Map<string, PrincipalId>([[s1, owner], [s2, otherOwner]]);
  const surfaceDeps = {
    platformSecret: (env: Env) => env.PLATFORM_SECRET,
    hostFor: () => surfaceHost,
    roles: [],
    ownerRoleKey: 'lead',
    resolveOwner: async (_env: Env, ref: { scopeId: string }) => owners.get(ref.scopeId) ?? null,
  };
  const app = new Hono<{ Bindings: Env }>();
  mountPlatformSurface<Env>(app, {
    ...surfaceDeps,
    members: membersHook<Env, typeof directory>({ roles: ['lead', 'agent'], directory: () => directory }),
  });
  // The vertical's own accept route — `x-sub` stands in for a verified login.
  mountInviteRoutes<Env, { scopeId: string }>(app, {
    nodeFor: () => ({ scopeId: s1 }),
    requireAdmin: async () => {
      throw new Error('not reached');
    },
    canAssign: async () => ({ covered: true, missing: [] }),
    assignScopeRoleBounded: async () => ({ covered: true, missing: [] }),
    roles: [],
    directory: () => directory,
    revokeScopeRole: async () => undefined,
    authProvider: async (_env, req) => ({
      handle: async () => new Response(null, { status: 404 }),
      resolve: async () => {
        const sub = req.headers.get('x-sub');
        return sub ? { sub, email: null, name: null } : null;
      },
    }),
  });

  const platform = { [PLATFORM_SECRET_HEADER]: SECRET, 'content-type': 'application/json' };
  const post = (path: string, body: object) =>
    app.request(path, { method: 'POST', headers: platform, body: JSON.stringify(body) }, ENV);
  const roster = async (tenant = t1, scope = s1) =>
    app.request(`/internal/members?tenantId=${tenant}&scopeId=${scope}`, { headers: platform }, ENV);
  const rosterOf = async () => (await roster()).json() as Promise<{
    roles: string[];
    members: { principal: string; roles: string[]; logins: number; email: string | null; owner: boolean }[];
    invites: { principal: string; roleKey: string }[];
  }>;
  const invite = (caller: PrincipalId, roleKey: string, email: string | null = null, tenant = t1, scope = s1) =>
    post('/internal/members/invite', { tenantId: tenant, scopeId: scope, caller, origin: 'https://desk.example/', roleKey, email });
  const accept = (acceptUrl: string, sub: string) =>
    app.request(
      '/api/accept-invite',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-sub': sub },
        body: JSON.stringify({ token: new URL(acceptUrl).searchParams.get('invite') }),
      },
      ENV,
    );
  const holds = async (who: PrincipalId, perm = PERM_READ) =>
    (await (await host.getScope(who, t1, s1)).invoke('perm/probe', { permission: perm }) as { allowed: boolean }).allowed;
  const rolesOf = async (who: string) =>
    (await host.listScopeRoleHolders(t1, s1)).filter((h) => h.principal === who).map((h) => h.roleKey).sort();
  /** A member who accepted: minted by the owner at `roleKey`, accepted as `sub`. */
  const member = async (roleKey: string, sub = `sub-${ulid()}`) => {
    const res = await invite(owner, roleKey, `${sub}@example.test`);
    expect(res.status).toBe(201);
    const minted = (await res.json()) as { principal: PrincipalId; acceptUrl: string };
    expect((await accept(minted.acceptUrl, sub)).status).toBe(200);
    return minted.principal;
  };

  beforeAll(async () => {
    host.registerModule(permMod);
    for (const [t, s, who] of [[t1, s1, owner], [t2, s2, otherOwner]] as const) {
      await host.admin.createTenant(staff, { id: t, slug: `members-${t.slice(-6).toLowerCase()}`, name: 'Members' });
      await host.admin.grantEntitlement(staff, t, 'perm');
      await host.provisionScope(staff, { tenantId: t, scopeId: s, vertical: 'perm-vertical' });
      await host.admin.activateScope(staff, t, s);
      await host.admin.defineRole(staff, t, { key: 'lead', permissions: [PERM_USE, PERM_READ], source: 'vertical' });
      await host.admin.defineRole(staff, t, { key: 'agent', permissions: [PERM_READ], source: 'vertical' });
      await host.admin.defineRole(staff, t, { key: 'service', permissions: [PERM_READ], source: 'vertical' });
      await host.admin.assignRole(staff, { principalId: who, roleKey: 'lead', node: { tenantId: t, scopeId: s } });
    }
    await host.admin.assignRole(staff, { principalId: agent, roleKey: 'agent', node: { tenantId: t1, scopeId: s1 } });
    await host.admin.assignRole(staff, { principalId: robot, roleKey: 'service', node: { tenantId: t1, scopeId: s1 } });
  });

  afterAll(async () => {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('lists the roster: the owner of record marked, the member roles offered', async () => {
    const body = await rosterOf();
    expect(body.roles).toEqual(['lead', 'agent']);
    expect(body.members).toEqual(expect.arrayContaining([
      { principal: owner, roles: ['lead'], logins: 0, email: null, owner: true },
      { principal: agent, roles: ['agent'], logins: 0, email: null, owner: false },
    ]));
    expect(body.members.find((m) => m.principal === nobody)).toBeUndefined();
  });

  it('invites: a one-time link on the origin given, accepted at the vertical’s own route', async () => {
    const res = await invite(owner, 'agent', 'kim@example.test');
    expect(res.status).toBe(201);
    const minted = (await res.json()) as { principal: PrincipalId; acceptUrl: string; email: string };
    expect(minted.acceptUrl).toMatch(/^https:\/\/desk\.example\/\?invite=/);
    expect((await rosterOf()).invites).toEqual([expect.objectContaining({ principal: minted.principal, roleKey: 'agent' })]);
    expect((await accept(minted.acceptUrl, 'kim')).status).toBe(200);
    const after = await rosterOf();
    expect(after.invites).toEqual([]);
    expect(after.members).toContainEqual({ principal: minted.principal, roles: ['agent'], logins: 1, email: 'kim@example.test', owner: false });
    expect(await holds(minted.principal)).toBe(true);
  });

  it('lets an agent invite an agent — the bound is what the caller holds, not a title', async () => {
    expect((await invite(agent, 'agent')).status).toBe(201);
  });

  it('refuses an escalating invite, writing nothing', async () => {
    const before = await host.listScopeRoleHolders(t1, s1);
    const openBefore = (await rosterOf()).invites;
    const res = await invite(agent, 'lead');
    expect(res.status).toBe(403);
    expect(await res.text()).toMatch(/you cannot invite at 'lead'.*perm:use/);
    expect(await host.listScopeRoleHolders(t1, s1)).toEqual(before);
    expect((await rosterOf()).invites).toEqual(openBefore);
  });

  it('refuses a caller holding nothing in the scope', async () => {
    const before = await host.listScopeRoleHolders(t1, s1);
    expect((await invite(nobody, 'agent')).status).toBe(403);
    expect(await host.listScopeRoleHolders(t1, s1)).toEqual(before);
  });

  it('refuses a role outside the declared member roles', async () => {
    expect((await invite(owner, 'service')).status).toBe(400);
  });

  it('changes a role in one write, bounded on both ends', async () => {
    const m = await member('agent');
    expect((await post('/internal/members/role', { tenantId: t1, scopeId: s1, caller: agent, principal: m, from: 'agent', to: 'lead' })).status).toBe(403);
    expect(await rolesOf(m)).toEqual(['agent']);
    expect((await post('/internal/members/role', { tenantId: t1, scopeId: s1, caller: owner, principal: m, from: 'agent', to: 'lead' })).status).toBe(200);
    expect(await rolesOf(m)).toEqual(['lead']);
    expect(await holds(m, PERM_USE)).toBe(true);
    // Demoting a lead takes the same bound: an agent cannot.
    expect((await post('/internal/members/role', { tenantId: t1, scopeId: s1, caller: agent, principal: m, from: 'lead', to: 'agent' })).status).toBe(403);
    expect(await rolesOf(m)).toEqual(['lead']);
  });

  it('removes a member: every role, every login, bounded by the caller', async () => {
    const m = await member('lead', 'lee');
    const refused = await post('/internal/members/remove', { tenantId: t1, scopeId: s1, caller: agent, principal: m });
    expect(refused.status).toBe(403);
    expect(await rolesOf(m)).toEqual(['lead']);
    expect(invites.listMemberBindings(sql, s1).find((b) => b.principal === m)?.logins).toBe(1);

    const res = await post('/internal/members/remove', { tenantId: t1, scopeId: s1, caller: owner, principal: m });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ revoked: ['lead'], unbound: 1, inviteWithdrawn: false });
    expect(await rolesOf(m)).toEqual([]);
    expect(await holds(m)).toBe(false);
    expect(invites.listMemberBindings(sql, s1).find((b) => b.principal === m)?.logins ?? 0).toBe(0);
    expect((await rosterOf()).members.find((x) => x.principal === m)).toBeUndefined();
  });

  it('lets an agent remove an agent', async () => {
    const m = await member('agent');
    expect((await post('/internal/members/remove', { tenantId: t1, scopeId: s1, caller: agent, principal: m })).status).toBe(200);
    expect(await holds(m)).toBe(false);
  });

  /** An accept only binds, in the directory the removal withdraws in: the old link finds nothing. */
  it('withdraws a pending invite with the removal, so its link no longer joins anyone', async () => {
    const minted = (await (await invite(owner, 'agent', 'late@example.test')).json()) as { principal: PrincipalId; acceptUrl: string };
    const res = await post('/internal/members/remove', { tenantId: t1, scopeId: s1, caller: owner, principal: minted.principal });
    expect(await res.json()).toEqual({ revoked: ['agent'], unbound: 0, inviteWithdrawn: true });
    expect((await accept(minted.acceptUrl, 'late')).status).toBe(400);
    expect(await holds(minted.principal)).toBe(false);
    expect(invites.listMemberBindings(sql, s1).find((b) => b.principal === minted.principal)?.logins ?? 0).toBe(0);
  });

  /** The bound is asked before anything is touched: a refused removal leaves the open invite usable. */
  it('refuses a removal beyond the caller before withdrawing anything', async () => {
    const minted = (await (await invite(owner, 'lead', 'boss@example.test')).json()) as { principal: PrincipalId; acceptUrl: string };
    expect((await post('/internal/members/remove', { tenantId: t1, scopeId: s1, caller: agent, principal: minted.principal })).status).toBe(403);
    expect((await rosterOf()).invites.map((i) => i.principal)).toContain(minted.principal);
    expect((await accept(minted.acceptUrl, 'boss')).status).toBe(200);
    expect(await rolesOf(minted.principal)).toEqual(['lead']);
  });

  /** Removal is bounded by the roles it takes; a principal with none is not the dashboard's to unbind. */
  it('refuses to remove a principal holding no role and no invite, leaving their logins bound', async () => {
    const m = await member('agent', 'gone-once');
    expect((await post('/internal/members/remove', { tenantId: t1, scopeId: s1, caller: owner, principal: m })).status).toBe(200);
    // A login bound to a principal that holds only what a role cannot reach (an entity grant, say).
    sql.exec('INSERT INTO identity (scope_id, sub, principal) VALUES (?, ?, ?)', s1, 'portal-sub', m);
    const res = await post('/internal/members/remove', { tenantId: t1, scopeId: s1, caller: nobody, principal: m });
    expect(res.status).toBe(404);
    expect(invites.listMemberBindings(sql, s1).find((b) => b.principal === m)?.logins).toBe(1);
  });

  it('refuses to remove or move the owner of record — that is the hand-over', async () => {
    const remove = await post('/internal/members/remove', { tenantId: t1, scopeId: s1, caller: owner, principal: owner });
    expect(remove.status).toBe(409);
    expect(await remove.text()).toMatch(/owner of record/);
    expect((await post('/internal/members/role', { tenantId: t1, scopeId: s1, caller: owner, principal: owner, from: 'lead', to: 'agent' })).status).toBe(409);
    expect(await rolesOf(owner)).toEqual(['lead']);
  });

  it('refuses to remove a principal holding a role the dashboard does not manage', async () => {
    expect((await post('/internal/members/remove', { tenantId: t1, scopeId: s1, caller: owner, principal: robot })).status).toBe(409);
    expect(await rolesOf(robot)).toEqual(['service']);
  });

  it('isolates tenants: a scope named under another tenant is unknown, and nothing is written', async () => {
    expect((await roster(t2, s1)).status).toBe(404);
    expect((await invite(owner, 'agent', null, t2, s1)).status).toBe(404);
    // The other tenant's own owner holds `lead` there, and still nothing at ours.
    expect((await invite(otherOwner, 'agent', null, t1, s1)).status).toBe(403);
    const m = await member('agent');
    expect((await post('/internal/members/remove', { tenantId: t2, scopeId: s1, caller: otherOwner, principal: m })).status).toBe(404);
    expect(await rolesOf(m)).toEqual(['agent']);
  });

  it('answers 501 on a vertical that declares no member roles', async () => {
    const bare = new Hono<{ Bindings: Env }>();
    mountPlatformSurface<Env>(bare, surfaceDeps);
    expect((await bare.request(`/internal/members?tenantId=${t1}&scopeId=${s1}`, { headers: platform }, ENV)).status).toBe(501);
    const res = await bare.request('/internal/members/invite', {
      method: 'POST', headers: platform,
      body: JSON.stringify({ tenantId: t1, scopeId: s1, caller: owner, origin: 'https://desk.example', roleKey: 'agent', email: null }),
    }, ENV);
    expect(res.status).toBe(501);
  });
});
