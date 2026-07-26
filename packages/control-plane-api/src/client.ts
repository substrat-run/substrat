import type {
  QueryScopeInput,
  ReadScopeTableInput,
  Scope,
  ScopeId,
  ScopeQueryResult,
  ScopeTable,
  ScopeTablePage,
  Tenant,
  TenantId,
} from '@substrat-run/contracts';
import { DEV_ACTOR_HEADER, SERVICE_TOKEN_HEADER } from './auth.js';

/**
 * A typed HTTP client for the control-plane API — the vertical side of the
 * connect seam (first-flow.md slice 4).
 *
 * A vertical that runs against a *separately deployed* shared control plane uses
 * this to (a) register its tenant, entitlements, and scope on boot, and (b) gate
 * each request on the directory's authoritative lifecycle — `assertScopeActive`
 * fails closed exactly as the kernel's own `getScope` does, so a suspend in the
 * console bites the vertical's next operation even across process and deployment
 * boundaries.
 *
 * What it deliberately does NOT do: write roles or grants. Those are not on the
 * control-plane HTTP surface (api.ts §4.5 — permission writes are the human
 * checkpoint, D-22/D-29), so a connected vertical keeps its permission model
 * local and treats the shared plane as the authority for tenant/scope lifecycle
 * and entitlements only.
 *
 * `fetch` is injectable: pass a Worker service-binding's fetch, or the router's
 * own `app.fetch` for an in-process test, instead of the global.
 */
export interface ControlPlaneClientOptions {
  /** Base URL of the control-plane API, e.g. `https://cp.example.com` or `http://127.0.0.1:8788`. */
  baseUrl: string;
  /** The platform actor id stamped as the audit subject on every write. */
  actor: string;
  /**
   * A service credential (`x-service-token`) proving the caller is an authorized
   * vertical, not just anyone with an actor id. Required when the control plane
   * has real auth — the dev-actor header alone does not authenticate there.
   */
  serviceToken?: string;
  /** Defaults to the global `fetch`. */
  fetch?: typeof globalThis.fetch;
}

export interface ClientProvisionScopeInput {
  tenantId: TenantId;
  scopeId: ScopeId;
  slug?: string;
  kind?: string;
  name?: string;
  vertical?: string | null;
  // The full storable vocabulary; the server gates which are accepted (K-32).
  jurisdiction?: 'eu' | 'us' | 'global';
}

/** A non-2xx (or unreachable) control-plane response. `status` is 0 on a transport error. */
export class ControlPlaneError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ControlPlaneError';
  }
}

export class ControlPlaneClient {
  private readonly baseUrl: string;
  private readonly actor: string;
  private readonly serviceToken?: string;
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(options: ControlPlaneClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.actor = options.actor;
    this.serviceToken = options.serviceToken;
    // Bind to globalThis: workerd throws "Illegal invocation" if `fetch` is called
    // with a `this` other than the global scope (which `this.fetchImpl(...)` would
    // otherwise set to this instance). An injected fetch is used as-is.
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  private async call<T>(path: string, init?: RequestInit, allow404 = false): Promise<T> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        ...init,
        headers: {
          [DEV_ACTOR_HEADER]: this.actor,
          ...(this.serviceToken ? { [SERVICE_TOKEN_HEADER]: this.serviceToken } : {}),
          'content-type': 'application/json',
          ...init?.headers,
        },
      });
    } catch (e) {
      // A transport failure (control plane down) must fail closed, not silently
      // pass — a vertical that cannot reach the authority does not get to run.
      throw new ControlPlaneError(0, `control plane unreachable: ${(e as Error).message}`);
    }
    if (res.status === 404 && allow404) return undefined as T;
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      throw new ControlPlaneError(res.status, body?.error ?? `${res.status} ${res.statusText}`);
    }
    return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
  }

  // -- registration (idempotent, mirrors HostAdmin) --------------------------

  createTenant(input: { id: TenantId; slug: string; name: string }): Promise<Tenant> {
    return this.call('/tenants', { method: 'POST', body: JSON.stringify(input) });
  }

  grantEntitlement(tenantId: TenantId, key: string): Promise<string[]> {
    return this.call(`/tenants/${tenantId}/entitlements/${key}`, { method: 'PUT' });
  }

  provisionScope(input: ClientProvisionScopeInput): Promise<Scope> {
    return this.call('/scopes', { method: 'POST', body: JSON.stringify(input) });
  }

  /**
   * Confirm the scope exists here, moving the directory row provisioning → active.
   *
   * In this (push) direction the vertical has already built the scope locally, so
   * registering and confirming are the same moment — but they stay two calls so
   * `provisionScope` means one thing everywhere, and so the directory is never the
   * one deciding a scope is ready (K-31).
   */
  activateScope(tenantId: TenantId, scopeId: ScopeId): Promise<Scope> {
    return this.call(`/tenants/${tenantId}/scopes/${scopeId}/activate`, { method: 'POST' });
  }

  // -- reads used for gating -------------------------------------------------

  getTenant(tenantId: TenantId): Promise<Tenant | undefined> {
    return this.call(`/tenants/${tenantId}`, undefined, true);
  }

  getScopeRecord(tenantId: TenantId, scopeId: ScopeId): Promise<Scope | undefined> {
    return this.call(`/tenants/${tenantId}/scopes/${scopeId}`, undefined, true);
  }

  listEntitlements(tenantId: TenantId): Promise<string[]> {
    return this.call(`/tenants/${tenantId}/entitlements`);
  }

  // -- read-only scope-DB introspection (§5.4 admin-query RPC) ----------------

  /** Every table in the scope's own database, with row counts (Data view). */
  listScopeTables(tenantId: TenantId, scopeId: ScopeId): Promise<ScopeTable[]> {
    return this.call(`/tenants/${tenantId}/scopes/${scopeId}/tables`);
  }

  /** A bounded page of one table of the scope's database. */
  readScopeTable(
    tenantId: TenantId,
    scopeId: ScopeId,
    input: ReadScopeTableInput,
  ): Promise<ScopeTablePage> {
    const q = new URLSearchParams({ limit: String(input.limit), offset: String(input.offset) });
    return this.call(
      `/tenants/${tenantId}/scopes/${scopeId}/tables/${encodeURIComponent(input.table)}?${q}`,
    );
  }

  /** One read-only SQL statement against the scope's database — the console (#219). */
  queryScope(
    tenantId: TenantId,
    scopeId: ScopeId,
    input: QueryScopeInput,
  ): Promise<ScopeQueryResult> {
    return this.call(`/tenants/${tenantId}/scopes/${scopeId}/query`, {
      method: 'POST',
      body: JSON.stringify(input),
    });
  }

  /**
   * The gate. Throws unless the tenant is active AND the scope exists and is
   * active — the same fail-closed logic the kernel's `validateScopeAccess`
   * applies locally, so a tenant-level cascade suspend bites too, not just a
   * per-scope one. Call it before handing a request to the local scope host.
   */
  async assertScopeActive(tenantId: TenantId, scopeId: ScopeId): Promise<void> {
    const [tenant, scope] = await Promise.all([
      this.getTenant(tenantId),
      this.getScopeRecord(tenantId, scopeId),
    ]);
    if (!tenant) throw new ControlPlaneError(403, `unknown tenant: ${tenantId}`);
    if (tenant.status !== 'active') {
      throw new ControlPlaneError(403, `tenant not active (status: ${tenant.status}): ${tenantId}`);
    }
    if (!scope) throw new ControlPlaneError(403, `unknown scope for tenant: (${tenantId}, ${scopeId})`);
    if (scope.status !== 'active') {
      throw new ControlPlaneError(403, `scope not active (status: ${scope.status}): ${scopeId}`);
    }
  }
}
