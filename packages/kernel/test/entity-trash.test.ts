import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import {
  declaredSurfaceOf,
  errorCodeOf,
  operationInputsOf,
  permissionKey,
  substratError,
  z,
  type OperationTarget,
  type ScheduleSpec,
} from '@substrat-run/contracts';
import {
  refuseTrashedTarget,
  entityStateMigrations,
  purgeHeldBy,
  purgeOnlyKeysOf,
  purgeReportOf,
  purgeStillDue,
  purgeDueOf,
  registerTrashTargets,
  runPurgePass,
  SCHEDULE_STATE_DDL,
  type PurgeGateFacts,
} from '../src/index.js';
import { entityStatePlans } from '../src/entity-state.js';
import { purgeCandidates, purgeCutoffOf } from '../src/entity-trash.js';
import { purgeLapOf, readPurgeLap, type PurgeDue } from '../src/entity-trash.js';

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
/** Declarations as a module's operation surface carries them; the host reads targets off these. */
const declared = {
  'b/delete': { permission: { key: 'box:delete', entity: 'box', idFrom: 'boxId' }, trashed: 'purges', input: z.strictObject({ boxId: z.string() }) },
  'b/rename': { permission: { key: 'box:read', entity: 'box', idFrom: 'boxId' }, input: z.object({ boxId: z.string(), name: z.string() }) },
};
const inputs = operationInputsOf(declared);

/** A `ScopedSql` over an in-memory database. */
const sqlOf = (db: DatabaseSync) => ({
  query: <T>(q: string, p: readonly unknown[] = []) => db.prepare(q).all(...(p as never[])) as T[],
  exec: (q: string, p: readonly unknown[] = []) => ({ changes: Number(db.prepare(q).run(...(p as never[])).changes) }),
});

describe('registerTrashTargets', () => {
  it('derives the targets from the declared surface, and requires one from a module with a trashable entity', () => {
    expect(registerTrashTargets('m', own, inputs, [decl], []).get('b/delete')).toEqual(purgeTarget);
    expect(() => registerTrashTargets('m', own, undefined, [decl], [])).toThrow(/operationInputsOf/);
    // A hand-built map carries no surface: nothing to derive the targets from.
    expect(() => registerTrashTargets('m', own, { ...inputs }, [decl], [])).toThrow(/operationInputsOf/);
    // Twin: a module with nothing trashable needs none.
    expect(registerTrashTargets('m', own, undefined, [], undefined).size).toBe(0);
  });

  it('refuses a bound operation the declarations do not name — an omitted target', () => {
    expect(() => registerTrashTargets('m', new Set([...own, 'b/sneak']), inputs, [decl], [])).toThrow(/b\/sneak/);
  });

  it('refuses an opt-in over an entity with no trash here', () => {
    const shelf = operationInputsOf({
      'b/rename': { permission: { key: 'box:read', entity: 'shelf', idFrom: 'boxId' }, trashed: 'admits', input: z.object({ boxId: z.string() }) },
    });
    expect(() => registerTrashTargets('m', new Set(['b/rename']), shelf, [decl], [])).toThrow(/declares no trash/);
  });

  it("refuses a purge whose parsed input takes anything but the id — an optional field included", () => {
    const wider = operationInputsOf({
      ...declared,
      'b/delete': { ...declared['b/delete'], input: z.strictObject({ boxId: z.string(), otherBoxId: z.string().optional() }) },
    });
    expect(() => registerTrashTargets('m', own, wider, [decl], [])).toThrow(/nothing else/);
  });

  it('refuses a purge whose input is not strict — a passthrough object keeps an extra id through the parse', () => {
    const loose = z.looseObject({ boxId: z.string() });
    // The hole itself: one declared field, and the parse still hands the handler a second id.
    expect(loose.parse({ boxId: 'a', otherBoxId: 'b' })).toEqual({ boxId: 'a', otherBoxId: 'b' });
    for (const input of [loose, z.object({ boxId: z.string() }).passthrough(), z.object({ boxId: z.string() }), z.object({ boxId: z.string() }).catchall(z.string())]) {
      const surface = operationInputsOf({ ...declared, 'b/delete': { ...declared['b/delete'], input } });
      expect(() => registerTrashTargets('m', own, surface, [decl], [])).toThrow(/strict/);
    }
    // Twin: strict, by either spelling.
    for (const input of [z.strictObject({ boxId: z.string() }), z.object({ boxId: z.string() }).strict()]) {
      const surface = operationInputsOf({ ...declared, 'b/delete': { ...declared['b/delete'], input } });
      expect(registerTrashTargets('m', own, surface, [decl], []).get('b/delete')).toEqual(purgeTarget);
    }
  });

  it('reads a surface nothing can edit: the record, its targets and the map are frozen', () => {
    const surface = operationInputsOf(declared);
    const record = declaredSurfaceOf(surface)!;
    expect(() => {
      (record as { targets: unknown }).targets = {};
    }).toThrow(TypeError);
    expect(() => {
      delete (record.targets as Record<string, unknown>)['b/delete'];
    }).toThrow(TypeError);
    expect(() => {
      (record.targets['b/delete'] as { trashed?: string }).trashed = 'admits';
    }).toThrow(TypeError);
    expect(() => {
      (record.operations as string[]).push('b/sneak');
    }).toThrow(TypeError);
    // Nor can the map's schemas be swapped for a looser purge input after the fact.
    expect(() => {
      (surface as Record<string, unknown>)['b/delete'] = z.looseObject({ boxId: z.string() });
    }).toThrow(TypeError);
    // So registration still derives every target, the purge included.
    expect(registerTrashTargets('m', own, surface, [decl], []).get('b/delete')).toEqual(purgeTarget);
  });

  it('reads a surface nothing can forge: only a map operationInputsOf itself returned has one', () => {
    const forged = { targets: {}, operations: ['b/delete', 'b/rename'] };
    // The old carrier — a registered symbol on the map — attached to a hand-built map, and to a copy.
    for (const map of [{ 'b/delete': declared['b/delete'].input }, { ...inputs }]) {
      Object.defineProperty(map, Symbol.for('substrat.declaredOperationSurface'), { value: forged });
      expect(declaredSurfaceOf(map)).toBeUndefined();
      expect(() => registerTrashTargets('m', own, map, [decl], [])).toThrow(/operationInputsOf/);
    }
    // A genuine surface is not transferable either: it belongs to the map it was built with.
    expect(declaredSurfaceOf({ ...inputs })).toBeUndefined();
    // Twin: the map as returned.
    expect(declaredSurfaceOf(inputs)?.targets['b/delete']).toEqual(purgeTarget);
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
  const clearGate: PurgeGateFacts = { switched: 'on', lifecycle: null, copy: false, foreignTenant: false };
  const now = { now: '2026-01-12T00:00:00.000Z', gate: clearGate };
  const refusal = (id: string, target: OperationTarget = purgeTarget) =>
    refuseTrashedTarget(deps, 'b/delete', target, { boxId: id }, now).then(
      () => 'admitted',
      (e: unknown) => [errorCodeOf(e), (e as { extensions?: { reason?: string } }).extensions?.reason ?? null],
    );

  const refusalUnder = (id: string, gate: PurgeGateFacts) =>
    refuseTrashedTarget(deps, 'b/delete', purgeTarget, { boxId: id }, { now: now.now, gate }).then(
      () => 'admitted',
      (e: unknown) => [errorCodeOf(e), (e as { extensions?: { reason?: string } }).extensions?.reason ?? null],
    );

  it('admits an entity trashed past the horizon', async () => expect(await refusal('due')).toBe('admitted'));
  it('refuses one trashed inside it, an active (restored) one, and a gone one', async () => {
    expect(await refusal('young')).toEqual(['conflict', 'purge_not_due']);
    expect(await refusal('active')).toEqual(['conflict', 'purge_not_due']);
    expect(await refusal('gone')).toEqual(['not_found', null]);
  });
  it('re-applies the sweep gate inside the purge: a held scope is purge_held, a foreign tenant not_found', async () => {
    expect(await refusalUnder('due', { ...clearGate, switched: 'off' })).toEqual(['conflict', 'purge_held']);
    expect(await refusalUnder('due', { ...clearGate, copy: true })).toEqual(['conflict', 'purge_held']);
    expect(await refusalUnder('due', { ...clearGate, lifecycle: 'scope not active (status: suspended)' })).toEqual(['conflict', 'purge_held']);
    expect(await refusalUnder('due', { ...clearGate, foreignTenant: true })).toEqual(['not_found', null]);
    // Twin: clear, the due entity is admitted.
    expect(await refusalUnder('due', clearGate)).toBe('admitted');
  });
  it('refuses the sweep on an operation that is not the purge', async () => {
    expect(await refusal('due', { ...purgeTarget, trashed: 'admits' })).toEqual(['internal', null]);
  });
  it('holds a purge to its parsed input: the id and nothing else, in the sweep or out of it', async () => {
    const run = (input: unknown, sweep?: typeof now) =>
      refuseTrashedTarget(deps, 'b/delete', purgeTarget, input, sweep).then(() => 'admitted', (e: unknown) => errorCodeOf(e));
    for (const sweep of [now, undefined]) {
      expect(await run({ boxId: 'due', otherBoxId: 'young' }, sweep)).toBe('validation_failed');
      expect(await run({ otherBoxId: 'due' }, sweep)).toBe('validation_failed');
      expect(await run(undefined, sweep)).toBe('validation_failed');
      // Twin: exactly the id.
      expect(await run({ boxId: 'due' }, sweep)).toBe('admitted');
    }
  });
});

describe('purgeHeldBy — the purge sweep gate', () => {
  const clear: PurgeGateFacts = { switched: 'on', lifecycle: null, copy: false, foreignTenant: false };
  it('holds a scope whose switch is off or never granted, whose lifecycle refuses, or that is a copy', () => {
    expect(purgeHeldBy(clear)).toBeNull();
    expect(purgeHeldBy({ ...clear, switched: 'off' })).toMatch(/switched off/);
    expect(purgeHeldBy({ ...clear, switched: 'ungranted' })).toMatch(/not granted/);
    expect(purgeHeldBy({ ...clear, lifecycle: 'scope not active (status: suspended)' })).toMatch(/not active/);
    expect(purgeHeldBy({ ...clear, copy: true })).toMatch(/copy/);
  });
  it('refuses a foreign tenant outright, whatever else holds', () => {
    expect(() => purgeHeldBy({ ...clear, foreignTenant: true })).toThrow(/not this scope/);
    expect(() => purgeHeldBy({ ...clear, foreignTenant: true, switched: 'off' })).toThrow(/not this scope/);
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
  /** A pass over `ids`, as a lap at `after` with `failed` earlier failures finds it; the lap write is recorded, not run. */
  const passOver = async (ids: string[], lap: { more: boolean; failed: number }, purgeOne: (id: string) => Promise<void>) => {
    const after = { at: 'x', id: 'y' };
    const due: PurgeDue = { cutoff: 'c', idFrom: 'boxId', ids, lap: { after, failed: lap.failed }, next: lap.more ? { at: 'x', id: ids.at(-1)! } : null };
    return runPurgePass('b/delete', due, purgeOne, () => undefined);
  };
  it('counts restored and already-gone entities as skipped, other throws as errors, and marks a full batch', async () => {
    const outcomes: Record<string, () => void> = {
      a: () => undefined,
      gone: () => {
        throw substratError('not_found', 'gone');
      },
      restored: () => {
        throw substratError('conflict', 'restored', { reason: 'purge_not_due' });
      },
      // The gate held the scope between the sweep's selection and this purge's transaction.
      held: () => {
        throw substratError('conflict', 'held', { reason: 'purge_held' });
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
    const pass = await passOver(ids, { more: true, failed: 3 }, async (id) => outcomes[id]!());
    expect(pass).toEqual({
      purged: 1,
      skipped: 3,
      errors: [
        { entityId: 'refused', error: 'nope' },
        { entityId: 'boom', error: 'crashed' },
      ],
      more: true,
      // The lap goes on: its earlier failures are carried in the cursor, not reported yet.
      lapFailed: 0,
    });
    // The pass that closes a lap reports the lap's earlier failures, so its cadence row keeps them.
    const closing = await passOver(['a'], { more: false, failed: 3 }, async () => undefined);
    expect(closing).toMatchObject({ purged: 1, errors: [], more: false, lapFailed: 3 });
    expect(purgeReportOf('b/delete', 'box', closing).failure?.message).toMatch(/3 failed earlier in this lap/);
    // Twin: a lap with no failures anywhere reports none.
    const clean = await passOver(['a'], { more: false, failed: 0 }, async () => undefined);
    expect(purgeReportOf('b/delete', 'box', clean).failure).toBeUndefined();
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
    const sql = sqlOf(db);
    const [plan] = entityStatePlans('m', [horizon]);
    const cutoff = purgeCutoffOf('2026-01-12T00:00:00.000Z', 7);
    expect(cutoff).toBe('2026-01-05T00:00:00.000Z');
    const ids = (keys: { id: string }[]) => keys.map((k) => k.id);
    expect(ids(purgeCandidates(sql, plan!, cutoff))).toEqual(['older', 'old']);
    expect(ids(purgeCandidates(sql, plan!, cutoff, 1))).toEqual(['older']);
    // After a key: compared as a value, so it places the walk whether or not that row still exists.
    expect(ids(purgeCandidates(sql, plan!, cutoff, 5, { at: '2026-01-01T00:00:00.000Z', id: 'older' }))).toEqual(['old']);
    expect(ids(purgeCandidates(sql, plan!, cutoff, 5, { at: '2026-01-01T12:00:00.000Z', id: 'gone' }))).toEqual(['old']);
    const detail = (db.prepare(`EXPLAIN QUERY PLAN SELECT id FROM boxes WHERE _substrat_trashed_at IS NOT NULL AND _substrat_trashed_at <= ? ORDER BY _substrat_trashed_at, id LIMIT 5`).all('x') as { detail: string }[])
      .map((r) => r.detail)
      .join(' | ');
    expect(detail).toContain('_substrat_purge_boxes');
  });
});

describe('the purge lap (#2096)', () => {
  const NOW = '2026-02-01T00:00:00.000Z';
  const DUE = (n: number) => new Date(Date.parse('2026-01-01T00:00:00.000Z') + n * 60_000).toISOString();
  const setup = (count: number) => {
    const db = new DatabaseSync(':memory:');
    db.exec('CREATE TABLE boxes (id TEXT PRIMARY KEY, name TEXT)');
    db.exec('CREATE TABLE _substrat_state_moves (entity_type TEXT, entity_id TEXT)');
    db.exec(SCHEDULE_STATE_DDL);
    for (const m of entityStateMigrations('m', [horizon])) db.exec(m.sql);
    const sql = sqlOf(db);
    const move = (id: string, when: string | null) => {
      db.prepare("INSERT INTO _substrat_state_moves VALUES ('box', ?)").run(id);
      db.prepare('UPDATE boxes SET _substrat_trashed_at = ? WHERE id = ?').run(when, id);
      db.prepare('DELETE FROM _substrat_state_moves').run();
    };
    const bin = (id: string, minute: number) => {
      db.prepare('INSERT INTO boxes (id, name) VALUES (?, ?)').run(id, id);
      move(id, DUE(minute));
    };
    for (let i = 0; i < count; i++) bin(`b${String(i).padStart(3, '0')}`, i);
    const plans = new Map(entityStatePlans('m', [horizon]).map((p) => [p.entityType, p]));
    const targets = new Map([['b/delete', purgeTarget]]);
    /** One pass: entities in `failing` throw, every other one is deleted. */
    const pass = async (failing: ReadonlySet<string>, limit: number) => {
      const due = purgeDueOf(sql, plans, targets, 'b/delete', 'box', NOW, limit);
      const p = await runPurgePass(
        'b/delete',
        due,
        async (id) => {
          if (failing.has(id)) throw new Error(`stuck ${id}`);
          db.prepare('DELETE FROM boxes WHERE id = ?').run(id);
        },
        (write) => write(sql),
      );
      return { due, pass: p };
    };
    const left = () => (db.prepare('SELECT id FROM boxes ORDER BY id').all() as { id: string }[]).map((r) => r.id);
    return { db, sql, pass, left, bin, move };
  };

  it('walks past a head that always fails: everything behind it is purged in the same lap, and the failures are tried every lap', async () => {
    const { sql, pass, left } = setup(7);
    const failing = new Set(['b000', 'b001', 'b002']);
    const first = await pass(failing, 3);
    expect(first.pass).toMatchObject({ purged: 0, more: true, lapFailed: 0 });
    expect(first.pass.errors.map((e) => e.entityId)).toEqual(['b000', 'b001', 'b002']);
    expect(purgeStillDue(first.pass)).toBe(true);
    expect(readPurgeLap(sql, 'b/delete')).toEqual({ after: { at: DUE(2), id: 'b002' }, failed: 3 });
    const second = await pass(failing, 3);
    expect(second.pass).toMatchObject({ purged: 3, errors: [], more: true });
    const third = await pass(failing, 3);
    // The tail: the lap closes, the cursor clears, and the closing pass carries the lap's failures.
    expect(third.pass).toMatchObject({ purged: 1, errors: [], more: false, lapFailed: 3 });
    expect(purgeStillDue(third.pass)).toBe(false);
    expect(purgeReportOf('b/delete', 'box', third.pass).failure).toBeDefined();
    expect(sql.query('SELECT purge_cursor FROM _substrat_schedule_state')).toEqual([{ purge_cursor: null }]);
    expect(left()).toEqual(['b000', 'b001', 'b002']);
    // The next lap starts at the oldest again: the failures are tried, and reported, again.
    const again = await pass(failing, 3);
    expect(again.pass.errors.map((e) => e.entityId)).toEqual(['b000', 'b001', 'b002']);
    // Exactly a batch left: the peek knows nothing follows, so the lap closes in this pass (#2087).
    expect(again.pass).toMatchObject({ more: false, lapFailed: 0 });
  });

  it('twin: nothing fails, and the lap purges the whole bin batch by batch with no failure recorded', async () => {
    const { pass, left } = setup(7);
    const outcomes = [];
    for (let i = 0; i < 3; i++) outcomes.push((await pass(new Set(), 3)).pass);
    expect(outcomes.map((p) => [p.purged, p.more])).toEqual([[3, true], [3, true], [1, false]]);
    expect(outcomes.every((p) => p.lapFailed === 0 && p.errors.length === 0)).toBe(true);
    expect(left()).toEqual([]);
  });

  it('a bin that changes mid-lap: a restored or vanished cursor entity still places the walk, and one binned behind the cursor waits for the next lap', async () => {
    const { db, pass, left, bin, move } = setup(6);
    const failing = new Set(['b000', 'b001']);
    await pass(failing, 2);
    // The cursor is b001. It is restored, and b003 — ahead of it — is purged by someone else.
    move('b001', null);
    db.prepare('DELETE FROM boxes WHERE id = ?').run('b003');
    // Binned, due, and BEHIND the cursor (an older trash instant than b001's).
    bin('a-late', 0);
    const second = await pass(failing, 2);
    expect(second.due.ids).toEqual(['b002', 'b004']);
    const third = await pass(failing, 2);
    expect(third.due.ids).toEqual(['b005']);
    expect(third.pass.more).toBe(false);
    expect(left()).toEqual(['a-late', 'b000', 'b001']);
    // The next lap reaches the one binned behind the cursor.
    const next = await pass(failing, 2);
    expect(next.due.ids).toEqual(['a-late', 'b000']); // same instant as b000; the id breaks the tie
    expect(left()).toEqual(['b000', 'b001']);
  });

  it('a cursor this code cannot read, or none at all, is the start of a lap', () => {
    expect(purgeLapOf(null)).toEqual({ after: null, failed: 0 });
    expect(purgeLapOf(undefined)).toEqual({ after: null, failed: 0 });
    expect(purgeLapOf('not json')).toEqual({ after: null, failed: 0 });
    expect(purgeLapOf('{"at":1,"id":"x"}')).toEqual({ after: null, failed: 0 });
    expect(purgeLapOf('{"at":"t","id":"x","failed":-4}')).toEqual({ after: { at: 't', id: 'x' }, failed: 0 });
    // Twin: a cursor it wrote.
    expect(purgeLapOf('{"at":"t","id":"x","failed":4}')).toEqual({ after: { at: 't', id: 'x' }, failed: 4 });
  });

  it('a cadence row written before the column — NULL cursor, a run already recorded — starts a lap and keeps the run', async () => {
    const { sql, pass } = setup(3);
    sql.exec(
      "INSERT INTO _substrat_schedule_state (kind, schedule_op, last_run_at, last_status) VALUES ('schedule', 'b/delete', '2020-01-01T00:00:00.000Z', 'ok')",
    );
    const first = await pass(new Set(), 2);
    expect(first.due.ids).toEqual(['b000', 'b001']);
    expect(sql.query("SELECT last_run_at, last_status FROM _substrat_schedule_state WHERE schedule_op = 'b/delete'")).toEqual([
      { last_run_at: '2020-01-01T00:00:00.000Z', last_status: 'ok' },
    ]);
  });
});
