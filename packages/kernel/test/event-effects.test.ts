import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { eventId } from '@substrat-run/contracts';
import { walkEventEffects, type ScopedSql } from '../src/index.js';

/**
 * The forward walk (#1237) — "expand this invocation" — against a REAL outbox and a
 * real delivery table, for the reason `event-cause.test.ts` gives: this is a SQL read
 * over two tables with a join in it, and a fake `query` would test the fake.
 *
 * The delivery half is where the traps are. `delivered_at` is NOT NULL and predates
 * retry state, so it reads as "delivered at" on a terminal row and "last attempted at"
 * on a pending one — and an EMPTY delivery list is ambiguous in a way no query can
 * resolve.
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
  );
  CREATE TABLE _substrat_deliveries (
    event_id TEXT NOT NULL,
    consumer_module TEXT NOT NULL,
    delivered_at TEXT NOT NULL,
    error TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TEXT,
    -- #1525: the call the LAST attempt ran in, which is not the event's.
    invocation_id TEXT,
    PRIMARY KEY (event_id, consumer_module)
  )`;

const id = (n: number) => eventId.parse(`01J${String(n).padStart(23, '0')}`);

interface Ev {
  n: number;
  operation?: string | null;
  causedBy?: number | null;
}
interface Del {
  n: number;
  consumer: string;
  error?: string | null;
  attempts?: number;
  nextAttemptAt?: string | null;
  /** #1525: the call the delivery's last attempt ran in. */
  invocation?: string | null;
}

function readerOver(events: Ev[], deliveries: Del[] = []): Pick<ScopedSql, 'query'> {
  const db = new DatabaseSync(':memory:');
  db.exec(DDL);
  const ins = db.prepare(
    `INSERT INTO _substrat_outbox (id, type, occurred_at, actor, payload, pii_class, operation, caused_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const e of events) {
    ins.run(
      id(e.n),
      `test.step${e.n}`,
      `2026-05-01T00:00:0${e.n % 10}.000Z`,
      JSON.stringify('01JPRINCIPAL0000000000000'),
      JSON.stringify({ n: e.n }),
      'none',
      e.operation ?? null,
      e.causedBy == null ? null : id(e.causedBy),
    );
  }
  const insD = db.prepare(
    `INSERT INTO _substrat_deliveries
       (event_id, consumer_module, delivered_at, error, attempts, next_attempt_at, invocation_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const d of deliveries) {
    insD.run(
      id(d.n),
      d.consumer,
      '2026-05-01T00:01:00.000Z',
      d.error ?? null,
      d.attempts ?? 0,
      d.nextAttemptAt ?? null,
      d.invocation ?? null,
    );
  }
  return {
    query: (<T>(sql: string, params?: unknown[]) =>
      db.prepare(sql).all(...((params ?? []) as never[])) as T[]) as ScopedSql['query'],
  };
}

describe('walkEventEffects (#1237)', () => {
  it('expands an event into what it set off', () => {
    // 1 → 2 → 3: an operation's event, the consumer's event, and that one's.
    const sql = readerOver([
      { n: 1, operation: 'billing/close' },
      { n: 2, causedBy: 1 },
      { n: 3, causedBy: 2 },
    ]);
    const tree = walkEventEffects({ sql }, id(1));
    expect(tree.terminal).toBe('complete');
    expect(tree.count).toBe(3);
    expect(tree.root!.event.operation).toBe('billing/close');
    expect(tree.root!.effects).toHaveLength(1);
    expect(tree.root!.effects[0]!.effects[0]!.event.type).toBe('test.step3');
  });

  it('resolves the three delivery states, and dates each by what it means', () => {
    // The trap. `delivered_at` is "delivered at" on a terminal row and "last attempted
    // at" on a pending one, so a view that printed one label would date a delivery that
    // has not happened.
    const sql = readerOver(
      [{ n: 1, operation: 'op' }],
      [
        { n: 1, consumer: '@x/ok' },
        { n: 1, consumer: '@x/retry', error: 'boom', attempts: 2, nextAttemptAt: '2026-05-02T00:00:00.000Z' },
        { n: 1, consumer: '@x/dead', error: 'fatal', attempts: 5 },
      ],
    );
    const tree = walkEventEffects({ sql }, id(1));
    const byConsumer = Object.fromEntries(tree.root!.deliveries.map((d) => [d.consumer, d]));
    expect(byConsumer['@x/ok']!.state).toBe('delivered');
    expect(byConsumer['@x/ok']!.error).toBeNull();
    // Pending is decided by `next_attempt_at`, NOT by the presence of an error: a dead
    // row has an error too, and conflating them would promise a retry that is not coming.
    expect(byConsumer['@x/retry']!.state).toBe('retrying');
    expect(byConsumer['@x/retry']!.attempts).toBe(2);
    expect(byConsumer['@x/dead']!.state).toBe('dead');
    expect(byConsumer['@x/dead']!.error).toBe('fatal');
  });

  it('carries each delivery\'s own invocation, per row and independent of the event (#1525)', () => {
    // PER ROW, which is the property a single-delivery assertion cannot see: three
    // consumers of one event are attempted separately, so their calls can differ — an
    // implementation that lifted one id for the whole event would pass that test and
    // fail this one. Null beside a named id is the control: it must stay null rather
    // than falling back to the event's.
    const sql = readerOver(
      [{ n: 1, operation: 'op' }],
      [
        { n: 1, consumer: '@x/ok', invocation: 'call-1' },
        { n: 1, consumer: '@x/retry', error: 'boom', attempts: 2, nextAttemptAt: '2026-05-02T00:00:00.000Z', invocation: 'call-2' },
        { n: 1, consumer: '@x/dead', error: 'fatal', attempts: 5 },
      ],
    );
    const byConsumer = Object.fromEntries(
      walkEventEffects({ sql }, id(1)).root!.deliveries.map((d) => [d.consumer, d]),
    );
    expect(byConsumer['@x/ok']!.invocationId).toBe('call-1');
    expect(byConsumer['@x/retry']!.invocationId).toBe('call-2');
    expect(byConsumer['@x/dead']!.invocationId).toBeNull();
  });

  it('reports no deliveries as empty, which is the ambiguous answer it is', () => {
    // Nothing here can tell "no consumer declares this type" from "dispatch has not run
    // yet" — the table records arrivals, never their absence. The empty list is carried
    // up so the VIEW can say so, rather than being turned into a claim here.
    const sql = readerOver([{ n: 1, operation: 'op' }]);
    expect(walkEventEffects({ sql }, id(1)).root!.deliveries).toEqual([]);
  });

  it('caps on NODES, so a wide fan-out is cut as honestly as a deep one', () => {
    const sql = readerOver([
      { n: 1, operation: 'op' },
      { n: 2, causedBy: 1 },
      { n: 3, causedBy: 1 },
      { n: 4, causedBy: 1 },
      { n: 5, causedBy: 1 },
    ]);
    const tree = walkEventEffects({ sql }, id(1), 3);
    expect(tree.count).toBe(3);
    // A tree cut without saying so reads as a complete one.
    expect(tree.terminal).toBe('depth');
  });

  it('names a cycle as an integrity failure, not as a big tree', () => {
    // A cause is always older than what it caused, so this is impossible on a sound
    // spine. Calling it `depth` would invite a reader to ask for a higher limit.
    const sql = readerOver([
      { n: 1, operation: 'op', causedBy: 2 },
      { n: 2, causedBy: 1 },
    ]);
    const tree = walkEventEffects({ sql }, id(1));
    expect(tree.terminal).toBe('cycle');
  });

  it('lets a cycle found early outrank the cap hit later', () => {
    // One `terminal` is shared by every level of the walk, so a cycle found under an
    // early child used to be overwritten by the cap biting under a later one — and
    // `depth` invites a retry with a bigger limit, which does not mend a cycle. (The
    // other order cannot happen: once the cap is hit every loop breaks before another
    // child is examined, so nothing can be found after `depth`.)
    const sql = readerOver([
      // 1 claims to be caused by 3, and 3 by 1: the cycle, reached under the second child.
      { n: 1, operation: 'op', causedBy: 3 },
      { n: 2, causedBy: 1 },
      { n: 3, causedBy: 1 },
      { n: 4, causedBy: 1 },
      { n: 5, causedBy: 1 },
    ]);
    // Cap 4: nodes 1, 2, 3 (whose child 1 is already seen → cycle), 4 — then 5 hits the cap.
    const tree = walkEventEffects({ sql }, id(1), 4);
    expect(tree.count).toBe(4);
    expect(tree.terminal).toBe('cycle');
  });

  it('reports MISSING for an event this scope never had', () => {
    const tree = walkEventEffects({ sql: readerOver([{ n: 1, operation: 'op' }]) }, id(9));
    expect(tree.root).toBeNull();
    expect(tree.terminal).toBe('missing');
    expect(tree.count).toBe(0);
  });

  it('decodes each node as history, so a caller never re-parses a column', () => {
    const sql = readerOver([{ n: 1, operation: 'op' }]);
    const root = walkEventEffects({ sql }, id(1)).root!;
    expect(root.event.payload).toEqual({ n: 1 });
    expect(root.event.actor).toBe('01JPRINCIPAL0000000000000');
    expect(root.event.causedBy).toBeNull();
  });

  it('walks a branch under each child, not just the first', () => {
    // Two independent consumers each emitting: a tree, not a list.
    const sql = readerOver([
      { n: 1, operation: 'op' },
      { n: 2, causedBy: 1 },
      { n: 3, causedBy: 1 },
      { n: 4, causedBy: 2 },
      { n: 5, causedBy: 3 },
    ]);
    const tree = walkEventEffects({ sql }, id(1));
    expect(tree.terminal).toBe('complete');
    expect(tree.count).toBe(5);
    expect(tree.root!.effects.map((e) => e.effects.length)).toEqual([1, 1]);
  });
});
