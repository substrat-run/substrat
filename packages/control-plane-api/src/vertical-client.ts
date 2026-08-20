import type {
  AttachmentRecord,
  ConnectionId,
  EntityRef,
  EntitlementGrant,
  PermissionKey,
  PlatformRequest,
  PlatformRequestFilter,
  PlatformRequestId,
  PlatformRequestStatus,
  PrincipalId,
  ConnectionGrantRecord,
  ProjectedConnectionGrant,
  ProjectedConnectionKey,
  ProjectedIdentityLink,
  QueryScopeInput,
  ReadScopeTableInput,
  ScopeDumpTable,
  ScopeId,
  ScopeQueryResult,
  ScopeTable,
  ScopeTablePage,
  TenantId,
  TenantStoreHandle,
  Visibility,
} from '@substrat-run/contracts';
import { attachmentRecord } from '@substrat-run/contracts';
import type { OpenedAttachment } from '@substrat-run/kernel';
import { CONNECTOR_ATTACHMENT_RECORD_HEADER, PLATFORM_SECRET_HEADER } from '@substrat-run/kernel';
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
   * The tenant's identity links, delivered WITH provisioning (#406) on the same trust line
   * as entitlements: the platform gathers them itself (`admin.listIdentityLinks`, never the
   * caller's body) and the CP-less vertical PROJECTS them, so its auth adapter resolves
   * `(provider, externalId) → principal` from local storage instead of a map compiled into
   * the bundle — which made offboarding a deploy and let a version rollback resurrect a
   * removed login. A vertical that predates the field ignores it (its body parse strips
   * unknown keys).
   */
  identityLinks?: ProjectedIdentityLink[];
  /**
   * The tenant's connection grants for THIS scope (#592), on the same trust line as
   * entitlements and identity links: the platform gathers them itself from the directory
   * (`admin.listConnectionGrants`, never the caller's body), materializes tenant-wide rows
   * per scope, and the CP-less vertical projects them as the `connection:<id>` tuples its
   * connector return path (`connectorInvokeLocal`) is permission-checked against. Without
   * this, a grant is a one-shot hand-write per scope: every install provisioned after
   * `grantToConnection` silently ships without the return path. A vertical that predates
   * the field ignores it (its body parse strips unknown keys).
   */
  connectionGrants?: ProjectedConnectionGrant[];
  /**
   * Live connections' PUBLIC sealing keys for this scope's vertical (#687), on the same
   * trust line as everything above it: the platform gathers them itself
   * (`admin.connectionSealingKeys`, never the caller's body) and the CP-less vertical
   * projects them, so module code can seal a value TO a connector — the only channel a
   * scope has for handing a connector something the spine must not hold in the clear.
   *
   * **Public halves only, structurally.** The private half stays sealed in the directory;
   * projecting a secret key into a scope is the failure kernel-design §13.1 names, and it
   * is what makes this carrier possible rather than what would break it — a public key
   * lets the scope WRITE to a connector, never read.
   *
   * Delivery ORDER is load-bearing (signature-contact-carrier.md §7 point 2): the key must
   * reach the scope before the engine tries to seal to it. A vertical that predates the
   * field ignores it (its body parse strips unknown keys), and until it lands
   * `sealToConnection` refuses loudly rather than emitting a request that reaches nobody.
   */
  connectionKeys?: ProjectedConnectionKey[];
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
  /**
   * NON-SECRET first-run facts the vertical reported alongside the ack (#426): a minted
   * client id, migrations applied, endpoint paths — anything the installer needs to SEE
   * once the instance exists. Collected from the provision response's extra top-level
   * primitive fields (and an explicit `result` object, which wins on a shared key), so a
   * vertical opts in by simply returning more than the ack. Persisted by installers and
   * shown to the operator — which is why secrets don't belong here: credentials flow IN
   * via `config` (the installer chose them), never back OUT in a response that outlives
   * one HTTP exchange. Keys that look like secrets are dropped as a backstop.
   */
  result?: Record<string, string>;
}

/** The ack fields every provision response carries — everything else is `result` material. */
const PROVISION_ACK_FIELDS = new Set(['tenantId', 'scopeId', 'owner', 'result']);

/** The backstop: a vertical that still returns credential-shaped keys has them dropped, not persisted. */
const SECRETLIKE_KEY = /password|secret|token|private/i;

/**
 * The non-secret result map from a vertical's provision response: explicit `result`
 * entries plus extra top-level primitives, secret-looking keys excluded, values
 * stringified. Undefined when the vertical returned only the bare ack.
 */
function provisionResultFrom(body: Record<string, unknown>): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  const collect = (entries: Record<string, unknown>, skipAck: boolean): void => {
    for (const [key, value] of Object.entries(entries)) {
      if (skipAck && PROVISION_ACK_FIELDS.has(key)) continue;
      if (SECRETLIKE_KEY.test(key)) continue;
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        out[key] = String(value);
      }
    }
  };
  collect(body, true);
  const explicit = body['result'];
  if (explicit && typeof explicit === 'object' && !Array.isArray(explicit)) {
    collect(explicit as Record<string, unknown>, false);
  }
  return Object.keys(out).length > 0 ? out : undefined;
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
  /** The tenant's identity links, gathered by the platform and re-projected on reconcile,
   *  exactly as at provision (#406) — the repair channel for a dropped delivery, and the
   *  re-delivery a link/unlink AFTER provision rides. */
  identityLinks?: ProjectedIdentityLink[];
  /** The tenant's connection grants for this scope, gathered and re-delivered exactly as at
   *  provision (#592) — the back-fill for a scope provisioned before `grantToConnection`
   *  ran, and the channel a grant AFTER provision rides. A revoked connection's grants are
   *  absent from the gather, so they stop being delivered. */
  connectionGrants?: ProjectedConnectionGrant[];
  /** Live connections' public sealing keys, gathered and re-delivered exactly as at provision
   *  (#687) — the back-fill for a scope provisioned before the connection existed, and the
   *  channel a connection made AFTER provision rides. A revoked connection's key is absent
   *  from the gather, so the scope stops being able to seal to it. */
  connectionKeys?: ProjectedConnectionKey[];
  /** Per-tenant relational stores, minted (or re-resolved) on the reconcile itself (#825) and
   *  handed over exactly as at provision: a tenant that predates its vertical's `tenantStores`
   *  declaration is given its store HERE, and has therefore never migrated it — so the handle
   *  must ride the reconcile into the same fail-closed K-31 ready-gate. A vertical that
   *  predates the field ignores it (its body parse strips unknown keys). */
  tenantStores?: TenantStoreHandle[];
}

/**
 * Materialize a tenant's directory-side connection grants for ONE scope (#592) — the
 * gather half every delivery site shares. Keeps only grants whose connection belongs to
 * the scope's vertical (a connection is keyed (tenant, vertical, provider) and must not
 * reach another vertical's scopes), then tenant-wide rows (`scopeId: null`) materialize
 * for any scope while scope-targeted rows survive only for their own — which is what
 * lets a re-provision re-deliver a hand-granted scope AND a fresh install receive the
 * tenant-wide grants it was provisioned after.
 */
export function connectionGrantsForScope(
  grants: ConnectionGrantRecord[],
  vertical: string | null | undefined,
  scopeId: ScopeId,
): ProjectedConnectionGrant[] {
  if (!vertical) return [];
  return grants
    .filter((g) => g.vertical === vertical && (g.scopeId === null || g.scopeId === scopeId))
    .map((g) => ({
      connectionId: g.connectionId,
      permission: g.permission,
      ...(g.expiresAt ? { expiresAt: g.expiresAt } : {}),
    }));
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
    const res = await this.reach('provisioning', () =>
      this.options.fetch(`${base}/internal/provision`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          [PLATFORM_SECRET_HEADER]: this.options.platformSecret,
        },
        body: JSON.stringify(input),
      }),
    );

    // Surfaced rather than swallowed: a 403 here means the secrets do not match,
    // which is a deployment error someone must see, not a transient failure to retry.
    if (!res.ok) throw await this.refusal('provisioning', res);
    // The SUCCESS body matters too (#426): a vertical may report first-run facts with
    // its ack. Carry them as `result` so callers can persist them — before this, the
    // body's only reader was `await res.json()` and everything beyond the ack died
    // with the response.
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    const ack = { tenantId: input.tenantId, scopeId: input.scopeId, owner: input.owner };
    const result = provisionResultFrom(body);
    return { ...ack, ...(result ? { result } : {}) };
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
  async listPlatformRequests(tenantId: TenantId, scopeId: ScopeId): Promise<PlatformRequest[]> {
    const q = new URLSearchParams({ tenantId, scopeId });
    return this.getInternal<PlatformRequest[]>(`/internal/platform-requests?${q}`);
  }

  /**
   * The scope's intent JOURNAL (#618) — every intent whatever became of it, newest first. Same
   * pull, different question: the read above feeds the drain and so returns only `pending`,
   * while a console asking "why did my connector fail?" needs the SETTLED rows, whose
   * `last_error` holds the provider's full answer.
   */
  async listPlatformRequestHistory(
    tenantId: TenantId,
    scopeId: ScopeId,
    filter?: PlatformRequestFilter,
  ): Promise<PlatformRequest[]> {
    const q = new URLSearchParams({ tenantId, scopeId });
    if (filter?.kind) q.set('kind', filter.kind);
    if (filter?.status) q.set('status', filter.status);
    if (filter?.limit) q.set('limit', String(filter.limit));
    return this.getInternal<PlatformRequest[]>(`/internal/platform-requests/history?${q}`);
  }

  /**
   * Invoke ONE operation in the vertical's deployment as a CONNECTION (#574) — the
   * write-back leg of the platform-run connector pass. The platform already passed the
   * directory gates (live connection, tenant/vertical match); the permission check runs
   * at the far end, in the scope's own DO, against its delivered `connection:<id>`
   * grant. Carries no credential — an operation name and its input, nothing more.
   */
  async connectorInvoke(input: {
    connectionId: ConnectionId;
    tenantId: TenantId;
    scopeId: ScopeId;
    operation: string;
    input?: unknown;
  }): Promise<unknown> {
    const body = await this.postInternal<{ result: unknown }>(
      '/internal/connector-invoke',
      input,
      'connector-invoke',
    );
    return body.result;
  }

  /**
   * Land provider bytes in the vertical's deployment as a CONNECTION (#574) — the bytes
   * leg (a sealed signed PDF cannot ride the JSON invoke). Multipart: `meta` carries the
   * JSON envelope, `body` the blob; fetch stamps the boundary content-type itself.
   */
  async connectorUploadAttachment(input: {
    connectionId: ConnectionId;
    tenantId: TenantId;
    scopeId: ScopeId;
    entity: EntityRef;
    filename: string;
    contentType: string;
    visibility: Visibility;
    body: Uint8Array;
  }): Promise<AttachmentRecord> {
    const { body, ...meta } = input;
    const form = new FormData();
    form.append('meta', JSON.stringify(meta));
    form.append('body', new Blob([body as BlobPart], { type: input.contentType }), input.filename);
    const base = this.options.baseUrl ?? 'https://vertical.invalid';
    const res = await this.reach('connector-attachment', () =>
      this.options.fetch(`${base}/internal/connector-attachment`, {
        method: 'POST',
        // No content-type here: fetch sets multipart/form-data with its boundary.
        headers: { [PLATFORM_SECRET_HEADER]: this.options.platformSecret },
        body: form,
      }),
    );
    if (!res.ok) throw await this.refusal('connector-attachment', res);
    return this.parseInternal<AttachmentRecord>('connector-attachment', '/internal/connector-attachment', res);
  }

  /**
   * Fetch ONE attachment's bytes back OUT of the vertical's deployment as a CONNECTION
   * (#711) — the outbound leg. The platform runs the vertical's signing connector and
   * must send the document the VERTICAL rendered; it holds the credential, the vertical
   * holds the bytes.
   *
   * Raw bytes in the body, the record in a header — a contract is megabytes and base64
   * in a JSON envelope would inflate and re-encode it for nothing. `404` is "this scope
   * does not know that id", answered as `null` so a caller falls back to rendering its
   * own document rather than failing a dispatch; a refusal is still a throw.
   */
  async connectorOpenAttachment(input: {
    connectionId: ConnectionId;
    tenantId: TenantId;
    scopeId: ScopeId;
    attachmentId: string;
    /**
     * The delivery this read is for (#726 remedy B). Sent as a NAME, not a claim: the
     * deployment resolves it against its own outbox and admits only the attachments of
     * the entity that row names, so the platform cannot widen its own reach by asking.
     */
    eventId?: string;
  }): Promise<OpenedAttachment | null> {
    const q = new URLSearchParams({
      connectionId: input.connectionId,
      tenantId: input.tenantId,
      scopeId: input.scopeId,
      ...(input.eventId ? { eventId: input.eventId } : {}),
    });
    const base = this.options.baseUrl ?? 'https://vertical.invalid';
    const path = `/internal/connector-attachment/${encodeURIComponent(input.attachmentId)}`;
    const res = await this.reach('connector-attachment-open', () =>
      this.options.fetch(`${base}${path}?${q}`, {
        headers: { [PLATFORM_SECRET_HEADER]: this.options.platformSecret },
      }),
    );
    if (res.status === 404) return null;
    if (!res.ok) throw await this.refusal('connector-attachment-open', res);
    const raw = res.headers.get(CONNECTOR_ATTACHMENT_RECORD_HEADER);
    if (!raw) {
      throw new Error(
        `connector-attachment-open: the vertical answered ${res.status} with no ` +
          `${CONNECTOR_ATTACHMENT_RECORD_HEADER} header — the bytes cannot be trusted without ` +
          `the record that witnesses them (#711)`,
      );
    }
    // Parsed, not cast: the record carries the sha256 the bytes are checked against at
    // the far end, and a shape this side invented would witness nothing.
    const record = attachmentRecord.parse(JSON.parse(raw));
    const body = new Uint8Array(await res.arrayBuffer());
    return {
      record,
      body,
      contentType: res.headers.get('content-type') ?? record.contentType,
    };
  }

  /**
   * Deliver a connection's scope-level grant tuple into the vertical's deployment
   * (#574) — the delivery half of `grantToConnection` for a scope served there.
   * Idempotent at the far end.
   */
  async connectorGrant(input: {
    connectionId: ConnectionId;
    scopeId: ScopeId;
    permission: PermissionKey;
    expiresAt?: string;
  }): Promise<void> {
    await this.postInternal<unknown>('/internal/connector-grant', input, 'connector-grant');
  }

  /** Journal a platform-request outcome back in the vertical after the platform ran it. */
  async settlePlatformRequest(
    tenantId: TenantId,
    scopeId: ScopeId,
    id: PlatformRequestId,
    outcome: { status: PlatformRequestStatus; result?: unknown; lastError?: string | null },
  ): Promise<void> {
    await this.postInternal<unknown>(
      '/internal/platform-requests/settle',
      { tenantId, scopeId, id, ...outcome },
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

  /**
   * A dispatch/transport REJECTION (the fetch itself threw — a cold-starting script, a
   * DO reset, a missing dispatch entry) is not a vertical's answer, but before #391 it
   * propagated raw and the API boundary collapsed it to the generic 500 "internal
   * error". Wrap it as a 502 carrying the runtime's own message, so the operator reads
   * "unreachable during configure: <why>" — and callers can treat 502 as the transient
   * it usually is (the dashboard's provision step 3 retries exactly this).
   */
  private async reach(verb: string, request: () => Promise<Response>): Promise<Response> {
    try {
      return await request();
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      throw new ControlPlaneError(502, `vertical unreachable during ${verb}: ${detail}`);
    }
  }

  /**
   * The vertical's refusal, VERBATIM. A non-2xx body is the diagnosis — the vertical
   * says exactly what is wrong ("no tenant store attached for <t> — provision first") —
   * so it must survive to the operator whatever its shape: our own verticals answer
   * `{error}`, but a foreign one (or a runtime error page) answers plain text, which the
   * old `res.json().catch(() => null)` silently dropped, leaving only "503 Service
   * Unavailable" (#424 case 1). Read the body once as text: a JSON `{error}` passes
   * through bare (the vertical authored a complete message — the existing contract);
   * any other non-empty body rides prefixed with the verb; only an EMPTY body falls
   * back to the status line.
   */
  private async refusal(verb: string, res: Response): Promise<ControlPlaneError> {
    const text = await res.text().catch(() => '');
    try {
      const parsed = JSON.parse(text) as { error?: unknown };
      if (typeof parsed?.error === 'string' && parsed.error !== '') {
        return new ControlPlaneError(res.status, parsed.error);
      }
    } catch {
      // not JSON — fall through to the raw text
    }
    const detail = text.trim().slice(0, 500);
    return new ControlPlaneError(
      res.status,
      detail !== ''
        ? `vertical refused ${verb} (${res.status}): ${detail}`
        : `vertical refused ${verb}: ${res.status} ${res.statusText}`,
    );
  }

  /**
   * A 200 whose body is not JSON is a script that does not SERVE this route: an old
   * worker build falls through to its SPA fallback and answers the app shell (200,
   * `<!doctype …`) for any `/internal/*` path it predates. Surface that as the
   * diagnosis instead of an unhandled SyntaxError → 500 (#389: a pre-#236 script has
   * no `/internal/export`, so a carried rebind cannot dump it).
   */
  private async parseInternal<T>(verb: string, path: string, res: Response): Promise<T> {
    const text = await res.text();
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new ControlPlaneError(
        502,
        `vertical answered ${verb} (${path}) with non-JSON — its deployed script predates this ` +
          `surface. Redeploy the vertical (or, for a rebind, use abandonData).`,
      );
    }
  }

  /** A platform-authenticated POST to the vertical's `/internal/*` surface. */
  private async postInternal<T>(path: string, body: unknown, verb: string): Promise<T> {
    const base = this.options.baseUrl ?? 'https://vertical.invalid';
    const res = await this.reach(verb, () =>
      this.options.fetch(`${base}${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          [PLATFORM_SECRET_HEADER]: this.options.platformSecret,
        },
        body: JSON.stringify(body),
      }),
    );
    if (!res.ok) throw await this.refusal(verb, res);
    return this.parseInternal<T>(verb, path, res);
  }

  /** A platform-authenticated GET to the vertical's `/internal/*` surface. */
  private async getInternal<T>(path: string): Promise<T> {
    const base = this.options.baseUrl ?? 'https://vertical.invalid';
    const res = await this.reach('introspection', () =>
      this.options.fetch(`${base}${path}`, {
        headers: { [PLATFORM_SECRET_HEADER]: this.options.platformSecret },
      }),
    );
    if (!res.ok) throw await this.refusal('introspection', res);
    return this.parseInternal<T>('introspection', path, res);
  }
}
