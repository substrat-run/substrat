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
import {
  platformActorId,
  tenantId,
  scopeId,
  emailRelayRequest,
  PROVISION_SIBLING_KIND,
  ARCHIVE_SCOPE_KIND,
  PROVISION_TENANT_KIND,
  SET_ENTITLEMENTS_KIND,
  connectorDispatchKind,
} from '@substrat-run/contracts';
import type { PlatformActorId, TenantId, ScopeId } from '@substrat-run/contracts';
import {
  runPlatformSweep,
  assertPlatformCall,
  PlatformCallError,
  webCryptoSecretBox,
  type FetchLike,
  type SecretBox,
} from '@substrat-run/kernel';
import {
  CloudflareScopeHost,
  ControlPlaneDO,
  createD1TenantStores,
  defineScopeDO,
  type ConnectorDelegation,
} from '@substrat-run/adapter-cloudflare';
import {
  SCRIVE_CALLBACK_ROUTE,
  handleScriveCallback,
  probeScriveConnection,
  probeScriveSecret,
  scriveCallbackPath,
  scriveConnectionActivity,
  scriveConnector,
  scriveCredentialSummary,
  sweepScriveReconciliations,
} from '@substrat-run/connector-scrive';
import {
  createControlPlaneApi,
  createWfpUploader,
  createWfpBindingsPatcher,
  createWfpModulesFetcher,
  createCfObservabilityReader,
  createCfDoNamespaceReader,
  createR2AccessLogSink,
  createR2BackupStore,
  createR2DirectoryBackupStore,
  backupDirectoryIfDue,
  pruneAccessLogBatches,
  pruneScopeBackups,
  createCustomHostnameProvisioner,
  reconcilePendingHostnames,
  isCustomHostname,
  firstBuilderAuth,
  firstPlatformActorAuth,
  pushTokenBuilderAuth,
  serviceTokenAuth,
  sessionPlatformAuth,
  UNSAFE_devPlatformActorAuth,
  drainScopePlatformRequests,
  relayConnectionUpsert,
  ConnectionRelayError,
  provisionSiblingHandler,
  archiveScopeHandler,
  provisionTenantHandler,
  setEntitlementsHandler,
  connectorDispatchHandler,
  type ManagedTenantDeps,
  type PlatformDrainReport,
  type DeployVerticalFn,
  type FetchVerticalAssetFn,
  type CustomHostnameProvisioner,
  type PlatformActorAuth,
  type ConnectionInspector,
  type PlatformRuntime,
  type DoNamespaceReader,
} from '@substrat-run/control-plane-api';
import { VerticalClient } from '@substrat-run/control-plane-api';
import type { SendEmailBinding } from '@substrat-run/adapter-email';
import { mountOidcRoutes, type OidcEnv } from '@substrat-run/oidc-rp';
import { transportFor, senderFor } from './email.js';
import { oidcStaffSessionReader, oidcStaffBearerReader } from './staff-auth.js';
import { d1StaffRoster } from './staff-roster.js';
import { mountCliAuthRoutes } from './cli-auth.js';
import { builderTenantsFor, oidcBuilderReader, resolveWhoami } from './builder-auth.js';

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
  /**
   * The platform's scope-backup bucket (#493) — where a reap's recoverable copy lands
   * before any byte is wiped. Bound in wrangler.jsonc. Absent (the workerd test, a
   * self-host) ⇒ a reap that explicitly asks for a backup is refused 501 rather than
   * proceeding without one; a reap that does not ask still works.
   */
  SCOPE_BACKUPS?: R2Bucket;
  /**
   * The platform's DIRECTORY-backup bucket (#40) — where the daily copy of the control
   * plane's own database lands. Bound in wrangler.jsonc. Absent (the workerd test, a
   * self-host) ⇒ the cron's backup phase is skipped and the directory backup routes
   * answer 501, which is the loud version of "this deployment keeps no platform copy".
   */
  DIRECTORY_BACKUPS?: R2Bucket;
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
   * Days a scope may sit `archived` before the sweep reaps its DO storage (§4.4).
   * Cloudflare never GCs a Durable Object, so an archived app's bytes persist forever
   * until this fires. UNSET disables auto-reap entirely — the reap is irreversible, so a
   * deployment opts in by naming a window; manual reap from the console is unaffected.
   * Parsed as an integer number of days.
   */
  SCOPE_RETENTION_DAYS?: string;
  /**
   * How many days a tenant may sit in `deleting` before the sweep reaps it (§4.8): every
   * scope reaped, PII/config directory rows cleared, the tenant row left as a tombstone.
   * The tenant-level counterpart of `SCOPE_RETENTION_DAYS`. UNSET disables auto-reap — the
   * reap is irreversible, so a deployment opts in by naming a grace window; the console's
   * "reap now" is unaffected. Parsed as an integer number of days.
   */
  TENANT_RETENTION_DAYS?: string;
  /**
   * Days a reap's stored copy (`scopes/…` in SCOPE_BACKUPS, #493) is kept before the
   * sweep drops it (#557). UNSET keeps every copy forever — the platform never deletes
   * evidence on a schedule a human did not choose, so a deployment opts in by naming a
   * window, exactly like the two reap windows above. Dropping a copy is dropping the
   * ONLY recoverable form of a reaped scope's data, so choose it as deliberately as the
   * reap window itself. Parsed as an integer number of days.
   */
  SCOPE_BACKUP_RETENTION_DAYS?: string;
  /**
   * Days a shipped access-log batch (`access-log/…` in DIRECTORY_BACKUPS, #553) is kept
   * before the sweep drops it (#557). This is the record's Tier 2 lifetime — the in-DO
   * window already closed when the batch shipped — so this chooses how far back "which
   * rows left, and when" is answerable from the object store; the admin log's own
   * drain/prune rows are never touched. UNSET keeps every batch forever, same opt-in
   * posture as above. Parsed as an integer number of days.
   */
  ACCESS_LOG_RETENTION_DAYS?: string;
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
   * Cloudflare-for-SaaS custom-hostname issuance (#305, §4.7). The zone whose fallback
   * origin fronts tenant apps (the `substrat.run` zone), the CNAME value tenants point a
   * custom domain at, and the comma-separated base domains a PLATFORM hostname is minted
   * under (those ride the wildcard cert and skip issuance). Absent CF_SAAS_ZONE_ID ⇒ a
   * custom bind records `pending` and issuance never runs (dev / self-host). The token +
   * account are the same CF_* credential the WfP uploader uses; it needs SSL/custom-
   * hostname write on the zone as well.
   */
  CF_SAAS_ZONE_ID?: string;
  CF_SAAS_ROUTING_TARGET?: string;
  /**
   * DCV method for custom-hostname certs. Defaults to `http`: Cloudflare serves the
   * validation token at its edge once the CNAME is live, so a tenant publishes a single
   * record (the routing CNAME) and issuance is hands-off — nothing for us to serve. Set
   * to `txt` for the two-record flow that can validate before the CNAME resolves.
   */
  CF_SAAS_SSL_METHOD?: string;
  PLATFORM_BASE_DOMAINS?: string;
  /**
   * Cloudflare Email Service `send_email` binding + sender address (#303). The control
   * plane is the ONE place that holds an outbound-mail credential: a hosted vertical cannot
   * bind `send_email` (WfP dispatch scripts have no such binding, and the §4 sandbox refuses
   * it), so a vertical granted `emailSender` POSTs to `/internal/email/send` and the CP sends
   * on its behalf through this binding. Absent ⇒ the relay falls back to the drop-mock (dev).
   */
  EMAIL?: SendEmailBinding;
  EMAIL_FROM?: string;
  /**
   * The control plane's own public origin (e.g. `https://console.substrat.net`) — injected
   * into every pushed vertical as `CONTROL_PLANE_URL` so a vertical granted `emailSender` knows
   * where to POST the email relay (#303). A checked-in `var`, not a secret: it is public and
   * differs per environment. Absent ⇒ verticals get no relay URL and fall back to the drop-mock.
   */
  PLATFORM_CP_URL?: string;
  /**
   * The WfP dispatch namespace holding pushed verticals — the control plane reaches one
   * to provision an instance of it (orchestration.md §5.4), the mirror of the router.
   */
  DISPATCH?: DispatchNamespace;
  /**
   * Seals connection credentials at rest (#101/#574) — base64(url) of 32 bytes
   * (`openssl rand -base64 32`), same convention as the dashboard's box. The
   * coordinator-side key for the directory's `_substrat_connection_secrets`
   * ciphertext; the DO never holds it. Unset ⇒ the host refuses to store or open
   * a connection credential (fail closed), which also disables the platform-run
   * connector pass. `SECRET_BOX_KEY_ID` labels the key generation for rotation
   * (default `sb1`).
   */
  SECRET_BOX_KEY?: string;
  SECRET_BOX_KEY_ID?: string;
  /**
   * Scrive API base for the platform-run connector pass (#574/#96) — the sweep, the
   * webhook ingress and the inspection reads (#605) all go through it.
   *
   * Unset ⇒ the connector's default, which is the TESTBED. That default is right for a
   * developer and wrong for a deployment: a production credential sent to the testbed
   * comes back 401, indistinguishable from a mistyped key. So both environments set this
   * var explicitly in `wrangler.jsonc` — production `https://scrive.com` (the API lives
   * under /api/v2 on the main host; `api.scrive.com` does not resolve), TEST the testbed.
   */
  SCRIVE_BASE_URL?: string;
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
    // CONTROL_PLANE_URL is the CP's own origin — the callback address a vertical POSTs to
    // for the email relay (#303); the vertical never hard-codes it (dev vs prod differ).
    injectSecrets: {
      PLATFORM_SECRET: env.PLATFORM_SECRET,
      ROUTER_SECRET: env.ROUTER_SECRET,
      CONTROL_PLANE_URL: env.PLATFORM_CP_URL,
    },
  });
}

/** The list of base domains a PLATFORM hostname is minted under (#305). */
function platformBaseDomains(env: Env): string[] {
  return (env.PLATFORM_BASE_DOMAINS ?? '')
    .split(',')
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean);
}

/** The Cloudflare-for-SaaS custom-hostname provisioner, when a SaaS zone is configured (#305). */
function provisionHostnameFor(env: Env): CustomHostnameProvisioner | undefined {
  if (!env.CF_API_TOKEN || !env.CF_SAAS_ZONE_ID) return undefined;
  return createCustomHostnameProvisioner({
    zoneId: env.CF_SAAS_ZONE_ID,
    apiToken: env.CF_API_TOKEN,
    // Where a tenant points DNS — the SaaS fallback ingress. Defaults to a conventional
    // `edge.<first base domain>` when unset, so a standard deployment needs no extra var.
    routingTarget:
      env.CF_SAAS_ROUTING_TARGET ?? `edge.${platformBaseDomains(env)[0] ?? 'substrat.run'}`,
    // `http` DCV (default) needs only the routing CNAME and validates at CF's edge; `txt`
    // opts into the two-record flow. Anything but an explicit `txt` means `http`.
    sslMethod: env.CF_SAAS_SSL_METHOD === 'txt' ? 'txt' : 'http',
  });
}

/**
 * The coordinates the console turns into Cloudflare dashboard links: the account every
 * script/database/bucket belongs to, and the namespace a `servingRef` or `deploymentRef`
 * names a script in. Needs no token — unlike every other Cloudflare seam here, nothing is
 * called; the descriptor is handed to the browser, so it deliberately reads only
 * `CF_ACCOUNT_ID` and never `CF_API_TOKEN`. Absent account ⇒ undefined ⇒ no links.
 */
function platformRuntimeFor(env: Env): PlatformRuntime | undefined {
  if (!env.CF_ACCOUNT_ID) return undefined;
  return {
    provider: 'cloudflare',
    accountId: env.CF_ACCOUNT_ID,
    dispatchNamespace: env.DISPATCH_NAMESPACE ?? 'substrat-verticals',
  };
}

/**
 * Resolves a script's Durable Object namespaces to their dashboard ids, so the console can
 * link a scope to the exact namespace its DO lives in rather than the account-wide list.
 * Same credential slot as the WfP uploader (Workers scripts read); absent ⇒ the route 501s
 * and the console keeps the list-level link.
 */
function doNamespacesFor(env: Env): DoNamespaceReader | undefined {
  if (!env.CF_API_TOKEN || !env.CF_ACCOUNT_ID) return undefined;
  return createCfDoNamespaceReader({ accountId: env.CF_ACCOUNT_ID, apiToken: env.CF_API_TOKEN });
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
 * Reads a pushed script's STATIC ASSET bytes back through the dispatch fabric (#578) —
 * the asset twin of `fetchVerticalModulesFor`, for the serve-in-place at promote: the
 * asset store dedupes per script, so the stable serving script cannot ride dedupe on
 * bytes the push uploaded to the version's archive script. There is no read-back API for
 * assets the way `/content` gives back modules, but none is needed: assets are served by
 * the runtime's edge without invoking the worker, so a plain dispatch fetch of the path
 * returns the bytes (which the serve then verifies against their content-address).
 * Redirects are followed by hand — `html_handling` may answer `/index.html` with a
 * redirect to `/` — against the same script, never off it.
 */
function fetchVerticalAssetFor(env: Env): FetchVerticalAssetFn | undefined {
  const dispatch = env.DISPATCH;
  if (!dispatch) return undefined;
  return async (deploymentRef, asset) => {
    const fetcher = dispatch.get(deploymentRef);
    let url = new URL(asset.path, 'https://asset-recovery.invalid');
    for (let hop = 0; hop < 3; hop++) {
      const res = await fetcher.fetch(url.toString(), { redirect: 'manual' });
      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get('location');
        await res.body?.cancel();
        if (!location) return undefined;
        url = new URL(location, url);
        continue;
      }
      if (!res.ok) {
        await res.body?.cancel();
        return undefined;
      }
      return new Uint8Array(await res.arrayBuffer());
    }
    return undefined;
  };
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
    const version = await host.admin.getVersion(actor, prod.versionId, slug);
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
    const version = await host.admin.getVersion(actor, versionId, slug);
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
// The actor the connection relay effects as (connections.md §3.5.2). Distinct from the
// sweep so the admin log reads honestly: a `createConnection` under this id was a tenant
// admin's relayed act (the principal is in the row's `createdBy`/`rotatedBy`), not staff.
const CONNECTION_RELAY_ACTOR = platformActorId.parse('01JZ00000000000000000000CR');

/**
 * `SCOPE_RETENTION_DAYS` → the sweep's `reapArchivedAfterDays`, or `undefined` when
 * unset/blank/invalid so the kernel skips the reap phase. A non-negative integer only:
 * a garbled value must disable auto-reap, never coerce to `0` and reap everything the
 * next sweep sees. `0` is honored (reap on the first pass) — an operator can ask for it.
 */
function parseRetentionDays(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : undefined;
}

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

/** The connection-secret box (#574), when the seal key is configured — the dashboard's
 *  exact convention (base64/base64url key, labelled key id) so operators set one shape. */
function secretBoxFor(env: Env): SecretBox | undefined {
  if (!env.SECRET_BOX_KEY) return undefined;
  const b64 = env.SECRET_BOX_KEY.trim().replace(/-/g, '+').replace(/_/g, '/');
  const padded = b64.padEnd(Math.ceil(b64.length / 4) * 4, '=');
  const key = Uint8Array.from(atob(padded), (ch) => ch.charCodeAt(0));
  if (key.length !== 32) {
    throw new Error(
      `SECRET_BOX_KEY must decode to 32 bytes (got ${key.length}) — use \`openssl rand -base64 32\``,
    );
  }
  return webCryptoSecretBox(env.SECRET_BOX_KEY_ID ?? 'sb1', key);
}

/**
 * What each connector can ANSWER about a connection (#605) — the third role the same
 * closures play, next to dispatch and sweep. Defined once because two callers need it:
 * the control-plane API's inspection routes, and the `/internal/connections/upsert`
 * relay, whose connect-time gate must be the same check the dashboard's connect makes.
 *
 * `probeCandidate` is the one that runs BEFORE a write — see `relayConnectionUpsert`.
 */
function connectionInspectorsFor(env: Env): Record<string, ConnectionInspector> {
  const fetchImpl = globalThis.fetch as unknown as FetchLike;
  return {
    scrive: {
      probe: (h, row) => probeScriveConnection(h, row, { fetch: fetchImpl, baseUrl: env.SCRIVE_BASE_URL }),
      activity: (h, row, opts) =>
        scriveConnectionActivity(h, row, {
          fetch: fetchImpl,
          baseUrl: env.SCRIVE_BASE_URL,
          live: opts.live,
          source: opts.source,
        }),
      credential: (h, row) => scriveCredentialSummary(h, row),
      probeCandidate: (secret) => probeScriveSecret(secret, { fetch: fetchImpl, baseUrl: env.SCRIVE_BASE_URL }),
    },
  };
}

/**
 * The connector write-back's platform half (#574): a connector running ON this worker
 * (the sweep, later the ingress) writes into a scope that lives in a vertical's dispatch
 * deployment — this routes `getConnectorScope().invoke` / attachment upload / grant
 * delivery over that vertical's platform-secret-gated `/internal/connector-*` surface,
 * resolved by the same serving-ref → bound-version → prod ladder every other delegated
 * verb uses. Undefined without DISPATCH/PLATFORM_SECRET — a deployment that cannot
 * reach a vertical fails the connector call loudly instead of writing into the CP's
 * own module-less placeholder DO.
 */
function connectorDelegationFor(env: Env): ConnectorDelegation | undefined {
  if (!env.DISPATCH || !env.PLATFORM_SECRET) return undefined;
  const clientFor = async (tenantId: TenantId, scopeId: ScopeId): Promise<VerticalClient> => {
    // A bare directory host (no delegation) — this is a read of our own directory,
    // not a connector call; constructed per invocation like every other host here.
    const directory = new CloudflareScopeHost({ scope: env.SCOPE, controlPlane: env.CONTROL_PLANE });
    const rec = await directory.admin.getScopeRecord(SWEEP_ACTOR, tenantId, scopeId);
    if (!rec?.vertical) {
      throw new Error(`scope ${scopeId} has no vertical — cannot delegate a connector call`);
    }
    const client = await resolveVerticalForScopeFor(env)(rec);
    if (!client) {
      throw new Error(
        `no deployment serving scope ${scopeId} (vertical '${rec.vertical}') — cannot deliver the connector call`,
      );
    }
    return client;
  };
  return {
    invoke: async (a) =>
      (await clientFor(a.tenantId, a.scopeId)).connectorInvoke({
        connectionId: a.connectionId,
        tenantId: a.tenantId,
        scopeId: a.scopeId,
        operation: a.operation,
        input: a.input,
      }),
    uploadAttachment: async (a) =>
      (await clientFor(a.tenantId, a.scopeId)).connectorUploadAttachment({
        connectionId: a.connectionId,
        tenantId: a.tenantId,
        scopeId: a.scopeId,
        ...a.upload,
      }),
    grant: async (a) =>
      (await clientFor(a.tenantId, a.scopeId)).connectorGrant({
        connectionId: a.connectionId,
        scopeId: a.scopeId,
        permission: a.permission,
        expiresAt: a.expiresAt,
      }),
  };
}

/** The coordinator is stateless — rebuilt per request; durable state is in the DOs. */
function hostFor(env: Env): CloudflareScopeHost {
  return new CloudflareScopeHost({
    scope: env.SCOPE,
    controlPlane: env.CONTROL_PLANE,
    // Per-tenant relational stores (#301): the live D1 mint/query client, on the same
    // platform credential the WfP uploader holds (the token additionally needs D1 write).
    // Absent creds ⇒ provisionTenantStore refuses loudly instead of half-provisioning.
    tenantStores:
      env.CF_API_TOKEN && env.CF_ACCOUNT_ID
        ? createD1TenantStores({ accountId: env.CF_ACCOUNT_ID, apiToken: env.CF_API_TOKEN })
        : undefined,
    // Connections (#574): seal/open credentials coordinator-side, and route connector
    // write-backs to the vertical deployment serving the scope — this worker's own
    // SCOPE namespace is the module-less placeholder and must never receive one.
    secretBox: secretBoxFor(env),
    connectorDelegation: connectorDelegationFor(env),
  });
}

/** Attach per-tenant store D1 bindings to a dispatch script without a redeploy (#301). */
function patchScriptBindingsFor(env: Env) {
  if (!env.CF_API_TOKEN || !env.CF_ACCOUNT_ID) return undefined;
  return createWfpBindingsPatcher({
    accountId: env.CF_ACCOUNT_ID,
    namespace: env.DISPATCH_NAMESPACE ?? 'substrat-verticals',
    apiToken: env.CF_API_TOKEN,
  });
}

/**
 * Resolve the `VerticalClient` serving a scope — the serving-ref → bound-version → prod
 * ladder the control-plane API's `verticalForScope` uses. Shared by the platform-intent
 * drain (both the periodic sweep and the router-kick endpoint) and its provision-sibling
 * handler. Returns `undefined` when no deployment is bound (nothing to drain).
 */
function resolveVerticalForScopeFor(
  env: Env,
): (scope: {
  vertical: string | null;
  verticalVersionId: string | null;
  servingRef?: string | null;
}) => Promise<VerticalClient | undefined> {
  const resolveVersion = resolveVerticalVersionFor(env);
  const resolveRef = resolveVerticalRefFor(env);
  const resolveSlug = resolveVerticalFor(env);
  return async (scope) => {
    const slug = scope.vertical;
    if (!slug) return undefined;
    if (scope.servingRef && resolveRef) {
      const serving = await resolveRef(scope.servingRef);
      if (serving) return serving;
    }
    if (scope.verticalVersionId && resolveVersion) {
      const bound = await resolveVersion(slug, scope.verticalVersionId, SWEEP_ACTOR);
      if (bound) return bound;
    }
    return resolveSlug ? resolveSlug(slug, SWEEP_ACTOR) : undefined;
  };
}

/**
 * Drain one scope's pending platform-intents now: pull them from the vertical's
 * `/internal` surface (its DO lives in the vertical's deployment, K-31), execute each
 * with platform authority via the registered handlers, settle back. The unit shared by
 * the ~2-min periodic sweep (reliability) and the router kick (latency, platform-intents.md
 * §"router kick") — a vertical whose response carried `x-substrat-platform-request` gets
 * drained in seconds instead of at the next sweep. A scope with no bound deployment drains
 * nothing. The identity is inherent: the tenant/vertical come from THIS directory's record
 * for the scope, never from the caller, so the intents executed are only ever the scope's own.
 */
async function drainOneScope(env: Env, t: TenantId, s: ScopeId): Promise<PlatformDrainReport> {
  const empty: PlatformDrainReport = { drained: 0, done: 0, failed: 0, pending: 0 };
  const host = hostFor(env);
  const rec = await host.admin.getScopeRecord(SWEEP_ACTOR, t, s);
  if (!rec?.vertical) return empty;
  const resolveVerticalForScope = resolveVerticalForScopeFor(env);
  const client = await resolveVerticalForScope(rec);
  if (!client) return empty;
  // The managed-tenant capability (#412/#444): who may create tenants is the registry's
  // `tenantProvisioner` flag — a staff grant read by admitManager at drain time. The
  // handlers are ALWAYS registered: an ungranted vertical's refusal settles `failed`
  // with a reason, where an absent handler would report the generic "no handler for kind".
  const managedTenantDeps: ManagedTenantDeps = {
    host,
    actor: SWEEP_ACTOR,
    resolveVerticalForScope,
    patchScriptBindings: patchScriptBindingsFor(env),
  };
  return drainScopePlatformRequests(
    client,
    { tenantId: t, scopeId: s, vertical: rec.vertical },
    {
      [PROVISION_SIBLING_KIND]: provisionSiblingHandler({
        host,
        actor: SWEEP_ACTOR,
        resolveVerticalForScope,
        patchScriptBindings: patchScriptBindingsFor(env),
      }),
      [ARCHIVE_SCOPE_KIND]: archiveScopeHandler({ host, actor: SWEEP_ACTOR }),
      [PROVISION_TENANT_KIND]: provisionTenantHandler(managedTenantDeps),
      [SET_ENTITLEMENTS_KIND]: setEntitlementsHandler(managedTenantDeps),
      // #574 phase 3: the outbound half of the platform-run connector pass. A CP-less
      // vertical routed a `protocol.signatures-requested` delivery here as an intent;
      // this host holds the directory, the sealed credential, and (via its
      // connectorDelegation) the scope write-back seam, so the SAME `scriveConnector`
      // closure a self-host registers runs unchanged. The callback URL terminates on
      // THIS worker's phase-2 ingress — minted only when the deployment knows its own
      // public origin; without it the dispatch is poll-only, which is complete, just
      // slower (the sweep is the floor).
      [connectorDispatchKind('scrive')]: connectorDispatchHandler({
        host,
        connector: scriveConnector({
          baseUrl: env.SCRIVE_BASE_URL,
          ...(env.PLATFORM_CP_URL
            ? {
                callbackUrl: (ref) =>
                  `${env.PLATFORM_CP_URL!.replace(/\/+$/, '')}${scriveCallbackPath(ref)}`,
              }
            : {}),
        }),
      }),
    },
    {
      // #570: the drain's attempt-ceiling give-up lands a durable ops-failure row
      // (#559). Fire-and-forget — a recorder failure must never mask the settle.
      recordFailure: (entry) => {
        void host.admin.recordOpsFailure({ actor: SWEEP_ACTOR, ...entry }).catch(() => undefined);
      },
    },
  );
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
      // Sanctioned egress for the connector sweepers below (kernel's FetchLike vs the
      // workers RequestInit — a type bridge, same fetch).
      fetch: globalThis.fetch as unknown as FetchLike,
      // #574: the platform runs the connector pass FOR dispatch verticals — they are
      // CP-less and cannot reach the connection directory. The sweep enumerates THIS
      // directory's connections, opens each with the coordinator-held secret box, polls
      // the provider, and writes back through the vertical's /internal/connector-*
      // surface (the host's connectorDelegation). A connection whose secret cannot be
      // opened (no CONNECTION_SEAL_KEY) fails its sweep loudly into report.errors.
      sweepers: {
        scrive: (h, id, o) =>
          sweepScriveReconciliations(h, id, { ...o, baseUrl: env.SCRIVE_BASE_URL }),
      },
      drainRetries: false,
      deleteSnapshotFn: async (tenantId, scopeId) => {
        const rec = await host.admin.getScopeRecord(SWEEP_ACTOR, tenantId, scopeId);
        if (rec?.vertical && rec.verticalVersionId && resolveVersion) {
          const vertical = await resolveVersion(rec.vertical, rec.verticalVersionId, SWEEP_ACTOR);
          if (vertical) await vertical.deleteScope({ scopeId });
        }
        await host.deleteSnapshot(SWEEP_ACTOR, tenantId, scopeId);
      },
      // §4.4 storage reap — opt-in via SCOPE_RETENTION_DAYS. Same orchestrated shape as
      // the snapshot delete: wipe the scope's DO in the vertical deployment that holds it
      // (its storage is CP-less), then the in-process reapScope for the directory
      // transition + audit. Left unset ⇒ the kernel skips the phase, so a deployment that
      // has not chosen a retention window never auto-deletes an app's data.
      reapArchivedAfterDays: parseRetentionDays(env.SCOPE_RETENTION_DAYS),
      reapScopeFn: async (tenantId, scopeId) => {
        const rec = await host.admin.getScopeRecord(SWEEP_ACTOR, tenantId, scopeId);
        if (rec?.vertical && rec.verticalVersionId && resolveVersion) {
          const vertical = await resolveVersion(rec.vertical, rec.verticalVersionId, SWEEP_ACTOR);
          if (vertical) await vertical.deleteScope({ scopeId });
        }
        // Automated retention / tenant-teardown reap: force past the bound-hostname guard
        // (that guard stops the interactive per-scope mistake, not the aged-out sweep).
        await host.admin.reapScope(SWEEP_ACTOR, tenantId, scopeId, { force: true });
      },
      // §4.8 tenant reap — opt-in via TENANT_RETENTION_DAYS. The kernel's default
      // `reapTenantFn` composes the `reapScopeFn` above (archive-if-needed → wipe each
      // scope's DO in its vertical deployment → reapScope), then clears the directory via
      // reapTenant — so the orchestrated per-scope wipe applies here without a separate
      // override. Left unset ⇒ the kernel skips the phase.
      reapDeletingAfterDays: parseRetentionDays(env.TENANT_RETENTION_DAYS),
      // Platform-intent drain (platform-intents.md B2/C): for each active scope, pull its pending
      // intents from the vertical's /internal surface (its DO lives in the vertical's deployment),
      // execute each with platform authority, and settle back. The same `drainOneScope` the router
      // kick calls on demand — the sweep is the reliability backstop, the kick is the latency path.
      drainPlatformRequestsFn: (t, s) => drainOneScope(env, t, s),
      // K-24 §4.4 — ship the staff access log to Tier 2, then prune what was shipped.
      // Rides the DIRECTORY backup bucket rather than a binding of its own: this is the
      // platform's own record (no tenant owns it), the `access-log/` prefix cannot collide
      // with `directory/`, and a fourth bucket would be one more thing to provision for no
      // isolation gained. Absent binding ⇒ the kernel skips the phase and the log grows —
      // the same opt-in posture as the two retention windows above.
      ...(env.DIRECTORY_BACKUPS
        ? { accessLogSink: createR2AccessLogSink(env.DIRECTORY_BACKUPS) }
        : {}),
    });
    // Log whenever the pass DID something — reaps, errors, or any platform-intent
    // activity (drained/failed/still-pending). The last one matters most (#444): a
    // scope with intents stuck `pending` should leave a trace on every pass, so a
    // drain that silently never converges is visible in the tail instead of invisible.
    const pr = report.platformRequestTotals;
    const al = report.accessLog;
    if (
      report.snapshotsReaped > 0 ||
      report.archivedScopesReaped > 0 ||
      report.tenantsReaped > 0 ||
      report.errors.length > 0 ||
      pr.drained > 0 ||
      pr.failed > 0 ||
      pr.pending > 0 ||
      (al !== null && (al.shipped > 0 || al.pruned > 0))
    ) {
      console.log('platform-sweep', {
        snapshotsReaped: report.snapshotsReaped,
        archivedScopesReaped: report.archivedScopesReaped,
        tenantsReaped: report.tenantsReaped,
        platformRequests: pr,
        // An egress leaves a trace in the tail as well as the admin log: `ref` is the
        // object the rows landed in, so a question about a pruned row has an address.
        ...(al ? { accessLog: al } : {}),
        errors: report.errors,
      });
    }

    // #305 §4.7 — the custom-hostname reconcile pass: unbind rows whose scope is
    // archived/reaped (a deleted app's hostnames must not linger), poll every `verifying`
    // domain (→ active/failed) and retry any `pending` custom bind whose create never landed.
    // This is what makes issuance self-heal without a human flipping status by hand. It
    // needs a CF-for-SaaS zone; without one (dev/self-host) the provisioner is undefined
    // and the pass is skipped. Contained per-row, so a bad domain never sinks the sweep.
    const provisioner = provisionHostnameFor(env);
    if (provisioner) {
      const bases = platformBaseDomains(env);
      const hostnameReport = await reconcilePendingHostnames({
        admin: host.admin,
        actor: SWEEP_ACTOR,
        provisioner,
        isCustom: (h) => isCustomHostname(h, bases),
      });
      if (hostnameReport.activated || hostnameReport.failed || hostnameReport.created || hostnameReport.healed || hostnameReport.orphaned || hostnameReport.errors.length) {
        console.log('hostname-reconcile', hostnameReport);
      }
    }

    // #40 — the platform's own disaster recovery. LAST in the pass, deliberately: the
    // phases above mutate the directory (reaps, hostname transitions, intent settling),
    // so a copy taken after them is a copy of a settled directory rather than of one
    // mid-sweep. The cadence guard lives in `backupDirectoryIfDue` and reads the newest
    // stored copy, so a quarter-hourly cron takes one a day and a missed tick means the
    // next pass takes it late instead of never.
    //
    // A failure here is logged, not thrown: it must not sink the sweep (the drain and
    // reap phases above are what keep the fleet moving), but it must be LOUD, because a
    // backup that has been quietly failing is worse than no backup — it is a false
    // belief. `GET /api/directory/backups` is where that belief gets checked.
    if (env.DIRECTORY_BACKUPS) {
      try {
        const backup = await backupDirectoryIfDue({
          admin: host.admin,
          store: createR2DirectoryBackupStore(env.DIRECTORY_BACKUPS),
          actor: SWEEP_ACTOR,
        });
        if (backup.taken || backup.pruned) console.log('directory-backup', backup);
      } catch (err) {
        console.error('directory-backup failed', err instanceof Error ? err.message : String(err));
      }
    }

    // #557 — the stored-copy lifecycle rule, the retention leg #36 left unmade. Both
    // windows are opt-in (unset ⇒ every copy kept forever), the same posture as the two
    // reap windows: the platform never deletes evidence on a schedule a human did not
    // choose. `directory/` copies are not here — their 30-copy window has lived in
    // `backupDirectoryIfDue` since #40. Contained like the backup above: a failed prune
    // must not sink the sweep, but it must be loud, because a lifecycle rule that has
    // been quietly failing is a cost leak wearing a policy's name.
    try {
      const scopeBackupDays = parseRetentionDays(env.SCOPE_BACKUP_RETENTION_DAYS);
      const accessLogDays = parseRetentionDays(env.ACCESS_LOG_RETENTION_DAYS);
      const scopeCopies =
        scopeBackupDays !== undefined && env.SCOPE_BACKUPS
          ? await pruneScopeBackups(env.SCOPE_BACKUPS, { olderThanDays: scopeBackupDays })
          : 0;
      const accessLogBatches =
        accessLogDays !== undefined && env.DIRECTORY_BACKUPS
          ? await pruneAccessLogBatches(env.DIRECTORY_BACKUPS, { olderThanDays: accessLogDays })
          : 0;
      if (scopeCopies || accessLogBatches) {
        console.log('stored-copy-retention', { scopeCopies, accessLogBatches });
      }
    } catch (err) {
      console.error(
        'stored-copy-retention failed',
        err instanceof Error ? err.message : String(err),
      );
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

    // The builder studio's membership lookup (builder-plane.md §4). The studio worker
    // verifies its OWN OIDC session (its session secret is not this worker's, so it
    // cannot ride `/api/auth/whoami`), then asks this directory which tenants that
    // login builds for — the same `builderTenantsFor` read whoami does session-side.
    // Service-token gated, the dashboard's credential class: an unset token refuses,
    // never bypasses, and the response is directory facts only (id, slug, name).
    app.post('/internal/builder/identity-tenants', async (c) => {
      const gate = c.env.SERVICE_TOKEN
        ? await serviceTokenAuth(c.env.SERVICE_TOKEN, SERVICE_ACTOR)(c.req.raw)
        : null;
      if (!gate) return c.json({ error: 'service token required' }, 403);
      const body = (await c.req.json().catch(() => ({}))) as { externalId?: unknown };
      if (typeof body.externalId !== 'string' || body.externalId === '') {
        return c.json({ error: 'externalId (the OIDC subject) is required' }, 400);
      }
      return c.json({ tenants: await builderTenantsFor(hostFor(c.env), { id: body.externalId }) });
    });

    // The router kick (platform-intents.md §"router kick"). When a vertical's response
    // carried `x-substrat-platform-request`, the router — the one hop that already knows the
    // resolved (tenant, scope) — calls this to drain that scope's intents NOW, turning the
    // ~2-min sweep latency into seconds. Platform-secret gated (an unset secret refuses, never
    // bypasses). The body only NAMES which scope to drain: the tenant/vertical are re-derived
    // from this directory's own record and the intents run are the scope's own, so a caller with
    // the global secret can at most accelerate a scope's own pending work — never act across it.
    app.post('/internal/drain-scope', async (c) => {
      try {
        assertPlatformCall(c.req.raw.headers, { expectedSecret: c.env.PLATFORM_SECRET });
      } catch (e) {
        if (e instanceof PlatformCallError) return c.json({ error: e.message }, 403);
        throw e;
      }
      const body = (await c.req.json().catch(() => ({}))) as { tenantId?: unknown; scopeId?: unknown };
      const ids = tenantId.safeParse(body.tenantId);
      const sids = scopeId.safeParse(body.scopeId);
      if (!ids.success || !sids.success) {
        return c.json({ error: 'tenantId and scopeId (ULIDs) are required' }, 400);
      }
      // Runs inline: the router backgrounds this call with `ctx.waitUntil`, so completing the
      // drain here is what keeps the subrequest alive long enough to actually settle the intents.
      const report = await drainOneScope(c.env, ids.data, sids.data);
      return c.json(report);
    });

    // The email relay (#303). A hosted vertical that holds the `emailSender` grant cannot send
    // mail itself — a WfP dispatch script has no `send_email` binding and the §4 sandbox refuses
    // one — so it POSTs the message here and the control plane, the one worker holding an outbound
    // credential, sends it. Platform-secret gated: the vertical presents its injected
    // PLATFORM_SECRET. That secret is shared across every dispatch script, so it only proves "a
    // platform script is calling" — WHICH vertical is re-derived from THIS directory's record for
    // the named scope, and the `emailSender` grant is checked against that vertical. So a script
    // that holds the secret but lacks the grant is still refused, and the FROM address is always
    // the platform's onboarded sender, never the caller's choice.
    app.post('/internal/email/send', async (c) => {
      try {
        assertPlatformCall(c.req.raw.headers, { expectedSecret: c.env.PLATFORM_SECRET });
      } catch (e) {
        if (e instanceof PlatformCallError) return c.json({ error: e.message }, 403);
        throw e;
      }
      const parsed = emailRelayRequest.safeParse(await c.req.json().catch(() => ({})));
      if (!parsed.success) {
        return c.json({ error: 'tenantId, scopeId (ULIDs) and {to, subject, html, text} are required' }, 400);
      }
      const { tenantId: t, scopeId: s, to, subject, html, text, fromName } = parsed.data;
      const host = hostFor(c.env);
      const rec = await host.admin.getScopeRecord(SWEEP_ACTOR, t, s);
      if (!rec?.vertical) return c.json({ error: 'scope has no vertical bound' }, 404);
      const registered = (await host.admin.listVerticals(SWEEP_ACTOR)).find((v) => v.slug === rec.vertical);
      if (!registered?.emailSender) {
        return c.json(
          {
            error: `vertical '${rec.vertical}' does not hold the email-sender capability — staff grants it in the console (setVerticalEmailSender)`,
          },
          403,
        );
      }
      const result = await transportFor(c.env).send({
        to,
        from: senderFor(c.env, fromName),
        subject,
        html,
        text,
      });
      return c.json({ sent: true, ...result });
    });

    // The connection relay (connections.md §3.5.2) — a tenant admin connects a provider
    // from the vertical's OWN admin screen: the vertical permission-checks the act
    // (`ctx.check`), returns the pasted credential as a harness-side effect, and the
    // harness POSTs it here for the platform to seal into the connection store — create,
    // or rotate in place when the connection is already live. Same trust posture as the
    // email relay above: the shared PLATFORM_SECRET only proves "a platform script is
    // calling"; WHICH vertical is re-derived from this directory's scope record, so a
    // caller can never plant a credential on a foreign vertical, and the store's own
    // guards pin every grant inside the connection's (tenant, vertical). The credential
    // is plaintext for the length of this call and never rests anywhere unsealed — the
    // reason this is a relay and not a platform-request intent (an intent payload lives
    // in the scope's spine, and with it in every export, backup, and PITR window).
    app.post('/internal/connections/upsert', async (c) => {
      try {
        assertPlatformCall(c.req.raw.headers, { expectedSecret: c.env.PLATFORM_SECRET });
      } catch (e) {
        if (e instanceof PlatformCallError) return c.json({ error: e.message }, 403);
        throw e;
      }
      try {
        const result = await relayConnectionUpsert(
          hostFor(c.env),
          CONNECTION_RELAY_ACTOR,
          await c.req.json().catch(() => ({})),
          // #605: a vertical's own admin screen gets the same connect-time gate the
          // dashboard does — a credential Scrive refuses never reaches the store.
          {
            probeCandidate: (provider, secret) =>
              Promise.resolve(
                connectionInspectorsFor(c.env)[provider]?.probeCandidate?.(secret),
              ),
          },
        );
        return c.json(result);
      } catch (e) {
        if (e instanceof ConnectionRelayError) {
          return c.json({ error: e.message, ...(e.probe ? { probe: e.probe } : {}) }, e.status);
        }
        throw e;
      }
    });

    // The Scrive webhook ingress (#574 phase 2, #96): for a CP-less dispatch vertical the
    // capability URL terminates HERE, not on the vertical — the dispatch ledger the token is
    // verified against lives in THIS directory (ControlPlaneDO connector state), and a pushed
    // script must never hold it. Unauthenticated by design: Scrive signs nothing, so the
    // per-dispatch token minted into the URL is the entire authentication, compared in
    // constant time against the ledger row. On a match the same reconcile the sweep runs
    // re-reads the provider's truth and records it back through the vertical's
    // `/internal/connector-*` surface (the host's connectorDelegation) — push collapses the
    // sweep's latency, never replaces it. Every rejection is one uniform 404 (the WHY stays
    // in the log), so the response is no oracle for probing which instances exist, and
    // nothing short of a verified token causes provider egress.
    app.post(SCRIVE_CALLBACK_ROUTE, async (c) => {
      const ref = c.req.param();
      try {
        const outcome = await handleScriveCallback(hostFor(c.env), ref, {
          fetch: globalThis.fetch as unknown as FetchLike,
          baseUrl: c.env.SCRIVE_BASE_URL,
        });
        if (!outcome.accepted) {
          console.log(`[scrive-callback] rejected (${outcome.reason})`);
          return c.json({ error: 'not found' }, 404);
        }
        const { recorded, complete, documentStatus } = outcome.result;
        console.log(
          `[scrive-callback] ${ref.instanceId}: recorded ${recorded.length}, status ${documentStatus}${complete ? ', complete' : ''}`,
        );
        return c.json({ ok: true });
      } catch (err) {
        // Verified but the reconcile failed (provider hiccup, a vertical deployment out of
        // reach): 500 so Scrive retries; the poll floor covers whatever push drops.
        console.error('[scrive-callback] reconcile failed', err);
        return c.json({ error: 'reconcile failed' }, 500);
      }
    });

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
        fetchVerticalAsset: fetchVerticalAssetFor(env),
        patchScriptBindings: patchScriptBindingsFor(env),
        observability: observabilityFor(env),
        // #605: the same connector closure the dispatch and the sweep already use, in its
        // third role — answering FOR a connection instead of acting through one. The
        // control plane is the only place that can: it holds the directory, the secret
        // box, and the sanctioned egress. Keyed by provider, so `control-plane-api`
        // learns no Scrive vocabulary and an unwired provider 501s honestly.
        connectionInspectors: connectionInspectorsFor(env),
        // Where the refs the console shows actually resolve, so staff get a link into the
        // Cloudflare dashboard instead of an id to hunt for. Account id + namespace only —
        // no credential — and absent when the account is not configured, which is the
        // self-host shape (the console then renders plain identifiers).
        platformRuntime: platformRuntimeFor(env),
        doNamespaces: doNamespacesFor(env),
        // #493 — the recoverable copy a reap leaves behind. Undefined when the bucket
        // is not bound, which is what makes an asked-for backup refuse rather than
        // silently skip.
        ...(env.SCOPE_BACKUPS ? { scopeBackups: createR2BackupStore(env.SCOPE_BACKUPS) } : {}),
        // #40 — the platform's own copy. Same absent-means-501 posture as the scope
        // store above: a control plane running with no directory backup should say so
        // when asked, not answer an empty list that reads like "nothing to restore".
        ...(env.DIRECTORY_BACKUPS
          ? { directoryBackups: createR2DirectoryBackupStore(env.DIRECTORY_BACKUPS) }
          : {}),
        // #305 §4.7 — a custom-domain bind drives Cloudflare-for-SaaS issuance; a
        // platform mint under one of these base domains rides the wildcard.
        provisionHostname: provisionHostnameFor(env),
        platformBaseDomains: platformBaseDomains(env),
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
