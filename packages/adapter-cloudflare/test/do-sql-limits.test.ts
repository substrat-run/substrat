import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { DO_SQL_LIMITS } from '@substrat-run/kernel';

/**
 * WHERE the SQL limits in `DO_SQL_LIMITS` come from (#1741): measured, on a real Durable Object's
 * SQLite, by growing a statement until it is refused. They are not from documentation. The node
 * adapter enforces the same values on `ctx.sql` (`guardSqlLimits`) and
 * `contract-tests/src/sql-limits-suite.ts` proves the two refuse the same statements with the
 * same words — but that parity is only as good as these numbers, so this file is what goes red
 * first if workerd moves one.
 *
 * Each limit is FOUND by bisection over a range wide enough to be a sane bound (stock SQLite
 * allows 500 terms, 32 766 parameters and 1 GB of SQL; every range here reaches past stock's
 * compound and variable limits), then compared with the constant. The ranges are kept close to the known values (a few times the limit,
 * not stock SQLite's 500 terms or 1 GB): a probe that builds megabyte statements against a runtime
 * shared with every other file in the pool is the wrong place to look for where a limit ends.
 */

type Trial = (n: number) => { sql: string; params?: unknown[] };

// ONE Durable Object for the file, on a name of its own: a fresh object per probe left a dozen
// abandoned instances behind in the shared runtime for the next file to re-patch around.
const run = async <T>(fn: (sql: SqlStorage) => T): Promise<T> => {
  const stub = env.SCOPE.get(env.SCOPE.idFromName('do-sql-limits'));
  return runInDurableObject(stub, (_instance, state) => fn(state.storage.sql));
};

const attempt = (sql: SqlStorage, t: Trial, n: number): string => {
  const { sql: q, params = [] } = t(n);
  try {
    sql.exec(q, ...(params as never[])).toArray();
    return 'ok';
  } catch (e) {
    return (e as Error).message;
  }
};

/** The largest n in [1, hi] that runs, and what n + 1 said. Throws if `hi` itself runs. */
const limitOf = (sql: SqlStorage, t: Trial, hi: number): { max: number; refusal: string } => {
  if (attempt(sql, t, hi) === 'ok') throw new Error(`no limit found up to ${hi}`);
  let lo = 1;
  let top = hi;
  while (lo < top - 1) {
    const mid = (lo + top) >> 1;
    if (attempt(sql, t, mid) === 'ok') lo = mid;
    else top = mid;
  }
  return { max: lo, refusal: attempt(sql, t, lo + 1) };
};

const terms = (n: number, op: string): string => Array.from({ length: n }, (_, i) => `SELECT ${i}`).join(` ${op} `);
const marks = (n: number): string => Array.from({ length: n }, () => '?').join(',');

describe('the SQL limits of a Durable Object, measured (#1741)', () => {
  for (const op of ['UNION ALL', 'UNION', 'INTERSECT', 'EXCEPT']) {
    it(`compound SELECT terms: ${op}`, async () => {
      const found = await run((sql) => limitOf(sql, (n) => ({ sql: terms(n, op) }), 60));
      expect(found.max).toBe(DO_SQL_LIMITS.compoundTerms);
      expect(found.refusal).toBe('too many terms in compound SELECT: SQLITE_ERROR');
    });
  }

  it('a multi-row VALUES list is NOT a compound: 1 000 rows run', async () => {
    const outcomes = await run((sql) => [
      attempt(sql, (n) => ({ sql: `SELECT * FROM (VALUES ${Array.from({ length: n }, () => '(1)').join(',')})` }), 1000),
      attempt(sql, (n) => ({ sql: `SELECT * FROM (VALUES ${Array.from({ length: n }, () => '(?)').join(',')})`, params: Array(n).fill(1) }), DO_SQL_LIMITS.boundParameters),
    ]);
    expect(outcomes).toEqual(['ok', 'ok']);
  });

  it('a subquery, a CTE body and the statement around them each count their own terms', async () => {
    const at = DO_SQL_LIMITS.compoundTerms;
    const outcome = await run((sql) =>
      attempt(sql, () => ({ sql: `WITH c AS (${terms(at, 'UNION ALL')}) SELECT * FROM (${terms(at, 'UNION ALL')}) UNION ALL ${terms(at - 1, 'UNION ALL')}` }), 1),
    );
    expect(outcome).toBe('ok');
  });

  it('bound parameters', async () => {
    const found = await run((sql) =>
      limitOf(sql, (n) => ({ sql: `SELECT 1 WHERE 1 IN (${marks(n)})`, params: Array(n).fill(1) }), 400),
    );
    expect(found.max).toBe(DO_SQL_LIMITS.boundParameters);
    // The offset is the byte where the first `?` past the limit starts.
    const offset = 'SELECT 1 WHERE 1 IN ('.length + 2 * DO_SQL_LIMITS.boundParameters;
    expect(found.refusal).toBe(`too many SQL variables at offset ${offset}: SQLITE_ERROR`);
  });

  it('the way round the limit: one JSON array through json_each carries any number of values', async () => {
    const ids = Array.from({ length: DO_SQL_LIMITS.boundParameters * 5 }, (_, i) => `id-${i}`);
    const count = await run(
      (sql) =>
        sql
          .exec(`SELECT COUNT(*) AS n FROM (SELECT 'id-3' AS id UNION ALL SELECT 'id-499' UNION ALL SELECT 'other') WHERE id IN (SELECT value FROM json_each(?))`, JSON.stringify(ids))
          .one().n,
    );
    expect(count).toBe(2);
  });

  it('a numbered parameter past the limit', async () => {
    const outcome = await run((sql) =>
      attempt(sql, (n) => ({ sql: `SELECT ?${n}`, params: Array(n).fill(1) }), DO_SQL_LIMITS.boundParameters + 1),
    );
    expect(outcome).toBe(`variable number must be between ?1 and ?${DO_SQL_LIMITS.boundParameters} at offset 7: SQLITE_ERROR`);
  });

  it('a named parameter counts once however often it is written', async () => {
    const outcome = await run((sql) =>
      attempt(sql, (n) => ({ sql: `SELECT ${Array.from({ length: n }, () => ':a').join('+')}`, params: [1] }), 60),
    );
    expect(outcome).toBe('ok');
  });

  it('statement length: the whole string, in bytes', async () => {
    const found = await run((sql) => limitOf(sql, (n) => ({ sql: `SELECT '${'a'.repeat(n)}'` }), 250_000));
    // `SELECT ''` is 9 bytes around the literal.
    expect(found.max + "SELECT ''".length).toBe(DO_SQL_LIMITS.statementBytes);
    expect(found.refusal).toBe('statement too long: SQLITE_TOOBIG');
  });

  it('statement length: two statements in one string count together', async () => {
    // Each half is well under the limit alone; together they are over it.
    const half = `SELECT '${'a'.repeat(DO_SQL_LIMITS.statementBytes * 0.6)}'`;
    const outcomes = await run((sql) => [
      attempt(sql, () => ({ sql: half }), 1),
      attempt(sql, () => ({ sql: `${half}; ${half}` }), 1),
    ]);
    expect(outcomes).toEqual(['ok', 'statement too long: SQLITE_TOOBIG']);
  });

  it('LIKE pattern length: the limit the node preload enforces', async () => {
    const found = await run((sql) =>
      limitOf(sql, (n) => ({ sql: `SELECT 'x' LIKE ?`, params: ['%' + 'a'.repeat(n) + '%'] }), 200),
    );
    // n characters between two `%`.
    expect(found.max + 2).toBe(DO_SQL_LIMITS.likePatternBytes);
    expect(found.refusal).toBe('LIKE or GLOB pattern too complex: SQLITE_ERROR');
  });
});
