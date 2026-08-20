import { describe, it, expect } from 'vitest';
import { splitSqlStatements } from '../src/scope-do.js';

/**
 * The migration splitter — the Durable Object runs one statement per `exec`, so a
 * migration blob is split on `;`. These pin the cases a naive `split(';')` gets
 * wrong, which made a migration that passed on SQLite fail only on DO.
 */
describe('splitSqlStatements', () => {
  it('splits plain statements on top-level semicolons', () => {
    expect(splitSqlStatements('CREATE TABLE a (x TEXT); CREATE TABLE b (y TEXT);')).toEqual([
      'CREATE TABLE a (x TEXT)',
      'CREATE TABLE b (y TEXT)',
    ]);
  });

  it('does not split on a semicolon inside a line comment', () => {
    const out = splitSqlStatements('CREATE TABLE a (x TEXT); -- items; keyed by id\nCREATE TABLE b (y TEXT);');
    expect(out).toEqual(['CREATE TABLE a (x TEXT)', 'CREATE TABLE b (y TEXT)']);
  });

  it('does not split on a semicolon inside a block comment', () => {
    const out = splitSqlStatements('CREATE TABLE a (x TEXT);/* a; b; c */CREATE TABLE b (y TEXT);');
    expect(out).toEqual(['CREATE TABLE a (x TEXT)', 'CREATE TABLE b (y TEXT)']);
  });

  it('does not split on a semicolon inside a string literal', () => {
    const out = splitSqlStatements("CREATE TABLE a (b TEXT DEFAULT 'n/a; see item'); CREATE TABLE c (d TEXT);");
    expect(out).toEqual(["CREATE TABLE a (b TEXT DEFAULT 'n/a; see item')", 'CREATE TABLE c (d TEXT)']);
  });

  it("handles the '' escaped-quote inside a string literal", () => {
    const out = splitSqlStatements("INSERT INTO t VALUES ('it''s; fine'); SELECT 1;");
    expect(out).toEqual(["INSERT INTO t VALUES ('it''s; fine')", 'SELECT 1']);
  });

  /**
   * #827. The derived search index is the first thing in the repo to emit a
   * trigger, and its body's semicolons are not top level: split on them and the
   * DO gets four fragments that are each "incomplete input". This passed on
   * better-sqlite3 (one `exec`, whole blob) and failed every scope on DO.
   */
  it('keeps a trigger body whole, splitting only after its END', () => {
    const out = splitSqlStatements(
      `CREATE TRIGGER idx_au AFTER UPDATE ON t BEGIN
         INSERT INTO idx(idx, rowid, name) VALUES('delete', old.rowid, old.name);
         INSERT INTO idx(rowid, name) VALUES (new.rowid, new.name);
       END;
       INSERT INTO idx(idx) VALUES('rebuild');`,
    );
    expect(out).toHaveLength(2);
    expect(out[0]).toMatch(/^CREATE TRIGGER idx_au/);
    expect(out[0]).toMatch(/END$/);
    expect(out[1]).toBe("INSERT INTO idx(idx) VALUES('rebuild')");
  });

  it('splits a statement that merely MENTIONS a trigger like any other', () => {
    expect(splitSqlStatements('DROP TRIGGER IF EXISTS idx_ai; DROP TABLE idx;')).toEqual([
      'DROP TRIGGER IF EXISTS idx_ai',
      'DROP TABLE idx',
    ]);
  });

  it('drops comments and never emits a comment-only statement', () => {
    // A trailing comment after the last statement must not become its own exec
    // (a comment-only input is "incomplete input" to SQLite).
    const out = splitSqlStatements('CREATE TABLE a (x TEXT);\n-- trailing note; nothing after\n');
    expect(out).toEqual(['CREATE TABLE a (x TEXT)']);
  });

  it('accepts a final statement with no trailing semicolon', () => {
    expect(splitSqlStatements('CREATE TABLE a (x TEXT)')).toEqual(['CREATE TABLE a (x TEXT)']);
  });

  it('ignores blank fragments from empty statements', () => {
    expect(splitSqlStatements('CREATE TABLE a (x TEXT);;\n\n;  CREATE TABLE b (y TEXT);')).toEqual([
      'CREATE TABLE a (x TEXT)',
      'CREATE TABLE b (y TEXT)',
    ]);
  });
});
