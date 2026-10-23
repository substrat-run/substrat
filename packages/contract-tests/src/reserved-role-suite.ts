import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectionId, instant, moduleId, orgId, platformActorId, principalId, scopeId, tenantId, type PermissionKey, type PrincipalId } from '@substrat-run/contracts';
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
 *   and an all-reserved role stored as person; it admits a system-held role of reserved keys.
 * - A raw grant (`HostAdmin.grant`, `grantToOrg`, `grantEntityShape`, `ctx.grant`) of a reserved
 *   key is refused whoever makes it — a person, or a system actor, which passes `ctx.grant`'s
 *   delegation re-check by construction. Its twin, a key no module reserves, passes.
 * - So is a connection grant (`grantToConnection`), at either node: a connection acts for the
 *   external provider holding its token. Nothing is recorded for a later provision to deliver.
 * - Each refusal writes nothing: the principal holds nothing afterwards.
 * - A role DEFINITION is judged too (#2447): `defineRole` refuses a person's role carrying a
 *   reserved key and a system-held role carrying a person's key, so a role cannot be widened after
 *   it was assigned; a seat holding a key reserved after it was seated keeps working, through a
 *   refused redefinition and a fan-out. A host that registers no reserving module learns the
 *   reservation from the tenant's system-held roles, admits a key it knows nothing about
 *   (fail-open), and its person's doors refuse a role stored `holder: 'system'`.
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
    const legacy = principalId.parse(ulid()); // seated in `mixed` before rsv:run was reserved here (#2447)
    const person = () => principalId.parse(ulid());
    const entity = () => ({ entityType: 'rsvdoc', entityId: ulid() });
    const RSV = moduleId.parse('@test/reserved-role');
    /** How a person's door refuses: worded for `canAssign`'s removal bound as well as for an assignment. */
    const NO_BOUND = "no person's bound covers it, to give the role or to take it back";
    /** A person's door on `roleKey`: for the reserved key it holds, or (#2447) for its stored `holder: 'system'`. */
    const personRefusal = (roleKey: string) =>
      new RegExp(`role '${roleKey}' (holds rsv:run, reserved to a system principal|is declared holder: 'system', a role for a system principal): ${NO_BOUND}`);

    const holds = async (who: PrincipalId, permission: PermissionKey, on?: { entityType: string; entityId: string }) => {
      const stub = await host.getScope(who, t1, s1);
      return (await stub.invoke<{ allowed: boolean }>('perm/probe', { permission, entity: on })).allowed;
    };

    beforeAll(async () => {
      fixture = await makeFixture();
      host = fixture.host;
      host.registerModule(permMod); // its `perm/probe` reports what a principal holds
      await host.admin.createTenant(staff, { id: t1, slug: 'reserved-role-tenant', name: 'Reserved' });
      // #2447: a role definition is judged when it is written, so the roles below that a person may
      // not hold exist the one way they still can: defined before the module reserving rsv:run was
      // registered here (a key an engine reserves in a later version). `legacy` is seated then too.
      await host.admin.defineRole(staff, t1, { key: 'mixed', permissions: [RSV_USE, RSV_RUN], source: 'vertical' });
      await host.admin.defineRole(staff, t1, { key: 'person-runner', permissions: [RSV_RUN], source: 'vertical' });
      await host.admin.assignRole(staff, { principalId: legacy, roleKey: 'mixed', node: { tenantId: t1, scopeId: null } });
      host.registerModule(reservedRoleMod);
      await host.admin.grantEntitlement(staff, t1, 'perm');
      await host.admin.grantEntitlement(staff, t1, 'rsv');
      await host.provisionScope(staff, { tenantId: t1, scopeId: s1, vertical: 'rsv-vertical' });
      await host.admin.activateScope(staff, t1, s1);
      await host.admin.defineRole(staff, t1, { key: 'member', permissions: [RSV_USE], source: 'vertical' });
      await host.admin.defineRole(staff, t1, { key: 'runner', permissions: [RSV_RUN], source: 'vertical', holder: 'system' });
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

      it.each([['the tenant node', null], ['a scope node', s1]])('refuses a newly stored person role of only reserved keys at %s', async (_where, scope) => {
        const who = person();
        await expectRefusal(
          host.admin.assignRole(staff, { principalId: who, roleKey: 'person-runner', node: { tenantId: t1, scopeId: scope } }),
          'forbidden',
          /role 'person-runner' holds rsv:run.*stored holder is person.*must declare holder: 'system'/,
        );
        expect(await holds(who, RSV_RUN)).toBe(false);
      });

      it('reads the persisted holder in the directory roster', async () => {
        const roles = await host.admin.listRoles(staff, { tenantId: t1 });
        expect(roles.find((r) => r.key === 'runner')?.holder).toBe('system');
        expect(roles.find((r) => r.key === 'person-runner')?.holder).toBe('person');
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
            personRefusal(roleKey),
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
          await expectRefusal(host.changeScopeRoleBounded(t1, s1, alice, who, 'member', roleKey), 'forbidden', personRefusal(roleKey));
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
        await expectRefusal(as.invoke('perm/can-assign', { roleKey: 'runner' }), 'forbidden', personRefusal('runner'));
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
          /rsv:run cannot be granted to a principal, an org or a connection: reserved to a system principal/,
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

      it.each([
        ['a scope node', s1],
        ['the tenant node', null],
      ])('grantToConnection refuses a reserved key at %s, recording nothing; its twin grants a person’s key', async (_where, scope) => {
        const conn = connectionId.parse(ulid());
        await host.admin.createConnection(staff, {
          id: conn,
          tenantId: t1,
          vertical: 'rsv-vertical',
          provider: `rsv-${conn.toLowerCase()}`,
          label: 'reserved-key connection',
          secret: { accessToken: 'tok' },
        });
        const grant = (permission: PermissionKey) =>
          host.admin.grantToConnection(staff, { connectionId: conn, permission, node: { tenantId: t1, scopeId: scope }, grantedBy: staff });
        const recorded = async () =>
          (await host.admin.listConnectionGrants(staff, t1)).filter((g) => g.connectionId === conn).map((g) => g.permission);
        const connectionHolds = async (permission: PermissionKey) =>
          (await (await host.getConnectorScope(conn, s1)).invoke<{ allowed: boolean }>('perm/probe', { permission })).allowed;
        await expectRefusal(grant(RSV_RUN), 'forbidden', /rsv:run cannot be granted to a principal, an org or a connection/);
        expect(await recorded()).toEqual([]);
        expect(await connectionHolds(RSV_RUN)).toBe(false);
        await grant(RSV_USE);
        expect(await recorded()).toEqual([RSV_USE]);
        expect(await connectionHolds(RSV_USE)).toBe(true);
      });

      it('reconcileEntityGrantShapes refuses a shape holding a reserved key before topping anyone up; one only retiring it reconciles', async () => {
        const who = person();
        const on = entity();
        const node = { tenantId: t1, scopeId: s1 };
        await host.admin.grantEntityShape(staff, { principalId: who, node, entity: on, permissions: [RSV_USE], grantedBy: alice });
        await expectRefusal(
          host.admin.reconcileEntityGrantShapes(staff, node, [{ entityType: 'rsvdoc', permissions: [RSV_USE, RSV_RUN], bootstrap: true }]),
          'forbidden',
          /the entity grant shape on rsvdoc: rsv:run cannot be granted to a principal, an org or a connection/,
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

    describe('role definitions (#2447)', () => {
      const stored = async (key: string) => (await host.admin.listRoles(staff, { tenantId: t1 })).find((r) => r.key === key)?.permissions;

      it('refuses defining a person’s role carrying a reserved key, and writes nothing; its twin is defined', async () => {
        await expectRefusal(
          host.admin.defineRole(staff, t1, { key: 'crew', permissions: [RSV_USE, RSV_RUN], source: 'vertical' }),
          'forbidden',
          /role 'crew' is a person's role and would hold rsv:run \(a module this host registers/,
        );
        expect(await stored('crew')).toBeUndefined();
        await host.admin.defineRole(staff, t1, { key: 'crew', permissions: [RSV_USE], source: 'vertical' });
        expect(await stored('crew')).toEqual([RSV_USE]);
      });

      it('refuses widening a role after it was assigned: the seat keeps exactly what it held', async () => {
        const who = person();
        await host.admin.defineRole(staff, t1, { key: 'grows', permissions: [RSV_USE], source: 'vertical' });
        await host.admin.assignRole(staff, { principalId: who, roleKey: 'grows', node: { tenantId: t1, scopeId: s1 } });
        await expectRefusal(
          host.admin.defineRole(staff, t1, { key: 'grows', permissions: [RSV_USE, RSV_RUN], source: 'vertical' }),
          'forbidden',
          /role 'grows' is a person's role and would hold rsv:run/,
        );
        expect(await stored('grows')).toEqual([RSV_USE]);
        expect(await holds(who, RSV_USE)).toBe(true);
        expect(await holds(who, RSV_RUN)).toBe(false);
      });

      it('revokes nothing: a seat holding a key reserved after it was seated keeps working, through a refused redefinition and a fan-out', async () => {
        expect(await holds(legacy, RSV_RUN)).toBe(true);
        await expectRefusal(
          host.admin.defineRole(staff, t1, { key: 'mixed', permissions: [RSV_USE, RSV_RUN], source: 'vertical' }),
          'forbidden',
          /role 'mixed' is a person's role and would hold rsv:run/,
        );
        // A tenant-level assignment fans the stored roles out to the scopes; the stored definition
        // is projected as it is, never re-judged, so the seat is not narrowed or dropped by it.
        await host.admin.assignRole(staff, { principalId: person(), roleKey: 'member', node: { tenantId: t1, scopeId: null } });
        expect(await stored('mixed')).toEqual([RSV_USE, RSV_RUN]);
        expect(await holds(legacy, RSV_RUN)).toBe(true);
        expect(await holds(legacy, RSV_USE)).toBe(true);
      });

      it('a narrowing redefinition is never refused for what it takes out', async () => {
        await host.admin.defineRole(staff, t1, { key: 'person-runner', permissions: [RSV_USE], source: 'vertical' });
        expect(await stored('person-runner')).toEqual([RSV_USE]);
      });

      it('refuses a system-held role holding a key a registered module declares for a person; its twin is defined', async () => {
        await expectRefusal(
          host.admin.defineRole(staff, t1, { key: 'wide-runner', permissions: [RSV_RUN, RSV_USE], source: 'vertical', holder: 'system' }),
          'forbidden',
          /role 'wide-runner' is declared holder: 'system' but holds rsv:use \(declared for a person by a module this host registers\)/,
        );
        expect(await stored('wide-runner')).toBeUndefined();
        await host.admin.defineRole(staff, t1, { key: 'wide-runner', permissions: [RSV_RUN], source: 'vertical', holder: 'system' });
        expect(await stored('wide-runner')).toEqual([RSV_RUN]);
      });
    });

    describe('a host that registers no module reserving the key (#2447)', () => {
      let bare: ScopeHostFixture;
      const t = tenantId.parse(ulid());
      const other = tenantId.parse(ulid());
      const roster = async (tenant: typeof t) => (await bare.host.admin.listRoles(staff, { tenantId: tenant })).map((r) => r.key).sort();

      beforeAll(async () => {
        bare = await makeFixture();
        bare.host.registerModule(permMod); // declares nothing of rsv
        for (const [id, slug] of [[t, 'rsv-bare'], [other, 'rsv-bare-other']] as const) {
          await bare.host.admin.createTenant(staff, { id, slug: `${slug}-${id.slice(-8).toLowerCase()}`, name: 'Bare' });
        }
        await bare.host.admin.defineRole(staff, t, { key: 'host-runner', permissions: [RSV_RUN], source: 'vertical', holder: 'system' });
        await bare.host.admin.defineRole(staff, t, { key: 'member', permissions: [RSV_USE], source: 'vertical' });
      });

      afterAll(async () => {
        await bare?.cleanup();
      });

      it('learns the reservation from the tenant’s system-held roles: a person’s role carrying one of their keys is refused', async () => {
        await expectRefusal(
          bare.host.admin.defineRole(staff, t, { key: 'crew', permissions: [RSV_USE, RSV_RUN], source: 'vertical' }),
          'forbidden',
          /role 'crew' is a person's role and would hold rsv:run \(held by the system-held role 'host-runner'\)/,
        );
        expect(await roster(t)).toEqual(['host-runner', 'member']);
      });

      it('fails open on a key it knows nothing about: with no system-held role holding it, the same role is defined', async () => {
        await bare.host.admin.defineRole(staff, other, { key: 'crew', permissions: [RSV_USE, RSV_RUN], source: 'vertical' });
        expect(await roster(other)).toEqual(['crew']);
      });

      it('a person’s door refuses the system-held role from its stored holder alone; its twin applies', async () => {
        const boss = person();
        await bare.host.admin.assignRole(staff, { principalId: boss, roleKey: 'member', node: { tenantId: t, scopeId: null } });
        const add = (roleKey: string) =>
          bare.host.admin.applyMembership(staff, {
            op: 'add',
            tenantId: t,
            principal: person(),
            roleKey,
            boundedBy: boss,
            unlessRemovedSince: instant.parse(new Date(Date.now() - 60_000).toISOString()),
          });
        expect(await add('host-runner')).toEqual({
          applied: false,
          reserved: expect.stringMatching(new RegExp(`role 'host-runner' is declared holder: 'system', a role for a system principal: ${NO_BOUND}`)),
        });
        expect(await add('member')).toEqual({ applied: true });
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
          // #2447: the role definition is where the held reservation now refuses first.
          await expectRefusal(
            declared.host.admin.defineRole(staff, t, { key: 'mixed', permissions: [RSV_USE, RSV_RUN], source: 'vertical' }),
            'forbidden',
            /role 'mixed' is a person's role and would hold rsv:run/,
          );
        } finally {
          await declared.cleanup();
        }
      });
    });
  });
}
