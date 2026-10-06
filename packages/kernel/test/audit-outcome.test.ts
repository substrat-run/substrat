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
  type AuditedOperationSqlRow,
} from '../src/audit-outcome.js';

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
    // SQLite's `json_array` and `operationKeyOf` write the same text, nulls and quoting included.
    const sqlKey = (d.prepare("SELECT json_array('transferOwner', 'o\"p', NULL, 's1') AS k").get() as { k: string }).k;
    expect(sqlKey).toBe(settleOutcomeParamsOf(ref('o"p', { tenantId: null }))[1]);
  });
});
