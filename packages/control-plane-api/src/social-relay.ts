import {
  PLATFORM_SECRET_HEADER,
  SOCIAL_RELAY_CONFIG_KEY,
  SOCIAL_RELAY_SECRET_NEEDED,
  SOCIAL_RELAY_VERTICALS,
  relayCallbackPath,
  socialRelayProviders,
  type SocialRelayDelivery,
  type SocialRelayProvider,
} from '@substrat-run/contracts';
import { ControlPlaneError } from '@substrat-run/control-plane-client';
import type { CustomHostnameProvisioner, FetchFn } from './custom-hostnames.js';

/**
 * Platform-provided social sign-in (#1544): the reconciler that keeps one Auth Server install's
 * client at the platform's social relay (`apps/social-relay`, id.substrat.net) in step with the
 * providers the relay serves and the hostnames the install answers on.
 *
 * One install, one call, safe to repeat. It:
 *
 *   1. reads the providers the relay can serve right now (`GET /providers`);
 *   2. builds the redirect URIs from the install's ACTIVE hostnames — the platform's own record
 *      of them, never anything the install says — one per provider per hostname;
 *   3. ensures the install's relay client under the platform's key for it (`scope:<scope id>`),
 *      which creates it the first time and otherwise replaces its redirect URIs;
 *   4. delivers `substrat:social-relay` to the install, which turns it into switched-off
 *      provider rows (`demos/auth-server/src/social-relay.ts`).
 *
 * The relay hands a client's secret out only when it creates the client, so an ordinary run
 * delivers none and the install keeps the one it holds. An install that holds none answers
 * `SOCIAL_RELAY_SECRET_NEEDED`; only then is the secret rotated and the entry sent again. Rotating
 * on every run would let two runs that overlap — an install binds several hostnames back to back,
 * each one a trigger — deliver their secrets out of order and leave the stale one in place.
 *
 * Triggers (#1544): a hostname of an Auth Server install becoming active, which covers install
 * time and every custom domain; and a staff-run pass over every install after a provider change.
 */

/** How the control plane reaches the relay: its public origin (issuers derive from it) and a fetch. */
export interface SocialRelayOptions {
  /** The relay's public origin, e.g. `https://id.substrat.net`. Every URL is built from it. */
  origin: string;
  /** A service binding's fetch in production; any fetch in a test. */
  fetch: FetchFn;
  /** Gates the relay's `/internal/*` surface. */
  platformSecret: string;
}

/** Is this vertical one the reconciler registers at the relay? Exact slugs only. */
export function isSocialRelayVertical(vertical: string | null | undefined): boolean {
  return vertical !== null && vertical !== undefined && SOCIAL_RELAY_VERTICALS.includes(vertical);
}

/** The platform's key for an install's relay client. */
export function relayClientRef(scopeId: string): string {
  return `scope:${scopeId}`;
}

/** Every redirect URI an install needs: each live provider's callback on each active hostname. */
export function relayRedirectUris(hostnames: readonly string[], providers: readonly SocialRelayProvider[]): string[] {
  const hosts = [...new Set(hostnames.map((h) => h.toLowerCase()))].sort();
  return hosts.flatMap((host) => providers.map((p) => `https://${host}${relayCallbackPath(p.id)}`));
}

export type SocialRelayOutcome =
  | {
      status: 'delivered';
      clientId: string;
      /** The relay client was created on this run. */
      created: boolean;
      /** The install held no secret, so one was rotated and delivered. */
      rotated: boolean;
      /** The relay client is switched off at the relay (the kill switch); delivered all the same. */
      disabled: boolean;
      providers: string[];
      hostnames: string[];
    }
  | { status: 'skipped'; reason: string };

export interface ReconcileInput {
  tenantId: string;
  scopeId: string;
  /** The install's hostnames whose status is `active`. */
  hostnames: readonly string[];
  /** Deliver config entries to the install (`VerticalClient.configureInstance`). */
  configure(entries: { key: string; value: string }[]): Promise<void>;
}

export async function reconcileSocialRelay(relay: SocialRelayOptions, input: ReconcileInput): Promise<SocialRelayOutcome> {
  const origin = relay.origin.replace(/\/+$/, '');
  const { providers } = socialRelayProviders.parse(await relayJson(relay, 'GET', `${origin}/providers`));
  if (providers.length === 0) return { status: 'skipped', reason: 'the relay serves no provider' };
  if (input.hostnames.length === 0) return { status: 'skipped', reason: 'the install has no active hostname' };

  const redirectUris = relayRedirectUris(input.hostnames, providers);
  const ensured = (await relayJson(
    relay,
    'PUT',
    `${origin}/internal/clients/by-ref/${encodeURIComponent(relayClientRef(input.scopeId))}`,
    { name: `${input.tenantId}/${input.scopeId}`, redirectUris },
  )) as { clientId: string; clientSecret: string | null; created: boolean; disabled: boolean };

  const deliver = (clientSecret: string | null) => {
    const value: SocialRelayDelivery = {
      clientId: ensured.clientId,
      ...(clientSecret ? { clientSecret } : {}),
      providers,
    };
    return input.configure([{ key: SOCIAL_RELAY_CONFIG_KEY, value: JSON.stringify(value) }]);
  };

  let rotated = false;
  try {
    await deliver(ensured.clientSecret);
  } catch (e) {
    if (!(e instanceof ControlPlaneError && e.status === 409 && e.message === SOCIAL_RELAY_SECRET_NEEDED)) throw e;
    const { clientSecret } = (await relayJson(
      relay,
      'POST',
      `${origin}/internal/clients/${encodeURIComponent(ensured.clientId)}/secret`,
    )) as { clientSecret: string };
    await deliver(clientSecret);
    rotated = true;
  }

  return {
    status: 'delivered',
    clientId: ensured.clientId,
    created: ensured.created,
    rotated,
    disabled: ensured.disabled,
    providers: providers.map((p) => p.id),
    hostnames: [...new Set(input.hostnames.map((h) => h.toLowerCase()))].sort(),
  };
}

/**
 * The hostnames an install may have a relay callback on: every active PLATFORM hostname, and a
 * custom domain only once Cloudflare itself reports it verified, asked now.
 *
 * Not the row's own `status` alone: a tenant may set its hostname's status by hand
 * (`PATCH /hostnames/:h/status`), and a callback on a domain nobody verified is a way to run the
 * platform's shared sign-in — the platform's name on the consent screen — on a site that is not
 * on the platform at all. A platform hostname is the platform's by construction. Without a
 * provisioner (dev, self-host) no custom domain is verified, so none is registered.
 */
export async function relayHostnames(
  rows: readonly { hostname: string; status: string; customHostnameId: string | null }[],
  verify: { isCustom(hostname: string): boolean; provisioner?: CustomHostnameProvisioner | undefined },
): Promise<string[]> {
  const out: string[] = [];
  for (const row of rows) {
    if (row.status !== 'active') continue;
    if (!verify.isCustom(row.hostname)) {
      out.push(row.hostname);
      continue;
    }
    if (!verify.provisioner || !row.customHostnameId) continue;
    const issuance = await verify.provisioner.check(row.customHostnameId).catch(() => null);
    if (issuance?.status === 'active') out.push(row.hostname);
  }
  return out;
}

/** What reconciling one install by its ids needs: the directory, and a way to reach its deployment. */
export interface ScopeReconcileDeps<S extends { vertical: string | null }> {
  relay: SocialRelayOptions;
  getScope(tenantId: string, scopeId: string): Promise<S | null | undefined>;
  /** The hostnames a callback may be registered on — `relayHostnames` over the install's rows. */
  activeHostnames(scopeId: string): Promise<string[]>;
  /** The install's running deployment, or undefined when it has none to deliver to. */
  deploymentOf(scope: S): Promise<
    { configureInstance(input: { tenantId: string; scopeId: string; entries: { key: string; value: string }[] }): Promise<void> } | undefined
  >;
}

/**
 * Reconcile one install named by its ids — what every trigger calls. Skips, never throws for, an
 * install the relay is not for (unknown, not an Auth Server, or nothing deployed to deliver to);
 * a relay or delivery failure does throw, so the caller can report it.
 */
export async function reconcileScopeSocialRelay<S extends { vertical: string | null }>(
  deps: ScopeReconcileDeps<S>,
  tenantId: string,
  scopeId: string,
): Promise<SocialRelayOutcome> {
  const scope = await deps.getScope(tenantId, scopeId);
  if (!scope) return { status: 'skipped', reason: 'unknown scope' };
  if (!isSocialRelayVertical(scope.vertical)) return { status: 'skipped', reason: 'not an Auth Server install' };
  const deployment = await deps.deploymentOf(scope);
  if (!deployment) return { status: 'skipped', reason: 'no deployment to deliver to' };
  return reconcileSocialRelay(deps.relay, {
    tenantId,
    scopeId,
    hostnames: await deps.activeHostnames(scopeId),
    configure: (entries) => deployment.configureInstance({ tenantId, scopeId, entries }),
  });
}

/** One call to the relay, refused loudly: a reconcile that half-ran must say which half. */
async function relayJson(relay: SocialRelayOptions, method: string, url: string, body?: unknown): Promise<unknown> {
  const res = await relay.fetch(url, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(url.includes('/internal/') ? { [PLATFORM_SECRET_HEADER]: relay.platformSecret } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, 300);
    throw new Error(`social relay refused ${method} ${new URL(url).pathname} (${res.status}): ${detail}`);
  }
  return res.json();
}
