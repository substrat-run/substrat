import {
  PLATFORM_SECRET_HEADER,
  SOCIAL_RELAY_CONFIG_KEY,
  SOCIAL_RELAY_DELIVERY_STALE,
  SOCIAL_RELAY_SECRET_NEEDED,
  SOCIAL_RELAY_SECRET_STALE,
  SOCIAL_RELAY_VERTICALS,
  relayCallbackPath,
  socialRelayProviders,
  z,
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
 * `SOCIAL_RELAY_SECRET_NEEDED`; only then is the secret rotated and the entry sent again.
 *
 * Two runs of one install overlap easily — an install binds several hostnames back to back, each
 * one a trigger — and "hand out a secret, then deliver it" must have one owner at a time, or both
 * hand one out and the slower delivery leaves the install holding the secret the relay rotated
 * away (#3275). Three things hold that, all at the relay, which owns the secret:
 *
 *   - **A lease.** Creating a client or rotating its secret takes a short lease on it, given back
 *     once the secret is delivered (or outlived, if this run dies first), and while it is held the
 *     relay refuses every other rotation of that client. An overlapping run that finds the install
 *     without a secret skips instead: the lease holder is delivering one.
 *   - **A compare-and-set.** A rotation names the generation this run read at its ensure, and the
 *     relay rotates only from that one, so two runs that both saw the install without a secret
 *     cannot both rotate even with no lease between them.
 *   - **A generation on every delivery.** The install refuses a secret older than the one it holds
 *     (`SOCIAL_RELAY_DELIVERY_STALE`), so a stale delivery cannot overwrite a newer secret even if
 *     the two above are ever bypassed; and it reports a held secret the relay has rotated past
 *     (`SOCIAL_RELAY_SECRET_STALE`), which this run answers with one rotation under the lease — so
 *     an install left holding a dead secret heals on its next reconcile instead of never.
 *
 * Triggers (#1544): a hostname of an Auth Server install becoming active, which covers install
 * time and every custom domain; a staff-run pass over every install after a provider change; and
 * the install itself (`SOCIAL_RELAY_SELF_PATH`), when its operator opens its Connections page and
 * it holds no relay client or lacks a provider the relay serves, or presses "Set up". The last
 * never rotates a secret for an install that says it holds a client (`rotate: false`).
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
  /**
   * May this run rotate the client's secret when the install answers that it holds none it can
   * vouch for (`SOCIAL_RELAY_SECRET_NEEDED`)? Default true. False skips instead
   * (`SELF_ROTATION_REFUSED`): the install's own call says it holds a relay client, and a call an
   * install makes must never replace a secret it may be signing people in with. A secret the relay
   * has rotated past (`SOCIAL_RELAY_SECRET_STALE`) signs nobody in, so it is rotated either way.
   */
  rotate?: boolean;
}

/** Why a run that may not rotate skipped: the install holds a client, but not this one's secret. */
export const SELF_ROTATION_REFUSED =
  'the install holds a relay client but no secret for the one the relay keeps for it; a platform operator’s reconcile rotates it';

/** Why a run skipped: another run holds the lease on this client's secret and is delivering it. */
export const ROTATION_IN_PROGRESS =
  'another reconcile is delivering a new secret for this install’s relay client; it completes the install';

/** Why a run skipped: the secret was rotated after this run read it, by a run that has delivered it. */
export const ROTATED_MEANWHILE =
  'another reconcile rotated this install’s relay secret after this one read it; the next reconcile delivers against it';

/** Why a run skipped: the install already holds a newer secret than the one this run delivered. */
export const DELIVERY_SUPERSEDED =
  'the install already holds a newer relay secret than the one this reconcile delivered';

/**
 * What the relay answers an ensure. `generation` and `lease` are absent from a relay older than
 * generations (#3275); a run against one delivers as runs always did, without either.
 */
const ensuredClient = z.object({
  clientId: z.string().min(1),
  clientSecret: z.string().min(1).nullable(),
  created: z.boolean(),
  disabled: z.boolean(),
  generation: z.number().int().positive().optional(),
  lease: z.string().min(1).optional(),
});

const rotatedSecret = z.object({
  clientSecret: z.string().min(1),
  generation: z.number().int().positive().optional(),
  lease: z.string().min(1).optional(),
});

/** The install's 409s that say why it did not apply the relay entry, and nothing else. */
const INSTALL_REFUSALS: ReadonlySet<string> = new Set([
  SOCIAL_RELAY_SECRET_NEEDED,
  SOCIAL_RELAY_SECRET_STALE,
  SOCIAL_RELAY_DELIVERY_STALE,
]);

function installRefusal(e: unknown): string | null {
  return e instanceof ControlPlaneError && e.status === 409 && INSTALL_REFUSALS.has(e.message) ? e.message : null;
}

export async function reconcileSocialRelay(relay: SocialRelayOptions, input: ReconcileInput): Promise<SocialRelayOutcome> {
  const origin = relay.origin.replace(/\/+$/, '');
  const { providers } = socialRelayProviders.parse(await relayJson(relay, 'GET', `${origin}/providers`));
  if (providers.length === 0) return { status: 'skipped', reason: 'the relay serves no provider' };
  if (input.hostnames.length === 0) return { status: 'skipped', reason: 'the install has no active hostname' };

  const redirectUris = relayRedirectUris(input.hostnames, providers);
  const ensured = ensuredClient.parse(
    await relayJson(relay, 'PUT', `${origin}/internal/clients/by-ref/${encodeURIComponent(relayClientRef(input.scopeId))}`, {
      name: `${input.tenantId}/${input.scopeId}`,
      redirectUris,
    }),
  );

  const deliver = (clientSecret: string | null, generation: number | undefined) => {
    const value: SocialRelayDelivery = {
      clientId: ensured.clientId,
      ...(clientSecret ? { clientSecret } : {}),
      ...(generation === undefined ? {} : { generation }),
      providers,
    };
    return input.configure([{ key: SOCIAL_RELAY_CONFIG_KEY, value: JSON.stringify(value) }]);
  };
  const skipped = (reason: string): SocialRelayOutcome => ({ status: 'skipped', reason });

  let rotated = false;
  try {
    try {
      await deliver(ensured.clientSecret, ensured.generation);
    } catch (e) {
      const refused = installRefusal(e);
      if (refused === SOCIAL_RELAY_DELIVERY_STALE) return skipped(DELIVERY_SUPERSEDED);
      // Only a secretless delivery is answered with either of the two below.
      if (refused === null || ensured.clientSecret !== null) throw e;
      if (refused === SOCIAL_RELAY_SECRET_NEEDED && input.rotate === false) return skipped(SELF_ROTATION_REFUSED);
      const rotation = await rotateSecret(relay, origin, ensured.clientId, ensured.generation);
      if (rotation.status === 'busy') return skipped(ROTATION_IN_PROGRESS);
      if (rotation.status === 'moved') return skipped(ROTATED_MEANWHILE);
      try {
        await deliver(rotation.clientSecret, rotation.generation);
      } catch (e2) {
        if (installRefusal(e2) === SOCIAL_RELAY_DELIVERY_STALE) return skipped(DELIVERY_SUPERSEDED);
        throw e2;
      } finally {
        if (rotation.lease) await releaseLease(relay, origin, ensured.clientId, rotation.lease);
      }
      rotated = true;
    }
  } finally {
    // A creation hands its secret out under a lease too: given back once it is delivered.
    if (ensured.lease) await releaseLease(relay, origin, ensured.clientId, ensured.lease);
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

type Rotation =
  | { status: 'rotated'; clientSecret: string; generation?: number | undefined; lease?: string | undefined }
  /** Another run holds the client's lease: it is delivering a secret of its own (409). */
  | { status: 'busy' }
  /** The secret is past the generation this run read: another run rotated it since (412). */
  | { status: 'moved' };

/**
 * Rotate the client's secret from the generation this run read, under a lease (#3275). A relay
 * older than generations ignores the body and rotates as it always did, answering no generation.
 */
async function rotateSecret(relay: SocialRelayOptions, origin: string, clientId: string, generation: number | undefined): Promise<Rotation> {
  const url = `${origin}/internal/clients/${encodeURIComponent(clientId)}/secret`;
  const res = await relayFetch(relay, 'POST', url, generation === undefined ? {} : { generation });
  if (res.status === 409) return { status: 'busy' };
  if (res.status === 412) return { status: 'moved' };
  if (!res.ok) throw await relayRefused('POST', url, res);
  return { status: 'rotated', ...rotatedSecret.parse(await res.json()) };
}

/** Give a lease back. A failure is not this run's to report: the lease simply runs out. */
async function releaseLease(relay: SocialRelayOptions, origin: string, clientId: string, lease: string): Promise<void> {
  const url = `${origin}/internal/clients/${encodeURIComponent(clientId)}/rotation-lease/${encodeURIComponent(lease)}`;
  await relayFetch(relay, 'DELETE', url).catch(() => undefined);
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
  opts: { rotate?: boolean } = {},
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
    ...(opts.rotate === undefined ? {} : { rotate: opts.rotate }),
  });
}

/**
 * The install's own call (`SOCIAL_RELAY_SELF_PATH`), once the route has held the caller to the
 * scope it names. A refusal is a value the route answers as a problem document: an unknown scope,
 * or one that is not an Auth Server install — the self call registers only the platform's own
 * issuer, whatever else holds the platform credential. Otherwise the same reconcile every trigger
 * runs, rotating only for an install that says it holds no client (`hasClient`, which narrows:
 * a `false` cannot rotate a working install, since only its own delivery's
 * `SOCIAL_RELAY_SECRET_NEEDED` answer leads to a rotation, and it holds the secret it signs in with)
 * — or for one whose delivery shows the secret it holds is one the relay rotated past
 * (`SOCIAL_RELAY_SECRET_STALE`), which signs nobody in, so replacing it is the heal (#3275).
 */
export async function selfReconcileSocialRelay<S extends { vertical: string | null }>(
  deps: ScopeReconcileDeps<S>,
  request: { tenantId: string; scopeId: string; hasClient: boolean },
): Promise<{ ok: true; outcome: SocialRelayOutcome } | { ok: false; code: 'not_found' | 'forbidden'; detail: string }> {
  const scope = await deps.getScope(request.tenantId, request.scopeId);
  if (!scope) return { ok: false, code: 'not_found', detail: `unknown scope ${request.scopeId}` };
  if (!isSocialRelayVertical(scope.vertical)) {
    return { ok: false, code: 'forbidden', detail: `scope ${request.scopeId} is not an Auth Server install; only one may ask for the social relay` };
  }
  const outcome = await reconcileScopeSocialRelay({ ...deps, getScope: async () => scope }, request.tenantId, request.scopeId, {
    rotate: !request.hasClient,
  });
  return { ok: true, outcome };
}

/** One call to the relay, refused loudly: a reconcile that half-ran must say which half. */
async function relayJson(relay: SocialRelayOptions, method: string, url: string, body?: unknown): Promise<unknown> {
  const res = await relayFetch(relay, method, url, body);
  if (!res.ok) throw await relayRefused(method, url, res);
  return res.json();
}

async function relayRefused(method: string, url: string, res: Response): Promise<Error> {
  const detail = (await res.text().catch(() => '')).slice(0, 300);
  return new Error(`social relay refused ${method} ${new URL(url).pathname} (${res.status}): ${detail}`);
}

function relayFetch(relay: SocialRelayOptions, method: string, url: string, body?: unknown): Promise<Response> {
  return relay.fetch(url, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(url.includes('/internal/') ? { [PLATFORM_SECRET_HEADER]: relay.platformSecret } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
