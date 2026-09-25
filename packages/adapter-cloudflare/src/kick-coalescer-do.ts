import { DurableObject } from 'cloudflare:workers';
import type { ScopeId, TenantId } from '@substrat-run/contracts';

/**
 * How long one producer's cross-vertical kicks coalesce (#1705 PR 2): after a pass STARTS, the
 * next may start no sooner than this. A burst inside the window costs the pass that started it
 * plus one trailing pass at the window's end, fleet-wide. It is not per isolate, because one
 * Durable Object per producer holds the bit.
 */
export const CROSS_VERTICAL_KICK_WINDOW_MS = 5_000;

/** What one kick did: started a pass, joined the one running, or left it for the window's end. */
export type KickOutcome = 'ran' | 'coalesced' | 'deferred';

/** The producer a kick names: the scope the router resolved, and its tenant. Nothing else. */
export interface KickProducer {
  tenantId: TenantId;
  scopeId: ScopeId;
}

/** The RPC surface a `defineKickCoalescerDO` class exposes over its stub. */
export interface KickCoalescerDo {
  kick(tenantId: TenantId, scopeId: ScopeId): Promise<KickOutcome>;
}

export interface KickCoalescerConfig<Env> {
  /** Default {@link CROSS_VERTICAL_KICK_WINDOW_MS}. */
  windowMs?: number;
  /**
   * One pass for this producer. CODE-TIME, closed over like `definePlatformSweeperDO`'s
   * `sweep`, since a Durable Object cannot receive a closure over RPC. It is where the
   * authority lives: the deployment runs `runCrossVerticalFrom` here with the same reach and
   * gates as its sweep, so this object decides only WHEN, never what or for whom.
   */
  run(env: Env, producer: KickProducer): Promise<void>;
  /** A pass that threw. Never rethrown: a lost kick costs latency, and the sweep is the backstop. */
  onError?(err: unknown, env: Env): void;
}

/** The one instance per producer: `ns.get(ns.idFromName(kickCoalescerName(tenantId, scopeId)))`. */
export function kickCoalescerName(tenantId: TenantId, scopeId: ScopeId): string {
  return `${tenantId}:${scopeId}`;
}

interface KickState {
  producer: KickProducer;
  /** When the last pass started, epoch ms. Stored, so an eviction does not reset the window. */
  lastStartedAt: number;
  /** A kick arrived that the last pass may not have covered. */
  dirty: boolean;
}

/**
 * `defineKickCoalescerDO` — the global bound on the router kick (#1705 PR 2).
 *
 * The kick is raised by a response header that tenant code sets, so a vertical can raise it on
 * every response it serves. Each one is a producer-scoped cross-vertical pass: a directory read,
 * registry reads, and up to `maxConsumers × (1 + 2 × sources)` `/internal` calls. The phase caps
 * one pass, not passes per unit of time. This object is that second cap, and it holds nothing
 * else: no authority and no data, only a start time and a dirty bit.
 *
 * - A kick with no pass running and none started within the window starts one, and waits for it.
 * - A kick while a pass runs marks the producer dirty and returns at once. When the pass ends,
 *   a dirty producer gets one trailing pass at the window's end, by alarm.
 * - A kick inside the window marks it dirty and returns at once. The same alarm runs the
 *   trailing pass.
 *
 * So passes for one producer start at least `windowMs` apart. A burst of N kicks costs one pass
 * plus one trailing pass, and nothing a tenant sends can raise that. The trailing pass is what
 * keeps coalescing lossless: an event committed after the first pass read its outbox is still
 * moved within one window, not left for the next sweep.
 */
export function defineKickCoalescerDO<Env>(
  config: KickCoalescerConfig<Env>,
): new (ctx: DurableObjectState, env: Env) => DurableObject<Env> & KickCoalescerDo {
  const windowMs = config.windowMs ?? CROSS_VERTICAL_KICK_WINDOW_MS;
  return class KickCoalescerDO extends DurableObject<Env> {
    /** The in-flight pass, when one is running. */
    #running: Promise<void> | null = null;

    async kick(tenantId: TenantId, scopeId: ScopeId): Promise<KickOutcome> {
      const prior = await this.ctx.storage.get<KickState>('state');
      const state: KickState = prior ?? { producer: { tenantId, scopeId }, lastStartedAt: 0, dirty: false };
      if (this.#running) {
        await this.ctx.storage.put('state', { ...state, dirty: true });
        return 'coalesced';
      }
      const now = Date.now();
      if (now - state.lastStartedAt < windowMs) {
        await this.ctx.storage.put('state', { ...state, dirty: true });
        await this.#armFor(state.lastStartedAt);
        return 'deferred';
      }
      await this.#pass(state);
      return 'ran';
    }

    /**
     * The window's end: the trailing pass if a kick arrived that no pass has covered, and
     * otherwise the end of this object. Its storage is deleted, so a producer that kicked once
     * leaves nothing behind. That waits for the window's end, so a kick after the delete may run
     * at once without breaking the bound.
     */
    async alarm(): Promise<void> {
      const state = await this.ctx.storage.get<KickState>('state');
      if (!state || this.#running) return;
      // The window holds even against an early alarm: re-arm for its end rather than act.
      if (Date.now() - state.lastStartedAt < windowMs) {
        await this.#armFor(state.lastStartedAt);
        return;
      }
      if (state.dirty) {
        await this.#pass(state);
        return;
      }
      await this.ctx.storage.deleteAlarm();
      await this.ctx.storage.deleteAll();
    }

    async #pass(state: KickState): Promise<void> {
      const startedAt = Date.now();
      await this.ctx.storage.put('state', { ...state, lastStartedAt: startedAt, dirty: false });
      this.#running = (async () => {
        try {
          await config.run(this.env, state.producer);
        } catch (err) {
          config.onError?.(err, this.env);
        }
      })();
      try {
        await this.#running;
      } finally {
        this.#running = null;
        // Always, at this window's end: the alarm runs the trailing pass if a kick arrived since
        // this one started, and clears this object's storage if none did.
        await this.#armFor(startedAt);
      }
    }

    /** Arm the trailing pass for the end of the window that started at `startedAt`. */
    async #armFor(startedAt: number): Promise<void> {
      const at = startedAt + windowMs;
      const existing = await this.ctx.storage.getAlarm();
      if (existing === null || existing > at) await this.ctx.storage.setAlarm(at);
    }
  };
}
