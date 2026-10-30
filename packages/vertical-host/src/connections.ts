import { PLATFORM_SECRET_HEADER, connectionBindResult, connectionRelayResult, connectionUnbindResult } from '@substrat-run/contracts';
import type {
  ConnectionBindRequest,
  ConnectionBindResult,
  ConnectionRelayResult,
  ConnectionUnbindRequest,
  ConnectionUnbindResult,
  connectionRelayRequest,
  z,
} from '@substrat-run/contracts';

/**
 * A connection, from a VERTICAL's worker: store a credential (connections.md §3.5.2), and bind a
 * scope's own connection to that scope with its own options, or unbind it (#2732).
 *
 * The same split as {@link requestConnectUrl}: the operation decides, the harness effects. Module
 * code cannot `fetch`, and a credential must never rest in a scope row or an event, so the
 * operation checks the permission and returns what to send, and the worker sends it:
 *
 * ```ts
 * // module.ts — the authorizing act, and the only place a permission is checked
 * const connectSource: OperationHandler = async (ctx, raw) => {
 *   assertAllowed(await ctx.check(PERM.manageSource));
 *   return { principal: ctx.principal, folder: schema.parse(raw).folder };
 * };
 *
 * // worker.ts — the effect
 * const { principal, folder } = await scope.invoke<{ principal: string; folder: string }>('drive/connect-source', { folder: body.folder });
 * const access = { controlPlaneUrl: env.CONTROL_PLANE_URL, platformSecret: env.PLATFORM_SECRET, tenantId, scopeId };
 * const { connectionId } = await upsertConnection({ ...access, provider: 'acme-files', secret, owner: 'scope', createdBy: principal });
 * await bindConnection({ ...access, connectionId, options: { folder }, boundBy: principal });
 * ```
 *
 * Which vertical the connection belongs to is re-derived from the directory's record for
 * `(tenantId, scopeId)`. A bind goes through the `on-request` landing the scope's running version
 * declares for the provider, so the operation and the key it grants come from that declaration,
 * and the connector validates the options. Bind and unbind, and an `owner: 'scope'` upsert, need a
 * PROVEN caller: call them from the worker, on the request it is serving, never from inside a
 * Durable Object.
 */
export interface ConnectionRelayAccess {
  /** The control plane's origin, injected into the vertical as `CONTROL_PLANE_URL`. */
  controlPlaneUrl: string;
  /** The `PLATFORM_SECRET` injected into this dispatch script. */
  platformSecret: string;
  /** `fetch` seam for tests; defaults to the runtime's, bound (see `lint:bound-fetch`). */
  fetchImpl?: typeof fetch;
}

export type UpsertConnectionRequest = ConnectionRelayAccess & z.input<typeof connectionRelayRequest>;
export type BindConnectionRequest = ConnectionRelayAccess & ConnectionBindRequest;
export type UnbindConnectionRequest = ConnectionRelayAccess & ConnectionUnbindRequest;

/** The relay refused, or answered something other than its result. Carries the status so a caller can map it. */
export class ConnectionRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'ConnectionRequestError';
  }
}

async function relay<S extends z.ZodTypeAny>(
  { controlPlaneUrl, platformSecret, fetchImpl, ...body }: ConnectionRelayAccess & object,
  path: string,
  result: S,
  what: string,
): Promise<z.infer<S>> {
  const res = await (fetchImpl ?? globalThis.fetch.bind(globalThis))(`${controlPlaneUrl.replace(/\/+$/, '')}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', [PLATFORM_SECRET_HEADER]: platformSecret },
    body: JSON.stringify(body),
  });
  const answer: unknown = await res.json().catch(() => ({}));
  const parsed = result.safeParse(answer);
  if (!res.ok || !parsed.success) {
    const error = (answer as { error?: unknown } | null)?.error;
    throw new ConnectionRequestError(
      `the platform refused to ${what} (${res.status}): ${typeof error === 'string' ? error : 'unknown error'}`,
      res.status,
    );
  }
  return parsed.data;
}

/** Create the connection, or rotate the live one's secret in place. The answer never echoes the secret. */
export function upsertConnection(request: UpsertConnectionRequest): Promise<ConnectionRelayResult> {
  return relay(request, '/internal/connections/upsert', connectionRelayResult, `store a ${request.provider} connection`);
}

/** Bind the scope's own connection to that scope with these options; a rebind keeps options it does not name. */
export function bindConnection(request: BindConnectionRequest): Promise<ConnectionBindResult> {
  return relay(request, '/internal/connections/bind', connectionBindResult, `bind connection ${request.connectionId}`);
}

/** Drop the binding and take its landing key back on this scope; what the scope landed stays. Idempotent. */
export function unbindConnection(request: UnbindConnectionRequest): Promise<ConnectionUnbindResult> {
  return relay(request, '/internal/connections/unbind', connectionUnbindResult, `unbind connection ${request.connectionId}`);
}
