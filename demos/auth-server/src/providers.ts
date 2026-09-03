import type { SqlExec } from './introspect.js';

/**
 * The UPSTREAM identity providers this issuer federates to — "sign in with Microsoft" —
 * configured from the dashboard rather than baked into a deploy.
 *
 * The direction is the thing to keep straight, because this issuer now has a registry at each
 * end of it. `oauth_client` holds the relying parties DOWNSTREAM: applications that send
 * people here to sign in. This table holds the providers UPSTREAM: directories this issuer
 * itself signs into on a visitor's behalf. A vendor with a Microsoft Entra tenant appears
 * here; the vendor's own app appears there.
 *
 * Rows, not declared config keys, and the reason is the plural. A declared key pair
 * (`MICROSOFT_CLIENT_ID` / `_SECRET`) would have ridden the `cfg:` mechanism `ALLOW_SIGNUP`
 * uses and needed no table — but it fixes the provider list at deploy time, and every further
 * provider is two more keys in a manifest that a person has to read. An issuer's upstreams are
 * an operational list that grows, so they are rows an operator adds, exactly as relying
 * parties are.
 *
 * Both runtimes rebuild Better Auth per request, so a provider added here answers on the next
 * request rather than the next deploy — the same promise `settings.ts` makes for the sign-up
 * toggle.
 */

/**
 * A provider the dashboard can offer. Deliberately a CLOSED catalogue over Better Auth's own
 * social providers rather than an open "any OIDC issuer" form: a built-in provider carries its
 * endpoints, its profile mapping and its quirks (Entra's per-directory authority, GitHub's
 * separate email read) in the library, and an operator pasting a discovery URL gets none of
 * that. Adding one here is a row in this array.
 */
export interface ProviderDescriptor {
  /** Better Auth's own provider id — this IS the callback path segment. */
  id: string;
  label: string;
  /**
   * The directory field, for providers that have one. Microsoft is the only one in the
   * catalogue that does: a concrete Entra tenant GUID (or domain) pins the authority to one
   * organisation, and its absence means the multi-tenant `common` authority — which lets ANY
   * Microsoft account in, personal ones included. That is a decision, so the panel asks.
   */
  tenantField?: { label: string; placeholder: string; hint: string };
  /** Where the operator registers the redirect URI, so the panel can say it plainly. */
  console: string;
}

export const PROVIDER_CATALOGUE: readonly ProviderDescriptor[] = [
  {
    id: 'microsoft',
    label: 'Microsoft',
    tenantField: {
      label: 'Directory (tenant) ID',
      placeholder: 'a GUID, or a domain like contoso.onmicrosoft.com',
      hint: 'One Entra directory. Leave blank for the multi-tenant `common` authority — which admits any Microsoft account, personal ones included.',
    },
    console: 'Entra admin centre → App registrations → your app → Authentication',
  },
  {
    id: 'google',
    label: 'Google',
    console: 'Google Cloud console → APIs & Services → Credentials → your OAuth client',
  },
  {
    id: 'github',
    label: 'GitHub',
    console: 'GitHub → Settings → Developer settings → OAuth Apps → your app',
  },
] as const;

export function descriptorOf(providerId: string): ProviderDescriptor | undefined {
  return PROVIDER_CATALOGUE.find((p) => p.id === providerId);
}

/**
 * The redirect URI the upstream has to be told about. Better Auth serves a built-in social
 * provider's callback at `{baseURL}/callback/{id}` under its base path — NOT the
 * `/oauth2/callback/{id}` the `genericOAuth` plugin uses, which is the wrong half of a pair
 * that is easy to copy from the wrong page of the docs. The panel renders this so nobody
 * has to choose.
 */
export function callbackPath(providerId: string): string {
  return `/api/auth/callback/${providerId}`;
}

/** One configured upstream, as stored. `client_secret` never leaves this module. */
export interface ProviderRow {
  provider_id: string;
  client_id: string;
  client_secret: string;
  tenant_id: string | null;
  allow_signup: number;
  trust_email: number;
  disabled: number;
  updated_at: number | null;
}

const COLUMNS = 'provider_id, client_id, client_secret, tenant_id, allow_signup, trust_email, disabled, updated_at';

export function readProviders(sql: SqlExec): ProviderRow[] {
  return sql
    .exec(`SELECT ${COLUMNS} FROM identity_provider ORDER BY provider_id`)
    .toArray() as unknown as ProviderRow[];
}

export function readProvider(sql: SqlExec, providerId: string): ProviderRow | undefined {
  return sql
    .exec(`SELECT ${COLUMNS} FROM identity_provider WHERE provider_id = ?`, providerId)
    .toArray()[0] as unknown as ProviderRow | undefined;
}

/** What an admin may set. The secret is optional on edit: absent means "keep the stored one". */
export interface ProviderInput {
  clientId: string;
  clientSecret?: string;
  tenantId?: string | null;
  allowSignup: boolean;
  trustEmail: boolean;
  disabled: boolean;
}

export function upsertProvider(sql: SqlExec, providerId: string, input: ProviderInput, existing?: ProviderRow): void {
  const secret = input.clientSecret ?? existing?.client_secret;
  if (!secret) throw new Error('a client secret is required');
  sql.exec(
    `INSERT INTO identity_provider
       (provider_id, client_id, client_secret, tenant_id, allow_signup, trust_email, disabled, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, cast(unixepoch('subsecond') * 1000 as integer))
     ON CONFLICT(provider_id) DO UPDATE SET
       client_id = excluded.client_id,
       client_secret = excluded.client_secret,
       tenant_id = excluded.tenant_id,
       allow_signup = excluded.allow_signup,
       trust_email = excluded.trust_email,
       disabled = excluded.disabled,
       updated_at = excluded.updated_at`,
    providerId,
    input.clientId,
    secret,
    input.tenantId?.trim() || null,
    input.allowSignup ? 1 : 0,
    input.trustEmail ? 1 : 0,
    input.disabled ? 1 : 0,
  );
}

export function deleteProvider(sql: SqlExec, providerId: string): void {
  sql.exec('DELETE FROM identity_provider WHERE provider_id = ?', providerId);
}

/** The rows that should actually be offered: enabled, and still in the catalogue. */
function live(rows: ProviderRow[]): ProviderRow[] {
  return rows.filter((row) => !row.disabled && descriptorOf(row.provider_id));
}

/**
 * The `socialProviders` config for `betterAuth()`, built from the rows.
 *
 * `disableSignUp` is the per-provider half of the sign-up decision and is deliberately NOT
 * the issuer-wide `ALLOW_SIGNUP`: those answer different questions. `ALLOW_SIGNUP` is whether
 * a stranger may create an account with an email and a password; this is whether someone the
 * upstream vouches for may. A vendor federating its own Entra directory usually wants the
 * second on and the first off — everyone in the directory gets in, nobody else can register.
 *
 * Undefined rather than `{}` when nothing is configured: Better Auth reads the key's presence
 * in places, and an issuer with no upstream must not advertise one.
 */
export function socialProvidersFrom(rows: ProviderRow[]): Record<string, Record<string, unknown>> | undefined {
  const enabled = live(rows);
  if (!enabled.length) return undefined;
  const config: Record<string, Record<string, unknown>> = {};
  for (const row of enabled) {
    config[row.provider_id] = {
      clientId: row.client_id,
      clientSecret: row.client_secret,
      ...(row.tenant_id ? { tenantId: row.tenant_id } : {}),
      disableSignUp: !row.allow_signup,
    };
  }
  return config;
}

/**
 * The providers whose verified email address is accepted as proof that the person IS the
 * local account with that address (`account.accountLinking.trustedProviders`).
 *
 * Without this, an administrator creates a user, that user signs in with Microsoft, and Better
 * Auth declines to join the two — the sign-in either creates a second account or fails on the
 * unique email. With it, a corporate directory is treated as authoritative for the addresses
 * it issues, which for a vendor's own Entra tenant is exactly true and for a consumer provider
 * is a decision worth making deliberately. Hence per-row, and off by default.
 *
 * The local row must ALSO be email-verified for implicit linking to happen — Better Auth's own
 * gate against someone pre-registering an unverified account at a victim's address. That is
 * the library's, not ours, and the panel says so rather than reaching for the deprecated
 * option that would disable it.
 */
export function trustedProvidersFrom(rows: ProviderRow[]): string[] {
  return live(rows)
    .filter((row) => row.trust_email)
    .map((row) => row.provider_id);
}

/** One row for the dashboard. The secret is never here — only whether there is one. */
export function toWireProvider(row: ProviderRow) {
  return {
    id: row.provider_id,
    clientId: row.client_id,
    clientSecretSet: true,
    tenantId: row.tenant_id,
    allowSignup: Boolean(row.allow_signup),
    trustEmail: Boolean(row.trust_email),
    disabled: Boolean(row.disabled),
    callbackPath: callbackPath(row.provider_id),
    updatedAt: row.updated_at,
  };
}

/**
 * What the SIGNED-OUT login screen may know: which buttons to draw, and nothing else. No
 * client id, no directory, no disabled row — a visitor learns only what pressing a button
 * would tell them anyway.
 */
export function publicProvidersFrom(rows: ProviderRow[]): { id: string; label: string }[] {
  return live(rows).map((row) => ({ id: row.provider_id, label: descriptorOf(row.provider_id)!.label }));
}
