import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { eventId } from '@substrat-run/contracts';
import { readInvocation, type ScopedSql } from '../src/index.js';

/**
 * Everything one call did (#1237), against a real outbox — the same reason
 * `event-cause.test.ts` uses one: a fake `query` would test the fake.
 *
 * The property worth stating: this read follows the INVOCATION, not cause. The two
 * walks either side of it follow cause, so both miss a sibling — and a sibling is most
 * of what "what did this request do" means.
 */
const DDL = `
  CREATE TABLE _substrat_outbox (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    occurred_at TEXT NOT NULL,
    actor TEXT NOT NULL,
    payload TEXT,
    authorization TEXT,
    impersonation TEXT,
    pii_class TEXT NOT NULL,
    subject_id TEXT,
    operation TEXT,
    version TEXT,
    caused_by TEXT,
    invocation_id TEXT
  )`;

const id = (n: number) => eventId.parse(`01J${String(n).padStart(23, '0')}`);

interface Ev {
  n: number;
  invocation?: string | null;
  causedBy?: number | null;
}

function readerOver(events: Ev[]): Pick<ScopedSql, 'query'> {
  const db = new DatabaseSync(':memory:');
  db.exec(DDL);
  const ins = db.prepare(
    `INSERT INTO _substrat_outbox (id, type, occurred_at, actor, payload, pii_class, caused_by, invocation_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const e of events) {
    ins.run(
      id(e.n),
      `test.step${e.n}`,
      `2026-09-15T00:00:0${e.n % 10}.000Z`,
      JSON.stringify('01JPRINCIPAL0000000000000'),
      JSON.stringify({ n: e.n }),
      'none',
      e.causedBy == null ? null : id(e.causedBy),
      e.invocation ?? null,
    );
  }
  return {
    query: (<T>(sql: string, params?: unknown[]) =>
      db.prepare(sql).all(...((params ?? []) as never[])) as T[]) as ScopedSql['query'],
  };
}

describe('readInvocation (#1237)', () => {
  it('returns SIBLINGS a causal walk cannot reach', () => {
    // The whole point. Two events from one operation with no causal edge between them:
    // from either, the other is invisible to `walkEventCause` and `walkEventEffects`
    // alike, because both follow cause. They are still the same call.
    const sql = readerOver([
      { n: 1, invocation: 'call-a' },
      { n: 2, invocation: 'call-a' },
    ]);
    const { events, truncated } = readInvocation({ sql }, 'call-a');
    expect(events.map((e) => e.type)).toEqual(['test.step1', 'test.step2']);
    expect(events[0]!.causedBy).toBeNull();
    expect(events[1]!.causedBy).toBeNull();
    expect(truncated).toBe(false);
  });

  it('includes what the call\'s consumers emitted', () => {
    // A consumer's emit belongs to the call that set it off — dispatch runs in the same
    // post-commit tail — so it shares the id and belongs in the answer.
    const sql = readerOver([
      { n: 1, invocation: 'call-a' },
      { n: 2, invocation: 'call-a', causedBy: 1 },
    ]);
    expect(readInvocation({ sql }, 'call-a').events).toHaveLength(2);
  });

  it('returns only THIS call, never a neighbour', () => {
    const sql = readerOver([
      { n: 1, invocation: 'call-a' },
      { n: 2, invocation: 'call-b' },
      { n: 3, invocation: 'call-a' },
    ]);
    expect(readInvocation({ sql }, 'call-a').events.map((e) => e.type)).toEqual([
      'test.step1',
      'test.step3',
    ]);
  });

  it('never matches the events that carry NO invocation', () => {
    // A seed or an internal call records null. Null is not an id, and a read that
    // matched it would gather every unattributed event in the scope under one "call".
    const sql = readerOver([{ n: 1, invocation: null }, { n: 2, invocation: null }]);
    expect(readInvocation({ sql }, 'call-a').events).toEqual([]);
  });

  it('orders by id, which is chronological', () => {
    // Inserted out of order; ULIDs sort by time, so the answer reads in the order the
    // events happened without a second sort key.
    const sql = readerOver([
      { n: 3, invocation: 'call-a' },
      { n: 1, invocation: 'call-a' },
      { n: 2, invocation: 'call-a' },
    ]);
    expect(readInvocation({ sql }, 'call-a').events.map((e) => e.type)).toEqual([
      'test.step1',
      'test.step2',
      'test.step3',
    ]);
  });

  it('says TRUNCATED rather than presenting a partial call as the whole one', () => {
    const sql = readerOver([1, 2, 3, 4].map((n) => ({ n, invocation: 'call-a' })));
    const { events, truncated } = readInvocation({ sql }, 'call-a', 2);
    expect(events).toHaveLength(2);
    // "The call did this much" and "the call did more than is shown" are different
    // claims, and only one of them is true here.
    expect(truncated).toBe(true);
  });

  it('answers an unknown invocation as empty, not as an error', () => {
    const sql = readerOver([{ n: 1, invocation: 'call-a' }]);
    expect(readInvocation({ sql }, 'call-zzz')).toEqual({ events: [], truncated: false });
  });

  it('decodes each event as history', () => {
    const sql = readerOver([{ n: 1, invocation: 'call-a' }]);
    const [entry] = readInvocation({ sql }, 'call-a').events;
    expect(entry!.payload).toEqual({ n: 1 });
    expect(entry!.invocationId).toBe('call-a');
  });
});
