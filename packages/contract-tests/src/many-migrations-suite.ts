/**
 * Contract suite for the applied-migrations read (#2553): a scope holding more migrations than the
 * read once capped at (100) answers with every one of them, on every adapter. The fixture is
 * `manyMigrationsMod`, which carries more than the cap on its own.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { platformActorId, principalId, scopeId, tenantId } from '@substrat-run/contracts';
import { ulid, type ScopeHost } from '@substrat-run/kernel';
import type { ScopeHostFixture } from './scope-host-suite.js';
import { MANY_MIGRATIONS_MODULE_ID, MANY_MIGRATIONS_VERSIONS, manyMigrationsMod } from './many-migrations.js';

export function manyMigrationsContractSuite(adapterName: string, makeFixture: () => Promise<ScopeHostFixture>): void {
  describe(`applied migrations past 100 rows (#2553): ${adapterName}`, () => {
    let fixture: ScopeHostFixture;
    let host: ScopeHost;
    const t = tenantId.parse(ulid());
    const s = scopeId.parse(ulid());
    const staff = platformActorId.parse(ulid());

    beforeAll(async () => {
      fixture = await makeFixture();
      host = fixture.host;
      host.registerModule(manyMigrationsMod);
      await host.admin.createTenant(staff, { id: t, slug: `mm-${t.toLowerCase()}`, name: 'Many migrations' });
      await host.admin.grantEntitlement(staff, t, 'many-migrations');
      await host.provisionScope(staff, { tenantId: t, scopeId: s, vertical: 'many-migrations' });
      await host.admin.activateScope(staff, t, s);
      await host.getScope(principalId.parse(ulid()), t, s);
    });
    afterAll(async () => {
      await fixture.cleanup();
    });

    it('reads back every migration a scope applied, not the first hundred', async () => {
      const applied = await host.admin.scopeAppliedMigrations(staff, t, s);
      // The twin of the fixture's own count: the list is longer than the old cap, and nothing is missing.
      expect(MANY_MIGRATIONS_VERSIONS.length).toBeGreaterThan(100);
      expect(applied.length).toBeGreaterThan(100);
      const mine = applied.filter((m) => m.moduleId === MANY_MIGRATIONS_MODULE_ID);
      expect(mine.map((m) => m.version).sort()).toEqual([...MANY_MIGRATIONS_VERSIONS].sort());
      // Each row is a whole record, the first migration as much as the last.
      for (const m of mine) {
        expect(Number.isNaN(Date.parse(m.appliedAt ?? ''))).toBe(false);
        expect(m.durationMs).toEqual(expect.any(Number));
      }
      // Still newest first end to end, so a caller renders a history without re-sorting it.
      const stamped = applied.filter((m) => m.appliedAt !== null).map((m) => m.appliedAt!);
      expect([...stamped].sort((a, b) => (a < b ? 1 : a > b ? -1 : 0))).toEqual(stamped);
    });
  });
}
