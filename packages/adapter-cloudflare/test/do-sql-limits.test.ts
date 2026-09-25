import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { DO_SQL_LIMITS, exportedSinceQuery, exportReadQuery } from '@substrat-run/kernel';

declare const __PROBE_DO_LIMITS__: boolean;

/**
 * WHERE the SQL limits in `DO_SQL_LIMITS` come from (#1741): measured, on a real Durable Object's
 * SQLite, not read from documentation. The node adapter enforces the same values on `ctx.sql`
 * (`guardSqlLimits`) and `contract-tests/src/sql-limits-suite.ts` proves the two refuse the same
 * statements with the same words. That parity is only as good as these numbers, so this file is
 * what goes red first if workerd moves one.
 *
 * Two halves, because they answer different questions:
 *
 *  - **The boundary** (always runs): each limit is exactly passable and one past it is refused with
 *    the pinned message. It is a pin, not a search, so it builds only statements at the limit.
 *  - **The measurement** (opt in: `SUBSTRAT_PROBE_DO_LIMITS=1 pnpm --filter
 *    @substrat-run/adapter-cloudflare test`): FINDS each limit by growing a statement until the
 *    Durable Object refuses it, over a range wide of the pinned value. Re-run it when workerd is
 *    bumped, and update `DO_SQL_LIMITS` if a number moved. It is not in CI because it crashed the
 *    Linux workerd there (`kj/table.c++: HashIndex detected hash table inconsistency`, then
 *    SIGSEGV, in the shared pool) on every run of #1758 that included it, and on none without it,
 *    while macOS ran it clean. The trigger is one of its search patterns, not the boundary statements
 *    above (which run in CI, and in `contract.test.ts`). It is a workerd fault, not a limit.
 *    The opt-in is decided in `vitest.config.ts`, because `process.env` inside workerd is not the
 *    runner's.
 */

type Trial = (n: number) => { sql: string; params?: unknown[] };

// ONE Durable Object for the file, on a name of its own.
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

const terms = (n: number, op: string): string => Array.from({ length: n }, (_, i) => `SELECT ${i}`).join(` ${op} `);
const marks = (n: number): string => Array.from({ length: n }, () => '?').join(',');

const { compoundTerms, boundParameters, statementBytes, likePatternBytes } = DO_SQL_LIMITS;
const compoundTrial = (op: string): Trial => (n) => ({ sql: terms(n, op) });
const paramTrial: Trial = (n) => ({ sql: `SELECT 1 WHERE 1 IN (${marks(n)})`, params: Array(n).fill(1) });
const lengthTrial: Trial = (n) => ({ sql: `SELECT '${'a'.repeat(n - "SELECT ''".length)}'` });
const likeTrial: Trial = (n) => ({ sql: `SELECT 'x' LIKE ?`, params: ['%' + 'a'.repeat(n - 2) + '%'] });

describe('the SQL limits of a Durable Object: the boundary (#1741)', () => {
  for (const op of ['UNION ALL', 'UNION', 'INTERSECT', 'EXCEPT']) {
    it(`compound SELECT terms: ${compoundTerms} ${op} terms run, one more is refused`, async () => {
      const [at, past] = await run((sql) => [
        attempt(sql, compoundTrial(op), compoundTerms),
        attempt(sql, compoundTrial(op), compoundTerms + 1),
      ]);
      expect(at).toBe('ok');
      expect(past).toBe('too many terms in compound SELECT: SQLITE_ERROR');
    });
  }

  it('a multi-row VALUES list is NOT a compound', async () => {
    const outcome = await run((sql) =>
      attempt(sql, (n) => ({ sql: `SELECT * FROM (VALUES ${Array.from({ length: n }, () => '(?)').join(',')})`, params: Array(n).fill(1) }), boundParameters),
    );
    expect(outcome).toBe('ok');
  });

  it('a subquery, a CTE body and the statement around them each count their own terms', async () => {
    const outcome = await run((sql) =>
      attempt(
        sql,
        () => ({
          sql: `WITH c AS (${terms(compoundTerms, 'UNION ALL')}) SELECT * FROM (${terms(compoundTerms, 'UNION ALL')}) UNION ALL ${terms(compoundTerms - 1, 'UNION ALL')}`,
        }),
        1,
      ),
    );
    expect(outcome).toBe('ok');
  });

  it('bound parameters: 100 run, the 101st is refused at its own byte offset', async () => {
    const [at, past] = await run((sql) => [attempt(sql, paramTrial, boundParameters), attempt(sql, paramTrial, boundParameters + 1)]);
    expect(at).toBe('ok');
    expect(past).toBe(`too many SQL variables at offset ${'SELECT 1 WHERE 1 IN ('.length + 2 * boundParameters}: SQLITE_ERROR`);
  });

  it('a numbered parameter past the limit', async () => {
    const outcome = await run((sql) =>
      attempt(sql, (n) => ({ sql: `SELECT ?${n}`, params: Array(n).fill(1) }), boundParameters + 1),
    );
    expect(outcome).toBe(`variable number must be between ?1 and ?${boundParameters} at offset 7: SQLITE_ERROR`);
  });

  it('a named parameter counts once however often it is written', async () => {
    const outcome = await run((sql) =>
      attempt(sql, (n) => ({ sql: `SELECT ${Array.from({ length: n }, () => ':a').join('+')}`, params: [1] }), 60),
    );
    expect(outcome).toBe('ok');
  });

  it('an extended $name (:: and a (…) suffix) is ONE parameter: 100 distinct ones run, 101 are refused', async () => {
    const extended: Trial = (n) => ({
      sql: `SELECT 1 WHERE 1 IN (${Array.from({ length: n }, (_, i) => `$ns${i}::part${i}(arg${i})`).join(',')})`,
      params: Array(n).fill(1),
    });
    const [at, past] = await run((sql) => [attempt(sql, extended, boundParameters), attempt(sql, extended, boundParameters + 1)]);
    expect(at).toBe('ok');
    expect(past).toMatch(/^too many SQL variables at offset \d+: SQLITE_ERROR$/);
  });

  it('the way round the limit: one JSON array through json_each carries any number of values', async () => {
    const ids = Array.from({ length: boundParameters * 5 }, (_, i) => `id-${i}`);
    const count = await run(
      (sql) =>
        sql
          .exec(`SELECT COUNT(*) AS n FROM (SELECT 'id-3' AS id UNION ALL SELECT 'id-499' UNION ALL SELECT 'other') WHERE id IN (SELECT value FROM json_each(?))`, JSON.stringify(ids))
          .one().n,
    );
    expect(count).toBe(2);
  });

  it('statement length: exactly 100 000 bytes run, one more is refused', async () => {
    const [at, past] = await run((sql) => [attempt(sql, lengthTrial, statementBytes), attempt(sql, lengthTrial, statementBytes + 1)]);
    expect(at).toBe('ok');
    expect(past).toBe('statement too long: SQLITE_TOOBIG');
  });

  it('LIKE pattern length: 50 bytes run, one more is refused', async () => {
    const [at, past] = await run((sql) => [attempt(sql, likeTrial, likePatternBytes), attempt(sql, likeTrial, likePatternBytes + 1)]);
    expect(at).toBe('ok');
    expect(past).toBe('LIKE or GLOB pattern too complex: SQLITE_ERROR');
  });
});

/** The slice of the ScopeDO's RPC surface the #1776 block below calls directly. */
interface ScopeInstance {
  freshnessProbe(types: string[]): Promise<Record<string, { observedAt: string | null; stateOutcome: string | null }>>;
}

/**
 * #1776: the platform's own statements that take a list bind it as ONE JSON array, so a list
 * longer than `boundParameters` runs. These lists are bounded by what a manifest declares, not
 * by a constant, so each is run here at 1.5 × the limit against a real ScopeDO's spine. The
 * plan is pinned too, because the conversion must not cost the index the old `IN (?, …)` used.
 * No stats exist in a scope (nothing runs ANALYZE), which is the state these plans are read in.
 */
describe('platform list statements past the parameter limit (#1776)', () => {
  const n = Math.floor(boundParameters * 1.5);
  const types = Array.from({ length: n }, (_, i) => `probe.t${i}`);
  const inScope = async <T>(fn: (instance: ScopeInstance, sql: SqlStorage) => T | Promise<T>): Promise<T> => {
    const stub = env.SCOPE.get(env.SCOPE.idFromName('do-sql-lists-1776'));
    return runInDurableObject(stub, (instance, state) => fn(instance as unknown as ScopeInstance, state.storage.sql));
  };
  const plan = (sql: SqlStorage, q: { sql: string; params: unknown[] }): string =>
    (sql.exec(`EXPLAIN QUERY PLAN ${q.sql}`, ...(q.params as never[])).toArray() as { detail: string }[])
      .map((r) => r.detail)
      .join(' | ');

  // One event of every type, and a freshness verdict for every type: the lists below then
  // have a row to find for each entry, so a count that stopped at 100 would be visible.
  it('seeds one event and one freshness verdict per type', async () => {
    await inScope((_i, sql) => {
      sql.exec('DELETE FROM _substrat_outbox');
      types.forEach((type, i) => {
        sql.exec(
          `INSERT INTO _substrat_outbox (id, type, schema_version, occurred_at, tenant_id, scope_id, actor,
             entity_type, entity_id, pii_class) VALUES (?, ?, 1, ?, 't', 's', 'a', 'e', ?, 'none')`,
          `01J${String(i).padStart(23, '0')}`,
          type,
          `2026-09-25T00:00:${String(i % 60).padStart(2, '0')}.000Z`,
          String(i),
        );
        sql.exec(
          `INSERT OR REPLACE INTO _substrat_schedule_state (kind, schedule_op, last_run_at, last_status)
             VALUES ('freshness', ?, '2026-09-25T00:00:00.000Z', 'ok')`,
          `freshness:${type}`,
        );
      });
    });
  });

  it('freshnessProbe answers every declared type, observed and recorded', async () => {
    const probe = await inScope((instance) => instance.freshnessProbe(types));
    expect(Object.keys(probe)).toHaveLength(n);
    expect(Object.values(probe).every((p) => p.observedAt !== null && p.stateOutcome === 'ok')).toBe(true);
  });

  // The access path the table is read by: the plan minus json_each's own lines. The old form,
  // one `?` per type, is planned for a list short enough to run, and must read the same way.
  const access = (detail: string): string => detail.split(' | ').find((l) => l.includes('_substrat_outbox'))!;
  const oldForm = (q: { sql: string; params: unknown[] }, few: readonly string[]) => ({
    sql: q.sql.replace('(SELECT value FROM json_each(?))', `(${few.map(() => '?').join(', ')})`),
    params: q.params.flatMap((p): unknown[] => (p === JSON.stringify(few) ? [...few] : [p])),
  });

  for (const after of [null, `01J${'0'.repeat(22)}9`]) {
    it(`exportReadQuery reads every exported type, by the index the old form used (after: ${after})`, async () => {
      const few = types.slice(0, 3);
      const [rows, now, before] = await inScope((_i, sql) => {
        const q = exportReadQuery(types, after, 1000);
        const small = exportReadQuery(few, after, 1000);
        return [sql.exec(q.sql, ...(q.params as never[])).toArray().length, plan(sql, small), plan(sql, oldForm(small, few))] as const;
      });
      expect(rows).toBe(after === null ? n : n - 10);
      expect(access(now)).toBe(access(before));
      expect(access(now)).toMatch(/USING (COVERING )?INDEX _substrat_outbox_type_/);
    });
  }

  it('exportedSinceQuery counts every exported type past the mark, by the index the old form used', async () => {
    const few = types.slice(0, 3);
    const [count, now, before] = await inScope((_i, sql) => {
      const q = exportedSinceQuery(types, 0);
      const small = exportedSinceQuery(few, 0);
      return [(sql.exec(q.sql, ...(q.params as never[])).one() as { n: number }).n, plan(sql, small), plan(sql, oldForm(small, few))] as const;
    });
    expect(count).toBe(n);
    expect(access(now)).toBe(access(before));
  });

  it('the drain stamp counts by the (drained_at, id) index, as the old form did', async () => {
    const few = ['a', 'b', 'c'];
    const [now, before] = await inScope((_i, sql) => {
      const small = {
        sql: 'SELECT COUNT(*) AS c FROM _substrat_outbox WHERE drained_at IS NULL AND id IN (SELECT value FROM json_each(?))',
        params: [JSON.stringify(few)],
      };
      return [plan(sql, small), plan(sql, oldForm(small, few))] as const;
    });
    expect(access(now)).toBe(access(before));
    expect(access(now)).toContain('_substrat_outbox_drained');
  });
});

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

describe.skipIf(!__PROBE_DO_LIMITS__)('the SQL limits of a Durable Object: the measurement (opt in, #1741)', () => {
  for (const op of ['UNION ALL', 'UNION', 'INTERSECT', 'EXCEPT']) {
    it(`finds the compound term limit: ${op}`, async () => {
      const found = await run((sql) => limitOf(sql, compoundTrial(op), 60));
      expect(found.max).toBe(compoundTerms);
    });
  }

  it('finds the bound parameter limit', async () => {
    const found = await run((sql) => limitOf(sql, paramTrial, 400));
    expect(found.max).toBe(boundParameters);
  });

  it('finds the statement length limit', async () => {
    const found = await run((sql) => limitOf(sql, lengthTrial, 250_000));
    expect(found.max).toBe(statementBytes);
  });

  it('finds the LIKE pattern limit', async () => {
    const found = await run((sql) => limitOf(sql, likeTrial, 200));
    expect(found.max).toBe(likePatternBytes);
  });

  it('a VALUES list of a thousand rows runs', async () => {
    const outcome = await run((sql) =>
      attempt(sql, (n) => ({ sql: `SELECT * FROM (VALUES ${Array.from({ length: n }, () => '(1)').join(',')})` }), 1000),
    );
    expect(outcome).toBe('ok');
  });

  it('statement length: two statements in one string count together', async () => {
    const half = `SELECT '${'a'.repeat(statementBytes * 0.6)}'`;
    const outcomes = await run((sql) => [attempt(sql, () => ({ sql: half }), 1), attempt(sql, () => ({ sql: `${half}; ${half}` }), 1)]);
    expect(outcomes).toEqual(['ok', 'statement too long: SQLITE_TOOBIG']);
  });
});
