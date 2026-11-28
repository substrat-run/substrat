/**
 * The delivery broker (K-74, rfc/broker-and-tenant-isolation.md §4): one per (tenant, app), and the
 * owner of every message a scope sends once the scope has handed it off.
 *
 * Not the local PEER broker (`@substrat-run/adapter-sqlite/vertical-broker`, #1706), which stands in
 * for the router on a call between apps. This one takes custody of what a commit left behind.
 *
 * What lives here is what both adapters share, so they cannot drift:
 *
 * - **The message** a scope hands off (`BrokerMessage`): an outbox row the scope emitted, or a
 *   platform intent it raised, carried whole as its row's JSON. The broker does not interpret it.
 * - **The scope's half** (`handoffBatch`, `advanceMarks`): which rows are due for handoff past the
 *   scope's marks, and how far an answer moves them. A mark is the greatest id handed off and
 *   acknowledged, per kind. Ids are the kernel's ulid, which only increases within a process and is
 *   seeded from the scope's newest id on wake, so `id > mark` is the same watermark
 *   `readScopeTimeline` walks. Nothing is written to the scope's own tables: the marks are a cache
 *   of what the broker holds (`BrokerStore.marks` is the authority), so a scope that lost them asks.
 * - **The broker's store** (`BrokerStore`): its own SQLite, which both adapters have, behind the
 *   three operations it needs. Acceptance is idempotent by message id, so a handoff repeated after a
 *   lost acknowledgement stores nothing twice and is acknowledged again.
 *
 * Delivery is effectively once inside the platform: dedup by id at every hop. Toward the internet it
 * is at least once (K-74). A1 delivers to a `DeliveryReceiver` only when one is configured; with none
 * the broker holds what it accepted, bounded by `BROKER_HELD_RETENTION_MS`, until A5's shadow
 * recorder and the real receivers arrive.
 */
import { emittedHere } from './scope-copy.js';

/** What a scope hands off: an event it emitted, or a platform intent it raised. */
export type BrokerMessageKind = 'event' | 'intent';

export const BROKER_MESSAGE_KINDS: readonly BrokerMessageKind[] = ['event', 'intent'];

export interface BrokerMessage {
  /** The row's own id: the outbox event's, or the intent's. Dedup is by this, per broker. */
  id: string;
  kind: BrokerMessageKind;
  tenantId: string;
  scopeId: string;
  /** The event's `type`, or the intent's `kind`. */
  type: string;
  /** The row, as JSON text. The broker carries it and never parses it. */
  body: string;
  /** When the row committed: the event's `occurred_at`, the intent's `requested_at`. */
  committedAt: string;
}

/** The broker's answer to a handoff: every id it now holds, a duplicate included. */
export interface HandOffAnswer {
  acked: string[];
}

/** The greatest id handed off and acknowledged, per kind. Absent: nothing yet. */
export type HandoffMarks = Partial<Record<BrokerMessageKind, string>>;

/** One broker, as a scope reaches it. */
export interface DeliveryBroker {
  handOff(messages: readonly BrokerMessage[]): Promise<HandOffAnswer>;
  /** What this broker holds for one scope, so a scope that lost its marks resumes past them. */
  marks(tenantId: string, scopeId: string): Promise<HandoffMarks>;
}

/** Where a broker delivers. A throw is a failure, retried on `BROKER_RETRY_MS`. */
export interface DeliveryReceiver {
  deliver(message: BrokerMessage): Promise<void>;
}

/** How many rows of each kind one handoff carries. A larger backlog follows in the next one. */
export const HANDOFF_BATCH = 50;

/** How many due messages one delivery pass attempts before it yields. */
export const BROKER_DELIVERY_BATCH = 50;

/** The waits after each failed delivery: then the last, for as long as it fails. A4 makes it policy. */
export const BROKER_RETRY_MS: readonly number[] = [1_000, 5_000, 30_000, 2 * 60_000, 10 * 60_000];

/** The waits after each failed handoff, as the scope retries it from its own alarm. */
export const HANDOFF_RETRY_MS: readonly number[] = [1_000, 5_000, 30_000, 2 * 60_000, 10 * 60_000];

/** How long a delivered message is kept, for a duplicate handoff to find it. */
export const BROKER_DELIVERED_RETENTION_MS = 24 * 60 * 60_000;

/** How long a message nobody delivers is held (no receiver yet): the K-70 bound until A5 exists. */
export const BROKER_HELD_RETENTION_MS = 7 * 24 * 60 * 60_000;

/** The wait after `attempts` failures, on a schedule: its last step repeats. */
export const retryAfter = (schedule: readonly number[], attempts: number): number =>
  schedule[Math.min(Math.max(attempts, 1), schedule.length) - 1]!;

/** The broker's name in its namespace: one per (tenant, app). */
export const brokerName = (tenantId: string, app: string): string => `${tenantId}/${app}`;

/**
 * The reads a handoff makes, one per kind, past the scope's marks. Every row is the scope's own:
 * `emittedHere` leaves out what a copy carried in, for intents as for events. (A copy's intents were
 * settled at load as not carried; one minted at the source after its last event compares above the
 * copy's key and is handed off once, settled. A5's comparison is where that would show.)
 */
export function handoffQueries(
  marks: HandoffMarks,
  limit = HANDOFF_BATCH,
): { kind: BrokerMessageKind; sql: string; params: unknown[] }[] {
  return [
    {
      kind: 'event',
      sql: `SELECT * FROM _substrat_outbox WHERE id > ? AND ${emittedHere()} ORDER BY id LIMIT ?`,
      params: [marks.event ?? '', limit],
    },
    {
      kind: 'intent',
      sql: `SELECT id, kind, payload, requested_by, impersonation, requested_at
              FROM _substrat_platform_requests WHERE id > ? AND ${emittedHere()} ORDER BY id LIMIT ?`,
      params: [marks.intent ?? '', limit],
    },
  ];
}

/** A handoff read's rows, as the messages they become. */
export function messagesOf(
  kind: BrokerMessageKind,
  rows: readonly Record<string, unknown>[],
  ids: { tenantId: string; scopeId: string },
): BrokerMessage[] {
  return rows.map((row) => ({
    id: String(row.id),
    kind,
    tenantId: ids.tenantId,
    scopeId: ids.scopeId,
    type: String(kind === 'event' ? row.type : row.kind),
    body: JSON.stringify(row),
    committedAt: String(kind === 'event' ? row.occurred_at : row.requested_at),
  }));
}

/**
 * How far an answer moves the marks: per kind, over the longest run of the batch, in id order, that
 * the broker acknowledged. A gap stops it, so an unacknowledged message is handed off again rather
 * than skipped.
 */
export function advanceMarks(
  marks: HandoffMarks,
  sent: readonly BrokerMessage[],
  answer: HandOffAnswer,
): HandoffMarks {
  const acked = new Set(answer.acked);
  const next: HandoffMarks = { ...marks };
  for (const kind of BROKER_MESSAGE_KINDS) {
    for (const m of sent.filter((s) => s.kind === kind).sort((a, b) => (a.id < b.id ? -1 : 1))) {
      if (!acked.has(m.id)) break;
      next[kind] = m.id;
    }
  }
  return next;
}

/** The SQL a broker store runs, over its own database. Both adapters have SQLite. */
export interface BrokerSql {
  run(sql: string, ...params: unknown[]): void;
  all<T = Record<string, unknown>>(sql: string, ...params: unknown[]): T[];
}

/** The broker's own tables. Not spine: no scope holds them, and module code never reaches them. */
export const BROKER_DDL = `
  CREATE TABLE IF NOT EXISTS broker_messages (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    tenant_id TEXT NOT NULL,
    scope_id TEXT NOT NULL,
    type TEXT NOT NULL,
    body TEXT NOT NULL,
    committed_at TEXT NOT NULL,
    received_at INTEGER NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    -- epoch ms of the next attempt, NULL when held (no receiver) or delivered
    next_at INTEGER,
    last_error TEXT,
    delivered_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS broker_messages_due ON broker_messages (next_at) WHERE next_at IS NOT NULL;
  CREATE TABLE IF NOT EXISTS broker_marks (
    tenant_id TEXT NOT NULL,
    scope_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    mark TEXT NOT NULL,
    PRIMARY KEY (tenant_id, scope_id, kind)
  );
`;

/** A message as the store keeps it. */
interface StoredRow {
  id: string;
  kind: BrokerMessageKind;
  tenant_id: string;
  scope_id: string;
  type: string;
  body: string;
  committed_at: string;
  attempts: number;
}

/** One delivery pass's outcome, for the caller to re-arm on. */
export interface DeliveryPass {
  delivered: number;
  failed: number;
  /** Epoch ms the store next has work (`BrokerStore.nextWakeAt`), or null when it holds nothing. */
  nextAt: number | null;
}

/**
 * The broker's store. Each method is synchronous over `BrokerSql`; the adapter wraps `accept` in a
 * transaction (`transactionSync` on the Durable Object, `db.transaction` on better-sqlite3).
 */
export class BrokerStore {
  constructor(
    private readonly sql: BrokerSql,
    private readonly opts: { delivers: boolean; retryMs?: readonly number[] },
  ) {
    for (const stmt of BROKER_DDL.split(';').map((s) => s.trim()).filter(Boolean)) sql.run(stmt);
  }

  /** Take custody. Idempotent by id; every id handed in is acknowledged, a duplicate too. */
  accept(messages: readonly BrokerMessage[], now: number): HandOffAnswer {
    for (const m of messages) {
      this.sql.run(
        `INSERT OR IGNORE INTO broker_messages
           (id, kind, tenant_id, scope_id, type, body, committed_at, received_at, next_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        m.id, m.kind, m.tenantId, m.scopeId, m.type, m.body, m.committedAt, now, this.opts.delivers ? now : null,
      );
      this.sql.run(
        `INSERT INTO broker_marks (tenant_id, scope_id, kind, mark) VALUES (?, ?, ?, ?)
           ON CONFLICT (tenant_id, scope_id, kind) DO UPDATE SET mark = MAX(mark, excluded.mark)`,
        m.tenantId, m.scopeId, m.kind, m.id,
      );
    }
    return { acked: messages.map((m) => m.id) };
  }

  marks(tenantId: string, scopeId: string): HandoffMarks {
    const rows = this.sql.all<{ kind: BrokerMessageKind; mark: string }>(
      'SELECT kind, mark FROM broker_marks WHERE tenant_id = ? AND scope_id = ?',
      tenantId,
      scopeId,
    );
    return Object.fromEntries(rows.map((r) => [r.kind, r.mark])) as HandoffMarks;
  }

  /** The messages due at `now`, oldest due first. */
  due(now: number, limit = BROKER_DELIVERY_BATCH): BrokerMessage[] {
    return this.sql
      .all<StoredRow>(
        `SELECT id, kind, tenant_id, scope_id, type, body, committed_at, attempts
           FROM broker_messages WHERE next_at IS NOT NULL AND next_at <= ? ORDER BY next_at, id LIMIT ?`,
        now,
        limit,
      )
      .map((r) => ({
        id: r.id,
        kind: r.kind,
        tenantId: r.tenant_id,
        scopeId: r.scope_id,
        type: r.type,
        body: r.body,
        committedAt: r.committed_at,
      }));
  }

  delivered(id: string, now: number): void {
    this.sql.run('UPDATE broker_messages SET next_at = NULL, delivered_at = ?, last_error = NULL WHERE id = ?', now, id);
  }

  failed(id: string, error: string, now: number): void {
    const row = this.sql.all<{ attempts: number }>('SELECT attempts FROM broker_messages WHERE id = ?', id)[0];
    const attempts = (row?.attempts ?? 0) + 1;
    const wait = retryAfter(this.opts.retryMs ?? BROKER_RETRY_MS, attempts);
    this.sql.run(
      'UPDATE broker_messages SET attempts = ?, next_at = ?, last_error = ? WHERE id = ?',
      attempts,
      now + wait,
      error.slice(0, 500),
      id,
    );
  }

  /** Epoch ms of the next due message, or null. */
  nextAt(): number | null {
    const row = this.sql.all<{ at: number | null }>('SELECT MIN(next_at) AS at FROM broker_messages')[0];
    return row?.at ?? null;
  }

  /**
   * Epoch ms the store next has work: the earliest of the next due delivery and the moment a kept
   * row's bound runs out (a delivered row's `BROKER_DELIVERED_RETENTION_MS`, a held row's
   * `BROKER_HELD_RETENTION_MS`). Null only when it holds nothing, so an idle broker arms nothing and
   * a busy one never keeps a row past its bound for want of an alarm.
   */
  nextWakeAt(): number | null {
    const row = this.sql.all<{ due: number | null; delivered: number | null; held: number | null }>(
      `SELECT MIN(next_at) AS due,
              MIN(delivered_at) AS delivered,
              MIN(CASE WHEN next_at IS NULL AND delivered_at IS NULL THEN received_at END) AS held
         FROM broker_messages`,
    )[0];
    const times = [
      row?.due ?? null,
      row?.delivered == null ? null : row.delivered + BROKER_DELIVERED_RETENTION_MS,
      row?.held == null ? null : row.held + BROKER_HELD_RETENTION_MS,
    ].filter((t): t is number => t !== null);
    return times.length ? Math.min(...times) : null;
  }

  /** Drop what the bounds say has been kept long enough (K-70). Marks stay: they are one row per scope and kind. */
  prune(now: number): void {
    this.sql.run(
      'DELETE FROM broker_messages WHERE delivered_at IS NOT NULL AND delivered_at <= ?',
      now - BROKER_DELIVERED_RETENTION_MS,
    );
    this.sql.run(
      'DELETE FROM broker_messages WHERE next_at IS NULL AND delivered_at IS NULL AND received_at <= ?',
      now - BROKER_HELD_RETENTION_MS,
    );
  }

  /** How many messages it holds that are not delivered yet (held or due). */
  pending(): number {
    const row = this.sql.all<{ n: number }>('SELECT COUNT(*) AS n FROM broker_messages WHERE delivered_at IS NULL')[0];
    return Number(row?.n ?? 0);
  }
}

/**
 * One delivery pass over a store, for both adapters: attempt each due message once, record the
 * outcome, and say when the next is due. A receiver's throw is a failure of that message alone.
 */
export async function runDeliveryPass(
  store: BrokerStore,
  receiver: DeliveryReceiver,
  now: () => number,
  limit = BROKER_DELIVERY_BATCH,
): Promise<DeliveryPass> {
  let delivered = 0;
  let failed = 0;
  for (const m of store.due(now(), limit)) {
    try {
      await receiver.deliver(m);
      store.delivered(m.id, now());
      delivered++;
    } catch (err) {
      store.failed(m.id, err instanceof Error ? err.message : String(err), now());
      failed++;
    }
  }
  store.prune(now());
  return { delivered, failed, nextAt: store.nextWakeAt() };
}
