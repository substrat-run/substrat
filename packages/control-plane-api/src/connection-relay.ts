import { isPrimaryScope, onRequestLandingFor, ulid, type ConnectionLandingOptionsInput, type ScopeHost } from '@substrat-run/kernel';
import {
  instant,
  connectionId,
  connectionRelayRequest,
  isVerticalConnectorProvider,
  type ConnectionProbe,
  type ConnectionRelayResult,
  type PlatformActorId,
  type ScopeId,
  type TenantId,
  type VerticalConnectorDeclaration,
} from '@substrat-run/contracts';

/**
 * The connection relay (connections.md §3.5.2) — the credential half of #574's routed
 * connector dispatch. A hosted CP-less vertical's tenant admin holds a provider credential
 * (a Scrive OAuth1 token, a Fortnox key) and needs to hand it to the platform's connection
 * store from the vertical's OWN admin screen: the vertical permission-checks the act
 * (`ctx.check`) and its harness POSTs the secret to `/internal/connections/upsert`, the
 * same shape as the email relay (#303). This module is that endpoint's logic, kept out of
 * the worker so it can be exercised against a real adapter.
 *
 * Trust posture, identical to the email relay: the shared PLATFORM_SECRET only proves "a
 * platform script is calling" — WHICH vertical is re-derived from the platform's own scope
 * record for the named `(tenantId, scopeId)`, so a caller cannot plant a credential on a
 * foreign vertical, and `grantToConnection`'s own checks pin every grant inside the
 * connection's (tenant, vertical). What the relay adds over a platform-request intent is
 * the posture connections.md §3.4 demands: the plaintext lives for the length of this call
 * and is sealed by the host's `SecretBox` — it never rests in a scope row, an event, an
 * intent payload, or the audit log.
 *
 * Upsert keyed (tenant, vertical, provider, externalAccountRef): no live connection →
 * create under a fresh id; one live → rotate its secret in place, reviving an
 * expired/errored row. Rotation preserves the connection id, so every grant tuple keyed on
 * it survives — which is why rotation is never revoke + create. Grants are re-applied on
 * every upsert (tuples are idempotent), so a re-connect also heals a missing grant.
 */
export class ConnectionRelayError extends Error {
  constructor(
    message: string,
    /**
     * `503` is the odd one out and deliberately so (#603): 4xx says the request was
     * wrong, and this one was not — the DEPLOYMENT cannot store credentials. Answering
     * 500 (what an unrecognised throw collapses to) sent an operator looking for a bug
     * in the credential or the relay, when the plane knew at boot that it had no key.
     */
    readonly status: 400 | 403 | 404 | 409 | 422 | 501 | 503,
    /** The provider's own answer, when the refusal came from a pre-flight probe (#605). */
    readonly probe?: ConnectionProbe,
  ) {
    super(message);
    this.name = 'ConnectionRelayError';
  }
}

/**
 * Check a candidate credential against the provider BEFORE it is written (#605).
 *
 * The upsert used to mean "store it": the row landed, the console said Connected, and the
 * first evidence that the provider disagreed arrived on the next dispatch — after a
 * signature request had already failed. On a ROTATION it is worse than cosmetic, because
 * writing first replaces a working credential with a broken one.
 *
 * Only a definite refusal (the provider answering 401/403) blocks the write. An
 * unreachable provider does not: rejecting then would make an outage look like every
 * tenant's keys going bad, and would block the rotation someone is attempting *because*
 * things are broken. Unverifiable is stored, and reported as unverified.
 */
export type ConnectionCandidateProbe = (
  provider: string,
  secret: Record<string, string>,
  /** Who the credential is for, as this directory re-derived it: a vertical-defined provider's probe runs in that vertical. */
  context: ConnectionCandidateContext,
) => Promise<ConnectionProbe | undefined>;

/** The connection a candidate credential would become: its tenant, its vertical and the scope that asked. */
export interface ConnectionCandidateContext {
  tenantId: TenantId;
  vertical: string;
  scopeId: ScopeId | null;
}

/**
 * Finish a candidate credential on the platform side, before it is probed and stored (#2100).
 *
 * For a provider where part of the credential is the PLATFORM's to make: Microsoft 365 with a
 * certificate generates the keypair here, so the private key is created where it is sealed and
 * never travels through the caller. `previous` is the live connection's plaintext secret when
 * this upsert rotates one, so a provider can carry what must survive an edit (the keypair whose
 * certificate the tenant already uploaded).
 *
 * `expiresAt`: a date lands on the connection, `null` clears the one it holds (the credential
 * that had it is gone), and absent leaves it as it is.
 */
export type ConnectionCandidatePrepare = (
  candidate: Record<string, string>,
  previous: Record<string, string> | undefined,
) => Promise<{ secret: Record<string, string>; expiresAt?: string | null }>;

/**
 * The provider's {@link ConnectionCandidatePrepare}, or `undefined` when it has none. A lookup
 * rather than a call, so the relay opens the live credential only for a provider that will read
 * it: a provider with no preparation must rotate even when the old secret no longer opens (a
 * sealing key the deployment no longer holds), which is the case a rotation exists to repair.
 */
export type ConnectionCandidatePreparer = (provider: string) => ConnectionCandidatePrepare | undefined;

/**
 * The declaration a vertical-defined provider's connection is held to (vertical-connectors.md
 * §7.2): the one its vertical's SERVING version declares (the version a connection-level call and
 * a candidate probe run), or why there is none. Its `grants` are the connection's standing grants,
 * whatever the caller asks for.
 */
export type VerticalConnectorDeclarationOf = (
  provider: string,
  context: { tenantId: TenantId; vertical: string },
) => Promise<{ declaration: Pick<VerticalConnectorDeclaration, 'grants'> } | { refused: string }>;

/** What a preview or a fork is told when it asks to change a connection (#2005). */
export const PREVIEW_CONNECTIONS_REFUSAL =
  "previews and forks cannot change a tenant's connections: this scope is a preview or a fork";

/**
 * #2732: what a scope's own connection, its bind and its unbind answer a call whose caller was not
 * established as the scope it names: they must be made from the vertical's worker, on the request
 * it is serving.
 */
export const PROVEN_CALLER_REFUSAL =
  "a scope's own connection is changed only by that scope: make this call from the vertical's worker, on the request it is serving";

export async function relayConnectionUpsert(
  host: ScopeHost,
  actor: PlatformActorId,
  body: unknown,
  options: {
    probeCandidate?: ConnectionCandidateProbe;
    prepareCandidate?: ConnectionCandidatePreparer;
    /** Required for a dotted provider: a host without it refuses one. */
    declarationOf?: VerticalConnectorDeclarationOf;
    /**
     * #2732: what an `owner: 'scope'` upsert is held to; a host without them refuses one. `proven`
     * is whether the call's caller was established as the scope it names. `scopeOwnable` says a
     * provider's connector opens a scope's own connection. `readLandings` reads a version's
     * declared landings, as the connector pass does.
     */
    scopeOwned?: {
      proven: boolean;
      scopeOwnable: (provider: string) => boolean;
      readLandings: ConnectionLandingOptionsInput['read'];
    };
  } = {},
): Promise<ConnectionRelayResult> {
  const parsed = connectionRelayRequest.safeParse(body);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new ConnectionRelayError(
      `invalid connection relay request: ${first ? `${first.path.join('.') || '(root)'} — ${first.message}` : 'malformed body'}`,
      400,
    );
  }
  const input = parsed.data;

  // Can this deployment keep a credential at all? (#603) Knowable at boot, so it is
  // answered before anything else happens — ahead of the probe in particular, which
  // would otherwise hand the plaintext to the provider over a real outbound call only
  // to fail at the write. The store refuses too (`SecretBoxUnconfiguredError`, fail
  // closed); asking first is what makes the refusal a typed 503 naming the missing key
  // instead of a bare 500 an operator can only diagnose from a worker tail.
  if (!host.admin.canStoreSecrets) {
    throw new ConnectionRelayError(
      'connection storage is not configured on this deployment: no SecretBox ' +
        '(SECRET_BOX_KEY unset on the control plane) — nothing was stored, and the ' +
        'credential was not sent to the provider.',
      503,
    );
  }

  // The vertical comes from THIS directory's record, never from the caller.
  const rec = await host.admin.getScopeRecord(actor, input.tenantId, input.scopeId);
  if (!rec?.vertical) {
    throw new ConnectionRelayError('scope has no vertical bound', 404);
  }
  // #2005: a connection is the TENANT's, keyed on (tenant, vertical, provider), so a preview
  // or a fork shares it with the install. Refused before the probe and the store, on every
  // path in — this relay, the dashboard's door, and a consent round's callback, which lands
  // here and so is judged against the scope's record at write time, however old the round.
  if (!isPrimaryScope(rec)) {
    throw new ConnectionRelayError(PREVIEW_CONNECTIONS_REFUSAL, 403);
  }
  const vertical = rec.vertical;

  // #2732: a scope's own connection is for a provider its running version lands on request, and one
  // whose connector opens a scope's own connection; refused before the probe and the store.
  const owner = input.owner === 'scope' ? input.scopeId : null;
  if (owner) {
    const held = options.scopeOwned;
    if (!held) throw new ConnectionRelayError("this deployment is not configured for a scope's own connections", 503);
    if (!held.proven) throw new ConnectionRelayError(PROVEN_CALLER_REFUSAL, 403);
    if (!held.scopeOwnable(input.provider)) {
      throw new ConnectionRelayError(`'${input.provider}' connections are the tenant's: its connector does not open a scope's own`, 409);
    }
    const declared = await onRequestLandingFor(host.admin, actor, held.readLandings, rec, input.provider);
    if ('refused' in declared) throw new ConnectionRelayError(declared.refused, 409);
  }

  // A vertical-defined provider's standing grants are what its vertical's serving version declares,
  // never what the caller sends (a dashboard door reads the latest push, which may not serve yet).
  // Refused before the probe and the store when that version declares no such connector.
  let grants = input.grants;
  if (isVerticalConnectorProvider(input.provider)) {
    if (!options.declarationOf) {
      throw new ConnectionRelayError(`'${input.provider}' is a vertical-defined provider, and this deployment is not configured to run one`, 503);
    }
    const found = await options.declarationOf(input.provider, { tenantId: input.tenantId, vertical });
    if ('refused' in found) throw new ConnectionRelayError(found.refused, 409);
    grants = found.declaration.grants;
  }

  // `listConnections` already excludes revoked rows; expired/errored rows are still the
  // live row for this key — rotation is what revives them. The account leg matches
  // exactly (absent matches absent): a multi-account provider's second account is a new
  // connection, not a rotation of the first. Read before the probe because a provider that
  // finishes its own credential (#2100) needs the one this upsert would replace. The owner is
  // part of the key (#2732), so a scope rotates only its own and a tenant upsert only the tenant's.
  const live = (
    await host.admin.listConnections(actor, {
      tenantId: input.tenantId,
      vertical,
      provider: input.provider,
      ownerScopeId: owner,
    })
  ).filter((c) => c.externalAccountRef === (input.externalAccountRef ?? null));

  // #2100: the platform's half of the credential, made here — before the probe, so what is
  // probed is exactly what is stored.
  let secret = input.secret;
  let expiresAt: string | null | undefined = input.expiresAt;
  const prepare = options.prepareCandidate?.(input.provider);
  if (prepare) {
    const previous =
      live.length === 1
        ? (await host.admin.openConnection(input.tenantId, vertical, input.provider, input.externalAccountRef, owner ?? undefined))?.secret
        : undefined;
    const prepared = await prepare(input.secret, previous);
    secret = prepared.secret;
    // Parsed: a provider's date becomes the same branded instant a caller's would be. `null` is
    // the provider clearing an expiry whose credential it dropped (a certificate → a client secret).
    expiresAt =
      input.expiresAt ??
      (prepared.expiresAt === undefined || prepared.expiresAt === null ? prepared.expiresAt : instant.parse(prepared.expiresAt));
  }

  // Ask the provider before touching the store (#605). Deliberately here, ahead of every
  // write below: a refused rotation must leave the live credential exactly as it was.
  const probe = await options.probeCandidate?.(input.provider, secret, { tenantId: input.tenantId, vertical, scopeId: input.scopeId });
  if (probe && !probe.ok && probe.refused) {
    throw new ConnectionRelayError(
      probe.error ?? `${input.provider} refused these credentials`,
      422,
      probe,
    );
  }

  let id;
  let created;
  if (live.length === 0) {
    id = connectionId.parse(ulid());
    await host.admin.createConnection(actor, {
      id,
      tenantId: input.tenantId,
      vertical,
      provider: input.provider,
      label: input.label ?? input.provider,
      externalAccountRef: input.externalAccountRef,
      scopes: input.scopes,
      // Whatever the caller supplies, else what the provider's own preparation knows (#2100: a
      // generated certificate's end). Undefined reads "not reported" (connections.md §3.6).
      expiresAt: expiresAt ?? undefined,
      secret,
      // §3.5.1 — the authorizing tenant principal, proven by the vertical's own
      // `ctx.check` before the secret ever left the operation.
      createdBy: input.createdBy,
      ...(owner ? { ownerScopeId: owner } : {}),
    });
    created = true;
  } else if (live.length === 1) {
    id = live[0]!.id;
    await host.admin.updateConnectionSecret(actor, id, secret, expiresAt, {
      rotatedBy: input.createdBy,
    });
    created = false;
  } else {
    // Several live connections under one key can only mean distinct external accounts
    // created before this caller started naming them — refusing beats rotating one
    // arbitrarily (the same law as `openConnection`'s multi-account throw).
    throw new ConnectionRelayError(
      `tenant holds ${live.length} live '${input.provider}' connections for vertical '${vertical}' — name externalAccountRef to pick one`,
      409,
    );
  }

  for (const permission of grants) {
    await host.admin.grantToConnection(actor, {
      connectionId: id,
      permission,
      node: { tenantId: input.tenantId, scopeId: input.scopeId },
      grantedBy: actor,
    });
  }

  // The pre-flight was a real, successful call with this exact credential — moments before
  // the row existed. Recording it as health is what stops a just-verified connection from
  // reading "connected, not used yet", which is the same "a row exists" claim the probe was
  // added to replace. A refusal never reaches here (it threw above), and an unreachable
  // provider records nothing: unverified must not look like failed.
  if (probe?.ok) await host.admin.recordConnectionUse(id, { ok: true });

  return { connectionId: id, created, granted: grants, ...(probe ? { probe } : {}) };
}
