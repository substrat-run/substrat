import { z } from 'zod';
import { scopeId } from './ids.js';
import { RESERVED_STORE_OPERATIONS } from './deploy.js';

/**
 * The hosted transport for a scope-store call (#2207).
 *
 * A vertical fetches `store.substrat.internal`. It names a binding, an operation
 * and an input. It does not name a script, an object or a key: the egress worker
 * hands the call to the router with the dispatch parameters the router set, and
 * the router is what signs the object name and addresses the store script.
 * `*.substrat.internal` is in no DNS zone, so a call from inside a Durable Object
 * — which an outbound worker does not see — fails instead of leaving the isolate.
 */

/** The one reserved host a scope-store call is addressed to. */
export const STORE_CALL_HOST = 'store.substrat.internal';

/** The address a platform-transport `getScopeStore` fetches. The caller does not build it. */
export const STORE_CALL_URL = `https://${STORE_CALL_HOST}/invoke`;

/** An exact host match. A suffix would admit a name the platform does not own. */
export const isStoreCallHost = (hostname: string): boolean =>
  hostname.toLowerCase() === STORE_CALL_HOST;

/**
 * An operation name a log line and a router will accept.
 *
 * A fixed label: no `@` (an address), no space, no `:` (a scheme). At most 64
 * characters, which is what the invocation line can carry.
 */
export const STORE_OPERATION_NAME = /^[^@ :]+$/;

export function isStoreOperationName(operation: string): boolean {
  return operation.length > 0 && operation.length <= 64 && STORE_OPERATION_NAME.test(operation);
}

/**
 * What the vertical puts in the body. The scope it may name is the one the
 * router dispatched it for; the router refuses any other. Strict, so a body
 * that tries to carry a signature or a script name is not a request.
 */
export const storeCallRequest = z
  .object({
    scopeId,
    binding: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
    operation: z.string().refine(isStoreOperationName, 'a store operation is a fixed label of at most 64 characters'),
    input: z.unknown().optional(),
  })
  .strict();
export type StoreCallRequest = z.infer<typeof storeCallRequest>;

/** Who the signature was made for. A reserved operation accepts only the platform's. */
export const storeCallAudience = z.enum(['caller', 'platform']);
export type StoreCallAudience = z.infer<typeof storeCallAudience>;

const reserved = new Set<string>(RESERVED_STORE_OPERATIONS);

/** A `substrat.*` operation is the platform's. A caller signature does not open it. */
export function storeAudienceAllows(operation: string, audience: StoreCallAudience): boolean {
  if (reserved.has(operation)) return audience === 'platform';
  return audience === 'caller';
}

/**
 * The name an object keeps.
 *
 * The first accepted name is stored. A later call whose name differs is not
 * this object's call, even when the signature over that other name is valid.
 * That is the check that stops a signature for one tenant's object being
 * presented to another's.
 */
export function rememberStoreObjectName(remembered: string | null, presented: string): string | undefined {
  if (presented.length === 0) return undefined;
  if (remembered === null) return presented;
  return remembered === presented ? remembered : undefined;
}
