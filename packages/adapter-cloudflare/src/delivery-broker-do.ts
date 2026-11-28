/**
 * K-74 on the Durable Object: the delivery broker, one object per (tenant, app), named
 * `brokerName(tenantId, app)` in the namespace the app's script binds as `SUBSTRAT_DELIVERY_BROKER`.
 * It sits in the app's own script, so a scope's handoff is a direct call.
 *
 * It keeps what it accepts in its own SQLite, through the kernel's `BrokerStore` — the same store
 * the pure host's `InProcessDeliveryBroker` uses — and acknowledges in the transaction that stores.
 * Acceptance is idempotent by message id: a handoff repeated after a lost acknowledgement stores
 * nothing twice.
 *
 * Delivery runs from the object's alarm, and only when a receiver is configured. A1 ships none
 * (A5 adds the shadow recorder), so in production the broker holds what it accepts, bounded by
 * `BROKER_HELD_RETENTION_MS`, with one alarm to prune it. An object holding nothing arms nothing
 * (D-79).
 */
import { DurableObject } from 'cloudflare:workers';
import {
  BROKER_HELD_RETENTION_MS,
  BrokerStore,
  runDeliveryPass,
  type BrokerMessage,
  type DeliveryReceiver,
  type HandOffAnswer,
  type HandoffMarks,
} from '@substrat-run/kernel';

export interface DeliveryBrokerOptions<Env> {
  /** Where due messages are delivered. Omitted, the broker holds what it accepts. */
  receiver?: (env: Env) => DeliveryReceiver;
  /** The waits after each failed delivery. Defaults to `BROKER_RETRY_MS`. */
  retryMs?: readonly number[];
}

/** The broker as a scope reaches it over RPC. */
export interface DeliveryBrokerRpc {
  handOff(messages: BrokerMessage[]): Promise<HandOffAnswer>;
  marks(tenantId: string, scopeId: string): Promise<HandoffMarks>;
}

export type DeliveryBrokerDOClass<Env> = new (
  ctx: DurableObjectState,
  env: Env,
) => DurableObject<Env> & DeliveryBrokerRpc & { alarm(): Promise<void> };

export function defineDeliveryBrokerDO<Env = unknown>(options: DeliveryBrokerOptions<Env> = {}): DeliveryBrokerDOClass<Env> {
  return class DeliveryBrokerDO extends DurableObject<Env> implements DeliveryBrokerRpc {
    private readonly store: BrokerStore;
    private readonly receiver: DeliveryReceiver | null;

    constructor(ctx: DurableObjectState, env: Env) {
      super(ctx, env);
      this.receiver = options.receiver ? options.receiver(env) : null;
      const sql = ctx.storage.sql;
      this.store = new BrokerStore(
        {
          run: (q, ...params) => void sql.exec(q, ...params),
          all: <T>(q: string, ...params: unknown[]) => sql.exec(q, ...params).toArray() as T[],
        },
        { delivers: this.receiver !== null, ...(options.retryMs ? { retryMs: options.retryMs } : {}) },
      );
    }

    async handOff(messages: BrokerMessage[]): Promise<HandOffAnswer> {
      const answer = this.ctx.storage.transactionSync(() => this.store.accept(messages, Date.now()));
      await this.armFor();
      return answer;
    }

    async marks(tenantId: string, scopeId: string): Promise<HandoffMarks> {
      return this.store.marks(tenantId, scopeId);
    }

    async alarm(): Promise<void> {
      if (this.receiver) await runDeliveryPass(this.store, this.receiver, Date.now);
      else this.store.prune(Date.now());
      await this.armFor();
    }

    /**
     * The one alarm, moved only earlier: the next due delivery with a receiver, the next prune of
     * what it holds without one, nothing when it holds nothing.
     */
    private async armFor(): Promise<void> {
      const at = this.receiver
        ? this.store.nextAt()
        : this.store.pending() > 0
          ? Date.now() + BROKER_HELD_RETENTION_MS
          : null;
      if (at === null) return;
      const current = await this.ctx.storage.getAlarm();
      if (current === null || current > at) await this.ctx.storage.setAlarm(at);
    }
  };
}
