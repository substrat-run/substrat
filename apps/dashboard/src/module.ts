import { z } from 'zod';
import { moduleManifest, permissionKey, type PermissionKey, type OrgId } from '@substrat-run/contracts';
import {
  assertAllowed,
  ulid,
  type ModuleRegistration,
  type OperationContext,
  type OperationHandler,
} from '@substrat-run/kernel';
import { INVITES_PERM, sendInvite, acceptInvite, revokeInvite } from '@substrat-run/engine-invites';

// ============================================================================
// The Dashboard — the tenant-facing self-service surface, built AS a Substrat
// vertical (the platform, dogfooded). See docs/design/dashboard.md.
//
// This module owns the customer's OWN data + permissions: the list of apps they
// have created (a `dashboard_apps` row per provisioned instance) and the keys
// that authorize managing them. The actual scope provisioning is NOT here —
// `provisionScope` is a ScopeHost action, so it runs in app-level code
// (`createApp` in provision.ts) with the tenant taken from the caller's own
// dashboard scope, never a request argument. This module answers "can they?" and
// records the result; the app layer effects it, narrowed to the caller's tenant.
// ============================================================================

export const DASHBOARD_PERM = {
  /** Create/track an app (a provisioned vertical instance) in this tenant. Held by the owner. */
  provisionApp: permissionKey.parse('dashboard:provision-app'),
  /** Read the account's apps. */
  read: permissionKey.parse('dashboard:read'),
  /** Invite/remove members and see the roster — the tenant-admin membership surface. */
  manageMembers: permissionKey.parse('dashboard:manage-members'),
  /**
   * Connect/disconnect third-party providers (GitHub, Scrive, …) for this tenant.
   * The in-scope authorization for a self-serve connect (connections.md §3.5.1): the
   * host effects the sealed write, but the *right* to connect is checked here.
   */
  manageIntegrations: permissionKey.parse('dashboard:manage-integrations'),
};

/**
 * The team roles a member can hold, each mapped to the permission set it carries.
 * `provision.ts` renders `ROLES` (the RoleDefinition[] the checkpoint reviews) from
 * this same map, so the artifact and the runtime agree by construction. The invite
 * flow enforces the §5.1 bound against these sets — a caller may only invite at a
 * role whose every permission they already hold (membership.md §5.1; the kernel does
 * NOT enforce this, so the dashboard does).
 *
 * `owner` and `admin` are equal in permissions today; the distinction is that the
 * owner is the un-removable first member (and will own billing). `member` runs apps
 * but cannot manage the team; `viewer` is read-only.
 */
export const MEMBER_ROLES: Record<string, PermissionKey[]> = {
  owner: [DASHBOARD_PERM.provisionApp, DASHBOARD_PERM.read, DASHBOARD_PERM.manageMembers, DASHBOARD_PERM.manageIntegrations, INVITES_PERM.send, INVITES_PERM.read, INVITES_PERM.revoke],
  admin: [DASHBOARD_PERM.provisionApp, DASHBOARD_PERM.read, DASHBOARD_PERM.manageMembers, DASHBOARD_PERM.manageIntegrations, INVITES_PERM.send, INVITES_PERM.read, INVITES_PERM.revoke],
  member: [DASHBOARD_PERM.provisionApp, DASHBOARD_PERM.read],
  viewer: [DASHBOARD_PERM.read],
};

export type MemberRole = keyof typeof MEMBER_ROLES;

export const dashboardManifest = moduleManifest.parse({
  id: '@substrat-run/dashboard',
  version: '0.0.1',
  kernelContract: '^0.0.1',
  permissions: [
    {
      key: 'dashboard:provision-app',
      description:
        'Provision and manage apps (vertical instances) in this tenant — the tenant admin',
    },
    { key: 'dashboard:read', description: 'Read the tenant’s apps' },
    {
      key: 'dashboard:manage-members',
      description: 'Invite and remove team members and see the roster',
    },
    {
      key: 'dashboard:manage-integrations',
      description: 'Connect and disconnect third-party providers (GitHub, Scrive) for this tenant',
    },
  ],
  events: { emits: [], consumes: [] },
  migrations: { journalDir: './migrations', compatibleFrom: '0.0.1' },
  attachmentTargets: [],
  entitlementKey: 'dashboard',
});

export const dashboardMigrations = [
  {
    version: '0001-init',
    sql: `
      -- One row per app (provisioned vertical instance) the tenant owns. The app
      -- itself is a separate SCOPE running that vertical; this is the account's
      -- own record of it, keyed by the app's scope id.
      CREATE TABLE dashboard_apps (
        id            TEXT PRIMARY KEY,
        app_scope_id  TEXT NOT NULL UNIQUE,
        vertical_slug TEXT NOT NULL,
        name          TEXT NOT NULL,
        status        TEXT NOT NULL CHECK (status IN ('provisioning','active','failed')),
        hostname      TEXT,
        created_by    TEXT NOT NULL,
        created_at    TEXT NOT NULL
      );
    `,
  },
  {
    version: '0002-app-deleted',
    sql: `
      -- Soft delete: deleting an app deprovisions its scope but keeps the record
      -- (the account's audit history is retained). A non-null timestamp hides the
      -- row from list-apps; the status enum is left alone so no table rebuild.
      ALTER TABLE dashboard_apps ADD COLUMN deleted_at TEXT;
    `,
  },
  {
    version: '0003-members',
    sql: `
      -- The team roster PROJECTION. There is no kernel "who holds a role at this
      -- tenant" query, so the dashboard keeps its own readable roster: one row per
      -- member (active) or outstanding invite (invited). Access itself is the kernel
      -- role assignment at the tenant node; this table is the human-facing view of it
      -- plus the plaintext the invites engine deliberately does not keep (it hashes
      -- identifiers). The admin legitimately sees whom they invited, so storing the
      -- email here is intended — the engine's non-enumerability protects the ACCEPT
      -- path and cross-tenant correlation, not the owner's view of their own team.
      CREATE TABLE dashboard_members (
        id            TEXT PRIMARY KEY,
        -- The kernel principal once accepted; NULL while still 'invited'.
        principal     TEXT UNIQUE,
        email         TEXT NOT NULL,
        role_key      TEXT NOT NULL,
        status        TEXT NOT NULL CHECK (status IN ('active','invited','revoked')),
        -- Links a pending row to its invites-engine invitation (the accept gate).
        invitation_id TEXT UNIQUE,
        invited_by    TEXT NOT NULL,
        invited_at    TEXT NOT NULL,
        joined_at     TEXT
      );
      CREATE INDEX dashboard_members_by_status ON dashboard_members (status);

      -- Per-team settings, one row. Holds the org id every team invitation is keyed
      -- by (the invites engine keys on org). Written once when the team is created.
      CREATE TABLE dashboard_team (
        org_id TEXT NOT NULL
      );
    `,
  },
  {
    version: '0004-app-events',
    sql: `
      -- The per-app audit trail: one append-only row per lifecycle transition of a
      -- provisioned app (created / active / failed / deleted). This is what the app's
      -- Activity panel shows — REAL events, including a failed provision's REASON, so a
      -- 'no deployment is bound' error is recorded here rather than only flashing as a toast.
      CREATE TABLE dashboard_app_events (
        id           TEXT PRIMARY KEY,
        app_scope_id TEXT NOT NULL,
        kind         TEXT NOT NULL CHECK (kind IN ('created','active','failed','deleted')),
        detail       TEXT,           -- failure reason / bound hostname / null
        actor        TEXT NOT NULL,  -- the principal that caused the transition
        created_at   TEXT NOT NULL
      );
      CREATE INDEX dashboard_app_events_by_app ON dashboard_app_events (app_scope_id, created_at);
    `,
  },
  {
    version: '0005-app-updated-event',
    sql: `
      -- Widen the event kinds to include 'updated' — an app moved to a newer version
      -- (its scope rebound to a new deploymentRef). SQLite can't ALTER a CHECK, so
      -- rebuild the table with the wider constraint and copy the rows. 0004 is untouched
      -- (append-only): this is a new, ordered migration.
      CREATE TABLE dashboard_app_events_new (
        id           TEXT PRIMARY KEY,
        app_scope_id TEXT NOT NULL,
        kind         TEXT NOT NULL CHECK (kind IN ('created','active','failed','deleted','updated')),
        detail       TEXT,
        actor        TEXT NOT NULL,
        created_at   TEXT NOT NULL
      );
      INSERT INTO dashboard_app_events_new (id, app_scope_id, kind, detail, actor, created_at)
        SELECT id, app_scope_id, kind, detail, actor, created_at FROM dashboard_app_events;
      DROP TABLE dashboard_app_events;
      ALTER TABLE dashboard_app_events_new RENAME TO dashboard_app_events;
      CREATE INDEX dashboard_app_events_by_app ON dashboard_app_events (app_scope_id, created_at);
    `,
  },
  {
    version: '0006-app-env',
    sql: `
      -- Per-app environment/config the tenant MANAGES from the dashboard: one row per
      -- (app, key). This is the management surface — the account's own record of its
      -- app's config, rendered as a form from the vertical's declared env-spec. DELIVERY
      -- to the running app scope (a hosted vertical reads its per-scope config at runtime,
      -- the connections.md model) is a separate step; this table is where the values are
      -- authored and held meanwhile.
      --
      -- Secret values live here in the tenant's OWN dashboard scope for now; they are
      -- never echoed back over the API (write-only). The production path seals a secret
      -- value via the host SecretBox (connections.md §3.5), the same way an OAuth secret
      -- is kept — not plaintext at rest. Flagged so the checkpoint sees it.
      CREATE TABLE dashboard_app_env (
        id           TEXT PRIMARY KEY,
        app_scope_id TEXT NOT NULL,
        key          TEXT NOT NULL,
        value        TEXT NOT NULL,
        is_secret    INTEGER NOT NULL DEFAULT 0,
        updated_by   TEXT NOT NULL,
        updated_at   TEXT NOT NULL
      );
      CREATE UNIQUE INDEX dashboard_app_env_key ON dashboard_app_env (app_scope_id, key);
    `,
  },
  {
    version: '0007-app-snapshot-events',
    sql: `
      -- Widen the event kinds again, for the Snapshots tab (preview-and-snapshots.md
      -- §3): 'snapshotted' (a test copy of the app's data was taken) and
      -- 'snapshot-deleted' (a copy was removed, by hand or by the GC sweep's expiry).
      -- Same rebuild-and-copy shape as 0005 — SQLite can't ALTER a CHECK, and 0005
      -- stays untouched (append-only).
      CREATE TABLE dashboard_app_events_new (
        id           TEXT PRIMARY KEY,
        app_scope_id TEXT NOT NULL,
        kind         TEXT NOT NULL CHECK (kind IN ('created','active','failed','deleted','updated','snapshotted','snapshot-deleted')),
        detail       TEXT,
        actor        TEXT NOT NULL,
        created_at   TEXT NOT NULL
      );
      INSERT INTO dashboard_app_events_new (id, app_scope_id, kind, detail, actor, created_at)
        SELECT id, app_scope_id, kind, detail, actor, created_at FROM dashboard_app_events;
      DROP TABLE dashboard_app_events;
      ALTER TABLE dashboard_app_events_new RENAME TO dashboard_app_events;
      CREATE INDEX dashboard_app_events_by_app ON dashboard_app_events (app_scope_id, created_at);
    `,
  },
  {
    version: '0008-app-data-events',
    sql: `
      -- Widen the event kinds for the Export & import card (preview-and-snapshots.md
      -- §8): 'data-exported' (the app's data left as a dump) and 'data-restored' (an
      -- uploaded dump replaced the app's data; the detail names the safety copy).
      -- Same rebuild-and-copy shape as 0005/0007 — SQLite can't ALTER a CHECK, and
      -- the shipped migrations stay untouched (append-only).
      CREATE TABLE dashboard_app_events_new (
        id           TEXT PRIMARY KEY,
        app_scope_id TEXT NOT NULL,
        kind         TEXT NOT NULL CHECK (kind IN ('created','active','failed','deleted','updated','snapshotted','snapshot-deleted','data-exported','data-restored')),
        detail       TEXT,
        actor        TEXT NOT NULL,
        created_at   TEXT NOT NULL
      );
      INSERT INTO dashboard_app_events_new (id, app_scope_id, kind, detail, actor, created_at)
        SELECT id, app_scope_id, kind, detail, actor, created_at FROM dashboard_app_events;
      DROP TABLE dashboard_app_events;
      ALTER TABLE dashboard_app_events_new RENAME TO dashboard_app_events;
      CREATE INDEX dashboard_app_events_by_app ON dashboard_app_events (app_scope_id, created_at);
    `,
  },
  {
    version: '0009-app-hostname-events',
    sql: `
      -- Widen the event kinds for the Domains tab (K-26 multi-surface exposure):
      -- 'hostname-bound' (a surface got a URL — platform-minted or a custom domain)
      -- and 'hostname-unbound' (a binding was removed; the detail names it). Same
      -- rebuild-and-copy shape as 0005/0007/0008 — SQLite can't ALTER a CHECK, and
      -- the shipped migrations stay untouched (append-only).
      CREATE TABLE dashboard_app_events_new (
        id           TEXT PRIMARY KEY,
        app_scope_id TEXT NOT NULL,
        kind         TEXT NOT NULL CHECK (kind IN ('created','active','failed','deleted','updated','snapshotted','snapshot-deleted','data-exported','data-restored','hostname-bound','hostname-unbound')),
        detail       TEXT,
        actor        TEXT NOT NULL,
        created_at   TEXT NOT NULL
      );
      INSERT INTO dashboard_app_events_new (id, app_scope_id, kind, detail, actor, created_at)
        SELECT id, app_scope_id, kind, detail, actor, created_at FROM dashboard_app_events;
      DROP TABLE dashboard_app_events;
      ALTER TABLE dashboard_app_events_new RENAME TO dashboard_app_events;
      CREATE INDEX dashboard_app_events_by_app ON dashboard_app_events (app_scope_id, created_at);
    `,
  },
  {
    version: '0010-app-resumed-event',
    sql: `
      -- Widen the event kinds with 'resumed' — an install stuck at 'provisioning'
      -- (worker died mid-sequence, browser closed) re-ran its idempotent tail in
      -- place (#424 case 4). Same rebuild-and-copy shape as 0005/0007/0008/0009 —
      -- SQLite can't ALTER a CHECK, and shipped migrations stay untouched.
      CREATE TABLE dashboard_app_events_new (
        id           TEXT PRIMARY KEY,
        app_scope_id TEXT NOT NULL,
        kind         TEXT NOT NULL CHECK (kind IN ('created','active','failed','deleted','updated','snapshotted','snapshot-deleted','data-exported','data-restored','hostname-bound','hostname-unbound','resumed')),
        detail       TEXT,
        actor        TEXT NOT NULL,
        created_at   TEXT NOT NULL
      );
      INSERT INTO dashboard_app_events_new (id, app_scope_id, kind, detail, actor, created_at)
        SELECT id, app_scope_id, kind, detail, actor, created_at FROM dashboard_app_events;
      DROP TABLE dashboard_app_events;
      ALTER TABLE dashboard_app_events_new RENAME TO dashboard_app_events;
      CREATE INDEX dashboard_app_events_by_app ON dashboard_app_events (app_scope_id, created_at);
    `,
  },
];

export interface DashboardAppRow {
  id: string;
  app_scope_id: string;
  vertical_slug: string;
  name: string;
  status: 'provisioning' | 'active' | 'failed';
  hostname: string | null;
  created_by: string;
  created_at: string;
  deleted_at: string | null;
}

/** One stored env var for an app (the raw row; secrets never leave the module unmasked). */
export interface DashboardAppEnvRow {
  id: string;
  app_scope_id: string;
  key: string;
  value: string;
  is_secret: number;
  updated_by: string;
  updated_at: string;
}

/** One env var as the dashboard exposes it — a secret's value is never echoed back. */
export interface AppEnvValue {
  key: string;
  isSecret: boolean;
  /** Whether a value is stored (a secret shows "set" without revealing it). */
  hasValue: boolean;
  /** The plaintext for a non-secret; null for a secret (write-only). */
  value: string | null;
  updatedAt: string;
}

/** One row of the app's audit trail — a lifecycle transition. */
export interface DashboardAppEventRow {
  id: string;
  app_scope_id: string;
  kind: 'created' | 'active' | 'failed' | 'deleted' | 'updated' | 'snapshotted' | 'snapshot-deleted' | 'data-exported' | 'data-restored' | 'hostname-bound' | 'hostname-unbound' | 'resumed';
  detail: string | null;
  actor: string;
  created_at: string;
}

/** Append a lifecycle event for an app — the real Activity trail (created/active/failed/deleted). */
function recordAppEvent(
  ctx: OperationContext,
  appScopeId: string,
  kind: DashboardAppEventRow['kind'],
  detail?: string | null,
): void {
  ctx.sql.exec(
    `INSERT INTO dashboard_app_events (id, app_scope_id, kind, detail, actor, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [ulid(), appScopeId, kind, detail ?? null, ctx.principal, new Date().toISOString()],
  );
}

// -- operations --------------------------------------------------------------

const provisionAppInput = z.object({
  /** The scope id the app will run under (minted by the caller). */
  appScopeId: z.string().min(1),
  /** Which vertical this app runs — 'meridian', 'callout', … (catalog slug). */
  verticalSlug: z.string().min(1),
  name: z.string().min(1),
});

/**
 * Authorize + record an app before the platform effect. Its FIRST line is the
 * permission check — the "can they?" the whole self-service model rests on. It
 * only writes this tenant's own `dashboard_apps` row (status `provisioning`); the
 * scope itself is provisioned by the app layer afterwards, in this same tenant.
 */
const provisionAppOp: OperationHandler<z.infer<typeof provisionAppInput>, DashboardAppRow> = async (
  ctx: OperationContext,
  raw,
) => {
  assertAllowed(await ctx.check(DASHBOARD_PERM.provisionApp));
  const input = provisionAppInput.parse(raw);
  const id = ulid();
  ctx.sql.exec(
    `INSERT INTO dashboard_apps (id, app_scope_id, vertical_slug, name, status, hostname, created_by, created_at)
     VALUES (?, ?, ?, ?, 'provisioning', NULL, ?, ?)`,
    [id, input.appScopeId, input.verticalSlug, input.name, ctx.principal, new Date().toISOString()],
  );
  recordAppEvent(ctx, input.appScopeId, 'created', input.verticalSlug);
  return ctx.sql.query<DashboardAppRow>('SELECT * FROM dashboard_apps WHERE id = ?', [id])[0]!;
};

const markAppActiveInput = z.object({
  appScopeId: z.string().min(1),
  hostname: z.string().min(1).optional(),
});

/** Flip an app to `active` once the platform provisioned its scope. Same authority as creating it. */
const markAppActiveOp: OperationHandler<z.infer<typeof markAppActiveInput>, DashboardAppRow> = async (
  ctx,
  raw,
) => {
  assertAllowed(await ctx.check(DASHBOARD_PERM.provisionApp));
  const input = markAppActiveInput.parse(raw);
  ctx.sql.exec(
    `UPDATE dashboard_apps SET status = 'active', hostname = COALESCE(?, hostname) WHERE app_scope_id = ?`,
    [input.hostname ?? null, input.appScopeId],
  );
  recordAppEvent(ctx, input.appScopeId, 'active', input.hostname ?? null);
  const row = ctx.sql.query<DashboardAppRow>('SELECT * FROM dashboard_apps WHERE app_scope_id = ?', [
    input.appScopeId,
  ])[0];
  if (!row) throw new Error(`no app for scope ${input.appScopeId}`);
  return row;
};

const updateAppInput = z.object({
  appScopeId: z.string().min(1),
  /** Human label of the move, e.g. "0.0.10 → 0.0.12" — shown on the Activity trail. */
  detail: z.string().min(1).optional(),
});

/**
 * Record that an app was moved to a newer version. The scope rebind is a platform
 * effect (the app layer calls `bindScopeVersion`); this is the in-scope authorize +
 * audit half — same authority as provisioning the app. Recording it here is what makes
 * a version bump show up on the Activity trail (the "nothing in the log" gap).
 */
const updateAppOp: OperationHandler<z.infer<typeof updateAppInput>, { ok: true }> = async (ctx, raw) => {
  assertAllowed(await ctx.check(DASHBOARD_PERM.provisionApp));
  const input = updateAppInput.parse(raw);
  recordAppEvent(ctx, input.appScopeId, 'updated', input.detail ?? null);
  return { ok: true };
};

const snapshotAppInput = z.object({
  appScopeId: z.string().min(1),
  /** Readable for the activity trail — e.g. "test copy, expires in 7 days". */
  detail: z.string().optional(),
});

/**
 * Authorize + record a snapshot of an app's data (preview-and-snapshots.md §3).
 * Same authority as managing the app; the platform effect (the fork itself)
 * happens after this asserts, on the tenant-narrowed authority — the same
 * check-then-effect split `dashboard/update-app` uses for a version rebind.
 */
const snapshotAppOp: OperationHandler<z.infer<typeof snapshotAppInput>, { ok: true }> = async (ctx, raw) => {
  assertAllowed(await ctx.check(DASHBOARD_PERM.provisionApp));
  const input = snapshotAppInput.parse(raw);
  recordAppEvent(ctx, input.appScopeId, 'snapshotted', input.detail ?? null);
  return { ok: true };
};

/** The inverse record: a snapshot of this app was deleted (reaped or by hand). */
const deleteAppSnapshotOp: OperationHandler<z.infer<typeof snapshotAppInput>, { ok: true }> = async (ctx, raw) => {
  assertAllowed(await ctx.check(DASHBOARD_PERM.provisionApp));
  const input = snapshotAppInput.parse(raw);
  recordAppEvent(ctx, input.appScopeId, 'snapshot-deleted', input.detail ?? null);
  return { ok: true };
};

/**
 * Authorize + record an export of the app's data (preview-and-snapshots.md §8's
 * governed pull, from the dashboard). Same check-then-effect split as a snapshot:
 * this asserts and writes the trail entry; the dump itself is the platform effect.
 */
const exportAppDataOp: OperationHandler<z.infer<typeof snapshotAppInput>, { ok: true }> = async (ctx, raw) => {
  assertAllowed(await ctx.check(DASHBOARD_PERM.provisionApp));
  const input = snapshotAppInput.parse(raw);
  recordAppEvent(ctx, input.appScopeId, 'data-exported', input.detail ?? null);
  return { ok: true };
};

/**
 * Authorize + record a restore INTO the app (§8's write half): an uploaded dump
 * replaces the app's data wholesale. The safety copy taken just before is part of
 * the recorded detail, so the trail names the fork to back out to.
 */
const restoreAppDataOp: OperationHandler<z.infer<typeof snapshotAppInput>, { ok: true }> = async (ctx, raw) => {
  assertAllowed(await ctx.check(DASHBOARD_PERM.provisionApp));
  const input = snapshotAppInput.parse(raw);
  recordAppEvent(ctx, input.appScopeId, 'data-restored', input.detail ?? null);
  return { ok: true };
};

/**
 * Authorize + record a hostname binding on one of this team's apps (K-26 multi-
 * surface). Same check-then-effect split as a snapshot: this asserts and writes the
 * trail entry; the platform effect (the directory bind, tenant-narrowed) follows.
 */
const bindAppHostnameOp: OperationHandler<z.infer<typeof snapshotAppInput>, { ok: true }> = async (ctx, raw) => {
  assertAllowed(await ctx.check(DASHBOARD_PERM.provisionApp));
  const input = snapshotAppInput.parse(raw);
  recordAppEvent(ctx, input.appScopeId, 'hostname-bound', input.detail ?? null);
  return { ok: true };
};

/** The inverse record: a hostname was unbound from this app (the detail names it). */
const unbindAppHostnameOp: OperationHandler<z.infer<typeof snapshotAppInput>, { ok: true }> = async (ctx, raw) => {
  assertAllowed(await ctx.check(DASHBOARD_PERM.provisionApp));
  const input = snapshotAppInput.parse(raw);
  recordAppEvent(ctx, input.appScopeId, 'hostname-unbound', input.detail ?? null);
  return { ok: true };
};

const resumeAppInput = z.object({ appScopeId: z.string().min(1) });

/**
 * Authorize + record a RESUME of an install stuck at `provisioning` (#424 case 4): the
 * worker died (or the browser closed) between the platform effect and `mark-app-active`,
 * leaving a row that renders as an eternal spinner with no affordance — `failed` has
 * Retry, `provisioning` had nothing. Same authority as creating the app; the platform
 * effect (re-running the idempotent install tail in place, same scope) follows in the
 * app layer. Guarded to `provisioning` rows only: an active app has nothing to resume,
 * and a failed one goes through Retry (fresh scope) instead.
 */
const resumeAppOp: OperationHandler<z.infer<typeof resumeAppInput>, DashboardAppRow> = async (ctx, raw) => {
  assertAllowed(await ctx.check(DASHBOARD_PERM.provisionApp));
  const input = resumeAppInput.parse(raw);
  const row = ctx.sql.query<DashboardAppRow & { deleted_at: string | null }>(
    'SELECT * FROM dashboard_apps WHERE app_scope_id = ?',
    [input.appScopeId],
  )[0];
  if (!row || row.deleted_at) throw new Error(`no app for scope ${input.appScopeId}`);
  if (row.status !== 'provisioning') {
    throw new Error(`only an app stuck at 'provisioning' can be resumed (this one is '${row.status}')`);
  }
  recordAppEvent(ctx, input.appScopeId, 'resumed', row.vertical_slug);
  return row;
};

const markAppFailedInput = z.object({
  appScopeId: z.string().min(1),
  /** Why it failed — recorded on the app's audit trail (e.g. "no deployment is bound"). */
  reason: z.string().optional(),
});

/**
 * Flip an app to `failed` when provisioning didn't complete (the vertical refused, a
 * hostname wouldn't bind, …). Same authority as creating it. Guarded to only move a
 * `provisioning` row, so it never clobbers an app that did come up. Without this a
 * failed create leaves the row silently at `provisioning` — indistinguishable from
 * "still coming up".
 */
const markAppFailedOp: OperationHandler<z.infer<typeof markAppFailedInput>, DashboardAppRow> = async (ctx, raw) => {
  assertAllowed(await ctx.check(DASHBOARD_PERM.provisionApp));
  const input = markAppFailedInput.parse(raw);
  ctx.sql.exec("UPDATE dashboard_apps SET status = 'failed' WHERE app_scope_id = ? AND status = 'provisioning'", [
    input.appScopeId,
  ]);
  recordAppEvent(ctx, input.appScopeId, 'failed', input.reason ?? null);
  const row = ctx.sql.query<DashboardAppRow>('SELECT * FROM dashboard_apps WHERE app_scope_id = ?', [
    input.appScopeId,
  ])[0];
  if (!row) throw new Error(`no app for scope ${input.appScopeId}`);
  return row;
};

/** The account's apps — a plain read, gated by `dashboard:read`. Deleted apps are hidden. */
const listAppsOp: OperationHandler<Record<string, never>, DashboardAppRow[]> = async (ctx) => {
  assertAllowed(await ctx.check(DASHBOARD_PERM.read));
  return ctx.sql.query<DashboardAppRow>(
    'SELECT * FROM dashboard_apps WHERE deleted_at IS NULL ORDER BY created_at DESC',
  );
};

const deleteAppInput = z.object({ appScopeId: z.string().min(1) });

/**
 * Soft-delete an app's record (same authority as creating it). The scope is
 * deprovisioned by the app layer afterwards (deprovisionApp in provision.ts); this
 * only stamps `deleted_at` so the row drops out of `list-apps` while the record —
 * the account's audit history — is retained. Idempotent: a second delete is a no-op.
 */
const deleteAppOp: OperationHandler<z.infer<typeof deleteAppInput>, DashboardAppRow> = async (ctx, raw) => {
  assertAllowed(await ctx.check(DASHBOARD_PERM.provisionApp));
  const input = deleteAppInput.parse(raw);
  const wasLive = ctx.sql.query<{ deleted_at: string | null }>(
    'SELECT deleted_at FROM dashboard_apps WHERE app_scope_id = ?',
    [input.appScopeId],
  )[0];
  ctx.sql.exec('UPDATE dashboard_apps SET deleted_at = ? WHERE app_scope_id = ? AND deleted_at IS NULL', [
    new Date().toISOString(),
    input.appScopeId,
  ]);
  // Only record on the transition (first delete), not on an idempotent repeat.
  if (wasLive && !wasLive.deleted_at) recordAppEvent(ctx, input.appScopeId, 'deleted');
  const row = ctx.sql.query<DashboardAppRow>('SELECT * FROM dashboard_apps WHERE app_scope_id = ?', [
    input.appScopeId,
  ])[0];
  if (!row) throw new Error(`no app for scope ${input.appScopeId}`);
  return row;
};

const appEventsInput = z.object({ appScopeId: z.string().min(1) });

/** The app's audit trail — newest first. A plain read, gated by `dashboard:read`. */
const appEventsOp: OperationHandler<z.infer<typeof appEventsInput>, DashboardAppEventRow[]> = async (ctx, raw) => {
  assertAllowed(await ctx.check(DASHBOARD_PERM.read));
  const input = appEventsInput.parse(raw);
  return ctx.sql.query<DashboardAppEventRow>(
    'SELECT * FROM dashboard_app_events WHERE app_scope_id = ? ORDER BY created_at DESC, id DESC',
    [input.appScopeId],
  );
};

// -- app environment / config ------------------------------------------------

const envKey = z.string().regex(/^[A-Z][A-Z0-9_]*$/, 'env keys are UPPER_SNAKE_CASE');

const setAppEnvInput = z.object({
  appScopeId: z.string().min(1),
  entries: z
    .array(z.object({ key: envKey, value: z.string(), secret: z.boolean().default(false) }))
    .min(1),
});

/**
 * Upsert an app's env/config. Same authority as managing the app (`provision-app`), so
 * no new permission key. An empty `value` is "leave unchanged" — that is how the form
 * submits without re-typing a secret it never received back (secret values are write-only,
 * so the client can't echo them); explicit removal is `delete-app-env`. Records the change
 * on the app's Activity trail (which keys moved, never the values).
 */
const setAppEnvOp: OperationHandler<z.infer<typeof setAppEnvInput>, { saved: number }> = async (ctx, raw) => {
  assertAllowed(await ctx.check(DASHBOARD_PERM.provisionApp));
  const input = setAppEnvInput.parse(raw);
  const now = new Date().toISOString();
  const saved: string[] = [];
  for (const e of input.entries) {
    if (e.value === '') continue; // leave-unchanged (untouched secret)
    ctx.sql.exec(
      `INSERT INTO dashboard_app_env (id, app_scope_id, key, value, is_secret, updated_by, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (app_scope_id, key) DO UPDATE SET
         value = excluded.value, is_secret = excluded.is_secret,
         updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
      [ulid(), input.appScopeId, e.key, e.value, e.secret ? 1 : 0, ctx.principal, now],
    );
    saved.push(e.key);
  }
  if (saved.length) recordAppEvent(ctx, input.appScopeId, 'updated', `env: ${saved.join(', ')}`);
  return { saved: saved.length };
};

const listAppEnvInput = z.object({ appScopeId: z.string().min(1) });

/** An app's stored env/config, secrets masked (value: null). Gated read. */
const listAppEnvOp: OperationHandler<z.infer<typeof listAppEnvInput>, AppEnvValue[]> = async (ctx, raw) => {
  assertAllowed(await ctx.check(DASHBOARD_PERM.read));
  const input = listAppEnvInput.parse(raw);
  // The `substrat:*` namespace is reserved for platform-managed entries (the app's
  // Identity choice lives at `substrat:auth`) — those have their own ops with
  // field-wise redaction, so they never appear as an opaque blob in the Env tab.
  const rows = ctx.sql.query<DashboardAppEnvRow>(
    "SELECT * FROM dashboard_app_env WHERE app_scope_id = ? AND key NOT LIKE 'substrat:%' ORDER BY key",
    [input.appScopeId],
  );
  return rows.map((r) => ({
    key: r.key,
    isSecret: r.is_secret === 1,
    hasValue: r.value !== '',
    value: r.is_secret === 1 ? null : r.value, // never echo a secret
    updatedAt: r.updated_at,
  }));
};

const deleteAppEnvInput = z.object({ appScopeId: z.string().min(1), key: envKey });

/** Remove one env var (same authority as setting it). Idempotent. */
const deleteAppEnvOp: OperationHandler<z.infer<typeof deleteAppEnvInput>, { ok: true }> = async (ctx, raw) => {
  assertAllowed(await ctx.check(DASHBOARD_PERM.provisionApp));
  const input = deleteAppEnvInput.parse(raw);
  ctx.sql.exec('DELETE FROM dashboard_app_env WHERE app_scope_id = ? AND key = ?', [input.appScopeId, input.key]);
  return { ok: true };
};

// -- app identity (the `substrat:auth` entry) --------------------------------

/**
 * The reserved key holding the app's Identity choice (vertical-auth-detach.md §2.4) —
 * the same JSON that `/internal/configure` delivers to the running scope. It shares
 * the env table (authored config, same authority) but sits outside the Env tab's
 * UPPER_SNAKE_CASE namespace and has its own ops, because the secret lives INSIDE
 * the JSON: masking the whole value would hide the issuer and clientId the user
 * legitimately needs to see, so redaction here is field-wise.
 */
const APP_AUTH_KEY = 'substrat:auth';

const appAuthConfig = z.object({
  mode: z.literal('oidc'),
  issuer: z.string().url(),
  clientId: z.string().min(1),
  clientSecret: z.string().min(1).optional(),
  audience: z.string().min(1).optional(),
});

/** The `substrat:auth` payload as authored/delivered — what `authProviderFor` parses. */
export type AppAuthConfig = z.infer<typeof appAuthConfig>;

/** The identity record as exposed to callers — the clientSecret never leaves. */
export interface AppAuthView {
  mode: 'oidc';
  issuer: string;
  clientId: string;
  audience: string | null;
  hasClientSecret: boolean;
  updatedAt: string;
}

const setAppAuthInput = z.object({ appScopeId: z.string().min(1), config: appAuthConfig });

/**
 * Record the app's identity choice (upsert, same authority as managing the app). An
 * absent clientSecret KEEPS the stored one — write-only like env secrets, so the form
 * can change issuer/clientId without re-typing a secret it never received back.
 * Returns the merged config so the caller can deliver exactly what was stored; the
 * Activity trail records the issuer, never the credentials.
 */
const setAppAuthOp: OperationHandler<z.infer<typeof setAppAuthInput>, AppAuthConfig> = async (ctx, raw) => {
  assertAllowed(await ctx.check(DASHBOARD_PERM.provisionApp));
  const input = setAppAuthInput.parse(raw);
  const merged: AppAuthConfig = { ...input.config };
  if (!merged.clientSecret) {
    const stored = readAppAuth(ctx, input.appScopeId);
    if (stored?.config.clientSecret) merged.clientSecret = stored.config.clientSecret;
  }
  ctx.sql.exec(
    `INSERT INTO dashboard_app_env (id, app_scope_id, key, value, is_secret, updated_by, updated_at)
     VALUES (?, ?, ?, ?, 1, ?, ?)
     ON CONFLICT (app_scope_id, key) DO UPDATE SET
       value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
    [ulid(), input.appScopeId, APP_AUTH_KEY, JSON.stringify(merged), ctx.principal, new Date().toISOString()],
  );
  recordAppEvent(ctx, input.appScopeId, 'updated', `identity: ${merged.issuer}`);
  return merged;
};

const getAppAuthInput = z.object({ appScopeId: z.string().min(1) });

/** The app's identity choice, clientSecret redacted. Null ⇒ the vertical's builtin auth. */
const getAppAuthOp: OperationHandler<z.infer<typeof getAppAuthInput>, AppAuthView | null> = async (ctx, raw) => {
  assertAllowed(await ctx.check(DASHBOARD_PERM.read));
  const input = getAppAuthInput.parse(raw);
  const stored = readAppAuth(ctx, input.appScopeId);
  if (!stored) return null;
  return {
    mode: stored.config.mode,
    issuer: stored.config.issuer,
    clientId: stored.config.clientId,
    audience: stored.config.audience ?? null,
    hasClientSecret: stored.config.clientSecret !== undefined,
    updatedAt: stored.updatedAt,
  };
};

/** The stored `substrat:auth` row, parsed; undefined when absent or unreadable. */
function readAppAuth(
  ctx: OperationContext,
  appScopeId: string,
): { config: AppAuthConfig; updatedAt: string } | undefined {
  const row = ctx.sql.query<DashboardAppEnvRow>(
    'SELECT * FROM dashboard_app_env WHERE app_scope_id = ? AND key = ?',
    [appScopeId, APP_AUTH_KEY],
  )[0];
  if (!row) return undefined;
  try {
    const parsed = appAuthConfig.safeParse(JSON.parse(row.value));
    return parsed.success ? { config: parsed.data, updatedAt: row.updated_at } : undefined;
  } catch {
    return undefined;
  }
}

// -- team + members ----------------------------------------------------------

export interface DashboardMemberRow {
  id: string;
  /** The kernel principal once accepted; null while still 'invited'. */
  principal: string | null;
  email: string;
  role_key: string;
  status: 'active' | 'invited' | 'revoked';
  invitation_id: string | null;
  invited_by: string;
  invited_at: string;
  joined_at: string | null;
}

const initTeamInput = z.object({
  orgId: z.string().min(1),
  ownerEmail: z.string().min(1),
});

/**
 * Seed a freshly-created team: record its invite-keying org id and the owner as the
 * first (active) member. Invoked once by the worker at team creation, as the owner
 * (who holds every permission). Guarded so a re-run cannot duplicate the singleton.
 */
const initTeamOp: OperationHandler<z.infer<typeof initTeamInput>, void> = async (ctx, raw) => {
  assertAllowed(await ctx.check(DASHBOARD_PERM.manageMembers));
  const input = initTeamInput.parse(raw);
  if (ctx.sql.query<{ org_id: string }>('SELECT org_id FROM dashboard_team LIMIT 1')[0]) return;
  const now = new Date().toISOString();
  ctx.sql.exec('INSERT INTO dashboard_team (org_id) VALUES (?)', [input.orgId]);
  ctx.sql.exec(
    `INSERT INTO dashboard_members (id, principal, email, role_key, status, invited_by, invited_at, joined_at)
     VALUES (?, ?, ?, 'owner', 'active', ?, ?, ?)`,
    [ulid(), ctx.principal, input.ownerEmail, ctx.principal, now, now],
  );
};

const inviteMemberInput = z.object({
  email: z.string().trim().min(1),
  roleKey: z.enum(['admin', 'member', 'viewer']),
});

/**
 * Invite someone to the team at a role. Enforces the §5.1 bound HERE (the kernel
 * does not): the caller may invite only at a role whose every permission they
 * already hold — checked with `ctx.check` per permission, so a member cannot mint
 * authority above their own. Composes the invites engine's `sendInvite` (hashed
 * identifier, rate-limited, accept-required) in the same transaction and records a
 * readable pending roster row.
 */
const inviteMemberOp: OperationHandler<z.infer<typeof inviteMemberInput>, { invitationId: string }> = async (ctx, raw) => {
  assertAllowed(await ctx.check(DASHBOARD_PERM.manageMembers));
  const input = inviteMemberInput.parse(raw);
  const perms = MEMBER_ROLES[input.roleKey];
  if (!perms) throw new Error(`unknown role '${input.roleKey}'`);
  for (const perm of perms) assertAllowed(await ctx.check(perm));

  const team = ctx.sql.query<{ org_id: string }>('SELECT org_id FROM dashboard_team LIMIT 1')[0];
  if (!team) throw new Error('team not initialised');

  const { id: invitationId } = await sendInvite(ctx, {
    orgId: team.org_id as unknown as OrgId,
    identifier: input.email,
    roleKey: input.roleKey,
  });
  // The engine no-ops a duplicate open invite (returns the same id); mirror that in
  // the projection so re-inviting is idempotent rather than a duplicate roster row.
  if (!ctx.sql.query<{ id: string }>('SELECT id FROM dashboard_members WHERE invitation_id = ?', [invitationId])[0]) {
    ctx.sql.exec(
      `INSERT INTO dashboard_members (id, email, role_key, status, invitation_id, invited_by, invited_at)
       VALUES (?, ?, ?, 'invited', ?, ?, ?)`,
      [ulid(), input.email, input.roleKey, invitationId, ctx.principal, new Date().toISOString()],
    );
  }
  return { invitationId };
};

const acceptInviteInput = z.object({
  invitationId: z.string().min(1),
  identifier: z.string().min(1),
});

/**
 * Accept an invitation, as the recipient principal (minted by the worker; not a
 * member yet, so there is no permission to check — the identifier hash IS the
 * authority, per the invites engine). Composes `acceptInvite` (verifies the hash,
 * transitions state, emits invites.accepted + member.add-requested) and flips the
 * roster row to active in the SAME transaction. The kernel role assignment + identity
 * link are effected by the worker afterwards (they need platform authority / the sub).
 */
const acceptInviteOp: OperationHandler<z.infer<typeof acceptInviteInput>, { roleKey: string }> = async (ctx, raw) => {
  const input = acceptInviteInput.parse(raw);
  const invitation = await acceptInvite(ctx, input); // throws "not acceptable" on any mismatch
  ctx.sql.exec(
    `UPDATE dashboard_members SET principal = ?, status = 'active', joined_at = ? WHERE invitation_id = ?`,
    [ctx.principal, new Date().toISOString(), input.invitationId],
  );
  return { roleKey: invitation.role_key };
};

const previewInviteInput = z.object({ invitationId: z.string().min(1) });

/**
 * Preview a pending invitation: its invited address + role. Deliberately does NO
 * permission check — like `accept-invite`, the authority is the signed invite token
 * the worker verifies before invoking, not a role in this scope (the invitee is not
 * a member yet, and may not even be signed in). Only ever returns the invite's OWN
 * address, and only while it is still open — enough to prefill the login email and
 * name the team on the accept screen, never a roster read. `null` if not pending.
 */
const previewInviteOp: OperationHandler<
  z.infer<typeof previewInviteInput>,
  { email: string; roleKey: string } | null
> = async (ctx, raw) => {
  const input = previewInviteInput.parse(raw);
  const row = ctx.sql.query<DashboardMemberRow>(
    `SELECT email, role_key FROM dashboard_members WHERE invitation_id = ? AND status = 'invited'`,
    [input.invitationId],
  )[0];
  return row ? { email: row.email, roleKey: row.role_key } : null;
};

const resendInviteInput = z.object({ invitationId: z.string().min(1) });

/**
 * Re-send a pending invitation. The raw address the invites engine deliberately
 * hashes away still lives in this readable roster row, so a resend needs no new
 * input — it re-composes `sendInvite` with the stored email + role. That call is
 * idempotent for a still-open invitation (returns the same id) and mints a fresh
 * one if the old lapsed; either way the projection is re-pointed at the live
 * invitation so accept keeps working. Re-checks the §5.1 role bound (as the
 * initial invite does) so a since-downgraded admin cannot re-mint above their own
 * authority. Returns the address + role + live id for the worker to re-mail, or
 * null when there is no such pending invite.
 */
const resendInviteOp: OperationHandler<
  z.infer<typeof resendInviteInput>,
  { invitationId: string; email: string; roleKey: string } | null
> = async (ctx, raw) => {
  assertAllowed(await ctx.check(DASHBOARD_PERM.manageMembers));
  const input = resendInviteInput.parse(raw);
  const row = ctx.sql.query<DashboardMemberRow>(
    `SELECT * FROM dashboard_members WHERE invitation_id = ? AND status = 'invited'`,
    [input.invitationId],
  )[0];
  if (!row) return null;

  const perms = MEMBER_ROLES[row.role_key];
  if (!perms) throw new Error(`unknown role '${row.role_key}'`);
  for (const perm of perms) assertAllowed(await ctx.check(perm));

  const team = ctx.sql.query<{ org_id: string }>('SELECT org_id FROM dashboard_team LIMIT 1')[0];
  if (!team) throw new Error('team not initialised');

  const { id: invitationId } = await sendInvite(ctx, {
    orgId: team.org_id as unknown as OrgId,
    identifier: row.email,
    roleKey: row.role_key,
  });
  // A lapsed invitation yields a fresh id; keep the projection pointing at the live one.
  if (invitationId !== row.invitation_id) {
    ctx.sql.exec('UPDATE dashboard_members SET invitation_id = ? WHERE id = ?', [invitationId, row.id]);
  }
  return { invitationId, email: row.email, roleKey: row.role_key };
};

const revokeInviteInput = z.object({ invitationId: z.string().min(1) });

/** Withdraw a pending invite (composes the engine's revoke) + drop it from the roster. */
const revokeInviteOp: OperationHandler<z.infer<typeof revokeInviteInput>, void> = async (ctx, raw) => {
  assertAllowed(await ctx.check(DASHBOARD_PERM.manageMembers));
  const input = revokeInviteInput.parse(raw);
  revokeInvite(ctx, input.invitationId);
  ctx.sql.exec(
    `UPDATE dashboard_members SET status = 'revoked' WHERE invitation_id = ? AND status = 'invited'`,
    [input.invitationId],
  );
};

/** The team roster — active members + outstanding invites, newest first. Gated read. */
const listMembersOp: OperationHandler<Record<string, never>, DashboardMemberRow[]> = async (ctx) => {
  assertAllowed(await ctx.check(DASHBOARD_PERM.read));
  return ctx.sql.query<DashboardMemberRow>(
    `SELECT * FROM dashboard_members WHERE status IN ('active','invited') ORDER BY invited_at DESC`,
  );
};

/**
 * The caller leaves the team — marks their OWN roster row revoked. The worker then
 * severs their identity link (`unlinkIdentity`), which is what actually detaches
 * them. Any member may leave (including the owner: on a throwaway/abandoned team
 * that is intended; a "last owner leaving" guard can come with team deletion).
 */
const leaveSelfOp: OperationHandler<Record<string, never>, void> = async (ctx) => {
  assertAllowed(await ctx.check(DASHBOARD_PERM.read));
  ctx.sql.exec(`UPDATE dashboard_members SET status = 'revoked' WHERE principal = ? AND status = 'active'`, [ctx.principal]);
};

/**
 * Delete the organization — the roster half. OWNER-ONLY: `manage-members` is the base
 * gate, and the roster (not a new permission key) is the owner check, mirroring how
 * `remove-member` protects the owner row. Revokes every roster row and returns the
 * active members so the worker can sever their identity links — the platform effects
 * (deprovision apps, tenant → `deleting`) happen host-side after this asserts.
 */
const deleteTeamOp: OperationHandler<Record<string, never>, { members: Array<{ principal: string; roleKey: string }> }> = async (ctx) => {
  assertAllowed(await ctx.check(DASHBOARD_PERM.manageMembers));
  const me = ctx.sql.query<DashboardMemberRow>(
    `SELECT * FROM dashboard_members WHERE principal = ? AND status = 'active'`,
    [ctx.principal],
  )[0];
  if (!me || me.role_key !== 'owner') {
    throw new Error('permission denied: only the owner can delete the organization');
  }
  const active = ctx.sql.query<DashboardMemberRow>(`SELECT * FROM dashboard_members WHERE status = 'active'`);
  ctx.sql.exec(`UPDATE dashboard_members SET status = 'revoked' WHERE status = 'active'`);
  return {
    members: active
      .filter((m) => m.principal)
      .map((m) => ({ principal: m.principal!, roleKey: m.role_key })),
  };
};

const removeMemberInput = z.object({ memberId: z.string().min(1) });

/**
 * Remove an ACTIVE member from the roster projection (the worker separately revokes
 * their kernel role via `unassignRole` — that is what actually cuts access). The
 * owner cannot be removed. Returns the removed principal + role so the worker knows
 * what to unassign; a no-match (already gone, or the owner) returns null.
 */
const removeMemberOp: OperationHandler<z.infer<typeof removeMemberInput>, { principal: string; roleKey: string } | null> = async (ctx, raw) => {
  assertAllowed(await ctx.check(DASHBOARD_PERM.manageMembers));
  const input = removeMemberInput.parse(raw);
  const row = ctx.sql.query<DashboardMemberRow>(
    `SELECT * FROM dashboard_members WHERE id = ? AND status = 'active' AND role_key != 'owner'`,
    [input.memberId],
  )[0];
  if (!row || !row.principal) return null;
  ctx.sql.exec(`UPDATE dashboard_members SET status = 'revoked' WHERE id = ?`, [input.memberId]);
  return { principal: row.principal, roleKey: row.role_key };
};

const beginConnectionInput = z.object({ provider: z.string().min(1).max(64) });

/**
 * Authorize a self-serve provider connection (connections.md §3.5.1). This is the
 * *in-scope* half of B: it does nothing but assert the caller may connect providers
 * for this tenant. The host effects the sealed `createConnection` afterwards (it
 * holds the SecretBox + the OAuth secret), attributed to `ctx.principal` — so the
 * authority originates here, in a permission-checked tenant act, not from a platform
 * actor conjured in a request handler. Returns the authorizing principal for the
 * host to stamp onto the connection + bind into the signed OAuth state.
 */
const beginConnectionOp: OperationHandler<z.infer<typeof beginConnectionInput>, { principal: string }> = async (ctx, raw) => {
  assertAllowed(await ctx.check(DASHBOARD_PERM.manageIntegrations));
  beginConnectionInput.parse(raw);
  return { principal: ctx.principal };
};

export const dashboardModule: ModuleRegistration = {
  manifest: dashboardManifest,
  migrations: dashboardMigrations,
  operations: {
    'dashboard/provision-app': provisionAppOp as OperationHandler<never, unknown>,
    'dashboard/mark-app-active': markAppActiveOp as OperationHandler<never, unknown>,
    'dashboard/update-app': updateAppOp as OperationHandler<never, unknown>,
    'dashboard/snapshot-app': snapshotAppOp as OperationHandler<never, unknown>,
    'dashboard/delete-app-snapshot': deleteAppSnapshotOp as OperationHandler<never, unknown>,
    'dashboard/export-app-data': exportAppDataOp as OperationHandler<never, unknown>,
    'dashboard/restore-app-data': restoreAppDataOp as OperationHandler<never, unknown>,
    'dashboard/bind-app-hostname': bindAppHostnameOp as OperationHandler<never, unknown>,
    'dashboard/unbind-app-hostname': unbindAppHostnameOp as OperationHandler<never, unknown>,
    'dashboard/mark-app-failed': markAppFailedOp as OperationHandler<never, unknown>,
    'dashboard/resume-app': resumeAppOp as OperationHandler<never, unknown>,
    'dashboard/app-events': appEventsOp as OperationHandler<never, unknown>,
    'dashboard/list-apps': listAppsOp as OperationHandler<never, unknown>,
    'dashboard/delete-app': deleteAppOp as OperationHandler<never, unknown>,
    'dashboard/set-app-env': setAppEnvOp as OperationHandler<never, unknown>,
    'dashboard/list-app-env': listAppEnvOp as OperationHandler<never, unknown>,
    'dashboard/delete-app-env': deleteAppEnvOp as OperationHandler<never, unknown>,
    'dashboard/set-app-auth': setAppAuthOp as OperationHandler<never, unknown>,
    'dashboard/get-app-auth': getAppAuthOp as OperationHandler<never, unknown>,
    'dashboard/init-team': initTeamOp as OperationHandler<never, unknown>,
    'dashboard/invite-member': inviteMemberOp as OperationHandler<never, unknown>,
    'dashboard/accept-invite': acceptInviteOp as OperationHandler<never, unknown>,
    'dashboard/preview-invite': previewInviteOp as OperationHandler<never, unknown>,
    'dashboard/resend-invite': resendInviteOp as OperationHandler<never, unknown>,
    'dashboard/revoke-invite': revokeInviteOp as OperationHandler<never, unknown>,
    'dashboard/list-members': listMembersOp as OperationHandler<never, unknown>,
    'dashboard/remove-member': removeMemberOp as OperationHandler<never, unknown>,
    'dashboard/leave-self': leaveSelfOp as OperationHandler<never, unknown>,
    'dashboard/delete-team': deleteTeamOp as OperationHandler<never, unknown>,
    'dashboard/begin-connection': beginConnectionOp as OperationHandler<never, unknown>,
  },
};
