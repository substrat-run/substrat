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
    // The role changes while the restore awaits its fence, after the first judgement read the roles.
    const fence = (host as unknown as { fenceOrphanSweep: (...a: unknown[]) => Promise<void> }).fenceOrphanSweep.bind(host);
    const redefineDuringFence = (holder: 'system' | 'person') => {
      (host as unknown as { fenceOrphanSweep: (...a: unknown[]) => Promise<void> }).fenceOrphanSweep = async (...a: unknown[]) => {
        await host.admin.defineRole(staff, t, { key: 'member', permissions: [holder === 'system' ? RUN : USE], source: 'vertical', ...(holder === 'system' ? { holder } : {}) });
        return fence(...a);
      };
    };
    const done = async () => {
      await host.close();
      rmSync(dir, { recursive: true, force: true });
    };
    return { host, staff, t, s, dump, redefineDuringFence, done };
  };

  it('made system-held during the fence: refused inside the load, and the seat does not come back', async () => {
    const { host, staff, t, s, dump, redefineDuringFence, done } = await setup();
    try {
      redefineDuringFence('system');
      await expect(host.restoreScope(staff, t, s, dump)).rejects.toThrow(
        "restore refused: the dump holds a seat or role that role 'member', as the tenant defines it now, does not admit (K-55); nothing was loaded",
      );
      expect((await host.roleStateLocal(t, s)).seated).toEqual([]);
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
