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
 *
 * #3474: with `SUBSTRAT_BROKER_TELEMETRY` bound, it writes a data point at each receipt and delivery
 * attempt, and its state (depth, oldest age, paused receivers, dead letters) whenever that moves
 * (`BrokerTelemetry`, `broker-telemetry.ts`). `state()` answers the same report to a staff read.
 */
import { DurableObject } from 'cloudflare:workers';
import {
  BrokerStore,
  BrokerTelemetry,
  runDeliveryPass,
  type BrokerMessage,
  type BrokerStateReport,
  type DeliveryReceiver,
  type HandOffAnswer,
  type HandoffMarks,
} from '@substrat-run/kernel';
import { analyticsBrokerSink, brokerIdsOf, brokerTelemetryDataset } from './broker-telemetry.js';

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
  /** #3474: the broker's state now, for staff. Null when telemetry is not bound. */
  state(): Promise<BrokerStateReport | null>;
}

export type DeliveryBrokerDOClass<Env> = new (
  ctx: DurableObjectState,
  env: Env,
) => DurableObject<Env> & DeliveryBrokerRpc & { alarm(): Promise<void> };

export function defineDeliveryBrokerDO<Env = unknown>(options: DeliveryBrokerOptions<Env> = {}): DeliveryBrokerDOClass<Env> {
  return class DeliveryBrokerDO extends DurableObject<Env> implements DeliveryBrokerRpc {
    private readonly store: BrokerStore;
    private readonly receiver: DeliveryReceiver | null;
    private readonly telemetry: BrokerTelemetry | null;

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
      const dataset = brokerTelemetryDataset(env);
      this.telemetry = dataset
        ? new BrokerTelemetry(this.store, analyticsBrokerSink(dataset), brokerIdsOf(ctx.id.name))
        : null;
    }

    async handOff(messages: BrokerMessage[]): Promise<HandOffAnswer> {
      // Read before the transaction, with no await between: nothing else runs on the object.
      const held = this.telemetry?.heldBefore(messages);
      const now = Date.now();
      const answer = this.ctx.storage.transactionSync(() => this.store.accept(messages, now));
      if (held) this.telemetry!.received(messages, held, now);
      await this.armFor();
      return answer;
    }

    async state(): Promise<BrokerStateReport | null> {
      return this.telemetry?.current(Date.now()) ?? null;
    }

    async marks(tenantId: string, scopeId: string): Promise<HandoffMarks> {
      return this.store.marks(tenantId, scopeId);
    }

    async alarm(): Promise<void> {
      if (this.receiver) {
        await runDeliveryPass(this.store, this.receiver, Date.now, undefined, this.telemetry?.passObserver());
      } else this.store.prune(Date.now());
      this.telemetry?.settle(Date.now());
      await this.armFor();
    }

    /**
     * The one alarm, moved only earlier: the next due delivery or the next row whose bound runs out
     * (`BrokerStore.nextWakeAt`), and nothing when the broker holds nothing.
     */
    private async armFor(): Promise<void> {
      const at = this.store.nextWakeAt();
      if (at === null) return;
      const current = await this.ctx.storage.getAlarm();
      if (current === null || current > at) await this.ctx.storage.setAlarm(at);
    }
  };
}
