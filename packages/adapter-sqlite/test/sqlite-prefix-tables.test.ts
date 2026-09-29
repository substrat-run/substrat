import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { platformActorId, scopeId, tenantId, type ScopeDumpTable } from '@substrat-run/contracts';
import { ulid, webCryptoSecretBox } from '@substrat-run/kernel';
import { SqliteScopeHost } from '../src/index.js';

/**
 * #1881: the reserved-prefix filter was `NOT LIKE 'sqlite_%'`, where `_` is a wildcard, so a
 * vertical table named `sqlitedata` fell out of the export AND out of the restore's drop sweep.
 * The twin: SQLite's own `sqlite_*` tables (here `sqlite_sequence`, born of AUTOINCREMENT)
 * stay out of a dump — they cannot be replayed.
 */
const table = (name: string, rows: unknown[][]): ScopeDumpTable => ({
  name,
  ddl: `CREATE TABLE ${name} (id INTEGER PRIMARY KEY, v TEXT)`,
  columns: ['id', 'v'],
  rows,
});
const SQLITEDATA = table('sqlitedata', [[1, 'a'], [2, 'b']]);
const SQLITEX = table('sqliteX', [[1, 'x']]);
const ours = (tables: ScopeDumpTable[]) => tables.filter((t) => /^sqlite/i.test(t.name));

const setup = async () => {
  const dir = mkdtempSync(join(tmpdir(), 'substrat-sqlite-prefix-'));
  const host = new SqliteScopeHost({ dir, secretBox: webCryptoSecretBox('test-key', new Uint8Array(32).fill(7)) });
  const staff = platformActorId.parse(ulid());
  const t = tenantId.parse(ulid());
  const s = scopeId.parse(ulid());
  await host.admin.createTenant(staff, { id: t, slug: `prefix-${t.slice(-10).toLowerCase()}`, name: 'Prefix' });
  await host.provisionScope(staff, { tenantId: t, scopeId: s });
  const done = async () => {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return { host, staff, t, s, done };
};

describe('tables named like the sqlite_ prefix (#1881)', () => {
  it('round-trip export → restore → export byte for byte, and a restore without them drops them', async () => {
    const { host, staff, t, s, done } = await setup();
    try {
      const base = await host.admin.exportScope(staff, t, s);
      const planted = [SQLITEDATA, SQLITEX];
      await host.restoreScope(staff, t, s, { ...base, tables: [...base.tables, ...planted] });
      const first = await host.admin.exportScope(staff, t, s);
      expect(ours(first.tables).map((x) => x.name).sort()).toEqual(['sqliteX', 'sqlitedata']);
      await host.restoreScope(staff, t, s, first);
      const second = await host.admin.exportScope(staff, t, s);
      expect(JSON.stringify(second.tables)).toBe(JSON.stringify(first.tables));
      expect(ours(second.tables).find((x) => x.name === 'sqlitedata')?.rows).toEqual(SQLITEDATA.rows);
      // The drop sweep: restoring a dump that lacks them must replace, not keep, the old copies.
      await host.restoreScope(staff, t, s, base);
      expect(ours((await host.admin.exportScope(staff, t, s)).tables)).toEqual([]);
    } finally {
      await done();
    }
  });

  it('twin: a real sqlite_* internal table (sqlite_sequence) is still left out of the dump', async () => {
    const { host, staff, t, s, done } = await setup();
    try {
      const base = await host.admin.exportScope(staff, t, s);
      const auto: ScopeDumpTable = {
        name: 'sqlitecounter',
        ddl: 'CREATE TABLE sqlitecounter (id INTEGER PRIMARY KEY AUTOINCREMENT, v TEXT)',
        columns: ['id', 'v'],
        rows: [[1, 'a']],
      };
      await host.restoreScope(staff, t, s, { ...base, tables: [...base.tables, auto] });
      const names = (await host.admin.exportScope(staff, t, s)).tables.map((x) => x.name);
      expect(names).toContain('sqlitecounter');
      expect(names).not.toContain('sqlite_sequence');
    } finally {
      await done();
    }
  });

  it('the directory dump: same filter, same round trip', async () => {
    const { host, staff, done } = await setup();
    try {
      const base = await host.admin.exportDirectory(staff);
      await host.admin.restoreDirectory(staff, { ...base, tables: [...base.tables, SQLITEDATA] });
      const withIt = await host.admin.exportDirectory(staff);
      expect(withIt.tables.map((x) => x.name)).toContain('sqlitedata');
      expect(withIt.tables.map((x) => x.name)).not.toContain('sqlite_sequence');
      await host.admin.restoreDirectory(staff, base);
      expect((await host.admin.exportDirectory(staff)).tables.map((x) => x.name)).not.toContain('sqlitedata');
    } finally {
      await done();
    }
  });
});
