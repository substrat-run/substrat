import { LIST_PAGE_MAX } from '@substrat-run/contracts';
import type {
  AdminAction,
  AdminLogEntry,
  ChannelName,
  DirectoryBackup,
  EntitlementGrant,
  EntitlementGrantInput,
  HostnameBinding,
  HostnameStatus,
  MigrationProgress,
  Page,
  PromotionAcknowledgement,
  Scope,
  ScopeBackup,
  ScopeId,
  ScopeStatus,
  Tenant,
  TenantId,
  TenantRole,
  TenantStatus,
  Vertical,
  VerticalChannel,
  VerticalSource,
  VerticalVersion,
} from '@substrat-run/contracts';
import type { DoNamespace, PlatformRuntime, TenantStores } from './cf-links';

/**
 * Client for the control-plane API (packages/control-plane-api).
 *
 * The types come from `@substrat-run/contracts` rather than being restated here:
 * the console renders the kernel's own vocabulary, so a field the platform
 * renames should break this build rather than render `undefined` in a table.
 */

/** Dev only. Real staff auth (SSO/MFA) gates exposing the console — §6. */
const DEV_ACTOR_HEADER = 'x-platform-actor';

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

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

function query(params: Record<string, string | string[] | number | undefined>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined) continue;
    // Repeatable params (status, action) — the API reads them with c.req.queries().
    if (Array.isArray(v)) for (const one of v) q.append(k, one);
    else q.append(k, String(v));
  }
  const s = q.toString();
  return s ? `?${s}` : '';
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

/**
 * Walk a paged read to exhaustion — for computations that need the FULL set
 * (fleet counts, cascade status, the bindable-scope dropdown) now that every
 * list egress defaults a page. Max-sized pages until the cursor runs out;
 * `nextCursor: null` is the end of the walk, never a trailing empty fetch.
 */
export async function walkAll<T>(fetchPage: (page: PageQuery) => Promise<Page<T>>): Promise<T[]> {
  const all: T[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = await fetchPage({ limit: LIST_PAGE_MAX, cursor });
    all.push(...page.entries);
    if (page.nextCursor === null) return all;
    cursor = page.nextCursor;
  }
}

/**
 * `actor` is the dev-actor id for the co-located quick path (sent as a header),
 * or null in session mode, where the staff session cookie authenticates instead.
 * `credentials: 'include'` carries that cookie (harmless in dev mode).
 */
export function createApi(actor: string | null, baseUrl = '/api') {
  async function call<T>(path: string, init?: RequestInit): Promise<T> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      ...(init?.headers as Record<string, string> | undefined),
    };
    if (actor) headers[DEV_ACTOR_HEADER] = actor;
    const res = await fetch(`${baseUrl}${path}`, {
      ...init,
      credentials: 'include',
      headers,
    });
    if (!res.ok) {
      // The API answers errors as { error }; a proxy or crash may not, so fall
      // back to the status rather than throwing while handling a throw.
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      throw new ApiError(res.status, body?.error ?? `${res.status} ${res.statusText}`);
    }
    return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
  }

  const post = <T>(path: string, body?: unknown) =>
    call<T>(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) });

  return {
    listTenants: (page: PageQuery = {}) => call<Page<Tenant>>(`/tenants${query({ ...page })}`),
    getTenant: (id: TenantId) => call<Tenant>(`/tenants/${id}`),
    createTenant: (input: { id: TenantId; slug: string; name: string }) =>
      post<Tenant>('/tenants', input),
    setTenantStatus: (id: TenantId, status: TenantStatus) =>
      call<Tenant>(`/tenants/${id}/status`, { method: 'PATCH', body: JSON.stringify({ status }) }),
    // Reap a deleting tenant NOW (§4.8) — skips the grace window: every scope reaped,
    // PII/config directory rows cleared, the tenant row kept as a `reaped` tombstone.
    reapTenant: (id: TenantId) => post<Tenant>(`/tenants/${id}/reap`),

    // Where the platform's compute and stores live — the account + dispatch namespace the
    // refs this console renders resolve in, so a scope's script or a tenant's database can
    // be a LINK into the Cloudflare dashboard rather than an id to search for. Answers
    // null on a control plane with no runtime configured (self-host): the views then show
    // the same identifiers, unlinked.
    platformRuntime: () => call<PlatformRuntime | null>('/platform/runtime'),

    // The Durable Object namespaces one script defines, scope-class first — the ids the
    // dashboard addresses a namespace by. 501s when the control plane has no lookup
    // configured, which callers treat as "link to the list instead".
    doNamespaces: (script: string) =>
      call<DoNamespace[]>(`/platform/do-namespaces${query({ script })}`),

    // The per-tenant store ledgers as inventory (#301 D1, #473 R2): which database and
    // which bucket hold this tenant's bytes. Read-only — stores are minted by
    // provisioning, never from here.
    tenantStores: (id: TenantId) => call<TenantStores>(`/tenants/${id}/stores`),

    listEntitlements: (id: TenantId) => call<EntitlementGrant[]>(`/tenants/${id}/entitlements`),
    grantEntitlement: (id: TenantId, key: string, plan?: EntitlementGrantInput) =>
      call<EntitlementGrant[]>(`/tenants/${id}/entitlements/${key}`, {
        method: 'PUT',
        body: plan === undefined ? undefined : JSON.stringify(plan),
      }),
    revokeEntitlement: (id: TenantId, key: string) =>
      call<EntitlementGrant[]>(`/tenants/${id}/entitlements/${key}`, { method: 'DELETE' }),

    listScopes: (filter?: { tenantId?: TenantId; status?: ScopeStatus[]; vertical?: string } & PageQuery) =>
      call<Page<Scope>>(`/scopes${query({ ...filter })}`),
    // Fleet migration progress (kernel-design §5.3, #49): "release N: X/Y
    // migrated, P pending, F failed" against the deployment's frontier.
    migrationProgress: (vertical?: string) =>
      call<MigrationProgress>(`/fleet/migrations${query({ vertical })}`),
    getScope: (tenantId: TenantId, scopeId: ScopeId) =>
      call<Scope>(`/tenants/${tenantId}/scopes/${scopeId}`),
    // Scope health (#321): an ACTIVE scope with a resolvable serving script but an empty
    // role projection serves traffic every check denies — surfaced as a platform condition
    // here instead of only as a per-app 403.
    scopeHealth: (tenantId: TenantId, scopeId: ScopeId) =>
      call<{ scopeId: ScopeId; status: string; servingRef: string | null; roleCount: number | null; roleProjectionEmpty: boolean }>(
        `/tenants/${tenantId}/scopes/${scopeId}/health`,
      ),
    provisionScope: (input: {
      tenantId: TenantId;
      scopeId: ScopeId;
      slug?: string;
      kind?: string;
      name?: string;
      vertical?: string | null;
      storageShape?: 'A' | 'B';
      // Only `global` is accepted today; `eu`/`us` are gated server-side (K-32).
      jurisdiction?: 'eu' | 'us' | 'global';
    }) => post<Scope>('/scopes', input),

    // One method per audited transition, mirroring the API and HostAdmin. The
    // console renders only legal transitions; the graph is enforced below.
    // provisioning → active: the vertical has confirmed the scope exists (K-31).
    activateScope: (t: TenantId, s: ScopeId) => post<Scope>(`/tenants/${t}/scopes/${s}/activate`),
    suspendScope: (t: TenantId, s: ScopeId) => post<Scope>(`/tenants/${t}/scopes/${s}/suspend`),
    unsuspendScope: (t: TenantId, s: ScopeId) => post<Scope>(`/tenants/${t}/scopes/${s}/unsuspend`),
    archiveScope: (t: TenantId, s: ScopeId) => post<Scope>(`/tenants/${t}/scopes/${s}/archive`),
    unarchiveScope: (t: TenantId, s: ScopeId) => post<Scope>(`/tenants/${t}/scopes/${s}/unarchive`),
    // archived → reaped (§4.4): irreversibly wipe the scope's DO storage, keeping the
    // directory row as a tombstone. Staff-only server-side; the console arms it behind a
    // type-to-confirm dialog because, unlike archive, there is no restore.
    //
    // `backup: true` is sent ALWAYS, never omitted (#493): the control plane treats an
    // explicit ask as "back up or refuse", so a console reap can never quietly wipe a
    // scope because the backup bucket went unbound. The returned `backup` names the copy
    // that landed — the operator's proof it exists, and the address to restore from.
    reapScope: (t: TenantId, s: ScopeId, opts: { backup?: boolean } = { backup: true }) =>
      post<Scope & { backup: ScopeBackup | null }>(`/tenants/${t}/scopes/${s}/reap`, opts),
    /** The copies held for a scope, newest first — readable after the reap (the tombstone survives). */
    listScopeBackups: (t: TenantId, s: ScopeId) =>
      call<ScopeBackup[]>(`/tenants/${t}/scopes/${s}/backups`),
    /** Take a copy without reaping — a pre-migration checkpoint, or an export to keep. */
    backupScope: (t: TenantId, s: ScopeId) => post<ScopeBackup>(`/tenants/${t}/scopes/${s}/backups`),

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
    listDirectoryBackups: () => call<DirectoryBackup[]>('/directory/backups'),
    backupDirectory: () => post<DirectoryBackup>('/directory/backups'),
    // Hard-delete a SNAPSHOT fork (forkedFrom set): wipes its storage, hostnames, and the
    // row (unlike reap, which keeps a tombstone). Refused (409) on a non-fork primary scope.
    deleteScope: (t: TenantId, s: ScopeId) =>
      call<{ deleted: ScopeId }>(`/tenants/${t}/scopes/${s}`, { method: 'DELETE' }),

    // Read only — there is no route that writes a role, by design.
    // Cursor is the composite `${tenantId}|${roleKey}` sort key (scope-host.ts listRoles).
    listRoles: (filter?: { tenantId?: TenantId; source?: string } & PageQuery) =>
      call<Page<TenantRole>>(`/roles${query({ ...filter })}`),

    // The hostname map (§4.7). `resolveHostname` is absent on purpose — that is the
    // router's per-request path, not a staff action, and it is not on this surface.
    listHostnames: (filter?: { tenantId?: TenantId; scopeId?: ScopeId } & PageQuery) =>
      call<Page<HostnameBinding>>(`/hostnames${query({ ...filter })}`),
    bindHostname: (input: {
      hostname: string;
      tenantId: TenantId;
      scopeId: ScopeId;
      surface: string;
      region?: 'eu' | null;
      canonical?: boolean;
    }) => post<HostnameBinding>('/hostnames', input),
    setHostnameStatus: (hostname: string, status: HostnameStatus, note?: string) =>
      call<HostnameBinding>(`/hostnames/${encodeURIComponent(hostname)}/status`, {
        method: 'PATCH',
        body: JSON.stringify({ status, note }),
      }),
    // Release a bound name — what a retire pass runs before reaping a scope, so the
    // reap's bound-hostname guard is satisfied and the router stops resolving it.
    unbindHostname: (hostname: string) =>
      call<void>(`/hostnames/${encodeURIComponent(hostname)}`, { method: 'DELETE' }),

    /**
     * Create one instance of a vertical (K-31). The control plane calls the
     * vertical, because only it can create a usable scope DO.
     *
     * Call this BEFORE `provisionScope`: the directory row should only exist once
     * the vertical is ready, so a failure leaves an invisible orphan rather than a
     * directory row promising a scope that is not there.
     */
    provisionInstance: (
      verticalSlug: string,
      input: { tenantId: TenantId; scopeId: ScopeId; owner: string; slug: string; name: string },
    ) => post<{ tenantId: TenantId; scopeId: ScopeId; owner: string }>(
      `/verticals/${encodeURIComponent(verticalSlug)}/instances`,
      input,
    ),

    adminLog: (q: AuditLogQuery = {}) => call<AdminLogPage>(`/admin-log${query({ ...q })}`),

    // -- vertical + version registry (orchestration.md §5.6) ----------------
    // The staff surface for the two human checkpoints: admit/reject a version,
    // and promote a channel — which refuses a changed permission/migration digest
    // unless acknowledged. Register is a producer action; publishing a version
    // (with digests from a build) is CI/CLI, not hand-entry.
    listVerticals: (page: PageQuery = {}) => call<Page<Vertical>>(`/verticals${query({ ...page })}`),
    registerVertical: (input: { slug: string; name: string; source: VerticalSource }) =>
      post<Vertical>('/verticals', input),
    listVersions: (slug: string, page: PageQuery = {}) =>
      call<Page<VerticalVersion>>(`/verticals/${encodeURIComponent(slug)}/versions${query({ ...page })}`),
    admitVersion: (slug: string, id: string) =>
      post<VerticalVersion>(`/verticals/${encodeURIComponent(slug)}/versions/${id}/admit`),
    rejectVersion: (slug: string, id: string, note: string) =>
      post<VerticalVersion>(`/verticals/${encodeURIComponent(slug)}/versions/${id}/reject`, { note }),
    listChannels: (slug: string, page: PageQuery = {}) =>
      call<Page<VerticalChannel>>(`/verticals/${encodeURIComponent(slug)}/channels${query({ ...page })}`),
    // Publish/unpublish to the PUBLIC marketplace (marketplace-publish.md §5) — the staff
    // admission of a builder's publish request. The API refuses `listed: true` while prod
    // points at an auto-admitted version; that refusal is surfaced verbatim, not pre-checked.
    setVerticalListed: (slug: string, listed: boolean) =>
      post<{ slug: string; listed: boolean }>(
        `/verticals/${encodeURIComponent(slug)}/listing`,
        { listed },
      ),
    // The install kill-switch: block/unblock NEW installs (existing scopes keep serving).
    setInstallsBlocked: (slug: string, blocked: boolean) =>
      post<{ slug: string; installsBlocked: boolean }>(
        `/verticals/${encodeURIComponent(slug)}/install-block`,
        { blocked },
      ),
    // Grant/revoke the tenant-provisioner capability (#412): whether this vertical's scopes
    // may enqueue provision-tenant / set-entitlements intents the platform executes.
    setTenantProvisioner: (slug: string, granted: boolean) =>
      post<{ slug: string; tenantProvisioner: boolean }>(
        `/verticals/${encodeURIComponent(slug)}/tenant-provisioner`,
        { granted },
      ),
    // Grant/revoke the email-sender capability (#303): whether this vertical's scopes may POST
    // to the /internal/email/send relay and have transactional mail sent on their behalf.
    setEmailSender: (slug: string, granted: boolean) =>
      post<{ slug: string; emailSender: boolean }>(
        `/verticals/${encodeURIComponent(slug)}/email-sender`,
        { granted },
      ),
    // Delete a vertical + its versions/channels. Refused (4xx) while any scope is bound.
    deleteVertical: (slug: string) =>
      call<{ slug: string; deleted: boolean }>(`/verticals/${encodeURIComponent(slug)}`, {
        method: 'DELETE',
      }),
    promoteVersion: (
      slug: string,
      channel: ChannelName,
      versionId: string,
      acknowledge?: PromotionAcknowledgement,
    ) =>
      post<VerticalChannel>(`/verticals/${encodeURIComponent(slug)}/channels/${channel}/promote`, {
        versionId,
        acknowledge,
      }),
    // Pin a scope to a version — what the router dispatches on (orchestration.md §5.4).
    // Refuses a non-admitted version below the seam.
    bindScopeVersion: (tenantId: TenantId, scopeId: ScopeId, versionId: string) =>
      post<Scope>(`/tenants/${tenantId}/scopes/${scopeId}/version`, { versionId }),

    // -- observability (design/observability.md §4.1) -----------------------
    // Proxied reads over the control plane's observability seam; 501 when no
    // backend is configured. Tier-3 numbers: sampled, approximate, never money
    // (master-plan §5.3).
    serviceMetrics: (hours: number) => call<ServiceMetricsRow[]>(`/observability/metrics${query({ hours })}`),
    recentLogs: (q: { service?: string; level?: string; hours?: number; limit?: number } = {}) =>
      call<RecentLogEvent[]>(`/observability/logs${query({ ...q })}`),
  };
}

export type Api = ReturnType<typeof createApi>;
