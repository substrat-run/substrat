import { PLATFORM_SECRET_HEADER } from '@substrat-run/contracts';
import type {
  ConnectLinkListRelayResult,
  ConnectLinkRelayResult,
  ConnectLinkRevokeRelayResult,
} from '@substrat-run/contracts';

/**
 * Mint a SHAREABLE provider connect link from a VERTICAL (connections.md §3.5.4) — and read
 * and revoke the ones this scope minted, by the ids the mints returned.
 *
 * `requestConnectUrl` serves the person sitting in front of the vertical: they click the URL
 * within minutes, so it lives fifteen and has no row. It does not serve the other half of a
 * bookkeeping bureau's job, which is getting the CLIENT company's Fortnox administrator to
 * approve. The bureau mails that person a link they open days later, from an inbox, with no
 * account anywhere. That link is a platform-held row: single-use (the platform's callback
 * spends it before storing the credential), revocable (`revokeConnectLink` kills the URL),
 * and expiring (seven days unless asked, thirty at most).
 *
 * ## Where the permission check goes
 *
 * The same split as `requestConnectUrl` — the operation decides, the harness effects. Module
 * code cannot `fetch` (boundary-lint R3), and a link is an outbound call made on authority
 * the scope already granted:
 *
 * ```ts
 * // module.ts — the authorizing act, and the only place a permission is checked
 * const inviteClientBooks: OperationHandler<{ clientId: string }, ConnectRequest> = async (ctx, raw) => {
 *   assertAllowed(await ctx.check(PERM.manageIntegrations));
 *   const input = schema.parse(raw);
 *   const client = ctx.sql.query('SELECT id FROM clients WHERE id = ?', [input.clientId])[0];
 *   if (!client) throw new NotFound(...);
 *   return { provider: 'fortnox', subjectRef: client.id };
 * };
 *
 * // server.ts — the effect
 * const request = await scope.invoke('crm/invite-client-books', { clientId });
 * const { url, link } = await mintConnectLink({
 *   controlPlaneUrl: env.CONTROL_PLANE_URL,
 *   platformSecret: env.PLATFORM_SECRET,
 *   tenantId, scopeId,
 *   provider: request.provider,
 *   createdBy: principal,                       // the principal whose check just passed
 *   subjectRef: request.subjectRef,             // shown on the list, echoed on the return
 * });
 * await mail(client.fortnoxAdminEmail, url);    // send it; keep `link.id`, not the URL
 * await scope.invoke('crm/record-books-link', { clientId, linkId: link.id });
 * ```
 *
 * Keep the link id: store it on your own row beside the `subjectRef` it was minted for (the
 * client row, above). Listing and revoking both name links by that id — there is no "every
 * link this scope minted" read — and both are permission-checked acts too: an operation
 * that checks and returns the ids (`{ linkIds }` for a list, `{ linkId }` for a revoke),
 * then the harness calls `listConnectLinks` or `revokeConnectLink`.
 *
 * ## What the platform decides, not you
 *
 * As for `requestConnectUrl`: the vertical is re-derived from the directory's record for
 * `(tenantId, scopeId)`, a preview or a fork is refused, and `returnUrl` must be an https
 * surface bound to this scope. Leave `returnUrl` out for a link mailed to someone with no
 * account on your surface — without it, the round ends on the platform's own page, whose
 * copy sends the reader back to whoever sent the link. With it, success and every refusal
 * (`?error=link_used`, `link_revoked`, `link_expired`, `link_unknown`, or the round's own)
 * return there, carrying `link=<id>` and your `subjectRef`. List and revoke reach only this
 * scope's links: a list omits another scope's id exactly as an unknown one, and a revoke
 * answers both with a `404`.
 */
export interface ConnectLinkRelayAccess {
  /** The control plane's origin, injected into the vertical as `CONTROL_PLANE_URL`. */
  controlPlaneUrl: string;
  /** The `PLATFORM_SECRET` injected into this dispatch script. */
  platformSecret: string;
  /** This scope's tenant (ULID). */
  tenantId: string;
  /** This scope (ULID) — the link's home, and what pins the vertical. */
  scopeId: string;
  /** `fetch` seam for tests; defaults to the runtime's, bound (see `lint:bound-fetch`). */
  fetchImpl?: typeof fetch;
}

export interface ConnectLinkRequest extends ConnectLinkRelayAccess {
  /** Provider slug (`fortnox`). One with no platform consent round is refused, naming the paste door. */
  provider: string;
  /** The principal whose in-scope `ctx.check` authorized this link. */
  createdBy: string;
  /** Where the browser returns. Must be https on a hostname bound to this scope. */
  returnUrl?: string;
  /** Your own name for what is being connected — stored on the link, echoed on the return. */
  subjectRef?: string;
  /** Seconds the link stays openable. Default 7 days; more than 30 days is refused. */
  ttlSeconds?: number;
}

export interface ConnectLinkListRequest extends ConnectLinkRelayAccess {
  /** The links to read — ids your mints returned, 1 to 100. One not in this scope is omitted. */
  linkIds: readonly string[];
  provider?: string;
  /** Only the links that can still be opened. Omitted: every named link, newest first. */
  outstanding?: boolean;
}

export interface ConnectLinkRevokeRequest extends ConnectLinkRelayAccess {
  linkId: string;
}

/** The relay refused, or could not be reached. Carries the status so a caller can map it. */
export class ConnectLinkRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'ConnectLinkRequestError';
  }
}

async function relay<T>(
  access: ConnectLinkRelayAccess,
  path: string,
  body: Record<string, unknown>,
  ok: (body: Partial<T>) => boolean,
  what: string,
): Promise<T> {
  const fetchImpl = access.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const base = access.controlPlaneUrl.replace(/\/+$/, '');
  const res = await fetchImpl(`${base}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      [PLATFORM_SECRET_HEADER]: access.platformSecret,
    },
    body: JSON.stringify({ tenantId: access.tenantId, scopeId: access.scopeId, ...body }),
  });
  const answer = (await res.json().catch(() => ({}))) as Partial<T> & { error?: string };
  if (!res.ok || !ok(answer)) {
    throw new ConnectLinkRequestError(
      `the platform refused to ${what} (${res.status}): ${answer.error ?? 'unknown error'}`,
      res.status,
    );
  }
  return answer as T;
}

export function mintConnectLink(request: ConnectLinkRequest): Promise<ConnectLinkRelayResult> {
  return relay<ConnectLinkRelayResult>(
    request,
    '/internal/connections/connect-links',
    {
      provider: request.provider,
      createdBy: request.createdBy,
      ...(request.returnUrl ? { returnUrl: request.returnUrl } : {}),
      ...(request.subjectRef ? { subjectRef: request.subjectRef } : {}),
      ...(request.ttlSeconds ? { ttlSeconds: request.ttlSeconds } : {}),
    },
    (b) => typeof b.url === 'string' && !!b.link,
    `mint a ${request.provider} connect link`,
  );
}

export function listConnectLinks(request: ConnectLinkListRequest): Promise<ConnectLinkListRelayResult> {
  return relay<ConnectLinkListRelayResult>(
    request,
    '/internal/connections/connect-links/list',
    {
      linkIds: request.linkIds,
      ...(request.provider ? { provider: request.provider } : {}),
      ...(request.outstanding ? { outstanding: true } : {}),
    },
    (b) => Array.isArray(b.links),
    'list connect links',
  );
}

export function revokeConnectLink(request: ConnectLinkRevokeRequest): Promise<ConnectLinkRevokeRelayResult> {
  return relay<ConnectLinkRevokeRelayResult>(
    request,
    '/internal/connections/connect-links/revoke',
    { linkId: request.linkId },
    (b) => !!b.link,
    `revoke connect link ${request.linkId}`,
  );
}
