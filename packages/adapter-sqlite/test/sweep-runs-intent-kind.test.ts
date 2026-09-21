import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { platformActorId } from '@substrat-run/contracts';
import { ulid } from '@substrat-run/kernel';
import { SqliteScopeHost } from '../src/index.js';

/**
 * #1572: `_substrat_sweep_runs_intent` gains `kind` — `(request_id, unit)` becomes
 * `(request_id, kind, unit)` — on a directory that ALREADY HAS the old index.
 *
 * That qualifier is the whole test. The bootstrap says `CREATE UNIQUE INDEX IF NOT
 * EXISTS _substrat_sweep_runs_intent …`, and `IF NOT EXISTS` matches on the name: change
 * the column list and a fresh directory gets the new shape while every existing one
 * keeps the old index for good. A test that starts from a fresh directory passes either
 * way, so every case here starts from one carrying the old index.
 *
 * The old directory is staged by building one with this code and putting the previous
 * release's index back, verbatim — the two releases' directories differ in that index
 * and nothing else, which this PR's diff to the bootstrap shows.
 */

/** The index as `origin/main` created it before #1572, byte for byte. */
const LEGACY_INDEX =
  'CREATE UNIQUE INDEX IF NOT EXISTS _substrat_sweep_runs_intent ON _substrat_sweep_runs (request_id, unit)';

/**
 * Rows an old directory can hold: all unique on (request_id, unit), including two NULL
 * request ids on one unit (the direct sweep path, which never dedupes). The widened
 * index must build over every one of them and move none.
 */
const LEGACY_ROWS = [
  ['01JLEGACYROWAAAAAAAAAAAAA1', 'schedule', 'scope-1:acme/tick', 'ok', '01JLEGACYINTENTAAAAAAAAAAA'],
  ['01JLEGACYROWAAAAAAAAAAAAA2', 'schedule', 'scope-1:acme/rest', 'skipped', '01JLEGACYINTENTAAAAAAAAAAA'],
  ['01JLEGACYROWAAAAAAAAAAAAA3', 'connector', 'conn-1', 'ok', null],
  ['01JLEGACYROWAAAAAAAAAAAAA4', 'connector', 'conn-1', 'failed', null],
] as const;

const staff = platformActorId.parse(ulid());

describe('#1572: a directory carrying the (request_id, unit) index', () => {
  let dir: string;
  let file: string;

  /** Reads the directory file on its own connection, closing it before it returns. */
  const inspect = <T>(read: (db: Database.Database) => T): T => {
    const db = new Database(file, { readonly: true });
    try {
      return read(db);
    } finally {
      db.close();
    }
  };
  const indexColumns = () =>
    inspect((db) =>
      (db.prepare('PRAGMA index_info(_substrat_sweep_runs_intent)').all() as { name: string }[]).map((c) => c.name),
    );
  const isUnique = () =>
    inspect(
      (db) =>
        (db.prepare('PRAGMA index_list(_substrat_sweep_runs)').all() as { name: string; unique: number }[]).find(
          (ix) => ix.name === '_substrat_sweep_runs_intent',
        )?.unique,
    );
  const storedRows = () =>
    inspect((db) => db.prepare('SELECT id, kind, unit, outcome, request_id, at FROM _substrat_sweep_runs ORDER BY id').all());

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'substrat-sweep-runs-intent-'));
    file = join(dir, '_directory.sqlite');
    await new SqliteScopeHost({ dir }).close();
    const db = new Database(file);
    db.exec('DROP INDEX _substrat_sweep_runs_intent');
    db.exec(LEGACY_INDEX);
    const insert = db.prepare(
      'INSERT INTO _substrat_sweep_runs (id, kind, unit, outcome, request_id, at) VALUES (?, ?, ?, ?, ?, ?)',
    );
    for (const row of LEGACY_ROWS) insert.run(...row, '2099-01-01T00:00:00.000Z');
    db.close();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('is staged for real: the old index is in place and swallows the second kind', () => {
    // The negative control. Without it, a staging step that quietly failed would leave
    // the new index in place and every test below would pass against the wrong store.
    expect(indexColumns()).toEqual(['request_id', 'unit']);
    const db = new Database(file);
    try {
      const swallowed = db
        .prepare(
          `INSERT OR IGNORE INTO _substrat_sweep_runs (id, kind, unit, outcome, request_id, at)
           VALUES ('01JSWALLOWEDAAAAAAAAAAAAAA', 'freshness', 'scope-1:acme/tick', 'failed', '01JLEGACYINTENTAAAAAAAAAAA', '2099-01-01T00:00:00.000Z')`,
        )
        .run();
      // The bug: a different kind, dropped on (request_id, unit), and no error.
      expect(swallowed.changes).toBe(0);
    } finally {
      db.close();
    }
  });

  it('is rebuilt with kind on open — to exactly what a fresh directory builds', async () => {
    await new SqliteScopeHost({ dir }).close();
    expect(indexColumns()).toEqual(['request_id', 'kind', 'unit']);
    expect(isUnique()).toBe(1);

    const freshDir = mkdtempSync(join(tmpdir(), 'substrat-sweep-runs-intent-fresh-'));
    try {
      await new SqliteScopeHost({ dir: freshDir }).close();
      const fresh = new Database(join(freshDir, '_directory.sqlite'), { readonly: true });
      const indexSql = (db: Database.Database) =>
        db.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = '_substrat_sweep_runs_intent'").get();
      try {
        expect(inspect(indexSql)).toEqual(indexSql(fresh));
      } finally {
        fresh.close();
      }
    } finally {
      rmSync(freshDir, { recursive: true, force: true });
    }
  });

  it('keeps every row it held, verbatim, and is a no-op on the open after', async () => {
    const before = storedRows();
    expect(before).toHaveLength(LEGACY_ROWS.length);
    for (let open = 1; open <= 2; open += 1) {
      await new SqliteScopeHost({ dir }).close();
      expect(storedRows()).toEqual(before);
      expect(indexColumns()).toEqual(['request_id', 'kind', 'unit']);
    }
  });

  it('then keeps a schedule and a freshness row of one batch on one unit — and still refuses a true duplicate', async () => {
    const host = new SqliteScopeHost({ dir });
    try {
      const unit = 'scope-1:orders.placed';
      const requestId = '01JUPGRADEDINTENTAAAAAAAAA';
      const schedule = () =>
        host.admin.recordSweepRun({ kind: 'schedule', unit, outcome: 'skipped', operation: 'orders.placed', requestId });
      const freshness = () =>
        host.admin.recordSweepRun({ kind: 'freshness', unit, outcome: 'failed', eventType: 'orders.placed', requestId });
      await schedule();
      await freshness();
      const both = await host.admin.listSweepRuns(staff, { unit });
      expect(both.map((r) => r.kind).sort()).toEqual(['freshness', 'schedule']);

      // The positive twin, on the migrated index: the same (request_id, kind, unit)
      // again is one row — including a row the OLD index let in before the upgrade.
      await schedule();
      await freshness();
      expect(await host.admin.listSweepRuns(staff, { unit })).toHaveLength(2);
      await host.admin.recordSweepRun({
        kind: 'schedule',
        unit: 'scope-1:acme/tick',
        outcome: 'ok',
        requestId: '01JLEGACYINTENTAAAAAAAAAAA',
      });
      expect(await host.admin.listSweepRuns(staff, { unit: 'scope-1:acme/tick' })).toHaveLength(1);
    } finally {
      await host.close();
    }
  });

  it('re-creates the index in the new shape when it is missing altogether', async () => {
    // A directory stopped between DROP and CREATE would look like this, were the two
    // not one transaction: it is recovered on the next open because the bootstrap
    // creates the index by name — the reason the transaction is not load-bearing here.
    const db = new Database(file);
    db.exec('DROP INDEX _substrat_sweep_runs_intent');
    db.close();
    await new SqliteScopeHost({ dir }).close();
    expect(indexColumns()).toEqual(['request_id', 'kind', 'unit']);
    expect(isUnique()).toBe(1);
  });
});
