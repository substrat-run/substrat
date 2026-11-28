/**
 * K-74 on the pure host: an in-process delivery broker over its own SQLite database, holding the
 * same contract the Durable Object broker holds (`defineDeliveryBrokerDO` in adapter-cloudflare).
 * One instance per (tenant, app): the harness keeps a map and hands `SqliteScopeHost` the resolver
 * (`deliveryBroker` option), since one pure host may serve several apps.
 *
 * It has no alarm. A delivery pass runs when `deliverDue()` is called: by the harness on its own
 * timer, or by a test. Without a receiver it only holds what it accepts, as the hosted broker does
 * until its receivers exist (A5). Retries, the pause per receiver, ordering per key and dead letter
 * (A4) are the kernel's `BrokerStore`, so they hold here exactly as on the Durable Object.
 */
import Database from 'better-sqlite3';
import {
  BrokerStore,
  runDeliveryPass,
  type BrokerMessage,
  type BrokerTiming,
  type DeadLetter,
  type DeliveryBroker,
  type DeliveryPass,
  type DeliveryPolicyInput,
  type DeliveryReceiver,
  type HandOffAnswer,
  type HandoffMarks,
} from '@substrat-run/kernel';

export interface InProcessDeliveryBrokerOptions {
  /** The database file; omitted, an in-memory database (lost with the process). */
  file?: string;
  /** Where due messages are delivered, as the subscription named `'default'`; omitted, the broker holds what it accepts. */
  receiver?: DeliveryReceiver;
  /** The `receiver`'s policy, over the platform's (`DEFAULT_DELIVERY_POLICY`). */
  policy?: DeliveryPolicyInput;
  /** Further receivers, each its own subscription: its own attempts, pause and lanes. */
  subscriptions?: readonly InProcessSubscription[];
  /** The platform's timing, over `BROKER_TIMING`. */
  timing?: Partial<BrokerTiming>;
  /** The jitter's draw, for a test that judges waits exactly. */
  random?: () => number;
  /** Epoch ms, for a test that judges retries on its own clock. */
  now?: () => number;
}

/** One receiver of an in-process broker. */
export interface InProcessSubscription {
  name: string;
  receiver: DeliveryReceiver;
  policy?: DeliveryPolicyInput;
}

export class InProcessDeliveryBroker implements DeliveryBroker {
  private readonly db: Database.Database;
  private readonly store: BrokerStore;
  private readonly receivers: Record<string, DeliveryReceiver>;
  private readonly now: () => number;

  constructor(options: InProcessDeliveryBrokerOptions = {}) {
    this.db = new Database(options.file ?? ':memory:');
    const subscriptions: InProcessSubscription[] = [
      ...(options.receiver ? [{ name: 'default', receiver: options.receiver, ...(options.policy ? { policy: options.policy } : {}) }] : []),
      ...(options.subscriptions ?? []),
    ];
    this.receivers = Object.fromEntries(subscriptions.map((s) => [s.name, s.receiver]));
    this.now = options.now ?? Date.now;
    this.store = new BrokerStore(
      {
        run: (sql, ...params) => void this.db.prepare(sql).run(...params),
        all: <T>(sql: string, ...params: unknown[]) => this.db.prepare(sql).all(...params) as T[],
        transaction: (fn) => this.db.transaction(fn)(),
      },
      {
        subscriptions: subscriptions.map((s) => ({ name: s.name, ...(s.policy ? { policy: s.policy } : {}) })),
        ...(options.timing ? { timing: options.timing } : {}),
        ...(options.random ? { random: options.random } : {}),
      },
    );
  }

  async handOff(messages: readonly BrokerMessage[]): Promise<HandOffAnswer> {
    return this.store.accept(messages, this.now());
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
    return runDeliveryPass(this.store, this.receivers, this.now);
  }

  /** How many messages it holds that some receiver is still owed. */
  pending(): number {
    return this.store.pending();
  }

  /** The dead letters, oldest first; `content` adds each message's body. */
  deadLetters(opts: { receiver?: string; limit?: number; content?: boolean } = {}): DeadLetter[] {
    return this.store.deadLetters(opts);
  }

  /** Resend a dead letter (at `receiver`, or wherever it is dead). Idempotent; returns the deliveries moved. */
  resend(messageId: string, receiver?: string): number {
    return this.store.resend(messageId, receiver, this.now());
  }

  /** Discard a dead letter, so its lane moves on. Idempotent; returns the deliveries settled. */
  discard(messageId: string, receiver?: string): number {
    return this.store.discard(messageId, receiver, this.now());
  }

  close(): void {
    this.db.close();
  }
}
