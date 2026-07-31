import type {
  EntitlementGrant,
  PlatformRequest,
  PlatformRequestId,
  PlatformRequestStatus,
  PrincipalId,
  QueryScopeInput,
  ReadScopeTableInput,
  ScopeDumpTable,
  ScopeId,
  ScopeQueryResult,
  ScopeTable,
  ScopeTablePage,
  TenantId,
  TenantStoreHandle,
} from '@substrat-run/contracts';
import { PLATFORM_SECRET_HEADER } from '@substrat-run/kernel';
import { ControlPlaneError } from './client.js';

/**
 * The platform's client for calling a VERTICAL (K-31).
 *
 * The mirror of `ControlPlaneClient`, pointing the other way, and the direction
 * matters: that one is a vertical talking up to the platform, this is the platform
 * telling a vertical to do something. K-31 makes this the authoritative direction,
 * because only the vertical can create a usable scope DO — the DO class bundles the
 * modules and lives in the vertical's own deployment.
 *
 * Deliberately tiny. The platform asks a vertical to do three kinds of thing: create an
 * instance (K-31); — read-only — introspect a scope's own database (§5.4), because the
 * scope's data DO lives in the vertical's deployment, not the platform's; and manage
 * scope-STORAGE lifecycle — snapshot a scope into a sibling, wipe a reaped fork
 * (preview-and-snapshots.md §9, the ratified trust line: infrastructure verbs over the
 * DO's storage, extending the authority provisionInstance already asserts). Every other
 * verb — anything that reads or writes DOMAIN data — would be authority the platform
 * holds over someone else's code. Note the lifecycle verbs move no data across the
 * boundary: a snapshot copies between two DOs inside the vertical's own deployment and
 * returns only a table count.
 */

export interface VerticalClientOptions {
  /**
   * How to reach the vertical. A Worker service binding's `fetch` when deployed —
   * the vertical has no public route (K-26/K-27), so this is the only ingress — or
   * plain `fetch` against a URL locally.
   */
  fetch: typeof fetch;
  /** Base URL. With a service binding the host is ignored, but `Request` needs one. */
  baseUrl?: string;
  /** Shared secret the vertical verifies with `assertPlatformCall`. */
  platformSecret: string;
}

export interface ProvisionInstanceInput {
  tenantId: TenantId;
  scopeId: ScopeId;
  /** The first admin — whoever asked for the instance. */
  owner: PrincipalId;
  slug: string;
  name: string;
  /**
   * Per-instance config delivered WITH provisioning, so a new app arrives configured
   * atomically — no window where the instance is live but unconfigured (an issuer with
   * no admin, an app with no auth). Same entries `configureInstance` upserts later; a
   * vertical that predates the field ignores it (its body parse strips unknown keys).
   */
  config?: Record<string, string>;
  /**
   * The tenant's entitlements, delivered WITH provisioning (#310) so a CP-less vertical
   * PROJECTS them into the new scope and reads/enforces `plan`/`quota`/`expiry` at request
   * time (#304) — it may not read the shared control plane (the `CONTROL_PLANE` binding is
   * forbidden, #302). The platform is authoritative: it gathers these itself rather than
   * trusting a caller. A vertical that predates the field ignores it (its body parse strips
   * unknown keys); until it lands, the scope trusts upstream and only expiry (carried on the
   * row) enforces locally.
   */
  entitlements?: EntitlementGrant[];
  /**
   * Per-tenant relational stores the platform MINTED for this tenant (#301), handed over
   * WITH provisioning so the vertical opens each (`host.openTenantStore(handle)`) and runs
   * its OWN store migrations against it before the callback returns — the same fail-closed,
   * idempotent, retryable K-31 ready-gate that guards scope migrations now also guards the
   * store, so there is no ready-but-empty-DB race. `ref` is opaque; the vertical never
   * parses it. A vertical that predates the field ignores it (its body parse strips unknown
   * keys). One handle per declared `tenantStoreNeed.binding`.
   */
  tenantStores?: TenantStoreHandle[];
}

export interface ConfigureInstanceInput {
  /** The scope's tenant — CP-less verticals shard identity/config storage per tenant
   *  (e.g. Meridian's IdentityDO is addressed by tenant id), so the address rides along. */
  tenantId: TenantId;
  scopeId: ScopeId;
  /** Upserts, key by key — never a full replace, so partial writes compose. */
  entries: Array<{ key: string; value: string }>;
}

export interface ProvisionedInstance {
  tenantId: TenantId;
  scopeId: ScopeId;
  owner: PrincipalId;
}

export interface ReconcileInstanceInput {
  /** The scope's tenant — a CP-less vertical shards its identity/owner store per tenant
   *  (Meridian's IdentityDO is addressed by tenant id), and re-sourcing the owner needs it. */
  tenantId: TenantId;
  scopeId: ScopeId;
  /** The tenant's entitlements, gathered by the platform and re-projected on reconcile, exactly
   *  as at provision (#310). Deliberately NO owner: the platform never persisted one — the
   *  vertical re-sources it from its own durable owner-of-record. */
  entitlements?: EntitlementGrant[];
}

export interface ReconciledInstance {
  tenantId: TenantId;
  scopeId: ScopeId;
  /** The owner the vertical re-granted, echoed back so the caller can report who was restored. */
  owner: PrincipalId;
}

export class VerticalClient {
  constructor(private readonly options: VerticalClientOptions) {}

  /**
   * Ask the vertical to create one instance.
   *
   * Idempotent at the far end, so a retry after a partial failure converges rather
   * than duplicating — which K-31 makes load-bearing, because this is the second
   * phase of a two-phase creation and the reconciliation sweep re-runs exactly it.
   */
  async provisionInstance(input: ProvisionInstanceInput): Promise<ProvisionedInstance> {
    const base = this.options.baseUrl ?? 'https://vertical.invalid';
    const res = await this.options.fetch(`${base}/internal/provision`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        [PLATFORM_SECRET_HEADER]: this.options.platformSecret,
      },
      body: JSON.stringify(input),
    });

    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      // Surfaced rather than swallowed: a 403 here means the secrets do not match,
      // which is a deployment error someone must see, not a transient failure to retry.
      throw new ControlPlaneError(
        res.status,
        body?.error ?? `vertical refused provisioning: ${res.status} ${res.statusText}`,
      );
    }
    return (await res.json()) as ProvisionedInstance;
  }

  /**
   * Deliver per-instance CONFIG to the scope's own storage (vertical-auth-detach.md
   * §2.2) — the write half of the dashboard's Env tab, and the same trust line as
   * provisionInstance: the platform names a scope inside the vertical's deployment and
   * hands it settings; the vertical owns what they mean. Idempotent upserts, so the
   * reconciliation sweep can re-run it. A vertical that has no live-config support
   * answers 501, which the caller may treat as "authored but not delivered".
   */
  async configureInstance(input: ConfigureInstanceInput): Promise<void> {
    await this.postInternal<unknown>('/internal/configure', input, 'configure');
  }

  /**
   * Re-provision an EXISTING instance to repair the #332 lockout: a scope left with role
   * definitions projected but no principal holding a role — `permission_source = 'local'`, zero
   * tuples — enforces nothing but denials, and the builder cannot reach the platform-secret-gated
   * `/internal/provision` to fix it. This is the builder-triggerable repair the control plane makes
   * on their behalf (after checking ownership): it carries NO owner — the platform never persisted
   * one — so the vertical re-sources the owner from its own durable owner-of-record and re-runs the
   * idempotent provision. Entitlements are re-gathered and re-delivered exactly as at provision.
   */
  async reconcileInstance(input: ReconcileInstanceInput): Promise<ReconciledInstance> {
    return this.postInternal<ReconciledInstance>('/internal/reconcile', input, 'reconcile');
  }

  /**
   * Read the scope's OWN database tables (kernel-design §5.4 admin-query RPC).
   *
   * The platform asks the vertical because the scope's data DO lives in the vertical's
   * deployment (K-31), not the control plane's own (empty-module) scope host. Read-only
   * and table-shaped — the platform never sends SQL, only a scope id (and, below, a
   * table name the vertical validates against its live schema).
   */
  async listScopeTables(scopeId: ScopeId): Promise<ScopeTable[]> {
    return this.getInternal<ScopeTable[]>(`/internal/tables?scopeId=${encodeURIComponent(scopeId)}`);
  }

  /** A bounded page of one of the scope's tables. */
  async readScopeTable(scopeId: ScopeId, input: ReadScopeTableInput): Promise<ScopeTablePage> {
    const q = new URLSearchParams({
      scopeId,
      limit: String(input.limit),
      offset: String(input.offset),
    });
    return this.getInternal<ScopeTablePage>(
      `/internal/tables/${encodeURIComponent(input.table)}?${q}`,
    );
  }

  /**
   * One read-only SQL statement against the scope's DB — the console (#219). The
   * vertical enforces read-only-ness in its own deployment (the kernel gate + the
   * DO's rolled-back transaction); a vertical that cannot answer safely (e.g. one
   * that redacts secret columns on table reads) refuses with its own status, which
   * the ControlPlaneError relays verbatim.
   */
  async queryScope(scopeId: ScopeId, input: QueryScopeInput): Promise<ScopeQueryResult> {
    return this.postInternal<ScopeQueryResult>('/internal/query', { scopeId, sql: input.sql }, 'query');
  }

  /**
   * The scope's PENDING platform intents (platform-intents.md) — the platform pulls these because
   * the intent rows live in the vertical's own scope DO, in the vertical's deployment (K-31), not
   * the control plane's. The platform executes each with its own authority, then `settlePlatformRequest`
   * journals the outcome back in the vertical.
   */
  async listPlatformRequests(scopeId: ScopeId): Promise<PlatformRequest[]> {
    return this.getInternal<PlatformRequest[]>(
      `/internal/platform-requests?scopeId=${encodeURIComponent(scopeId)}`,
    );
  }

  /** Journal a platform-request outcome back in the vertical after the platform ran it. */
  async settlePlatformRequest(
    scopeId: ScopeId,
    id: PlatformRequestId,
    outcome: { status: PlatformRequestStatus; result?: unknown; lastError?: string | null },
  ): Promise<void> {
    await this.postInternal<unknown>(
      '/internal/platform-requests/settle',
      { scopeId, id, ...outcome },
      'settle-platform-request',
    );
  }

  /**
   * Copy one scope's data into a fresh sibling scope DO, inside the vertical's own
   * deployment (§9's data half). The platform names source and destination; the bytes
   * never cross the boundary — the response is a table count, not a dump. The
   * directory half (provenance row, activation, version bind) is the caller's job.
   */
  async snapshotScope(input: {
    sourceScopeId: ScopeId;
    newScopeId: ScopeId;
  }): Promise<{ tables: number }> {
    return this.postInternal<{ tables: number }>('/internal/snapshot', input, 'snapshot');
  }

  /**
   * Wipe a reaped fork's storage (§9's reap half). The platform calls this before
   * deleting the directory row — same storage-before-row ordering as the in-process
   * deleteSnapshot, so a crash between the two converges on retry. The fork-only
   * refusal lives with the directory record, on the platform's side.
   */
  async deleteScope(input: { scopeId: ScopeId }): Promise<void> {
    await this.postInternal<unknown>('/internal/delete-scope', input, 'delete-scope');
  }

  /**
   * The scope's full dump — the ONE verb here that deliberately moves scope bytes
   * across the boundary, for the governed `scope pull` (§8). The control-plane route
   * in front of it is the gate: staff-only, audited, masked by default, jurisdiction-
   * checked. Everything else on this surface stays byte-free by design.
   */
  async exportScope(scopeId: ScopeId): Promise<ScopeDumpTable[]> {
    return this.getInternal<ScopeDumpTable[]>(
      `/internal/export?scopeId=${encodeURIComponent(scopeId)}`,
    );
  }

  /**
   * The write half of `exportScope` — load a dump into one existing scope in this
   * deployment (drop-then-replay), for the governed restore/backout. The control-plane
   * route in front is the gate and the auditor, exactly as with the export.
   *
   * `tenantId` rides along so the vertical can RE-PROJECT its own role definitions
   * after the import (projectRolesLocal): a dump from a CP-full world carries tuples
   * but no role definitions, and without the repair every check denies while /me
   * still names the role. A vertical that predates the field ignores it.
   */
  async restoreScope(
    tenantId: TenantId,
    scopeId: ScopeId,
    tables: ScopeDumpTable[],
  ): Promise<{ tables: number }> {
    return this.postInternal<{ tables: number }>('/internal/restore', { tenantId, scopeId, tables }, 'restore');
  }

  /**
   * The PITR bookmarks one scope recorded before its migration passes (#286) —
   * the rewind points the deployments UI offers for a backout. Metadata only;
   * no scope bytes cross the boundary.
   */
  async migrationBookmarks(
    scopeId: ScopeId,
  ): Promise<{ bookmark: string; takenAt: string; pending: string[] }[]> {
    return this.getInternal<{ bookmark: string; takenAt: string; pending: string[] }[]>(
      `/internal/bookmarks?scopeId=${encodeURIComponent(scopeId)}`,
    );
  }

  /**
   * Rewind one scope to a pre-migration bookmark (#286's backout): schema AND data,
   * discarding every write since the bookmark. The scope DO enforces the freshness
   * window (24h without `force`) and restarts itself to complete the restore; the
   * control-plane route in front is the gate and the auditor.
   */
  async rewindScope(
    scopeId: ScopeId,
    bookmark: string,
    opts?: { force?: boolean },
  ): Promise<{ rewindingTo: string }> {
    return this.postInternal<{ rewindingTo: string }>(
      '/internal/rewind',
      { scopeId, bookmark, force: opts?.force ?? false },
      'rewind',
    );
  }

  /** A platform-authenticated POST to the vertical's `/internal/*` surface. */
  private async postInternal<T>(path: string, body: unknown, verb: string): Promise<T> {
    const base = this.options.baseUrl ?? 'https://vertical.invalid';
    const res = await this.options.fetch(`${base}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        [PLATFORM_SECRET_HEADER]: this.options.platformSecret,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const parsed = (await res.json().catch(() => null)) as { error?: string } | null;
      throw new ControlPlaneError(
        res.status,
        parsed?.error ?? `vertical refused ${verb}: ${res.status} ${res.statusText}`,
      );
    }
    return (await res.json()) as T;
  }

  /** A platform-authenticated GET to the vertical's `/internal/*` surface. */
  private async getInternal<T>(path: string): Promise<T> {
    const base = this.options.baseUrl ?? 'https://vertical.invalid';
    const res = await this.options.fetch(`${base}${path}`, {
      headers: { [PLATFORM_SECRET_HEADER]: this.options.platformSecret },
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      throw new ControlPlaneError(
        res.status,
        body?.error ?? `vertical refused introspection: ${res.status} ${res.statusText}`,
      );
    }
    return (await res.json()) as T;
  }
}
