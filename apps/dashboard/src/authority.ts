import type {
  PrincipalId,
  ScopeId,
  ScopeQueryResult,
  ScopeTable,
  ScopeTablePage,
  TenantId,
} from '@substrat-run/contracts';

/**
 * The tenant-narrowed platform authority — the crux of docs/design/dashboard.md §4.
 *
 * A customer's tenant-admin must be able to provision an app on the SHARED control
 * plane (the directory the router reads), but only ever inside THEIR OWN tenant.
 * This client is that seam: it wraps the control-plane API over an injected `fetch`
 * (a Worker service binding to `substrat-control-plane`) and **pins `tenantId`**.
 *
 * The tenant is fixed at construction from the caller's dashboard node — it is NOT
 * a parameter any method takes. So operation code physically cannot name another
 * tenant: cross-tenant is impossible by construction, the same move the #97
 * connector-authority seam makes ("authority is inherited, not re-declared").
 *
 * Auth is a shared service credential (`x-service-token`) that the control plane
 * resolves to its fixed SERVICE_ACTOR — machine-to-machine, distinct from staff
 * sign-in (control-plane-api/auth.ts). The audit subject on the shared plane is
 * therefore the service actor today; attributing each write to the customer's own
 * principal (the §4 ideal) waits on a per-principal control-plane credential.
 */
export interface TenantNarrowedControlPlaneOptions {
  /** Base URL of the control-plane API, e.g. `https://cp/api`. Host is ignored over a service binding. */
  baseUrl: string;
  /** The platform actor id stamped as `x-platform-actor` (prod resolves the real subject from the token). */
  actor: string;
  /** The shared service credential proving the caller is an authorized platform vertical. */
  serviceToken: string;
  /** The ONE tenant every call is pinned to — the caller's own, ambient from their session. */
  tenantId: TenantId;
  /** A Worker service-binding's `fetch` (bound to `substrat-control-plane`). Defaults to global fetch. */
  fetch?: typeof globalThis.fetch;
}

export class ControlPlaneError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ControlPlaneError';
  }
}

/** A fork's directory row, as the Snapshots tab needs it (a subset of the CP's Scope). */
export interface SnapshotRecord {
  id: string;
  kind: string;
  forkedFrom: string | null;
  forkedAt: string | null;
  expiresAt: string | null;
  verticalVersionId: string | null;
  createdAt: string;
  /** The copy's preview hostname (`app--s1a2b.…`), when one is bound. Joined by the caller. */
  url?: string | null;
}

export class TenantNarrowedControlPlane {
  private readonly baseUrl: string;
  private readonly actor: string;
  private readonly serviceToken: string;
  private readonly fetchImpl: typeof globalThis.fetch;
  /** Read-only: the pinned tenant. Every write below silently injects it. */
  readonly tenantId: TenantId;

  constructor(opts: TenantNarrowedControlPlaneOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, '');
    this.actor = opts.actor;
    this.serviceToken = opts.serviceToken;
    this.tenantId = opts.tenantId;
    // Bind to globalThis: workerd throws "Illegal invocation" if a service-binding
    // fetch is called with the wrong `this`. An injected fetch is used as-is.
    this.fetchImpl = opts.fetch ?? globalThis.fetch.bind(globalThis);
  }

  private async call<T>(path: string, init: RequestInit & { idempotent?: boolean } = {}): Promise<T> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        ...init,
        headers: {
          'content-type': 'application/json',
          'x-platform-actor': this.actor,
          'x-service-token': this.serviceToken,
          ...(init.headers as Record<string, string> | undefined),
        },
      });
    } catch (e) {
      throw new ControlPlaneError(0, `control plane unreachable: ${(e as Error).message}`);
    }
    if (!res.ok) {
      // A tenant/entitlement that already exists is fine on an idempotent step
      // (re-provisioning, a retried create) — the directory already reflects it.
      if (init.idempotent && (res.status === 409 || res.status === 422)) return undefined as T;
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      throw new ControlPlaneError(res.status, body?.error ?? `${res.status} ${res.statusText}`);
    }
    return res.status === 204 ? (undefined as T) : ((await res.json().catch(() => undefined)) as T);
  }

  private post<T>(path: string, body?: unknown, idempotent = false): Promise<T> {
    return this.call<T>(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body), idempotent });
  }

  /** Ensure the caller's tenant exists in the shared directory (idempotent). */
  ensureTenant(slug: string, name: string): Promise<void> {
    return this.post('/tenants', { id: this.tenantId, slug, name }, true);
  }

  /** Grant a SKU flag on the pinned tenant (idempotent). */
  grantEntitlement(key: string): Promise<void> {
    return this.call(`/tenants/${this.tenantId}/entitlements/${encodeURIComponent(key)}`, { method: 'PUT', idempotent: true });
  }

  /** Write the directory row for a new scope (`provisioning`) in the pinned tenant. */
  provisionScope(input: { scopeId: ScopeId; slug: string; name: string; vertical: string; jurisdiction: 'global' }): Promise<void> {
    return this.post('/scopes', { tenantId: this.tenantId, ...input });
  }

  /** Have the control plane call the vertical (K-31) to create the scope's data. */
  provisionInstance(
    verticalSlug: string,
    input: { scopeId: ScopeId; owner: PrincipalId; slug: string; name: string; config?: Record<string, string> },
  ): Promise<void> {
    return this.post(`/verticals/${encodeURIComponent(verticalSlug)}/instances`, { tenantId: this.tenantId, ...input });
  }

  /**
   * Deliver per-instance config to the app's running scope (vertical-auth-detach.md
   * §2.2) — the delivery half of the Env tab. The control plane routes it to the
   * deployment holding the scope's DO. 501 means "this app has no live-config support";
   * the caller treats that as authored-but-not-delivered, not as a failure.
   */
  configureInstance(scopeId: ScopeId, entries: Array<{ key: string; value: string }>): Promise<void> {
    return this.post(`/tenants/${this.tenantId}/scopes/${scopeId}/configure`, { entries });
  }

  /** provisioning → active, once the vertical has confirmed the scope exists. */
  activateScope(scopeId: ScopeId): Promise<void> {
    return this.post(`/tenants/${this.tenantId}/scopes/${scopeId}/activate`);
  }

  /**
   * Take a scope offline — suspend fails its `getScope` closed for every request (the
   * control plane's live weapon, control-plane.md §7). Reversible and audit-preserving.
   */
  suspendScope(scopeId: ScopeId): Promise<void> {
    return this.post(`/tenants/${this.tenantId}/scopes/${scopeId}/suspend`);
  }

  /**
   * Archive a scope — the terminal state for a DELETED app: offline (getScope fails
   * closed) and, unlike suspend, it releases the scope's slug so the name can be reused.
   * The record is retained (audit history), archived not erased.
   */
  archiveScope(scopeId: ScopeId): Promise<void> {
    return this.post(`/tenants/${this.tenantId}/scopes/${scopeId}/archive`);
  }

  /** Bind the default hostname so the router (reading this directory) can resolve it. */
  bindHostname(input: { hostname: string; scopeId: ScopeId; surface: string; canonical: boolean }): Promise<void> {
    return this.post('/hostnames', { tenantId: this.tenantId, region: null, ...input });
  }

  setHostnameStatus(hostname: string, status: 'active' | 'pending' | 'failed', note?: string): Promise<void> {
    return this.call(`/hostnames/${encodeURIComponent(hostname)}/status`, {
      method: 'PATCH',
      body: JSON.stringify({ status, note }),
    });
  }

  /**
   * The verticals this tenant OWNS (builder-plane.md Phase 4). The shared registry is
   * staff-wide over the service token, so filter to `ownerTenant === this.tenantId` here —
   * the dashboard's Deployments view shows a customer only their own pushed verticals.
   */
  async listVerticals(): Promise<
    Array<{ slug: string; name: string; source: string; ownerTenant: TenantId | null; listed?: boolean }>
  > {
    const all =
      (await this.call<Array<{ slug: string; name: string; source: string; ownerTenant: TenantId | null; listed?: boolean }>>(
        '/verticals',
      )) ?? [];
    return all.filter((v) => v.ownerTenant === this.tenantId);
  }

  /**
   * The shared plane's INSTALL catalog for this tenant (marketplace-publish.md §2): every
   * PUBLISHED vertical + this tenant's own, with the install-spec fields `createApp` needs.
   * The registry is staff-wide over the service token, so the visibility filter is here —
   * same posture as `listVerticals` above, plus the public (`listed`) tier.
   */
  async listCatalog(): Promise<
    Array<{ slug: string; name: string; source: string; owned: boolean; listed: boolean; entitlements?: string[]; ownerGrants?: string[]; envSpec?: unknown[] }>
  > {
    const all =
      (await this.call<
        Array<{ slug: string; name: string; source: string; ownerTenant: TenantId | null; listed?: boolean; entitlements?: string[]; ownerGrants?: string[]; envSpec?: unknown[] }>
      >('/verticals')) ?? [];
    return all
      .filter((v) => v.listed || v.ownerTenant === this.tenantId)
      .map((v) => ({
        slug: v.slug,
        name: v.name,
        source: v.source,
        owned: v.ownerTenant === this.tenantId,
        listed: !!v.listed,
        entitlements: v.entitlements,
        ownerGrants: v.ownerGrants,
        // The declared env-spec rides the registry too (manifest → push → here), so
        // the Env tab renders a form for a pushed vertical without loading its code.
        envSpec: v.envSpec,
      }));
  }

  /** A vertical's versions (admission state + deploymentRef). `[]` if it has none/unknown. */
  async listVersions(
    verticalSlug: string,
  ): Promise<
    Array<{ id: string; version: string; admission: string; admissionNote: string | null; deploymentRef: string | null; createdAt: string }>
  > {
    try {
      return (await this.call(`/verticals/${encodeURIComponent(verticalSlug)}/versions`)) ?? [];
    } catch {
      return [];
    }
  }

  /**
   * The vertical's release channels. Empty when it has no registered/promoted
   * versions — a static-binding vertical (like platform-owned Callout today), in
   * which case there is nothing to pin. `[]` on any non-200 so callers can treat
   * "no version" and "not registered" the same.
   */
  async listChannels(verticalSlug: string): Promise<Array<{ channel: string; versionId: string }>> {
    try {
      return (await this.call(`/verticals/${encodeURIComponent(verticalSlug)}/channels`)) ?? [];
    } catch {
      return [];
    }
  }

  /**
   * Every deployed service ref belonging to THIS tenant's verticals, mapped back to
   * (vertical, version). The ownership universe for the observability reads below:
   * a ref outside this map does not exist as far as this tenant is concerned.
   */
  private async ownedServiceRefs(): Promise<Map<string, { vertical: string; version: string }>> {
    const owned = new Map<string, { vertical: string; version: string }>();
    for (const v of await this.listVerticals()) {
      for (const ver of await this.listVersions(v.slug)) {
        if (ver.deploymentRef) owned.set(ver.deploymentRef, { vertical: v.slug, version: ver.version });
      }
    }
    return owned;
  }

  /**
   * Invocation metrics for this tenant's pushed verticals (design/observability.md §5,
   * view 2). The plane's `/observability/metrics` is staff-wide over the service token,
   * so the owner-narrowing is here — same posture as `listVerticals`: rows are kept only
   * for services that are a version of a vertical this tenant owns, and each is mapped
   * back to (vertical, version) so the UI never shows a bare deployment ref.
   * Throws `ControlPlaneError(501)` when the plane has no observability backend —
   * callers surface "not available", never an empty chart pretending to be zero traffic.
   */
  async observabilityMetrics(hours: number): Promise<
    Array<{
      vertical: string;
      version: string;
      service: string;
      requests: number;
      errors: number;
      subrequests: number;
      cpuTimeP50: number;
      cpuTimeP99: number;
    }>
  > {
    const owned = await this.ownedServiceRefs();
    if (owned.size === 0) return [];
    const all =
      (await this.call<
        Array<{ service: string; requests: number; errors: number; subrequests: number; cpuTimeP50: number; cpuTimeP99: number }>
      >(`/observability/metrics?hours=${hours}`)) ?? [];
    return all.filter((r) => owned.has(r.service)).map((r) => ({ ...r, ...owned.get(r.service)! }));
  }

  /**
   * Recent log events for ONE owned service. Ownership is checked BEFORE the plane is
   * asked — an unowned ref must never reach the staff-wide log query, and the answer
   * for one is `[]`, indistinguishable from a service with no logs (existence hiding,
   * the same property `listVerticals` narrowing gives the registry).
   */
  async observabilityLogs(input: {
    service: string;
    level?: string;
    hours?: number;
    limit?: number;
  }): Promise<
    Array<{ timestamp: number | null; level: string | null; message: string | null; service: string | null; outcome: string | null }>
  > {
    const owned = await this.ownedServiceRefs();
    if (!owned.has(input.service)) return [];
    const q = new URLSearchParams({ service: input.service });
    if (input.level) q.set('level', input.level);
    if (input.hours) q.set('hours', String(input.hours));
    if (input.limit) q.set('limit', String(input.limit));
    return (await this.call(`/observability/logs?${q.toString()}`)) ?? [];
  }

  /**
   * Point a channel at a version (builder-plane.md Phase 4). dev/staging always; `prod`
   * only for a PRIVATE vertical — the worker endpoint enforces that split (a listed
   * vertical's prod is staff again). Over the service token the shared plane treats this
   * as a staff promotion, so the caller's ownership of the slug must be checked FIRST
   * (`assertOwned`). `acknowledge` carries the digest-change confirmations the registry
   * demands when the permission/migration surface differs from what the channel serves.
   */
  promote(
    verticalSlug: string,
    channel: string,
    versionId: string,
    acknowledge?: { permissionChange?: boolean; migrationChange?: boolean },
  ): Promise<void> {
    return this.post(
      `/verticals/${encodeURIComponent(verticalSlug)}/channels/${encodeURIComponent(channel)}/promote`,
      { versionId, ...(acknowledge ? { acknowledge } : {}) },
    );
  }

  /** One channel's promotion timeline, newest first — the rollback picker's data. */
  async channelHistory(
    verticalSlug: string,
    channel: string,
  ): Promise<Array<{ id: string; versionId: string; fromVersionId: string | null; actor: string; at: string }>> {
    try {
      return (
        (await this.call(
          `/verticals/${encodeURIComponent(verticalSlug)}/channels/${encodeURIComponent(channel)}/history`,
        )) ?? []
      );
    } catch {
      return [];
    }
  }

  /**
   * Pin the scope to a vertical version, so the router dispatches on its
   * `deploymentRef` (orchestration.md §5.4). This is the ONE call that differs
   * between the static-binding bring-up and dynamic WfP dispatch — a scope with no
   * pinned version serves via the router's static `VERTICAL_<slug>` fallback, so
   * calling this only when a `prod` version exists keeps the dashboard identical
   * for both. Not tenant-narrowed in the wire shape beyond the pinned tenant path.
   */
  bindScopeVersion(scopeId: ScopeId, versionId: string, opts?: { snapshot?: boolean }): Promise<void> {
    return this.post(`/tenants/${this.tenantId}/scopes/${scopeId}/version`, {
      versionId,
      ...(opts?.snapshot ? { snapshot: true } : {}),
    });
  }

  /**
   * Mint a tenant-scoped CI push token (control-plane-api push-token.ts) — the
   * credential the git-import setup writes into a customer repo's Actions secrets.
   * Pinned to this tenant like everything here: the minted token authenticates as a
   * BUILDER for this tenant only, so the repo's CI can push `<tenantSlug>/…` versions
   * (landing pending) and nothing else — never the platform service token. 501 from
   * the CP when push tokens are not configured there.
   */
  mintPushToken(): Promise<{ token: string; tenantSlug: string }> {
    return this.post('/push-tokens', { tenantId: this.tenantId });
  }

  /**
   * Mirror a member's identity link into the shared directory (tenant-pinned).
   * The builder plane — `substrat login`'s whoami and the CLI push's session
   * auth — resolves `userId → tenants` against the SHARED plane's directory,
   * not this deployment's, so without this mirror an interactive push never
   * finds a workspace. Idempotent: re-linking the same member is a no-op.
   */
  linkIdentity(input: { provider: string; externalId: string; principal: PrincipalId; scopeId?: ScopeId }): Promise<void> {
    return this.call(`/tenants/${this.tenantId}/identities`, {
      method: 'PUT',
      body: JSON.stringify(input),
      idempotent: true,
    });
  }

  /** Sever the mirrored link (leave/remove/delete-team) — the inverse of `linkIdentity`. */
  unlinkIdentity(principal: PrincipalId): Promise<void> {
    return this.call(`/tenants/${this.tenantId}/identities/${principal}`, { method: 'DELETE', idempotent: true });
  }

  /** The pinned tenant's own shared-directory row, or null before it is mirrored. */
  async getTenant(): Promise<{ id: string; slug: string; name: string } | null> {
    try {
      return await this.call(`/tenants/${this.tenantId}`);
    } catch (e) {
      if (e instanceof ControlPlaneError && e.status === 404) return null;
      throw e;
    }
  }

  /**
   * Keep the shared directory's DISPLAY name in step with the team's — what the CLI
   * shows in its workspace picker. Never the slug: registry ids key on it.
   */
  setTenantName(name: string): Promise<void> {
    return this.call(`/tenants/${this.tenantId}`, { method: 'PATCH', body: JSON.stringify({ name }) });
  }

  // -- snapshots (preview-and-snapshots.md §3/§9) -----------------------------
  // Thin wrappers over the CP's orchestrated snapshot surface, tenant-pinned by
  // construction like everything else here. The CP does the data hop into the
  // app's own vertical deployment; the dashboard only ever sees directory rows.

  /** Fork an app's data into an archive scope; `expiresAt` opts into the GC sweep. */
  snapshotScope(scopeId: ScopeId, opts?: { expiresAt?: string }): Promise<{ id: string }> {
    return this.post(`/tenants/${this.tenantId}/scopes/${scopeId}/snapshots`, {
      ...(opts?.expiresAt ? { expiresAt: opts.expiresAt } : {}),
    });
  }

  /** The forks OF one scope — what the Snapshots tab lists. Newest first. */
  listSnapshots(scopeId: ScopeId): Promise<SnapshotRecord[]> {
    return this.call<SnapshotRecord[]>(`/tenants/${this.tenantId}/scopes/${scopeId}/snapshots`);
  }

  /** Reap one snapshot. The CP refuses anything that is not a fork (409). */
  deleteSnapshot(snapshotScopeId: ScopeId): Promise<void> {
    return this.call(`/tenants/${this.tenantId}/scopes/${snapshotScopeId}`, { method: 'DELETE' });
  }

  /** The PITR bookmarks a scope recorded before its migration passes (#286) —
   *  the rewind points the deployments tab offers for a backout. */
  migrationBookmarks(
    scopeId: ScopeId,
  ): Promise<Array<{ bookmark: string; takenAt: string; pending: string[] }>> {
    return this.call(`/tenants/${this.tenantId}/scopes/${scopeId}/bookmarks`);
  }

  /** #286's backout: rewind a scope to a pre-migration bookmark — schema AND data,
   *  discarding every write since. The scope DO enforces the 24h freshness window. */
  rewindScope(scopeId: ScopeId, bookmark: string): Promise<{ rewindingTo: string }> {
    return this.post(`/tenants/${this.tenantId}/scopes/${scopeId}/rewind`, { bookmark });
  }

  /** The hostnames bound to one scope (tenant-pinned) — the copy's preview URL. */
  listHostnames(scopeId: ScopeId): Promise<Array<{ hostname: string; status: string }>> {
    const q = new URLSearchParams({ tenantId: this.tenantId, scopeId });
    return this.call<Array<{ hostname: string; status: string }>>(`/hostnames?${q}`);
  }

  /**
   * The version a scope is ACTUALLY pinned to — what the router dispatches on
   * (`scope.verticalVersionId`), which is NOT the same as the vertical's prod channel:
   * an app installed when prod was 0.0.9 stays on 0.0.9 until it is rebound, even after
   * prod moves to 0.0.12. This read is what lets the dashboard show the true running
   * version and offer an update. `null` when the scope has no pinned version (static
   * binding) or can't be read (treated as "unknown, nothing to update").
   */
  async boundVersionId(scopeId: ScopeId): Promise<string | null> {
    try {
      const record = await this.call<{ verticalVersionId: string | null } | undefined>(
        `/tenants/${this.tenantId}/scopes/${scopeId}`,
      );
      return record?.verticalVersionId ?? null;
    } catch {
      return null;
    }
  }

  // -- read-only scope-DB introspection (§5.4 admin-query RPC; the Data tab) ---
  // Pinned to this tenant like every other call, so a scope id from another tenant
  // cannot be addressed — it fails closed below the seam (K-3) exactly as provisioning does.

  /** Every table in the scope's own database, with row counts. */
  listScopeTables(scopeId: ScopeId): Promise<ScopeTable[]> {
    return this.call(`/tenants/${this.tenantId}/scopes/${scopeId}/tables`);
  }

  /** A bounded page of one table of the scope's database. */
  readScopeTable(
    scopeId: ScopeId,
    input: { table: string; limit: number; offset: number },
  ): Promise<ScopeTablePage> {
    const q = new URLSearchParams({ limit: String(input.limit), offset: String(input.offset) });
    return this.call(
      `/tenants/${this.tenantId}/scopes/${scopeId}/tables/${encodeURIComponent(input.table)}?${q}`,
    );
  }

  /** One read-only SQL statement against the scope's database — the console (#219). */
  queryScope(scopeId: ScopeId, sql: string): Promise<ScopeQueryResult> {
    return this.call(`/tenants/${this.tenantId}/scopes/${scopeId}/query`, {
      method: 'POST',
      body: JSON.stringify({ sql }),
    });
  }
}
