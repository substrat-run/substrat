/**
 * Install-time identity wiring (vertical-auth-detach.md §2.4, Phase 4).
 *
 * The New-app form's Identity section produces an `AppAuthChoice`; `createApp` turns it
 * into the ONE `substrat:auth` entry delivered to the new instance via
 * `/internal/configure` — after the hostname is bound, because the OIDC callback URL is
 * derived from it. For a team Auth Server, the dashboard also REGISTERS the new app as a
 * relying party at that issuer first (RFC 7591 dynamic client registration, which the
 * auth-server demo enables) — so "pick an auth server" is one click, no credential
 * copy-paste.
 */

export type AppAuthChoice =
  /** An issuer the user configured by hand — Supabase, Auth0, Keycloak, …; the client
   *  must already be registered THERE with `https://<app>/api/auth/callback`. */
  | { source: 'external'; issuer: string; clientId: string; clientSecret?: string; audience?: string }
  /** One of the team's own Auth Server apps — the client is auto-registered at install. */
  | { source: 'auth-server'; issuer: string };

export interface RegisteredClient {
  clientId: string;
  clientSecret: string;
}

export type RegisterOidcClientFn = (
  issuer: string,
  input: { appName: string; redirectUri: string },
) => Promise<RegisteredClient>;

/**
 * Register a relying party at `issuer` via dynamic client registration. The endpoint
 * comes from the issuer's own discovery document (`registration_endpoint`), with the
 * Better-Auth default path as the fallback for an issuer whose discovery omits it.
 * `token_endpoint_auth_method: client_secret_post` matches how the RP flow presents the
 * secret (oidc-rp sends it in the token-request body).
 */
export async function registerOidcClient(
  issuer: string,
  input: { appName: string; redirectUri: string },
  fetchImpl: typeof globalThis.fetch = globalThis.fetch.bind(globalThis),
): Promise<RegisteredClient> {
  const base = issuer.replace(/\/$/, '');
  const discovery = (await fetchImpl(`${base}/.well-known/openid-configuration`)
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null)) as { registration_endpoint?: string } | null;
  const endpoint = discovery?.registration_endpoint ?? `${base}/api/auth/oauth2/register`;

  const res = await fetchImpl(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_name: input.appName,
      redirect_uris: [input.redirectUri],
      token_endpoint_auth_method: 'client_secret_post',
    }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`client registration at ${issuer} failed (${res.status})${detail ? `: ${detail.slice(0, 200)}` : ''}`);
  }
  const body = (await res.json()) as { client_id?: string; client_secret?: string };
  if (!body.client_id || !body.client_secret) {
    throw new Error(`client registration at ${issuer} returned no client credentials`);
  }
  return { clientId: body.client_id, clientSecret: body.client_secret };
}

/**
 * The `substrat:auth` value for a choice — registering the client first when the issuer
 * is a team Auth Server. This is what the vertical's `authProviderFor` parses.
 */
export async function authConfigFor(
  choice: AppAuthChoice,
  input: { appName: string; redirectUri: string; registerClient?: RegisterOidcClientFn },
): Promise<Record<string, string>> {
  if (choice.source === 'external') {
    return {
      mode: 'oidc',
      issuer: choice.issuer,
      clientId: choice.clientId,
      ...(choice.clientSecret ? { clientSecret: choice.clientSecret } : {}),
      ...(choice.audience ? { audience: choice.audience } : {}),
    };
  }
  const register = input.registerClient ?? registerOidcClient;
  const client = await register(choice.issuer, { appName: input.appName, redirectUri: input.redirectUri });
  return { mode: 'oidc', issuer: choice.issuer, clientId: client.clientId, clientSecret: client.clientSecret };
}
