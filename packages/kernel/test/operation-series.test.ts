import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { operationSeriesInput, type OperationSeriesInput } from '@substrat-run/contracts';
import { createUlid, readOperationSeries, type ScopedSql } from '../src/index.js';

/**
 * Business volumes per bucket (#1750), against a real outbox: the read is one aggregate
 * over a primary-key range plus `strftime` and `json_each`, and a fake `query` would only
 * test the fake.
 */
const DDL = `
  CREATE TABLE _substrat_outbox (
    id TEXT PRIMARY KEY,
    occurred_at TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    operation TEXT,
    invocation_id TEXT
  );`;

interface Ev {
  at: string;
  op: string | null;
  entity?: string;
  entityType?: string;
  call?: string | null;
  /** The id's own instant, when it differs from `at` (a clock held at the mint's floor). */
  idAt?: string;
}

/** Each event's id from its own instant, through a writer's mint — what both adapters do. */
function readerOver(evs: Ev[]): { reader: Pick<ScopedSql, 'query'>; sqls: string[] } {
  const db = new DatabaseSync(':memory:');
  db.exec(DDL);
  const mint = createUlid();
  const ins = db.prepare('INSERT INTO _substrat_outbox (id, occurred_at, entity_type, entity_id, operation, invocation_id) VALUES (?, ?, ?, ?, ?, ?)');
  let n = 0;
  for (const e of evs) {
    n += 1;
    ins.run(mint(Date.parse(e.idAt ?? e.at)), e.at, e.entityType ?? 'conversation', e.entity ?? `c${n}`, e.op, e.call === undefined ? `call-${n}` : e.call);
  }
  const sqls: string[] = [];
  return {
    sqls,
    reader: {
      query: <T>(sql: string, params: unknown[] = []) => {
        sqls.push(sql);
        return db.prepare(sql).all(...(params as never[])) as T[];
      },
    } as Pick<ScopedSql, 'query'>,
  };
}

const CLOSE = { entityType: 'conversation', operation: 'desk/close' };
const ASSIGN = { entityType: 'conversation', operation: 'desk/assign' };

const read = (evs: Ev[], over: Partial<OperationSeriesInput> = {}) =>
  readOperationSeries(
    { sql: readerOver(evs).reader },
    { moves: [CLOSE, ASSIGN], since: '2026-10-03T00:00:00.000Z', until: '2026-10-04T00:00:00.000Z', bucketMinutes: 30, ...over },
  );

describe('readOperationSeries (#1750)', () => {
  it('counts each pair per bucket, anchored at `since`, with every pair asked for answered', () => {
    const r = read([
      { at: '2026-10-03T00:00:00.000Z', op: 'desk/close' },
      { at: '2026-10-03T00:29:59.999Z', op: 'desk/close' },
      { at: '2026-10-03T00:30:00.000Z', op: 'desk/close' },
      { at: '2026-10-03T23:59:59.000Z', op: 'desk/close' },
    ]);
    expect(r.series).toEqual([
      {
        ...CLOSE,
        total: 4,
        buckets: [
          { start: '2026-10-03T00:00:00.000Z', count: 2 },
          { start: '2026-10-03T00:30:00.000Z', count: 1 },
          { start: '2026-10-03T23:30:00.000Z', count: 1 },
        ],
      },
      // Asked for, nothing matched: listed, not dropped — a missing row would read as unasked.
      { ...ASSIGN, total: 0, buckets: [] },
    ]);
  });

  it('a window is half-open: an event at `until` is the next window’s, one at `since` is this one’s', () => {
    const evs: Ev[] = [
      { at: '2026-10-02T23:59:59.999Z', op: 'desk/close' },
      { at: '2026-10-03T00:00:00.000Z', op: 'desk/close' },
      { at: '2026-10-04T00:00:00.000Z', op: 'desk/close' },
    ];
    expect(read(evs).series[0]!.total).toBe(1);
    // The twin: widen by a millisecond either way and both edges come in.
    expect(read(evs, { since: '2026-10-02T23:59:59.000Z', until: '2026-10-04T00:00:00.001Z' }).series[0]!.total).toBe(3);
  });

  it('a call that emitted several events about one record is one move; two records are two', () => {
    const r = read([
      { at: '2026-10-03T10:00:00.000Z', op: 'desk/close', entity: 'c1', call: 'k1' },
      { at: '2026-10-03T10:00:00.000Z', op: 'desk/close', entity: 'c1', call: 'k1' },
      { at: '2026-10-03T10:00:00.000Z', op: 'desk/close', entity: 'c2', call: 'k1' },
      // Two calls on the same record are two moves (closed, reopened elsewhere, closed).
      { at: '2026-10-03T10:05:00.000Z', op: 'desk/close', entity: 'c1', call: 'k2' },
      // A row from before invocation ids counts on its own.
      { at: '2026-10-03T10:06:00.000Z', op: 'desk/close', entity: 'c3', call: null },
      { at: '2026-10-03T10:06:00.000Z', op: 'desk/close', entity: 'c3', call: null },
    ]);
    expect(r.series[0]!.total).toBe(5);
  });

  it('counts only the pairs asked for: another entity under the same operation, or a consumer emit, is not a move', () => {
    const r = read([
      { at: '2026-10-03T10:00:00.000Z', op: 'desk/close' },
      { at: '2026-10-03T10:00:00.000Z', op: 'desk/close', entityType: 'message' },
      { at: '2026-10-03T10:00:00.000Z', op: null },
      { at: '2026-10-03T10:00:00.000Z', op: 'desk/assign' },
    ]);
    expect(r.series.map((s) => s.total)).toEqual([1, 1]);
  });

  it('finds an event whose id ran ahead of its instant (a clock held at the floor), and seeks the key for the rest', () => {
    const { reader, sqls } = readerOver([
      { at: '2026-10-03T10:00:00.000Z', op: 'desk/close', idAt: '2026-10-05T00:00:00.000Z' },
      { at: '2026-10-03T11:00:00.000Z', op: 'desk/close' },
    ]);
    const r = readOperationSeries({ sql: reader }, { moves: [CLOSE], since: '2026-10-03T00:00:00.000Z', until: '2026-10-04T00:00:00.000Z', bucketMinutes: 60 });
    expect(r.series[0]!.total).toBe(2);
    // One statement, bounded below on the primary key.
    expect(sqls).toHaveLength(1);
    expect(sqls[0]).toContain('id >= ?');
  });

  it('takes 64 pairs as one bound parameter, below the Durable Object’s 100', () => {
    const moves = Array.from({ length: 64 }, (_, i) => ({ entityType: `e${i}`, operation: `op/${i}` }));
    const r = read([{ at: '2026-10-03T10:00:00.000Z', op: 'op/63', entityType: 'e63' }], { moves });
    expect(r.series[63]).toMatchObject({ total: 1 });
    expect(r.series.slice(0, 63).every((s) => s.total === 0)).toBe(true);
  });
});

describe('operationSeriesInput (#1750)', () => {
  const base = { moves: [CLOSE], since: '2026-10-03T00:00:00.000Z', until: '2026-10-04T00:00:00.000Z', bucketMinutes: 30 };
  it('accepts a day at 30 minutes and refuses a window past seven days, too many buckets, or a fractional anchor', () => {
    expect(operationSeriesInput.safeParse(base).success).toBe(true);
    expect(operationSeriesInput.safeParse({ ...base, until: '2026-10-10T00:00:00.000Z' }).success).toBe(true);
    expect(operationSeriesInput.safeParse({ ...base, until: '2026-10-10T00:00:00.001Z', bucketMinutes: 60 }).success).toBe(false);
    expect(operationSeriesInput.safeParse({ ...base, until: '2026-10-10T00:00:00.000Z', bucketMinutes: 15 }).success).toBe(false);
    expect(operationSeriesInput.safeParse({ ...base, since: '2026-10-03T00:00:00.500Z' }).success).toBe(false);
    expect(operationSeriesInput.safeParse({ ...base, until: base.since }).success).toBe(false);
    expect(operationSeriesInput.safeParse({ ...base, moves: Array.from({ length: 65 }, () => CLOSE) }).success).toBe(false);
  });

  it('refuses an instant an event id cannot encode as a validation error, and takes the epoch itself', () => {
    const epoch = { ...base, since: '1970-01-01T00:00:00.000Z', until: '1970-01-02T00:00:00.000Z' };
    expect(operationSeriesInput.safeParse(epoch).success).toBe(true);
    // The read's seek would otherwise throw a RangeError from `ulidFloor` past the boundary.
    expect(() => readOperationSeries({ sql: readerOver([]).reader }, operationSeriesInput.parse(epoch))).not.toThrow();
    for (const bad of [
      { ...epoch, since: '1969-12-31T23:59:59.000Z' },
      { ...epoch, since: '1969-12-31T00:00:00.000Z', until: '1969-12-31T23:59:59.999Z' },
    ]) {
      const r = operationSeriesInput.safeParse(bad);
      expect(r.success).toBe(false);
      expect(JSON.stringify(r.error?.issues)).toContain('outside what an event id can encode');
    }
  });
});
