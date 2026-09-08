import { PLATFORM_SECRET_HEADER } from '@substrat-run/kernel';
import type { ConnectUrlRelayResult } from '@substrat-run/contracts';

/**
 * Start a provider consent round from a VERTICAL (connections.md §3.5.3).
 *
 * The case this exists for: a bookkeeping bureau connects a new client company most
 * weeks, each one its own Fortnox consent round, and the people doing it work inside the
 * vertical and have no dashboard account. Neither existing door fits — there is no
 * credential to paste until the round has happened, and minting the dashboard's connect
 * link needs a dashboard session.
 *
 * ## Where the permission check goes
 *
 * **Here is the harness, not the operation.** Module code cannot `fetch` (boundary-lint
 * R3), and it must not: a connect URL is an outbound call, and the authority behind it is
 * a decision the scope already made. So the shape is the one `user/set-password` and the
 * credential relay established — the operation decides, the harness effects:
 *
 * ```ts
 * // module.ts — the authorizing act, and the only place a permission is checked
 * const connectClientBooks: OperationHandler<{ clientId: string }, ConnectRequest> = async (ctx, raw) => {
 *   assertAllowed(await ctx.check(PERM.manageIntegrations));
 *   const input = schema.parse(raw);
 *   const client = ctx.sql.query('SELECT id FROM clients WHERE id = ?', [input.clientId])[0];
 *   if (!client) throw new NotFound(...);
 *   return { provider: 'fortnox', subjectRef: client.id };   // no URL yet, and no secret ever
 * };
 *
 * // server.ts — the effect, with the URL stripped from nothing and handed straight on
 * const request = await scope.invoke('crm/connect-client-books', { clientId });
 * const { url } = await requestConnectUrl({
 *   controlPlaneUrl: env.CONTROL_PLANE_URL,
 *   platformSecret: env.PLATFORM_SECRET,
 *   tenantId, scopeId,
 *   provider: request.provider,
 *   createdBy: principal,                       // the principal whose check just passed
 *   subjectRef: request.subjectRef,
 *   returnUrl: `https://${host}/clients/${clientId}`,
 * });
 * return Response.redirect(url, 302);
 * ```
 *
 * The vertical never learns the provider's client credentials, the consent code, or the
 * token. It receives a link and forgets it. Everything that touches a credential happens
 * on the platform origin that owns the registered `redirect_uri`, and the connection is
 * stamped `createdBy` the principal named here — so the audit trail leads back to the
 * `ctx.check` above rather than to a platform actor (§3.5.1).
 *
 * ## What the platform decides, not you
 *
 * `PLATFORM_SECRET` is shared across every dispatch script, so it proves only that a
 * platform script is calling. Which VERTICAL the resulting connection lands on is
 * re-derived from the directory's record for `(tenantId, scopeId)`, and again at the
 * callback — naming someone else's scope does not borrow their vertical, it fails.
 * `returnUrl` is likewise checked against the hostname map: it must be a surface this
 * scope actually answers on, or the call is refused.
 */
export interface ConnectUrlRequest {
  /** The control plane's origin, injected into the vertical as `CONTROL_PLANE_URL`. */
  controlPlaneUrl: string;
  /** The `PLATFORM_SECRET` injected into this dispatch script. */
  platformSecret: string;
  /** This scope's tenant (ULID). */
  tenantId: string;
  /** This scope (ULID) — the connection's home, and what pins the vertical. */
  scopeId: string;
  /** Provider slug (`fortnox`). One with no platform consent round is refused, naming the paste door. */
  provider: string;
  /** The principal whose in-scope `ctx.check` authorized this round. */
  createdBy: string;
  /** Where the browser returns. Must be https on a hostname bound to this scope. */
  returnUrl?: string;
  /** Your own name for what is being connected — echoed back on the return, opaque to the platform. */
  subjectRef?: string;
  /** Seconds the URL stays openable; the platform clamps to 15 minutes. */
  ttlSeconds?: number;
  /** `fetch` seam for tests; defaults to the runtime's, bound (see `lint:bound-fetch`). */
  fetchImpl?: typeof fetch;
}

/** The relay refused, or could not be reached. Carries the status so a caller can map it. */
export class ConnectUrlRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'ConnectUrlRequestError';
  }
}

export async function requestConnectUrl(request: ConnectUrlRequest): Promise<ConnectUrlRelayResult> {
  const fetchImpl = request.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const base = request.controlPlaneUrl.replace(/\/+$/, '');
  const res = await fetchImpl(`${base}/internal/connections/connect-url`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      [PLATFORM_SECRET_HEADER]: request.platformSecret,
    },
    body: JSON.stringify({
      tenantId: request.tenantId,
      scopeId: request.scopeId,
      provider: request.provider,
      createdBy: request.createdBy,
      ...(request.returnUrl ? { returnUrl: request.returnUrl } : {}),
      ...(request.subjectRef ? { subjectRef: request.subjectRef } : {}),
      ...(request.ttlSeconds ? { ttlSeconds: request.ttlSeconds } : {}),
    }),
  });
  const body = (await res.json().catch(() => ({}))) as Partial<ConnectUrlRelayResult> & { error?: string };
  if (!res.ok || !body.url) {
    throw new ConnectUrlRequestError(
      `the platform refused to start a ${request.provider} consent round (${res.status}): ${body.error ?? 'unknown error'}`,
      res.status,
    );
  }
  return body as ConnectUrlRelayResult;
}
