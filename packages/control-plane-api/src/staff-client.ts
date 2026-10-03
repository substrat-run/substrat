import { capabilityQuery, denialQuery } from '@substrat-run/contracts';
import type {
  AdminAction,
  AdminLogEntry,
  ChannelName,
  ConnectionHealthPage,
  ConnectionHealthState,
  CapabilityFilter,
  CapabilityPage,
  DenialFilter,
  DenialSummary,
  DirectoryBackup,
  EdgeHealthReport,
  EntitlementGrant,
  EntitlementGrantInput,
  ExportBreak,
  HostnameBinding,
  HostnameStatus,
  ImportCursorMove,
  ImportCursorMoved,
  IssueEntry,
  IssueStatus,
  IssueStatusInput,
  MeterReading,
  MigrationDiff,
  MigrationProgress,
  ModelUsageSummary,
  ModuleId,
  OpsFailureEntry,
  Page,
  PeerGrantsStatusEntry,
  PeerSwitchResult,
  PermissionDenial,
  PermissionRegistry,
  PlatformRequestBacklog,
  PromotionAcknowledgement,
  Scope,
  ScopeBackup,
  ScopeId,
  ScopeStatus,
  StorageMeterReading,
  SweepRunEntry,
  SweepRunKind,
  SystemGrantsStatusEntry,
  SystemSwitchRecord,
  SystemSwitchResult,
  Tenant,
  TenantId,
  TenantRole,
  TenantStatus,
  Vertical,
  VerticalChannel,
  VerticalSource,
  VerticalVersion,
} from '@substrat-run/contracts';
import type { BlobStoreRecord, TenantStoreRecord } from '@substrat-run/kernel';

import type { ClientProvisionScopeInput } from './client.js';
import type { DoNamespaceRecord } from './do-namespaces.js';
import type { ConnectorCallsBucket } from './observability.js';
import type { PlatformRuntime } from './platform-runtime.js';
import { ControlPlaneTransport } from './transport.js';

/**
 * The staff surface of the control-plane API as one typed client — what the console
 * calls (#971). Where `ControlPlaneClient` is the vertical's connect seam (register a
 * tenant, gate on the lifecycle), this is the whole operator vocabulary: tenants, scopes,
 * the fleet reads, the vertical + version registry, the audit and failure logs.
 *
 * It shares everything about HOW a request is made with `ControlPlaneClient` — one
 * transport, one error (`ControlPlaneError`), one reading of a problem document. The two
 * are siblings rather than parent and child on purpose: they overlap in name (`getTenant`
 * answers `undefined` on a 404 in the connect seam, which gates on absence, and throws
 * here, where a missing tenant is a page-level failure) and a subclass would have made the
 * connect seam's gate dispatch to the staff reading.
 *
 * Every method is an arrow-function property, not a prototype method, deliberately: the
 * console hands them around unbound (`{ suspend: api.suspendScope }`), as it always has,
 * and a prototype method would lose its `this` there.
 *
 * Answers are typed, not parsed — the same trust the console's hand-rolled client had.
 */

/** One service's invocation aggregates — the control plane's observability proxy
 *  (provider-neutral seam; Cloudflare analytics is the current backend). */
export interface ServiceMetricsRow {
  service: string;
  /** Set for pushed verticals (the platform's dispatch pool), null for platform services. */
  namespace: string | null;
  requests: number;
  errors: number;
  subrequests: number;
  /** Per-request CPU time quantiles, microseconds. */
  cpuTimeP50: number;
  cpuTimeP99: number;
}

/** One log event from the control plane's observability proxy. */
export interface RecentLogEvent {
  timestamp: number | null;
  level: string | null;
  message: string | null;
  service: string | null;
  outcome: string | null;
  raw: unknown;
}

/**
 * One destination a deployed version was OBSERVED reaching (#859, D-46), joined with
 * whether its manifest DECLARED it.
 */
export interface ObservedEgressRow {
  service: string;
  host: string;
  /** `durable-object` egress is the half the egress worker cannot intercept (D-46). */
  origin: 'worker' | 'durable-object' | 'unknown';
  calls: number;
  lastSeen: number | null;
  sampleUrl: string | null;
  /** The version's declared surface; null = pushed before the declaration existed. */
  declared: string[] | null;
  /** Reached a host the declaration does not cover. Always false when `unenforced`. */
  undeclared: boolean;
  /** The version declares nothing, so the egress worker meters but does not enforce. */
  unenforced: boolean;
}

export interface EgressReport {
  rows: ObservedEgressRow[];
  byService: {
    service: string;
    versionId: string;
    version: string;
    declared: string[] | null;
    /** Declared but never seen in the window. Not a fault — a quiet window proves nothing. */
    unused: string[];
  }[];
  /** The read was capped, so the host set is a FLOOR. Must be said out loud (#859). */
  truncated: boolean;
  servicesTruncated: boolean;
  versionsConsidered: number;
  versionsTotal: number;
  /** Head sampling rate, or null for "coverage unknown" — not the same as 1. */
  samplingRate: number | null;
  hours: number;
}

/** A staff roster row (CP `staff_actor`) — who may act on the control plane. */
export interface StaffMember {
  email: string;
  /** Their identity in the admin log; null when the stored value is malformed. */
  actor: string | null;
  name: string | null;
  addedAt: string;
  /** Who granted it — null for rows that predate the Members surface. */
  addedBy: string | null;
  revokedAt: string | null;
}

export interface MembersReading {
  staff: StaffMember[];
}

/** The tenant's platform-minted stores, as the console reads them (#301, #473). */
export interface TenantStores {
  tenantStores: TenantStoreRecord[];
  blobStores: BlobStoreRecord[];
}

/**
 * The ONE pagination convention (contracts pagination.ts): every list route takes
 * `?limit&cursor&order` (limit defaults 20, max 200 at the egress) and answers
 * `{ entries, nextCursor }`. The admin log shipped this shape first; every list
 * call below now speaks it, so a view walks any list the way AdminLog always has.
 */
export interface PageQuery {
  limit?: number;
  cursor?: string;
  order?: 'asc' | 'desc';
}

/** The admin-log page — now just the shared envelope (kept as the historical name). */
export type AdminLogPage = Page<AdminLogEntry>;

export interface AuditLogQuery extends PageQuery {
  tenantId?: TenantId;
  scopeId?: ScopeId;
  actor?: string;
  action?: AdminAction[];
  since?: string;
  until?: string;
}

/** The sweep-record filter (#1232) — mirrors SweepRunFilter, minus the cursor triple PageQuery carries. */
export interface SweepRunsQuery extends PageQuery {
  kind?: SweepRunKind;
  unit?: string;
  outcome?: 'ok' | 'failed' | 'skipped';
  tenantId?: TenantId;
  scopeId?: ScopeId;
  vertical?: string;
  connectionId?: string;
  since?: string;
  until?: string;
}

/**
 * `GET /connections/health` (#1690) — `status` is the DERIVED health state. No `order`:
 * the walk is ascending by connection id only, and the route refuses `desc`.
 */
export interface ConnectionHealthQuery extends Omit<PageQuery, 'order'> {
  status?: ConnectionHealthState;
  /** Free text, matched server-side before paging — so it finds rows on any page. */
  q?: string;
  provider?: string;
  tenantId?: TenantId;
}

/** The ops-failure list's server-side narrowing (#559) — `reference` is an exact
 *  match, the `reference = <id>` a CI log hands the operator. */
export interface OpsFailuresQuery extends PageQuery {
  tenantId?: TenantId;
  scopeId?: ScopeId;
  vertical?: string;
  operation?: string;
  /** The taxonomy code — the error-shape narrowing (#1233). */
  code?: string;
  /** One issue's exemplar rows (#1233) — the jump from Operations → Issues. */
  fingerprint?: string;
  reference?: string;
  since?: string;
  until?: string;
}

/** `GET /system-switches` (#1674) — the fleet read of the schedule kill switch. */
export interface SystemSwitchesQuery extends PageQuery {
  position?: 'on' | 'off' | 'all';
  tenantId?: TenantId;
  scopeId?: ScopeId;
  moduleId?: ModuleId;
  vertical?: string;
}

/** The issues read (#1233). No cursor by design — grouping IS the compression. */
export interface IssuesQuery {
  status?: IssueStatus;
  operation?: string;
  code?: string;
  limit?: number;
}

export type { ConnectorCallsBucket, PlatformRuntime };
/** One Durable Object namespace as Cloudflare describes it. */
export type DoNamespace = DoNamespaceRecord;

/** A scope's health, as `GET …/scopes/:id/health` answers it (#321, #825). */
export interface ScopeHealth {
  scopeId: ScopeId;
  status: string;
  servingRef: string | null;
  roleCount: number | null;
  roleProjectionEmpty: boolean;
  missingStores?: { binding: string; kind: 'relational' | 'blob' }[];
}

/** What the connect seam provisions, plus the storage shape the console picks. */
export interface ProvisionScopeInput extends ClientProvisionScopeInput {
  storageShape?: 'A' | 'B';
}

export interface RebindScopeResult {
  servingRef: string;
  versionId: string;
  alreadyBound?: boolean;
  tables?: number;
}

export interface BindHostnameInput {
  hostname: string;
  tenantId: TenantId;
  scopeId: ScopeId;
  surface: string;
  region?: 'eu' | null;
  canonical?: boolean;
}

/** Repeatable params (status, action) are appended once per value — the API reads them
 *  with `c.req.queries()`. `undefined` is dropped. */
function query(params: Record<string, string | string[] | number | undefined>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined) continue;
    if (Array.isArray(v)) for (const one of v) q.append(k, one);
    else q.append(k, String(v));
  }
  const s = q.toString();
  return s ? `?${s}` : '';
}

const seg = encodeURIComponent;

export class ControlPlaneStaffClient extends ControlPlaneTransport {
  private json<T>(method: string, path: string, body?: unknown): Promise<T> {
    return this.call(path, {
      method,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }
  private post = <T>(path: string, body?: unknown): Promise<T> => this.json('POST', path, body);

  // -- tenants ---------------------------------------------------------------

  listTenants = (page: PageQuery = {}): Promise<Page<Tenant>> => this.call(`/tenants${query({ ...page })}`);
  getTenant = (id: TenantId): Promise<Tenant> => this.call(`/tenants/${id}`);
  createTenant = (input: { id: TenantId; slug: string; name: string }): Promise<Tenant> =>
    this.post('/tenants', input);
  setTenantStatus = (id: TenantId, status: TenantStatus): Promise<Tenant> =>
    this.json('PATCH', `/tenants/${id}/status`, { status });
  // Reap a deleting tenant NOW (§4.8) — skips the grace window: every scope reaped,
  // PII/config directory rows cleared, the tenant row kept as a `reaped` tombstone.
  reapTenant = (id: TenantId): Promise<Tenant> => this.post(`/tenants/${id}/reap`);

  // The per-tenant store ledgers as inventory (#301 D1, #473 R2): which database and
  // which bucket hold this tenant's bytes. Read-only — stores are minted by
  // provisioning, never from here.
  tenantStores = (id: TenantId): Promise<TenantStores> => this.call(`/tenants/${id}/stores`);

  listEntitlements = (id: TenantId): Promise<EntitlementGrant[]> => this.call(`/tenants/${id}/entitlements`);
  // The key rides in the PATH, so it is encoded (#691). `entitlementGrant` accepts any
  // non-empty string — looser than the manifest's `/^[a-z0-9-]+$/` — precisely so a
  // legacy grant like `t-0wv2mwk4j5/crm-eff` round-trips. Unencoded, its slash forked the
  // route and the console could neither grant nor REVOKE the very rows that needed
  // cleaning up, which is what forced the hand-curl.
  grantEntitlement = (id: TenantId, key: string, plan?: EntitlementGrantInput): Promise<EntitlementGrant[]> =>
    this.json('PUT', `/tenants/${id}/entitlements/${seg(key)}`, plan);
  revokeEntitlement = (id: TenantId, key: string): Promise<EntitlementGrant[]> =>
    this.json('DELETE', `/tenants/${id}/entitlements/${seg(key)}`);

  // -- platform --------------------------------------------------------------

  // Where the platform's compute and stores live — the account + dispatch namespace the
  // refs this console renders resolve in, so a scope's script or a tenant's database can
  // be a LINK into the Cloudflare dashboard rather than an id to search for. Answers
  // null on a control plane with no runtime configured (self-host): the views then show
  // the same identifiers, unlinked.
  platformRuntime = (): Promise<PlatformRuntime | null> => this.call('/platform/runtime');
  // The Durable Object namespaces one script defines, scope-class first — the ids the
  // dashboard addresses a namespace by. 501s when the control plane has no lookup
  // configured, which callers treat as "link to the list instead".
  doNamespaces = (script: string): Promise<DoNamespace[]> =>
    this.call(`/platform/do-namespaces${query({ script })}`);

  // §5's meters 1 and 2 (#38) — tenants + effective-active scopes, and the entitlement
  // store grouped by SKU and tier. Computed platform-side because the billable rule
  // (a scope is billable only if its tenant is active; expiry decided at `readAt`)
  // belongs to one definition, not to whichever surface renders it. Omit `tenantId`
  // for the fleet reading.
  readMeters = (tenantId?: TenantId): Promise<MeterReading> => this.call(`/meters${query({ tenantId })}`);
  // Storage (#1524): one PAGE of a tenant's scope-database sizes, read on demand. Each
  // scope read wakes its Durable Object, so the card calls this only when a person asks,
  // and walks further pages with `cursor` one press at a time.
  readStorage = (tenantId: TenantId, cursor?: ScopeId): Promise<StorageMeterReading> =>
    this.call(`/meters/storage${query({ tenantId, cursor })}`);
  // Meter 3 (#1054) — model usage, the one D-30 could not compute: the lines the
  // `model-usage` intents drained into the directory, folded per (tenant, vertical,
  // model) with the platform's margin applied at read time. Defaults to the current
  // calendar month so far; omit `tenantId` for the fleet.
  readModelUsage = (q: { tenantId?: TenantId; since?: string; until?: string } = {}): Promise<ModelUsageSummary> =>
    this.call(`/model-usage/summary${query({ ...q })}`);

  // -- scopes ----------------------------------------------------------------

  listScopes = (filter?: { tenantId?: TenantId; status?: ScopeStatus[]; vertical?: string } & PageQuery): Promise<Page<Scope>> =>
    this.call(`/scopes${query({ ...filter })}`);
  // Fleet migration progress (kernel-design §5.3, #49): "release N: X/Y
  // migrated, P pending, F failed" against the deployment's frontier.
  migrationProgress = (vertical?: string): Promise<MigrationProgress> =>
    this.call(`/fleet/migrations${query({ vertical })}`);
  getScope = (tenantId: TenantId, scopeId: ScopeId): Promise<Scope> =>
    this.call(`/tenants/${tenantId}/scopes/${scopeId}`);
  // Scope health (#321): an ACTIVE scope with a resolvable serving script but an empty
  // role projection serves traffic every check denies — surfaced as a platform condition
  // here instead of only as a per-app 403. `missingStores` (#825) is the same kind of
  // condition one layer down: a per-tenant store the vertical declares that this tenant
  // was never minted, invisible until the code touches it.
  scopeHealth = (tenantId: TenantId, scopeId: ScopeId): Promise<ScopeHealth> =>
    this.call(`/tenants/${tenantId}/scopes/${scopeId}/health`);

  // The K-35 denial log (#867) — the scope's own record of every ENFORCED permission
  // refusal. Summary first: the raw log's volume is attacker-influenceable (a probing
  // client mints rows), so bucketing is what keeps a quiet actor visible next to a loud
  // one. The rows are the drill-down behind a bucket.
  denialSummary = (t: TenantId, s: ScopeId, filter?: DenialFilter): Promise<DenialSummary> =>
    this.call(`/tenants/${t}/scopes/${s}/denials/summary${denialQuery(filter)}`);
  listDenials = (t: TenantId, s: ScopeId, filter?: DenialFilter): Promise<PermissionDenial[]> =>
    this.call(`/tenants/${t}/scopes/${s}/denials${denialQuery(filter)}`);

  // The operator's read of a scope's capabilities (#1686). Staff-only server-side; a
  // deployment predating the route answers 404/501 like the other late reads. Records only.
  listCapabilities = (t: TenantId, s: ScopeId, filter?: CapabilityFilter): Promise<CapabilityPage> =>
    this.call(`/tenants/${t}/scopes/${s}/capabilities${capabilityQuery(filter)}`);

  // The #1666 schedule kill switch, read and moved from the console (#1674/#1675). No
  // new permission surface here — the route is already staff-only server-side
  // (`confinedTenant`), and the console is a staff session. `moduleId` is the module's
  // manifest id (e.g. '@substrat-run/engine-absence'), always read off a status entry
  // rather than typed by hand. A deployment predating the route answers 501, which
  // `ControlPlaneError` relays verbatim (never a wrong `on`).
  systemGrantsStatus = (t: TenantId, s: ScopeId): Promise<SystemGrantsStatusEntry[]> =>
    this.call(`/tenants/${t}/scopes/${s}/system-grants`);
  // DELETE on the switch route (#1676) — `reason` is required server-side
  // (`z.string().trim().min(1).max(500)`) and lands on the admin log beside the actor.
  switchScheduleOff = (t: TenantId, s: ScopeId, moduleId: ModuleId, reason: string): Promise<SystemSwitchResult> =>
    this.json('DELETE', `/tenants/${t}/scopes/${s}/system-grants`, {
      moduleId,
      reason,
    });
  // POST on the same route — the only way back on; restores exactly what the DELETE took.
  switchScheduleOn = (t: TenantId, s: ScopeId, moduleId: ModuleId, reason: string): Promise<SystemSwitchResult> =>
    this.post(`/tenants/${t}/scopes/${s}/system-grants`, { moduleId, reason });

  // The #1706 peer kill switch, read and moved from the console. The route admits a
  // tenant's own credential as well as staff (unlike the schedule switch above), because
  // it answers a question about the tenant's own two apps; the console is a staff session
  // either way. `vertical` is the CALLING vertical's registry slug, always read off a
  // status entry rather than typed by hand. A deployment predating the route answers 501,
  // which `ControlPlaneError` relays verbatim (never a wrong `on`).
  peerGrantsStatus = (t: TenantId, s: ScopeId): Promise<PeerGrantsStatusEntry[]> =>
    this.call(`/tenants/${t}/scopes/${s}/peer-grants`);
  // DELETE on the switch route — `reason` is required server-side and lands on the admin
  // log beside the actor, exactly as the schedule switch's does.
  switchPeerOff = (t: TenantId, s: ScopeId, vertical: string, reason: string): Promise<PeerSwitchResult> =>
    this.json('DELETE', `/tenants/${t}/scopes/${s}/peer-grants`, {
      vertical,
      reason,
    });
  // POST on the same route — the only way back on; restores exactly what the DELETE took.
  switchPeerOn = (t: TenantId, s: ScopeId, vertical: string, reason: string): Promise<PeerSwitchResult> =>
    this.post(`/tenants/${t}/scopes/${s}/peer-grants`, { vertical, reason });

  // #1705 PR 3: where each cross-vertical edge of a tenant stands, read live through the
  // sweep's own reach, and the replay lever on a consumer scope. The lever's body carries its
  // acknowledgement literal. Without it the plane refuses in the words it stands for.
  // `focus` narrows the read to one scope's edges, into it and out of it.
  crossVerticalEdges = (t: TenantId, focus?: ScopeId): Promise<EdgeHealthReport> =>
    this.call(
      `/tenants/${t}/cross-vertical/edges${focus ? `?scopeId=${seg(focus)}` : ''}`,
    );
  moveImportCursor = (t: TenantId, s: ScopeId, move: ImportCursorMove): Promise<ImportCursorMoved> =>
    this.post(`/tenants/${t}/scopes/${s}/import-cursor`, move);

  provisionScope = (input: ProvisionScopeInput): Promise<Scope> => this.post('/scopes', input);

  // One method per audited transition, mirroring the API and HostAdmin. The
  // console renders only legal transitions; the graph is enforced below.
  // provisioning → active: the vertical has confirmed the scope exists (K-31).
  activateScope = (t: TenantId, s: ScopeId): Promise<Scope> => this.post(`/tenants/${t}/scopes/${s}/activate`);
  suspendScope = (t: TenantId, s: ScopeId): Promise<Scope> => this.post(`/tenants/${t}/scopes/${s}/suspend`);
  unsuspendScope = (t: TenantId, s: ScopeId): Promise<Scope> => this.post(`/tenants/${t}/scopes/${s}/unsuspend`);
  /**
   * Re-run the vertical's provision for a scope that already has one — NOT a status
   * transition, which is why it sits outside the ladder above and outside
   * `availableActions`. Nothing about the scope's state changes; what happens is that
   * everything provisioning delivers is delivered again: entitlements, identity links,
   * connection grants, and the vertical's OWN `onProvision` hook.
   *
   * Idempotent at the far end (K-31), so it is safe to press twice. It is the lever
   * for two shapes of stuck install: the #332 lockout (roles projected, zero tuples,
   * every login denied), and an install that predates something its vertical now mints
   * for itself at provision — a new service principal, say — which no other path can
   * ever deliver, because provision runs at install and never again.
   */
  reprovisionScope = (t: TenantId, s: ScopeId): Promise<Scope> => this.post(`/tenants/${t}/scopes/${s}/provision`);
  archiveScope = (t: TenantId, s: ScopeId): Promise<Scope> => this.post(`/tenants/${t}/scopes/${s}/archive`);
  unarchiveScope = (t: TenantId, s: ScopeId): Promise<Scope> => this.post(`/tenants/${t}/scopes/${s}/unarchive`);
  // archived → reaped (§4.4): irreversibly wipe the scope's DO storage, keeping the
  // directory row as a tombstone. Staff-only server-side; the console arms it behind a
  // type-to-confirm dialog because, unlike archive, there is no restore.
  //
  // `backup: true` is sent ALWAYS, never omitted (#493): the control plane treats an
  // explicit ask as "back up or refuse", so a console reap can never quietly wipe a
  // scope because the backup bucket went unbound. The returned `backup` names the copy
  // that landed — the operator's proof it exists, and the address to restore from.
  reapScope = (
    t: TenantId,
    s: ScopeId,
    opts: { backup?: boolean } = { backup: true },
  ): Promise<Scope & { backup: ScopeBackup | null }> =>
    this.post(`/tenants/${t}/scopes/${s}/reap`, opts);
  // Move ONE scope onto a DIFFERENT vertical lineage's serving script (#389) — the
  // update-rebind behind retiring a lineage in favour of another. Data-first with the
  // source script kept as the backout. `ackMigrations` is the digest gate's override:
  // the control plane refuses the crossing when the two lineages' migration digests
  // differ unless the operator acknowledges having read both surfaces. `abandonData`
  // is deliberately NOT exposed — it exists for pre-#236 relic scripts only, and a
  // console that offers it invites moving an install while leaving its data behind.
  rebindScopeVertical = (
    t: TenantId,
    s: ScopeId,
    vertical: string,
    opts: { ackMigrations?: boolean } = {},
  ): Promise<RebindScopeResult> =>
    this.post(
      `/tenants/${t}/scopes/${s}/rebind-vertical`,
      { vertical, ...opts },
    );
  /** The copies held for a scope, newest first — readable after the reap (the tombstone survives). */
  listScopeBackups = (t: TenantId, s: ScopeId): Promise<ScopeBackup[]> =>
    this.call(`/tenants/${t}/scopes/${s}/backups`);
  /** Take a copy without reaping — a pre-migration checkpoint, or an export to keep. */
  backupScope = (t: TenantId, s: ScopeId): Promise<ScopeBackup> => this.post(`/tenants/${t}/scopes/${s}/backups`);

  // The PLATFORM's own copies (#40) — the directory, not a tenant's scope. Read and
  // take-now only: `POST /directory/restore` is deliberately NOT on this client. A
  // one-click replace-the-whole-directory control is well past what a type-to-confirm
  // dialog can guard (its blast radius is every tenant at once), and the scenario it
  // exists for is one where the directory is GONE — a recovery path that assumes a
  // healthy console is a recovery path that is not there when it is needed. Restore is
  // a deliberate API call from the runbook (control-plane.md §4.9).
  //
  // A 501 here is meaningful, not an error to swallow: it means no backup store is
  // bound, i.e. this control plane keeps NO platform copy. The view renders that as
  // the alarm it is.
  listDirectoryBackups = (): Promise<DirectoryBackup[]> => this.call('/directory/backups');
  backupDirectory = (): Promise<DirectoryBackup> => this.post('/directory/backups');
  // Hard-delete a SNAPSHOT fork (forkedFrom set): wipes its storage, hostnames, and the
  // row (unlike reap, which keeps a tombstone). Refused (409) on a non-fork primary scope.
  deleteScope = (t: TenantId, s: ScopeId): Promise<{ deleted: ScopeId }> =>
    this.json('DELETE', `/tenants/${t}/scopes/${s}`);

  // Read only — there is no route that writes a role, by design.
  // Cursor is the composite `${tenantId}|${roleKey}` sort key (scope-host.ts listRoles).
  listRoles = (filter?: { tenantId?: TenantId; source?: string } & PageQuery): Promise<Page<TenantRole>> =>
    this.call(`/roles${query({ ...filter })}`);

  // The hostname map (§4.7). `resolveHostname` is absent on purpose — that is the
  // router's per-request path, not a staff action, and it is not on this surface.
  listHostnames = (filter?: { tenantId?: TenantId; scopeId?: ScopeId } & PageQuery): Promise<Page<HostnameBinding>> =>
    this.call(`/hostnames${query({ ...filter })}`);
  bindHostname = (input: BindHostnameInput): Promise<HostnameBinding> => this.post('/hostnames', input);
  setHostnameStatus = (hostname: string, status: HostnameStatus, note?: string): Promise<HostnameBinding> =>
    this.json('PATCH', `/hostnames/${seg(hostname)}/status`, { status, note });
  // Release a bound name — what a retire pass runs before reaping a scope, so the
  // reap's bound-hostname guard is satisfied and the router stops resolving it.
  unbindHostname = (hostname: string): Promise<void> => this.json('DELETE', `/hostnames/${seg(hostname)}`);

  /**
   * Create one instance of a vertical (K-31). The control plane calls the
   * vertical, because only it can create a usable scope DO.
   *
   * Call this BEFORE `provisionScope`: the directory row should only exist once
   * the vertical is ready, so a failure leaves an invisible orphan rather than a
   * directory row promising a scope that is not there.
   */
  provisionInstance = (
    verticalSlug: string,
    input: { tenantId: TenantId; scopeId: ScopeId; owner: string; slug: string; name: string },
  ): Promise<{ tenantId: TenantId; scopeId: ScopeId; owner: string }> =>
    this.post(
      `/verticals/${seg(verticalSlug)}/instances`,
      input,
    );

  // -- logs and fleet reads --------------------------------------------------

  adminLog = (q: AuditLogQuery = {}): Promise<AdminLogPage> => this.call(`/admin-log${query({ ...q })}`);

  // Operational failures (#559) — what the platform could NOT do, durable and
  // queryable, distinct from the admin log's successful mutations. Newest first
  // by default; `reference` finds the row a `reference = <id>` CI error names.
  listOpsFailures = (q: OpsFailuresQuery = {}): Promise<Page<OpsFailureEntry>> =>
    this.call(`/ops-failures${query({ ...q })}`);
  // The fleet's sweep record (#1232) — connections polled, schedules fired or
  // skipped, freshness verdicts. Newest first; 14-day retention.
  listSweepRuns = (q: SweepRunsQuery = {}): Promise<Page<SweepRunEntry>> =>
    this.call(`/sweep-runs${query({ ...q })}`);
  // The schedule kill-switch fleet read (#1674) — every (tenant, scope, module) the
  // directory records a switch position for. `position` defaults to `off` server-side:
  // "what is switched off across the fleet" is the question this read exists to answer.
  listSystemSwitches = (q: SystemSwitchesQuery = {}): Promise<Page<SystemSwitchRecord>> =>
    this.call(`/system-switches${query({ ...q })}`);
  // Fleet-wide connection health (#1690) — every tenant's connections with their
  // derived health, refresh-expiry warning, and connector dead letters per provider.
  listConnectionHealth = (q: ConnectionHealthQuery = {}): Promise<ConnectionHealthPage> =>
    this.call(`/connections/health${query({ ...q })}`);
  // Connector calls per provider over a window (#1691) — the trend behind the health
  // line. 501s where the control plane names no connector-call dataset.
  connectorCalls = (q: { hours: number; provider?: string }): Promise<{ hours: number; buckets: ConnectorCallsBucket[] }> =>
    this.call(`/connections/calls${query({ ...q })}`);
  // Failures grouped by fingerprint (#1233) — counted defects with a lifecycle.
  // `{ entries }` alone: the server sends no cursor, deliberately.
  listIssues = (q: IssuesQuery = {}): Promise<{ entries: IssueEntry[] }> => this.call(`/issues${query({ ...q })}`);
  // The staff verdict: resolve / ignore / reopen. The fingerprint rides in the
  // body — it embeds U+001F, and a path segment would demand percent-encoding
  // every caller can get subtly wrong.
  setIssueStatus = (fingerprint: string, status: IssueStatusInput): Promise<IssueEntry> =>
    this.json('PUT', '/issues/status', { fingerprint, status });

  // -- vertical + version registry (orchestration.md §5.6) ----------------
  // The staff surface for the two human checkpoints: admit/reject a version,
  // and promote a channel — which refuses a changed permission/migration digest
  // unless acknowledged. Register is a producer action; publishing a version
  // (with digests from a build) is CI/CLI, not hand-entry.
  listVerticals = (page: PageQuery = {}): Promise<Page<Vertical>> => this.call(`/verticals${query({ ...page })}`);
  registerVertical = (input: { slug: string; name: string; source: VerticalSource }): Promise<Vertical> =>
    this.post('/verticals', input);
  listVersions = (slug: string, page: PageQuery = {}): Promise<Page<VerticalVersion>> =>
    this.call(`/verticals/${seg(slug)}/versions${query({ ...page })}`);
  admitVersion = (slug: string, id: string): Promise<VerticalVersion> =>
    this.post(`/verticals/${seg(slug)}/versions/${id}/admit`);
  rejectVersion = (slug: string, id: string, note: string): Promise<VerticalVersion> =>
    this.post(`/verticals/${seg(slug)}/versions/${id}/reject`, { note });
  listChannels = (slug: string, page: PageQuery = {}): Promise<Page<VerticalChannel>> =>
    this.call(`/verticals/${seg(slug)}/channels${query({ ...page })}`);
  // Publish/unpublish to the PUBLIC marketplace (marketplace-publish.md §5) — the staff
  // admission of a builder's publish request. The API refuses `listed: true` while prod
  // points at an auto-admitted version; that refusal is surfaced verbatim, not pre-checked.
  setVerticalListed = (slug: string, listed: boolean): Promise<{ slug: string; listed: boolean }> =>
    this.post(`/verticals/${seg(slug)}/listing`, { listed });
  // The install kill-switch: block/unblock NEW installs (existing scopes keep serving).
  setInstallsBlocked = (slug: string, blocked: boolean): Promise<{ slug: string; installsBlocked: boolean }> =>
    this.post(`/verticals/${seg(slug)}/install-block`, {
      blocked,
    });
  // Grant/revoke the tenant-provisioner capability (#412): whether this vertical's scopes
  // may enqueue provision-tenant / set-entitlements intents the platform executes.
  setTenantProvisioner = (slug: string, granted: boolean): Promise<{ slug: string; tenantProvisioner: boolean }> =>
    this.post(
      `/verticals/${seg(slug)}/tenant-provisioner`,
      { granted },
    );
  // Grant/revoke the email-sender capability (#303): whether this vertical's scopes may POST
  // to the /internal/email/send relay and have transactional mail sent on their behalf.
  setEmailSender = (slug: string, granted: boolean): Promise<{ slug: string; emailSender: boolean }> =>
    this.post(`/verticals/${seg(slug)}/email-sender`, {
      granted,
    });
  // Delete a vertical + its versions/channels. Refused (4xx) while any scope is bound.
  deleteVertical = (slug: string): Promise<{ slug: string; deleted: boolean }> =>
    this.json('DELETE', `/verticals/${seg(slug)}`);
  promoteVersion = (
    slug: string,
    channel: ChannelName,
    versionId: string,
    acknowledge?: PromotionAcknowledgement,
  ): Promise<VerticalChannel> =>
    this.post(`/verticals/${seg(slug)}/channels/${channel}/promote`, {
      versionId,
      acknowledge,
    });
  // #1705 PR 3: which installed apps promoting `versionId` would break, read before promoting
  // so the dialog can ask for the export-break acknowledgement up front. Staff see every app.
  promotionImpact = (
    slug: string,
    channel: ChannelName,
    versionId: string,
  ): Promise<{ affected: ExportBreak[]; otherTenants?: number }> =>
    this.call(
      `/verticals/${seg(slug)}/channels/${channel}/promote-impact?versionId=${seg(versionId)}`,
    );
  // #1677: the two diffs a promote acknowledges. `registry` is null for a version that declared
  // none ("cannot diff"), `migrations` null for one that carries no SQL ("not available").
  versionRegistry = (slug: string, versionId: string): Promise<{ registry: PermissionRegistry | null }> =>
    this.call(
      `/verticals/${seg(slug)}/versions/${seg(versionId)}/registry`,
    );
  versionMigrations = (slug: string, versionId: string, base?: string): Promise<{ migrations: MigrationDiff | null }> =>
    this.call(
      `/verticals/${seg(slug)}/versions/${seg(versionId)}/migrations${
        base === undefined ? '' : `?base=${seg(base)}`
      }`,
    );
  // Pin a scope to a version — what the router dispatches on (orchestration.md §5.4).
  // Refuses a non-admitted version below the seam.
  bindScopeVersion = (tenantId: TenantId, scopeId: ScopeId, versionId: string): Promise<Scope> =>
    this.post(`/tenants/${tenantId}/scopes/${scopeId}/version`, { versionId });

  // -- members (console → Members) ----------------------------------------
  // Who may act on the control plane (staff_actor) — the CP worker's own D1,
  // not the directory, so the routes live beside /api/auth/* rather than in
  // control-plane-api. Every mutation returns the fresh reading: one round
  // trip, no refetch. (Builder-studio access is NOT managed here — it is the
  // `builder` entitlement on the tenant, granted like any SKU.)
  listMembers = (): Promise<MembersReading> => this.call('/members');
  grantStaffAccess = (email: string, name?: string): Promise<MembersReading> =>
    this.post('/members/staff', { email, name });
  revokeStaffAccess = (email: string): Promise<MembersReading> => this.post('/members/staff/revoke', { email });

  // -- observability (design/observability.md §4.1) -----------------------
  // Proxied reads over the control plane's observability seam; 501 when no
  // backend is configured. Tier-3 numbers: sampled, approximate, never money
  // (master-plan §5.3).
  serviceMetrics = (hours: number): Promise<ServiceMetricsRow[]> =>
    this.call(`/observability/metrics${query({ hours })}`);
  recentLogs = (q: { service?: string; level?: string; hours?: number; limit?: number } = {}): Promise<RecentLogEvent[]> =>
    this.call(`/observability/logs${query({ ...q })}`);
  /** Observed-vs-declared outbound egress for a vertical's deployed versions (#859). */
  verticalEgress = (slug: string, q: { hours?: number; limit?: number } = {}): Promise<EgressReport> =>
    this.call(`/verticals/${seg(slug)}/egress${query({ ...q })}`);
  // Platform-request drain backlog, fleet-wide (#1690 §2) — terminal give-ups over a
  // window, plus the pending count as of the sweep's last drain pass (#1840). See
  // `PlatformRequestBacklog`'s own doc.
  platformRequestBacklog = (): Promise<PlatformRequestBacklog> => this.call('/platform-requests/backlog');
}
