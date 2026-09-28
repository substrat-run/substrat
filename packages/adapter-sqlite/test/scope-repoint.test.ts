import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { platformActorId, scopeId, tenantId } from '@substrat-run/contracts';
import { ulid, webCryptoSecretBox } from '@substrat-run/kernel';
import { scopeRepointContractSuite } from '@substrat-run/contract-tests';
import Database from 'better-sqlite3';
import { DO_SCOPE_ONLY_SPINE_TABLES, SqliteScopeHost } from '../src/index.js';
// @ts-expect-error — a plain .mjs tool with no declarations; the same extraction lint:spine-ddl runs.
import { scopeOneSidedTables } from '../../../tools/spine-ddl-drift.mjs';

// #1869, on the DEFAULT checker so the suite can assert decisions as well as rows.
scopeRepointContractSuite('adapter-sqlite', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'substrat-repoint-'));
  const host = new SqliteScopeHost({ dir, secretBox: webCryptoSecretBox('test-key', new Uint8Array(32).fill(7)) });
  return {
    host,
    cleanup: async () => {
      await host.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
});

/**
 * #1883: a dump a Durable Object exported, loaded into a node scope. The DO builds spine tables
 * (`_substrat_roles`, `_substrat_tenant_tuples`, …) that a node scope keeps in its directory, or
 * does not keep at all. Those are skipped by name (`DO_SCOPE_ONLY_SPINE_TABLES`); any other spine
 * table this kernel does not build is still refused. The DO's twin, which loads the same tables,
 * is in `adapter-cloudflare/test/scope-repoint.test.ts`.
 */
describe('a DO-shaped dump restored into a node scope (#1883)', () => {
  const setup = async () => {
    const dir = mkdtempSync(join(tmpdir(), 'substrat-do-dump-'));
    const host = new SqliteScopeHost({ dir, secretBox: webCryptoSecretBox('test-key', new Uint8Array(32).fill(7)) });
    const staff = platformActorId.parse(ulid());
    const t = tenantId.parse(ulid());
    const s = scopeId.parse(ulid());
    await host.admin.createTenant(staff, { id: t, slug: `do-dump-${t.slice(-10).toLowerCase()}`, name: 'DO dump' });
    await host.provisionScope(staff, { tenantId: t, scopeId: s });
    const done = async () => {
      await host.close();
      rmSync(dir, { recursive: true, force: true });
    };
    return { dir, host, staff, t, s, done };
  };
  const doOnly = (t: string) => [
    {
      name: '_substrat_roles',
      ddl:
        'CREATE TABLE _substrat_roles (tenant_id TEXT NOT NULL, role_key TEXT NOT NULL, permissions TEXT NOT NULL, ' +
        'source TEXT NOT NULL, revoked_at TEXT, PRIMARY KEY (tenant_id, role_key))',
      columns: ['tenant_id', 'role_key', 'permissions', 'source', 'revoked_at'],
      rows: [[t, 'reader', '["perm:read"]', 'vertical', null]],
    },
    {
      name: '_substrat_meta',
      ddl: 'CREATE TABLE _substrat_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)',
      columns: ['key', 'value'],
      rows: [['permission_source', 'local']],
    },
  ];

  it('the skip list is exactly the spine tables the DO builds in a scope and this adapter does not', () => {
    const { doOnly: fromDdl, nodeOnly } = scopeOneSidedTables();
    expect([...DO_SCOPE_ONLY_SPINE_TABLES].sort()).toEqual(fromDdl);
    // The other direction is empty, so a node dump never meets the same question on a DO.
    expect(nodeOnly).toEqual([]);
  });

  it('lands, with the DO-only tables skipped and everything else loaded', async () => {
    const { host, staff, t, s, done } = await setup();
    try {
      const before = await host.admin.exportScope(staff, t, s);
      await host.restoreScope(staff, t, s, { ...before, tables: [...before.tables, ...doOnly(t)] });
      const after = await host.admin.exportScope(staff, t, s);
      expect(after.tables.map((tb) => tb.name)).not.toContain('_substrat_roles');
      expect(after.tables.map((tb) => tb.name)).not.toContain('_substrat_meta');
      expect(after.tables).toEqual(before.tables);
    } finally {
      await done();
    }
  });

  it('any other spine table this kernel does not build is still refused, named alone, and the scope is kept', async () => {
    const { host, staff, t, s, done } = await setup();
    try {
      const before = await host.admin.exportScope(staff, t, s);
      const unknown = { name: '_substrat_smuggled', ddl: 'CREATE TABLE _substrat_smuggled (id TEXT)', columns: ['id'], rows: [['x']] };
      await expect(
        host.restoreScope(staff, t, s, { ...before, tables: [...before.tables, ...doOnly(t), unknown] }),
      ).rejects.toThrow(/spine table\(s\) this host's kernel does not build: _substrat_smuggled\. It was exported/);
      expect((await host.admin.exportScope(staff, t, s)).tables).toEqual(before.tables);
    } finally {
      await done();
    }
  });
});

/**
 * #1883: a restore keeps a spine column a newer kernel's dump carried, as a plain untyped column
 * spelled as the dump spelled it. When a later kernel then adds that column for real, its
 * additive pass must find it there rather than add it twice, which SQLite refuses and which
 * would leave the scope unable to open. Staged directly: the untyped column a restore adds
 * (lowercased), on the one additive column the kernel still ALTERs in on wake.
 */
describe('a later kernel waking over a column a restore added untyped (#1883)', () => {
  it('opens, keeps the value, and does not add the column twice', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'substrat-untyped-column-'));
    let host = new SqliteScopeHost({ dir, secretBox: webCryptoSecretBox('test-key', new Uint8Array(32).fill(7)) });
    const staff = platformActorId.parse(ulid());
    const t = tenantId.parse(ulid());
    const s = scopeId.parse(ulid());
    try {
      await host.admin.createTenant(staff, { id: t, slug: `untyped-${t.slice(-10).toLowerCase()}`, name: 'Untyped' });
      await host.provisionScope(staff, { tenantId: t, scopeId: s });
      await host.close();

      // The deliveries table as a kernel from before #1525 built it, with `invocation_id` then
      // added by a restore of a newer dump: untyped, and lowercased as a restore adds it.
      const db = new Database(join(dir, `${t}__${s}.sqlite`));
      db.exec('DROP TABLE _substrat_deliveries');
      db.exec(
        'CREATE TABLE _substrat_deliveries (event_id TEXT NOT NULL, consumer_module TEXT NOT NULL, ' +
          'delivered_at TEXT NOT NULL, error TEXT, attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at TEXT, ' +
          'PRIMARY KEY (event_id, consumer_module))',
      );
      db.exec('ALTER TABLE _substrat_deliveries ADD COLUMN "invocation_id"');
      db.prepare('INSERT INTO _substrat_deliveries (event_id, consumer_module, delivered_at, invocation_id) VALUES (?, ?, ?, ?)').run(
        'e1',
        'm1',
        '2026-09-01T00:00:00.000Z',
        'inv-1',
      );
      db.close();

      host = new SqliteScopeHost({ dir, secretBox: webCryptoSecretBox('test-key', new Uint8Array(32).fill(7)) });
      const deliveries = (await host.admin.exportScope(staff, t, s)).tables.find((tb) => tb.name === '_substrat_deliveries')!;
      expect(deliveries.columns.filter((c) => c.toLowerCase() === 'invocation_id')).toEqual(['invocation_id']);
      expect(deliveries.rows).toEqual([['e1', 'm1', '2026-09-01T00:00:00.000Z', null, 0, null, 'inv-1']]);
    } finally {
      await host.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
