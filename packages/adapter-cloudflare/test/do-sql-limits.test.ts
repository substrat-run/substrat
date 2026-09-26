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

/** The plan SQLite reads a statement by, its lines joined. */
const plan = (sql: SqlStorage, q: { sql: string; params: unknown[] }): string =>
  (sql.exec(`EXPLAIN QUERY PLAN ${q.sql}`, ...(q.params as never[])).toArray() as { detail: string }[])
    .map((r) => r.detail)
    .join(' | ');

/** `exportReadQuery` as it was before #1776: one `?` per type, no join. */
const oldExportRead = (types: readonly string[], after: string | null, limit: number) => ({
  sql:
    `SELECT * FROM _substrat_outbox WHERE type IN (${types.map(() => '?').join(', ')})` +
    (after === null ? '' : ' AND id > ?') +
    ' ORDER BY id LIMIT ?',
  params: [...types, ...(after === null ? [] : [after]), limit],
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

  // The access path the table is read by: the plan minus json_each's own lines, and minus the
  // table's name (a join aliases it). The old form, one `?` per type, is planned for a list short
  // enough to run, and must read the same way.
  const access = (detail: string): string =>
    detail.split(' | ').find((l) => l.includes('_substrat_outbox'))!.replace(/^.*?USING /, '');
  const oldForm = (q: { sql: string; params: unknown[] }, few: readonly string[]) => ({
    sql: q.sql.replace('(SELECT value FROM json_each(?))', `(${few.map(() => '?').join(', ')})`),
    params: q.params.flatMap((p): unknown[] => (p === JSON.stringify(few) ? [...few] : [p])),
  });

  for (const after of [null, `01J${'0'.repeat(22)}9`]) {
    it(`exportReadQuery reads every exported type, by the index the old form used (after: ${after})`, async () => {
      const few = types.slice(0, 3);
      const [rows, now, before] = await inScope((_i, sql) => {
        const q = exportReadQuery(types, after, 1000);
        return [
          sql.exec(q.sql, ...(q.params as never[])).toArray().length,
          plan(sql, exportReadQuery(few, after, 1000)),
          plan(sql, oldExportRead(few, after, 1000)),
        ] as const;
      });
      expect(rows).toBe(after === null ? n : n - 10);
      expect(access(now)).toBe(access(before));
      expect(access(now)).toMatch(/INDEX _substrat_outbox_type_/);
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
    expect(access(now)).toContain('INDEX _substrat_outbox_type_id');
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

/** The slice of a ControlPlaneDO the #1787 block below drives: the audit read, and the SQL it runs. */
interface ControlPlaneInstance {
  auditLog(query: { tenantId?: string; action?: string[]; limit?: number; order?: 'asc' | 'desc' }): { id: string }[];
  sql: SqlStorage;
}

/**
 * #1787: a plan that holds only while no table statistics exist is not pinned, it is lucky. A
 * platform statement never runs `ANALYZE`, but a module's `ctx.sql` can (the spine guard judges
 * write targets, not `ANALYZE`), and after it `type IN (SELECT value FROM json_each(?))` stopped
 * seeking `_substrat_outbox_type_id` and walked the primary key with a bloom filter, reading the
 * whole tail for a rare type. `exportReadQuery` has its join order pinned, and is planned here with
 * and without statistics, returning the rows the unpinned form did. The other lists are planned too.
 *
 * The rows are the issue's own shape: 20 000 of them over 50 types, read for 3 after a cursor.
 */
describe('list statements keep their index once table statistics exist (#1787)', () => {
  const rows = 20_000;
  const kinds = 50;
  const id = (i: number): string => `01J${String(i).padStart(23, '0')}`;
  const cursor = id(5_000);
  const wanted = ['probe.t1', 'probe.t2', 'probe.t3'];

  const idsOf = (sql: SqlStorage, q: { sql: string; params: unknown[] }): string[] =>
    (sql.exec(q.sql, ...(q.params as never[])).toArray() as { id: string }[]).map((r) => r.id);
  // `sqlite_stat1` does not exist until something has run ANALYZE.
  const statRows = (sql: SqlStorage): number =>
    sql.exec(`SELECT 1 FROM sqlite_master WHERE name = 'sqlite_stat1'`).toArray().length === 0
      ? 0
      : (sql.exec('SELECT COUNT(*) AS c FROM sqlite_stat1').one() as { c: number }).c;

  /** `exportReadQuery` as #1776 shipped it: `json_each` in an `IN`, and no join order. */
  const unpinnedExport = (types: readonly string[], after: string | null, limit: number) => ({
    sql:
      'SELECT * FROM _substrat_outbox WHERE type IN (SELECT value FROM json_each(?))' +
      (after === null ? '' : ' AND id > ?') +
      ' ORDER BY id LIMIT ?',
    params: [JSON.stringify(types), ...(after === null ? [] : [after]), limit],
  });
  const inScope = async <T>(fn: (sql: SqlStorage) => T): Promise<T> => {
    const stub = env.SCOPE.get(env.SCOPE.idFromName('do-sql-stats-1787'));
    return runInDurableObject(stub, (_i, state) => fn(state.storage.sql));
  };
  const inControlPlane = async <T>(fn: (i: ControlPlaneInstance, sql: SqlStorage) => T): Promise<T> => {
    const stub = env.CONTROL_PLANE.get(env.CONTROL_PLANE.idFromName('do-sql-stats-1787-cp'));
    return runInDurableObject(stub, (i, state) => fn(i as unknown as ControlPlaneInstance, state.storage.sql));
  };

  // Each read is asserted twice: before ANALYZE, where the pin must not have cost anything, and
  // after it, where the pin is the whole point. The seed below is the state both are read in
  // (its counts are written into the SQL: a bound JS number is a REAL, and `i % 50.0` is `1.0`).
  it('seeds 20 000 outbox rows over 50 types and as many admin-log entries over 50 actions and 200 tenants', async () => {
    await inScope((sql) => {
      sql.exec('DELETE FROM _substrat_outbox');
      sql.exec(
        `INSERT INTO _substrat_outbox (id, type, schema_version, occurred_at, tenant_id, scope_id, actor,
           entity_type, entity_id, pii_class)
         WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ${rows - 1})
         SELECT printf('01J%023d', i), 'probe.t' || (i % ${kinds}), 1, '2026-09-25T00:00:00.000Z', 't', 's', 'a', 'e',
                CAST(i AS TEXT), 'none' FROM n`,
      );
      expect(statRows(sql)).toBe(0);
    });
    await inControlPlane((_i, sql) => {
      sql.exec('DELETE FROM _substrat_admin_log');
      sql.exec(
        `INSERT INTO _substrat_admin_log (id, actor, action, tenant_id, scope_id, at)
         WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ${rows - 1})
         SELECT printf('01J%023d', i), 'a', 'probe.a' || (i % ${kinds}), 'probe.tenant' || (i % 200), 's', '2026-09-25T00:00:00.000Z' FROM n`,
      );
    });
  });

  // ASSESSED AND NOT PINNED: the audit log's `action IN (SELECT value FROM json_each(?))`. After an
  // ANALYZE its paged read (`id > ?`) also walks the primary key, but a CROSS JOIN pin makes the
  // action list drive even when a more selective (tenant_id, id) index applies, and with no
  // statistics, which is the control-plane DO's state, `{ tenantId, action: [common] }` went from
  // 0.03 ms to 14.7 ms. Nothing runs ANALYZE there, so a pin buys a hypothetical case with a real one.
  // This is the real one, kept: with no statistics a tenant-narrowed action filter reads the tenant's index.
  it('the audit log narrows by tenant before the action list (no statistics: the state it runs in)', async () => {
    const [ran, got] = await inControlPlane((i, sql) => {
      // Capture the statement the producer itself sends, so the plan is read off the real one.
      const real = i.sql;
      const sent: { q: string; p: unknown[] }[] = [];
      i.sql = { exec: (q: string, ...p: unknown[]) => (sent.push({ q, p }), real.exec(q, ...(p as never[]))) } as SqlStorage;
      let entries: { id: string }[];
      try {
        entries = i.auditLog({ tenantId: 'probe.tenant1', action: ['probe.a1', 'probe.a2'], order: 'desc', limit: 50 });
      } finally {
        i.sql = real;
      }
      const last = sent.at(-1)!;
      return [plan(sql, { sql: last.q, params: last.p }), entries] as const;
    });
    expect(ran).toContain('_substrat_admin_log_tenant (tenant_id=?)');
    expect(got.length).toBeGreaterThan(0);
  });

  const exportSeek = /_substrat_outbox_type_id \(type=\? AND id>\?\)/;

  for (const phase of ['without statistics', 'after ANALYZE'] as const) {
    if (phase === 'after ANALYZE') {
      it('ANALYZE runs on a Durable Object and leaves statistics behind (the premise)', async () => {
        await inScope((sql) => {
          sql.exec('ANALYZE');
          expect(statRows(sql)).toBeGreaterThan(0);
        });
        await inControlPlane((_i, sql) => {
          sql.exec('ANALYZE');
          expect(statRows(sql)).toBeGreaterThan(0);
        });
      });
    }

    it(`exportReadQuery seeks (type, id) and returns what the old forms did (${phase})`, async () => {
      const [now, pinned, unpinned, listed] = await inScope((sql) => {
        // A repeated type is in the list on purpose: `IN` is a set test, and the read must stay one.
        const q = exportReadQuery([...wanted, 'probe.t1'], cursor, 1000);
        return [
          plan(sql, q),
          idsOf(sql, q),
          idsOf(sql, unpinnedExport(wanted, cursor, 1000)),
          idsOf(sql, oldExportRead(wanted, cursor, 1000)),
        ] as const;
      });
      expect(now).toMatch(exportSeek);
      expect(now).not.toContain('sqlite_autoindex__substrat_outbox');
      expect(pinned).toHaveLength(3 * (rows / kinds - 100));
      expect(pinned).toEqual(unpinned);
      expect(pinned).toEqual(listed);
      expect(pinned).toEqual([...pinned].sort());
      expect(new Set(pinned).size).toBe(pinned.length);
    });

    it(`exportReadQuery without a cursor seeks by type as well, and pages by LIMIT (${phase})`, async () => {
      const [now, page, expected] = await inScope((sql) => {
        const q = exportReadQuery(wanted, null, 7);
        return [plan(sql, q), idsOf(sql, q), idsOf(sql, oldExportRead(wanted, null, 7))] as const;
      });
      expect(now).toMatch(/_substrat_outbox_type_(at|id) \(type=\?\)/);
      expect(page).toHaveLength(7);
      expect(page).toEqual(expected);
    });
  }

  // The other `json_each` lists #1776 introduced, planned after statistics. None lost its index,
  // so none is pinned; this is the record that each was looked at, and the alarm if one starts to.
  it('the lists that need no pin keep their access path after ANALYZE', async () => {
    const [scope, cp] = await Promise.all([
      inScope((sql) => {
        const at = (q: string, ...p: unknown[]) => plan(sql, { sql: q, params: p });
        const ids = JSON.stringify([id(1), id(2)]);
        return {
          drain: at(
            'SELECT COUNT(*) AS c FROM _substrat_outbox WHERE drained_at IS NULL AND id IN (SELECT value FROM json_each(?))',
            ids,
          ),
          freshnessObserved: at(
            'SELECT type, MAX(occurred_at) AS at FROM _substrat_outbox WHERE type IN (SELECT value FROM json_each(?)) GROUP BY type',
            JSON.stringify(wanted),
          ),
          freshnessState: at(
            `SELECT schedule_op, last_run_at, last_status FROM _substrat_schedule_state
              WHERE kind = 'freshness' AND schedule_op IN (SELECT value FROM json_each(?))`,
            JSON.stringify(wanted.map((t) => `freshness:${t}`)),
          ),
          exportedSince: at(exportedSinceQuery(wanted, rows - 1000).sql, ...exportedSinceQuery(wanted, rows - 1000).params),
        };
      }),
      inControlPlane((_i, sql) => {
        const at = (q: string, ...p: unknown[]) => plan(sql, { sql: q, params: p });
        return {
          // `scopes` has no index on `status`: a fleet read narrows by tenant, or scans, with or without statistics.
          fleetByTenant: at(
            'SELECT * FROM scopes WHERE tenant_id = ? AND status IN (SELECT value FROM json_each(?)) AND scope_id > ? ORDER BY scope_id LIMIT ?',
            't', JSON.stringify(['suspended']), 'S', 100,
          ),
        };
      }),
    ]);
    expect(scope.drain).toContain('_substrat_outbox_drained (drained_at=? AND id=?)');
    expect(scope.freshnessObserved).toMatch(/_substrat_outbox_type_(at|id) \(type=\?\)/);
    expect(scope.freshnessState).toContain('sqlite_autoindex__substrat_schedule_state_1 (kind=? AND schedule_op=?)');
    // `exportedSinceQuery` seeks the rowid after ANALYZE, as its own doc says: it walks only what the invoke added.
    expect(scope.exportedSince).toContain('INTEGER PRIMARY KEY (rowid>?)');
    expect(cp.fleetByTenant).toContain('scopes_tenant (tenant_id=? AND scope_id>?)');
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
