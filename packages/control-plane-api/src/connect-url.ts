import { signConnectState, type ScopeHost } from '@substrat-run/kernel';
import {
  connectUrlRelayRequest,
  instant,
  type ConnectUrlRelayResult,
  type PlatformActorId,
  type ScopeId,
  type TenantId,
} from '@substrat-run/contracts';

/**
 * The connect-url relay (connections.md §3.5.3) — the OAuth half of §3.5.2's credential
 * relay. This module is `/internal/connections/connect-url`'s logic, kept out of the
 * worker so it can be exercised against a real adapter.
 *
 * A bookkeeping bureau's staff work inside the VERTICAL. They have no dashboard account,
 * they connect a new client company most weeks, and each one is its own Fortnox consent
 * round. The credential relay cannot serve them — there is no credential to paste until
 * the round has already happened — and the dashboard's connect link cannot either,
 * because minting one requires the dashboard session they do not have. So the round has
 * to be startable from where the work is, while everything that touches a credential
 * stays where it already is.
 *
 * What this returns is a URL. Not a token the vertical could spend, not a client id, not
 * a capability: the consent starts and ends on the platform's own origin — the one
 * `redirect_uri` registered with the provider — and the vertical's part is over the
 * moment it redirects its user. The authority behind the round is the `ctx.check` the
 * vertical's operation ran before calling, carried as `principal` in the signed state and
 * stamped on the connection as `createdBy` (§3.5.1).
 */
export class ConnectUrlRelayError extends Error {
  constructor(
    message: string,
    /** `503` when the DEPLOYMENT cannot run a round at all, the same distinction #603 drew. */
    readonly status: 400 | 404 | 503,
  ) {
    super(message);
    this.name = 'ConnectUrlRelayError';
  }
}

/** Where a provider's platform-hosted consent round begins. */
export interface ConnectFlowSpec {
  /**
   * Absolute path on {@link ConnectUrlRelayOptions.connectOrigin} that starts the round
   * — e.g. `/api/integrations/fortnox/connect`. It takes the signed state as `?token=`
   * and redirects to the provider.
   */
  readonly startPath: string;
}

export interface ConnectUrlRelayOptions {
  /**
   * The origin hosting the consent round and the provider's registered `redirect_uri`
   * (`https://app.substrat.net`). A deployment fact, not a caller's choice: the whole
   * point is that every vertical's round lands on the ONE callback the provider knows.
   */
  connectOrigin?: string;
  /** The providers this deployment can run a round for. A provider absent here is a 404. */
  flows: Readonly<Record<string, ConnectFlowSpec | undefined>>;
  /** This deployment's `PLATFORM_SECRET` — the state's signing key (via HKDF). */
  platformSecret?: string;
}

/** 15 minutes. The clamp is in the schema; this is the default when none is asked for. */
const DEFAULT_TTL_SECONDS = 900;

/**
 * Is `returnUrl` somewhere this scope actually answers?
 *
 * The check exists because the return lands on the PLATFORM's origin first: an
 * unvalidated `returnUrl` would make `app.substrat.net` — the origin holding the
 * dashboard's session cookie — redirect anywhere a caller named. The hostname map is the
 * right authority for it (K-26): it is what the router resolves against, so "a hostname
 * bound to this scope" and "a hostname this scope can be reached on" are the same
 * sentence.
 *
 * `https` only, and no credentials in the URL. A `pending` binding counts: a domain
 * mid-issuance is still this tenant's, and refusing would make the connect flow depend on
 * certificate timing rather than on ownership.
 */
async function assertReturnUrlBelongsToScope(
  host: ScopeHost,
  actor: PlatformActorId,
  input: { tenantId: TenantId; scopeId: ScopeId; returnUrl: string },
): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(input.returnUrl);
  } catch {
    throw new ConnectUrlRelayError('returnUrl is not a URL', 400);
  }
  if (parsed.protocol !== 'https:') {
    throw new ConnectUrlRelayError('returnUrl must be https', 400);
  }
  if (parsed.username || parsed.password) {
    throw new ConnectUrlRelayError('returnUrl must not carry credentials', 400);
  }
  const bindings = await host.admin.listHostnames(actor, {
    tenantId: input.tenantId,
    scopeId: input.scopeId,
  });
  const bound = bindings.some((b) => b.hostname.toLowerCase() === parsed.hostname.toLowerCase());
  if (!bound) {
    throw new ConnectUrlRelayError(
      `returnUrl host '${parsed.hostname}' is not a hostname bound to this scope` +
        ' — the consent can only return to a surface this scope answers on',
      400,
    );
  }
}

export async function relayConnectUrl(
  host: ScopeHost,
  actor: PlatformActorId,
  body: unknown,
  options: ConnectUrlRelayOptions,
): Promise<ConnectUrlRelayResult> {
  const parsed = connectUrlRelayRequest.safeParse(body);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new ConnectUrlRelayError(
      `invalid connect-url request: ${first ? `${first.path.join('.') || '(root)'} — ${first.message}` : 'malformed body'}`,
      400,
    );
  }
  const input = parsed.data;

  // Answered before anything else, and before the directory is read: both are knowable at
  // boot, so a deployment that cannot run a round says so as a typed 503 naming what is
  // missing, rather than minting a URL that dead-ends on a consent screen (#603).
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

  // The vertical comes from THIS directory's record, never from the caller — the same law
  // the credential relay states, and the callback applies it a second time to the scope in
  // the signed state, so neither hop trusts the other's word for it.
  const rec = await host.admin.getScopeRecord(actor, input.tenantId, input.scopeId);
  if (!rec?.vertical) {
    throw new ConnectUrlRelayError('scope has no vertical bound', 404);
  }

  if (input.returnUrl) {
    await assertReturnUrlBelongsToScope(host, actor, {
      tenantId: input.tenantId,
      scopeId: input.scopeId,
      returnUrl: input.returnUrl,
    });
  }

  const expiresAtMs = Date.now() + (input.ttlSeconds ?? DEFAULT_TTL_SECONDS) * 1000;
  const token = await signConnectState(options.platformSecret, {
    tenantId: input.tenantId,
    scopeId: input.scopeId,
    vertical: rec.vertical,
    provider: input.provider,
    principal: input.createdBy,
    ...(input.returnUrl ? { returnUrl: input.returnUrl } : {}),
    ...(input.subjectRef ? { subjectRef: input.subjectRef } : {}),
    exp: expiresAtMs,
  });

  const url = new URL(flow.startPath, options.connectOrigin.replace(/\/+$/, '') + '/');
  url.searchParams.set('token', token);
  return {
    url: url.toString(),
    expiresAt: instant.parse(new Date(expiresAtMs).toISOString()),
    vertical: rec.vertical,
  };
}
