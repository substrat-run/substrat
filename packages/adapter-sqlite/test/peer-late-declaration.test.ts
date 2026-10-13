import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { errorCodeOf, permissionKey, platformActorId, scopeId, tenantId, type VerticalCaller } from '@substrat-run/contracts';
import { ulid } from '@substrat-run/kernel';
import { PEER_CALLER, peerMod } from '@substrat-run/contract-tests';
import { SqliteScopeHost } from '../src/index.js';

/**
 * #2263: a scope provisioned by a version that declared NO peers, then served by a version that
 * declares one. Two hosts over one directory are the two versions over one scope's storage.
 *
 * The declaration alone admits the caller at the door and grants it nothing: its keys are seated
 * by provisioning (`peerSeats`), which this scope ran before the declaration existed. A reconcile
 * (a re-provision, on this host) is what seats them, and then the call is admitted.
 */
describe('#2263: a peer declared after the scope was provisioned (pure adapter)', () => {
  it('holds nothing until a reconcile seats the declared keys, then is admitted', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'substrat-peer-late-'));
    const staff = platformActorId.parse(ulid());
    const t = tenantId.parse(ulid());
    const s = scopeId.parse(ulid());
    const caller: VerticalCaller = { vertical: PEER_CALLER, scope: scopeId.parse(ulid()) };
    const READ = permissionKey.parse('peer:read');
    const WRITE = permissionKey.parse('peer:write');
    // The version before the declaration: the same module, with no `peers`.
    const undeclared = { ...peerMod, manifest: { ...peerMod.manifest, peers: undefined } };

    const before = new SqliteScopeHost({ dir });
    before.registerModule(undeclared);
    await before.admin.createTenant(staff, { id: t, slug: 'peer-late', name: 'Peer late' });
    await before.admin.grantEntitlement(staff, t, 'peer');
    await before.provisionScope(staff, { tenantId: t, scopeId: s });
    await before.admin.activateScope(staff, t, s);
    await before.close();

    const after = new SqliteScopeHost({ dir });
    after.registerModule(peerMod);
    try {
      const list = async () => (await after.getVerticalScope(caller, t, s)).invoke('peer/list');
      const status = async () => (await after.admin.peerGrantsStatus(staff, { tenantId: t, scopeId: s })).map((p) => p.vertical);

      // The new version serves the scope: declared, and holding nothing.
      expect(await after.peerCovers(t, s, PEER_CALLER, [READ, WRITE])).toEqual([
        { permission: READ, held: false },
        { permission: WRITE, held: false },
      ]);
      expect(await status()).toEqual([]);
      expect(errorCodeOf(await list().then(() => undefined, (e: unknown) => e))).toBe('permission_denied');

      // The reconcile seats exactly the declared keys, and the next call is admitted.
      await after.provisionScope(staff, { tenantId: t, scopeId: s });
      expect(await after.peerCovers(t, s, PEER_CALLER, [READ, WRITE])).toEqual([
        { permission: READ, held: true },
        { permission: WRITE, held: true },
      ]);
      expect(await status()).toContain(PEER_CALLER);
      await expect(list()).resolves.toEqual([]);
    } finally {
      await after.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
