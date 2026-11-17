/**
 * Registering a relying party at an issuer, by RFC 7591 dynamic client registration. Its own
 * module (and the `./register` subpath) because the platform registers clients from two places:
 * the dashboard at an install, and the control plane's `provision-tenant` drain for a managed
 * tenant that signs in at its provisioner's team auth-server (#3202). One implementation, so the
 * rules the secret travels under are the same at both.
 */
import { isAllowedEndpoint, readDiscovery } from './discovery.js';

export interface RegisteredClient {
  clientId: string;
  clientSecret: string;
}

export interface ClientRegistrationInput {
  /** The client's display name at the issuer. */
  appName: string;
  /** The one callback the client is registered with: `https://<host>/api/auth/callback`. */
  redirectUri: string;
  /** Where the issuer may send the browser back after its logout (#2904). */
  postLogoutRedirectUris?: readonly string[];
}

/** How long a whole client registration may take — the auth-server's own discovery bound. */
export const REGISTRATION_TIMEOUT_MS = 10_000;

/**
 * Register a relying party at `issuer` via dynamic client registration. The endpoint comes from
 * the issuer's own discovery document (`registration_endpoint`), with the Better-Auth default path
 * on the issuer's own origin as the fallback for an issuer whose discovery omits it.
 * `token_endpoint_auth_method: client_secret_post` matches how the RP flow presents the secret
 * (oidc-rp sends it in the token-request body).
 *
 * The response carries the new client's secret, so the document is read under oidc-rp's rules
 * (`readDiscovery`: an https issuer, same-origin redirects, the issuer it states is the one asked
 * for), the endpoint it names passes `isAllowedEndpoint`, and the POST follows no redirect. A
 * document that cannot be read, or is refused, fails the registration rather than falling back:
 * the app's login reads the same document and would refuse it too.
 */
export async function registerOidcClient(
  issuer: string,
  input: ClientRegistrationInput,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch.bind(globalThis),
  timeoutMs = REGISTRATION_TIMEOUT_MS,
): Promise<RegisteredClient> {
  // One bound for the whole registration — every discovery hop and the POST — so an issuer that
  // accepts the connection and never answers fails the caller instead of holding it.
  const signal = AbortSignal.timeout(timeoutMs);
  const discovery = await readDiscovery(issuer, { fetch: fetchImpl, signal });
  const named = (discovery as { registration_endpoint?: unknown }).registration_endpoint;
  if (named !== undefined && typeof named !== 'string') {
    throw new Error(`client registration at ${issuer}: the discovery document's registration_endpoint is not a URL`);
  }
  const endpoint = named ?? `${issuer.replace(/\/$/, '')}/api/auth/oauth2/register`;
  if (!isAllowedEndpoint(issuer, endpoint)) {
    throw new Error(`client registration at ${issuer}: the registration_endpoint is not https`);
  }

  const res = await fetchImpl(endpoint, {
    method: 'POST',
    // A 30x is a failure, not a place to send the request (and take the secret from) instead.
    redirect: 'manual',
    signal,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_name: input.appName,
      redirect_uris: [input.redirectUri],
      ...(input.postLogoutRedirectUris?.length ? { post_logout_redirect_uris: [...input.postLogoutRedirectUris] } : {}),
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
