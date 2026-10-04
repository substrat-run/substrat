import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { LIFECYCLE_FLOW_EVENT_BUDGET, type LifecycleFlowInput } from '@substrat-run/contracts';
import { readLifecycleFlow, REFUSALS_DDL, refusalInsert, type ScopedSql } from '../src/index.js';

/**
 * The process map's replay (#1744), against a real outbox: the read is a keyset walk over
 * an index plus `json_extract`, and a fake `query` would only test the fake.
 */
const DDL = `
  CREATE TABLE _substrat_outbox (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    occurred_at TEXT NOT NULL,
    actor TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    payload TEXT,
    pii_class TEXT NOT NULL,
    operation TEXT,
    invocation_id TEXT
  );
  CREATE INDEX _substrat_outbox_entity ON _substrat_outbox (entity_type, entity_id, id);`;

/** A support conversation, shaped like ticket0's: one op is an edge from one state and allowed in another. */
const LIFECYCLE: LifecycleFlowInput['lifecycle'] = {
  field: 'state',
  initial: 'new',
  states: {
    new: { on: { 'desk/assign': 'open', 'desk/close': 'closed' } },
    open: { on: { 'desk/snooze': 'snoozed', 'desk/resolve': 'resolved', 'desk/close': 'closed' }, allow: ['desk/ingest'] },
    snoozed: { on: { 'desk/wake': 'open', 'desk/close': 'closed' } },
    resolved: { on: { 'desk/ingest': 'open', 'desk/close': 'closed' } },
    closed: { terminal: true },
  },
};

interface Ev {
  entity: string;
  at: string;
  op: string | null;
  /** The payload's state; omitted = the payload carries no state field. */
  state?: string;
  pii?: string;
  erased?: boolean;
  call?: string;
  entityType?: string;
  /** The stored actor JSON; a principal by default. */
  actor?: string;
}

let seq = 0;
interface Refusal {
  at: string;
  from: string;
  operation: string;
  attempted?: string | null;
  entityType?: string;
  actor?: string;
  /** A guard's refusal instead of a transition's (K-38): no from-state to draw a stub from. */
  guard?: string;
}

function readerOver(evs: Ev[], refusals: Refusal[] = []): Pick<ScopedSql, 'query'> {
  const db = new DatabaseSync(':memory:');
  db.exec(DDL);
  // #1745: the kernel's own table, through its own INSERT — what both adapters write.
  db.exec(REFUSALS_DDL);
  for (const f of refusals) {
    const q = refusalInsert({
      tenantId: 't',
      scopeId: 's',
      refused:
        f.guard === undefined
          ? { entityType: f.entityType ?? 'conversation', entityId: 'c1', from: f.from, operation: f.operation, attempted: f.attempted ?? null }
          : { kind: 'guard', predicate: f.guard, operation: f.operation, reason: null, entityType: f.entityType ?? 'conversation', entityId: 'c1' },
      invokedOperation: f.operation,
      actor: f.actor ?? '"prin_ada"',
      impersonation: null,
      invocationId: null,
      at: f.at,
    });
    db.prepare(q.sql).run(...(q.params as never[]));
  }
  const ins = db.prepare(
    `INSERT INTO _substrat_outbox (id, type, occurred_at, actor, entity_type, entity_id, payload, pii_class, operation, invocation_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  db.exec('BEGIN');
  for (const e of evs) {
    seq += 1;
    ins.run(
      `01J${String(seq).padStart(23, '0')}`,
      'desk.changed',
      e.at,
      e.actor ?? '"prin_01J000000000000000000000"',
      e.entityType ?? 'conversation',
      e.entity,
      e.erased ? null : JSON.stringify(e.state === undefined ? { id: e.entity } : { id: e.entity, state: e.state }),
      e.pii ?? 'none',
      e.op,
      e.call ?? null,
    );
  }
  db.exec('COMMIT');
  return {
    query: <T>(sql: string, params: unknown[] = []) => db.prepare(sql).all(...(params as never[])) as T[],
  } as Pick<ScopedSql, 'query'>;
}

const read = (evs: Ev[], over: Partial<LifecycleFlowInput> = {}, refusals: Refusal[] = []) =>
  readLifecycleFlow(
    { sql: readerOver(evs, refusals) },
    { entityType: 'conversation', lifecycle: LIFECYCLE, since: '2026-09-01T00:00:00Z', until: '2026-09-08T00:00:00Z', ...over },
  );

const at = (day: number, hour = 0) => `2026-09-0${day}T${String(hour).padStart(2, '0')}:00:00.000Z`;
const edge = (r: ReturnType<typeof read>, from: string, to: string, op: string | null) =>
  r.edges.find((e) => e.from === from && e.to === to && e.operation === op);
const state = (r: ReturnType<typeof read>, s: string) => r.states.find((x) => x.state === s)!;

describe('readLifecycleFlow (#1744)', () => {
  it('counts the moves the payloads record, and lists a declared edge nobody took at 0', () => {
    const r = read([
      { entity: 'c1', at: at(1), op: 'desk/create', state: 'new' },
      { entity: 'c1', at: at(1, 2), op: 'desk/assign', state: 'open' },
      { entity: 'c1', at: at(1, 6), op: 'desk/resolve', state: 'resolved' },
      { entity: 'c2', at: at(2), op: 'desk/create', state: 'new' },
      { entity: 'c2', at: at(2, 1), op: 'desk/assign', state: 'open' },
    ]);
    expect(edge(r, 'new', 'open', 'desk/assign')).toMatchObject({ count: 2, declared: true });
    expect(edge(r, 'open', 'resolved', 'desk/resolve')).toMatchObject({ count: 1, declared: true });
    expect(edge(r, 'open', 'snoozed', 'desk/snooze')).toMatchObject({ count: 0, declared: true });
    expect(state(r, 'open').current).toBe(1);
    expect(state(r, 'resolved').current).toBe(1);
    expect(state(r, 'open').entered).toBe(2);
    // Stays in `new` that ended inside the window: 2h and 1h.
    expect(state(r, 'new').dwell).toEqual({ samples: 2, medianMs: 3_600_000, p90Ms: 7_200_000 });
    expect(r.observation).toMatchObject({ entities: 2, events: 5, inferred: 0, unexplained: 0, complete: true });
  });

  it('infers the move from the declared edge when the payload cannot say — erased, personal, or field-less', () => {
    const r = read([
      { entity: 'c1', at: at(1), op: 'desk/create', state: 'new' },
      { entity: 'c1', at: at(1, 1), op: 'desk/assign', erased: true, pii: 'personal' },
      { entity: 'c1', at: at(1, 2), op: 'desk/snooze', state: 'snoozed', pii: 'personal' },
      { entity: 'c1', at: at(1, 3), op: 'desk/wake' },
    ]);
    expect(edge(r, 'new', 'open', 'desk/assign')!.count).toBe(1);
    // A classified payload is not read (#1762) even though it carries the field.
    expect(edge(r, 'open', 'snoozed', 'desk/snooze')!.count).toBe(1);
    expect(edge(r, 'snoozed', 'open', 'desk/wake')!.count).toBe(1);
    expect(r.observation.inferred).toBe(3);
  });

  it('reads the same operation as a move or not by where the entity was', () => {
    const r = read([
      { entity: 'c1', at: at(1), op: 'desk/create' },
      { entity: 'c1', at: at(1, 1), op: 'desk/assign' },
      { entity: 'c1', at: at(1, 2), op: 'desk/ingest' }, // allowed in open: no move
      { entity: 'c1', at: at(1, 3), op: 'desk/resolve' },
      { entity: 'c1', at: at(1, 4), op: 'desk/ingest' }, // an edge out of resolved
    ]);
    expect(edge(r, 'resolved', 'open', 'desk/ingest')!.count).toBe(1);
    expect(state(r, 'open').current).toBe(1);
    expect(r.observation.unexplained).toBe(0);
  });

  it('files a move first seen on a later event under the declared pair, not the operation that reported it', () => {
    // An inbound message reopened the conversation and emitted nothing about it; the next
    // conversation event — a priority change — is the first to show `open`.
    const r = read([
      { entity: 'c1', at: at(1), op: 'desk/create', state: 'new' },
      { entity: 'c1', at: at(1, 1), op: 'desk/assign', state: 'open' },
      { entity: 'c1', at: at(1, 2), op: 'desk/resolve', state: 'resolved' },
      { entity: 'c1', at: at(1, 5), op: 'desk/set-priority', state: 'open' },
    ]);
    expect(r.edges.find((e) => e.operation === 'desk/set-priority')).toBeUndefined();
    expect(r.edges.find((e) => e.from === 'resolved' && e.to === 'open' && e.seenLate)).toMatchObject({
      operation: null,
      count: 1,
      declared: true,
      // Nor who: the principal on `desk/set-priority` only exposed the move.
      actors: { unknown: 1 },
    });
    // The declared edge itself is still at 0: nobody can say `desk/ingest` did it.
    expect(edge(r, 'resolved', 'open', 'desk/ingest')!.count).toBe(0);
    expect(r.observation.seenLate).toBe(1);
  });

  it('counts an entity first seen through a declared edge out of the initial state as started', () => {
    const r = read([{ entity: 'c1', at: at(1), op: 'desk/assign', state: 'open' }]);
    expect(edge(r, 'new', 'open', 'desk/assign')!.count).toBe(1);
    expect(r.funnel).toEqual({ started: 1, reached: { new: 1, open: 1 } });
  });

  it('keeps a move the declaration does not have apart, as undeclared', () => {
    const r = read([
      { entity: 'c1', at: at(1), op: 'desk/create', state: 'new' },
      { entity: 'c1', at: at(1, 1), op: 'desk/assign', state: 'resolved' },
      { entity: 'c1', at: at(1, 2), op: null, state: 'open' },
    ]);
    expect(edge(r, 'new', 'resolved', 'desk/assign')).toMatchObject({ count: 1, declared: false });
    expect(edge(r, 'new', 'open', 'desk/assign')!.count).toBe(0);
    // A consumer emit names no operation, so no declaration can hold its move.
    expect(edge(r, 'resolved', 'open', null)).toMatchObject({ count: 1, declared: false });
  });

  it('believes a payload state the declaration does not have, rather than inferring from the operation', () => {
    // `desk/assign` IS the declared edge new → open, but the row says `archived`: the code
    // and the model disagree, and the payload is what the row held.
    const r = read([
      { entity: 'c1', at: at(1), op: 'desk/create', state: 'new' },
      { entity: 'c1', at: at(1, 1), op: 'desk/assign', state: 'archived' },
    ]);
    expect(edge(r, 'new', 'archived', 'desk/assign')).toMatchObject({ count: 1, declared: false });
    expect(edge(r, 'new', 'open', 'desk/assign')!.count).toBe(0);
    expect(r.observation.inferred).toBe(0);
    // Listed, so the instance sitting in it is still counted somewhere.
    expect(state(r, 'archived')).toMatchObject({ declared: false, terminal: false, current: 1, entered: 1 });
    expect(state(r, 'open')).toMatchObject({ declared: true, current: 0 });
    expect(r.totals.inFlight).toBe(1);
  });

  it('believes an undeclared state an entity is first found in', () => {
    const r = read([{ entity: 'c1', at: at(1), op: 'desk/import', state: 'archived' }]);
    expect(state(r, 'archived')).toMatchObject({ declared: false, current: 1 });
    expect(state(r, 'new').current).toBe(0);
  });

  it('stops believing undeclared payload states once there are too many to be an enum', () => {
    // 40 distinct values: past the bound the field is not the enum the model says, and those
    // events fall back to the declaration (here `desk/assign`, the edge new → open).
    const evs: Ev[] = [];
    for (let i = 0; i < 40; i += 1) {
      const entity = `c${String(i).padStart(2, '0')}`;
      evs.push({ entity, at: at(1), op: 'desk/create', state: 'new' });
      evs.push({ entity, at: at(1, 1), op: 'desk/assign', state: `free text ${i}` });
    }
    const r = read(evs);
    expect(r.states.filter((s) => !s.declared)).toHaveLength(32);
    expect(edge(r, 'new', 'open', 'desk/assign')!.count).toBe(8);
    expect(r.observation.inferred).toBe(8);
  });

  it('says who made each move, by the kind of actor the outbox recorded', () => {
    const r = read([
      { entity: 'c1', at: at(1), op: 'desk/create', state: 'new' },
      { entity: 'c1', at: at(1, 1), op: 'desk/assign', state: 'open' },
      { entity: 'c2', at: at(1), op: 'desk/create', state: 'new' },
      { entity: 'c2', at: at(1, 1), op: 'desk/assign', state: 'open', actor: '{"system":"desk-router"}' },
      { entity: 'c3', at: at(1), op: 'desk/create', state: 'new' },
      { entity: 'c3', at: at(1, 1), op: 'desk/assign', state: 'open', actor: 'not json' },
    ]);
    expect(edge(r, 'new', 'open', 'desk/assign')!.actors).toEqual({ principal: 1, system: 1, unknown: 1 });
    expect(edge(r, 'open', 'snoozed', 'desk/snooze')!.actors).toEqual({});
  });

  describe('a declared self-transition', () => {
    // `desk/reassign` keeps the conversation `open`: a real edge, from a state to itself.
    const LOOPING: LifecycleFlowInput['lifecycle'] = {
      ...LIFECYCLE,
      states: { ...LIFECYCLE.states, open: { ...LIFECYCLE.states.open!, on: { ...LIFECYCLE.states.open!.on, 'desk/reassign': 'open' } } },
    };
    const readLooping = (evs: Ev[]) => read(evs, { lifecycle: LOOPING });

    it('is counted on its edge whether the payload says the state or not', () => {
      const r = readLooping([
        { entity: 'c1', at: at(1), op: 'desk/create', state: 'new' },
        { entity: 'c1', at: at(1, 1), op: 'desk/assign', state: 'open' },
        { entity: 'c1', at: at(1, 2), op: 'desk/reassign', state: 'open' },
        { entity: 'c1', at: at(1, 3), op: 'desk/reassign' },
      ]);
      expect(edge(r, 'open', 'open', 'desk/reassign')).toMatchObject({ count: 2, declared: true, actors: { principal: 2 } });
      // Only the state-less one came from the declaration.
      expect(r.observation.inferred).toBe(1);
    });

    it('does not end the stay: no entry, no dwell sample, and `stuck` still dates from the real entry', () => {
      const r = readLooping([
        { entity: 'c1', at: at(1), op: 'desk/create', state: 'new' },
        { entity: 'c1', at: at(1, 1), op: 'desk/assign', state: 'open' },
        { entity: 'c1', at: at(2), op: 'desk/reassign', state: 'open' },
      ]);
      expect(state(r, 'open')).toMatchObject({ entered: 1, dwell: null, current: 1 });
      expect(state(r, 'open').stuck[0]!.since).toBe(at(1, 1));
    });

    it('counts once per call, however many events the call emits', () => {
      const r = readLooping([
        { entity: 'c1', at: at(1), op: 'desk/create', state: 'new' },
        { entity: 'c1', at: at(1, 1), op: 'desk/assign', state: 'open' },
        { entity: 'c1', at: at(1, 2), op: 'desk/reassign', state: 'open', call: 'call-9' },
        { entity: 'c1', at: at(1, 2), op: 'desk/reassign', state: 'open', call: 'call-9' },
      ]);
      expect(edge(r, 'open', 'open', 'desk/reassign')!.count).toBe(1);
    });
  });

  it('moves once per call when one call emits several state-less events for the entity', () => {
    const r = read([
      { entity: 'c1', at: at(1), op: 'desk/create' },
      { entity: 'c1', at: at(1, 1), op: 'desk/assign', call: 'call-1' },
      { entity: 'c1', at: at(1, 1), op: 'desk/assign', call: 'call-1' },
    ]);
    expect(edge(r, 'new', 'open', 'desk/assign')!.count).toBe(1);
  });

  it('counts an edge operation that makes no sense from where the entity is as unexplained, and stays put', () => {
    const r = read([
      { entity: 'c1', at: at(1), op: 'desk/create' },
      { entity: 'c1', at: at(1, 1), op: 'desk/wake' }, // wake is an edge only out of snoozed
    ]);
    expect(r.observation.unexplained).toBe(1);
    expect(state(r, 'new').current).toBe(1);
  });

  it('replays history before the window without counting it, and reads nothing after it', () => {
    const r = read(
      [
        { entity: 'c1', at: '2026-08-30T00:00:00.000Z', op: 'desk/create', state: 'new' },
        { entity: 'c1', at: '2026-08-31T00:00:00.000Z', op: 'desk/assign', state: 'open' },
        { entity: 'c1', at: at(2), op: 'desk/snooze', state: 'snoozed' },
        { entity: 'c1', at: '2026-09-09T00:00:00.000Z', op: 'desk/wake', state: 'open' },
      ],
      {},
    );
    expect(edge(r, 'new', 'open', 'desk/assign')!.count).toBe(0);
    expect(edge(r, 'open', 'snoozed', 'desk/snooze')!.count).toBe(1);
    // The stay in `open` began before the window and ended inside it: two days.
    expect(state(r, 'open').dwell!.medianMs).toBe(2 * 86_400_000);
    // As of `until` it is snoozed; the wake after the window is not read.
    expect(state(r, 'snoozed').current).toBe(1);
    expect(r.funnel.started).toBe(0);
    expect(r.observation.events).toBe(3);
  });

  it('draws the funnel and totals from instances that started inside the window', () => {
    const r = read([
      { entity: 'c1', at: at(1), op: 'desk/create', state: 'new' },
      { entity: 'c1', at: at(1, 1), op: 'desk/assign', state: 'open' },
      { entity: 'c1', at: at(1, 5), op: 'desk/close', state: 'closed' },
      { entity: 'c2', at: at(2), op: 'desk/create', state: 'new' },
      { entity: 'c2', at: at(2, 1), op: 'desk/assign', state: 'open' },
      { entity: 'c3', at: at(3), op: 'desk/create', state: 'new' },
      // Found mid-life, never seen in `new`: not a start.
      { entity: 'c4', at: at(3), op: 'desk/ingest', state: 'resolved' },
    ]);
    expect(r.funnel).toEqual({ started: 3, reached: { closed: 1, new: 3, open: 2 } });
    expect(r.totals).toEqual({ started: 3, finished: 1, inFlight: 3, medianLifecycleMs: 5 * 3_600_000 });
    expect(state(r, 'resolved').current).toBe(1);
  });

  it('lists the longest-stuck instances oldest first, with their last operation, and none for a terminal state', () => {
    const evs: Ev[] = [];
    for (let i = 1; i <= 7; i++) {
      evs.push({ entity: `c${i}`, at: at(1, i), op: 'desk/create', state: 'new' });
      evs.push({ entity: `c${i}`, at: at(1, i + 10), op: 'desk/assign', state: 'open' });
      evs.push({ entity: `c${i}`, at: at(2, i), op: 'desk/ingest', state: 'open' });
    }
    evs.push({ entity: 'c9', at: at(1), op: 'desk/close', state: 'closed' });
    const r = read(evs, { stuckLimit: 3 });
    expect(state(r, 'open').stuck).toEqual([
      { entityId: 'c1', since: at(1, 11), lastOperation: 'desk/ingest', lastAt: at(2, 1) },
      { entityId: 'c2', since: at(1, 12), lastOperation: 'desk/ingest', lastAt: at(2, 2) },
      { entityId: 'c3', since: at(1, 13), lastOperation: 'desk/ingest', lastAt: at(2, 3) },
    ]);
    expect(state(r, 'closed').stuck).toEqual([]);
  });

  it('counts an event at exactly `since` however the caller spells the instant', () => {
    // `…T00:00:00Z` sorts after `…T00:00:00.000Z` as text; the bound is normalized first.
    const evs: Ev[] = [
      { entity: 'c1', at: '2026-09-01T00:00:00.000Z', op: 'desk/create', state: 'new' },
      { entity: 'c1', at: '2026-09-01T00:00:00.000Z', op: 'desk/assign', state: 'open' },
    ];
    expect(edge(read(evs, { since: '2026-09-01T00:00:00Z' }), 'new', 'open', 'desk/assign')!.count).toBe(1);
    expect(() => read(evs, { since: 'last tuesday' })).toThrow(/not an ISO 8601 instant/);
  });

  it('counts the refused moves in the window, grouped by where the record was and what was tried (#1745)', () => {
    const r = read(
      [{ entity: 'c1', at: at(1), op: 'desk/create', state: 'new' }],
      {},
      [
        { at: at(2), from: 'closed', operation: 'desk/ingest', attempted: 'open' },
        { at: at(3), from: 'closed', operation: 'desk/ingest', attempted: 'open', actor: '{"system":"mail"}' },
        { at: at(3), from: 'new', operation: 'desk/wake', attempted: 'open' },
        // Outside the window, and another entity type: neither is counted.
        { at: '2026-08-01T00:00:00.000Z', from: 'closed', operation: 'desk/ingest', attempted: 'open' },
        { at: at(3), from: 'closed', operation: 'desk/ingest', attempted: 'open', entityType: 'contact' },
        // A guard's refusal is the row read's, not a stub: it has no from-state.
        { at: at(3), from: '', operation: 'desk/close', guard: 'protocol/all-signed' },
      ],
    );
    expect(r.refused).toEqual([
      { from: 'closed', attempted: 'open', operation: 'desk/ingest', count: 2, actors: { principal: 1, system: 1 } },
      { from: 'new', attempted: 'open', operation: 'desk/wake', count: 1, actors: { principal: 1 } },
    ]);
  });

  it('reports no refusals as an empty list, not as absent', () => {
    expect(read([{ entity: 'c1', at: at(1), op: 'desk/create', state: 'new' }]).refused).toEqual([]);
  });

  it('reads only the entity type asked for', () => {
    const r = read([
      { entity: 'c1', at: at(1), op: 'desk/create', state: 'new' },
      { entity: 'x1', at: at(1), op: 'desk/assign', state: 'open', entityType: 'contact' },
    ]);
    expect(r.observation.entities).toBe(1);
  });

  it('walks across page boundaries without losing an entity’s place', () => {
    // 1,500 events on one entity, flip-flopping open ↔ snoozed: a page cut mid-entity must
    // resume in the same stay, or the count would be off by the moves at the seam.
    const evs: Ev[] = [
      { entity: 'c1', at: '2026-09-01T00:00:00.000Z', op: 'desk/create', state: 'new' },
      { entity: 'c1', at: '2026-09-01T00:00:01.000Z', op: 'desk/assign', state: 'open' },
    ];
    for (let i = 0; i < 1_498; i++) {
      const snoozed = i % 2 === 0;
      evs.push({
        entity: 'c1',
        at: new Date(Date.parse('2026-09-01T00:01:00.000Z') + i * 1_000).toISOString(),
        op: snoozed ? 'desk/snooze' : 'desk/wake',
        state: snoozed ? 'snoozed' : 'open',
      });
    }
    const r = read(evs);
    expect(edge(r, 'open', 'snoozed', 'desk/snooze')!.count).toBe(749);
    expect(edge(r, 'snoozed', 'open', 'desk/wake')!.count).toBe(749);
    expect(r.observation).toMatchObject({ events: 1_500, complete: true });
  });

  it('stops at the budget and says the answer is incomplete, rather than shrinking it', () => {
    const evs: Ev[] = [];
    for (let i = 0; i <= LIFECYCLE_FLOW_EVENT_BUDGET; i++) {
      evs.push({ entity: `c${String(i).padStart(6, '0')}`, at: at(1), op: 'desk/create', state: 'new' });
    }
    const r = read(evs);
    expect(r.observation).toMatchObject({ events: LIFECYCLE_FLOW_EVENT_BUDGET, complete: false });
  });
});
