import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  moduleId,
  permissionKey,
  platformActorId,
  orgId,
  principalId,
  scopeId,
  tenantId,
  type EntityRef,
  type PermissionKey,
  type OrgId,
  type PrincipalId,
} from '@substrat-run/contracts';
import { ulid, type ScopeHost } from '@substrat-run/kernel';
import type { ScopeHostFixture } from './scope-host-suite.js';
import { permMod } from './modules.js';

const PERM_USE = permissionKey.parse('perm:use');
const PERM_READ = permissionKey.parse('perm:read');
const PERM_ADMIN = permissionKey.parse('perm:admin');
const ENGINE_SOURCE = moduleId.parse('@substrat-run/engine-workorder');

/**
 * Contract suite for the default (tuple) permission checker (design doc §4.2,
 * D-23). The fixture host must use the adapter's DEFAULT checker — no
 * UNSAFE_allowAllChecker.
 */
export function permissionContractSuite(
  adapterName: string,
  makeFixture: () => Promise<ScopeHostFixture>,
): void {
  describe(`permission contract (tuple checker): ${adapterName}`, () => {
    let fixture: ScopeHostFixture;
    let host: ScopeHost;
    const t1 = tenantId.parse(ulid());
    const s1 = scopeId.parse(ulid());
    const s2 = scopeId.parse(ulid()); // same tenant, second scope
    const alice: PrincipalId = principalId.parse(ulid()); // tenant-level admin
    const bob: PrincipalId = principalId.parse(ulid()); // scope role at s1 only
    const carol: PrincipalId = principalId.parse(ulid()); // entity-narrowed grant
    const dave: PrincipalId = principalId.parse(ulid()); // expired grant
    const erin: PrincipalId = principalId.parse(ulid()); // via org membership
    // Orgs are real records with branded ULID ids (K-22) — `acme` as a bare string
    // used to BE the org, so a typo silently addressed a different one.
    const acme: OrgId = orgId.parse(ulid());
    const beta: OrgId = orgId.parse(ulid());
    const gamma: OrgId = orgId.parse(ulid());
    const delta: OrgId = orgId.parse(ulid());
    const epsilon: OrgId = orgId.parse(ulid());
    const staff = platformActorId.parse(ulid()); // control-plane dev actor (§6)

    const probe = async (
      who: PrincipalId,
      scope: typeof s1,
      permission: PermissionKey,
      entity?: EntityRef,
    ) => {
      const stub = await host.getScope(who, t1, scope);
      return stub.invoke<{ allowed: boolean; proof?: unknown[] }>('perm/probe', {
        permission,
        entity,
      });
    };

    beforeAll(async () => {
      fixture = await makeFixture();
      host = fixture.host;
      host.registerModule(permMod);
      await host.admin.createTenant(staff, { id: t1, slug: 'perm-tenant', name: 'Perm Tenant' });
      await host.admin.grantEntitlement(staff, t1, 'perm'); // default-deny (§4.3): perm/* needs it
      // Bound to a vertical: a connection is keyed (tenant, vertical, provider),
      // so a connector's authority is only expressible against a scope that runs one.
      await host.provisionScope(staff, { tenantId: t1, scopeId: s1, vertical: 'perm-vertical' });
      await host.admin.activateScope(staff, t1, s1);
      await host.provisionScope(staff, { tenantId: t1, scopeId: s2, vertical: 'perm-vertical' });
      await host.admin.activateScope(staff, t1, s2);

      await host.admin.defineRole(staff, t1, {
        key: 'admin',
        permissions: [PERM_USE, PERM_READ],
        source: 'vertical',
      });
      await host.admin.defineRole(staff, t1, { key: 'tech', permissions: [PERM_READ], source: 'vertical' });
      await host.admin.assignRole(staff, { principalId: alice, roleKey: 'admin', node: { tenantId: t1, scopeId: null } });
      await host.admin.assignRole(staff, { principalId: bob, roleKey: 'tech', node: { tenantId: t1, scopeId: s1 } });

      // Entity graph in s1: item i1 → box b1, item i2 → box b2.
      const stub = await host.getScope(alice, t1, s1);
      await stub.invoke('perm/link', {
        child: { entityType: 'item', entityId: 'i1' },
        parent: { entityType: 'box', entityId: 'b1' },
      });
      await stub.invoke('perm/link', {
        child: { entityType: 'item', entityId: 'i2' },
        parent: { entityType: 'box', entityId: 'b2' },
      });

      await host.admin.grant(staff, {
        principalId: carol,
        permission: PERM_READ,
        node: { tenantId: t1, scopeId: s1 },
        entity: { entityType: 'box', entityId: 'b1' },
        grantedBy: alice,
      });
      await host.admin.grant(staff, {
        principalId: dave,
        permission: PERM_READ,
        node: { tenantId: t1, scopeId: s1 },
        expiresAt: (await import('@substrat-run/contracts')).instant.parse('2000-01-01T00:00:00Z'),
        grantedBy: alice,
      });
      await host.admin.createOrg(staff, { id: acme, tenantId: t1, slug: 'acme', name: 'Acme' });
      await host.admin.grantToOrg(staff, acme, PERM_READ, { tenantId: t1, scopeId: s1 });
      await host.admin.addMember(staff, t1, erin, acme);
    });

    afterAll(async () => {
      await fixture.cleanup();
    });

    // -- runtime delegation: ctx.grant / ctx.revoke ---------------------------
    // The verb user-initiated sharing needs. Every OTHER entity-narrowed grant in
    // this suite is made by `host.admin.grant` — a platform actor at seed time —
    // so without these an app where a person shares their own record with someone
    // has no supported mechanism.
    describe('ctx.grant delegates, and cannot elevate', () => {
      const frank: PrincipalId = principalId.parse(ulid());
      const share = async (who: PrincipalId, permission: PermissionKey, entity: EntityRef) => {
        const stub = await host.getScope(who, t1, s1);
        return stub.invoke('perm/share', { principal: frank, permission, entity });
      };

      it('a caller may narrow a permission it holds onto one entity', async () => {
        expect((await probe(frank, s1, PERM_USE, { entityType: 'item', entityId: 'i1' })).allowed).toBe(false);
        await share(alice, PERM_USE, { entityType: 'item', entityId: 'i1' });
        expect((await probe(frank, s1, PERM_USE, { entityType: 'item', entityId: 'i1' })).allowed).toBe(true);
      });

      it('the grant reaches that entity and nothing else', async () => {
        expect((await probe(frank, s1, PERM_USE, { entityType: 'item', entityId: 'i2' })).allowed).toBe(false);
        expect((await probe(frank, s1, PERM_USE)).allowed).toBe(false);
      });

      it('refuses to grant what the caller does not hold there', async () => {
        // bob holds PERM_READ at s1 and PERM_USE nowhere.
        await expect(share(bob, PERM_USE, { entityType: 'item', entityId: 'i1' })).rejects.toThrow(
          /a grant delegates, it never elevates/,
        );
      });

      it('...while the door bob DOES hold stays open', async () => {
        // The control: without this, the refusal above would pass just as
        // happily if `ctx.grant` were broken for everyone.
        await expect(share(bob, PERM_READ, { entityType: 'item', entityId: 'i1' })).resolves.toBeTruthy();
      });

      it('revoke withdraws it', async () => {
        const stub = await host.getScope(alice, t1, s1);
        await stub.invoke('perm/unshare', {
          principal: frank,
          permission: PERM_USE,
          entity: { entityType: 'item', entityId: 'i1' },
        });
        expect((await probe(frank, s1, PERM_USE, { entityType: 'item', entityId: 'i1' })).allowed).toBe(false);
      });
    });

    it('denies by default with the checked permission and node', async () => {
      const d = await probe(principalId.parse(ulid()), s1, PERM_READ);
      expect(d.allowed).toBe(false);
    });

    it('tenant-level roles inherit downward into scopes (rule 2), with proof', async () => {
      const d = await probe(alice, s1, PERM_USE);
      expect(d.allowed).toBe(true);
      expect(d.proof!.length).toBeGreaterThanOrEqual(2);
    });

    it('scope roles are confined to their scope — no sideways leakage', async () => {
      await expect(probe(bob, s1, PERM_READ)).resolves.toMatchObject({ allowed: true });
      await expect(probe(bob, s2, PERM_READ)).resolves.toMatchObject({ allowed: false });
    });

    it('entity-narrowed grants resolve through declared parent edges (rule 3)', async () => {
      const own = await probe(carol, s1, PERM_READ, { entityType: 'item', entityId: 'i1' });
      expect(own.allowed).toBe(true);
      // proof contains the parent tuple AND the grant — the walk shown
      expect(JSON.stringify(own.proof)).toContain('"item:i1"');
      expect(JSON.stringify(own.proof)).toContain('"box:b1"');

      const other = await probe(carol, s1, PERM_READ, { entityType: 'item', entityId: 'i2' });
      expect(other.allowed).toBe(false);

      // No node-level access: the narrow grant does not widen.
      await expect(probe(carol, s1, PERM_READ)).resolves.toMatchObject({ allowed: false });
    });

    it('expired grants are dead', async () => {
      await expect(probe(dave, s1, PERM_READ)).resolves.toMatchObject({ allowed: false });
    });

    // -- event authorization + denial log (K-34, K-35) --------------------
    // The two completions of the permission/audit story: what authorized a mutation
    // (stamped on the event it produced), and what was refused (recorded even though
    // the operation rolled back).

    type AuthzRow = { id: string; type: string; authorization: string | null };
    const lastActed = async (): Promise<AuthzRow> => {
      const stub = await host.getScope(alice, t1, s1);
      const rows = await stub.invoke<AuthzRow[]>('perm/read-outbox');
      const acted = rows.filter((r) => r.type === 'perm.acted');
      return acted[acted.length - 1]!;
    };

    it('stamps a role-authorized emit with the permission and no grant (K-34)', async () => {
      // alice holds perm:use via the tenant-level `admin` role — a role, not a grant.
      const stub = await host.getScope(alice, t1, s1);
      await stub.invoke('perm/authorized-emit', { permission: PERM_USE });
      const row = await lastActed();
      expect(row.authorization).not.toBeNull();
      expect(JSON.parse(row.authorization!)).toEqual([{ permission: PERM_USE }]);
    });

    it('stamps an entity-grant emit with the granting entity ref (K-34)', async () => {
      // carol's allow walks item i1 → box b1 to a grant ON box b1 — the grant ref.
      const stub = await host.getScope(carol, t1, s1);
      await stub.invoke('perm/authorized-emit', {
        permission: PERM_READ,
        entity: { entityType: 'item', entityId: 'i1' },
      });
      const row = await lastActed();
      expect(JSON.parse(row.authorization!)).toEqual([{ permission: PERM_READ, grant: 'box:b1' }]);
    });

    it('records a refused check as a denial, though the operation rolled back (K-35)', async () => {
      // bob's `tech` role at s1 holds perm:read, never perm:use.
      const stub = await host.getScope(bob, t1, s1);
      await expect(stub.invoke('perm/authorized-emit', { permission: PERM_USE })).rejects.toThrow(
        /permission denied/,
      );
      // The emit never happened (rolled back), but the denial was recorded.
      const acted = await host.getScope(alice, t1, s1);
      const denials = await acted.invoke<
        { actor: string; permission: string; tenant_id: string; scope_id: string; operation: string }[]
      >('perm/read-denials');
      const mine = denials.find(
        (d) => d.permission === PERM_USE && (JSON.parse(d.actor) as string) === bob,
      );
      expect(mine).toBeDefined();
      expect(mine!.operation).toBe('perm/authorized-emit');
      expect(mine!.scope_id).toBe(s1);
    });

    it('org membership reaches org grants (rule 4), membership tuple in the proof', async () => {
      const d = await probe(erin, s1, PERM_READ);
      expect(d.allowed).toBe(true);
      expect(JSON.stringify(d.proof)).toContain(`org:${acme}`);
    });

    // -- revocation tombstones (K-21) ----------------------------------------
    // Its own org/principal rather than reusing acme/erin: the suites carry state
    // across `it` blocks, and revoking a fixture others assert on would couple them.

    it('revoking a membership stops it granting, but keeps it readable as evidence', async () => {
      const frank: PrincipalId = principalId.parse(ulid());
      await host.admin.createOrg(staff, { id: beta, tenantId: t1, slug: 'beta', name: 'Beta' });
      await host.admin.grantToOrg(staff, beta, PERM_READ, { tenantId: t1, scopeId: s1 });
      await host.admin.addMember(staff, t1, frank, beta);
      await expect(probe(frank, s1, PERM_READ)).resolves.toMatchObject({ allowed: true });

      await host.admin.removeMember(staff, t1, frank, beta);

      // The walk skips it — access is gone.
      await expect(probe(frank, s1, PERM_READ)).resolves.toMatchObject({ allowed: false });

      // And the row is still here. This is the entire reason K-21 chose a
      // tombstone over a DELETE: a tuple that once granted access is the evidence
      // of why an access was allowed (K-4), which a deleted row cannot provide.
      expect(await host.admin.listMembers(staff, t1, beta)).toEqual([]);
      const withRevoked = await host.admin.listMembers(staff, t1, beta, { includeRevoked: true });
      expect(withRevoked).toHaveLength(1);
      expect(withRevoked[0]!.principal).toBe(frank);
      expect(typeof withRevoked[0]!.revokedAt).toBe('string');
    });

    it('unassigning a role stops it granting (K-21), is idempotent, and re-assign restores it', async () => {
      const ivan: PrincipalId = principalId.parse(ulid());
      await host.admin.assignRole(staff, { principalId: ivan, roleKey: 'tech', node: { tenantId: t1, scopeId: null } });
      await expect(probe(ivan, s1, PERM_READ)).resolves.toMatchObject({ allowed: true });

      // The inverse of assignRole — the walk skips the tombstoned tuple, access gone.
      await host.admin.unassignRole(staff, { principalId: ivan, roleKey: 'tech', node: { tenantId: t1, scopeId: null } });
      await expect(probe(ivan, s1, PERM_READ)).resolves.toMatchObject({ allowed: false });

      // Idempotent: unassigning a role that isn't assigned is a silent no-op.
      await host.admin.unassignRole(staff, { principalId: ivan, roleKey: 'tech', node: { tenantId: t1, scopeId: null } });
      await host.admin.unassignRole(staff, { principalId: principalId.parse(ulid()), roleKey: 'tech', node: { tenantId: t1, scopeId: null } });

      // Re-assigning the same (principal, role, node) reactivates it — the tombstone clears.
      await host.admin.assignRole(staff, { principalId: ivan, roleKey: 'tech', node: { tenantId: t1, scopeId: null } });
      await expect(probe(ivan, s1, PERM_READ)).resolves.toMatchObject({ allowed: true });
    });

    it('enumerates live members of an org', async () => {
      const gina: PrincipalId = principalId.parse(ulid());
      const hank: PrincipalId = principalId.parse(ulid());
      await host.admin.createOrg(staff, { id: gamma, tenantId: t1, slug: 'gamma', name: 'Gamma' });
      await host.admin.addMember(staff, t1, gina, gamma);
      await host.admin.addMember(staff, t1, hank, gamma);
      await host.admin.removeMember(staff, t1, hank, gamma);

      const live = await host.admin.listMembers(staff, t1, gamma);
      expect(live.map((m) => m.principal)).toEqual([gina]);
      expect(live[0]!.revokedAt).toBeNull();
      expect(await host.admin.listMembers(staff, t1, gamma, { includeRevoked: true })).toHaveLength(2);
    });

    it('re-adding a revoked member clears the tombstone', async () => {
      const iris: PrincipalId = principalId.parse(ulid());
      await host.admin.createOrg(staff, { id: delta, tenantId: t1, slug: 'delta', name: 'Delta' });
      await host.admin.grantToOrg(staff, delta, PERM_READ, { tenantId: t1, scopeId: s1 });
      await host.admin.addMember(staff, t1, iris, delta);
      await host.admin.removeMember(staff, t1, iris, delta);
      await expect(probe(iris, s1, PERM_READ)).resolves.toMatchObject({ allowed: false });

      await host.admin.addMember(staff, t1, iris, delta);
      await expect(probe(iris, s1, PERM_READ)).resolves.toMatchObject({ allowed: true });
      const rows = await host.admin.listMembers(staff, t1, delta, { includeRevoked: true });
      expect(rows.find((m) => m.principal === iris)?.revokedAt).toBeNull();
    });

    it('revoking is idempotent — no timestamp drift, no second audit row', async () => {
      const jack: PrincipalId = principalId.parse(ulid());
      await host.admin.createOrg(staff, { id: epsilon, tenantId: t1, slug: 'epsilon', name: 'Eps' });
      await host.admin.addMember(staff, t1, jack, epsilon);
      await host.admin.removeMember(staff, t1, jack, epsilon);
      const first = (await host.admin.listMembers(staff, t1, epsilon, { includeRevoked: true }))[0]!
        .revokedAt;

      await host.admin.removeMember(staff, t1, jack, epsilon);
      await host.admin.removeMember(staff, t1, jack, gamma); // real org, never a member

      const after = (await host.admin.listMembers(staff, t1, epsilon, { includeRevoked: true }))[0]!
        .revokedAt;
      expect(after).toBe(first);
      const removals = (await host.admin.auditLog(staff, { tenantId: t1 })).filter(
        (r) => r.action === 'removeMember',
      );
      expect(removals.filter((r) => JSON.stringify(r.before).includes(jack))).toHaveLength(1);
    });

    // -- organizations are a real record (K-22) ------------------------------

    it('refuses membership and grants for an org that does not exist', async () => {
      const ghost: OrgId = orgId.parse(ulid());
      const kim: PrincipalId = principalId.parse(ulid());
      // This is what the record buys. Before it, every one of these silently
      // succeeded and produced a tuple pointing at a phantom — granting nothing,
      // appearing in no listing, and reading in the permission diff as if access
      // had been conferred.
      await expect(host.admin.addMember(staff, t1, kim, ghost)).rejects.toThrow(/unknown org/);
      await expect(
        host.admin.grantToOrg(staff, ghost, PERM_READ, { tenantId: t1, scopeId: s1 }),
      ).rejects.toThrow(/unknown org/);
      await expect(host.admin.listMembers(staff, t1, ghost)).rejects.toThrow(/unknown org/);
    });

    it("scopes orgs by tenant — another tenant's org reads as absent", async () => {
      // The other tenant's org must not be reachable from t1, or the record would
      // not be the boundary it exists to make explicit.
      const other = tenantId.parse(ulid());
      await host.admin.createTenant(staff, { id: other, slug: `o-${other.toLowerCase()}`, name: 'O' });
      const foreign: OrgId = orgId.parse(ulid());
      await host.admin.createOrg(staff, { id: foreign, tenantId: other, slug: 'foreign', name: 'F' });
      expect(await host.admin.getOrg(staff, other, foreign)).toMatchObject({ slug: 'foreign' });
      expect(await host.admin.getOrg(staff, t1, foreign)).toBeUndefined();
      const stranger: PrincipalId = principalId.parse(ulid());
      await expect(host.admin.addMember(staff, t1, stranger, foreign)).rejects.toThrow(
        /unknown org/,
      );
    });

    it('creates orgs idempotently and enumerates them per tenant', async () => {
      const dup: OrgId = orgId.parse(ulid());
      await host.admin.createOrg(staff, { id: dup, tenantId: t1, slug: 'dup', name: 'Dup' });
      await host.admin.createOrg(staff, { id: dup, tenantId: t1, slug: 'dup', name: 'Dup' });
      const orgs = await host.admin.listOrgs(staff, t1);
      expect(orgs.filter((o) => o.id === dup)).toHaveLength(1);
      expect(orgs.every((o) => o.tenantId === t1)).toBe(true);
    });

    it('rejects a slug already taken by a different org in the tenant', async () => {
      const first: OrgId = orgId.parse(ulid());
      const second: OrgId = orgId.parse(ulid());
      await host.admin.createOrg(staff, { id: first, tenantId: t1, slug: 'taken', name: 'One' });
      // Fails closed rather than swallowing it: a silent no-op here would report
      // success while not creating the org the caller asked for.
      await expect(
        host.admin.createOrg(staff, { id: second, tenantId: t1, slug: 'taken', name: 'Two' }),
      ).rejects.toThrow(/already taken/);
      expect(await host.admin.getOrg(staff, t1, second)).toBeUndefined();
    });

    // -- identity: pools, topology, and per-tenant keying (§4.3, K-22/K-23) --
    // The first contract coverage identity has had on either adapter, which is part
    // of why the key drifted from what §4.3 requires without anyone noticing.

    it('refuses to link through a provider that has not registered a pool', async () => {
      // Deny-by-default. An unregistered pool has not said whether the same
      // externalId in two tenants is one human or two, and the kernel will not guess.
      await expect(
        host.admin.linkIdentity(staff, {
          provider: 'oidc:unregistered',
          externalId: 'x',
          principal: principalId.parse(ulid()),
          tenantId: t1,
        }),
      ).rejects.toThrow(/not registered/);
    });

    it('keys identities per tenant — the same externalId in two pools is two people', async () => {
      // §4.3: with one auth pool per white-label tenant, an external subject id is
      // unique only WITHIN its pool. Two pools both issuing '123' is normal and they
      // are different people. Two pools means two PROVIDER strings — a provider names
      // exactly one pool, which is what makes the tenant-bound rule enforceable.
      const other = tenantId.parse(ulid());
      await host.admin.createTenant(staff, { id: other, slug: `p-${other.toLowerCase()}`, name: 'P' });
      await host.admin.registerIdentityPool(staff, {
        provider: 'oidc:shop-a',
        topology: 'tenant-bound',
        tenantId: t1,
      });
      await host.admin.registerIdentityPool(staff, {
        provider: 'oidc:shop-b',
        topology: 'tenant-bound',
        tenantId: other,
      });
      const here: PrincipalId = principalId.parse(ulid());
      const there: PrincipalId = principalId.parse(ulid());

      await host.admin.linkIdentity(staff, {
        provider: 'oidc:shop-a',
        externalId: '123',
        principal: here,
        tenantId: t1,
      });
      await host.admin.linkIdentity(staff, {
        provider: 'oidc:shop-b',
        externalId: '123', // same string, different pool, different person
        principal: there,
        tenantId: other,
      });

      expect((await host.admin.resolveIdentity(t1, 'oidc:shop-a', '123'))?.principal).toBe(here);
      expect((await host.admin.resolveIdentity(other, 'oidc:shop-b', '123'))?.principal).toBe(there);
      // Neither pool's subject is visible through the other.
      expect(await host.admin.resolveIdentity(t1, 'oidc:shop-b', '123')).toBeUndefined();
    });

    it('holds a tenant-bound pool to its own tenant', async () => {
      const other = tenantId.parse(ulid());
      await host.admin.createTenant(staff, { id: other, slug: `b-${other.toLowerCase()}`, name: 'B' });
      await host.admin.registerIdentityPool(staff, {
        provider: 'oidc:bound',
        topology: 'tenant-bound',
        tenantId: t1,
      });
      await expect(
        host.admin.linkIdentity(staff, {
          provider: 'oidc:bound',
          externalId: 'y',
          principal: principalId.parse(ulid()),
          tenantId: other,
        }),
      ).rejects.toThrow(/bound to tenant/);
    });

    it('lets one central-pool login belong to several tenants (the cross-tenant case)', async () => {
      // The mirror of the bleed: §4.3's central pool is where "someone administering
      // five tenants wants ONE login" — and RallyPoint's player at several clubs is
      // the same shape, since clubs are tenants there. One login, one principal per
      // tenant: shared identity, separate authority.
      const consultant: PrincipalId = principalId.parse(ulid());
      const second: PrincipalId = principalId.parse(ulid());
      const tB = tenantId.parse(ulid());
      await host.admin.createTenant(staff, { id: tB, slug: `c-${tB.toLowerCase()}`, name: 'C' });
      await host.admin.registerIdentityPool(staff, {
        provider: 'oidc:central',
        topology: 'central',
        tenantId: null,
      });

      await host.admin.linkIdentity(staff, {
        provider: 'oidc:central',
        externalId: 'consultant-1',
        principal: consultant,
        tenantId: t1,
      });
      await host.admin.linkIdentity(staff, {
        provider: 'oidc:central',
        externalId: 'consultant-1', // one login...
        principal: second, // ...one principal per tenant
        tenantId: tB,
      });

      expect((await host.admin.resolveIdentity(t1, 'oidc:central', 'consultant-1'))?.principal).toBe(
        consultant,
      );
      expect((await host.admin.resolveIdentity(tB, 'oidc:central', 'consultant-1'))?.principal).toBe(
        second,
      );
      // The cross-tenant question, answerable ONLY because the pool is central.
      expect(await host.admin.listIdentityTenants(staff, 'oidc:central', 'consultant-1')).toEqual(
        [t1, tB].sort(),
      );
    });

    it('refuses to enumerate tenants for a tenant-bound pool', async () => {
      await host.admin.registerIdentityPool(staff, {
        provider: 'oidc:enum-bound',
        topology: 'tenant-bound',
        tenantId: t1,
      });
      // Not a leak — the caller already knows this pool's tenant. It throws because
      // ASKING is a category error: on a tenant-bound pool the same externalId in
      // another tenant is a different person, so a tenant list has no meaning.
      await expect(host.admin.listIdentityTenants(staff, 'oidc:enum-bound', 'z')).rejects.toThrow(
        /tenant-bound/,
      );
    });

    it('is idempotent on an identical pool registration, and refuses a conflicting one', async () => {
      await host.admin.registerIdentityPool(staff, {
        provider: 'oidc:stable',
        topology: 'central',
        tenantId: null,
      });
      await host.admin.registerIdentityPool(staff, {
        provider: 'oidc:stable',
        topology: 'central',
        tenantId: null,
      });
      // Flipping a live pool's topology silently reinterprets every row it owns —
      // the same externalId across tenants would change from one human to two.
      await expect(
        host.admin.registerIdentityPool(staff, {
          provider: 'oidc:stable',
          topology: 'tenant-bound',
          tenantId: t1,
        }),
      ).rejects.toThrow(/already registered/);
    });

    it('resolves only within the tenant asked for', async () => {
      const someone: PrincipalId = principalId.parse(ulid());
      const elsewhere = tenantId.parse(ulid());
      await host.admin.createTenant(staff, {
        id: elsewhere,
        slug: `e-${elsewhere.toLowerCase()}`,
        name: 'E',
      });
      await host.admin.registerIdentityPool(staff, {
        provider: 'oidc:scoped',
        topology: 'tenant-bound',
        tenantId: t1,
      });
      await host.admin.linkIdentity(staff, {
        provider: 'oidc:scoped',
        externalId: 'only-here',
        principal: someone,
        tenantId: t1,
      });
      expect(await host.admin.resolveIdentity(elsewhere, 'oidc:scoped', 'only-here')).toBeUndefined();
    });

    it('refuses to rebind a key to a different principal, loudly', async () => {
      const first: PrincipalId = principalId.parse(ulid());
      const impostor: PrincipalId = principalId.parse(ulid());
      await host.admin.registerIdentityPool(staff, {
        provider: 'oidc:collide',
        topology: 'tenant-bound',
        tenantId: t1,
      });
      const link = (principal: PrincipalId) =>
        host.admin.linkIdentity(staff, {
          provider: 'oidc:collide',
          externalId: 'collide',
          principal,
          tenantId: t1,
        });
      await link(first);
      await link(first); // re-linking the same person stays idempotent
      // ...but a genuine collision must not be swallowed. The old INSERT OR IGNORE
      // silently dropped it and left the second person resolving as the first,
      // without even an audit row to show it happened.
      await expect(link(impostor)).rejects.toThrow(/already bound/);
      expect((await host.admin.resolveIdentity(t1, 'oidc:collide', 'collide'))?.principal).toBe(
        first,
      );
    });

    // -- staff access log (K-24) ---------------------------------------------

    it('records who READ the directory, with what came back', async () => {
      const reader = platformActorId.parse(ulid());
      await host.admin.listTenants(reader);
      const rows = await host.admin.accessLog(staff, { actor: reader });
      const listed = rows.find((r) => r.method === 'listTenants');
      expect(listed?.actor).toBe(reader);
      // result_count is what separates navigation from an incident: "called
      // listTenants" against "enumerated every tenant on the platform".
      expect(listed?.resultCount).toBeGreaterThan(0);
      expect(listed?.drainedAt).toBeNull();
    });

    it('audits reading the audit trail, and reading the access log itself', async () => {
      const nosy = platformActorId.parse(ulid());
      await host.admin.auditLog(nosy, { tenantId: t1 });
      await host.admin.accessLog(nosy, {});
      const rows = await host.admin.accessLog(staff, { actor: nosy });
      // Who examined the record of who did what is the question an incident asks
      // second, so neither read is exempt from being recorded.
      expect(rows.map((r) => r.method)).toEqual(
        expect.arrayContaining(['auditLog', 'accessLog']),
      );
    });

    it('keeps reads OUT of the mutation trail', async () => {
      // Two logs because they are two things. A read in the admin log would make
      // its "every row is an effect" property false.
      const before = (await host.admin.auditLog(staff, { tenantId: t1 })).length;
      await host.admin.listScopes(staff, { tenantId: t1 });
      expect((await host.admin.auditLog(staff, { tenantId: t1 })).length).toBe(before);
    });

    it('refuses to prune anything undrained', async () => {
      const filler = platformActorId.parse(ulid());
      await host.admin.listTenants(filler);
      const before = (await host.admin.accessLog(staff, { actor: filler })).length;
      expect(before).toBeGreaterThan(0);
      // Nothing has been shipped anywhere, so nothing may be pruned. Expiring on age
      // alone would destroy evidence while calling itself retention — the failure
      // K-21 rejected for tuples, one layer up.
      expect(await host.admin.pruneAccessLog(staff, 100)).toBe(0);
      expect((await host.admin.accessLog(staff, { actor: filler })).length).toBe(before);
    });

    it('drains to Tier 2, then prunes exactly what drained (K-24)', async () => {
      const filler = platformActorId.parse(ulid());
      await host.admin.listTenants(filler);

      // The drain's only query: the oldest rows that have not left yet.
      const pending = await host.admin.accessLog(staff, {
        drained: false,
        order: 'asc',
        limit: 500,
      });
      expect(pending.length).toBeGreaterThan(0);
      expect(pending.every((r) => r.drainedAt === null)).toBe(true);

      // The batch's last id is the watermark — ULID order is chronological, so rows
      // written while a shipment is in flight sort after it and are left for the
      // next pass rather than being stamped unshipped.
      const upToId = pending[pending.length - 1]!.id;
      const marked = await host.admin.markAccessLogDrained(
        staff,
        upToId,
        new Date().toISOString(),
      );
      expect(marked).toBe(pending.length);

      // Idempotent: a retried shipment re-stamps nothing, so the admin log never
      // records an egress that already happened.
      expect(
        await host.admin.markAccessLogDrained(staff, upToId, new Date().toISOString()),
      ).toBe(0);

      const drained = await host.admin.accessLog(staff, { drained: true, limit: 500 });
      expect(drained.length).toBe(marked);
      expect(drained.every((r) => r.drainedAt !== null)).toBe(true);

      // The egress is itself evidence: an operator asking "which rows left, and when"
      // is answered by the mutation log, not by the object store.
      const egress = await host.admin.auditLog(staff, { action: 'drainAccessLog' });
      expect(egress.length).toBeGreaterThanOrEqual(1);
      expect(egress[egress.length - 1]!.after).toMatchObject({ drained: marked, upToId });

      // Only NOW are they deletable, and only they.
      expect(await host.admin.pruneAccessLog(staff, 500)).toBe(marked);
      expect((await host.admin.accessLog(staff, { drained: true, limit: 500 })).length).toBe(0);

      // The prune is evidence too, and its payload is the APPLIED state — `after`,
      // like drainAccessLog's row, per adminLogEntry's contract (before = prior state,
      // after = the applied payload). Pinned because it shipped inverted once (#557).
      const prunes = await host.admin.auditLog(staff, { action: 'pruneAccessLog' });
      expect(prunes.length).toBeGreaterThanOrEqual(1);
      expect(prunes[prunes.length - 1]!.before).toBeNull();
      expect(prunes[prunes.length - 1]!.after).toMatchObject({ pruned: marked });
    });

    // -- control-plane audit trail (control-plane.md §4.4) --------------------

    it('records every admin mutation with actor and target, append-only (K-20)', async () => {
      const log = await host.admin.auditLog(staff, { tenantId: t1 });
      // The six seed mutations each left a row; nothing is ever removed.
      expect(log.length).toBeGreaterThanOrEqual(6);
      // Every row is stamped platform-side: our staff actor, this tenant, a timestamp.
      for (const row of log) {
        expect(row.actor).toBe(staff);
        expect(row.tenantId).toBe(t1);
        expect(typeof row.at).toBe('string');
      }
      const actions = log.map((r) => r.action);
      expect(actions).toEqual(
        expect.arrayContaining(['defineRole', 'assignRole', 'grant', 'grantToOrg', 'addMember']),
      );
      // defineRole captures the applied role in `after` — the raw material for
      // the §4.5 permission diff.
      const defined = log.find((r) => r.action === 'defineRole');
      expect(defined?.after).toMatchObject({ permissions: expect.any(Array) });
    });

    it('captures before/after when a role is redefined — the permission-diff seed', async () => {
      await host.admin.defineRole(staff, t1, { key: 'tech', permissions: [PERM_USE], source: 'vertical' });
      const redefines = (await host.admin.auditLog(staff, { tenantId: t1 }))
        .filter(
          (r) =>
            r.action === 'defineRole' &&
            (r.after as { key?: string })?.key === 'tech' &&
            r.before !== null,
        );
      expect(redefines.length).toBeGreaterThanOrEqual(1);
      const last = redefines[redefines.length - 1]!;
      expect((last.before as { permissions: string[] }).permissions).toEqual([PERM_READ]);
      expect((last.after as { permissions: string[] }).permissions).toEqual([PERM_USE]);
    });

    // -- the roles read path (control-plane.md §4.5 console item 4) -----------
    // defineRole shipped with the permission model; nothing could ask what roles
    // exist. CI diffs the roles declared in CODE — this is the only way to see
    // what a live deployment holds, which is a different question.

    it('lists the roles the directory holds, with their tenant (§4.5)', async () => {
      await host.admin.defineRole(staff, t1, {
        key: 'listed-role',
        permissions: [PERM_READ, PERM_USE],
        source: 'vertical',
      });
      const roles = await host.admin.listRoles(staff, { tenantId: t1 });
      const found = roles.find((r) => r.key === 'listed-role');
      expect(found).toMatchObject({
        tenantId: t1,
        key: 'listed-role',
        permissions: [PERM_READ, PERM_USE],
        source: 'vertical',
      });
      // Ordered by (tenantId, key) so the console renders stably.
      expect(roles.map((r) => r.key)).toEqual([...roles.map((r) => r.key)].sort());
    });

    it('reflects a redefinition rather than duplicating the role (§4.5)', async () => {
      await host.admin.defineRole(staff, t1, {
        key: 'listed-role',
        permissions: [PERM_READ, PERM_USE, PERM_ADMIN],
        source: 'vertical',
      });
      const listed = (await host.admin.listRoles(staff, { tenantId: t1 })).filter((r) => r.key === 'listed-role');
      // defineRole is an upsert keyed on (tenant, key) — a redefinition replaces.
      expect(listed).toHaveLength(1);
      expect(listed[0]!.permissions).toContain(PERM_ADMIN);
    });

    it('filters roles by source, and scopes the read by tenant (§4.5)', async () => {
      await host.admin.defineRole(staff, t1, {
        key: 'engine-role',
        permissions: [PERM_READ],
        source: ENGINE_SOURCE,
      });
      const bySource = await host.admin.listRoles(staff, { tenantId: t1, source: 'vertical' });
      expect(bySource.length).toBeGreaterThan(0);
      expect(bySource.every((r) => r.source === 'vertical')).toBe(true);
      expect(bySource.some((r) => r.key === 'engine-role')).toBe(false);

      const engine = await host.admin.listRoles(staff, { source: ENGINE_SOURCE });
      expect(engine.some((r) => r.key === 'engine-role')).toBe(true);

      // Another tenant's roles are not this tenant's, the same way the audit read
      // is scoped — the console must never show one tenant's role design to another.
      const other = await host.admin.listRoles(staff, { tenantId: tenantId.parse(ulid()) });
      expect(other.some((r) => r.key === 'listed-role')).toBe(false);
    });

    it('scopes the audit read by tenant', async () => {
      const otherTenant = tenantId.parse(ulid());
      expect(await host.admin.auditLog(staff, { tenantId: otherTenant })).toEqual([]);
    });

    // -- the inbound authority seam (#97) -------------------------------------
    //
    // A provider's callback must write back into a scope, and it is not a
    // person. A CONNECTION is therefore a subject in this same model — no
    // second gate, no bypass — and what matters is what it cannot reach.

    describe('a connection as a subject', () => {
      const connId = ulid();

      beforeAll(async () => {
        await host.admin.createConnection(staff, {
          id: connId as never,
          tenantId: t1,
          vertical: 'perm-vertical',
          provider: 'inbound',
          label: 'inbound authority',
          secret: { accessToken: 'tok' },
        });
      });

      const connProbe = async (permission: PermissionKey) => {
        const stub = await host.getConnectorScope(connId as never, s1);
        return stub.invoke<{ allowed: boolean; proof?: unknown[] }>('perm/probe', { permission });
      };

      it('opens the door but confers nothing — a grant is a separate act', async () => {
        expect((await connProbe(PERM_USE)).allowed).toBe(false);
      });

      it('allows exactly what it was granted, and proves it with a connection tuple', async () => {
        await host.admin.grantToConnection(staff, {
          connectionId: connId,
          permission: PERM_USE,
          node: { tenantId: t1, scopeId: s1 },
          grantedBy: staff,
        });
        const decision = await connProbe(PERM_USE);
        expect(decision.allowed).toBe(true);
        // The proof names a CONNECTION, not a principal. That is the difference
        // between this and minting a principal per connection, and it is the
        // property every audit view depends on.
        expect(JSON.stringify(decision.proof)).toContain(`connection:${connId}`);

        // …and nothing else. One grant, one permission.
        expect((await connProbe(PERM_ADMIN)).allowed).toBe(false);
      });

      // #726 gap 1. The read-back exists so a deployment can answer "may this
      // connection act here" without staff access to the control plane — which is
      // the question nothing could answer when `protocol:attach` went missing from a
      // live connection for months (#716). Its whole worth is agreeing with the
      // checker, so that is what is asserted: not the rows it selected, but that
      // every permission it reports is one the probe allows, and every permission it
      // omits is one the probe denies.
      it('reads back exactly what the checker would allow for this connection', async () => {
        const reported = new Set(
          (await host.connectionGrantsInScope(t1, s1))
            .filter((g) => g.connectionId === connId)
            .map((g) => g.permission),
        );
        // PERM_USE was granted above; PERM_ADMIN never was. Both must agree.
        for (const perm of [PERM_USE, PERM_ADMIN]) {
          const { allowed } = await connProbe(perm);
          expect({ perm, reported: reported.has(perm) }).toEqual({ perm, reported: allowed });
        }
      });

      it('inherits no memberships and no roles — it is not a person', async () => {
        // Roles reach principals through role tuples and orgs through
        // membership. A connection has neither, so a role that carries a
        // permission cannot leak into it.
        await host.admin.defineRole(staff, t1, {
          key: 'conn-role',
          permissions: [PERM_READ],
          source: 'vertical',
        });
        expect((await connProbe(PERM_READ)).allowed).toBe(false);
      });

      it('cannot reach a scope outside its own tenant or vertical', async () => {
        const otherTenant = tenantId.parse(ulid());
        await host.admin.createTenant(staff, {
          id: otherTenant,
          slug: 'other-perm',
          name: 'Other',
        });
        const otherScope = scopeId.parse(ulid());
        await host.provisionScope(staff, {
          tenantId: otherTenant,
          scopeId: otherScope,
          vertical: 'perm-vertical',
        });
        await host.admin.activateScope(staff, otherTenant, otherScope);
        // Inherited from the (tenant, vertical, provider) key rather than
        // re-declared at the door.
        await expect(host.getConnectorScope(connId as never, otherScope)).rejects.toThrow(
          /unknown scope for connection/,
        );
        await expect(
          host.admin.grantToConnection(staff, {
            connectionId: connId,
            permission: PERM_USE,
            node: { tenantId: otherTenant, scopeId: otherScope },
            grantedBy: staff,
          }),
        ).rejects.toThrow(/cannot be granted anything in/);
      });

      it('stops working the moment the connection is revoked', async () => {
        const [live] = await host.admin.listConnections(staff, {
          tenantId: t1,
          provider: 'inbound',
        });
        await host.admin.revokeConnection(staff, live!.id);
        // One revoke closes the credential AND the door. Two operations to
        // remember is how one of them gets forgotten.
        await expect(host.getConnectorScope(connId as never, s1)).rejects.toThrow(/revoked/);
      });
    });
  });
}
