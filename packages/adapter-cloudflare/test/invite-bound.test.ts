/**
 * The platform's invite routes over a REAL CP-less host (#1931) — the path every demo vertical
 * that mounts them runs: `assignScopeRole`, `revokeScopeRole` and the new `canAssign` answered
 * by the ScopeDO, the admin gate a real permission check. What the routes promise over stand-ins
 * (`packages/vertical-auth/test/invite-routes.test.ts`) is held here against the producer: an
 * admin confers, and takes back, only a role whose permissions they hold at the scope — an
 * entity-narrowed grant counting for nothing — and a refusal writes no grant and no row.
 */
import { env } from 'cloudflare:test';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { permissionKey, principalId, scopeId, tenantId, type PrincipalId } from '@substrat-run/contracts';
import { ulid, webCryptoSecretBox } from '@substrat-run/kernel';
import { mountInviteRoutes, type InviteDirectory } from '@substrat-run/vertical-auth/invite-routes';
import { CloudflareScopeHost } from '../src/host.js';

type Row = { principal: string; roleKey: string; email: string | null; createdAt: number };

/** The identity DO's invite half, in memory — the bound under test is the host's, not the directory's. */
class MemoryDirectory implements InviteDirectory {
  readonly rows = new Map<string, Row>();
  async createInvite(_s: string, principal: string, roleKey: string, email: string | null) {
    this.rows.set(principal, { principal, roleKey, email, createdAt: 0 });
  }
  async listInvites() {
    return [...this.rows.values()];
  }
  async getInvite(_s: string, principal: string) {
    return this.rows.get(principal) ?? null;
  }
  async revokeInvite(_s: string, principal: string) {
    this.rows.delete(principal);
  }
  async claimInvite() {
    return null;
  }
}

describe('invite routes over a CP-less host — the canAssign bound (#1931)', () => {
  let host: CloudflareScopeHost;
  let app: Hono<{ Bindings: Record<string, never> }>;
  let directory: MemoryDirectory;
  let grants: string[];
  /** Which tenant the bound is asked under — another one makes it a `not_found` about the scope. */
  let boundTenant: typeof t;
  const t = tenantId.parse(ulid());
  const s = scopeId.parse(ulid());
  const MANAGE = permissionKey.parse('perm:admin'); // what the vertical's admin gate asks for
  const READ = permissionKey.parse('perm:read');
  const BILL = permissionKey.parse('perm:use');
  const owner = principalId.parse(ulid()); // office-admin: everything
  const manager = principalId.parse(ulid()); // manager: MANAGE + READ, not BILL
  const narrowed = principalId.parse(ulid()); // gatekeeper (MANAGE) + READ on one entity only

  const probe = async (who: PrincipalId, perm: typeof READ): Promise<boolean> =>
    (await (await host.getScope(who, t, s)).invoke<{ allowed: boolean }>('perm/probe', { permission: perm })).allowed;

  beforeAll(async () => {
    host = new CloudflareScopeHost({ scope: env.SCOPE, secretBox: webCryptoSecretBox('test-key', new Uint8Array(32).fill(7)) });
    await host.provisionScopeLocal({
      tenantId: t,
      scopeId: s,
      owner,
      roles: [
        { key: 'office-admin', permissions: [MANAGE, READ, BILL], source: 'vertical' },
        { key: 'manager', permissions: [MANAGE, READ], source: 'vertical' },
        { key: 'gatekeeper', permissions: [MANAGE], source: 'vertical' },
        { key: 'reader', permissions: [READ], source: 'vertical' },
      ],
      ownerRoleKey: 'office-admin',
    });
    await host.assignScopeRole(s, manager, 'manager');
    await host.assignScopeRole(s, narrowed, 'gatekeeper');
    await host.grantEntityLocal(s, narrowed, READ, { entityType: 'box', entityId: 'b1' });
  });

  afterAll(async () => host.close());

  beforeEach(() => {
    directory = new MemoryDirectory();
    grants = [];
    boundTenant = t;
    app = new Hono<{ Bindings: Record<string, never> }>();
    app.onError((err, c) => (err instanceof HTTPException ? err.getResponse() : c.json({ error: err.message }, 500)));
    mountInviteRoutes(app, {
      nodeFor: () => ({ tenantId: t, scopeId: s }),
      // A real gate: the caller named by a header must hold MANAGE here.
      requireAdmin: async (c) => {
        const principal = principalId.parse(c.req.header('x-caller'));
        if (!(await probe(principal, MANAGE))) throw new HTTPException(403, { message: 'only an admin can manage invites' });
        return { principal };
      },
      roles: ['office-admin', 'manager', 'reader'],
      directory: () => directory,
      assignScopeRoleBounded: async (_env, node, caller, principal, roleKey) => {
        const bound = await host.assignScopeRoleBounded(boundTenant, node.scopeId, caller, principal, roleKey);
        if (bound.covered) grants.push(`${principal} ${roleKey}`);
        return bound;
      },
      revokeScopeRole: (_env, scope, principal, roleKey) => host.revokeScopeRole(scopeId.parse(scope), principal, roleKey),
      canAssign: (_env, node, principal, roleKey) => host.canAssign(boundTenant, node.scopeId, principal, roleKey),
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

  it('bounds revoke by the stored invite’s role: the manager cannot revoke an office-admin invite, the owner can', async () => {
    const { principal } = (await (await invite(owner, 'office-admin')).json()) as { principal: string };
    const refused = await revoke(manager, principal);
    expect(refused.status).toBe(403);
    expect(directory.rows.has(principal)).toBe(true);
    expect((await revoke(owner, principal)).status).toBe(204);
    expect(directory.rows.has(principal)).toBe(false);
  });

  /**
   * An invite stored at a role the tenant does not define (#1931 review): the host's `not_found`
   * for that role confers nothing, so the revoke goes through. A `not_found` about anything else
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

  it('refuses when the bound\'s not_found is about the scope, not the role — the invite stays', async () => {
    const principal = await seeded('retired');
    boundTenant = tenantId.parse(ulid());
    await expect(host.canAssign(boundTenant, s, manager, 'retired')).rejects.toThrow(/unknown scope/);
    expect((await revoke(manager, principal)).status).toBe(500);
    expect(directory.rows.has(principal)).toBe(true);
  });

  it('a non-admin is refused by the gate before the bound is asked', async () => {
    const stranger = principalId.parse(ulid());
    const res = await invite(stranger, 'reader');
    expect([res.status, await res.text()]).toEqual([403, 'only an admin can manage invites']);
    expect(grants).toEqual([]);
  });

  it('host.canAssign throws not_found on a role this scope never projected', async () => {
    await expect(host.canAssign(t, s, owner, 'not-a-projected-role')).rejects.toThrow(/no such role/);
  });

  /**
   * The real drop, and last because it re-projects this scope's roles: an invite made while
   * `reader` existed, then `reader` removed by a re-provision. Its grant now confers nothing,
   * and an admin can still withdraw the link.
   */
  it('revokes an invite whose role was dropped after it was made; the grant it held confers nothing', async () => {
    const { principal } = (await (await invite(owner, 'reader')).json()) as { principal: PrincipalId };
    expect(await probe(principal, READ)).toBe(true);
    await host.provisionScopeLocal({
      tenantId: t,
      scopeId: s,
      owner,
      roles: [
        { key: 'office-admin', permissions: [MANAGE, READ, BILL], source: 'vertical' },
        { key: 'manager', permissions: [MANAGE, READ], source: 'vertical' },
        { key: 'gatekeeper', permissions: [MANAGE], source: 'vertical' },
      ],
      ownerRoleKey: 'office-admin',
    });
    expect(await probe(principal, READ)).toBe(false);
    expect((await revoke(manager, principal)).status).toBe(204);
    expect(directory.rows.has(principal)).toBe(false);
  });
});
