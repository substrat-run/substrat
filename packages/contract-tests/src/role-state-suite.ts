import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { platformActorId, principalId, scopeId, tenantId, type PermissionKey, type RoleDefinition, type ScopeId, type TenantId } from '@substrat-run/contracts';
import { releaseRoleSetRefusal, ulid, type RoleState } from '@substrat-run/kernel';
import type { ScopeHostFixture } from './scope-host-suite.js';

/**
 * #2446: `roleStateLocal`, the state a promote judges the incoming version's role set against
 * before it moves a scope, reads the same on both adapters: the roles the host stores for the
 * tenant (with their holders), and the role keys anyone holds a live scope-level seat in at that
 * scope (`SCOPE_SEATED_ROLES_SQL`). A tenant-level seat is not a scope's; a revoked seat is not a
 * seat. It names no principal. And the promote's question over it (`releaseRoleSetRefusal`) refuses
 * a seated person's role made `holder: 'system'` and admits its unseated twin.
 */
export function roleStateContractSuite(
  adapterName: string,
  makeFixture: () => Promise<
    ScopeHostFixture & {
      roleState(tenantId: TenantId, scopeId: ScopeId): Promise<RoleState>;
      /** Where a host keeps a scope-level copy of the tenant's roles (a CP-less deployment), project them there as its reconcile does. */
      projectRoles?(tenantId: TenantId, scopeId: ScopeId, roles: RoleDefinition[]): Promise<void>;
    }
  >,
): void {
  describe(`a scope's role state, as a promote reads it (#2446): ${adapterName}`, () => {
    let fixture: Awaited<ReturnType<typeof makeFixture>>;
    const staff = platformActorId.parse(ulid());
    const t = tenantId.parse(ulid());
    const s = scopeId.parse(ulid());
    const other = scopeId.parse(ulid());
    const alice = principalId.parse(ulid());
    const bob = principalId.parse(ulid());
    const carol = principalId.parse(ulid());
    const USE = 'rst:use' as PermissionKey;
    const RUN = 'rst:run' as PermissionKey;
    const flip = {
      permissions: [{ key: USE }, { key: RUN, holder: 'system' as const }],
      roles: [{ key: 'member', permissions: [RUN], holder: 'system' as const }],
    };

    beforeAll(async () => {
      fixture = await makeFixture();
      const { host } = fixture;
      await host.admin.createTenant(staff, { id: t, slug: `role-state-${t.slice(-8).toLowerCase()}`, name: 'Role state' });
      for (const id of [s, other]) {
        await host.provisionScope(staff, { tenantId: t, scopeId: id, vertical: 'role-state' });
        await host.admin.activateScope(staff, t, id);
      }
      const roles: RoleDefinition[] = [
        { key: 'member', permissions: [USE], source: 'vertical' },
        { key: 'runner', permissions: [RUN], source: 'vertical', holder: 'system' },
        { key: 'tenant-wide', permissions: [USE], source: 'vertical' },
        { key: 'elsewhere', permissions: [USE], source: 'vertical' },
      ];
      for (const role of roles) await host.admin.defineRole(staff, t, role);
      for (const id of [s, other]) await fixture.projectRoles?.(t, id, roles);
      await host.admin.assignRole(staff, { principalId: alice, roleKey: 'member', node: { tenantId: t, scopeId: s } });
      await host.admin.assignRole(staff, { principalId: bob, roleKey: 'tenant-wide', node: { tenantId: t, scopeId: null } });
      await host.admin.assignRole(staff, { principalId: carol, roleKey: 'elsewhere', node: { tenantId: t, scopeId: other } });
    });
    afterAll(async () => fixture?.cleanup());

    it('reads the tenant’s stored roles with their holders, and the scope-level seats there', async () => {
      const state = await fixture.roleState(t, s);
      const byKey = Object.fromEntries(state.roles.map((r) => [r.key, r]));
      expect(byKey['member']).toMatchObject({ key: 'member', permissions: [USE] });
      expect(byKey['member']?.holder ?? 'person').toBe('person');
      expect(byKey['runner']).toEqual({ key: 'runner', permissions: [RUN], holder: 'system' });
      // A tenant-level seat (bob's) is not this scope's.
      expect(state.seated).toEqual(['member']);
      // A seat in another scope of the tenant is that scope's, not this one's.
      expect((await fixture.roleState(t, other)).seated).toEqual(['elsewhere']);
    });

    it('names role keys only, never a principal', async () => {
      const wire = JSON.stringify(await fixture.roleState(t, s));
      expect(wire).not.toContain(alice);
      expect(wire).not.toContain(bob);
      expect(JSON.stringify(await fixture.roleState(t, other))).not.toContain(carol);
    });

    it('the promote’s question over it refuses a seated person’s role made holder: system; twin: another scope passes', async () => {
      expect(releaseRoleSetRefusal(flip, await fixture.roleState(t, s))).toMatch(
        /^role 'member' is held by a principal \(stored as a person's role\), so it cannot be declared holder: 'system'/,
      );
      expect(releaseRoleSetRefusal(flip, await fixture.roleState(t, other))).toBeNull();
    });

    it('a revoked seat is no seat, and the same release then passes', async () => {
      await fixture.host.admin.unassignRole(staff, { principalId: alice, roleKey: 'member', node: { tenantId: t, scopeId: s } });
      const state = await fixture.roleState(t, s);
      expect(state.seated).toEqual([]);
      expect(releaseRoleSetRefusal(flip, state)).toBeNull();
    });
  });
}
