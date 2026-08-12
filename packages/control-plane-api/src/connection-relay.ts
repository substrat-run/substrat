import { ulid, type ScopeHost } from '@substrat-run/kernel';
import {
  connectionId,
  connectionRelayRequest,
  type ConnectionProbe,
  type ConnectionRelayResult,
  type PlatformActorId,
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
    readonly status: 400 | 404 | 409 | 422 | 503,
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
) => Promise<ConnectionProbe | undefined>;

export async function relayConnectionUpsert(
  host: ScopeHost,
  actor: PlatformActorId,
  body: unknown,
  options: { probeCandidate?: ConnectionCandidateProbe } = {},
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
  const vertical = rec.vertical;

  // Ask the provider before touching the store (#605). Deliberately here, ahead of every
  // write below: a refused rotation must leave the live credential exactly as it was.
  const probe = await options.probeCandidate?.(input.provider, input.secret);
  if (probe && !probe.ok && probe.refused) {
    throw new ConnectionRelayError(
      probe.error ?? `${input.provider} refused these credentials`,
      422,
      probe,
    );
  }

  // `listConnections` already excludes revoked rows; expired/errored rows are still the
  // live row for this key — rotation is what revives them. The account leg matches
  // exactly (absent matches absent): a multi-account provider's second account is a new
  // connection, not a rotation of the first.
  const live = (
    await host.admin.listConnections(actor, {
      tenantId: input.tenantId,
      vertical,
      provider: input.provider,
    })
  ).filter((c) => c.externalAccountRef === (input.externalAccountRef ?? null));

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
      expiresAt: input.expiresAt,
      secret: input.secret,
      // §3.5.1 — the authorizing tenant principal, proven by the vertical's own
      // `ctx.check` before the secret ever left the operation.
      createdBy: input.createdBy,
    });
    created = true;
  } else if (live.length === 1) {
    id = live[0]!.id;
    await host.admin.updateConnectionSecret(actor, id, input.secret, input.expiresAt, {
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

  for (const permission of input.grants) {
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

  return { connectionId: id, created, granted: input.grants, ...(probe ? { probe } : {}) };
}
