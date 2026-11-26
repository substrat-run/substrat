import type { ConnectionLandingOptionsInput, ScopeHost } from '@substrat-run/kernel';
import { scopeId as scopeIdSchema, z, type ConnectionProbe, type PlatformActorId, type TenantId } from '@substrat-run/contracts';
import { verifyConnectState } from './connect-state.js';
import { heldScopeBinding, relayConnectionBind } from './connection-binding-relay.js';
import { ConnectionRelayError, relayConnectionUpsert } from './connection-relay.js';

/**
 * The end of a consent round a vertical asked for as a scope's OWN connection (#3410):
 * `POST /tenants/:tenantId/connections/consented`.
 *
 * A tenant runs several stores, each its own scope, and each keeps its own books in its own
 * Fortnox company. The vertical starts the round from a store (`/internal/connections/connect-url`
 * with `owner: 'scope'`), where its worker is proven to be that store; the round's callback runs on
 * the platform's connect origin, which holds the provider's one `redirect_uri`, and ends here.
 *
 * The tenant's upsert route is always the tenant's, because a scope's own connection is made only
 * by that scope. Here the scope's request is the signed state its proven worker obtained: this plane
 * minted it and verifies it again, so the worker holding the callback relays the proof rather than
 * supplying it. The tenant must be the path's, and the scope, provider and principal are the
 * claim's, never the body's. The body carries only what the round produced: the credential, its
 * company and a label.
 *
 * The round then binds the connection to that scope alone, through the `on-request` landing its
 * running version declares, because the vertical never learns the connection's id to bind it
 * itself. The two steps are not one transaction: a bind refused after the store leaves the scope's
 * own connection stored and unbound, answered as `bound: null` with the reason. After a passing
 * refusal, the next round for the same company from the same scope rotates that connection and binds
 * it; a version that no longer lands the provider on request refuses the next round at mint too.
 */
export const consentedConnectionRequest = z.object({
  /** The round's signed state, as the provider handed it back. */
  state: z.string().min(1).max(8192),
  label: z.string().min(1).max(200).optional(),
  /** The account the round consented, which keys the connection (Fortnox's DatabaseNumber). */
  externalAccountRef: z.string().min(1).max(200).optional(),
  secret: z.record(z.string(), z.string()),
});

export interface ConsentedConnectionResult {
  connectionId: string;
  created: boolean;
  granted: string[];
  probe?: ConnectionProbe;
  /** The scope the connection is the own connection of: the claim's. */
  scopeId: string;
  /**
   * The scope's binding to the connection after the round: the one it made, or, when the bind was
   * refused (`bindRefusal`), the one the scope already held, which a refused re-bind leaves syncing.
   * Null only when the scope holds none.
   */
  bound: { scopeId: string; options: Record<string, unknown> } | null;
  bindRefusal?: string;
}

export interface ConsentedConnectionOptions {
  /** The platform secret the state was signed under. Absent: 503, nothing verified. */
  platformSecret?: string;
  /** The connector pass's reader and binders, so the round binds as the pass and the bind relay do. */
  landings?: ConnectionLandingOptionsInput;
  /** Whether a provider's connector opens a scope's own connection. */
  scopeOwnable: (provider: string) => boolean;
  /** The upsert relay's own seams, as the tenant's route hands them. */
  upsert?: Pick<NonNullable<Parameters<typeof relayConnectionUpsert>[3]>, 'probeCandidate' | 'prepareCandidate' | 'accountFromProbe' | 'onUpserted'>;
  now?: () => number;
}

/** One refusal for every way a state is not a scope's own round for this tenant. */
export const NOT_A_SCOPE_ROUND = "not a consent round this platform started for a scope's own connection";

export async function relayConsentedConnection(
  host: ScopeHost,
  actor: PlatformActorId,
  tenantId: TenantId,
  body: unknown,
  options: ConsentedConnectionOptions,
): Promise<ConsentedConnectionResult> {
  const parsed = consentedConnectionRequest.safeParse(body);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new ConnectionRelayError(
      `invalid consented connection: ${first ? `${first.path.join('.') || '(root)'} — ${first.message}` : 'malformed body'}`,
      400,
    );
  }
  const input = parsed.data;
  if (!options.platformSecret) {
    throw new ConnectionRelayError('consent rounds are not configured on this deployment: no platform secret to verify a round with', 503);
  }
  const landings = options.landings;
  if (!landings) throw new ConnectionRelayError("this deployment is not configured for a scope's own connections", 503);

  // A forgery, an expired round, a tenant's round and another tenant's round all read alike: an
  // oracle telling them apart is worth nothing to a caller.
  const claim = await verifyConnectState(options.platformSecret, input.state, options.now?.() ?? Date.now());
  if (!claim || claim.tenantId !== tenantId || claim.owner !== 'scope') throw new ConnectionRelayError(NOT_A_SCOPE_ROUND, 403);
  const scope = scopeIdSchema.parse(claim.scopeId);

  // The upsert relay judges the scope again as it stands now — primary, of a vertical, its running
  // version landing the provider on request — however old the round. The signed state is the proof
  // of the caller: it was minted only for one proven to be this scope.
  const stored = await relayConnectionUpsert(
    host,
    actor,
    {
      tenantId,
      scopeId: scope,
      provider: claim.provider,
      ...(input.label ? { label: input.label } : {}),
      ...(input.externalAccountRef ? { externalAccountRef: input.externalAccountRef } : {}),
      secret: input.secret,
      grants: [],
      createdBy: claim.principal,
      owner: 'scope',
    },
    {
      ...options.upsert,
      scopeOwned: { proven: true, scopeOwnable: options.scopeOwnable, readLandings: landings.read },
    },
  );

  try {
    const result = await relayConnectionBind(
      host,
      actor,
      { tenantId, scopeId: scope, connectionId: stored.connectionId, boundBy: claim.principal },
      { proven: true, landings },
    );
    return { ...stored, scopeId: scope, bound: { scopeId: result.scopeId, options: result.options } };
  } catch (err) {
    if (!(err instanceof ConnectionRelayError) || err.status >= 500) throw err;
    // A refused bind writes nothing: a re-consent's earlier binding stays and keeps syncing, so the
    // answer reports it rather than calling the scope unbound.
    const held = await heldScopeBinding(host, actor, { tenantId, scopeId: scope, connectionId: stored.connectionId }, landings);
    return { ...stored, scopeId: scope, bound: held, bindRefusal: err.message };
  }
}
