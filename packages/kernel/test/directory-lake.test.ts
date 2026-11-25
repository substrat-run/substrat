// `node:sqlite`, as facet-events.test.ts: the kernel declares no better-sqlite3.
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { platformActorId } from '@substrat-run/contracts';
import {
  DIRECTORY_LAKE_DDL,
  ackDirectoryOutbox,
  ensureDirectoryLakeTriggers,
  advanceDirectoryLakeBackfill,
  parseDirectoryLakeCapture,
  pruneDirectoryLakeWindow,
  readDirectoryLakeBackfill,
  readDirectoryOutbox,
  setDirectoryLakeCapture,
  sweepDirectoryLake,
  type DirectoryLakeRow,
  type DirectoryLakeSweepReport,
} from '../src/directory-lake.js';
import { METER_DAYS_DDL } from '../src/meter-days.js';
import type { HostAdmin } from '../src/scope-host.js';
import type { RedactionSql } from '../src/subject-redaction.js';

const NOW = '2026-11-25T10:00:00.000Z';

/** A directory holding the two shapes that matter: an append-only log, and an upserted day. */
function directory() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE _substrat_access_log (id TEXT PRIMARY KEY, actor TEXT NOT NULL, method TEXT NOT NULL,
      tenant_id TEXT, scope_id TEXT, params TEXT, result_count INTEGER NOT NULL, on_behalf_of TEXT,
      drained_at TEXT, at TEXT NOT NULL);
    ${METER_DAYS_DDL}
    ${DIRECTORY_LAKE_DDL}
  `);
  const sql: RedactionSql = (q, params) => {
    const stmt = db.prepare(q);
    return stmt.columns().length > 0 ? stmt.all(...(params as (string | number | null)[])) : (stmt.run(...(params as (string | number | null)[])), []);
  };
  const access = (id: string, tenant = 'T1') =>
    sql(`INSERT INTO _substrat_access_log (id, actor, method, tenant_id, scope_id, params, result_count, at)
         VALUES (?, 'staff', 'getTenant', ?, NULL, '{}', 1, ?)`, [id, tenant, NOW]);
  const meter = (day: string, status: string) =>
    sql(`INSERT INTO _substrat_meter_days (day, tenant_id, read_at, status, billable, scopes, verticals, entitlements)
         VALUES (?, 'T1', ?, ?, 1, '[]', '[]', '[]')
         ON CONFLICT (day, tenant_id) DO UPDATE SET status = excluded.status`, [day, NOW, status]);
  const triggers = () => (sql(`SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name`, []) as { name: string }[]).map((t) => t.name);
  return { db, sql, access, meter, triggers };
}

describe('the directory outbox (K-70)', () => {
  it('captures nothing and builds no trigger until a data set is switched on', () => {
    const d = directory();
    d.access('A1');
    expect(d.triggers()).toEqual([]);
    expect(readDirectoryOutbox(d.sql, 10)).toEqual([]);
  });

  it('queues each insert, each later version of an upserted row, and no delete', () => {
    const d = directory();
    setDirectoryLakeCapture(d.sql, ['access_log', 'meter_days'], NOW);
    d.access('A1');
    d.meter('2026-11-24', 'active');
    d.meter('2026-11-24', 'suspended');
    d.sql(`UPDATE _substrat_access_log SET drained_at = ?`, [NOW]);
    d.sql(`DELETE FROM _substrat_access_log`, []);

    const rows = readDirectoryOutbox(d.sql, 10);
    expect(rows.map((r) => [r.dataset, r.rowKey, r.kind])).toEqual([
      ['access_log', 'A1', 'getTenant'],
      ['meter_days', '["2026-11-24","T1"]', 'active'],
      ['meter_days', '["2026-11-24","T1"]', 'suspended'],
    ]);
    expect(rows[0]).toMatchObject({ tenantId: 'T1', scopeId: null, actor: 'staff', at: NOW });
    // The access log's own drain stamp is bookkeeping, never shipped.
    expect(JSON.parse(rows[0]!.row)).toEqual({
      id: 'A1', actor: 'staff', method: 'getTenant', tenant_id: 'T1', scope_id: null, params: '{}',
      result_count: 1, on_behalf_of: null, at: NOW,
    });
    expect(rows.map((r) => r.seq)).toEqual([1, 2, 3]);
  });

  it('rebuilds a trigger when its table grew a column, so the new column ships', () => {
    const d = directory();
    setDirectoryLakeCapture(d.sql, ['access_log'], NOW);
    d.sql(`ALTER TABLE _substrat_access_log ADD COLUMN reason TEXT`, []);
    expect(ensureDirectoryLakeTriggers(d.sql)).toBe(1);
    expect(ensureDirectoryLakeTriggers(d.sql)).toBe(0);
    d.access('A1');
    expect(JSON.parse(readDirectoryOutbox(d.sql, 1)[0]!.row)).toHaveProperty('reason', null);
  });

  it('switched off, drops its triggers and keeps what it queued; back on, resets since and the backfill mark', () => {
    const d = directory();
    setDirectoryLakeCapture(d.sql, ['access_log'], NOW);
    d.access('A1');
    expect(advanceDirectoryLakeBackfill(d.sql, 'access_log', { after: 0, next: 1, done: true }, NOW).changed).toBe(true);
    expect(setDirectoryLakeCapture(d.sql, [], NOW)).toMatchObject({ enabled: [], disabled: ['access_log'], current: [] });
    d.access('A2');
    expect(d.triggers()).toEqual([]);
    expect(readDirectoryOutbox(d.sql, 10).map((r) => r.rowKey)).toEqual(['A1']);
    expect(() => advanceDirectoryLakeBackfill(d.sql, 'access_log', { after: 0, next: null, done: true }, NOW)).toThrow(/not capturing/);

    const later = '2026-11-26T00:00:00.000Z';
    expect(setDirectoryLakeCapture(d.sql, ['access_log'], later).current).toEqual([
      { dataset: 'access_log', since: later, backfillUntil: 2, backfillAfter: 0, backfilledAt: null },
    ]);
  });

  it('acks up to a seq, and never hands a seq out twice once the outbox is empty', () => {
    const d = directory();
    setDirectoryLakeCapture(d.sql, ['access_log'], NOW);
    d.access('A1');
    d.access('A2');
    expect(ackDirectoryOutbox(d.sql, 1)).toBe(1);
    expect(ackDirectoryOutbox(d.sql, 2)).toBe(1);
    expect(ackDirectoryOutbox(d.sql, 2)).toBe(0);
    d.access('A3');
    expect(readDirectoryOutbox(d.sql, 10).map((r) => r.seq)).toEqual([3]);
  });

  it('backfills by rowid in the outbox shape, without queueing anything', () => {
    const d = directory();
    d.access('A1');
    d.access('A2');
    d.access('A3');
    const first = readDirectoryLakeBackfill(d.sql, 'access_log', 0, 2);
    expect(first.rows.map((r) => [r.seq, r.rowKey])).toEqual([[null, 'A1'], [null, 'A2']]);
    expect(first).toMatchObject({ next: 2, done: false });
    const last = readDirectoryLakeBackfill(d.sql, 'access_log', first.next!, 2);
    expect(last).toMatchObject({ next: 3, done: true });
    expect(JSON.parse(last.rows[0]!.row)).not.toHaveProperty('drained_at');
    expect(readDirectoryOutbox(d.sql, 10)).toEqual([]);
    // Capture on: the walk stops at the rowid capture began at; the trigger has the rest.
    setDirectoryLakeCapture(d.sql, ['access_log'], NOW);
    d.access('A4');
    expect(readDirectoryLakeBackfill(d.sql, 'access_log', 2, 2)).toMatchObject({ next: 3, done: true });
  });

  it('records a backfill page by page, refusing a page that does not start where the last ended', () => {
    const d = directory();
    setDirectoryLakeCapture(d.sql, ['access_log'], NOW);
    expect(() => advanceDirectoryLakeBackfill(d.sql, 'access_log', { after: 2, next: 4, done: false }, NOW)).toThrow(/resumes after rowid 0, not 2/);
    advanceDirectoryLakeBackfill(d.sql, 'access_log', { after: 0, next: 2, done: false }, NOW);
    const end = advanceDirectoryLakeBackfill(d.sql, 'access_log', { after: 2, next: 3, done: true }, NOW);
    expect(end.state).toMatchObject({ backfillAfter: 3, backfilledAt: NOW });
    expect(advanceDirectoryLakeBackfill(d.sql, 'access_log', { after: 0, next: 9, done: true }, NOW).changed).toBe(false);
  });

  it('prunes only once the lake provably holds the rows, older than the window, and ships no delete', () => {
    const d = directory();
    d.access('A1'); // at NOW
    const after = '2026-11-26T00:00:00.000Z';
    expect(pruneDirectoryLakeWindow(d.sql, 'access_log', after, 10)).toEqual({ pruned: 0, refused: 'not-capturing' });
    setDirectoryLakeCapture(d.sql, ['access_log', 'meter_days'], NOW);
    expect(pruneDirectoryLakeWindow(d.sql, 'access_log', after, 10)).toEqual({ pruned: 0, refused: 'not-backfilled' });
    advanceDirectoryLakeBackfill(d.sql, 'access_log', { after: 0, next: 1, done: true }, NOW);
    d.access('A2'); // queued, not yet shipped
    expect(pruneDirectoryLakeWindow(d.sql, 'access_log', after, 10)).toEqual({ pruned: 0, refused: 'queued-before-window' });
    ackDirectoryOutbox(d.sql, readDirectoryOutbox(d.sql, 10).at(-1)!.seq!);
    expect(pruneDirectoryLakeWindow(d.sql, 'access_log', NOW, 10)).toEqual({ pruned: 0, refused: null });
    expect(pruneDirectoryLakeWindow(d.sql, 'access_log', after, 1)).toEqual({ pruned: 1, refused: null });
    expect(pruneDirectoryLakeWindow(d.sql, 'access_log', after, 10)).toEqual({ pruned: 1, refused: null });
    expect(readDirectoryOutbox(d.sql, 10)).toEqual([]);

    // A day-keyed set compares the day with the cut's UTC day.
    advanceDirectoryLakeBackfill(d.sql, 'meter_days', { after: 0, next: null, done: true }, NOW);
    d.meter('2026-11-24', 'active');
    ackDirectoryOutbox(d.sql, readDirectoryOutbox(d.sql, 10).at(-1)!.seq!);
    expect(pruneDirectoryLakeWindow(d.sql, 'meter_days', '2026-11-24T23:00:00.000Z', 10).pruned).toBe(0);
    expect(pruneDirectoryLakeWindow(d.sql, 'meter_days', '2026-11-25T00:00:00.000Z', 10).pruned).toBe(1);
  });

  it('reads the switch from the environment, refusing a name it does not know', () => {
    expect(parseDirectoryLakeCapture(undefined)).toEqual([]);
    expect(parseDirectoryLakeCapture(' off ')).toEqual([]);
    expect(parseDirectoryLakeCapture('all')).toHaveLength(9);
    expect(parseDirectoryLakeCapture('admin_log, meter_days,admin_log')).toEqual(['admin_log', 'meter_days']);
    expect(() => parseDirectoryLakeCapture('admin_logs')).toThrow(/unknown data set admin_logs/);
  });
});

describe('the pass phase', () => {
  /** HostAdmin's four outbox members over one directory, as an adapter answers them. */
  const adminOver = (sql: RedactionSql): HostAdmin =>
    ({
      setDirectoryLakeCapture: async (_a, ds) => setDirectoryLakeCapture(sql, ds, NOW),
      pruneDirectoryLakeWindow: async (_a, ds, before, limit) => pruneDirectoryLakeWindow(sql, ds, before, limit),
      directoryOutbox: async (_a, limit) => readDirectoryOutbox(sql, limit),
      ackDirectoryOutbox: async (_a, upTo) => ackDirectoryOutbox(sql, upTo),
    }) as Partial<HostAdmin> as HostAdmin;
  const actor = platformActorId.parse('01JCSYSTEM0000000000000000');
  const report = (): DirectoryLakeSweepReport => ({ capture: null, shipped: 0, acked: 0, ref: null });

  it('ships batch after batch while each is full, and leaves an unconfirmed batch queued', async () => {
    const d = directory();
    const admin = adminOver(d.sql);
    await sweepDirectoryLake(admin, actor, { sink: { ship: async () => ({ ref: 'x' }) }, capture: ['access_log'] }, report());
    for (const id of ['A1', 'A2', 'A3']) d.access(id);

    const shipped: DirectoryLakeRow[][] = [];
    const out = report();
    await sweepDirectoryLake(admin, actor, {
      sink: { ship: async (rows) => (shipped.push(rows), { ref: `r${shipped.length}` }) },
      capture: ['access_log'], batch: 2, batchesPerPass: 5,
    }, out);
    expect(shipped.map((b) => b.map((r) => r.rowKey))).toEqual([['A1', 'A2'], ['A3']]);
    expect(out).toMatchObject({ shipped: 3, acked: 3, ref: 'r2' });

    d.access('A4');
    await expect(sweepDirectoryLake(admin, actor, {
      sink: { ship: async () => { throw new Error('stream down'); } }, capture: ['access_log'],
    }, report())).rejects.toThrow('stream down');
    expect(readDirectoryOutbox(d.sql, 10).map((r) => r.rowKey)).toEqual(['A4']);
  });

  it('prunes after the drain, only the listed data sets, and reports why one pruned nothing', async () => {
    const d = directory();
    const admin = adminOver(d.sql);
    const sink = { ship: async () => ({ ref: 'r' }) };
    await sweepDirectoryLake(admin, actor, { sink, capture: ['access_log', 'meter_days'] }, report());
    advanceDirectoryLakeBackfill(d.sql, 'access_log', { after: 0, next: null, done: true }, NOW);
    d.access('A1'); // queued now, shipped by the same pass that prunes it
    const out = report();
    const nowMs = Date.parse('2027-01-01T00:00:00.000Z');
    await sweepDirectoryLake(admin, actor, { sink, capture: ['access_log', 'meter_days'], prune: ['access_log', 'meter_days'], nowMs }, out);
    expect(out.pruned).toEqual({ access_log: 1, meter_days: 'not-backfilled' });
  });
});
