import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { instant, platformActorId, principalId, scopeId, tenantId, type PermissionKey, type PrincipalId } from '@substrat-run/contracts';
import { ulid, type DeclaredPermissions, type ScopeHost } from '@substrat-run/kernel';
import { expectRefusal, type ScopeHostFixture } from './scope-host-suite.js';
import { permMod } from './modules.js';
import { RSV_RUN, RSV_USE, reservedRoleMod } from './reserved-role-module.js';

/**
 * #2430: a role carrying a key a registered module reserves to a system principal
 * (`holder: 'system'`) is not conferred through a role door, on either adapter.
 *
 * - A person's doors (`assignScopeRoleBounded`, `changeScopeRoleBounded`'s target, a membership
 *   add) refuse any role carrying one, even to a caller who holds every key of it, so the refusal
 *   is the reservation's and never the coverage bound's.
 * - The platform's door (`HostAdmin.assignRole`) refuses a role mixing reserved and other keys,
 *   and admits a role made only of reserved keys (K-55's system-held shape).
 * - Each refusal writes nothing: the principal holds nothing afterwards.
 *
 * And the host option `permissions`: a host given its declared surface refuses to register a
 * module the surface leaves out.
 */
export function reservedRoleContractSuite(
  adapterName: string,
  makeFixture: (options?: { permissions?: DeclaredPermissions }) => Promise<ScopeHostFixture>,
): void {
  describe(`reserved keys at the role doors (#2430): ${adapterName}`, () => {
    let fixture: ScopeHostFixture;
    let host: ScopeHost;
    const t1 = tenantId.parse(ulid());
    const s1 = scopeId.parse(ulid());
    const staff = platformActorId.parse(ulid());
    const alice = principalId.parse(ulid()); // holds both keys tenant-wide: every bound is covered
    const person = () => principalId.parse(ulid());

    const holds = async (who: PrincipalId, permission: PermissionKey) => {
      const stub = await host.getScope(who, t1, s1);
      return (await stub.invoke<{ allowed: boolean }>('perm/probe', { permission })).allowed;
    };

    beforeAll(async () => {
      fixture = await makeFixture();
      host = fixture.host;
      host.registerModule(reservedRoleMod);
      host.registerModule(permMod); // its `perm/probe` reports what a principal holds
      await host.admin.createTenant(staff, { id: t1, slug: 'reserved-role-tenant', name: 'Reserved' });
      await host.admin.grantEntitlement(staff, t1, 'perm');
      await host.provisionScope(staff, { tenantId: t1, scopeId: s1, vertical: 'rsv-vertical' });
      await host.admin.activateScope(staff, t1, s1);
      await host.admin.defineRole(staff, t1, { key: 'member', permissions: [RSV_USE], source: 'vertical' });
      await host.admin.defineRole(staff, t1, { key: 'mixed', permissions: [RSV_USE, RSV_RUN], source: 'vertical' });
      await host.admin.defineRole(staff, t1, { key: 'runner', permissions: [RSV_RUN], source: 'vertical' });
      for (const permission of [RSV_USE, RSV_RUN]) {
        await host.admin.grant(staff, { principalId: alice, permission, node: { tenantId: t1, scopeId: null }, grantedBy: alice });
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

      it('admits a role made only of reserved keys (the system-held shape, K-55)', async () => {
        const hostPrincipal = person();
        await host.admin.assignRole(staff, { principalId: hostPrincipal, roleKey: 'runner', node: { tenantId: t1, scopeId: s1 } });
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
        'assignScopeRoleBounded refuses %s to a caller who covers it, and writes nothing',
        async (roleKey) => {
          const who = person();
          await expectRefusal(
            host.assignScopeRoleBounded(t1, s1, alice, who, roleKey),
            'forbidden',
            new RegExp(`role '${roleKey}' cannot be given to a person: it holds rsv:run`),
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

      it('changeScopeRoleBounded refuses moving someone into a reserved role, and leaves the role they held', async () => {
        const who = person();
        await host.assignScopeRoleBounded(t1, s1, alice, who, 'member');
        await expectRefusal(host.changeScopeRoleBounded(t1, s1, alice, who, 'member', 'runner'), 'forbidden', /role 'runner' cannot be given/);
        expect(await host.listScopeRoleHolders(t1, s1, who)).toEqual([{ principal: who, roleKey: 'member' }]);
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
        expect(await add('mixed')).toEqual({ applied: false, reserved: expect.stringMatching(/role 'mixed' cannot be given to a person/) });
        expect(await holds(who, RSV_USE)).toBe(false);
        expect(await add('member')).toEqual({ applied: true });
        expect(await holds(who, RSV_USE)).toBe(true);
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
    });
  });
}
