import { z } from 'zod';
import { appEvent, appRow, installStep, memberRow } from './routes.js';
import {
  CURSOR_FIELD_SEPARATOR,
  defineOperations,
  listLimitOf,
  mapPage,
  moduleManifest,
  pageOf,
  permissionKey,
  substratError,
  type Page,
  type PagedInput,
  type PermissionKey,
  type OrgId,
} from '@substrat-run/contracts';
import {
  assertAllowed,
  MEMBER_ADD_REQUESTED,
  MEMBER_REMOVE_REQUESTED,
  MEMBERSHIP_EXECUTOR_ID,
  membershipEntity,
  readExecutorDelivery,
  ulid,
  type MemberRemoveRequestedPayload,
  type ModuleRegistration,
  type OperationContext,
  type OperationHandler,
  operationsFor,
} from '@substrat-run/kernel';
import { INVITES_PERM, sendInvite, acceptInvite, revokeInvite, readInvitation } from '@substrat-run/engine-invites';

// ============================================================================
// The Dashboard — the tenant-facing self-service surface, built AS a Substrat
// vertical (the platform, dogfooded). See docs/architecture/dashboard.md.
//
// This module owns the customer's OWN data + permissions: the list of apps they
// have created (a `dashboard_apps` row per provisioned instance) and the keys
// that authorize managing them. The actual scope provisioning is NOT here —
// `provisionScope` is a ScopeHost action, so it runs in app-level code
// (`createApp` in provision.ts) with the tenant taken from the caller's own
// dashboard scope, never a request argument. This module answers "can they?" and
// records the result; the app layer effects it, narrowed to the caller's tenant.
// ============================================================================

/**
 * A dashboard key typed as its own literal as well as a `PermissionKey`. The brand alone is the
 * same type for every key, so a `defineOperations` allow-list built from branded keys admits any
 * key at all (an invites key on a dashboard operation compiled); the literal is what tells the
 * dashboard's six from a foreign one.
 */
const dashboardKey = <const K extends string>(key: K) => permissionKey.parse(key) as PermissionKey & K;

export const DASHBOARD_PERM = {
  /** Create/track an app (a provisioned vertical instance) in this tenant. Held by the owner. */
  provisionApp: dashboardKey('dashboard:provision-app'),
  /** Read the account's apps. */
  read: dashboardKey('dashboard:read'),
  /** Invite/remove members and see the roster — the tenant-admin membership surface. */
  manageMembers: dashboardKey('dashboard:manage-members'),
  /**
   * Connect/disconnect third-party providers (GitHub, Scrive, …) for this tenant.
   * The in-scope authorization for a self-serve connect (connections.md §3.5.1): the
   * host effects the sealed write, but the *right* to connect is checked here.
   */
  manageIntegrations: dashboardKey('dashboard:manage-integrations'),
  /** Read the tenant's findings and suppress rules (#1748) — the Findings inbox. */
  readFindings: dashboardKey('dashboard:read-findings'),
  /** Acknowledge, resolve or reopen a finding, and create or revoke a suppress rule (#1748). */
  manageFindings: dashboardKey('dashboard:manage-findings'),
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
  owner: [DASHBOARD_PERM.provisionApp, DASHBOARD_PERM.read, DASHBOARD_PERM.manageMembers, DASHBOARD_PERM.manageIntegrations, DASHBOARD_PERM.readFindings, DASHBOARD_PERM.manageFindings, INVITES_PERM.send, INVITES_PERM.read, INVITES_PERM.revoke],
  admin: [DASHBOARD_PERM.provisionApp, DASHBOARD_PERM.read, DASHBOARD_PERM.manageMembers, DASHBOARD_PERM.manageIntegrations, DASHBOARD_PERM.readFindings, DASHBOARD_PERM.manageFindings, INVITES_PERM.send, INVITES_PERM.read, INVITES_PERM.revoke],
  // A member runs the apps, so triaging what they do wrong is theirs too; a viewer only reads.
  member: [DASHBOARD_PERM.provisionApp, DASHBOARD_PERM.read, DASHBOARD_PERM.readFindings, DASHBOARD_PERM.manageFindings],
  viewer: [DASHBOARD_PERM.read, DASHBOARD_PERM.readFindings],
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
    { key: 'dashboard:read-findings', description: 'Read the tenant’s findings and suppress rules' },
    {
      key: 'dashboard:manage-findings',
      description: 'Acknowledge, resolve or reopen findings, and create or revoke suppress rules',
    },
  ],
  // #1184: a removal is asked of the kernel's membership executor, as an add is by the invites engine.
  events: { emits: [{ type: MEMBER_REMOVE_REQUESTED, schemaVersion: 1 }], consumes: [] },
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
  {
    version: '0011-app-provision-result',
    sql: `
      -- The vertical's provision RESULT (#426): the non-secret first-run facts it
      -- reported when its instance was created (a minted client id, migrations applied,
      -- endpoints), as a JSON object. Before this column the 201 body was discarded and
      -- those facts existed for exactly one HTTP response. NULL for verticals that
      -- return only the bare ack. Never secrets: credentials flow IN via install-time
      -- config (the installer chose them), and the platform seam drops secret-shaped
      -- keys as a backstop.
      ALTER TABLE dashboard_apps ADD COLUMN provision_result TEXT;
    `,
  },
  {
    version: '0012-install-steps',
    sql: `
      -- The install as a durable, inspectable operation (#424): one row per STEP of an
      -- app's install sequence (directory → provision → activate → hostname → identity),
      -- in the shape the platform-request spine already uses (status/attempts/last_error/
      -- settled_at) rather than a second progress vocabulary. A step that runs again on
      -- Resume UPDATES its row (attempts += 1) instead of appending, so the table always
      -- reads as "where the install is now"; history stays on dashboard_app_events.
      -- A failed step keeps the downstream error VERBATIM in last_error — the diagnosis
      -- the next bug report needs, pre-collected.
      CREATE TABLE dashboard_install_steps (
        app_scope_id TEXT NOT NULL,
        step         TEXT NOT NULL,
        seq          INTEGER NOT NULL,
        status       TEXT NOT NULL CHECK (status IN ('running','done','failed')),
        attempts     INTEGER NOT NULL DEFAULT 1,
        last_error   TEXT,
        started_at   TEXT NOT NULL,
        settled_at   TEXT,
        PRIMARY KEY (app_scope_id, step)
      );
    `,
  },
  {
    version: '0013-connect-links',
    sql: `
      -- Outstanding provider-consent rounds (#1220): one row per minted connect link
      -- for an OAuth-style provider (Fortnox). The signed token a recipient holds
      -- names this row; the row is what makes the link SINGLE-USE (consumed exactly
      -- once, at the consent callback) and REVOCABLE (an outstanding link an admin
      -- regrets is killed here, and the signature it rides becomes worthless). The
      -- recipient needs no dashboard login — the authority is the minting admin's,
      -- checked at mint AND re-checked at consume, so removing the admin also voids
      -- their outstanding links. What the consent attached (the provider's company)
      -- is recorded at consume time: the audit answer to "who connected THAT".
      CREATE TABLE dashboard_connect_links (
        id             TEXT PRIMARY KEY,
        provider       TEXT NOT NULL,
        app_scope_id   TEXT NOT NULL,
        status         TEXT NOT NULL CHECK (status IN ('outstanding','used','revoked')),
        created_by     TEXT NOT NULL,
        created_at     TEXT NOT NULL,
        expires_at     TEXT NOT NULL,
        used_at        TEXT,
        account_ref    TEXT,
        account_label  TEXT
      );
    `,
  },
  {
    version: '0014-member-joining',
    sql: `
      -- 'joining' (#1184): an accepted invite whose membership the kernel's executor has not
      -- effected yet. The accept commits before the role exists, so the row says so rather
      -- than 'active'; the roster read resolves it against the executor's journal (pending,
      -- refused and why, or joined). SQLite cannot widen a CHECK in place, so the table is
      -- rebuilt with its rows, constraints and index exactly as 0003 made them.
      CREATE TABLE dashboard_members_0014 (
        id            TEXT PRIMARY KEY,
        principal     TEXT UNIQUE,
        email         TEXT NOT NULL,
        role_key      TEXT NOT NULL,
        status        TEXT NOT NULL CHECK (status IN ('active','invited','revoked','joining')),
        invitation_id TEXT UNIQUE,
        invited_by    TEXT NOT NULL,
        invited_at    TEXT NOT NULL,
        joined_at     TEXT
      );
      INSERT INTO dashboard_members_0014
        (id, principal, email, role_key, status, invitation_id, invited_by, invited_at, joined_at)
        SELECT id, principal, email, role_key, status, invitation_id, invited_by, invited_at, joined_at
          FROM dashboard_members;
      DROP TABLE dashboard_members;
      ALTER TABLE dashboard_members_0014 RENAME TO dashboard_members;
      CREATE INDEX dashboard_members_by_status ON dashboard_members (status);
    `,
  },
];

/*
 * The rows the operations below return, declared once as schemas (#2426) so each operation's
 * `output` and its handler's type are the same object. Where the HTTP surface already declares a
 * row (routes.ts), the module's is that row plus the columns the route leaves out.
 */

/** One app as the module records it: the Apps list's row, plus its soft-delete stamp. */
const dashboardAppRow = appRow.extend({
  /** The vertical's non-secret provision result as JSON (#426); null for a bare ack. */
  provision_result: z.string().nullable(),
  /** Set when the app was deleted; `list-apps` returns only rows where it is null. */
  deleted_at: z.string().nullable(),
});

export type DashboardAppRow = z.infer<typeof dashboardAppRow>;

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
const appEnvValue = z.object({
  key: z.string(),
  isSecret: z.boolean(),
  /** Whether a value is stored (a secret shows "set" without revealing it). */
  hasValue: z.boolean(),
  /** The plaintext for a non-secret; null for a secret (write-only). */
  value: z.string().nullable(),
  updatedAt: z.string(),
});

export type AppEnvValue = z.infer<typeof appEnvValue>;

/** One row of the app's audit trail — a lifecycle transition. */
export type DashboardAppEventRow = z.infer<typeof appEvent>;

/**
 * One step of an app's install sequence (#424) — where the install is NOW, durably. `seq` is
 * the render order, stable even if steps settle out of order; `last_error` is the downstream
 * error VERBATIM.
 */
const installStepRow = installStep.extend({ app_scope_id: z.string() });

export type DashboardInstallStepRow = z.infer<typeof installStepRow>;

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
    [ulid(), appScopeId, kind, detail ?? null, ctx.principal, ctx.now()],
  );
}

/**
 * The keyset half of a list read that composes its own SQL (#811, #2426): the clause that
 * resumes after a cursor, the ORDER BY and LIMIT, and the cursor each row hands on.
 *
 * `columns` are the walk's sort and together unique, so a page boundary never falls between two
 * rows that compare equal. Most reads here walk their ULID `id` alone: ids are minted at insert,
 * so `id DESC` is the created-at order those lists always showed, and unique, which a timestamp
 * is not. A cursor over several columns joins their values with `CURSOR_FIELD_SEPARATOR`.
 *
 * The cursor is exclusive. `order` is the caller's: the host's parse has already applied the
 * declaration's default, and `fallback` only answers a call that did not go through it. `limit`
 * resolves against the platform default and ceiling (`listLimitOf`), so an in-process call that
 * names no page gets the page an HTTP one would, never the whole table.
 */
function keyset<R>(columns: readonly (keyof R & string)[], page: PagedInput, fallback: 'asc' | 'desc') {
  const ascending = (page.order ?? fallback) === 'asc';
  const after = page.cursor?.split(CURSOR_FIELD_SEPARATOR);
  if (after && (after.length !== columns.length || after.includes(''))) {
    throw substratError('validation_failed', 'invalid cursor: pass back the nextCursor a page answered');
  }
  const tuple = (parts: readonly string[]) => (parts.length === 1 ? parts[0]! : `(${parts.join(', ')})`);
  return {
    limit: listLimitOf(page.limit),
    /** ` AND …` past the cursor, or nothing on a first page: appended to the read's own WHERE. */
    where: after ? ` AND ${tuple(columns)} ${ascending ? '>' : '<'} ${tuple(columns.map(() => '?'))}` : '',
    /** The cursor's values, bound after the read's own WHERE parameters. */
    params: after ?? [],
    /** ORDER BY and LIMIT; the limit is bound last. */
    tail: ` ORDER BY ${columns.map((c) => `${c} ${ascending ? 'ASC' : 'DESC'}`).join(', ')} LIMIT ?`,
    cursorOf: (row: R) => columns.map((c) => String(row[c])).join(CURSOR_FIELD_SEPARATOR),
  };
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
    [id, input.appScopeId, input.verticalSlug, input.name, ctx.principal, ctx.now()],
  );
  recordAppEvent(ctx, input.appScopeId, 'created', input.verticalSlug);
  return ctx.sql.query<DashboardAppRow>('SELECT * FROM dashboard_apps WHERE id = ?', [id])[0]!;
};

const markAppActiveInput = z.object({
  appScopeId: z.string().min(1),
  hostname: z.string().min(1).optional(),
  /** The vertical's non-secret provision result (#426) — persisted with the flip to active. */
  provisionResult: z.record(z.string(), z.string()).optional(),
});

/** Flip an app to `active` once the platform provisioned its scope. Same authority as creating it. */
const markAppActiveOp: OperationHandler<z.infer<typeof markAppActiveInput>, DashboardAppRow> = async (
  ctx,
  raw,
) => {
  assertAllowed(await ctx.check(DASHBOARD_PERM.provisionApp));
  const input = markAppActiveInput.parse(raw);
  ctx.sql.exec(
    `UPDATE dashboard_apps SET status = 'active', hostname = COALESCE(?, hostname),
       provision_result = COALESCE(?, provision_result) WHERE app_scope_id = ?`,
    [input.hostname ?? null, input.provisionResult ? JSON.stringify(input.provisionResult) : null, input.appScopeId],
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

const reconcileAppVerticalInput = z.object({
  appScopeId: z.string().min(1),
  /** The DIRECTORY's lineage slug — what the row is healed TO. */
  verticalSlug: z.string().min(1),
});

/**
 * Heal the row's vertical lineage to match the directory (#389): a
 * `rebind-vertical` moves a scope onto a different lineage (e.g. builtin
 * 'manyfold' → tenant-owned 'acme/manyfold') and the directory's scope record is
 * the source of truth — but this row still names the old slug, which misroutes the
 * per-app Update path (prod channels resolve by `vertical_slug`) and the Apps
 * view's version display. Called by the read-path reconcile the same way
 * `mark-app-active` is (#424); same authority as provisioning the app. Idempotent:
 * a row already naming the directory's slug is returned untouched, no event.
 */
const reconcileAppVerticalOp: OperationHandler<
  z.infer<typeof reconcileAppVerticalInput>,
  DashboardAppRow
> = async (ctx, raw) => {
  assertAllowed(await ctx.check(DASHBOARD_PERM.provisionApp));
  const input = reconcileAppVerticalInput.parse(raw);
  const row = ctx.sql.query<DashboardAppRow>('SELECT * FROM dashboard_apps WHERE app_scope_id = ?', [
    input.appScopeId,
  ])[0];
  if (!row) throw new Error(`no app for scope ${input.appScopeId}`);
  if (row.vertical_slug === input.verticalSlug) return row;
  ctx.sql.exec('UPDATE dashboard_apps SET vertical_slug = ? WHERE app_scope_id = ?', [
    input.verticalSlug,
    input.appScopeId,
  ]);
  recordAppEvent(ctx, input.appScopeId, 'updated', `rebound ${row.vertical_slug} → ${input.verticalSlug}`);
  return { ...row, vertical_slug: input.verticalSlug };
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

/**
 * The gate in front of moving or retiring the installs a vertical still backs (#1592).
 *
 * Those acts touch the SHARED plane — rebinding a scope onto another lineage, wiping a
 * scope's storage — over a staff-level service token, so nothing below the seam asks who
 * is calling. This is where that is asked: the same `dashboard:provision-app` every other
 * install-changing operation here holds, so a `viewer` can read the list and not act on
 * it. It writes nothing — a bound scope need not have a `dashboard_apps` row for the
 * trail to hang off (a fork, or an install made before this dashboard tracked them), and
 * the plane's own audit log records each rebind and reap.
 */
/** A check-only operation: it writes nothing, and answers whether the caller holds `perm`. */
const checkOnly =
  (perm: PermissionKey): OperationHandler<undefined, { ok: true }> =>
  async (ctx) => {
    assertAllowed(await ctx.check(perm));
    return { ok: true };
  };

const authorizeScopeChangeOp = checkOnly(DASHBOARD_PERM.provisionApp);

/**
 * The findings gates (#1748): who inside the tenant may read the inbox, and who may act on it.
 * The control plane confines the tenant credential to the tenant; these say WHICH person.
 * Check-only, like `authorize-scope-change`: the read or the verdict is the plane's.
 */
const authorizeFindingsReadOp = checkOnly(DASHBOARD_PERM.readFindings);
const authorizeFindingsChangeOp = checkOnly(DASHBOARD_PERM.manageFindings);

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

const recordInstallStepInput = z.object({
  appScopeId: z.string().min(1),
  /** The step's stable key — 'directory', 'provision', 'activate', 'hostname', 'identity'. */
  step: z.string().min(1),
  /** Position in the install sequence (render order). */
  seq: z.number().int().min(0),
  status: z.enum(['running', 'done', 'failed']),
  /** The downstream error VERBATIM — required reading for a failed step. */
  error: z.string().optional(),
});

/**
 * Record one step of the install sequence (#424) — the durable progress record the
 * Apps view renders live and a failed install is diagnosed from. UPSERT keyed by
 * (app, step): a step re-entered by Resume transitions back to 'running' and bumps
 * `attempts` on its own row, so the table is always the CURRENT install state (the
 * append-only history is dashboard_app_events). Same authority as provisioning the
 * app — this is only ever written by the install flow itself.
 */
const recordInstallStepOp: OperationHandler<z.infer<typeof recordInstallStepInput>, { ok: true }> = async (
  ctx,
  raw,
) => {
  assertAllowed(await ctx.check(DASHBOARD_PERM.provisionApp));
  const input = recordInstallStepInput.parse(raw);
  const now = ctx.now();
  if (input.status === 'running') {
    // A fresh attempt at this step: back to 'running', attempts += 1, the previous
    // outcome cleared (its error already lives on the Activity trail if it mattered).
    ctx.sql.exec(
      `INSERT INTO dashboard_install_steps (app_scope_id, step, seq, status, attempts, last_error, started_at, settled_at)
       VALUES (?, ?, ?, 'running', 1, NULL, ?, NULL)
       ON CONFLICT (app_scope_id, step) DO UPDATE SET
         status = 'running', attempts = attempts + 1, last_error = NULL, started_at = ?, settled_at = NULL`,
      [input.appScopeId, input.step, input.seq, now, now],
    );
  } else {
    // Settle the running row. The INSERT arm is a safety net for a settle without a
    // recorded start (never the normal path) — better an honest row than a lost error.
    ctx.sql.exec(
      `INSERT INTO dashboard_install_steps (app_scope_id, step, seq, status, attempts, last_error, started_at, settled_at)
       VALUES (?, ?, ?, ?, 1, ?, ?, ?)
       ON CONFLICT (app_scope_id, step) DO UPDATE SET
         status = ?, last_error = ?, settled_at = ?`,
      [
        input.appScopeId, input.step, input.seq, input.status, input.error ?? null, now, now,
        input.status, input.error ?? null, now,
      ],
    );
  }
  return { ok: true };
};

const installStepsInput = z.object({ appScopeId: z.string().min(1) });

/**
 * The install's step list, in sequence order — a plain read, gated by `dashboard:read`. Walked
 * on (seq, step): `seq` is the render order and nothing makes it unique, while a step's name is
 * unique per app (the primary key).
 */
const installStepsOp: OperationHandler<
  z.infer<typeof installStepsInput> & PagedInput,
  Page<DashboardInstallStepRow>
> = async (ctx, input) => {
  assertAllowed(await ctx.check(DASHBOARD_PERM.read));
  const page = keyset<DashboardInstallStepRow>(['seq', 'step'], input, 'asc');
  const rows = ctx.sql.query<DashboardInstallStepRow>(
    `SELECT * FROM dashboard_install_steps WHERE app_scope_id = ?${page.where}${page.tail}`,
    [input.appScopeId, ...page.params, page.limit],
  );
  return pageOf(rows, page.limit, page.cursorOf);
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

/** The account's apps, newest first — a plain read, gated by `dashboard:read`. Deleted apps are hidden. */
const listAppsOp: OperationHandler<PagedInput, Page<DashboardAppRow>> = async (ctx, input) => {
  assertAllowed(await ctx.check(DASHBOARD_PERM.read));
  const page = keyset<DashboardAppRow>(['id'], input, 'desc');
  const rows = ctx.sql.query<DashboardAppRow>(
    `SELECT * FROM dashboard_apps WHERE deleted_at IS NULL${page.where}${page.tail}`,
    [...page.params, page.limit],
  );
  return pageOf(rows, page.limit, page.cursorOf);
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
    ctx.now(),
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

/** The app's audit trail — newest first (id DESC ≡ created_at DESC; see `keyset`). Gated read. */
const appEventsOp: OperationHandler<z.infer<typeof appEventsInput> & PagedInput, Page<DashboardAppEventRow>> = async (
  ctx,
  input,
) => {
  assertAllowed(await ctx.check(DASHBOARD_PERM.read));
  const page = keyset<DashboardAppEventRow>(['id'], input, 'desc');
  const rows = ctx.sql.query<DashboardAppEventRow>(
    `SELECT * FROM dashboard_app_events WHERE app_scope_id = ?${page.where}${page.tail}`,
    [input.appScopeId, ...page.params, page.limit],
  );
  return pageOf(rows, page.limit, page.cursorOf);
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
  const now = ctx.now();
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

/** An app's stored env/config in key order, secrets masked (value: null). Gated read. */
const listAppEnvOp: OperationHandler<z.infer<typeof listAppEnvInput> & PagedInput, Page<AppEnvValue>> = async (
  ctx,
  input,
) => {
  assertAllowed(await ctx.check(DASHBOARD_PERM.read));
  const page = keyset<DashboardAppEnvRow>(['key'], input, 'asc');
  // The `substrat:*` namespace is reserved for platform-managed entries (the app's
  // Identity choice lives at `substrat:auth`) — those have their own ops with
  // field-wise redaction, so they never appear as an opaque blob in the Env tab.
  const rows = ctx.sql.query<DashboardAppEnvRow>(
    `SELECT * FROM dashboard_app_env WHERE app_scope_id = ? AND key NOT LIKE 'substrat:%'${page.where}${page.tail}`,
    [input.appScopeId, ...page.params, page.limit],
  );
  return mapPage(pageOf(rows, page.limit, page.cursorOf), (r) => ({
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
const appAuthView = z.object({
  mode: z.literal('oidc'),
  issuer: z.string(),
  clientId: z.string(),
  audience: z.string().nullable(),
  hasClientSecret: z.boolean(),
  updatedAt: z.string(),
});

export type AppAuthView = z.infer<typeof appAuthView>;

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
    [ulid(), input.appScopeId, APP_AUTH_KEY, JSON.stringify(merged), ctx.principal, ctx.now()],
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

/**
 * One roster row (routes.ts `memberRow`). Stored, its status is 'active' | 'invited' | 'revoked'
 * | 'joining'. As `list-members` returns it, a 'joining' row is resolved against the membership
 * executor's journal (#1184): 'active' once it joined, 'refused' (with `refusal`) once it never
 * will, 'joining' while it is pending.
 */
export type DashboardMemberRow = z.infer<typeof memberRow>;

const initTeamInput = z.object({
  orgId: z.string().min(1),
  /**
   * The owner's address as the issuer verified it, or `''` when it did not (#1359): an
   * address the issuer did not vouch for never enters a roster row, where a later match on
   * email could read it as someone. Empty rather than NULL because the column predates
   * this and is NOT NULL; the row is keyed by `principal` either way.
   */
  ownerEmail: z.string(),
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
  const now = ctx.now();
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
      [ulid(), input.email, input.roleKey, invitationId, ctx.principal, ctx.now()],
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
 * roster row to joining in the SAME transaction. The role assignment is effected after
 * the commit by the membership executor (#1184, `membership.ts`), the
 * identity link by the worker (it needs the sub).
 */
const acceptInviteOp: OperationHandler<z.infer<typeof acceptInviteInput>, { roleKey: string }> = async (ctx, raw) => {
  const input = acceptInviteInput.parse(raw);
  const invitation = await acceptInvite(ctx, input); // throws "not acceptable" on any mismatch
  ctx.sql.exec(
    `UPDATE dashboard_members SET principal = ?, status = 'joining', joined_at = ? WHERE invitation_id = ?`,
    [ctx.principal, ctx.now(), input.invitationId],
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

const inviteLinkInput = z.object({ invitationId: z.string().min(1) });

/**
 * The facts a pending invite's "Copy link" needs — a pure READ. It asks what a resend
 * asks (manage-members, and the §5.1 bound on the row's role) but composes no `sendInvite`:
 * no rate limit, no expiry sweep, no new invitation, no event. An open invitation returns
 * its id and deadline; one that has lapsed (or is no longer open in the engine) returns
 * `{ lapsed: true }` — renewing it is the resend's job, not a side effect of looking.
 * `null` when the roster has no such pending invite.
 */
const inviteLinkOp: OperationHandler<
  z.infer<typeof inviteLinkInput>,
  { invitationId: string; expiresAt: string } | { lapsed: true } | null
> = async (ctx, raw) => {
  assertAllowed(await ctx.check(DASHBOARD_PERM.manageMembers));
  const input = inviteLinkInput.parse(raw);
  const row = ctx.sql.query<DashboardMemberRow>(
    `SELECT * FROM dashboard_members WHERE invitation_id = ? AND status = 'invited'`,
    [input.invitationId],
  )[0];
  if (!row) return null;

  const perms = MEMBER_ROLES[row.role_key];
  if (!perms) throw new Error(`unknown role '${row.role_key}'`);
  for (const perm of perms) assertAllowed(await ctx.check(perm));

  const invitation = readInvitation(ctx, input.invitationId);
  if (!invitation || invitation.state !== 'invited') return { lapsed: true };
  return { invitationId: invitation.id, expiresAt: invitation.expires_at };
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

/** The team roster — active members + outstanding invites, newest first (id DESC ≡ invited_at DESC). Gated read. */
const listMembersOp: OperationHandler<PagedInput, Page<DashboardMemberRow>> = async (ctx, input) => {
  assertAllowed(await ctx.check(DASHBOARD_PERM.read));
  const page = keyset<DashboardMemberRow>(['id'], input, 'desc');
  const rows = ctx.sql.query<DashboardMemberRow>(
    `SELECT * FROM dashboard_members WHERE status IN ('active','invited','joining')${page.where}${page.tail}`,
    [...page.params, page.limit],
  );
  return mapPage(pageOf(rows, page.limit, page.cursorOf), (row) => joinedAs(ctx, row));
};

/**
 * A 'joining' row as it actually stands (#1184): the membership executor's journal for the
 * request its accept emitted. Read, never written back — a read must not mutate (#964).
 */
function joinedAs(ctx: OperationContext, row: DashboardMemberRow): DashboardMemberRow {
  if (row.status !== 'joining' || !row.principal) return row;
  const delivery = readExecutorDelivery(ctx, {
    executorId: MEMBERSHIP_EXECUTOR_ID,
    eventType: MEMBER_ADD_REQUESTED,
    entity: membershipEntity(row.principal),
  });
  if (delivery?.state === 'delivered') return { ...row, status: 'active' };
  if (delivery?.state === 'refused' || delivery?.state === 'dead-lettered') {
    return { ...row, status: 'refused', refusal: delivery.error ?? delivery.state };
  }
  return row;
}

/**
 * The caller leaves the team — marks their OWN roster row revoked. The worker then
 * severs their identity link (`unlinkIdentity`), which is what actually detaches
 * them. Any member may leave (including the owner: on a throwaway/abandoned team
 * that is intended; a "last owner leaving" guard can come with team deletion).
 */
const leaveSelfOp: OperationHandler<undefined, void> = async (ctx) => {
  assertAllowed(await ctx.check(DASHBOARD_PERM.read));
  ctx.sql.exec(`UPDATE dashboard_members SET status = 'revoked' WHERE principal = ? AND status IN ('active','joining')`, [ctx.principal]);
};

/**
 * Delete the organization — the roster half. OWNER-ONLY: `manage-members` is the base
 * gate, and the roster (not a new permission key) is the owner check, mirroring how
 * `remove-member` protects the owner row. Revokes every roster row and returns the
 * active members so the worker can sever their identity links — the platform effects
 * (deprovision apps, tenant → `deleting`) happen host-side after this asserts.
 */
const deleteTeamOp: OperationHandler<undefined, { members: Array<{ principal: string; roleKey: string }> }> = async (ctx) => {
  assertAllowed(await ctx.check(DASHBOARD_PERM.manageMembers));
  const me = ctx.sql.query<DashboardMemberRow>(
    `SELECT * FROM dashboard_members WHERE principal = ? AND status = 'active'`,
    [ctx.principal],
  )[0];
  if (!me || me.role_key !== 'owner') {
    throw substratError('permission_denied', 'permission denied: only the owner can delete the organization');
  }
  const active = ctx.sql.query<DashboardMemberRow>(`SELECT * FROM dashboard_members WHERE status IN ('active','joining')`);
  ctx.sql.exec(`UPDATE dashboard_members SET status = 'revoked' WHERE status IN ('active','joining')`);
  return {
    members: active
      .filter((m) => m.principal)
      .map((m) => ({ principal: m.principal!, roleKey: m.role_key })),
  };
};

const removeMemberInput = z.object({ memberId: z.string().min(1) });

/**
 * Remove a member (#1184). The roster row is revoked here and `member.remove-requested` asks
 * the kernel's membership executor to take the role away, after the
 * commit and inline — the same seam the join went through, so a join still pending when the
 * person is removed can never land afterwards. §5.1's bound applies to removal as to
 * assignment: you cannot strip a role you could not have granted. The owner cannot be
 * removed. Returns the principal so the worker can sever their login; null for no match
 * (already gone, or the owner).
 */
const removeMemberOp: OperationHandler<
  z.infer<typeof removeMemberInput>,
  { principal: string; roleKey: string } | null
> = async (ctx, raw) => {
  assertAllowed(await ctx.check(DASHBOARD_PERM.manageMembers));
  const input = removeMemberInput.parse(raw);
  const row = ctx.sql.query<DashboardMemberRow>(
    `SELECT * FROM dashboard_members WHERE id = ? AND status IN ('active','joining') AND role_key != 'owner'`,
    [input.memberId],
  )[0];
  if (!row || !row.principal) return null;
  const bound = await ctx.canAssign(row.role_key);
  if (!bound.covered) {
    throw substratError(
      'permission_denied',
      `permission denied: you cannot remove a '${row.role_key}': you do not hold ${bound.missing.join(', ')}`,
    );
  }
  const team = ctx.sql.query<{ org_id: string }>('SELECT org_id FROM dashboard_team LIMIT 1')[0];
  if (!team) throw new Error('team not initialised');
  ctx.sql.exec(`UPDATE dashboard_members SET status = 'revoked' WHERE id = ?`, [input.memberId]);
  const payload: MemberRemoveRequestedPayload = {
    principal: row.principal as MemberRemoveRequestedPayload['principal'],
    orgId: team.org_id as MemberRemoveRequestedPayload['orgId'],
    tenantId: ctx.tenantId,
    roleKey: row.role_key,
  };
  ctx.emit({
    type: MEMBER_REMOVE_REQUESTED,
    schemaVersion: 1,
    entity: membershipEntity(row.principal),
    piiClass: 'none',
    payload,
  });
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

// -- connect links (#1220) ---------------------------------------------------
// The DB-backed half of an OAuth-style provider connect. `begin-connection` above
// authorizes a paste-credential connect that completes within one request; a consent
// ROUND leaves the dashboard (a browser visits the provider, possibly a different
// person's browser, possibly days later), so its authorization is reified as a row +
// a signed token. Mint and revoke are the admin's own permission-checked acts;
// consume runs when the consent returns, AS the minting principal (the worker proves
// that principal from the token's signature), and re-checks the same permission — a
// link outlives neither its author's access nor a revocation.

const CONNECT_LINK_MAX_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const CONNECT_LINK_DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** One minted connect link, as the module exposes it (never the signed token itself). */
const connectLinkRow = z.object({
  id: z.string(),
  provider: z.string(),
  app_scope_id: z.string(),
  status: z.enum(['outstanding', 'used', 'revoked']),
  created_by: z.string(),
  created_at: z.string(),
  expires_at: z.string(),
  used_at: z.string().nullable(),
  account_ref: z.string().nullable(),
  account_label: z.string().nullable(),
});

export type ConnectLinkRow = z.infer<typeof connectLinkRow>;

const mintConnectLinkInput = z.object({
  provider: z.string().min(1).max(64),
  appScopeId: z.string().min(1),
  /** How long the link lives; clamped to 30 days. Default 7 days. */
  ttlMs: z.number().int().positive().max(CONNECT_LINK_MAX_TTL_MS).optional(),
});

const mintConnectLinkOp: OperationHandler<z.infer<typeof mintConnectLinkInput>, ConnectLinkRow> = async (ctx, raw) => {
  assertAllowed(await ctx.check(DASHBOARD_PERM.manageIntegrations));
  const input = mintConnectLinkInput.parse(raw);
  const id = ulid();
  const now = ctx.now();
  const expiresAt = new Date(
    Date.parse(now) + (input.ttlMs ?? CONNECT_LINK_DEFAULT_TTL_MS),
  ).toISOString();
  ctx.sql.exec(
    `INSERT INTO dashboard_connect_links (id, provider, app_scope_id, status, created_by, created_at, expires_at)
     VALUES (?, ?, ?, 'outstanding', ?, ?, ?)`,
    [id, input.provider, input.appScopeId, ctx.principal, now, expiresAt],
  );
  return ctx.sql.query<ConnectLinkRow>('SELECT * FROM dashboard_connect_links WHERE id = ?', [id])[0]!;
};

const consumeConnectLinkInput = z.object({
  linkId: z.string().min(1),
  provider: z.string().min(1).max(64),
  /** What the consent attached — recorded for the audit trail, shown nowhere else. */
  accountRef: z.string().max(256).optional(),
  accountLabel: z.string().max(256).optional(),
});

/**
 * Why a consume was refused, as a value rather than a thrown string: the callback
 * renders a different page for each, and parsing error messages to tell them apart
 * is how a wording change becomes a wrong screen.
 */
const connectLinkConsume = z.union([
  z.object({ ok: z.literal(true), link: connectLinkRow }),
  z.object({ ok: z.literal(false), reason: z.enum(['unknown', 'used', 'revoked', 'expired']) }),
]);

export type ConnectLinkConsume = z.infer<typeof connectLinkConsume>;

const consumeConnectLinkOp: OperationHandler<z.infer<typeof consumeConnectLinkInput>, ConnectLinkConsume> = async (ctx, raw) => {
  assertAllowed(await ctx.check(DASHBOARD_PERM.manageIntegrations));
  const input = consumeConnectLinkInput.parse(raw);
  const row = ctx.sql.query<ConnectLinkRow>(
    'SELECT * FROM dashboard_connect_links WHERE id = ? AND provider = ?',
    [input.linkId, input.provider],
  )[0];
  if (!row) return { ok: false, reason: 'unknown' };
  if (row.status === 'used') return { ok: false, reason: 'used' };
  if (row.status === 'revoked') return { ok: false, reason: 'revoked' };
  // ISO 8601 UTC text on both sides, so lexicographic comparison IS chronological.
  if (row.expires_at <= ctx.now()) return { ok: false, reason: 'expired' };
  // Single-use is enforced by the WHERE, not the read above: two concurrent callbacks
  // both read 'outstanding', but only one UPDATE matches and the other answers 'used'.
  const flipped = ctx.sql.exec(
    `UPDATE dashboard_connect_links SET status = 'used', used_at = ?, account_ref = ?, account_label = ?
     WHERE id = ? AND status = 'outstanding'`,
    [ctx.now(), input.accountRef ?? null, input.accountLabel ?? null, input.linkId],
  );
  if (flipped.changes !== 1) return { ok: false, reason: 'used' };
  return {
    ok: true,
    link: ctx.sql.query<ConnectLinkRow>('SELECT * FROM dashboard_connect_links WHERE id = ?', [input.linkId])[0]!,
  };
};

const restoreConnectLinkInput = z.object({ linkId: z.string().min(1) });

/**
 * The compensating half of consume: the callback spent the link, then failed to store
 * the credential — nothing was connected, so the spend is undone and the same link can
 * carry a fresh consent round. Only a 'used' row goes back (revoked stays revoked), and
 * only the callback that won the consume race has a 'used' row to restore, so the
 * single-use guard is untouched. Expiry needs no re-check here: consume and the list
 * both judge it on the way back in.
 */
const restoreConnectLinkOp: OperationHandler<z.infer<typeof restoreConnectLinkInput>, { restored: boolean }> = async (ctx, raw) => {
  assertAllowed(await ctx.check(DASHBOARD_PERM.manageIntegrations));
  const input = restoreConnectLinkInput.parse(raw);
  const flipped = ctx.sql.exec(
    `UPDATE dashboard_connect_links
     SET status = 'outstanding', used_at = NULL, account_ref = NULL, account_label = NULL
     WHERE id = ? AND status = 'used'`,
    [input.linkId],
  );
  return { restored: flipped.changes === 1 };
};

const revokeConnectLinkInput = z.object({ linkId: z.string().min(1) });

const revokeConnectLinkOp: OperationHandler<z.infer<typeof revokeConnectLinkInput>, { status: ConnectLinkRow['status'] } | null> = async (ctx, raw) => {
  assertAllowed(await ctx.check(DASHBOARD_PERM.manageIntegrations));
  const input = revokeConnectLinkInput.parse(raw);
  ctx.sql.exec(
    `UPDATE dashboard_connect_links SET status = 'revoked' WHERE id = ? AND status = 'outstanding'`,
    [input.linkId],
  );
  const row = ctx.sql.query<ConnectLinkRow>('SELECT * FROM dashboard_connect_links WHERE id = ?', [input.linkId])[0];
  return row ? { status: row.status } : null;
};

const listConnectLinksInput = z.object({
  appScopeId: z.string().min(1).optional(),
  provider: z.string().min(1).max(64).optional(),
});

/**
 * Outstanding links only — a used or revoked row is history, not something to revoke. Newest
 * first by id, which is the created-at order (see `keyset`).
 */
const listConnectLinksOp: OperationHandler<z.infer<typeof listConnectLinksInput> & PagedInput, Page<ConnectLinkRow>> = async (
  ctx,
  input,
) => {
  assertAllowed(await ctx.check(DASHBOARD_PERM.manageIntegrations));
  const page = keyset<ConnectLinkRow>(['id'], input, 'desc');
  const rows = ctx.sql.query<ConnectLinkRow>(
    `SELECT * FROM dashboard_connect_links
     WHERE status = 'outstanding' AND expires_at > ?
       AND (? IS NULL OR app_scope_id = ?) AND (? IS NULL OR provider = ?)${page.where}${page.tail}`,
    [
      ctx.now(), input.appScopeId ?? null, input.appScopeId ?? null, input.provider ?? null, input.provider ?? null,
      ...page.params, page.limit,
    ],
  );
  return pageOf(rows, page.limit, page.cursorOf);
};

/** What an operation that only authorizes, or only records, answers. */
const ok = z.object({ ok: z.literal(true) });

/** A member the caller is to act on: their principal and the role they held. */
const memberRef = z.object({ principal: z.string(), roleKey: z.string() });

/**
 * The keys these operations may declare. A literal tuple rather than `Object.values(DASHBOARD_PERM)`:
 * that is typed as the brand, the same for every key, and would admit a foreign key.
 */
export const DASHBOARD_PERMISSIONS = [
  DASHBOARD_PERM.provisionApp,
  DASHBOARD_PERM.read,
  DASHBOARD_PERM.manageMembers,
  DASHBOARD_PERM.manageIntegrations,
  DASHBOARD_PERM.readFindings,
  DASHBOARD_PERM.manageFindings,
] as const;

export const dashboardOperations = defineOperations({}, DASHBOARD_PERMISSIONS)({
  'dashboard/provision-app': {
    summary: 'Record a new app in this team, before its scope is provisioned',
    permission: DASHBOARD_PERM.provisionApp,
    input: provisionAppInput,
    output: dashboardAppRow,
  },
  'dashboard/mark-app-active': {
    summary: 'Mark a provisioned app active',
    permission: DASHBOARD_PERM.provisionApp,
    input: markAppActiveInput,
    output: dashboardAppRow,
  },
  'dashboard/update-app': {
    summary: 'Record that an app moved to a newer version',
    permission: DASHBOARD_PERM.provisionApp,
    input: updateAppInput,
    output: ok,
  },
  'dashboard/reconcile-app-vertical': {
    summary: 'Re-point an app’s record at the vertical slug the directory now names',
    permission: DASHBOARD_PERM.provisionApp,
    input: reconcileAppVerticalInput,
    output: dashboardAppRow,
  },
  'dashboard/snapshot-app': {
    summary: 'Authorize taking a snapshot of an app’s data',
    permission: DASHBOARD_PERM.provisionApp,
    input: snapshotAppInput,
    output: ok,
  },
  'dashboard/delete-app-snapshot': {
    summary: 'Authorize deleting an app’s snapshot',
    permission: DASHBOARD_PERM.provisionApp,
    input: snapshotAppInput,
    output: ok,
  },
  'dashboard/export-app-data': {
    summary: 'Authorize exporting an app’s data',
    permission: DASHBOARD_PERM.provisionApp,
    input: snapshotAppInput,
    output: ok,
  },
  'dashboard/restore-app-data': {
    summary: 'Authorize restoring an app’s data',
    permission: DASHBOARD_PERM.provisionApp,
    input: snapshotAppInput,
    output: ok,
  },
  'dashboard/bind-app-hostname': {
    summary: 'Authorize binding a custom hostname to an app',
    permission: DASHBOARD_PERM.provisionApp,
    input: snapshotAppInput,
    output: ok,
  },
  'dashboard/unbind-app-hostname': {
    summary: 'Authorize unbinding a custom hostname from an app',
    permission: DASHBOARD_PERM.provisionApp,
    input: snapshotAppInput,
    output: ok,
  },
  'dashboard/authorize-scope-change': {
    summary: 'Answer whether the caller may move or retire the installs a vertical still backs',
    permission: DASHBOARD_PERM.provisionApp,
    output: ok,
  },
  'dashboard/authorize-findings-read': {
    summary: 'Answer whether the caller may read the team’s findings',
    permission: DASHBOARD_PERM.readFindings,
    output: ok,
  },
  'dashboard/authorize-findings-change': {
    summary: 'Answer whether the caller may act on the team’s findings',
    permission: DASHBOARD_PERM.manageFindings,
    output: ok,
  },
  'dashboard/mark-app-failed': {
    summary: 'Mark an app’s install failed',
    permission: DASHBOARD_PERM.provisionApp,
    input: markAppFailedInput,
    output: dashboardAppRow,
  },
  'dashboard/record-install-step': {
    summary: 'Record one step of an app’s install',
    permission: DASHBOARD_PERM.provisionApp,
    input: recordInstallStepInput,
    output: ok,
  },
  'dashboard/install-steps': {
    summary: 'Read the steps recorded for an app’s install',
    permission: DASHBOARD_PERM.read,
    input: installStepsInput,
    output: installStepRow,
    // Bounded in practice, not by construction: the install flow writes one row per step of
    // `INSTALL_STEPS` (five), but `record-install-step` takes any step name. So it pages like
    // the rest rather than being exempt from #811; the steps route walks every page.
    paged: { sortKey: 'seq' },
  },
  'dashboard/resume-app': {
    summary: 'Authorize and record a resume of an install stuck at provisioning',
    permission: DASHBOARD_PERM.provisionApp,
    input: resumeAppInput,
    output: dashboardAppRow,
  },
  'dashboard/app-events': {
    summary: 'Read an app’s event trail',
    permission: DASHBOARD_PERM.read,
    input: appEventsInput,
    output: appEvent,
    // Unbounded: a row per lifecycle transition, for as long as the app lives. The Activity
    // route serves one page at a time.
    paged: { sortKey: 'id', order: 'desc' },
  },
  'dashboard/list-apps': {
    summary: 'List the team’s apps',
    permission: DASHBOARD_PERM.read,
    output: dashboardAppRow,
    // Unbounded: a row per install. The Apps route serves one page at a time; a caller that
    // needs every app (a lookup by scope id, a team-wide pass) walks the pages (`allApps`).
    // No declared input: a call with none is still answered, because the host hands a paged
    // read an empty page request rather than nothing.
    paged: { sortKey: 'id', order: 'desc' },
  },
  'dashboard/delete-app': {
    summary: 'Delete an app’s record, keeping its history',
    permission: DASHBOARD_PERM.provisionApp,
    input: deleteAppInput,
    output: dashboardAppRow,
  },
  'dashboard/set-app-env': {
    summary: 'Set an app’s environment values',
    permission: DASHBOARD_PERM.provisionApp,
    input: setAppEnvInput,
    output: z.object({ saved: z.number().int() }),
  },
  'dashboard/list-app-env': {
    summary: 'Read an app’s environment values',
    permission: DASHBOARD_PERM.read,
    input: listAppEnvInput,
    output: appEnvValue,
    // Not bounded by construction: `set-app-env` takes any UPPER_SNAKE_CASE key, not only the
    // ones the vertical's env-spec declares. Walked in key order; the Env route reads every page.
    paged: { sortKey: 'key' },
  },
  'dashboard/delete-app-env': {
    summary: 'Delete one of an app’s environment values',
    permission: DASHBOARD_PERM.provisionApp,
    input: deleteAppEnvInput,
    output: ok,
  },
  'dashboard/set-app-auth': {
    summary: 'Set how an app signs its users in',
    permission: DASHBOARD_PERM.provisionApp,
    input: setAppAuthInput,
    output: appAuthConfig,
  },
  'dashboard/get-app-auth': {
    summary: 'Read how an app signs its users in',
    permission: DASHBOARD_PERM.read,
    input: getAppAuthInput,
    output: appAuthView.nullable(),
  },
  'dashboard/init-team': {
    summary: 'Seed a new team with its invite-keying org and its owner',
    permission: DASHBOARD_PERM.manageMembers,
    input: initTeamInput,
    output: z.void(),
  },
  'dashboard/invite-member': {
    summary: 'Invite someone to the team at a role the caller already holds',
    permission: DASHBOARD_PERM.manageMembers,
    input: inviteMemberInput,
    output: z.object({ invitationId: z.string() }),
  },
  'dashboard/accept-invite': {
    summary: 'Accept an invitation, as the recipient',
    input: acceptInviteInput,
    output: z.object({ roleKey: z.string() }),
    narrows: {
      reason:
        'Runs before the caller is a member, so there is no role to check: the invites engine verifies the ' +
        'identifier hash against the invitation, and that hash is the authority',
      checks: [],
      unchecked: true,
    },
  },
  'dashboard/preview-invite': {
    summary: 'Read the address and role a still-open invitation names',
    input: previewInviteInput,
    output: z.object({ email: z.string(), roleKey: z.string() }).nullable(),
    narrows: {
      reason:
        'Runs before the caller is a member, so there is no role to check: the authority is the signed invite ' +
        'token the worker verifies before invoking, and it returns only that invitation’s own address, only while open',
      checks: [],
      unchecked: true,
    },
  },
  'dashboard/resend-invite': {
    summary: 'Re-send a pending invitation',
    permission: DASHBOARD_PERM.manageMembers,
    input: resendInviteInput,
    output: z.object({ invitationId: z.string(), email: z.string(), roleKey: z.string() }).nullable(),
  },
  'dashboard/invite-link': {
    summary: 'Read the link of a pending invitation',
    permission: DASHBOARD_PERM.manageMembers,
    input: inviteLinkInput,
    output: z.union([z.object({ invitationId: z.string(), expiresAt: z.string() }), z.object({ lapsed: z.literal(true) })]).nullable(),
  },
  'dashboard/revoke-invite': {
    summary: 'Revoke a pending invitation',
    permission: DASHBOARD_PERM.manageMembers,
    input: revokeInviteInput,
    output: z.void(),
  },
  'dashboard/list-members': {
    summary: 'List the team’s roster',
    permission: DASHBOARD_PERM.read,
    output: memberRow,
    // Team-sized, not bounded by construction: invitations are rate-limited, not capped. The
    // roster route serves one page at a time. No declared input, as `list-apps`.
    paged: { sortKey: 'id', order: 'desc' },
  },
  'dashboard/remove-member': {
    summary: 'Remove a member from the team',
    permission: DASHBOARD_PERM.manageMembers,
    input: removeMemberInput,
    output: memberRef.nullable(),
  },
  'dashboard/leave-self': {
    summary: 'Leave the team',
    permission: DASHBOARD_PERM.read,
    output: z.void(),
  },
  'dashboard/delete-team': {
    summary: 'Delete the team, listing the members to remove',
    permission: DASHBOARD_PERM.manageMembers,
    output: z.object({ members: z.array(memberRef) }),
  },
  'dashboard/begin-connection': {
    summary: 'Authorize starting a connection to a third-party provider',
    permission: DASHBOARD_PERM.manageIntegrations,
    input: beginConnectionInput,
    output: z.object({ principal: z.string() }),
  },
  'dashboard/mint-connect-link': {
    summary: 'Mint a one-time link for connecting a provider to an app',
    permission: DASHBOARD_PERM.manageIntegrations,
    input: mintConnectLinkInput,
    output: connectLinkRow,
  },
  'dashboard/consume-connect-link': {
    summary: 'Use up a connect link',
    permission: DASHBOARD_PERM.manageIntegrations,
    input: consumeConnectLinkInput,
    output: connectLinkConsume,
  },
  'dashboard/restore-connect-link': {
    summary: 'Put back a connect link whose use did not complete',
    permission: DASHBOARD_PERM.manageIntegrations,
    input: restoreConnectLinkInput,
    output: z.object({ restored: z.boolean() }),
  },
  'dashboard/revoke-connect-link': {
    summary: 'Revoke an outstanding connect link',
    permission: DASHBOARD_PERM.manageIntegrations,
    input: revokeConnectLinkInput,
    output: z.object({ status: connectLinkRow.shape.status }).nullable(),
  },
  'dashboard/list-connect-links': {
    summary: 'List the outstanding connect links',
    permission: DASHBOARD_PERM.manageIntegrations,
    input: listConnectLinksInput,
    output: connectLinkRow,
    // Not bounded by construction: an admin may mint any number of links. Each expires within
    // 30 days, which bounds them in time, not in count. Its callers walk every page.
    paged: { sortKey: 'id', order: 'desc' },
  },
});

export const dashboardModule: ModuleRegistration = {
  manifest: dashboardManifest,
  migrations: dashboardMigrations,
  ...operationsFor(dashboardOperations)({
    'dashboard/provision-app': provisionAppOp,
    'dashboard/mark-app-active': markAppActiveOp,
    'dashboard/update-app': updateAppOp,
    'dashboard/reconcile-app-vertical': reconcileAppVerticalOp,
    'dashboard/snapshot-app': snapshotAppOp,
    'dashboard/delete-app-snapshot': deleteAppSnapshotOp,
    'dashboard/export-app-data': exportAppDataOp,
    'dashboard/restore-app-data': restoreAppDataOp,
    'dashboard/bind-app-hostname': bindAppHostnameOp,
    'dashboard/unbind-app-hostname': unbindAppHostnameOp,
    'dashboard/authorize-scope-change': authorizeScopeChangeOp,
    'dashboard/authorize-findings-read': authorizeFindingsReadOp,
    'dashboard/authorize-findings-change': authorizeFindingsChangeOp,
    'dashboard/mark-app-failed': markAppFailedOp,
    'dashboard/record-install-step': recordInstallStepOp,
    'dashboard/install-steps': installStepsOp,
    'dashboard/resume-app': resumeAppOp,
    'dashboard/app-events': appEventsOp,
    'dashboard/list-apps': listAppsOp,
    'dashboard/delete-app': deleteAppOp,
    'dashboard/set-app-env': setAppEnvOp,
    'dashboard/list-app-env': listAppEnvOp,
    'dashboard/delete-app-env': deleteAppEnvOp,
    'dashboard/set-app-auth': setAppAuthOp,
    'dashboard/get-app-auth': getAppAuthOp,
    'dashboard/init-team': initTeamOp,
    'dashboard/invite-member': inviteMemberOp,
    'dashboard/accept-invite': acceptInviteOp,
    'dashboard/preview-invite': previewInviteOp,
    'dashboard/resend-invite': resendInviteOp,
    'dashboard/invite-link': inviteLinkOp,
    'dashboard/revoke-invite': revokeInviteOp,
    'dashboard/list-members': listMembersOp,
    'dashboard/remove-member': removeMemberOp,
    'dashboard/leave-self': leaveSelfOp,
    'dashboard/delete-team': deleteTeamOp,
    'dashboard/begin-connection': beginConnectionOp,
    'dashboard/mint-connect-link': mintConnectLinkOp,
    'dashboard/consume-connect-link': consumeConnectLinkOp,
    'dashboard/restore-connect-link': restoreConnectLinkOp,
    'dashboard/revoke-connect-link': revokeConnectLinkOp,
    'dashboard/list-connect-links': listConnectLinksOp,
  }),
};
