/**
 * The platform's `/internal/*` surface, authored ONCE.
 *
 * Every sandbox-clean vertical (Meridian, Manyfold, Callout, egeryds-crm, …) has to
 * answer the same control-plane contract: provision a scope, reconcile a locked-out one,
 * introspect its tables, run the read-only SQL console, drain platform-requests, snapshot
 * / delete / export / restore / bookmark / rewind its storage, upsert its per-instance
 * config. Before this package each vertical HAND-COPIED those ~14 routes plus a Hono
 * `onError` into its own `worker.ts`, and the copies drifted: route sets disagreed
 * (12 / 13 / 14) and two of four workers shipped WITHOUT the error handler — so a thrown
 * `/internal/restore` surfaced as the Workers runtime's bare `Internal Server Error`
 * instead of a readable `{ error }` the control plane could relay (issue #510).
 *
 * `mountPlatformSurface` mounts the whole contract — and the error envelope — in one call.
 * The generic routes are pure host delegations owned entirely here; the three flavored
 * ones (provision / reconcile / configure) keep their gate, parse, and response envelope
 * here and take only a vertical-supplied hook. A vertical that forgets to mount it has no
 * `/internal/provision` and fails to provision loudly (first deploy, scenario test) — so
 * the surface is self-enforcing, not convention.
 *
 * The scope host is taken STRUCTURALLY (`VerticalScopeHost`), so this package depends on
 * neither `adapter-cloudflare` nor any concrete host — no dependency cycle, and a future
 * adapter satisfies the same interface.
 */
import type { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import {
  assertPlatformCall,
  CONNECTOR_ATTACHMENT_RECORD_HEADER,
  PlatformCallError,
} from '@substrat-run/kernel';
import {
  z,
  scopeId as scopeIdOf,
  tenantId as tenantIdOf,
  principalId as principalIdOf,
  connectionId as connectionIdOf,
  permissionKey as permissionKeyOf,
  entityRef,
  visibility,
  instant,
  entitlementGrant,
  projectedConnectionGrant,
  projectedIdentityLink,
  platformRequestFilter,
  platformRequestId,
  platformRequestStatus,
  readScopeTableInput,
  queryScopeInput,
  type ScopeId,
  type TenantId,
  type PrincipalId,
  type ConnectionId,
  type PermissionKey,
  type EntityRef,
  type Visibility,
  type RoleDefinition,
  type ScopeDumpTable,
  type ScopeTable,
  type ScopeQueryResult,
  type EntitlementGrant,
  type ProjectedConnectionGrant,
  type ProjectedIdentityLink,
  type PlatformRequest,
  type PlatformRequestFilter,
  type PlatformRequestId,
  type PlatformRequestStatus,
} from '@substrat-run/contracts';

/**
 * The slice of the scope host the platform surface delegates to. Structural on purpose:
 * this package names behaviour, never the concrete `CloudflareScopeHost`. Every method
 * here is one the sandbox-clean host already exports (the `…Local` CP-less halves plus
 * the introspection + platform-request reads).
 */
export interface VerticalScopeHost {
  provisionScopeLocal(input: {
    tenantId: TenantId;
    scopeId: ScopeId;
    owner: PrincipalId;
    roles: RoleDefinition[];
    ownerRoleKey: string;
    entitlements?: EntitlementGrant[];
    identityLinks?: ProjectedIdentityLink[];
    connectionGrants?: ProjectedConnectionGrant[];
  }): Promise<void>;
  restoreScopeLocal(scopeId: ScopeId, tables: ScopeDumpTable[]): Promise<{ tables: number }>;
  projectRolesLocal(tenantId: TenantId, scopeId: ScopeId, roles: RoleDefinition[]): Promise<void>;
  exportScopeLocal(scopeId: ScopeId): Promise<ScopeDumpTable[]>;
  snapshotScopeLocal(source: ScopeId, dest: ScopeId): Promise<{ tables: number }>;
  deleteScopeLocal(scopeId: ScopeId): Promise<void>;
  migrationBookmarksLocal(
    scopeId: ScopeId,
  ): Promise<{ bookmark: string; takenAt: string; pending: string[] }[]>;
  rewindScopeLocal(
    scopeId: ScopeId,
    bookmark: string,
    opts?: { force?: boolean },
  ): Promise<{ rewindingTo: string }>;
  introspectScopeTables(scopeId: ScopeId): Promise<ScopeTable[]>;
  introspectScopeTable(
    scopeId: ScopeId,
    input: z.infer<typeof readScopeTableInput>,
  ): Promise<unknown>;
  introspectScopeQuery(scopeId: ScopeId, input: { sql: string }): Promise<ScopeQueryResult>;
  listPlatformRequests(tenantId: TenantId, scopeId: ScopeId): Promise<PlatformRequest[]>;
  listPlatformRequestHistory(
    tenantId: TenantId,
    scopeId: ScopeId,
    filter?: PlatformRequestFilter,
  ): Promise<PlatformRequest[]>;
  settlePlatformRequest(
    tenantId: TenantId,
    scopeId: ScopeId,
    id: PlatformRequestId,
    outcome: { status: PlatformRequestStatus; result?: unknown; lastError?: string | null },
  ): Promise<void>;
  // The connector write-back's far end (#574): the shared control plane runs the
  // connector pass for this CP-less deployment and reaches back through these. The
  // permission check happens HERE, in the scope's own DO, against the delivered
  // `connection:<id>` tuple — the platform cannot skip it.
  connectorInvokeLocal(
    connectionId: ConnectionId,
    tenantId: TenantId,
    scopeId: ScopeId,
    operation: string,
    input?: unknown,
  ): Promise<unknown>;
  connectorAttachmentUploadLocal(
    connectionId: ConnectionId,
    tenantId: TenantId,
    scopeId: ScopeId,
    upload: {
      entity: EntityRef;
      filename: string;
      contentType: string;
      visibility: Visibility;
      body: Uint8Array;
    },
  ): Promise<unknown>;
  /** The outbound read (#711) — the vertical's own document, handed back by id. */
  connectorAttachmentOpenLocal(
    connectionId: ConnectionId,
    tenantId: TenantId,
    scopeId: ScopeId,
    attachmentId: string,
  ): Promise<{ record: unknown; body: Uint8Array; contentType: string } | null>;
  connectorGrantLocal(
    connectionId: ConnectionId,
    scopeId: ScopeId,
    permission: PermissionKey,
    expiresAt?: string,
  ): Promise<void>;
}

/** `/internal/provision` body. `slug`/`name` ride along so `onProvision` can register a site (M2). */
const provisionBody = z.object({
  tenantId: tenantIdOf,
  scopeId: scopeIdOf,
  owner: principalIdOf,
  slug: z.string().min(1).optional(),
  name: z.string().min(1).optional(),
  entitlements: z.array(entitlementGrant).optional(),
  identityLinks: z.array(projectedIdentityLink).optional(),
  connectionGrants: z.array(projectedConnectionGrant).optional(),
});
/** The parsed provision body handed to `onProvision`. */
export type ProvisionBody = z.infer<typeof provisionBody>;

/** `/internal/reconcile` carries no owner — the vertical re-sources it via `resolveOwner` (#332). */
const reconcileBody = z.object({
  tenantId: tenantIdOf,
  scopeId: scopeIdOf,
  entitlements: z.array(entitlementGrant).optional(),
  identityLinks: z.array(projectedIdentityLink).optional(),
  connectionGrants: z.array(projectedConnectionGrant).optional(),
});

const restoreBody = z.object({
  tenantId: tenantIdOf.optional(),
  scopeId: scopeIdOf,
  tables: z.array(
    z.object({
      name: z.string(),
      ddl: z.string(),
      columns: z.array(z.string()),
      rows: z.array(z.array(z.unknown())),
    }),
  ),
});

const configureBody = z.object({
  tenantId: tenantIdOf,
  scopeId: scopeIdOf,
  entries: z.array(z.object({ key: z.string().min(1), value: z.string() })).min(1),
});
/** The parsed configure body handed to `onConfigure`. */
export type ConfigureBody = z.infer<typeof configureBody>;

const settleBody = z.object({
  tenantId: tenantIdOf,
  scopeId: scopeIdOf,
  id: platformRequestId,
  status: platformRequestStatus,
  result: z.unknown().optional(),
  lastError: z.string().nullable().optional(),
});

/** `/internal/connector-invoke` body (#574) — one operation, invoked as the connection. */
const connectorInvokeBody = z.object({
  connectionId: connectionIdOf,
  tenantId: tenantIdOf,
  scopeId: scopeIdOf,
  operation: z.string().min(1),
  input: z.unknown().optional(),
});

/** The `meta` field of a `/internal/connector-attachment` multipart body (#574). */
const connectorAttachmentMeta = z.object({
  connectionId: connectionIdOf,
  tenantId: tenantIdOf,
  scopeId: scopeIdOf,
  entity: entityRef,
  filename: z.string().min(1),
  contentType: z.string().min(1),
  visibility,
});

/** `/internal/connector-grant` body (#574) — the delivery half of `grantToConnection`. */
const connectorGrantBody = z.object({
  connectionId: connectionIdOf,
  scopeId: scopeIdOf,
  permission: permissionKeyOf,
  expiresAt: instant.optional(),
});

export interface PlatformSurfaceDeps<Env> {
  /**
   * The secret that gates every `/internal` call, read off the worker env. Unset ⇒ every
   * call 403s — `assertPlatformCall` fails closed (an open provisioning endpoint lets a
   * stranger mint tenants inside the vertical).
   */
  platformSecret: (env: Env) => string | undefined;
  /** The scope host for THIS deployment — the data DOs live here (K-31). */
  hostFor: (env: Env) => VerticalScopeHost;
  /** The vertical's own role definitions — re-projected after BOTH provision and restore. */
  roles: RoleDefinition[];
  /** The role the installing owner is granted, at scope level (`hr-admin`, `admin`, …). */
  ownerRoleKey: string;

  /**
   * Vertical-specific provision side effect — the pending-owner TOFU claim, and for a
   * multi-site vertical the site-registry write. Runs after the scope's own state is set
   * up. Optional: a vertical with no owner-of-record store omits it.
   */
  onProvision?: (env: Env, body: ProvisionBody) => Promise<void>;
  /**
   * Re-source a reconcile's owner from the vertical's durable owner-of-record (#332).
   * Return `null` when there is no record (⇒ 409, re-run the install). Omit entirely and
   * `/internal/reconcile` answers 501 — the vertical keeps no owner-of-record.
   */
  resolveOwner?: (
    env: Env,
    ref: { tenantId: TenantId; scopeId: ScopeId },
  ) => Promise<PrincipalId | null>;
  /**
   * Persist per-instance config (the dashboard's Env tab). Omit ⇒ `/internal/configure`
   * answers 501 — the vertical stores no per-scope config.
   */
  onConfigure?: (env: Env, body: ConfigureBody) => Promise<void>;
  /**
   * Vertical-specific delete-scope side effect — e.g. drop the scope from a deployment
   * sweep roster (#461) so its alarm never wakes a reaped scope. Runs after the host has
   * wiped the scope's storage. Optional.
   */
  onDeleteScope?: (env: Env, scopeId: ScopeId) => Promise<void>;

  /**
   * Extra error mapping, tried BEFORE the default envelope. Return a `{status, message}`
   * to override, or `undefined` to fall through to the default. Use it for a vertical's
   * own domain errors; the platform routes here never need it.
   */
  mapError?: (err: unknown) => { status: number; message: string } | undefined;
}

/**
 * A throw that names the RUNTIME failing, not the request (#559). Two signals, either
 * sufficient: the flags workerd sets on transient Durable Object errors (`retryable`,
 * `overloaded`), and the message shapes the runtime is known to emit — foremost DO
 * SQLite's redacted `internal error; reference = <id>`, whose reference resolves only at
 * Cloudflare support. The patterns are anchored/specific on purpose: an APP error that
 * merely mentions "internal error" mid-sentence is still the caller's 400.
 */
const PLATFORM_FAULT_PATTERNS = [
  /^internal error(?:;|$)/i,
  /^durable object reset/i,
  /^durable object storage operation/i,
  /transient (?:issue|error)/i,
  /^network connection lost/i,
];

function isPlatformFault(err: unknown, message: string): boolean {
  const flags = err as { retryable?: unknown; overloaded?: unknown } | null;
  if (flags?.retryable === true || flags?.overloaded === true) return true;
  return PLATFORM_FAULT_PATTERNS.some((p) => p.test(message));
}

/**
 * Mount the platform's `/internal/*` contract and the guaranteed error envelope onto a
 * vertical's Hono app. Call it once; it registers the platform-secret gate (one
 * middleware, not a per-route try/catch), every `/internal` route, and `app.onError`.
 *
 * Hono keeps the LAST-registered `onError`, so mounting the surface installs the envelope
 * — there is no "mounted the routes but forgot the handler" state. A vertical keeps its
 * own user-facing surface (`/api/auth`, `/me`, `/op`, …) on the same `app`.
 */
export function mountPlatformSurface<Env extends object>(
  app: Hono<{ Bindings: Env }>,
  deps: PlatformSurfaceDeps<Env>,
): void {
  // ── ONE gate for the entire surface (replaces the per-route copy-pasted try/catch) ──
  app.use('/internal/*', async (c, next) => {
    try {
      assertPlatformCall(c.req.raw.headers, { expectedSecret: deps.platformSecret(c.env) });
    } catch (e) {
      if (e instanceof PlatformCallError) throw new HTTPException(403, { message: e.message });
      throw e;
    }
    await next();
  });

  // ── Generic host-delegating routes: zero vertical-specific behaviour, cannot drift ──

  // The full dump behind a governed `scope pull` (preview-and-snapshots.md §8): the one
  // /internal verb that deliberately moves scope bytes out; the control plane is the gate.
  app.get('/internal/export', async (c) =>
    c.json(await deps.hostFor(c.env).exportScopeLocal(scopeIdOf.parse(c.req.query('scopeId')))),
  );

  // The write half (§8): load a dump into one scope, replacing its data — the governed
  // restore/backout, and the data hop of adopt-serving (#286). After the import the
  // vertical's OWN role definitions are re-projected: a dump from a CP-full world carries
  // tuples but no role definitions, so without the repair every check denies while /me
  // still names the role. Roles are code-defined, so re-projecting is always safe.
  app.post('/internal/restore', async (c) => {
    const body = restoreBody.parse(await c.req.json());
    const host = deps.hostFor(c.env);
    const result = await host.restoreScopeLocal(body.scopeId, body.tables);
    if (body.tenantId) await host.projectRolesLocal(body.tenantId, body.scopeId, deps.roles);
    return c.json(result);
  });

  // #286: the PITR bookmarks one scope recorded before its migration passes — the rewind
  // points a backout offers. Metadata only; no scope bytes cross the boundary.
  app.get('/internal/bookmarks', async (c) =>
    c.json(await deps.hostFor(c.env).migrationBookmarksLocal(scopeIdOf.parse(c.req.query('scopeId')))),
  );

  // #286's backout: rewind one scope's ENTIRE storage — schema and data — to a
  // pre-migration bookmark. The DO enforces the freshness window (24h without force) and
  // restarts itself to complete the restore; the control plane is the gate and the auditor.
  app.post('/internal/rewind', async (c) => {
    const body = z
      .object({ scopeId: scopeIdOf, bookmark: z.string().min(1), force: z.boolean().optional() })
      .parse(await c.req.json());
    return c.json(
      await deps.hostFor(c.env).rewindScopeLocal(body.scopeId, body.bookmark, { force: body.force }),
    );
  });

  // Scope-storage lifecycle (preview-and-snapshots.md §9): copy a scope into a sibling DO /
  // wipe a reaped fork — both inside this deployment; no bytes cross the boundary.
  app.post('/internal/snapshot', async (c) => {
    const body = z.object({ sourceScopeId: scopeIdOf, newScopeId: scopeIdOf }).parse(await c.req.json());
    return c.json(await deps.hostFor(c.env).snapshotScopeLocal(body.sourceScopeId, body.newScopeId), 201);
  });

  app.post('/internal/delete-scope', async (c) => {
    const body = z.object({ scopeId: scopeIdOf }).parse(await c.req.json());
    await deps.hostFor(c.env).deleteScopeLocal(body.scopeId);
    await deps.onDeleteScope?.(c.env, body.scopeId);
    return c.json({ deleted: body.scopeId });
  });

  // Read-only introspection of a scope's OWN database (kernel-design §5.4) — what the
  // console/dashboard "Data" view reads. The scope's data DO lives HERE (K-31), so the
  // control plane delegates; the scope id is trusted from the gated call.
  app.get('/internal/tables', async (c) =>
    c.json(await deps.hostFor(c.env).introspectScopeTables(scopeIdOf.parse(c.req.query('scopeId')))),
  );

  app.get('/internal/tables/:table', async (c) => {
    const scope = scopeIdOf.parse(c.req.query('scopeId'));
    const input = readScopeTableInput.parse({
      table: c.req.param('table'),
      limit: c.req.query('limit') ? Number(c.req.query('limit')) : undefined,
      offset: c.req.query('offset') ? Number(c.req.query('offset')) : undefined,
    });
    return c.json(await deps.hostFor(c.env).introspectScopeTable(scope, input));
  });

  // The SQL console (#219): one read-only statement, enforced in the DO (textual gate + a
  // transaction that always rolls back). The gate's refusal is the CALLER's mistake — 400,
  // relayed verbatim by the platform — not this worker's fault.
  app.post('/internal/query', async (c) => {
    const body = queryScopeInput.extend({ scopeId: scopeIdOf }).parse(await c.req.json());
    try {
      return c.json(await deps.hostFor(c.env).introspectScopeQuery(body.scopeId, { sql: body.sql }));
    } catch (e) {
      if (e instanceof Error && e.message.includes('read-only console')) {
        throw new HTTPException(400, { message: e.message });
      }
      throw e;
    }
  });

  // Platform-intent drain surface (platform-intents.md): the control plane PULLS this
  // scope's pending intents — its DO lives HERE, not the platform's — executes each with
  // its own authority, and journals the outcome back. Platform-secret gated.
  app.get('/internal/platform-requests', async (c) => {
    const t = tenantIdOf.parse(c.req.query('tenantId'));
    const s = scopeIdOf.parse(c.req.query('scopeId'));
    return c.json(await deps.hostFor(c.env).listPlatformRequests(t, s));
  });

  // The intent JOURNAL (#618), not the drain queue: every intent this scope enqueued in
  // whatever state it settled, newest first. The drain never needs it — the control plane's
  // console does, because a `failed` connector intent's `last_error` is the whole diagnosis
  // ("HTTP 409 … requires valid personal number field") and it lives here, in the scope's own
  // deployment, where nothing but the read-only SQL console could reach it. Same
  // platform-secret gate as the pending read it sits beside.
  app.get('/internal/platform-requests/history', async (c) => {
    const t = tenantIdOf.parse(c.req.query('tenantId'));
    const s = scopeIdOf.parse(c.req.query('scopeId'));
    const filter = platformRequestFilter.parse({
      kind: c.req.query('kind'),
      status: c.req.query('status'),
      limit: c.req.query('limit') ? Number(c.req.query('limit')) : undefined,
    });
    return c.json(await deps.hostFor(c.env).listPlatformRequestHistory(t, s, filter));
  });

  // The connector write-back seam (#574): the shared control plane runs the connector
  // pass (poll sweep, and later webhook ingress + dispatch) for this CP-less deployment,
  // because the connection directory and its sealed secrets live platform-side and a
  // pushed script must never hold them. What comes BACK over these three verbs carries
  // no credential — an operation invocation, provider bytes, a grant tuple — and each is
  // authorized in the scope's own DO against its `connection:<id>` grants, exactly like
  // any other caller. Platform-secret gated with the rest of the surface.
  app.post('/internal/connector-invoke', async (c) => {
    const body = connectorInvokeBody.parse(await c.req.json());
    const result = await deps
      .hostFor(c.env)
      .connectorInvokeLocal(body.connectionId, body.tenantId, body.scopeId, body.operation, body.input);
    // Enveloped: an operation may legitimately return undefined, which bare JSON can't say.
    return c.json({ result: result ?? null });
  });

  // The bytes leg (#574): multipart, because provider artifacts (a sealed signed PDF)
  // cannot ride a JSON invoke. `meta` is a JSON string field, `body` the raw blob.
  app.post('/internal/connector-attachment', async (c) => {
    const form = await c.req.formData();
    const metaRaw = form.get('meta');
    if (typeof metaRaw !== 'string') {
      throw new HTTPException(400, { message: 'connector-attachment needs a `meta` JSON field' });
    }
    const meta = connectorAttachmentMeta.parse(JSON.parse(metaRaw));
    const blob = form.get('body');
    if (blob === null || typeof blob === 'string') {
      throw new HTTPException(400, { message: 'connector-attachment needs a `body` file field' });
    }
    const record = await deps.hostFor(c.env).connectorAttachmentUploadLocal(
      meta.connectionId,
      meta.tenantId,
      meta.scopeId,
      {
        entity: meta.entity,
        filename: meta.filename,
        contentType: meta.contentType,
        visibility: meta.visibility,
        body: new Uint8Array(await blob.arrayBuffer()),
      },
    );
    return c.json(record as Record<string, unknown>, 201);
  });

  // The bytes leg, OUTBOUND (#711): the platform runs this vertical's signing
  // connector and has to send the document the vertical rendered — but the metadata
  // row is in this deployment's ScopeDO and the object in this deployment's R2, so
  // the platform can only ask. Answered with the raw bytes and the record in a
  // header, rather than base64 in JSON, so a multi-megabyte contract costs no
  // re-encoding on either side.
  //
  // `404` means "this scope does not know that id" — a distinct answer from a
  // refusal, which comes back as the permission check's own error. Read-gated at the
  // far end like any other caller: the target's `readPermission`, checked against
  // this connection's delivered tuple.
  app.get('/internal/connector-attachment/:attachmentId', async (c) => {
    const connection = connectionIdOf.parse(c.req.query('connectionId'));
    const t = tenantIdOf.parse(c.req.query('tenantId'));
    const s = scopeIdOf.parse(c.req.query('scopeId'));
    const opened = await deps
      .hostFor(c.env)
      .connectorAttachmentOpenLocal(connection, t, s, c.req.param('attachmentId'));
    if (!opened) return c.body(null, 404);
    return c.body(opened.body as unknown as ArrayBuffer, 200, {
      'content-type': opened.contentType,
      [CONNECTOR_ATTACHMENT_RECORD_HEADER]: JSON.stringify(opened.record),
    });
  });

  // Grant delivery (#574): the scope-level `connection:<id>` tuple the two verbs above
  // are checked against. Idempotent (INSERT OR REPLACE). No revoke mirror: every
  // delegated call re-passes the platform's live-connection gate first, so revoking
  // the connection closes the door even while the tuple remains.
  app.post('/internal/connector-grant', async (c) => {
    const body = connectorGrantBody.parse(await c.req.json());
    await deps
      .hostFor(c.env)
      .connectorGrantLocal(body.connectionId, body.scopeId, body.permission, body.expiresAt);
    return c.json({ granted: body.permission, scopeId: body.scopeId });
  });

  app.post('/internal/platform-requests/settle', async (c) => {
    const body = settleBody.parse(await c.req.json());
    await deps.hostFor(c.env).settlePlatformRequest(body.tenantId, body.scopeId, body.id, {
      status: body.status,
      result: body.result,
      lastError: body.lastError ?? null,
    });
    return c.json({ ok: true });
  });

  // ── Flavored routes: platform owns the gate + parse + envelope, vertical owns the hook ──

  // Provision ONE scope on the platform's instruction (K-31), CP-less: migrate the module
  // tables, project the role defs, grant the owner their role at scope level. The shared
  // control plane already owns the directory row + entitlements. Idempotent.
  app.post('/internal/provision', async (c) => {
    const body = provisionBody.parse(await c.req.json());
    await deps.hostFor(c.env).provisionScopeLocal({
      tenantId: body.tenantId,
      scopeId: body.scopeId,
      owner: body.owner,
      roles: deps.roles,
      ownerRoleKey: deps.ownerRoleKey,
      entitlements: body.entitlements,
      identityLinks: body.identityLinks,
      connectionGrants: body.connectionGrants,
    });
    await deps.onProvision?.(c.env, body);
    return c.json({ tenantId: body.tenantId, scopeId: body.scopeId, owner: body.owner }, 201);
  });

  // Repair a scope stuck at the #332 lockout (roles projected, no principal holding one —
  // e.g. a promote recreated the scope DO storage, #321). The builder can't reach the
  // secret-gated /internal/provision, so the control plane calls this on their behalf
  // after checking ownership. It re-sources the owner from the vertical's durable
  // owner-of-record and re-runs the idempotent provision. No owner in the body.
  app.post('/internal/reconcile', async (c) => {
    if (!deps.resolveOwner) {
      throw new HTTPException(501, { message: 'this vertical keeps no owner-of-record to reconcile from' });
    }
    const body = reconcileBody.parse(await c.req.json());
    const owner = await deps.resolveOwner(c.env, { tenantId: body.tenantId, scopeId: body.scopeId });
    if (!owner) {
      throw new HTTPException(409, {
        message: `no owner of record for scope ${body.scopeId} — cannot reconcile; re-run the full install`,
      });
    }
    await deps.hostFor(c.env).provisionScopeLocal({
      tenantId: body.tenantId,
      scopeId: body.scopeId,
      owner,
      roles: deps.roles,
      ownerRoleKey: deps.ownerRoleKey,
      entitlements: body.entitlements,
      identityLinks: body.identityLinks,
      connectionGrants: body.connectionGrants,
    });
    return c.json({ tenantId: body.tenantId, scopeId: body.scopeId, owner });
  });

  // Upsert per-instance config on the platform's instruction (vertical-auth-detach.md
  // §2.2) — the delivery half of the dashboard's Env tab, and how a scope's `substrat:auth`
  // issuer choice arrives. Idempotent upserts; keyed by scope.
  app.post('/internal/configure', async (c) => {
    if (!deps.onConfigure) {
      throw new HTTPException(501, { message: 'this vertical stores no per-instance config' });
    }
    const body = configureBody.parse(await c.req.json());
    await deps.onConfigure(c.env, body);
    return c.json({ scopeId: body.scopeId, entries: body.entries.length });
  });

  // ── The guaranteed error envelope — the whole point (#510). Without this, Hono answers
  //    an uncaught throw with the runtime's bare "Internal Server Error" and the control
  //    plane relays that with no diagnosis. Here every failure becomes { error: <message> },
  //    which vertical-client.refusal() passes through intact. Registered LAST so it wins. ──
  app.onError((err, c) => {
    const mapped = deps.mapError?.(err);
    if (mapped) return c.json({ error: mapped.message }, mapped.status as ContentfulStatusCode);
    const status = err instanceof HTTPException ? err.status : 400;
    const m = err instanceof Error ? err.message : String(err);
    // An infrastructure fault is the PLATFORM failing, not the request (#559). Defaulting
    // it to 400 taught every layer above to treat a Cloudflare outage as the caller's
    // fault — the control plane relays the status verbatim, and its retry convention
    // (install path) deliberately retries 5xx while surfacing 4xx immediately, so the
    // misclassification also disarmed any retry. 502 is the honest answer. Log it
    // structured so the vertical's observability keeps stage + reference queryable.
    if (status === 400 && isPlatformFault(err, m)) {
      console.error('vertical-host.platform-fault', {
        method: c.req.method,
        path: c.req.path,
        detail: m,
        stack: err instanceof Error ? err.stack : undefined,
      });
      return c.json({ error: m }, 502);
    }
    // Map the kernel/engine error vocabulary onto HTTP. Only reinterpret the default 400 —
    // an explicit HTTPException status (403/404/409/501 the routes raise) is authoritative.
    if (status === 400 && /permission denied/i.test(m)) return c.json({ error: m }, 403);
    if (status === 400 && /not found|unknown scope/i.test(m)) return c.json({ error: m }, 404);
    if (status === 400 && /invalid transition|immutable/i.test(m)) return c.json({ error: m }, 409);
    return c.json({ error: m }, status);
  });
}
