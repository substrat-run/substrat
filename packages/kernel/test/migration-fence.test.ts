import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { errorCodeOf } from '@substrat-run/contracts';
import { runMigrationStatements, type ScopedSql, type SqlMigration, type SqlValue } from '../src/index.js';

/**
 * #115 — the data-loss fence, on a real SQLite, through `runMigrationStatements` as both adapters
 * call it. Every refusal has its twin: the same SQL on a scope that holds nothing, or a declaration
 * that names the loss, applies. The contract suite proves the wiring on both adapters.
 */
const scope = (setup: string) => {
  const db = new DatabaseSync(':memory:');
  db.exec(setup);
  const sql: ScopedSql = {
    query: <T>(q: string, p: readonly SqlValue[] = []) => db.prepare(q).all(...(p as never[])) as T[],
    exec: (q: string, p: readonly SqlValue[] = []) => ({ changes: Number(db.prepare(q).run(...(p as never[])).changes) }),
  };
  /** Run one migration in a transaction, as an adapter does: a throw rolls all of it back. */
  const migrate = (migration: Omit<SqlMigration, 'version'>, authored = true) => {
    db.exec('BEGIN');
    try {
      runMigrationStatements(sql, { version: '0002', ...migration }, (st) => db.exec(st), { key: 'm@0002', authored });
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  };
  const rows = (q: string) => db.prepare(q).all();
  return { db, migrate, rows };
};

const NOTES = `CREATE TABLE notes (id TEXT PRIMARY KEY, body TEXT, score TEXT);`;
const populated = () => scope(`${NOTES} INSERT INTO notes VALUES ('a', 'hello', '1.50'), ('b', 'world', NULL);`);
const empty = () => scope(NOTES);

const refusal = (fn: () => void): string => {
  try {
    fn();
  } catch (err) {
    expect(errorCodeOf(err)).toBe('forbidden');
    return (err as Error).message;
  }
  throw new Error('expected the fence to refuse');
};

describe('the data-loss fence (#115)', () => {
  it('refuses DROP TABLE of a table holding rows, and leaves the rows where they were', () => {
    const s = populated();
    const message = refusal(() => s.migrate({ sql: 'DROP TABLE notes;' }));
    expect(message).toContain('table notes held 2 row(s) and is gone');
    expect(message).toContain(`discards: { 'notes': '<why this data may go>' }`);
    expect(s.rows('SELECT id FROM notes')).toHaveLength(2);
  });

  it('lets the same DROP TABLE through on a scope where the table is empty', () => {
    const s = empty();
    s.migrate({ sql: 'DROP TABLE notes;' });
    expect(s.rows("SELECT name FROM sqlite_master WHERE name = 'notes'")).toHaveLength(0);
  });

  it('refuses DROP COLUMN of a column holding values; an all-NULL column may go', () => {
    const s = populated();
    expect(refusal(() => s.migrate({ sql: 'ALTER TABLE notes DROP COLUMN body;' }))).toContain(
      'column notes.body held 2 value(s) and is gone',
    );
    const nulls = scope(`${NOTES} INSERT INTO notes VALUES ('a', 'hello', NULL);`);
    nulls.migrate({ sql: 'ALTER TABLE notes DROP COLUMN score;' });
  });

  it('refuses a DELETE, and an UPDATE that NULLs values', () => {
    const s = populated();
    expect(refusal(() => s.migrate({ sql: "DELETE FROM notes WHERE id = 'b';" }))).toContain('table notes held 2 row(s), now 1');
    expect(refusal(() => s.migrate({ sql: 'UPDATE notes SET body = NULL;' }))).toContain('column notes.body held 2 value(s), now 0');
    // Its twin: an UPDATE that only fills values in loses nothing.
    s.migrate({ sql: "UPDATE notes SET score = '0' WHERE score IS NULL;" });
  });

  it('passes a faithful create-copy-drop-rename rebuild, and refuses one that forgets a column', () => {
    const rebuild = (cols: string) => `
      CREATE TABLE notes_new (id TEXT PRIMARY KEY, body TEXT, score TEXT);
      INSERT INTO notes_new (${cols}) SELECT ${cols} FROM notes;
      DROP TABLE notes;
      ALTER TABLE notes_new RENAME TO notes;`;
    const s = populated();
    expect(refusal(() => s.migrate({ sql: rebuild('id, body') }))).toContain('column notes.score held 1 value(s), now 0');
    s.migrate({ sql: rebuild('id, body, score') });
    expect(s.rows('SELECT * FROM notes ORDER BY id')).toEqual([
      { id: 'a', body: 'hello', score: '1.50' },
      { id: 'b', body: 'world', score: null },
    ]);
  });

  it('passes the rename-old-away rebuild, judged by the original name', () => {
    const s = populated();
    s.migrate({
      sql: `ALTER TABLE notes RENAME TO notes_old;
        CREATE TABLE notes (id TEXT PRIMARY KEY, body TEXT NOT NULL, score TEXT);
        INSERT INTO notes SELECT * FROM notes_old;
        DROP TABLE notes_old;`,
    });
  });

  it('refuses a rebuild that filters rows', () => {
    const s = populated();
    expect(
      refusal(() =>
        s.migrate({
          sql: `CREATE TABLE notes_new (id TEXT PRIMARY KEY, body TEXT, score TEXT);
            INSERT INTO notes_new SELECT * FROM notes WHERE score IS NOT NULL;
            DROP TABLE notes; ALTER TABLE notes_new RENAME TO notes;`,
        }),
      ),
    ).toContain('table notes held 2 row(s), now 1');
  });

  it('follows RENAME TO and RENAME COLUMN', () => {
    const s = populated();
    s.migrate({ sql: 'ALTER TABLE notes RENAME TO memos; ALTER TABLE memos RENAME COLUMN body TO text; ALTER TABLE memos RENAME score TO grade;' });
    expect(s.rows('SELECT text, grade FROM memos ORDER BY id')).toEqual([
      { text: 'hello', grade: '1.50' },
      { text: 'world', grade: null },
    ]);
  });

  it('refuses rename-as-drop+add, and passes the same change written as a declared move', () => {
    const sql = `ALTER TABLE notes ADD COLUMN text TEXT; UPDATE notes SET text = body; ALTER TABLE notes DROP COLUMN body;`;
    expect(refusal(() => populated().migrate({ sql }))).toContain('column notes.body held 2 value(s) and is gone');
    populated().migrate({ sql, moves: { 'notes.body': 'notes.text' } });
  });

  it('refuses a narrowing retype: the count holds, the storage class does not', () => {
    const sql = `CREATE TABLE notes_new (id TEXT PRIMARY KEY, body TEXT, score REAL);
      INSERT INTO notes_new SELECT * FROM notes; DROP TABLE notes; ALTER TABLE notes_new RENAME TO notes;`;
    const message = refusal(() => populated().migrate({ sql }));
    expect(message).toContain('column notes.score held 1 value(s), now 1 (text 1 → 0: retyped)');
    populated().migrate({ sql, discards: { 'notes.score': 'scores become numbers; the text form is not kept' } });
  });

  it('sees a loss a foreign-key cascade makes in a table the migration never names', () => {
    const setup = `${NOTES} CREATE TABLE tags (note_id TEXT REFERENCES notes(id) ON DELETE CASCADE, tag TEXT);
      INSERT INTO notes VALUES ('a', 'x', NULL); INSERT INTO tags VALUES ('a', 't');`;
    const s = scope(setup);
    s.db.exec('PRAGMA foreign_keys = ON');
    const message = refusal(() => s.migrate({ sql: "DELETE FROM notes WHERE id = 'a';", discards: { notes: 'note a was a test row' } }));
    expect(message).toContain('table tags held 1 row(s), now 0');
    expect(message).not.toContain('table notes');
  });

  it('sees a loss a trigger makes when a migration inserts', () => {
    const s = scope(`${NOTES} CREATE TABLE log (line TEXT); INSERT INTO log VALUES ('kept');
      CREATE TRIGGER wipe AFTER INSERT ON notes BEGIN DELETE FROM log; END;`);
    expect(refusal(() => s.migrate({ sql: "INSERT INTO notes VALUES ('c', 'new', NULL);" }))).toContain('table log held 1 row(s), now 0');
  });

  it('does not measure an additive migration, and does not hold kernel-derived DDL to the fence', () => {
    const s = populated();
    s.migrate({ sql: 'ALTER TABLE notes ADD COLUMN tag TEXT; CREATE INDEX notes_tag ON notes (tag); CREATE VIEW v AS SELECT id FROM notes;' });
    s.migrate({ sql: 'DROP TABLE notes;' }, false);
  });

  describe('moves are verified', () => {
    const MOVE = `CREATE TABLE archive (id TEXT PRIMARY KEY, body TEXT, score TEXT);
      INSERT INTO archive SELECT * FROM notes; DROP TABLE notes;`;

    it('a table moved whole passes', () => {
      populated().migrate({ sql: MOVE, moves: { notes: 'archive' } });
    });

    it('a move that drops rows on the way is still refused', () => {
      const sql = MOVE.replace('FROM notes;', 'FROM notes WHERE score IS NOT NULL;');
      expect(refusal(() => populated().migrate({ sql, moves: { notes: 'archive' } }))).toContain(
        'moves into archive from notes: the sources held 2 row(s), the target gained 1',
      );
    });

    it('several sources into one target must all arrive', () => {
      const s = scope(`${NOTES} CREATE TABLE drafts (id TEXT PRIMARY KEY, body TEXT, score TEXT);
        INSERT INTO notes VALUES ('a', 'x', NULL); INSERT INTO drafts VALUES ('d', 'y', NULL);`);
      const sql = `CREATE TABLE archive (id TEXT PRIMARY KEY, body TEXT, score TEXT);
        INSERT INTO archive SELECT * FROM notes; DROP TABLE notes; DROP TABLE drafts;`;
      expect(refusal(() => s.migrate({ sql, moves: { notes: 'archive', drafts: 'archive' } }))).toContain(
        'the sources held 2 row(s), the target gained 1',
      );
      s.migrate({ sql: sql.replace('DROP TABLE notes;', 'INSERT INTO archive SELECT * FROM drafts; DROP TABLE notes;'), moves: { notes: 'archive', drafts: 'archive' } });
    });

    it('a move excuses its source only; a neighbour lost alongside is still refused', () => {
      const sql = `${MOVE.replace('DROP TABLE notes;', '')} ALTER TABLE notes DROP COLUMN score; ALTER TABLE notes DROP COLUMN body;`;
      const message = refusal(() => populated().migrate({ sql, moves: { 'notes.body': 'archive.body' } }));
      expect(message).toContain('column notes.score');
      expect(message).not.toContain('column notes.body');
    });
  });

  describe('declarations are checked before anything runs', () => {
    const invalid = (migration: Omit<SqlMigration, 'version'>): string => {
      const s = populated();
      try {
        s.migrate(migration);
      } catch (err) {
        expect(errorCodeOf(err)).toBe('validation_failed');
        expect(s.rows('SELECT id FROM notes')).toHaveLength(2);
        return (err as Error).message;
      }
      throw new Error('expected the declaration to be refused');
    };

    it('a discard with no reason is refused', () => {
      expect(invalid({ sql: 'DROP TABLE notes;', discards: { notes: '  ' } })).toContain('gives no reason');
    });

    it('a declaration naming a table or column the scope does not hold is refused', () => {
      expect(invalid({ sql: 'DROP TABLE notes;', discards: { notez: 'typo' } })).toContain('discards names notez');
      expect(invalid({ sql: 'DROP TABLE notes;', moves: { 'notes.bdy': 'x.body' } })).toContain('moves names notes.bdy');
    });

    it('a move between a table and a column is refused', () => {
      expect(invalid({ sql: 'DROP TABLE notes;', moves: { notes: 'archive.body' } })).toContain('moves a table to a column');
    });

    it('a move whose target does not exist afterwards is refused', () => {
      expect(refusal(() => populated().migrate({ sql: 'DROP TABLE notes;', moves: { notes: 'archive' } }))).toContain(
        'moves names archive as a target, which does not exist after the migration',
      );
    });

    it('a discard excuses exactly what it names', () => {
      const s = populated();
      const message = refusal(() =>
        s.migrate({ sql: 'ALTER TABLE notes DROP COLUMN body; ALTER TABLE notes DROP COLUMN score;', discards: { 'notes.body': 'retired' } }),
      );
      expect(message).toContain('column notes.score');
      expect(message).not.toContain('notes.body');
      s.migrate({ sql: 'DROP TABLE notes;', discards: { notes: 'the feature is retired' } });
    });
  });
});
