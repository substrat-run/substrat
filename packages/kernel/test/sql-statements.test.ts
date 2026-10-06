import { describe, expect, it } from 'vitest';
import { splitSqlStatements } from '../src/index.js';

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
});
