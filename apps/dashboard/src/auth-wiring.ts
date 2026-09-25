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

import { SHARED_ISSUER_CONFIG_KEY, type ScopeId } from '@substrat-run/contracts';
import { isAllowedEndpoint, readDiscovery } from '@substrat-run/oidc-rp/discovery';

export type AppAuthChoice =
  /** An issuer the user configured by hand — Supabase, Auth0, Keycloak, …; the client
   *  must already be registered THERE with `https://<app>/api/auth/callback`. */
  | { source: 'external'; issuer: string; clientId: string; clientSecret?: string; audience?: string }
  /**
   * One of the team's own Auth Server apps — the client is auto-registered at install, and
   * so is the app's MCP endpoint (#1619, `mcp-resources.ts`), which is what `issuerScopeId`
   * addresses. Absent, the endpoint is left for the Apps list's reconcile to register.
   */
  | { source: 'auth-server'; issuer: string; issuerScopeId?: ScopeId };

export interface RegisteredClient {
  clientId: string;
  clientSecret: string;
}

export type RegisterOidcClientFn = (
  issuer: string,
  input: { appName: string; redirectUri: string },
) => Promise<RegisteredClient>;

/** How long a whole client registration may take — the auth-server's own discovery bound. */
export const REGISTRATION_TIMEOUT_MS = 10_000;

/**
 * Register a relying party at `issuer` via dynamic client registration. The endpoint
 * comes from the issuer's own discovery document (`registration_endpoint`), with the
 * Better-Auth default path on the issuer's own origin as the fallback for an issuer whose
 * discovery omits it. `token_endpoint_auth_method: client_secret_post` matches how the RP
 * flow presents the secret (oidc-rp sends it in the token-request body).
 *
 * The response carries the new client's secret, so the document is read under oidc-rp's
 * rules (`readDiscovery`: an https issuer, same-origin redirects, the issuer it states is the
 * one asked for), the endpoint it names passes `isAllowedEndpoint`, and the POST follows no
 * redirect. A document that cannot be read, or is refused, fails the registration rather than
 * falling back: the installed app's login reads the same document and would refuse it too.
 */
export async function registerOidcClient(
  issuer: string,
  input: { appName: string; redirectUri: string },
  fetchImpl: typeof globalThis.fetch = globalThis.fetch.bind(globalThis),
  timeoutMs = REGISTRATION_TIMEOUT_MS,
): Promise<RegisteredClient> {
  // One bound for the whole registration — every discovery hop and the POST — so an issuer
  // that accepts the connection and never answers fails the install instead of holding it.
  const signal = AbortSignal.timeout(timeoutMs);
  const discovery = await readDiscovery(issuer, { fetch: fetchImpl, signal });
  const named = discovery.registration_endpoint;
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

/**
 * The delivered entry that tells an app whether its issuer is one of the team's shared
 * auth-servers (#1683) — `"true"` holds its bearer path to the app's OWN tokens, `""`
 * leaves it as it always was. Delivered beside `substrat:auth` at install and on an
 * Identity change, and re-asserted by the Apps list's reconcile (`mcp-resources.ts`) for
 * every install that predates it. A key of its own so that re-assertion never has to
 * re-deliver — and so never has to read back — the client secret inside `substrat:auth`.
 *
 * An external issuer gets `""`: it is the operator's own, and the knob they already have
 * for its bearers is `audience`.
 */
export function sharedIssuerEntry(shared: boolean): { key: string; value: string } {
  return { key: SHARED_ISSUER_CONFIG_KEY, value: shared ? 'true' : '' };
}
