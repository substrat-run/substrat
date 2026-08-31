import { describe, expect, it, vi } from 'vitest';
import { errorCodeOf } from '@substrat-run/contracts';
import { assertNoSpineWrite, guardSpine, type ScopedSql } from '../src/index.js';

/**
 * The statement scan behind `ctx.sql` (#954). Two properties are being pinned and
 * they pull in opposite directions: every shape of forge is refused, and every
 * read of the spine still runs — including the read that feeds a write, which is
 * the projection pattern CLAUDE.md blesses.
 */
describe('assertNoSpineWrite: refuses', () => {
  const forges = [
    'INSERT INTO _substrat_tuples (subject, relation, object) VALUES (?, ?, ?)',
    "UPDATE _substrat_outbox SET payload = '{}' WHERE id = ?",
    'DELETE FROM _substrat_events WHERE id = ?',
    'REPLACE INTO _substrat_tuples VALUES (?, ?, ?)',
    'INSERT OR REPLACE INTO _substrat_migrations (module_id, version) VALUES (?, ?)',
    'DROP TABLE _substrat_tuples',
    'DROP TABLE IF EXISTS _substrat_outbox',
    'ALTER TABLE _substrat_outbox ADD COLUMN sneaky TEXT',
    'CREATE TABLE _substrat_shadow (id TEXT)',
    'CREATE TABLE IF NOT EXISTS _substrat_shadow (id TEXT)',
    'CREATE INDEX _substrat_ix ON todos (id)',
    // The first thing anyone tries once a scanner is known to skip quotes.
    'INSERT INTO "_substrat_tuples" (subject) VALUES (?)',
    'INSERT INTO `_substrat_tuples` (subject) VALUES (?)',
    'INSERT INTO [_substrat_tuples] (subject) VALUES (?)',
    "INSERT INTO '_substrat_tuples' (subject) VALUES (?)",
    // Schema-qualified, and with the qualifier split across whitespace.
    'DELETE FROM main._substrat_tuples',
    'DELETE FROM main . _substrat_tuples',
    // Case is not a defence.
    'insert into _SUBSTRAT_TUPLES (subject) values (?)',
    // A forge chained after a legitimate write: the DO's `sql.exec` runs both.
    "INSERT INTO todos (id) VALUES ('t1'); INSERT INTO _substrat_tuples VALUES (?, ?, ?)",
    // A comment is not a hiding place either way round — including INSIDE a qualified
    // name, where SQLite reads a comment as whitespace and joins the parts anyway.
    '/* harmless */ UPDATE _substrat_tuples SET object = ?',
    'UPDATE -- comment\n _substrat_tuples SET object = ?',
    'UPDATE main /* qualifier */ . _substrat_tuples SET relation = ?',
    'DELETE FROM main -- qualifier\n . _substrat_tuples',
    'UPDATE main . /* after the dot */ _substrat_tuples SET relation = ?',
    // The second table a statement reaches past the one it names first. A trigger on
    // the outbox is denial of the spine rather than forgery of it, and just as reachable.
    "CREATE TRIGGER block BEFORE INSERT ON _substrat_outbox BEGIN SELECT RAISE(ABORT, 'no'); END",
    'CREATE INDEX ix ON _substrat_tuples (subject)',
    'CREATE UNIQUE INDEX IF NOT EXISTS ix ON _substrat_tuples (subject)',
    'ALTER TABLE todos RENAME TO _substrat_shadow',
    // A trigger BODY that forges is caught by the ordinary verb scan.
    'CREATE TRIGGER t AFTER INSERT ON todos BEGIN INSERT INTO _substrat_tuples VALUES (?, ?, ?); END',
    // `RETURNING` makes a write look like a read to a naive query/exec split.
    'INSERT INTO _substrat_tuples (subject) VALUES (?) RETURNING subject',
  ];

  for (const sql of forges) {
    it(sql.replace(/\s+/g, ' ').slice(0, 72), () => {
      expect(() => assertNoSpineWrite(sql)).toThrow(/cannot write the platform spine/);
    });
  }

  it('answers the taxonomy as a forbidden, naming the reason', () => {
    try {
      assertNoSpineWrite('INSERT INTO _substrat_tuples VALUES (?, ?, ?)');
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(errorCodeOf(err)).toBe('forbidden');
      expect((err as { extensions: Record<string, unknown> }).extensions.reason).toBe('spine_write');
      // The message names the table, so the author sees which line to delete.
      expect((err as Error).message).toContain('_substrat_tuples');
    }
  });
});

describe('assertNoSpineWrite: allows', () => {
  const allowed = [
    'SELECT module_id, version FROM _substrat_migrations ORDER BY module_id',
    'SELECT subject, relation, object FROM _substrat_tuples',
    "SELECT id FROM _substrat_outbox WHERE type = 'test.atomic'",
    // The projection pattern: a spine READ feeding a domain write. Only the target
    // is judged, so this must keep working.
    'INSERT INTO my_timeline (id, type) SELECT id, type FROM _substrat_events',
    'CREATE TABLE my_timeline AS SELECT id FROM _substrat_events',
    // Ordinary module writes.
    'INSERT INTO testmod_items (id, box) VALUES (?, ?)',
    "UPDATE todos SET title = ? WHERE id = ?",
    'DELETE FROM todos WHERE id = ?',
    'CREATE TABLE IF NOT EXISTS todos (id TEXT PRIMARY KEY)',
    // A string literal that merely LOOKS like a forge.
    "INSERT INTO audit_notes (body) VALUES ('INSERT INTO _substrat_tuples')",
    // Column names that start with a write verb are not write verbs.
    'SELECT created_at, updated_at FROM todos WHERE deleted_at IS NULL',
    // `replace()` the builtin, not `REPLACE INTO`.
    "SELECT replace(body, 'a', 'b') FROM _substrat_outbox",
    // A module's own trigger and index on its own tables.
    'CREATE INDEX ix_todos_owner ON todos (owner)',
    'CREATE TRIGGER touch AFTER UPDATE ON todos BEGIN UPDATE todos SET n = n + 1; END',
    'ALTER TABLE todos RENAME TO tasks',
  ];

  for (const sql of allowed) {
    it(sql.replace(/\s+/g, ' ').slice(0, 72), () => {
      expect(() => assertNoSpineWrite(sql)).not.toThrow();
    });
  }
});

describe('guardSpine', () => {
  it('checks query as well as exec — INSERT … RETURNING runs through .all()', () => {
    const inner = {
      query: vi.fn(() => []) as unknown as ScopedSql['query'],
      exec: vi.fn(() => ({ changes: 0 })),
    };
    const guarded = guardSpine(inner);

    expect(() => guarded.query('INSERT INTO _substrat_tuples VALUES (?) RETURNING subject')).toThrow();
    expect(() => guarded.exec('DELETE FROM _substrat_tuples')).toThrow();
    expect(inner.query).not.toHaveBeenCalled();
    expect(inner.exec).not.toHaveBeenCalled();
  });

  it('passes a permitted statement through untouched, params and all', () => {
    const inner = {
      query: vi.fn(() => [{ n: 1 }]) as unknown as ScopedSql['query'],
      exec: vi.fn(() => ({ changes: 3 })),
    };
    const guarded = guardSpine(inner);

    expect(guarded.query('SELECT n FROM todos WHERE id = ?', ['t1'])).toEqual([{ n: 1 }]);
    expect(inner.query).toHaveBeenCalledWith('SELECT n FROM todos WHERE id = ?', ['t1']);
    expect(guarded.exec('DELETE FROM todos WHERE id = ?', ['t1'])).toEqual({ changes: 3 });
    expect(inner.exec).toHaveBeenCalledWith('DELETE FROM todos WHERE id = ?', ['t1']);
  });
});
