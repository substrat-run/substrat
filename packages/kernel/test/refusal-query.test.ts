// `node:sqlite`, as facet-events.test.ts: the kernel declares no better-sqlite3.
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import {
  assertTransition,
  nameRefusedRecord,
  refusalRecord,
  substratError,
  type LifecycleDef,
} from '@substrat-run/contracts';
import {
  REFUSALS_DDL,
  REFUSALS_REBUILD,
  markGuardRefusal,
  refusalInsert,
  refusalOf,
  refusalsAdmitGuards,
  type RefusedGuard,
} from '../src/refusals.js';
import { mapRefusalRow, refusalListQuery, type RefusalDbRow } from '../src/refusal-query.js';
import { ulid } from '../src/ulid.js';

const T = ulid();
const S = ulid();
const ALICE = ulid();

/**
 * #1745: the refusal log's read, against the real DDL both adapters run — the INSERT the
 * kernel writes, read back by the SELECT both adapters build. Executed, never string-matched.
 */
function db(): DatabaseSync {
  const d = new DatabaseSync(':memory:');
  d.exec(REFUSALS_DDL);
  return d;
}

function write(d: DatabaseSync, over: Partial<Parameters<typeof refusalInsert>[0]> & { entityId?: string; at: string }): void {
  const q = refusalInsert({
    tenantId: T,
    scopeId: S,
    refused: { entityType: 'order', entityId: over.entityId ?? 'o1', from: 'closed', operation: 'shop/complete', attempted: 'completed' },
    invokedOperation: 'shop/complete',
    actor: over.actor ?? JSON.stringify(ALICE),
    impersonation: null,
    invocationId: over.invocationId ?? null,
    at: over.at,
  });
  d.prepare(q.sql).run(...q.params);
}

function read(d: DatabaseSync, filter?: Parameters<typeof refusalListQuery>[0]) {
  const q = refusalListQuery(filter);
  return (d.prepare(q.sql).all(...q.params) as unknown as RefusalDbRow[]).map(mapRefusalRow);
}

describe('refusal log read (#1745)', () => {
  it('maps a written row to the published shape, with the problem code and actor kind', () => {
    const d = db();
    write(d, { at: '2026-10-01T10:00:00.000Z', invocationId: 'call-1' });
    const [row] = read(d);
    expect(refusalRecord.parse(row)).toEqual(row);
    expect(row).toMatchObject({
      kind: 'transition',
      reason: 'invalid_transition',
      actor: ALICE,
      actorKind: 'principal',
      entityType: 'order',
      entityId: 'o1',
      fromState: 'closed',
      attemptedState: 'completed',
      operation: 'shop/complete',
      invocationId: 'call-1',
    });
    expect(row!.decodeError).toBeUndefined();
  });

  it('filters by record, actor (logical form), call and a half-open window, newest first', () => {
    const d = db();
    write(d, { at: '2026-10-01T10:00:00.000Z', entityId: 'o1' });
    write(d, { at: '2026-10-01T11:00:00.000Z', entityId: 'o2', actor: JSON.stringify({ system: 'mail' }), invocationId: 'c2' });
    write(d, { at: '2026-10-01T12:00:00.000Z', entityId: 'o1' });
    expect(read(d).map((r) => r.at)).toEqual([
      '2026-10-01T12:00:00.000Z',
      '2026-10-01T11:00:00.000Z',
      '2026-10-01T10:00:00.000Z',
    ]);
    expect(read(d, { entityType: 'order', entityId: 'o1' })).toHaveLength(2);
    expect(read(d, { actor: ALICE })).toHaveLength(2);
    expect(read(d, { actor: '{"system":"mail"}' })).toMatchObject([{ entityId: 'o2', actorKind: 'system' }]);
    expect(read(d, { invocationId: 'c2' })).toHaveLength(1);
    expect(read(d, { since: '2026-10-01T11:00:00.000Z', until: '2026-10-01T12:00:00.000Z' })).toMatchObject([{ entityId: 'o2' }]);
    expect(read(d, { limit: 1 })).toHaveLength(1);
  });

  it('reads an undecodable actor as the marker, saying so, rather than losing the page', () => {
    const d = db();
    write(d, { at: '2026-10-01T10:00:00.000Z', actor: '{not json' });
    write(d, { at: '2026-10-01T11:00:00.000Z' });
    const rows = read(d);
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({ actor: { system: 'undecodable' }, actorKind: 'unknown' });
    expect(rows[1]!.decodeError).toMatch(/actor/);
  });

  it('refuses a filter outside its bounds rather than building SQL from it', () => {
    expect(() => refusalListQuery({ limit: 0 })).toThrow();
    expect(() => refusalListQuery({ limit: 10_000 })).toThrow();
  });
});

describe('guard refusals (#1745, K-38)', () => {
  const guard = (over: Partial<RefusedGuard> = {}): RefusedGuard => ({
    kind: 'guard',
    predicate: 'protocol/all-signed',
    operation: 'shop/finish',
    reason: 'protocol_required',
    entityType: 'order',
    entityId: 'o9',
    ...over,
  });

  it('writes a guard row with no from-state, and reads it back as a guard', () => {
    const d = db();
    const q = refusalInsert({
      tenantId: T,
      scopeId: S,
      refused: guard(),
      invokedOperation: 'shop/finish',
      actor: JSON.stringify(ALICE),
      impersonation: null,
      invocationId: 'call-g',
      at: '2026-10-01T12:00:00.000Z',
    });
    d.prepare(q.sql).run(...q.params);
    write(d, { at: '2026-10-01T11:00:00.000Z' });
    const [row] = read(d, { kind: 'guard' });
    expect(refusalRecord.parse(row)).toEqual(row);
    expect(row).toMatchObject({
      kind: 'guard',
      guard: 'protocol/all-signed',
      reason: 'protocol_required',
      entityType: 'order',
      entityId: 'o9',
      fromState: null,
      attemptedState: null,
      operation: 'shop/finish',
      invocationId: 'call-g',
    });
    expect(row!.decodeError).toBeUndefined();
    // The kind narrows; the transition row is the other one.
    expect(read(d, { kind: 'transition' }).map((r) => [r.kind, r.guard, r.reason])).toEqual([
      ['transition', null, 'invalid_transition'],
    ]);
  });

  it('marks only a conflict as a guard refusal, and never a throw that already is a refused transition', () => {
    const refusing = substratError('conflict', 'not yet: Ada Lovelace', { reason: 'protocol_required' });
    nameRefusedRecord(refusing, { entityType: 'order', entityId: 'o9' });
    markGuardRefusal(refusing, 'protocol/all-signed', 'shop/finish');
    expect(refusalOf(refusing)).toEqual(guard());

    // No reason extension: still a refusal, the code unknown. No record named: still recorded.
    const bare = substratError('conflict', 'no');
    markGuardRefusal(bare, 'g/p', 'x/op');
    expect(refusalOf(bare)).toEqual(guard({ predicate: 'g/p', operation: 'x/op', reason: null, entityType: null, entityId: null }));

    // A guard failing is not a guard refusing.
    for (const other of [new Error('boom'), substratError('validation_failed', 'bad'), substratError('forbidden', 'no'), 'thrown string', null]) {
      markGuardRefusal(other, 'g/p', 'x/op');
      expect(refusalOf(other)).toBeNull();
    }

    // A predicate that hit assertTransition: one refusal, the transition it is.
    let thrown: unknown;
    try {
      assertTransition(
        { field: 'status', initial: 'open', states: { open: { on: { 'x/close': 'closed' } }, closed: { terminal: true } } } as unknown as LifecycleDef,
        'thing',
        'closed',
        'x/close',
        { entityType: 'thing', entityId: 't1' },
      );
    } catch (err) {
      thrown = err;
    }
    markGuardRefusal(thrown, 'g/p', 'x/op');
    expect(refusalOf(thrown)).toMatchObject({ from: 'closed', operation: 'x/close' });
    expect(refusalOf(thrown)).not.toHaveProperty('kind');
  });
});

describe('REFUSALS_REBUILD (#1745): a store from before guard refusals', () => {
  // The table #1928 shipped. Frozen: it is what deployed scopes hold. The adapters' copy is
  // `PRE_GUARD_REFUSALS_DDL` in contract-tests, which the kernel cannot import.
  const PRE_GUARD = `
    CREATE TABLE _substrat_refusals (
      id TEXT PRIMARY KEY,
      -- 'transition' today; a guard refusal (K-38) is the next kind, recorded the same way.
      kind TEXT NOT NULL, tenant_id TEXT NOT NULL, scope_id TEXT, entity_type TEXT, entity_id TEXT,
      from_state TEXT NOT NULL, attempted_state TEXT, operation TEXT NOT NULL, invoked_operation TEXT,
      actor TEXT NOT NULL, impersonation TEXT, invocation_id TEXT, at TEXT NOT NULL, drained_at TEXT
    );
    CREATE INDEX _substrat_refusals_entity_at ON _substrat_refusals (entity_type, at);
  `;
  const tableSql = (d: DatabaseSync) =>
    (d.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = '_substrat_refusals'").get() as { sql: string }).sql;
  const legacy = (): DatabaseSync => {
    const d = new DatabaseSync(':memory:');
    d.exec(PRE_GUARD);
    d.prepare(
      `INSERT INTO _substrat_refusals (id, kind, tenant_id, scope_id, entity_type, entity_id, from_state, attempted_state,
         operation, invoked_operation, actor, impersonation, invocation_id, at, drained_at)
       VALUES (?, 'transition', ?, ?, 'order', 'o1', 'closed', 'completed', 'shop/complete', 'shop/complete', ?, NULL, 'c1', ?, NULL)`,
    ).run(ulid(), T, S, JSON.stringify(ALICE), '2026-09-30T10:00:00.000Z');
    return d;
  };

  it('is due on the shipped shape and not on the current one — a comment saying "guard" does not count', () => {
    expect(refusalsAdmitGuards(tableSql(legacy()))).toBe(false);
    expect(refusalsAdmitGuards(tableSql(db()))).toBe(true);
  });

  it('keeps every row and the index, and the result admits a guard row', () => {
    const d = legacy();
    const before = d.prepare('SELECT * FROM _substrat_refusals').all();
    d.exec(`BEGIN; ${REFUSALS_REBUILD}; COMMIT;`);
    expect(refusalsAdmitGuards(tableSql(d))).toBe(true);
    expect(d.prepare('SELECT * FROM _substrat_refusals').all()).toEqual(
      before.map((r) => ({ ...r, guard: null, reason: null })),
    );
    expect(
      d.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = '_substrat_refusals_entity_at'").all(),
    ).toHaveLength(1);
    expect(d.prepare("SELECT name FROM sqlite_master WHERE name = '_substrat_refusals_new'").all()).toEqual([]);
    // Read back as the transition it was, its code implied by the kind.
    expect(read(d)[0]).toMatchObject({ kind: 'transition', reason: 'invalid_transition', guard: null, fromState: 'closed' });
    const q = refusalInsert({
      tenantId: T,
      scopeId: S,
      refused: { kind: 'guard', predicate: 'p/q', operation: 'x/y', reason: null, entityType: null, entityId: null },
      invokedOperation: 'x/y',
      actor: JSON.stringify(ALICE),
      impersonation: null,
      invocationId: null,
      at: '2026-10-01T00:00:00.000Z',
    });
    d.prepare(q.sql).run(...q.params);
    expect(read(d, { kind: 'guard' })).toHaveLength(1);
  });

  it('leaves the old table whole when interrupted inside its transaction', () => {
    const d = legacy();
    const before = d.prepare('SELECT * FROM _substrat_refusals').all();
    // A failure after the DROP and before the COMMIT — the state to fear — rolls all of it back.
    const statements = REFUSALS_REBUILD.split('ALTER TABLE _substrat_refusals_new RENAME TO _substrat_refusals;');
    d.exec('BEGIN');
    d.exec(statements[0]!);
    expect(() => d.exec('SELECT no_such_function()')).toThrow();
    d.exec('ROLLBACK');
    expect(refusalsAdmitGuards(tableSql(d))).toBe(false);
    expect(d.prepare('SELECT * FROM _substrat_refusals').all()).toEqual(before);
    expect(d.prepare("SELECT name FROM sqlite_master WHERE name = '_substrat_refusals_new'").all()).toEqual([]);
  });

  it('starts clean over a scratch table a torn copy left behind', () => {
    const d = legacy();
    d.exec('CREATE TABLE _substrat_refusals_new (junk TEXT)');
    d.exec(`BEGIN; ${REFUSALS_REBUILD}; COMMIT;`);
    expect(refusalsAdmitGuards(tableSql(d))).toBe(true);
    expect(read(d)).toHaveLength(1);
  });
});
