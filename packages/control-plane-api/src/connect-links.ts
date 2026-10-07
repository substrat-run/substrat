import { isPrimaryScope, signConnectState, type ScopeHost } from '@substrat-run/kernel';
import {
  CONNECT_LINK_DEFAULT_TTL_SECONDS,
  connectLinkListRelayRequest,
  connectLinkRelayRequest,
  connectLinkRevokeRelayRequest,
  type ConnectLink,
  type ConnectLinkListRelayResult,
  type ConnectLinkRelayResult,
  type ConnectLinkRevokeRelayResult,
  type ConnectLinkView,
  type PlatformActorId,
  type ScopeId,
  type TenantId,
  type z,
} from '@substrat-run/contracts';
import { PREVIEW_CONNECTIONS_REFUSAL } from './connection-relay.js';
import { assertReturnUrlBelongsToScope, ConnectUrlRelayError, type ConnectUrlRelayOptions } from './connect-url.js';

/**
 * The connect-LINK relays (connections.md §3.5.4) — `/internal/connections/connect-links`,
 * `…/list` and `…/revoke`, kept out of the worker so they run against a real adapter.
 *
 * §3.5.3's connect URL serves the bureau's own staff, who click it within minutes. It does
 * not serve the other half of the same job: the person who must APPROVE at Fortnox is the
 * client company's administrator, not the bureau, and the bureau mails them a link they open
 * days later. A week-long signature nobody can withdraw or spend would be a replayable
 * consent round sitting in an inbox — so the mailed link is a directory row
 * (`_substrat_connect_links`), and the signed state names it. The callback consumes the row
 * before it stores anything, so the link is single-use, and revoking the row kills the URL.
 *
 * Trust posture is the connect URL's, unchanged: PLATFORM_SECRET proves only that a platform
 * script is calling, the VERTICAL is re-derived from this directory's record, previews and
 * forks are refused (#2005), and the return URL must be a hostname bound to the scope. The
 * list and the revoke are confined to the named scope by the store's own key — a link of
 * another scope reads as absent — and both take the link ids the caller names, never a
 * browse of the scope: reading or withdrawing a link takes the id its mint answered.
 * Errors are `ConnectUrlRelayError`: the same statuses, the same worker mapping.
 */

/** A link as its vertical may see it — never the tenant, scope or return URL echoed back. */
export const connectLinkViewOf = (link: ConnectLink): ConnectLinkView => ({
  id: link.id,
  provider: link.provider,
  status: link.status,
  createdBy: link.createdBy,
  subjectRef: link.subjectRef,
  createdAt: link.createdAt,
  expiresAt: link.expiresAt,
  usedAt: link.usedAt,
  accountRef: link.accountRef,
  accountLabel: link.accountLabel,
});

function parseOr400<S extends z.ZodTypeAny>(schema: S, body: unknown, what: string): z.infer<S> {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new ConnectUrlRelayError(
      `invalid ${what} request: ${first ? `${first.path.join('.') || '(root)'} — ${first.message}` : 'malformed body'}`,
      400,
    );
  }
  return parsed.data;
}

/** The scope's vertical, from THIS directory — and a refusal for a scope that is not a primary. */
async function verticalOfPrimaryScope(
  host: ScopeHost,
  actor: PlatformActorId,
  tenantId: TenantId,
  scopeId: ScopeId,
): Promise<string> {
  const rec = await host.admin.getScopeRecord(actor, tenantId, scopeId);
  if (!rec?.vertical) throw new ConnectUrlRelayError('scope has no vertical bound', 404);
  // #2005: a preview or a fork has no connections of its own to start a round for, and
  // nothing it minted could land anywhere — the store refuses its writes too.
  if (!isPrimaryScope(rec)) throw new ConnectUrlRelayError(PREVIEW_CONNECTIONS_REFUSAL, 403);
  return rec.vertical;
}

export async function relayConnectLinkMint(
  host: ScopeHost,
  actor: PlatformActorId,
  body: unknown,
  options: ConnectUrlRelayOptions,
): Promise<ConnectLinkRelayResult> {
  const input = parseOr400(connectLinkRelayRequest, body, 'connect-link');

  // Knowable at boot, so answered before the directory is read — a deployment that cannot
  // run a round says so, rather than writing a row whose URL dead-ends (#603).
  if (!options.connectOrigin) {
    throw new ConnectUrlRelayError(
      'provider consent rounds are not configured on this deployment: no connect origin ' +
        '(PLATFORM_CONNECT_URL unset on the control plane)',
      503,
    );
  }
  if (!options.platformSecret) {
    throw new ConnectUrlRelayError(
      'provider consent rounds are not configured on this deployment: PLATFORM_SECRET is unset, ' +
        'so no state can be signed',
      503,
    );
  }
  const flow = options.flows[input.provider];
  if (!flow) {
    throw new ConnectUrlRelayError(
      `provider '${input.provider}' has no platform-hosted consent round — its credential is ` +
        'pasted through /internal/connections/upsert instead',
      404,
    );
  }

  const vertical = await verticalOfPrimaryScope(host, actor, input.tenantId, input.scopeId);
  if (input.returnUrl) {
    await assertReturnUrlBelongsToScope(host, actor, {
      tenantId: input.tenantId,
      scopeId: input.scopeId,
      returnUrl: input.returnUrl,
    });
  }

  const link = await host.admin.mintConnectLink(actor, {
    tenantId: input.tenantId,
    scopeId: input.scopeId,
    vertical,
    provider: input.provider,
    createdBy: input.createdBy,
    ...(input.subjectRef ? { subjectRef: input.subjectRef } : {}),
    ...(input.returnUrl ? { returnUrl: input.returnUrl } : {}),
    expiresAt: new Date(Date.now() + (input.ttlSeconds ?? CONNECT_LINK_DEFAULT_TTL_SECONDS) * 1000).toISOString(),
  });
  // The signature's life is the row's: past it the token is dead on its own, and before it
  // the row is what can still say no.
  const token = await signConnectState(options.platformSecret, {
    tenantId: input.tenantId,
    scopeId: input.scopeId,
    vertical,
    provider: input.provider,
    principal: input.createdBy,
    ...(input.returnUrl ? { returnUrl: input.returnUrl } : {}),
    ...(input.subjectRef ? { subjectRef: input.subjectRef } : {}),
    linkId: link.id,
    exp: Date.parse(link.expiresAt),
  });

  const url = new URL(flow.startPath, options.connectOrigin.replace(/\/+$/, '') + '/');
  url.searchParams.set('token', token);
  return { url: url.toString(), link: connectLinkViewOf(link), vertical };
}

export async function relayConnectLinkList(
  host: ScopeHost,
  actor: PlatformActorId,
  body: unknown,
): Promise<ConnectLinkListRelayResult> {
  const input = parseOr400(connectLinkListRelayRequest, body, 'connect-link list');
  await verticalOfPrimaryScope(host, actor, input.tenantId, input.scopeId);
  // A capability read: only the links the caller names, by the ids its own mints answered.
  // Every pushed vertical holds the same shared platform-call credential, so nothing binds
  // the caller to the (tenant, scope) it names — a platform-wide gap, not this relay's to
  // close. A browse would hand any vertical that learned another tenant's two ids that
  // tenant's whole list (company names, subject refs, principals); a link id is a ULID only
  // the mint's answer carries, so reading a link takes holding its id.
  const links = await host.admin.listConnectLinks(actor, {
    tenantId: input.tenantId,
    scopeId: input.scopeId,
    ids: input.linkIds,
    ...(input.provider ? { provider: input.provider } : {}),
    ...(input.outstanding ? { outstandingOnly: true } : {}),
  });
  return { links: links.map(connectLinkViewOf) };
}

export async function relayConnectLinkRevoke(
  host: ScopeHost,
  actor: PlatformActorId,
  body: unknown,
): Promise<ConnectLinkRevokeRelayResult> {
  const input = parseOr400(connectLinkRevokeRelayRequest, body, 'connect-link revoke');
  await verticalOfPrimaryScope(host, actor, input.tenantId, input.scopeId);
  const link = await host.admin.revokeConnectLink(actor, {
    tenantId: input.tenantId,
    scopeId: input.scopeId,
    id: input.linkId,
  });
  if (!link) throw new ConnectUrlRelayError('unknown connect link', 404);
  return { link: connectLinkViewOf(link) };
}
