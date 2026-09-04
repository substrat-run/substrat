import { socialProviderList } from 'better-auth/social-providers';
import type { GenericOAuthConfig } from 'better-auth/plugins/generic-oauth';
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
 * A provider the dashboard can offer. A CLOSED catalogue over Better Auth's own social
 * providers: a built-in provider carries its endpoints, its profile mapping and its quirks
 * (Entra's per-directory authority, GitHub's separate email read) in the library, and an
 * operator gets all of that from a credential and two decisions. Adding one here is a row in
 * this array.
 *
 * The catalogue is no longer the whole story: a row whose `issuer` column is set is a GENERIC
 * OIDC provider instead — an operator-named upstream (Keycloak, Okta, Auth0, another Substrat
 * auth server) mounted through Better Auth's `genericOAuth` plugin, with its endpoints read
 * from the issuer's own discovery document rather than typed into a form. What stays closed is
 * the shape of the ask: an issuer URL is the ONE address OIDC lets us derive everything else
 * from, so a generic provider is still a credential, one URL and the same two decisions —
 * never a form of five endpoints to get subtly wrong.
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
 * The id an operator may give a GENERIC provider: a path-safe slug, because the id IS the
 * callback path segment every upstream must have registered character for character.
 */
export const GENERIC_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;

/**
 * Ids a generic provider may not take: every id Better Auth ships a BUILT-IN provider under.
 * The generic plugin prepends its providers to the built-in list, so a custom row named
 * `gitlab` would silently shadow the library's GitLab — same button, different endpoints —
 * and the failure would read as "GitLab is broken" rather than "two things share a name".
 * The catalogue ids are a subset of this list, so this is also what keeps `microsoft` from
 * being re-declared as a generic row.
 */
export function isReservedProviderId(providerId: string): boolean {
  return (socialProviderList as readonly string[]).includes(providerId);
}

/** Loopback hosts, where OAuth 2.1 still permits plain HTTP for local development. */
export const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/**
 * The rule every URL an operator can point this issuer at must pass: HTTPS, or HTTP on a
 * loopback host so a local Keycloak works in dev. Applied to the issuer URL at save time AND
 * to every endpoint its discovery document declares — an HTTPS issuer must not be able to
 * route authorization codes or client credentials to a plain-HTTP endpoint.
 */
export function isHttpsOrLoopback(url: URL): boolean {
  return url.protocol === 'https:' || (url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname));
}

/**
 * The discovery document for an issuer URL. Operators paste the ISSUER (what OIDC calls it,
 * what a relying party is configured with, what this issuer's own dashboard displays about
 * itself) and the well-known suffix is derived — but a pasted discovery URL is recognised
 * rather than doubled into `/.well-known/.well-known/…`.
 */
export function discoveryUrlOf(issuer: string): string {
  const trimmed = issuer.replace(/\/+$/, '');
  return trimmed.includes('/.well-known/') ? trimmed : `${trimmed}/.well-known/openid-configuration`;
}

/**
 * What a generic provider's discovery document resolved to, stored ON the row.
 *
 * Discovery is resolved ONCE, when the operator saves the provider — never at runtime — and
 * that is a load-bearing decision, not caching. Both runtimes rebuild Better Auth per request
 * (the property every dashboard toggle relies on), and `genericOAuth` given a `discoveryUrl`
 * fetches it in `init`: together that is one outbound fetch per configured upstream per
 * REQUEST — password sign-ins included — and, for an upstream whose discovery URL routes back
 * to this issuer (a second auth server like this one, federating back), an unbounded fetch
 * recursion that OOMs the process. Both were observed, not theorised. So the save is where
 * discovery happens: the operator gets "that URL serves no discovery document" while still in
 * the form, and the runtime config carries explicit endpoints the plugin never fetches for.
 */
export interface ProviderEndpoints {
  /** The issuer as ITS OWN discovery document declares it — the stable account namespace. */
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  userinfo_endpoint?: string;
  end_session_endpoint?: string;
}

/* The fetch itself lives in `provider-discovery.ts` — a declared network boundary in the
 * same class as `cimd-fetch.ts`, and named there so what it may and may not do is
 * reviewable in one place. */

/**
 * The redirect URI the upstream has to be told about. Better Auth serves every social
 * provider's callback at `{baseURL}/callback/{id}` under its base path — built-in and
 * generic alike, since this `genericOAuth` registers its providers as first-class social
 * providers rather than mounting the older `/oauth2/callback/{id}` pair the docs still show.
 * The panel renders this so nobody has to choose.
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
  /** Set ⇔ this is a GENERIC OIDC row: the upstream's issuer URL, as the operator gave it. */
  issuer: string | null;
  /** The generic row's display name — what the login button says. Null on catalogue rows. */
  label: string | null;
  /** The resolved discovery document (`ProviderEndpoints`, JSON) — see `resolveIssuerEndpoints`. */
  endpoints: string | null;
  allow_signup: number;
  trust_email: number;
  disabled: number;
  updated_at: number | null;
}

const COLUMNS =
  'provider_id, client_id, client_secret, tenant_id, issuer, label, endpoints, allow_signup, trust_email, disabled, updated_at';

/** Is this row a generic OIDC provider (vs a catalogue one)? The issuer column IS the flag. */
export function isGenericRow(row: ProviderRow): boolean {
  return row.issuer !== null;
}

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
  /** The generic row's issuer URL. Set on every save of a generic provider, never a catalogue one. */
  issuer?: string | null;
  /** The generic row's display name. Only meaningful alongside `issuer`. */
  label?: string | null;
  /** The resolved discovery document — the admin route supplies it beside `issuer`. */
  endpoints?: ProviderEndpoints | null;
  allowSignup: boolean;
  trustEmail: boolean;
  disabled: boolean;
}

export function upsertProvider(sql: SqlExec, providerId: string, input: ProviderInput, existing?: ProviderRow): void {
  const secret = input.clientSecret ?? existing?.client_secret;
  if (!secret) throw new Error('a client secret is required');
  sql.exec(
    `INSERT INTO identity_provider
       (provider_id, client_id, client_secret, tenant_id, issuer, label, endpoints, allow_signup, trust_email, disabled, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, cast(unixepoch('subsecond') * 1000 as integer))
     ON CONFLICT(provider_id) DO UPDATE SET
       client_id = excluded.client_id,
       client_secret = excluded.client_secret,
       tenant_id = excluded.tenant_id,
       issuer = excluded.issuer,
       label = excluded.label,
       endpoints = excluded.endpoints,
       allow_signup = excluded.allow_signup,
       trust_email = excluded.trust_email,
       disabled = excluded.disabled,
       updated_at = excluded.updated_at`,
    providerId,
    input.clientId,
    secret,
    input.tenantId?.trim() || null,
    input.issuer?.trim() || null,
    input.label?.trim() || null,
    input.endpoints ? JSON.stringify(input.endpoints) : null,
    input.allowSignup ? 1 : 0,
    input.trustEmail ? 1 : 0,
    input.disabled ? 1 : 0,
  );
}

export function deleteProvider(sql: SqlExec, providerId: string): void {
  sql.exec('DELETE FROM identity_provider WHERE provider_id = ?', providerId);
}

/** The rows that should actually be offered: enabled, and either in the catalogue or generic. */
function live(rows: ProviderRow[]): ProviderRow[] {
  return rows.filter((row) => !row.disabled && (isGenericRow(row) || descriptorOf(row.provider_id)));
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
  const enabled = live(rows).filter((row) => !isGenericRow(row));
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
 * The `genericOAuth` plugin config for the GENERIC rows — the other half of the split
 * `socialProvidersFrom` opens. The plugin registers these as first-class social providers
 * (same `/sign-in/social`, same `/callback/{id}`), so everything downstream — the login
 * button, the redirect URI the panel shows, `oauthProvider`'s authorize-resume — is one code
 * path whichever kind a row is.
 *
 * Explicit endpoints from the row, deliberately NOT `discoveryUrl`: the plugin fetches a
 * discovery URL in `init`, this issuer rebuilds Better Auth per request, and the product of
 * those two facts is a discovery fetch on every request — or an unbounded fetch recursion,
 * when the upstream is another issuer like this one whose discovery routes back here (both
 * observed; see `resolveIssuerEndpoints`, which is where discovery now happens, once, at
 * save time).
 *
 * `accountIssuer`/`accountSubject` are what discovery mode would have derived: the upstream's
 * self-declared issuer as the account namespace, and the id_token's `sub` as the subject
 * (`fetchUserInfo` maps it to `id`; the fallback order never switches fields for a given
 * provider, which is the stability the plugin's docs demand). The scopes are pinned to OIDC's
 * sign-in triple rather than asked for — this issuer federates IDENTITY, and an upstream's
 * API scopes are some other feature's problem — and `openid` in them is what guarantees the
 * id_token that `sub` rides in. `pkce` is stated even though it is the plugin's default,
 * because OAuth 2.1 requires it and a default is one refactor away from changing.
 *
 * Undefined rather than `[]` when nothing is configured, for the same reason as above: an
 * issuer with no generic upstream must not mount the plugin at all.
 */
export function genericProvidersFrom(rows: ProviderRow[]): GenericOAuthConfig[] | undefined {
  const enabled = live(rows).filter((row) => isGenericRow(row) && row.endpoints);
  if (!enabled.length) return undefined;
  return enabled.map((row) => {
    const endpoints = JSON.parse(row.endpoints!) as ProviderEndpoints;
    return {
      providerId: row.provider_id,
      name: row.label ?? row.provider_id,
      authorizationUrl: endpoints.authorization_endpoint,
      tokenUrl: endpoints.token_endpoint,
      ...(endpoints.userinfo_endpoint ? { userInfoUrl: endpoints.userinfo_endpoint } : {}),
      ...(endpoints.end_session_endpoint ? { endSessionEndpoint: endpoints.end_session_endpoint } : {}),
      accountIssuer: endpoints.issuer,
      accountSubject: ({ profile }) => String(profile.sub ?? profile.id ?? ''),
      clientId: row.client_id,
      clientSecret: row.client_secret,
      scopes: ['openid', 'profile', 'email'],
      pkce: true,
      disableSignUp: !row.allow_signup,
    };
  });
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
    issuer: row.issuer,
    label: row.label,
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
  return live(rows).map((row) => ({
    id: row.provider_id,
    label: isGenericRow(row) ? (row.label ?? row.provider_id) : descriptorOf(row.provider_id)!.label,
  }));
}
