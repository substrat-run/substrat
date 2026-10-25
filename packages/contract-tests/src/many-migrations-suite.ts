/**
 * Contract suite for the applied-migrations read (#2553): a scope holding more migrations than the
 * read once capped at (100) answers with every one of them, on every adapter. The fixture is
 * `manyMigrationsMod`, which carries more than the cap on its own.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { platformActorId, principalId, scopeId, tenantId } from '@substrat-run/contracts';
import { ulid, type ModuleRegistration, type ScopeHost } from '@substrat-run/kernel';
import type { ScopeHostFixture } from './scope-host-suite.js';
import {
  MANY_MIGRATIONS_MODULE_ID,
  MANY_MIGRATIONS_VERSIONS,
  OVER_CAP_MIGRATIONS_MODULE_ID,
  OVER_CAP_MIGRATIONS_VERSIONS,
  manyMigrationsMod,
  overCapMigrationsMod,
} from './many-migrations.js';

/** One host, one tenant, one provisioned and migrated scope carrying `mod`. */
function scopeWith(mod: ModuleRegistration, vertical: string, makeFixture: () => Promise<ScopeHostFixture>) {
  const t = tenantId.parse(ulid());
  const s = scopeId.parse(ulid());
  const staff = platformActorId.parse(ulid());
  const state = {} as { fixture: ScopeHostFixture; host: ScopeHost };
  const setup = async () => {
    state.fixture = await makeFixture();
    state.host = state.fixture.host;
    state.host.registerModule(mod);
    await state.host.admin.createTenant(staff, { id: t, slug: `mm-${t.toLowerCase()}`, name: 'Many migrations' });
    await state.host.admin.grantEntitlement(staff, t, vertical);
    await state.host.provisionScope(staff, { tenantId: t, scopeId: s, vertical });
    await state.host.admin.activateScope(staff, t, s);
    await state.host.getScope(principalId.parse(ulid()), t, s);
  };
  const applied = () => state.host.admin.scopeAppliedMigrations(staff, t, s);
  return { state, setup, applied };
}

export function manyMigrationsContractSuite(adapterName: string, makeFixture: () => Promise<ScopeHostFixture>): void {
  describe(`applied migrations past 100 rows (#2553): ${adapterName}`, () => {
    const scope = scopeWith(manyMigrationsMod, 'many-migrations', makeFixture);
    beforeAll(scope.setup);
    afterAll(async () => {
      await scope.state.fixture.cleanup();
    });

    it('reads back every migration a scope applied, not the first hundred', async () => {
      const applied = await scope.applied();
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

/**
 * The same read past twice the old cap, newest first (#2553), for a host that can carry
 * `overCapMigrationsMod` without every other scope in the kit migrating it too. The pure host can;
 * the Durable-Object host's module set is fixed at code time, so its own suite plants the rows.
 */
export function overCapMigrationsContractSuite(adapterName: string, makeFixture: () => Promise<ScopeHostFixture>): void {
  describe(`applied migrations past 200 rows, newest first (#2553): ${adapterName}`, () => {
    const scope = scopeWith(overCapMigrationsMod, 'over-cap-migrations', makeFixture);
    beforeAll(scope.setup);
    afterAll(async () => {
      await scope.state.fixture.cleanup();
    });

    it('answers every one of 260 migrations, last applied first', async () => {
      expect(OVER_CAP_MIGRATIONS_VERSIONS.length).toBeGreaterThan(200);
      const mine = (await scope.applied()).filter((m) => m.moduleId === OVER_CAP_MIGRATIONS_MODULE_ID);
      // The exact reverse of the order they ran in. The stamps alone cannot say it: a pass stamps
      // each migration with its own clock read, so neighbours share a millisecond (every one of them
      // does where the clock holds still), and only the order they were written in tells which came last.
      expect(mine.map((m) => m.version)).toEqual([...OVER_CAP_MIGRATIONS_VERSIONS].reverse());
    });
  });
}
