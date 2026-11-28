/**
 * K-74 on the pure host: an in-process delivery broker over its own SQLite database, holding the
 * same contract the Durable Object broker holds (`defineDeliveryBrokerDO` in adapter-cloudflare).
 * One instance per (tenant, app): the harness keeps a map and hands `SqliteScopeHost` the resolver
 * (`deliveryBroker` option), since one pure host may serve several apps.
 *
 * It has no alarm. A delivery pass runs when `deliverDue()` is called: by the harness on its own
 * timer, or by a test. Without a receiver it only holds what it accepts, as the hosted broker does
 * until its receivers exist (A5).
 */
import Database from 'better-sqlite3';
import {
  BrokerStore,
  runDeliveryPass,
  type BrokerMessage,
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
}

export class InProcessDeliveryBroker implements DeliveryBroker {
  private readonly db: Database.Database;
  private readonly store: BrokerStore;
  private readonly receiver: DeliveryReceiver | null;
  private readonly now: () => number;

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
  }

  async handOff(messages: readonly BrokerMessage[]): Promise<HandOffAnswer> {
    return this.db.transaction(() => this.store.accept(messages, this.now()))();
  }

  async marks(tenantId: string, scopeId: string): Promise<HandoffMarks> {
    return this.store.marks(tenantId, scopeId);
  }

  /** One delivery pass. With no receiver there is nothing to deliver: the pass only prunes. */
  async deliverDue(): Promise<DeliveryPass> {
    if (!this.receiver) {
      this.store.prune(this.now());
      return { delivered: 0, failed: 0, nextAt: null };
    }
    return runDeliveryPass(this.store, this.receiver, this.now);
  }

  /** How many messages it holds that are not delivered yet. */
  pending(): number {
    return this.store.pending();
  }

  close(): void {
    this.db.close();
  }
}
