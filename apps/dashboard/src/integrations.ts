import type { ScopeHost } from '@substrat-run/kernel';
import { ulid } from '@substrat-run/kernel';
import {
  connectionId,
  permissionKey,
  type Connection,
  type PlatformActorId,
  type ScopeId,
  type TenantId,
} from '@substrat-run/contracts';

/**
 * The dashboard's provider-connection catalog (dashboard-ui.md §4.8) — which third-party
 * integrations the Integrations surfaces offer, and everything the UI + worker need to
 * offer them: the credential FORM (self-describing fields, the same move as the manifest
 * `envSpec`), and the GRANTS a connection of that provider needs to do its write-back.
 *
 * A vertical opts in by declaring the provider slug in its manifest `requires:` — the
 * field already rides push → registry → catalog (#427), and only `oidc-issuer` is
 * interpreted elsewhere. The per-app tab renders the declared subset; a declared-but-
 * unconnected provider is the "enabled, missing its settings" state, never a gate: a
 * connector dispatch with no live connection settles pending and retries, so connecting
 * later heals every queued delivery.
 */
export interface ProviderField {
  key: string;
  label: string;
  /** Write-only in the UI; never echoed back. All connection fields are stored sealed regardless. */
  secret: boolean;
  placeholder?: string;
}

export interface ProviderSpec {
  provider: string;
  name: string;
  description: string;
  monogram: string;
  /** The credential form. Every field is required — a provider credential is a set, not a sum of options. */
  fields: ProviderField[];
  /**
   * The permission keys granted to the connection on the connecting app's scope — the
   * whole authority a leaked provider token would carry, readable in the permission diff.
   */
  grants: string[];
}

export const PROVIDERS: Record<string, ProviderSpec> = {
  scrive: {
    provider: 'scrive',
    name: 'Scrive',
    description: 'E-signing for documents and protocols.',
    monogram: 'Sc',
    // The OAuth1 four-part from Scrive's "API settings → personal access credentials",
    // keyed exactly as the connector's `scriveSecret` schema parses them.
    fields: [
      { key: 'clientId', label: 'Client credentials identifier', secret: false },
      { key: 'clientSecret', label: 'Client credentials secret', secret: true },
      { key: 'tokenId', label: 'Token credentials identifier', secret: false },
      { key: 'tokenSecret', label: 'Token credentials secret', secret: true },
    ],
    // `record-signature` lands the signature; `attach` lands the sealed signed PDF
    // (the attachmentTargets write gate). Without `attach` the reconcile retries the
    // upload forever — and since this list is the only place the dashboard door can
    // carry a grant, it must track what the connector's RETURN path needs.
    //
    // `protocol:read` is deliberately absent since #726. Reading the bound document is
    // a per-dispatch act, and its authority is now the delivery itself: the host admits
    // the attachments of the entity the delivered event names, resolved against the
    // deployment's own spine. There is no grant to hold, so there is none to miss —
    // which is the failure this catalog reproduced for months (#841, #711).
    grants: ['protocol:record-signature', 'protocol:attach'],
  },
};

/** Parse + validate a credential body against the provider's declared fields. */
export function parseProviderSecret(spec: ProviderSpec, raw: unknown): Record<string, string> {
  const body = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  const secret: Record<string, string> = {};
  const missing: string[] = [];
  for (const f of spec.fields) {
    const v = body[f.key];
    if (typeof v === 'string' && v.trim() !== '') secret[f.key] = v.trim();
    else missing.push(f.key);
  }
  if (missing.length > 0) {
    throw new Error(`missing credential field${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}`);
  }
  return secret;
}

/** The live (non-revoked) row for one provider, if any — expired/error rows are still THE row; rotation revives them. */
export function liveConnectionFor(rows: Connection[], provider: string): Connection | undefined {
  return rows.find((r) => r.provider === provider && r.status !== 'revoked' && r.externalAccountRef === null);
}

/**
 * The EMBEDDED-mode upsert — the same semantics as the control plane's
 * `/tenants/:t/connections` (create, or rotate the one live row in place so its grant
 * tuples survive; grants re-applied idempotently), effected directly on this
 * deployment's own directory because there is no shared plane to relay to. In embedded
 * mode this directory is also the one the local connector runtime opens, so the row
 * lands where it is consumed — the same invariant the connected mode gets by relaying.
 */
export async function upsertLocalConnection(
  host: ScopeHost,
  actor: PlatformActorId,
  input: {
    tenantId: TenantId;
    scopeId: ScopeId;
    vertical: string;
    spec: ProviderSpec;
    secret: Record<string, string>;
    label?: string;
    createdBy: string;
  },
): Promise<{ connectionId: string; created: boolean }> {
  const rows = await host.admin.listConnections(actor, {
    tenantId: input.tenantId,
    vertical: input.vertical,
    provider: input.spec.provider,
  });
  const live = rows.filter((r) => r.externalAccountRef === null);
  let id;
  let created;
  if (live.length === 0) {
    id = connectionId.parse(ulid());
    await host.admin.createConnection(actor, {
      id,
      tenantId: input.tenantId,
      vertical: input.vertical,
      provider: input.spec.provider,
      label: input.label ?? input.spec.name,
      secret: input.secret,
      createdBy: input.createdBy,
    });
    created = true;
  } else {
    id = live[0]!.id;
    await host.admin.updateConnectionSecret(actor, id, input.secret, undefined, { rotatedBy: input.createdBy });
    created = false;
  }
  for (const permission of input.spec.grants) {
    await host.admin.grantToConnection(actor, {
      connectionId: id,
      permission: permissionKey.parse(permission),
      node: { tenantId: input.tenantId, scopeId: input.scopeId },
      grantedBy: actor,
    });
  }
  return { connectionId: id, created };
}
