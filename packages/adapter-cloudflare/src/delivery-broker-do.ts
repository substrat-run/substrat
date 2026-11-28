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
 * Retries, the pause per receiver, ordering per key and dead letter (A4, #3470) are the kernel's
 * `BrokerStore` over this object's SQLite; the alarm is what runs them. Each receiver is a
 * subscription: `receiver` alone is the one named `'default'`. A dead letter is resent or discarded
 * over RPC (`resend`, `discard`), and read with `deadLetters`.
 */
import { DurableObject } from 'cloudflare:workers';
import {
  BrokerStore,
  runDeliveryPass,
  type BrokerMessage,
  type BrokerTiming,
  type DeadLetter,
  type DeliveryPolicyInput,
  type DeliveryReceiver,
  type HandOffAnswer,
  type HandoffMarks,
} from '@substrat-run/kernel';

/** One receiver of the broker, made from the script's env. */
export interface DeliveryBrokerSubscription<Env> {
  name: string;
  receiver: (env: Env) => DeliveryReceiver;
  policy?: DeliveryPolicyInput;
}

export interface DeliveryBrokerOptions<Env> {
  /** Where due messages are delivered, as the subscription named `'default'`. Omitted (and no `subscriptions`), the broker holds what it accepts. */
  receiver?: (env: Env) => DeliveryReceiver;
  /** The `receiver`'s policy, over the platform's (`DEFAULT_DELIVERY_POLICY`). */
  policy?: DeliveryPolicyInput;
  /** Further receivers, each its own subscription: its own attempts, pause and lanes. */
  subscriptions?: readonly DeliveryBrokerSubscription<Env>[];
  /** The platform's timing, over `BROKER_TIMING`. Production passes nothing. */
  timing?: Partial<BrokerTiming>;
  /** The jitter's draw. Defaults to `Math.random`. */
  random?: () => number;
}

/** The broker as a scope reaches it over RPC. */
export interface DeliveryBrokerRpc {
  handOff(messages: BrokerMessage[]): Promise<HandOffAnswer>;
  marks(tenantId: string, scopeId: string): Promise<HandoffMarks>;
}

/** The broker's dead letter, over RPC: read, resend, discard. */
export interface DeliveryBrokerDeadLetterRpc {
  deadLetters(opts?: { receiver?: string; limit?: number; content?: boolean }): Promise<DeadLetter[]>;
  resend(messageId: string, receiver?: string): Promise<number>;
  discard(messageId: string, receiver?: string): Promise<number>;
}

export type DeliveryBrokerDOClass<Env> = new (
  ctx: DurableObjectState,
  env: Env,
) => DurableObject<Env> & DeliveryBrokerRpc & DeliveryBrokerDeadLetterRpc & { alarm(): Promise<void> };

export function defineDeliveryBrokerDO<Env = unknown>(options: DeliveryBrokerOptions<Env> = {}): DeliveryBrokerDOClass<Env> {
  const subscriptions: DeliveryBrokerSubscription<Env>[] = [
    ...(options.receiver ? [{ name: 'default', receiver: options.receiver, ...(options.policy ? { policy: options.policy } : {}) }] : []),
    ...(options.subscriptions ?? []),
  ];
  return class DeliveryBrokerDO extends DurableObject<Env> implements DeliveryBrokerRpc, DeliveryBrokerDeadLetterRpc {
    private readonly store: BrokerStore;
    private readonly receivers: Record<string, DeliveryReceiver>;

    constructor(ctx: DurableObjectState, env: Env) {
      super(ctx, env);
      this.receivers = Object.fromEntries(subscriptions.map((s) => [s.name, s.receiver(env)]));
      const sql = ctx.storage.sql;
      this.store = new BrokerStore(
        {
          run: (q, ...params) => void sql.exec(q, ...params),
          all: <T>(q: string, ...params: unknown[]) => sql.exec(q, ...params).toArray() as T[],
          transaction: (fn) => ctx.storage.transactionSync(fn),
        },
        {
          subscriptions: subscriptions.map((s) => ({ name: s.name, ...(s.policy ? { policy: s.policy } : {}) })),
          ...(options.timing ? { timing: options.timing } : {}),
          ...(options.random ? { random: options.random } : {}),
        },
      );
    }

    async handOff(messages: BrokerMessage[]): Promise<HandOffAnswer> {
      const answer = this.store.accept(messages, Date.now());
      await this.armFor();
      return answer;
    }

    async marks(tenantId: string, scopeId: string): Promise<HandoffMarks> {
      return this.store.marks(tenantId, scopeId);
    }

    async deadLetters(opts: { receiver?: string; limit?: number; content?: boolean } = {}): Promise<DeadLetter[]> {
      return this.store.deadLetters(opts);
    }

    async resend(messageId: string, receiver?: string): Promise<number> {
      const moved = this.store.resend(messageId, receiver, Date.now());
      if (moved) await this.armFor();
      return moved;
    }

    async discard(messageId: string, receiver?: string): Promise<number> {
      const settled = this.store.discard(messageId, receiver, Date.now());
      // A discarded head lets its lane move on: what waited behind it is due now.
      if (settled) await this.armFor();
      return settled;
    }

    async alarm(): Promise<void> {
      await runDeliveryPass(this.store, this.receivers, Date.now);
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
