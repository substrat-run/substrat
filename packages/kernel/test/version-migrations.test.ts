import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { migrationDigestOf, moduleId, unheldMigrationDigest } from '@substrat-run/contracts';
import {
  VERSION_MIGRATIONS_DDL,
  MIGRATION_DIGEST_MISMATCH_REASON,
  deriveMigrationDigestsBatch,
  deriveVersionMigrationDigest,
  publishedMigrationDigest,
  versionsAwaitDigest,
  splitManifestMigrations,
  splitVersionMigrationsBatch,
  versionMigrationsOf,
  versionsAwaitSplit,
  writeVersionMigrations,
  type SwitchSql,
} from '../src/index.js';
import {
  BATCH_MANIFEST_BYTES,
  UNDERIVED_IDS_SQL,
  UNDERIVED_PROBE_SQL,
  UNSPLIT_IDS_SQL,
  UNSPLIT_PROBE_SQL,
} from '../src/version-migrations.js';

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
      migration_count INTEGER, migrations_split INTEGER,
      migration_digest TEXT NOT NULL DEFAULT 'pushed', migration_digest_derived INTEGER
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

  describe('declared moves and discards (#2322)', () => {
    const declared = [
      { ...migrations[0]!, moves: { legacy: 'a' } },
      { ...migrations[1]!, discards: { 'a.note': 'never read; <b>see</b> 0003' } },
    ];
    const split = (sql: SwitchSql, id: string, ms: unknown[]) => {
      sql.run('INSERT INTO vertical_versions (id, vertical_slug, migration_count, migrations_split) VALUES (?, ?, ?, 1)', id, 'acme', ms.length);
      writeVersionMigrations(sql, id, ms as never);
    };

    it('stores them beside the SQL and reads them back; a migration declaring none has neither key', () => {
      const { sql } = fresh();
      split(sql, 'v', [...declared, { moduleId: helpdesk, version: '0003', sql: 'SELECT 1;' }]);
      expect(versionMigrationsOf(sql, 'v')?.migrations).toEqual([...declared, { moduleId: helpdesk, version: '0003', sql: 'SELECT 1;' }]);
      const cols = sql.all('SELECT declarations FROM vertical_version_migrations ORDER BY ordinal').map((r) => r.declarations);
      expect(cols[2]).toBeNull();
    });

    it('stores and reads back constructor and prototype as the table names they are (#2322 r2)', () => {
      const { sql } = fresh();
      const named = [{ ...migrations[0]!, discards: { constructor: 'why', prototype: 'why' }, moves: { 'constructor.a': 'prototype.a' } }];
      split(sql, 'v', named);
      expect(versionMigrationsOf(sql, 'v')?.migrations).toEqual(named);
    });

    it('a version holding a newline, tab, zero-width or bidi character is stored and read back as it is (#2322 r3)', () => {
      const version = `0007\n+ x\t${String.fromCodePoint(0x200b, 0x202e)}y`;
      const odd = [{ ...migrations[0]!, version }];
      // Split from a push, and from a stored pre-#1764 manifest the backfill has not reached.
      const { sql } = fresh();
      split(sql, 'v', odd);
      expect(versionMigrationsOf(sql, 'v')?.migrations).toEqual(odd);
      expect(splitManifestMigrations(manifest({ migrations: odd }), 'push').migrations).toEqual(odd);
      legacy(sql, 'old', manifest({ migrations: odd }));
      expect(versionMigrationsOf(sql, 'old')?.migrations).toEqual(odd);
    });

    it('a stored row naming __proto__ makes the version not available, as the push boundary refuses it', () => {
      const { sql } = fresh();
      split(sql, 'v', migrations);
      sql.run('UPDATE vertical_version_migrations SET declarations = ? WHERE ordinal = 0', '{"discards":{"__proto__":"why","b":"ok"}}');
      expect(versionMigrationsOf(sql, 'v')?.migrations).toBeNull();
    });

    it('a row stored before they were carried (NULL) reads as declaring none', () => {
      const { sql } = fresh();
      split(sql, 'old', migrations);
      sql.run('UPDATE vertical_version_migrations SET declarations = NULL');
      expect(versionMigrationsOf(sql, 'old')?.migrations).toEqual(migrations);
    });

    it('a row whose declarations do not read makes the whole version not available, never a list without them', () => {
      for (const bad of ['not json', '{}', '{"discards":{"a":""}}', '{"moves":{"a":1}}', '{"other":{"a":"b"}}', '[]']) {
        const { sql } = fresh();
        split(sql, 'v', declared);
        sql.run('UPDATE vertical_version_migrations SET declarations = ? WHERE ordinal = 1', bad);
        expect(versionMigrationsOf(sql, 'v')?.migrations, bad).toBeNull();
      }
    });

    it('a version the backfill moves keeps them, and so does one read before it is moved', () => {
      const { sql } = fresh();
      legacy(sql, 'carried', manifest({ migrations: declared }));
      expect(versionMigrationsOf(sql, 'carried')?.migrations).toEqual(declared);
      splitVersionMigrationsBatch(sql);
      expect(versionMigrationsOf(sql, 'carried')?.migrations).toEqual(declared);
    });

    it('a push whose declaration the boundary refuses carries no SQL at all, so the version reads not available', () => {
      const r = splitManifestMigrations(manifest({ migrations: [{ ...migrations[0]!, discards: { a: ' ' } }] }), 'push');
      expect(r.migrations).toBeNull();
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

  describe('the migration digest is derived from what is stored (#2339)', () => {
    const doClasses = ['TicketDO'];
    const declaring = [{ ...migrations[0]!, discards: { 'a.legacy': 'replaced by b' } }, migrations[1]!];
    /** What a CLI from before the SQL entered the digest sent: the store classes alone. */
    const preSqlDigest = async (classes: string[]) => {
      const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(classes)));
      return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
    };

    describe('publishedMigrationDigest', () => {
      const publish = (migrationDigest: string, carried: typeof migrations | null, classes: unknown = doClasses) =>
        publishedMigrationDigest({
          id: 'v1',
          migrationDigest,
          manifestJson: manifest({ doClasses: classes }),
          migrations: carried,
        });

      it("stores the derived digest when the push's agrees with the migrations it carries", async () => {
        const digest = await migrationDigestOf({ doClasses, migrations: declaring });
        await expect(publish(digest, declaring)).resolves.toBe(digest);
      });

      it('refuses an equal digest over different stored migrations, and over different declarations', async () => {
        const base = await migrationDigestOf({ doClasses, migrations });
        // The SQL moved, the digest did not.
        const edited = [migrations[0]!, { ...migrations[1]!, sql: 'DROP TABLE a;' }];
        await expect(publish(base, edited)).rejects.toMatchObject({
          code: 'validation_failed',
          extensions: { reason: MIGRATION_DIGEST_MISMATCH_REASON },
        });
        // Only a declared data loss was added: still a different set.
        await expect(publish(base, declaring)).rejects.toMatchObject({ code: 'validation_failed' });
        // And the store classes count too.
        await expect(publish(base, migrations, ['TicketDO', 'OtherDO'])).rejects.toMatchObject({ code: 'validation_failed' });
      });

      it('a CLI whose digest covers the SQL keeps working; one from before the SQL was hashed is refused, naming no version', async () => {
        // A CLI that hashes SQL but predates declarations: its migrations carry none, so its digest is the same.
        await expect(publish(await migrationDigestOf({ doClasses, migrations }), migrations)).resolves.toBeTypeOf('string');
        const refusal = await publish(await preSqlDigest(doClasses), migrations).catch((e: unknown) => e as Error);
        expect(refusal).toBeInstanceOf(Error);
        expect(refusal.message).toMatch(/upgrade to a CLI release whose push digest covers its SQL migrations/);
        expect(refusal.message).not.toMatch(/\b\d+\.\d+(\.\d+)?\b/);
      });

      it('a push that carries no migrations is not refused, and stores a digest equal to no other version', async () => {
        await expect(publish('anything', null)).resolves.toBe(unheldMigrationDigest('v1'));
        await expect(publishedMigrationDigest({ id: 'v2', migrationDigest: 'x', manifestJson: null, migrations: null }))
          .resolves.toBe(unheldMigrationDigest('v2'));
        expect(unheldMigrationDigest('v1')).not.toBe(unheldMigrationDigest('v2'));
      });

      it('carried migrations beside store classes that do not read are refused, never stored as unheld', async () => {
        const digest = await migrationDigestOf({ doClasses: [], migrations });
        await expect(publish(digest, migrations, 'not a list')).rejects.toMatchObject({ code: 'validation_failed' });
        // An absent `doClasses` reads as none, as the stored parser defaults it.
        await expect(
          publishedMigrationDigest({ id: 'v1', migrationDigest: digest, manifestJson: manifest(), migrations }),
        ).resolves.toBe(digest);
      });
    });

    describe('versions stored before it', () => {
      /** A version as an older control plane stored it: split, with the digest its push sent. */
      const stored = (sql: SwitchSql, id: string, pushed: string, ms: typeof migrations | null, classes: unknown = doClasses) => {
        sql.run(
          `INSERT INTO vertical_versions (id, vertical_slug, manifest_json, migration_count, migrations_split, migration_digest)
           VALUES (?, 'acme', ?, ?, 1, ?)`,
          id, manifest({ doClasses: classes }), ms?.length ?? null, pushed,
        );
        writeVersionMigrations(sql, id, ms);
      };
      const row = (sql: SwitchSql, id: string) =>
        sql.all('SELECT migration_digest, migration_digest_derived FROM vertical_versions WHERE id = ?', id)[0];

      it('a read derives an underived version: the pushed digest is replaced by the derived one, once', async () => {
        const { sql } = fresh();
        const derived = await migrationDigestOf({ doClasses, migrations: declaring });
        stored(sql, 'honest', derived, declaring);
        stored(sql, 'lying', 'the-base-digest', declaring);
        stored(sql, 'pre-sql', await preSqlDigest(doClasses), declaring);
        for (const id of ['honest', 'lying', 'pre-sql']) {
          await expect(deriveVersionMigrationDigest(sql, id)).resolves.toBe(derived);
          expect(row(sql, id)).toEqual({ migration_digest: derived, migration_digest_derived: 1 });
        }
        // Derived rows are left alone, whatever they hold.
        sql.run("UPDATE vertical_versions SET migration_digest = 'kept' WHERE id = 'honest'");
        await expect(deriveVersionMigrationDigest(sql, 'honest')).resolves.toBe('kept');
        await expect(deriveVersionMigrationDigest(sql, 'missing')).resolves.toBeUndefined();
      });

      it('a version with no stored migrations, or no manifest, becomes unheld; one still unsplit derives from its manifest', async () => {
        const { sql } = fresh();
        stored(sql, 'none', 'pushed', null);
        sql.run("INSERT INTO vertical_versions (id, vertical_slug, migration_digest) VALUES ('bare', 'acme', 'pushed')");
        legacy(sql, 'unsplit', manifest({ doClasses, migrations }));
        await expect(deriveVersionMigrationDigest(sql, 'none')).resolves.toBe(unheldMigrationDigest('none'));
        await expect(deriveVersionMigrationDigest(sql, 'bare')).resolves.toBe(unheldMigrationDigest('bare'));
        await expect(deriveVersionMigrationDigest(sql, 'unsplit')).resolves.toBe(await migrationDigestOf({ doClasses, migrations }));
        // A manifest whose JSON does not read, or whose classes do not, is unheld too.
        legacy(sql, 'garbled', 'not json');
        stored(sql, 'odd-classes', 'pushed', migrations, 'nope');
        await expect(deriveVersionMigrationDigest(sql, 'garbled')).resolves.toBe(unheldMigrationDigest('garbled'));
        await expect(deriveVersionMigrationDigest(sql, 'odd-classes')).resolves.toBe(unheldMigrationDigest('odd-classes'));
      });

      it('the backfill derives a bounded batch per call, reads agree before and after, and it ends', async () => {
        const { sql } = fresh();
        const derived = await migrationDigestOf({ doClasses, migrations });
        const ids = Array.from({ length: 25 }, (_, i) => `v${String(i).padStart(2, '0')}`);
        for (const id of ids) stored(sql, id, 'pushed', migrations);
        expect(versionsAwaitDigest(sql)).toBe(true);
        // A version the backfill has not reached yet: its read derives it first.
        await expect(deriveVersionMigrationDigest(sql, 'v24')).resolves.toBe(derived);
        expect(await deriveMigrationDigestsBatch(sql)).toEqual({ derived: 10, more: true });
        expect(await deriveMigrationDigestsBatch(sql)).toEqual({ derived: 10, more: true });
        // 24 left minus the 20, the 25th was derived on read: four, and nothing after.
        expect(await deriveMigrationDigestsBatch(sql)).toEqual({ derived: 4, more: false });
        expect(await deriveMigrationDigestsBatch(sql)).toEqual({ derived: 0, more: false });
        expect(versionsAwaitDigest(sql)).toBe(false);
        expect(new Set(ids.map((id) => row(sql, id)!.migration_digest))).toEqual(new Set([derived]));
      });

      it('the two reads that find underived versions are answered from the partial index, not a scan', () => {
        const { sql } = fresh();
        for (const [query, params] of [[UNDERIVED_IDS_SQL, [10]], [UNDERIVED_PROBE_SQL, []]] as const) {
          const plan = (sql.all(`EXPLAIN QUERY PLAN ${query}`, ...params) as { detail: string }[]).map((p) => p.detail);
          expect(plan.join(' | ')).toMatch(/USING (COVERING )?INDEX vertical_versions_underived/);
          expect(plan.join(' | ')).not.toMatch(/SCAN vertical_versions(?! USING)|TEMP B-TREE/);
        }
      });
    });
  });
});
