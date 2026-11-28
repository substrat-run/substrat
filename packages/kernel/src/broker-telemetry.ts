/**
 * #3474 (RFC broker-and-tenant-isolation §9.1): what a delivery broker tells the platform about the
 * messages it owns, and the state it is in. Shared by both adapters, so the two cannot report
 * differently.
 *
 * Two kinds of record, one sink:
 *
 * - **A data point per step** — the scope's handoff, the broker's receipt, each delivery attempt
 *   (delivered, or failed and retried), and, once #3470 decides them, dead letter and a receiver's
 *   pause starting and ending. Each names the tenant, the app, the scope, the receiver, the channel
 *   (the message's kind), the outcome, its timing and the trace id where one is known.
 * - **The broker's state, when it changes** — queue depth, the oldest waiting message's age, paused
 *   receivers, dead-letter count. Reported by the broker as it moves, never polled, so an alarm such
 *   as "dead letter growing for app X" is a query over these points and needs no pass.
 *
 * **Never content.** No body, no event payload, no error text (a receiver's error may echo what it
 * was given), no event type, no principal: only ids the platform mints (tenant, scope, message,
 * trace), the app's slug, and enumerated steps and outcomes. Exact counts for billing are not these
 * points' job: they come from the broker's own store, into the lake (K-70).
 *
 * **Cost.** A sink write is in-memory and never awaited. A handoff adds one primary-key read per 50
 * ids it carries (`BrokerStore.held`), to tell a new message from a repeat, and keeps the state in
 * memory from there; the one aggregate read (`BrokerStore.stats`) runs once per object wake and once
 * after each delivery pass, beside the pass's own reads. A delivery pass writes one point per
 * attempt, bounded by `BROKER_DELIVERY_BATCH`, so an invocation stays far under Analytics Engine's
 * per-invocation point limit. A sink that throws drops the point and never fails the broker.
 *
 * **The seams #3470 calls.** `deadLettered`, `pauseStarted` and `pauseEnded` are here and write the
 * points their steps name; nothing calls them until #3470 decides those transitions. Its tables
 * extend `BrokerStore.stats` for the two counts the state carries.
 */
import type { BrokerMessage, BrokerMessageKind, BrokerStats, BrokerStore, DeliveryObserver } from './delivery-broker.js';

/**
 * The Analytics Engine dataset binding the broker and the scopes that hand off to it write through.
 * No binding, no points: the broker runs unobserved, as it does with the switch off.
 */
export const BROKER_TELEMETRY_BINDING = 'SUBSTRAT_BROKER_TELEMETRY';

/** Where a message is in its life, as a point names it. `state` is the broker's state report. */
export type BrokerStep =
  | 'handoff'
  | 'receipt'
  | 'delivery'
  | 'retry'
  | 'dead-letter'
  | 'pause-start'
  | 'pause-end'
  | 'state';

/** The outcomes each step may carry: enumerated, so no free text reaches a point. */
export type BrokerOutcome =
  /** handoff: every message acknowledged. */
  | 'acked'
  /** handoff: some acknowledged; the rest go again. */
  | 'partial'
  /** handoff: the broker refused or was unreachable; the scope alarm retries. */
  | 'failed'
  /** receipt: the broker now holds the batch (`duplicates` says how many it held already). */
  | 'stored'
  /** delivery: the receiver took it. */
  | 'delivered'
  /** retry: the attempt failed and the next is scheduled (`wait_ms`). */
  | 'scheduled'
  /** dead-letter: the message stops being retried (#3470). */
  | 'dead'
  /** pause-start / pause-end (#3470). */
  | 'paused'
  | 'resumed'
  /** state: the broker's state moved. */
  | 'changed';

/** One step, as it leaves. Every count and time is a number; a field not known is null. */
export interface BrokerPoint {
  step: BrokerStep;
  outcome: BrokerOutcome;
  tenantId: string;
  app: string;
  scopeId: string | null;
  /** The receiver's name. A1 has one, unnamed: null until #3470 names them. */
  receiver: string | null;
  channel: BrokerMessageKind | null;
  /** The W3C trace id (32 hex) of the request that committed, where the step runs inside it. */
  traceId: string | null;
  /** The message, for a step about one. */
  messageId: string | null;
  /** How many messages the point stands for. */
  messages: number;
  /** receipt: how many of them the broker already held. */
  duplicates: number;
  /** The step's own time: the handoff call, the delivery attempt, a pause's length. */
  durationMs: number;
  /** Since the message committed (the oldest of a batch). */
  ageMs: number;
  attempts: number;
  /** retry: until the next attempt. */
  waitMs: number;
}

/** The broker's state, as it leaves. */
export interface BrokerStateReport extends BrokerStats {
  tenantId: string;
  app: string;
  /** Age of the oldest waiting message at the report, or 0 with none. */
  oldestAgeMs: number;
}

/** Where points go: Analytics Engine on the Durable Object, a recorder in a test. */
export interface BrokerTelemetrySink {
  point(point: BrokerPoint): void;
  state(report: BrokerStateReport): void;
}

/**
 * Where each field lands in an Analytics Engine data point. **A published shape**, as the scope-work
 * and router layouts are: it only ever GROWS, a new field taking the next ordinal; no position is
 * reordered, renamed or reused. Its own dataset. Every reader filters on `substrat.broker.step`,
 * because state reports and step points share it; a state report's step fields hold their `absent`.
 *
 * "Dead letter growing for app X" reads, for instance:
 * `SELECT index1 AS tenant, blob1 AS app, max(double10) FROM <dataset> WHERE blob2 = 'state'
 *  AND timestamp > NOW() - INTERVAL '1' HOUR GROUP BY tenant, app`.
 */
export const BROKER_DATA_POINT_LAYOUT = {
  indexes: [{ ordinal: 'index1', name: 'substrat.tenant.id', unit: null, absent: '' }],
  blobs: [
    { ordinal: 'blob1', name: 'substrat.vertical', unit: null, absent: '' },
    { ordinal: 'blob2', name: 'substrat.broker.step', unit: null, absent: '' },
    { ordinal: 'blob3', name: 'substrat.broker.outcome', unit: null, absent: '' },
    { ordinal: 'blob4', name: 'substrat.scope.id', unit: null, absent: '' },
    { ordinal: 'blob5', name: 'substrat.broker.receiver', unit: null, absent: '' },
    { ordinal: 'blob6', name: 'substrat.broker.channel', unit: null, absent: '' },
    { ordinal: 'blob7', name: 'trace.id', unit: null, absent: '' },
    { ordinal: 'blob8', name: 'substrat.message.id', unit: null, absent: '' },
  ],
  doubles: [
    { ordinal: 'double1', name: 'substrat.broker.messages', unit: '{message}', absent: 0 },
    { ordinal: 'double2', name: 'substrat.broker.duplicates', unit: '{message}', absent: 0 },
    { ordinal: 'double3', name: 'substrat.broker.duration', unit: 'ms', absent: 0 },
    { ordinal: 'double4', name: 'substrat.broker.age', unit: 'ms', absent: 0 },
    { ordinal: 'double5', name: 'substrat.broker.attempts', unit: '{attempt}', absent: 0 },
    { ordinal: 'double6', name: 'substrat.broker.wait', unit: 'ms', absent: 0 },
    { ordinal: 'double7', name: 'substrat.broker.queue.depth', unit: '{message}', absent: 0 },
    { ordinal: 'double8', name: 'substrat.broker.queue.oldest_age', unit: 'ms', absent: 0 },
    { ordinal: 'double9', name: 'substrat.broker.paused_receivers', unit: '{receiver}', absent: 0 },
    { ordinal: 'double10', name: 'substrat.broker.dead_letters', unit: '{message}', absent: 0 },
  ],
} as const;

type LayoutName =
  | (typeof BROKER_DATA_POINT_LAYOUT)['blobs'][number]['name']
  | (typeof BROKER_DATA_POINT_LAYOUT)['doubles'][number]['name']
  | 'substrat.tenant.id';

/** A step point or a state report as the data point it becomes, built from the layout. */
export function brokerDataPoint(record: BrokerPoint | BrokerStateReport): {
  indexes: string[];
  blobs: string[];
  doubles: number[];
} {
  const isState = !('step' in record);
  const values: Partial<Record<LayoutName, string | number | null>> = isState
    ? {
        'substrat.tenant.id': record.tenantId,
        'substrat.vertical': record.app,
        'substrat.broker.step': 'state',
        'substrat.broker.outcome': 'changed',
        'substrat.broker.queue.depth': record.depth,
        'substrat.broker.queue.oldest_age': record.oldestAgeMs,
        'substrat.broker.paused_receivers': record.pausedReceivers,
        'substrat.broker.dead_letters': record.deadLetters,
      }
    : {
        'substrat.tenant.id': record.tenantId,
        'substrat.vertical': record.app,
        'substrat.broker.step': record.step,
        'substrat.broker.outcome': record.outcome,
        'substrat.scope.id': record.scopeId,
        'substrat.broker.receiver': record.receiver,
        'substrat.broker.channel': record.channel,
        'trace.id': record.traceId,
        'substrat.message.id': record.messageId,
        'substrat.broker.messages': record.messages,
        'substrat.broker.duplicates': record.duplicates,
        'substrat.broker.duration': record.durationMs,
        'substrat.broker.age': record.ageMs,
        'substrat.broker.attempts': record.attempts,
        'substrat.broker.wait': record.waitMs,
      };
  const L = BROKER_DATA_POINT_LAYOUT;
  return {
    indexes: L.indexes.map((f) => String(values[f.name] ?? f.absent)),
    blobs: L.blobs.map((f) => String(values[f.name] ?? f.absent)),
    doubles: L.doubles.map((f) => Number(values[f.name] ?? f.absent)),
  };
}

/** The trace id of a W3C `traceparent` (`00-<trace>-<span>-<flags>`), or null. */
export function traceIdOf(traceparent: string | undefined): string | null {
  const id = traceparent?.split('-')[1];
  return id && /^[0-9a-f]{32}$/.test(id) ? id : null;
}

const EMPTY: Omit<BrokerPoint, 'step' | 'outcome' | 'tenantId' | 'app'> = {
  scopeId: null,
  receiver: null,
  channel: null,
  traceId: null,
  messageId: null,
  messages: 0,
  duplicates: 0,
  durationMs: 0,
  ageMs: 0,
  attempts: 0,
  waitMs: 0,
};

const ageOf = (committedAt: string, at: number): number => {
  const t = Date.parse(committedAt);
  return Number.isFinite(t) ? Math.max(0, at - t) : 0;
};

/**
 * The scope's side: one point per handoff round, written where the scope calls its broker. A
 * failed round carries what it tried to send. Never throws.
 */
export function reportHandoff(
  sink: BrokerTelemetrySink,
  ids: { tenantId: string; app: string; scopeId: string },
  round: {
    sent: readonly BrokerMessage[];
    outcome: Extract<BrokerOutcome, 'acked' | 'partial' | 'failed'>;
    startedAt: number;
    at: number;
    traceId: string | null;
  },
): void {
  try {
    const oldest = round.sent.reduce<string | null>((o, m) => (o === null || m.committedAt < o ? m.committedAt : o), null);
    sink.point({
      ...EMPTY,
      step: 'handoff',
      outcome: round.outcome,
      ...ids,
      traceId: round.traceId,
      messages: round.sent.length,
      durationMs: Math.max(0, round.at - round.startedAt),
      ageMs: oldest === null ? 0 : ageOf(oldest, round.at),
    });
  } catch {
    // Telemetry never fails a handoff.
  }
}

/**
 * The broker's side, over its store: receipts, attempts, the #3470 seams, and the state report.
 * One per broker object. Every method swallows a sink's throw (counted in `dropped`).
 */
export class BrokerTelemetry {
  /** Points the sink refused. */
  dropped = 0;
  /** The state as last read or moved; null until the first read after a wake. */
  private known: BrokerStats | null = null;
  private lastReported: string | null = null;

  constructor(
    private readonly store: BrokerStore,
    private readonly sink: BrokerTelemetrySink,
    private readonly ids: { tenantId: string; app: string },
  ) {}

  /** Before `accept`: which of the messages the store holds already. Empty when the read fails. */
  heldBefore(messages: readonly BrokerMessage[]): Set<string> {
    try {
      return this.store.held(messages.map((m) => m.id));
    } catch {
      return new Set();
    }
  }

  /**
   * After `accept` committed: one receipt per (scope, channel) in the batch, and the state moved by
   * the new messages in memory (read whole once, on the first receipt after a wake).
   */
  received(messages: readonly BrokerMessage[], heldBefore: ReadonlySet<string>, at: number, traceId: string | null = null): void {
    const groups = new Map<string, { scopeId: string; channel: BrokerMessageKind; n: number; dup: number; oldest: string }>();
    let fresh = 0;
    for (const m of messages) {
      const key = `${m.scopeId}|${m.kind}`;
      const g = groups.get(key) ?? { scopeId: m.scopeId, channel: m.kind, n: 0, dup: 0, oldest: m.committedAt };
      g.n++;
      if (heldBefore.has(m.id)) g.dup++;
      else fresh++;
      if (m.committedAt < g.oldest) g.oldest = m.committedAt;
      groups.set(key, g);
    }
    for (const g of groups.values()) {
      this.write({
        ...EMPTY,
        step: 'receipt',
        outcome: 'stored',
        ...this.ids,
        scopeId: g.scopeId,
        channel: g.channel,
        traceId,
        messages: g.n,
        duplicates: g.dup,
        ageMs: ageOf(g.oldest, at),
      });
    }
    if (this.known === null) {
      this.settle(at);
      return;
    }
    if (fresh > 0) {
      this.known = { ...this.known, depth: this.known.depth + fresh, oldestAt: this.known.oldestAt ?? at };
    }
    this.report(at);
  }

  /** What `runDeliveryPass` tells of each attempt. */
  passObserver(receiver: string | null = null): DeliveryObserver {
    return {
      delivered: (m, startedAt, at) =>
        this.write({
          ...this.about(m, receiver),
          step: 'delivery',
          outcome: 'delivered',
          durationMs: Math.max(0, at - startedAt),
          ageMs: ageOf(m.committedAt, at),
        }),
      retried: (m, startedAt, at, retry) =>
        this.write({
          ...this.about(m, receiver),
          step: 'retry',
          outcome: 'scheduled',
          durationMs: Math.max(0, at - startedAt),
          ageMs: ageOf(m.committedAt, at),
          attempts: retry.attempts,
          waitMs: Math.max(0, retry.nextAt - at),
        }),
    };
  }

  /** #3470's seam: the message stops being retried. Settle the state after the pass that decided it. */
  deadLettered(m: BrokerMessage, at: number, detail: { attempts: number; receiver?: string | null }): void {
    this.write({
      ...this.about(m, detail.receiver ?? null),
      step: 'dead-letter',
      outcome: 'dead',
      ageMs: ageOf(m.committedAt, at),
      attempts: detail.attempts,
    });
  }

  /** #3470's seam: a receiver is paused. */
  pauseStarted(receiver: string, _at: number): void {
    this.write({ ...EMPTY, step: 'pause-start', outcome: 'paused', ...this.ids, receiver });
  }

  /** #3470's seam: a receiver resumes after `pausedForMs`. */
  pauseEnded(receiver: string, _at: number, pausedForMs: number): void {
    this.write({ ...EMPTY, step: 'pause-end', outcome: 'resumed', ...this.ids, receiver, durationMs: Math.max(0, pausedForMs) });
  }

  /** Read the state whole (`BrokerStore.stats`) and report it if it moved: after a pass, or on wake. */
  settle(at: number): void {
    try {
      this.known = this.store.stats();
    } catch {
      return;
    }
    this.report(at);
  }

  /** The state as known now, for a staff read (`state()` on the broker); read whole if not yet known. */
  current(at: number): BrokerStateReport {
    if (this.known === null) this.known = this.store.stats();
    return this.reportOf(this.known, at);
  }

  private reportOf(s: BrokerStats, at: number): BrokerStateReport {
    return { ...this.ids, ...s, oldestAgeMs: s.oldestAt === null ? 0 : Math.max(0, at - s.oldestAt) };
  }

  /** On change only: the same depth, oldest, pauses and dead letters write nothing. */
  private report(at: number): void {
    const s = this.known;
    if (s === null) return;
    const key = `${s.depth}|${s.oldestAt}|${s.pausedReceivers}|${s.deadLetters}`;
    if (key === this.lastReported) return;
    try {
      this.sink.state(this.reportOf(s, at));
      this.lastReported = key;
    } catch {
      this.dropped++;
    }
  }

  private about(m: BrokerMessage, receiver: string | null): BrokerPoint {
    return {
      ...EMPTY,
      step: 'delivery',
      outcome: 'delivered',
      ...this.ids,
      scopeId: m.scopeId,
      receiver,
      channel: m.kind,
      messageId: m.id,
      messages: 1,
    };
  }

  private write(point: BrokerPoint): void {
    try {
      this.sink.point(point);
    } catch {
      this.dropped++;
    }
  }
}
