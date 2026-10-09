import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { expect, it } from 'vitest';
import { moduleId, platformActorId, scopeId, tenantId } from '@substrat-run/contracts';
import { permMod } from '@substrat-run/contract-tests';
import { ulid, webCryptoSecretBox } from '@substrat-run/kernel';
import { SqliteScopeHost } from '../src/index.js';

it('upgrades old capability rows to no attachment opt-in and tolerates a second wake (#2126)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'substrat-cap-attachments-'));
  const secretBox = webCryptoSecretBox('test-key', new Uint8Array(32).fill(7));
  const t = tenantId.parse(ulid());
  const s = scopeId.parse(ulid());
  const staff = platformActorId.parse(ulid());
  const open = () => {
    const h = new SqliteScopeHost({ dir, secretBox });
    h.registerModule(permMod);
    h.registerJob(moduleId.parse('@test/perm'), 'walk', () => ({ done: true }));
    return h;
  };
  let host = open();
  try {
    await host.admin.createTenant(staff, { id: t, slug: `cap-upgrade-${ulid().toLowerCase()}`, name: 'Capability upgrade' });
    await host.admin.grantEntitlement(staff, t, 'perm');
    await host.provisionScope(staff, { tenantId: t, scopeId: s, vertical: 'perm-vertical' });
    await host.admin.activateScope(staff, t, s);
    await host.startJobRun(t, s, { moduleId: moduleId.parse('@test/perm'), job: 'walk' });
    await host.close();

    const db = new Database(join(dir, `${t}__${s}.sqlite`));
    try {
      db.exec('ALTER TABLE _substrat_capabilities DROP COLUMN attachments');
      db.prepare(`INSERT INTO _substrat_capabilities
        (id, token_hash, mode, entity_type, entity_id, permissions, operations, minted_by, minted_at)
        VALUES (?, ?, 'act', 'doc', 'legacy', '["cap:read"]', '["attachments.read"]', '"legacy"', '2026-01-01T00:00:00.000Z')`)
        .run(ulid(), 'a'.repeat(64));
    } finally { db.close(); }

    // The first reopened host adds the nullable field; closing and waking it again proves
    // ensureColumn treats the already-upgraded table as a no-op.
    host = open();
    await host.startJobRun(t, s, { moduleId: moduleId.parse('@test/perm'), job: 'walk', instance: 'upgrade-1' });
    await host.close();
    host = open();
    await host.startJobRun(t, s, { moduleId: moduleId.parse('@test/perm'), job: 'walk', instance: 'upgrade-2' });
    const upgraded = new Database(join(dir, `${t}__${s}.sqlite`), { readonly: true });
    try {
      expect(upgraded.prepare("SELECT name FROM pragma_table_info('_substrat_capabilities')").all()).toContainEqual({ name: 'attachments' });
      expect(upgraded.prepare('SELECT operations, attachments FROM _substrat_capabilities').get()).toEqual({
        operations: '["attachments.read"]', attachments: null,
      });
    } finally { upgraded.close(); }
  } finally {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
