import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { instant, moduleId, orgId, platformActorId, principalId, scopeId, tenantId, type PermissionKey, type PrincipalId } from '@substrat-run/contracts';
import { ulid, type DeclaredPermissions, type ScopeHost } from '@substrat-run/kernel';
import { expectRefusal, type ScopeHostFixture } from './scope-host-suite.js';
import { permMod } from './modules.js';
import { RSV_RUN, RSV_USE, reservedRoleMod, unmarkedReservedRoleMod } from './reserved-role-module.js';

/**
 * #2430: a key a registered module reserves to a system principal (`holder: 'system'`) is not
 * handed to a person through a role or a raw grant, on either adapter.
 *
 * - A person's doors (`assignScopeRoleBounded`, `changeScopeRoleBounded`'s target, a membership
 *   add) refuse any role carrying one, and `canAssign` and `ctx.canAssign` answer as they do.
 * - A reconcile of declared entity-grant shapes refuses a shape whose keys hold one, before it
 *   tops any holder up; a shape that only retires one reconciles.
 * - The platform's door (`HostAdmin.assignRole`) refuses a role mixing reserved and other keys,
 *   at either node, and admits a role made only of reserved keys (K-55's system-held shape).
 * - A raw grant (`HostAdmin.grant`, `grantToOrg`, `grantEntityShape`, `ctx.grant`) of a reserved
 *   key is refused whoever makes it — a person, or a system actor, which passes `ctx.grant`'s
 *   delegation re-check by construction. Its twin, a key no module reserves, passes.
 * - Each refusal writes nothing: the principal holds nothing afterwards.
 *
 * And the host option `permissions`: a host given its declared surface refuses to register a
 * module the surface leaves out, and holds the reservations the surface declares whatever is
 * registered under its ids.
 */
export function reservedRoleContractSuite(
  adapterName: string,
  makeFixture: (options?: { permissions?: DeclaredPermissions }) => Promise<ScopeHostFixture>,
): void {
  describe(`reserved keys at the role and grant doors (#2430): ${adapterName}`, () => {
    let fixture: ScopeHostFixture;
    let host: ScopeHost;
    const t1 = tenantId.parse(ulid());
    const s1 = scopeId.parse(ulid());
    const staff = platformActorId.parse(ulid());
    const alice = principalId.parse(ulid()); // holds rsv:use tenant-wide, and rsv:run through a reserved-only role
    const person = () => principalId.parse(ulid());
    const entity = () => ({ entityType: 'rsvdoc', entityId: ulid() });
    const RSV = moduleId.parse('@test/reserved-role');
    /** How a person's door refuses: worded for `canAssign`'s removal bound as well as for an assignment. */
    const NO_BOUND = "no person's bound covers it, to give the role or to take it back";

    const holds = async (who: PrincipalId, permission: PermissionKey, on?: { entityType: string; entityId: string }) => {
      const stub = await host.getScope(who, t1, s1);
      return (await stub.invoke<{ allowed: boolean }>('perm/probe', { permission, entity: on })).allowed;
    };

    beforeAll(async () => {
      fixture = await makeFixture();
      host = fixture.host;
      host.registerModule(reservedRoleMod);
      host.registerModule(permMod); // its `perm/probe` reports what a principal holds
      await host.admin.createTenant(staff, { id: t1, slug: 'reserved-role-tenant', name: 'Reserved' });
      await host.admin.grantEntitlement(staff, t1, 'perm');
      await host.admin.grantEntitlement(staff, t1, 'rsv');
      await host.provisionScope(staff, { tenantId: t1, scopeId: s1, vertical: 'rsv-vertical' });
      await host.admin.activateScope(staff, t1, s1);
      await host.admin.defineRole(staff, t1, { key: 'member', permissions: [RSV_USE], source: 'vertical' });
      await host.admin.defineRole(staff, t1, { key: 'mixed', permissions: [RSV_USE, RSV_RUN], source: 'vertical' });
      await host.admin.defineRole(staff, t1, { key: 'runner', permissions: [RSV_RUN], source: 'vertical' });
      await host.admin.grant(staff, { principalId: alice, permission: RSV_USE, node: { tenantId: t1, scopeId: null }, grantedBy: alice });
      // The platform door admits a role made only of reserved keys, so alice can hold rsv:run.
      await host.admin.assignRole(staff, { principalId: alice, roleKey: 'runner', node: { tenantId: t1, scopeId: null } });
      // The system principal of the reserving module, holding both keys at the scope.
      for (const permission of [RSV_USE, RSV_RUN]) {
        await host.admin.grantToSystem(staff, { moduleId: RSV, permission, node: { tenantId: t1, scopeId: s1 }, grantedBy: staff });
      }
    });

    afterAll(async () => {
      await fixture?.cleanup();
    });

    describe('the platform’s door, HostAdmin.assignRole', () => {
      it.each([
        ['the tenant node', null],
        ['a scope node', s1],
      ])('refuses a role mixing a reserved key with a person’s key, at %s, and writes nothing', async (_where, scope) => {
        const who = person();
        await expectRefusal(
          host.admin.assignRole(staff, { principalId: who, roleKey: 'mixed', node: { tenantId: t1, scopeId: scope } }),
          'forbidden',
          /role 'mixed' holds rsv:run, reserved to a system principal, beside rsv:use/,
        );
        expect(await holds(who, RSV_USE)).toBe(false);
      });

      it.each([
        ['the tenant node', null],
        ['a scope node', s1],
      ])('admits a role made only of reserved keys (the system-held shape, K-55), at %s', async (_where, scope) => {
        const hostPrincipal = person();
        await host.admin.assignRole(staff, { principalId: hostPrincipal, roleKey: 'runner', node: { tenantId: t1, scopeId: scope } });
        expect(await holds(hostPrincipal, RSV_RUN)).toBe(true);
      });

      it('admits a role of person keys', async () => {
        const who = person();
        await host.admin.assignRole(staff, { principalId: who, roleKey: 'member', node: { tenantId: t1, scopeId: s1 } });
        expect(await holds(who, RSV_USE)).toBe(true);
      });
    });

    describe('a person’s doors', () => {
      it.each(['runner', 'mixed'])(
        'assignScopeRoleBounded refuses %s to a caller who holds it, and writes nothing',
        async (roleKey) => {
          const who = person();
          await expectRefusal(
            host.assignScopeRoleBounded(t1, s1, alice, who, roleKey),
            'forbidden',
            new RegExp(`role '${roleKey}' holds rsv:run, reserved to a system principal: ${NO_BOUND}`),
          );
          expect(await host.listScopeRoleHolders(t1, s1, who)).toEqual([]);
          expect(await holds(who, RSV_RUN)).toBe(false);
        },
      );

      it('…and grants a role of person keys, as before', async () => {
        const who = person();
        expect(await host.assignScopeRoleBounded(t1, s1, alice, who, 'member')).toEqual({ covered: true, missing: [] });
        expect(await holds(who, RSV_USE)).toBe(true);
      });

      it.each(['runner', 'mixed'])(
        'changeScopeRoleBounded refuses moving someone into %s, and leaves the role they held',
        async (roleKey) => {
          const who = person();
          await host.assignScopeRoleBounded(t1, s1, alice, who, 'member');
          await expectRefusal(host.changeScopeRoleBounded(t1, s1, alice, who, 'member', roleKey), 'forbidden', new RegExp(`role '${roleKey}' holds rsv:run.*${NO_BOUND}`));
          expect(await host.listScopeRoleHolders(t1, s1, who)).toEqual([{ principal: who, roleKey: 'member' }]);
        },
      );

      it('canAssign answers as the door does: a reserved role is refused, a person’s role is covered', async () => {
        await expectRefusal(host.canAssign(t1, s1, alice, 'mixed'), 'forbidden', new RegExp(`role 'mixed' holds rsv:run.*${NO_BOUND}`));
        expect(await host.canAssign(t1, s1, alice, 'member')).toEqual({ covered: true, missing: [] });
      });

      it('…and so does ctx.canAssign, inside an operation, for a caller who holds every key of the role', async () => {
        const as = await host.getScope(alice, t1, s1);
        await expectRefusal(as.invoke('perm/can-assign', { roleKey: 'mixed' }), 'forbidden', new RegExp(`role 'mixed' holds rsv:run.*${NO_BOUND}`));
        await expectRefusal(as.invoke('perm/can-assign', { roleKey: 'runner' }), 'forbidden', new RegExp(`role 'runner' holds rsv:run.*${NO_BOUND}`));
        expect(await as.invoke('perm/can-assign', { roleKey: 'member' })).toEqual({ covered: true, missing: [] });
      });

      it('a membership add of a reserved role applies nothing, and says why; its twin applies', async () => {
        const who = person();
        const add = (roleKey: string) =>
          host.admin.applyMembership(staff, {
            op: 'add',
            tenantId: t1,
            principal: who,
            roleKey,
            boundedBy: alice,
            unlessRemovedSince: instant.parse(new Date(Date.now() - 60_000).toISOString()),
          });
        expect(await add('mixed')).toEqual({ applied: false, reserved: expect.stringMatching(new RegExp(`role 'mixed' holds rsv:run.*${NO_BOUND}`)) });
        expect(await holds(who, RSV_USE)).toBe(false);
        expect(await add('member')).toEqual({ applied: true });
        expect(await holds(who, RSV_USE)).toBe(true);
      });
    });

    describe('raw grants', () => {
      it.each([
        ['the tenant node', null],
        ['a scope node', s1],
      ])('HostAdmin.grant refuses a reserved key at %s, and grants a person’s key', async (_where, scope) => {
        const who = person();
        await expectRefusal(
          host.admin.grant(staff, { principalId: who, permission: RSV_RUN, node: { tenantId: t1, scopeId: scope }, grantedBy: alice }),
          'forbidden',
          /rsv:run cannot be granted to a principal or an org: reserved to a system principal/,
        );
        expect(await holds(who, RSV_RUN)).toBe(false);
        await host.admin.grant(staff, { principalId: who, permission: RSV_USE, node: { tenantId: t1, scopeId: scope }, grantedBy: alice });
        expect(await holds(who, RSV_USE)).toBe(true);
      });

      it('grantToOrg refuses a reserved key to an org, whose members are people', async () => {
        const org = orgId.parse(ulid());
        await host.admin.createOrg(staff, { id: org, tenantId: t1, slug: `rsv-${ulid().toLowerCase()}`, name: 'Org' });
        await expectRefusal(host.admin.grantToOrg(staff, org, RSV_RUN, { tenantId: t1, scopeId: s1 }), 'forbidden', /rsv:run cannot be granted/);
        await host.admin.grantToOrg(staff, org, RSV_USE, { tenantId: t1, scopeId: s1 });
      });

      it('grantEntityShape refuses a shape carrying a reserved key, and grants one that does not', async () => {
        const who = person();
        const on = entity();
        const shape = (permissions: PermissionKey[]) =>
          host.admin.grantEntityShape(staff, { principalId: who, node: { tenantId: t1, scopeId: s1 }, entity: on, permissions, grantedBy: alice });
        await expectRefusal(shape([RSV_USE, RSV_RUN]), 'forbidden', /rsv:run cannot be granted/);
        expect(await holds(who, RSV_USE, on)).toBe(false);
        await shape([RSV_USE]);
        expect(await holds(who, RSV_USE, on)).toBe(true);
      });

      it('reconcileEntityGrantShapes refuses a shape holding a reserved key before topping anyone up; one only retiring it reconciles', async () => {
        const who = person();
        const on = entity();
        const node = { tenantId: t1, scopeId: s1 };
        await host.admin.grantEntityShape(staff, { principalId: who, node, entity: on, permissions: [RSV_USE], grantedBy: alice });
        await expectRefusal(
          host.admin.reconcileEntityGrantShapes(staff, node, [{ entityType: 'rsvdoc', permissions: [RSV_USE, RSV_RUN], bootstrap: true }]),
          'forbidden',
          /the entity grant shape on rsvdoc: rsv:run cannot be granted to a principal or an org/,
        );
        expect(await holds(who, RSV_RUN, on)).toBe(false);
        const twin = await host.admin.reconcileEntityGrantShapes(staff, node, [{ entityType: 'rsvdoc', permissions: [RSV_USE], retired: [RSV_RUN], bootstrap: true }]);
        expect(twin).toMatchObject({ toppedUp: 0, retired: 0 });
        expect(await holds(who, RSV_USE, on)).toBe(true);
      });

      it('ctx.grant refuses a reserved key from a person who holds it, and shares a person’s key', async () => {
        const who = person();
        const on = entity();
        const as = await host.getScope(alice, t1, s1);
        await expectRefusal(as.invoke('rsv/share', { principal: who, permission: RSV_RUN, entity: on }), 'forbidden', /rsv:run cannot be granted/);
        expect(await holds(who, RSV_RUN, on)).toBe(false);
        await as.invoke('rsv/share', { principal: who, permission: RSV_USE, entity: on });
        expect(await holds(who, RSV_USE, on)).toBe(true);
      });

      it('…and from a system actor, which holds the key and passes the delegation re-check by construction', async () => {
        const who = person();
        const on = entity();
        const system = await host.getSystemScope(RSV, t1, s1);
        await expectRefusal(system.invoke('rsv/share', { principal: who, permission: RSV_RUN, entity: on }), 'forbidden', /rsv:run cannot be granted/);
        expect(await holds(who, RSV_RUN, on)).toBe(false);
        await system.invoke('rsv/share', { principal: who, permission: RSV_USE, entity: on });
        expect(await holds(who, RSV_USE, on)).toBe(true);
      });
    });

    describe('the declared permission surface (`permissions`)', () => {
      it('refuses to register a module the surface leaves out, naming it', async () => {
        const other = await makeFixture({ permissions: { modules: [{ manifest: { id: '@test/elsewhere' } }] } });
        try {
          expect(() => other.host.registerModule(reservedRoleMod)).toThrow(
            /@test\/reserved-role is not in this host's permission surface \(the `permissions` it was given lists @test\/elsewhere\)/,
          );
        } finally {
          await other.cleanup();
        }
      });

      it('…and registers one it lists', async () => {
        const declared = await makeFixture({ permissions: { modules: [reservedRoleMod] } });
        try {
          expect(() => declared.host.registerModule(reservedRoleMod)).not.toThrow();
        } finally {
          await declared.cleanup();
        }
      });

      it('holds the reservation the surface declares when the module registered under its id sheds it', async () => {
        const declared = await makeFixture({ permissions: { modules: [reservedRoleMod] } });
        const t = tenantId.parse(ulid());
        try {
          declared.host.registerModule(unmarkedReservedRoleMod);
          await declared.host.admin.createTenant(staff, { id: t, slug: `rsv-union-${t.slice(-10).toLowerCase()}`, name: 'Union' });
          await declared.host.admin.defineRole(staff, t, { key: 'mixed', permissions: [RSV_USE, RSV_RUN], source: 'vertical' });
          await expectRefusal(
            declared.host.admin.assignRole(staff, { principalId: person(), roleKey: 'mixed', node: { tenantId: t, scopeId: null } }),
            'forbidden',
            /role 'mixed' holds rsv:run, reserved to a system principal/,
          );
        } finally {
          await declared.cleanup();
        }
      });
    });
  });
}
