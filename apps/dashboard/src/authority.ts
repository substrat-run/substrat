import type {
  AdminLogEntry,
  Connection,
  ConnectionActivity,
  ConnectionActivitySource,
  ConnectionCredential,
  ConnectionGrantRecord,
  ConnectionProbe,
  DeployAssets,
  DeployManifest,
  DeclaredOperationOutput,
  EmittedModel,
  IdentityLink,
  ListPage,
  OpsFailureEntry,
  SweepRunEntry,
  Page,
  HistoryEntry,
  EventFacetResult,
  PermissionRegistry,
  PlatformRequest,
  PrincipalId,
  Scope,
  ScopeDump,
  ScopeDumpTable,
  ScopeId,
  ScopeQueryResult,
  ScopeTable,
  ScopeTablePage,
  TenantId,
  VersionOrigin,
  OwnerSeat,
  OwnerClaimLink,
} from '@substrat-run/contracts';
import { LIST_PAGE_MAX } from '@substrat-run/contracts';

/**
 * Bytes of `&service=…` params one bucketed-metrics request may carry (#1236). A Workers
 * request URL is capped at 16 KB; a quarter of that leaves ample room for the base URL
 * and every other param, and a vertical's owned service refs grow with every push it has
 * ever made — so the ask batches rather than eventually becoming unsendable.
 */
const SERIES_URL_BUDGET = 4096;

/**
 * One list read, with the two facts about the READ that its rows cannot state.
 *
 * Every consumer of a bounded list read has to decide what the absence of a row
 * means, and only these flags answer it: rows + `complete: true` is the record;
 * rows + `complete: false` is a window with older rows behind it; `failed: true` is
 * no answer at all. The fleet rollup (#1238) turns each of those into a different
 * verdict, because rendering "I could not see" as "nothing is wrong" is the one
 * mistake the signals views exist to refuse.
 */
export interface ListRead<T> {
  entries: T[];
  complete: boolean;
  failed: boolean;
}

/** Filter for the ops-failure record. `since` windows it; the plane matches `at >= since`. */
export interface OpsFailureRead {
  vertical?: string;
  since?: string;
  limit?: number;
}

/** Filter for the sweep record (#1232). */
export interface SweepRunRead {
  kind?: 'connector' | 'schedule' | 'freshness';
  connectionId?: string;
  scopeId?: string;
  unit?: string;
  outcome?: 'ok' | 'failed' | 'skipped';
  since?: string;
  limit?: number;
}

/**
 * The tenant-narrowed platform authority — the crux of docs/architecture/dashboard.md §4.
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
    /**
     * The provider's own answer, when the plane refused a connect because the credential
     * was rejected upstream (#605, 422). Carried so a console can show WHY — "Scrive:
     * No valid access credentials were provided" — instead of a generic save failure.
     */
    readonly probe?: ConnectionProbe,
  ) {
    super(message);
    this.name = 'ControlPlaneError';
  }
}

/** One hostname binding as the CP returns it (a subset of contracts' HostnameBinding). */
/** A DNS record a tenant must publish for a custom domain (contracts' dnsRecord). */
export interface DnsRecordRow {
  type: 'hostname' | 'txt';
  name: string;
  value: string;
  status: string | null;
}

export interface HostnameBindingRow {
  hostname: string;
  scopeId: string;
  surface: string;
  status: string;
  statusNote?: string | null;
  canonical: boolean;
  createdAt: string;
  /** Cloudflare-for-SaaS issuance (§4.7): null for a platform mint. */
  customHostnameId?: string | null;
  /** DNS records to publish for a custom domain; empty for a platform mint. */
  validationRecords?: DnsRecordRow[];
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

/** One per-PR preview row, as the CP's `GET /verticals/:slug/previews` returns it. */
export interface PreviewRecord {
  scopeId: string;
  tag: string | null;
  versionId: string | null;
  forkedFrom: string | null;
  expiresAt: string | null;
  hostname: string | null;
  url: string | null;
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
          // The workspace this seam acts for (#417): the service token keeps its staff
          // reach, but vertical routes use this to resolve a bare slug to the tenant's
          // `<tenantSlug>/<name>` registry id — the id already-prefixed catalog slugs
          // pass through unchanged.
          'x-substrat-tenant': this.tenantId,
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
      const body = (await res.json().catch(() => null)) as
        | { error?: string; probe?: ConnectionProbe }
        | null;
      throw new ControlPlaneError(
        res.status,
        body?.error ?? `${res.status} ${res.statusText}`,
        body?.probe,
      );
    }
    return res.status === 204 ? (undefined as T) : ((await res.json().catch(() => undefined)) as T);
  }

  private post<T>(path: string, body?: unknown, idempotent = false): Promise<T> {
    return this.call<T>(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body), idempotent });
  }

  /**
   * GET one page of a CP list route — the platform-wide `{ entries, nextCursor }`
   * envelope (contracts pagination.ts), verbatim. A bare array from a pre-envelope
   * plane (deploy skew: the dashboard and the CP ship separately) is tolerated as
   * a single exhausted page.
   */
  private async page<T>(path: string, page: ListPage = {}): Promise<Page<T>> {
    const q = new URLSearchParams();
    if (page.limit !== undefined) q.set('limit', String(page.limit));
    if (page.cursor !== undefined) q.set('cursor', page.cursor);
    if (page.order !== undefined) q.set('order', page.order);
    const qs = q.toString();
    const url = qs ? `${path}${path.includes('?') ? '&' : '?'}${qs}` : path;
    const res = await this.call<Page<T> | T[] | undefined>(url);
    if (Array.isArray(res)) return { entries: res, nextCursor: null };
    return res ?? { entries: [], nextCursor: null };
  }

  /**
   * Walk a CP list route to completion (max-size pages, cursor followed until null).
   * The CP defaults every list read to one page now; internal callers of this class
   * (provisioning, catalogs, the observability ownership map) mean "everything", so
   * the complete-list semantics they were built on are preserved HERE, at the seam.
   */
  private async listAll<T>(path: string): Promise<T[]> {
    const all: T[] = [];
    let cursor: string | undefined;
    do {
      const { entries, nextCursor } = await this.page<T>(path, { limit: LIST_PAGE_MAX, cursor });
      all.push(...entries);
      cursor = nextCursor ?? undefined;
    } while (cursor !== undefined);
    return all;
  }

  /**
   * One FILTERED CP list read, walked as capped pages — and honest about what it saw.
   *
   * The route caps a page at `LIST_PAGE_MAX`, and a limit past the cap is a 400 the
   * skew guard below would swallow into `[]` — a panel silently blank, the exact
   * failure class these records exist to surface. So a larger ask is a CURSOR WALK of
   * capped pages, never one oversized request.
   *
   * The two facts beside the rows are what a plain array cannot carry, and what a
   * derivation that RANKS apps by these rows needs (#1238): `complete` is false when
   * the walk stopped at `limit` with a cursor still pending — there are older rows it
   * did not fetch, so its silence about an app means nothing. `failed` is the read
   * itself not happening, which is distinct from an empty window and the only case in
   * which zero rows may not be read as "nothing recorded".
   */
  private async walkList<T>(
    path: string,
    params: Record<string, string | undefined>,
    limit?: number,
  ): Promise<ListRead<T>> {
    const wanted = limit ?? LIST_PAGE_MAX;
    const entries: T[] = [];
    let cursor: string | undefined;
    try {
      while (entries.length < wanted) {
        const q = new URLSearchParams({ tenantId: this.tenantId });
        for (const [k, v] of Object.entries(params)) if (v !== undefined) q.set(k, v);
        q.set('limit', String(Math.min(wanted - entries.length, LIST_PAGE_MAX)));
        if (cursor !== undefined) q.set('cursor', cursor);
        const page = await this.call<Page<T> | T[] | undefined>(`${path}?${q.toString()}`);
        // A bare array is a pre-envelope plane (deploy skew): one exhausted page.
        if (Array.isArray(page)) return { entries: [...entries, ...page], complete: true, failed: false };
        entries.push(...(page?.entries ?? []));
        if (!page?.nextCursor) return { entries, complete: true, failed: false };
        cursor = page.nextCursor;
      }
      // `limit` reached with a cursor still pending: this read is a window, not the record.
      return { entries, complete: false, failed: false };
    } catch {
      // Deploy skew (a plane predating the route): no panel, never an error — and
      // never a clean bill of health either, which is what `failed` is for.
      return { entries, complete: false, failed: true };
    }
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

  /**
   * Add a SIBLING scope — a new "site" — to an app the pinned tenant already runs
   * (multi-scope self-serve, M1 of multi-scope-manyfold.md). The control plane authorizes it
   * by `parentScopeId` (which must be one of this tenant's scopes), inherits that app's
   * vertical + jurisdiction, and runs the full provision → materialize-instance → activate
   * sequence server-side — so the caller supplies only the new scope's identity and owner.
   */
  addSiblingScope(input: { scopeId: ScopeId; parentScopeId: ScopeId; owner: PrincipalId; slug: string; name: string }): Promise<void> {
    return this.post(`/tenants/${this.tenantId}/scopes`, input);
  }

  /**
   * Have the control plane call the vertical (K-31) to create the scope's data. The 201
   * body is RETURNED, not dropped (#426): `result` carries the vertical's non-secret
   * first-run facts (client id, migrations applied, …), which the install persists on
   * the app row — before this, the body's one chance to be seen ended right here.
   */
  provisionInstance(
    verticalSlug: string,
    input: { scopeId: ScopeId; owner: PrincipalId; slug: string; name: string; config?: Record<string, string> },
  ): Promise<{ result?: Record<string, string> } | undefined> {
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

  /**
   * The app's OWNER SEAT (#925) — claimed, or still empty (and whether a plain first sign-in
   * can still take it). Read from the vertical through the platform; 501 means the app's
   * deployment keeps no seat the platform can ask about.
   */
  ownerSeat(scopeId: ScopeId): Promise<OwnerSeat> {
    return this.call(`/tenants/${this.tenantId}/scopes/${scopeId}/owner-seat`);
  }

  /**
   * Mint a short-lived claim link for an unclaimed owner seat (#925). The answer is shown to
   * the installer ONCE and stored nowhere — the platform composed the URL on the app's own
   * hostname and the vertical holds only the token's hash.
   */
  mintOwnerClaim(scopeId: ScopeId): Promise<OwnerClaimLink> {
    return this.post(`/tenants/${this.tenantId}/scopes/${scopeId}/owner-claim`);
  }

  /**
   * The pinned tenant's provider connections in the SHARED plane's store — the one the
   * platform-run connectors (`connector:scrive` dispatch) actually open. Metadata only:
   * the `Connection` row cannot carry a secret. Distinct from the dashboard's own
   * directory, where its GitHub App connections live.
   */
  listConnections(filter: { vertical?: string; provider?: string; includeRevoked?: boolean } = {}): Promise<Connection[]> {
    const q = new URLSearchParams();
    if (filter.vertical) q.set('vertical', filter.vertical);
    if (filter.provider) q.set('provider', filter.provider);
    if (filter.includeRevoked) q.set('includeRevoked', '1');
    const qs = q.toString();
    return this.call<Connection[]>(`/tenants/${this.tenantId}/connections${qs ? `?${qs}` : ''}`);
  }

  /**
   * Upsert a provider credential (connections.md §3.5): no live connection for
   * (tenant, scope's vertical, provider, externalAccountRef) → create; one live → rotate
   * the secret in place, preserving the connection id and every grant tuple on it. The
   * vertical is re-derived control-plane-side from the scope record — never sent. The
   * plaintext lives for the length of this call; the plane seals it via SecretBox.
   */
  upsertConnection(input: {
    scopeId: ScopeId;
    provider: string;
    label?: string;
    externalAccountRef?: string;
    secret: Record<string, string>;
    grants?: string[];
    createdBy: string;
  }): Promise<{ connectionId: string; created: boolean; granted: string[]; probe?: ConnectionProbe }> {
    // #605: the plane checks the candidate against the provider BEFORE writing. A refused
    // credential comes back 422 (as a ControlPlaneError) and nothing is stored — which is
    // what keeps a bad rotation from replacing a working credential.
    return this.post(`/tenants/${this.tenantId}/connections`, input);
  }

  /**
   * Verify a stored credential against the provider (#605) — the plane opens the sealed
   * secret, spends one cheap authenticated read, and answers what the provider said.
   * A rejected credential is a 200 with `ok: false`; only an unwired provider (501) or
   * a platform fault is an error. Also refreshes the connection's health, because
   * verifying IS a use.
   */
  verifyConnection(connectionId: string): Promise<ConnectionProbe> {
    return this.post<ConnectionProbe>(
      `/tenants/${this.tenantId}/connections/${encodeURIComponent(connectionId)}/verify`,
    );
  }

  /**
   * What the connection has done (#605) — the connector's dispatch ledger, projected by
   * the connector itself (a raw ledger row can carry connector secrets). `live` asks the
   * provider for current state too, and the answer reports whether it got it.
   */
  connectionActivity(
    connectionId: string,
    opts: { live?: boolean; source?: ConnectionActivitySource } = {},
  ): Promise<ConnectionActivity> {
    const q = new URLSearchParams();
    if (opts.live) q.set('live', '1');
    if (opts.source) q.set('source', opts.source);
    const qs = q.toString();
    return this.call<ConnectionActivity>(
      `/tenants/${this.tenantId}/connections/${encodeURIComponent(connectionId)}/activity${qs ? `?${qs}` : ''}`,
    );
  }

  /**
   * The scope's platform-intent journal for ONE provider (#618) — the dispatches the platform
   * ran on this app's behalf, and what came back.
   *
   * A hosted vertical cannot run a connector itself: each delivery is routed as a
   * `connector:<provider>` intent and settled by the platform's drain, which journals the
   * provider's full answer in `lastError`. That journal is the only place the whole sentence
   * exists — the connection row keeps a one-line summary — so a card that reads "HTTP 409 from
   * scrive" has the rest of it right here.
   */
  scopeIntents(
    scopeId: string,
    filter: { kind?: string; limit?: number } = {},
  ): Promise<PlatformRequest[]> {
    const q = new URLSearchParams();
    if (filter.kind) q.set('kind', filter.kind);
    if (filter.limit) q.set('limit', String(filter.limit));
    const qs = q.toString();
    return this.call<PlatformRequest[]>(
      `/tenants/${this.tenantId}/scopes/${encodeURIComponent(scopeId)}/intents${qs ? `?${qs}` : ''}`,
    );
  }

  /**
   * The stored credential as a console may see it — identifiers whole, secrets masked by
   * the connector's own rule. Never usable as a credential; it exists so "connected" and
   * "connected with the wrong keys" stop looking identical.
   */
  connectionCredential(connectionId: string): Promise<ConnectionCredential> {
    return this.call<ConnectionCredential>(
      `/tenants/${this.tenantId}/connections/${encodeURIComponent(connectionId)}/credential`,
    );
  }

  /** The tenant's live connection grants — what each connection is allowed to invoke (#592). */
  listConnectionGrants(): Promise<ConnectionGrantRecord[]> {
    return this.call<ConnectionGrantRecord[]>(`/tenants/${this.tenantId}/connection-grants`);
  }

  /** Revoke a connection (terminal — the sealed secret is deleted, grants tombstone). */
  revokeConnection(connectionId: string): Promise<void> {
    return this.call(`/tenants/${this.tenantId}/connections/${encodeURIComponent(connectionId)}`, { method: 'DELETE' });
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

  /**
   * Bind a hostname so the router (reading this directory) can resolve it. Returns the
   * post-issuance row: a platform mint comes back `active`, a custom domain `verifying`
   * with the DNS records to publish (§4.7). The default-hostname bind at provision ignores
   * the return; the Domains UI reads it.
   */
  bindHostname(input: {
    hostname: string;
    scopeId: ScopeId;
    surface: string;
    canonical: boolean;
  }): Promise<HostnameBindingRow> {
    return this.call<HostnameBindingRow>('/hostnames', {
      method: 'POST',
      body: JSON.stringify({ tenantId: this.tenantId, region: null, ...input }),
    });
  }

  /**
   * Re-poll a custom domain's Cloudflare-for-SaaS issuance ("check again"). Tenant-pinned
   * like the rest of this class: the hostname must belong to one of the tenant's scopes,
   * which the control plane enforces (a foreign hostname reads as 404).
   */
  verifyHostname(hostname: string): Promise<HostnameBindingRow> {
    return this.call<HostnameBindingRow>(`/hostnames/${encodeURIComponent(hostname)}/verify`, {
      method: 'POST',
    });
  }

  /** Every hostname across all of this tenant's scopes — the account-level Domains list. */
  listTenantHostnames(): Promise<HostnameBindingRow[]> {
    const q = new URLSearchParams({ tenantId: this.tenantId });
    return this.listAll<HostnameBindingRow>(`/hostnames?${q}`);
  }

  /** One page of the tenant's hostnames (keyset on the hostname) — the paged Domains read. */
  listTenantHostnamesPage(page: ListPage): Promise<Page<HostnameBindingRow>> {
    const q = new URLSearchParams({ tenantId: this.tenantId });
    return this.page<HostnameBindingRow>(`/hostnames?${q}`, page);
  }

  /**
   * One page of the tenant's control-plane audit log (the append-only admin log,
   * control-plane.md §4.4), newest first (#479). `tenantId` is always pinned by this
   * seam, so the read can only ever see the caller's own tenant; `scope` narrows it
   * further to a single app's scope. `order: 'desc'` matches the console's read and the
   * dashboard's "newest first" framing — `nextCursor` (the last entry's id, ULID order)
   * then walks older entries.
   */
  auditLogPage(page: ListPage, scope?: ScopeId): Promise<Page<AdminLogEntry>> {
    const q = new URLSearchParams({ tenantId: this.tenantId, order: 'desc' });
    if (scope) q.set('scopeId', scope);
    return this.page<AdminLogEntry>(`/admin-log?${q}`, page);
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
    const all = await this.listAll<{ slug: string; name: string; source: string; ownerTenant: TenantId | null; listed?: boolean }>(
      '/verticals',
    );
    return all.filter((v) => v.ownerTenant === this.tenantId);
  }

  /**
   * The shared plane's INSTALL catalog for this tenant (marketplace-publish.md §2): every
   * PUBLISHED vertical + this tenant's own, with the install-spec fields `createApp` needs.
   * The registry is staff-wide over the service token, so the visibility filter is here —
   * same posture as `listVerticals` above, plus the public (`listed`) tier.
   */
  async listCatalog(): Promise<
    Array<{ slug: string; name: string; source: string; owned: boolean; listed: boolean; entitlements?: string[]; ownerGrants?: string[]; envSpec?: unknown[]; surfaces?: Array<{ name: string; label: string }>; provides?: string[]; requires?: string[] }>
  > {
    const all = await this.listAll<{ slug: string; name: string; source: string; ownerTenant: TenantId | null; listed?: boolean; entitlements?: string[]; ownerGrants?: string[]; envSpec?: unknown[]; surfaces?: Array<{ name: string; label: string }>; provides?: string[]; requires?: string[] }>(
      '/verticals',
    );
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
        // Declared surfaces ride the same way — the Domains tab's picker.
        surfaces: v.surfaces,
        // Declared capabilities ride too (#427) — install-time `oidc-issuer` binding
        // resolves providers/requirers off the registry row, pushed or builtin alike.
        provides: v.provides,
        requires: v.requires,
      }));
  }

  /** A vertical's versions (admission state + deploymentRef). `[]` if it has none/unknown. */
  async listVersions(
    verticalSlug: string,
  ): Promise<
    Array<{ id: string; version: string; admission: string; admissionNote: string | null; deploymentRef: string | null; origin?: VersionOrigin | null; createdAt: string }>
  > {
    try {
      return await this.listAll(`/verticals/${encodeURIComponent(verticalSlug)}/versions`);
    } catch {
      return [];
    }
  }

  /**
   * ONE page of a vertical's versions — the `{ entries, nextCursor }` envelope
   * verbatim, keyset on the version's ULID id (order flippable; the per-app
   * Deployments tab walks `desc` = newest first). An unknown/unowned slug reads
   * as an exhausted empty page, mirroring `listVersions`' `[]`.
   */
  async listVersionsPage(
    verticalSlug: string,
    page: ListPage,
  ): Promise<
    Page<{ id: string; version: string; admission: string; admissionNote: string | null; deploymentRef: string | null; origin?: VersionOrigin | null; createdAt: string }>
  > {
    try {
      return await this.page(`/verticals/${encodeURIComponent(verticalSlug)}/versions`, page);
    } catch {
      return { entries: [], nextCursor: null };
    }
  }

  /**
   * The declared permission registry (D-39, #336) of ONE version — keys+descriptions,
   * role templates, entity-grant shapes: the machine-readable PERMISSIONS.md that ships
   * inside the version's manifest. `null` for a version that retained no manifest (pushed
   * pre-#286) or declared no surface. Read by the app's Permissions tab; `null` on any
   * non-200 so the caller treats "unknown" and "no surface" the same.
   */
  async versionRegistry(verticalSlug: string, versionId: string): Promise<PermissionRegistry | null> {
    try {
      const res = await this.call<{ registry: PermissionRegistry | null }>(
        `/verticals/${encodeURIComponent(verticalSlug)}/versions/${encodeURIComponent(versionId)}/registry`,
      );
      return res?.registry ?? null;
    } catch {
      return null;
    }
  }

  /**
   * The emitted entity model (#1214) one version ships — entities, field schemas, parent
   * edges, declared lifecycles — out of the same retained manifest as the registry above.
   * `null` for a version pushed by a pre-#1214 CLI or a vertical with no model.json;
   * `null` on any non-200, so the caller treats "unknown" and "none" the same.
   */
  /** The declared schedules of one version (#1232) — null on skew or a pre-field push. */
  async versionSchedules(
    verticalSlug: string,
    versionId: string,
  ): Promise<{
    schedules: DeployManifest['schedules'] | null;
    freshness: DeployManifest['freshness'] | null;
  }> {
    try {
      const res = await this.call<{
        schedules: DeployManifest['schedules'] | null;
        freshness?: DeployManifest['freshness'] | null;
      }>(`/verticals/${encodeURIComponent(verticalSlug)}/versions/${encodeURIComponent(versionId)}/schedules`);
      return { schedules: res?.schedules ?? null, freshness: res?.freshness ?? null };
    } catch {
      return { schedules: null, freshness: null };
    }
  }

  async versionModel(verticalSlug: string, versionId: string): Promise<EmittedModel | null> {
    return (await this.versionModelSurface(verticalSlug, versionId)).model;
  }

  /**
   * The emitted model AND what each operation declares it returns (#1321), from
   * one read — they are stored side by side on the retained manifest, and the
   * field-coverage view needs both to say which declared fields nothing returns.
   * Null on any non-200, so "unknown" and "none" stay the same answer here, as
   * everywhere else that reads a retained manifest.
   */
  async versionModelSurface(
    verticalSlug: string,
    versionId: string,
  ): Promise<{ model: EmittedModel | null; outputSurface: DeclaredOperationOutput[] | null }> {
    try {
      const res = await this.call<{
        model: EmittedModel | null;
        outputSurface?: DeclaredOperationOutput[] | null;
      }>(`/verticals/${encodeURIComponent(verticalSlug)}/versions/${encodeURIComponent(versionId)}/model`);
      return { model: res?.model ?? null, outputSurface: res?.outputSurface ?? null };
    } catch {
      return { model: null, outputSurface: null };
    }
  }

  /**
   * The static files (#340) one version ships — path, size, content type, content address —
   * out of the same retained manifest the registry read above uses. `null` for a version that
   * retained no manifest or shipped no static files; `null` on any non-200, so the caller
   * treats "unknown" and "none" the same, exactly like `versionRegistry`.
   */
  async versionAssets(verticalSlug: string, versionId: string): Promise<DeployAssets | null> {
    try {
      const res = await this.call<{ assets: DeployAssets | null }>(
        `/verticals/${encodeURIComponent(verticalSlug)}/versions/${encodeURIComponent(versionId)}/assets`,
      );
      return res?.assets ?? null;
    } catch {
      return null;
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
      return await this.listAll(`/verticals/${encodeURIComponent(verticalSlug)}/channels`);
    } catch {
      return [];
    }
  }

  /**
   * Every service ref that can carry THIS tenant's traffic, mapped back to
   * (vertical, version). The ownership universe for the observability reads below:
   * a ref outside this map does not exist as far as this tenant is concerned.
   *
   * TWO ref schemes live here (both since #286):
   * - Per-version archive scripts (`<slug>-<ulid>`, `version.deploymentRef`): the push
   *   archive — readiness probes address them, but they do NOT serve production traffic.
   * - The stable serving script (`<slug>`, `scope.servingRef`): where real traffic and
   *   the scope's Durable Objects live. The router dispatches on `scope.servingRef`, so
   *   Cloudflare records invocations under THIS name. Omitting it is why the per-version
   *   view read empty — every real-traffic row was filtered out (the archive refs it
   *   knew about serve ~zero requests). The serving ref's version now comes from the
   *   registry's own `servingVersionId` via `/service-refs`, not from a scope-derived
   *   guess — the stable script runs one code version, and the registry names it.
   */
  private async ownedServiceRefs(): Promise<{
    owned: Map<string, { vertical: string; version: string; versionId: string | null }>;
    /** The resolver capped its vertical fan-out — the map below is INCOMPLETE. */
    truncated: boolean;
  }> {
    // The JOIN moved behind the plane (#1231's last item): GET /service-refs is the
    // one implementation of "what a service ref means", forced-filtered to this
    // tenant, answering the registry's own servingVersionId for the serving script —
    // authoritative where the scope-derived guess this method used to make was an
    // approximation. What STAYS here is ownership narrowing: the map is still the
    // universe, and the pre-flight gates below still keep unowned refs from ever
    // reaching the plane's staff-wide observability routes.
    const owned = new Map<string, { vertical: string; version: string; versionId: string | null }>();
    const res = await this.call<{
      entries: Array<{
        service: string;
        role: 'archive' | 'serving';
        stamp: { vertical?: string; version?: string };
        versionLabel: string | null;
      }>;
      verticalsTruncated?: boolean;
    }>(`/service-refs?tenantId=${encodeURIComponent(this.tenantId)}`);
    for (const e of res?.entries ?? []) {
      if (!e.stamp.vertical) continue;
      // The serving script wins over an archive ref of the same name (they never
      // collide by construction, but the map must not depend on entry order).
      if (owned.has(e.service) && e.role !== 'serving') continue;
      owned.set(e.service, {
        vertical: e.stamp.vertical,
        // '—' keeps the UI's placeholder contract for an unlabellable version.
        version: e.versionLabel ?? '—',
        versionId: e.stamp.version ?? null,
      });
    }
    return { owned, truncated: res?.verticalsTruncated === true };
  }

  /**
   * The same invocations bucketed over time (#1236) — the series a chart plots.
   * Owner-narrowed the same way `observabilityMetrics` is, with one difference
   * that matters: the owned service names are pushed DOWN to the plane as the
   * `service` filter, because a bucketed fleet read is scripts × buckets and a
   * tenant has no business paying for (or seeing) the rest of the fleet's rows.
   * Throws `ControlPlaneError(501)` when the plane cannot bucket — the caller
   * renders "not available", never an empty chart that reads as silence.
   */
  async observabilityMetricsSeries(
    hours: number,
    vertical?: string,
  ): Promise<Array<{ versionId: string | null; version: string; start: string; bucketMinutes: number; requests: number; errors: number }>> {
    const refs = await this.ownedServiceRefs();
    if (refs.truncated) {
      throw new ControlPlaneError(503, 'service map truncated: too many verticals to resolve in one answer');
    }
    let owned = refs.owned;
    if (vertical !== undefined) {
      owned = new Map([...owned].filter(([, v]) => v.vertical === vertical));
    }
    if (owned.size === 0) return [];
    // One request per URL-sized batch of service names, merged. A vertical's owned refs
    // grow with every push it has ever made and nothing caps them, while a Workers
    // request URL is capped at 16 KB — so a long-lived vertical would eventually send an
    // unsendable URL and its chart would read as "not available". Batching by BYTES
    // rather than a count is what keeps that true whatever the names are.
    const batches: string[][] = [[]];
    let budget = SERIES_URL_BUDGET;
    for (const service of owned.keys()) {
      const cost = `&service=${encodeURIComponent(service)}`.length;
      if (budget - cost < 0 && batches[batches.length - 1]!.length > 0) {
        batches.push([]);
        budget = SERIES_URL_BUDGET;
      }
      batches[batches.length - 1]!.push(service);
      budget -= cost;
    }
    const pages = await Promise.all(
      batches.map((services) => {
        const q = new URLSearchParams({ hours: String(hours) });
        for (const service of services) q.append('service', service);
        return this.call<Array<{ service: string; start: string; bucketMinutes: number; requests: number; errors: number }>>(
          `/observability/metrics-series?${q.toString()}`,
        );
      }),
    );
    const rows = pages.flatMap((page) => page ?? []);
    // The narrowing is re-applied on the way back, not trusted from the request:
    // the plane is staff-wide over the service token, so an unowned row that
    // slipped into the answer must not reach a tenant's chart.
    return rows
      .filter((r) => owned.has(r.service))
      .map((r) => ({
        versionId: owned.get(r.service)!.versionId,
        version: owned.get(r.service)!.version,
        start: r.start,
        bucketMinutes: r.bucketMinutes,
        requests: r.requests,
        errors: r.errors,
      }));
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
  async observabilityMetrics(hours: number, vertical?: string): Promise<
    Array<{
      vertical: string;
      version: string;
      /** The registry ULID — the signals `version` dimension; label above is display. */
      versionId: string | null;
      service: string;
      requests: number;
      errors: number;
      subrequests: number;
      cpuTimeP50: number;
      cpuTimeP99: number;
    }>
  > {
    const refs = await this.ownedServiceRefs();
    // The resolver said its answer is incomplete (a >cap vertical fan-out). A chart
    // over a partial ownership map reads as "the missing verticals had no traffic" —
    // the silent-drop the resolver reports truncation to prevent — so refuse loudly
    // instead; the UI surfaces the message rather than a wrong zero.
    if (refs.truncated) {
      throw new ControlPlaneError(503, 'service map truncated: too many verticals to resolve in one answer');
    }
    let owned = refs.owned;
    // The per-app tab's filter: not a query param the plane ever sees — the ownership
    // map itself is narrowed to the one vertical, so a slug this tenant doesn't own
    // short-circuits to [] exactly like owning nothing at all.
    if (vertical !== undefined) {
      owned = new Map([...owned].filter(([, v]) => v.vertical === vertical));
    }
    if (owned.size === 0) return [];
    const all =
      (await this.call<
        Array<{ service: string; requests: number; errors: number; subrequests: number; cpuTimeP50: number; cpuTimeP99: number }>
      >(`/observability/metrics?hours=${hours}`)) ?? [];
    // Field-by-field, not a spread: the seam's row also carries `namespace` (the
    // Cloudflare dispatch namespace), which the declared type omitted while the
    // spread leaked it to the tenant UI at runtime. Explicit is the fix.
    return all
      .filter((r) => owned.has(r.service))
      .map((r) => ({
        ...owned.get(r.service)!,
        service: r.service,
        requests: r.requests,
        errors: r.errors,
        subrequests: r.subrequests,
        cpuTimeP50: r.cpuTimeP50,
        cpuTimeP99: r.cpuTimeP99,
      }));
  }

  /**
   * Recent log events for owned services — one, or a vertical's whole set (the tab's
   * "all versions", which the plane answers as one merged newest-first stream).
   * Ownership is checked BEFORE the plane is asked: unowned refs are dropped here, so
   * they never reach the staff-wide log query, and a request for nothing but unowned
   * refs answers `[]`, indistinguishable from services with no logs (existence hiding,
   * the same property `listVerticals` narrowing gives the registry).
   */
  async observabilityLogs(input: {
    services: string[];
    level?: string;
    search?: string;
    hours?: number;
    limit?: number;
  }): Promise<
    Array<{
      timestamp: number | null;
      level: string | null;
      message: string | null;
      service: string | null;
      outcome: string | null;
      trigger: string | null;
      invocation: string | null;
      entrypoint: string | null;
      requestId: string | null;
      cpuTimeMs: number | null;
      wallTimeMs: number | null;
      raw: unknown;
    }>
  > {
    const refs = await this.ownedServiceRefs();
    // Same refusal as observabilityMetrics: a partial ownership map here would
    // silently drop a legitimately owned service from the ask.
    if (refs.truncated) {
      throw new ControlPlaneError(503, 'service map truncated: too many verticals to resolve in one answer');
    }
    const services = input.services.filter((s) => refs.owned.has(s));
    if (services.length === 0) return [];
    const q = new URLSearchParams();
    for (const s of services) q.append('service', s);
    if (input.level) q.set('level', input.level);
    if (input.search) q.set('search', input.search);
    if (input.hours) q.set('hours', String(input.hours));
    if (input.limit) q.set('limit', String(input.limit));
    const events =
      (await this.call<
        Array<{
          timestamp?: unknown;
          level?: unknown;
          message?: unknown;
          service?: unknown;
          outcome?: unknown;
          trigger?: unknown;
          invocation?: unknown;
          entrypoint?: unknown;
          requestId?: unknown;
          cpuTimeMs?: unknown;
          wallTimeMs?: unknown;
          raw?: unknown;
        }>
      >(`/observability/logs?${q.toString()}`)) ?? [];
    // A builder only ever reaches an OWNED service here (checked above), so the event —
    // `raw` included — is already this tenant's own telemetry: passing the whole thing
    // through is a deliberate widening (the drill-down the per-app tab renders), not a
    // leak. The one narrowing that remains is the ownership gate, not the field set.
    const str = (v: unknown) => (typeof v === 'string' ? v : null);
    const num = (v: unknown) => (typeof v === 'number' ? v : null);
    return events.map((e) => ({
      timestamp: num(e.timestamp),
      level: str(e.level),
      message: str(e.message),
      service: str(e.service),
      outcome: str(e.outcome),
      trigger: str(e.trigger),
      invocation: str(e.invocation),
      entrypoint: str(e.entrypoint),
      requestId: str(e.requestId),
      cpuTimeMs: num(e.cpuTimeMs),
      wallTimeMs: num(e.wallTimeMs),
      raw: e.raw,
    }));
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

  /**
   * Delete a vertical + its versions and channels from the shared registry. Over the
   * service token this is a staff-level act, so the caller's ownership of the slug must
   * be checked FIRST (`assertOwned`), same as `promote`. The plane refuses while any
   * scope still runs it — that refusal (naming the count) surfaces verbatim.
   */
  deleteVertical(verticalSlug: string): Promise<void> {
    return this.call<void>(`/verticals/${encodeURIComponent(verticalSlug)}`, { method: 'DELETE' });
  }

  /**
   * This tenant's operational-failure rows (#559 step 5) — why a deploy, preview, or
   * provision failed, newest first, each carrying the upstream `reference = <id>` when
   * one was extracted. Tenant-pinned HERE: the service token has staff reach, so the
   * forced `tenantId` is this seam's narrowing, not the CP's builder rule. Tolerated
   * to empty against a plane predating the route (deploy skew).
   */
  async listOpsFailures(filter: OpsFailureRead = {}): Promise<OpsFailureEntry[]> {
    return (await this.readOpsFailures(filter)).entries;
  }

  /**
   * The same read, carrying whether it saw everything (`walkList`). A caller that
   * RANKS apps by what these rows say — the fleet rollup (#1238) — must be able to
   * tell "nothing is recorded" from "I did not reach the end of the record".
   */
  readOpsFailures(filter: OpsFailureRead = {}): Promise<ListRead<OpsFailureEntry>> {
    return this.walkList<OpsFailureEntry>(
      '/ops-failures',
      { vertical: filter.vertical, since: filter.since },
      filter.limit,
    );
  }

  /**
   * The sweep record for this tenant (#1232), newest first — when each connection was
   * last swept and how it went, the recent-runs strip's data. Tenant-pinned and
   * deploy-skew-tolerant exactly as `listOpsFailures` above.
   */
  async listSweepRuns(filter: SweepRunRead = {}): Promise<SweepRunEntry[]> {
    return (await this.readSweepRuns(filter)).entries;
  }

  /** The same read, carrying whether it saw everything — `readOpsFailures`'s reason. */
  readSweepRuns(filter: SweepRunRead = {}): Promise<ListRead<SweepRunEntry>> {
    return this.walkList<SweepRunEntry>(
      '/sweep-runs',
      {
        kind: filter.kind,
        connectionId: filter.connectionId,
        scopeId: filter.scopeId,
        unit: filter.unit,
        outcome: filter.outcome,
        since: filter.since,
      },
      filter.limit,
    );
  }

  /** One channel's promotion timeline, newest first — the rollback picker's data. */
  async channelHistory(
    verticalSlug: string,
    channel: string,
  ): Promise<Array<{ id: string; versionId: string; fromVersionId: string | null; actor: string; at: string }>> {
    try {
      return await this.listAll(
        `/verticals/${encodeURIComponent(verticalSlug)}/channels/${encodeURIComponent(channel)}/history`,
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

  /**
   * Assign an already-DEFINED role to a principal in the shared directory (#1343),
   * at the TENANT node — which is what a team membership is, and all the route
   * offers. There is no `scopeId`: the whole node comes from the path, because a
   * node carrying a scope is written to that scope's DO with no tenant
   * cross-check below it, so accepting one here would be a cross-tenant write.
   *
   * Defining what a role MEANS stays off this seam deliberately — that is a
   * permission change, and the permission diff is a human checkpoint (D-22/D-29).
   */
  assignRole(input: { principalId: PrincipalId; roleKey: string }): Promise<void> {
    return this.post(`/tenants/${this.tenantId}/role-assignments`, input);
  }

  /** Revoke an assignment — tombstoned (K-21), idempotent, so a retry is safe. */
  unassignRole(input: { principalId: PrincipalId; roleKey: string }): Promise<void> {
    return this.call(`/tenants/${this.tenantId}/role-assignments`, {
      method: 'DELETE',
      body: JSON.stringify(input),
      idempotent: true,
    });
  }

  /** Create an org under this tenant — the portal-customer grouping (§4.1). */
  createOrg(input: { id: string; slug: string; name: string }): Promise<void> {
    return this.post(`/tenants/${this.tenantId}/orgs`, input);
  }

  /** The tenant's orgs, as the shared directory holds them. */
  listOrgs(): Promise<Array<{ id: string; slug: string; name: string }>> {
    return this.call(`/tenants/${this.tenantId}/orgs`);
  }

  /**
   * What the SHARED directory currently links for this tenant (#1343) — the read
   * half of a seam that only ever had a write half. Without it the mirror's
   * completeness was unknowable from the dashboard: it wrote and never looked,
   * and its `catch` swallowed the failures. Retiring the local directory is a
   * live-data move, and a move cannot be planned against a belief.
   */
  listIdentityLinks(): Promise<IdentityLink[]> {
    return this.call(`/tenants/${this.tenantId}/identities`);
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

  // -- per-PR previews (preview-and-snapshots.md §2/§9) -----------------------
  // The CP's builder-facing preview routes, reached over the service token: the
  // `x-substrat-tenant` header this class always sends resolves the bare vertical
  // slug to this tenant's `<tenantSlug>/<slug>` registry id (#417), so the webhook
  // DO speaks the same route CI's `substrat preview` does — no parallel surface.

  /** The live previews of a vertical (fork + PR version + `--<tag>` URL each). */
  listPreviews(verticalSlug: string): Promise<PreviewRecord[]> {
    return this.call<PreviewRecord[]>(`/verticals/${encodeURIComponent(verticalSlug)}/previews`);
  }

  /**
   * Create (or reuse, per `tag`) a preview of an already-pushed version — the builder
   * surface behind the dashboard's Previews/Environments panel. The browser doesn't build,
   * so it names an existing `versionId` rather than pushing a tree the way `substrat preview
   * create` does; everything else is the same route. `ttlHours: null` PINS it (a long-lived
   * test environment); `empty` provisions a clean-room scope when there is no prod to fork.
   */
  createPreview(
    verticalSlug: string,
    input: {
      tag: string;
      versionId: string;
      ttlHours?: number | null;
      empty?: boolean;
      sourceScopeId?: ScopeId;
      surface?: string;
      refresh?: boolean;
    },
  ): Promise<{ scopeId: string; hostname: string; url: string; versionId: string; reused: boolean }> {
    return this.post(`/verticals/${encodeURIComponent(verticalSlug)}/previews`, input);
  }

  /** Reap one preview by tag. Idempotent on the CP: already-gone ⇒ `deleted: null`. */
  deletePreview(verticalSlug: string, tag: string): Promise<{ deleted: string | null }> {
    return this.call(`/verticals/${encodeURIComponent(verticalSlug)}/previews/${encodeURIComponent(tag)}`, {
      method: 'DELETE',
    });
  }

  /** When this app's migrations actually ran (#1236) — its schema history,
   *  newest first. Tolerated to empty against a plane predating the route. */
  /**
   * Null when the read FAILED, `[]` when the app genuinely has no migrations —
   * a distinction this swallowed until a review caught it. Both are real states:
   * a module may register `migrations: []`, and a deployment predating
   * `/internal/migrations` (or any transient plane fault) answers neither. Reading
   * empty as "unreadable" invented a cause; reading unreadable as empty hid one.
   */
  async appliedMigrations(
    scopeId: ScopeId,
  ): Promise<Array<{ moduleId: string; version: string; appliedAt: string | null }> | null> {
    try {
      return (await this.call(`/tenants/${this.tenantId}/scopes/${scopeId}/migrations`)) ?? null;
    } catch {
      return null;
    }
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

  // -- export / restore (preview-and-snapshots.md §8 — the dashboard half) ----
  // The CLI's `scope pull`/`scope restore` seam, reached tenant-pinned. The CP is
  // the gate on both: the export lands MASKED (this client never sends `?full=true` —
  // the break-glass stays a staff/CLI affordance) and jurisdiction-gated; the
  // restore is audited on the shared plane and delegated into the deployment that
  // actually serves the scope.

  /** The scope's data as a dump — always the masked form from this seam. */
  exportScope(scopeId: ScopeId): Promise<ScopeDump & { masked: boolean }> {
    return this.call(`/tenants/${this.tenantId}/scopes/${scopeId}/export`);
  }

  /**
   * Load a dump into the app's EXISTING scope, replacing its data wholesale.
   * tenantId/scopeId in the body are provenance; the URL says where it lands.
   */
  restoreScope(scopeId: ScopeId, tables: ScopeDumpTable[]): Promise<{ restored: string; tables: number }> {
    return this.post(`/tenants/${this.tenantId}/scopes/${scopeId}/restore`, {
      tenantId: this.tenantId,
      scopeId,
      // boundary-lint-allow R6
      // Host-driving code, not module code: this is the app calling INTO a scope
      // from outside, so there is no operation whose instant to borrow. The value
      // is provenance on a dump ("when was this captured"), which is a real
      // wall-clock fact about the export, not a stamp on a row inside a transaction.
      capturedAt: new Date().toISOString(),
      // boundary-lint-end R6
      tables,
    });
  }

  /** The hostnames bound to one scope (tenant-pinned) — the Domains list and
   *  the copy's preview URL. Full binding rows: the surface/canonical/status columns
   *  are exactly what the settings section renders. */
  listHostnames(scopeId: ScopeId): Promise<HostnameBindingRow[]> {
    const q = new URLSearchParams({ tenantId: this.tenantId, scopeId });
    return this.listAll<HostnameBindingRow>(`/hostnames?${q}`);
  }

  /**
   * Unbind one hostname FROM ONE OF THIS TENANT'S SCOPES. The CP's DELETE is
   * staff-wide over the service token, so the narrowing is here, like everything
   * else in this class: the hostname must appear in the pinned tenant's own scope's
   * bindings before the delete is sent — a foreign hostname reads as not bound,
   * never as deletable.
   */
  async unbindHostname(scopeId: ScopeId, hostname: string): Promise<void> {
    const own = await this.listHostnames(scopeId);
    if (!own.some((h) => h.hostname === hostname.toLowerCase())) {
      throw new ControlPlaneError(404, `hostname '${hostname}' is not bound to this app`);
    }
    return this.call(`/hostnames/${encodeURIComponent(hostname)}`, { method: 'DELETE' });
  }

  /**
   * Release EVERY hostname bound to one of this tenant's scopes — the delete-app
   * cleanup. The rows come from the tenant-pinned list, so the narrowing above holds
   * without a per-name re-check; the CP's DELETE releases a custom domain's Cloudflare
   * object too, so a name freed here can re-bind cleanly elsewhere.
   */
  async unbindScopeHostnames(scopeId: ScopeId): Promise<void> {
    for (const h of await this.listHostnames(scopeId)) {
      await this.call(`/hostnames/${encodeURIComponent(h.hostname)}`, { method: 'DELETE' });
    }
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

  /**
   * The DIRECTORY's status for a scope — the platform's authoritative record, read
   * for reconciling the dashboard's own install row against it (#424 case 4: a
   * retried install can leave the dashboard row at 'provisioning' forever while the
   * directory has been 'active' all along). Carries the scope's `vertical` too — a
   * staff rebind-vertical moves a scope onto a different lineage and only the
   * directory knows (#389); the read-path reconcile heals the row's slug from it.
   * `null` when the scope can't be read — callers treat that as "unknown, change nothing".
   */
  async scopeStatus(
    scopeId: ScopeId,
  ): Promise<{ status: string; servingRef: string | null; vertical: string | null } | null> {
    try {
      const record = await this.call<
        { status: string; servingRef: string | null; vertical: string | null } | undefined
      >(`/tenants/${this.tenantId}/scopes/${scopeId}`);
      return record
        ? { status: record.status, servingRef: record.servingRef ?? null, vertical: record.vertical ?? null }
        : null;
    } catch {
      return null;
    }
  }

  /**
   * The tenant's scopes for one vertical — the Data tab's scope switcher (M4 of
   * multi-scope-manyfold.md). Tenant-pinned: the CP filters by (tenant, vertical) so this only
   * ever returns THIS tenant's scopes. A multi-scope vertical (e.g. Manyfold: one site per
   * scope) returns several; a single-scope app, just the one.
   */
  listScopes(vertical: string): Promise<Scope[]> {
    const q = new URLSearchParams({ tenantId: this.tenantId, vertical });
    return this.listAll<Scope>(`/scopes?${q}`);
  }

  // -- read-only scope-DB introspection (§5.4 admin-query RPC; the Data tab) ---
  // Pinned to this tenant like every other call, so a scope id from another tenant
  // cannot be addressed — it fails closed below the seam (K-3) exactly as provisioning does.

  /** Every table in the scope's own database, with row counts. */
  listScopeTables(scopeId: ScopeId): Promise<ScopeTable[]> {
    return this.call(`/tenants/${this.tenantId}/scopes/${scopeId}/tables`);
  }

  /**
   * Facets over one app's outbox (#1239) — narrow, group, count. The erased-payload
   * rule lives in the kernel helper below the seam: a shredded event is counted
   * apart rather than folded into a "no value" bucket.
   */
  facetEvents(
    scopeId: ScopeId,
    input: { groupBy: string; field?: string; type?: string; since?: string; until?: string; limit?: number },
  ): Promise<EventFacetResult> {
    const q = new URLSearchParams();
    if (input.field !== undefined) q.set('field', input.field);
    else q.set('groupBy', input.groupBy);
    if (input.type !== undefined) q.set('type', input.type);
    // BOTH bounds, or the window is only half a window. `until` is the one parameter
    // whose loss is invisible: the query still succeeds and simply answers about a
    // wider slice than the caller asked about, which reads as a real distribution.
    if (input.since !== undefined) q.set('since', input.since);
    if (input.until !== undefined) q.set('until', input.until);
    if (input.limit !== undefined) q.set('limit', String(input.limit));
    return this.call(`/tenants/${this.tenantId}/scopes/${scopeId}/facets?${q}`);
  }

  /**
   * One record's event history (#1235) — `readHistory`'s answer, through the
   * platform. Cursor-paged rather than offset-paged, unlike the table read below:
   * the outbox pages by id, so an event arriving mid-walk cannot shift a page
   * boundary and duplicate or skip an entry.
   */
  entityHistory(
    scopeId: ScopeId,
    input: { entityType: string; entityId: string; limit?: number; cursor?: string },
  ): Promise<Page<HistoryEntry>> {
    const q = new URLSearchParams({ entityType: input.entityType, entityId: input.entityId });
    if (input.limit !== undefined) q.set('limit', String(input.limit));
    if (input.cursor !== undefined) q.set('cursor', input.cursor);
    return this.call(`/tenants/${this.tenantId}/scopes/${scopeId}/history?${q}`);
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
