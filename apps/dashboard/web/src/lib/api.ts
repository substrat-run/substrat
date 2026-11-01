import { problemDetail } from '@substrat-run/contracts';
import { ApiError as GeneratedApiError, createClient, type AdminLogEntry, type AppDeployments, type AppEvent, type AppFailuresView, type AppHostnameRow, type AppMetricsView, type AppOverlays, type AppRow, type AppSchedulesView, type BoundScopeRow, type BusinessVolumesView, type ChannelHistoryRow, type ConnectorCallsView, type DashboardClient, type DeployFailureRow, type DeploymentRow, type DeploymentVersion, type DomainRow, type FailureGroupRow, type FieldCoverageView, type FieldReadsView, type FlowView, type InstallStep, type LineVolume, type LogPatterns, type Member, type MoveReviewRow, type ObservabilityRow, type PreviewCreated, type PreviewRow, type ProcessMapView as GeneratedProcessMapView, type ReleaseRow, type ReleasesView, type RequestFacets, type RequestVolume, type TeamTrafficSeries, type TenantMetricsRow, type TrafficSeries } from './api.generated';
import { ApiError as AccountApiError, createClient as createAccountClient, type AccountView as Me, type OnboardingView as Onboarding, type TeamSummary as Team } from './account-api.generated';
import { logsIncompleteOf } from '@substrat-run/control-plane-api/browser';
import { tenantLogsQuery } from './logs-query';
import type { LineReadQuery, RequestReadQuery } from './requests';
import type { CauseChain, DeadLetter, EffectsTree, InvocationEvents, EmittedModel, EventFacetResult, HistoryEntry, Page, PrincipalId, ScopeId, TenantId } from '@substrat-run/contracts';

// The shapes the declared Deployments routes answer (#2170) are the generated client's own.
export type { AppDeployments, AppEvent, AppFailuresView, AppHostnameRow, AppMetricsView, AppOverlays, AppRow, BoundScopeRow, BusinessVolumesView, ConnectorCallsView, DeployFailureRow, DeploymentVersion, DomainRow, FailureGroupRow, FieldCoverageView, FieldReadsView, FlowView, InstallStep, LineVolume, LogPatterns, Member, MoveReviewRow, ObservabilityRow, PreviewCreated, ReleaseRow, ReleasesView, RequestFacets, RequestVolume, TeamTrafficSeries, TenantMetricsRow, TrafficSeries };

// The observability reads' parts (#2170), named as the views always have: each is the generated view's own member.
export type AppMetricsRow = AppMetricsView['rows'][number];
export type FlowFindingsView = FlowView['findings'];
export type FlowFinding = FlowFindingsView['findings'][number];
export type FlowGraph = FlowView['graph'];
export type FlowNode = FlowGraph['nodes'][number];
export type FlowEdge = FlowGraph['edges'][number];
export type OperationHealthView = FlowView['operations'];
export type OperationHealthRow = OperationHealthView['rows'][number];
export type RefusalWindow = NonNullable<OperationHealthView['refusals']>;
export type ConnectionSweepView = FlowView['connectionSweep'];
export type ConnectionSweepRow = ConnectionSweepView['rows'][number];
export type EntityCoverage = FieldCoverageView['entities'][number];
export type FieldCoverageRow = EntityCoverage['fields'][number];
export type ConnectorCallsBucket = ConnectorCallsView['buckets'][number];
export type BusinessVolumeRow = BusinessVolumesView['rows'][number];
export type OverlayMarker = AppOverlays['markers'][number];
export type OverlaySpan = AppOverlays['spans'][number];
export type AppFailure = AppFailuresView['entries'][number];
export type TeamTrafficLine = TeamTrafficSeries['series'][number];
export type RequestVolumeBucket = RequestVolume['buckets'][number];
export type LogPattern = LogPatterns['patterns'][number];
export type AuditEntry = AdminLogEntry;
export type ChannelHistoryEntry = ChannelHistoryRow;
export type VerticalPreview = PreviewRow;

// A route's answer, named by the generated client method that returns it: the views below are the wire's own, not copies.
type Out<K extends keyof DashboardClient> = Awaited<ReturnType<DashboardClient[K]>>;

/**
 * Client for the Dashboard worker's own API (apps/dashboard/src/worker.ts).
 *
 * The worker serves everything under `/api`: `/api/me` (who am I — and, on first
 * call, bootstraps my tenant), and the team-scoped surface under `/api/teams/:teamId` (`teamApi`). Auth is an OIDC
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

/** A team-grain observability read's query: which apps (none = every app), and the window. */
const obsWindow = (q: { scopeIds?: string[]; hours?: number; since?: string; until?: string }) => ({
  scopeId: q.scopeIds,
  hours: q.hours === undefined ? undefined : String(q.hours),
  since: q.since,
  until: q.until,
});

const pageQs = (opts?: PageOpts): string => {
  const q = new URLSearchParams();
  if (opts?.limit != null) q.set('limit', String(opts.limit));
  if (opts?.cursor) q.set('cursor', opts.cursor);
  const s = q.toString();
  return s ? `?${s}` : '';
};

/** The `/api/me` shapes (#2170): the generated account client's own. */
export type { Me, Onboarding, Team };

/** The `/api/me` result: either a resolved account, or a teamless login to onboard. */
export type MeResult = Me | Onboarding;

/** Narrow a `MeResult` to the teamless onboarding state. */
export function needsOnboarding(m: MeResult): m is Onboarding {
  return (m as Onboarding).needsOnboarding === true;
}

/** One row of the New-app picker, read from the team's declared catalog route. */
export type { CatalogEntry } from './api.generated';

/** The role a new member can be invited at (owner is the un-invitable first member). */
export type InviteRole = 'admin' | 'member' | 'viewer';

/** The install form's Identity choice — which issuer the new app authenticates against.
 *  Absent ⇒ the vertical's builtin auth. `auth-server` names one of the team's own Auth
 *  Server apps (the client is registered there automatically); `external` is any OIDC
 *  issuer the user configured by hand. */
export type AppAuthChoice =
  | { source: 'auth-server'; scopeId: string }
  | { source: 'external'; issuer: string; clientId: string; clientSecret?: string; audience?: string };

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
export type MigrationBookmark = Out<'listAppBookmarks'>[number];

export type Deployment = DeploymentRow;






/**
 * One app's schema history with its availability (#1236). `available: false` is a
 * fact about the read — a deployment that does not serve the endpoint, or a plane
 * fault — while `migrations: []` with `available: true` is a fact about the app:
 * it genuinely has none, which a module registering `migrations: []` produces.
 */
export type AppMigrationsView = Out<'listAppMigrations'>;
/** One migration as an app actually applied it (#1236) — its schema history. */
export type AppliedMigration = AppMigrationsView['migrations'][number];

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
 *
 * The route publishes the three documents as `unknown` (the plane owns them); this narrows
 * them to the contract's shapes, which is the one place the screen trusts them.
 */
export type ProcessMapView = Omit<GeneratedProcessMapView, 'lifecycle' | 'current' | 'previous'> & {
  /** The machine the counts were replayed against — what the map lays out. */
  lifecycle: import('@substrat-run/contracts').EmittedLifecycle | null;
  current: import('@substrat-run/contracts').LifecycleFlowResult | null;
  previous: import('@substrat-run/contracts').LifecycleFlowResult | null;
};

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
export type EventFacetAnswer = Omit<EventFacetResult, 'withheldPersonal' | 'withheldReason'> & { withheldPersonal?: number; withheldReason?: string };

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

/** A deploy moment drawn on the chart (#1236) — a registry fact, not telemetry. */
export interface ReleaseMarker {
  at: string;
  kind: 'pushed' | 'went-live';
  version: string;
  versionId: string;
}

export type ReleaseComparison = Out<'getAppReleaseComparison'>;
/** One side of the running-vs-update comparison (#1236). Nulls = metrics unavailable. */
export type ReleaseSide = NonNullable<ReleaseComparison['running']>;

export type BoundScopesView = Out<'listBoundScopes'>;
export type MoveScopesResult = Out<'moveScopes'>;
export type RetireScopesResult = Out<'retireScopes'>;

/** The result of updating an app to its vertical's prod version. */
export type UpdateResult = Out<'updateInstalledApp'>;

/** One snapshot (test copy) of an app's data — a fork's directory row. */
export type SnapshotRow = Out<'listAppSnapshots'>[number];

/** An app's data as a dump the CLI also accepts. */
export type AppDataDump = Out<'exportInstalledApp'>;
export type DumpTable = AppDataDump['tables'][number];
export type DumpStore = NonNullable<AppDataDump['stores']>[number];

/** What an import did, including the fork to back out to. */
export type RestoreResult = Out<'restoreInstalledApp'>;

/** `GET /api/teams/:teamId/github/repos` — the Git-import card's live state. */
export type GitReposResult = Out<'listGithubRepos'>;
/** One importable repo the tenant's GitHub connection can see. */
export type GitRepo = GitReposResult['repos'][number];

/** `GET /api/teams/:teamId/github/workflow-preview` — the manual path's copy-paste workflow. */
export type WorkflowPreview = Out<'githubWorkflowPreview'>;

/** One table in an app's database — the Data tab's left list. */
export type ScopeTable = Out<'listAppTables'>[number];
/** One scope an app spans — the Data tab's scope switcher (a multi-scope vertical has several). */
export type AppScope = Out<'appScopes'>[number];
/** A bounded page of one table. Rows are positional, aligned to `columns`. */
export type ScopeTablePage = Out<'readAppTable'>;
/** A read-only console query's result. `truncated` = row cap hit. */
export type ScopeQueryResult = Out<'queryAppScope'>;

/** The app's Env tab: the declared spec (placeholder + description), the stored values, and the model catalogue. */
export type AppEnvView = Out<'getAppEnv'>;
/** A declared env var for a vertical — drives the Env form. */
export type EnvVarSpec = AppEnvView['spec'][number];
/** One stored env var — a secret's value is never sent back (write-only). */
export type AppEnvValue = AppEnvView['values'][number];
export type ModelCatalogOption = AppEnvView['modelCatalog'][number];

/** The app's owner seat (#925) as the platform relays it from the app's own identity directory. */
export type OwnerSeatView = Out<'appOwnerSeat'>;

/** A freshly minted owner-claim link — shown once, stored nowhere. */
export type OwnerClaimLinkView = Out<'appOwnerClaim'>;

/** An installed app's members (#1150), as the platform relays them from the app's own deployment. */
export type AppMembersView = Out<'appMembers'>;

/**
 * What every member change answers beside its result (#2064). `auditWarning` means the change
 * WENT THROUGH but the platform could not write its admin-log outcome: show it as a warning on a
 * success, never as an error to retry.
 */
export type AuditedAnswerView = Pick<Out<'appInviteMember'>, 'operationId' | 'auditWarning'>;

/** A freshly minted member invite — shown once, stored nowhere. */
export type MemberInviteView = Out<'appInviteMember'>;

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
  /** #2343: the connection sends mail as the tenant, so its detail offers a send test. */
  sendsMail: boolean;
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
  /** See {@link AppIntegration.sendsMail}. */
  sendsMail?: boolean;
  connections: Array<
    ConnectionView & {
      vertical: string;
      apps: Array<{ scopeId: string; name: string }>;
      /** #1232: the last day's sweep outcomes, newest first — the recent-runs strip. A connector
       *  sweep has no freshness evidence, so these rows carry no `observedAt`. */
      sweepRuns: Omit<SweepRunView, 'observedAt'>[];
    }
  >;
  connectTargets: Array<{ scopeId: string; name: string; vertical: string; connected: boolean }>;
}

/** One outstanding consent-round link (#1220) — single-use, revocable, expiring. */
export interface ConnectLinkView {
  id: string;
  provider: string;
  appScopeId: string;
  /** outstanding · used · revoked; the plane owns an app-minted link's status, so it stays open. */
  status: string;
  createdBy: string;
  createdAt: string;
  expiresAt: string;
  /** Present on the mint response only — the URL is never listed back. */
  url?: string;
  /** On the list: minted here (`dashboard`) or by the app itself and mailed from it (`app`). */
  source?: 'dashboard' | 'app';
}

/** `GET /api/teams/:teamId/integrations` */
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
  /** #2343: every address a send test may go from, whole; empty or absent for a provider that sends no mail. */
  mailSenders?: string[];
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
export type AppScheduleRow = NonNullable<AppSchedulesView['schedules']>[number];

/**
 * One peer target this app declares it calls (#1706), resolved against what the tenant runs
 * and against the switch in the TARGET's scope. Mirrors `apps/dashboard/src/peers.ts` —
 * `not-installed` is an ordinary answer, never a fault, and `unreadable` is never folded
 * into `allowed`.
 */
export type DeclaredCallRow = AppPeersView['calls'][number];

/** Both directions of the peer disclosure for one app (#1706). */
export type AppPeersView = Out<'appPeers'>;

/** Where one of the tenant's other apps stands at THIS app's door. */
export type PeerCallerRow = NonNullable<AppPeersView['callers']>[number];

export type { AppSchedulesView };

/** One sweep outcome for a connection (#1232) — what the recent-runs strip renders. */
export type SweepRunView = NonNullable<AppSchedulesView['schedules']>[number]['runs'][number];

/** One declared freshness expectation's verdict on an app (#1272) — rendered verbatim. */
export type AppFreshnessRow = NonNullable<AppSchedulesView['freshness']>[number];

/** `GET /api/teams/:teamId/apps/:scope/hostnames` — bindings + declared surfaces + the untouchable default. */
export type AppHostnamesView = Out<'listAppHostnames'>;
/** A surface the app's vertical declares it serves — the Domains tab's picker. */
export type DeclaredSurface = AppHostnamesView['surfaces'][number];

/** The stored identity choice; `auth: null` means the vertical's builtin sign-in. The clientSecret is write-only, never echoed. */
export type AppAuthView = Out<'getAppAuth'>;
export type AppAuthRecord = NonNullable<AppAuthView['auth']>;

/** The save result; `delivered` says whether the running app got it. */
export type AppAuthUpdateResult = Out<'setAppAuth'>;

/** A DNS record the tenant must publish for a custom domain (§4.7). `type` is the plane's: known are hostname and txt; a newer plane may name another (#2401). */
export type DnsRecord = NonNullable<Out<'addDomain'>['validationRecords']>[number];

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

/** The handwritten client and the two declared clients (team, account) report separate error classes. */
export const isApiError = (error: unknown): error is ApiError | GeneratedApiError | AccountApiError =>
  error instanceof ApiError || error instanceof GeneratedApiError || error instanceof AccountApiError;

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
 * `/api/teams/<teamId>/…`, so the request names its team in its own URL. The `sb_team`
 * cookie, which every tab shares, is no longer what a request acts on. The hand-written
 * helper below (`call`) reaches only the invite preview; the other team-less routes are
 * `accountApi`'s.
 *
 * Build it from the team the TAB is on (`me.currentTeamId`, pinned by the URL), never
 * once at module load.
 */
const teamClients = new Map<string, DashboardClient>();

export function teamApi(teamId: string): DashboardClient {
  const cached = teamClients.get(teamId);
  if (cached) return cached;
  const client = createClient({
    baseUrl: `/api/teams/${encodeURIComponent(teamId)}`,
    fetch: (input, init) => fetch(input, { credentials: 'include', ...init }),
    // The one reading of a failed body (#971), same as `call`.
    errorMessage: (body) => problemDetail(body),
  });
  teamClients.set(teamId, client);
  return client;
}

/**
 * The declared team-less routes (#2170) under `/api`: who am I, create, switch, accept, the
 * support claim, and the two that run before sign-in (the invite preview, the public catalog).
 */
const accountApi = createAccountClient({
  fetch: (input, init) => fetch(input, { credentials: 'include', ...init }),
  errorMessage: (body) => problemDetail(body),
});

/** One recent log event from a team vertical's deployed service. */
/** #1746: one request, as its stamped invocation line recorded it. `null` = not recorded. */
import type { RequestRecord } from './request-detail';
export type { RequestRecord };

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

/** #2762: plus the Lines facets, each a list of alternatives sent once per value. */
export type AppTenantLogsQuery = Parameters<typeof tenantLogsQuery>[0] & { operation?: string[]; principalKind?: string[] };

async function appTenantLogsRead(
  teamId: string,
  scopeId: string,
  { operation, principalKind, ...q }: AppTenantLogsQuery,
): Promise<{ events: ObservabilityLogEvent[]; incomplete: boolean }> {
  const { body, headers } = await teamApi(teamId).appObservabilityLogs({
    scopeId,
    ...Object.fromEntries(tenantLogsQuery(q)),
    ...(operation?.length ? { operation } : {}),
    ...(principalKind?.length ? { principalKind } : {}),
  });
  return { events: body, incomplete: logsIncompleteOf(headers) };
}

async function observabilityLogsRead(
  teamId: string,
  q: ObservabilityLogsQuery,
): Promise<{ events: ObservabilityLogEvent[]; incomplete: boolean }> {
  const { body, headers } = await teamApi(teamId).observabilityLogs({
    service: q.services,
    level: q.level || undefined,
    search: q.search || undefined,
    hours: q.hours ? String(q.hours) : undefined,
    limit: q.limit ? String(q.limit) : undefined,
  });
  return { events: body, incomplete: logsIncompleteOf(headers) };
}

export const api = {
  /** `null` when there is no session (the worker answers 401); onboarding when teamless. */
  me: async (): Promise<MeResult | null> => {
    try {
      return await accountApi.me();
    } catch (e) {
      if (isApiError(e) && e.status === 401) return null;
      throw e;
    }
  },
  /** Create a team (first team or another); the server switches to it, so reload after. */
  createTeam: (name: string) => accountApi.createTeam({ name }),
  /** Switch the active team; the server pins it in a cookie, so the caller reloads after. */
  switchTeam: (teamId: string) => accountApi.switchTeam({ teamId }),
  /** Preview an invite (unauthenticated): the team + invited email, for prefill + the accept screen. */
  previewInvite: (token: string) => accountApi.previewTeamInvite({ token }),
  /** Accept an invite token; the server switches to the team, so the caller reloads after. */
  acceptInvite: (token: string) => accountApi.acceptTeamInvite({ token }),
  /** One page of the TEAM's control-plane audit log (#1447) — every app, newest first.
   *  `scopeId` narrows it to one app; without it the page is the tenant's whole log,
   *  which is the only way to see the entries that name no scope at all. */
  auditLogAll: (teamId: string, opts?: PageOpts & { scopeId?: string }): Promise<ListPage<AuditEntry>> =>
    teamApi(teamId).listTeamAudit({ limit: opts?.limit, cursor: opts?.cursor, scopeId: opts?.scopeId || undefined }),
  /** The app's vertical version registry (one page of versions, newest first) + channels +
   *  the version THIS scope actually runs (`boundVersionId`). `cursor` walks older versions. */
  // The registry, model and asset documents are carried as the plane answered them, so the
  // generated client types them `unknown`; these views are what the plane answers.
  appDeployments: (teamId: string, scopeId: string, opts?: PageOpts): Promise<AppDeployments> =>
    teamApi(teamId).getAppDeployments({ scopeId, ...opts }),
  /** The static files ONE version ships (#340), from its retained deploy manifest —
   *  `assets: null` when it retained none or shipped no static files. */
  appVersionAssets: (teamId: string, scopeId: string, versionId: string) =>
    teamApi(teamId).getAppVersionAssets({ scopeId, versionId }).then((r) => r.assets as DeployAssets | null),
  /** The declared permission surface (D-39, #336) of the version this app runs, plus the
   *  update target's, for the Permissions tab's table + update diff. */
  appPermissions: (teamId: string, scopeId: string) => teamApi(teamId).getAppPermissions({ scopeId }) as Promise<AppPermissionsView>,
  appModel: (teamId: string, scopeId: string) => teamApi(teamId).getAppModel({ scopeId }) as Promise<AppModelView>,
  /** Schedule health for the app's running version (#1232) — null schedules hides the panel. */
  // The route declares a sweep row as loosely as the plane writes it; this is the shape it writes.
  appSchedules: (teamId: string, scopeId: string) => teamApi(teamId).getAppSchedules({ scopeId }) as Promise<AppSchedulesView>,
  /** Data reads use the selected tab's team through the generated client. */
  appTables: (teamId: string, scopeId: string) => teamApi(teamId).listAppTables({ scopeId }),
  appTableRows: (teamId: string, scopeId: string, table: string, opts: { limit?: number; offset?: number } = {}) =>
    teamApi(teamId).readAppTable({ scopeId, table, ...opts }),
  appQuery: (teamId: string, scopeId: string, sql: string) => teamApi(teamId).queryAppScope({ scopeId, sql }),
  /** The account-level integrations overview: all providers, connections, and connectable apps.
   *  The route declares a connection's plane-owned `status` as a string; only that field is cast. */
  integrations: async (teamId: string): Promise<AccountIntegrationsView> => {
    const { providers } = await teamApi(teamId).listTeamIntegrations();
    return {
      providers: providers.map((p) => ({
        ...p,
        connections: p.connections.map((c) => ({ ...c, status: c.status as ConnectionView['status'] })),
      })),
    };
  },
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
    teamApi(teamId).tenantMetricsSeries(obsWindow(q)),
  /**
   * The same read, shaped for the team Observability chart (#1447): one zero-filled
   * series per app, every scope asked for present whether it served or not. No
   * `scopeIds` means every app this team has installed — resolved by the worker.
   */
  teamTraffic: (teamId: string, q: { scopeIds?: string[]; hours?: number; since?: string; until?: string } = {}) =>
    teamApi(teamId).teamTraffic(obsWindow(q)),
  connectorCalls: (teamId: string, q: { hours?: number; since?: string; until?: string } = {}) =>
    teamApi(teamId).connectorCalls({ hours: q.hours === undefined ? undefined : String(q.hours), since: q.since, until: q.until }),
  businessVolumes: (teamId: string, q: { scopeIds?: string[]; hours?: number; since?: string; until?: string } = {}) =>
    teamApi(teamId).businessVolumes(obsWindow(q)),
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
  appRequestVolume: (teamId: string, scopeId: string, query: RequestReadQuery): Promise<RequestVolume> =>
    teamApi(teamId).appRequestVolume({ scopeId, ...query }),
  appRequestFacets: (teamId: string, scopeId: string, query: RequestReadQuery): Promise<RequestFacets> =>
    teamApi(teamId).appRequestFacets({ scopeId, ...query }),
  /** #2762: one app's Lines histogram and facet counts — its request lines and ctx.log lines. */
  appLogVolume: (teamId: string, scopeId: string, query: LineReadQuery): Promise<LineVolume> =>
    teamApi(teamId).appLogVolume({ scopeId, ...query }),
  appLogFacets: (teamId: string, scopeId: string, query: LineReadQuery): Promise<RequestFacets> =>
    teamApi(teamId).appLogFacets({ scopeId, ...query }),
  /** #2762: the versions that went live for one app inside a window — the request histogram's
   *  deploy marks. The traffic read is the one that already answers them. */
  appGoLives: (teamId: string, scopeId: string, window: { since: string; until: string }): Promise<ReleaseMarker[]> =>
    teamApi(teamId)
      .getAppTraffic({ scopeId, ...window })
      .then((t) => t.markers.filter((m) => m.kind === 'went-live')),
  /** #1747: one app's `ctx.log` lines grouped by template. */
  appLogPatterns: (teamId: string, scopeId: string, query: Omit<Parameters<DashboardClient['appLogPatterns']>[0], 'scopeId'>): Promise<LogPatterns> =>
    teamApi(teamId).appLogPatterns({ scopeId, ...query }),
  appRequests: (teamId: string, scopeId: string, query: RequestReadQuery): Promise<RequestRecord[]> =>
    teamApi(teamId).appRequests({ scopeId, ...query }),
  /** The manual path's workflow YAML (same generator the one-click commit uses). */
  workflowPreview: (teamId: string, repo: string, branch: string, path?: string): Promise<WorkflowPreview> =>
    teamApi(teamId).githubWorkflowPreview({ repo, branch, path }),
  /**
   * One record's event history (#1235) — payload, authorization chain, impersonation, PII class.
   *
   * Cursor-paged, and the caller must walk it: the outbox is read `ORDER BY id ASC`
   * a page at a time, so dropping `nextCursor` would show a long-lived record's
   * OLDEST events and silently hide everything since.
   */
  appEntityHistory: (teamId: string, scopeId: string, entityType: string, entityId: string, cursor?: string) =>
    teamApi(teamId).readAppHistory({ scopeId, entityType, entityId, cursor }) as Promise<Page<HistoryEntry>>,
  /** Facets over an app's events (#1239), with both window bounds. */
  appFacets: (teamId: string, scopeId: string, q: { groupBy?: string; field?: string; type?: string; since?: string; until?: string }) =>
    teamApi(teamId).facetAppEvents({ scopeId, ...q }) as Promise<EventFacetAnswer>,
  appEventCause: (teamId: string, scopeId: string, eventId: string) =>
    teamApi(teamId).readAppCause({ scopeId, eventId }) as Promise<CauseChain>,
  appEventEffects: (teamId: string, scopeId: string, eventId: string) =>
    teamApi(teamId).readAppEffects({ scopeId, eventId }) as Promise<EffectsTree>,
  appInvocationEvents: (teamId: string, scopeId: string, invocationId: string) =>
    teamApi(teamId).readAppInvocation({ scopeId, invocationId }) as Promise<InvocationEvents>,
  appDenials: (teamId: string, scopeId: string, opts: { until?: string; limit?: number } = {}) =>
    teamApi(teamId).listAppDenials({ scopeId, ...opts }),
  appDeadLetters: (teamId: string, scopeId: string, cursor?: string) =>
    teamApi(teamId).listAppDeadLetters({ scopeId, cursor }) as Promise<Page<DeadLetter>>,

  /** Every app's health, worst first (#1238) — the rollup, not a per-app read. */
  fleetHealth: (teamId: string): Promise<{ rows: AppHealthRow[] }> => teamApi(teamId).fleetHealth(),
  appMetrics: (teamId: string, hours = 24) => teamApi(teamId).appMetrics({ hours: String(hours) }),

  /** One declared lifecycle replayed for the process map (#1744); the first declared one when `entity` is absent. */
  appProcesses: (teamId: string, scopeId: string, input: { entity?: string; period: ProcessPeriod }) =>
    teamApi(teamId).getAppProcessMap({ scopeId, ...input }) as Promise<ProcessMapView>,
};

/**
 * Auth is a full-page redirect — the OIDC round-trip needs a real navigation.
 * `returnTo` is a same-origin path the callback returns to (e.g. an invite link);
 * `loginHint` prefills the email at the IdP; `screenHint` opens sign-up vs log-in.
 * Opening the dashboard as `/?idp=alt` signs in through the alternate issuer instead of
 * the default one (the server accepts that one value and ignores any other).
 */
export const signIn = (
  opts: { returnTo?: string; loginHint?: string; screenHint?: 'signup' | 'login'; prompt?: 'login' } = {},
) => {
  const p = new URLSearchParams();
  if (opts.returnTo) p.set('returnTo', opts.returnTo);
  if (opts.loginHint) p.set('login_hint', opts.loginHint);
  if (opts.screenHint) p.set('screen_hint', opts.screenHint);
  if (opts.prompt) p.set('prompt', opts.prompt);
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
