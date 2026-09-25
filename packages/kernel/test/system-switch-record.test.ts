import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import {
  SYSTEM_SWITCHES_BACKFILL_SQL,
  SYSTEM_SWITCHES_DDL,
  listSystemSwitchRecords,
  recordSystemSwitchedOff,
  recordSystemSwitchedOn,
  restoreSystemSwitchRecord,
  switchedOffModulesOf,
  systemSwitchRecordsOf,
  systemSwitchesTableExists,
  withRecorded,
  type SwitchSql,
} from '../src/index.js';

/**
 * #1674: the directory's record of the schedule switch, executed against a real SQLite.
 * Each adapter runs these same functions over its own directory (the shared
 * `systemSwitchContractSuite` holds the two to the same behaviour end to end).
 */
describe('the schedule switch record (#1674)', () => {
  const T = 'tenant-a';
  const S = 'scope-1';
  const M = '@m/x';

  const fresh = (): { db: DatabaseSync; sql: SwitchSql } => {
    const db = new DatabaseSync(':memory:');
    db.exec(`CREATE TABLE scopes (scope_id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, vertical TEXT)`);
    db.exec(`CREATE TABLE _substrat_admin_log (
      id TEXT PRIMARY KEY, actor TEXT NOT NULL, action TEXT NOT NULL, tenant_id TEXT, scope_id TEXT,
      vertical TEXT, before TEXT, after TEXT, caused_by TEXT, at TEXT NOT NULL
    )`);
    const sql: SwitchSql = {
      all: (q, ...p) => db.prepare(q).all(...p) as Record<string, unknown>[],
      run: (q, ...p) => {
        db.prepare(q).run(...p);
      },
    };
    return { db, sql };
  };
  const create = (db: DatabaseSync) => db.exec(SYSTEM_SWITCHES_DDL);

  /** A switch call as `revokeFromSystem` / `restoreToSystem` audit it: intent, then outcome. */
  let seq = 0;
  const audit = (
    db: DatabaseSync,
    call: { to: 'on' | 'off'; outcome: 'applied' | 'refused' | 'failed'; reason: string; module?: string; scope?: string },
  ) => {
    const action = call.to === 'off' ? 'revokeFromSystem' : 'restoreToSystem';
    const operationId = `01OP${String(++seq).padStart(22, '0')}`;
    const moduleId = call.module ?? M;
    const scope = call.scope ?? S;
    const row = db.prepare(`INSERT INTO _substrat_admin_log (id, actor, action, tenant_id, scope_id, after, at)
      VALUES (?, 'staff', ?, ?, ?, ?, ?)`);
    const at = `2026-09-0${Math.min(seq, 9)}T00:00:00.000Z`;
    row.run(`01ID${String(seq).padStart(22, '0')}a`, action, T, scope,
      JSON.stringify({ operationId, moduleId, schedules: call.to, phase: 'intent', reason: call.reason }), at);
    row.run(`01ID${String(seq).padStart(22, '0')}b`, action, T, scope,
      JSON.stringify({ operationId, moduleId, schedules: call.to, phase: call.outcome, changed: true }), at);
    return operationId;
  };
  const rows = (sql: SwitchSql) =>
    listSystemSwitchRecords(sql).map((r) => ({ scopeId: r.scopeId, moduleId: r.moduleId, position: r.position, reason: r.reason }));

  describe('the backfill from the admin log', () => {
    it('takes the LATEST applied call per (tenant, scope, module): off → on → off reads off', () => {
      const { db, sql } = fresh();
      audit(db, { to: 'off', outcome: 'applied', reason: 'first' });
      audit(db, { to: 'on', outcome: 'applied', reason: 'fixed' });
      const last = audit(db, { to: 'off', outcome: 'applied', reason: 'again' });
      create(db);
      db.exec(SYSTEM_SWITCHES_BACKFILL_SQL);
      expect(rows(sql)).toEqual([{ scopeId: S, moduleId: M, position: 'off', reason: 'again' }]);
      expect(listSystemSwitchRecords(sql)[0]).toMatchObject({ operationId: last, actor: 'staff', tenantId: T });
    });

    it('and off → on reads on — the restore is the latest', () => {
      const { db, sql } = fresh();
      audit(db, { to: 'off', outcome: 'applied', reason: 'incident' });
      audit(db, { to: 'on', outcome: 'applied', reason: 'fixed' });
      create(db);
      db.exec(SYSTEM_SWITCHES_BACKFILL_SQL);
      expect(rows(sql)).toEqual([{ scopeId: S, moduleId: M, position: 'on', reason: 'fixed' }]);
    });

    it('counts only APPLIED calls: a refused OFF alone writes no row, and neither does a failed one', () => {
      const { db, sql } = fresh();
      audit(db, { to: 'off', outcome: 'refused', reason: 'typo', module: '@m/typo' });
      audit(db, { to: 'off', outcome: 'failed', reason: 'unreachable', module: '@m/down' });
      create(db);
      db.exec(SYSTEM_SWITCHES_BACKFILL_SQL);
      expect(rows(sql)).toEqual([]);
    });

    it('a refused call AFTER an applied one does not mask it — the latest APPLIED call wins', () => {
      const { db, sql } = fresh();
      audit(db, { to: 'off', outcome: 'applied', reason: 'incident' });
      audit(db, { to: 'on', outcome: 'failed', reason: 'tried to restore' });
      create(db);
      db.exec(SYSTEM_SWITCHES_BACKFILL_SQL);
      expect(rows(sql)).toEqual([{ scopeId: S, moduleId: M, position: 'off', reason: 'incident' }]);
    });

    it('never overwrites a row the switch already wrote, and re-running it changes nothing', () => {
      const { db, sql } = fresh();
      audit(db, { to: 'off', outcome: 'applied', reason: 'history' });
      create(db);
      recordSystemSwitchedOff(sql, {
        tenantId: T, scopeId: S, moduleId: M, actor: 'staff', reason: 'written live', operationId: '01LIVE', at: '2026-09-20T00:00:00.000Z',
      });
      db.exec(SYSTEM_SWITCHES_BACKFILL_SQL);
      db.exec(SYSTEM_SWITCHES_BACKFILL_SQL);
      expect(rows(sql)).toEqual([{ scopeId: S, moduleId: M, position: 'off', reason: 'written live' }]);
    });

    it('keeps modules and scopes apart', () => {
      const { db, sql } = fresh();
      audit(db, { to: 'off', outcome: 'applied', reason: 'a' });
      audit(db, { to: 'off', outcome: 'applied', reason: 'b', module: '@m/y' });
      audit(db, { to: 'off', outcome: 'applied', reason: 'c', scope: 'scope-2' });
      audit(db, { to: 'on', outcome: 'applied', reason: 'd', scope: 'scope-2' });
      create(db);
      db.exec(SYSTEM_SWITCHES_BACKFILL_SQL);
      expect(rows(sql)).toEqual([
        { scopeId: S, moduleId: M, position: 'off', reason: 'a' },
        { scopeId: S, moduleId: '@m/y', position: 'off', reason: 'b' },
        { scopeId: 'scope-2', moduleId: M, position: 'on', reason: 'd' },
      ]);
    });

    it('`systemSwitchesTableExists` is what gates it to the one run that creates the table', () => {
      const { db, sql } = fresh();
      expect(systemSwitchesTableExists(sql)).toBe(false);
      create(db);
      expect(systemSwitchesTableExists(sql)).toBe(true);
    });
  });

  describe('the writes', () => {
    const write = (over: Partial<{ reason: string; operationId: string }> = {}) => ({
      tenantId: T, scopeId: S, moduleId: M, actor: 'staff', reason: 'incident', operationId: '01A', at: '2026-09-01T00:00:00.000Z',
      ...over,
    });

    it('OFF upserts; a repeat OFF refreshes the reason', () => {
      const { db, sql } = fresh();
      create(db);
      recordSystemSwitchedOff(sql, write());
      recordSystemSwitchedOff(sql, write({ reason: 'still investigating', operationId: '01B' }));
      expect(listSystemSwitchRecords(sql)).toEqual([
        expect.objectContaining({ position: 'off', reason: 'still investigating', operationId: '01B' }),
      ]);
    });

    it('ON updates only a row that exists, and answers the prior row, which a failed ON puts back', () => {
      const { db, sql } = fresh();
      create(db);
      // No row: ON creates none, so a restore of something never switched off records nothing.
      expect(recordSystemSwitchedOn(sql, write({ reason: 'noop' }))).toBeNull();
      expect(listSystemSwitchRecords(sql)).toEqual([]);

      recordSystemSwitchedOff(sql, write());
      const prior = recordSystemSwitchedOn(sql, write({ reason: 'fixed', operationId: '01B' }));
      expect(prior).toMatchObject({ position: 'off', reason: 'incident', operationId: '01A' });
      expect(switchedOffModulesOf(sql, T, S)).toEqual([]);

      restoreSystemSwitchRecord(sql, { tenantId: T, scopeId: S, moduleId: M }, prior);
      expect(switchedOffModulesOf(sql, T, S)).toEqual([M]);
      expect(listSystemSwitchRecords(sql)[0]).toMatchObject({ reason: 'incident', operationId: '01A' });
    });
  });

  describe('the fleet read', () => {
    const seed = () => {
      const { db, sql } = fresh();
      create(db);
      db.prepare(`INSERT INTO scopes VALUES ('s1', 't1', 'shop'), ('s2', 't1', 'desk'), ('s3', 't2', 'shop')`).run();
      const off = (scopeId: string, tenantId: string, moduleId: string, operationId: string) =>
        recordSystemSwitchedOff(sql, { tenantId, scopeId, moduleId, actor: 'staff', reason: 'r', operationId, at: 'x' });
      off('s1', 't1', '@m/a', '01A');
      off('s2', 't1', '@m/a', '01B');
      off('s3', 't2', '@m/b', '01C');
      off('s1', 't1', '@m/b', '01D');
      recordSystemSwitchedOn(sql, { tenantId: 't1', scopeId: 's1', moduleId: '@m/b', actor: 'staff', reason: 'r', operationId: '01E', at: 'x' });
      return sql;
    };
    const ids = (rows: { operationId: string }[]) => rows.map((r) => r.operationId);

    it('filters by position, tenant, scope, module and the joined vertical', () => {
      const sql = seed();
      expect(ids(listSystemSwitchRecords(sql, { position: 'off' }))).toEqual(['01A', '01B', '01C']);
      expect(ids(listSystemSwitchRecords(sql, { position: 'on' }))).toEqual(['01E']);
      expect(ids(listSystemSwitchRecords(sql, { tenantId: 't1', position: 'off' }))).toEqual(['01A', '01B']);
      expect(ids(listSystemSwitchRecords(sql, { scopeId: 's1' }))).toEqual(['01A', '01E']);
      expect(ids(listSystemSwitchRecords(sql, { moduleId: '@m/b' }))).toEqual(['01C', '01E']);
      expect(ids(listSystemSwitchRecords(sql, { vertical: 'shop', position: 'off' }))).toEqual(['01A', '01C']);
      expect(listSystemSwitchRecords(sql, { scopeId: 's2' })[0]).toMatchObject({ vertical: 'desk', tenantId: 't1' });
    });

    it('pages by operation id, both ways, without skipping or repeating', () => {
      const sql = seed();
      const first = listSystemSwitchRecords(sql, { limit: 2 });
      expect(ids(first)).toEqual(['01A', '01B']);
      expect(ids(listSystemSwitchRecords(sql, { limit: 2, cursor: '01B' }))).toEqual(['01C', '01E']);
      expect(ids(listSystemSwitchRecords(sql, { limit: 2, cursor: '01E' }))).toEqual([]);
      expect(ids(listSystemSwitchRecords(sql, { limit: 3, order: 'desc' }))).toEqual(['01E', '01C', '01B']);
      expect(ids(listSystemSwitchRecords(sql, { order: 'desc', cursor: '01B' }))).toEqual(['01A']);
    });

    it('`systemSwitchRecordsOf` and `switchedOffModulesOf` read one scope', () => {
      const sql = seed();
      expect([...systemSwitchRecordsOf(sql, 't1', 's1')].sort()).toEqual([['@m/a', 'off'], ['@m/b', 'on']]);
      expect(switchedOffModulesOf(sql, 't1', 's1')).toEqual(['@m/a']);
      expect(switchedOffModulesOf(sql, 't2', 's1')).toEqual([]);
    });
  });

  describe('withRecorded', () => {
    it('joins the record on, and ADDS a recorded module the scope no longer reports — the wiped scope', () => {
      expect(
        withRecorded(
          [
            { moduleId: '@m/b', schedules: 'on' },
            { moduleId: '@m/c', schedules: 'off' },
          ],
          new Map<string, 'on' | 'off'>([
            ['@m/a', 'off'],
            ['@m/c', 'off'],
          ]),
        ),
      ).toEqual([
        { moduleId: '@m/a', schedules: 'ungranted', recorded: 'off' },
        { moduleId: '@m/b', schedules: 'on', recorded: null },
        { moduleId: '@m/c', schedules: 'off', recorded: 'off' },
      ]);
    });
  });
});
