/**
 * K-74 on the pure host: an in-process delivery broker over its own SQLite database, holding the
 * same contract the Durable Object broker holds (`defineDeliveryBrokerDO` in adapter-cloudflare).
 * One instance per (tenant, app): the harness keeps a map and hands `SqliteScopeHost` the resolver
 * (`deliveryBroker` option), since one pure host may serve several apps.
 *
 * It has no alarm. A delivery pass runs when `deliverDue()` is called: by the harness on its own
 * timer, or by a test. Without a receiver it only holds what it accepts, as the hosted broker does
 * until its receivers exist (A5).
 *
 * #3474: given `telemetry`, it reports what the Durable Object broker reports, through the same
 * kernel `BrokerTelemetry`: a point per receipt and delivery attempt, its state when that moves.
 */
import Database from 'better-sqlite3';
import {
  BrokerStore,
  BrokerTelemetry,
  runDeliveryPass,
  type BrokerMessage,
  type BrokerStateReport,
  type BrokerTelemetrySink,
  type DeliveryBroker,
  type DeliveryPass,
  type DeliveryReceiver,
  type HandOffAnswer,
  type HandoffMarks,
} from '@substrat-run/kernel';

export interface InProcessDeliveryBrokerOptions {
  /** The database file; omitted, an in-memory database (lost with the process). */
  file?: string;
  /** Where due messages are delivered; omitted, the broker holds what it accepts. */
  receiver?: DeliveryReceiver;
  /** The waits after each failed delivery. Defaults to `BROKER_RETRY_MS`. */
  retryMs?: readonly number[];
  /** Epoch ms, for a test that judges retries on its own clock. */
  now?: () => number;
  /** #3474: where its points and state reports go, and the (tenant, app) it is the broker of. */
  telemetry?: { sink: BrokerTelemetrySink; tenantId: string; app: string };
}

export class InProcessDeliveryBroker implements DeliveryBroker {
  private readonly db: Database.Database;
  private readonly store: BrokerStore;
  private readonly receiver: DeliveryReceiver | null;
  private readonly now: () => number;
  private readonly telemetry: BrokerTelemetry | null;

  constructor(options: InProcessDeliveryBrokerOptions = {}) {
    this.db = new Database(options.file ?? ':memory:');
    this.receiver = options.receiver ?? null;
    this.now = options.now ?? Date.now;
    this.store = new BrokerStore(
      {
        run: (sql, ...params) => void this.db.prepare(sql).run(...params),
        all: <T>(sql: string, ...params: unknown[]) => this.db.prepare(sql).all(...params) as T[],
      },
      { delivers: this.receiver !== null, ...(options.retryMs ? { retryMs: options.retryMs } : {}) },
    );
    const t = options.telemetry;
    this.telemetry = t ? new BrokerTelemetry(this.store, t.sink, { tenantId: t.tenantId, app: t.app }) : null;
  }

  async handOff(messages: readonly BrokerMessage[]): Promise<HandOffAnswer> {
    const held = this.telemetry?.heldBefore(messages);
    const now = this.now();
    const answer = this.db.transaction(() => this.store.accept(messages, now))();
    if (held) this.telemetry!.received(messages, held, now);
    return answer;
  }

  /** #3474: the broker's state now, as a staff read sees it. Null without telemetry. */
  state(): BrokerStateReport | null {
    return this.telemetry?.current(this.now()) ?? null;
  }

  async marks(tenantId: string, scopeId: string): Promise<HandoffMarks> {
    return this.store.marks(tenantId, scopeId);
  }

  /** The pass now running, if any: passes run one at a time, as the Durable Object's alarm runs them. */
  private running: Promise<DeliveryPass> | null = null;

  /**
   * One delivery pass. With no receiver there is nothing to deliver: the pass only prunes. A call
   * made while a pass runs waits for it and then runs its own, so no message is handed to the
   * receiver twice by two overlapping passes.
   */
  async deliverDue(): Promise<DeliveryPass> {
    const prior = this.running;
    const pass = (async () => {
      if (prior) await prior.catch(() => undefined);
      return this.pass();
    })();
    this.running = pass;
    try {
      return await pass;
    } finally {
      if (this.running === pass) this.running = null;
    }
  }

  private async pass(): Promise<DeliveryPass> {
    if (!this.receiver) {
      this.store.prune(this.now());
      this.telemetry?.settle(this.now());
      return { delivered: 0, failed: 0, nextAt: this.store.nextWakeAt() };
    }
    const pass = await runDeliveryPass(this.store, this.receiver, this.now, undefined, this.telemetry?.passObserver());
    this.telemetry?.settle(this.now());
    return pass;
  }

  /** How many messages it holds that are not delivered yet. */
  pending(): number {
    return this.store.pending();
  }

  close(): void {
    this.db.close();
  }
}
