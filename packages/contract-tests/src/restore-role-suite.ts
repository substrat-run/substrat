import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { platformActorId, principalId, scopeId, tenantId, type PermissionKey, type ScopeId, type TenantId } from '@substrat-run/contracts';
import { ulid, type RoleState } from '@substrat-run/kernel';
import type { ScopeHostFixture } from './scope-host-suite.js';

/**
 * #2555: a staff restore or import on a host the control plane runs (`restoreScope`, `importScope`)
 * judges the tenant's roles as the directory stores them NOW against the dump's seats and role rows
 * (`dumpRoleRefusal`), before anything is replaced. A dump holding a seat in a role the directory
 * has since made system-held is refused, with nothing loaded and no scope created; the twin without
 * the seat is admitted. A change the rule admits leaves the dump's seats as they were: nothing is
 * revoked. The refusal is one fixed sentence naming the role key only.
 */
export function restoreRoleContractSuite(
  adapterName: string,
  makeFixture: () => Promise<
    ScopeHostFixture & {
      roleState(tenantId: TenantId, scopeId: ScopeId): Promise<RoleState>;
      /** Whether this host's dump stores the tenant's role rows (a scope that reads its roles locally). */
      dumpCarriesRoles: boolean;
    }
  >,
): void {
  describe(`a restore judges the directory's roles against the dump's seats (#2555): ${adapterName}`, () => {
    let fixture: Awaited<ReturnType<typeof makeFixture>>;
    const staff = platformActorId.parse(ulid());
    const t = tenantId.parse(ulid());
    const alice = principalId.parse(ulid());
    const USE = 'rrs:use' as PermissionKey;
    const RUN = 'rrs:run' as PermissionKey;
    const undefinedInDump = (key: string) =>
      `restore refused: the dump seats role '${key}' but carries no definition of it, so its seats cannot be told from a person's, ` +
      `and the tenant now defines the role for a system principal (K-55); nothing was loaded`;
    /** The refusal of a seat in a role since made system-held: which sentence depends on whether the dump stores the role. */
    const refusalFor = (key: string) =>
      fixture.dumpCarriesRoles
        ? `restore refused: role '${key}', which the dump seats or defines, cannot be applied as the tenant defines it now (K-55); nothing was loaded`
        : undefinedInDump(key);

    const scope = async () => {
      const id = scopeId.parse(ulid());
      await fixture.host.provisionScope(staff, { tenantId: t, scopeId: id, vertical: 'restore-roles' });
      await fixture.host.admin.activateScope(staff, t, id);
      return id;
    };
    const seat = (roleKey: string, at: ScopeId) => ({ principalId: alice, roleKey, node: { tenantId: t, scopeId: at } });
    const refusalOf = (p: Promise<unknown>) => p.then(() => undefined, (e: unknown) => e as Error & { code?: string });

    beforeAll(async () => {
      fixture = await makeFixture();
      await fixture.host.admin.createTenant(staff, { id: t, slug: `restore-roles-${t.slice(-8).toLowerCase()}`, name: 'Restore roles' });
    });
    afterAll(async () => fixture?.cleanup());

    it('a dump seated in a role since made system-held is refused: nothing loaded, no scope created', async () => {
      const s = await scope();
      await fixture.host.admin.defineRole(staff, t, { key: 'member', permissions: [USE], source: 'vertical' });
      await fixture.host.admin.assignRole(staff, seat('member', s));
      const dump = await fixture.host.admin.exportScope(staff, t, s);
      // The seat is taken back, so the directory may now make the role system-held.
      await fixture.host.admin.unassignRole(staff, seat('member', s));
      await fixture.host.admin.defineRole(staff, t, { key: 'member', permissions: [RUN], source: 'vertical', holder: 'system' });

      const restored = await refusalOf(fixture.host.restoreScope(staff, t, s, dump));
      expect(restored?.message).toBe(refusalFor('member'));
      // The scope is as it was: the seat the dump holds did not come back.
      expect((await fixture.roleState(t, s)).seated).toEqual([]);

      const fresh = scopeId.parse(ulid());
      const imported = await refusalOf(fixture.host.importScope(staff, { tenantId: t, scopeId: fresh, vertical: 'restore-roles' }, dump));
      expect(imported?.message).toBe(refusalFor('member'));
      expect((await fixture.host.admin.getScopeRecord(staff, t, fresh)) ?? null).toBeNull();
    });

    it('the refusal names the role key only: no principal, no tenant', async () => {
      const s = await scope();
      await fixture.host.admin.defineRole(staff, t, { key: 'named', permissions: [USE], source: 'vertical' });
      await fixture.host.admin.assignRole(staff, seat('named', s));
      const dump = await fixture.host.admin.exportScope(staff, t, s);
      await fixture.host.admin.unassignRole(staff, seat('named', s));
      await fixture.host.admin.defineRole(staff, t, { key: 'named', permissions: [RUN], source: 'vertical', holder: 'system' });
      const message = (await refusalOf(fixture.host.restoreScope(staff, t, s, dump)))?.message ?? '';
      expect(message).toBe(refusalFor('named'));
      for (const id of [alice, t, s]) expect(message).not.toContain(id);
    });

    it('twin: the same change with no seat in the dump is admitted, by restore and by import', async () => {
      const s = await scope();
      await fixture.host.admin.defineRole(staff, t, { key: 'idle', permissions: [USE], source: 'vertical' });
      const dump = await fixture.host.admin.exportScope(staff, t, s);
      await fixture.host.admin.defineRole(staff, t, { key: 'idle', permissions: [RUN], source: 'vertical', holder: 'system' });
      await fixture.host.restoreScope(staff, t, s, dump);
      const fresh = scopeId.parse(ulid());
      await fixture.host.importScope(staff, { tenantId: t, scopeId: fresh, vertical: 'restore-roles' }, dump);
      expect((await fixture.host.admin.getScopeRecord(staff, t, fresh))?.status).toBe('active');
    });

    it('a person’s role the directory changed since is admitted, and the dump’s seat in it is kept', async () => {
      const s = await scope();
      await fixture.host.admin.defineRole(staff, t, { key: 'editor', permissions: [USE], source: 'vertical' });
      await fixture.host.admin.assignRole(staff, seat('editor', s));
      const dump = await fixture.host.admin.exportScope(staff, t, s);
      await fixture.host.admin.unassignRole(staff, seat('editor', s));
      await fixture.host.admin.defineRole(staff, t, { key: 'editor', permissions: [USE, 'rrs:edit' as PermissionKey], source: 'vertical' });
      await fixture.host.restoreScope(staff, t, s, dump);
      expect((await fixture.roleState(t, s)).seated).toEqual(['editor']);
    });

    // Where the dump carries no role rows, this is a scope that cannot be restored from its own export (K-55).
    it('a seat in a role stored system-held when the dump was taken: admitted where the dump stores the role, else judged a person’s', async () => {
      const s = await scope();
      await fixture.host.admin.defineRole(staff, t, { key: 'runner', permissions: [RUN], source: 'vertical', holder: 'system' });
      // The platform's door seats a system-held role made only of keys this host does not reserve.
      await fixture.host.admin.assignRole(staff, seat('runner', s));
      const dump = await fixture.host.admin.exportScope(staff, t, s);
      const restored = await refusalOf(fixture.host.restoreScope(staff, t, s, dump));
      if (fixture.dumpCarriesRoles) {
        expect(restored).toBeUndefined();
      } else {
        // A dump with no role rows says nothing about the definition its seat was made under.
        expect(restored?.message).toBe(undefinedInDump('runner'));
      }
      expect((await fixture.roleState(t, s)).seated).toEqual(['runner']);
    });
  });
}
