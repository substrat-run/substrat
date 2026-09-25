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
import { BATCH_MANIFEST_BYTES, UNSPLIT_IDS_SQL, UNSPLIT_PROBE_SQL } from '../src/version-migrations.js';

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

    it('a batch never passes the manifest bound by one more manifest, and the first always moves', () => {
      const { sql } = fresh();
      // Near-limit manifests: two fit (2 × 0.45 of the bound), the third would pass it.
      const padded = (i: number, share: number) =>
        manifest({ migrations: [{ ...migrations[0]!, version: `000${i}` }], pad: 'x'.repeat(Math.floor(BATCH_MANIFEST_BYTES * share)) });
      for (let i = 0; i < 5; i++) legacy(sql, `v${i}`, padded(i, 0.45));
      const split = () => sql.all('SELECT id FROM vertical_versions WHERE migrations_split = 1 ORDER BY id').map((r) => r.id as string);

      expect(splitVersionMigrationsBatch(sql)).toEqual({ moved: 2, more: true });
      expect(split()).toEqual(['v0', 'v1']);
      expect(splitVersionMigrationsBatch(sql)).toEqual({ moved: 2, more: true });
      expect(splitVersionMigrationsBatch(sql)).toEqual({ moved: 1, more: false });
      // Exactly at the bound is still taken: two manifests summing to it move together.
      const { sql: at } = fresh();
      legacy(at, 'a', 'x'.repeat(BATCH_MANIFEST_BYTES / 2));
      legacy(at, 'b', 'x'.repeat(BATCH_MANIFEST_BYTES / 2));
      legacy(at, 'c', 'x');
      expect(splitVersionMigrationsBatch(at)).toEqual({ moved: 2, more: true });
      // Bytes, not code points: two manifests of four-byte characters, each well under the
      // bound in code points (a quarter of it) but at 0.6 of it in bytes, never share a batch.
      const { sql: wide } = fresh();
      const emoji = '\u{1F600}'.repeat(Math.floor((BATCH_MANIFEST_BYTES * 0.6) / 4));
      legacy(wide, 'w1', emoji);
      legacy(wide, 'w2', emoji);
      const { points, octets } = wide.all(
        "SELECT length(manifest_json) AS points, octet_length(manifest_json) AS octets FROM vertical_versions WHERE id = 'w1'",
      )[0] as { points: number; octets: number };
      expect(2 * points).toBeLessThan(BATCH_MANIFEST_BYTES); // a code-point bound would take both
      expect(2 * octets).toBeGreaterThan(BATCH_MANIFEST_BYTES);
      expect(splitVersionMigrationsBatch(wide)).toEqual({ moved: 1, more: true });
      // A manifest over the bound on its own still moves, alone: the first is always taken.
      const { sql: over } = fresh();
      legacy(over, 'big', 'x'.repeat(BATCH_MANIFEST_BYTES + 1));
      legacy(over, 'next', 'x');
      expect(splitVersionMigrationsBatch(over)).toEqual({ moved: 1, more: true });
    });

    it('the two reads that find unsplit versions are answered from the partial index, not a scan', () => {
      const { sql } = fresh();
      seed(sql, 3);
      for (const [query, params] of [[UNSPLIT_IDS_SQL, [26]], [UNSPLIT_PROBE_SQL, []]] as const) {
        const plan = (sql.all(`EXPLAIN QUERY PLAN ${query}`, ...params) as { detail: string }[]).map((p) => p.detail);
        expect(plan.join(' | ')).toMatch(/USING (COVERING )?INDEX vertical_versions_unsplit/);
        // Answered by the index alone: no scan of the table, and no sort for the ORDER BY.
        expect(plan.join(' | ')).not.toMatch(/SCAN vertical_versions(?! USING)|TEMP B-TREE/);
      }
    });
  });
});
