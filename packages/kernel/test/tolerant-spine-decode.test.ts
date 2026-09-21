import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import {
  denialBucket,
  domainEvent,
  drainedEvent,
  historyEntry,
  permissionDenial,
  timelineEntry,
  type Actor,
  type DataSubjectId,
  type EventAuthorization,
  type EventId,
  type HistoryEntry,
  type ImpersonationStamp,
  type Instant,
  type PermissionDenial,
  type PermissionKey,
  type PiiClass,
  type ScopeId,
  type TenantId,
} from '@substrat-run/contracts';
import {
  domainEventOf,
  mapDenialBucketRow,
  mapDenialRow,
  readHistory,
  readTimeline,
  readUndrainedOutbox,
  UNDECODED_ACTOR,
  UNDECODED_PERMISSION,
  UNDRAINED_SCAN_FACTOR,
  UNDRAINED_SKIPPED_IDS,
  walkEventCause,
  walkEventEffects,
  readInvocation,
  type DenialRow,
  type OutboxDrainRow,
  type ScopedSql,
} from '../src/index.js';

/**
 * #1636 — the spine's list reads decode each row TOLERANTLY, and the executed paths decode
 * STRICTLY but per row. Held here column by column, against a REAL SQLite table (so values
 * come back with SQLite's own types and nullability, the `event-cause.test.ts` move), and
 * against a verbatim copy of each strict decode it replaced — so "a healthy row reads
 * exactly as it did" is a comparison, not a claim.
 */

const ULID = (n: number, prefix = '01J') => `${prefix}${String(n).padStart(26 - prefix.length, '0')}`;
const T = ULID(1, '01JT') as TenantId;
const S = ULID(1, '01JS') as ScopeId;
const PRINCIPAL = ULID(7, '01JP');
const AT = '2026-09-01T00:00:00.000Z';
const STAMP: ImpersonationStamp = { session: ULID(9, '01JQ'), by: ULID(8, '01JB') } as ImpersonationStamp;

const OUTBOX_DDL = `
  CREATE TABLE _substrat_outbox (
    id TEXT PRIMARY KEY, type TEXT NOT NULL, schema_version INTEGER NOT NULL,
    occurred_at TEXT NOT NULL, tenant_id TEXT NOT NULL, scope_id TEXT NOT NULL,
    actor TEXT NOT NULL, entity_type TEXT NOT NULL, entity_id TEXT NOT NULL,
    pii_class TEXT NOT NULL, subject_id TEXT, payload TEXT, authorization TEXT,
    impersonation TEXT, operation TEXT, version TEXT, caused_by TEXT, invocation_id TEXT,
    drained_at TEXT
  );
  CREATE TABLE _substrat_deliveries (
    event_id TEXT NOT NULL, consumer_module TEXT NOT NULL, delivered_at TEXT NOT NULL,
    error TEXT, attempts INTEGER NOT NULL DEFAULT 1, next_attempt_at TEXT, invocation_id TEXT,
    PRIMARY KEY (event_id, consumer_module)
  )`;

const DENIALS_DDL = `
  CREATE TABLE _substrat_denials (
    id TEXT PRIMARY KEY, actor TEXT NOT NULL, permission TEXT NOT NULL, tenant_id TEXT NOT NULL,
    scope_id TEXT, operation TEXT, impersonation TEXT, invocation_id TEXT, at TEXT NOT NULL,
    drained_at TEXT
  )`;

/** A cell. A BLOB is how a TEXT column holds a non-string at all: SQLite's affinity turns a number into text. */
type Cells = Record<string, string | number | Uint8Array | null>;

/** A healthy outbox row, as the kernel writes one — every JSON column JSON, every id a ULID. */
function eventRow(n: number, over: Cells = {}): Cells {
  return {
    id: ULID(n),
    type: 'test.happened',
    schema_version: 1,
    occurred_at: AT,
    tenant_id: T,
    scope_id: S,
    actor: JSON.stringify(PRINCIPAL),
    entity_type: 'thing',
    entity_id: 'x1',
    pii_class: 'pseudonymous',
    subject_id: ULID(5, '01JD'),
    payload: JSON.stringify({ n }),
    authorization: JSON.stringify([{ permission: 'thing:write' }]),
    impersonation: JSON.stringify(STAMP),
    operation: 'thing/update',
    version: 'v-1',
    caused_by: null,
    invocation_id: 'call-1',
    drained_at: null,
    ...over,
  };
}

function dbWith(ddl: string, table: string, rows: Cells[]): { db: DatabaseSync; sql: Pick<ScopedSql, 'query'> } {
  const db = new DatabaseSync(':memory:');
  db.exec(ddl);
  for (const r of rows) {
    const cols = Object.keys(r);
    db.prepare(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(
      ...(Object.values(r) as never[]),
    );
  }
  return {
    db,
    sql: {
      query: (<T>(sql: string, params?: unknown[]) =>
        db.prepare(sql).all(...((params ?? []) as never[])) as T[]) as ScopedSql['query'],
    },
  };
}

const outbox = (rows: Cells[]) => dbWith(OUTBOX_DDL, '_substrat_outbox', rows);
const THING = { entityType: 'thing', entityId: 'x1' };

// -- the strict decodes these replaced, VERBATIM (#1636 base 02c181a0) ----------------------

/** A stored outbox row as SQLite hands it back — the columns the old decoders read. */
interface RawOutboxRow extends OutboxDrainRow {
  version: string | null;
  caused_by: string | null;
  invocation_id: string | null;
}

function strictHistoryOf(row: RawOutboxRow): HistoryEntry {
  return {
    id: row.id as EventId,
    type: row.type,
    occurredAt: row.occurred_at as Instant,
    actor: JSON.parse(row.actor) as Actor,
    payload: row.payload === null ? null : (JSON.parse(row.payload) as unknown),
    authorization:
      row.authorization === null ? null : (JSON.parse(row.authorization) as EventAuthorization[]),
    impersonation:
      row.impersonation === null ? null : (JSON.parse(row.impersonation) as ImpersonationStamp),
    piiClass: row.pii_class as PiiClass,
    subjectId: row.subject_id as DataSubjectId | null,
    operation: row.operation,
    version: row.version,
    causedBy: row.caused_by as EventId | null,
    invocationId: row.invocation_id,
  };
}

function strictDenialOf(row: DenialRow): PermissionDenial {
  return {
    id: row.id,
    actor: JSON.parse(row.actor) as Actor,
    permission: row.permission as PermissionKey,
    tenantId: row.tenant_id as TenantId,
    scopeId: (row.scope_id ?? null) as ScopeId | null,
    operation: row.operation ?? null,
    impersonation:
      row.impersonation == null ? null : (JSON.parse(row.impersonation) as ImpersonationStamp),
    invocationId: row.invocation_id ?? null,
    at: row.at,
    drainedAt: row.drained_at ?? null,
  };
}

function strictEventOf(row: RawOutboxRow) {
  return domainEvent.parse({
    id: row.id,
    type: row.type,
    schemaVersion: row.schema_version,
    occurredAt: row.occurred_at,
    tenantId: row.tenant_id,
    scopeId: row.scope_id,
    actor: JSON.parse(row.actor),
    entity: { entityType: row.entity_type, entityId: row.entity_id },
    piiClass: row.pii_class,
    ...(row.subject_id ? { subjectId: row.subject_id } : {}),
    ...(row.authorization ? { authorization: JSON.parse(row.authorization) } : {}),
    ...(row.impersonation ? { impersonation: JSON.parse(row.impersonation) } : {}),
    ...(row.operation ? { operation: row.operation } : {}),
    payload: row.payload === null ? undefined : JSON.parse(row.payload),
  });
}

// ------------------------------------------------------------------------------------------

describe('history and timeline reads — tolerant (#1636)', () => {
  it('reads a healthy row exactly as the strict decode did, and carries no decodeError at all', () => {
    const { db, sql } = outbox([eventRow(1), eventRow(2, { impersonation: null, authorization: null })]);
    const raw = db.prepare('SELECT * FROM _substrat_outbox ORDER BY id').all() as unknown as RawOutboxRow[];
    const page = readHistory({ sql }, THING);
    expect(page.entries).toHaveLength(2);
    page.entries.forEach((entry, i) => {
      expect(entry).toStrictEqual(strictHistoryOf(raw[i]!));
      expect(entry).not.toHaveProperty('decodeError');
    });
    for (const entry of readTimeline({ sql }, THING).entries) expect(entry).not.toHaveProperty('decodeError');
  });

  it('returns every row beside a bad one, the bad one EMPTY where it did not decode and saying so', () => {
    const { sql } = outbox([
      eventRow(1),
      eventRow(2, { actor: '{"system":', payload: 'not json at all', impersonation: '[]' }),
      eventRow(3),
    ]);
    const { sql: clean } = outbox([eventRow(1), eventRow(3)]);
    const page = readHistory({ sql }, THING);
    expect(page.entries.map((e) => e.id)).toEqual([ULID(1), ULID(2), ULID(3)]);
    // The neighbours read exactly as they do with no bad row among them.
    const twin = readHistory({ sql: clean }, THING).entries;
    expect(page.entries[0]).toStrictEqual(twin[0]);
    expect(page.entries[2]).toStrictEqual(twin[1]);

    const bad = page.entries[1]!;
    // Every column that did not decode is named, in order — not only the first.
    expect(bad.decodeError).toMatch(
      /^actor: not valid JSON; payload: not valid JSON; impersonation: .*expected object, received array$/,
    );
    expect(bad.actor).toEqual(UNDECODED_ACTOR);
    expect(bad.impersonation).toBeNull();
    // The columns that DID decode are still there — the envelope is the evidence.
    expect(bad.authorization).toEqual([{ permission: 'thing:write' }]);
    expect(bad.operation).toBe('thing/update');

    // The timeline takes the same row the same way.
    const timeline = readTimeline({ sql }, THING).entries;
    expect(timeline).toHaveLength(3);
    expect(timeline[1]).toEqual({
      id: ULID(2),
      type: 'test.happened',
      occurredAt: AT,
      actor: UNDECODED_ACTOR,
      decodeError: 'actor: not valid JSON',
    });
  });

  it('keeps an undecodable payload apart from an ERASED one — both null, only one explained', () => {
    const { sql } = outbox([eventRow(1, { payload: null }), eventRow(2, { payload: '{oops' })]);
    const [erased, unreadable] = readHistory({ sql }, THING).entries;
    expect(erased!.payload).toBeNull();
    expect(erased).not.toHaveProperty('decodeError');
    expect(unreadable!.payload).toBeNull();
    expect(unreadable!.decodeError).toBe('payload: not valid JSON');
  });

  it('never quotes the stored text — a payload is the event’s content', () => {
    const { sql } = outbox([eventRow(1, { payload: '{"email":"anna@example.test",' })]);
    const [entry] = readHistory({ sql }, THING).entries;
    expect(entry!.decodeError).toBeDefined();
    expect(entry!.decodeError).not.toContain('anna');
  });

  it('returns only values the published schema accepts, however the row is broken', () => {
    const broken: Cells[] = [
      { actor: '"not-a-ulid"' },
      { actor: '42' },
      { authorization: '[{"permission":"NOT A KEY"}]' },
      { authorization: 'nope' },
      { impersonation: '{"session":1}' },
      { subject_id: 'not-a-subject' },
      { caused_by: 'not-an-event' },
      { operation: new Uint8Array([7]) },
      { invocation_id: new Uint8Array([7]) },
    ];
    const { sql } = outbox(broken.map((over, i) => eventRow(i + 1, over)));
    const entries = readHistory({ sql }, THING, { limit: 50 }).entries;
    expect(entries).toHaveLength(broken.length);
    for (const entry of entries) {
      expect(entry.decodeError).toBeDefined();
      expect(() => historyEntry.parse(entry)).not.toThrow();
      expect(() => timelineEntry.parse({ id: entry.id, type: entry.type, occurredAt: entry.occurredAt, actor: entry.actor })).not.toThrow();
    }
  });

  it('throws, naming every column, when a REQUIRED scalar breaks — it has no honest empty value', () => {
    const { sql } = outbox([eventRow(1, { id: 'not-a-ulid', type: 'NoDot', pii_class: 'secret', payload: '{' })]);
    const read = () => readHistory({ sql }, THING);
    expect(read).toThrow(/outbox row "not-a-ulid" cannot be read as a HistoryEntry/);
    // Required ones first, then the tolerated ones — every column, not the first.
    expect(read).toThrow(/id: .*; type: .*; pii_class: .*; payload: not valid JSON/);
  });

  it('reaches every read that maps history: the cause walk, the effects tree, an invocation', () => {
    const { sql } = outbox([eventRow(1), eventRow(2, { payload: '{', caused_by: ULID(1) })]);
    const chain = walkEventCause({ sql }, ULID(2) as EventId);
    expect(chain.chain.map((e) => e.id)).toEqual([ULID(2), ULID(1)]);
    expect(chain.chain[0]!.decodeError).toBe('payload: not valid JSON');
    expect(chain.terminal).toBe('operation');

    const tree = walkEventEffects({ sql }, ULID(1) as EventId);
    expect(tree.root!.effects.map((e) => e.event.decodeError)).toEqual(['payload: not valid JSON']);

    const call = readInvocation({ sql }, 'call-1');
    expect(call.events.map((e) => e.decodeError ?? null)).toEqual([null, 'payload: not valid JSON']);
  });

  it('ends a cause walk as `missing` when the cause did not decode — never as a complete chain', () => {
    // The positive twin: the same row with a real (null) cause and an operation IS complete.
    const { sql: whole } = outbox([eventRow(1)]);
    expect(walkEventCause({ sql: whole }, ULID(1) as EventId).terminal).toBe('operation');

    // Read as null, an unreadable cause beside an operation would say exactly that.
    const { sql } = outbox([eventRow(1, { caused_by: 'not-an-event-id' })]);
    const walk = walkEventCause({ sql }, ULID(1) as EventId);
    expect(walk.chain[0]!.causedBy).toBeNull();
    expect(walk.chain[0]!.decodeError).toMatch(/^caused_by: /);
    expect(walk.terminal).toBe('missing');

    // …and so does an unreadable operation beside a null cause: it is the column that
    // decides between 'operation' and 'unrecorded'.
    const { sql: noOp } = outbox([eventRow(1, { operation: new Uint8Array([7]) })]);
    expect(walkEventCause({ sql: noOp }, ULID(1) as EventId).terminal).toBe('missing');
  });
});

describe('denial reads — tolerant (#1636)', () => {
  const denial = (n: number, over: Cells = {}): Cells => ({
    id: ULID(n),
    actor: JSON.stringify(PRINCIPAL),
    permission: 'thing:read',
    tenant_id: T,
    scope_id: S,
    operation: 'thing/read',
    impersonation: JSON.stringify(STAMP),
    invocation_id: 'call-1',
    at: AT,
    drained_at: null,
    ...over,
  });
  const denials = (rows: Cells[]) => dbWith(DENIALS_DDL, '_substrat_denials', rows).db;
  const rowsOf = (db: DatabaseSync) =>
    db.prepare('SELECT * FROM _substrat_denials ORDER BY id').all() as unknown as DenialRow[];

  it('reads a healthy row exactly as the strict decode did, with no decodeError', () => {
    const db = denials([denial(1), denial(2, { actor: JSON.stringify({ system: 'invoicing' }), impersonation: null, scope_id: null })]);
    for (const row of rowsOf(db)) {
      expect(mapDenialRow(row)).toStrictEqual(strictDenialOf(row));
      expect(mapDenialRow(row)).not.toHaveProperty('decodeError');
    }
  });

  it('flags a bad actor and impersonation instead of throwing, and returns only schema-valid values', () => {
    const db = denials([denial(1, { actor: '{nope', impersonation: 'also nope' }), denial(2, { actor: '"not-a-ulid"' })]);
    const [a, b] = rowsOf(db).map(mapDenialRow);
    expect(a!.actor).toEqual(UNDECODED_ACTOR);
    expect(a!.impersonation).toBeNull();
    expect(a!.decodeError).toBe('actor: not valid JSON; impersonation: not valid JSON');
    expect(a!.permission).toBe('thing:read');
    expect(b!.decodeError).toMatch(/^actor: /);
    for (const d of [a, b]) expect(() => permissionDenial.parse(d)).not.toThrow();
  });

  it('throws naming the columns when a required scalar breaks', () => {
    const db = denials([denial(1, { tenant_id: 'nope', at: '', actor: '{' })]);
    expect(() => mapDenialRow(rowsOf(db)[0]!)).toThrow(
      /denial row ".*" cannot be read as a PermissionDenial — tenant_id: .*; at: .*; actor: not valid JSON/,
    );
  });

  it('lists a malformed permission key with the marker, and quotes the key it refused', () => {
    // Reachable from live module code, not only a dump: nothing validates a checked key at
    // runtime, so a module that casts `Workorder:Read` is refused and recorded with it.
    // The key is the evidence of why — the row must be listed, and the key kept.
    const db = denials([denial(1), denial(2, { permission: 'Workorder:Read' })]);
    const [ok, bad] = rowsOf(db).map(mapDenialRow);
    expect(bad!.permission).toBe(UNDECODED_PERMISSION);
    expect(bad!.decodeError).toMatch(/^permission: .* \(stored "Workorder:Read"\)$/);
    expect(() => permissionDenial.parse(bad)).not.toThrow();
    // The rest of the row is the refusal as recorded.
    expect(bad!.actor).toBe(PRINCIPAL);
    expect(bad!.operation).toBe('thing/read');
    // The positive twin: a valid key round-trips unchanged, and says nothing.
    expect(ok!.permission).toBe('thing:read');
    expect(ok).not.toHaveProperty('decodeError');
  });

  it('quotes a stored key only so far — it is an identifier, not a payload', () => {
    const db = denials([denial(1, { permission: `X${'y'.repeat(500)}` })]);
    const [bad] = rowsOf(db).map(mapDenialRow);
    expect(bad!.permission).toBe(UNDECODED_PERMISSION);
    expect(bad!.decodeError!.length).toBeLessThan(300);
    expect(bad!.decodeError).toMatch(/…\)$/);
  });

  it('keeps a summary bucket whose actor did not decode — counted, and saying why', () => {
    const healthy = { actor: JSON.stringify(PRINCIPAL), permission: 'thing:read', count: 3, operations: 1, first_at: AT, last_at: AT };
    expect(mapDenialBucketRow(healthy)).toStrictEqual({
      actor: PRINCIPAL,
      permission: 'thing:read',
      count: 3,
      operations: 1,
      firstAt: AT,
      lastAt: AT,
    });
    const bad = mapDenialBucketRow({ ...healthy, actor: '{' });
    expect(bad).toEqual({ ...mapDenialBucketRow(healthy), actor: UNDECODED_ACTOR, decodeError: 'actor: not valid JSON' });
    expect(() => denialBucket.parse(bad)).not.toThrow();
    // A malformed key is its own bucket: kept and counted under the marker, the key quoted.
    const badKey = mapDenialBucketRow({ ...healthy, permission: 'Workorder:Read' });
    expect(badKey).toMatchObject({ actor: PRINCIPAL, permission: UNDECODED_PERMISSION, count: 3 });
    expect(badKey.decodeError).toMatch(/^permission: .* \(stored "Workorder:Read"\)$/);
    expect(() => denialBucket.parse(badKey)).not.toThrow();
  });
});

describe('the executed decode — strict, naming every column (#1636)', () => {
  const rawRows = (rows: Cells[]) =>
    outbox(rows).db.prepare('SELECT * FROM _substrat_outbox ORDER BY id').all() as unknown as OutboxDrainRow[];

  it('decodes a healthy row exactly as the adapters’ strict decode did', () => {
    for (const row of rawRows([eventRow(1), eventRow(2, { subject_id: null, pii_class: 'none', authorization: null, impersonation: null, operation: null, payload: null })])) {
      expect(domainEventOf(row)).toStrictEqual(strictEventOf(row as RawOutboxRow));
    }
  });

  it('throws naming EVERY column that did not decode, and never quotes the stored text', () => {
    const [row] = rawRows([
      eventRow(1, {
        actor: '{',
        payload: '{"email":"anna@example.test",',
        authorization: '[{"permission":"NOT A KEY"}]',
        pii_class: 'secret',
        entity_id: '',
      }),
    ]);
    let message = '';
    try {
      domainEventOf(row!);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/^event row ".*" cannot be decoded — /);
    for (const column of ['actor: not valid JSON', 'payload: not valid JSON', 'authorization.0.permission: ', 'entity_id: ', 'pii_class: ']) {
      expect(message).toContain(column);
    }
    expect(message).not.toContain('anna');
  });

  it('refuses a row that parses but breaks the envelope’s own PII rule', () => {
    const [row] = rawRows([eventRow(1, { subject_id: null, pii_class: 'direct' })]);
    expect(() => domainEventOf(row!)).toThrow(/subject_id: subjectId is required/);
  });
});

describe('readUndrainedOutbox — the Tier-2 read, contained per row (#1636)', () => {
  const pageOver = (rows: Cells[]) => {
    const { db } = outbox(rows);
    const stmt = db.prepare('SELECT * FROM _substrat_outbox WHERE drained_at IS NULL ORDER BY id LIMIT ? OFFSET ?');
    const reads: [number, number][] = [];
    return {
      reads,
      page: (offset: number, count: number) => {
        reads.push([offset, count]);
        return stmt.all(count, offset) as unknown as OutboxDrainRow[];
      },
    };
  };
  const plain = { payload: null, pii_class: 'none', subject_id: null };
  const bad = (n: number) => eventRow(n, { ...plain, actor: '{' });
  const good = (n: number) => eventRow(n, plain);

  it('a clean page carries no `skipped` at all — the positive twin', () => {
    const { page } = pageOver([good(1), good(2)]);
    const read = readUndrainedOutbox(page, 10);
    expect(read.events.map((e) => e.id)).toEqual([ULID(1), ULID(2)]);
    expect(read).not.toHaveProperty('skipped');
    for (const e of read.events) expect(() => drainedEvent.parse(e)).not.toThrow();
  });

  it('steps over a row that will not decode, returns the rows behind it, and counts it', () => {
    const { page } = pageOver([bad(1), good(2), good(3)]);
    const read = readUndrainedOutbox(page, 10);
    expect(read.events.map((e) => e.id)).toEqual([ULID(2), ULID(3)]);
    expect(read.skipped).toEqual({ count: 1, eventIds: [ULID(1)] });
  });

  it('still fills the limit with healthy rows when bad ones sit in front of them', () => {
    const { page, reads } = pageOver([bad(1), bad(2), good(3), good(4), good(5)]);
    const read = readUndrainedOutbox(page, 2);
    expect(read.events.map((e) => e.id)).toEqual([ULID(3), ULID(4)]);
    expect(read.skipped).toEqual({ count: 2, eventIds: [ULID(1), ULID(2)] });
    // Paged by offset past what it consumed, never re-reading a row.
    expect(reads).toEqual([
      [0, 2],
      [2, 2],
    ]);
  });

  it('is bounded — and says so: past limit × factor bad rows in a row, a pass ships nothing', () => {
    const limit = 1;
    const ceiling = limit * UNDRAINED_SCAN_FACTOR;
    // One fewer bad row than the ceiling: the healthy row behind them still ships.
    const under = pageOver([...Array.from({ length: ceiling - 1 }, (_, i) => bad(i + 1)), good(ceiling)]);
    const shipped = readUndrainedOutbox(under.page, limit);
    expect(shipped.events.map((e) => e.id)).toEqual([ULID(ceiling)]);
    expect(shipped.skipped!.count).toBe(ceiling - 1);

    // As many as the ceiling: the read stops there and returns nothing — the known limit.
    // Every pass reads the same window again, so the healthy row behind it waits until
    // the spine is repaired. The count is what makes that visible.
    const over = pageOver([...Array.from({ length: ceiling }, (_, i) => bad(i + 1)), good(ceiling + 1)]);
    const stalled = readUndrainedOutbox(over.page, limit);
    expect(stalled.events).toEqual([]);
    expect(stalled.skipped!.count).toBe(ceiling);
    expect(over.reads.reduce((n, [, count]) => n + count, 0)).toBe(ceiling);
  });

  it('names at most UNDRAINED_SKIPPED_IDS ids, and keeps the count exact past it', () => {
    const many = UNDRAINED_SKIPPED_IDS + 5;
    const { page } = pageOver([...Array.from({ length: many }, (_, i) => bad(i + 1)), good(many + 1)]);
    const read = readUndrainedOutbox(page, 100);
    expect(read.events.map((e) => e.id)).toEqual([ULID(many + 1)]);
    expect(read.skipped!.count).toBe(many);
    expect(read.skipped!.eventIds).toHaveLength(UNDRAINED_SKIPPED_IDS);
  });
});
