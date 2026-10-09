/**
 * The platform's invite routes over a REAL pure-SQLite host (#1931) — the twin of
 * `adapter-cloudflare/test/invite-bound.test.ts`. The grant and its take-back are the admin
 * surface's scope-level assignment here (this host has no CP-less `assignScopeRole`); the bound
 * is the host's bounded grant and bounded revoke, and the admin gate a real permission check. What is held: an admin
 * confers, and takes back, only a role whose permissions they hold at the scope — an
 * entity-narrowed grant counting for nothing — and a refusal writes no grant and no row.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { permissionKey, platformActorId, principalId, scopeId, tenantId, type PrincipalId } from '@substrat-run/contracts';
import { ulid, webCryptoSecretBox } from '@substrat-run/kernel';
import { permMod } from '@substrat-run/contract-tests';
import { mountInviteRoutes, type InviteDirectory } from '@substrat-run/vertical-auth/invite-routes';
import { SqliteScopeHost } from '../src/index.js';

type Row = { principal: string; roleKey: string; email: string | null; createdAt: number; capabilityId: string | null };

/** The identity DO's invite half, in memory — the bound under test is the host's, not the directory's. */
class MemoryDirectory implements InviteDirectory {
  readonly rows = new Map<string, Row>();
  async createInvite(_s: string, principal: string, roleKey: string, email: string | null, _h?: string, capabilityId: string | null = null) {
    this.rows.set(principal, { principal, roleKey, email, createdAt: 0, capabilityId });
  }
  async listInvites() {
    return [...this.rows.values()];
  }
  async getInvite(_s: string, principal: string) {
    return this.rows.get(principal) ?? null;
  }
  async revokeInvite(_s: string, principal: string) {
    const link = this.rows.get(principal)?.capabilityId ?? null;
    this.rows.delete(principal);
    return link;
  }
  async claimInvite() {
    return null;
  }
  async inviteLink(_s: string, principal: string) {
    return this.rows.get(principal)?.capabilityId ?? null;
  }
  async inviteMatches() {
    return false;
  }
  async claimInviteByCapability() {
    return null;
  }
}

describe('invite routes over the SQLite host — the assignment bound (#1931)', () => {
  let dir: string;
  let host: SqliteScopeHost;
  let app: Hono<{ Bindings: Record<string, never> }>;
  let directory: MemoryDirectory;
  let grants: string[];
  /** Which tenant the bound is asked under — another one makes it a `not_found` about the scope. */
  let boundTenant: typeof t;
  const staff = platformActorId.parse(ulid());
  const t = tenantId.parse(ulid());
  const s = scopeId.parse(ulid());
  const node = { tenantId: t, scopeId: s };
  const MANAGE = permissionKey.parse('perm:admin'); // what the vertical's admin gate asks for
  const READ = permissionKey.parse('perm:read');
  const BILL = permissionKey.parse('perm:use');
  const owner = principalId.parse(ulid()); // office-admin: everything
  const manager = principalId.parse(ulid()); // manager: MANAGE + READ, not BILL
  const narrowed = principalId.parse(ulid()); // gatekeeper (MANAGE) + READ on one entity only

  const probe = async (who: PrincipalId, perm: typeof READ): Promise<boolean> =>
    (await (await host.getScope(who, t, s)).invoke<{ allowed: boolean }>('perm/probe', { permission: perm })).allowed;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'substrat-invite-bound-'));
    host = new SqliteScopeHost({ dir, secretBox: webCryptoSecretBox('test-key', new Uint8Array(32).fill(7)) });
    host.registerModule(permMod);
    await host.admin.createTenant(staff, { id: t, slug: 'invite-bound', name: 'Invite Bound' });
    await host.admin.grantEntitlement(staff, t, 'perm');
    await host.provisionScope(staff, { tenantId: t, scopeId: s, vertical: 'perm-vertical' });
    await host.admin.activateScope(staff, t, s);
    const roles = {
      'office-admin': [MANAGE, READ, BILL],
      manager: [MANAGE, READ],
      gatekeeper: [MANAGE],
      reader: [READ],
    };
    for (const [key, permissions] of Object.entries(roles)) {
      await host.admin.defineRole(staff, t, { key, permissions, source: 'vertical' });
    }
    await host.admin.assignRole(staff, { principalId: owner, roleKey: 'office-admin', node });
    await host.admin.assignRole(staff, { principalId: manager, roleKey: 'manager', node });
    await host.admin.assignRole(staff, { principalId: narrowed, roleKey: 'gatekeeper', node });
    await host.admin.grant(staff, {
      principalId: narrowed,
      permission: READ,
      node,
      entity: { entityType: 'box', entityId: 'b1' },
      grantedBy: owner,
    });
  });

  afterAll(async () => {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  });

  beforeEach(() => {
    directory = new MemoryDirectory();
    grants = [];
    boundTenant = t;
    app = new Hono<{ Bindings: Record<string, never> }>();
    app.onError((err, c) => (err instanceof HTTPException ? err.getResponse() : c.json({ error: err.message }, 500)));
    mountInviteRoutes(app, {
      nodeFor: () => node,
      // A real gate: the caller named by a header must hold MANAGE here.
      requireAdmin: async (c) => {
        const principal = principalId.parse(c.req.header('x-caller'));
        if (!(await probe(principal, MANAGE))) throw new HTTPException(403, { message: 'only an admin can manage invites' });
        return { principal };
      },
      roles: ['office-admin', 'manager', 'reader'],
      directory: () => directory,
      assignScopeRoleBounded: async (_env, n, caller, principal, roleKey) => {
        const bound = await host.assignScopeRoleBounded(boundTenant, s, caller, principal, roleKey);
        if (bound.covered) grants.push(`${principal} ${roleKey}`);
        return bound;
      },
      revokeScopeRole: (_env, _scope, principal, roleKey) => host.admin.unassignRole(staff, { principalId: principal, roleKey, node }),
      revokeScopeRolesBounded: (_env, _node, caller, principal) => host.revokeScopeRolesBounded(boundTenant, s, caller, principal),
      // #1686: the invite's link, a `become` capability bounded by what the caller holds.
      mintBecomeCapabilityBounded: (_env, _node, caller, input) => host.mintBecomeCapabilityBounded(boundTenant, s, caller, input),
      revokeBecomeCapability: (_env, _node, id, by) => host.revokeBecomeCapability(boundTenant, s, id, by),
      exchangeCapability: (_env, _node, secret) => host.exchangeCapability(boundTenant, s, secret, { mode: 'become' }),
      authProvider: async () => {
        throw new Error('accept is not exercised here');
      },
    });
  });

  const invite = (who: PrincipalId, roleKey: string) =>
    app.request('http://app.example/api/invites', {
      method: 'POST',
      headers: { 'x-caller': who, 'content-type': 'application/json' },
      body: JSON.stringify({ roleKey }),
    });
  const revoke = (who: PrincipalId, principal: string) =>
    app.request(`http://app.example/api/invites/${principal}/revoke`, { method: 'POST', headers: { 'x-caller': who } });

  it('refuses an admin inviting at a role carrying more than they hold — 403, no grant, no row', async () => {
    const res = await invite(manager, 'office-admin');
    expect(res.status).toBe(403);
    expect(await res.text()).toMatch(/you do not hold perm:use/);
    expect(grants).toEqual([]);
    expect(directory.rows.size).toBe(0);
  });

  it('...while the same admin invites at a role they hold all of, and the grant is real', async () => {
    const res = await invite(manager, 'reader');
    expect(res.status).toBe(201);
    const { principal } = (await res.json()) as { principal: PrincipalId };
    expect(await probe(principal, READ)).toBe(true);
    expect(directory.rows.has(principal)).toBe(true);
  });

  it('lets the owner invite at the highest role', async () => {
    const res = await invite(owner, 'office-admin');
    expect(res.status).toBe(201);
    const { principal } = (await res.json()) as { principal: PrincipalId };
    expect(await probe(principal, BILL)).toBe(true);
  });

  /** Narrowing: READ held on ONE entity must not let its holder confer READ over the scope. */
  it('refuses an admin whose only hold on the role is entity-narrowed', async () => {
    // The control: the gate admits them, and they really do hold READ — on that entity.
    const narrowedStub = await host.getScope(narrowed, t, s);
    expect(
      (await narrowedStub.invoke<{ allowed: boolean }>('perm/probe', { permission: READ, entity: { entityType: 'box', entityId: 'b1' } }))
        .allowed,
    ).toBe(true);
    const res = await invite(narrowed, 'reader');
    expect(res.status).toBe(403);
    expect(await res.text()).toMatch(/you do not hold perm:read/);
    expect(grants).toEqual([]);
    expect(directory.rows.size).toBe(0);
  });

  it('bounds a withdrawal by the roles the principal holds: the manager cannot withdraw an office-admin invite, the owner can', async () => {
    const { principal } = (await (await invite(owner, 'office-admin')).json()) as { principal: PrincipalId };
    const refused = await revoke(manager, principal);
    expect(refused.status).toBe(403);
    expect(directory.rows.has(principal)).toBe(true);
    expect(await probe(principal, BILL)).toBe(true);
    const link = directory.rows.get(principal)!.capabilityId!;
    expect((await revoke(owner, principal)).status).toBe(204);
    expect(directory.rows.has(principal)).toBe(false);
    // The grant goes with the row: a withdrawn invite leaves its principal holding nothing.
    expect(await probe(principal, READ)).toBe(false);
    // …and its link (#1686) is revoked in the scope by the owner who withdrew it.
    expect((await host.admin.listCapabilities(staff, t, s, { includeRevoked: true })).entries.find((c) => c.id === link)).toMatchObject({ revokedBy: owner });
  });

  /**
   * The row's `roleKey` is what was minted and authorizes nothing (Codex #2057 r2): a role move
   * can land after the grant and leave the row stale. The withdrawal is bounded by what the
   * principal HOLDS, read in the scope task that takes it.
   */
  it('refuses a withdrawal by a stale row: minted at reader, moved to office-admin — the manager is refused', async () => {
    const { principal } = (await (await invite(owner, 'reader')).json()) as { principal: PrincipalId };
    expect((await host.changeScopeRoleBounded(t, s, owner, principal, 'reader', 'office-admin')).covered).toBe(true);
    expect(directory.rows.get(principal)?.roleKey).toBe('reader');
    expect((await revoke(manager, principal)).status).toBe(403);
    expect(directory.rows.has(principal)).toBe(true);
    expect(await probe(principal, BILL)).toBe(true);
    expect((await revoke(owner, principal)).status).toBe(204);
    expect(await probe(principal, READ)).toBe(false);
  });

  it('...and the twin: minted at office-admin, moved down to reader — the manager may withdraw it', async () => {
    const { principal } = (await (await invite(owner, 'office-admin')).json()) as { principal: PrincipalId };
    expect((await host.changeScopeRoleBounded(t, s, owner, principal, 'office-admin', 'reader')).covered).toBe(true);
    expect((await revoke(manager, principal)).status).toBe(204);
    expect(directory.rows.has(principal)).toBe(false);
  });

  /**
   * An invite stored at a role the tenant does not define (#1931 review): its principal holds
   * nothing that role could confer, so the withdrawal goes through. A `not_found` about the scope
   * still refuses.
   */
  const seeded = async (roleKey: string) => {
    const principal = principalId.parse(ulid());
    await directory.createInvite(s, principal, roleKey, null);
    return principal;
  };

  it('revokes an invite at a role the tenant does not define — the invite is gone', async () => {
    const principal = await seeded('retired');
    expect((await revoke(manager, principal)).status).toBe(204);
    expect(directory.rows.has(principal)).toBe(false);
  });

  it('...while a non-admin is still refused by the gate, and the invite stays', async () => {
    const principal = await seeded('retired');
    const res = await revoke(principalId.parse(ulid()), principal);
    expect([res.status, await res.text()]).toEqual([403, 'only an admin can manage invites']);
    expect(directory.rows.has(principal)).toBe(true);
  });

  it('refuses when the bounded revoke\'s not_found is about the scope — the invite stays', async () => {
    const principal = await seeded('retired');
    boundTenant = tenantId.parse(ulid());
    await expect(host.revokeScopeRolesBounded(boundTenant, s, manager, principal)).rejects.toThrow(/unknown scope/);
    expect((await revoke(manager, principal)).status).toBe(500);
    expect(directory.rows.has(principal)).toBe(true);
  });

  it('a non-admin is refused by the gate before the bound is asked', async () => {
    const stranger = principalId.parse(ulid());
    const res = await invite(stranger, 'reader');
    expect([res.status, await res.text()]).toEqual([403, 'only an admin can manage invites']);
    expect(grants).toEqual([]);
  });
});

/**
 * A member's role move and removal are ONE transaction on the store (Codex #2057 r1). The bound
 * and the write already ran in one actor turn; this is the other half — a statement that fails
 * part-way must take the earlier ones with it. Injected with a trigger on the scope's own file.
 */
describe('scope-role writes over the SQLite host — all or nothing (#1150)', () => {
  const staff = platformActorId.parse(ulid());
  const t = tenantId.parse(ulid());
  const s = scopeId.parse(ulid());
  const node = { tenantId: t, scopeId: s };
  const READ = permissionKey.parse('perm:read');
  const BILL = permissionKey.parse('perm:use');
  const owner = principalId.parse(ulid());
  let dir: string;
  let host: SqliteScopeHost;
  let file: InstanceType<typeof Database>;
  const rolesOf = async (who: PrincipalId) =>
    (await host.listScopeRoleHolders(t, s, who)).map((h) => h.roleKey).sort();
  const inject = (sql: string) => file.exec(`CREATE TRIGGER injected ${sql} BEGIN SELECT RAISE(ABORT, 'injected failure'); END;`);

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'substrat-role-atomic-'));
    host = new SqliteScopeHost({ dir });
    host.registerModule(permMod);
    await host.admin.createTenant(staff, { id: t, slug: 'role-atomic', name: 'Role Atomic' });
    await host.admin.grantEntitlement(staff, t, 'perm');
    await host.provisionScope(staff, { tenantId: t, scopeId: s, vertical: 'perm-vertical' });
    await host.admin.activateScope(staff, t, s);
    await host.admin.defineRole(staff, t, { key: 'lead', permissions: [READ, BILL], source: 'vertical' });
    await host.admin.defineRole(staff, t, { key: 'agent', permissions: [READ], source: 'vertical' });
    await host.admin.assignRole(staff, { principalId: owner, roleKey: 'lead', node });
    file = new Database(join(dir, `${t}__${s}.sqlite`));
  });

  afterAll(async () => {
    file.close();
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  });

  afterEach(() => {
    file.exec('DROP TRIGGER IF EXISTS injected');
  });

  it('a role move whose grant fails keeps the old role — never neither', async () => {
    const m = principalId.parse(ulid());
    await host.assignScopeRoleBounded(t, s, owner, m, 'agent');
    inject(`BEFORE INSERT ON _substrat_tuples WHEN NEW.relation = 'role:lead'`);
    await expect(host.changeScopeRoleBounded(t, s, owner, m, 'agent', 'lead')).rejects.toThrow(/injected failure/);
    expect(await rolesOf(m)).toEqual(['agent']);
    // The twin: with nothing injected, the same move lands.
    file.exec('DROP TRIGGER injected');
    expect((await host.changeScopeRoleBounded(t, s, owner, m, 'agent', 'lead')).covered).toBe(true);
    expect(await rolesOf(m)).toEqual(['lead']);
  });

  it('a removal whose second tombstone fails takes nothing', async () => {
    const m = principalId.parse(ulid());
    await host.assignScopeRoleBounded(t, s, owner, m, 'agent');
    await host.assignScopeRoleBounded(t, s, owner, m, 'lead');
    inject(`BEFORE UPDATE ON _substrat_tuples WHEN NEW.relation = 'role:lead' AND NEW.revoked_at IS NOT NULL`);
    await expect(host.revokeScopeRolesBounded(t, s, owner, m)).rejects.toThrow(/injected failure/);
    expect(await rolesOf(m)).toEqual(['agent', 'lead']);
    file.exec('DROP TRIGGER injected');
    expect((await host.revokeScopeRolesBounded(t, s, owner, m)).revoked.sort()).toEqual(['agent', 'lead']);
    expect(await rolesOf(m)).toEqual([]);
  });
});
