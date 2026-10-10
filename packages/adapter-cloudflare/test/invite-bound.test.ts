/**
 * The platform's invite routes over a REAL CP-less host (#1931) — the path every demo vertical
 * that mounts them runs: the bounded grant, `revokeScopeRole` and the bounded revoke answered
 * by the ScopeDO, the admin gate a real permission check. What the routes promise over stand-ins
 * (`packages/vertical-auth/test/invite-routes.test.ts`) is held here against the producer: an
 * admin confers, and takes back, only a role whose permissions they hold at the scope — an
 * entity-narrowed grant counting for nothing — and a refusal writes no grant and no row.
 */
import { env, runInDurableObject } from 'cloudflare:test';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { permissionKey, principalId, scopeId, tenantId, type PrincipalId } from '@substrat-run/contracts';
import { ulid, webCryptoSecretBox, type ShapeCursor } from '@substrat-run/kernel';
import { mountInviteRoutes, type InviteDirectory } from '@substrat-run/vertical-auth/invite-routes';
import { CloudflareScopeHost } from '../src/host.js';

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

describe('invite routes over a CP-less host — the assignment bound (#1931)', () => {
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
        const bound = await host.assignScopeRoleBounded(boundTenant, s, caller, principal, roleKey);
        if (bound.covered) grants.push(`${principal} ${roleKey}`);
        return bound;
      },
      revokeScopeRole: (_env, scope, principal, roleKey) => host.revokeScopeRole(scopeId.parse(scope), principal, roleKey),
      revokeScopeRolesBounded: (_env, _node, caller, principal) => host.revokeScopeRolesBounded(boundTenant, s, caller, principal),
      // #1686: the invite's link, a `become` capability bounded by what the caller holds.
      mintBecomeCapabilityBounded: (_env, _node, caller, input) => host.mintBecomeCapabilityBounded(boundTenant, s, caller, input),
      revokeBecomeCapability: (_env, _node, id, by) => host.revokeBecomeCapability(boundTenant, s, id, by),
      exchangeCapability: (_env, _node, secret) => host.exchangeCapability(boundTenant, s, secret, { mode: 'become' }),
      becomeLinkStates: (_env, _node, ids) => host.becomeLinkStates(boundTenant, s, ids),
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
    expect((await host.listCapabilitiesLocal(s, { includeRevoked: true })).entries.find((c) => c.id === link)).toMatchObject({ revokedBy: owner });
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

/**
 * A member's role move and removal are ONE transaction in the ScopeDO (Codex #2057 r1) — the
 * twin of adapter-sqlite's. The bound and the writes already ran in one queued task; this holds
 * the other half: a statement failing part-way takes the earlier ones with it. Injected with a
 * trigger in the DO's own storage.
 */
describe('scope-role writes over a CP-less host — all or nothing (#1150)', () => {
  let host: CloudflareScopeHost;
  const t = tenantId.parse(ulid());
  const s = scopeId.parse(ulid());
  const READ = permissionKey.parse('perm:read');
  const BILL = permissionKey.parse('perm:use');
  const owner = principalId.parse(ulid());
  const stub = () => env.SCOPE.get(env.SCOPE.idFromName(s));
  const sqlIn = (statement: string) => runInDurableObject(stub(), (_i, state) => void state.storage.sql.exec(statement));
  const inject = (when: string) => sqlIn(`CREATE TRIGGER injected ${when} BEGIN SELECT RAISE(ABORT, 'injected failure'); END;`);
  const rolesOf = async (who: PrincipalId) => (await host.listScopeRoleHolders(t, s, who)).map((h) => h.roleKey).sort();

  beforeAll(async () => {
    host = new CloudflareScopeHost({ scope: env.SCOPE, secretBox: webCryptoSecretBox('test-key', new Uint8Array(32).fill(7)) });
    await host.provisionScopeLocal({
      tenantId: t,
      scopeId: s,
      owner,
      roles: [
        { key: 'lead', permissions: [READ, BILL], source: 'vertical' },
        { key: 'agent', permissions: [READ], source: 'vertical' },
      ],
      ownerRoleKey: 'lead',
    });
  });

  afterAll(async () => host.close());

  // A case failing between its CREATE and its DROP must not leave the trigger to the next one.
  afterEach(async () => sqlIn('DROP TRIGGER IF EXISTS injected'));

  it('a role move whose grant fails keeps the old role — never neither', async () => {
    const m = principalId.parse(ulid());
    await host.assignScopeRoleBounded(t, s, owner, m, 'agent');
    await inject(`BEFORE INSERT ON _substrat_tuples WHEN NEW.relation = 'role:lead'`);
    await expect(host.changeScopeRoleBounded(t, s, owner, m, 'agent', 'lead')).rejects.toThrow(/injected failure/);
    expect(await rolesOf(m)).toEqual(['agent']);
    await sqlIn('DROP TRIGGER injected');
    expect((await host.changeScopeRoleBounded(t, s, owner, m, 'agent', 'lead')).covered).toBe(true);
    expect(await rolesOf(m)).toEqual(['lead']);
  });

  it('a removal whose second tombstone fails takes nothing', async () => {
    const m = principalId.parse(ulid());
    await host.assignScopeRoleBounded(t, s, owner, m, 'agent');
    await host.assignScopeRoleBounded(t, s, owner, m, 'lead');
    await inject(`BEFORE UPDATE ON _substrat_tuples WHEN NEW.relation = 'role:lead' AND NEW.revoked_at IS NOT NULL`);
    await expect(host.revokeScopeRolesBounded(t, s, owner, m)).rejects.toThrow(/injected failure/);
    expect(await rolesOf(m)).toEqual(['agent', 'lead']);
    await sqlIn('DROP TRIGGER injected');
    expect((await host.revokeScopeRolesBounded(t, s, owner, m)).revoked.sort()).toEqual(['agent', 'lead']);
    expect(await rolesOf(m)).toEqual([]);
  });
});

/**
 * #2071 over the CP-less host a deployed vertical runs: the shape granted with
 * `grantEntityShapeLocal` at link time, and topped up by `provisionScopeLocal`'s
 * `entityGrants` — the call every provision, `/internal/reconcile` and listed promote makes.
 */
describe('a declared entity-grant shape over a CP-less host (#2071)', () => {
  let host: CloudflareScopeHost;
  const t = tenantId.parse(ulid());
  const s = scopeId.parse(ulid());
  const READ = permissionKey.parse('perm:read');
  const USE = permissionKey.parse('perm:use');
  const owner = principalId.parse(ulid());
  const employee = principalId.parse(ulid());
  const record = { entityType: 'employee', entityId: 'e1' };
  const provision = (permissions?: (typeof READ)[]) =>
    host.provisionScopeLocal({
      tenantId: t,
      scopeId: s,
      owner,
      roles: [{ key: 'office-admin', permissions: [READ, USE], source: 'vertical' }],
      ownerRoleKey: 'office-admin',
      ...(permissions ? { entityGrants: [{ entityType: 'employee', permissions, bootstrap: true as const }] } : {}),
    });
  const can = async (perm: typeof READ): Promise<boolean> =>
    (await (await host.getScope(employee, t, s)).invoke<{ allowed: boolean }>('perm/probe', { permission: perm, entity: record }))
      .allowed;

  beforeAll(async () => {
    host = new CloudflareScopeHost({ scope: env.SCOPE, secretBox: webCryptoSecretBox('test-key', new Uint8Array(32).fill(7)) });
    await provision([READ]);
    await host.grantEntityShapeLocal(s, employee, record, [READ]);
  });

  afterAll(async () => host.close());

  it('an employee linked under the old shape holds the key the next provision adds', async () => {
    expect(await can(READ)).toBe(true);
    expect(await can(USE)).toBe(false);
    await provision([READ, USE]);
    expect(await can(USE)).toBe(true);
  });

  it('...and the top-up is an event on the employee record, stamped with no operation', async () => {
    const rows = await runInDurableObject(env.SCOPE.get(env.SCOPE.idFromName(s)), (_i, state) =>
      state.storage.sql
        .exec(`SELECT payload, operation FROM _substrat_outbox WHERE type = 'entity.grants-topped-up' AND entity_id = 'e1'`)
        .toArray(),
    );
    expect(rows).toEqual([{ payload: JSON.stringify({ entity: record, principal: employee, added: [USE] }), operation: null }]);
  });

  it('a provision without `entityGrants` reconciles nothing, and a repeat with them adds no second event', async () => {
    await provision();
    await provision([READ, USE]);
    const count = await runInDurableObject(env.SCOPE.get(env.SCOPE.idFromName(s)), (_i, state) =>
      state.storage.sql.exec(`SELECT count(*) AS n FROM _substrat_outbox WHERE type = 'entity.grants-topped-up'`).one(),
    );
    expect(count).toEqual({ n: 1 });
  });
});

/**
 * #2082 over the same CP-less host: a key the reviewed shape declares `retired` is taken back
 * at the next provision, and one DO pass, retirement and top-up together, does no more rows of
 * work than its `limit` — the bound that keeps each scope transaction short.
 */
describe('a key a declared shape retires, over a CP-less host (#2082)', () => {
  let host: CloudflareScopeHost;
  const t = tenantId.parse(ulid());
  const s = scopeId.parse(ulid());
  const READ = permissionKey.parse('perm:read');
  const USE = permissionKey.parse('perm:use');
  const ADMIN = permissionKey.parse('perm:admin');
  const owner = principalId.parse(ulid());
  const people = [0, 1, 2].map(() => principalId.parse(ulid()));
  const record = (i: number) => ({ entityType: 'employee', entityId: `e${i}` });
  const stub = () => env.SCOPE.get(env.SCOPE.idFromName(s));
  const provision = (entityGrants?: { entityType: string; permissions: (typeof READ)[]; bootstrap: true; retired?: (typeof READ)[] }[]) =>
    host.provisionScopeLocal({
      tenantId: t,
      scopeId: s,
      owner,
      roles: [{ key: 'office-admin', permissions: [READ, USE, ADMIN], source: 'vertical' }],
      ownerRoleKey: 'office-admin',
      ...(entityGrants ? { entityGrants } : {}),
    });
  const can = async (who: PrincipalId, perm: typeof READ, i: number): Promise<boolean> =>
    (await (await host.getScope(who, t, s)).invoke<{ allowed: boolean }>('perm/probe', { permission: perm, entity: record(i) })).allowed;
  const events = (type: string) =>
    runInDurableObject(stub(), (_i, state) =>
      state.storage.sql.exec(`SELECT count(*) AS n FROM _substrat_outbox WHERE type = ?`, type).one(),
    );

  beforeAll(async () => {
    host = new CloudflareScopeHost({ scope: env.SCOPE, secretBox: webCryptoSecretBox('test-key', new Uint8Array(32).fill(7)) });
    await provision();
    for (const [i, p] of people.entries()) await host.grantEntityShapeLocal(s, p, record(i), [READ, USE]);
  });

  afterAll(async () => host.close());

  it('one pass retires and tops up together, and does no more than its limit', async () => {
    const shapes = [{ entityType: 'employee', permissions: [READ, ADMIN], bootstrap: true as const, retired: [USE] }];
    // Through an arrow on the real stub, never a `.bind`: the RPC proxy is not a plain function.
    const pass = (tn: string, sc: string, sh: unknown, limit: number, after: ShapeCursor | null) =>
      (
        stub() as unknown as {
          topUpEntityGrantShapes: (
            t: string,
            s: string,
            shapes: unknown,
            limit: number,
            after: ShapeCursor | null,
          ) => Promise<{ toppedUp: number; retired: number; next: ShapeCursor | null }>;
        }
      ).topUpEntityGrantShapes(tn, sc, sh, limit, after);
    const first = await pass(t, s, shapes, 4, null);
    expect(first).toEqual({ retired: 3, toppedUp: 1, next: { shape: 0, step: 'topUp', after: expect.any(Object) } });
    expect([await events('entity.grants-retired'), await events('entity.grants-topped-up')]).toEqual([{ n: 3 }, { n: 1 }]);
    // The next pass resumes where the first stopped (#2083).
    expect(await pass(t, s, shapes, 4, first.next)).toEqual({ retired: 0, toppedUp: 2, next: null });
    for (const [i, p] of people.entries()) {
      expect([await can(p, READ, i), await can(p, USE, i), await can(p, ADMIN, i)]).toEqual([true, false, true]);
    }
  });

  it('a provision carrying the shape again retires nobody a second time', async () => {
    await provision([{ entityType: 'employee', permissions: [READ, ADMIN], bootstrap: true, retired: [USE] }]);
    expect(await events('entity.grants-retired')).toEqual({ n: 3 });
  });
});
