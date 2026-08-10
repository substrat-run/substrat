import { ulid, type ScopeHost } from '@substrat-run/kernel';
import {
  connectionId,
  connectionRelayRequest,
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
    readonly status: 400 | 404 | 409,
  ) {
    super(message);
    this.name = 'ConnectionRelayError';
  }
}

export async function relayConnectionUpsert(
  host: ScopeHost,
  actor: PlatformActorId,
  body: unknown,
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

  // The vertical comes from THIS directory's record, never from the caller.
  const rec = await host.admin.getScopeRecord(actor, input.tenantId, input.scopeId);
  if (!rec?.vertical) {
    throw new ConnectionRelayError('scope has no vertical bound', 404);
  }
  const vertical = rec.vertical;

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

  return { connectionId: id, created, granted: input.grants };
}
