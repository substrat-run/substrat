import {
  CLIENT_REDIRECTS_CONFIG_PREFIX,
  DELEGATIONS_CONFIG_PREFIX,
  MCP_RESOURCES_CONFIG_PREFIX,
  PLACES_CONFIG_PREFIX,
  SHARED_ISSUER_CONFIG_KEY,
} from '@substrat-run/contracts';

/**
 * The delivered-config keys only the platform writes (#3177). An issuer applies whatever
 * `/internal/configure` hands it, so these are refused at the plane's `/configure` for a
 * tenant credential minted without `issuerConfig` — today, only the dashboard's carries it.
 *
 * `substrat:auth` is here too: it is an app scope's OIDC client (issuer, client id, secret),
 * so writing it points the app's sign-in at another issuer. The dashboard is its only writer
 * through this route, as it is of the shared-issuer flag beside it. `@substrat-run/vertical-auth`
 * owns that key's constant (`AUTH_CONFIG_KEY`); this package does not depend on it.
 *
 * An entry ending in `:` is a prefix; any other is one exact key.
 */
export const ISSUER_ONLY_CONFIG_KEYS: readonly string[] = [
  DELEGATIONS_CONFIG_PREFIX,
  PLACES_CONFIG_PREFIX,
  MCP_RESOURCES_CONFIG_PREFIX,
  CLIENT_REDIRECTS_CONFIG_PREFIX,
  'substrat:auth',
  SHARED_ISSUER_CONFIG_KEY,
];

/** The issuer-only prefix (or exact key) `key` falls under, or undefined for an ordinary key. */
export function issuerOnlyConfigKeyOf(key: string): string | undefined {
  return ISSUER_ONLY_CONFIG_KEYS.find((k) => (k.endsWith(':') ? key.startsWith(k) : key === k));
}
