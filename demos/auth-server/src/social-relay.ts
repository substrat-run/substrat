import { isAllowedEndpoint } from '@substrat-run/oidc-rp/discovery';
import {
  SOCIAL_RELAY_CONFIG_KEY,
  relayProviderId,
  socialRelayDelivery,
  type SocialRelayDelivery,
} from '@substrat-run/contracts';
import type { SqlExec } from './introspect.js';
import { readProvider, readProviders, upsertProvider, type ProviderRow } from './providers.js';

/**
 * Platform-provided social sign-in (#1544): the rows behind "Sign in with GitHub (provided by
 * Substrat)".
 *
 * The platform registers this install at its social relay (id.substrat.net) and delivers the
 * result through the platform-gated `/internal/configure` as one `substrat:social-relay` entry
 * (vocabulary in `@substrat-run/contracts`). This file turns it into ordinary generic OIDC rows
 * in `identity_provider`, one per upstream the relay serves, named `<upstream>-relay`, so Better
 * Auth mounts them exactly like a custom provider an operator added. What makes them the
 * platform's is the client: every one of them carries the relay client id this install was
 * given, which is remembered beside them (`social_relay_client`), never a column of its own.
 *
 * The operator owns the decisions, the platform owns the credential:
 *
 *   - A row created here starts **disabled**. Nothing changes for an install's users until an
 *     operator switches a provider on.
 *   - A later delivery replaces the credential, issuer, label and endpoints, and leaves
 *     `disabled`, `allow_signup` and `trust_email` exactly as the operator set them.
 *   - A row under the same id that an operator configured against some OTHER issuer is theirs
 *     and is never touched. One configured against the relay itself (by hand, before this
 *     existed) is adopted: it is the same provider, now with the platform's credential.
 *   - A provider the relay no longer serves is switched off rather than left as a button that
 *     cannot work. It stays, with its decisions, for when the provider comes back.
 *
 * The delivery is the whole set, so re-sending it is a no-op. It carries a secret only when the
 * platform has a new one; otherwise the one held here is kept, and if none is held the sync
 * writes nothing and says `secretNeeded`, which the configure route answers with a 409.
 */

/**
 * Where the relay client this install was given is remembered (`config`, not a `cfg:` row), as
 * `{ clientId, clientSecret }`: the secret is what a provider added later is created with, since
 * a re-delivery does not carry it.
 */
const CLIENT_KEY = 'social_relay_client';

interface StoredClient {
  clientId: string;
  clientSecret: string;
}

function storedClient(sql: SqlExec): StoredClient | null {
  const row = sql.exec('SELECT value FROM config WHERE key = ?', CLIENT_KEY).toArray()[0] as
    | { value: string }
    | undefined;
  if (!row) return null;
  try {
    const parsed = JSON.parse(row.value) as Partial<StoredClient>;
    return typeof parsed.clientId === 'string' && typeof parsed.clientSecret === 'string'
      ? { clientId: parsed.clientId, clientSecret: parsed.clientSecret }
      : null;
  } catch {
    return null;
  }
}

export function isSocialRelayEntry(key: string): boolean {
  return key === SOCIAL_RELAY_CONFIG_KEY;
}

/**
 * A delivered entry, validated. Throws on anything malformed — the caller parses every entry of
 * a delivery before writing any, so a bad one refuses the whole call. Each provider's endpoints
 * must sit under its own issuer: the platform states them, and this is the same rule the admin
 * route holds a discovery document to, so a delivery cannot send a code anywhere discovery could not.
 */
export function parseSocialRelayEntry(value: string): SocialRelayDelivery {
  const delivery = socialRelayDelivery.parse(JSON.parse(value));
  for (const provider of delivery.providers) {
    const { endpoints } = provider;
    if (endpoints.issuer !== provider.issuer) {
      throw new Error(`social relay provider '${provider.id}': endpoints describe another issuer`);
    }
    for (const url of [endpoints.authorization_endpoint, endpoints.token_endpoint, endpoints.userinfo_endpoint]) {
      if (url === undefined) continue;
      if (!isAllowedEndpoint(provider.issuer, url) || !url.startsWith(`${provider.issuer}/`)) {
        throw new Error(`social relay provider '${provider.id}': an endpoint is not under its issuer`);
      }
    }
  }
  return delivery;
}

/** What one sync did, for a caller that logs it and a test that pins it. */
export interface SocialRelaySync {
  /** The delivery carried no secret and none is held for its client: nothing was written. */
  secretNeeded: boolean;
  created: string[];
  updated: string[];
  switchedOff: string[];
  operatorOwned: string[];
}

/** The relay client this install was given, if any. */
export function relayClientId(sql: SqlExec): string | null {
  return storedClient(sql)?.clientId ?? null;
}

/**
 * Is this row one the platform delivered? Its id is a relay id and it holds the relay client
 * this install was given. The panel shows such a row as a switch rather than a credential form.
 */
export function isPlatformRow(row: ProviderRow, clientId: string | null): boolean {
  return clientId !== null && row.client_id === clientId && row.provider_id.endsWith('-relay');
}

/**
 * Apply one delivery. Synchronous from first read to last write; the caller owns the
 * transaction (the DO runs this inside `storage.transactionSync` with the rest of the delivery).
 */
export function syncSocialRelay(sql: SqlExec, delivery: SocialRelayDelivery): SocialRelaySync {
  const result: SocialRelaySync = { secretNeeded: false, created: [], updated: [], switchedOff: [], operatorOwned: [] };
  const stored = storedClient(sql);
  const previousClient = stored?.clientId ?? null;
  const clientSecret =
    delivery.clientSecret ?? (stored?.clientId === delivery.clientId ? stored.clientSecret : undefined);
  if (!clientSecret) return { ...result, secretNeeded: true };
  const delivered = new Set<string>();

  for (const provider of delivery.providers) {
    const id = relayProviderId(provider.id);
    delivered.add(id);
    const existing = readProvider(sql, id);
    // The same id against another issuer is an operator's own provider: theirs, untouched.
    if (existing && existing.issuer !== provider.issuer) {
      result.operatorOwned.push(id);
      continue;
    }
    upsertProvider(
      sql,
      id,
      {
        clientId: delivery.clientId,
        clientSecret,
        tenantId: null,
        issuer: provider.issuer,
        label: provider.label,
        endpoints: provider.endpoints,
        allowSignup: existing ? Boolean(existing.allow_signup) : false,
        trustEmail: existing ? Boolean(existing.trust_email) : false,
        disabled: existing ? Boolean(existing.disabled) : true,
      },
      existing,
    );
    (existing ? result.updated : result.created).push(id);
  }

  // Rows this platform delivered before, for a provider the relay no longer serves.
  for (const row of readProviders(sql)) {
    if (delivered.has(row.provider_id) || row.disabled) continue;
    const ours = isPlatformRow(row, delivery.clientId) || isPlatformRow(row, previousClient);
    if (!ours) continue;
    sql.exec('UPDATE identity_provider SET disabled = 1 WHERE provider_id = ?', row.provider_id);
    result.switchedOff.push(row.provider_id);
  }

  sql.exec(
    'INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)',
    CLIENT_KEY,
    JSON.stringify({ clientId: delivery.clientId, clientSecret }),
  );
  return result;
}
