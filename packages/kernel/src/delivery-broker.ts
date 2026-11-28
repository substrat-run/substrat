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
 * is at least once (K-74). A broker delivers to the receivers it was given, one delivery per
 * (message, receiver), each under its subscription's policy (`delivery-policy.ts`, A4); with none it
 * holds what it accepted, bounded by `BROKER_HELD_RETENTION_MS`, until A5's shadow recorder and the
 * real receivers arrive. Its tables are `broker-schema.ts`.
 */
import { migrateBrokerStore } from './broker-schema.js';
import {
  BROKER_TIMING,
  DEFAULT_DELIVERY_POLICY,
  backoffMs,
  classifyFailure,
  resolvePolicy,
  type BrokerTiming,
  type DeliveryPolicy,
  type DeliveryPolicyInput,
  type FailureClass,
} from './delivery-policy.js';
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
  /**
   * The sender's ordering key (RFC §4.5): at a receiver whose subscription asks for order, messages
   * with one key are delivered one at a time, in id order. Absent: unordered everywhere.
   */
  key?: string;
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

/**
 * Where a broker delivers. A throw is a failure, of a kind `classifyFailure` reads from it: throw a
 * `DeliveryFailure` with the receiver's status (and `retryAfterMs` for a `Retry-After`) to say which.
 */
export interface DeliveryReceiver {
  deliver(message: BrokerMessage): Promise<void>;
}

/** How many rows of each kind one handoff carries. A larger backlog follows in the next one. */
export const HANDOFF_BATCH = 50;

/** How many due messages one delivery pass attempts before it yields. */
export const BROKER_DELIVERY_BATCH = 50;

/** The waits after each failed handoff, as the scope retries it from its own alarm. */
export const HANDOFF_RETRY_MS: readonly number[] = [1_000, 5_000, 30_000, 2 * 60_000, 10 * 60_000];

/** How long a settled message is kept, for a duplicate handoff to find it (`BrokerTiming.deliveredRetentionMs`). */
export const BROKER_DELIVERED_RETENTION_MS = BROKER_TIMING.deliveredRetentionMs;

/** How long a message nobody delivers is held (no receiver yet): the K-70 bound until A5 exists. */
export const BROKER_HELD_RETENTION_MS = BROKER_TIMING.heldRetentionMs;

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
  /** Run `fn` in one transaction (`transactionSync` on the Durable Object, `db.transaction` on better-sqlite3). Nests. */
  transaction<T>(fn: () => T): T;
}

/** A subscription as the store knows it: its receiver's name and the policy it declared. */
export interface BrokerSubscriptionSpec {
  /** The receiver's name, unique per broker. A1's single receiver is `'default'`. */
  name: string;
  policy?: DeliveryPolicyInput;
}

export interface BrokerStoreOptions {
  /** Where the broker delivers. None: it holds what it accepts. */
  subscriptions: readonly BrokerSubscriptionSpec[];
  /** The platform's timing, over `BROKER_TIMING`. Tests shorten it; production passes nothing. */
  timing?: Partial<BrokerTiming>;
  /** The jitter's draw, 0 ≤ r < 1. Defaults to `Math.random`. */
  random?: () => number;
}

/** One delivery due: a message, and the receiver it is for. */
export interface DueDelivery {
  message: BrokerMessage;
  receiver: string;
  /** Attempts already spent on it. */
  attempts: number;
}

/** A message the broker gave up on, for one receiver: kept `deadLetterRetentionMs`, to be resent or discarded. */
export interface DeadLetter {
  messageId: string;
  receiver: string;
  kind: BrokerMessageKind;
  type: string;
  tenantId: string;
  scopeId: string;
  committedAt: string;
  key: string | null;
  attempts: number;
  lastError: string | null;
  lastStatus: number | null;
  /** Epoch ms it was given up on, and when it expires unless resent. */
  deadAt: number;
  expiresAt: number;
  resends: number;
  /** The message's row, only when content was asked for: the tenant's admin sees it, the platform does not. */
  body?: string;
}

/** What a failed attempt led to. */
export type FailureOutcome = 'retry' | 'dead' | 'slow';

/** One delivery pass's outcome, for the caller to re-arm on. */
export interface DeliveryPass {
  delivered: number;
  /** Attempts that failed and will be tried again (a slow-down included). */
  failed: number;
  /** Deliveries the pass gave up on: now in dead letter. */
  deadLettered: number;
  /** Epoch ms the store next has work (`BrokerStore.nextWakeAt`), or null when it holds nothing. */
  nextAt: number | null;
}

/** A delivery is open while the broker still owes it: pending, or dead and resendable. */
const OPEN = "('pending', 'dead')";

/** A pending delivery may go now only as its lane's head: no lower message id open in its (receiver, lane). */
const LANE_HEAD = `(d.lane IS NULL OR NOT EXISTS (
    SELECT 1 FROM broker_deliveries e
     WHERE e.receiver = d.receiver AND e.lane = d.lane AND e.state IN ${OPEN} AND e.message_id < d.message_id))`;

/** How many settled messages one prune deletes; the rest go in the next. */
const PRUNE_BATCH = 500;

interface DueRow {
  message_id: string;
  receiver: string;
  attempts: number;
  kind: BrokerMessageKind;
  tenant_id: string;
  scope_id: string;
  type: string;
  body: string;
  committed_at: string;
  ordering_key: string | null;
}

/**
 * The broker's store (schema: `broker-schema.ts`). Each method is synchronous over `BrokerSql`, and
 * each that writes runs in one transaction.
 *
 * A message is stored once (`broker_messages`, its content) and owed once per receiver
 * (`broker_deliveries`, its fate there), so a receiver that fails or is paused holds back only its
 * own deliveries. Ordering is per (receiver, key): only a lane's head is ever due, so a message stuck
 * on key 17 holds back key 17 at that receiver and nothing else. A dead head keeps its lane stopped,
 * since delivering past it would break the order the receiver asked for: the later messages of that
 * key wait, spending nothing, until the dead letter is resent and delivered, discarded, or expires.
 */
export class BrokerStore {
  private readonly policies: ReadonlyMap<string, DeliveryPolicy>;
  private readonly receivers: string;
  private readonly timing: BrokerTiming;
  private readonly random: () => number;

  constructor(
    private readonly sql: BrokerSql,
    opts: BrokerStoreOptions,
  ) {
    this.policies = new Map(opts.subscriptions.map((s) => [s.name, resolvePolicy(s.policy)]));
    if (this.policies.size !== opts.subscriptions.length) throw new Error('BrokerStore: two subscriptions share a name');
    this.receivers = JSON.stringify([...this.policies.keys()]);
    this.timing = { ...BROKER_TIMING, ...opts.timing };
    this.random = opts.random ?? Math.random;
    migrateBrokerStore(sql);
    // A store opened with receivers over rows held while it had none: those become due, from when
    // they arrived, at every receiver it has now.
    if (this.policies.size) {
      sql.transaction(() => {
        const held = sql.all<{ id: string; ordering_key: string | null; received_at: number }>(
          `SELECT id, ordering_key, received_at FROM broker_messages m
            WHERE NOT EXISTS (SELECT 1 FROM broker_deliveries d WHERE d.message_id = m.id)`,
        );
        for (const m of held) this.owe(m.id, m.ordering_key, m.received_at);
      });
    }
  }

  /** The deliveries a new message is owed: one per receiver, due at `at`. */
  private owe(id: string, key: string | null, at: number): void {
    for (const [receiver, policy] of this.policies) {
      this.sql.run(
        `INSERT OR IGNORE INTO broker_deliveries (message_id, receiver, lane, state, next_at) VALUES (?, ?, ?, 'pending', ?)`,
        id,
        receiver,
        policy.ordered ? key : null,
        at,
      );
    }
  }

  /** Take custody. Idempotent by id; every id handed in is acknowledged, a duplicate too. */
  accept(messages: readonly BrokerMessage[], now: number): HandOffAnswer {
    return this.sql.transaction(() => {
      for (const m of messages) {
        const known = this.sql.all('SELECT 1 FROM broker_messages WHERE id = ?', m.id).length > 0;
        if (!known) {
          this.sql.run(
            `INSERT INTO broker_messages (id, kind, tenant_id, scope_id, type, body, committed_at, received_at, ordering_key)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            m.id, m.kind, m.tenantId, m.scopeId, m.type, m.body, m.committedAt, now, m.key ?? null,
          );
          this.owe(m.id, m.key ?? null, now);
        }
        this.sql.run(
          `INSERT INTO broker_marks (tenant_id, scope_id, kind, mark) VALUES (?, ?, ?, ?)
             ON CONFLICT (tenant_id, scope_id, kind) DO UPDATE SET mark = MAX(mark, excluded.mark)`,
          m.tenantId, m.scopeId, m.kind, m.id,
        );
      }
      return { acked: messages.map((m) => m.id) };
    });
  }

  marks(tenantId: string, scopeId: string): HandoffMarks {
    const rows = this.sql.all<{ kind: BrokerMessageKind; mark: string }>(
      'SELECT kind, mark FROM broker_marks WHERE tenant_id = ? AND scope_id = ?',
      tenantId,
      scopeId,
    );
    return Object.fromEntries(rows.map((r) => [r.kind, r.mark])) as HandoffMarks;
  }

  /**
   * The deliveries due at `now`, oldest due first: pending, at a receiver this store has and that is
   * neither paused nor slowed, and the head of their lane. `skip` names deliveries already attempted
   * this pass (`deliveryKey`), so a wait of zero is not attempted twice in one pass.
   */
  due(now: number, limit = BROKER_DELIVERY_BATCH, skip: readonly string[] = []): DueDelivery[] {
    return this.sql
      .all<DueRow>(
        `SELECT d.message_id, d.receiver, d.attempts,
                m.kind, m.tenant_id, m.scope_id, m.type, m.body, m.committed_at, m.ordering_key
           FROM broker_deliveries d
           JOIN broker_messages m ON m.id = d.message_id
           LEFT JOIN broker_receivers r ON r.receiver = d.receiver
          WHERE d.state = 'pending' AND d.next_at <= ?
            AND d.receiver IN (SELECT value FROM json_each(?))
            AND (r.blocked_until IS NULL OR r.blocked_until <= ?)
            AND ${LANE_HEAD}
            AND (d.message_id || ' ' || d.receiver) NOT IN (SELECT value FROM json_each(?))
          ORDER BY d.next_at, d.message_id LIMIT ?`,
        now,
        this.receivers,
        now,
        JSON.stringify(skip),
        limit,
      )
      .map((r) => ({
        receiver: r.receiver,
        attempts: r.attempts,
        message: {
          id: r.message_id,
          kind: r.kind,
          tenantId: r.tenant_id,
          scopeId: r.scope_id,
          type: r.type,
          body: r.body,
          committedAt: r.committed_at,
          ...(r.ordering_key === null ? {} : { key: r.ordering_key }),
        },
      }));
  }

  /** Whether a receiver is paused or slowed at `now`: nothing is sent to it. */
  blocked(receiver: string, now: number): boolean {
    const row = this.sql.all<{ blocked_until: number | null }>('SELECT blocked_until FROM broker_receivers WHERE receiver = ?', receiver)[0];
    return row?.blocked_until != null && row.blocked_until > now;
  }

  /** A delivery landed: it settles, and the receiver's pause, if any, is over. */
  delivered(id: string, receiver: string, now: number): void {
    this.sql.transaction(() => {
      this.sql.run(
        `UPDATE broker_deliveries SET state = 'delivered', next_at = NULL, settled_at = ?, last_error = NULL, last_status = NULL
          WHERE message_id = ? AND receiver = ? AND state = 'pending'`,
        now,
        id,
        receiver,
      );
      this.sql.run('DELETE FROM broker_receivers WHERE receiver = ?', receiver);
    });
  }

  /** A delivery failed, as `classifyFailure` read it. Says what follows for that delivery. */
  failed(id: string, receiver: string, failure: FailureClass, now: number): FailureOutcome {
    return this.sql.transaction(() => {
      const row = this.sql.all<{ attempts: number }>(
        "SELECT attempts FROM broker_deliveries WHERE message_id = ? AND receiver = ? AND state = 'pending'",
        id,
        receiver,
      )[0];
      const r = this.sql.all<{ failures: number; open: number; pause_ms: number | null; blocked_until: number | null }>(
        'SELECT failures, open, pause_ms, blocked_until FROM broker_receivers WHERE receiver = ?',
        receiver,
      )[0] ?? { failures: 0, open: 0, pause_ms: null, blocked_until: null };
      const status = failure.status ?? null;
      if (failure.kind === 'slow') {
        // Not a failure: nothing spent, the run toward a pause unchanged; the receiver waits.
        const wait = Math.min(failure.afterMs ?? this.timing.slowDownMs, this.timing.maxSlowDownMs);
        const until = Math.max(r.blocked_until ?? 0, now + wait);
        this.saveReceiver(receiver, { ...r, blocked_until: until });
        if (row) {
          this.sql.run(
            'UPDATE broker_deliveries SET next_at = ?, last_error = ?, last_status = ? WHERE message_id = ? AND receiver = ?',
            now + wait, failure.error, status, id, receiver,
          );
        }
        return 'slow';
      }
      if (failure.kind === 'fail') {
        // The receiver answered: it is up, and this message will never land there.
        this.sql.run('DELETE FROM broker_receivers WHERE receiver = ?', receiver);
      } else if (r.open) {
        // A failed probe: paused again, for longer.
        const pause = Math.min((r.pause_ms ?? this.timing.pauseMs) * 2, this.timing.maxPauseMs);
        this.saveReceiver(receiver, { failures: r.failures + 1, open: 1, pause_ms: pause, blocked_until: now + pause });
      } else if (r.failures + 1 >= this.timing.pauseAfterFailures) {
        this.saveReceiver(receiver, { failures: r.failures + 1, open: 1, pause_ms: this.timing.pauseMs, blocked_until: now + this.timing.pauseMs });
      } else {
        this.saveReceiver(receiver, { ...r, failures: r.failures + 1 });
      }
      if (!row) return 'retry';
      const attempts = row.attempts + 1;
      const policy = this.policies.get(receiver) ?? DEFAULT_DELIVERY_POLICY;
      if (failure.kind === 'fail' || attempts >= policy.attempts) {
        this.sql.run(
          `UPDATE broker_deliveries SET state = 'dead', attempts = ?, next_at = NULL, dead_at = ?, last_error = ?, last_status = ?
            WHERE message_id = ? AND receiver = ?`,
          attempts, now, failure.error, status, id, receiver,
        );
        return 'dead';
      }
      this.sql.run(
        'UPDATE broker_deliveries SET attempts = ?, next_at = ?, last_error = ?, last_status = ? WHERE message_id = ? AND receiver = ?',
        attempts, now + backoffMs(policy, attempts, this.random), failure.error, status, id, receiver,
      );
      return 'retry';
    });
  }

  private saveReceiver(
    receiver: string,
    r: { failures: number; open: number; pause_ms: number | null; blocked_until: number | null },
  ): void {
    this.sql.run(
      `INSERT INTO broker_receivers (receiver, failures, open, pause_ms, blocked_until) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (receiver) DO UPDATE SET failures = excluded.failures, open = excluded.open,
           pause_ms = excluded.pause_ms, blocked_until = excluded.blocked_until`,
      receiver, r.failures, r.open, r.pause_ms, r.blocked_until,
    );
  }

  /** The dead letters, oldest first; `content` adds each message's body. */
  deadLetters(opts: { receiver?: string; limit?: number; content?: boolean } = {}): DeadLetter[] {
    const rows = this.sql.all<DueRow & {
      dead_at: number; last_error: string | null; last_status: number | null; resends: number;
    }>(
      `SELECT d.message_id, d.receiver, d.attempts, d.dead_at, d.last_error, d.last_status, d.resends,
              m.kind, m.tenant_id, m.scope_id, m.type, m.body, m.committed_at, m.ordering_key
         FROM broker_deliveries d JOIN broker_messages m ON m.id = d.message_id
        WHERE d.state = 'dead' AND (? IS NULL OR d.receiver = ?)
        ORDER BY d.dead_at, d.message_id LIMIT ?`,
      opts.receiver ?? null,
      opts.receiver ?? null,
      opts.limit ?? 50,
    );
    return rows.map((r) => ({
      messageId: r.message_id,
      receiver: r.receiver,
      kind: r.kind,
      type: r.type,
      tenantId: r.tenant_id,
      scopeId: r.scope_id,
      committedAt: r.committed_at,
      key: r.ordering_key,
      attempts: r.attempts,
      lastError: r.last_error,
      lastStatus: r.last_status,
      deadAt: r.dead_at,
      expiresAt: r.dead_at + this.timing.deadLetterRetentionMs,
      resends: r.resends,
      ...(opts.content ? { body: r.body } : {}),
    }));
  }

  /**
   * Resend a dead letter: due now, with its attempts afresh, back at the head of its lane. Only a
   * dead delivery moves, so a resend repeated, or sent after the message landed, changes nothing and
   * the receiver gets it once. `receiver` omitted: at every receiver where it is dead. Returns how
   * many deliveries it moved.
   */
  resend(id: string, receiver: string | undefined, now: number): number {
    return this.settleDead(
      `UPDATE broker_deliveries SET state = 'pending', attempts = 0, next_at = ?, dead_at = NULL, resends = resends + 1`,
      id,
      receiver,
      now,
    );
  }

  /** Discard a dead letter: it settles, and its lane moves on. Idempotent as `resend` is. */
  discard(id: string, receiver: string | undefined, now: number): number {
    return this.settleDead(`UPDATE broker_deliveries SET state = 'discarded', settled_at = ?`, id, receiver, now);
  }

  private settleDead(update: string, id: string, receiver: string | undefined, now: number): number {
    return this.sql.transaction(() => {
      const where = "WHERE message_id = ? AND state = 'dead' AND (? IS NULL OR receiver = ?)";
      const n = this.sql.all<{ n: number }>(`SELECT COUNT(*) AS n FROM broker_deliveries ${where}`, id, receiver ?? null, receiver ?? null)[0];
      this.sql.run(`${update} ${where}`, now, id, receiver ?? null, receiver ?? null);
      return Number(n?.n ?? 0);
    });
  }

  /**
   * Epoch ms the store next has work: the earliest of the next delivery that can go (a lane's head, at
   * a receiver it has, after the receiver's pause or slow-down) and the moment a kept row's bound runs
   * out (a settled message's `deliveredRetentionMs`, a dead letter's `deadLetterRetentionMs`, a held
   * message's `heldRetentionMs`). Null only when it holds nothing, so an idle broker arms nothing and
   * a busy one never keeps a row past its bound for want of an alarm. A message waiting behind its
   * lane's head is not work: the head's settling is what wakes it.
   */
  nextWakeAt(): number | null {
    const row = this.sql.all<{ due: number | null; settled: number | null; dead: number | null; held: number | null }>(
      `SELECT
         (SELECT MIN(MAX(d.next_at, COALESCE(r.blocked_until, 0)))
            FROM broker_deliveries d LEFT JOIN broker_receivers r ON r.receiver = d.receiver
           WHERE d.state = 'pending' AND d.receiver IN (SELECT value FROM json_each(?)) AND ${LANE_HEAD}) AS due,
         (SELECT MIN(last) FROM (SELECT MAX(settled_at) AS last FROM broker_deliveries
            GROUP BY message_id HAVING SUM(state IN ${OPEN}) = 0)) AS settled,
         (SELECT MIN(dead_at) FROM broker_deliveries WHERE state = 'dead') AS dead,
         (SELECT MIN(received_at) FROM broker_messages m
           WHERE NOT EXISTS (SELECT 1 FROM broker_deliveries d WHERE d.message_id = m.id)) AS held`,
      this.receivers,
    )[0];
    const times = [
      row?.due ?? null,
      row?.settled == null ? null : row.settled + this.timing.deliveredRetentionMs,
      row?.dead == null ? null : row.dead + this.timing.deadLetterRetentionMs,
      row?.held == null ? null : row.held + this.timing.heldRetentionMs,
    ].filter((t): t is number => t !== null);
    return times.length ? Math.min(...times) : null;
  }

  /**
   * Drop what the bounds say has been kept long enough (K-70). A dead letter past its bound expires,
   * which settles it as of when it died, so its message goes in the same prune and its lane moves on.
   * Marks stay: they are one row per scope and kind.
   */
  prune(now: number): void {
    this.sql.transaction(() => {
      this.sql.run(
        "UPDATE broker_deliveries SET state = 'expired', settled_at = dead_at WHERE state = 'dead' AND dead_at <= ?",
        now - this.timing.deadLetterRetentionMs,
      );
      const settled = this.sql.all<{ message_id: string }>(
        `SELECT message_id FROM broker_deliveries GROUP BY message_id
          HAVING SUM(state IN ${OPEN}) = 0 AND MAX(settled_at) <= ? LIMIT ?`,
        now - this.timing.deliveredRetentionMs,
        PRUNE_BATCH,
      );
      if (settled.length) {
        const ids = JSON.stringify(settled.map((s) => s.message_id));
        this.sql.run('DELETE FROM broker_deliveries WHERE message_id IN (SELECT value FROM json_each(?))', ids);
        this.sql.run('DELETE FROM broker_messages WHERE id IN (SELECT value FROM json_each(?))', ids);
      }
      this.sql.run(
        `DELETE FROM broker_messages WHERE received_at <= ?
           AND NOT EXISTS (SELECT 1 FROM broker_deliveries d WHERE d.message_id = broker_messages.id)`,
        now - this.timing.heldRetentionMs,
      );
    });
  }

  /** How many messages it holds that some receiver is still owed (held, or pending somewhere). */
  pending(): number {
    const row = this.sql.all<{ n: number }>(
      `SELECT COUNT(*) AS n FROM broker_messages m
        WHERE NOT EXISTS (SELECT 1 FROM broker_deliveries d WHERE d.message_id = m.id)
           OR EXISTS (SELECT 1 FROM broker_deliveries d WHERE d.message_id = m.id AND d.state = 'pending')`,
    )[0];
    return Number(row?.n ?? 0);
  }
}

/** A delivery's key in a pass's `skip` list. */
const deliveryKey = (d: { message: { id: string }; receiver: string }) => `${d.message.id} ${d.receiver}`;

/**
 * One delivery pass over a store, for both adapters: attempt each due delivery once, record the
 * outcome, and say when the next is due. A receiver's throw is a failure of that delivery alone,
 * read by `classifyFailure`. The pass re-reads what is due as it goes, so the message behind a lane's
 * head goes in the same pass once the head landed, and a receiver that a failure paused (or a probe
 * that failed) is sent nothing more in it. At most `limit` attempts.
 */
export async function runDeliveryPass(
  store: BrokerStore,
  receivers: Readonly<Record<string, DeliveryReceiver>>,
  now: () => number,
  limit = BROKER_DELIVERY_BATCH,
): Promise<DeliveryPass> {
  let delivered = 0;
  let failed = 0;
  let deadLettered = 0;
  const tried: string[] = [];
  while (tried.length < limit) {
    const batch = store.due(now(), limit - tried.length, tried);
    if (!batch.length) break;
    for (const d of batch) {
      tried.push(deliveryKey(d));
      const receiver = receivers[d.receiver];
      if (!receiver || store.blocked(d.receiver, now())) continue;
      try {
        await receiver.deliver(d.message);
        store.delivered(d.message.id, d.receiver, now());
        delivered++;
      } catch (err) {
        if (store.failed(d.message.id, d.receiver, classifyFailure(err), now()) === 'dead') deadLettered++;
        else failed++;
      }
    }
  }
  store.prune(now());
  return { delivered, failed, deadLettered, nextAt: store.nextWakeAt() };
}
