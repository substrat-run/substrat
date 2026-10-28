import { problemDetail, REQUEST_ID_HEADER } from '@substrat-run/contracts';
import { createClient, type BoundScopeRow, type ChannelHistoryRow, type DashboardClient, type DeployFailureRow, type FailureGroupRow, type MoveReviewRow, type PreviewCreated, type PreviewRow, type ReleaseRow, type ReleasesView } from './api.generated';
import { logsIncompleteOf } from '@substrat-run/control-plane-api/browser';
import { tenantLogsQuery } from './logs-query';
import { exportBreaksIn } from './bind-ack';
import type { RebindReviewReason, CauseChain, DeadLetter, EffectsTree, InvocationEvents, EmittedModel, EventFacetResult, HistoryEntry, Page, PrincipalId, ScopeId, TenantId } from '@substrat-run/contracts';

// The shapes the declared Deployments routes answer (#2170) are the generated client's own.
export type { BoundScopeRow, DeployFailureRow, FailureGroupRow, MoveReviewRow, PreviewCreated, ReleaseRow, ReleasesView };
export type ChannelHistoryEntry = ChannelHistoryRow;
export type VerticalPreview = PreviewRow;

/**
 * Client for the Dashboard worker's own API (apps/dashboard/src/worker.ts).
 *
 * The worker serves everything under `/api`: `/api/me` (who am I — and, on first
 * call, bootstraps my tenant), `/api/catalog`, and the team-scoped surface under `/api/teams/:teamId` (`teamApi`). Auth is an OIDC
 * redirect to the platform's AuthHero instance — there is no password here, so
 * sign-in/out are full-page navigations, not fetches. `credentials: 'include'`
 * carries the same-origin session cookie the worker sets.
 *
 * Only the M0 surface is real; the rest of the Dashboard runs on demo data (see
 * lib/demo.ts) with the honesty banners the design calls for.
 */

/**
 * The envelope every paged list read returns (the platform-wide convention,
 * contracts pagination.ts): one page of entries, newest first, and the cursor
 * that fetches the next (older) page — `null` when the walk is done.
 */
export interface ListPage<T> {
  entries: T[];
  nextCursor: string | null;
}

/** Optional page params for a list read; unset = the server's default page (20). */
export interface PageOpts {
  limit?: number;
  cursor?: string;
}

/** A team-grain observability read's query: which apps, and the window. */
const obsWindowQs = (q: { scopeIds?: string[]; hours?: number; since?: string; until?: string }): string => {
  const p = new URLSearchParams();
  for (const s of q.scopeIds ?? []) p.append('scopeId', s);
  if (q.hours) p.set('hours', String(q.hours));
  if (q.since) p.set('since', q.since);
  if (q.until) p.set('until', q.until);
  const qs = p.toString();
  return qs ? `?${qs}` : '';
};

const pageQs = (opts?: PageOpts): string => {
  const q = new URLSearchParams();
  if (opts?.limit != null) q.set('limit', String(opts.limit));
  if (opts?.cursor) q.set('cursor', opts.cursor);
  const s = q.toString();
  return s ? `?${s}` : '';
};

/** One team (tenant) the signed-in user belongs to — drives the team switcher. */
export interface Team {
  id: TenantId;
  name: string;
  slug: string;
}

/** Authenticated, but not in any team yet — the app shows the onboarding screen. */
export interface Onboarding {
  needsOnboarding: true;
  email?: string | null;
  name?: string | null;
}

/** The `/api/me` result: either a resolved account, or a teamless login to onboard. */
export type MeResult = Me | Onboarding;

/** Narrow a `MeResult` to the teamless onboarding state. */
export function needsOnboarding(m: MeResult): m is Onboarding {
  return (m as Onboarding).needsOnboarding === true;
}

/** Who the authenticated customer is — their current team, dashboard scope, principal. */
export interface Me {
  principal: PrincipalId;
  /** The currently-selected team (tenant) this session is scoped to. */
  tenant: TenantId;
  dashboardScope: ScopeId;
  /** From the OIDC session — shown in the shell (footer, user pill). */
  email?: string | null;
  name?: string | null;
  /** Every team this login belongs to — one user can span several teams. */
  teams: Team[];
  /** The selected team's id (mirrors `tenant`); drives the switcher's checkmark. */
  currentTeamId: TenantId;
  /** The caller's role on the selected team, independent of the roster's current page. */
  roleKey: string | null;
}

export interface CatalogEntry {
  slug: string;
  name: string;
  /** Owned by my team — the New-app page's "Your verticals" group. */
  owned: boolean;
  /** Published to the public marketplace (the "Marketplace" group). */
  listed: boolean;
  source: string;
  /** False until a pushed vertical has a prod-promoted version — shown but not installable. */
  installable: boolean;
  /** The vertical's declared env-spec (#426) — the New-app form renders these fields so
   *  first-run config (an issuer's bootstrap admin, API keys) flows in WITH provisioning. */
  envSpec?: EnvVarSpec[];
  /** Capabilities this vertical provides (#427) — an `oidc-issuer` provider's instances
   *  appear in other installs' Identity picker, and it gets no Identity section itself. */
  provides?: string[];
  /** Capabilities this vertical can consume at install (#427) — `oidc-issuer` marks the
   *  Identity section as the vertical's declared delegation seam. */
  requires?: string[];
}

/** A team roster entry — an active member or an outstanding invite. Mirrors the worker's row. */
export interface Member {
  id: string;
  /** The kernel principal once accepted; null while still 'invited'. */
  principal: string | null;
  email: string;
  role_key: string;
  /**
   * 'joining' is an accepted invite whose access is still being set up; 'refused' one that
   * never will be, with the reason in `refusal` (#1184).
   */
  status: 'active' | 'invited' | 'revoked' | 'joining' | 'refused';
  refusal?: string;
  invitation_id: string | null;
  invited_by: string;
  invited_at: string;
  joined_at: string | null;
}

/** The role a new member can be invited at (owner is the un-invitable first member). */
export type InviteRole = 'admin' | 'member' | 'viewer';

/** One provisioned app — mirrors the worker's `DashboardAppRow` (module.ts). */
/** The install form's Identity choice — which issuer the new app authenticates against.
 *  Absent ⇒ the vertical's builtin auth. `auth-server` names one of the team's own Auth
 *  Server apps (the client is registered there automatically); `external` is any OIDC
 *  issuer the user configured by hand. */
export type AppAuthChoice =
  | { source: 'auth-server'; scopeId: string }
  | { source: 'external'; issuer: string; clientId: string; clientSecret?: string; audience?: string };

export interface AppRow {
  id: string;
  app_scope_id: string;
  vertical_slug: string;
  name: string;
  status: 'provisioning' | 'active' | 'failed';
  hostname: string | null;
  /** The vertical's non-secret provision result as JSON (#426); null for a bare ack. */
  provision_result?: string | null;
  created_by: string;
  created_at: string;
}

/**
 * One step of an app's install sequence (#424) — the durable progress record.
 * `attempts` > 1 means Resume (or a retry) re-ran the step; a 'failed' step carries
 * the downstream error VERBATIM in `last_error`.
 */
export interface InstallStep {
  step: 'directory' | 'provision' | 'activate' | 'hostname' | 'identity' | string;
  seq: number;
  status: 'running' | 'done' | 'failed';
  attempts: number;
  last_error: string | null;
  started_at: string;
  settled_at: string | null;
}

/** One entry in an app's audit trail (Activity panel) — a lifecycle transition. */
export interface AppEvent {
  id: string;
  app_scope_id: string;
  kind: 'created' | 'active' | 'failed' | 'deleted' | 'updated' | 'snapshotted' | 'snapshot-deleted' | 'data-exported' | 'data-restored';
  /** Failure reason / bound hostname / the version move / the vertical slug — depending on `kind`. */
  detail: string | null;
  actor: string;
  created_at: string;
}

/**
 * One entry in an app scope's control-plane audit log (#479) — an append-only admin
 * action (control-plane.md §4.4), mirrors the worker's `AdminLogEntry`. `before`/`after`
 * are the prior/applied state where cheaply captured; `causedBy` is the domain event id
 * that triggered the action, when one did.
 */
export interface AuditEntry {
  id: string;
  actor: string;
  action: string;
  tenantId: string | null;
  scopeId: string | null;
  vertical: string | null;
  before: unknown;
  after: unknown;
  causedBy: string | null;
  /**
   * The person the actor acted for (#977): a team member's principal, and the K-42 stamp
   * when staff were acting as them. Null or absent when the actor acted for itself — a
   * job, or a row written before the dashboard named who clicked.
   */
  onBehalfOf?: { principal: string; tenantId: string; impersonation?: { session: string; by: string } } | null;
  at: string;
}

/** One version of a deployed vertical — mirrors the worker's DeploymentVersion. */
export interface DeploymentVersion {
  id: string;
  version: string;
  admission: 'pending' | 'admitted' | 'rejected' | string;
  admissionNote: string | null;
  deploymentRef: string | null;
  /** Updating TO this version crosses a migration boundary (#286) — badged in the UI. */
  schemaChange?: boolean;
  /** Where the push came from: git CI (with repo/commit) vs a terminal. Null = pushed
   *  before origin tracking. `gate` is the push-time layer-rule receipt (#955): absent =
   *  no receipt rode the push, so nothing checked the layer rules. */
  origin?: {
    source: 'git' | 'cli';
    gitRepo?: string;
    gitCommit?: string;
    gitRef?: string;
    gate?: 'passed' | 'skipped' | 'none';
  } | null;
  createdAt: string;
}

/** One static file a version ships (#340), as the platform holds it: the served path, the
 *  bytes' size and MIME type, and the content address the runtime's asset store dedups on. */
export interface AssetEntry {
  path: string;
  hash: string;
  size: number;
  contentType: string;
}
/** One version's static files + how the runtime routes paths against them (#340). */
export interface DeployAssets {
  files: AssetEntry[];
  htmlHandling?: string;
  notFoundHandling?: string;
  runWorkerFirst?: boolean | string[];
}

/** One declared permission key (D-39, #336): the key, its description, and the module(s)
 *  that declare it — the machine-readable §1 of PERMISSIONS.md. */
export interface PermissionRegistryEntry {
  key: string;
  description: string;
  declaredBy: string[];
  /** #2430: a key reserved to a system principal; absent for every other key. */
  holder?: 'system';
}
/** A role template (D-39): a role key and the permission keys it holds. `source` is the
 *  declaring module id, or `'vertical'` for a role the vertical composes itself. */
export interface RoleDefinition {
  key: string;
  permissions: string[];
  source: string;
  /** #2430: `'system'` for a role held by a system principal (K-55); absent is a person's. */
  holder?: 'person' | 'system';
}
/** An entity-narrowed grant SHAPE (D-39): which keys a per-entity grant carries. The grants
 *  themselves are per-principal runtime tuples (control-plane §4.5) — only the shape is a code
 *  fact, so only the shape ships in the manifest. */
export interface EntityGrantShape {
  entityType: string;
  permissions: string[];
}
/** The vertical's declared permission surface for one version (D-39). */
export interface PermissionRegistry {
  permissions: PermissionRegistryEntry[];
  roles: RoleDefinition[];
  entityGrants: EntityGrantShape[];
}
/** One version + its declared registry — a running or update target on the Permissions tab. */
export interface VersionRegistry {
  versionId: string | null;
  version: string | null;
  /** `null` when the version retained no manifest (pushed pre-#286) or declared no surface. */
  registry: PermissionRegistry | null;
}
/**
 * The app's Permissions tab payload (#336): the declared surface of the version this app
 * RUNS, plus the version an available update would move it to (`update`, else null) so the
 * tab can diff the two before the update lands.
 */
export interface AppPermissionsView {
  running: VersionRegistry;
  update: VersionRegistry | null;
}

/** One version + its emitted entity model — a running or update target on the Model tab. */
export interface VersionModel {
  versionId: string | null;
  version: string | null;
  /** `null` when the version was pushed by a pre-#1214 CLI or ships no model.json. */
  model: EmittedModel | null;
}
/**
 * The app's Model tab payload (#1214): the emitted entity model of the version this app
 * RUNS, plus the version an available update would move it to (`update`, else null).
 */
export interface AppModelView {
  running: VersionModel;
  update: VersionModel | null;
}

/** One PITR rewind point an app recorded before a migration pass (#286). */
export interface MigrationBookmark {
  bookmark: string;
  takenAt: string;
  /** The `module@version` migrations that were about to apply when it was taken. */
  pending: string[];
}

/** A vertical this tenant pushed — the Verticals view's row (builder-plane.md Phase 4). */
export interface Deployment {
  slug: string; // full registry id, e.g. `acme-co/helpdesk`
  displaySlug: string; // bare name for display, `helpdesk`
  name: string;
  source: string;
  /** Published to the public marketplace (vs private to this team). */
  listed?: boolean;
  /**
   * Pushed by MY team — set on the per-app deployments read (the tenant-level Verticals
   * list is owned by construction). Owned + private ⇒ prod promotion is self-serve on
   * the Verticals page; otherwise it's a staff action.
   */
  owned?: boolean;
  versions: DeploymentVersion[];
  // `servingVersionId` is what prod's stable serving script actually runs (#321): when it
  // differs from a prod channel's `versionId`, the promote moved the pointer but the
  // in-place serve failed — scopes still run the old code.
  channels: Array<{ channel: string; versionId: string; servingVersionId?: string | null }>;
  /**
   * The version THIS scope is actually pinned to (the router dispatches on it) — set on
   * the per-app deployments read. It can lag the `prod` channel: an app installed when
   * prod was 0.0.9 stays on 0.0.9 until updated. `null` ⇒ unpinned (static binding).
   */
  boundVersionId?: string | null;
}

/** The per-app deployments read: `versions` is ONE page (newest first); `nextCursor` walks older. */
export interface AppDeployments extends Deployment {
  nextCursor: string | null;
}






/** One migration as an app actually applied it (#1236) — its schema history. */
export interface AppliedMigration {
  moduleId: string;
  version: string;
  /** Null for a row written before the platform recorded the instant. */
  appliedAt: string | null;
  durationMs: number | null;
  rowsChanged: number | null;
}

/**
 * One app's schema history with its availability (#1236). `available: false` is a
 * fact about the read — a deployment that does not serve the endpoint, or a plane
 * fault — while `migrations: []` with `available: true` is a fact about the app:
 * it genuinely has none, which a module registering `migrations: []` produces.
 */
/**
 * One event in a record's history (#1235) — the CONTRACT's type, not a copy of it.
 *
 * Re-declaring it here is what made the first cut render `by undefined` for every
 * impersonated action: the stamp is `{ session, by }` and the copy said
 * `{ staffActor }`, which no compiler could contradict. The same copy flattened
 * `actor` — a union whose `{ system }` and `{ connection }` members are objects —
 * to `string`. Importing the contract makes both of those a type error instead of
 * a screen that is quietly wrong.
 *
 * Three nullables are FACTS, not gaps: `payload` null = erased (a shred keeps the
 * row, drops the content); `authorization` null = the row predates K-34 recording
 * it, which is different from an empty list (checked nothing); `impersonation`
 * null = nobody was impersonating, the ordinary case. See `lib/history.ts`, which
 * is where each one is turned into words.
 */
export type { HistoryEntry, CauseChain, CauseTerminal, EffectsTree, EventEffects, EventDelivery, EffectsTerminal, InvocationEvents, DeadLetter } from '@substrat-run/contracts';
export type { LifecycleFlowResult, EmittedLifecycle } from '@substrat-run/contracts';

/** One declared lifecycle as the process map lists it (#1744). */
export interface DeclaredProcess {
  entity: string;
  initial: string;
  states: number;
  edges: number;
}

export type ProcessPeriod = '24h' | '7d' | '30d';

/**
 * One app's process map (#1744): a declared lifecycle replayed over the period asked and
 * the one before it. `unavailable` says why there is nothing to draw — each reason is a
 * different next step, so the screen never renders them as one empty map.
 */
export interface ProcessMapView {
  versionId: string | null;
  processes: DeclaredProcess[];
  entity: string | null;
  /** The machine the counts were replayed against — what the map lays out. */
  lifecycle: import('@substrat-run/contracts').EmittedLifecycle | null;
  period: ProcessPeriod;
  current: import('@substrat-run/contracts').LifecycleFlowResult | null;
  previous: import('@substrat-run/contracts').LifecycleFlowResult | null;
  unavailable: 'no-version' | 'no-lifecycles' | 'not-yet-available' | null;
}

/**
 * One app's health verdict (#1238), rolled up from the signals tiers 1–2 record.
 * `silent` and `ok` are different answers: nothing having checked an app is not
 * the same as nothing being wrong with it.
 */
/** One traffic row per app for the Apps table (#1767) — mirrors `src/app-metrics.ts`. */
export interface AppMetricsRow {
  scopeId: string;
  /** Null when this app's traffic was not read — beyond the view's `cap`. */
  requests: number | null;
  errors: number | null;
  /** Milliseconds; null when not measured (no traffic, or a plane that cannot group by app). */
  p95: number | null;
}
export interface AppMetricsView {
  available: boolean;
  /** Set when the read came back full: a null `requests` is an app not in the top `cap`. */
  cap: number | null;
  rows: AppMetricsRow[];
}

export interface AppHealthRow {
  scopeId: string;
  /** The app's own name and vertical slug — whose app this is, on the row itself. */
  name: string;
  vertical: string;
  state: 'failing' | 'stale' | 'silent' | 'ok' | 'unknown';
  reason: string;
  failures: number;
  sweepFailures: number;
  stale: number;
  lastSweepAt: string | null;
}

/**
 * A facet over the outbox (#1239) — re-exported from the contract rather than
 * restated here, exactly as `HistoryEntry` above is. A second copy of a shape the
 * kernel derives is a place for the two to drift, and the drift would be silent:
 * the wire carries whatever the helper returns either way.
 *
 * Two of its nullables are FACTS. A bucket's `value` of `null` is the
 * EXTRACTION-NULL bucket, which is weaker than "absent" — SQLite returns the same
 * NULL for a key the payload does not carry and for a key carrying an explicit
 * JSON `null`. And what it is NOT is an erased payload: those never reach a bucket
 * at all and are counted in `erased`, so a distribution over redacted history
 * cannot read as complete.
 */
export type { EventFacetBucket, EventFacetResult } from '@substrat-run/contracts';

/**
 * A facet answer as the wire may carry it. The control plane refuses a payload grouping
 * from an app whose kernel predates #1762 and says so in `withheldReason`; a control plane
 * from before this release relays such an answer without `withheldPersonal` at all, so
 * the absence is "unknown", never 0.
 */
export type EventFacetAnswer = Omit<EventFacetResult, 'withheldPersonal'> & { withheldPersonal?: number };

/** One declared field and whether anything declares it as output (#1321). */
/** One node of the flow map (#1234), already laid out. */
export interface FlowNode {
  id: string;
  kind: 'trigger' | 'module' | 'event' | 'connection' | 'egress';
  label: string;
  sublabel: string | null;
  /** Event nodes only; null when the observation could not be completed. */
  observed: number | null;
  /** True only when the observation is trustworthy AND found nothing. */
  silent: boolean;
  /** True when the node HAS fired and not lately — a different story from `silent`. */
  stale: boolean;
  status: 'ok' | 'warn' | 'danger';
  title: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface FlowEdge {
  from: string;
  to: string;
  kind: 'triggers' | 'emits' | 'consumes' | 'uses';
  title: string;
}

export interface FlowGraph {
  available: boolean;
  nodes: FlowNode[];
  edges: FlowEdge[];
  width: number;
  height: number;
  /** True when some event node has no count because the facet was truncated. */
  partialObservation: boolean;
  /** False when the DECLARED surface was cut at the cap, so whole nodes are missing —
   *  and a missing node, unlike a missing count, leaves nothing on screen to notice. */
  declaredComplete: boolean;
}

/** One operation's recorded facts (#1234). */
export interface OperationHealthRow {
  operation: string;
  /** Events it emitted; null when the facet could not say. */
  events: number | null;
  lastSeen: string | null;
  /** Refusals in the page read; null when the log could not be read. A floor unless `refusals.complete`. */
  refusals: number | null;
  /** True when refusals are the ONLY evidence — the facet was complete and it has emitted nothing. */
  refusedOnly: boolean;
}

/** What the refusal side can vouch for; null on the view when the log could not be read. */
export interface RefusalWindow {
  /** True when the page held every row the log holds, so counts are exact. */
  complete: boolean;
  held: number;
  counted: number;
  /** Oldest refusal still held. Those rows drain, so 0 never means "never refused". */
  since: string | null;
}

export interface OperationHealthView {
  rows: OperationHealthRow[];
  observedComplete: boolean;
  refusals: RefusalWindow | null;
}

/** One bound connection and whether it has actually been used (#1234). */
export interface ConnectionSweepRow {
  connectionId: string;
  provider: string;
  /** The human label — a tenant can hold several connections to one provider. */
  label: string;
  status: string;
  /** Null = no run through it inside `windowDays`. Bounded by the window, NEVER "never". */
  lastSweptAt: string | null;
  lastOutcomeFailed: boolean | null;
  /** The record could not be read: absence proves nothing, and the copy says so. */
  unknown: boolean;
  /** Usable, read, and with no run in the window. A lapsed connection is not called idle too. */
  idle: boolean;
}

export interface ConnectionSweepView {
  rows: ConnectionSweepRow[];
  /** What "no runs" is bounded by — the sweep log's retention, not a promise. */
  windowDays: number;
  idleCount: number;
}

/** The flow read: the same declarations projected as a list and as a map. */
export interface FlowView {
  findings: FlowFindingsView;
  graph: FlowGraph;
  operations: OperationHealthView;
  connectionSweep: ConnectionSweepView;
}

/** One declared-vs-observed finding (#1234). */
export interface FlowFinding {
  kind: 'unemitted' | 'unconsumed' | 'stale' | 'unconnected-provider' | 'unhealthy-provider';
  subject: string;
  moduleId: string | null;
  detail: string;
}

export interface FlowFindingsView {
  /** False when the running version predates the declared-event surface. */
  available: boolean;
  /** False when the observed side was truncated, so the event findings are withheld. */
  observedComplete: boolean;
  /** False when the DECLARED side was cut at the manifest's cap — the findings shown are
   *  real, but they are not everything, and the count line must say so. */
  declaredComplete: boolean;
  findings: FlowFinding[];
  declaredTypes: number;
  /** Under a truncated observation this is the number RETURNED, never a total. */
  observedTypes: number;
}

export interface FieldCoverageRow {
  field: string;
  returned: boolean;
  erasable: boolean;
}

export interface EntityCoverage {
  entity: string;
  table: string;
  fields: FieldCoverageRow[];
  neverReturned: FieldCoverageRow[];
}

/**
 * Field coverage for the running version (#1321). `available: false` means the
 * version predates the declared output surface — unknown, never "nothing is
 * returned", which would report a whole schema as dead.
 */
export interface FieldCoverageView {
  available: boolean;
  entities: EntityCoverage[];
  declared: number;
  returned: number;
  neverReturnedErasable: number;
  operations: number;
}

export interface FieldReadsView {
  available: boolean;
  source: 'vertical-asserted';
  window?: { since: string; until: string };
  groups: Array<{
    sampleRate: number | null;
    armedRequests: number;
    refused: number;
    operations: Array<{ operation: string; responses: number; fields: Array<{
      field: string; present: number; empty: number; absent: number; eligible: number;
      sampleRate: number | null; window: { since: string; until: string };
    }> }>;
    notObservedReturned: Array<{ operation: string; field: string }>;
  }>;
}

export interface AppMigrationsView {
  available: boolean;
  migrations: AppliedMigration[];
}

/** One plotted bucket of traffic (#1236) — zero-filled worker-side. */
export interface TrafficBucket {
  start: string;
  requests: number;
  errors: number;
  /** Per-bucket latency, null for an unreadable slot. Older workers are normalized by callers. */
  durationP95: number | null;
  /**
   * The chart's green and yellow segments (#1693): `green` is 2xx + 3xx traffic, `yellow`
   * is 4xx — the red segment is `errors` above, unchanged. Both present or both absent:
   * absent means the source carried no status-class split, and the chart falls back to
   * its single-color bar.
   */
  green?: number;
  yellow?: number;
}

/** One tenant connector's calls in one time bucket. Empty buckets are omitted by the plane. */
export interface ConnectorCallsBucket {
  provider: string;
  start: string;
  bucketMinutes: number;
  calls: number;
  errors: number;
  ok: number;
  class4xx: number;
  class5xx: number;
  timeouts: number;
  failed: number;
  durationP50: number;
  durationP95: number;
}

export interface ConnectorCallsView {
  available: boolean;
  buckets: ConnectorCallsBucket[];
}

/**
 * One declared lifecycle move of one app (#1750): calls that moved an `entityType` into
 * `state`, today (the 24 hours ending at the window's end), yesterday (the 24 before), and
 * per bucket over the window — zero-filled, so a gap is a quiet stretch, not missing data.
 */
export interface BusinessVolumeRow {
  scopeId: string;
  entityType: string;
  state: string;
  terminal: boolean;
  fromInitial: boolean;
  operations: string[];
  today: number;
  yesterday: number;
  buckets: Array<{ start: string; count: number }>;
}

export interface BusinessVolumesView {
  window: { since: string; until: string };
  bucketMinutes: number;
  rows: BusinessVolumeRow[];
  /** Why an app has no rows: nothing running, no move the model lets be counted, or code that predates the read. */
  apps: Array<{ scopeId: string; unavailable: 'no-version' | 'no-moves' | 'not-yet-available' | null }>;
}

/** A deploy moment drawn on the chart (#1236) — a registry fact, not telemetry. */
export interface ReleaseMarker {
  at: string;
  kind: 'pushed' | 'went-live';
  version: string;
  versionId: string;
}

export interface TrafficSeries {
  window?: { since: string; until: string };
  buckets: TrafficBucket[];
  markers: ReleaseMarker[];
  bucketMinutes: number;
  /** False = the plane cannot bucket; the chart says so rather than drawing silence. */
  available: boolean;
}

/** One instant drawn on an app's chart (#1447) — a declared fact, never an inferred anomaly. */
export interface OverlayMarker {
  at: string;
  kind: 'migration' | 'run-failed' | 'failure';
  label: string;
  /** The one line of context the tooltip adds, or the honest absence of one. */
  detail: string | null;
}

/** Recorded failures retained independently of a schedule's recent successful runs. */
export interface AppFailure {
  id: string;
  at: string;
  kind: 'sweep' | 'operation';
  operation: string;
  stage: string | null;
  message: string | null;
  code: string | null;
}
export interface AppFailuresView {
  entries: AppFailure[];
  unavailableSources: string[];
  incompleteSources: string[];
}

/** A stretch of time worth shading — today only a freshness expectation reading stale. */
export interface OverlaySpan {
  from: string;
  to: string;
  kind: 'stale';
  label: string;
}

export interface AppOverlays {
  unavailableSources?: string[];
  incompleteSources?: string[];
  markers: OverlayMarker[];
  spans: OverlaySpan[];
  /** True = markers were dropped to the cap; the legend says so rather than hiding it. */
  truncated: boolean;
}

/** One app's line on the team chart — its own zero-filled series. */
export interface TeamTrafficLine {
  scopeId: string;
  buckets: TrafficBucket[];
}

export interface TeamTrafficSeries {
  window?: { since: string; until: string };
  /** Every scope asked for, in the order asked. */
  series: TeamTrafficLine[];
  bucketMinutes: number;
  /** False = the plane cannot bucket; the chart says so rather than drawing silence. */
  available: boolean;
}

/** One side of the running-vs-update comparison (#1236). Nulls = metrics unavailable. */
export interface ReleaseSide {
  versionId: string;
  version: string | null;
  requests: number | null;
  errors: number | null;
  cpuTimeP50: number | null;
  cpuTimeP99: number | null;
}

export interface ReleaseComparison {
  running: ReleaseSide | null;
  /** Null = already on prod's head — nothing an update would move to. */
  update: ReleaseSide | null;
  metricsAvailable: boolean;
  /** False = another team publishes this vertical; its traffic is theirs to see, not ours. */
  owned: boolean;
}


export interface BoundScopesView {
  /** Neither archived nor reaped — the number `still backs N scope(s)` reports. */
  live: number;
  /** Archived — the number `still backs N archived scope(s)` reports. */
  archived: number;
  scopes: BoundScopeRow[];
}

export interface MoveScopesResult {
  moved: string[];
  /** `reason` (#2347): the review the acknowledgement answered moved, or none was sent. */
  refusal: { scopeId: string; message: string; reason?: RebindReviewReason } | null;
}


export interface RetireScopesResult {
  retired: string[];
  failure: { scopeId: string; message: string } | null;
}



/** The result of updating an app to its vertical's prod version. */
export interface UpdateResult {
  updated: boolean;
  version: string | null;
  previousVersion: string | null;
}

/** One snapshot (test copy) of an app's data — a fork's directory row. */
export interface SnapshotRow {
  id: string;
  kind: string;
  forkedFrom: string | null;
  forkedAt: string | null;
  /** null = kept until deleted; otherwise the GC sweep reaps it past this instant. */
  expiresAt: string | null;
  verticalVersionId: string | null;
  createdAt: string;
  /** The copy's preview hostname (`app--s1a2b.…`), when one is bound. */
  url?: string | null;
}

/** One table of an app-data dump (mirrors the platform's ScopeDumpTable). */
export interface DumpTable {
  name: string;
  ddl: string;
  columns: string[];
  rows: unknown[][];
}

export interface DumpStore {
  binding: string;
  driver: string;
  tables: DumpTable[];
}

/** An app's data as a dump the CLI also accepts. */
export interface AppDataDump {
  tenantId: string;
  scopeId: string;
  capturedAt: string;
  /** True when PII columns arrived redacted (always, in connected mode). */
  masked: boolean;
  tables: DumpTable[];
  stores: DumpStore[];
}

/** What an import did, including the fork to back out to. */
export interface RestoreResult {
  restored: string;
  tables: number;
  safetyCopyId: string;
}

/** One importable repo the tenant's GitHub connection can see (worker's github.ts shape). */
export interface GitRepo {
  fullName: string;
  defaultBranch: string;
  private: boolean;
  updatedAt: string;
}

/** `GET /api/teams/:teamId/github/repos` — the Git-import card's live state. */
export interface GitReposResult {
  /** Is the GitHub App configured on this deployment at all? `false` ⇒ show nothing/hint. */
  configured: boolean;
  /** Has this tenant connected GitHub? `false` ⇒ show the Connect button. */
  connected: boolean;
  /** The SELECTED GitHub account (org/user login), when connected. */
  account?: string | null;
  /** Every connected account (namespace) — the picker's list; `repos` belongs to `account`. */
  accounts: string[];
  repos: GitRepo[];
}

/** `GET /api/github/workflow-preview` — the manual path's copy-paste workflow. */
export interface WorkflowPreview {
  workflowPath: string;
  workflow: string;
}

/** One table in an app's database — the Data tab's left list (mirrors ScopeTable). */
export interface ScopeTable {
  name: string;
  rowCount: number;
  /** `_substrat_*` spine + SQLite internals — grouped apart from the vertical's own tables. */
  system: boolean;
}

/** One scope an app spans — the Data tab's scope switcher (a multi-scope vertical has several). */
export interface AppScope {
  scopeId: string;
  name: string;
  status: string;
  /** The app's primary scope — the one the Data tab opens on. */
  isDefault: boolean;
}

/** A bounded page of one table (mirrors ScopeTablePage). Rows are positional, aligned to `columns`. */
export interface ScopeTablePage {
  table: string;
  columns: string[];
  rows: unknown[][];
  rowCount: number;
  limit: number;
  offset: number;
}

/** A read-only console query's result (mirrors ScopeQueryResult). `truncated` = row cap hit. */
export interface ScopeQueryResult {
  columns: string[];
  rows: unknown[][];
  truncated: boolean;
}

/** A declared env var for a vertical — drives the Env form (placeholder + description). */
export interface EnvVarSpec {
  key: string;
  label?: string;
  description: string;
  placeholder?: string;
  required: boolean;
  secret: boolean;
  default?: string;
  group?: string;
}

/** One stored env var — a secret's value is never sent back (write-only). */
export interface AppEnvValue {
  key: string;
  isSecret: boolean;
  hasValue: boolean;
  value: string | null;
  updatedAt: string;
}

/** The app's owner seat (#925) as the platform relays it from the app's own identity directory. */
export interface OwnerSeatView {
  /** The deployed vertical may return a state this dashboard does not yet recognize. */
  state: string;
  owner: string | null;
  firstSignIn: { open: boolean; until: string | null } | null;
  claimLink: { expiresAt: string } | null;
}

/** A freshly minted owner-claim link — shown once, stored nowhere. */
export interface OwnerClaimLinkView {
  claimUrl: string;
  expiresAt: string;
}

/** An installed app's members (#1150), as the platform relays them from the app's own deployment. */
export interface AppMembersView {
  /** The roles a person may be invited at or moved to — the app's declared member roles. */
  roles: string[];
  members: { principal: string; roles: string[]; logins: number; email: string | null; owner: boolean }[];
  /** `roleKey`: the role it was minted at. `roles`: what its principal holds now. */
  invites: {
    principal: string;
    roleKey: string;
    roles: string[];
    email: string | null;
    createdAt: number;
    /** Where the invite's link stands (#1686); null for an older invite, absent from an older vertical. */
    link?: { state: string; reason: string | null } | null;
  }[];
}

/** A freshly minted member invite — shown once, stored nowhere. */
/**
 * What every member change answers beside its result (#2064). `auditWarning` means the change
 * WENT THROUGH but the platform could not write its admin-log outcome: show it as a warning on a
 * success, never as an error to retry.
 */
export interface AuditedAnswerView {
  operationId?: string;
  auditWarning?: string;
}

export interface MemberInviteView extends AuditedAnswerView {
  principal: string;
  roleKey: string;
  email: string | null;
  acceptUrl: string;
}

export interface AppEnvView {
  spec: EnvVarSpec[];
  values: AppEnvValue[];
}

/** A provider credential form field — server-driven, the same move as the env spec. */
export interface ProviderField {
  key: string;
  label: string;
  /** Write-only: never echoed back after saving. */
  secret: boolean;
  placeholder?: string;
  /** #2100: may be left empty — an alternative, not part of the credential's set. */
  optional?: boolean;
  /** A checkbox: sent as `'yes'` when ticked, left out otherwise. */
  toggle?: boolean;
}

/** A public certificate a connection signs in with (#2100). */
export interface CertificateView {
  pem: string;
  thumbprint: string;
  notAfter: string;
}

/** One provider connection, metadata only — the row cannot carry its secret. */
export interface ConnectionView {
  id: string;
  label: string;
  status: 'active' | 'expired' | 'revoked' | 'error';
  externalAccountRef: string | null;
  expiresAt: string | null;
  lastOkAt: string | null;
  lastError: string | null;
  lastErrorAt: string | null;
  createdAt: string;
}

/** One provider on the per-app Integrations tab: the form, whether the app's vertical
 *  declares it (`required`), and the live connection if one exists. */
export interface AppIntegration {
  provider: string;
  name: string;
  description: string;
  monogram: string;
  fields: ProviderField[];
  /**
   * `'redirect'` when the primary connect is an OAuth-style consent round (#1220):
   * the UI leads with a Connect button and a copyable connect link, and the
   * credential form becomes the operator fallback. Null when the flow is not
   * declared — or declared but unconfigured on this deployment.
   */
  connectFlow: 'redirect' | null;
  /**
   * One connection per external account (#1267) — a bureau connects one Fortnox company
   * per client. The card then lists `connections` and offers "connect another"; a new
   * consent adds a row rather than rotating one.
   */
  multiAccount: boolean;
  required: boolean;
  /** The single-connection answer (the null-ref row, else the newest). */
  connection: ConnectionView | null;
  /** Every live connection for this provider, newest first. */
  connections: ConnectionView[];
}

export interface AppIntegrationsView {
  providers: AppIntegration[];
}

/** One provider on the account-level Integrations page: every connection under it (a
 *  connection is keyed to a vertical, shared by that vertical's apps) and which apps
 *  can connect it. */
export interface AccountIntegration {
  provider: string;
  name: string;
  description: string;
  monogram: string;
  fields: ProviderField[];
  /** See {@link AppIntegration.connectFlow}. */
  connectFlow: 'redirect' | null;
  /** See {@link AppIntegration.multiAccount}. */
  multiAccount?: boolean;
  connections: Array<
    ConnectionView & {
      vertical: string;
      apps: Array<{ scopeId: string; name: string }>;
      /** #1232: the last day's sweep outcomes, newest first — the recent-runs strip. */
      sweepRuns: SweepRunView[];
    }
  >;
  connectTargets: Array<{ scopeId: string; name: string; vertical: string; connected: boolean }>;
}

/** One outstanding consent-round link (#1220) — single-use, revocable, expiring. */
export interface ConnectLinkView {
  id: string;
  provider: string;
  appScopeId: string;
  status: 'outstanding' | 'used' | 'revoked';
  createdBy: string;
  createdAt: string;
  expiresAt: string;
  /** Present on the mint response only — the URL is never listed back. */
  url?: string;
  /** On the list: minted here (`dashboard`) or by the app itself and mailed from it (`app`). */
  source?: 'dashboard' | 'app';
}

/** `GET /api/integrations` */
export interface AccountIntegrationsView {
  providers: AccountIntegration[];
}

/** One provider-named fact — a probe's account detail, or a line of an activity row. */
export interface ConnectionFact {
  label: string;
  value: string;
}

/**
 * An app provider verification — what the provider said when
 * asked to accept this credential. `ok: false` is an answer, not a failure: the
 * provider's own words are the whole value ("This feature is disabled" and "invalid
 * credentials" send an operator to different places).
 */
export interface ConnectionProbeView {
  ok: boolean;
  refused?: boolean;
  accountRef: string | null;
  accountLabel: string | null;
  facts: ConnectionFact[];
  error: string | null;
}

/** One thing the connection did — a projected dispatch-ledger row. */
export interface ConnectionActivityEntryView {
  key: string;
  title: string;
  reference: string | null;
  status: string;
  at: string | null;
  facts: ConnectionFact[];
}

/**
 * One stored credential field as the console may see it: identifiers whole, secrets
 * reduced by the connector to a bullet run plus their last four characters. Never enough
 * to use — enough to tell two credentials apart.
 */
export interface ConnectionCredentialFieldView {
  key: string;
  label: string;
  value: string;
  masked: boolean;
}

/**
 * One platform-run delivery for this provider (#618) — a `connector:<provider>` intent as the
 * drain settled it.
 *
 * This is the row that already held the answer and had no reader. A hosted vertical cannot run
 * a connector, so every delivery becomes an intent the platform executes; the provider's reply
 * lands in `lastError` in full, while the connection card could only ever say "HTTP 409 from
 * scrive". `lastError` is carried verbatim and rendered untruncated for exactly that reason.
 */
export interface ConnectionIntentView {
  id: string;
  status: 'pending' | 'done' | 'failed';
  attempts: number;
  lastError: string | null;
  requestedAt: string;
  settledAt: string | null;
  /** The routed event's type — what was sent, beside what came back. */
  eventType: string;
  /**
   * WHO refused (#841), as the drain attributed it — `null` on an intent settled by a
   * control plane too old to say, or by a vertical whose spine predates the column.
   *
   * A caption may only quote a failure as the provider's words when `origin` is
   * `provider`. It was captioning ALL of them that way, so a `permission denied:
   * protocol:read` raised by our own check — before a byte reached Scrive — was rendered
   * as "what Scrive said, in full", and the operator went to audit their Scrive account.
   */
  failure: {
    origin: 'platform' | 'provider' | 'unknown';
    code: string | null;
    /** The permission key the refusal named, when it named one — the grant join's key. */
    permission: string | null;
  } | null;
}

/** A dispatch record the platform could not read whole (#1637): named as stored, never guessed at. */
export interface UnreadableIntentView {
  id: string | null;
  status: string | null;
  requestedAt: string | null;
  decodeError: string;
}

/**
 * An app provider activity response — activity, plus the grants the
 * connection holds and the masked credential.
 *
 * Two dials, two different questions. `source` is `ledger` (what this platform sent) or
 * `provider` (what the provider's own archive holds, including documents nobody here
 * created) — neither is a superset. `live` says whether ledger statuses were refreshed
 * against the provider; a UI must not blur the platform's record with the provider's.
 */
export interface ConnectionActivityView {
  source: 'ledger' | 'provider';
  /** The connection as the directory holds it right now — health included. */
  connection: ConnectionView;
  entries: ConnectionActivityEntryView[];
  live: boolean;
  grants: string[];
  credential: ConnectionCredentialFieldView[];
  /**
   * #2100: the public certificate the connection signs in with, for the tenant to upload on
   * the provider's side. Absent or null when the provider or this connection uses none.
   */
  certificate?: (CertificateView & {
    /** The successor being rotated in; the fields above stay the certificate in use until it is uploaded. */
    next?: CertificateView;
  }) | null;
  /**
   * The platform's dispatch record for this provider (#618) — newest first, empty on a plane
   * too old to serve it (the read is best-effort so a missing journal never costs the activity).
   */
  intents: ConnectionIntentView[];
  /**
   * #1637: dispatch records whose stored identity did not decode — id, status or time as stored,
   * and which columns broke. Absent on a plane too old to name them; empty on a healthy journal.
   */
  unreadableIntents?: UnreadableIntentView[];
  /**
   * The platform's sweep record for this connection (#1232) — newest first, empty on a
   * plane too old to serve it. "When was this last swept, and how did it go", which no
   * amount of provider-side activity can answer: a sweep that found nothing to do
   * appears here and nowhere else.
   */
  sweepRuns: SweepRunView[];
}

/** One declared schedule's health on an app (#1232) — the worker's derived verdict, rendered verbatim. */
export interface AppScheduleRow {
  operation: string;
  moduleId: string;
  everyMinutes: number;
  permissions: string[];
  lastRun: SweepRunView | null;
  nextDueAt: string | null;
  health: 'healthy' | 'overdue' | 'never-run' | 'sweeper-silent';
  runs: SweepRunView[];
}

/** The schedules panel's data. Both null = nothing declared or a pre-field version — hide. */
/**
 * One peer target this app declares it calls (#1706), resolved against what the tenant runs
 * and against the switch in the TARGET's scope. Mirrors `apps/dashboard/src/peers.ts` —
 * `not-installed` is an ordinary answer, never a fault, and `unreadable` is never folded
 * into `allowed`.
 */
export type DeclaredCallRow =
  | { state: 'not-installed'; vertical: string }
  | { state: 'ambiguous'; vertical: string; count: number }
  | { state: 'bound-unavailable'; vertical: string }
  | { state: 'not-declared'; vertical: string }
  | { state: 'allowed'; vertical: string; scopeId: string }
  | {
      state: 'switched-off';
      vertical: string;
      scopeId: string;
      switchedOff: { actor: string; reason: string; at: string } | null;
    }
  | { state: 'no-grant'; vertical: string; scopeId: string }
  | { state: 'unreadable'; vertical: string; scopeId: string; message: string };

/** Where one of the tenant's other apps stands at THIS app's door. */
export interface PeerCallerRow {
  vertical: string;
  /** The control plane owns the vocabulary; unknown positions have no switch action. */
  calls: string;
  switchedOff: { actor: string; reason: string; at: string } | null;
}

/** Both directions of the peer disclosure for one app (#1706). */
export interface AppPeersView {
  /** What the running version declares it calls. `null` = a version that predates the field. */
  declares: string[] | null;
  calls: DeclaredCallRow[];
  bindingChoices: { vertical: string; boundScopeId: string | null; invalidated: boolean; candidates: { scopeId: string; name: string }[] }[];
  /** The mirror: who may call in here. `null` when the read itself failed. */
  callers: PeerCallerRow[] | null;
  callersError: string | null;
}

export interface AppSchedulesView {
  running: { versionId: string | null; version: string | null };
  schedules: AppScheduleRow[] | null;
  /** Declared freshness expectations' verdicts (#1272); null = none declared. */
  freshness: AppFreshnessRow[] | null;
  lastSweepAt: string | null;
}

/** One sweep outcome for a connection (#1232) — what the recent-runs strip renders. */
export interface SweepRunView {
  id: string;
  outcome: 'ok' | 'failed' | 'skipped';
  at: string;
  error: string | null;
  elapsedMs: number | null;
  /** The freshness rows' evidence timestamp (#1272); null on schedule rows. */
  observedAt: string | null;
}

/** One declared freshness expectation's verdict on an app (#1272) — rendered verbatim. */
export interface AppFreshnessRow {
  eventType: string;
  moduleId: string;
  withinHours: number;
  observedAt: string | null;
  health: 'fresh' | 'stale' | 'never-seen' | 'sweeper-silent';
  runs: SweepRunView[];
}

/** One hostname bound to the app's scope (the Domains tab). */
export interface AppHostnameRow {
  hostname: string;
  surface: string;
  status: string;
  /** Why a row is `failed` (or mid-flight detail) — rendered under the status pill. */
  statusNote: string | null;
  canonical: boolean;
  createdAt: string | null;
  /** DNS records to publish for a custom domain; empty for a platform mint. */
  validationRecords: DnsRecord[];
}

/** A surface the app's vertical declares it serves — the Domains tab's picker. */
export interface DeclaredSurface {
  name: string;
  label: string;
}

/** `GET /api/teams/:teamId/apps/:scope/hostnames` — bindings + declared surfaces + the untouchable default. */
export interface AppHostnamesView {
  bindings: AppHostnameRow[];
  surfaces: DeclaredSurface[];
  defaultHostname: string | null;
}

/** The app's stored Identity choice — the clientSecret is write-only, never echoed. */
export interface AppAuthRecord {
  mode: 'oidc';
  issuer: string;
  clientId: string;
  audience: string | null;
  hasClientSecret: boolean;
  updatedAt: string;
}

/** The stored identity choice; `auth: null` means the vertical's builtin sign-in. */
export interface AppAuthView {
  auth: AppAuthRecord | null;
  /** The redirect URL to register at an external issuer; null while no hostname is bound. */
  callbackUrl: string | null;
}

/** The save result; `delivered` says whether the running app got it. */
export interface AppAuthUpdateResult {
  delivered: boolean;
  note?: string;
}

/** A DNS record the tenant must publish for a custom domain (§4.7). */
export interface DnsRecord {
  /** The plane's (known: hostname, txt); a newer plane may name another (#2401). */
  type: string;
  name: string;
  value: string;
  status?: string | null;
}

/** One custom domain row for the account-level Domains view (`GET /api/teams/:teamId/domains`). */
export interface DomainRow {
  hostname: string;
  appScopeId: string;
  /** The app (vertical install) this domain fronts. */
  app: string;
  surface: string;
  /** The plane's (known: pending, verifying, active, failed); a newer plane may name another (#2401). */
  status: string;
  statusNote: string | null;
  /** Canonical for its (scope, surface) — the "primary" tag. */
  primary: boolean;
  createdAt: string;
  /** DNS records to publish while it is not yet active. */
  validationRecords: DnsRecord[];
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /**
     * The provider's own answer, when a connect was refused because the credential was
     * rejected upstream (#605, 422). Lets the dialog say what is actually wrong —
     * including WHICH provider environment answered — rather than "couldn't save".
     */
    readonly probe?: ConnectionProbeView,
    /** #1756: the apps an Update or a Bind would break, when that is why it was refused. */
    readonly exportBreaks?: ExportBreakRow[],
    /**
     * #2192: the id of the request that failed, when the answering worker named one — the
     * `x-substrat-request-id` header, else the problem body's `requestId`. What a person
     * quotes to find the request. Absent where the answer carried none.
     */
    readonly requestId?: string,
    /** The problem's `reason` slug, when it carried one: what a caller branches on (#2333). */
    readonly reason?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** One app a move would break (#1756): it imports `type` at `schemaVersion`, and the version stops exporting it. */
export interface ExportBreakRow {
  scopeId: string;
  vertical: string;
  type: string;
  schemaVersion: number;
  /** What the version exports it as instead, or null when it no longer does. */
  incoming: number | null;
}

/**
 * The declared surface (#2170), bound to ONE team: every call goes to
 * `/api/teams/<teamId>/…`, so the request names its team in its own URL. The routes
 * `call` reaches below still read the team off the `sb_team` cookie, which every tab
 * shares — the reason a tab could show one team while reading another. Areas move from
 * `call` to this as their routes move into `src/routes.ts`.
 *
 * Build it from the team the TAB is on (`me.currentTeamId`, pinned by the URL), never
 * once at module load.
 */
export function teamApi(teamId: string): DashboardClient {
  return createClient({
    baseUrl: `/api/teams/${encodeURIComponent(teamId)}`,
    fetch: (input, init) => fetch(input, { credentials: 'include', ...init }),
    // The one reading of a failed body (#971), same as `call`.
    errorMessage: (body) => problemDetail(body),
  });
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  return (await callWithHeaders<T>(path, init)).body;
}

/** `call`, plus the headers of the answer — for a read that says something its body cannot. */
async function callWithHeaders<T>(path: string, init?: RequestInit): Promise<{ body: T; headers: Headers }> {
  const res = await fetch(`/api${path}`, {
    credentials: 'include',
    headers: { 'content-type': 'application/json', ...(init?.headers as Record<string, string>) },
    ...init,
  });
  if (!res.ok) {
    // `problemDetail` is the one reading of a failed body (#971) — the problem body's
    // sentence, then the deprecated duplicate every SPA read before it. The `probe`
    // beside it is the dashboard's own extension (#605) and stays read here.
    const body = (await res.json().catch(() => null)) as { probe?: ConnectionProbeView; requestId?: unknown; reason?: unknown } | null;
    // Only something shaped like an id is surfaced as one: it is shown, and people copy it.
    const plausible = (v: unknown): string | undefined => (typeof v === 'string' && /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/i.test(v) ? v : undefined);
    const fromBody = plausible(body?.requestId);
    throw new ApiError(
      res.status,
      problemDetail(body) ?? `${res.status} ${res.statusText}`,
      body?.probe,
      exportBreaksIn<ExportBreakRow>(body),
      plausible(res.headers.get(REQUEST_ID_HEADER)) ?? fromBody,
      typeof body?.reason === 'string' ? body.reason : undefined,
    );
  }
  return { body: res.status === 204 ? (undefined as T) : ((await res.json()) as T), headers: res.headers };
}

/** Invocation aggregates for one deployed version of a team vertical (last N hours). */
export interface ObservabilityRow {
  vertical: string;
  /** The human version label (display); `versionId` is the signals dimension. */
  version: string;
  /** The version-registry ULID (#1231), or null where the registry cannot name one. */
  versionId: string | null;
  service: string;
  requests: number;
  errors: number;
  subrequests: number;
  /** Per-request CPU time quantiles, microseconds. */
  cpuTimeP50: number;
  cpuTimeP99: number;
}

/**
 * One installed app's own traffic — the tenant grain (observability.md §3 view 4).
 *
 * `ObservabilityRow` above is keyed on the deployed SERVICE, which serves every team that
 * installed the vertical; this is keyed on the app scope, which is one installation. Two
 * teams running the same vertical are two of these and one indistinguishable one of those.
 */
export interface TenantMetricsRow {
  scopeId: string;
  vertical: string | null;
  /** Which declared surface answered (`app`, `api`, …). */
  surface: string | null;
  requests: number;
  errors: number;
  /** Router-observed duration quantiles, milliseconds. */
  durationP50: number;
  durationP95: number;
}

/**
 * One installed app's traffic inside ONE time bucket (#1447) — `TenantMetricsRow` with a
 * time axis, keyed on the app alone so a chart draws one line per app. An empty bucket is
 * omitted, never zero-filled; the renderer fills, knowing `bucketMinutes`.
 */
export interface TenantMetricsBucket {
  scopeId: string;
  /** The bucket's opening instant, ISO, UTC. */
  start: string;
  bucketMinutes: number;
  requests: number;
  errors: number;
  /** Weighted median request duration inside the bucket, ms — the same quantiles as `TenantMetricsRow`. */
  durationP50: number;
  durationP95: number;
}

/** One recent log event from a team vertical's deployed service. */
/** #1746: one bucket of the request histogram — per-level counts from `start`. */
export interface RequestVolumeBucket {
  start: string;
  info: number;
  warn: number;
  error: number;
  /** Requests whose line predates `level` — a version not re-pushed since #1746. */
  unrecorded: number;
}

/** #1746: the request histogram over a window. Buckets with no requests are absent. */
export interface RequestVolume {
  bucketMs: number;
  buckets: RequestVolumeBucket[];
  /** The backend counted from a sample; the numbers are estimates. */
  estimated: boolean;
}

/** #1746: facet counts — each counted with every other filter applied, its own left out. */
export interface RequestFacets {
  total: number;
  facets: Record<string, { value: string | number; count: number }[]>;
  estimated: boolean;
}

/** #1746: one request, as its stamped invocation line recorded it. `null` = not recorded. */
import type { RequestRecord } from './request-detail';
export type { RequestRecord };

/** #1747: one template and the lines written from it. */
export interface LogPattern {
  template: string;
  count: number;
  /** Of every matching `ctx.log` line in the window, 0–1. */
  share: number;
  levels: Record<'debug' | 'info' | 'warn' | 'error', number>;
  dominant: 'debug' | 'info' | 'warn' | 'error';
  /** Lines per bucket, oldest first; an empty bucket is absent. */
  buckets: { start: string; count: number }[];
}

/** #1747: the pattern read. */
export interface LogPatterns {
  total: number;
  bucketMs: number;
  patterns: LogPattern[];
  /** More templates existed than were listed. */
  truncated: boolean;
  estimated: boolean;
}

export interface ObservabilityLogEvent {
  timestamp: number | null;
  level: string | null;
  message: string | null;
  service: string | null;
  outcome: string | null;
  /** Neutral enrichments carried through the observability seam (observability.ts). */
  trigger: string | null;
  /** The invocation shape (`fetch`, `rpc`, `scheduled`, …) — never a domain event's type (#1231). */
  invocation: string | null;
  entrypoint: string | null;
  requestId: string | null;
  /** Substrat stamped invocation ID; distinct from a provider request ID. */
  invocationId?: string | null;
  cpuTimeMs: number | null;
  wallTimeMs: number | null;
  /** The backend's full event — powers the per-row expand-to-JSON drill-down. */
  raw?: unknown;
}

/** The team-grain logs read's query: one service, or every version the tab is showing. */
interface ObservabilityLogsQuery {
  services: string[];
  level?: string;
  search?: string;
  hours?: number;
  limit?: number;
}

export type AppTenantLogsQuery = Parameters<typeof tenantLogsQuery>[0];

async function appTenantLogsRead(
  teamId: string,
  scopeId: string,
  q: AppTenantLogsQuery,
): Promise<{ events: ObservabilityLogEvent[]; incomplete: boolean }> {
  const p = tenantLogsQuery(q);
  const { body, headers } = await callWithHeaders<ObservabilityLogEvent[]>(
    `/teams/${encodeURIComponent(teamId)}/apps/${encodeURIComponent(scopeId)}/observability/logs?${p.toString()}`,
  );
  return { events: body, incomplete: logsIncompleteOf(headers) };
}

async function observabilityLogsRead(
  teamId: string,
  q: ObservabilityLogsQuery,
): Promise<{ events: ObservabilityLogEvent[]; incomplete: boolean }> {
  const p = new URLSearchParams();
  for (const s of q.services) p.append('service', s);
  if (q.level) p.set('level', q.level);
  if (q.search) p.set('search', q.search);
  if (q.hours) p.set('hours', String(q.hours));
  if (q.limit) p.set('limit', String(q.limit));
  const { body, headers } = await callWithHeaders<ObservabilityLogEvent[]>(
    `/teams/${encodeURIComponent(teamId)}/observability/logs?${p.toString()}`,
  );
  return { events: body, incomplete: logsIncompleteOf(headers) };
}

export const api = {
  /** `null` when there is no session (the worker answers 401); onboarding when teamless. */
  me: async (): Promise<MeResult | null> => {
    try {
      return await call<MeResult>('/me');
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return null;
      throw e;
    }
  },
  /** Create a team (first team or another); the server switches to it, so reload after. */
  createTeam: (name: string) =>
    call<{ teamId: string }>('/teams', { method: 'POST', body: JSON.stringify({ name }) }),
  /** Switch the active team; the server pins it in a cookie, so the caller reloads after. */
  switchTeam: (teamId: string) =>
    call<void>('/teams/switch', { method: 'POST', body: JSON.stringify({ teamId }) }),
  catalog: () => call<CatalogEntry[]>('/catalog'),
  /** Preview an invite (unauthenticated): the team + invited email, for prefill + the accept screen. */
  previewInvite: (token: string) =>
    call<{ teamName: string; email: string; roleKey: InviteRole }>(
      `/invites/preview?token=${encodeURIComponent(token)}`,
    ),
  /** Accept an invite token; the server switches to the team, so the caller reloads after. */
  acceptInvite: (token: string) =>
    call<{ teamId: string; already?: boolean }>('/invites/accept', {
      method: 'POST',
      body: JSON.stringify({ token }),
    }),
  /** One page of the app's audit trail, newest first; `nextCursor` walks older activity. */
  appEvents: (scopeId: string, opts?: PageOpts) =>
    call<ListPage<AppEvent>>(`/apps/${encodeURIComponent(scopeId)}/events${pageQs(opts)}`),
  /** The install's durable step record (#424) — rendered live while an install runs. */
  installSteps: (scopeId: string) => call<InstallStep[]>(`/apps/${encodeURIComponent(scopeId)}/steps`),
  /** One page of the app scope's control-plane audit log (#479), newest first; `nextCursor` walks older. */
  auditLog: (scopeId: string, opts?: PageOpts) =>
    call<ListPage<AuditEntry>>(`/apps/${encodeURIComponent(scopeId)}/audit${pageQs(opts)}`),
  /** One page of the TEAM's control-plane audit log (#1447) — every app, newest first.
   *  `scopeId` narrows it to one app; without it the page is the tenant's whole log,
   *  which is the only way to see the entries that name no scope at all. */
  auditLogAll: (opts?: PageOpts & { scopeId?: string }) => {
    const qs = pageQs(opts);
    const scope = opts?.scopeId ? `${qs ? '&' : '?'}scopeId=${encodeURIComponent(opts.scopeId)}` : '';
    return call<ListPage<AuditEntry>>(`/audit${qs}${scope}`);
  },
  /** The app's vertical version registry (one page of versions, newest first) + channels +
   *  the version THIS scope actually runs (`boundVersionId`). `cursor` walks older versions. */
  appDeployments: (scopeId: string, opts?: PageOpts) =>
    call<AppDeployments>(`/apps/${encodeURIComponent(scopeId)}/deployments${pageQs(opts)}`),
  /** The static files ONE version ships (#340), from its retained deploy manifest —
   *  `assets: null` when it retained none or shipped no static files. */
  appVersionAssets: (scopeId: string, versionId: string) =>
    call<{ assets: DeployAssets | null }>(
      `/apps/${encodeURIComponent(scopeId)}/deployments/${encodeURIComponent(versionId)}/assets`,
    ).then((r) => r.assets),
  /** The declared permission surface (D-39, #336) of the version this app runs, plus the
   *  update target's, for the Permissions tab's table + update diff. */
  appPermissions: (scopeId: string) => call<AppPermissionsView>(`/apps/${encodeURIComponent(scopeId)}/permissions`),
  appModel: (scopeId: string) => call<AppModelView>(`/apps/${encodeURIComponent(scopeId)}/model`),
  /** Schedule health for the app's running version (#1232) — null schedules hides the panel. */
  appSchedules: (scopeId: string) => call<AppSchedulesView>(`/apps/${encodeURIComponent(scopeId)}/schedules`),
  /** The tables of the app's own database (Data tab). */
  appTables: (scopeId: string) => call<ScopeTable[]>(`/apps/${encodeURIComponent(scopeId)}/tables`),
  /** A bounded page of one table of the app's database. */
  appTableRows: (scopeId: string, table: string, opts: { limit?: number; offset?: number } = {}) => {
    const q = new URLSearchParams();
    if (opts.limit != null) q.set('limit', String(opts.limit));
    if (opts.offset != null) q.set('offset', String(opts.offset));
    const qs = q.toString();
    return call<ScopeTablePage>(
      `/apps/${encodeURIComponent(scopeId)}/tables/${encodeURIComponent(table)}${qs ? `?${qs}` : ''}`,
    );
  },
  /** One read-only SQL statement against the app's database (the Data tab's console). */
  appQuery: (scopeId: string, sql: string) =>
    call<ScopeQueryResult>(`/apps/${encodeURIComponent(scopeId)}/query`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sql }),
    }),
  /**
   * Mint a consent-round connect link (#1220). The `url` in the answer is both the
   * Connect button's destination (navigate to it now) and the copyable link for a
   * provider admin with no dashboard login. Single-use; revocable while outstanding.
   */
  mintConnectLink: (scopeId: string, provider: string, input: { ttlMs?: number } = {}) =>
    call<ConnectLinkView & { url: string }>(
      `/apps/${encodeURIComponent(scopeId)}/integrations/${encodeURIComponent(provider)}/connect-links`,
      { method: 'POST', body: JSON.stringify(input) },
    ),
  /** The outstanding connect links for this app + provider. */
  connectLinks: (scopeId: string, provider: string) =>
    call<{ links: ConnectLinkView[] }>(
      `/apps/${encodeURIComponent(scopeId)}/integrations/${encodeURIComponent(provider)}/connect-links`,
    ),
  /** Revoke an outstanding connect link — the URL it minted stops working. */
  revokeConnectLink: (scopeId: string, provider: string, linkId: string) =>
    call<void>(
      `/apps/${encodeURIComponent(scopeId)}/integrations/${encodeURIComponent(provider)}/connect-links/${encodeURIComponent(linkId)}`,
      { method: 'DELETE' },
    ),
  /** The account-level integrations overview: all providers, connections, and connectable apps. */
  integrations: () => call<AccountIntegrationsView>('/integrations'),
  // -- observability (design/observability.md §5, view 2) -------------------
  // Metrics/logs for THIS team's pushed verticals only — the worker narrows by
  // owned deployment refs. 501 = the platform has no observability backend.
  observabilityMetrics: (teamId: string, hours = 24, vertical?: string) =>
    teamApi(teamId).observabilityMetrics({ hours: String(hours), vertical }),
  // `services` is a set: one version, or every version the tab is showing — the
  // worker asks the plane for them together and answers one merged stream.
  observabilityLogs: async (teamId: string, q: ObservabilityLogsQuery): Promise<ObservabilityLogEvent[]> =>
    (await observabilityLogsRead(teamId, q)).events,
  /**
   * The same read, with what its body cannot carry (#2520): `incomplete` is set when the
   * worker passed on the plane's `x-substrat-logs-incomplete` header — the page may be
   * incomplete or missing newer lines — and only then.
   */
  observabilityLogsRead,

  // -- the tenant grain (observability.md §3 view 4) ------------------------
  // The two reads above answer "how is the vertical I PUBLISHED doing", across every
  // team that installed it. These answer "how is MY app doing" — the question a team
  // asks about an app running someone else's vertical, which the reads above cannot
  // answer at all: an installed vertical has no owned service ref and comes back empty.
  // Narrowed to this app's scope by the worker, never by this client.
  appTenantMetrics: (teamId: string, scopeId: string, hours = 24, window?: { since: string; until: string }) =>
    teamApi(teamId).appObservabilityMetrics({ scopeId, hours: String(hours), ...window }),
  /**
   * The same traffic bucketed over time, across MY apps (#1447): one series per app, in
   * one read. No `scopeIds` means every app this team has installed — resolved by the
   * worker against the team's own apps, never by this client.
   */
  tenantMetricsSeries: (teamId: string, q: { scopeIds?: string[]; hours?: number } = {}) =>
    call<TenantMetricsBucket[]>(`/teams/${encodeURIComponent(teamId)}/observability/tenant-metrics-series${obsWindowQs(q)}`),
  /**
   * The same read, shaped for the team Observability chart (#1447): one zero-filled
   * series per app, every scope asked for present whether it served or not. No
   * `scopeIds` means every app this team has installed — resolved by the worker.
   */
  teamTraffic: (teamId: string, q: { scopeIds?: string[]; hours?: number; since?: string; until?: string } = {}) =>
    q.scopeIds?.length
      ? call<TeamTrafficSeries>(`/teams/${encodeURIComponent(teamId)}/observability/traffic${obsWindowQs(q)}`)
      : teamApi(teamId).teamTraffic({ hours: q.hours === undefined ? undefined : String(q.hours), since: q.since, until: q.until }),
  connectorCalls: (teamId: string, q: { hours?: number; since?: string; until?: string } = {}) =>
    teamApi(teamId).connectorCalls({ hours: q.hours === undefined ? undefined : String(q.hours), since: q.since, until: q.until }),
  businessVolumes: (teamId: string, q: { scopeIds?: string[]; hours?: number; since?: string; until?: string } = {}) =>
    q.scopeIds?.length
      ? call<BusinessVolumesView>(`/teams/${encodeURIComponent(teamId)}/observability/business-volumes${obsWindowQs(q)}`)
      : teamApi(teamId).businessVolumes({ hours: q.hours === undefined ? undefined : String(q.hours), since: q.since, until: q.until }),
  /** `since`/`until` are the chart's time cursor — a window ending in the past, which
   *  `hours` cannot name. Sent instead of `hours`, never beside it. */
  appTenantLogs: async (teamId: string, scopeId: string, q: AppTenantLogsQuery): Promise<ObservabilityLogEvent[]> =>
    (await appTenantLogsRead(teamId, scopeId, q)).events,
  /**
   * The same read, with what its body cannot carry (#2521): `incomplete` is set when the worker
   * passed on the plane's `x-substrat-logs-incomplete` header — the page may be missing lines
   * behind a cut — and only then.
   */
  appTenantLogsRead,
  /** #1746: one app's request histogram, facet counts and request list. `query` is built
   *  by `requestReadQuery`, so the three reads always carry the same window and filters. */
  appRequestVolume: (teamId: string, scopeId: string, query: URLSearchParams) =>
    call<RequestVolume>(`/teams/${encodeURIComponent(teamId)}/apps/${encodeURIComponent(scopeId)}/observability/requests/volume?${query.toString()}`),
  appRequestFacets: (teamId: string, scopeId: string, query: URLSearchParams) =>
    call<RequestFacets>(`/teams/${encodeURIComponent(teamId)}/apps/${encodeURIComponent(scopeId)}/observability/requests/facets?${query.toString()}`),
  /** #1747: one app's `ctx.log` lines grouped by template. */
  appLogPatterns: (teamId: string, scopeId: string, query: URLSearchParams) =>
    call<LogPatterns>(`/teams/${encodeURIComponent(teamId)}/apps/${encodeURIComponent(scopeId)}/observability/log-patterns?${query.toString()}`),
  appRequests: (teamId: string, scopeId: string, query: URLSearchParams) =>
    call<RequestRecord[]>(`/teams/${encodeURIComponent(teamId)}/apps/${encodeURIComponent(scopeId)}/observability/requests/list?${query.toString()}`),
  /** The manual path's workflow YAML (same generator the one-click commit uses). */
  workflowPreview: (repo: string, branch: string, path?: string) =>
    call<WorkflowPreview>(
      `/github/workflow-preview?repo=${encodeURIComponent(repo)}&branch=${encodeURIComponent(branch)}${path ? `&path=${encodeURIComponent(path)}` : ''}`,
    ),

  /**
   * The same series for ONE installed app (#1447) — tenant grain, so the answer is this
   * installation's traffic rather than the script's across every team that installed the
   * vertical. One app, zero-filled, with release markers — what Observability draws in
   * one-app mode. The team-level ALL-APPS chart is NOT a consumer: it plots many apps on
   * one axis from the multi-scope series instead, so never call this once per app to
   * build that.
   */
  appTraffic: (scopeId: string, hours: number, window?: { since: string; until: string }) =>
    call<TrafficSeries>(`/apps/${encodeURIComponent(scopeId)}/traffic?${new URLSearchParams({ hours: String(hours), ...window })}`),

  /**
   * The declared facts drawn over that series (#1447) — migrations applied, failed
   * schedule runs, stale freshness spans, recorded failures. Its own call because it is
   * its own route: the chart must draw on the series alone, and these arriving late or
   * not at all costs the overlays and nothing else.
   */
  appFailures: (scopeId: string, window: { since: string; until: string }) =>
    call<AppFailuresView>(`/apps/${encodeURIComponent(scopeId)}/failures?${new URLSearchParams(window)}`),

  appOverlays: (scopeId: string, hours: number, window?: { since: string; until: string }) =>
    call<AppOverlays>(`/apps/${encodeURIComponent(scopeId)}/overlays?${new URLSearchParams({ hours: String(hours), ...window })}`),


  /**
   * One record's event history (#1235) — payload, authorization chain, impersonation, PII class.
   *
   * Cursor-paged, and the caller must walk it: the outbox is read `ORDER BY id ASC`
   * a page at a time, so dropping `nextCursor` would show a long-lived record's
   * OLDEST events and silently hide everything since.
   */
  /** Facets over an app's events (#1239) — narrow, group, count. Both window bounds
   *  cross: a dropped `until` answers about a wider slice than was asked for, and
   *  nothing about the answer says so. */
  /** What one event set off (#1237) — the consumers it reached and what they emitted. */
  appEventEffects: (scopeId: string, eventId: string) =>
    call<EffectsTree>(
      `/apps/${encodeURIComponent(scopeId)}/effects?eventId=${encodeURIComponent(eventId)}`,
    ),

  /** Every delivery in one app that gave up (#1525), newest event first. */
  /** #1828: one app's refused permission checks, newest first; the next page is `until` the oldest held. */
  appDenials: (scopeId: string, opts: { until?: string; limit?: number } = {}) => {
    const q = new URLSearchParams();
    if (opts.until) q.set('until', opts.until);
    if (opts.limit !== undefined) q.set('limit', String(opts.limit));
    return call<{ entries: import('./audit-activity').Refusal[]; limit: number }>(
      `/apps/${encodeURIComponent(scopeId)}/denials${q.size ? `?${q}` : ''}`,
    );
  },
  appDeadLetters: (scopeId: string, cursor?: string) =>
    call<Page<DeadLetter>>(
      `/apps/${encodeURIComponent(scopeId)}/dead-letters${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`,
    ),

  /** Everything one call emitted (#1237), oldest first — siblings included. */
  appInvocationEvents: (scopeId: string, invocationId: string) =>
    call<InvocationEvents>(
      `/apps/${encodeURIComponent(scopeId)}/invocation?invocationId=${encodeURIComponent(invocationId)}`,
    ),

  /** Why one event exists (#1237) — its causal chain, newest first. */
  appEventCause: (scopeId: string, eventId: string) =>
    call<CauseChain>(
      `/apps/${encodeURIComponent(scopeId)}/cause?eventId=${encodeURIComponent(eventId)}`,
    ),

  appFacets: (
    scopeId: string,
    q: { groupBy?: string; field?: string; type?: string; since?: string; until?: string },
  ) =>
    call<EventFacetAnswer>(
      `/apps/${encodeURIComponent(scopeId)}/facets?${new URLSearchParams(
        Object.fromEntries(Object.entries(q).filter(([, v]) => v !== undefined && v !== '')) as Record<string, string>,
      )}`,
    ),

  appEntityHistory: (scopeId: string, entityType: string, entityId: string, cursor?: string) =>
    call<Page<HistoryEntry>>(
      `/apps/${encodeURIComponent(scopeId)}/history?entityType=${encodeURIComponent(entityType)}&entityId=${encodeURIComponent(entityId)}` +
        (cursor === undefined ? '' : `&cursor=${encodeURIComponent(cursor)}`),
    ),

  /** Every app's health, worst first (#1238) — the rollup, not a per-app read. */
  fleetHealth: () => call<{ rows: AppHealthRow[] }>('/fleet-health'),
  appMetrics: (teamId: string, hours = 24) => teamApi(teamId).appMetrics({ hours: String(hours) }),

  /** Field coverage for the running version (#1321) — declared vs returnable. */
  /** Declared-vs-observed findings (#1234) — what this app promises against what it has done. */
  appFlow: (scopeId: string) => call<FlowView>(`/apps/${encodeURIComponent(scopeId)}/flow`),

  /** One declared lifecycle replayed for the process map (#1744); the first declared one when `entity` is absent. */
  appProcesses: (scopeId: string, input: { entity?: string; period: ProcessPeriod }) => {
    const q = new URLSearchParams({ period: input.period });
    if (input.entity) q.set('entity', input.entity);
    return call<ProcessMapView>(`/apps/${encodeURIComponent(scopeId)}/processes?${q}`);
  },

  appFieldCoverage: (scopeId: string) =>
    call<FieldCoverageView>(`/apps/${encodeURIComponent(scopeId)}/field-coverage`),
  appFieldReads: (scopeId: string, hours: number) =>
    call<FieldReadsView>(`/apps/${encodeURIComponent(scopeId)}/field-reads?hours=${hours}`),

};

/**
 * Auth is a full-page redirect — the OIDC round-trip needs a real navigation.
 * `returnTo` is a same-origin path the callback returns to (e.g. an invite link);
 * `loginHint` prefills the email at the IdP; `screenHint` opens sign-up vs log-in.
 * Opening the dashboard as `/?idp=alt` signs in through the alternate issuer instead of
 * the default one (the server accepts that one value and ignores any other).
 */
export const signIn = (
  opts: { returnTo?: string; loginHint?: string; screenHint?: 'signup' | 'login' } = {},
) => {
  const p = new URLSearchParams();
  if (opts.returnTo) p.set('returnTo', opts.returnTo);
  if (opts.loginHint) p.set('login_hint', opts.loginHint);
  if (opts.screenHint) p.set('screen_hint', opts.screenHint);
  if (new URLSearchParams(window.location.search).get('idp') === 'alt') p.set('idp', 'alt');
  const qs = p.toString();
  window.location.href = `/api/auth/login${qs ? `?${qs}` : ''}`;
};
/** Connect GitHub to `teamId` — a full-page redirect to the App install flow (returns to /apps/new). */
export const connectGithub = async (teamId: string) => {
  window.location.href = (await teamApi(teamId).connectGithub()).url;
};
export const signOut = (opts: { returnTo?: string } = {}) => {
  const rt = typeof opts?.returnTo === 'string' ? opts.returnTo : undefined;
  // Always federated: signed-out visits redirect straight to the IdP, so a logout
  // that left the IdP's SSO cookie alive would silently sign the user right back in.
  window.location.href = `/api/auth/logout?federated${rt ? `&returnTo=${encodeURIComponent(rt)}` : ''}`;
};
