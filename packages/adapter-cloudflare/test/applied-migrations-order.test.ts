/**
 * The applied-migrations read on a real Durable Object, past twice the cap it once had (#2553).
 * The ScopeDO's module set is fixed at code time, so a 260-migration module would be migrated by
 * every scope in the kit; this plants the journal rows on ONE scope instead, all stamped with the
 * same instant, which is what a pass on a clock that holds still writes.
 */
import { env, runInDurableObject } from 'cloudflare:test';
import { beforeAll, expect, it } from 'vitest';
import { platformActorId, principalId, scopeId, tenantId } from '@substrat-run/contracts';
import { OVER_CAP_MIGRATIONS_VERSIONS, listMod } from '@substrat-run/contract-tests';
import { ulid, UNSAFE_allowAllChecker, webCryptoSecretBox } from '@substrat-run/kernel';
import { CloudflareScopeHost } from './test-host.js';
import { warmControlPlane } from './do-warmup.js';

beforeAll(() => warmControlPlane(env.CONTROL_PLANE));

it('answers all 260 journal rows, the one written last first, whatever instant they share (#2553)', async () => {
  const host = new CloudflareScopeHost({
    scope: env.SCOPE,
    controlPlane: env.CONTROL_PLANE,
    secretBox: webCryptoSecretBox('test-key', new Uint8Array(32).fill(7)),
    checker: UNSAFE_allowAllChecker,
  });
  host.registerModule(listMod);
  const staff = platformActorId.parse(ulid());
  const t = tenantId.parse(ulid());
  const s = scopeId.parse(ulid());
  await host.admin.createTenant(staff, { id: t, slug: `applied-order-${ulid().toLowerCase()}`, name: 'Applied order' });
  await host.admin.grantEntitlement(staff, t, 'list');
  await host.provisionScope(staff, { tenantId: t, scopeId: s, vertical: 'list-vertical' });
  try {
    await host.admin.activateScope(staff, t, s);
    await host.getScope(principalId.parse(ulid()), t, s);
    expect(OVER_CAP_MIGRATIONS_VERSIONS.length).toBeGreaterThan(200);
    // Later than anything the real migrations stamped, so the planted rows lead the list.
    const sharedInstant = '2999-01-01T00:00:00.000Z';
    await runInDurableObject(env.SCOPE.get(env.SCOPE.idFromName(s)), (_instance, state) => {
      for (const version of OVER_CAP_MIGRATIONS_VERSIONS) {
        state.storage.sql.exec(
          'INSERT INTO _substrat_migrations (module_id, version, applied_at, duration_ms, rows_changed, sql_digest) VALUES (?, ?, ?, ?, ?, ?)',
          '@test/planted',
          version,
          sharedInstant,
          0,
          0,
          'f'.repeat(64),
        );
      }
    });
    const applied = await host.admin.scopeAppliedMigrations(staff, t, s);
    // Every planted row, and in the reverse of the order it was written in.
    expect(applied.filter((m) => m.moduleId === '@test/planted').map((m) => m.version)).toEqual(
      [...OVER_CAP_MIGRATIONS_VERSIONS].reverse(),
    );
    // Nothing the real migrations wrote went missing behind them.
    expect(applied.length).toBeGreaterThan(OVER_CAP_MIGRATIONS_VERSIONS.length);
    expect(applied.some((m) => m.moduleId === '@test/list')).toBe(true);
  } finally {
    await host.admin.archiveScope(staff, t, s);
    await host.close();
  }
});
