import { describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { ADMIN_LOG_INDEXES_SQL } from '../src/admin-log-ddl.js';
import {
  AUDITED_OPERATIONS_BATCH,
  operationKeyOf,
  auditedOperationsSql,
  effectiveOutcomes,
  isSupersededOutcome,
  readAuditedOperations,
  SETTLE_OUTCOME_SQL,
  settleOutcomeParamsOf,
  AUDITED_CHANGE_ACTIONS,
  UNRECORDED_OUTCOME_LOG,
  recordAuditOutcome,
  unknownOutcomeOf,
  type AuditedOperationSqlRow,
} from '../src/audit-outcome.js';
import { SWITCH_ACTIONS } from '../src/system-switch-record.js';

/**
 * #2064: an audited operation's effective outcome is a PRIORITY over its rows, never an order.
 * The intent, a real outcome and a settle's `unknown` are written by different writers, whose
 * ids and clocks need not agree, so every order below must resolve the same way.
 */
describe('effectiveOutcomes', () => {
  const op = (phase: string, operationId = 'op', where: { tenantId?: string; scopeId?: string } = {}) => ({
    action: 'transferOwner', operationId, tenantId: where.tenantId ?? 't1', scopeId: where.scopeId ?? 's1', phase,
  });
  const key = (where: { tenantId?: string; scopeId?: string } = {}) =>
    operationKeyOf({ action: 'transferOwner', operationId: 'op', tenantId: where.tenantId ?? 't1', scopeId: where.scopeId ?? 's1' });
  const resolve = (...rows: ReturnType<typeof op>[]) => effectiveOutcomes(rows).get(key());

  it('a real outcome beats unknown in either order', () => {
    for (const real of ['applied', 'refused', 'failed']) {
      expect(resolve(op('intent'), op('unknown'), op(real))?.outcome).toBe(real);
      expect(resolve(op(real), op('unknown'), op('intent'))?.outcome).toBe(real);
    }
  });

  it('unknown stands only when no real outcome exists; an intent alone is pending', () => {
    expect(resolve(op('intent'), op('unknown'))?.outcome).toBe('unknown');
    expect(resolve(op('intent'))).toBeUndefined();
  });

  it('two real outcomes are conflicting, never one of them guessed', () => {
    expect(resolve(op('applied'), op('refused'))).toEqual({ outcome: 'conflicting', real: ['applied', 'refused'] });
    expect(resolve(op('applied'), op('unknown'), op('applied'))?.outcome).toBe('conflicting');
  });

  it('superseded is an unknown that a real outcome beat — never a real outcome', () => {
    const beaten = resolve(op('unknown'), op('applied'));
    expect(isSupersededOutcome('unknown', beaten)).toBe(true);
    expect(isSupersededOutcome('applied', beaten)).toBe(false);
    expect(isSupersededOutcome('unknown', resolve(op('unknown')))).toBe(false);
  });

  it('rows of another action or another operation decide nothing', () => {
    const rows = [op('unknown'), { ...op('applied'), action: 'createTenant' }, op('applied', 'other')];
    expect(effectiveOutcomes(rows).get(key())?.outcome).toBe('unknown');
  });

  it('one operation id in two tenants, or two scopes, is two operations — never a conflict', () => {
    const rows = [op('applied'), op('refused', 'op', { tenantId: 't2' }), op('failed', 'op', { scopeId: 's2' })];
    const effective = effectiveOutcomes(rows);
    expect(effective.get(key())?.outcome).toBe('applied');
    expect(effective.get(key({ tenantId: 't2' }))?.outcome).toBe('refused');
    expect(effective.get(key({ scopeId: 's2' }))?.outcome).toBe('failed');
    // The twin: two real outcomes in the SAME scope are still the invariant breaking.
    expect(effectiveOutcomes([op('applied'), op('refused')]).get(key())?.outcome).toBe('conflicting');
  });
});

/**
 * The reads behind it, against a real SQLite with the shared DDL: an operation is found through
 * the operation-id index (never a scan of the log), in batches that bind at most
 * `AUDITED_OPERATIONS_BATCH` ids, and an operation is its action, id AND scope.
 */
describe('the operation-id reads', () => {
  const db = () => {
    const d = new DatabaseSync(':memory:');
    d.exec(`CREATE TABLE _substrat_admin_log (
      id TEXT PRIMARY KEY, actor TEXT NOT NULL, action TEXT NOT NULL, tenant_id TEXT, scope_id TEXT,
      vertical TEXT, before TEXT, after TEXT, caused_by TEXT, on_behalf_of TEXT, at TEXT NOT NULL)`);
    d.exec(ADMIN_LOG_INDEXES_SQL);
    return d;
  };
  let n = 0;
  const insert = (d: DatabaseSync, action: string, operationId: string, phase: string, scope: string | null = 's1', tenant: string | null = 't1') =>
    d
      .prepare('INSERT INTO _substrat_admin_log (id, actor, action, tenant_id, scope_id, after, at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(String(++n).padStart(8, '0'), 'a', action, tenant, scope, JSON.stringify({ phase, operationId }), '2026-10-06T12:00:00.000Z');
  const ref = (operationId: string, where: { tenantId?: string | null; scopeId?: string | null } = {}) => ({
    action: 'transferOwner', operationId, tenantId: where.tenantId === undefined ? 't1' : where.tenantId, scopeId: where.scopeId === undefined ? 's1' : where.scopeId,
  });
  const all = (d: DatabaseSync) => (sql: string, params: string[]) => d.prepare(sql).all(...params) as unknown as AuditedOperationSqlRow[];

  it('both statements search the operation-id index rather than scan the log', () => {
    const d = db();
    const plan = (sql: string, params: unknown[]) =>
      (d.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...(params as string[])) as unknown as { detail: string }[]).map((r) => r.detail).join(' | ');
    expect(plan(auditedOperationsSql(3), ['a', 'b', 'c'])).toMatch(/USING INDEX _substrat_admin_log_operation/);
    expect(plan(SETTLE_OUTCOME_SQL, settleOutcomeParamsOf(ref('a')))).toMatch(/USING INDEX _substrat_admin_log_operation/);
  });

  it('reads only the operations asked about, in batches, out of a large unrelated history', () => {
    const d = db();
    for (let i = 0; i < 2000; i++) insert(d, 'manageScopeMember', `noise-${i}`, i % 2 ? 'intent' : 'applied');
    const asked = Array.from({ length: AUDITED_OPERATIONS_BATCH * 2 + 1 }, (_, i) => `op-${i}`);
    for (const id of asked) {
      insert(d, 'transferOwner', id, 'intent');
      insert(d, 'transferOwner', id, 'unknown');
    }
    insert(d, 'transferOwner', 'op-0', 'applied', 'another-scope');
    const statements: number[] = [];
    const rows = readAuditedOperations(
      (sql, params) => {
        statements.push(params.length);
        return all(d)(sql, params);
      },
      asked.map((operationId) => ({ action: 'transferOwner', operationId, tenantId: 't1', scopeId: 's1' })),
    );
    // Three statements for 101 ids, none binding more than the batch.
    expect(statements).toEqual([AUDITED_OPERATIONS_BATCH, AUDITED_OPERATIONS_BATCH, 1]);
    // Exactly the asked operations' rows in their own scope: no noise, no other scope's row.
    expect(rows).toHaveLength(asked.length * 2);
    expect(new Set(rows.map((r) => r.operationId))).toEqual(new Set(asked));
    expect(rows.every((r) => r.scopeId === 's1')).toBe(true);
  });

  it('the settle check finds an outcome by operation id, whatever its id says about order', () => {
    const d = db();
    insert(d, 'transferOwner', 'late', 'applied'); // a LOWER id than the intent below
    insert(d, 'transferOwner', 'late', 'intent');
    expect(d.prepare(SETTLE_OUTCOME_SQL).get(...settleOutcomeParamsOf(ref('late')))).toBeTruthy();
    insert(d, 'transferOwner', 'open', 'intent');
    expect(d.prepare(SETTLE_OUTCOME_SQL).get(...settleOutcomeParamsOf(ref('open')))).toBeUndefined();
  });

  it('the settle check is the WHOLE key: the same id in another tenant, scope or action is not this operation', () => {
    const d = db();
    insert(d, 'transferOwner', 'shared', 'intent');
    insert(d, 'transferOwner', 'shared', 'applied', 's2', 't2');
    insert(d, 'transferOwner', 'shared', 'refused', 's2');
    insert(d, 'transferOwner', 'shared', 'failed', 's1', 't2');
    insert(d, 'manageScopeMember', 'shared', 'applied');
    expect(d.prepare(SETTLE_OUTCOME_SQL).get(...settleOutcomeParamsOf(ref('shared')))).toBeUndefined();
    // The twin: an outcome under the same whole key is found.
    insert(d, 'transferOwner', 'shared', 'unknown');
    expect(d.prepare(SETTLE_OUTCOME_SQL).get(...settleOutcomeParamsOf(ref('shared')))).toBeTruthy();
  });

  it('a null tenant or scope compares as null in both grammars, never as a wildcard', () => {
    const d = db();
    insert(d, 'transferOwner', 'tenantless', 'applied', null, null);
    expect(d.prepare(SETTLE_OUTCOME_SQL).get(...settleOutcomeParamsOf(ref('tenantless', { tenantId: null, scopeId: null })))).toBeTruthy();
    expect(d.prepare(SETTLE_OUTCOME_SQL).get(...settleOutcomeParamsOf(ref('tenantless')))).toBeUndefined();
  });
});

/**
 * #2089: the outcome write every audited change makes — the control plane's flows and both
 * adapters' kill switches — through one helper that never swallows a failure.
 */
describe('recordAuditOutcome', () => {
  it('an empty audit error remains a failure rather than the null success sentinel', async () => {
    const logged: unknown[] = [];
    const line = { flow: 'system-switch', operationId: 'empty-error', phase: 'applied' };
    const result = await recordAuditOutcome(() => { throw new Error(''); }, line, (...args) => logged.push(args));
    expect(result).toBe('');
    expect(logged).toEqual([[UNRECORDED_OUTCOME_LOG, { ...line, auditError: '' }]]);
  });

  it('a throwing logger cannot replace the audit-write failure', async () => {
    for (const phase of ['refused', 'failed', 'applied']) {
      const line = { flow: 'system-switch', operationId: 'logger-error', phase };
      const write = () => { throw new Error('audit write failed'); };
      const log = () => { throw new Error('logger failed'); };
      expect(await recordAuditOutcome(write, line, log)).toBe('audit write failed');
    }
  });

  const line = { flow: 'system-switch', operationId: 'op-1', phase: 'refused' };

  it('a row that lands answers null and logs nothing', async () => {
    const logged: unknown[] = [];
    const written: string[] = [];
    expect(await recordAuditOutcome(() => written.push('row'), line, (...a) => logged.push(a))).toBeNull();
    expect(await recordAuditOutcome(async () => written.push('async row'), line, (...a) => logged.push(a))).toBeNull();
    expect(written).toEqual(['row', 'async row']);
    expect(logged).toEqual([]);
  });

  it('a row that throws, sync or async, answers its message and logs it with the operation', async () => {
    for (const write of [
      () => {
        throw new Error('log down');
      },
      () => Promise.reject(new Error('log down')),
    ]) {
      const logged: unknown[] = [];
      expect(await recordAuditOutcome(write, line, (...a) => logged.push(a))).toBe('log down');
      expect(logged).toEqual([[UNRECORDED_OUTCOME_LOG, { ...line, auditError: 'log down' }]]);
    }
  });
});

describe('unknownOutcomeOf, for a kill switch (#2089)', () => {
  const intent = (action: string, after: Record<string, unknown>) => ({
    id: 'row-1', action, tenant_id: 't1', scope_id: 's1', vertical: null, after: JSON.stringify(after),
  });

  it('every switch call action is settled', () => {
    for (const action of SWITCH_ACTIONS) expect(AUDITED_CHANGE_ACTIONS).toContain(action);
    expect([...SWITCH_ACTIONS].sort()).toEqual(['restoreToPeer', 'restoreToSystem', 'revokeFromPeer', 'revokeFromSystem']);
  });

  it("the unknown row is the intent's own fields, phase unknown, with the error capped", () => {
    const after = { operationId: 'op-1', moduleId: '@m/x', schedules: 'off', phase: 'intent', reason: 'incident' };
    const outcome = unknownOutcomeOf(intent('revokeFromSystem', after), 'row-1', 'e'.repeat(1000));
    expect(outcome.after).toEqual({ ...after, phase: 'unknown', error: 'e'.repeat(300) });
    expect(outcome.operation).toEqual({ action: 'revokeFromSystem', operationId: 'op-1', tenantId: 't1', scopeId: 's1' });
    expect(outcome.failure).toMatchObject({ operation: 'audit.revokeFromSystem', stage: 'outcome-unknown', reference: 'op-1' });
    const peer = { operationId: 'op-2', vertical: 'acme/crm', calls: 'on', phase: 'intent', reason: 'resolved' };
    expect(unknownOutcomeOf(intent('restoreToPeer', peer), 'row-1', 'why').after).toEqual({ ...peer, phase: 'unknown', error: 'why' });
  });

  it('an outcome row, a re-assert row, or an id the contract refuses is not a switch intent to settle', () => {
    const base = { moduleId: '@m/x', schedules: 'off', reason: 'r' };
    expect(() => unknownOutcomeOf(intent('revokeFromSystem', { ...base, operationId: 'op', phase: 'applied' }), 'row-1', 'x')).toThrow(/no audited-change intent/);
    expect(() => unknownOutcomeOf(intent('reassertSystemSwitch', { ...base, operationId: 'op', phase: 'intent' }), 'row-1', 'x')).toThrow(/no audited-change intent/);
    expect(() => unknownOutcomeOf(intent('revokeFromSystem', { ...base, operationId: '\ud800', phase: 'intent' }), 'row-1', 'x')).toThrow(/no audited-change intent/);
    // Twin: the same intent with a well-formed id settles.
    expect(unknownOutcomeOf(intent('revokeFromSystem', { ...base, operationId: 'op', phase: 'intent' }), 'row-1', 'x').operationId).toBe('op');
  });
});
