import { describe, expect, it } from 'vitest';
import { executableSqlStatements, splitSqlStatements } from '../src/index.js';

/**
 * #2068, Codex #2084 r4 — the splitter's own contract: original substrings, nothing glued, and an
 * unterminated string ending the input. Its agreement with SQLite on every boundary case is
 * `adapter-sqlite/test/split-sql-differential.test.ts` (better-sqlite3) and
 * `adapter-cloudflare/test/split-sql.test.ts` (workerd), over `SPLIT_CASES` in the contract kit.
 */
describe('splitSqlStatements (#2068)', () => {
  it('returns each statement as its original text — comments kept, nothing glued', () => {
    expect(splitSqlStatements('CREATE/*c*/TABLE t(a); -- note;\nINSERT INTO t VALUES(1);')).toEqual([
      'CREATE/*c*/TABLE t(a)',
      '-- note;\nINSERT INTO t VALUES(1)',
    ]);
  });

  it('ends the input as one statement at an unterminated string, for SQLite to refuse', () => {
    expect(splitSqlStatements("SELECT 1; SELECT 'open")).toEqual(['SELECT 1', "SELECT 'open"]);
  });

  it('executable text blanks every comment to equal-length whitespace, keeps newlines, and leaves strings alone', () => {
    const sql = "CREATE/*c*/TABLE t(a, -- note\n b DEFAULT '-- kept /* too */'); -- tail;\nINSERT INTO \"x--y\" VALUES(1);";
    const exec = executableSqlStatements(sql);
    const text = splitSqlStatements(sql);
    expect(exec).toEqual([
      "CREATE     TABLE t(a,        \n b DEFAULT '-- kept /* too */')",
      'INSERT INTO "x--y" VALUES(1)',
    ]);
    // The same boundaries as the original text, statement for statement.
    expect(exec).toHaveLength(text.length);
    expect(text[0]).toContain('/*c*/');
  });

  it('reads identifiers spelled like Object.prototype members as ordinary words', () => {
    expect(splitSqlStatements('CREATE TABLE constructor(toString); INSERT INTO constructor VALUES(1);')).toEqual([
      'CREATE TABLE constructor(toString)',
      'INSERT INTO constructor VALUES(1)',
    ]);
  });
});
