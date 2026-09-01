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
import { classifyError, messageOf, problemOf } from './errors.js';
import {
  assertPlatformCall,
  CONNECTOR_ATTACHMENT_RECORD_HEADER,
  PlatformCallError,
} from '@substrat-run/kernel';
import {
  z,
  PROBLEM_CONTENT_TYPE,
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
  projectedConnectionKey,
  projectedIdentityLink,
  ownerSeat,
  ownerClaimLink,
  platformRequestFilter,
  denialFilter,
  type DenialFilter,
  type DenialSummary,
  type PermissionDenial,
  platformRequestId,
  platformRequestStatus,
  platformRequestFailure,
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
  type ProjectedConnectionKey,
  type ProjectedIdentityLink,
  type OwnerClaimLink,
  type PlatformRequest,
  type PlatformRequestFilter,
  type PlatformRequestId,
  type PlatformRequestStatus,
  type PlatformRequestFailure,
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
    connectionKeys?: ProjectedConnectionKey[];
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
  listDenialsLocal(scopeId: ScopeId, filter?: DenialFilter): Promise<PermissionDenial[]>;
  summarizeDenialsLocal(scopeId: ScopeId, filter?: DenialFilter): Promise<DenialSummary>;
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
    outcome: {
      status: PlatformRequestStatus;
      result?: unknown;
      lastError?: string | null;
      failure?: PlatformRequestFailure | null;
    },
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
  /** The outbound read (#711) — the vertical's own document, handed back by id.
   *  `eventId` (#726) names the delivery asking; resolved HERE against this
   *  deployment's own outbox, it admits the attachments of that event's entity and
   *  nothing else, which is what lets the read need no standing grant. */
  connectorAttachmentOpenLocal(
    connectionId: ConnectionId,
    tenantId: TenantId,
    scopeId: ScopeId,
    attachmentId: string,
    eventId?: string,
  ): Promise<{ record: unknown; body: Uint8Array; contentType: string } | null>;
  connectorGrantLocal(
    connectionId: ConnectionId,
    scopeId: ScopeId,
    permission: PermissionKey,
    expiresAt?: string,
  ): Promise<void>;
}

/**
 * The denial-log filter, off the query string (#867). Both denial routes take the same
 * one, and it is PARSED here rather than forwarded: what arrives is text, and what it
 * narrows is a SQL read of the scope's own log.
 */
const denialQuery = (c: { req: { query: (k: string) => string | undefined } }): DenialFilter =>
  denialFilter.parse({
    actor: c.req.query('actor'),
    permission: c.req.query('permission'),
    operation: c.req.query('operation'),
    since: c.req.query('since'),
    until: c.req.query('until'),
    limit: c.req.query('limit') ? Number(c.req.query('limit')) : undefined,
  });

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
  connectionKeys: z.array(projectedConnectionKey).optional(),
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
  connectionKeys: z.array(projectedConnectionKey).optional(),
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

/** `/internal/owner-claim` body (#925). `origin` is the instance's public origin, supplied by the
 *  platform (it owns the hostname directory; a dispatched `/internal` call carries no usable host). */
const ownerClaimBody = z.object({
  tenantId: tenantIdOf,
  scopeId: scopeIdOf,
  origin: z.string().url(),
});

const settleBody = z.object({
  tenantId: tenantIdOf,
  scopeId: scopeIdOf,
  id: platformRequestId,
  status: platformRequestStatus,
  result: z.unknown().optional(),
  lastError: z.string().nullable().optional(),
  // #841. Optional so a control plane too old to attribute still settles — the column
  // then stays NULL, which reads as "nobody classified this" rather than a guess.
  failure: platformRequestFailure.nullable().optional(),
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
   * The scope's owner seat as the platform may see it (#925) — claimed, unclaimed (and whether
   * a plain first sign-in still claims it), or unknown. Omit ⇒ `/internal/owner-seat` answers
   * 501: the vertical keeps no owner seat (it binds logins some other way).
   */
  ownerSeat?: (env: Env, ref: { tenantId: TenantId; scopeId: ScopeId }) => Promise<z.input<typeof ownerSeat>>;
  /**
   * Mint a short-lived claim link for an UNCLAIMED owner seat (#925) — what the dashboard
   * hands the installer once the first-sign-in window has closed (or instead of relying on
   * it). Return `null` when the seat is already claimed (⇒ 409). The link is answered to the
   * platform and never persisted by it; the vertical stores only the token's hash. Omit ⇒
   * `/internal/owner-claim` answers 501.
   */
  mintOwnerClaim?: (
    env: Env,
    ref: { tenantId: TenantId; scopeId: ScopeId },
    input: { origin: string },
  ) => Promise<OwnerClaimLink | null>;
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

  // The K-35 denial log (#867). The rows live in THIS deployment — a denial is written
  // in the scope's own DO, where the refused operation ran — so the control plane has
  // to ask for them, exactly as it does for the tables and the intent journal. The K-3
  // check and the K-24 access-log entry are made on the platform side before this is
  // reached; the gate here is the platform secret, like the rest of the surface.
  app.get('/internal/denials', async (c) => {
    const s = scopeIdOf.parse(c.req.query('scopeId'));
    return c.json(await deps.hostFor(c.env).listDenialsLocal(s, denialQuery(c)));
  });

  // The bucketed view (K-35's rate-buckets). Its own route rather than a flag on the
  // one above: it returns a different shape, and it is the read a console opens first.
  app.get('/internal/denials/summary', async (c) => {
    const s = scopeIdOf.parse(c.req.query('scopeId'));
    return c.json(await deps.hostFor(c.env).summarizeDenialsLocal(s, denialQuery(c)));
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
      .connectorAttachmentOpenLocal(
        connection,
        t,
        s,
        c.req.param('attachmentId'),
        c.req.query('eventId'),
      );
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
      failure: body.failure ?? null,
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
      connectionKeys: body.connectionKeys,
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
      connectionKeys: body.connectionKeys,
    });
    /**
     * The VERTICAL's half of a provision runs here too — and it did not, which made this
     * route a repair that could not repair.
     *
     * "Re-runs the idempotent provision" was only ever true of the kernel half: roles
     * projected, owner seated. Everything a vertical does for itself at provision — the
     * service principals ticket0 mints, the site another registers — was skipped, so a
     * scope could be reconciled as often as you liked and still be missing whatever its
     * own hook creates. That is worst exactly where it matters most: an install that
     * predates a new service principal has no other way to receive one, since
     * `/internal/provision` is called at install and never again.
     *
     * `onProvision` is required to be idempotent (this route and the drain's retry both
     * re-run it), so calling it here asks nothing new of a vertical. `slug` and `name`
     * are absent — the platform does not carry them on a reconcile, and both are
     * optional for exactly this kind of caller.
     */
    await deps.onProvision?.(c.env, {
      tenantId: body.tenantId,
      scopeId: body.scopeId,
      owner,
      ...(body.entitlements ? { entitlements: body.entitlements } : {}),
      ...(body.identityLinks ? { identityLinks: body.identityLinks } : {}),
      ...(body.connectionGrants ? { connectionGrants: body.connectionGrants } : {}),
      ...(body.connectionKeys ? { connectionKeys: body.connectionKeys } : {}),
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

  // The owner seat (#925), read and claimed on the platform's instruction. Both answer 501
  // without a hook, so a control plane can tell "this vertical binds logins some other way"
  // from a failure. The claim link is the ONE `/internal` answer that carries a credential,
  // and it is allowed to precisely because nothing persists it: the vertical holds a hash,
  // the platform relays it once, the dashboard shows it. Parsed on the way OUT as well as in
  // — a hook returning the wrong shape is a 400 here, never a half-rendered seat upstream.
  app.get('/internal/owner-seat', async (c) => {
    if (!deps.ownerSeat) {
      throw new HTTPException(501, { message: 'this vertical keeps no owner seat' });
    }
    const ref = {
      tenantId: tenantIdOf.parse(c.req.query('tenantId')),
      scopeId: scopeIdOf.parse(c.req.query('scopeId')),
    };
    return c.json(ownerSeat.parse(await deps.ownerSeat(c.env, ref)));
  });

  app.post('/internal/owner-claim', async (c) => {
    if (!deps.mintOwnerClaim) {
      throw new HTTPException(501, { message: 'this vertical keeps no owner seat' });
    }
    const body = ownerClaimBody.parse(await c.req.json());
    const link = await deps.mintOwnerClaim(
      c.env,
      { tenantId: body.tenantId, scopeId: body.scopeId },
      { origin: body.origin },
    );
    if (!link) {
      throw new HTTPException(409, {
        message: `the owner seat of scope ${body.scopeId} is already claimed — nothing to mint a claim link for`,
      });
    }
    return c.json(ownerClaimLink.parse(link), 201);
  });

  // ── The guaranteed error envelope — the whole point (#510). Without this, Hono answers
  //    an uncaught throw with the runtime's bare "Internal Server Error" and the control
  //    plane relays that with no diagnosis. Here every failure becomes { error: <message> },
  //    which vertical-client.refusal() passes through intact. Registered LAST so it wins. ──
  app.onError((err, c) => {
    // The shared vocabulary (`./errors.ts`) decides the status. It also answers "no
    // opinion", which THIS surface turns into the caller's 400 — the control plane
    // relays the status verbatim and retries 5xx, so an unrecognised throw must not
    // claim to be the platform's fault. `mountOperations` answers no-opinion differently.
    // A vertical's own `mapError` outranks it and is rendered the same way, so its
    // answer is a problem document too rather than the last `{ error }` on the surface.
    const mapped = deps.mapError?.(err);
    const seen = mapped
      ? { status: mapped.status as ContentfulStatusCode, message: mapped.message }
      : (classifyError(err) ?? {
          status: 400 as ContentfulStatusCode,
          message: messageOf(err),
        });
    // An infrastructure fault is the PLATFORM failing, not the request (#559). Defaulting
    // it to 400 taught every layer above to treat a Cloudflare outage as the caller's
    // fault — the control plane relays the status verbatim, and its retry convention
    // (install path) deliberately retries 5xx while surfacing 4xx immediately, so the
    // misclassification also disarmed any retry. 502 is the honest answer. Log it
    // structured so the vertical's observability keeps stage + reference queryable.
    if (seen.platformFault) {
      console.error('vertical-host.platform-fault', {
        method: c.req.method,
        path: c.req.path,
        detail: seen.message,
        stack: err instanceof Error ? err.stack : undefined,
      });
    }
    const { body } = problemOf(seen, err, c.req.path);
    return c.body(JSON.stringify(body), seen.status, {
      'content-type': PROBLEM_CONTENT_TYPE,
    });
  });
}

export * from './operations-routes.js';
export * from './mcp.js';
export * from './public-surface.js';
export {
  classifyError,
  isPlatformFault,
  messageOf,
  problemFor,
  problemOf,
  problemResponse,
} from './errors.js';
export type { ClassifiedProblem, ErrorClassification } from './errors.js';
