import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { platformActorId, type DirectoryDump } from '@substrat-run/contracts';
import { ulid } from '@substrat-run/kernel';
import { SqliteScopeHost } from '../src/index.js';

/**
 * #1764 on the pure adapter: a directory from before the split, opened by this code.
 *
 * Its `vertical_versions` has neither new column and there is no migrations table, and each
 * manifest carries its SQL. Opening it must add the columns BEFORE the DDL that indexes one
 * of them, then move every version's SQL out of its manifest. A restore of a dump taken
 * before that lands the old shape again, and is moved again.
 */
describe('a directory from before #1764, opened by this code', () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  const staff = platformActorId.parse('01JZ00000000000000000000ST');
  const migrations = [
    { moduleId: 'helpdesk', version: '0001-init', sql: 'CREATE TABLE a (id TEXT);' },
    { moduleId: 'helpdesk', version: '0002-more', sql: 'ALTER TABLE a ADD COLUMN b TEXT;' },
  ];
  const manifests: Record<string, Record<string, unknown>> = {
    carried: { version: '1.0.0', entry: 'i.js', migrations },
    none: { version: '1.0.1', entry: 'i.js', migrations: [] },
    older: { version: '1.0.2', entry: 'i.js' },
  };
  const ids: Record<string, string> = { carried: ulid(), none: ulid(), older: ulid() };
  const want: Record<string, unknown> = { carried: migrations, none: [], older: null };

  /** A directory as the code before #1764 left it, and a dump of it taken then. */
  const plant = async (): Promise<DirectoryDump> => {
    dir = mkdtempSync(join(tmpdir(), 'version-migrations-'));
    const host = new SqliteScopeHost({ dir });
    await host.admin.registerVertical(staff, { slug: 'acme', name: 'Acme', source: 'builtin' });
    for (const [key, id] of Object.entries(ids)) {
      await host.admin.publishVersion(staff, {
        id, verticalSlug: 'acme', version: manifests[key]!.version as string, manifestDigest: 'm',
        permissionDigest: 'p', migrationDigest: 'g', deploymentRef: null,
      });
    }
    await host.close();
    const db = new Database(join(dir, '_directory.sqlite'));
    db.exec(`DROP INDEX vertical_versions_unsplit;
             DROP TABLE vertical_version_migrations;
             ALTER TABLE vertical_versions DROP COLUMN migration_count;
             ALTER TABLE vertical_versions DROP COLUMN migrations_split;`);
    const put = db.prepare('UPDATE vertical_versions SET manifest_json = ? WHERE id = ?');
    for (const [key, id] of Object.entries(ids)) put.run(JSON.stringify(manifests[key]), id);
    // The dump `exportDirectory` would have taken then: every table, DDL from sqlite_master.
    const defs = db
      .prepare(`SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND sql IS NOT NULL`)
      .all() as { name: string; sql: string }[];
    const tables = defs.map(({ name, sql }) => {
      const stmt = db.prepare(`SELECT * FROM "${name}"`).raw(true);
      return { name, ddl: sql, rows: stmt.all() as unknown[][], columns: stmt.columns().map((c) => c.name) };
    });
    db.close();
    return { capturedAt: new Date().toISOString(), tables };
  };

  const check = async (host: SqliteScopeHost) => {
    for (const [key, id] of Object.entries(ids)) {
      expect(await host.admin.versionMigrations(staff, 'acme', id)).toEqual(want[key]);
      const stored = JSON.parse((await host.admin.versionManifest(staff, 'acme', id))!);
      expect(stored).not.toHaveProperty('migrations');
    }
    const db = new Database(join(dir!, '_directory.sqlite'), { readonly: true });
    const left = db.prepare('SELECT COUNT(*) AS n FROM vertical_versions WHERE migrations_split IS NULL').get();
    db.close();
    expect(left).toEqual({ n: 0 });
  };

  it('opens, and every version reads its migrations from the table with a manifest that no longer carries them', async () => {
    await plant();
    const host = new SqliteScopeHost({ dir: dir! });
    await check(host);
    await host.close();
  });

  it('a restore of a dump taken before the split is split again', async () => {
    const before = await plant();
    const host = new SqliteScopeHost({ dir: dir! });
    await host.admin.restoreDirectory(staff, before);
    await check(host);
    await host.close();
  });
});
