/**
 * #1722 (Codex #2008 r2): the write revision a carry's conditional restore is fenced on. It is
 * advanced by the scope DO's one SQL handle for every statement `isWriteStatement` counts, so the
 * classifier has to count every write (an UPDATE in place included) and may only skip reads.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isWriteStatement } from '../src/carried-copy.js';

describe('isWriteStatement (#1722)', () => {
  it.each([
    'INSERT INTO t (a) VALUES (1)',
    'UPDATE _substrat_outbox SET drained_at = ? WHERE id IN (?)',
    'update _substrat_outbox set drained_at = NULL where drained_at < ?',
    'DELETE FROM t',
    'REPLACE INTO t VALUES (1)',
    'CREATE TABLE t (a)',
    'DROP TABLE IF EXISTS "t"',
    'ALTER TABLE t ADD COLUMN b',
    '  -- a comment\n  INSERT INTO t VALUES (1)',
    '/* lead */ UPDATE t SET a = 1',
    'WITH x AS (SELECT 1) INSERT INTO t SELECT * FROM x',
    'WITH x AS (SELECT id FROM t) DELETE FROM t WHERE id IN (SELECT id FROM x)',
    'SELECT 1; DELETE FROM t',
    'INSERT INTO t VALUES (1) RETURNING a',
    'VACUUM',
  ])('counts %j as a write', (sql) => {
    expect(isWriteStatement(sql)).toBe(true);
  });

  it.each([
    'SELECT * FROM t',
    'select value from _substrat_meta where key = ?',
    '  SELECT 1',
    'WITH RECURSIVE r(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM r WHERE x < 3) SELECT x FROM r',
    'EXPLAIN QUERY PLAN SELECT * FROM t',
    'PRAGMA defer_foreign_keys = ON',
    '-- only a comment',
    '',
  ])('does not count %j', (sql) => {
    expect(isWriteStatement(sql)).toBe(false);
  });
});

/**
 * The chokepoint, held: the scope DO takes its SQL handle in exactly one place, wrapped. A second
 * raw `ctx.storage.sql` would be a writer the revision never sees, which is the hole this closes.
 * (adapter-cloudflare's own suite runs in workerd and cannot read a source file.)
 */
describe("the scope DO's one SQL handle counts writes (#1722)", () => {
  const source = readFileSync(join(import.meta.dirname, '../../adapter-cloudflare/src/scope-do.ts'), 'utf8');

  it('takes `ctx.storage.sql` once, through revisionCounting', () => {
    expect(source.match(/storage\.sql\b/g)).toEqual(['storage.sql']);
    expect(source).toMatch(/this\.sql = revisionCounting\(ctx\.storage\.sql,/);
  });
});
