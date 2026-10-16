import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MIGRATION_REPLAY_API, replayMigrations, type ReplayDatabase, type SqlMigration, type SqlValue } from '../src/index.js';

/**
 * #2321 — the replay `lint:migration-fence` and `substrat push` both run: a vertical's modules,
 * applied in order against an in-memory scope populated before every authored migration, through
 * the fence. Each refusal has its passing twin.
 */
const database = (): ReplayDatabase & { db: DatabaseSync } => {
  const db = new DatabaseSync(':memory:');
  return {
    db,
    exec: (q) => db.exec(q),
    query: <T>(q: string, p: readonly SqlValue[] = []) => db.prepare(q).all(...(p as never[])) as T[],
    run: (q, p = []) => ({ changes: Number(db.prepare(q).run(...(p as never[])).changes) }),
  };
};
const module = (migrations: SqlMigration[], id = 'notes') => ({ manifest: { id }, migrations });
const replay = (migrations: SqlMigration[], opts?: { spineDdl?: string }) => replayMigrations(database(), [module(migrations)], opts);

const INIT: SqlMigration = { version: '0001', sql: 'CREATE TABLE notes (id TEXT PRIMARY KEY, body TEXT);' };

describe('replayMigrations', () => {
  it('names its API version, which a caller reaching a kernel it was not built with checks first', () => {
    expect(MIGRATION_REPLAY_API).toBe(1);
  });

  it('refuses an undeclared drop of a table the replay populated, naming the declaration to add', () => {
    const out = replay([INIT, { version: '0002', sql: 'DROP TABLE notes;' }]);
    expect(out.refused).toMatchObject({ key: 'notes@0002', reason: 'data_loss' });
    expect(out.refused!.message).toContain("discards: { 'notes': '<why this data may go>' }");
    expect(out.failed).toBeUndefined();
    expect(out).toMatchObject({ authored: 2, passed: 1 });
  });

  it('passes the same drop when it is declared, and reports the declaration with its reason', () => {
    const out = replay([INIT, { version: '0002', sql: 'DROP TABLE notes;', discards: { notes: 'retired in 0.4' } }]);
    expect(out.refused).toBeUndefined();
    expect(out).toMatchObject({ authored: 2, passed: 2 });
    expect(out.declared).toEqual(['notes@0002 discards notes: retired in 0.4']);
  });

  it('passes an additive migration and a faithful rebuild', () => {
    const out = replay([
      INIT,
      { version: '0002', sql: 'ALTER TABLE notes ADD COLUMN title TEXT;' },
      {
        version: '0003',
        sql: 'CREATE TABLE notes_new (id TEXT PRIMARY KEY, body TEXT NOT NULL, title TEXT); INSERT INTO notes_new SELECT * FROM notes; DROP TABLE notes; ALTER TABLE notes_new RENAME TO notes;',
      },
    ]);
    expect(out).toEqual({ authored: 3, passed: 3, declared: [] });
  });

  it('populates before EVERY authored migration, so a column added later is held too', () => {
    // The column 0002 adds is empty until the replay fills it before 0003; unfilled, dropping it
    // would lose nothing and pass.
    const out = replay([
      INIT,
      { version: '0002', sql: 'ALTER TABLE notes ADD COLUMN title TEXT;' },
      { version: '0003', sql: 'ALTER TABLE notes DROP COLUMN title;' },
    ]);
    expect(out.refused).toMatchObject({ key: 'notes@0003', reason: 'data_loss' });
  });

  it('a migration that cannot run on synthetic data is FAILED, not refused, and the replay stops there', () => {
    const out = replay([
      INIT,
      { version: '0002', sql: "UPDATE notes SET body = json_extract(body, '$.text');" },
      { version: '0003', sql: 'DROP TABLE notes;' },
    ]);
    expect(out.refused).toBeUndefined();
    expect(out.failed).toMatchObject({ key: 'notes@0002' });
    expect(out.failed!.message).toMatch(/json/i);
    expect(out).toMatchObject({ authored: 3, passed: 1 });
  });

  it('builds the spine first when given one, so an authored read of it replays', () => {
    const reads: SqlMigration = { version: '0002', sql: 'INSERT INTO notes (id, body) SELECT id, kind FROM _substrat_things;' };
    expect(replay([INIT, reads]).failed!.message).toMatch(/no such table: _substrat_things/);
    expect(replay([INIT, reads], { spineDdl: 'CREATE TABLE _substrat_things (id TEXT, kind TEXT);' })).toMatchObject({ passed: 2 });
  });

  it('turns foreign keys and CHECKs off, since a made-up value satisfies neither', () => {
    const out = replay([
      { version: '0001', sql: 'CREATE TABLE a (id TEXT PRIMARY KEY); CREATE TABLE b (a_id TEXT REFERENCES a(id), n INTEGER CHECK (n < 0));' },
      { version: '0002', sql: 'ALTER TABLE b ADD COLUMN m TEXT;' },
    ]);
    expect(out).toMatchObject({ passed: 2 });
    expect(out.failed).toBeUndefined();
  });

  it('runs the derived index DDL too, unfenced, and counts only authored migrations', () => {
    const TICKET: SqlMigration = { version: '0001', sql: 'CREATE TABLE ticket (id TEXT PRIMARY KEY, title TEXT, status TEXT, created_at TEXT);' };
    const manifest = {
      id: 'helpdesk',
      searchables: [{ entityType: 'ticket', fields: ['title'], table: 'ticket', idColumn: 'id', tokenizer: 'unicode61' }],
      lists: [{ entityType: 'ticket', sortable: ['created_at', 'id'], filterable: ['status'], table: 'ticket', idColumn: 'id' }],
    };
    const db = database();
    const out = replayMigrations(db, [{ manifest, migrations: [TICKET, { version: '0002', sql: 'ALTER TABLE ticket ADD COLUMN body TEXT;' }] }] as never);
    expect(out).toEqual({ authored: 2, passed: 2, declared: [] });
    // The derived DDL ran: the search index exists.
    expect(db.query<{ name: string }>("SELECT name FROM sqlite_master WHERE name LIKE '_substrat_search_%'").length).toBeGreaterThan(0);
  });

  it('gives each column a value its declared type stores, so a STRICT table with a BLOB column replays complete', () => {
    const out = replay([
      { version: '0001', sql: 'CREATE TABLE f (id TEXT PRIMARY KEY, data BLOB, n INTEGER, r REAL, x ANY) STRICT;' },
      { version: '0002', sql: 'ALTER TABLE f ADD COLUMN note TEXT;' },
      { version: '0003', sql: 'ALTER TABLE f DROP COLUMN data;' },
    ]);
    // The blob was held, so dropping it is a loss — refused, not a failure to populate.
    expect(out.failed).toBeUndefined();
    expect(out.refused).toMatchObject({ key: 'notes@0003', reason: 'data_loss' });
    expect(out.refused!.message).toContain('column f.data held 1 value(s) and is gone');
  });

  it('refuses ATTACH, so the replay never creates a file — and an ATTACH smuggling a drop is refused too', () => {
    const dir = mkdtempSync(join(tmpdir(), 'substrat-replay-attach-'));
    const file = join(dir, 'leak.db');
    const out = replay([
      INIT,
      { version: '0002', sql: `ATTACH DATABASE '${file}' AS x; CREATE TABLE x.leak (a TEXT); INSERT INTO x.leak VALUES ('hi');` },
    ]);
    expect(out.refused).toMatchObject({ key: 'notes@0002', reason: 'migration_attach' });
    expect(existsSync(file)).toBe(false);
    const smuggled = replay([INIT, { version: '0002', sql: `ATTACH DATABASE ':memory:' AS x; DROP TABLE main.notes;` }]);
    expect(smuggled.refused).toMatchObject({ key: 'notes@0002', reason: 'migration_attach' });
  });

  it('tells a caller which migration is about to run, so it can bound each one', () => {
    const seen: [string, boolean][] = [];
    const manifest = { id: 'helpdesk', lists: [{ entityType: 't', sortable: ['id'], filterable: [], table: 't', idColumn: 'id' }] };
    replayMigrations(database(), [{ manifest, migrations: [{ version: '0001', sql: 'CREATE TABLE t (id TEXT);' }] }] as never, {
      onMigration: (key, authored) => seen.push([key, authored]),
    });
    expect(seen[0]).toEqual(['helpdesk@0001', true]);
    expect(seen.slice(1).every(([, authored]) => !authored)).toBe(true);
    expect(seen.length).toBeGreaterThan(1);
  });

  it('replays modules in order, each judged under its own key', () => {
    const out = replayMigrations(database(), [
      module([INIT]),
      module([{ version: '0001', sql: 'CREATE TABLE tags (id TEXT);' }, { version: '0002', sql: 'DELETE FROM tags;' }], 'tags'),
    ]);
    expect(out.refused).toMatchObject({ key: 'tags@0002' });
    expect(out).toMatchObject({ authored: 3, passed: 2 });
  });
});
