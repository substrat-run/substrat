import type {
  AdminAction,
  AdminLogEntry,
  ChannelName,
  EntitlementGrant,
  EntitlementGrantInput,
  HostnameBinding,
  HostnameStatus,
  MigrationProgress,
  PromotionAcknowledgement,
  Scope,
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

export interface AdminLogPage {
  entries: AdminLogEntry[];
  nextCursor: string | null;
}

export interface AuditLogQuery {
  tenantId?: TenantId;
  scopeId?: ScopeId;
  actor?: string;
  action?: AdminAction[];
  since?: string;
  until?: string;
  limit?: number;
  cursor?: string;
  order?: 'asc' | 'desc';
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
    listTenants: () => call<Tenant[]>('/tenants'),
    getTenant: (id: TenantId) => call<Tenant>(`/tenants/${id}`),
    createTenant: (input: { id: TenantId; slug: string; name: string }) =>
      post<Tenant>('/tenants', input),
    setTenantStatus: (id: TenantId, status: TenantStatus) =>
      call<Tenant>(`/tenants/${id}/status`, { method: 'PATCH', body: JSON.stringify({ status }) }),

    listEntitlements: (id: TenantId) => call<EntitlementGrant[]>(`/tenants/${id}/entitlements`),
    grantEntitlement: (id: TenantId, key: string, plan?: EntitlementGrantInput) =>
      call<EntitlementGrant[]>(`/tenants/${id}/entitlements/${key}`, {
        method: 'PUT',
        body: plan === undefined ? undefined : JSON.stringify(plan),
      }),
    revokeEntitlement: (id: TenantId, key: string) =>
      call<EntitlementGrant[]>(`/tenants/${id}/entitlements/${key}`, { method: 'DELETE' }),

    listScopes: (filter?: { tenantId?: TenantId; status?: ScopeStatus[]; vertical?: string }) =>
      call<Scope[]>(`/scopes${query({ ...filter })}`),
    // Fleet migration progress (kernel-design §5.3, #49): "release N: X/Y
    // migrated, P pending, F failed" against the deployment's frontier.
    migrationProgress: (vertical?: string) =>
      call<MigrationProgress>(`/fleet/migrations${query({ vertical })}`),
    getScope: (tenantId: TenantId, scopeId: ScopeId) =>
      call<Scope>(`/tenants/${tenantId}/scopes/${scopeId}`),
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
    reapScope: (t: TenantId, s: ScopeId) => post<Scope>(`/tenants/${t}/scopes/${s}/reap`),

    // Read only — there is no route that writes a role, by design.
    listRoles: (filter?: { tenantId?: TenantId; source?: string }) =>
      call<TenantRole[]>(`/roles${query({ ...filter })}`),

    // The hostname map (§4.7). `resolveHostname` is absent on purpose — that is the
    // router's per-request path, not a staff action, and it is not on this surface.
    listHostnames: (filter?: { tenantId?: TenantId; scopeId?: ScopeId }) =>
      call<HostnameBinding[]>(`/hostnames${query({ ...filter })}`),
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
    listVerticals: () => call<Vertical[]>('/verticals'),
    registerVertical: (input: { slug: string; name: string; source: VerticalSource }) =>
      post<Vertical>('/verticals', input),
    listVersions: (slug: string) => call<VerticalVersion[]>(`/verticals/${encodeURIComponent(slug)}/versions`),
    admitVersion: (slug: string, id: string) =>
      post<VerticalVersion>(`/verticals/${encodeURIComponent(slug)}/versions/${id}/admit`),
    rejectVersion: (slug: string, id: string, note: string) =>
      post<VerticalVersion>(`/verticals/${encodeURIComponent(slug)}/versions/${id}/reject`, { note }),
    listChannels: (slug: string) => call<VerticalChannel[]>(`/verticals/${encodeURIComponent(slug)}/channels`),
    // The install kill-switch: block/unblock NEW installs (existing scopes keep serving).
    setInstallsBlocked: (slug: string, blocked: boolean) =>
      post<{ slug: string; installsBlocked: boolean }>(
        `/verticals/${encodeURIComponent(slug)}/install-block`,
        { blocked },
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
