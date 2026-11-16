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

import { SHARED_ISSUER_CONFIG_KEY, oidcPostLogoutUrls, type ScopeId } from '@substrat-run/contracts';
import {
  REGISTRATION_TIMEOUT_MS,
  registerOidcClient as registerAtIssuer,
  type RegisteredClient,
} from '@substrat-run/oidc-rp/register';

export { REGISTRATION_TIMEOUT_MS, type RegisteredClient };

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

export type RegisterOidcClientFn = (
  issuer: string,
  input: { appName: string; redirectUri: string },
) => Promise<RegisteredClient>;

/**
 * Register a relying party at `issuer` via dynamic client registration — `@substrat-run/oidc-rp`'s
 * `registerOidcClient`, which the control plane's `provision-tenant` drain shares (#3202), with the
 * app's own origin as where the issuer may send the browser back after its logout (#2904). Every
 * later hostname's come with the platform's `substrat:redirects` delivery, which also turns
 * end-session on (DCR cannot).
 */
export function registerOidcClient(
  issuer: string,
  input: { appName: string; redirectUri: string },
  fetchImpl: typeof globalThis.fetch = globalThis.fetch.bind(globalThis),
  timeoutMs = REGISTRATION_TIMEOUT_MS,
): Promise<RegisteredClient> {
  return registerAtIssuer(
    issuer,
    { ...input, postLogoutRedirectUris: oidcPostLogoutUrls(new URL(input.redirectUri).host) },
    fetchImpl,
    timeoutMs,
  );
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
