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
  entityStatePlans,
  purgeCandidates,
  purgeCutoffOf,
  purgeHeldBy,
  purgeOnlyKeysOf,
  registerTrashTargets,
  runPurgePass,
  type PurgeGateFacts,
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
/** Declarations as a module's operation surface carries them; the host reads targets off these. */
const declared = {
  'b/delete': { permission: { key: 'box:delete', entity: 'box', idFrom: 'boxId' }, trashed: 'purges', input: z.strictObject({ boxId: z.string() }) },
  'b/rename': { permission: { key: 'box:read', entity: 'box', idFrom: 'boxId' }, input: z.object({ boxId: z.string(), name: z.string() }) },
};
const inputs = operationInputsOf(declared);

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
    const pass = await runPurgePass(ids, ids.length, async (id) => outcomes[id]!());
    expect(pass).toEqual({
      purged: 1,
      skipped: 3,
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
