import { Hono } from 'hono';
import type { Context } from 'hono';
import {
  parseHostname,
  withLabel,
  RESERVED_LABEL_SEPARATOR,
  adminAction,
  ASSET_PART_PREFIX,
  assetHash,
  channelName,
  connectionActivity,
  connectionActivitySource,
  connectionCredential,
  connectionFilter,
  connectionProbe,
  createTenantInput,
  entitlementGrantInput,
  hostname as hostnameSchema,
  hostnameRegion,
  hostnameStatus,
  identityLink,
  listPageQuery,
  matchesOutboundHost,
  pageOf,
  platformRequestFilter,
  principalId as principalIdSchema,
  promotionAcknowledgement,
  provisionableJurisdiction,
  publishVersionInput,
  queryScopeInput,
  readScopeTableInput,
  DEFAULT_DENIAL_LIMIT,
  DENIAL_LIMIT_MAX,
  registerVerticalInput,
  scopeDump,
  dataSubjectId as dataSubjectIdSchema,
  scopeId as scopeIdSchema,
  scopeStatus,
  storageShape,
  surfaceName,
  tenantId as tenantIdSchema,
  tenantStatus,
  versionOrigin,
  z,
  PROBLEM_CONTENT_TYPE,
  toProblem,
} from '@substrat-run/contracts';
import type {
  Connection,
  ConnectionActivity,
  ConnectionActivitySource,
  ConnectionCredential,
  ConnectionProbe,
  ListPageQuery,
  Page,
  PlatformActorId,
  Scope,
  ScopeDump,
  ScopeId,
  TenantExport,
  TenantId,
} from '@substrat-run/contracts';
import type { OpsFailureInput, ScopeHost } from '@substrat-run/kernel';
import { migrationProgress, ulid } from '@substrat-run/kernel';
import { TENANT_HEADER } from './auth.js';
import type { PlatformActorAuth, BuilderAuth, Principal } from './auth.js';
import { connectionGrantsForScope, type VerticalClient } from './vertical-client.js';
import { reconcileConnectionGrants } from './connection-grants.js';
import { ConnectionRelayError, relayConnectionUpsert } from './connection-relay.js';
import { ControlPlaneError } from './client.js';
import { provisionSiblingScope } from './platform-drain.js';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { mapError, type ApiError } from './errors.js';
import { maskDump, maskRecords } from './mask.js';
import { openDump, sealDump, type SubjectSealer } from './seal.js';
import {
  assertSandboxContract,
  deployManifest,
  storedDeployManifest,
  deploymentRefFor,
  stableDeploymentRefFor,
  nextMigrationTag,
  upstreamStatusOf,
} from './deploy.js';
import type {
  AssetUpload,
  DeployVerticalFn,
  FetchVerticalAssetFn,
  FetchVerticalModulesFn,
} from './deploy.js';
import type { PatchScriptBindingsFn } from './wfp.js';

/**
 * Answer with a problem document (#113 phase 4).
 *
 * `c.body` rather than `c.json`, because the media type is the contract: a response
 * labelled `application/json` is not an RFC 9457 problem however well-shaped its body is,
 * and `/openapi.json` has documented `application/problem+json` on every error response
 * since phase 1 — this is the half that makes the document true.
 */
function problem(c: Context, answer: ApiError): Response {
  return c.body(JSON.stringify(answer.body), answer.status, {
    'content-type': PROBLEM_CONTENT_TYPE,
  });
}
import {
  backfillDeclaredStores,
  blobStoreBindings,
  collectBlobStoreHandles,
  collectTenantStoreHandles,
  missingStoresForTenant,
  tenantStoreBindings,
  type MintedStore,
} from './tenant-stores.js';
import { mintPushToken, pushActorFor } from './push-token.js';
import type { ObservabilityReader } from './observability.js';
import type { PlatformRuntime } from './platform-runtime.js';
import { namespacesForScript, type DoNamespaceReader } from './do-namespaces.js';
import type {
  DirectoryBackup,
  DirectoryBackupStore,
  ScopeBackup,
  ScopeBackupStore,
} from './backups.js';
import { backupDirectoryIfDue } from './directory-backup.js';
import {
  isCustomHostname,
  validateBindableHostname,
  type CustomHostnameProvisioner,
} from './custom-hostnames.js';

/**
 * What one provider can answer about a live connection (#605) — the seam behind
 * `POST /tenants/:t/connections/:id/verify` and `GET …/activity`.
 *
 * Both halves take the connection ROW, never a credential: opening the secret is the
 * connector's own act through `HostAdmin`, so the plaintext still never crosses this
 * package. `probe` says whether the provider accepts the credential and whose account
 * it is; `activity` projects the connector's dispatch ledger into the declared shape —
 * a projection precisely because a raw ledger row may carry connector secrets (Scrive's
 * callback capability token), and redaction has to be structural.
 */
export interface ConnectionInspector {
  probe?: (host: ScopeHost, connection: Connection) => Promise<ConnectionProbe>;
  activity?: (
    host: ScopeHost,
    connection: Connection,
    opts: { live: boolean; source: ConnectionActivitySource },
  ) => Promise<ConnectionActivity>;
  /**
   * The stored credential, REDUCED — identifiers whole, secrets masked by the connector's
   * own rule. The one read in this package's vicinity that touches plaintext, and it is
   * the connector that touches it: only the connector knows which of its fields are
   * identifiers. What comes back is never usable as a credential.
   */
  credential?: (host: ScopeHost, connection: Connection) => Promise<ConnectionCredential>;
  /**
   * Check a credential that is not stored yet — the connect-time gate (#605).
   *
   * Distinct from `probe` because there is nothing to open: the candidate secret is passed
   * straight in, no connection row is touched, and no health is written (a candidate's
   * failure is not a fact about the live connection). Registered ⇒ every upsert of this
   * provider is checked before it writes, and a REFUSED credential never lands.
   */
  probeCandidate?: (secret: Record<string, string>) => Promise<ConnectionProbe>;
}

export interface ControlPlaneApiOptions {
  /**
   * The platform's margin over list price for model usage it provides (#1054), whole
   * percent, applied at read time by `GET /model-usage/summary`. One global number
   * today; a per-provider rate is an additive change later. Default 20.
   */
  modelMarginPercent?: number;
  host: ScopeHost;
  /**
   * How to reach each vertical, by slug (K-31). Absent slugs simply cannot be
   * provisioned — the route 501s rather than pretending, because a control plane that
   * silently does nothing is worse than one that says it cannot.
   *
   * A static map is the milestone-one shape, the same one the router carries and with
   * the same Workers-for-Platforms swap later.
   */
  verticals?: Record<string, VerticalClient>;
  /**
   * The standing grants each connector declares, by provider (#726 gap 2) — e.g.
   * `{ scrive: SCRIVE_CONNECTION_GRANTS }`.
   *
   * Every reconcile heals a connection toward this floor before gathering, which is what
   * makes a missing capability repairable by a PUSH rather than by re-typing a working
   * credential. Absent ⇒ nothing is healed and the gather behaves exactly as before, so a
   * host that configures no connectors is unaffected.
   */
  connectorGrants?: Readonly<Record<string, readonly string[]>>;
  /**
   * Resolves a vertical dynamically — the dispatch swap for provisioning (orchestration.md
   * §5.4), the mirror of the router's `verticalFor`. Given a slug, the host looks up the
   * vertical's `prod` channel version and returns a `VerticalClient` over
   * `env.DISPATCH.get(deploymentRef)`. Tried after the static `verticals` map, so a
   * pushed vertical is provisionable with no redeploy. Absent ⇒ only static bindings.
   */
  resolveVertical?: (slug: string, actor: PlatformActorId) => Promise<VerticalClient | undefined>;
  /**
   * Resolves a vertical at a SPECIFIC version — a scope's data DO lives in the
   * deployment of the version it was provisioned/bound to (`scope.verticalVersionId`),
   * NOT necessarily the `prod` channel. Because each `substrat push` is a separate WfP
   * script with its own DO namespace, introspection must reach the BOUND version's
   * deployment (the same one the router serves the app from), or it reads an empty DO
   * once an installed app lags prod. The `/tables` route prefers this over
   * `resolveVertical`; the latter (prod) stays the fallback for a scope with no bound
   * version. Absent ⇒ the route uses prod-channel/static resolution only.
   */
  resolveVerticalVersion?: (
    slug: string,
    versionId: string,
    actor: PlatformActorId,
  ) => Promise<VerticalClient | undefined>;
  /**
   * Resolves a vertical by a KNOWN dispatch script name (#286) — the direct form the
   * other two resolvers reduce to. Introspection and restore use it for a scope whose
   * `servingRef` is set: that scope's data lives in the stable serving script, and
   * neither the bound version's script (data left behind) nor the prod channel (may
   * have moved on) is the right door. Absent ⇒ serving scopes fall back to the other
   * resolvers, which is only correct before any scope has adopted the serving script.
   */
  resolveVerticalRef?: (deploymentRef: string) => Promise<VerticalClient | undefined>;
  /**
   * Uploads a built vertical bundle to the platform runtime (a WfP dispatch
   * namespace), injected by the host so this package holds no Cloudflare SDK and the
   * builder never holds a Cloudflare credential (D-34). Absent ⇒ the deploy route
   * 501s. See `deploy.ts`.
   */
  deployVertical?: DeployVerticalFn;
  /**
   * Reads a script's module contents back from the platform runtime (#286) — the
   * archive script is the bundle store the serving upload reads from. Host-injected
   * like `deployVertical`. Absent ⇒ promotion moves channels without serving in
   * place (the pre-#286 behavior: scopes stay on per-version dispatch).
   */
  fetchVerticalModules?: FetchVerticalModulesFn;
  /**
   * Reads one static file's bytes back from a script in the namespace (#578) — the
   * asset twin of `fetchVerticalModules`. The runtime's asset store dedupes per
   * SCRIPT, not namespace-wide, so the first serve of an asset-carrying version onto
   * the stable serving script always finds its hashes missing there; this seam is how
   * the serve recovers the bytes the push uploaded to the version's archive script.
   * Host-injected like `deployVertical` (on Cloudflare, a dispatch fetch — the archive
   * script's edge serves its own assets without invoking the worker). Absent ⇒ a
   * re-serve can only ride what the stable script already holds and refuses honestly
   * otherwise.
   */
  fetchVerticalAsset?: FetchVerticalAssetFn;
  /**
   * Ensures per-tenant store D1 bindings exist on a dispatch script without a redeploy
   * (#301) — the attach step that makes a freshly-minted tenant store reachable in the
   * vertical's worker at request time (`createWfpBindingsPatcher`). Host-injected like
   * `deployVertical`. Absent ⇒ stores still mint and handles still ride the provision
   * callback (the pure adapter needs no binding), but no script is patched.
   */
  patchScriptBindings?: PatchScriptBindingsFn;
  /**
   * Backoff for retrying a TRANSIENT vertical failure during install (#424 case 2).
   * The install chain patches script bindings and then immediately calls the vertical,
   * which can race Cloudflare script-settings propagation — the vertical answers 503
   * "no tenant store attached" moments before it would have succeeded. Every step is
   * idempotent by design, so the endpoint rides that window out instead of surfacing a
   * one-shot failure. Honest refusals (any 4xx, and 501) are never retried. Tests pass
   * short/empty.
   */
  provisionRetryDelaysMs?: readonly number[];
  /**
   * Resolves the platform actor from the request. No default: an unauthenticated
   * control plane is not a sensible fallback, and a package that shipped one
   * would eventually be deployed with it (control-plane.md §6).
   */
  authenticate: PlatformActorAuth;
  /**
   * Resolves a BUILDER principal — a tenant user acting on their own verticals
   * (builder-plane.md §4). Tried only after `authenticate` declines, so staff and
   * service auth are unchanged and remain a superset. Absent ⇒ no builder path:
   * the surface is staff/service-only exactly as before. A builder is confined to
   * the vertical-management routes and to the verticals their tenant owns.
   */
  authenticateBuilder?: BuilderAuth;
  /**
   * Signs tenant-scoped push tokens (push-token.ts) — the CI credential the dashboard
   * mints into a customer repo. Absent ⇒ the mint route 501s. A dedicated secret,
   * never PLATFORM_SECRET (injected into pushed verticals) and never the service
   * token; set once, out of routine rotation (rotating it revokes every issued token).
   */
  pushTokenSecret?: string;
  /**
   * Cloudflare-native observability reads (design/observability.md §4.1) —
   * host-injected like `deployVertical`, so this package holds no credential and the
   * Cloudflare token never leaves the platform (D-34). Absent ⇒ the observability
   * routes 501. Staff-only for now: the routes are deliberately NOT in
   * `BUILDER_ROUTES` — the builder view needs owner-narrowing (only scripts whose
   * registry `ownerTenant` is the caller's) before it can be opened, and default-deny
   * means forgetting that costs a feature, never a leak.
   */
  observability?: ObservabilityReader;
  /**
   * Per-provider connection **inspectors** (#605), keyed by provider slug — what makes
   * an integration something an operator can interrogate rather than trust.
   *
   * Host-injected for the same reason `deployVertical` and `observability` are: this
   * package holds no connector and must learn no provider's vocabulary. The host wires
   * the same connector closure it already registers for dispatch and sweep (the
   * `sweepers` idiom, `apps/control-plane/src/worker.ts`), and the routes below stay
   * pure transport over a declared, provider-agnostic shape.
   *
   * An unregistered provider 501s rather than answering emptily — "this platform cannot
   * verify a Fortnox key yet" is a true statement; "your Fortnox key is fine" is not.
   */
  connectionInspectors?: Record<string, ConnectionInspector>;
  /**
   * Where this platform's compute actually runs — the coordinates a staff surface needs
   * to hand an operator a link INTO the provider's own console (the right script, the
   * right database, the right bucket), rather than a bare id they have to hunt for.
   *
   * Host-injected like `observability`, and deliberately NOT a credential: it is the
   * account/namespace the deployment already advertises in every dispatch URL. Absent ⇒
   * the route answers `null` and the console renders identifiers with no links, which is
   * exactly the self-host / pure-adapter shape (no provider console to point at).
   */
  platformRuntime?: PlatformRuntime;
  /**
   * Resolves a script's Durable Object namespaces to the ids the provider's dashboard
   * addresses them by (`do-namespaces.ts`) — what turns "your DO is named `<scopeId>`,
   * somewhere in this list" into a link to the right namespace. Host-injected, credential
   * on the host side. Absent ⇒ the route 501s and the console keeps its list-level link.
   */
  doNamespaces?: DoNamespaceReader;
  /**
   * Where a reap's recoverable copy is stored (#493) — host-injected like
   * `observability`, so this package holds no bucket binding. When present, reaping a
   * scope writes a full-fidelity dump here FIRST and records its ref on the admin-log
   * entry; a store that throws aborts the reap, because a wipe with no copy is exactly
   * what the seam exists to prevent.
   *
   * Absent ⇒ a reap that did not explicitly ask for a backup proceeds without one (the
   * self-host / embedded / test shape, where there is no platform bucket), and one that
   * DID ask is refused 501 rather than silently reaping. That asymmetry is deliberate:
   * the console always asks, so a control plane deployed with the binding missing fails
   * loudly instead of quietly dropping the guarantee — the lesson `PLATFORM_BASE_DOMAINS`
   * taught when it silently went unset.
   */
  scopeBackups?: ScopeBackupStore;
  /**
   * Where the platform's OWN copies live (#40) — the directory, not a tenant's scope.
   * Host-injected on the same posture as `scopeBackups`, and pointable at the same
   * bucket (the key prefixes keep the two apart) or at a different one.
   *
   * Absent ⇒ the directory backup routes answer 501 and the cron's backup phase is
   * skipped. Loud, never silent: a control plane running with no directory copy is a
   * platform one bug away from unrecoverable, and that must be visible rather than
   * inferred from an absence of backups nobody looked for.
   */
  directoryBackups?: DirectoryBackupStore;
  /**
   * Issues + polls Cloudflare-for-SaaS custom hostnames (#305, §4.7) — host-injected
   * like `deployVertical`, so this package holds no Cloudflare credential (D-34). When
   * present, binding a CUSTOM domain kicks off issuance (create → `verifying` + DNS
   * records) instead of leaving a bare `pending` row that only a manual status flip
   * could clear. Absent ⇒ a custom bind records `pending` and issuance never runs (the
   * self-host / dev shape, where there is no CF-for-SaaS zone).
   */
  provisionHostname?: CustomHostnameProvisioner;
  /**
   * The platform's base domains — the wildcard-covered zones a PLATFORM hostname is
   * minted under (`substrat.run`, `global.substrat.run`, …). A bind AT or UNDER one of
   * these rides the wildcard cert and goes straight to `active`; anything else is a
   * custom domain and walks issuance. Empty/absent ⇒ every bind is treated as custom
   * (correct for a deployment that mints no platform hostnames).
   */
  platformBaseDomains?: string[];
}

// `actor` is the audited subject for every HostAdmin call (staff or builder alike).
// `principal` carries the authz distinction the builder routes read. Both are set by
// the auth middleware; keeping `actor` means every existing route is untouched.
type Vars = { actor: PlatformActorId; principal: Principal };

// -- request schemas ---------------------------------------------------------
// Parse, don't trust: every input crosses Zod at the boundary. The ids stay
// CALLER-SUPPLIED rather than minted here, exactly as the contract has them —
// that is what keeps `createTenant`/`provisionScope` idempotent (§3.3: "safe to
// re-run"). Minting server-side would be friendlier and would silently turn a
// retry into a second tenant. This surface is a transport; it does not invent
// semantics on top of HostAdmin.

const provisionScopeBody = z.object({
  tenantId: tenantIdSchema,
  scopeId: scopeIdSchema,
  slug: z.string().optional(),
  kind: z.string().optional(),
  name: z.string().optional(),
  vertical: z.string().nullable().optional(),
  storageShape: storageShape.optional(),
  // The gate: only `global` is accepted until `eu`/`us` enforcement exists (K-32).
  // A request naming a jurisdiction we cannot yet honour is refused at the Zod
  // boundary with 400, rather than recorded as a residency claim with no mechanism.
  jurisdiction: provisionableJurisdiction.optional(),
});

const setTenantStatusBody = z.object({ status: tenantStatus });

const provisionInstanceBody = z.object({
  tenantId: tenantIdSchema,
  scopeId: scopeIdSchema,
  owner: z.string().min(1),
  slug: z.string().min(1),
  name: z.string().min(1),
  config: z.record(z.string(), z.string()).optional(),
});

// A SIBLING scope added to an app the tenant already runs (multi-scope self-serve, M1 of
// multi-scope-manyfold.md). `parentScopeId` is the existing app scope: it authorizes the add
// (the tenant already runs this vertical) and donates the vertical + jurisdiction, so the
// caller can never name a vertical it doesn't already have. `owner` is the vertical-domain
// principal to seat as the new scope's owner (the same person who installed the app).
const addSiblingScopeBody = z.object({
  scopeId: scopeIdSchema,
  parentScopeId: scopeIdSchema,
  owner: z.string().min(1),
  slug: z.string().min(1),
  name: z.string().min(1),
});

const configureInstanceBody = z.object({
  entries: z.array(z.object({ key: z.string().min(1), value: z.string() })).min(1),
});

const bindHostnameBody = z.object({
  hostname: hostnameSchema,
  tenantId: tenantIdSchema,
  scopeId: scopeIdSchema,
  surface: surfaceName,
  region: hostnameRegion.optional().default(null),
  canonical: z.boolean().optional().default(false),
});

const setHostnameStatusBody = z.object({
  status: hostnameStatus,
  note: z.string().optional(),
});

const listHostnamesQuery = z.object({
  tenantId: tenantIdSchema.optional(),
  scopeId: scopeIdSchema.optional(),
});

// Every GET list below shares ONE pagination convention (contracts pagination.ts):
// keyset over the list's own sort key, `limit` DEFAULTED at this egress (the kernel
// reads stay unbounded for in-process callers — the admin-log precedent, generalized),
// `{ entries, nextCursor }` out. The cursor is the last entry's sort key verbatim.
const pageParams = (c: { req: { query(key: string): string | undefined } }): ListPageQuery =>
  listPageQuery.parse({
    limit: c.req.query('limit'),
    cursor: c.req.query('cursor'),
    order: c.req.query('order'),
  });

/**
 * Page an already-materialized asc-sorted list — for the one read whose principal
 * narrowing runs ABOVE the adapter (`GET /verticals`), where a pushed-down page
 * would terminate early. Same cursor semantics as the keyset reads.
 */
const pageSlice = <T>(rows: T[], page: ListPageQuery, key: (row: T) => string): Page<T> => {
  const found = page.cursor === undefined ? 0 : rows.findIndex((r) => key(r) > page.cursor!);
  const from = found === -1 ? rows.length : found;
  const entries = rows.slice(from, from + page.limit);
  return {
    entries,
    nextCursor: from + page.limit < rows.length ? key(entries[entries.length - 1]!) : null,
  };
};

/** Repeatable query params arrive as `?status=active&status=suspended`. */
const listScopesQuery = z.object({
  tenantId: tenantIdSchema.optional(),
  status: z.array(scopeStatus).optional(),
  vertical: z.string().optional(),
});

const fleetMigrationsQuery = z.object({ vertical: z.string().min(1).optional() });

// -- vertical + version registry bodies (#31; orchestration.md §5.6) --------
// Each route below is a thin pass-through to a built `HostAdmin` method — the
// registry data model, admission and the digest-diff promotion gate already exist
// (registry.ts + both adapters). This surface exposes them; it adds no policy of its
// own. The `deploy` route (the uploader) is deliberately absent — that is Phase 2.

const rejectVersionBody = z.object({ note: z.string().min(1) });

const promoteVersionBody = z.object({
  versionId: z.string().min(1),
  // The two human checkpoints: promotion refuses a changed permission/migration
  // digest unless the matching flag is set. Optional because an unchanged digest
  // needs no acknowledgement.
  acknowledge: promotionAcknowledgement.optional(),
});

const bindScopeVersionBody = z.object({
  versionId: z.string().min(1),
  // Fork-before-promote (preview-and-snapshots.md §4): snapshot the pre-migration
  // data first when this bind crosses a migration-digest boundary. Optional and
  // ignored on a code-only rebind — the digest compare is the gate, not the flag.
  snapshot: z.boolean().optional(),
});

const rebindScopeVerticalBody = z.object({
  // The FULL registry id of the target lineage (e.g. `substrat-9yjbbn/manyfold`) —
  // staff address lineages by their exact id, never through a workspace prefix.
  vertical: z.string().min(1),
  // Cross-lineage migration histories are independent (#389): the digest gate below
  // refuses the rebind unless the scope's bound version and the target's serving
  // version carry the SAME migration digest — or the operator acknowledges having
  // read both migration surfaces. Same discipline as a promote's `--ack-migrations`.
  ackMigrations: z.boolean().optional(),
  // Rebind the DIRECTORY only — no export/restore. For a scope whose source script
  // predates the `/internal/export` surface (#236) and so cannot be dumped at all.
  // The data is not deleted: it stays on the source script, which remains the
  // backout copy exactly as in a carried rebind. The scope must be re-provisioned
  // on the target afterwards (`/verticals/:slug/instances` is idempotent, K-31).
  abandonData: z.boolean().optional(),
});

// A snapshot request (preview-and-snapshots.md §3/§9). `expiresAt` opts into the GC
// sweep; absent = pinned until deliberately deleted. `kind` defaults to 'archive'.
const snapshotScopeBody = z.object({
  kind: z.string().min(1).optional(),
  expiresAt: z.string().datetime({ offset: true }).optional(),
});

// A reap request (#493). `backup` is deliberately TRI-STATE, not a defaulted boolean:
//   true      — back up or refuse (the console always sends this, so a control plane
//               deployed without a backup store fails loudly instead of quietly wiping)
//   false     — the explicit "I accept an unrecoverable wipe"
//   undefined — back up if a store is configured, proceed without one if not, which is
//               what keeps every pre-#493 caller (and self-host) working unchanged
const reapScopeBody = z.object({
  backup: z.boolean().optional(),
});

// A directory-restore request (#40). `capturedAt` addresses the copy — there is one
// directory, so that is its whole address. `overwrite` is the guard against the
// dangerous case: replaying a restore onto a control plane that already recovered.
const restoreDirectoryBody = z.object({
  capturedAt: z.string().min(1),
  overwrite: z.boolean().optional(),
});

/**
 * How a stored backup is named in the admin log and to callers: the route that fetches
 * it. Store-neutral by construction — the R2 key scheme stays private to the store — and
 * an operator reading a reap entry gets an address they can actually GET, rather than a
 * bucket path they would have to know the platform's internals to use.
 */
function backupRefOf(b: ScopeBackup): string {
  return `/tenants/${b.tenantId}/scopes/${b.scopeId}/backups/${b.capturedAt}`;
}

// A per-PR preview request (preview-and-snapshots.md §2/§9 — the "run a new version
// against a fork of prod" slice). `tag` is a short DNS-safe label (`pr-123`): it names
// the preview both in its scope slug (`<vertical>--<tag>`) and in its hostname
// (`<label>--<tag>.<base>`), so lookup + teardown are by tag, not scope id. `versionId`
// is the just-pushed PR version to bind (a private vertical's push self-admits, so this
// is a self-serve bind — no admission relaxation). Idempotent on (tenant, vertical, tag):
// a re-run rebinds the new version onto the SAME fork so successive PR pushes roll their
// migrations forward on one copy (§4); `refresh` forces a fresh fork from prod instead.
const createPreviewBody = z.object({
  tag: z
    .string()
    .regex(/^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/, 'tag must be a short DNS-safe label, e.g. pr-123'),
  versionId: z.string().min(1),
  sourceScopeId: scopeIdSchema.optional(),
  // Clean-room (#509 ask (b)): provision an EMPTY scope instead of forking prod — so a
  // vertical's FIRST environment can be a throwaway preview, exactly when a fork has nothing
  // to copy. Mutually exclusive with `sourceScopeId`; a `--tag`'s reuse keeps whichever it was.
  empty: z.boolean().optional(),
  // Hours until the GC sweep may reap the fork. Absent = the 72h default; an explicit
  // `null` pins the fork until it is deliberately deleted — a long-lived preview
  // environment (a `--tag dev` scope CI re-pushes to). The deadline is (re)applied on
  // every create, reuse included, so activity keeps a preview alive (§9).
  ttlHours: z.number().int().positive().max(720).nullable().optional(),
  surface: surfaceName.optional(),
  refresh: z.boolean().optional(),
});

const listRolesQuery = z.object({
  tenantId: tenantIdSchema.optional(),
  // Free-form: a module id or 'vertical'. Not narrowed to the source union here
  // — an unknown source should return nothing, not 400. The console offers only
  // sources it has seen.
  source: z.string().optional(),
});

const auditLogQuery = z.object({
  tenantId: tenantIdSchema.optional(),
  scopeId: scopeIdSchema.optional(),
  actor: z.string().optional(),
  action: z.array(adminAction).optional(),
  since: z.string().optional(),
  until: z.string().optional(),
  // The shared page fields (contracts pagination.ts). Defaulted, not merely capped:
  // the admin log is append-only and never swept (the retention decision — it is the
  // compliance witness, control-plane.md §4.4/§4.8), so it only grows. An unbounded
  // `GET /admin-log` would dump the whole table; a default page keeps the external
  // read bounded while `nextCursor` still walks the entire log. The KERNEL call stays
  // deliberately unbounded (an in-process caller that wants everything asks for
  // everything) — only the HTTP egress vectors are bounded by default.
  ...listPageQuery.shape,
});

/**
 * The K-35 denial-log filter (#867). Bounded by default like every other HTTP read
 * here: the log's volume is attacker-influenceable by design (a probing client mints
 * rows), so an unbounded `GET` is exactly the wrong default.
 */
const denialLogQuery = z.object({
  actor: z.string().optional(),
  permission: z.string().optional(),
  operation: z.string().optional(),
  since: z.string().optional(),
  until: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(DENIAL_LIMIT_MAX).default(DEFAULT_DENIAL_LIMIT),
});

const opsFailuresQuery = z.object({
  tenantId: tenantIdSchema.optional(),
  scopeId: scopeIdSchema.optional(),
  vertical: z.string().optional(),
  operation: z.string().optional(),
  // Exact match — the lookup a CI log's `reference = <id>` line lands on.
  reference: z.string().optional(),
  since: z.string().optional(),
  until: z.string().optional(),
  // Bounded by default exactly as /admin-log, and for the same reason.
  ...listPageQuery.shape,
});

const modelUsageQuery = z.object({
  tenantId: tenantIdSchema.optional(),
  scopeId: scopeIdSchema.optional(),
  vertical: z.string().optional(),
  model: z.string().optional(),
  since: z.string().optional(),
  until: z.string().optional(),
  ...listPageQuery.shape,
});

/** The summary window: a half-open `[since, until)`; defaults to the current calendar month so far. */
const modelUsageSummaryQuery = z.object({
  tenantId: tenantIdSchema.optional(),
  since: z.string().optional(),
  until: z.string().optional(),
});

export const DEFAULT_MODEL_MARGIN_PERCENT = 20;

/** The upstream provider's trace handle, when a failure message carries one —
 *  Cloudflare's `internal error; reference = <id>` shape (#559). */
const UPSTREAM_REFERENCE = /\breference\s*=\s*([a-z0-9]+)/i;

/**
 * The audited HTTP surface over `HostAdmin` (control-plane.md §4.5).
 *
 * This is the OUT-OF-BAND control plane §3 argues for: it is not module code, it
 * never receives a `ctx`, and it never runs in a scope's serialization domain —
 * so `boundary-lint` is untouched (§7). It is one router over the kernel seam,
 * mounted by whichever transport is hosting it (a Node server locally, a Worker
 * holding the `controlPlane` binding on Cloudflare).
 *
 * Two rules hold everywhere below, and they are the reason this can exist at all:
 *
 * 1. **The actor comes from the authenticated request, never the body.** §4.4:
 *    every field of an audit row except before/after is stamped platform-side,
 *    "never supplied by the caller". A route that read an actor from JSON would
 *    make the entire trail forgeable, which is the one thing that must not be
 *    retrofitted (K-20). Note there is no route here that accepts an `actor`
 *    field at all — it is unrepresentable, not merely ignored.
 * 2. **Reads are exposed; enforcement writes are not.** defineRole / assignRole /
 *    grant / grantToOrg / addMember are on `HostAdmin` but get no route: the
 *    console's v1 job is the tenant registry, lifecycle, entitlements and
 *    history. The ONE exception is the identity-mirror pair under
 *    `/tenants/:tenantId/identities` (service/staff only): builder auth resolves
 *    a CLI session against THIS deployment's directory, but identity links are
 *    born in the Dashboard's own deployment — a different DO — so the dashboard
 *    mirrors them here. `resolveIdentity` especially stays off — it is the auth
 *    adapter's read path, not an admin surface.
 */
export function createControlPlaneApi(options: ControlPlaneApiOptions): Hono<{ Variables: Vars }> {
  const { host, authenticate, authenticateBuilder } = options;
  const admin = host.admin;
  const app = new Hono<{ Variables: Vars }>();

  // Fail closed, before any route runs: no principal, no reach. Staff/service first
  // (unchanged, a superset); a builder session only when staff declines.
  app.use('*', async (c, next) => {
    const staff = await authenticate(c.req.raw);
    let principal: Principal | null = staff ? { kind: 'staff', actor: staff } : null;
    if (!principal && authenticateBuilder) {
      const builder = await authenticateBuilder(c.req.raw);
      if (builder) {
        principal = {
          kind: 'builder',
          actor: builder.actor,
          tenantId: builder.tenantId,
          tenantSlug: builder.tenantSlug,
        };
      }
    }
    if (!principal) return c.json({ error: 'unauthenticated' }, 401);
    c.set('principal', principal);
    c.set('actor', principal.actor);
    await next();
  });

  // Confine a BUILDER to the vertical-management surface, fail-CLOSED (builder-plane.md
  // §4). Default-deny by design: a builder reaches only the routes on this allowlist,
  // and only for verticals its tenant owns (the per-route ownership checks below). A
  // route not listed here 403s for a builder — forgetting to allow one costs a feature,
  // never an escalation, which is why this is an allowlist rather than a set of guards
  // sprinkled on the staff-only routes (a forgotten guard there would fail OPEN). Staff
  // pass through untouched. The set deliberately excludes the staff-only
  // `versions/:id/{admit,reject}` and `.../instances`.
  //
  // Matched on the request path by SUFFIX from `/verticals` (a URL-encoded prefixed slug
  // has no literal `/`, so `[^/]+` covers it) — mount-independent: it works whether the app
  // is standalone (`/verticals/…`) or routed under `/api` in the worker (`/api/verticals/…`).
  // The `$` anchors deliberately exclude the staff-only `versions/:id/{admit,reject}` and
  // `.../instances`, which end in a different segment.
  const BUILDER_ROUTES: readonly { method: string; re: RegExp }[] = [
    { method: 'GET', re: /\/verticals$/ },
    { method: 'POST', re: /\/verticals$/ },
    { method: 'GET', re: /\/verticals\/[^/]+\/versions$/ },
    { method: 'POST', re: /\/verticals\/[^/]+\/versions$/ },
    // The declared permission registry of one version (D-39, #336) — owner-narrowed in the
    // handler like the versions list; the builder-facing Permissions tab reads it.
    { method: 'GET', re: /\/verticals\/[^/]+\/versions\/[^/]+\/registry$/ },
    { method: 'GET', re: /\/verticals\/[^/]+\/channels$/ },
    { method: 'GET', re: /\/verticals\/[^/]+\/channels\/[^/]+\/history$/ },
    { method: 'POST', re: /\/verticals\/[^/]+\/channels\/[^/]+\/promote$/ },
    { method: 'POST', re: /\/verticals\/[^/]+\/deploy$/ },
    // A builder REQUESTS publication of a vertical it owns (marketplace-publish.md §5); the
    // `listing` flip stays staff-only. Ownership is checked in the handler.
    { method: 'POST', re: /\/verticals\/[^/]+\/publish-request$/ },
    // The hostname map, tenant-narrowed (K-26 multi-surface exposure): a builder manages
    // bindings for ITS OWN scopes — the same power the dashboard already exercises for it
    // over the service token. Each handler narrows to the principal's tenant; an unknown
    // or foreign hostname reads as 404 (existence hiding, like the registry filter).
    { method: 'GET', re: /\/hostnames$/ },
    { method: 'POST', re: /\/hostnames$/ },
    { method: 'PATCH', re: /\/hostnames\/[^/]+\/status$/ },
    // Re-poll issuance ("check again") — self-serve for the scope's own tenant (#305).
    { method: 'POST', re: /\/hostnames\/[^/]+\/verify$/ },
    { method: 'DELETE', re: /\/hostnames\/[^/]+$/ },
    // Recover a scope stuck at "roles projected, zero tuples" (#332) — re-provision a scope the
    // builder's OWN vertical runs. Ownership is re-checked in the handler; the allowlist alone is
    // not authz.
    { method: 'POST', re: /\/scopes\/[^/]+\/provision$/ },
    // Directory READS for the builder's own installs (#424 CLI parity: `substrat installs`,
    // `substrat scope status`). Each handler narrows to the principal's tenant — the list
    // forces the filter, the per-scope reads hide a foreign tenant as 404 (K-3).
    { method: 'GET', re: /\/scopes$/ },
    { method: 'GET', re: /\/tenants\/[^/]+\/scopes\/[^/]+$/ },
    { method: 'GET', re: /\/tenants\/[^/]+\/scopes\/[^/]+\/health$/ },
    // The scope's platform-intent journal (#618) — "why did my connector fail?", answered
    // without the read-only SQL console. Tenant-narrowed in the handler like the health read.
    { method: 'GET', re: /\/tenants\/[^/]+\/scopes\/[^/]+\/intents$/ },
    // Add a SIBLING scope (a new "site") to an app the builder's own tenant already runs
    // (multi-scope self-serve, M1). Tenant-narrowed + parent-authorized in the handler; the
    // allowlist alone is not authz.
    { method: 'POST', re: /\/tenants\/[^/]+\/scopes$/ },
    // Per-PR preview instances of the builder's OWN (private) vertical (preview-and-snapshots.md
    // §2/§9). Create/list/reap forks bound to an unpromoted PR version — ownership + private-only
    // are re-checked in each handler; the allowlist alone is not authz.
    { method: 'POST', re: /\/verticals\/[^/]+\/previews$/ },
    { method: 'GET', re: /\/verticals\/[^/]+\/previews$/ },
    { method: 'DELETE', re: /\/verticals\/[^/]+\/previews\/[^/]+$/ },
    // The builder's slice of the ops-failure record (#559 step 5): why did MY deploy /
    // preview / provision fail. Tenant-narrowed in the handler (the forced-filter
    // pattern, like GET /scopes); the allowlist alone is not authz.
    { method: 'GET', re: /\/ops-failures$/ },
  ];
  app.use('*', async (c, next) => {
    if (c.get('principal').kind === 'builder') {
      const allowed = BUILDER_ROUTES.some((r) => r.method === c.req.method && r.re.test(c.req.path));
      if (!allowed) return c.json({ error: 'forbidden' }, 403);
    }
    await next();
  });

  // Fire-and-forget ops-failure write (#559): a recorder that throws must never
  // mask the failure it is recording, so every path through this swallows its own
  // errors. The upstream reference is extracted here — one place — so a caller
  // that only has the message still lands a searchable row.
  const recordFailure = (entry: OpsFailureInput): void => {
    void admin
      .recordOpsFailure({
        ...entry,
        reference: entry.reference ?? UPSTREAM_REFERENCE.exec(entry.message)?.[1] ?? null,
      })
      .catch(() => undefined);
  };

  // Rides out a transient downstream window: the install path's binding-attach →
  // script-settings propagation race (#424 case 2), and a one-shot DO storage blip
  // during an export→restore or snapshot copy (#559 (2)). Retrying is cheap at THESE
  // call sites specifically — the dump is already in memory and the far end is
  // drop-then-replay idempotent — unlike CI's retry, which burns a pushed version per
  // attempt. Honest refusals (4xx, and 501 = not implemented) surface immediately:
  // retrying a refusal only delays the real message. ~3s worst case on the default
  // delays, well inside a Worker request budget; a persistent fault still exhausts
  // and surfaces (and lands an ops-failure row via the paths that record).
  const PROVISION_RETRY_DELAYS_MS: readonly number[] = [750, 2500];
  const retryTransient = async <T>(fn: () => Promise<T>): Promise<T> => {
    const delays = options.provisionRetryDelaysMs ?? PROVISION_RETRY_DELAYS_MS;
    for (let attempt = 0; ; attempt++) {
      try {
        return await fn();
      } catch (e) {
        const transient =
          e instanceof ControlPlaneError && (e.status === 0 || (e.status >= 500 && e.status !== 501));
        const delay = delays[attempt];
        if (!transient || delay === undefined) throw e;
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  };

  // One error boundary for every route: adapters throw plain Errors, and each
  // one is a fail-closed refusal that must reach the caller as a status, not a
  // stack trace.
  app.onError((err, c) => {
    // A parse failure goes through the same builder as everything else (#113 phase 4):
    // `toProblem` maps zod's `issues` onto the declared `errors: [{ path, message }]`
    // extension, which is the shape the model documents and a client can act on. The raw
    // `issues` array it used to echo was zod's own, undocumented, and read by nobody.
    if (err instanceof z.ZodError) {
      return problem(c, { status: 400, body: toProblem(err, c.req.path) });
    }
    const { status, body } = mapError(err);
    // A 5xx is the PLATFORM failing — an unmapped throw, or a downstream vertical's
    // own 5xx passing through (a DO storage fault during a preview restore is the
    // founding case, #559) — so it lands a durable ops-failure row the console can
    // list and a `reference = <id>` search can find. 501 stays out: an honest
    // not-implemented is a capability statement, not a failure. 4xx stay out too:
    // they are refusals the caller can already read. Actor is unset only when the
    // throw happened before authentication — nothing worth recording refuses there.
    const actor = c.get('actor');
    if (status >= 500 && status !== 501 && actor) {
      recordFailure({
        actor,
        operation: `${c.req.method} ${c.req.routePath}`,
        vertical: c.req.param('slug') ? decodeURIComponent(c.req.param('slug')!) : null,
        tenantId: (c.req.param('tenantId') as OpsFailureInput['tenantId']) ?? null,
        scopeId: (c.req.param('scopeId') as OpsFailureInput['scopeId']) ?? null,
        status,
        message: err instanceof Error ? err.message : String(err),
      });
    }
    // A 500 is, by definition, a throw whose message `mapError` did not recognise — so the
    // client gets a GENERIC body that discloses nothing, and until now nothing recorded WHAT
    // threw either. That left every unmapped failure (e.g. a raw SQLite constraint from a
    // registry write, or a deploy that 500s with no detail) undiagnosable without reproducing
    // it. Log the real error + the request that provoked it, server-side only, so the worker
    // tail names the cause. Mapped 4xx are honest refusals — no log needed. A MAPPED 5xx
    // (the 503 for a plane with no seal key, #603) passes through here too: its body already
    // says what is wrong, and the tail line is what ties it to the request that hit it.
    if (status >= 500) {
      console.error('control-plane.unhandled', {
        method: c.req.method,
        path: c.req.path,
        detail: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      });
    }
    return problem(c, { status, body });
  });

  // -- tenant registry (§4.1) ------------------------------------------------

  app.get('/tenants', async (c) => {
    const page = pageParams(c);
    const entries = await admin.listTenants(c.get('actor'), page);
    return c.json(pageOf(entries, page.limit, (t) => t.id));
  });

  app.post('/tenants', async (c) => {
    const input = createTenantInput.parse(await c.req.json());
    // Provenance (#412) is a host-derived fact set ONLY by the provisioning drain
    // (from the manager scope's directory row) — never caller-supplied. A direct staff
    // create is first-class by definition, so force it null even if a body carries it,
    // so the field can't be forged into a false ownership relationship.
    await admin.createTenant(c.get('actor'), { ...input, provisionedByTenant: null });
    // Idempotent (§4.1): re-creating an existing tenant is a no-op, not an error,
    // so this reads back rather than reporting a create that may not have happened.
    return c.json(await admin.getTenant(c.get('actor'), input.id), 201);
  });

  app.get('/tenants/:tenantId', async (c) => {
    const tenantId = tenantIdSchema.parse(c.req.param('tenantId'));
    const tenant = await admin.getTenant(c.get('actor'), tenantId);
    if (!tenant) return c.json({ error: `unknown tenant: ${tenantId}` }, 404);
    return c.json(tenant);
  });

  // Display rename only — the slug stays put (registry ids `<tenantSlug>/<name>` and
  // pinned workspaces key on it). The dashboard's identity mirror uses this to keep
  // the shared directory's names in step with team renames (and to repair tenants
  // created at app-provision time with a placeholder name).
  app.patch('/tenants/:tenantId', async (c) => {
    const tenantId = tenantIdSchema.parse(c.req.param('tenantId'));
    const { name } = z.object({ name: z.string().trim().min(1).max(100) }).parse(await c.req.json());
    await admin.setTenantName(c.get('actor'), tenantId, name);
    return c.json(await admin.getTenant(c.get('actor'), tenantId));
  });

  app.patch('/tenants/:tenantId/status', async (c) => {
    const tenantId = tenantIdSchema.parse(c.req.param('tenantId'));
    const { status } = setTenantStatusBody.parse(await c.req.json());
    // The live weapon (§7): `suspended` fails getScope closed for EVERY scope
    // under the tenant. The blast radius is the console's to show; the audit row
    // is this layer's to guarantee.
    await admin.setTenantStatus(c.get('actor'), tenantId, status);
    return c.json(await admin.getTenant(c.get('actor'), tenantId));
  });

  // Reap a DELETING tenant now (control-plane.md §4.8) — the staff "reap now" that skips
  // the grace window, the tenant analogue of the scope reap route below. Refuses a tenant
  // that is not `deleting` (409): a reap only ever follows the reversible delete state, and
  // starting/reversing it is the ordinary `PATCH …/status` transition above. Every scope is
  // reaped FIRST (archive-if-needed → the vertical wipes its co-located DO → `reapScope`,
  // the same storage-before-row ordering the scope route keeps) so no scope's bytes outlive
  // the tenant, then `reapTenant` clears the directory. Staff/service only (not in
  // BUILDER_ROUTES). Idempotent: a crash mid-reap leaves the tenant `deleting`, and a retry
  // (or the grace-window sweep) converges — reaped scopes are skipped, reapTenant re-checks.
  app.post('/tenants/:tenantId/reap', async (c) => {
    const tenantId = tenantIdSchema.parse(c.req.param('tenantId'));
    const actor = c.get('actor');
    const { backup: wantsBackup } = reapScopeBody.parse(await c.req.json().catch(() => ({})));
    const tenant = await admin.getTenant(actor, tenantId);
    if (!tenant) return c.json({ error: `unknown tenant: ${tenantId}` }, 404);
    if (tenant.status !== 'deleting') {
      return c.json(
        {
          error: `tenant ${tenantId} is ${tenant.status}, not deleting — only a deleting tenant may be reaped`,
        },
        409,
      );
    }
    try {
      for (const scope of await admin.listScopes(actor, { tenantId })) {
        if (scope.status === 'reaped') continue;
        if (scope.status !== 'archived') await admin.archiveScope(actor, tenantId, scope.id);
        // A backup here is OPT-IN, the inverse of the per-scope reap's default (#493).
        // A scope reap is operational cleanup, so leaving a copy is the safe default; a
        // TENANT reap is the deletion of a customer, and §4.8 exists partly to serve an
        // Art. 17 erasure — silently writing that customer's data to a bucket the reap
        // does not clear would defeat the request it was made to satisfy. Staff who are
        // retiring (not erasing) a tenant pass `backup: true` deliberately.
        const backup = wantsBackup === true ? await backupScope(c, tenantId, scope) : null;
        const vertical = await verticalForScope(c, scope);
        if (vertical) await vertical.deleteScope({ scopeId: scope.id });
        // Tenant teardown reaps every scope and releases every name by design — force past
        // the bound-hostname guard (which fences the interactive per-scope reap route below).
        await admin.reapScope(actor, tenantId, scope.id, {
          force: true,
          ...(backup ? { backupRef: backupRefOf(backup) } : {}),
        });
      }
      await admin.reapTenant(actor, tenantId);
      return c.json(await admin.getTenant(actor, tenantId));
    } catch (e) {
      if (e instanceof ControlPlaneError) {
        return c.json({ error: e.message }, e.status as ContentfulStatusCode);
      }
      throw e;
    }
  });

  // -- entitlements (§4.3) ---------------------------------------------------

  app.get('/tenants/:tenantId/entitlements', async (c) =>
    c.json(await admin.listEntitlements(c.get('actor'), tenantIdSchema.parse(c.req.param('tenantId')))),
  );

  app.put('/tenants/:tenantId/entitlements/:key', async (c) => {
    const tenantId = tenantIdSchema.parse(c.req.param('tenantId'));
    // The body is the plan half (#33) and optional — a bodyless PUT is the
    // pre-widening bare flag grant, and PATCH semantics in the store mean it
    // preserves whatever plan fields the grant already carries.
    const plan = entitlementGrantInput.parse(await c.req.json().catch(() => ({})));
    await admin.grantEntitlement(c.get('actor'), tenantId, c.req.param('key'), plan);
    return c.json(await admin.listEntitlements(c.get('actor'), tenantId));
  });

  app.delete('/tenants/:tenantId/entitlements/:key', async (c) => {
    const tenantId = tenantIdSchema.parse(c.req.param('tenantId'));
    await admin.revokeEntitlement(c.get('actor'), tenantId, c.req.param('key'));
    return c.json(await admin.listEntitlements(c.get('actor'), tenantId));
  });

  // -- the meters (§5, #38) --------------------------------------------------
  // Meters 1 and 2, read fleet-wide or narrowed with `?tenantId=`. Meters 3 and 4 have
  // no route because they have no number: the outbox is per-scope-database with no
  // cross-tenant fan-in and reads emit nothing, so anything served here would be
  // invented. Staff-only (absent from BUILDER_ROUTES) — a fleet-wide revenue aggregate
  // is the platform's own book, not a builder's view of their installs.
  //
  // GET, and nothing is stored: D-30 is meter, do not bill, so a reading is recomputed
  // per call and stamped with the instant it was taken.
  app.get('/meters', async (c) => {
    const raw = c.req.query('tenantId');
    const tenantId = raw ? tenantIdSchema.parse(raw) : undefined;
    return c.json(await admin.readMeters(c.get('actor'), tenantId ? { tenantId } : undefined));
  });

  // -- per-tenant stores (#301, #473) ----------------------------------------
  // The two ledgers as INVENTORY — what `listTenantStores`/`listBlobStores` were always
  // meant to answer for a staff surface: which database and which bucket hold this
  // tenant's bytes, by the provider's own id. Read-only by construction (there is no
  // route that mints a store; provisioning does that), and staff-only — not in
  // BUILDER_ROUTES, because a builder asking "which D1 backs my install" is a different,
  // owner-narrowed question than staff asking "where does this tenant live".
  app.get('/tenants/:tenantId/stores', async (c) => {
    const tenantId = tenantIdSchema.parse(c.req.param('tenantId'));
    const actor = c.get('actor');
    const [tenantStores, blobStores] = await Promise.all([
      admin.listTenantStores(actor, { tenantId }),
      admin.listBlobStores(actor, { tenantId }),
    ]);
    return c.json({ tenantStores, blobStores });
  });

  // -- identity mirror (builder-plane.md §4) ---------------------------------
  // Builder auth (`whoami`, the CLI session reader) resolves `userId → tenants`
  // against THIS deployment's identity directory, but the links are created at
  // dashboard sign-up in the Dashboard's OWN deployment — a different DO. This
  // pair is the mirror seam the dashboard writes through (idempotent, keyed the
  // same as its local links). Not in BUILDER_ROUTES: a builder cannot write the
  // directory that authenticates builders — service/staff only, fail-closed.

  const mirrorIdentityBody = identityLink.omit({ tenantId: true });
  app.put('/tenants/:tenantId/identities', async (c) => {
    const tenantId = tenantIdSchema.parse(c.req.param('tenantId'));
    const link = mirrorIdentityBody.parse(await c.req.json());
    // The pool must exist before a link can land in it (central topology, K-23);
    // registering an existing pool is a no-op.
    await admin.registerIdentityPool(c.get('actor'), { provider: link.provider, topology: 'central', tenantId: null });
    await admin.linkIdentity(c.get('actor'), { ...link, tenantId });
    return c.body(null, 204);
  });

  app.delete('/tenants/:tenantId/identities/:principal', async (c) => {
    const tenantId = tenantIdSchema.parse(c.req.param('tenantId'));
    await admin.unlinkIdentity(c.get('actor'), tenantId, principalIdSchema.parse(c.req.param('principal')));
    return c.body(null, 204);
  });

  // The read half of the mirror seam (#406): what the directory currently links for a
  // tenant — the console's offboarding view, and the way to verify an unlink landed.
  app.get('/tenants/:tenantId/identities', async (c) => {
    const tenantId = tenantIdSchema.parse(c.req.param('tenantId'));
    return c.json(await admin.listIdentityLinks(c.get('actor'), tenantId));
  });

  // The tenant's live connection grants (#592) — the readable "what may this connection
  // invoke" (connections.md §6.2.4 Q2), and the rows provision/reconcile deliver from.
  app.get('/tenants/:tenantId/connection-grants', async (c) => {
    const tenantId = tenantIdSchema.parse(c.req.param('tenantId'));
    return c.json(await admin.listConnectionGrants(c.get('actor'), tenantId));
  });

  // -- the connection store, tenant-scoped (connections.md §3.5) -------------
  //
  // The dashboard's door to the PLATFORM's connection store. The dashboard keeps its own
  // directory (its GitHub App connections live there, consumed by the dashboard itself),
  // but a provider credential a PLATFORM-run connector consumes (Scrive, Fortnox) must
  // land in THIS directory — `connector:<provider>` dispatch opens connections here, and
  // a row written anywhere else is invisible to it. Metadata only on the read: the
  // `Connection` type cannot carry a secret (contract-tested), so listing is safe as-is.
  // Not in BUILDER_ROUTES — service/staff only, fail-closed, same law as the identity
  // mirror above.

  app.get('/tenants/:tenantId/connections', async (c) => {
    const filter = connectionFilter.parse({
      tenantId: tenantIdSchema.parse(c.req.param('tenantId')),
      vertical: c.req.query('vertical'),
      provider: c.req.query('provider'),
      includeRevoked: c.req.query('includeRevoked') === '1' ? true : undefined,
    });
    return c.json(await admin.listConnections(c.get('actor'), filter));
  });

  // The same upsert semantics as `/internal/connections/upsert` (§3.5.2) — create under a
  // fresh id, or rotate the one live row in place so its grant tuples survive — behind
  // platform-actor auth instead of the vertical-harness PLATFORM_SECRET. The tenant is
  // the path's, never the body's: a body naming a different tenant is refused, not
  // silently rewritten.
  app.post('/tenants/:tenantId/connections', async (c) => {
    const tenantId = tenantIdSchema.parse(c.req.param('tenantId'));
    const raw = await c.req.json();
    const body = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
    if (body.tenantId !== undefined && body.tenantId !== tenantId) {
      return c.json({ error: 'body tenantId disagrees with the route tenant' }, 400);
    }
    try {
      return c.json(
        await relayConnectionUpsert(host, c.get('actor'), { ...body, tenantId }, { probeCandidate }),
      );
    } catch (err) {
      if (err instanceof ConnectionRelayError && err.status < 500) {
        // A refusal carries the provider's own answer, so a console can show WHY rather
        // than "save failed" — the whole point of checking before writing.
        return c.json({ error: err.message, ...(err.probe ? { probe: err.probe } : {}) }, err.status);
      }
      // A 5xx relay refusal (#603: this deployment holds no seal key) is the PLATFORM
      // failing, not the caller — rethrown so the shared boundary maps it (still a 503
      // with this message) and records the ops-failure row a console can list. Answering
      // it here would leave the operator's screen as the only place it was ever seen.
      throw err;
    }
  });

  // Revoke — terminal (the sealed secret is deleted, grants tombstone; a replacement is a
  // new connection). Tenant-scoped with K-3 existence hiding: a foreign tenant's
  // connection id is indistinguishable from an absent one. Idempotent: revoking an
  // already-revoked row is a 204 no-op, not an error.
  app.delete('/tenants/:tenantId/connections/:id', async (c) => {
    const tenantId = tenantIdSchema.parse(c.req.param('tenantId'));
    const id = c.req.param('id');
    const rows = await admin.listConnections(c.get('actor'), { tenantId, includeRevoked: true });
    const row = rows.find((r) => r.id === id);
    if (!row) return c.json({ error: 'unknown connection' }, 404);
    if (row.status !== 'revoked') await admin.revokeConnection(c.get('actor'), row.id);
    return c.body(null, 204);
  });

  /**
   * The tenant-scoped connection lookup the two inspection routes share. Same K-3
   * existence hiding as the revoke above — a foreign tenant's connection id reads
   * exactly like an absent one — and revoked rows are excluded: a withdrawn credential
   * has no secret left to probe with, so "revoked" is a 404 for these reads too.
   */
  /**
   * The connect-time gate (#605), as the relay consumes it: ask the provider about a
   * candidate credential, or answer `undefined` when this platform has no probe for it —
   * in which case the upsert behaves exactly as it always did, storing unverified.
   */
  const probeCandidate = async (provider: string, secret: Record<string, string>) =>
    options.connectionInspectors?.[provider]?.probeCandidate?.(secret);

  const inspectableConnection = async (c: Context<{ Variables: Vars }>) => {
    const tenantId = tenantIdSchema.parse(c.req.param('tenantId'));
    const id = c.req.param('id');
    const rows = await admin.listConnections(c.get('actor'), { tenantId });
    return rows.find((r) => r.id === id);
  };

  /**
   * **Verify a credential against the provider** (#605) — the read that turns "stored"
   * into "works, and for this account".
   *
   * A POST because it reaches out: it spends an authenticated call at the provider and
   * writes health (`recordConnectionUse` rides the connector's sanctioned `fetch`), so
   * it is not the safe, cacheable read a GET promises. Not audited — like every other
   * connection USE, it is machine telemetry, and §3.4's rule is that the audit log
   * records control-plane mutations, not outbound calls.
   *
   * A rejected credential is `200 { ok: false, error }`, not an HTTP error: the
   * provider answered, and its answer is the payload. Only a platform fault (no
   * inspector wired, an unopenable secret) is a non-200.
   */
  app.post('/tenants/:tenantId/connections/:id/verify', async (c) => {
    const row = await inspectableConnection(c);
    if (!row) return c.json({ error: 'unknown connection' }, 404);
    const probe = options.connectionInspectors?.[row.provider]?.probe;
    if (!probe) {
      return c.json({ error: `no probe registered for provider '${row.provider}'` }, 501);
    }
    return c.json(connectionProbe.parse(await probe(host, row)));
  });

  /**
   * **What the connection has done** (#605) — the connector's dispatch ledger, projected.
   *
   * `?live=1` asks the provider for current state as well; the result says which it got
   * (`live`), because presenting the ledger's view as the provider's would be inventing
   * facts. The projection is the connector's, never this package's: a raw ledger row can
   * carry connector secrets, so it is never serialized here.
   *
   * `?source=provider` asks a different question entirely — list the provider's OWN
   * records (Scrive's document archive), including ones this platform never sent. The
   * answer echoes `source` back, because neither view is a superset of the other.
   */
  app.get('/tenants/:tenantId/connections/:id/activity', async (c) => {
    const row = await inspectableConnection(c);
    if (!row) return c.json({ error: 'unknown connection' }, 404);
    const activity = options.connectionInspectors?.[row.provider]?.activity;
    if (!activity) {
      return c.json({ error: `no activity view registered for provider '${row.provider}'` }, 501);
    }
    const source = connectionActivitySource.catch('ledger').parse(c.req.query('source'));
    const live = c.req.query('live') === '1';
    return c.json(connectionActivity.parse(await activity(host, row, { live, source })));
  });

  /**
   * **The stored credential, reduced** (#605) — identifiers whole, secrets masked.
   *
   * Reads plaintext plane-side (the connector opens it) and returns something that is
   * deliberately not a credential. This is the screen that makes "connected" and
   * "connected with a mistyped token" distinguishable, which they were not: the store's
   * write-only rule is right, but with no view at all the only repair on offer was to
   * paste every field again blind.
   */
  app.get('/tenants/:tenantId/connections/:id/credential', async (c) => {
    const row = await inspectableConnection(c);
    if (!row) return c.json({ error: 'unknown connection' }, 404);
    const credential = options.connectionInspectors?.[row.provider]?.credential;
    if (!credential) {
      return c.json({ error: `no credential view registered for provider '${row.provider}'` }, 501);
    }
    return c.json(connectionCredential.parse(await credential(host, row)));
  });

  // -- the scope directory (§3.2/§4.2) ---------------------------------------

  app.get('/scopes', async (c) => {
    const p = c.get('principal');
    const filter = listScopesQuery.parse({
      // A builder reads only its OWN tenant's directory rows — the filter is forced,
      // not trusted from the query (#424 CLI parity for `substrat installs`).
      tenantId: p.kind === 'builder' ? p.tenantId : c.req.query('tenantId'),
      status: c.req.queries('status'),
      vertical: c.req.query('vertical'),
    });
    const page = pageParams(c);
    const entries = await admin.listScopes(c.get('actor'), { ...filter, ...page });
    return c.json(pageOf(entries, page.limit, (s) => s.id));
  });

  // -- fleet migration progress (kernel-design §5.3, #49) ---------------------
  // The ops-console view: "release N: X/Y migrated, P pending, F failed",
  // computed from the directory listing against THIS host's registered frontier
  // (§5.4: fleet questions never fan out — no scope is woken to answer). Staff
  // only via the builder allowlist's default-deny. `vertical` narrows the fleet
  // — in a multi-deployment environment each vertical has its own frontier, so
  // an unfiltered read is meaningful only where one deployment runs everything.
  app.get('/fleet/migrations', async (c) => {
    const filter = fleetMigrationsQuery.parse({ vertical: c.req.query('vertical') });
    const scopes = await admin.listScopes(c.get('actor'), {
      status: ['active', 'provisioning'],
      ...(filter.vertical ? { vertical: filter.vertical } : {}),
    });
    return c.json(migrationProgress(host.migrationFrontier(), scopes));
  });

  app.post('/scopes', async (c) => {
    const input = provisionScopeBody.parse(await c.req.json());
    await host.provisionScope(c.get('actor'), input as Parameters<ScopeHost['provisionScope']>[1]);
    const record = await admin.getScopeRecord(c.get('actor'), input.tenantId, input.scopeId);
    return c.json(record, 201);
  });

  // Add a SIBLING scope — a new "site" — to an app the tenant already runs (multi-scope
  // self-serve, M1 of multi-scope-manyfold.md). Runs the same provision → materialize-instance
  // → activate sequence `createApp` runs for the first scope, but authorized differently: the
  // `parentScopeId` app scope must already exist under this tenant, which is what proves the
  // tenant is entitled to this vertical — and the new scope INHERITS the parent's vertical +
  // jurisdiction, so the caller can never name a vertical it does not already run. A BUILDER is
  // confined to its own tenant (the allowlist reaches this route; the tenant check below is the
  // authz); staff may target any tenant. Idempotent on `scopeId` like every provision (K-31).
  //
  // No site-count quota is enforced here yet — that is an open product question
  // (multi-scope-manyfold.md, "Quota policy"); when a cap lands it belongs right here, counting
  // `admin.listScopes({ tenantId, vertical })` against the tenant's `sites` entitlement.
  app.post('/tenants/:tenantId/scopes', async (c) => {
    const tenantId = tenantIdSchema.parse(c.req.param('tenantId'));
    const input = addSiblingScopeBody.parse(await c.req.json());
    const actor = c.get('actor');
    const p = c.get('principal');
    // A builder acts only within its own tenant; a foreign tenant is hidden as 404 (K-3),
    // never distinguished from "no such scope".
    if (p.kind === 'builder' && p.tenantId !== tenantId) {
      return c.json({ error: `unknown scope for tenant: (${tenantId}, ${input.parentScopeId})` }, 404);
    }
    // The provisioning sequence lives in one place — `provisionSiblingScope` — shared with the
    // platform-intent drain's `provision-sibling` handler (platform-intents.md B2).
    try {
      const result = await provisionSiblingScope(
        { host, actor, resolveVerticalForScope: (scope) => verticalForScope({ get: () => actor }, scope) },
        {
          tenantId,
          parentScopeId: input.parentScopeId,
          scopeId: input.scopeId,
          slug: input.slug,
          name: input.name,
          owner: input.owner,
        },
      );
      if (!result.ok) return c.json({ error: result.error }, result.status as ContentfulStatusCode);
      return c.json(await admin.getScopeRecord(actor, tenantId, input.scopeId), 201);
    } catch (e) {
      if (e instanceof ControlPlaneError) return c.json({ error: e.message }, e.status as ContentfulStatusCode);
      throw e;
    }
  });

  app.get('/tenants/:tenantId/scopes/:scopeId', async (c) => {
    const tenantId = tenantIdSchema.parse(c.req.param('tenantId'));
    const scopeId = scopeIdSchema.parse(c.req.param('scopeId'));
    // A builder reads only its own tenant; a foreign tenant is hidden as 404 (K-3).
    const p = c.get('principal');
    if (p.kind === 'builder' && p.tenantId !== tenantId) {
      return c.json({ error: `unknown scope for tenant: (${tenantId}, ${scopeId})` }, 404);
    }
    const record = await admin.getScopeRecord(c.get('actor'), tenantId, scopeId);
    // Absent, or present under another tenant — indistinguishable on purpose (K-3).
    if (!record) return c.json({ error: `unknown scope for tenant: (${tenantId}, ${scopeId})` }, 404);
    return c.json(record);
  });

  // Read-only introspection of a scope's own database (kernel-design §5.4 admin-query
  // RPC) — the console/dashboard "Data" view.
  //
  // The scope's DATA lives in the vertical's own deployment (K-31), NOT in this control
  // plane's own (empty-module) scope host — so we DELEGATE to the vertical, the mirror
  // of `/verticals/:slug/instances`. `getScopeRecord` first does the K-3 cross-check +
  // access-log entry and tells us which vertical (and which VERSION) backs the scope.
  //
  // Resolution order matters. A scope's data DO lives in the deployment of its BOUND
  // version (`verticalVersionId`) — each `substrat push` is a separate WfP script with
  // its own DO namespace, so the prod-channel deployment is the wrong one the moment an
  // installed app lags prod. So we prefer bound-version resolution, then fall back to
  // prod-channel/static (a scope with no bound version), then to reading this host's own
  // scope DB directly (a co-located host, or the contract tests — data is right here).
  /**
   * The per-subject key operations bound to one scope and one actor (#37) — what
   * `sealDump`/`openDump` need and nothing more.
   *
   * Narrowed on purpose: the seal path gets exactly two capabilities, so a future edit
   * cannot quietly widen a backup routine into a general admin caller. Every call lands in
   * the access log under the acting staff member, because reading or minting the keys that
   * protect a subject's data is itself a thing an incident asks about.
   */
  const sealerFor = (
    c: { get: (k: 'actor') => PlatformActorId },
    tenantId: TenantId,
    scopeId: ScopeId,
  ): SubjectSealer => ({
    seal: (items) => admin.sealSubjectPayloads(c.get('actor'), tenantId, scopeId, items),
    open: (items) => admin.openSubjectPayloads(c.get('actor'), tenantId, scopeId, items),
  });

  const verticalForScope = async (
    c: { get: (k: 'actor') => PlatformActorId },
    scope: { tenantId?: TenantId; vertical: string | null; verticalVersionId: string | null; servingRef?: string | null },
  ): Promise<VerticalClient | undefined> => {
    if (!scope.vertical) return undefined;
    const actor = c.get('actor');
    // A scope on the stable serving script (#286) is reached THERE — that script holds
    // its DOs regardless of what the bound version or the prod channel say.
    if (scope.servingRef && options.resolveVerticalRef) {
      const serving = await options.resolveVerticalRef(scope.servingRef);
      if (serving) return serving;
    }
    const bySlug = async (slug: string): Promise<VerticalClient | undefined> => {
      if (scope.verticalVersionId && options.resolveVerticalVersion) {
        const bound = await options.resolveVerticalVersion(slug, scope.verticalVersionId, actor);
        if (bound) return bound;
      }
      return options.verticals?.[slug] ?? (await options.resolveVertical?.(slug, actor));
    };
    const direct = await bySlug(scope.vertical);
    if (direct) return direct;
    // Miss path only (#417) — a resolved scope never pays for these registry reads: a
    // scope bound to a BARE slug that is not registered, while the owning tenant's
    // prefixed registration of the same name exists, is addressing the prefixed lineage
    // under its bare spelling. Retry once under the registry id; anything else still
    // misses and surfaces through `diagnoseUnboundScope` as before.
    if (scope.tenantId && !scope.vertical.includes('/') && (await ownerOf(actor, scope.vertical)) === undefined) {
      const tenant = await admin.getTenant(actor, scope.tenantId).catch(() => null);
      const prefixed = tenant ? `${tenant.slug}/${scope.vertical}` : null;
      if (prefixed && (await ownerOf(actor, prefixed)) !== undefined) return bySlug(prefixed);
    }
    return undefined;
  };

  /**
   * Why a scope's vertical did not resolve to a running deployment — an ACTIONABLE 501
   * body, computed only on the miss path, in place of the bare "no deployment is bound"
   * that masked the #399 lineage fork. A `substrat push` publishes versions under the
   * slug it derives from the project (package.json `name`, unless `substrat.slug` pins
   * it), while installs/hostnames — and so `scope.vertical` — carry the slug the app was
   * installed under. When those diverge, `resolveVerticalVersion` filters the bound
   * version by the scope's slug (control-plane worker) and never finds it, so delivery
   * 501s with no hint that the versions merely live under a different slug. This names the
   * exact split so it is a seconds-long diagnosis, not a multi-hour hunt. A couple of
   * directory reads only when a call has already failed to resolve.
   */
  const diagnoseUnboundScope = async (
    actor: PlatformActorId,
    scope: { vertical: string | null; verticalVersionId: string | null; servingRef?: string | null },
  ): Promise<string> => {
    const slug = scope.vertical;
    if (!slug) return 'scope has no vertical bound — nothing to deliver to';
    const versions = await admin.listVersions(actor, slug).catch(() => []);
    const boundId = scope.verticalVersionId;
    if (boundId && !versions.some((v) => v.id === boundId)) {
      return (
        `scope is bound to version '${boundId}', which is not among vertical '${slug}'’s ${versions.length} ` +
        `pushed version(s) — its versions were most likely pushed under a DIFFERENT slug (a lineage fork). ` +
        `Check the vertical's package.json \`name\` vs \`substrat.slug\`, and compare ` +
        `\`substrat versions ${slug}\` against \`substrat hostnames ${slug}\`.`
      );
    }
    if (versions.length === 0) {
      return (
        `vertical '${slug}' has no pushed versions, yet a scope is installed under it — the installs and the ` +
        `pushes are on different slugs (a lineage fork). Push under '${slug}' by setting \`substrat.slug\`, ` +
        `or rebind the install to the slug the versions live under.`
      );
    }
    const serving = await admin.verticalServing(actor, slug).catch(() => null);
    if (!serving) {
      return `vertical '${slug}' has ${versions.length} version(s) but none is promoted to a serving channel — promote one to prod.`;
    }
    return (
      `no deployment is bound for vertical '${slug}': the scope is not on the serving script and its bound ` +
      `version did not resolve. Promote a version to prod, then adopt the scope onto the serving script.`
    );
  };

  /**
   * Move ONE legacy scope's data off its per-version dispatch script onto its vertical's
   * stable serving script (#286/#321), then flip routing. The one primitive behind both
   * the explicit `adopt-serving` endpoint and the automatic adoption a prod promote runs.
   *
   * Ordering is data-first: export from the script that holds the data TODAY (the scope's
   * current dispatch — resolved BEFORE any version rebind), restore into the serving
   * script (which re-projects the vertical's roles), and only then `setScopeServingRef` +
   * advance the version pointer. A crash before the flip leaves the scope serving its old
   * script intact, and the adopt retries idempotently. Already-adopted scopes short-circuit.
   * Throws `ControlPlaneError` so callers surface an actionable status, never a bare 500.
   */
  const adoptScopeOntoServing = async (
    c: { get: (k: 'actor') => PlatformActorId },
    tenantId: TenantId,
    scopeId: ScopeId,
  ): Promise<{ servingRef: string; alreadyAdopted?: boolean; tables?: number }> => {
    const actor = c.get('actor');
    const scope = await admin.getScopeRecord(actor, tenantId, scopeId);
    if (!scope) {
      throw new ControlPlaneError(404, `unknown scope for tenant: (${tenantId}, ${scopeId})`);
    }
    if (scope.servingRef) return { servingRef: scope.servingRef, alreadyAdopted: true };
    if (!scope.vertical) {
      throw new ControlPlaneError(409, 'scope has no vertical — nothing to adopt onto');
    }
    const serving = await admin.verticalServing(actor, scope.vertical);
    if (!serving) {
      throw new ControlPlaneError(
        409,
        `vertical '${scope.vertical}' has no serving script yet — promote a version to prod first`,
      );
    }
    const source = await verticalForScope(c, scope);
    const dest = await options.resolveVerticalRef?.(serving.ref);
    if (!source || !dest) {
      throw new ControlPlaneError(501, 'adopt-serving needs dispatch resolution for both ends');
    }
    const dump = await source.exportScope(scopeId);
    const restored = await retryTransient(() => dest.restoreScope(tenantId, scopeId, dump));
    // Data landed — only now flip routing and move the version pointer.
    await admin.setScopeServingRef(actor, tenantId, scopeId, serving.ref);
    await admin.bindScopeVersion(actor, tenantId, scopeId, serving.versionId);
    return { servingRef: serving.ref, tables: restored.tables };
  };

  /**
   * After a prod in-place serve, own the owned-scope adopt+rebind the host cascade
   * delegated to us for a dispatch-backed vertical (#321): adopt any still-legacy scope
   * onto the serving script (data survives), and advance every owned scope's version
   * pointer to the promoted version so Update stops offering a crossing already made.
   *
   * Gated exactly where the host cascade would have run: PRIVATE (owned, unlisted) only,
   * active non-fork scopes only. Runs only when a serving script exists — i.e. the serve
   * actually happened (dispatch-backed + deploy configured); for an embedded vertical the
   * host cascade already rebound, and `verticalServing` is null, so this is a no-op.
   * Idempotent and retry-safe: the host cascade never rebound these scopes, so their data
   * is still findable on a retry after a failed serve.
   */
  const adoptAndRebindOwnedScopes = async (
    c: { get: (k: 'actor') => PlatformActorId },
    slug: string,
    versionId: string,
  ): Promise<void> => {
    const actor = c.get('actor');
    const serving = await admin.verticalServing(actor, slug);
    if (!serving) return; // embedded / not dispatch-backed — the host cascade handled rebinds
    const v = await verticalOf(actor, slug);
    if (!v || v.ownerTenant === null || v.listed) return; // private only, like the host cascade
    const owned = (
      await admin.listScopes(actor, { tenantId: v.ownerTenant, vertical: slug, status: ['active'] })
    ).filter((s) => !s.forkedFrom);
    for (const s of owned) {
      if (!s.servingRef) {
        // Adopt: export from the scope's current (un-rebound) dispatch → serving script,
        // then bind to the serving version. Data-first, so a failure here leaves the
        // scope intact on its old script for the next promote to retry.
        await adoptScopeOntoServing(c, s.tenantId, s.id);
      } else if (s.verticalVersionId !== versionId) {
        // Already on the serving script (born there, or adopted earlier): routing is
        // pinned to servingRef, so advancing the version pointer only affects Update
        // offers. Snapshot on a migration-digest crossing (fork-before-promote, §4).
        await admin.bindScopeVersion(actor, s.tenantId, s.id, versionId, { snapshot: true });
      }
    }
  };

  /**
   * Move ONE scope onto a DIFFERENT vertical lineage's serving script (#389) — the
   * update-rebind behind retiring a platform-owned lineage in favour of a tenant-owned
   * one (`manyfold` → `substrat-9yjbbn/manyfold`). The same data-first shape as
   * `adoptScopeOntoServing`, with the destination resolved from the TARGET slug and
   * the version pointer crossing lineages (the adapter's `bindScopeVersion` rewrites
   * `scopes.vertical` from the version row, so the directory follows in the same act).
   *
   * The one hazard adopt-serving never had: the two lineages' migration histories are
   * independent, and the scope's DO carries the SOURCE lineage's applied-migration
   * journal. The digest gate refuses the crossing unless the scope's bound version and
   * the target's serving version carry the same migration digest — or the operator
   * acknowledges having read both surfaces (`ackMigrations`). The source script's copy
   * is never deleted — flipping `servingRef` + version back is the backout.
   */
  const rebindScopeOntoVertical = async (
    c: { get: (k: 'actor') => PlatformActorId },
    tenantId: TenantId,
    scopeId: ScopeId,
    target: string,
    opts: { ackMigrations?: boolean; abandonData?: boolean },
  ): Promise<{
    servingRef: string;
    versionId: string;
    alreadyBound?: boolean;
    tables?: number;
    dataAbandoned?: boolean;
  }> => {
    const actor = c.get('actor');
    const scope = await admin.getScopeRecord(actor, tenantId, scopeId);
    if (!scope) {
      throw new ControlPlaneError(404, `unknown scope for tenant: (${tenantId}, ${scopeId})`);
    }
    if (scope.forkedFrom) {
      throw new ControlPlaneError(409, 'a fork cannot be rebound — reap it and re-preview against the target lineage');
    }
    if (!scope.vertical) {
      throw new ControlPlaneError(409, 'scope has no vertical — nothing to rebind');
    }
    const serving = await admin.verticalServing(actor, target);
    if (!serving) {
      throw new ControlPlaneError(
        409,
        `vertical '${target}' has no serving script yet — promote a version to prod first`,
      );
    }
    if (scope.vertical === target && scope.servingRef === serving.ref) {
      return { servingRef: serving.ref, versionId: serving.versionId, alreadyBound: true };
    }
    if (opts.abandonData) {
      // Directory-only crossing: no bytes move, so the frontier gate has nothing to
      // protect — the target provisions its own schema from scratch. The source
      // script's copy is untouched and remains the backout, same as a carried rebind.
      // The scope serves nothing until `/verticals/:slug/instances` re-provisions it.
      await admin.setScopeServingRef(actor, tenantId, scopeId, serving.ref);
      await admin.bindScopeVersion(actor, tenantId, scopeId, serving.versionId);
      return { servingRef: serving.ref, versionId: serving.versionId, dataAbandoned: true };
    }
    // The frontier gate. Digest equality proves the target's migration set is exactly
    // what this DO has already applied plus whatever a same-lineage update would have
    // brought — the crossing is then no riskier than an ordinary version bind. Anything
    // else (differing digests, or a scope with no bound version to compare) needs the
    // operator's explicit acknowledgement.
    const targetV = await admin.getVersion(actor, serving.versionId, target);
    const currentV = scope.verticalVersionId
      ? await admin.getVersion(actor, scope.verticalVersionId, scope.vertical)
      : undefined;
    const digestsMatch = Boolean(
      currentV && targetV && currentV.migrationDigest === targetV.migrationDigest,
    );
    if (!digestsMatch && !opts.ackMigrations) {
      throw new ControlPlaneError(
        409,
        `migration surfaces differ across lineages ('${scope.vertical}' ${currentV?.migrationDigest ?? '(unbound)'} → ` +
          `'${target}' ${targetV?.migrationDigest ?? '(unknown)'}) — read both migration diffs, then re-run with ackMigrations`,
      );
    }
    const source = await verticalForScope(c, scope);
    const dest = await options.resolveVerticalRef?.(serving.ref);
    if (!source || !dest) {
      throw new ControlPlaneError(501, 'rebind-vertical needs dispatch resolution for both ends');
    }
    const dump = await source.exportScope(scopeId);
    const restored = await retryTransient(() => dest.restoreScope(tenantId, scopeId, dump));
    // Data landed on the target script — only now flip routing and cross the pointer.
    // `bindScopeVersion` rewrites `scopes.vertical` from the version row, audited. No
    // extra snapshot here (adopt-serving's precedent): the source script's copy is the
    // pre-migration state, and it is never deleted — that copy is the backout.
    await admin.setScopeServingRef(actor, tenantId, scopeId, serving.ref);
    await admin.bindScopeVersion(actor, tenantId, scopeId, serving.versionId);
    return { servingRef: serving.ref, versionId: serving.versionId, tables: restored.tables };
  };

  app.get('/tenants/:tenantId/scopes/:scopeId/tables', async (c) => {
    const tenantId = tenantIdSchema.parse(c.req.param('tenantId'));
    const scopeId = scopeIdSchema.parse(c.req.param('scopeId'));
    const scope = await admin.getScopeRecord(c.get('actor'), tenantId, scopeId);
    if (!scope) return c.json({ error: `unknown scope for tenant: (${tenantId}, ${scopeId})` }, 404);
    const vertical = await verticalForScope(c, scope);
    return c.json(
      vertical
        ? await vertical.listScopeTables(scopeId)
        : await admin.listScopeTables(c.get('actor'), tenantId, scopeId),
    );
  });

  // Scope health (#321, criterion #3). The silent failure the field report chased was an
  // ACTIVE scope serving traffic from a DO whose `_substrat_roles` projection is EMPTY:
  // identity resolves, every permission check denies, and it reads as a per-app 403 rather
  // than a platform condition. Surface it as one. The role count comes from the SAME
  // introspection the Data view uses (the serving script the router actually dispatches to),
  // so it reflects the DO in front of live traffic — reusing existing plumbing rather than
  // a new scope-DO route. `roleProjectionEmpty` on an active scope is the flag a console
  // fleet view raises; a scope whose roles live off-DO (adapter-sqlite's directory) reports
  // a null count and is not flagged.
  //
  // `missingStores` (#825) is the second silent condition, and the same shape of failure:
  // per-tenant stores are minted in the TENANT-creation lifecycle, so a tenant that predates
  // a newly declared `runtimeNeeds` store never gets one — the vertical's declaration and the
  // tenant's ledger simply disagree, forever, and the only signal was a runtime throw at
  // first use (an attachment upload refusing in production, long after the deploy that
  // introduced the need). Comparing DECLARED against MINTED here makes a scope that cannot
  // serve its own declared surface report unhealthy at the moment the need ships, and
  // re-provisioning the scope is the repair (that path now mints what this reports).
  app.get('/tenants/:tenantId/scopes/:scopeId/health', async (c) => {
    const tenantId = tenantIdSchema.parse(c.req.param('tenantId'));
    const scopeId = scopeIdSchema.parse(c.req.param('scopeId'));
    // A builder reads only its own tenant; a foreign tenant is hidden as 404 (K-3).
    const principal = c.get('principal');
    if (principal.kind === 'builder' && principal.tenantId !== tenantId) {
      return c.json({ error: `unknown scope for tenant: (${tenantId}, ${scopeId})` }, 404);
    }
    const scope = await admin.getScopeRecord(c.get('actor'), tenantId, scopeId);
    if (!scope) return c.json({ error: `unknown scope for tenant: (${tenantId}, ${scopeId})` }, 404);
    const vertical = await verticalForScope(c, scope);
    const tables = vertical
      ? await vertical.listScopeTables(scopeId)
      : await admin.listScopeTables(c.get('actor'), tenantId, scopeId);
    const roles = tables.find((t) => t.name === '_substrat_roles');
    const roleCount = roles ? roles.rowCount : null;
    const roleProjectionEmpty = scope.status === 'active' && roleCount === 0;
    const missingStores = scope.vertical
      ? await missingStoresForTenant({
          host: options.host,
          actor: c.get('actor'),
          slug: scope.vertical,
          tenantId,
        })
      : [];
    return c.json({
      scopeId,
      status: scope.status,
      servingRef: scope.servingRef ?? null,
      roleCount,
      roleProjectionEmpty,
      missingStores,
    });
  });

  /**
   * **A scope's platform-intent journal** (#618) — what the vertical asked the platform to do,
   * and what came back.
   *
   * The gap this closes: a connector delivery routed as a `connector:<provider>` intent journals
   * the provider's full refusal in `last_error`, correctly and durably — inside the scope's own
   * DO, in the vertical's deployment, where the only readers were the read-only SQL console with
   * system tables toggled on and a break-glass `scope pull --full`. A connection card could say
   * "HTTP 409 from scrive" and nothing more, while the nine words that were the entire diagnosis
   * ("requires valid personal number field") sat one hop away.
   *
   * `payload` rides along deliberately: what was SENT next to what came back is the difference
   * between reading an error and fixing it. Nothing here is a credential — a connector's secret
   * lives in the sealed directory, never in an intent — and the rows are the tenant's own scope's,
   * behind the same K-3 addressing as every other scope read.
   */
  app.get('/tenants/:tenantId/scopes/:scopeId/intents', async (c) => {
    const tenantId = tenantIdSchema.parse(c.req.param('tenantId'));
    const scopeId = scopeIdSchema.parse(c.req.param('scopeId'));
    const principal = c.get('principal');
    if (principal.kind === 'builder' && principal.tenantId !== tenantId) {
      return c.json({ error: `unknown scope for tenant: (${tenantId}, ${scopeId})` }, 404);
    }
    const filter = platformRequestFilter.parse({
      kind: c.req.query('kind'),
      status: c.req.query('status'),
      limit: c.req.query('limit') ? Number(c.req.query('limit')) : undefined,
    });
    const scope = await admin.getScopeRecord(c.get('actor'), tenantId, scopeId);
    if (!scope) return c.json({ error: `unknown scope for tenant: (${tenantId}, ${scopeId})` }, 404);
    // Same delegation ladder as the table reads: the intents live in the DO of the scope's BOUND
    // version, so a hosted scope is asked through its vertical and a co-located one locally.
    const vertical = await verticalForScope(c, scope);
    return c.json(
      vertical
        ? await vertical.listPlatformRequestHistory(tenantId, scopeId, filter)
        : await host.listPlatformRequestHistory(tenantId, scopeId, filter),
    );
  });

  // #332: re-provision a scope stuck at "roles projected, zero tuples" — the enforcement flip
  // switched on against an empty tuple table, so every login denies and the owner is locked out
  // with no lever (the platform secret is the CP's, not the builder's). This is that lever: the
  // CP re-runs the vertical's idempotent provision on the builder's behalf. The vertical re-sources
  // the owner from its own owner-of-record; the platform never hands over PLATFORM_SECRET. Builder
  // or staff — a builder only for a scope running a vertical its own tenant owns (mirrors
  // adopt-serving). Entitlements are re-gathered here, authoritative, exactly as at provision (#310).
  app.post('/tenants/:tenantId/scopes/:scopeId/provision', async (c) => {
    const tenantId = tenantIdSchema.parse(c.req.param('tenantId'));
    const scopeId = scopeIdSchema.parse(c.req.param('scopeId'));
    const actor = c.get('actor');
    const scope = await admin.getScopeRecord(actor, tenantId, scopeId);
    if (!scope) return c.json({ error: `unknown scope for tenant: (${tenantId}, ${scopeId})` }, 404);
    const p = c.get('principal');
    if (p.kind === 'builder') {
      const v = scope.vertical ? await verticalOf(actor, scope.vertical) : undefined;
      if (!v || v.ownerTenant !== p.tenantId) return c.json({ error: 'forbidden' }, 403);
    }
    const vertical = await verticalForScope(c, scope);
    if (!vertical) return c.json({ error: await diagnoseUnboundScope(c.get('actor'), scope) }, 501);
    const entitlements = await admin.listEntitlements(actor, tenantId);
    // #406: re-gathered and re-delivered like entitlements, so a reconcile also repairs a
    // dropped identity-link delivery — and is the channel a link/unlink after provision rides.
    const identityLinks = (await admin.listIdentityLinks(actor, tenantId)).map(
      ({ tenantId: _tenantId, ...link }) => link,
    );
    // #592: connection grants ride the same authoritative gather — the back-fill for a
    // scope provisioned before `grantToConnection` ran, and how a revoked connection's
    // grants stop being delivered (they are absent from the directory's live rows).
    // #726 gap 2: heal FIRST, gather second. The gather only ever delivered grants that
    // already existed as directory rows, so a capability the connector requires and the
    // connection never received was repairable only by re-submitting the credential. This
    // is the operator's existing lever (`substrat scope provision`, the idempotent
    // repair), so a missing grant is now fixed by the same command that fixes everything
    // else — and by a push, once a connector's declaration changes.
    //
    // Best-effort: healing reaches the directory and must never take the reconcile down
    // with it. A failure here leaves exactly the behaviour that shipped before it existed.
    try {
      await reconcileConnectionGrants(
        { admin, actor, declared: options.connectorGrants ?? {} },
        tenantId,
        scope.vertical,
      );
    } catch {
      // The next reconcile tries again; the read-back still shows what is missing.
    }
    const connectionGrants = connectionGrantsForScope(
      await admin.listConnectionGrants(actor, tenantId),
      scope.vertical,
      scopeId,
    );
    // #687: connection sealing keys ride the same gather — the back-fill for a scope
    // provisioned before its connection existed, and the channel a connection made AFTER
    // provision rides. Minted on first ask, so this is also how a connection older than
    // the feature acquires a keypair without being reconnected.
    const connectionKeys = scope.vertical
      ? await admin.connectionSealingKeys(tenantId, scope.vertical)
      : [];
    // #825: the BACKFILL seam for per-tenant stores. Minting lived only in the
    // tenant-creation lifecycle, so a tenant created before its vertical declared a
    // `runtimeNeeds` store never got one and nothing ever gave it one — the vertical then
    // fails at first use, in production, with nothing an operator can reach. This is the
    // lever they already reach for (`substrat scope provision`, the idempotent repair), so
    // it mints and attaches what the serving version declares before reconciling. Safe to
    // re-run by construction: both collectors are idempotent on (tenant, vertical, binding)
    // and the binding attach is additive, so a scope whose stores already exist re-resolves
    // the same refs and changes nothing.
    //
    // BEST-EFFORT, and each substrate independently (#828). Minting reaches Cloudflare, so
    // it fails for reasons that have nothing to do with this scope — a credential missing a
    // permission, a store API refusing, a client the deployment never configured. Letting
    // that throw took the whole call down, which cost the caller the RECONCILE they came
    // for: the owner re-grant and role re-projection that is this lever's original job
    // (#332) and that has no relation to stores. It also answered a bare 500, so the
    // operator could not tell a missing credential from a bad scope id.
    //
    // This is the posture the promote-path backfill already has (`backfillFleetStores`) and
    // for the same reason: the repair must report what it could not do, not refuse to do
    // the rest. The two paths now agree. What does NOT get this treatment is a NEW install
    // (`POST /verticals/:slug/instances`, below): there the store is handed into the K-31
    // ready-gate and a fresh install without it is simply broken, so a failed mint must
    // fail the provision rather than hand back a half-built scope.
    const storeErrors: string[] = [];
    const mintBestEffort = async <T>(stage: string, mint: () => Promise<T>): Promise<T | undefined> => {
      try {
        return await mint();
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        console.error('stores.provision.failed', { tenantId, scopeId, vertical: scope.vertical, stage, detail: message });
        recordFailure({
          actor,
          operation: 'scope.provision.stores',
          stage,
          tenantId,
          scopeId,
          vertical: scope.vertical,
          status: e instanceof ControlPlaneError ? e.status : null,
          message,
        });
        storeErrors.push(message);
        return undefined;
      }
    };
    // Independently, so a D1 refusal does not silently skip the R2 mint (and vice versa):
    // a scope declaring both would otherwise report one fault, get half its stores, and
    // need a second run to discover the other.
    const tenantStores = scope.vertical
      ? ((await mintBestEffort('tenant-stores', () =>
          collectTenantStoreHandles({
            host: options.host,
            actor,
            slug: scope.vertical as string,
            tenantId,
            patchBindings: options.patchScriptBindings,
          }),
        )) ?? [])
      : [];
    if (scope.vertical) {
      await mintBestEffort('blob-stores', () =>
        collectBlobStoreHandles({
          host: options.host,
          actor,
          slug: scope.vertical as string,
          tenantId,
          patchBindings: options.patchScriptBindings,
        }),
      );
    }
    try {
      const result = await vertical.reconcileInstance({
        tenantId,
        scopeId,
        entitlements,
        identityLinks,
        connectionGrants,
        connectionKeys,
        // Handed over exactly as at provision: a store minted HERE has never been migrated
        // by the vertical, so the reconcile must carry it into the same ready-gate — a bound
        // but unmigrated database fails as loudly as an absent one.
        ...(tenantStores.length ? { tenantStores } : {}),
      });
      // The reconcile succeeded; a store that did not mint rides back as a diagnosis
      // (`substrat scope provision` prints it, and `/health` keeps reporting the gap
      // until it closes). Absent when nothing failed, so the response is unchanged for
      // every scope that has no declared store or already has them all.
      return c.json(storeErrors.length ? { ...result, storeError: storeErrors.join('; ') } : result);
    } catch (e) {
      if (e instanceof ControlPlaneError) {
        // Both halves failed. The store fault is usually the CAUSE (an unmigrated or
        // unbound store is exactly what makes a vertical refuse its own reconcile), so
        // it must not be the half that gets dropped.
        const detail = storeErrors.length ? `${e.message} (stores: ${storeErrors.join('; ')})` : e.message;
        return c.json({ error: detail }, e.status as ContentfulStatusCode);
      }
      throw e;
    }
  });

  app.get('/tenants/:tenantId/scopes/:scopeId/tables/:table', async (c) => {
    const tenantId = tenantIdSchema.parse(c.req.param('tenantId'));
    const scopeId = scopeIdSchema.parse(c.req.param('scopeId'));
    const input = readScopeTableInput.parse({
      table: c.req.param('table'),
      limit: c.req.query('limit') ? Number(c.req.query('limit')) : undefined,
      offset: c.req.query('offset') ? Number(c.req.query('offset')) : undefined,
    });
    const scope = await admin.getScopeRecord(c.get('actor'), tenantId, scopeId);
    if (!scope) return c.json({ error: `unknown scope for tenant: (${tenantId}, ${scopeId})` }, 404);
    const vertical = await verticalForScope(c, scope);
    return c.json(
      vertical
        ? await vertical.readScopeTable(scopeId, input)
        : await admin.readScopeTable(c.get('actor'), tenantId, scopeId, input),
    );
  });

  // The SQL console (#219): one read-only statement, POSTed because SQL does not
  // belong in a URL. Same delegation as the table reads; the gate's refusal maps to
  // 400 (errors.ts), and a vertical that cannot answer safely (auth-server, whose
  // DO redacts secret columns on table reads — arbitrary SQL would walk around the
  // redaction) refuses via its own 501, relayed verbatim.
  app.post('/tenants/:tenantId/scopes/:scopeId/query', async (c) => {
    const tenantId = tenantIdSchema.parse(c.req.param('tenantId'));
    const scopeId = scopeIdSchema.parse(c.req.param('scopeId'));
    const input = queryScopeInput.parse(await c.req.json());
    const scope = await admin.getScopeRecord(c.get('actor'), tenantId, scopeId);
    if (!scope) return c.json({ error: `unknown scope for tenant: (${tenantId}, ${scopeId})` }, 404);
    const vertical = await verticalForScope(c, scope);
    return c.json(
      vertical
        ? await vertical.queryScope(scopeId, input)
        : await admin.queryScope(c.get('actor'), tenantId, scopeId, input),
    );
  });

  // The K-35 denial log (#867) — the third of the platform's three logs and the last to
  // get a reader. `/admin-log` holds staff mutations and the K-24 access log staff
  // reads; these are the refusals, and they live in the SCOPE's database rather than the
  // directory because a denial rolls its own operation back. Same delegation ladder as
  // the table reads: a hosted scope is asked through its vertical, a co-located one
  // locally. Builders read only their own tenant — a foreign one is hidden as 404 (K-3),
  // matching every other scope-addressed read here.
  //
  // Two routes, not one with a flag. The bucketed view returns a different shape, and it
  // is the one an operator opens first — "who has been probing for access they don't
  // hold" is a question about counts.
  app.get('/tenants/:tenantId/scopes/:scopeId/denials', async (c) => {
    const tenantId = tenantIdSchema.parse(c.req.param('tenantId'));
    const scopeId = scopeIdSchema.parse(c.req.param('scopeId'));
    const principal = c.get('principal');
    if (principal.kind === 'builder' && principal.tenantId !== tenantId) {
      return c.json({ error: `unknown scope for tenant: (${tenantId}, ${scopeId})` }, 404);
    }
    const filter = denialLogQuery.parse(c.req.query());
    const scope = await admin.getScopeRecord(c.get('actor'), tenantId, scopeId);
    if (!scope) return c.json({ error: `unknown scope for tenant: (${tenantId}, ${scopeId})` }, 404);
    const vertical = await verticalForScope(c, scope);
    return c.json(
      vertical
        ? await vertical.listDenials(scopeId, filter)
        : await admin.listDenials(c.get('actor'), tenantId, scopeId, filter),
    );
  });

  app.get('/tenants/:tenantId/scopes/:scopeId/denials/summary', async (c) => {
    const tenantId = tenantIdSchema.parse(c.req.param('tenantId'));
    const scopeId = scopeIdSchema.parse(c.req.param('scopeId'));
    const principal = c.get('principal');
    if (principal.kind === 'builder' && principal.tenantId !== tenantId) {
      return c.json({ error: `unknown scope for tenant: (${tenantId}, ${scopeId})` }, 404);
    }
    const filter = denialLogQuery.parse(c.req.query());
    const scope = await admin.getScopeRecord(c.get('actor'), tenantId, scopeId);
    if (!scope) return c.json({ error: `unknown scope for tenant: (${tenantId}, ${scopeId})` }, 404);
    const vertical = await verticalForScope(c, scope);
    return c.json(
      vertical
        ? await vertical.summarizeDenials(scopeId, filter)
        : await admin.summarizeDenials(c.get('actor'), tenantId, scopeId, filter),
    );
  });

  // The owner seat (#925). Both reads go to the VERTICAL — the seat lives in its identity
  // directory, in its deployment — after the same K-3 cross-check every scope-addressed read
  // here makes. A co-located scope (contract-test host, self-host running no vertical code)
  // has no seat to ask about, so that is a 501 with the diagnosis rather than a fabricated
  // "claimed". The claim route additionally needs the instance's public origin, which the
  // platform — owner of the hostname directory — supplies rather than trusting a body: the
  // scope's canonical `app` hostname, or the first active one bound to it.
  app.get('/tenants/:tenantId/scopes/:scopeId/owner-seat', async (c) => {
    const tenantId = tenantIdSchema.parse(c.req.param('tenantId'));
    const scopeId = scopeIdSchema.parse(c.req.param('scopeId'));
    const principal = c.get('principal');
    if (principal.kind === 'builder' && principal.tenantId !== tenantId) {
      return c.json({ error: `unknown scope for tenant: (${tenantId}, ${scopeId})` }, 404);
    }
    const scope = await admin.getScopeRecord(c.get('actor'), tenantId, scopeId);
    if (!scope) return c.json({ error: `unknown scope for tenant: (${tenantId}, ${scopeId})` }, 404);
    const vertical = await verticalForScope(c, scope);
    if (!vertical) return c.json({ error: await diagnoseUnboundScope(c.get('actor'), scope) }, 501);
    try {
      return c.json(await vertical.ownerSeat(tenantId, scopeId));
    } catch (e) {
      if (e instanceof ControlPlaneError) return c.json({ error: e.message }, e.status as ContentfulStatusCode);
      throw e;
    }
  });

  app.post('/tenants/:tenantId/scopes/:scopeId/owner-claim', async (c) => {
    const tenantId = tenantIdSchema.parse(c.req.param('tenantId'));
    const scopeId = scopeIdSchema.parse(c.req.param('scopeId'));
    const principal = c.get('principal');
    if (principal.kind === 'builder' && principal.tenantId !== tenantId) {
      return c.json({ error: `unknown scope for tenant: (${tenantId}, ${scopeId})` }, 404);
    }
    const actor = c.get('actor');
    const scope = await admin.getScopeRecord(actor, tenantId, scopeId);
    if (!scope) return c.json({ error: `unknown scope for tenant: (${tenantId}, ${scopeId})` }, 404);
    const vertical = await verticalForScope(c, scope);
    if (!vertical) return c.json({ error: await diagnoseUnboundScope(actor, scope) }, 501);
    // The address the link opens on: the scope's canonical `app` hostname, preferring one
    // the platform has activated but not requiring it — a platform hostname is bound
    // `pending` and activated a step later, and that step can fail while the app is fully
    // reachable (#294). `failed` is the one state that never routes, so only it is skipped.
    const bound = (await admin.listHostnames(actor, { scopeId })).filter((h) => h.status !== 'failed');
    const pick = (hs: typeof bound) =>
      hs.find((h) => h.surface === 'app' && h.canonical) ?? hs.find((h) => h.surface === 'app') ?? hs[0];
    const host = pick(bound.filter((h) => h.status === 'active')) ?? pick(bound);
    if (!host) {
      return c.json(
        { error: `scope ${scopeId} has no hostname bound — a claim link needs an address to open on` },
        409,
      );
    }
    try {
      return c.json(await vertical.mintOwnerClaim({ tenantId, scopeId, origin: `https://${host.hostname}` }), 201);
    } catch (e) {
      if (e instanceof ControlPlaneError) return c.json({ error: e.message }, e.status as ContentfulStatusCode);
      throw e;
    }
  });

  // Deliver per-instance CONFIG to the scope's own storage (vertical-auth-detach.md
  // §2.2) — the missing "delivery" step behind the dashboard's Env tab. Same K-3
  // addressing + bound-version resolution as introspection: the scope's DO lives in the
  // deployment of its BOUND version, so that is where its config must land. A scope with
  // no reachable vertical deployment (co-located/contract-test hosts run no vertical
  // code) has nowhere to deliver to — 501, so the caller can tell "authored but not
  // delivered" from "failed". The vertical's own status (e.g. its 501 for no live-config
  // support) propagates rather than collapsing to a 500.
  app.post('/tenants/:tenantId/scopes/:scopeId/configure', async (c) => {
    const tenantId = tenantIdSchema.parse(c.req.param('tenantId'));
    const scopeId = scopeIdSchema.parse(c.req.param('scopeId'));
    const input = configureInstanceBody.parse(await c.req.json());
    const scope = await admin.getScopeRecord(c.get('actor'), tenantId, scopeId);
    if (!scope) return c.json({ error: `unknown scope for tenant: (${tenantId}, ${scopeId})` }, 404);
    const vertical = await verticalForScope(c, scope);
    if (!vertical) {
      return c.json({ error: await diagnoseUnboundScope(c.get('actor'), scope) }, 501);
    }
    try {
      await vertical.configureInstance({ tenantId, scopeId, entries: input.entries });
    } catch (e) {
      if (e instanceof ControlPlaneError) {
        return c.json({ error: e.message }, e.status as ContentfulStatusCode);
      }
      throw e;
    }
    return c.json({ applied: input.entries.length });
  });

  // The four lifecycle transitions, one route each — mirroring the four audited
  // actions rather than collapsing into a PATCH that would accept a target
  // status the transition graph forbids. The graph is enforced below the seam;
  // an illegal transition surfaces as a 409.
  const transitions = {
    activate: (a: PlatformActorId, t: TenantId, s: ScopeId) => admin.activateScope(a, t, s),
    suspend: (a: PlatformActorId, t: TenantId, s: ScopeId) => admin.suspendScope(a, t, s),
    unsuspend: (a: PlatformActorId, t: TenantId, s: ScopeId) => admin.unsuspendScope(a, t, s),
    archive: (a: PlatformActorId, t: TenantId, s: ScopeId) => admin.archiveScope(a, t, s),
    unarchive: (a: PlatformActorId, t: TenantId, s: ScopeId) => admin.unarchiveScope(a, t, s),
  } as const;

  for (const [action, run] of Object.entries(transitions)) {
    app.post(`/tenants/:tenantId/scopes/:scopeId/${action}`, async (c) => {
      const tenantId = tenantIdSchema.parse(c.req.param('tenantId'));
      const scopeId = scopeIdSchema.parse(c.req.param('scopeId'));
      await run(c.get('actor'), tenantId, scopeId);
      return c.json(await admin.getScopeRecord(c.get('actor'), tenantId, scopeId));
    });
  }

  // -- snapshots (preview-and-snapshots.md §3/§9) -----------------------------
  // The DATA half of a snapshot runs inside the vertical's own deployment (the
  // scope's bytes never cross the boundary — the §9 property the trust line rests
  // on); the DIRECTORY half — provenance row, activation, version bind — runs here.
  // With no vertical client resolved (co-located host, tests, self-host) the host's
  // in-process snapshotScope does both halves against its own SCOPE namespace.
  const orchestratedSnapshot = async (
    c: { get: (k: 'actor') => PlatformActorId },
    tenantId: TenantId,
    scope: Scope,
    opts: { kind?: string; expiresAt?: string },
  ): Promise<ScopeId> => {
    const actor = c.get('actor');
    const vertical = await verticalForScope(c, scope);
    if (!vertical) return options.host.snapshotScope(actor, tenantId, scope.id, opts);
    const snapId = scopeIdSchema.parse(ulid());
    // Directory row FIRST, as `provisioning` (K-31's two-phase shape, used as
    // intended): a crash between the row and the data copy leaves an inert
    // provisioning row — which, carrying provenance and an expiry, the GC sweep
    // eventually reaps — never copied data with no record.
    await options.host.provisionScope(actor, {
      tenantId,
      scopeId: snapId,
      kind: opts.kind ?? 'archive',
      vertical: scope.vertical,
      jurisdiction: scope.jurisdiction,
      forkedFrom: scope.id,
      forkedAt: new Date().toISOString(),
      expiresAt: opts.expiresAt,
    });
    await retryTransient(() => vertical.snapshotScope({ sourceScopeId: scope.id, newScopeId: snapId }));
    await admin.activateScope(actor, tenantId, snapId);
    // Bound to the SOURCE's current version: source and fork share a deployment, so
    // the fork resolves to the DO namespace its bytes actually live in.
    if (scope.verticalVersionId) {
      await admin.bindScopeVersion(actor, tenantId, snapId, scope.verticalVersionId);
    }
    return snapId;
  };

  // The forks OF one scope — what a Snapshots UI lists. A directory read (kind,
  // provenance, expiry all live on the scope row); newest first.
  app.get('/tenants/:tenantId/scopes/:scopeId/snapshots', async (c) => {
    const tenantId = tenantIdSchema.parse(c.req.param('tenantId'));
    const scopeId = scopeIdSchema.parse(c.req.param('scopeId'));
    const scopes = await admin.listScopes(c.get('actor'), { tenantId });
    return c.json(
      scopes
        .filter((s) => s.forkedFrom === scopeId)
        .sort((a, b) => (a.forkedAt! < b.forkedAt! ? 1 : -1)),
    );
  });

  app.post('/tenants/:tenantId/scopes/:scopeId/snapshots', async (c) => {
    const tenantId = tenantIdSchema.parse(c.req.param('tenantId'));
    const scopeId = scopeIdSchema.parse(c.req.param('scopeId'));
    const body = snapshotScopeBody.parse(await c.req.json().catch(() => ({})));
    const scope = await admin.getScopeRecord(c.get('actor'), tenantId, scopeId);
    if (!scope) return c.json({ error: `unknown scope for tenant: (${tenantId}, ${scopeId})` }, 404);
    try {
      const snapId = await orchestratedSnapshot(c, tenantId, scope, body);
      return c.json(await admin.getScopeRecord(c.get('actor'), tenantId, snapId), 201);
    } catch (e) {
      if (e instanceof ControlPlaneError) {
        return c.json({ error: e.message }, e.status as ContentfulStatusCode);
      }
      throw e;
    }
  });

  // Reap a fork. The fork-only refusal is surfaced HERE, before any delegation —
  // the vertical must never even be asked to wipe a primary scope — and re-checked
  // below the seam by deleteSnapshot, which also wipes the co-located storage,
  // removes hostnames + the directory row, and writes the audit entry.
  /**
   * Wipe a scope's co-located bytes via the vertical's `/internal/delete-scope`,
   * tolerating the ONE refusal that must never pin a directory row forever: a script
   * that never implemented the verb (answers 501 — the standalone-app shape; the
   * retired auth-server lineage is the canonical case). Those bytes are unreachable
   * through every platform verb — export and delete alike — so they stay in the
   * script's own storage and die with the script at orphan cleanup (#248): the same
   * stranded-not-deleted posture as rebind's `abandonData`. Anything else (a real
   * 5xx, a timeout) still aborts — an implemented wipe that failed is a retry, not a
   * shrug. Returns true when the storage was stranded.
   */
  const deleteScopeStorageOrStrand = async (
    vertical: { deleteScope(input: { scopeId: ScopeId }): Promise<void> } | null | undefined,
    scopeId: ScopeId,
  ): Promise<boolean> => {
    if (!vertical) return false;
    try {
      await vertical.deleteScope({ scopeId });
      return false;
    } catch (e) {
      if (e instanceof ControlPlaneError && e.status === 501) return true;
      throw e;
    }
  };

  app.delete('/tenants/:tenantId/scopes/:scopeId', async (c) => {
    const tenantId = tenantIdSchema.parse(c.req.param('tenantId'));
    const scopeId = scopeIdSchema.parse(c.req.param('scopeId'));
    const actor = c.get('actor');
    const scope = await admin.getScopeRecord(actor, tenantId, scopeId);
    if (!scope) return c.json({ error: `unknown scope for tenant: (${tenantId}, ${scopeId})` }, 404);
    if (!scope.forkedFrom) {
      return c.json(
        { error: `scope ${scopeId} is not a fork — only snapshots may be deleted` },
        409,
      );
    }
    try {
      // Vertical's storage first, then the in-process delete (refusal re-check,
      // local/placeholder wipe, hostnames + directory row, audit) — the same
      // storage-before-row ordering deleteSnapshot itself keeps, so a crash
      // between the two converges on retry.
      const vertical = await verticalForScope(c, scope);
      const storageStranded = await deleteScopeStorageOrStrand(vertical, scopeId);
      await options.host.deleteSnapshot(actor, tenantId, scopeId);
      return c.json({ deleted: scopeId, ...(storageStranded ? { storageStranded: true } : {}) });
    } catch (e) {
      if (e instanceof ControlPlaneError) {
        return c.json({ error: e.message }, e.status as ContentfulStatusCode);
      }
      throw e;
    }
  });

  // -- backups (#493) --------------------------------------------------------
  // The recoverable copy a reap leaves behind. Delegation mirrors the export route
  // exactly: `admin.exportScope` is the canonical call — it writes the K-24 access-log
  // entry, and IS the bytes when the host is co-located — and a vertical-held scope's
  // real tables overlay it. FULL fidelity, never masked: a masked dump cannot restore,
  // and a backup that cannot restore is a false promise (see `backups.ts`).
  const backupScope = async (
    c: { get: (k: 'actor') => PlatformActorId },
    tenantId: TenantId,
    scope: Scope,
  ): Promise<ScopeBackup> => {
    const store = options.scopeBackups;
    if (!store) {
      throw new ControlPlaneError(
        501,
        'no backup target configured — this control plane cannot store a scope backup ' +
          '(bind one, or reap with backup=false to accept an unrecoverable wipe)',
      );
    }
    // Residency (K-7/K-32): the platform bucket is global, so writing a jurisdiction-
    // pinned scope's bytes into it would move them out of the region the scope was
    // promised. Refuse rather than back up to the wrong place — and, because the reap
    // aborts with it, rather than wipe a scope we cannot legally copy.
    if (scope.jurisdiction !== 'global') {
      throw new ControlPlaneError(
        409,
        `scope ${scope.id} is pinned to '${scope.jurisdiction}' — the platform backup ` +
          `store is global, so a backup would move its data out of that jurisdiction ` +
          `(K-32); refused until a per-jurisdiction store exists`,
      );
    }
    const dump = await admin.exportScope(c.get('actor'), tenantId, scope.id);
    const vertical = await verticalForScope(c, scope);
    const tables = vertical ? await vertical.exportScope(scope.id) : dump.tables;
    // Seal classified payloads per subject on the way in (#37). This copy is full-fidelity
    // and the platform keeps it, which is precisely why an erasure could never reach it: a
    // redaction fixes the live scope and does nothing to the object already in R2. Sealed
    // here, destroying one subject's key reaches backwards into every copy already taken.
    // Restores open it again (`restoreFromBackup`) — except for subjects shredded in the
    // meantime, which is the mechanism working rather than the copy being damaged.
    const sealed = await sealDump(tables, sealerFor(c, tenantId, scope.id));
    return store.put({ vertical: scope.vertical, dump: { ...dump, tables: sealed } });
  };

  // The copies held for one scope — metadata only, so listing a reaped scope's backups
  // is cheap and hands out no bytes. Readable AFTER the reap (that is the point): the
  // directory row survives as a tombstone, and this is what tells the operator a
  // recoverable copy exists and when it was taken.
  app.get('/tenants/:tenantId/scopes/:scopeId/backups', async (c) => {
    const tenantId = tenantIdSchema.parse(c.req.param('tenantId'));
    const scopeId = scopeIdSchema.parse(c.req.param('scopeId'));
    if (!options.scopeBackups) return c.json({ error: 'no backup target configured' }, 501);
    // Reads the directory, not the store, for the tenant cross-check: the store is keyed
    // by (tenant, scope) but nothing there proves the caller's tenant owns the scope.
    const scope = await admin.getScopeRecord(c.get('actor'), tenantId, scopeId);
    if (!scope) return c.json({ error: `unknown scope for tenant: (${tenantId}, ${scopeId})` }, 404);
    return c.json(await options.scopeBackups.list({ tenantId, scopeId }));
  });

  // One backup's DUMP — the restore source. Staff-only like the export it came from
  // (not in BUILDER_ROUTES), and full-fidelity, so it is the same governed-pull posture:
  // K-3 cross-checked above, and `POST …/restore` is where it goes back.
  app.get('/tenants/:tenantId/scopes/:scopeId/backups/:capturedAt', async (c) => {
    const tenantId = tenantIdSchema.parse(c.req.param('tenantId'));
    const scopeId = scopeIdSchema.parse(c.req.param('scopeId'));
    const capturedAt = c.req.param('capturedAt');
    if (!options.scopeBackups) return c.json({ error: 'no backup target configured' }, 501);
    const scope = await admin.getScopeRecord(c.get('actor'), tenantId, scopeId);
    if (!scope) return c.json({ error: `unknown scope for tenant: (${tenantId}, ${scopeId})` }, 404);
    const dump = await options.scopeBackups.get({ tenantId, scopeId, capturedAt });
    if (!dump) return c.json({ error: `no backup for scope ${scopeId} at ${capturedAt}` }, 404);
    // Unseal on the way out (#37). The bytes in the store stay sealed — this is the
    // authorized read opening them with the keys the platform holds. A subject shredded
    // since the copy was taken opens to a null payload, which is exactly the erasure
    // working: the ciphertext never left the object, and nothing turns it back into a
    // person. A dump taken before sealing existed passes through untouched.
    const opened = await openDump(dump.tables, sealerFor(c, tenantId, scopeId));
    return c.json({ ...dump, tables: opened });
  });

  // Take a backup WITHOUT reaping — the standalone copy (a pre-migration checkpoint, an
  // export-to-keep). The reap route below takes its own; this is the same act made
  // available on its own, so "back up" is not something only a destructive path can do.
  app.post('/tenants/:tenantId/scopes/:scopeId/backups', async (c) => {
    const tenantId = tenantIdSchema.parse(c.req.param('tenantId'));
    const scopeId = scopeIdSchema.parse(c.req.param('scopeId'));
    const scope = await admin.getScopeRecord(c.get('actor'), tenantId, scopeId);
    if (!scope) return c.json({ error: `unknown scope for tenant: (${tenantId}, ${scopeId})` }, 404);
    try {
      return c.json(await backupScope(c, tenantId, scope), 201);
    } catch (e) {
      if (e instanceof ControlPlaneError) {
        return c.json({ error: e.message }, e.status as ContentfulStatusCode);
      }
      throw e;
    }
  });

  // -- subject erasure (#37) --------------------------------------------------
  // Erase one data subject from one scope: redact the spine payloads keyed to them, then
  // destroy the key that seals every platform-retained copy of those payloads.
  //
  // Staff-only, and NOT in BUILDER_ROUTES. That placement is the shared-responsibility line
  // drawn where hosting-and-certification.md §3 already draws it — "we provide extraction,
  // they define scope". A builder forwards the request; the platform executes it and hands
  // back a receipt they can answer their data subject with. Making it self-service would
  // hand a vertical the ability to destroy evidence about a person on its own authority,
  // which is a different decision than this one and belongs in its own issue.
  //
  // Idempotent by construction: a re-run redacts nothing (the payloads are already null),
  // reports `keyDestroyed: false` (the key is already gone) and still returns
  // `tombstoned: true`. Safe to retry, which matters because the audited half and the
  // cryptographic half are two writes.
  app.post('/tenants/:tenantId/scopes/:scopeId/subjects/:subjectId/shred', async (c) => {
    const tenantId = tenantIdSchema.parse(c.req.param('tenantId'));
    const scopeId = scopeIdSchema.parse(c.req.param('scopeId'));
    // A ULID, like every other subject id the spine carries — parsed rather than trusted,
    // so a wildcard or an injection attempt is a 400 and never reaches the UPDATE.
    const subjectId = dataSubjectIdSchema.parse(c.req.param('subjectId'));
    const scope = await admin.getScopeRecord(c.get('actor'), tenantId, scopeId);
    if (!scope) return c.json({ error: `unknown scope for tenant: (${tenantId}, ${scopeId})` }, 404);
    return c.json(await admin.shredSubject(c.get('actor'), tenantId, scopeId, subjectId));
  });

  // -- directory backups (#40) -----------------------------------------------
  // The platform's own disaster recovery, on the same store posture as the scope
  // backups above and deliberately on a different axis from them: a scope has ~30-day
  // point-in-time recovery, the directory has one Durable Object and no second copy of
  // the mapping that makes every scope addressable. These routes are the manual arms of
  // the cron phase (`backupDirectoryIfDue`) — take one now, see what is held, and the
  // break-glass restore. Staff-only: none is in BUILDER_ROUTES, and none is per-tenant,
  // because the subject of all three is every tenant at once.

  // What copies exist, newest first — metadata only, so this is cheap and hands out no
  // bytes. This is also the answer to "is the backup actually running?", which is the
  // question an unrehearsed backup story never has a way to ask.
  app.get('/directory/backups', async (c) => {
    if (!options.directoryBackups) return c.json({ error: 'no directory backup target configured' }, 501);
    return c.json(await options.directoryBackups.list());
  });

  // Take one NOW, cadence ignored — the pre-migration checkpoint an operator takes by
  // hand before touching the directory, and the way a fresh deployment gets its first
  // copy without waiting a day for the cron.
  app.post('/directory/backups', async (c) => {
    if (!options.directoryBackups) return c.json({ error: 'no directory backup target configured' }, 501);
    const result = await backupDirectoryIfDue({
      admin,
      store: options.directoryBackups,
      actor: c.get('actor'),
      force: true,
    });
    return c.json(result.taken as DirectoryBackup, 201);
  });

  // One copy's DUMP — the restore source, and the off-platform escape hatch: an operator
  // who wants the directory on their own disk GETs this. The most privileged read the
  // control plane offers (every tenant, every hostname, every identity), so staff-only
  // and audited by `exportDirectory` underneath.
  app.get('/directory/backups/:capturedAt', async (c) => {
    if (!options.directoryBackups) return c.json({ error: 'no directory backup target configured' }, 501);
    const capturedAt = c.req.param('capturedAt');
    const dump = await options.directoryBackups.get({ capturedAt });
    if (!dump) return c.json({ error: `no directory backup at ${capturedAt}` }, 404);
    return c.json(dump);
  });

  // Break-glass: REPLACE the directory with a stored copy.
  //
  // Guarded by an explicit `overwrite` rather than a confirmation string, because the
  // dangerous case is not a slip of the fingers — it is a well-formed retry against a
  // control plane that has already recovered, which would silently roll the platform
  // back to the copy's moment and lose every tenant created since. So a directory that
  // still holds tenants refuses (409) unless the caller says, in the body, that
  // replacing them is the intent. An EMPTY directory — the actual disaster, a fresh DO
  // with nothing in it — needs no such ceremony.
  app.post('/directory/restore', async (c) => {
    if (!options.directoryBackups) return c.json({ error: 'no directory backup target configured' }, 501);
    const body = restoreDirectoryBody.parse(await c.req.json().catch(() => ({})));
    const dump = await options.directoryBackups.get({ capturedAt: body.capturedAt });
    if (!dump) return c.json({ error: `no directory backup at ${body.capturedAt}` }, 404);
    const actor = c.get('actor');
    const live = await admin.listTenants(actor, { limit: 1 });
    if (live.length > 0 && !body.overwrite) {
      return c.json(
        {
          error:
            'the directory is not empty — a restore REPLACES it, so anything created ' +
            'since this copy was taken would be lost; pass overwrite=true to confirm',
        },
        409,
      );
    }
    await admin.restoreDirectory(actor, dump);
    return c.json({ capturedAt: dump.capturedAt, tables: dump.tables.length });
  });

  // Reap an ARCHIVED primary scope (control-plane.md §4.4): free its DO storage —
  // Cloudflare never garbage-collects a Durable Object, so a deleted app's bytes persist
  // forever otherwise — while keeping the directory row as a tombstone. A POST verb, not
  // DELETE: DELETE means "remove the record" (and is already the fork hard-delete above),
  // whereas reap KEEPS the row and just moves it to `reaped`. Staff/service only — not in
  // BUILDER_ROUTES. The archived-only refusal is surfaced HERE before any delegation (the
  // vertical must never be asked to wipe a live scope) and re-checked below the seam by
  // reapScope. Same storage-before-row ordering as deleteSnapshot: the vertical wipes its
  // co-located DO first, then the in-process reapScope flips the status and audits.
  app.post('/tenants/:tenantId/scopes/:scopeId/reap', async (c) => {
    const tenantId = tenantIdSchema.parse(c.req.param('tenantId'));
    const scopeId = scopeIdSchema.parse(c.req.param('scopeId'));
    const actor = c.get('actor');
    // Body is optional so the bare `POST …/reap` every existing caller sends still
    // parses; `backup` tri-states on purpose (see the ordering comment below).
    const { backup: wantsBackup } = reapScopeBody.parse(await c.req.json().catch(() => ({})));
    const scope = await admin.getScopeRecord(actor, tenantId, scopeId);
    if (!scope) return c.json({ error: `unknown scope for tenant: (${tenantId}, ${scopeId})` }, 404);
    if (scope.status !== 'archived') {
      return c.json(
        { error: `scope ${scopeId} is ${scope.status}, not archived — only an archived scope may be reaped` },
        409,
      );
    }
    // Refuse a scope that still resolves a hostname BEFORE any delegation — the vertical's
    // `deleteScope` below wipes the hosted DO's bytes, so this must gate ahead of it, not
    // only in `reapScope` after. A serving app always holds a bound name; unbind it first.
    // (This route is the interactive per-scope reap; the tenant-teardown route forces past
    // the same guard because releasing every name is the point there.)
    const boundNames = await admin.listHostnames(actor, { scopeId, limit: 1 });
    if (boundNames.length > 0) {
      return c.json(
        {
          error:
            `scope ${scopeId} still resolves hostname '${boundNames[0]!.hostname}' — ` +
            `unbind it before reaping (reap wipes storage and cannot be undone)`,
        },
        409,
      );
    }
    // The recoverable copy, BEFORE any byte is wiped (#493). Ordering is the whole
    // guarantee: `backupScope` has to have resolved — durably stored — before
    // `deleteScope` runs, so a store that throws (or is missing when one was asked for)
    // aborts the reap with the scope intact. `backup: false` is the explicit "I accept an
    // unrecoverable wipe"; omitting it backs up when a store is configured and proceeds
    // without one when the platform has none.
    //
    // Its own try/catch, OUTSIDE the reap's: a backup failure and a reap failure are
    // different facts to an operator, and collapsing a dead bucket into the generic 500
    // would read as "the reap broke" when the scope is in fact untouched (#321's lesson).
    let backup: ScopeBackup | null = null;
    if (!(wantsBackup === false || (wantsBackup === undefined && !options.scopeBackups))) {
      try {
        backup = await backupScope(c, tenantId, scope);
      } catch (e) {
        if (e instanceof ControlPlaneError) {
          return c.json({ error: e.message }, e.status as ContentfulStatusCode);
        }
        return c.json(
          {
            error:
              'backup failed — the scope was NOT reaped and its data is intact; ' +
              'retry, or reap with backup=false to accept an unrecoverable wipe',
            detail: e instanceof Error ? e.message : String(e),
          },
          502,
        );
      }
    }
    try {
      const vertical = await verticalForScope(c, scope);
      // By this point the backup contract has resolved (a copy landed, or the caller
      // explicitly declined one), so stranding is a bookkeeping fact, not data loss.
      const storageStranded = await deleteScopeStorageOrStrand(vertical, scopeId);
      await admin.reapScope(actor, tenantId, scopeId, {
        ...(backup ? { backupRef: backupRefOf(backup) } : {}),
      });
      const reaped = await admin.getScopeRecord(actor, tenantId, scopeId);
      return c.json({ ...reaped, backup, ...(storageStranded ? { storageStranded: true } : {}) });
    } catch (e) {
      if (e instanceof ControlPlaneError) {
        return c.json({ error: e.message }, e.status as ContentfulStatusCode);
      }
      throw e;
    }
  });

  // The governed pull (preview-and-snapshots.md §6/§8) — the ONE route that
  // deliberately hands scope BYTES to the caller, which is why every §6 layer sits
  // on it: staff-only (not in BUILDER_ROUTES), K-3 cross-checked, K-24 audited (the
  // exportScope access-log entry), jurisdiction-gated, and MASKED by default —
  // `?full=true` is the explicit break-glass. Dumps are JSON-safe today (no BLOB
  // columns exist in any schema); a vertical that adds one needs an encoding here.
  app.get('/tenants/:tenantId/scopes/:scopeId/export', async (c) => {
    const tenantId = tenantIdSchema.parse(c.req.param('tenantId'));
    const scopeId = scopeIdSchema.parse(c.req.param('scopeId'));
    const actor = c.get('actor');
    const scope = await admin.getScopeRecord(actor, tenantId, scopeId);
    if (!scope) return c.json({ error: `unknown scope for tenant: (${tenantId}, ${scopeId})` }, 404);
    // Residency (K-7/K-32): jurisdiction pins EXECUTION, not just storage. A pull
    // lands the data on a machine outside the platform's control, so anything
    // pinned tighter than `global` is refused until a compliant path exists.
    if (scope.jurisdiction !== 'global') {
      return c.json(
        {
          error:
            `scope ${scopeId} is pinned to '${scope.jurisdiction}' — a local pull would ` +
            `move its data outside that jurisdiction; refused (K-32, preview-and-snapshots.md §6)`,
        },
        403,
      );
    }
    const full = c.req.query('full') === 'true';
    try {
      // The canonical export first: it writes the K-24 access-log entry and is the
      // bytes when the host is co-located. When the scope's data lives in a vertical
      // deployment, its dump OVERLAYS the (placeholder) tables — audit stays on the
      // one canonical path either way.
      const dump = await admin.exportScope(actor, tenantId, scopeId);
      const vertical = await verticalForScope(c, scope);
      const tables = vertical ? await vertical.exportScope(scopeId) : dump.tables;
      return c.json({ ...dump, tables: full ? tables : maskDump(tables), masked: !full });
    } catch (e) {
      if (e instanceof ControlPlaneError) {
        return c.json({ error: e.message }, e.status as ContentfulStatusCode);
      }
      throw e;
    }
  });

  // -- tenant export (#36) ----------------------------------------------------
  //
  // GDPR Art. 20 portability, and the escrow handover: one tenant, whole, in one file.
  //
  // Composed ENTIRELY from the sanctioned reads above — `listScopes`, `listOrgs`,
  // `listMembers`, `listRoles`, `listEntitlements`, `listIdentityLinks`,
  // `listHostnames`, the store ledgers, `listConnections`, `exportScope`. That is the
  // constraint the design puts on this route, not an implementation preference:
  // control-plane.md §7 says the control plane must not acquire a back door into scope
  // databases, and the only sanctioned path is the audited admin surface. An export
  // that reached past it would BE the back door — and every read here is already
  // K-24 access-logged, so the trail is a property of the parts.
  //
  // It is deliberately NOT the same shape as a directory dump (#40): that one is raw
  // tables for recovery, this one is the platform's documented vocabulary for a reader
  // who does not know the schema. Only the per-scope `data` is raw, because that is the
  // half that has to be reloadable.
  app.get('/tenants/:tenantId/export', async (c) => {
    const tenantId = tenantIdSchema.parse(c.req.param('tenantId'));
    const actor = c.get('actor');
    const tenant = await admin.getTenant(actor, tenantId);
    if (!tenant) return c.json({ error: `unknown tenant: ${tenantId}` }, 404);

    // Every scope, tombstones included: an archived or reaped scope is part of the
    // tenant's history, and an export that quietly dropped them would misrepresent what
    // the tenant was. Their DATA is a different question, handled below.
    const scopes = await admin.listScopes(actor, { tenantId });

    // Residency (K-7/K-32), checked across the WHOLE tenant before anything is read: an
    // export lands on a machine outside the platform's control, so one pinned scope
    // taints the file. Refused as a unit rather than silently exporting the global
    // scopes and omitting the pinned ones — a partial export that does not say it is
    // partial is the failure mode worth avoiding.
    const pinned = scopes.filter((s) => s.jurisdiction !== 'global');
    if (pinned.length > 0) {
      return c.json(
        {
          error:
            `tenant ${tenantId} has ${pinned.length} scope(s) pinned to a jurisdiction ` +
            `(${[...new Set(pinned.map((s) => s.jurisdiction))].join(', ')}) — an export would ` +
            `move that data out of the region it was promised; refused (K-32). Export the ` +
            `global scopes individually, or wait for a per-jurisdiction path.`,
        },
        403,
      );
    }

    const full = c.req.query('full') === 'true';
    try {
      const orgs = await admin.listOrgs(actor, tenantId);
      // Revoked memberships included: K-21 makes a removal a tombstone precisely because
      // "was a member until March" is the fact an audit asks for.
      const members = (
        await Promise.all(
          orgs.map((o) => admin.listMembers(actor, tenantId, o.id, { includeRevoked: true })),
        )
      ).flat();
      const [roles, entitlements, identityLinks, hostnames, stores, blobStores, connections] =
        await Promise.all([
          admin.listRoles(actor, { tenantId }),
          admin.listEntitlements(actor, tenantId),
          admin.listIdentityLinks(actor, tenantId),
          admin.listHostnames(actor, { tenantId }),
          admin.listTenantStores(actor, { tenantId }),
          admin.listBlobStores(actor, { tenantId }),
          admin.listConnections(actor, { tenantId }),
        ]);

      // Scope DATA, from the same delegation the per-scope export route uses: the
      // canonical `exportScope` writes the audit entry and is the bytes when co-located;
      // a vertical-held scope's real tables overlay it. A reaped scope has no storage
      // left to read, so it is skipped here while its RECORD stays above — the tombstone
      // is honest, an error would not be.
      const live = scopes.filter((s) => s.status !== 'reaped');
      const data: ScopeDump[] = [];
      for (const scope of live) {
        const dump = await admin.exportScope(actor, tenantId, scope.id);
        const vertical = await verticalForScope(c, scope);
        const tables = vertical ? await vertical.exportScope(scope.id) : dump.tables;
        data.push({ ...dump, tables: full ? tables : maskDump(tables) });
      }

      // The admin log is FULL-only (#36): it records what STAFF did, so it is not the
      // customer's Art. 20 data, and it carries staff actor ids and internal action
      // names. An escrow or a dispute needs it, which is why break-glass reaches it
      // rather than nothing reaching it.
      const adminLog = full ? await admin.auditLog(actor, { tenantId }) : null;

      const body: TenantExport = {
        tenantId,
        capturedAt: new Date().toISOString(),
        masked: !full,
        tenant: full ? tenant : maskRecords([tenant])[0]!,
        scopes: full ? scopes : maskRecords(scopes),
        orgs: full ? orgs : maskRecords(orgs),
        members: full ? members : maskRecords(members),
        // Roles, entitlements and hostnames are configuration rather than personal data,
        // so they read the same in both fidelities — but they still go through the sweep,
        // because deciding per-collection what "cannot contain PII" means is exactly the
        // assumption that ages badly. One rule, applied everywhere.
        roles: full ? roles : maskRecords(roles),
        entitlements: full ? entitlements : maskRecords(entitlements),
        // Identity links are the sharpest item here: `externalId` is usually an email.
        identityLinks: full ? identityLinks : maskRecords(identityLinks),
        hostnames: full ? hostnames : maskRecords(hostnames),
        stores: [...stores, ...blobStores].map((s) => ({
          kind: s.kind,
          vertical: s.vertical,
          binding: s.binding,
          ref: s.ref,
          createdAt: s.createdAt,
        })),
        connections: full ? connections : maskRecords(connections),
        adminLog,
        data,
      };
      return c.json(body);
    } catch (e) {
      if (e instanceof ControlPlaneError) {
        return c.json({ error: e.message }, e.status as ContentfulStatusCode);
      }
      throw e;
    }
  });

  // The write half of the governed pull (§8) — load a dump INTO an existing scope:
  // restore a backup, back out to a snapshot, or land a locally-built world on a
  // hosted app. Staff-only like the export (not in BUILDER_ROUTES). No jurisdiction
  // gate: this is ingress — the data ENTERS the scope's pinned region, it never
  // leaves one. Mirrors the export's delegation shape: the canonical `restoreScope`
  // writes the audit row (and the co-located bytes); when the scope's data lives in
  // a vertical deployment, the same dump is then loaded THERE — the bytes the router
  // actually serves. (Yes, that stores the dump twice in delegated mode; the
  // placeholder copy is the price of one canonical audited path, same as export.)
  app.post('/tenants/:tenantId/scopes/:scopeId/restore', async (c) => {
    const tenantId = tenantIdSchema.parse(c.req.param('tenantId'));
    const scopeId = scopeIdSchema.parse(c.req.param('scopeId'));
    const actor = c.get('actor');
    const scope = await admin.getScopeRecord(actor, tenantId, scopeId);
    if (!scope) return c.json({ error: `unknown scope for tenant: (${tenantId}, ${scopeId})` }, 404);
    const dump = scopeDump.parse(await c.req.json());
    // A backup with no tables is not a scope dump — name that plainly rather than letting
    // the empty replay reach the checker and surface as a bare `internal error` (#321).
    if (dump.tables.length === 0) {
      return c.json({ error: 'restore refused: the backup has no tables — not a scope dump' }, 422);
    }
    try {
      // Belt and braces for #37: a caller who fetched the object bytes by some other route
      // may POST a still-sealed dump, and a scope restored full of ciphertext is a silent
      // data-loss bug. `openDump` skips cells that are not sealed, so a plaintext dump —
      // the normal case, since the GET above already opened it — costs one pass and
      // changes nothing.
      //
      // Opened against the dump's OWN provenance, not the destination. Subject keys are
      // keyed by (scope, subject), so a copy of scope A landing in scope B — a backout onto
      // a different scope, a world loaded sideways — must be opened with A's keys. Using
      // the destination's would find no key, null every payload, and call it a restore.
      const origin = { tenantId: tenantIdSchema.parse(dump.tenantId), scopeId: scopeIdSchema.parse(dump.scopeId) };
      const tables = await openDump(dump.tables, sealerFor(c, origin.tenantId, origin.scopeId));
      const landing = { ...dump, tables };
      await host.restoreScope(actor, tenantId, scopeId, landing);
      const vertical = await verticalForScope(c, scope);
      if (vertical) await retryTransient(() => vertical.restoreScope(tenantId, scopeId, tables));
      return c.json({ restored: scopeId, tables: tables.length });
    } catch (e) {
      if (e instanceof ControlPlaneError) {
        return c.json({ error: e.message }, e.status as ContentfulStatusCode);
      }
      // A restore throw is driven by the caller-supplied dump (a shape the target cannot
      // load, a DDL the engine rejects), so DISCLOSE it as an actionable 422 rather than
      // collapsing to the generic 500 `internal error` mapError would produce (#321,
      // secondary obs #2). The route is staff/owner-gated and the detail is about the
      // dump the caller sent, not another tenant's state.
      const detail = e instanceof Error ? e.message : String(e);
      return c.json({ error: 'restore failed — the backup could not be loaded', detail }, 422);
    }
  });

  // #286: the PITR bookmarks a scope recorded before its migration passes — the
  // rewind points the deployments UI offers for a backout. Read through the
  // vertical that holds the scope's data when one resolves; the co-located host
  // otherwise. Metadata only — no scope bytes cross the boundary, so no masking.
  app.get('/tenants/:tenantId/scopes/:scopeId/bookmarks', async (c) => {
    const tenantId = tenantIdSchema.parse(c.req.param('tenantId'));
    const scopeId = scopeIdSchema.parse(c.req.param('scopeId'));
    const actor = c.get('actor');
    const scope = await admin.getScopeRecord(actor, tenantId, scopeId);
    if (!scope) return c.json({ error: `unknown scope for tenant: (${tenantId}, ${scopeId})` }, 404);
    const vertical = await verticalForScope(c, scope);
    return c.json(
      vertical
        ? await vertical.migrationBookmarks(scopeId)
        : await admin.scopeMigrationBookmarks(actor, tenantId, scopeId),
    );
  });

  // #286's backout: rewind a scope to a pre-migration bookmark — schema AND data,
  // discarding every write since. Audited below the seam BEFORE the rewind runs;
  // the scope DO enforces the freshness window (24h unless force). Delegated to the
  // vertical that holds the scope's data when one resolves, applied on the
  // co-located host otherwise.
  app.post('/tenants/:tenantId/scopes/:scopeId/rewind', async (c) => {
    const tenantId = tenantIdSchema.parse(c.req.param('tenantId'));
    const scopeId = scopeIdSchema.parse(c.req.param('scopeId'));
    const { bookmark, force } = z
      .object({ bookmark: z.string().min(1), force: z.boolean().optional() })
      .parse(await c.req.json());
    const actor = c.get('actor');
    const scope = await admin.getScopeRecord(actor, tenantId, scopeId);
    if (!scope) return c.json({ error: `unknown scope for tenant: (${tenantId}, ${scopeId})` }, 404);
    try {
      const vertical = await verticalForScope(c, scope);
      const result = await admin.rewindScope(actor, tenantId, scopeId, bookmark, {
        force,
        localApply: !vertical,
      });
      if (vertical) {
        return c.json(await vertical.rewindScope(scopeId, bookmark, { force }));
      }
      return c.json(result);
    } catch (e) {
      if (e instanceof ControlPlaneError) {
        return c.json({ error: e.message }, e.status as ContentfulStatusCode);
      }
      throw e;
    }
  });

  // #286/#321: adopt a LEGACY scope onto its vertical's stable serving script — the
  // one-time data hop off per-version dispatch, and the builder-triggerable backfill for
  // installs that predate the in-place serve. The whole body lives in
  // `adoptScopeOntoServing` (shared with the automatic adoption a prod promote runs);
  // here it is just mapped to a JSON response.
  app.post('/tenants/:tenantId/scopes/:scopeId/adopt-serving', async (c) => {
    const tenantId = tenantIdSchema.parse(c.req.param('tenantId'));
    const scopeId = scopeIdSchema.parse(c.req.param('scopeId'));
    try {
      const r = await adoptScopeOntoServing(c, tenantId, scopeId);
      return c.json({ adopted: scopeId, ...r });
    } catch (e) {
      if (e instanceof ControlPlaneError) {
        return c.json({ error: e.message }, e.status as ContentfulStatusCode);
      }
      throw e;
    }
  });

  // Backfill EVERY still-legacy active scope of a vertical in one call — the vertical-wide
  // trigger for an install that predates the in-place serve. Owner or staff (owned-slug
  // checked by the confinement middleware). Idempotent: already-adopted scopes are skipped
  // and reported. A per-scope failure stops the run and surfaces which scope failed, so a
  // re-run resumes from there (each adopt is data-first and retry-safe).
  app.post('/verticals/:slug/adopt-serving', async (c) => {
    const p = c.get('principal');
    const slug = await resolveVerticalId(c, c.req.param('slug'));
    const actor = c.get('actor');
    if (p.kind === 'builder') {
      const v = await verticalOf(actor, slug);
      if (!v || v.ownerTenant !== p.tenantId) return c.json({ error: 'forbidden' }, 403);
    }
    const v = await verticalOf(actor, slug);
    if (!v) return c.json({ error: `unknown vertical '${slug}'` }, 404);
    if (v.ownerTenant === null) {
      return c.json({ error: 'adopt-serving is a private-vertical operation' }, 409);
    }
    const owned = (
      await admin.listScopes(actor, { tenantId: v.ownerTenant, vertical: slug })
    ).filter((s) => !s.forkedFrom && s.status === 'active');
    const adopted: string[] = [];
    const alreadyAdopted: string[] = [];
    try {
      for (const s of owned) {
        const r = await adoptScopeOntoServing(c, s.tenantId, s.id);
        (r.alreadyAdopted ? alreadyAdopted : adopted).push(s.id);
      }
    } catch (e) {
      if (e instanceof ControlPlaneError) {
        return c.json({ error: e.message, adopted, alreadyAdopted }, e.status as ContentfulStatusCode);
      }
      throw e;
    }
    return c.json({ vertical: slug, adopted, alreadyAdopted });
  });

  // Rebind ONE scope onto a different vertical lineage (#389) — the update-rebind that
  // retires a platform-owned lineage in favour of a tenant-owned one. Deliberately NOT
  // in BUILDER_ROUTES: a lineage crossing re-homes a customer's data under a different
  // registry owner, which is a staff decision like admission — the allowlist's
  // default-deny 403s a builder without a line here.
  app.post('/tenants/:tenantId/scopes/:scopeId/rebind-vertical', async (c) => {
    const tenantId = tenantIdSchema.parse(c.req.param('tenantId'));
    const scopeId = scopeIdSchema.parse(c.req.param('scopeId'));
    const { vertical, ackMigrations, abandonData } = rebindScopeVerticalBody.parse(
      await c.req.json(),
    );
    try {
      const r = await rebindScopeOntoVertical(c, tenantId, scopeId, vertical, {
        ackMigrations,
        abandonData,
      });
      return c.json({ rebound: scopeId, vertical, ...r });
    } catch (e) {
      if (e instanceof ControlPlaneError) {
        return c.json({ error: e.message }, e.status as ContentfulStatusCode);
      }
      throw e;
    }
  });

  // Pin a scope to a vertical version (#31; orchestration.md §4). Refuses a
  // non-admitted version below the seam — that refusal is the registry's reason to
  // exist. A scope operation, so it keeps the scope route shape. `snapshot: true`
  // opts into fork-before-promote (§4): on a migration-digest-crossing bind the
  // pre-migration data is snapshotted first — orchestrated through the vertical
  // when one resolves, in-process otherwise.
  app.post('/tenants/:tenantId/scopes/:scopeId/version', async (c) => {
    const tenantId = tenantIdSchema.parse(c.req.param('tenantId'));
    const scopeId = scopeIdSchema.parse(c.req.param('scopeId'));
    const { versionId, snapshot } = bindScopeVersionBody.parse(await c.req.json());
    const actor = c.get('actor');
    if (snapshot) {
      const scope = await admin.getScopeRecord(actor, tenantId, scopeId);
      if (!scope) {
        return c.json({ error: `unknown scope for tenant: (${tenantId}, ${scopeId})` }, 404);
      }
      const vertical = await verticalForScope(c, scope);
      if (vertical) {
        // Delegated path: the digest compare lives here (the in-process path does
        // it below the seam). Snapshot only a migration-crossing bind.
        if (scope.vertical && scope.verticalVersionId) {
          const [current, incoming] = await Promise.all([
            admin.getVersion(actor, scope.verticalVersionId, scope.vertical),
            admin.getVersion(actor, versionId, scope.vertical),
          ]);
          if (current && incoming && current.migrationDigest !== incoming.migrationDigest) {
            await orchestratedSnapshot(c, tenantId, scope, {});
          }
        }
        await admin.bindScopeVersion(actor, tenantId, scopeId, versionId);
      } else {
        await admin.bindScopeVersion(actor, tenantId, scopeId, versionId, { snapshot: true });
      }
      return c.json(await admin.getScopeRecord(actor, tenantId, scopeId));
    }
    await admin.bindScopeVersion(actor, tenantId, scopeId, versionId);
    return c.json(await admin.getScopeRecord(actor, tenantId, scopeId));
  });

  // -- instances (K-31) -------------------------------------------------------
  // The one place this surface calls OUT rather than sitting over `HostAdmin`, and
  // it is unavoidable: only the vertical can create a usable scope DO, because the
  // DO class bundles the modules and lives in the vertical's own deployment.
  //
  // The DIRECTORY row is not written here. The console writes it after this
  // succeeds, so the ordering is vertical-then-directory: a failure leaves an
  // orphaned scope nobody can see, rather than a directory row promising a scope
  // that does not exist. `scopeStatus` has a `provisioning` state for expressing the
  // in-between properly, and it is still unused — see the PR.

  app.post('/verticals/:slug/instances', async (c) => {
    const slug = c.req.param('slug');
    // The install kill-switch: a blocked vertical takes no NEW instances, for anyone
    // including its owner. Refused before deployment resolution so the answer is
    // uniform whether or not anything is deployed. Existing scopes keep serving.
    const registered = (await admin.listVerticals(c.get('actor'))).find((v) => v.slug === slug);
    if (registered?.installsBlocked) {
      return c.json({ error: `new installs of vertical '${slug}' are blocked` }, 403);
    }
    // Static binding first (milestone-one shape), then the dispatch resolver for a
    // pushed vertical — the provisioning mirror of the router's verticalFor.
    const vertical =
      options.verticals?.[slug] ?? (await options.resolveVertical?.(slug, c.get('actor')));
    if (!vertical) {
      return c.json({ error: `no deployment is bound for vertical '${slug}'` }, 501);
    }
    const input = provisionInstanceBody.parse(await c.req.json());
    // #310: the platform is the authoritative source of the tenant's entitlements — it
    // gathers them HERE (not from the caller's body) and delivers them WITH provisioning so
    // the CP-less vertical projects them and enforces plan/quota/expiry at request time
    // (#304). A vertical predating the field ignores it; grant/revoke AFTER provision ride
    // a re-provision (this endpoint is idempotent, K-31), meanwhile expiry still enforces
    // locally because the projected row carries it.
    const entitlements = await admin.listEntitlements(c.get('actor'), input.tenantId);
    // #406: identity links ride the same authoritative gather — the vertical projects them
    // so its auth adapter resolves logins from local storage, and offboarding becomes an
    // unlink + re-deliver instead of a source edit + deploy.
    const identityLinks = (await admin.listIdentityLinks(c.get('actor'), input.tenantId)).map(
      ({ tenantId: _tenantId, ...link }) => link,
    );
    // #592: connection grants too — tenant-wide rows materialize for the NEW scope, so an
    // install provisioned after `grantToConnection` holds the same `connection:<id>` tuple
    // as one provisioned before it, and the connector return path works without a human
    // replaying grants per install.
    // #726 gap 2: heal before gathering here too, so a NEW install of a vertical whose
    // connector has since declared another grant receives it — rather than inheriting the
    // gap the tenant's first install was created with.
    try {
      await reconcileConnectionGrants(
        { admin, actor: c.get('actor'), declared: options.connectorGrants ?? {} },
        input.tenantId,
        slug,
      );
    } catch {
      // Best-effort, exactly as on the reconcile route.
    }
    const connectionGrants = connectionGrantsForScope(
      await admin.listConnectionGrants(c.get('actor'), input.tenantId),
      slug,
      input.scopeId,
    );
    // #687: and the public sealing keys of this tenant's live connections for the same
    // vertical, so the new install can seal a value TO a connector from its first
    // operation — before this, a scope could only receive a connector's answer, never
    // hand it something the spine must not carry in the clear.
    const connectionKeys = await admin.connectionSealingKeys(input.tenantId, slug);
    // #301 PR-2: per-tenant relational stores the vertical DECLARED, minted here (before
    // the callback — the vertical migrates the store inside the K-31 ready-gate, so it
    // must exist and be bound first). Idempotent like the endpoint: a retried provision
    // re-resolves the same handles and the binding attach no-ops once present. `[]` for
    // every vertical that declares none — the payload is unchanged for them.
    const tenantStores = await collectTenantStoreHandles({
      host: options.host,
      actor: c.get('actor'),
      slug,
      tenantId: input.tenantId,
      patchBindings: options.patchScriptBindings,
    });
    // #473: per-tenant BLOB stores the vertical declared, minted + bound the same way.
    // No handle rides the provision callback (a blob store has no schema to migrate), so
    // the effect is purely the ledger row + the attached r2_bucket binding.
    await collectBlobStoreHandles({
      host: options.host,
      actor: c.get('actor'),
      slug,
      tenantId: input.tenantId,
      patchBindings: options.patchScriptBindings,
    });
    try {
      // #424 case 2: the binding attach above races Cloudflare script-settings
      // propagation, so the vertical's FIRST answer can be a transient 5xx that a
      // retry moments later heals. `provisionInstance` is idempotent at the far end
      // (K-31), so ride the window out on a short backoff.
      const instance = await retryTransient(() =>
        vertical.provisionInstance({
          ...(input as Parameters<VerticalClient['provisionInstance']>[0]),
          entitlements,
          identityLinks,
          connectionGrants,
          connectionKeys,
          ...(tenantStores.length ? { tenantStores } : {}),
        }),
      );
      return c.json(instance, 201);
    } catch (e) {
      // Propagate the vertical's own status rather than collapsing it to a 500. A
      // 403 means the platform secrets do not match — a deployment error someone
      // must act on, and indistinguishable from "the vertical is broken" once it
      // has been flattened.
      if (e instanceof ControlPlaneError) {
        // The retry above already rode out the transient window, so a 5xx here is a
        // provision the platform could not complete — record it (#559). Refusals
        // (4xx, and 501 = not implemented) stay unrecorded: the caller can read them.
        if (e.status >= 500 && e.status !== 501) {
          recordFailure({
            actor: c.get('actor'),
            operation: 'install.provision',
            vertical: slug,
            tenantId: input.tenantId,
            status: e.status,
            message: e.message,
          });
        }
        return c.json({ error: e.message }, e.status as ContentfulStatusCode);
      }
      throw e;
    }
  });

  // -- vertical + version registry (#31; orchestration.md §5.6) --------------
  // Thin pass-throughs to `HostAdmin`. Register a vertical, publish a version
  // (lands PENDING — a push is not a deploy), admit/reject at the checkpoints,
  // promote a channel through the digest-diff gate, pin a scope to a version.
  //
  // A BUILDER (builder-plane.md §4) reaches only this subset (the confinement
  // middleware above), and only for verticals its tenant owns. `ownerOf` reads the
  // registry row's owner_tenant (undefined ⇒ not registered — a claimable slug).
  // `listVerticals` returns every row (the adapter does not narrow); the transport is
  // where per-principal filtering happens — here and on GET /verticals.
  const ownerOf = async (
    actor: PlatformActorId,
    slug: string,
  ): Promise<TenantId | null | undefined> => {
    const v = (await admin.listVerticals(actor)).find((x) => x.slug === slug);
    return v ? v.ownerTenant : undefined;
  };

  // The full registry row, for the checks that need more than the owner — whether the
  // vertical is PRIVATE (owned + not listed), which is what scopes a builder's prod
  // self-serve below.
  const verticalOf = async (actor: PlatformActorId, slug: string) =>
    (await admin.listVerticals(actor)).find((x) => x.slug === slug);

  // The vertical id a request actually addresses. For a BUILDER it is `<tenantSlug>/<name>`
  // (builder-plane.md §5): they send a bare `--slug`, the control plane forms the prefix
  // from their authenticated tenant — so two builders can each own a `helpdesk` with no
  // global claim race, and a builder can never name another tenant's namespace (their
  // prefix is fixed by auth). Idempotent: a builder addressing its own FULL id (e.g. the
  // `verticalSlug` a deploy response returned) is not double-prefixed — the prefix is
  // auth-derived either way, so this can never reach another tenant's namespace. Staff
  // address a vertical by its full id, so for them the raw slug is the identity. A builder
  // slug carrying any OTHER tenant's prefix yields a two-slash id that fails
  // `verticalSlug` validation / the ownership check downstream — fail-closed.
  const effectiveSlug = (p: Principal, raw: string): string =>
    p.kind === 'builder' ? (raw.startsWith(`${p.tenantSlug}/`) ? raw : `${p.tenantSlug}/${raw}`) : raw;

  // The ONE (bare slug, tenant context) → registry id resolution for the routes that
  // ADDRESS an existing vertical (#417). A builder's context is its auth (`effectiveSlug`,
  // unchanged). STAFF acting for a workspace — the CLI over a service token, the
  // dashboard's tenant-narrowed seam — name it via the same `x-substrat-tenant` header a
  // builder session uses, and the prefix is formed exactly as a pinned push forms it: a
  // bare slug the pinned workspace owns stays itself (staff hand-registrations predate
  // prefixed claims), otherwise `<workspace.slug>/<slug>` — but only when that row
  // EXISTS. Addressing never redirects to a lineage that is not there: a platform-owned
  // bare slug under an irrelevant pin, and an unknown pin, resolve to the raw slug —
  // exactly the pre-#417 behavior. Registration and deploy keep their own CLAIM
  // semantics; this helper only addresses lineages, it never decides where one lands.
  const resolveVerticalId = async (c: Context<{ Variables: Vars }>, raw: string): Promise<string> => {
    const p = c.get('principal');
    if (p.kind === 'builder') return effectiveSlug(p, raw);
    const pin = c.req.header(TENANT_HEADER)?.trim();
    if (!pin) return raw;
    const actor = c.get('actor');
    const workspace = (await admin.listTenants(actor)).find((t) => t.slug === pin || t.id === pin);
    if (!workspace || raw.startsWith(`${workspace.slug}/`)) return raw;
    if ((await ownerOf(actor, raw)) === workspace.id) return raw;
    const prefixed = `${workspace.slug}/${raw}`;
    return (await ownerOf(actor, prefixed)) !== undefined ? prefixed : raw;
  };

  app.get('/verticals', async (c) => {
    const page = pageParams(c);
    const all = await admin.listVerticals(c.get('actor'));
    const p = c.get('principal');
    // A builder sees only what it owns; staff see the whole registry. The narrowing
    // runs above the adapter, so the page is sliced here — over the narrowed list.
    const visible = p.kind === 'builder' ? all.filter((v) => v.ownerTenant === p.tenantId) : all;
    return c.json(pageSlice(visible, page, (v) => v.slug));
  });

  app.post('/verticals', async (c) => {
    const input = registerVerticalInput.parse(await c.req.json());
    const p = c.get('principal');
    if (p.kind === 'builder') {
      // The bare `--slug` becomes `<tenantSlug>/<name>`; claim it or re-register one this
      // tenant already owns (a slug owned by another tenant is refused — unreachable via
      // the prefix, backstopped by the ownership check). Owner + prefix come from the
      // principal, never trusted from the body.
      input.slug = effectiveSlug(p, input.slug);
      const owner = await ownerOf(p.actor, input.slug);
      if (owner !== undefined && owner !== p.tenantId) return c.json({ error: 'forbidden' }, 403);
      input.ownerTenant = p.tenantId;
    }
    await admin.registerVertical(c.get('actor'), input);
    // Idempotent on the slug (a conflicting re-register throws below the seam), so
    // read back rather than echo the request.
    const registered = (await admin.listVerticals(c.get('actor'))).find((v) => v.slug === input.slug);
    return c.json(registered, 201);
  });

  app.get('/verticals/:slug/versions', async (c) => {
    const p = c.get('principal');
    const slug = await resolveVerticalId(c, c.req.param('slug'));
    // A builder reading a vertical it does not own gets 404 — indistinguishable from
    // absent, the same fail-closed reflex K-3 uses for a cross-tenant scope.
    if (p.kind === 'builder' && (await ownerOf(p.actor, slug)) !== p.tenantId) {
      return c.json({ error: 'not found' }, 404);
    }
    const page = pageParams(c);
    const entries = await admin.listVersions(c.get('actor'), slug, page);
    return c.json(pageOf(entries, page.limit, (v) => v.id));
  });

  app.post('/verticals/:slug/versions', async (c) => {
    const input = publishVersionInput.parse(await c.req.json());
    // The slug is in the path AND the body; they must agree (both bare for a builder),
    // the same fail-closed cross-check `(tenantId, scopeId)` makes (K-3) — a mismatch is
    // a client bug, not a silent publish under the wrong vertical.
    if (input.verticalSlug !== c.req.param('slug')) {
      return c.json({ error: 'verticalSlug does not match the path' }, 400);
    }
    const p = c.get('principal');
    const slug = await resolveVerticalId(c, input.verticalSlug);
    if (p.kind === 'builder' && (await ownerOf(p.actor, slug)) !== p.tenantId) {
      return c.json({ error: 'forbidden' }, 403);
    }
    input.verticalSlug = slug;
    await admin.publishVersion(c.get('actor'), input);
    const version = await admin.getVersion(c.get('actor'), input.id, slug);
    return c.json(version, 201);
  });

  // The declared permission registry (D-39, #336) that ships inside one version's manifest:
  // keys+descriptions, role templates, entity-grant shapes — the machine-readable twin of
  // PERMISSIONS.md. Owner-narrowed exactly like the versions list (a builder reading a vertical
  // it does not own gets 404). `registry` is null for a version that retained no manifest
  // (pushed pre-#286) or declared no surface. The dashboard renders and diffs it; the promotion
  // permission-diff checkpoint stays the human gate — this route only reads.
  app.get('/verticals/:slug/versions/:id/registry', async (c) => {
    const p = c.get('principal');
    const slug = await resolveVerticalId(c, c.req.param('slug'));
    if (p.kind === 'builder' && (await ownerOf(p.actor, slug)) !== p.tenantId) {
      return c.json({ error: 'not found' }, 404);
    }
    const json = await admin.versionManifest(c.get('actor'), slug, c.req.param('id'));
    const registry = json ? (storedDeployManifest.parse(JSON.parse(json)).registry ?? null) : null;
    return c.json({ registry });
  });

  // The static files (#340) one version ships: path, size, content type, content address —
  // read straight out of the retained manifest, which is where they were persisted for the
  // promote path anyway. Owner-narrowed exactly like the registry route above. `assets` is
  // null for a version that retained no manifest (pushed pre-#286) or shipped no static
  // files; the two are distinguishable by the caller only as "nothing to show", which is
  // all the dashboard panel needs to render an empty state.
  app.get('/verticals/:slug/versions/:id/assets', async (c) => {
    const p = c.get('principal');
    const slug = await resolveVerticalId(c, c.req.param('slug'));
    if (p.kind === 'builder' && (await ownerOf(p.actor, slug)) !== p.tenantId) {
      return c.json({ error: 'not found' }, 404);
    }
    const json = await admin.versionManifest(c.get('actor'), slug, c.req.param('id'));
    const assets = json ? (storedDeployManifest.parse(JSON.parse(json)).assets ?? null) : null;
    return c.json({ assets });
  });

  app.post('/verticals/:slug/versions/:id/admit', async (c) => {
    const slug = c.req.param('slug');
    const id = c.req.param('id');
    await admin.admitVersion(c.get('actor'), id);
    return c.json(await admin.getVersion(c.get('actor'), id, slug));
  });

  app.post('/verticals/:slug/versions/:id/reject', async (c) => {
    const slug = c.req.param('slug');
    const id = c.req.param('id');
    const { note } = rejectVersionBody.parse(await c.req.json());
    await admin.rejectVersion(c.get('actor'), id, note);
    return c.json(await admin.getVersion(c.get('actor'), id, slug));
  });

  // A builder REQUESTS publication of a vertical it owns (marketplace-publish.md §5) — any owner
  // may ask; the staff `listing` flip below is the review gate. Owner-checked (like promote).
  app.post('/verticals/:slug/publish-request', async (c) => {
    const p = c.get('principal');
    const slug = await resolveVerticalId(c, c.req.param('slug'));
    if (p.kind === 'builder' && (await ownerOf(p.actor, slug)) !== p.tenantId) {
      return c.json({ error: 'not found' }, 404);
    }
    await admin.requestPublish(c.get('actor'), slug);
    return c.json({ slug, requested: true });
  });

  // Publish/unpublish a vertical to the PUBLIC marketplace (marketplace-publish.md §5). Staff
  // admission of a publish request — NOT in BUILDER_ROUTES, so a builder is refused (the review
  // gate). `listed` then makes `availableCatalog` offer it to every tenant + resolves the request.
  app.post('/verticals/:slug/listing', async (c) => {
    const slug = c.req.param('slug');
    const { listed } = z.object({ listed: z.boolean() }).parse(await c.req.json());
    await admin.setVerticalListed(c.get('actor'), slug, listed);
    return c.json({ slug, listed });
  });

  // The install kill-switch (staff-only — not in BUILDER_ROUTES, so a builder is
  // refused by the confinement middleware). Blocks NEW installs; existing scopes
  // keep serving. Orthogonal to /listing (visibility).
  app.post('/verticals/:slug/install-block', async (c) => {
    const slug = c.req.param('slug');
    const { blocked } = z.object({ blocked: z.boolean() }).parse(await c.req.json());
    await admin.setVerticalInstallsBlocked(c.get('actor'), slug, blocked);
    return c.json({ slug, installsBlocked: blocked });
  });

  // Grant/revoke the TENANT-PROVISIONER capability (#412) — whether this vertical's scopes
  // may enqueue provision-tenant / set-entitlements intents the platform executes. Staff-only
  // (not in BUILDER_ROUTES): granting platform authority is precisely the seam a vertical's
  // owner must not control. The drain's admitManager reads the flag at execution time.
  app.post('/verticals/:slug/tenant-provisioner', async (c) => {
    const slug = c.req.param('slug');
    const { granted } = z.object({ granted: z.boolean() }).parse(await c.req.json());
    await admin.setVerticalTenantProvisioner(c.get('actor'), slug, granted);
    return c.json({ slug, tenantProvisioner: granted });
  });

  // Grant/revoke the EMAIL-SENDER capability (#303) — whether this vertical's scopes may POST to
  // the /internal/email/send relay and have transactional mail sent for them. Staff-only (not in
  // BUILDER_ROUTES): outbound authority is a platform decision, not the owner's. The relay handler
  // reads the flag on every send.
  app.post('/verticals/:slug/email-sender', async (c) => {
    const slug = c.req.param('slug');
    const { granted } = z.object({ granted: z.boolean() }).parse(await c.req.json());
    await admin.setVerticalEmailSender(c.get('actor'), slug, granted);
    return c.json({ slug, emailSender: granted });
  });

  // Delete a vertical + its versions and channels (staff-only, same confinement).
  // Refused below the seam while any scope is still bound — surfaces as a 4xx via
  // mapError, naming the count. Dispatch scripts become orphans for cleanup (#248).
  app.delete('/verticals/:slug', async (c) => {
    const slug = c.req.param('slug');
    await admin.deleteVertical(c.get('actor'), slug);
    return c.json({ slug, deleted: true });
  });

  app.get('/verticals/:slug/channels', async (c) => {
    const p = c.get('principal');
    const slug = await resolveVerticalId(c, c.req.param('slug'));
    if (p.kind === 'builder' && (await ownerOf(p.actor, slug)) !== p.tenantId) {
      return c.json({ error: 'not found' }, 404);
    }
    const page = pageParams(c);
    const entries = await admin.listChannels(c.get('actor'), slug, page);
    return c.json(pageOf(entries, page.limit, (ch) => ch.channel));
  });

  // The promotion timeline (newest first) — what a rollback UI picks a target from.
  // Owner-narrowed like the channel read above: a builder sees only its own verticals'
  // history, and a foreign slug 404s indistinguishably from an absent one.
  app.get('/verticals/:slug/channels/:channel/history', async (c) => {
    const p = c.get('principal');
    const slug = await resolveVerticalId(c, c.req.param('slug'));
    const rawChannel = c.req.param('channel');
    if (rawChannel !== 'prod') {
      return c.json({ error: `channel '${rawChannel}' is retired — only 'prod' has history` }, 400);
    }
    const channel = channelName.parse(rawChannel);
    if (p.kind === 'builder' && (await ownerOf(p.actor, slug)) !== p.tenantId) {
      return c.json({ error: 'not found' }, 404);
    }
    const page = pageParams(c);
    const entries = await admin.listChannelHistory(c.get('actor'), slug, channel, page);
    return c.json(pageOf(entries, page.limit, (e) => e.id));
  });

  /**
   * Serve a version IN PLACE (#286): upload its bundle onto the vertical's ONE stable
   * serving script, where every scope's data DO lives — this is the step that makes a
   * promote carry data forward instead of stranding it in the outgoing version's
   * script. Reads the module bytes back from the version's archive script and the
   * upload metadata from its retained manifest; the first serve creates the script
   * (full DO-class migrations), later serves update it (secrets kept, class delta only).
   *
   * Serving state is recorded only AFTER the upload succeeds. A failed serve throws —
   * the caller surfaces it — and leaves `servingVersionId` trailing the channel:
   * visible, and retried by promoting again.
   */
  const serveVersionInPlace = async (
    actor: PlatformActorId,
    slug: string,
    versionId: string,
  ): Promise<void> => {
    if (!options.deployVertical || !options.fetchVerticalModules) return; // not configured: pre-#286 behavior
    const version = await admin.getVersion(actor, versionId, slug);
    if (!version?.deploymentRef) {
      throw new ControlPlaneError(502, `version ${versionId} has no archive script to serve from`);
    }
    const archiveRef = version.deploymentRef;
    const manifestJson = await admin.versionManifest(actor, slug, versionId);
    if (!manifestJson) {
      throw new ControlPlaneError(
        502,
        `version ${versionId} retained no manifest — pushed pre-#286; push it again to serve in place`,
      );
    }
    const manifest = storedDeployManifest.parse(JSON.parse(manifestJson));
    const serving = await admin.verticalServing(actor, slug);
    const ref = serving?.ref ?? stableDeploymentRefFor(slug);
    const modules = await options.fetchVerticalModules(version.deploymentRef);
    // #301 PR-2: every serving upload re-derives the per-tenant store D1 bindings from
    // the ledger and sends them WITH the bundle's own bindings — an upload's `bindings`
    // replaces the script's set, so deriving from the ledger (not from what the script
    // happened to carry) is what makes a re-deploy structurally unable to drop a
    // tenant's store. Platform-granted after the §4 sandbox check, like injectSecrets:
    // the builder never declared these and never named the ids.
    const storeBindings = [
      ...tenantStoreBindings(await admin.listTenantStores(actor, { vertical: slug })),
      // #473: the per-tenant blob-store r2_bucket bindings, re-derived from the ledger on
      // every serving upload for the same reason — an upload replaces the script's binding
      // set, so a re-deploy must never drop a tenant's attachment bucket.
      ...blobStoreBindings(await admin.listBlobStores(actor, { vertical: slug })),
    ].map((b) =>
      b.type === 'd1'
        ? { type: 'd1', name: b.name, id: b.id }
        : { type: 'r2_bucket', name: b.name, bucket_name: b.bucketName },
    );
    await options.deployVertical(
      ref,
      {
        entry: manifest.entry,
        compatibilityDate: manifest.compatibilityDate,
        compatibilityFlags: manifest.compatibilityFlags,
        modules,
        doClasses: manifest.doClasses,
        bindings: [...manifest.bindings, ...storeBindings],
        // #1054: the model runtime is bound only for a version that ASKED for it, so the
        // capability is visible in the manifest diff at admit rather than fleet-wide.
        ...(manifest.usesModels ? { usesModels: true } : {}),
        // #340/#578: the version's static files travel with it onto the serving script —
        // from the RETAINED manifest, with no bytes. The runtime's asset store dedupes
        // per SCRIPT (not namespace-wide — the #578 finding), so the serving script only
        // skips hashes it has itself held before; everything else — every first serve of
        // new content — is recovered on demand from the version's archive script, the
        // same store the modules come back from (#286), and verified against its
        // content-address before upload. This is why the manifest is retained rather
        // than the bytes: the archive script gives back modules AND assets.
        ...(manifest.assets
          ? {
              assets: {
                ...manifest.assets,
                ...(options.fetchVerticalAsset
                  ? {
                      recoverContent: (asset: Pick<AssetUpload, 'path' | 'hash'>) =>
                        options.fetchVerticalAsset!(archiveRef, asset),
                    }
                  : {}),
              },
            }
          : {}),
      },
      serving
        ? { priorDoClasses: serving.doClasses, priorMigrationTag: serving.migrationTag }
        : undefined,
    );
    const addedClasses = serving
      ? manifest.doClasses.some((cls) => !serving.doClasses.includes(cls))
      : false;
    await admin.setVerticalServing(actor, slug, {
      ref,
      versionId,
      // The serving script's class set only ever GROWS (DO classes cannot be deleted
      // while their storage lives), so record the union, and the tag only moves when
      // a migration actually rode the upload.
      doClasses: serving
        ? [...new Set([...serving.doClasses, ...manifest.doClasses])]
        : manifest.doClasses,
      migrationTag: serving
        ? addedClasses
          ? nextMigrationTag(serving.migrationTag)
          : serving.migrationTag
        : 'v1',
    });
  };

  /**
   * Reconcile the INSTALLED FLEET's per-tenant stores to what the version now being served
   * declares (#825). Runs on promote, after the in-place serve, because that is the act
   * that makes a declaration real: until the serve, `verticalServing` still names the old
   * version and the declaration being backfilled would be the previous one.
   *
   * Without this, minting existed only in the tenant-creation lifecycle — a gate every
   * installed tenant passed long before the declaration was written — so declaring a store
   * in version N+1 gave it to nobody, and adopting it meant an operator remembering to
   * re-provision each install by hand. They forget, and the vertical then fails at first
   * use, in production, arbitrarily long after the deploy that introduced the need.
   *
   * Best-effort by construction, and deliberately NOT part of the serve's success: a
   * minting failure (the platform's Cloudflare credential, a store API refusing) must not
   * make a promote report failure when the new code is already live and serving. It lands
   * an ops-failure row, rides back in the promote response so the builder sees it at the
   * terminal, and the scope's own `/health` keeps reporting the gap until it closes —
   * `substrat scope provision` remains the per-scope retry.
   */
  const backfillFleetStores = async (
    c: { get: (k: 'actor') => PlatformActorId },
    slug: string,
  ): Promise<{ minted: MintedStore[]; error?: string }> => {
    const actor = c.get('actor');
    try {
      // Every tenant with an install that can still serve. Archived/reaped scopes are
      // excluded — minting a bucket for storage that is gone is pure waste.
      const scopes = await admin.listScopes(actor, {
        vertical: slug,
        status: ['provisioning', 'active', 'suspended'],
      });
      const tenantIds = [...new Set(scopes.map((s) => s.tenantId))];
      if (tenantIds.length === 0) return { minted: [] };
      const minted = await backfillDeclaredStores({
        host: options.host,
        actor,
        slug,
        tenantIds,
        patchBindings: options.patchScriptBindings,
      });
      if (minted.length) {
        console.log('stores.backfilled', { slug, count: minted.length });
      }
      return { minted };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      console.error('stores.backfill.failed', { slug, detail: message });
      recordFailure({ actor, operation: 'promote.store-backfill', vertical: slug, message });
      return { minted: [], error: message };
    }
  };

  app.post('/verticals/:slug/channels/:channel/promote', async (c) => {
    const p = c.get('principal');
    const slug = await resolveVerticalId(c, c.req.param('slug'));
    // `prod` is the only channel (#509 retired dev/staging). A non-prod promote is refused
    // with the honest alternative — a non-prod environment is a scope with data, a preview.
    const rawChannel = c.req.param('channel');
    if (rawChannel !== 'prod') {
      return c.json(
        {
          error:
            `channel '${rawChannel}' is retired — 'prod' is the only channel. To run a version ` +
            `against non-prod data, create a preview: 'substrat preview create --tag <tag>'.`,
        },
        400,
      );
    }
    const channel = channelName.parse(rawChannel);
    if (p.kind === 'builder') {
      // A builder promotes only verticals it owns — and prod only while the vertical
      // is PRIVATE (not listed). A private vertical's blast radius is the owning
      // tenant itself, and dev/staging already run the same bundle in the same
      // sandbox, so a staff prod gate there protected nothing; it returns the moment
      // the audience widens (publish flips `listed`, and prod becomes staff-only
      // again — the trust boundary marketplace-publish.md §2 draws).
      const v = await verticalOf(p.actor, slug);
      if (!v || v.ownerTenant !== p.tenantId) return c.json({ error: 'forbidden' }, 403);
      if (channel === 'prod' && v.listed) {
        return c.json({ error: 'promotion to prod is staff-only for a listed vertical' }, 403);
      }
    }
    const { versionId, acknowledge } = promoteVersionBody.parse(await c.req.json());
    // The blast-radius moment: refuses a changed digest without the acknowledgement,
    // and refuses a non-admitted version. Both are enforced below the seam and
    // surface as a 4xx through mapError, not a 500.
    await admin.promoteVersion(c.get('actor'), slug, channel, versionId, acknowledge);
    // The in-place serve (#286), prod only, AFTER every promote gate has passed —
    // uploading first would deploy to live scopes before the acknowledgement check.
    // A failed serve is NOT a failed promote: the channel moved (audited), old code
    // still serves, and promoting again retries the upload.
    let backfill: { minted: MintedStore[]; error?: string } = { minted: [] };
    if (channel === 'prod') {
      try {
        await serveVersionInPlace(c.get('actor'), slug, versionId);
        // Adopt any still-legacy owned scope onto the serving script and advance every
        // owned scope's version — the rebind the host cascade delegated to us for a
        // dispatch-backed vertical (#321), in the correct order (serve → adopt → rebind),
        // so a legacy scope's data survives the promote instead of being stranded on a
        // fresh per-version script. Retry-safe: nothing rebound these scopes yet.
        await adoptAndRebindOwnedScopes(c, slug, versionId);
        // #825: and mint whatever THIS version newly declares for the tenants already
        // installed — after the serve, so the declaration being read is the one now live.
        backfill = await backfillFleetStores(c, slug);
      } catch (e) {
        const detail = e instanceof Error ? e.message : String(e);
        console.error('serve.inplace.failed', { slug, versionId, detail });
        return c.json(
          {
            error: 'promoted, but the in-place serve failed — scopes still run the previous code; promote again to retry',
            detail,
          },
          502,
        );
      }
    }
    const promoted = (await admin.listChannels(c.get('actor'), slug)).find(
      (ch) => ch.channel === channel,
    );
    // The store backfill rides the response only when it has something to say (#825), so
    // nothing changes for the overwhelming majority of promotes — and when a store WAS
    // minted, or could not be, the builder reads it at the terminal rather than finding out
    // from a runtime throw weeks later.
    //
    // Named tenants are narrowed to what the caller may see: the sweep is fleet-wide (it has
    // to be — every install needs the store), but a BUILDER reads only its own tenant's
    // directory rows everywhere else (K-3, the forced filter on `GET /scopes`), and a promote
    // report must not be the one place that hands them the tenant ids of everyone who
    // installed their vertical. The rest is a count, which tells them the fleet was covered
    // without naming who is in it.
    const p2 = c.get('principal');
    const visible =
      p2.kind === 'builder' ? backfill.minted.filter((m) => m.tenantId === p2.tenantId) : backfill.minted;
    const otherTenants = new Set(
      backfill.minted.filter((m) => !visible.includes(m)).map((m) => m.tenantId),
    ).size;
    return c.json({
      ...promoted,
      ...(backfill.minted.length || backfill.error
        ? {
            storeBackfill: {
              minted: visible,
              ...(otherTenants ? { otherTenants } : {}),
              ...(backfill.error ? { error: backfill.error } : {}),
            },
          }
        : {}),
    });
  });

  // The deploy seam (self-serve-deploy.md): a `substrat push` uploads a built bundle
  // here. The order is upload → record, deliberately: a failed record leaves an
  // orphaned namespace script (invisible, GC'able) rather than a directory row
  // pointing at a deployment that is not there. The version lands PENDING — except a
  // PRIVATE vertical's, which self-admits below the seam (its blast radius is its own
  // tenant); for everything else admission still gates serving.
  app.post('/verticals/:slug/deploy', async (c) => {
    if (!options.deployVertical) {
      return c.json({ error: 'deploy is not configured on this control plane' }, 501);
    }
    const p = c.get('principal');
    const form = await c.req.formData();
    const raw = form.get('manifest');
    if (typeof raw !== 'string') return c.json({ error: 'missing manifest part' }, 400);
    const manifest = deployManifest.parse(JSON.parse(raw));

    // §4 sandbox contract, before anything reaches the namespace.
    assertSandboxContract(manifest);

    // The workspace this push is FOR — the project's pin (package.json `substrat.tenant`),
    // sent by the CLI alongside the bundle. The pin is intent, and intent is honored or
    // refused, never silently reinterpreted: a BUILDER's workspace is already fixed by
    // auth, so a pin naming a different one is a 403 rather than a push that lands
    // somewhere the project didn't say; STAFF have no workspace of their own, so the pin
    // is what makes their push land as the tenant's — prefixed and owned exactly as the
    // equivalent builder push — instead of claiming the slug platform-owned (unowned ⇒
    // invisible in every workspace dashboard, and never self-admitting) with the pin
    // silently dropped. An old CLI that sends no pin keeps today's behavior on all paths.
    const pinField = form.get('tenant');
    const pin = typeof pinField === 'string' && pinField.length > 0 ? pinField : null;

    // The push's self-reported provenance (git CI vs a terminal) — a label the dashboard
    // shows, never authority, so a missing or malformed field must not fail the push
    // (an old CLI sends none). Lenient by construction: safeParse, drop on mismatch.
    const originField = form.get('origin');
    const origin = (() => {
      if (typeof originField !== 'string') return undefined;
      try {
        const parsed = versionOrigin.safeParse(JSON.parse(originField));
        return parsed.success ? parsed.data : undefined;
      } catch {
        return undefined;
      }
    })();

    // Resolve the registry id + owner this push acts on. Checked BEFORE the upload so a
    // refused push never leaves an orphaned namespace script.
    const bare = c.req.param('slug');
    let slug: string;
    let ownerTenant: TenantId | null;
    if (p.kind === 'builder') {
      if (pin && pin !== p.tenantSlug && pin !== p.tenantId) {
        return c.json(
          { error: `push is pinned to workspace '${pin}' but this session acts for '${p.tenantSlug}'` },
          403,
        );
      }
      slug = effectiveSlug(p, bare);
      // A builder pushes to a slug it owns, or claims an unregistered one (§3).
      const existingOwner = await ownerOf(c.get('actor'), slug);
      if (existingOwner !== undefined && existingOwner !== p.tenantId) {
        return c.json({ error: 'forbidden' }, 403);
      }
      ownerTenant = p.tenantId;
    } else if (pin) {
      const workspace = (await admin.listTenants(c.get('actor'))).find(
        (t) => t.slug === pin || t.id === pin,
      );
      if (!workspace) return c.json({ error: `unknown workspace '${pin}'` }, 404);
      // Back-compat: a BARE slug already registered as the pinned tenant's (a staff
      // hand-registration predating prefixed claims) stays addressable as itself.
      // Otherwise the claim lands under the tenant prefix, exactly like a builder push —
      // same namespace, no claim race with other workspaces' bare names.
      const bareOwner = await ownerOf(c.get('actor'), bare);
      slug = bareOwner === workspace.id ? bare : `${workspace.slug}/${bare}`;
      const existingOwner = slug === bare ? bareOwner : await ownerOf(c.get('actor'), slug);
      if (existingOwner !== undefined && existingOwner !== workspace.id) {
        return c.json({ error: `vertical '${slug}' is not owned by workspace '${pin}'` }, 403);
      }
      ownerTenant = workspace.id;
    } else {
      // No pin: the raw slug is the identity and an existing owner is preserved
      // (null ⇒ platform-owned for a first-party vertical) — unchanged staff behavior.
      slug = bare;
      ownerTenant = (await ownerOf(c.get('actor'), slug)) ?? null;
    }

    // #388: refuse the SILENT lineage fork. A first push of a registry id that does not
    // exist yet, whose product name (the slug's tail) matches an existing lineage this
    // push could CONFUSE ITSELF WITH, is almost always a mis-identified project — a
    // tenant pin or a package-name-derived slug about to fork `manyfold` into
    // `acme/manyfold` — not an intent to run two same-named products. The fork confuses
    // precisely because it half-works: pushes land and serve, while installs of the
    // EXISTING lineage never see them. Checked before the upload (like the ownership
    // check) so a refused push leaves no orphaned namespace script; `allowFork` (the
    // CLI's --allow-fork) makes a real second lineage a deliberate choice.
    //
    // Same-name-under-ANOTHER-tenant is deliberately NOT a fork: every tenant may own a
    // private `helpdesk` — that is the namespace working (§2). So a sibling qualifies
    // only when the confusion is real: platform-owned, marketplace-listed, or owned by
    // the very workspace this push acts for. An unpinned STAFF push acts for the
    // platform and sees the whole registry, so every same-named lineage qualifies. This
    // scoping is also what keeps existence-hiding intact — a builder is never told about
    // a foreign private slug.
    if (form.get('allowFork') !== '1') {
      const registry = await admin.listVerticals(c.get('actor'));
      const tail = slug.split('/').pop();
      const siblings = registry.some((v) => v.slug === slug)
        ? []
        : registry.filter(
            (v) =>
              v.slug.split('/').pop() === tail &&
              (v.ownerTenant === null ||
                v.listed ||
                v.ownerTenant === ownerTenant ||
                (p.kind !== 'builder' && !pin)),
          );
      if (siblings.length > 0) {
        const owner = (v: (typeof siblings)[number]): string =>
          v.ownerTenant === null
            ? 'platform-owned'
            : v.ownerTenant === ownerTenant
              ? 'owned by this same workspace'
              : `owned by tenant ${v.ownerTenant}`;
        const named = siblings.map((v) => `'${v.slug}' (${owner(v)}${v.listed ? ', listed' : ''})`).join(', ');
        return c.json(
          {
            error:
              `this push would CREATE a new vertical '${slug}' — a separate lineage beside ${named}. ` +
              `Installs of the existing lineage never update from pushes to '${slug}'. If you meant to ` +
              `update it, fix the project's identity first: package.json \`substrat.slug\` and ` +
              `\`substrat.tenant\` (or --tenant) decide where a push lands. To deliberately run a ` +
              `separate same-named lineage, re-run with --allow-fork.`,
          },
          409,
        );
      }
    }

    // Two kinds of part in one body (#340): worker MODULES (unprefixed) and static ASSETS
    // (`asset:<served path>`). Splitting on the prefix — rather than on content type or on
    // whether the manifest happens to name it — is what keeps an uploaded file from being
    // able to enter the wrong pipeline.
    const modules: { name: string; content: Uint8Array; contentType: string }[] = [];
    const assetParts = new Map<string, File>();
    for (const [name, value] of form.entries()) {
      if (name === 'manifest') continue;
      if (!(value instanceof File)) continue;
      if (name.startsWith(ASSET_PART_PREFIX)) {
        assetParts.set(name.slice(ASSET_PART_PREFIX.length), value);
        continue;
      }
      modules.push({
        name,
        content: new Uint8Array(await value.arrayBuffer()),
        contentType: value.type || 'application/javascript+module',
      });
    }
    if (!modules.some((m) => m.name === manifest.entry)) {
      return c.json({ error: `entry module '${manifest.entry}' is not among the uploaded files` }, 400);
    }

    // The static-asset half of the §4 sandbox contract (self-serve-deploy.md §4.1). The
    // bytes are inert — no code, no authority — so they are ACCEPTED; the content-address
    // is not, so it is VERIFIED. The runtime's asset store dedups by hash across the whole
    // dispatch namespace, which means bytes stored under a hash they do not have would let
    // one push decide what another vertical's identical-hash asset serves. Re-deriving the
    // hash here (from the received bytes, with the same `assetHash` the CLI used) is what
    // makes that structurally impossible — and it is the only inspection of the bytes we do.
    const assets: AssetUpload[] = [];
    for (const file of manifest.assets?.files ?? []) {
      const part = assetParts.get(file.path);
      if (!part) {
        return c.json(
          { error: `asset '${file.path}' is named in the manifest but was not uploaded` },
          400,
        );
      }
      const content = new Uint8Array(await part.arrayBuffer());
      if (content.byteLength !== file.size) {
        return c.json(
          { error: `asset '${file.path}' declares ${file.size} bytes but ${content.byteLength} arrived` },
          400,
        );
      }
      const actual = await assetHash(content, file.path);
      if (actual !== file.hash) {
        return c.json(
          {
            error:
              `asset '${file.path}' does not match its declared content hash ` +
              `(declared ${file.hash}, computed ${actual}) — the hash is the runtime's shared dedup key, ` +
              `so a mismatch is refused rather than stored`,
          },
          400,
        );
      }
      assets.push({
        path: file.path,
        hash: file.hash,
        size: file.size,
        contentType: file.contentType,
        content,
      });
      assetParts.delete(file.path);
    }
    if (assetParts.size > 0) {
      // An unlisted asset part would be uploaded by nothing and served by nothing; saying so
      // beats silently dropping it, because the builder's page would 404 with no explanation.
      const extra = [...assetParts.keys()].slice(0, 5).join(', ');
      return c.json(
        {
          error:
            `${assetParts.size} uploaded asset part(s) are absent from the manifest (${extra}${assetParts.size > 5 ? ', …' : ''})`,
        },
        400,
      );
    }

    // Mint the version id first: the deploymentRef (the dispatch script name) is keyed
    // on it, so it is CF-valid and unique per version.
    const id = ulid();
    const deploymentRef = deploymentRefFor(slug, id);
    try {
      await options.deployVertical(deploymentRef, {
        entry: manifest.entry,
        compatibilityDate: manifest.compatibilityDate,
        compatibilityFlags: manifest.compatibilityFlags,
        modules,
        doClasses: manifest.doClasses,
        bindings: manifest.bindings,
        // #340: the verified bytes go up with the bundle. The manifest's routing config
        // rides along untouched — it decides what the RUNTIME does with paths, and carries
        // no reach, so there is nothing in it for the sandbox contract to refuse.
        ...(manifest.assets ? { assets: { ...manifest.assets, files: assets } } : {}),
      });
    } catch (e) {
      // The upload to the runtime failed. Surface the detail (the builder is
      // authenticated) rather than the anonymous 500 the generic handler would give, so a
      // push failure is diagnosable without reading worker logs. The version label is NOT
      // consumed here: registration/publish happen only AFTER a successful upload (below),
      // so a failed push leaves the same --version reusable (#307).
      //
      // Answer the upstream status honestly: a runtime 4xx is a bad-bundle rejection — the
      // builder's own script (e.g. a module-top-level throw → CF 10021), well-formed HTTP
      // but refused — so a 422, not a 502 that reads as a platform outage. A 5xx (or any
      // throw with no upstream status) is a platform failure and stays a 502.
      const detail = e instanceof Error ? e.message : String(e);
      const upstream = upstreamStatusOf(e);
      console.error('deploy.upload.failed', { slug, deploymentRef, detail, upstream });
      const rejected = upstream !== undefined && upstream >= 400 && upstream < 500;
      // Both outcomes land an ops-failure row (#559): the 502 is the platform's to
      // explain, and the 422 is what the builder-facing failure view (step 5) will
      // list — a red push should be explainable from a durable record either way.
      recordFailure({
        actor: c.get('actor'),
        operation: 'deploy.upload',
        stage: 'wfp-upload',
        vertical: slug,
        tenantId: ownerTenant ?? null,
        status: rejected ? 422 : 502,
        message: detail,
      });
      return rejected
        ? c.json({ error: 'deploy rejected', detail }, 422)
        : c.json({ error: 'deploy upload failed', detail }, 502);
    }

    // Register-then-publish, both idempotent-ish below the seam: a first push of a
    // slug registers it; publishVersion lands the version pending with deploymentRef
    // (or admitted, for a PRIVATE vertical — the registry's self-admit rule). The owner
    // was resolved with the slug above: the builder's tenant, the pinned workspace, or
    // the preserved existing owner for an unpinned staff push.
    await admin.registerVertical(c.get('actor'), {
      slug,
      name: manifest.name ?? slug,
      source: 'cli',
      ownerTenant,
      // The vertical's declared config surface rides to the registry, so the dashboard
      // renders a settings form for a pushed vertical exactly like a builtin.
      ...(manifest.envSpec ? { envSpec: manifest.envSpec } : {}),
      // Registry-driven install metadata (marketplace-publish.md §3) — so the dashboard
      // installs a pushed vertical without a hardcoded catalog entry.
      ...(manifest.ownerGrants ? { ownerGrants: manifest.ownerGrants } : {}),
      ...(manifest.entitlements ? { entitlements: manifest.entitlements } : {}),
      ...(manifest.provides ? { provides: manifest.provides } : {}),
      ...(manifest.requires ? { requires: manifest.requires } : {}),
      // The declared provisioner intent (#455) — a REQUEST the console reviews; the
      // tenant-provisioner grant itself is never touched by a push. Refreshes on every
      // re-push like the rest of the install spec, exactly because it grants nothing.
      ...(manifest.provisions ? { provisions: manifest.provisions } : {}),
      // The declared email-sender intent (#303) — a REQUEST the console reviews; the
      // `emailSender` grant itself is never touched by a push. Refreshes on every re-push
      // like the rest of the install spec, exactly because it grants nothing.
      ...(manifest.sendsEmail ? { sendsEmail: true } : {}),
      // The declared surfaces (K-26) ride like envSpec: registry metadata for the
      // hostname-binding picker, never behavior. Not part of any admission digest.
      ...(manifest.surfaces ? { surfaces: manifest.surfaces } : {}),
    });
    await admin.publishVersion(c.get('actor'), {
      id,
      verticalSlug: slug,
      version: manifest.version,
      manifestDigest: manifest.digests.manifest,
      permissionDigest: manifest.digests.permission,
      migrationDigest: manifest.digests.migration,
      deploymentRef,
      ...(origin ? { origin } : {}),
      // Retained for the serving upload (#286): the archive script keeps the module
      // bytes, this keeps their shape (entry, compat, doClasses, bindings).
      manifestJson: JSON.stringify(manifest),
    });
    // Same spirit as the permission-surface gate, advisory tier: when the push DECLARES
    // surfaces, name any surface that hostnames are still bound to but the declaration
    // dropped — the URL keeps resolving (routing never keys on the declaration), it just
    // serves whatever the vertical does for an unknown surface. A push declaring nothing
    // opts out of the check entirely.
    const warnings: string[] = [];
    if (manifest.surfaces?.length) {
      const declared = new Set(manifest.surfaces.map((s) => s.name));
      // Narrowed to THIS vertical's bindings in the query. It used to read every
      // hostname on the platform and filter in JS, which made an advisory warning about
      // one push depend on every other tenant's routing rows parsing cleanly — a
      // malformed cert-validation blob on an unrelated domain took the whole deploy down
      // with a blank 500, after the version had already been published.
      const bound = await admin.listHostnames(c.get('actor'), { verticalSlug: slug });
      for (const h of bound) {
        if (!declared.has(h.surface)) {
          warnings.push(
            `hostname '${h.hostname}' is bound to surface '${h.surface}', which this version no longer declares`,
          );
        }
      }
    }
    const version = await admin.getVersion(c.get('actor'), id, slug);
    return c.json({ ...version, ...(warnings.length ? { warnings } : {}) }, 201);
  });

  // -- where this platform runs (ops ergonomics) -----------------------------
  // The console renders refs it already has — `servingRef`, a store's `ref`, a version's
  // `deploymentRef` — and this is the one thing it cannot derive: which account and which
  // dispatch namespace those resolve in. Answering `null` (not 501) is deliberate: an
  // unconfigured runtime is the ordinary self-host shape, and the console degrades to
  // plain identifiers rather than treating it as a failure. No credential crosses here.
  app.get('/platform/runtime', (c) => c.json(options.platformRuntime ?? null));

  // Which Durable Object namespaces one script defines — the id the dashboard addresses a
  // namespace by, which nothing else in the platform record carries. Narrowed to the asked-
  // for script SERVER-side: the account-wide listing is one row per pushed script and has no
  // business crossing to a browser. 501 (not an empty list) when no reader is configured,
  // because "no namespaces in that script" and "I cannot look" are different answers.
  app.get('/platform/do-namespaces', async (c) => {
    if (!options.doNamespaces) {
      return c.json({ error: 'durable-object namespace lookup is not configured on this control plane' }, 501);
    }
    const { script } = z.object({ script: z.string().min(1).max(200) }).parse({ script: c.req.query('script') });
    return c.json(namespacesForScript(await options.doNamespaces.list(), script));
  });

  // -- observability (design/observability.md §4.1) --------------------------
  // Proxied Cloudflare-native reads: the console's fleet view and (later, owner-
  // narrowed) the dashboard's builder view. STAFF-ONLY — not in BUILDER_ROUTES; see
  // the option's doc for why. Tier-3 numbers (master-plan §5.3): sampled, approximate,
  // never money.

  app.get('/observability/metrics', async (c) => {
    if (!options.observability) {
      return c.json({ error: 'observability is not configured on this control plane' }, 501);
    }
    const { hours } = z
      .object({ hours: z.coerce.number().int().min(1).max(72).default(24) })
      .parse({ hours: c.req.query('hours') });
    return c.json(await options.observability.serviceMetrics({ hours }));
  });

  app.get('/observability/logs', async (c) => {
    if (!options.observability) {
      return c.json({ error: 'observability is not configured on this control plane' }, 501);
    }
    // `service` repeats: one deployed unit per param, so a caller can ask for a
    // vertical's whole set (the dashboard's "all versions") in one query and get one
    // merged stream back. Capped because each extra service is another backend query.
    const services = (c.req.queries('service') ?? []).filter((s) => s.length > 0);
    const input = z
      .object({
        services: z.array(z.string().min(1).max(200)).max(20).optional(),
        level: z.enum(['log', 'info', 'warn', 'error', 'debug']).optional(),
        search: z.string().min(1).max(200).optional(),
        hours: z.coerce.number().int().min(1).max(72).default(1),
        limit: z.coerce.number().int().min(1).max(500).default(100),
      })
      .parse({
        services: services.length ? services : undefined,
        level: c.req.query('level') || undefined,
        search: c.req.query('search') || undefined,
        hours: c.req.query('hours'),
        limit: c.req.query('limit'),
      });
    return c.json(await options.observability.recentLogs(input));
  });

  /**
   * Observed-vs-declared outbound egress for a vertical's deployed versions (#859, D-46).
   *
   * The declaration (`substrat.outbound`) says what a vertical MAY call; this says what it
   * DID call, and the interesting part is the difference. Scoped to a vertical rather than
   * to bare script names because that is the unit the admit checkpoint works in — and
   * because `VerticalVersion` already carries both halves of the join, `deploymentRef` and
   * `outbound`, so no second lookup is needed to learn what a script was allowed to reach.
   *
   * Two directions, meaning opposite things:
   *
   * - **undeclared** — reached a host the declaration does not cover. Either drift, or
   *   DO-originated egress the egress worker never saw and so never refused (#858 proved
   *   that traffic is visible here and nowhere else).
   * - **unused** — declared but never observed. NOT a fault, and deliberately not worded as
   *   one: a quiet window proves nothing, which is why this is reported and never acted on.
   *
   * A version pushed before #303 declares nothing (`outbound: null`). Its hosts are marked
   * `unenforced` rather than `undeclared` — the egress worker lets them through by design,
   * and rendering them as violations would blame a vertical for the platform's own tail.
   *
   * The comparison uses `matchesOutboundHost`, the same function the egress worker enforces
   * with, so "allowed" cannot mean one thing here and another at the seam.
   *
   * STAFF-ONLY, like the other observability reads (absent from BUILDER_ROUTES).
   */
  app.get('/verticals/:slug/egress', async (c) => {
    if (!options.observability?.observedEgress) {
      return c.json({ error: 'observed egress is not available on this control plane' }, 501);
    }
    const slug = await resolveVerticalId(c, c.req.param('slug'));
    const { hours, limit } = z
      .object({
        hours: z.coerce.number().int().min(1).max(72).default(24),
        limit: z.coerce.number().int().min(1).max(1000).default(500),
      })
      .parse({ hours: c.req.query('hours'), limit: c.req.query('limit') });

    // Deployed versions only: a version with no `deploymentRef` has never run, so there is
    // nothing it could have been observed reaching.
    const versions = (await admin.listVersions(c.get('actor'), slug)).filter(
      (v) => v.deploymentRef,
    );
    // Cap the fan-out — each service is another backend query. Truncating the SERVICE list
    // is exactly the silent-drop #859 calls a defect, so it is reported, not swallowed.
    const MAX_SERVICES = 20;
    const considered = versions.slice(0, MAX_SERVICES);
    const servicesTruncated = versions.length > MAX_SERVICES;

    const declaredByService = new Map<string, string[] | null>();
    for (const v of considered) declaredByService.set(v.deploymentRef!, v.outbound ?? null);

    const report = await options.observability.observedEgress({
      services: considered.map((v) => v.deploymentRef!),
      hours,
      limit,
    });

    const rows = report.rows.map((row) => {
      const declared = declaredByService.get(row.service) ?? null;
      return {
        ...row,
        declared,
        // `null` declared ⇒ unenforced, so nothing is "undeclared" in the policy sense.
        // Keeping the two states apart stops a pre-#303 push from rendering as a breach.
        undeclared: declared === null ? false : !matchesOutboundHost(row.host, declared),
        unenforced: declared === null,
      };
    });

    const byService = considered.map((v) => {
      const service = v.deploymentRef!;
      const declared = declaredByService.get(service) ?? null;
      const observed = report.rows.filter((r) => r.service === service).map((r) => r.host);
      return {
        service,
        versionId: v.id,
        version: v.version,
        declared,
        unused: declared?.filter((d) => !observed.some((h) => matchesOutboundHost(h, [d]))) ?? [],
      };
    });

    return c.json({
      rows,
      byService,
      // Carried through verbatim, never smoothed. A truncated or unknown-coverage read
      // rendered as a clean result is the failure mode #859 names as a defect, so every
      // way this answer can be partial travels with it.
      truncated: report.truncated || servicesTruncated,
      servicesTruncated,
      versionsConsidered: considered.length,
      versionsTotal: versions.length,
      samplingRate: report.samplingRate,
      hours,
    });
  });

  // -- push tokens (push-token.ts) -------------------------------------------
  // Mint a tenant-scoped CI credential. STAFF-ONLY by the builder allowlist (not in
  // BUILDER_ROUTES): the dashboard mints over its service token during git-import
  // setup; a builder session cannot mint (their own session already authenticates
  // them, and a self-serve mint surface deserves its own decision, not a side door).
  // The token authenticates as a BUILDER for the named tenant — everything a builder
  // can NOT do (prod promote, admit, other tenants' slugs) holds for it identically.
  app.post('/push-tokens', async (c) => {
    if (!options.pushTokenSecret) {
      return c.json({ error: 'push tokens are not configured on this control plane' }, 501);
    }
    const { tenantId } = z.object({ tenantId: tenantIdSchema }).parse(await c.req.json());
    const tenant = await admin.getTenant(c.get('actor'), tenantId);
    if (!tenant) return c.json({ error: `unknown tenant: ${tenantId}` }, 404);
    const token = await mintPushToken(options.pushTokenSecret, {
      actor: await pushActorFor(tenantId),
      tenantId,
      tenantSlug: tenant.slug,
    });
    return c.json({ token, tenantSlug: tenant.slug }, 201);
  });

  // -- the hostname map (§4.7, K-26) -----------------------------------------
  // Staff actions, PLUS a tenant-narrowed builder view (multi-surface exposure —
  // binding an EKA-style second surface is self-serve for the scope's own tenant).
  // `resolveHostname` deliberately does NOT land here: it is the router's per-request
  // machine path, unaudited by design (K-24), and putting it on the audited staff
  // surface would either flood the log or quietly create an unaudited route on a
  // surface whose whole claim is that it is audited. The router reads the directory
  // directly; it does not come through here.

  // A builder's view of one hostname: the row when it belongs to their tenant,
  // undefined otherwise — a foreign hostname must read as nonexistent, never as 403
  // (which would confirm the name is taken by someone).
  const tenantHostname = async (c: Context<{ Variables: Vars }>, name: string) => {
    const p = c.get('principal');
    const filter = p.kind === 'builder' ? { tenantId: p.tenantId } : {};
    return (await admin.listHostnames(c.get('actor'), filter)).find(
      (h) => h.hostname === name.toLowerCase(),
    );
  };

  app.get('/hostnames', async (c) => {
    const p = c.get('principal');
    const filter = listHostnamesQuery.parse({
      tenantId: c.req.query('tenantId'),
      scopeId: c.req.query('scopeId'),
    });
    // A builder's list is ALWAYS its own tenant's — the query may narrow further
    // (scopeId) but never widen; a foreign tenantId in the query loses silently.
    if (p.kind === 'builder') filter.tenantId = p.tenantId;
    const page = pageParams(c);
    const entries = await admin.listHostnames(c.get('actor'), { ...filter, ...page });
    return c.json(pageOf(entries, page.limit, (h) => h.hostname));
  });

  // Which base domains ride the platform wildcard cert (go straight to `active`);
  // everything else is a custom domain that walks Cloudflare-for-SaaS issuance (§4.7).
  const platformBaseDomains = options.platformBaseDomains ?? [];
  const custom = (hostname: string) => isCustomHostname(hostname, platformBaseDomains);

  /**
   * Drive a freshly-bound (or re-checked) hostname through issuance (§4.7):
   *
   *   - a PLATFORM mint rides the wildcard cert → flip straight to `active`;
   *   - a CUSTOM domain, when a provisioner is configured → `create` (on first bind) or
   *     `check` (a re-verify), persisting status + DNS records + the CF id;
   *   - a custom domain with NO provisioner (self-host/dev) → left `pending`.
   *
   * Failures are swallowed to a `failed`/`pending` note rather than thrown: a bind that
   * recorded the row must still return 201, and the reconcile sweep retries.
   */
  const runIssuance = async (
    actor: PlatformActorId,
    row: Awaited<ReturnType<typeof admin.listHostnames>>[number],
  ): Promise<void> => {
    if (!custom(row.hostname)) {
      // Platform mint: rides *.<base> — no per-hostname CF object, immediately servable.
      // A mint carrying issuance relics (a CF id, publish-these-records rows) was born
      // under a deployment whose PLATFORM_BASE_DOMAINS was unset and walked custom
      // issuance by mistake (#423) — heal it: clear the relics so no surface ever again
      // tells the user to publish DNS on the platform's own zone, and release the CF
      // object (best-effort, like the unbind route — a leak is a nuisance, not a hazard).
      if (row.customHostnameId || row.validationRecords.length > 0) {
        if (row.customHostnameId && options.provisionHostname) {
          await options.provisionHostname.remove(row.customHostnameId).catch(() => {});
        }
        await admin.setHostnameIssuance(actor, row.hostname, {
          status: 'active',
          note: null,
          customHostnameId: null,
          validationRecords: [],
        });
      } else if (row.status !== 'active') {
        await admin.setHostnameStatus(actor, row.hostname, 'active');
      }
      return;
    }
    if (!options.provisionHostname) return; // no CF-for-SaaS zone here; stays pending
    try {
      const issuance = row.customHostnameId
        ? await options.provisionHostname.check(row.customHostnameId)
        : await options.provisionHostname.create(row.hostname);
      await admin.setHostnameIssuance(actor, row.hostname, {
        status: issuance.status,
        note: issuance.note,
        // Only write the id on create; a re-check leaves it untouched (undefined).
        customHostnameId: row.customHostnameId ? undefined : issuance.customHostnameId,
        validationRecords: issuance.records,
      });
    } catch (err) {
      // Record the failure as a note but keep the row — the sweep re-attempts. Never
      // turn a transient CF error into a lost binding.
      await admin.setHostnameIssuance(actor, row.hostname, {
        status: 'failed',
        note: err instanceof Error ? err.message : String(err),
        validationRecords: row.validationRecords,
      });
    }
  };

  const hostnameRow = async (c: Context<{ Variables: Vars }>, name: string) =>
    (await admin.listHostnames(c.get('actor'), {})).find((h) => h.hostname === name.toLowerCase());

  app.post('/hostnames', async (c) => {
    const p = c.get('principal');
    const input = bindHostnameBody.parse(await c.req.json());
    if (p.kind === 'builder') {
      // The body names the tenant the binding lands under; a builder may only name
      // its own (the adapter then verifies the scope belongs to it, K-3).
      if (input.tenantId !== p.tenantId) return c.json({ error: 'forbidden' }, 403);
      // The region column is an EU-residency claim (K-30) — never builder-suppliable.
      if (input.region !== null) {
        return c.json({ error: 'region is derived from the scope, not chosen on a binding' }, 403);
      }
    }
    // Registrable-suffix guard (#305, D-35): a custom domain must be a real registrable
    // name, never a bare public suffix whose cookie would span tenants. Platform mints
    // skip it — they are the platform's own registrable domain by construction.
    if (custom(input.hostname)) {
      const bad = validateBindableHostname(input.hostname);
      if (bad) return c.json({ error: bad }, 422);
    }
    await admin.bindHostname(c.get('actor'), input);
    const bound = (await admin.listHostnames(c.get('actor'), { scopeId: input.scopeId })).find(
      (h) => h.hostname === input.hostname,
    );
    if (bound) await runIssuance(c.get('actor'), bound);
    // Re-read so the response carries the post-issuance status + DNS records the caller
    // (dashboard / CLI) renders — a custom bind comes back `verifying` with records.
    const out = (await admin.listHostnames(c.get('actor'), { scopeId: input.scopeId })).find(
      (h) => h.hostname === input.hostname,
    );
    return c.json(out ?? bound, 201);
  });

  // Re-poll a custom hostname's issuance ("check again" in the dashboard). Tenant-narrowed
  // like the other hostname routes; a platform mint or an already-active row is a no-op
  // re-affirm. Idempotent and safe to hammer — it just reflects Cloudflare's current state.
  app.post('/hostnames/:hostname/verify', async (c) => {
    const name = c.req.param('hostname');
    if (c.get('principal').kind === 'builder' && !(await tenantHostname(c, name))) {
      return c.json({ error: `unknown hostname: ${name.toLowerCase()}` }, 404);
    }
    const row = await hostnameRow(c, name);
    if (!row) return c.json({ error: `unknown hostname: ${name.toLowerCase()}` }, 404);
    await runIssuance(c.get('actor'), row);
    return c.json(await hostnameRow(c, name));
  });

  app.patch('/hostnames/:hostname/status', async (c) => {
    const { status, note } = setHostnameStatusBody.parse(await c.req.json());
    // Not path-parsed through the schema: a hostname is the path segment here, and
    // `setHostnameStatus` normalizes and 404s an unknown one below the seam.
    const name = c.req.param('hostname');
    if (c.get('principal').kind === 'builder' && !(await tenantHostname(c, name))) {
      return c.json({ error: `unknown hostname: ${name.toLowerCase()}` }, 404);
    }
    await admin.setHostnameStatus(c.get('actor'), name, status, note);
    const row = (await admin.listHostnames(c.get('actor'), {})).find(
      (h) => h.hostname === name.toLowerCase(),
    );
    return c.json(row);
  });

  // Unbind (hard-delete) a hostname row — what the orphan cleanup uses on rows
  // whose scope is archived or gone, and what an operator uses to retire a surface
  // URL. Audited below the seam, idempotent for staff: an unknown hostname deletes
  // nothing and still 200s. For a builder a hostname outside their tenant is a 404 —
  // idempotency yields to existence hiding at the tenant boundary.
  app.delete('/hostnames/:hostname', async (c) => {
    const name = c.req.param('hostname');
    if (c.get('principal').kind === 'builder' && !(await tenantHostname(c, name))) {
      return c.json({ error: `unknown hostname: ${name.toLowerCase()}` }, 404);
    }
    // Release the Cloudflare custom hostname before dropping the row, or the CF object
    // leaks (billable, and it would block a future rebind of the same name). Best-effort:
    // a CF failure must not strand the unbind — the row still goes, and a leaked CF
    // hostname is a cleanup nuisance, not a routing hazard. `remove` already tolerates 404.
    const row = await hostnameRow(c, name);
    if (row?.customHostnameId && options.provisionHostname) {
      await options.provisionHostname.remove(row.customHostnameId).catch(() => {});
    }
    await admin.unbindHostname(c.get('actor'), name);
    return c.json({ deleted: name.toLowerCase() });
  });

  // -- per-PR previews (preview-and-snapshots.md §2/§9) ----------------------
  // The "run a NEW version against a fork of prod" slice: unlike orchestratedSnapshot
  // (fork bound to the SOURCE's version — same deployment, bytes never move), a preview
  // binds the fork to the PR's version, whose bundle is a DIFFERENT dispatch script. So
  // the dump must cross deployments — export from where the prod data lives today, import
  // into the PR version's deployment — the one genuinely byte-moving path (§9), gated
  // below exactly as the governed pull is: `global`-only + the canonical audited export.

  /** The preview scope's deterministic slug — how a `(vertical, tag)` is looked up + reaped.
   *  Derived from the vertical's BARE label, never the qualified `<tenant>/<label>` registry
   *  id `resolveVerticalId` hands the routes: a scope slug is a DNS label (`slugSchema`), so a
   *  `/` in it fails `provisionScope`'s parse (#498). Slugs are unique per tenant, and the
   *  label is unique within a tenant, so dropping the prefix stays collision-free. Both
   *  create (provision + reuse-match) and delete (reap-match) run through here, so they agree. */
  const previewSlug = (slug: string, tag: string): string => `${slug.split('/').at(-1)}--${tag}`;

  /** Reap one preview: wipe the DO in its own deployment, then drop the directory row and
   *  its hostnames. Storage-before-row, the same ordering the DELETE route uses — a crash
   *  between the two converges on retry. Shared by that route and by the create path, which
   *  reaps a HALF-BUILT leftover before re-forking (see `orchestratedPreview`). */
  const reapPreview = async (
    c: { get: (k: 'actor') => PlatformActorId },
    preview: Scope,
  ): Promise<void> => {
    const vertical = await verticalForScope(c, preview);
    if (vertical) await vertical.deleteScope({ scopeId: preview.id });
    await options.host.deleteSnapshot(c.get('actor'), preview.tenantId, preview.id);
  };

  /** Given a base hostname `<label>.<domain>`, mint (or find) the preview's `--<tag>`
   *  hostname `<label>--<tag>.<domain>` bound to `previewId`. Non-canonical, so it never
   *  demotes the prod surface. Shared by the fork and clean-room paths. */
  const bindPreviewHostname = async (
    actor: PlatformActorId,
    baseHostname: string,
    tenantId: TenantId,
    previewId: ScopeId,
    tag: string,
    surface: string,
  ): Promise<string> => {
    const parsed = parseHostname(baseHostname);
    if (!parsed) throw new ControlPlaneError(400, `'${baseHostname}' is not a hostname a preview can be minted beside`);
    const hostname = withLabel(baseHostname, `${parsed.label}${RESERVED_LABEL_SEPARATOR}${tag}`)!;
    const existing = (await admin.listHostnames(actor, { scopeId: previewId })).find(
      (h) => h.hostname === hostname,
    );
    if (!existing) {
      await admin.bindHostname(actor, {
        hostname,
        tenantId,
        scopeId: previewId,
        surface,
        region: null,
        canonical: false,
      });
    }
    const bound = (await admin.listHostnames(actor, { scopeId: previewId })).find(
      (h) => h.hostname === hostname,
    );
    if (bound) await runIssuance(actor, bound); // platform mint rides the wildcard cert → active
    return hostname;
  };

  /** The base hostname a preview's `--<tag>` URL is derived from. A FORK inherits the
   *  source scope's canonical URL; a clean-room preview (no source, #509 ask (b)) has none,
   *  so it is built from the platform tenant-app convention `<vertical>-<tenant>.<base>` —
   *  the same scheme provisioning mints (`callout-sesamy.global.substrat.run`). */
  const previewBaseHostname = async (
    actor: PlatformActorId,
    source: Scope | null,
    tenantId: TenantId,
    slug: string,
    surface: string,
  ): Promise<string> => {
    if (source) {
      const own = await admin.listHostnames(actor, { scopeId: source.id });
      const src =
        own.find((h) => h.canonical && h.surface === surface) ??
        own.find((h) => h.canonical) ??
        own[0];
      if (!src || !src.hostname.includes('.')) {
        throw new ControlPlaneError(
          409,
          `source scope ${source.id} has no platform hostname to derive a preview URL from`,
        );
      }
      return src.hostname;
    }
    if (platformBaseDomains.length === 0) {
      throw new ControlPlaneError(
        409,
        `no platform base domain configured — a clean-room preview has no source URL to derive from`,
      );
    }
    // Mint under `<label>.<jurisdiction>.<baseDomain>`, exactly as provisioning does
    // (provision.ts `bindDefaultHostname` → `egeryds.global.substrat.run`). A clean-room
    // preview scope is provisioned `global` by construction (see the caller), and the
    // wildcard DNS/cert lives on `*.global.substrat.run` — NOT the certless apex
    // `*.substrat.run`. `platformBaseDomains` lists every platform suffix for custom-hostname
    // detection (`substrat.run`, `global.substrat.run`, …); the registrable base is the
    // shortest, the one all jurisdiction domains are subdomains of. Taking `[0]` grabbed the
    // bare apex and stranded clean-room previews on a hostname that never resolves.
    const baseDomain = [...platformBaseDomains].sort((a, b) => a.length - b.length)[0]!;
    const jurisdiction = 'global';
    const tenant = await admin.getTenant(actor, tenantId);
    const handle = tenant?.slug ?? tenantId;
    return `${slug.split('/').at(-1)}-${handle}.${jurisdiction}.${baseDomain}`;
  };

  const orchestratedPreview = async (
    c: { get: (k: 'actor') => PlatformActorId },
    tenantId: TenantId,
    slug: string,
    // A FORK copies this scope's data; `null` provisions an empty clean-room scope (#509 (b)).
    source: Scope | null,
    opts: { tag: string; versionId: string; ttlHours?: number | null; surface?: string; refresh?: boolean },
  ): Promise<{ scopeId: ScopeId; hostname: string; url: string; versionId: string; reused: boolean }> => {
    const actor = c.get('actor');
    const surface = opts.surface ?? 'app';
    // #527 guard: a preview MUST serve the version it just bound. Routing resolves
    // `COALESCE(scope.servingRef, version.deploymentRef)` (control-plane-do `readRoute`),
    // so a preview that still carries an inherited `serving_ref` — or otherwise resolves away
    // from this version's own dispatch script — would answer with OTHER code (the promoted
    // prod build) while we report success. That is worse than a failure: it sends a reviewer
    // to redo correct work. So refuse to return success for a URL that would serve other code.
    const assertServesBoundVersion = async (previewId: ScopeId): Promise<void> => {
      const bound = await admin.getVersion(actor, opts.versionId, slug);
      // A co-located / embedded vertical has no per-version dispatch script (deploymentRef
      // null) and routes via the static fallback — nothing to compare, so nothing to guard.
      if (!bound?.deploymentRef) return;
      const rec = await admin.getScopeRecord(actor, tenantId, previewId);
      const effectiveRef = rec?.servingRef ?? bound.deploymentRef;
      if (effectiveRef !== bound.deploymentRef) {
        throw new ControlPlaneError(
          500,
          `preview ${previewId} bound version ${opts.versionId} but would route to '${effectiveRef}' ` +
            `instead of that version's dispatch script '${bound.deploymentRef}' — refusing to report ` +
            `success for a preview URL that would serve other code (#527)`,
        );
      }
    };
    // The GC deadline for this create. `null` (explicit) pins the preview; absent defaults to
    // 72h. Computed once so the reuse and fresh paths agree — and, crucially, so reuse
    // PUSHES THE DEADLINE FORWARD: without this a preview CI re-pushes to would be reaped 72h
    // after its first creation no matter how alive it is (preview-and-snapshots.md §9).
    const expiresAt =
      opts.ttlHours === null ? null : new Date(Date.now() + (opts.ttlHours ?? 72) * 3_600_000).toISOString();
    // Residency (K-7/K-32): forking pins the copy's EXECUTION to the preview deployment.
    // Anything tighter than `global` cannot be honoured until Regional Services, so refuse
    // it here rather than record a residency claim with no mechanism (same gate as export).
    // A clean-room preview has no source data to move, so it is `global` by construction.
    if (source && source.jurisdiction !== 'global') {
      throw new ControlPlaneError(
        422,
        `scope ${source.id} is pinned to '${source.jurisdiction}' — forking it would move its ` +
          `data outside that jurisdiction; refused (K-32, preview-and-snapshots.md §6)`,
      );
    }

    // The PR version's deployment (its own dispatch script) — where the fork must land so
    // the preview actually runs the PR's code. Falls back to prod/static resolution only
    // when a version resolver is not wired (co-located host / tests).
    const target =
      (await options.resolveVerticalVersion?.(slug, opts.versionId, actor)) ??
      options.verticals?.[slug] ??
      (await options.resolveVertical?.(slug, actor));

    // The `--<tag>` URL's base — the source's canonical hostname (fork) or the tenant-app
    // convention (clean-room). Computed once so reuse and fresh mint the same URL.
    const baseHostname = await previewBaseHostname(actor, source, tenantId, slug, surface);

    // Idempotent on (tenant, vertical, tag): a PR *synchronize* rebinds the new version
    // onto the SAME preview — successive pushes roll their migrations forward on one copy
    // (§4's rehearsal case) — unless `refresh` asks for a fresh one.
    const existing = (await admin.listScopes(actor, { tenantId, vertical: slug })).find(
      (s) => s.kind === 'preview' && s.slug === previewSlug(slug, opts.tag),
    );
    // A preview only HAS data once its two-phase create finished: the directory row lands
    // first as `provisioning` (K-31), the fork's export→restore runs, and `activateScope`
    // is the last step. So a row still at `provisioning` is a create that DIED mid-fork —
    // its DO is empty. Reuse must never adopt one: reuse only rebinds the version and the
    // hostname, it never copies data, so adopting a half-built row hands back a
    // permanently EMPTY preview and reports `reused: true` — success for a URL that shows
    // a reviewer no data at all. That is exactly what a CI retry does (the generated
    // workflow retries `preview create` on a transient), so the failure mode is the
    // COMMON one, not a corner: attempt 1 forks and dies, attempt 2 adopts its corpse and
    // goes green. Instead, reap the leftover and fall through to a fresh fork below —
    // which is what the retry was asking for. Same for an explicit `refresh`, whose fresh
    // scope would otherwise collide with the old row's still-bound `--<tag>` hostname.
    const stale = existing !== undefined && (opts.refresh || existing.status !== 'active');
    if (existing && !stale) {
      // Heal a preview provisioned before #527: clear any inherited serving_ref so routing
      // follows the bound version (its per-version script), not the prod serving script.
      if (existing.servingRef) await admin.setScopeServingRef(actor, tenantId, existing.id, null);
      await admin.bindScopeVersion(actor, tenantId, existing.id, opts.versionId);
      // Renew (or clear) the preview's GC deadline so a reused preview does not silently die.
      await admin.setScopeExpiresAt(actor, tenantId, existing.id, expiresAt);
      const hostname = await bindPreviewHostname(actor, baseHostname, tenantId, existing.id, opts.tag, surface);
      await assertServesBoundVersion(existing.id);
      return { scopeId: existing.id, hostname, url: `https://${hostname}`, versionId: opts.versionId, reused: true };
    }
    // Free the tag: the slug is unique per tenant and the `--<tag>` hostname is still bound
    // to the old row, so the fresh fork below cannot be provisioned until this one is gone.
    if (existing && stale) await reapPreview(c, existing);

    const previewId = scopeIdSchema.parse(ulid());
    // The founding #559 case lands its durable row HERE, not in onError: the previews
    // route answers a ControlPlaneError directly (its own catch, never the app-level
    // recorder), and only this frame knows the preview's scopeId — the key that lets
    // the console explain the stranded `provisioning` row this throw leaves behind.
    const restoreOrRecord = async (fn: () => Promise<unknown>): Promise<void> => {
      try {
        await retryTransient(fn);
      } catch (e) {
        if (e instanceof ControlPlaneError && e.status >= 500 && e.status !== 501) {
          recordFailure({
            actor,
            operation: 'preview.create',
            stage: 'restore',
            tenantId,
            scopeId: previewId,
            vertical: slug,
            status: e.status,
            message: e.message,
          });
        }
        throw e;
      }
    };
    if (source) {
      // A fresh fork. Export from where the prod data lives TODAY. The canonical
      // `admin.exportScope` first — it writes the K-24 audit entry (and the co-located
      // bytes); the vertical dump then overlays it, exactly as the governed export route.
      const sourceClient = await verticalForScope(c, source);
      if (!target) {
        throw new ControlPlaneError(501, 'preview needs dispatch resolution for the PR version');
      }
      const canonical = await admin.exportScope(actor, tenantId, source.id);
      const tables = sourceClient ? await sourceClient.exportScope(source.id) : canonical.tables;
      // Directory row FIRST as `provisioning` (K-31 two-phase): a crash before the data
      // copy leaves an inert row that — carrying `forkedFrom` + `expiresAt` — the GC sweep
      // reaps, never copied data with no record.
      await options.host.provisionScope(actor, {
        tenantId,
        scopeId: previewId,
        kind: 'preview',
        slug: previewSlug(slug, opts.tag),
        name: `${source.name ?? slug} (${opts.tag})`,
        vertical: slug,
        jurisdiction: source.jurisdiction,
        forkedFrom: source.id,
        forkedAt: new Date().toISOString(),
        // Directory models "absent = pinned", so a pinned preview passes no horizon at all.
        expiresAt: expiresAt ?? undefined,
      });
      // Load the fork into the PR version's deployment (materializes the preview scope DO
      // there; restore re-projects the vertical's roles from the dump's tuples). A one-shot
      // DO storage blip heals on the in-request retry WITHOUT burning a CI attempt (which
      // pushes a fresh version per try) — #559 (2).
      await restoreOrRecord(() => target.restoreScope(tenantId, previewId, tables));
    } else {
      // A clean-room preview (#509 (b)): an EMPTY scope, no source to export. No `forkedFrom`
      // — the reap sweep and `deleteSnapshot` reap it by `kind === 'preview'` instead. The
      // co-located host migrates the module tables at `provisionScope`; a dispatch deployment
      // materializes the empty DO via `restoreScope([])` (its `ensureMigrations` creates the
      // schema on first access), so a source-less preview needs no export/restore of data.
      await options.host.provisionScope(actor, {
        tenantId,
        scopeId: previewId,
        kind: 'preview',
        slug: previewSlug(slug, opts.tag),
        name: `${slug.split('/').at(-1)} (${opts.tag})`,
        vertical: slug,
        jurisdiction: 'global',
        expiresAt: expiresAt ?? undefined,
      });
      if (target) await restoreOrRecord(() => target.restoreScope(tenantId, previewId, []));
    }
    await admin.activateScope(actor, tenantId, previewId);
    // Bind the PR version. A private vertical's push self-admitted, so this is accepted; a
    // preview scope also admits a pending version (#513), which is what a clean-room rehearsal
    // of not-yet-admitted code needs.
    await admin.bindScopeVersion(actor, tenantId, previewId, opts.versionId);
    const hostname = await bindPreviewHostname(actor, baseHostname, tenantId, previewId, opts.tag, surface);
    await assertServesBoundVersion(previewId);
    return { scopeId: previewId, hostname, url: `https://${hostname}`, versionId: opts.versionId, reused: false };
  };

  // The owning tenant of a builder's OWN vertical — the gate every preview route shares. A
  // preview forks THIS tenant's own scope and binds the version onto that fork (never an
  // install), so it survives publication: previewing your own new code into your own data is
  // the same own-tenant blast radius a private vertical self-admits under, and `bindScopeVersion`
  // admits a pending version onto a preview scope for exactly this reason (issue #509 ask (d)).
  // A builder is still confined to a vertical it OWNS, and a first-party vertical (no owner
  // tenant) has no scope of its own to fork.
  const previewVertical = async (
    c: Context<{ Variables: Vars }>,
  ): Promise<{ tenantId: TenantId; slug: string } | { error: string; status: ContentfulStatusCode }> => {
    const p = c.get('principal');
    const slug = await resolveVerticalId(c, c.req.param('slug')!);
    const v = await verticalOf(c.get('actor'), slug);
    if (!v) return { error: `unknown vertical '${slug}'`, status: 404 };
    if (p.kind === 'builder' && v.ownerTenant !== p.tenantId) return { error: 'forbidden', status: 403 };
    if (v.ownerTenant === null) return { error: `vertical '${slug}' has no owner tenant`, status: 409 };
    return { tenantId: v.ownerTenant, slug };
  };

  app.post('/verticals/:slug/previews', async (c) => {
    const gate = await previewVertical(c);
    if ('error' in gate) return c.json({ error: gate.error }, gate.status);
    const { tenantId, slug } = gate;
    const body = createPreviewBody.parse(await c.req.json());
    const actor = c.get('actor');
    if (body.empty && body.sourceScopeId) {
      return c.json({ error: `pass either --empty (clean-room) or a sourceScopeId, not both` }, 400);
    }
    // Clean-room (#509 (b)): a null source provisions an EMPTY scope — no prod scope needed.
    // Everything else forks the tenant's own active, non-fork scope for this vertical.
    let source: Scope | null = null;
    if (!body.empty) {
      const owned = (
        await admin.listScopes(actor, { tenantId, vertical: slug, status: ['active'] })
      ).filter((s) => !s.forkedFrom && s.kind !== 'preview');
      source = body.sourceScopeId
        ? (owned.find((s) => s.id === body.sourceScopeId) ?? null)
        : owned.length === 1
          ? (owned[0] ?? null)
          : null;
      if (!source) {
        if (body.sourceScopeId) {
          return c.json({ error: `no active prod scope ${body.sourceScopeId} for '${slug}'` }, 404);
        }
        if (owned.length === 0) {
          return c.json(
            { error: `no prod scope to fork for '${slug}' — provision one first, or pass empty:true for a clean-room preview` },
            409,
          );
        }
        return c.json(
          { error: `'${slug}' has several prod scopes — pass sourceScopeId`, scopes: owned.map((s) => s.id) },
          409,
        );
      }
    }
    try {
      const out = await orchestratedPreview(c, tenantId, slug, source, body);
      return c.json(out, out.reused ? 200 : 201);
    } catch (e) {
      if (e instanceof ControlPlaneError) return c.json({ error: e.message }, e.status as ContentfulStatusCode);
      throw e;
    }
  });

  app.get('/verticals/:slug/previews', async (c) => {
    const gate = await previewVertical(c);
    if ('error' in gate) return c.json({ error: gate.error }, gate.status);
    const { tenantId, slug } = gate;
    const actor = c.get('actor');
    const previews = (await admin.listScopes(actor, { tenantId, vertical: slug }))
      .filter((s) => s.kind === 'preview')
      .sort((a, b) => ((a.forkedAt ?? '') < (b.forkedAt ?? '') ? 1 : -1));
    const out = [];
    for (const s of previews) {
      const hosts = await admin.listHostnames(actor, { scopeId: s.id });
      out.push({
        scopeId: s.id,
        tag: s.slug?.split('--').at(-1) ?? null,
        versionId: s.verticalVersionId,
        forkedFrom: s.forkedFrom,
        expiresAt: s.expiresAt,
        hostname: hosts[0]?.hostname ?? null,
        url: hosts[0]?.hostname ? `https://${hosts[0]!.hostname}` : null,
      });
    }
    return c.json(out);
  });

  app.delete('/verticals/:slug/previews/:tag', async (c) => {
    const gate = await previewVertical(c);
    if ('error' in gate) return c.json({ error: gate.error }, gate.status);
    const { tenantId, slug } = gate;
    const tag = c.req.param('tag');
    const actor = c.get('actor');
    const preview = (await admin.listScopes(actor, { tenantId, vertical: slug })).find(
      (s) => s.kind === 'preview' && s.slug === previewSlug(slug, tag),
    );
    // Idempotent: an already-reaped (or never-created) preview is a no-op success, so a
    // PR-close job never fails because the preview was already gone.
    if (!preview) return c.json({ deleted: null, note: `no preview '${tag}' for '${slug}'` });
    try {
      // Storage-before-row, the same ordering as the fork hard-delete: wipe the DO in the
      // PR version's deployment, then deleteSnapshot (fork-only re-check, hostnames + row,
      // audit). A crash between the two converges on retry.
      await reapPreview(c, preview);
      return c.json({ deleted: preview.id });
    } catch (e) {
      if (e instanceof ControlPlaneError) return c.json({ error: e.message }, e.status as ContentfulStatusCode);
      throw e;
    }
  });

  // -- roles, read only (§4.5 console item 4) --------------------------------
  // The READ lands; `defineRole` deliberately does not. Creating a role over
  // HTTP is a permission change, and the permission diff is a human checkpoint
  // (D-22/D-29) — that surface needs its own decision, not a route added because
  // the verb was adjacent.
  app.get('/roles', async (c) => {
    const filter = listRolesQuery.parse({
      tenantId: c.req.query('tenantId'),
      source: c.req.query('source'),
    });
    const page = pageParams(c);
    const entries = await admin.listRoles(c.get('actor'), { ...filter, ...page });
    // Composite sort key (tenant_id, role_key) — the `|` join is the documented
    // cursor shape (scope-host.ts listRoles).
    return c.json(pageOf(entries, page.limit, (r) => `${r.tenantId}|${r.key}`));
  });

  // -- the admin log (§4.4/§4.5) ---------------------------------------------

  app.get('/admin-log', async (c) => {
    const filter = auditLogQuery.parse({
      tenantId: c.req.query('tenantId'),
      scopeId: c.req.query('scopeId'),
      actor: c.req.query('actor'),
      action: c.req.queries('action'),
      since: c.req.query('since'),
      until: c.req.query('until'),
      limit: c.req.query('limit'),
      cursor: c.req.query('cursor'),
      order: c.req.query('order'),
    });
    const entries = await admin.auditLog(c.get('actor'), filter as Parameters<typeof admin.auditLog>[1]);
    // The cursor IS the last entry's id (ULID order is chronological), so the
    // page carries its own continuation and the console never assembles one.
    return c.json(pageOf(entries, filter.limit, (e) => e.id));
  });

  // The recorded operational failures (#559) — the console's failures view, and the
  // "what does this `reference = <id>` belong to" lookup. Newest first by default,
  // unlike /admin-log: an operator asks "what broke lately". A builder reads only its
  // OWN tenant's rows — the filter is forced, not trusted from the query (step 5: a
  // red CI run is explainable from the dashboard without staff involvement).
  app.get('/ops-failures', async (c) => {
    const p = c.get('principal');
    const filter = opsFailuresQuery.parse({
      tenantId: p.kind === 'builder' ? p.tenantId : c.req.query('tenantId'),
      scopeId: c.req.query('scopeId'),
      vertical: c.req.query('vertical'),
      operation: c.req.query('operation'),
      reference: c.req.query('reference'),
      since: c.req.query('since'),
      until: c.req.query('until'),
      limit: c.req.query('limit'),
      cursor: c.req.query('cursor'),
      order: c.req.query('order'),
    });
    const entries = await admin.listOpsFailures(
      c.get('actor'),
      filter as Parameters<typeof admin.listOpsFailures>[1],
    );
    return c.json(pageOf(entries, filter.limit, (e) => e.id));
  });

  // -- model usage (#1054): meter 3, the one D-30 could not compute -------------
  // The ledger the `model-usage` intents drain into. Staff-only: the tenant-facing
  // read is the vertical's own usage screen over its metering engine; this is the
  // platform's copy, the one an invoice reconciles against.
  app.get('/model-usage', async (c) => {
    const filter = modelUsageQuery.parse({
      tenantId: c.req.query('tenantId'),
      scopeId: c.req.query('scopeId'),
      vertical: c.req.query('vertical'),
      model: c.req.query('model'),
      since: c.req.query('since'),
      until: c.req.query('until'),
      limit: c.req.query('limit'),
      cursor: c.req.query('cursor'),
      order: c.req.query('order'),
    });
    const entries = await admin.listModelUsage(c.get('actor'), filter as Parameters<typeof admin.listModelUsage>[1]);
    return c.json(pageOf(entries, filter.limit, (e) => e.id));
  });

  // Folded per (tenant, vertical, model) with the platform's margin applied at read
  // time. Nothing is stored by the read: D-30's "meter, don't bill" holds.
  app.get('/model-usage/summary', async (c) => {
    const q = modelUsageSummaryQuery.parse({
      tenantId: c.req.query('tenantId'),
      since: c.req.query('since'),
      until: c.req.query('until'),
    });
    const now = new Date();
    const since = q.since ?? new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
    const until = q.until ?? now.toISOString();
    const summary = await admin.summarizeModelUsage(
      c.get('actor'),
      { ...(q.tenantId ? { tenantId: q.tenantId } : {}), since, until },
      options.modelMarginPercent ?? DEFAULT_MODEL_MARGIN_PERCENT,
    );
    return c.json(summary);
  });

  return app;
}
