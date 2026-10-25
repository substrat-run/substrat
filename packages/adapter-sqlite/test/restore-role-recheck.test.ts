import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { platformActorId, principalId, scopeId, tenantId, type PermissionKey } from '@substrat-run/contracts';
import { ulid } from '@substrat-run/kernel';
import { SqliteScopeHost } from '../src/index.js';

const USE = 'rrc:use' as PermissionKey;
const RUN = 'rrc:run' as PermissionKey;

/**
 * #2555, on the pure host: a restore judges the tenant's roles against the dump's seats twice, before
 * the orphan-sweep fence and again inside the load's own transaction. A role defined between the two
 * (here, while the fence is awaited) is judged against the dump too, and nothing is loaded. The shared
 * suite (`restoreRoleContractSuite`) holds the first judgement on both adapters; the Cloudflare host
 * has no transaction across the directory and the scope, so this half is the pure host's alone.
 */
describe('#2555: a role defined after the first judgement is judged inside the load', () => {
  const setup = async () => {
    const dir = mkdtempSync(join(tmpdir(), 'substrat-restore-recheck-'));
    const host = new SqliteScopeHost({ dir });
    const staff = platformActorId.parse(ulid());
    const t = tenantId.parse(ulid());
    const s = scopeId.parse(ulid());
    const alice = principalId.parse(ulid());
    await host.admin.createTenant(staff, { id: t, slug: `recheck-${t.slice(-10).toLowerCase()}`, name: 'Recheck' });
    await host.provisionScope(staff, { tenantId: t, scopeId: s });
    await host.admin.activateScope(staff, t, s);
    await host.admin.defineRole(staff, t, { key: 'member', permissions: [USE], source: 'vertical' });
    const seat = { principalId: alice, roleKey: 'member', node: { tenantId: t, scopeId: s } };
    await host.admin.assignRole(staff, seat);
    const dump = await host.admin.exportScope(staff, t, s);
    await host.admin.unassignRole(staff, seat);
    const redefine = (holder: 'system' | 'person') =>
      host.admin.defineRole(staff, t, { key: 'member', permissions: [holder === 'system' ? RUN : USE], source: 'vertical', ...(holder === 'system' ? { holder } : {}) });
    // The role changes while the restore awaits its fence, after the first judgement read the roles.
    const fence = (host as unknown as { fenceOrphanSweep: (...a: unknown[]) => Promise<void> }).fenceOrphanSweep.bind(host);
    const redefineDuringFence = (holder: 'system' | 'person') => {
      (host as unknown as { fenceOrphanSweep: (...a: unknown[]) => Promise<void> }).fenceOrphanSweep = async (...a: unknown[]) => {
        await redefine(holder);
        return fence(...a);
      };
    };
    // An import's: while it creates its scope, after the first judgement and before the load.
    const provision = host.provisionScope.bind(host);
    const redefineDuringProvision = (holder: 'system' | 'person') => {
      host.provisionScope = async (...a: Parameters<typeof host.provisionScope>) => {
        await provision(...a);
        await redefine(holder);
      };
    };
    const done = async () => {
      await host.close();
      rmSync(dir, { recursive: true, force: true });
    };
    return { host, staff, t, s, dump, redefine, redefineDuringFence, redefineDuringProvision, provision, done };
  };
  // A pure-SQLite dump carries no role rows, so the second sentence is the one met.
  const refused =
    "restore refused: the dump seats role 'member' but carries no definition of it, so its seats cannot be told from a person's, " +
    'and the tenant now defines the role for a system principal (K-55); nothing was loaded';

  it('made system-held during the fence: refused inside the load, and the seat does not come back', async () => {
    const { host, staff, t, s, dump, redefineDuringFence, done } = await setup();
    try {
      redefineDuringFence('system');
      await expect(host.restoreScope(staff, t, s, dump)).rejects.toThrow(refused);
      expect((await host.roleStateLocal(t, s)).seated).toEqual([]);
    } finally {
      await done();
    }
  });

  it('import: made system-held while its scope is created, refused inside the load, and the scope taken down', async () => {
    const { host, staff, t, dump, redefine, redefineDuringProvision, provision, done } = await setup();
    try {
      const fresh = scopeId.parse(ulid());
      redefineDuringProvision('system');
      await expect(host.importScope(staff, { tenantId: t, scopeId: fresh }, dump)).rejects.toThrow(refused);
      expect((await host.admin.getScopeRecord(staff, t, fresh)) ?? null).toBeNull();
      // The teardown is not a snapshot reap, so it is not audited as one.
      expect((await host.admin.auditLog(staff)).map((e) => e.action)).not.toContain('deleteSnapshot');
      // Nothing is left for a retry to meet: once the role is a person's again, the same id imports.
      host.provisionScope = provision;
      await redefine('person');
      await host.importScope(staff, { tenantId: t, scopeId: fresh }, dump);
      expect((await host.admin.getScopeRecord(staff, t, fresh))?.status).toBe('active');
    } finally {
      await done();
    }
  });

  it('import: a teardown that throws leaves the refusal as the answer, and files a staff-only ops row', async () => {
    const { host, staff, t, dump, redefineDuringProvision, done } = await setup();
    try {
      const fresh = scopeId.parse(ulid());
      redefineDuringProvision('system');
      (host as unknown as { dropScopeOutright: () => Promise<void> }).dropScopeOutright = async () => {
        throw new Error('disk gone');
      };
      await expect(host.importScope(staff, { tenantId: t, scopeId: fresh }, dump)).rejects.toThrow(refused);
      const rows = (await host.admin.listOpsFailures(staff)).filter((r) => r.stage === 'refused-import-teardown');
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ operation: 'importScope', scopeId: fresh, tenantId: null });
      expect(rows[0]?.message).toContain('disk gone');
      // The scope stays for staff to reap; the row is what names it.
      expect((await host.admin.getScopeRecord(staff, t, fresh))?.status).toBe('provisioning');
    } finally {
      await done();
    }
  });

  it('import twin: redefined as a person’s role while its scope is created, the import loads with the seat', async () => {
    const { host, staff, t, dump, redefineDuringProvision, done } = await setup();
    try {
      const fresh = scopeId.parse(ulid());
      redefineDuringProvision('person');
      await host.importScope(staff, { tenantId: t, scopeId: fresh }, dump);
      expect((await host.roleStateLocal(t, fresh)).seated).toEqual(['member']);
    } finally {
      await done();
    }
  });

  it('twin: redefined as a person’s role during the fence, the restore loads and the seat is back', async () => {
    const { host, staff, t, s, dump, redefineDuringFence, done } = await setup();
    try {
      redefineDuringFence('person');
      await host.restoreScope(staff, t, s, dump);
      expect((await host.roleStateLocal(t, s)).seated).toEqual(['member']);
    } finally {
      await done();
    }
  });
});
