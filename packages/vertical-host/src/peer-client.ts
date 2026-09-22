import { globalFetch } from '@substrat-run/kernel';
import { PEER_CALL_URL, peerCallResponse, substratError, type ErrorCode } from '@substrat-run/contracts';

/**
 * Calling another vertical of the same tenant, from a vertical's own harness (#1706).
 *
 * ```ts
 * const crm = peerClient('acme/crm');
 * const { items } = await crm.invoke<{ items: Customer[] }>('customer/list', { limit: 50 });
 * ```
 *
 * There is no credential here, and no address: the call goes to one reserved, unroutable
 * address, and the platform fills in WHO is calling from the dispatch the harness is running
 * under. What the caller declares is `substrat.calls` in its package.json; what it may do is
 * the target's own `peers` declaration, whose permissions its permission diff reviews.
 *
 * **Where it may be called from.** Harness code — a route handler, or work a route handler
 * starts. NOT module code: an operation, a consumer and a schedule run inside the scope's
 * Durable Object, which has no network by rule, and the platform does not police a fetch
 * raised there. A handler that needs a peer asks for one through a platform intent instead
 * (`ctx.requestPlatform`), which is delivered with the same identity and at-least-once.
 *
 * `fetch` is injectable for one reason: the pure host has no egress worker in front of it, so
 * a dev server or a test passes the local broker's transport instead
 * (`createLocalVerticalBroker` from `@substrat-run/adapter-sqlite/vertical-broker`). A hosted
 * deployment passes nothing and gets the runtime's own `fetch`, which is what carries the
 * call through egress.
 */
export interface PeerClient {
  /** Invoke one operation on that vertical's instance in this tenant. */
  invoke<O = unknown>(operation: string, input?: unknown, options?: { idempotencyKey?: string }): Promise<O>;
}

export interface PeerClientOptions {
  /** The transport. Defaults to the runtime's `fetch`, which egress intercepts. */
  fetch?: typeof fetch;
}

/** What a refused peer call throws: the platform's code and the reason, not a bare status. */
const REFUSAL_BY_STATUS: Record<number, ErrorCode> = {
  400: 'validation_failed',
  403: 'forbidden',
  404: 'not_found',
  409: 'conflict',
  429: 'rate_limited',
  502: 'unavailable',
  503: 'unavailable',
};

export function peerClient(vertical: string, options: PeerClientOptions = {}): PeerClient {
  const call = options.fetch ?? globalFetch;
  return {
    async invoke<O>(operation: string, input?: unknown, invokeOptions?: { idempotencyKey?: string }): Promise<O> {
      const response = await call(PEER_CALL_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          vertical,
          operation,
          ...(input === undefined ? {} : { input }),
          ...(invokeOptions?.idempotencyKey === undefined
            ? {}
            : { idempotencyKey: invokeOptions.idempotencyKey }),
        }),
      });
      const body = (await response.json().catch(() => null)) as { result?: unknown; error?: unknown } | null;
      if (!response.ok) {
        // The platform's own words reach the caller: an undeclared target says what to
        // declare, a preview says to use the local broker, an ambiguous tenant says to bind
        // the instance. Swallowing them into "peer call failed" would cost exactly the
        // sentence a builder needs.
        throw substratError(
          REFUSAL_BY_STATUS[response.status] ?? 'internal',
          typeof body?.error === 'string'
            ? body.error
            : `the call to '${vertical}' was refused (${response.status})`,
        );
      }
      const parsed = peerCallResponse.safeParse(body);
      if (!parsed.success) throw substratError('unavailable', `invalid peer response from '${vertical}'`);
      return parsed.data.result as O;
    },
  };
}
