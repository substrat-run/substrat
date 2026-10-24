import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { platformActorId, scopeId, tenantId, type ScopeId } from '@substrat-run/contracts';
import { ulid, type ScopeHost } from '@substrat-run/kernel';
import type { DirectoryExec } from './findings-atomic-suite.js';
import { expectRefusal, type ScopeHostFixture } from './scope-host-suite.js';

/**
 * Provisioning holds a vertical a caller names to the registry's grammar (`verticalSource:
 * 'input'`, the default), and a copy takes the vertical its source already stores
 * (`'copy'`), held only to what the directory reads. So a scope whose stored vertical reads but
 * is not a slug — one stored before the grammar was held at provisioning — is snapshotted as
 * before, and the same value named by a caller is refused.
 *
 * `exec` writes the stored value past the provisioning boundary, the only way such a row is
 * reached now. Every value is written back before the suite ends: an adapter's directory may be
 * shared with other suites.
 */
export function storedVerticalCopyContractSuite(
  adapterName: string,
  makeFixture: () => Promise<ScopeHostFixture>,
  exec: DirectoryExec,
): void {
  describe(`a stored vertical that is not a slug is copied as stored: ${adapterName}`, () => {
    let fixture: ScopeHostFixture;
    let host: ScopeHost;
    const staff = platformActorId.parse(ulid());
    const t = tenantId.parse(ulid());
    /** Values the `scope` schema reads (non-empty) that the registry grammar does not admit. */
    const STORED = ['Todo', 'my_vertical', 'a/b/c', ' spaced '];
    const written: ScopeId[] = [];

    /** An active scope whose row stores `vertical` as given. Every value is a literal of this suite. */
    const storedWith = async (vertical: string): Promise<ScopeId> => {
      const s = scopeId.parse(ulid());
      await host.provisionScope(staff, { tenantId: t, scopeId: s, vertical: 'todo' });
      await host.admin.activateScope(staff, t, s);
      await exec(host, `UPDATE scopes SET vertical = '${vertical}' WHERE scope_id = '${s}'`);
      written.push(s);
      return s;
    };

    beforeAll(async () => {
      fixture = await makeFixture();
      host = fixture.host;
      await host.admin.createTenant(staff, { id: t, slug: `stored-vertical-${t.slice(-10).toLowerCase()}`, name: 'Stored vertical' });
    });

    afterAll(async () => {
      for (const s of written) await exec(host, `UPDATE scopes SET vertical = 'todo' WHERE scope_id = '${s}'`);
      await fixture.cleanup();
    });

    it.each(STORED)('snapshots a scope storing %j, and the snapshot carries it', async (vertical) => {
      const source = await storedWith(vertical);
      const snap = await host.snapshotScope(staff, t, source);
      written.push(snap);
      expect(await host.admin.getScopeRecord(staff, t, snap)).toMatchObject({ forkedFrom: source, vertical });
    });

    it.each(STORED)('provisions %j given as a copy', async (vertical) => {
      const s = scopeId.parse(ulid());
      await host.provisionScope(staff, { tenantId: t, scopeId: s, vertical, verticalSource: 'copy' });
      written.push(s);
      expect((await host.admin.getScopeRecord(staff, t, s))?.vertical).toBe(vertical);
    });

    it.each([...STORED.map((v) => [v, undefined] as const), ...STORED.map((v) => [v, 'input'] as const)])(
      'refuses %j named by a caller (source %s)',
      async (vertical, verticalSource) => {
        const s = scopeId.parse(ulid());
        await expectRefusal(
          host.provisionScope(staff, { tenantId: t, scopeId: s, vertical, ...(verticalSource ? { verticalSource } : {}) }),
          'validation_failed',
          /^provisionScope: vertical /,
        );
        expect(await host.admin.getScopeRecord(staff, t, s)).toBeUndefined();
      },
    );

    it('refuses an empty vertical even as a copy', async () => {
      const s = scopeId.parse(ulid());
      await expectRefusal(host.provisionScope(staff, { tenantId: t, scopeId: s, vertical: '', verticalSource: 'copy' }), 'validation_failed', /^provisionScope: vertical /);
      expect(await host.admin.getScopeRecord(staff, t, s)).toBeUndefined();
    });
  });
}
