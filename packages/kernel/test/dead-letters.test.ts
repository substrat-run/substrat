import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { eventId } from '@substrat-run/contracts';
import { readDeadLetters, type ScopedSql } from '../src/index.js';

/**
 * The scope-wide dead-letter read (#1525), against a real outbox and a real delivery
 * table — a join over two tables, so a fake `query` would test the fake.
 *
 * The property worth stating: "dead" is TWO conditions. A retrying row carries an error
 * as well, and a list that forgot `next_attempt_at` would tell a reader a delivery had
 * given up while it was still going to run.
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
    invocation_id TEXT
  );
  CREATE TABLE _substrat_deliveries (
    event_id TEXT NOT NULL,
    consumer_module TEXT NOT NULL,
    delivered_at TEXT NOT NULL,
    error TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TEXT,
    PRIMARY KEY (event_id, consumer_module)
  )`;

const id = (n: number) => eventId.parse(`01J${String(n).padStart(23, '0')}`);

interface Del {
  n: number;
  consumer: string;
  error?: string | null;
  attempts?: number;
  nextAttemptAt?: string | null;
}

function readerOver(events: number[], deliveries: Del[], invocation: string | null = null): Pick<ScopedSql, 'query'> {
  const db = new DatabaseSync(':memory:');
  db.exec(DDL);
  const ins = db.prepare(
    `INSERT INTO _substrat_outbox (id, type, occurred_at, actor, entity_type, entity_id, payload, pii_class, invocation_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const n of events) {
    ins.run(
      id(n),
      `test.step${n}`,
      `2026-09-17T00:00:0${n % 10}.000Z`,
      JSON.stringify('01JPRINCIPAL0000000000000'),
      'order',
      `order-${n}`,
      JSON.stringify({ n }),
      'none',
      invocation,
    );
  }
  const insD = db.prepare(
    `INSERT INTO _substrat_deliveries (event_id, consumer_module, delivered_at, error, attempts, next_attempt_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  for (const d of deliveries) {
    insD.run(id(d.n), d.consumer, '2026-09-17T00:01:00.000Z', d.error ?? null, d.attempts ?? 0, d.nextAttemptAt ?? null);
  }
  return {
    query: (<T>(sql: string, params?: unknown[]) =>
      db.prepare(sql).all(...((params ?? []) as never[])) as T[]) as ScopedSql['query'],
  };
}

describe('readDeadLetters (#1525)', () => {
  it('lists a delivery that gave up, and neither a delivered nor a RETRYING one', () => {
    const sql = readerOver(
      [1, 2, 3],
      [
        { n: 1, consumer: '@test/ok' },
        // Retrying: an error AND a next attempt. Not dead — it is going to run again.
        { n: 2, consumer: 'executor:flaky', error: 'boom', attempts: 1, nextAttemptAt: '2026-09-17T01:00:00.000Z' },
        { n: 3, consumer: '@test/doomed', error: 'always fails', attempts: 1 },
      ],
    );
    const { entries, nextCursor } = readDeadLetters({ sql });
    expect(entries.map((e) => [e.eventType, e.consumer])).toEqual([['test.step3', '@test/doomed']]);
    expect(nextCursor).toBeNull();
  });

  it('carries the event envelope a reader opens next, and no payload', () => {
    const sql = readerOver([4], [{ n: 4, consumer: '@test/doomed', error: 'always fails', attempts: 2 }], 'call-a');
    const [entry] = readDeadLetters({ sql }).entries;
    expect(entry).toEqual({
      eventId: id(4),
      eventType: 'test.step4',
      occurredAt: '2026-09-17T00:00:04.000Z',
      entity: { entityType: 'order', entityId: 'order-4' },
      invocationId: 'call-a',
      consumer: '@test/doomed',
      at: '2026-09-17T00:01:00.000Z',
      error: 'always fails',
      attempts: 2,
    });
    expect(entry).not.toHaveProperty('payload');
  });

  it('orders newest event first', () => {
    const sql = readerOver(
      [1, 2, 3],
      [1, 3, 2].map((n) => ({ n, consumer: '@test/doomed', error: 'x' })),
    );
    expect(readDeadLetters({ sql }).entries.map((e) => e.eventType)).toEqual(['test.step3', 'test.step2', 'test.step1']);
  });

  it('pages without skipping the other consumers of an event split across a boundary', () => {
    // The reason the cursor is the PAIR: one event gave up on three consumers, and a
    // cursor on the event alone would lose the two after the page boundary.
    const sql = readerOver(
      [1, 2],
      [
        { n: 2, consumer: '@test/a', error: 'x' },
        { n: 2, consumer: '@test/b', error: 'x' },
        { n: 2, consumer: '@test/c', error: 'x' },
        { n: 1, consumer: '@test/a', error: 'x' },
      ],
    );
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 10; i += 1) {
      const page = readDeadLetters({ sql }, { limit: 2, cursor });
      seen.push(...page.entries.map((e) => `${e.eventType}:${e.consumer}`));
      if (page.nextCursor === null) break;
      cursor = page.nextCursor;
    }
    expect(seen).toEqual(['test.step2:@test/c', 'test.step2:@test/b', 'test.step2:@test/a', 'test.step1:@test/a']);
  });

  it('keeps the executor prefix, so a consumer id and an executor never read as the same thing', () => {
    const sql = readerOver([1], [{ n: 1, consumer: 'executor:mailer', error: 'x', attempts: 5 }]);
    expect(readDeadLetters({ sql }).entries[0]!.consumer).toBe('executor:mailer');
  });

  it('answers an empty page, not an error, for a scope with nothing dead', () => {
    const sql = readerOver([1], [{ n: 1, consumer: '@test/ok' }]);
    expect(readDeadLetters({ sql })).toEqual({ entries: [], nextCursor: null });
  });
});
