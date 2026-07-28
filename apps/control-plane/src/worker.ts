/**
 * The shared control plane as a deployable Cloudflare Worker — now the whole
 * **portal**: it serves the console SPA, the audited control-plane API, and staff
 * sign-in (OIDC against AuthHero), all from one origin (first-flow.md slices 1 + 3).
 *
 * Routing (per request; the coordinator is stateless):
 *   - `/api/auth/*` → the OIDC relying party (login/callback/logout) + `/session`
 *   - `/api/*`      → the control-plane router, behind `sessionPlatformAuth` — a
 *                     request with no rostered staff session is refused
 *   - everything else → the console SPA (assets binding, SPA fallback)
 *
 * The module-less `ScopeDO` is bound only because `CloudflareScopeHost.provisionScope`
 * instantiates one (host.ts) — nothing domain-shaped runs here; the real scope DOs
 * live in the vertical's deployment.
 *
 * Deploy: `pnpm --filter @substrat-run/control-plane deploy` (builds the console,
 * then `wrangler deploy`; needs Workers Paid for DO SQLite + a D1 for the roster).
 */
import { Hono } from 'hono';
import { platformActorId } from '@substrat-run/contracts';
import type { PlatformActorId } from '@substrat-run/contracts';
import { runPlatformSweep, type FetchLike } from '@substrat-run/kernel';
import {
  CloudflareScopeHost,
  ControlPlaneDO,
  defineScopeDO,
} from '@substrat-run/adapter-cloudflare';
import {
  createControlPlaneApi,
  createWfpUploader,
  createWfpModulesFetcher,
  createCfObservabilityReader,
  firstBuilderAuth,
  firstPlatformActorAuth,
  pushTokenBuilderAuth,
  serviceTokenAuth,
  sessionPlatformAuth,
  UNSAFE_devPlatformActorAuth,
  type DeployVerticalFn,
  type PlatformActorAuth,
} from '@substrat-run/control-plane-api';
import { VerticalClient } from '@substrat-run/control-plane-api';
import { mountOidcRoutes, type OidcEnv } from '@substrat-run/oidc-rp';
import { oidcStaffSessionReader, oidcStaffBearerReader } from './staff-auth.js';
import { d1StaffRoster } from './staff-roster.js';
import { mountCliAuthRoutes } from './cli-auth.js';
import { oidcBuilderReader, resolveWhoami } from './builder-auth.js';

/** The placeholder scope-DO class: kernel only, no modules. */
export const ScopeDO = defineScopeDO([], {});
export { ControlPlaneDO };

interface Env extends OidcEnv {
  SCOPE: DurableObjectNamespace;
  CONTROL_PLANE: DurableObjectNamespace;
  /** The staff roster's D1 store (#42). Absent in the workerd test (dev-actor path only). */
  AUTH_DB?: D1Database;
  /** The console SPA. Absent in the workerd test. */
  ASSETS?: Fetcher;
  /** Shared secret a connected vertical presents (x-service-token) to register. */
  SERVICE_TOKEN?: string;
  /**
   * Signs tenant-scoped push tokens (`spt1.…` — the CI credential the dashboard mints
   * into a customer repo during git-import setup). Set ONCE (`openssl rand -hex 32`)
   * and keep it out of routine rotation: rotating it revokes every issued push token,
   * breaking customer CI until they reconnect. Unset ⇒ minting 501s and presented
   * push tokens simply never authenticate.
   */
  PUSH_TOKEN_SECRET?: string;
  /** Local dev / test only: trust the `x-platform-actor` header. NEVER on a real deploy. */
  ALLOW_DEV_ACTOR?: string;
  /**
   * Shared secret presented to a vertical when provisioning an instance (K-31).
   * Must match that vertical's own `PLATFORM_SECRET`. Unset means instance creation
   * is unavailable, and the route says so rather than failing obscurely.
   */
  PLATFORM_SECRET?: string;
  /**
   * The router's shared secret (K-27). Injected into every pushed vertical so it can
   * verify the router-asserted node; the router presents the same value. Platform-owned,
   * like PLATFORM_SECRET — the vertical receives it, never declares it.
   */
  ROUTER_SECRET?: string;
  /**
   * A `substrat push` uploads a built vertical bundle into this WfP dispatch namespace,
   * with the platform's own token — the builder never holds one (D-34, self-serve-deploy.md).
   * All three unset ⇒ the deploy route 501s.
   */
  CF_API_TOKEN?: string;
  CF_ACCOUNT_ID?: string;
  DISPATCH_NAMESPACE?: string;
  /**
   * The WfP dispatch namespace holding pushed verticals — the control plane reaches one
   * to provision an instance of it (orchestration.md §5.4), the mirror of the router.
   */
  DISPATCH?: DispatchNamespace;
  /**
   * Service bindings to vertical deployments, `VERTICAL_<SLUG>` with dashes as
   * underscores — the same convention and the same static-map shape the router
   * carries, with the same Workers-for-Platforms swap later.
   */
  [binding: string]: unknown;
}

/** Minimal shape of a WfP dispatch namespace binding. */
interface DispatchNamespace {
  get(name: string): Fetcher;
}

/** The WfP uploader, when the platform's CF credential is configured (self-serve-deploy.md). */
function deployVerticalFor(env: Env): DeployVerticalFn | undefined {
  if (!env.CF_API_TOKEN || !env.CF_ACCOUNT_ID) return undefined;
  return createWfpUploader({
    accountId: env.CF_ACCOUNT_ID,
    namespace: env.DISPATCH_NAMESPACE ?? 'substrat-verticals',
    apiToken: env.CF_API_TOKEN,
    // Inject the platform-owned secrets a vertical needs to verify inbound platform +
    // router calls, so a pushed vertical is provisionable + servable with no per-vertical
    // secret setup (wrangler can't set secrets on a dispatch-namespace script anyway).
    injectSecrets: { PLATFORM_SECRET: env.PLATFORM_SECRET, ROUTER_SECRET: env.ROUTER_SECRET },
  });
}

/** Reads a pushed script's modules back from the namespace (#286) — the archive
 *  script is the bundle store the in-place serve at promote reads from. */
function fetchVerticalModulesFor(env: Env) {
  if (!env.CF_API_TOKEN || !env.CF_ACCOUNT_ID) return undefined;
  return createWfpModulesFetcher({
    accountId: env.CF_ACCOUNT_ID,
    namespace: env.DISPATCH_NAMESPACE ?? 'substrat-verticals',
    apiToken: env.CF_API_TOKEN,
  });
}

/**
 * Cloudflare-native observability reads for the console's fleet view
 * (design/observability.md §4.1). Same credential slot as the WfP uploader; the token
 * additionally needs Account Analytics read + Workers Observability read, or the
 * proxied queries fail with a Cloudflare auth error rather than 501.
 */
function observabilityFor(env: Env) {
  if (!env.CF_API_TOKEN || !env.CF_ACCOUNT_ID) return undefined;
  return createCfObservabilityReader({ accountId: env.CF_ACCOUNT_ID, apiToken: env.CF_API_TOKEN });
}

/**
 * Resolve a pushed vertical for provisioning: slug → its `prod` channel version →
 * `env.DISPATCH.get(deploymentRef)` (orchestration.md §5.4). The mirror of the router's
 * verticalFor. Absent DISPATCH or PLATFORM_SECRET ⇒ only static VERTICAL_ bindings work.
 */
function resolveVerticalFor(
  env: Env,
): ((slug: string, actor: PlatformActorId) => Promise<VerticalClient | undefined>) | undefined {
  const dispatch = env.DISPATCH;
  const secret = env.PLATFORM_SECRET;
  if (!dispatch || !secret) return undefined;
  return async (slug, actor) => {
    const host = hostFor(env);
    // A vertical serving in place (#286) provisions into its stable serving script —
    // that's where a new scope's data DO must be born, or the router (which resolves
    // scopes to the serving script) would serve empty storage.
    const serving = await host.admin.verticalServing(actor, slug).catch(() => null);
    if (serving) {
      const fetcher = dispatch.get(serving.ref);
      return new VerticalClient({ fetch: fetcher.fetch.bind(fetcher), platformSecret: secret });
    }
    const prod = (await host.admin.listChannels(actor, slug)).find((c) => c.channel === 'prod');
    if (!prod) return undefined;
    const version = (await host.admin.listVersions(actor, slug)).find((v) => v.id === prod.versionId);
    if (!version?.deploymentRef) return undefined;
    const fetcher = dispatch.get(version.deploymentRef);
    return new VerticalClient({ fetch: fetcher.fetch.bind(fetcher), platformSecret: secret });
  };
}

/** Resolve a vertical by a KNOWN dispatch script name (#286) — scopes on the stable
 *  serving script are reached directly; no channel or version lookup can disagree. */
function resolveVerticalRefFor(
  env: Env,
): ((deploymentRef: string) => Promise<VerticalClient | undefined>) | undefined {
  const dispatch = env.DISPATCH;
  const secret = env.PLATFORM_SECRET;
  if (!dispatch || !secret) return undefined;
  return async (deploymentRef) => {
    const fetcher = dispatch.get(deploymentRef);
    return new VerticalClient({ fetch: fetcher.fetch.bind(fetcher), platformSecret: secret });
  };
}

/**
 * Resolve a pushed vertical at a SPECIFIC version: slug + versionId → that version's
 * `deploymentRef` → `env.DISPATCH.get(...)`. The introspection path uses this to reach a
 * scope's BOUND version's deployment — the one that actually holds its data DO and that
 * the router serves it from — rather than the `prod` channel (which diverges once an
 * installed app lags prod, and each version is a separate WfP script + DO namespace).
 */
function resolveVerticalVersionFor(
  env: Env,
): ((slug: string, versionId: string, actor: PlatformActorId) => Promise<VerticalClient | undefined>) | undefined {
  const dispatch = env.DISPATCH;
  const secret = env.PLATFORM_SECRET;
  if (!dispatch || !secret) return undefined;
  return async (slug, versionId, actor) => {
    const host = hostFor(env);
    const version = (await host.admin.listVersions(actor, slug)).find((v) => v.id === versionId);
    if (!version?.deploymentRef) return undefined;
    const fetcher = dispatch.get(version.deploymentRef);
    return new VerticalClient({ fetch: fetcher.fetch.bind(fetcher), platformSecret: secret });
  };
}

// The actor a connected vertical acts as when it registers (a service, not staff).
const SERVICE_ACTOR = platformActorId.parse('01JZ00000000000000000000SV');
// The actor the scheduled sweep runs as (a machine pass, not staff): its directory
// reads land in the access log and its reaps in the admin log under this id.
const SWEEP_ACTOR = platformActorId.parse('01JZ00000000000000000000SW');

/**
 * The verticals this control plane can provision into (K-31).
 *
 * Discovered from the bindings rather than listed in code, so adding a vertical is a
 * wrangler change and not a code change. Empty without `PLATFORM_SECRET`: a vertical
 * refuses an unauthenticated provisioning call anyway, and an empty map makes the
 * route answer "no deployment bound" instead of failing at the far end.
 */
function verticalsFor(env: Env): Record<string, VerticalClient> {
  const secret = env.PLATFORM_SECRET;
  if (!secret) return {};
  const out: Record<string, VerticalClient> = {};
  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith('VERTICAL_')) continue;
    const binding = value as { fetch?: typeof fetch };
    if (typeof binding?.fetch !== 'function') continue;
    const slug = key.slice('VERTICAL_'.length).toLowerCase().replace(/_/g, '-');
    out[slug] = new VerticalClient({
      fetch: binding.fetch.bind(binding),
      platformSecret: secret,
    });
  }
  return out;
}

/** The coordinator is stateless — rebuilt per request; durable state is in the DOs. */
function hostFor(env: Env): CloudflareScopeHost {
  return new CloudflareScopeHost({ scope: env.SCOPE, controlPlane: env.CONTROL_PLANE });
}

/**
 * Staff session (OIDC, gated by the roster) when the roster D1 is bound, plus the
 * UNSAFE dev-actor header when explicitly enabled (local/test only). Session first;
 * neither → 401. Secure by default: a real deploy binds AUTH_DB and never sets
 * ALLOW_DEV_ACTOR.
 */
function authFor(env: Env): PlatformActorAuth {
  const readers: PlatformActorAuth[] = [];
  // Staff sign in: an OIDC session (AuthHero), gated by the D1 roster.
  if (env.AUTH_DB) {
    // The roster is DATA, not config (#42): one actor per human, revocable by a
    // timestamp rather than by editing a secret. migrations/0002_staff_roster.sql.
    const roster = d1StaffRoster(env.AUTH_DB);
    // A browser presents the session as the `sb_session` cookie; the CLI presents the
    // SAME signed session as a bearer token (obtained via the login broker, cli-auth.ts).
    // Both reduce to the same roster gate — the CLI is a staff human, not a shared actor.
    readers.push(sessionPlatformAuth(oidcStaffSessionReader(env), roster));
    readers.push(sessionPlatformAuth(oidcStaffBearerReader(env), roster));
  }
  // A connected vertical registers as a service (shared token), not staff.
  if (env.SERVICE_TOKEN) readers.push(serviceTokenAuth(env.SERVICE_TOKEN, SERVICE_ACTOR));
  // Local dev / test only.
  if (env.ALLOW_DEV_ACTOR === 'true') readers.push(UNSAFE_devPlatformActorAuth());
  return firstPlatformActorAuth(...readers);
}

export default {
  /**
   * The platform's scheduled pass (docs/design/scheduler.md; cron in wrangler.jsonc):
   * `runPlatformSweep`, whose GC phase reaps expired snapshot forks (preview-and-
   * snapshots.md §3/§9). Executor drains are skipped here — this deployment's SCOPE
   * namespace is the module-less placeholder, so there is nothing to drain; verticals
   * drain their own. The reap is the ORCHESTRATED delete: wipe the fork's storage in
   * the vertical deployment that actually holds it (resolved by bound version, like
   * introspection), then the in-process delete for the directory row + audit. Without
   * DISPATCH/PLATFORM_SECRET the vertical hop is skipped and only co-located storage
   * is wiped — correct for a single-deployment environment, and the directory row
   * never outlives the bytes either way.
   */
  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    const host = hostFor(env);
    const resolveVersion = resolveVerticalVersionFor(env);
    const report = await runPlatformSweep(host, {
      actor: SWEEP_ACTOR,
      // Handed to connector sweepers only — none are registered here, so this is a
      // type bridge (kernel's FetchLike vs the workers RequestInit), never called.
      fetch: globalThis.fetch as unknown as FetchLike,
      sweepers: {},
      drainRetries: false,
      deleteSnapshotFn: async (tenantId, scopeId) => {
        const rec = await host.admin.getScopeRecord(SWEEP_ACTOR, tenantId, scopeId);
        if (rec?.vertical && rec.verticalVersionId && resolveVersion) {
          const vertical = await resolveVersion(rec.vertical, rec.verticalVersionId, SWEEP_ACTOR);
          if (vertical) await vertical.deleteScope({ scopeId });
        }
        await host.deleteSnapshot(SWEEP_ACTOR, tenantId, scopeId);
      },
    });
    if (report.snapshotsReaped > 0 || report.errors.length > 0) {
      console.log('platform-sweep', {
        snapshotsReaped: report.snapshotsReaped,
        errors: report.errors,
      });
    }
  },

  fetch(request: Request, env: Env): Response | Promise<Response> {
    const app = new Hono<{ Bindings: Env }>();

    // Staff sign-in: OIDC relying party (AuthHero) — /api/auth/login → /callback →
    // /logout. Same-origin with the console, so the session cookie just carries.
    // Registered before the /api router so these paths win over it.
    mountOidcRoutes(app);

    // The CLI login broker (`substrat login`): /api/auth/cli + /api/auth/cli/token.
    // A loopback OAuth flow that reuses the AuthHero round-trip above and hands the CLI
    // the same signed session as a bearer. Also before the /api router.
    mountCliAuthRoutes(app);

    // Who is signed in — the console SPA polls this (null when there is no session).
    app.get('/api/auth/session', async (c) => {
      const staff = await oidcStaffSessionReader(c.env)(c.req.raw.headers);
      return c.json({ user: staff ? { email: staff.email } : null });
    });

    // The BUILDER's identity + the tenants they can build for (builder-plane.md §5). The
    // CLI calls this on `login` to store a default tenant, and to prompt when a user
    // belongs to several. Reads the same session (bearer or cookie) as the API.
    app.get('/api/auth/whoami', async (c) => c.json(await resolveWhoami(hostFor(c.env), c.env, c.req.raw)));

    // The audited control-plane API under /api (the console's baseUrl).
    app.route(
      '/api',
      createControlPlaneApi({
        host: hostFor(env),
        authenticate: authFor(env),
        // A tenant user acting on their own verticals — self-serve, no vetting roster.
        // Tried only after staff/service auth declines (control-plane-api middleware).
        // A CI push token (`spt1.…` in x-service-token) authenticates as the same kind
        // of principal — tenant-scoped builder, never staff — via the second reader.
        authenticateBuilder: firstBuilderAuth(
          oidcBuilderReader(hostFor(env), env),
          ...(env.PUSH_TOKEN_SECRET ? [pushTokenBuilderAuth(env.PUSH_TOKEN_SECRET)] : []),
        ),
        pushTokenSecret: env.PUSH_TOKEN_SECRET,
        verticals: verticalsFor(env),
        resolveVertical: resolveVerticalFor(env),
        resolveVerticalVersion: resolveVerticalVersionFor(env),
        resolveVerticalRef: resolveVerticalRefFor(env),
        deployVertical: deployVerticalFor(env),
        fetchVerticalModules: fetchVerticalModulesFor(env),
        observability: observabilityFor(env),
      }),
    );

    // The console SPA for everything else; the assets binding does the SPA fallback.
    if (env.ASSETS) {
      const assets = env.ASSETS;
      app.all('*', () => assets.fetch(request));
    }

    return app.fetch(request, env);
  },
};
