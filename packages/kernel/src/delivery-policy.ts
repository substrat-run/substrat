/**
 * What the delivery broker does when a delivery fails (K-74, rfc/broker-and-tenant-isolation.md
 * §4.5–§4.6): the receiver's policy per subscription, and what the platform decides when nobody
 * declared anything.
 *
 * | Who | Decides |
 * |---|---|
 * | The receiver, per subscription | `DeliveryPolicy`: attempts, a growing backoff with jitter, whether it needs order |
 * | The platform, undeclared | `BrokerTiming`: the pause per receiver, the slow-down, how long a dead letter is kept; and `classifyFailure`: which failures retry |
 *
 * The sender's half (time to live, whether a repeat is safe, the ordering key) is the message's: the
 * key travels as `BrokerMessage.key`, set at handoff.
 *
 * **Which failures retry** (`classifyFailure`). A receiver throws; what it throws decides:
 * - a `429`, or anything carrying `retryAfterMs` (`Retry-After`), is **slow down**: not a failure. No
 *   attempt is spent and the run toward a pause does not grow; the receiver is sent nothing until the
 *   wait passes.
 * - any other `4xx` (but `408`), or a schema error (a `ZodError`, or `permanent: true`), **fails at
 *   once**: the message goes to dead letter with one attempt spent. The receiver answered, so the run
 *   toward a pause resets.
 * - a `5xx`, a `408`, a timeout, or a throw that says nothing (a network error), is **retried**: one
 *   attempt spent, the next after the policy's backoff, and one more toward the receiver's pause.
 *
 * **Pause per receiver** (circuit breaker). After `pauseAfterFailures` retried failures in a row to
 * one receiver, the broker sends it nothing for `pauseMs`. The first delivery after that is the one
 * probe: it spends its message's attempt like any send. A success resumes everything; a failure
 * pauses again for twice as long, up to `maxPauseMs`. While paused, messages wait and spend no
 * attempts, so a receiver that is down does not exhaust what was sent to it.
 */

/** A receiver's policy for one subscription. */
export interface DeliveryPolicy {
  /** Attempts before the message goes to dead letter. */
  attempts: number;
  /** The wait after the n-th failure: `initialMs * multiplier^(n-1)`, at most `maxMs`. */
  backoff: { initialMs: number; multiplier: number; maxMs: number };
  /** The part of each wait drawn at random, 0 to 1: a wait of `w` becomes one in `[w * (1 - jitter), w]`. */
  jitter: number;
  /** Deliver in order per the sender's key: one lane per (receiver, key). A message with no key is unordered. */
  ordered: boolean;
}

/** A policy as a subscription declares it: every field optional, the rest the platform's. */
export type DeliveryPolicyInput = Partial<Omit<DeliveryPolicy, 'backoff'>> & { backoff?: Partial<DeliveryPolicy['backoff']> };

/** The platform's policy where a subscription declares none: 1 s, 4 s, 16 s, … to 10 min, 8 attempts, unordered. */
export const DEFAULT_DELIVERY_POLICY: DeliveryPolicy = {
  attempts: 8,
  backoff: { initialMs: 1_000, multiplier: 4, maxMs: 10 * 60_000 },
  jitter: 0.2,
  ordered: false,
};

/** A declared policy over the platform's defaults. */
export const resolvePolicy = (input: DeliveryPolicyInput = {}): DeliveryPolicy => ({
  ...DEFAULT_DELIVERY_POLICY,
  ...input,
  backoff: { ...DEFAULT_DELIVERY_POLICY.backoff, ...input.backoff },
});

/** What the platform decides for every receiver of one broker. A host option; these are production's. */
export interface BrokerTiming {
  /** Retried failures in a row that pause a receiver. */
  pauseAfterFailures: number;
  /** The first pause; a failed probe doubles it. */
  pauseMs: number;
  maxPauseMs: number;
  /** The slow-down after a `429` that names no `Retry-After`. */
  slowDownMs: number;
  /** The most a `Retry-After` is honoured for. */
  maxSlowDownMs: number;
  /** How long a dead letter is kept, to be resent or discarded. */
  deadLetterRetentionMs: number;
  /** How long a settled message is kept, for a duplicate handoff to find it. */
  deliveredRetentionMs: number;
  /** How long a message is held when the broker had no receiver for it (the K-70 bound until A5). */
  heldRetentionMs: number;
}

export const BROKER_TIMING: BrokerTiming = {
  pauseAfterFailures: 5,
  pauseMs: 30_000,
  maxPauseMs: 10 * 60_000,
  slowDownMs: 5_000,
  maxSlowDownMs: 60 * 60_000,
  deadLetterRetentionMs: 14 * 24 * 60 * 60_000,
  deliveredRetentionMs: 24 * 60 * 60_000,
  heldRetentionMs: 7 * 24 * 60 * 60_000,
};

/** The wait after `attempts` failures under a policy, `random` drawing the jitter (0 ≤ r < 1). */
export function backoffMs(policy: DeliveryPolicy, attempts: number, random: () => number): number {
  const { initialMs, multiplier, maxMs } = policy.backoff;
  const wait = Math.min(maxMs, initialMs * multiplier ** Math.max(attempts - 1, 0));
  return Math.round(wait * (1 - policy.jitter * random()));
}

/**
 * What a receiver throws to say how a delivery failed. Any throw is a failure; this one says which
 * kind. Its fields are read by shape, so an error that crossed an RPC hop with them still counts.
 */
export class DeliveryFailure extends Error {
  readonly status?: number;
  readonly retryAfterMs?: number;
  readonly permanent?: boolean;
  constructor(message: string, detail: { status?: number; retryAfterMs?: number; permanent?: boolean } = {}) {
    super(message);
    this.name = 'DeliveryFailure';
    if (detail.status !== undefined) this.status = detail.status;
    if (detail.retryAfterMs !== undefined) this.retryAfterMs = detail.retryAfterMs;
    if (detail.permanent !== undefined) this.permanent = detail.permanent;
  }
}

/** How the broker treats one failed delivery. */
export type FailureClass =
  | { kind: 'retry'; error: string; status?: number }
  | { kind: 'fail'; error: string; status?: number }
  | { kind: 'slow'; error: string; status?: number; afterMs?: number };

/** The platform's reading of a receiver's throw (see the header). */
export function classifyFailure(err: unknown): FailureClass {
  const e = (err ?? {}) as { message?: unknown; name?: unknown; status?: unknown; retryAfterMs?: unknown; permanent?: unknown };
  const error = (typeof e.message === 'string' ? e.message : String(err)).slice(0, 500);
  const status = typeof e.status === 'number' ? e.status : undefined;
  const withStatus = status === undefined ? {} : { status };
  const retryAfterMs = typeof e.retryAfterMs === 'number' && e.retryAfterMs >= 0 ? e.retryAfterMs : undefined;
  if (status === 429 || retryAfterMs !== undefined) {
    return { kind: 'slow', error, ...withStatus, ...(retryAfterMs === undefined ? {} : { afterMs: retryAfterMs }) };
  }
  if (e.permanent === true || e.name === 'ZodError') return { kind: 'fail', error, ...withStatus };
  if (status !== undefined && status >= 400 && status < 500 && status !== 408) return { kind: 'fail', error, ...withStatus };
  return { kind: 'retry', error, ...withStatus };
}
