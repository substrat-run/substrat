import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { moduleId } from '@substrat-run/contracts';
import {
  VERSION_MIGRATIONS_DDL,
  splitManifestMigrations,
  splitVersionMigrationsBatch,
  versionMigrationsOf,
  versionsAwaitSplit,
  writeVersionMigrations,
  type SwitchSql,
} from '../src/index.js';

/**
 * #1764: a version's SQL migrations, stored apart from its manifest, executed against a real
 * SQLite. Each adapter runs these same functions over its own directory; the scope-host
 * contract suite and the workerd backfill test hold the two to them end to end.
 */
describe('version migrations stored apart (#1764)', () => {
  const fresh = (): { db: DatabaseSync; sql: SwitchSql } => {
    const db = new DatabaseSync(':memory:');
    db.exec(`CREATE TABLE vertical_versions (
      id TEXT PRIMARY KEY, vertical_slug TEXT NOT NULL, manifest_json TEXT,
      migration_count INTEGER, migrations_split INTEGER
    )`);
    db.exec(VERSION_MIGRATIONS_DDL);
    const sql: SwitchSql = {
      all: (q, ...p) => db.prepare(q).all(...p) as Record<string, unknown>[],
      run: (q, ...p) => {
        db.prepare(q).run(...p);
      },
    };
    return { db, sql };
  };
  /** A version stored before #1764: its manifest as it came, not yet split. */
  const legacy = (sql: SwitchSql, id: string, manifestJson: string | null) =>
    sql.run('INSERT INTO vertical_versions (id, vertical_slug, manifest_json) VALUES (?, ?, ?)', id, 'acme', manifestJson);

  const helpdesk = moduleId.parse('helpdesk');
  const migrations = [
    { moduleId: helpdesk, version: '0001-init', sql: 'CREATE TABLE a (id TEXT);' },
    { moduleId: helpdesk, version: '0002-more', sql: 'ALTER TABLE a ADD COLUMN b TEXT;' },
  ];
  const manifest = (extra: Record<string, unknown> = {}) => JSON.stringify({ version: '1.0.0', entry: 'i.js', ...extra });

  describe('splitManifestMigrations', () => {
    it('takes the field out and hands back the rest of the manifest', () => {
      const split = splitManifestMigrations(manifest({ migrations }), 'push');
      expect(split.migrations).toEqual(migrations);
      expect(JSON.parse(split.manifestJson!)).toEqual({ version: '1.0.0', entry: 'i.js' });
    });

    it('`[]` is none; an absent field is not available, and that manifest is left byte for byte', () => {
      expect(splitManifestMigrations(manifest({ migrations: [] }), 'push').migrations).toEqual([]);
      const older = ' {"version":"1.0.0"} ';
      expect(splitManifestMigrations(older, 'push')).toEqual({ manifestJson: older, migrations: null });
      expect(splitManifestMigrations(null, 'push')).toEqual({ manifestJson: null, migrations: null });
      expect(splitManifestMigrations('not json', 'push')).toEqual({ manifestJson: 'not json', migrations: null });
      expect(splitManifestMigrations('[1]', 'push')).toEqual({ manifestJson: '[1]', migrations: null });
    });

    it('a push over the caps, or not shaped like migrations, is dropped from the manifest AND reads as not available', () => {
      const over = [{ moduleId: 'helpdesk', version: '0001', sql: 'x'.repeat(512 * 1024 + 1) }];
      for (const bad of [over, 'nope', null, [{ moduleId: 'helpdesk' }]]) {
        const split = splitManifestMigrations(manifest({ migrations: bad }), 'push');
        expect(split.migrations).toBeNull();
        expect(JSON.parse(split.manifestJson!)).not.toHaveProperty('migrations');
      }
      // At the cap exactly, it is kept.
      const at = [{ moduleId: 'helpdesk', version: '0001', sql: 'x'.repeat(512 * 1024) }];
      expect(splitManifestMigrations(manifest({ migrations: at }), 'push').migrations).toEqual(at);
    });

    it('stored history is read without the push caps, so lowering one never hides SQL already stored', () => {
      const over = [{ moduleId: 'helpdesk', version: '0001', sql: 'x'.repeat(512 * 1024 + 1) }];
      expect(splitManifestMigrations(manifest({ migrations: over }), 'stored').migrations).toEqual(over);
    });
  });

  describe('versionMigrationsOf', () => {
    it('reads the rows in order once split, and null when the count disagrees with them', () => {
      const { sql } = fresh();
      sql.run("INSERT INTO vertical_versions (id, vertical_slug, migration_count, migrations_split) VALUES ('v1', 'acme', 2, 1)");
      writeVersionMigrations(sql, 'v1', [...migrations].reverse());
      expect(versionMigrationsOf(sql, 'v1')).toEqual({ verticalSlug: 'acme', migrations: [...migrations].reverse() });
      // A lost row must never read as a shorter set.
      sql.run("DELETE FROM vertical_version_migrations WHERE version_id = 'v1' AND ordinal = 1");
      expect(versionMigrationsOf(sql, 'v1')).toEqual({ verticalSlug: 'acme', migrations: null });
      expect(versionMigrationsOf(sql, 'nope')).toBeUndefined();
    });

    it('split with no SQL carried reads as not available; split with none reads as none', () => {
      const { sql } = fresh();
      sql.run("INSERT INTO vertical_versions (id, vertical_slug, migration_count, migrations_split) VALUES ('a', 'acme', NULL, 1)");
      sql.run("INSERT INTO vertical_versions (id, vertical_slug, migration_count, migrations_split) VALUES ('n', 'acme', 0, 1)");
      // A stray row under a version that carried none does not make it look carried.
      writeVersionMigrations(sql, 'x', migrations);
      sql.run("UPDATE vertical_version_migrations SET version_id = 'a'");
      expect(versionMigrationsOf(sql, 'a')?.migrations).toBeNull();
      expect(versionMigrationsOf(sql, 'n')?.migrations).toEqual([]);
    });

    it('a version the backfill has not reached reads from its manifest', () => {
      const { sql } = fresh();
      legacy(sql, 'carried', manifest({ migrations }));
      legacy(sql, 'none', manifest({ migrations: [] }));
      legacy(sql, 'older', manifest());
      legacy(sql, 'bare', null);
      expect(versionMigrationsOf(sql, 'carried')?.migrations).toEqual(migrations);
      expect(versionMigrationsOf(sql, 'none')?.migrations).toEqual([]);
      expect(versionMigrationsOf(sql, 'older')?.migrations).toBeNull();
      expect(versionMigrationsOf(sql, 'bare')?.migrations).toBeNull();
    });
  });

  describe('splitVersionMigrationsBatch', () => {
    const seed = (sql: SwitchSql, n: number) => {
      const ids = Array.from({ length: n }, (_, i) => `v${String(i).padStart(3, '0')}`);
      ids.forEach((id, i) => {
        // Every fourth one was pushed before migrations were carried, and one ships none.
        const extra = i % 4 === 3 ? {} : i === 0 ? { migrations: [] } : { migrations };
        legacy(sql, id, manifest(extra));
      });
      return ids;
    };
    const expected = (i: number) => (i % 4 === 3 ? null : i === 0 ? [] : migrations);

    it('moves a bounded batch per call, reads stay right before, during and after, and it ends', () => {
      const { sql } = fresh();
      const ids = seed(sql, 12);
      const reads = () => ids.map((id) => versionMigrationsOf(sql, id)?.migrations);
      const want = ids.map((_, i) => expected(i));
      expect(reads()).toEqual(want);

      expect(splitVersionMigrationsBatch(sql, 5)).toEqual({ moved: 5, more: true });
      expect(reads()).toEqual(want);
      expect(versionsAwaitSplit(sql)).toBe(true);
      expect(splitVersionMigrationsBatch(sql, 5)).toEqual({ moved: 5, more: true });
      expect(splitVersionMigrationsBatch(sql, 5)).toEqual({ moved: 2, more: false });
      expect(reads()).toEqual(want);
      expect(versionsAwaitSplit(sql)).toBe(false);
      expect(splitVersionMigrationsBatch(sql, 5)).toEqual({ moved: 0, more: false });

      // Every manifest is out of the SQL business, and the counts say which carried none.
      const rows = sql.all('SELECT id, manifest_json, migration_count FROM vertical_versions ORDER BY id') as {
        manifest_json: string;
        migration_count: number | null;
      }[];
      for (const [i, r] of rows.entries()) {
        expect(JSON.parse(r.manifest_json)).not.toHaveProperty('migrations');
        expect(r.migration_count).toBe(expected(i)?.length ?? null);
      }
    });

    it('a version put back unsplit, as a restore of an older dump does, is moved again to the same answer', () => {
      const { sql } = fresh();
      const ids = seed(sql, 4);
      while (splitVersionMigrationsBatch(sql, 3).more);
      // The dump predates the backfill: its manifest carries the SQL, and its rows are stale.
      sql.run(`UPDATE vertical_versions SET migrations_split = NULL, migration_count = NULL, manifest_json = ? WHERE id = ?`,
        manifest({ migrations: migrations.slice(0, 1) }), ids[1]!);
      expect(versionMigrationsOf(sql, ids[1]!)?.migrations).toEqual(migrations.slice(0, 1));
      while (splitVersionMigrationsBatch(sql, 3).more);
      expect(versionMigrationsOf(sql, ids[1]!)?.migrations).toEqual(migrations.slice(0, 1));
      expect(sql.all(`SELECT COUNT(*) AS n FROM vertical_version_migrations WHERE version_id = ?`, ids[1]!)).toEqual([{ n: 1 }]);
    });

    it('finds the versions left through the partial index, not a scan of every manifest', () => {
      const { sql } = fresh();
      seed(sql, 3);
      const plan = sql.all(
        'EXPLAIN QUERY PLAN SELECT id, manifest_json FROM vertical_versions WHERE migrations_split IS NULL ORDER BY id LIMIT 26',
      ) as { detail: string }[];
      expect(plan.map((p) => p.detail).join(' ')).toMatch(/vertical_versions_unsplit/);
    });
  });
});
