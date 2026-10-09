import { env, runInDurableObject } from 'cloudflare:test';
import { beforeAll, expect, it } from 'vitest';
import { moduleId, platformActorId, scopeId, tenantId } from '@substrat-run/contracts';
import { permMod } from '@substrat-run/contract-tests';
import { ulid, UNSAFE_allowAllChecker, webCryptoSecretBox } from '@substrat-run/kernel';
import { CloudflareScopeHost } from '../src/host.js';
import { warmControlPlane } from './do-warmup.js';

beforeAll(() => warmControlPlane(env.CONTROL_PLANE));

it('upgrades old capability rows to no attachment opt-in and tolerates a second wake (#2126)', async () => {
  const host = new CloudflareScopeHost({
    scope: env.SCOPE, controlPlane: env.CONTROL_PLANE,
    secretBox: webCryptoSecretBox('test-key', new Uint8Array(32).fill(7)), checker: UNSAFE_allowAllChecker,
  });
  host.registerModule(permMod);
  host.registerJob(moduleId.parse('@test/perm'), 'walk', () => ({ done: true }));
  const staff = platformActorId.parse(ulid());
  const t = tenantId.parse(ulid());
  const s = scopeId.parse(ulid());
  await host.admin.createTenant(staff, { id: t, slug: `cap-upgrade-${ulid().toLowerCase()}`, name: 'Capability upgrade' });
  await host.admin.grantEntitlement(staff, t, 'perm');
  await host.provisionScope(staff, { tenantId: t, scopeId: s, vertical: 'perm-vertical' });
  try {
    await host.admin.activateScope(staff, t, s);
    await host.startJobRun(t, s, { moduleId: moduleId.parse('@test/perm'), job: 'walk' });
    const freshStub = () => env.SCOPE.get(env.SCOPE.idFromName(s));
    const readLegacy = () => runInDurableObject(freshStub(), (_instance, state) => {
      state.storage.sql.exec('ALTER TABLE _substrat_capabilities DROP COLUMN attachments');
      state.storage.sql.exec(`INSERT INTO _substrat_capabilities
        (id, token_hash, mode, entity_type, entity_id, permissions, operations, minted_by, minted_at)
        VALUES (?, ?, 'act', 'doc', 'legacy', '["cap:read"]', '["attachments.read"]', '"legacy"', '2026-01-01T00:00:00.000Z')`,
      ulid(), 'a'.repeat(64));
    });
    await readLegacy();
    const abortToWake = async () => runInDurableObject(freshStub(), (_instance, state) => {
      state.abort('wake capability attachment column upgrade');
    }).catch(() => undefined);
    const inspect = () => runInDurableObject(freshStub(), (_instance, state) => ({
      columns: state.storage.sql.exec("SELECT name FROM pragma_table_info('_substrat_capabilities')").toArray(),
      row: state.storage.sql.exec('SELECT operations, attachments FROM _substrat_capabilities').toArray()[0],
    }));
    await abortToWake();
    expect(await inspect()).toMatchObject({
      columns: expect.arrayContaining([{ name: 'attachments' }]),
      row: { operations: '["attachments.read"]', attachments: null },
    });
    await abortToWake();
    expect(await inspect()).toMatchObject({
      columns: expect.arrayContaining([{ name: 'attachments' }]),
      row: { operations: '["attachments.read"]', attachments: null },
    });
  } finally {
    await host.admin.archiveScope(staff, t, s);
  }
});
