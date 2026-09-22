import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import {
  deadLetter,
  denialOperationBucket,
  eventDelivery,
  type EventId,
} from '@substrat-run/contracts';
import {
  mapDenialOperationBucketRow,
  mapDenialSummaryBuckets,
  readDeadLetters,
  walkEventEffects,
  type DenialOperationBucketRow,
  type ScopedSql,
  VERTICAL_EVENTS_DDL,
} from '../src/index.js';

/**
 * #1643 — the three mappers #1641 left casting: `deliveryOf`, the `readDeadLetters` map and
 * `mapDenialOperationBucketRow`. Each is a LIST mapper, so each is held to #1634's rule the
 * way its siblings are: a value is only ever replaced by one its own schema accepts, the
 * evidence goes in `decodeError`, and a required scalar with no honest empty value throws
 * naming its column — never returned typed as valid.
 *
 * Against a REAL SQLite table, so a cell comes back with SQLite's own type: INTEGER affinity
 * keeps text it cannot convert (which is how `attempts` is corrupt at all), and a BLOB is how
 * a TEXT column holds a non-string.
 */

const AT = '2026-09-17T00:00:00.000Z';
const id = (n: number) => `01J${String(n).padStart(23, '0')}`;
const CALL = 'call-1';

const DDL = `
  CREATE TABLE _substrat_outbox (
    id TEXT PRIMARY KEY, type TEXT NOT NULL, occurred_at TEXT NOT NULL, actor TEXT NOT NULL,
    entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, payload TEXT, authorization TEXT,
    impersonation TEXT, pii_class TEXT NOT NULL, subject_id TEXT, operation TEXT, version TEXT,
    caused_by TEXT, invocation_id TEXT
  );
  CREATE TABLE _substrat_deliveries (
    event_id TEXT NOT NULL, consumer_module TEXT NOT NULL, delivered_at TEXT NOT NULL,
    error TEXT, attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at TEXT, invocation_id TEXT,
    PRIMARY KEY (event_id, consumer_module)
  )`;

type Cell = string | number | Uint8Array | null;
type Cells = Record<string, Cell>;

const event = (n: number, over: Cells = {}): Cells => ({
  id: id(n),
  type: 'test.happened',
  occurred_at: AT,
  actor: JSON.stringify('01JZPR1NC1PA1000000000000A'),
  entity_type: 'thing',
  entity_id: `x${n}`,
  payload: JSON.stringify({ n }),
  authorization: null,
  impersonation: null,
  pii_class: 'none',
  subject_id: null,
  operation: 'thing/update',
  version: null,
  caused_by: null,
  invocation_id: CALL,
  ...over,
});

const delivery = (n: number, over: Cells = {}): Cells => ({
  event_id: id(n),
  consumer_module: '@test/doomed',
  delivered_at: AT,
  error: 'gave up',
  attempts: 3,
  next_attempt_at: null,
  invocation_id: 'attempt-call',
  ...over,
});

function world(events: Cells[], deliveries: Cells[]): Pick<ScopedSql, 'query'> {
  const db = new DatabaseSync(':memory:');
  db.exec(DDL);
  // #1705: every scope has the import journal, and the dead-letter read consults it.
  db.exec(VERTICAL_EVENTS_DDL);
  const put = (table: string, r: Cells) => {
    const cols = Object.keys(r);
    db.prepare(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(
      ...(Object.values(r) as never[]),
    );
  };
  events.forEach((r) => put('_substrat_outbox', r));
  deliveries.forEach((r) => put('_substrat_deliveries', r));
  return {
    query: (<T>(sql: string, params?: unknown[]) =>
      db.prepare(sql).all(...((params ?? []) as never[])) as T[]) as ScopedSql['query'],
  };
}

/** The deliveries `walkEventEffects` reports for event `n` — `deliveryOf`'s only caller. */
const deliveriesOf = (sql: Pick<ScopedSql, 'query'>, n: number) =>
  walkEventEffects({ sql }, id(n) as EventId).root!.deliveries;

describe('deliveryOf — one delivery row, decoded (#1643)', () => {
  it('reads a healthy row exactly as the cast did, with no decodeError — the positive twin', () => {
    const sql = world(
      [event(1)],
      [
        delivery(1, { consumer_module: '@test/a', error: null, attempts: 1 }),
        delivery(1, { consumer_module: '@test/b', error: 'boom', attempts: 2, next_attempt_at: AT }),
        delivery(1, { consumer_module: '@test/c' }),
      ],
    );
    const got = deliveriesOf(sql, 1);
    expect(got).toStrictEqual([
      { consumer: '@test/a', state: 'delivered', at: AT, error: null, attempts: 1, invocationId: 'attempt-call' },
      { consumer: '@test/b', state: 'retrying', at: AT, error: 'boom', attempts: 2, invocationId: 'attempt-call' },
      { consumer: '@test/c', state: 'dead', at: AT, error: 'gave up', attempts: 3, invocationId: 'attempt-call' },
    ]);
    for (const d of got) expect(() => eventDelivery.parse(d)).not.toThrow();
  });

  it('still reads an EXECUTOR delivery — `executor:<id>` is not a module id, and a healthy row must not throw', () => {
    // The trap the schema had to be widened for: a decode against a bare `moduleId` refuses the
    // colon, so the fix itself would have thrown on every healthy executor delivery.
    const sql = world([event(1)], [delivery(1, { consumer_module: 'executor:mailer', attempts: 4 })]);
    expect(deliveriesOf(sql, 1)).toMatchObject([{ consumer: 'executor:mailer', state: 'dead', attempts: 4 }]);
  });

  it.each(['executor:', 'executor:line\nbreak', 'executor:a b/ç'])(
    'reads an executor delivery registered under %j — the reader matches the writer, not a tidier id',
    (consumer) => {
      // `registerExecutor` accepts any string and the adapters persist `executor:${id}`, so the kernel
      // can write these itself. Its well-formed twin (`executor:mailer`) is the test above.
      const sql = world([event(1)], [delivery(1, { consumer_module: consumer })]);
      expect(deliveriesOf(sql, 1)).toMatchObject([{ consumer, state: 'dead' }]);
      expect(readDeadLetters({ sql }).entries).toMatchObject([{ consumer }]);
    },
  );

  it('still refuses a consumer that is neither a module id nor an executor — the prefix is the rule', () => {
    for (const consumer of ['executorx:mailer', 'Executor:mailer', '', 'Not A Module!']) {
      const sql = world([event(1)], [delivery(1, { consumer_module: consumer })]);
      expect(() => deliveriesOf(sql, 1)).toThrow(/consumer_module: /);
    }
  });

  it.each([
    ['a negative count', -1],
    ['a fractional count', 1.5],
    ['text INTEGER affinity could not convert', 'many'],
  ] as const)('throws naming `attempts` for %s — a required scalar, never returned typed as valid', (_l, attempts) => {
    const sql = world([event(1)], [delivery(1, { attempts })]);
    expect(() => deliveriesOf(sql, 1)).toThrow(/delivery row "@test\/doomed" cannot be read as a valid EventDelivery — attempts: /);
  });

  it('throws naming every required column that broke, and never quotes the stored text', () => {
    const sql = world([event(1)], [delivery(1, { attempts: -3, delivered_at: 'yesterday-ish', consumer_module: 'Not A Module!' })]);
    let message = '';
    try {
      deliveriesOf(sql, 1);
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/consumer_module: /);
    expect(message).toMatch(/delivered_at: /);
    expect(message).toMatch(/attempts: /);
    expect(message).not.toContain('yesterday-ish');
    // The row is NAMED by its consumer — an identifier, as a denial row is named by its id —
    // but no column's stored value is quoted as evidence.
    expect(message.replace('delivery row "Not A Module!"', '')).not.toContain('Not A Module!');
  });

  it('reads a nullable column that broke as null beside a decodeError, and state stays the stored fact', () => {
    // A BLOB in the TEXT `invocation_id` / `error` columns — the only way a non-string gets in.
    const sql = world(
      [event(1)],
      [delivery(1, { invocation_id: new Uint8Array([1]), error: new Uint8Array([2]), consumer_module: '@test/blobby' })],
    );
    const [d] = deliveriesOf(sql, 1);
    expect(d).toMatchObject({ consumer: '@test/blobby', state: 'dead', error: null, invocationId: null, attempts: 3 });
    expect(d!.decodeError).toMatch(/^error: .*; invocation_id: /);
    expect(() => eventDelivery.parse(d)).not.toThrow();
  });

  it('tests state by presence, not truthiness — an EMPTY error is a delivery that gave up, not one that did not', () => {
    const sql = world([event(1)], [delivery(1, { error: '' })]);
    expect(deliveriesOf(sql, 1)).toMatchObject([{ state: 'dead', error: '' }]);
    // …and an empty next_attempt_at is a pending marker, exactly as `IS NOT NULL` reads it in SQL.
    const pending = world([event(1)], [delivery(1, { next_attempt_at: '' })]);
    expect(deliveriesOf(pending, 1)).toMatchObject([{ state: 'retrying' }]);
  });
});

describe('readDeadLetters — the row map, decoded against a published schema (#1643)', () => {
  it('lists a healthy row, exactly as the casts did, with no decodeError — the positive twin', () => {
    const sql = world([event(1), event(2)], [delivery(1), delivery(2, { consumer_module: 'executor:mailer' })]);
    const { entries } = readDeadLetters({ sql });
    expect(entries).toHaveLength(2);
    expect(entries[0]).toStrictEqual({
      eventId: id(2),
      eventType: 'test.happened',
      occurredAt: AT,
      entity: { entityType: 'thing', entityId: 'x2' },
      invocationId: CALL,
      attemptInvocationId: 'attempt-call',
      consumer: 'executor:mailer',
      at: AT,
      error: 'gave up',
      attempts: 3,
    });
    for (const e of entries) expect(() => deadLetter.parse(e)).not.toThrow();
  });

  it('a nullable column that broke reads null beside a decodeError, and its neighbours are listed', () => {
    const sql = world(
      [event(1, { invocation_id: new Uint8Array([9]) }), event(2)],
      [delivery(1, { invocation_id: new Uint8Array([8]) }), delivery(2)],
    );
    const { entries } = readDeadLetters({ sql });
    expect(entries.map((e) => e.eventId)).toEqual([id(2), id(1)]);
    expect(entries[0]).not.toHaveProperty('decodeError');
    expect(entries[1]).toMatchObject({ invocationId: null, attemptInvocationId: null });
    expect(entries[1]!.decodeError).toMatch(/^invocation_id: .*; attempt_invocation_id: /);
    for (const e of entries) expect(() => deadLetter.parse(e)).not.toThrow();
  });

  it.each([
    ['attempts', delivery(1, { attempts: -1 })],
    ['delivered_at', delivery(1, { delivered_at: 'soon' })],
    ['consumer_module', delivery(1, { consumer_module: 'Not A Module!' })],
  ] as const)('throws naming `%s` when a required scalar breaks — it is never typed as a DeadLetter', (column, d) => {
    const sql = world([event(1)], [d]);
    expect(() => readDeadLetters({ sql })).toThrow(new RegExp(`cannot be read as a DeadLetter — ${column}: `));
  });

  it('throws naming the event columns too — type, occurred_at and the entity', () => {
    const sql = world([event(1, { type: 'NOT AN EVENT TYPE', occurred_at: 'never', entity_id: '' })], [delivery(1)]);
    expect(() => readDeadLetters({ sql })).toThrow(
      /type: .*; occurred_at: .*; entity_type\/entity_id\.entityId: /,
    );
  });

  it('the cursor is built from the decoded values, so a page boundary still walks every row', () => {
    const sql = world([event(1), event(2), event(3)], [delivery(1), delivery(2), delivery(3)]);
    const first = readDeadLetters({ sql }, { limit: 2 });
    expect(first.entries.map((e) => e.eventId)).toEqual([id(3), id(2)]);
    const second = readDeadLetters({ sql }, { limit: 2, cursor: first.nextCursor! });
    expect(second.entries.map((e) => e.eventId)).toEqual([id(1)]);
  });
});

describe('mapDenialOperationBucketRow — tolerant, as its sibling is (#1643)', () => {
  const healthy: DenialOperationBucketRow = { operation: 'thing/read', count: 3, first_at: AT, last_at: AT };

  it('reads a healthy bucket exactly as the cast did, with no decodeError — the positive twin', () => {
    expect(mapDenialOperationBucketRow(healthy)).toStrictEqual({
      operation: 'thing/read',
      count: 3,
      firstAt: AT,
      lastAt: AT,
    });
    // The refusal outside any operation is a bucket of its own, and that null is a FACT.
    const none = mapDenialOperationBucketRow({ ...healthy, operation: null });
    expect(none).toStrictEqual({ operation: null, count: 3, firstAt: AT, lastAt: AT });
    expect(none).not.toHaveProperty('decodeError');
  });

  it('an operation that is not text reads null beside a decodeError — which is what keeps it from reading as "outside an operation"', () => {
    const bad = mapDenialOperationBucketRow({ ...healthy, operation: new Uint8Array([1]) as never });
    expect(bad).toMatchObject({ operation: null, count: 3 });
    expect(bad.decodeError).toMatch(/^operation: /);
    expect(() => denialOperationBucket.parse(bad)).not.toThrow();
  });

  it('a bad bucket does not take its neighbours down with it', () => {
    const buckets = mapDenialSummaryBuckets('operation', [
      healthy,
      { ...healthy, operation: new Uint8Array([1]) },
      { ...healthy, operation: null },
    ]).buckets;
    expect(buckets).toHaveLength(3);
    expect(buckets[0]).toStrictEqual({ operation: 'thing/read', count: 3, firstAt: AT, lastAt: AT });
    expect(buckets[1]).toHaveProperty('decodeError');
    expect(buckets[2]).not.toHaveProperty('decodeError');
  });

  it.each([
    ['count', { count: 0 }],
    ['count', { count: Number.NaN }],
    ['first_at', { first_at: '' }],
    ['last_at', { last_at: '' }],
  ] as const)('throws naming `%s` when a required scalar breaks', (column, over) => {
    expect(() => mapDenialOperationBucketRow({ ...healthy, ...over })).toThrow(
      new RegExp(`cannot be read as a DenialOperationBucket — ${column}: `),
    );
  });
});
