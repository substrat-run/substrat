import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { permissionKey, substratError, type OperationTarget, type ScheduleSpec } from '@substrat-run/contracts';
import {
  entityStateMigrations,
  entityStatePlans,
  purgeCandidates,
  purgeCutoffOf,
  purgeOnlyKeysOf,
  registerTrashTargets,
  runPurgePass,
} from '../src/index.js';

/**
 * The kernel half of #119 PR 2 that needs no host: registration's refusals, the purge pass's
 * classification of outcomes, the purge-only keys, and the purge walk's SQL against a real
 * SQLite. The behaviour on a scope is `entityTrashContractSuite`'s, on both adapters.
 */
const TRASH = permissionKey.parse('box:trash');
const decl = { entityType: 'box', trashPermission: TRASH, table: 'boxes', idColumn: 'id' };
const horizon = { ...decl, purgeAfterDays: 7 };
const purgeTarget: OperationTarget = { entity: 'box', idFrom: 'boxId', key: 'box:delete', trashed: 'purges' };
const purgeSchedule: ScheduleSpec = {
  operation: 'b/delete',
  cadence: { everyMinutes: 60 },
  permissions: [permissionKey.parse('box:delete')],
  purge: { entityType: 'box' },
};
const own = new Set(['b/delete', 'b/rename']);

describe('registerTrashTargets', () => {
  it('requires operationTargets from a module with a trashable entity', () => {
    expect(() => registerTrashTargets('m', own, undefined, [decl], [])).toThrow(/operationTargets/);
    // Twin: an empty map is a statement, and a module with nothing trashable needs none.
    expect(registerTrashTargets('m', own, {}, [decl], []).size).toBe(0);
    expect(registerTrashTargets('m', own, undefined, [], undefined).size).toBe(0);
  });

  it('refuses a target on an unbound operation, and an opt-in over an entity with no trash', () => {
    expect(() => registerTrashTargets('m', own, { 'b/ghost': purgeTarget }, [decl], [])).toThrow(/unbound/);
    expect(() =>
      registerTrashTargets('m', own, { 'b/rename': { ...purgeTarget, entity: 'shelf', trashed: 'admits' } }, [decl], []),
    ).toThrow(/declares no trash/);
  });

  it('ties a horizon to exactly one purge schedule running the purging operation', () => {
    expect(registerTrashTargets('m', own, inputs, [horizon], [purgeSchedule]).get('b/delete')).toEqual(purgeTarget);
    expect(() => registerTrashTargets('m', own, inputs, [horizon], [])).toThrow(/0 purge schedules/);
    expect(() => registerTrashTargets('m', own, inputs, [horizon], [purgeSchedule, purgeSchedule])).toThrow(/2 purge schedules/);
    expect(() => registerTrashTargets('m', own, inputs, [horizon], [{ ...purgeSchedule, operation: 'b/rename' }])).toThrow(
      /not\s+that entity's/,
    );
    // A purge schedule for an entity that declares no horizon is refused too.
    expect(() => registerTrashTargets('m', own, inputs, [decl], [purgeSchedule])).toThrow(/purge schedule/);
  });
});

describe('refuseTrashedTarget under the purge sweep', () => {
  // The cutoff is the host's: `now` minus the declared horizon. Nothing a caller passes moves it.
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE boxes (id TEXT PRIMARY KEY, name TEXT)');
  for (const m of entityStateMigrations('m', [horizon])) db.exec(m.sql);
  db.exec('CREATE TABLE _substrat_state_moves (entity_type TEXT, entity_id TEXT)');
  const insert = db.prepare('INSERT INTO boxes (id, name) VALUES (?, ?)');
  const trashAt = (id: string, when: string) => {
    insert.run(id, id);
    db.prepare("INSERT INTO _substrat_state_moves VALUES ('box', ?)").run(id);
    db.prepare('UPDATE boxes SET _substrat_trashed_at = ? WHERE id = ?').run(when, id);
    db.prepare('DELETE FROM _substrat_state_moves').run();
  };
  trashAt('due', '2026-01-01T00:00:00.000Z');
  trashAt('young', '2026-01-10T00:00:00.000Z');
  insert.run('active', 'active');
  const sql = {
    query: <T>(q: string, p: readonly unknown[] = []) => db.prepare(q).all(...(p as never[])) as T[],
    exec: () => ({ changes: 0 }),
  };
  const plans = new Map(entityStatePlans('m', [horizon]).map((p) => [p.entityType, p]));
  const deps = { sql, plans, check: async () => ({ allowed: true as const, proof: [] }) } as never;
  const now = { now: '2026-01-12T00:00:00.000Z' };
  const refusal = (id: string, target: OperationTarget = purgeTarget) =>
    refuseTrashedTarget(deps, 'b/delete', target, { boxId: id }, now).then(
      () => 'admitted',
      (e: unknown) => [errorCodeOf(e), (e as { extensions?: { reason?: string } }).extensions?.reason ?? null],
    );

  it('admits an entity trashed past the horizon', async () => expect(await refusal('due')).toBe('admitted'));
  it('refuses one trashed inside it, an active (restored) one, and a gone one', async () => {
    expect(await refusal('young')).toEqual(['conflict', 'purge_not_due']);
    expect(await refusal('active')).toEqual(['conflict', 'purge_not_due']);
    expect(await refusal('gone')).toEqual(['not_found', null]);
  });
  it('refuses the sweep on an operation that is not the purge', async () => {
    expect(await refusal('due', { ...purgeTarget, trashed: 'admits' })).toEqual(['internal', null]);
  });
});

describe('a horizon is declared on a trashable entity only', () => {
  it('refuses a horizon without a trash permission', () => {
    expect(() => entityStatePlans('m', [{ entityType: 'box', archivePermission: TRASH, purgeAfterDays: 3, table: 'boxes' }])).toThrow(
      /purge horizon and no trash/,
    );
  });
});

describe('purgeOnlyKeysOf', () => {
  it('names the keys only a purge schedule declares', () => {
    const other: ScheduleSpec = { operation: 'b/tick', cadence: { everyMinutes: 5 }, permissions: [permissionKey.parse('box:read')] };
    expect([...purgeOnlyKeysOf([purgeSchedule, other])!]).toEqual(['box:delete']);
    // A key another schedule also declares is already the system principal's for that one.
    const shares: ScheduleSpec = { ...other, permissions: [permissionKey.parse('box:delete')] };
    // Nothing withheld is `undefined`, so a system principal's every check skips the lookup.
    expect(purgeOnlyKeysOf([purgeSchedule, shares])).toBeUndefined();
    expect(purgeOnlyKeysOf([])).toBeUndefined();
  });
});

describe('runPurgePass', () => {
  it('counts restored and already-gone entities as skipped, other throws as errors, and marks a full batch', async () => {
    const outcomes: Record<string, () => void> = {
      a: () => undefined,
      gone: () => {
        throw substratError('not_found', 'gone');
      },
      restored: () => {
        throw substratError('conflict', 'restored', { reason: 'purge_not_due' });
      },
      // A conflict for any other reason is the operation's own refusal — a failure.
      refused: () => {
        throw substratError('conflict', 'nope', { reason: 'invalid_transition' });
      },
      boom: () => {
        throw new Error('crashed');
      },
    };
    const ids = Object.keys(outcomes);
    const pass = await runPurgePass(ids, ids.length, async (id) => outcomes[id]!());
    expect(pass).toEqual({
      purged: 1,
      skipped: 2,
      errors: [
        { entityId: 'refused', error: 'nope' },
        { entityId: 'boom', error: 'crashed' },
      ],
      full: true,
    });
    expect((await runPurgePass(['a'], 2, async () => undefined)).full).toBe(false);
  });
});

describe('the purge walk', () => {
  it('selects the trashed rows at or before the cutoff, oldest first, through the purge index', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('CREATE TABLE boxes (id TEXT PRIMARY KEY, name TEXT)');
    for (const m of entityStateMigrations('m', [horizon])) db.exec(m.sql);
    const insert = db.prepare('INSERT INTO boxes (id, name) VALUES (?, ?)');
    for (const id of ['old', 'older', 'young', 'active']) insert.run(id, id);
    // The trigger refuses an unauthorized move; a test writes the kernel's authorization around it.
    const at = (id: string, when: string) => {
      db.prepare('CREATE TABLE IF NOT EXISTS _substrat_state_moves (entity_type TEXT, entity_id TEXT)').run();
      db.prepare("INSERT INTO _substrat_state_moves VALUES ('box', ?)").run(id);
      db.prepare('UPDATE boxes SET _substrat_trashed_at = ? WHERE id = ?').run(when, id);
      db.prepare('DELETE FROM _substrat_state_moves').run();
    };
    at('older', '2026-01-01T00:00:00.000Z');
    at('old', '2026-01-02T00:00:00.000Z');
    at('young', '2026-01-20T00:00:00.000Z');
    const sql = {
      query: <T>(q: string, p: readonly unknown[] = []) => db.prepare(q).all(...(p as never[])) as T[],
      exec: (q: string, p: readonly unknown[] = []) => ({ changes: Number(db.prepare(q).run(...(p as never[])).changes) }),
    };
    const [plan] = entityStatePlans('m', [horizon]);
    const cutoff = purgeCutoffOf('2026-01-12T00:00:00.000Z', 7);
    expect(cutoff).toBe('2026-01-05T00:00:00.000Z');
    expect(purgeCandidates(sql, plan!, cutoff)).toEqual(['older', 'old']);
    expect(purgeCandidates(sql, plan!, cutoff, 1)).toEqual(['older']);
    const detail = (db.prepare(`EXPLAIN QUERY PLAN SELECT id FROM boxes WHERE _substrat_trashed_at IS NOT NULL AND _substrat_trashed_at <= ? ORDER BY _substrat_trashed_at, id LIMIT 5`).all('x') as { detail: string }[])
      .map((r) => r.detail)
      .join(' | ');
    expect(detail).toContain('_substrat_purge_boxes');
  });
});
