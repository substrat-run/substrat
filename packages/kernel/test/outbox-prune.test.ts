import { DatabaseSync } from 'node:sqlite';
import { ENTITY_STATE_MOVE_TYPES } from '@substrat-run/contracts';
import { describe, expect, it } from 'vitest';
import { OUTBOX_PRUNED_DDL, pruneDrainedOutbox, walkCursorAt, walkCursorPastFloor, WatermarkPruned, type OutboxPruneInput } from '../src/outbox-prune.js';
import { COPY_ORIGIN_DDL } from '../src/scope-copy.js';
import type { SwitchSql } from '../src/system-switch.js';

/**
 * #1334: the prune's rule, over real SQLite. Each case builds one old drained row (`T`) that the
 * baseline prunes, then changes one fact about its world; the row must stay. The adapters run
 * this same function inside their own transaction, and the contract suite drives it through both.
 */
const OLD = '2026-01-01T00:00:00.000Z';
const BEFORE = '2026-02-01T00:00:00.000Z';
const T = 'E05';
const MOVE = ENTITY_STATE_MOVE_TYPES[0]!;

const store = (): { db: DatabaseSync; sql: SwitchSql } => {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE _substrat_outbox (id TEXT PRIMARY KEY, type TEXT NOT NULL, entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL, caused_by TEXT, drained_at TEXT);
    CREATE TABLE _substrat_deliveries (event_id TEXT NOT NULL, consumer_module TEXT NOT NULL,
      delivered_at TEXT NOT NULL, error TEXT, next_attempt_at TEXT, PRIMARY KEY (event_id, consumer_module));
    CREATE TABLE _substrat_imports (event_id TEXT PRIMARY KEY, hops INTEGER NOT NULL);
    ${COPY_ORIGIN_DDL}
    ${OUTBOX_PRUNED_DDL}
  `);
  return {
    db,
    sql: {
      all: (q, ...p) => db.prepare(q).all(...p) as Record<string, unknown>[],
      run: (q, ...p) => void db.prepare(q).run(...p),
    },
  };
};

type Row = { id: string; type?: string; entity?: string; causedBy?: string; drainedAt?: string | null };
const put = (db: DatabaseSync, r: Row): void =>
  void db
    .prepare('INSERT INTO _substrat_outbox (id, type, entity_type, entity_id, caused_by, drained_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(r.id, r.type ?? 'x.happened', 'thing', r.entity ?? 'a', r.causedBy ?? null, r.drainedAt === undefined ? OLD : r.drainedAt);
const deliver = (db: DatabaseSync, eventId: string, module: string, outcome: { error?: string; due?: string } = {}): void =>
  void db
    .prepare('INSERT INTO _substrat_deliveries (event_id, consumer_module, delivered_at, error, next_attempt_at) VALUES (?, ?, ?, ?, ?)')
    .run(eventId, module, OLD, outcome.error ?? null, outcome.due ?? null);
const ids = (db: DatabaseSync): string[] =>
  (db.prepare('SELECT id FROM _substrat_outbox ORDER BY id').all() as { id: string }[]).map((r) => r.id);

const base: OutboxPruneInput = { drainedBefore: BEFORE, limit: 100, due: true, subscribers: [], exportTypes: [] };

describe('pruneDrainedOutbox (#1334)', () => {
  // `T` with a newer row about the same entity and of the same type: the baseline prunes it.
  const world = (): ReturnType<typeof store> => {
    const s = store();
    put(s.db, { id: T });
    put(s.db, { id: 'E09', drainedAt: null });
    return s;
  };

  it('prunes a superseded drained row nothing subscribes to, and one its subscriber took', () => {
    const plain = world();
    expect(pruneDrainedOutbox(plain.sql, base)).toBe(1);
    expect(ids(plain.db)).toEqual(['E09']);

    const taken = world();
    deliver(taken.db, T, 'mine');
    expect(pruneDrainedOutbox(taken.sql, { ...base, subscribers: [{ deliveryId: 'mine', eventType: 'x.happened' }] })).toBe(1);
    expect(taken.db.prepare('SELECT COUNT(*) AS n FROM _substrat_deliveries').get()).toEqual({ n: 0 });
  });

  it.each<[string, (s: ReturnType<typeof store>) => Partial<OutboxPruneInput> | void]>([
    ['a dead letter for its subscriber', (s) => {
      deliver(s.db, T, 'mine', { error: 'gave up' });
      return { subscribers: [{ deliveryId: 'mine', eventType: 'x.happened' }] };
    }],
    ['only another subscriber took it', (s) => {
      deliver(s.db, T, 'other');
      return { subscribers: [{ deliveryId: 'mine', eventType: 'x.happened' }] };
    }],
    ['its type is exported', () => ({ exportTypes: ['x.happened'] })],
    ['it was copied in, not emitted here', (s) => {
      s.sql.run("INSERT INTO _substrat_copy_origin (id, events_through, copied_at, is_copy) VALUES (1, 'E06', ?, 1)", OLD);
    }],
    ['the only newer row about its entity is a state move', (s) => {
      s.sql.run('DELETE FROM _substrat_outbox WHERE id = ?', 'E09');
      put(s.db, { id: 'E07', entity: 'b' });
      put(s.db, { id: 'E08', type: MOVE });
    }],
    ['it is the newest of its type', (s) => {
      s.sql.run('DELETE FROM _substrat_outbox WHERE id = ?', 'E09');
      put(s.db, { id: 'E09', type: 'y.happened', drainedAt: null });
    }],
    ['its cause chain reaches an import', (s) => {
      s.sql.run("INSERT INTO _substrat_imports (event_id, hops) VALUES ('I01', 1)");
      s.sql.run("UPDATE _substrat_outbox SET caused_by = 'I01' WHERE id = ?", T);
    }],
    ['it was drained inside retention', () => ({ drainedBefore: OLD })],
    ['it was never drained', (s) => {
      s.sql.run('UPDATE _substrat_outbox SET drained_at = NULL WHERE id = ?', T);
    }],
  ])('keeps the row when %s', (_case, change) => {
    const s = world();
    const input = { ...base, ...(change(s) ?? {}) };
    expect(pruneDrainedOutbox(s.sql, input)).toBe(0);
    expect(ids(s.db)).toContain(T);
  });

  it('keeps the floor at the highest id ever pruned', () => {
    const s = store();
    put(s.db, { id: 'E10' });
    put(s.db, { id: 'E03' });
    deliver(s.db, 'E10', 'mine');
    deliver(s.db, 'E03', 'mine', { due: OLD });
    put(s.db, { id: 'E20', drainedAt: null });
    const mine = { ...base, subscribers: [{ deliveryId: 'mine', eventType: 'x.happened' }] };
    expect(pruneDrainedOutbox(s.sql, mine)).toBe(1); // E10; E03 is still retrying
    s.sql.run('UPDATE _substrat_deliveries SET next_attempt_at = NULL');
    expect(pruneDrainedOutbox(s.sql, mine)).toBe(1); // E03, below the floor
    expect(s.sql.all('SELECT through FROM _substrat_outbox_pruned')).toEqual([{ through: 'E10' }]);
  });

  it('continues a lap a cap stopped on every pass, and waits for its hour once caught up', () => {
    const s = store();
    // Three rows that never qualify (each its entity's only row), then two that do.
    for (const [id, entity] of [['E01', 'p'], ['E02', 'q'], ['E03', 'r'], ['E04', 'a'], ['E05', 'a']] as const) put(s.db, { id, entity });
    put(s.db, { id: 'E09', drainedAt: null });
    const pass = (due: boolean) => pruneDrainedOutbox(s.sql, { ...base, due, limit: 1, scanLimit: 3 });
    expect(pass(true)).toBe(0); // the scan cap stops it at E03
    expect(pass(false)).toBe(1); // continues without its hour: E04, then the delete cap stops it
    expect(pass(false)).toBe(1); // E05, and the delete cap again
    expect(pass(false)).toBe(0); // the window's end: the lap is over
    expect(s.sql.all('SELECT scan_at, scan_id FROM _substrat_outbox_pruned')).toEqual([{ scan_at: null, scan_id: null }]);
    put(s.db, { id: 'E06' });
    expect(pass(false)).toBe(0); // caught up: a new lap waits for the scope's hour
    expect(pass(true)).toBe(0); // its hour: the new lap steps over the front again
    expect(pass(false)).toBe(1); // and continues to E06
    expect(ids(s.db)).toEqual(['E01', 'E02', 'E03', 'E09']);
  });
});

describe('scope walk cursors against the pruned floor (#1334)', () => {
  it.each<[string, string, string | undefined, string | 'refused']>([
    ['a bare id above the floor', 'E09', 'E05', 'E09'],
    ['a bare id with no floor', 'E01', undefined, 'E01'],
    ['a bare watermark below the floor', 'E02', 'E05', 'refused'],
    ['a continuation minted under this floor', 'E02~E05', 'E05', 'E02'],
    ['a continuation a later prune overtook', 'E02~E05', 'E07', 'refused'],
  ])('%s', (_case, cursor, floor, expected) => {
    if (expected === 'refused') expect(() => walkCursorPastFloor(cursor, floor)).toThrow(WatermarkPruned);
    else expect(walkCursorPastFloor(cursor, floor)).toBe(expected);
  });

  it('mints a continuation only below the floor', () => {
    expect(walkCursorAt('E02', 'E05')).toBe('E02~E05');
    expect(walkCursorAt('E06', 'E05')).toBe('E06');
    expect(walkCursorAt(null, 'E05')).toBeNull();
  });
});
