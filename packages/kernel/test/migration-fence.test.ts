import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { errorCodeOf } from '@substrat-run/contracts';
import { runMigrationStatements, type ScopedSql, type SqlMigration, type SqlValue } from '../src/index.js';
import { assertWithinSqlLimits } from '../src/sql-limits.js';

/**
 * #115 — the data-loss fence, on a real SQLite, through `runMigrationStatements` as both adapters
 * call it. Every refusal has its twin: the same SQL on a scope that holds nothing, or a declaration
 * that names the loss, applies. The contract suite proves the wiring on both adapters.
 */
const scope = (setup: string) => {
  const db = new DatabaseSync(':memory:');
  db.exec(setup);
  // Every query the fence issues is held to a Durable Object's limits, which node's SQLite does
  // not enforce: a measuring query wider than the DO allows would close a scope on its own (#115 r1).
  const sql: ScopedSql = {
    query: <T>(q: string, p: readonly SqlValue[] = []) => {
      assertWithinSqlLimits(q);
      return db.prepare(q).all(...(p as never[])) as T[];
    },
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

  it("leaves a kernel column's leaving to the kernel's own check, but still holds its values", () => {
    const setup = `CREATE TABLE notes (id TEXT PRIMARY KEY, body TEXT, _substrat_trashed_at TEXT);
      INSERT INTO notes VALUES ('a', 'x', '2026-01-01T00:00:00Z');`;
    // Gone: #2090's check refuses that, with its own remedy, right after this one.
    scope(setup).migrate({ sql: 'ALTER TABLE notes DROP COLUMN _substrat_trashed_at;' });
    // Kept but emptied: a binned row would come back, and nobody declared that.
    expect(refusal(() => scope(setup).migrate({ sql: 'UPDATE notes SET _substrat_trashed_at = NULL;' }))).toContain(
      'column notes._substrat_trashed_at held 1 value(s), now 0',
    );
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

  describe('a wide table is measured inside the Durable Object limits (#115 r1)', () => {
    /** A populated table of `n` columns: `id` and `c1` … `c{n-1}`, every one holding a value. */
    const wide = (n: number) => {
      const cols = Array.from({ length: n - 1 }, (_, i) => `c${i + 1}`);
      return scope(
        `CREATE TABLE w (id TEXT PRIMARY KEY, ${cols.map((c) => `${c} TEXT`).join(', ')});
         INSERT INTO w VALUES ('a', ${cols.map((c) => `'${c}'`).join(', ')});`,
      );
    };

    it.each([26, 30, 100])('a %i-column table: a migration that loses nothing applies', (n) => {
      wide(n).migrate({ sql: "UPDATE w SET c1 = c1 WHERE id = 'a';" });
    });

    it.each([30, 100])('a %i-column table: a loss in its last column, past the first scan, is refused', (n) => {
      expect(refusal(() => wide(n).migrate({ sql: `ALTER TABLE w DROP COLUMN c${n - 1};` }))).toContain(
        `column w.c${n - 1} held 1 value(s) and is gone`,
      );
    });
  });

  it('two tables before cannot both become one after: a rename onto a dropped name loses the dropped rows (#115 r1)', () => {
    const setup = `CREATE TABLE a (id TEXT); CREATE TABLE b (id TEXT);
      INSERT INTO a VALUES ('1'), ('2'), ('3'); INSERT INTO b VALUES ('x');`;
    expect(refusal(() => scope(setup).migrate({ sql: 'DROP TABLE b; ALTER TABLE a RENAME TO b;' }))).toContain(
      'table b held 1 row(s) and is gone',
    );
    // Its twin: declared, the same replacement applies.
    scope(setup).migrate({ sql: 'DROP TABLE b; ALTER TABLE a RENAME TO b;', discards: { b: 'b was a staging copy' } });
  });

  it('the rename claims its target first, whichever table the scope created first', () => {
    // `b` before `a` in the catalogue: an unrenamed `b` must not take the name `a` was renamed onto.
    const setup = `CREATE TABLE b (id TEXT); CREATE TABLE a (id TEXT);
      INSERT INTO a VALUES ('1'), ('2'), ('3'); INSERT INTO b VALUES ('x');`;
    const message = refusal(() => scope(setup).migrate({ sql: 'DROP TABLE b; ALTER TABLE a RENAME TO b;' }));
    expect(message).toContain('table b held 1 row(s) and is gone');
    expect(message).not.toContain('table a');
    scope(setup).migrate({ sql: 'DROP TABLE b; ALTER TABLE a RENAME TO b;', discards: { b: 'b was a staging copy' } });
  });

  describe.each([
    ['b created first', 'CREATE TABLE b (id TEXT, x TEXT); CREATE TABLE a (id TEXT, x TEXT);'],
    ['a created first', 'CREATE TABLE a (id TEXT, x TEXT); CREATE TABLE b (id TEXT, x TEXT);'],
  ])('a dropped name, reused by a rename, then renamed again (%s) (#115 r2)', (_, create) => {
    const setup = `${create} INSERT INTO a VALUES ('1', 'p'), ('2', 'q'); INSERT INTO b VALUES ('x', 'r');`;
    const reused = 'DROP TABLE b; ALTER TABLE a RENAME TO b;';
    const dropB = { discards: { b: 'b was a staging copy' } };

    it('a column renamed on the reused name belongs to the table renamed onto it', () => {
      scope(setup).migrate({ sql: `${reused} ALTER TABLE b RENAME COLUMN x TO y;`, ...dropB });
    });

    it('the reused name renamed again carries the renamed table, not the dropped one', () => {
      const s = scope(setup);
      s.migrate({ sql: `${reused} ALTER TABLE b RENAME TO c;`, ...dropB });
      expect(s.rows('SELECT id FROM c ORDER BY id')).toEqual([{ id: '1' }, { id: '2' }]);
    });

    it('undeclared, the refusal names the dropped table only', () => {
      const message = refusal(() => scope(setup).migrate({ sql: `${reused} ALTER TABLE b RENAME TO c;` }));
      expect(message).toContain('table b held 1 row(s) and is gone');
      expect(message).not.toContain('table a');
    });

    it('declaring the wrong table does not pass: the dropped rows are still named', () => {
      expect(
        refusal(() => scope(setup).migrate({ sql: `${reused} ALTER TABLE b RENAME TO c;`, discards: { a: 'mistaken remedy' } })),
      ).toContain('table b held 1 row(s) and is gone');
    });
  });

  it('a table renamed, then dropped, does not live on in a new table created under that name (#115 r2)', () => {
    const setup = `CREATE TABLE a (id TEXT, x TEXT); INSERT INTO a VALUES ('1', 'p'), ('2', 'q');`;
    const sql = `ALTER TABLE a RENAME TO y; DROP TABLE y;
      CREATE TABLE y (id TEXT, x TEXT); INSERT INTO y VALUES ('n1', 'new'), ('n2', 'new'), ('n3', 'new');`;
    expect(refusal(() => scope(setup).migrate({ sql }))).toContain('table a held 2 row(s) and is gone');
    scope(setup).migrate({ sql, discards: { a: 'replaced by a fresh y' } });
  });

  describe('a table rebuilt back into place after a column rename (#115 r2)', () => {
    const setup = `${NOTES} INSERT INTO notes VALUES ('a', 'hello', '1');`;
    const aside = 'ALTER TABLE notes RENAME COLUMN body TO text; ALTER TABLE notes RENAME TO notes_old;';

    it('keeps the original name when the rebuilt table does', () => {
      scope(setup).migrate({
        sql: `${aside} CREATE TABLE notes (id TEXT PRIMARY KEY, body TEXT, score TEXT);
          INSERT INTO notes SELECT * FROM notes_old; DROP TABLE notes_old;`,
      });
    });

    it('prefers the renamed name when the rebuilt table has both and only that one is filled', () => {
      scope(setup).migrate({
        sql: `${aside} CREATE TABLE notes (id TEXT PRIMARY KEY, body TEXT, text TEXT, score TEXT);
          INSERT INTO notes (id, text, score) SELECT id, text, score FROM notes_old; DROP TABLE notes_old;`,
      });
    });
  });

  it('measures a real table that only shares a prefix with a virtual one; skips the exact shadow tables (#115 r1)', () => {
    const setup = `CREATE VIRTUAL TABLE notes USING fts5(body);
      INSERT INTO notes (body) VALUES ('indexed');
      CREATE TABLE notes_archive (id TEXT); INSERT INTO notes_archive VALUES ('kept');`;
    expect(refusal(() => scope(setup).migrate({ sql: 'DROP TABLE notes_archive;' }))).toContain(
      'table notes_archive held 1 row(s) and is gone',
    );
    // The FTS index and its shadow tables are not measured: clearing the index is not a refusal.
    scope(setup).migrate({ sql: "DELETE FROM notes;" });
  });

  describe('a table moved whole brings its columns (#115 r1)', () => {
    const setup = `CREATE TABLE drafts (id TEXT PRIMARY KEY, body TEXT, author TEXT);
      CREATE TABLE notes (id TEXT PRIMARY KEY, body TEXT);
      INSERT INTO drafts VALUES ('d', 'text', 'ann');`;
    const sql = 'INSERT INTO notes (id, body) SELECT id, body FROM drafts; DROP TABLE drafts;';

    it('a column left behind is refused, even though every row arrived', () => {
      expect(refusal(() => scope(setup).migrate({ sql, moves: { drafts: 'notes' } }))).toContain(
        "moves drafts.author into notes, but notes.author does not exist — move the column by name (moves: { 'drafts.author': '<table.column>' }) or discard it",
      );
    });

    it('the column discarded by name, or moved by name, passes', () => {
      scope(setup).migrate({ sql, moves: { drafts: 'notes' }, discards: { 'drafts.author': 'authors are not kept on notes' } });
      scope(`${setup} ALTER TABLE notes ADD COLUMN by_whom TEXT;`).migrate({
        sql: 'INSERT INTO notes (id, body, by_whom) SELECT id, body, author FROM drafts; DROP TABLE drafts;',
        moves: { drafts: 'notes', 'drafts.author': 'notes.by_whom' },
      });
    });
  });

  it('follows a column renamed before its table moved aside and was rebuilt back into place (#115 r1)', () => {
    scope(`${NOTES} INSERT INTO notes VALUES ('a', 'hello', '1');`).migrate({
      sql: `ALTER TABLE notes RENAME COLUMN body TO text;
        ALTER TABLE notes RENAME TO notes_old;
        CREATE TABLE notes (id TEXT PRIMARY KEY, text TEXT, score TEXT);
        INSERT INTO notes SELECT * FROM notes_old;
        DROP TABLE notes_old;`,
    });
  });

  it('reports an integer widening as a retype, which only a discard excuses (counts cannot tell 5 → 5.0 from 5 → 0.05)', () => {
    const setup = 'CREATE TABLE m (id TEXT PRIMARY KEY, amt INTEGER); INSERT INTO m VALUES (\'a\', 5);';
    const sql = `CREATE TABLE m_new (id TEXT PRIMARY KEY, amt REAL); INSERT INTO m_new SELECT * FROM m;
      DROP TABLE m; ALTER TABLE m_new RENAME TO m;`;
    expect(refusal(() => scope(setup).migrate({ sql }))).toContain('column m.amt held 1 value(s), now 1 (integer 1 → 0: retyped)');
    scope(setup).migrate({ sql, discards: { 'm.amt': 'amounts widen to REAL; the integer form is not kept' } });
  });
});
