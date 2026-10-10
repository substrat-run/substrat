import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import { entityGrantShape } from '@substrat-run/contracts';
import { shapeReconcilePlans } from '@substrat-run/contract-tests';
import { topUpEntityGrantShapes, ulid, type ShapeCursor } from '@substrat-run/kernel';
import { switchSqlOver } from '../src/scope-do.js';

/**
 * #2083 on the SQLite a scope Durable Object runs: the shape reconcile reads markers on
 * `_substrat_tuples_shape_marker`, never by scanning the tuple table, and a DO built before the
 * index gets it on its next wake (KERNEL_DDL runs in the constructor, every wake). The probe in
 * `@substrat-run/contract-tests` drives the kernel's own passes over this DO's real schema and
 * has workerd plan every statement they send. adapter-sqlite's `shape-marker-index.test.ts` is
 * the same on node.
 */
const INDEX = '_substrat_tuples_shape_marker';

// A fresh `env.SCOPE.get` each time: `state.abort()` poisons the stub it was called through.
const stubOf = (name: string) => env.SCOPE.get(env.SCOPE.idFromName(name));
const indexSql = (sql: SqlStorage) =>
  sql.exec("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?", INDEX).toArray()[0]?.['sql'] ?? null;

function expectOnIndexes(name: string) {
  return runInDurableObject(stubOf(name), (_instance, state) => {
    const report = shapeReconcilePlans(switchSqlOver(state.storage.sql), { tenantId: ulid(), scopeId: ulid() });
    expect(report.complete).toBe(true);
    expect(report.passes).toBeGreaterThan(1);
    expect(report.walks.length).toBeGreaterThan(0);
    for (const plan of report.walks) {
      expect(plan).toMatch(new RegExp(`SEARCH m USING (COVERING )?INDEX ${INDEX} \\(\\(object,subject\\)>\\(\\?,\\?\\) AND object<\\?\\)`));
      expect(plan).not.toMatch(/TEMP B-TREE FOR ORDER BY/);
    }
    // #2154: the backfill reads each holder kind in its index order, a window per pass, and marks each
    // legacy holder exactly once.
    for (const plan of [...report.backfills.self, ...report.backfills.grantee]) {
      expect(plan).toMatch(/SEARCH t USING (COVERING )?INDEX _substrat_tuples_object_relation_subject \(\(object,relation,subject\)>\(\?,\?,\?\) AND object<\?\)/);
    }
    for (const plan of report.backfills.table) expect(plan).toMatch(/SEARCH e USING (COVERING )?INDEX sqlite_autoindex_shape_plan_badge_1 \(id>\?\)/);
    for (const kind of ['self', 'grantee', 'table'] as const) expect(report.backfills[kind].length, kind).toBeGreaterThan(0);
    for (const plan of Object.values(report.backfills).flat()) expect(plan).not.toMatch(/TEMP B-TREE FOR ORDER BY/);
    expect([report.marks, report.maxFetched <= report.window]).toEqual([report.holders, true]);
    expect(report.scans).toEqual([]);
  });
}

describe('#2083: the shape reconcile reads markers on their own index, on workerd', () => {
  it('a new scope DO has the partial index, and every read a reconcile sends plans on an index', async () => {
    const name = `shape-marker-${ulid()}`;
    const ddl = await runInDurableObject(stubOf(name), (_instance, state) => indexSql(state.storage.sql));
    expect(ddl).toMatch(/ON _substrat_tuples \(object, subject\) WHERE relation = 'bootstrap'$/);
    await expectOnIndexes(name);
  });

  it('a DO built before the index gets it on its next wake, and its reads plan on it', async () => {
    const name = `shape-marker-legacy-${ulid()}`;
    const dropped = await runInDurableObject(stubOf(name), (_instance, state) => {
      state.storage.sql.exec(`DROP INDEX ${INDEX}`);
      return indexSql(state.storage.sql);
    });
    expect(dropped).toBeNull();
    // The eviction: `abort()` throws inside the DO by contract, and the next stub wakes it anew.
    await runInDurableObject(stubOf(name), (_instance, state) => {
      state.abort('evicted for #2083 test');
    }).catch(() => undefined);
    const woken = await runInDurableObject(stubOf(name), (_instance, state) => indexSql(state.storage.sql));
    expect(woken).toMatch(/WHERE relation = 'bootstrap'$/);
    await expectOnIndexes(name);
  });
});

/**
 * #2154 on a Durable Object's own SQLite: the backfill's reads are bounded by the window, counted
 * the way the platform counts them (`cursor.rowsRead`, every statement a pass sends, subqueries
 * included), not by the rows a query hands back. Before #2154 each pass re-read its whole candidate
 * range, so the most a pass read grew with the scope.
 */
describe('#2154: the shape backfill reads a bounded window per pass, on workerd', () => {
  /** `storage.sql` as the kernel's SwitchSql, adding up the rows the engine read. */
  const counted = (sql: SqlStorage) => {
    let read = 0;
    const exec = (q: string, params: unknown[]) => {
      const cursor = sql.exec(q, ...params);
      const rows = cursor.toArray() as Record<string, unknown>[];
      read += cursor.rowsRead;
      return rows;
    };
    return { sql: { all: (q: string, ...p: unknown[]) => exec(q, p), run: (q: string, ...p: unknown[]) => void exec(q, p) }, rowsRead: () => read };
  };
  const maxRowsRead = (legacy: number) =>
    runInDurableObject(stubOf(`shape-backfill-${ulid()}`), (_instance, state) => {
      const c = counted(state.storage.sql);
      const report = shapeReconcilePlans(c.sql, { tenantId: ulid(), scopeId: ulid() }, { legacy, rowsRead: c.rowsRead });
      expect(report.complete).toBe(true);
      expect(report.marks).toBe(report.holders); // every legacy holder marked, each exactly once
      return report.maxRowsRead!;
    });

  it('four times the legacy holders: the most one pass reads stays where it was', async () => {
    const small = await maxRowsRead(100);
    const large = await maxRowsRead(400);
    expect(small).toBeGreaterThan(0);
    // Unbounded, the large scope's backfill passes read about four times the small one's.
    expect(large).toBeLessThanOrEqual(small * 1.25);
  });

  /**
   * #2159 review: the probe's candidates are a fixed share of its rows, so a read that filtered
   * candidates in its WHERE would also stop after a constant number of rows. What the window must
   * bound is a range where non-candidates GROW and candidates do not: the restart an interrupted
   * reconcile makes, re-reading every holder it already marked ahead of the few it has not. Each
   * holder kind, with `marked` holders already marked and five left, all at the range's end.
   */
  const restartRows = (kind: 'self' | 'grantee' | 'table', marked: number) =>
    runInDurableObject(stubOf(`shape-backfill-restart-${ulid()}`), (_instance, state) => {
      const c = counted(state.storage.sql);
      const tuple = (subject: string, relation: string, object: string) =>
        c.sql.run('INSERT INTO _substrat_tuples (subject, relation, object) VALUES (?, ?, ?)', subject, relation, object);
      const KEY = 'restart:use';
      if (kind === 'table') c.sql.run('CREATE TABLE shape_restart_badge (id TEXT PRIMARY KEY, holder TEXT)');
      const left: string[] = [];
      for (let i = 0; i < marked + 5; i++) {
        const p = ulid();
        // Already-marked holders sort first, the five left to mark after them: `a…` before `z…`.
        const id = kind === 'self' ? `${i < marked ? '0' : '7'}${p.slice(1)}` : `${i < marked ? 'a' : 'z'}${String(i).padStart(5, '0')}`;
        const object = `${kind === 'self' ? 'owner' : kind === 'grantee' ? 'desk' : 'badge'}:${id}`;
        const subject = `principal:${kind === 'self' ? id : p}`;
        if (kind === 'table') c.sql.run('INSERT INTO shape_restart_badge (id, holder) VALUES (?, ?)', id, p);
        tuple(subject, `granted:${KEY}`, object);
        if (i < marked) tuple(subject, 'bootstrap', object);
        else left.push(`${subject} ${object}`);
      }
      const holder = kind === 'table' ? { table: 'shape_restart_badge', idColumn: 'id', principalColumn: 'holder' } : kind;
      const entityType = kind === 'self' ? 'owner' : kind === 'grantee' ? 'desk' : 'badge';
      const shapes = [entityGrantShape.parse({ entityType, permissions: [KEY], bootstrap: true, holder })];
      let [max, passes, after] = [0, 0, null as ShapeCursor | null];
      do {
        const before = c.rowsRead();
        after = topUpEntityGrantShapes(c.sql, { tenantId: ulid(), scopeId: ulid(), shapes, now: new Date().toISOString(), limit: 2, after, mintEventId: () => ulid(), version: null }).next;
        max = Math.max(max, c.rowsRead() - before);
        passes++;
      } while (after && passes < 10_000);
      const markedNow = c.sql
        .all("SELECT subject || ' ' || object AS pair FROM _substrat_tuples WHERE relation = 'bootstrap' AND object >= ? AND object < ?", `${entityType}:`, `${entityType};`)
        .map((r) => String(r['pair']));
      expect(after).toBeNull();
      for (const pair of left) expect(markedNow).toContain(pair);
      return max;
    });

  it.each(['self', 'grantee', 'table'] as const)(
    '%s: a restart over four times the already-marked holders reads no more in any pass',
    async (kind) => {
      const small = await restartRows(kind, 200);
      const large = await restartRows(kind, 800);
      expect(small).toBeGreaterThan(0);
      // Filtered in the WHERE, the first pass reads every marked holder to find the five left.
      expect(large).toBeLessThanOrEqual(small * 1.25);
    },
  );

  /** The holder table's schema is the vertical's: the first window plans its read and says so if it sorts. */
  const warnings = (ddl: string) =>
    runInDurableObject(stubOf(`shape-backfill-warn-${ulid()}`), (_instance, state) => {
      const sql = switchSqlOver(state.storage.sql);
      sql.run(ddl);
      for (let i = 0; i < 25; i++) sql.run('INSERT INTO shape_warn_badge (id, holder) VALUES (?, ?)', `b${String(i).padStart(3, '0')}`, ulid());
      const lines: string[] = [];
      const warn = vi.spyOn(console, 'warn').mockImplementation((line: string) => void lines.push(line));
      try {
        const shapes = [entityGrantShape.parse({ entityType: 'badge', permissions: ['badge:use'], bootstrap: true, holder: { table: 'shape_warn_badge', idColumn: 'id', principalColumn: 'holder' } })];
        let after: ShapeCursor | null = null;
        let passes = 0;
        do {
          after = topUpEntityGrantShapes(sql, { tenantId: ulid(), scopeId: ulid(), shapes, now: new Date().toISOString(), limit: 1, after, mintEventId: () => ulid(), version: null }).next;
          passes++;
        } while (after && passes < 100);
        expect(passes).toBeGreaterThan(1);
      } finally {
        warn.mockRestore();
      }
      return lines.map((l) => JSON.parse(l) as Record<string, unknown>);
    });

  it('a holder table whose idColumn leads no index writes one shape-backfill-unbounded line per reconcile', async () => {
    expect(await warnings('CREATE TABLE shape_warn_badge (id TEXT, holder TEXT)')).toEqual([
      expect.objectContaining({ substrat: 'shape-backfill-unbounded', level: 'warn', entityType: 'badge', table: 'shape_warn_badge', idColumn: 'id' }),
    ]);
  });

  it('...and one keyed on idColumn writes none', async () => {
    expect(await warnings('CREATE TABLE shape_warn_badge (id TEXT PRIMARY KEY, holder TEXT)')).toEqual([]);
  });
});
