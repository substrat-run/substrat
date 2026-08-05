import type { PrincipalId, ScopeId, TenantId } from '@substrat-run/contracts';

/**
 * Client for the Dashboard worker's own API (apps/dashboard/src/worker.ts).
 *
 * The worker serves everything under `/api`: `/api/me` (who am I — and, on first
 * call, bootstraps my tenant), `/api/catalog`, `/api/apps`. Auth is an OIDC
 * redirect to the platform's AuthHero instance — there is no password here, so
 * sign-in/out are full-page navigations, not fetches. `credentials: 'include'`
 * carries the same-origin session cookie the worker sets.
 *
 * Only the M0 surface is real; the rest of the Dashboard runs on demo data (see
 * lib/demo.ts) with the honesty banners the design calls for.
 */

/**
 * The envelope every paged list read returns (the platform-wide convention,
 * contracts pagination.ts): one page of entries, newest first, and the cursor
 * that fetches the next (older) page — `null` when the walk is done.
 */
export interface ListPage<T> {
  entries: T[];
  nextCursor: string | null;
}

/** Optional page params for a list read; unset = the server's default page (20). */
export interface PageOpts {
  limit?: number;
  cursor?: string;
}

const pageQs = (opts?: PageOpts): string => {
  const q = new URLSearchParams();
  if (opts?.limit != null) q.set('limit', String(opts.limit));
  if (opts?.cursor) q.set('cursor', opts.cursor);
  const s = q.toString();
  return s ? `?${s}` : '';
};

/** One team (tenant) the signed-in user belongs to — drives the team switcher. */
export interface Team {
  id: TenantId;
  name: string;
  slug: string;
}

/** Authenticated, but not in any team yet — the app shows the onboarding screen. */
export interface Onboarding {
  needsOnboarding: true;
  email?: string | null;
  name?: string | null;
}

/** The `/api/me` result: either a resolved account, or a teamless login to onboard. */
export type MeResult = Me | Onboarding;

/** Narrow a `MeResult` to the teamless onboarding state. */
export function needsOnboarding(m: MeResult): m is Onboarding {
  return (m as Onboarding).needsOnboarding === true;
}

/** Who the authenticated customer is — their current team, dashboard scope, principal. */
export interface Me {
  principal: PrincipalId;
  /** The currently-selected team (tenant) this session is scoped to. */
  tenant: TenantId;
  dashboardScope: ScopeId;
  /** From the OIDC session — shown in the shell (footer, user pill). */
  email?: string | null;
  name?: string | null;
  /** Every team this login belongs to — one user can span several teams. */
  teams: Team[];
  /** The selected team's id (mirrors `tenant`); drives the switcher's checkmark. */
  currentTeamId: TenantId;
}

export interface CatalogEntry {
  slug: string;
  name: string;
  /** Owned by my team — the New-app page's "Your verticals" group. */
  owned: boolean;
  /** Published to the public marketplace (the "Marketplace" group). */
  listed: boolean;
  source: string;
  /** False until a pushed vertical has a prod-promoted version — shown but not installable. */
  installable: boolean;
  /** The vertical's declared env-spec (#426) — the New-app form renders these fields so
   *  first-run config (an issuer's bootstrap admin, API keys) flows in WITH provisioning. */
  envSpec?: EnvVarSpec[];
  /** Capabilities this vertical provides (#427) — an `oidc-issuer` provider's instances
   *  appear in other installs' Identity picker, and it gets no Identity section itself. */
  provides?: string[];
  /** Capabilities this vertical can consume at install (#427) — `oidc-issuer` marks the
   *  Identity section as the vertical's declared delegation seam. */
  requires?: string[];
}

/** A team roster entry — an active member or an outstanding invite. Mirrors the worker's row. */
export interface Member {
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

/** The role a new member can be invited at (owner is the un-invitable first member). */
export type InviteRole = 'admin' | 'member' | 'viewer';

/** One provisioned app — mirrors the worker's `DashboardAppRow` (module.ts). */
/** The install form's Identity choice — which issuer the new app authenticates against.
 *  Absent ⇒ the vertical's builtin auth. `auth-server` names one of the team's own Auth
 *  Server apps (the client is registered there automatically); `external` is any OIDC
 *  issuer the user configured by hand. */
export type AppAuthChoice =
  | { source: 'auth-server'; scopeId: string }
  | { source: 'external'; issuer: string; clientId: string; clientSecret?: string; audience?: string };

export interface AppRow {
  id: string;
  app_scope_id: string;
  vertical_slug: string;
  name: string;
  status: 'provisioning' | 'active' | 'failed';
  hostname: string | null;
  /** The vertical's non-secret provision result as JSON (#426); null for a bare ack. */
  provision_result?: string | null;
  created_by: string;
  created_at: string;
}

/**
 * One step of an app's install sequence (#424) — the durable progress record.
 * `attempts` > 1 means Resume (or a retry) re-ran the step; a 'failed' step carries
 * the downstream error VERBATIM in `last_error`.
 */
export interface InstallStep {
  step: 'directory' | 'provision' | 'activate' | 'hostname' | 'identity' | string;
  seq: number;
  status: 'running' | 'done' | 'failed';
  attempts: number;
  last_error: string | null;
  started_at: string;
  settled_at: string | null;
}

/** One entry in an app's audit trail (Activity panel) — a lifecycle transition. */
export interface AppEvent {
  id: string;
  app_scope_id: string;
  kind: 'created' | 'active' | 'failed' | 'deleted' | 'updated' | 'snapshotted' | 'snapshot-deleted' | 'data-exported' | 'data-restored';
  /** Failure reason / bound hostname / the version move / the vertical slug — depending on `kind`. */
  detail: string | null;
  actor: string;
  created_at: string;
}

/**
 * One entry in an app scope's control-plane audit log (#479) — an append-only admin
 * action (control-plane.md §4.4), mirrors the worker's `AdminLogEntry`. `before`/`after`
 * are the prior/applied state where cheaply captured; `causedBy` is the domain event id
 * that triggered the action, when one did.
 */
export interface AuditEntry {
  id: string;
  actor: string;
  action: string;
  tenantId: string | null;
  scopeId: string | null;
  vertical: string | null;
  before: unknown;
  after: unknown;
  causedBy: string | null;
  at: string;
}

/** One version of a deployed vertical — mirrors the worker's DeploymentVersion. */
export interface DeploymentVersion {
  id: string;
  version: string;
  admission: 'pending' | 'admitted' | 'rejected' | string;
  admissionNote: string | null;
  deploymentRef: string | null;
  /** Updating TO this version crosses a migration boundary (#286) — badged in the UI. */
  schemaChange?: boolean;
  createdAt: string;
}

/** One declared permission key (D-39, #336): the key, its description, and the module(s)
 *  that declare it — the machine-readable §1 of PERMISSIONS.md. */
export interface PermissionRegistryEntry {
  key: string;
  description: string;
  declaredBy: string[];
}
/** A role template (D-39): a role key and the permission keys it holds. `source` is the
 *  declaring module id, or `'vertical'` for a role the vertical composes itself. */
export interface RoleDefinition {
  key: string;
  permissions: string[];
  source: string;
}
/** An entity-narrowed grant SHAPE (D-39): which keys a per-entity grant carries. The grants
 *  themselves are per-principal runtime tuples (control-plane §4.5) — only the shape is a code
 *  fact, so only the shape ships in the manifest. */
export interface EntityGrantShape {
  entityType: string;
  permissions: string[];
}
/** The vertical's declared permission surface for one version (D-39). */
export interface PermissionRegistry {
  permissions: PermissionRegistryEntry[];
  roles: RoleDefinition[];
  entityGrants: EntityGrantShape[];
}
/** One version + its declared registry — a running or update target on the Permissions tab. */
export interface VersionRegistry {
  versionId: string | null;
  version: string | null;
  /** `null` when the version retained no manifest (pushed pre-#286) or declared no surface. */
  registry: PermissionRegistry | null;
}
/**
 * The app's Permissions tab payload (#336): the declared surface of the version this app
 * RUNS, plus the version an available update would move it to (`update`, else null) so the
 * tab can diff the two before the update lands.
 */
export interface AppPermissionsView {
  running: VersionRegistry;
  update: VersionRegistry | null;
}

/** One PITR rewind point an app recorded before a migration pass (#286). */
export interface MigrationBookmark {
  bookmark: string;
  takenAt: string;
  /** The `module@version` migrations that were about to apply when it was taken. */
  pending: string[];
}

/** A vertical this tenant pushed — the Verticals view's row (builder-plane.md Phase 4). */
export interface Deployment {
  slug: string; // full registry id, e.g. `acme-co/helpdesk`
  displaySlug: string; // bare name for display, `helpdesk`
  name: string;
  source: string;
  /** Published to the public marketplace (vs private to this team). */
  listed?: boolean;
  /**
   * Pushed by MY team — set on the per-app deployments read (the tenant-level Verticals
   * list is owned by construction). Owned + private ⇒ prod promotion is self-serve on
   * the Verticals page; otherwise it's a staff action.
   */
  owned?: boolean;
  versions: DeploymentVersion[];
  // `servingVersionId` is what prod's stable serving script actually runs (#321): when it
  // differs from a prod channel's `versionId`, the promote moved the pointer but the
  // in-place serve failed — scopes still run the old code.
  channels: Array<{ channel: string; versionId: string; servingVersionId?: string | null }>;
  /**
   * The version THIS scope is actually pinned to (the router dispatches on it) — set on
   * the per-app deployments read. It can lag the `prod` channel: an app installed when
   * prod was 0.0.9 stays on 0.0.9 until updated. `null` ⇒ unpinned (static binding).
   */
  boundVersionId?: string | null;
}

/** The per-app deployments read: `versions` is ONE page (newest first); `nextCursor` walks older. */
export interface AppDeployments extends Deployment {
  nextCursor: string | null;
}

/**
 * One builder preview of a vertical — a scope with data bound to a version, at its own
 * `--<tag>` URL (#509). A pinned one (`expiresAt: null`) with a custom domain is a
 * long-lived test environment.
 */
export interface VerticalPreview {
  scopeId: string;
  tag: string | null;
  versionId: string | null;
  forkedFrom: string | null;
  expiresAt: string | null;
  hostname: string | null;
  url: string | null;
}

/** The result of creating (or reusing) a preview. `reused` ⇒ an existing tag was rebound. */
export interface PreviewCreated {
  scopeId: string;
  hostname: string;
  url: string;
  versionId: string;
  reused: boolean;
}

/**
 * One recorded go-live: what a channel started serving, what it replaced, who moved the
 * pointer and exactly when — the rollback picker's row. `at` is also the instant a
 * point-in-time data restore would rewind to.
 */
export interface ChannelHistoryEntry {
  id: string;
  versionId: string;
  fromVersionId: string | null;
  actor: string;
  at: string;
}

/** The result of updating an app to its vertical's prod version. */
export interface UpdateResult {
  updated: boolean;
  version: string | null;
  previousVersion: string | null;
}

/** One snapshot (test copy) of an app's data — a fork's directory row. */
export interface SnapshotRow {
  id: string;
  kind: string;
  forkedFrom: string | null;
  forkedAt: string | null;
  /** null = kept until deleted; otherwise the GC sweep reaps it past this instant. */
  expiresAt: string | null;
  verticalVersionId: string | null;
  createdAt: string;
  /** The copy's preview hostname (`app--s1a2b.…`), when one is bound. */
  url?: string | null;
}

/** One table of an app-data dump (mirrors the platform's ScopeDumpTable). */
export interface DumpTable {
  name: string;
  ddl: string;
  columns: string[];
  rows: unknown[][];
}

/** `GET /api/apps/:id/export` — the app's data as a dump the CLI also accepts. */
export interface AppDataDump {
  tenantId: string;
  scopeId: string;
  capturedAt: string;
  /** True when PII columns arrived redacted (always, in connected mode). */
  masked: boolean;
  tables: DumpTable[];
}

/** `POST /api/apps/:id/restore` — what the import did, incl. the fork to back out to. */
export interface RestoreResult {
  restored: string;
  tables: number;
  safetyCopyId: string;
}

/** One importable repo the tenant's GitHub connection can see (worker's github.ts shape). */
export interface GitRepo {
  fullName: string;
  defaultBranch: string;
  private: boolean;
  updatedAt: string;
}

/** `GET /api/github/repos` — the Git-import card's live state. */
export interface GitReposResult {
  /** Is the GitHub App configured on this deployment at all? `false` ⇒ show nothing/hint. */
  configured: boolean;
  /** Has this tenant connected GitHub? `false` ⇒ show the Connect button. */
  connected: boolean;
  /** The SELECTED GitHub account (org/user login), when connected. */
  account?: string | null;
  /** Every connected account (namespace) — the picker's list; `repos` belongs to `account`. */
  accounts: string[];
  repos: GitRepo[];
}

/** `POST /api/github/setup-ci` — what the one-click deploy setup did (or still needs). */
export type SetupCiResult =
  | { ok: true; workflowPath: string; workflowUpdated: boolean; branch: string; vertical: string }
  | { ok: false; needsPermissions: true };

/** `GET /api/github/workflow-preview` — the manual path's copy-paste workflow. */
export interface WorkflowPreview {
  workflowPath: string;
  workflow: string;
}

/** One table in an app's database — the Data tab's left list (mirrors ScopeTable). */
export interface ScopeTable {
  name: string;
  rowCount: number;
  /** `_substrat_*` spine + SQLite internals — grouped apart from the vertical's own tables. */
  system: boolean;
}

/** One scope an app spans — the Data tab's scope switcher (a multi-scope vertical has several). */
export interface AppScope {
  scopeId: string;
  name: string;
  status: string;
  /** The app's primary scope — the one the Data tab opens on. */
  isDefault: boolean;
}

/** A bounded page of one table (mirrors ScopeTablePage). Rows are positional, aligned to `columns`. */
export interface ScopeTablePage {
  table: string;
  columns: string[];
  rows: unknown[][];
  rowCount: number;
  limit: number;
  offset: number;
}

/** A read-only console query's result (mirrors ScopeQueryResult). `truncated` = row cap hit. */
export interface ScopeQueryResult {
  columns: string[];
  rows: unknown[][];
  truncated: boolean;
}

/** A declared env var for a vertical — drives the Env form (placeholder + description). */
export interface EnvVarSpec {
  key: string;
  label?: string;
  description: string;
  placeholder?: string;
  required: boolean;
  secret: boolean;
  default?: string;
  group?: string;
}

/** One stored env var — a secret's value is never sent back (write-only). */
export interface AppEnvValue {
  key: string;
  isSecret: boolean;
  hasValue: boolean;
  value: string | null;
  updatedAt: string;
}

/** `GET /api/apps/:scope/env` — the vertical's declared spec + this app's current values. */
export interface AppEnvView {
  spec: EnvVarSpec[];
  values: AppEnvValue[];
}

/** `PUT /api/apps/:scope/env` — always authored; `delivered` says whether the running app
 *  got the values live, and `note` explains a save that could not be applied (#374). */
export interface AppEnvUpdateResult {
  saved: number;
  delivered: boolean;
  note?: string;
}

/** One hostname bound to the app's scope (the Domains tab). */
export interface AppHostnameRow {
  hostname: string;
  surface: string;
  status: string;
  /** Why a row is `failed` (or mid-flight detail) — rendered under the status pill. */
  statusNote: string | null;
  canonical: boolean;
  createdAt: string | null;
  /** DNS records to publish for a custom domain; empty for a platform mint. */
  validationRecords: DnsRecord[];
}

/** A surface the app's vertical declares it serves — the Domains tab's picker. */
export interface DeclaredSurface {
  name: string;
  label: string;
}

/** `GET /api/apps/:scope/hostnames` — bindings + declared surfaces + the untouchable default. */
export interface AppHostnamesView {
  bindings: AppHostnameRow[];
  surfaces: DeclaredSurface[];
  defaultHostname: string | null;
}

/** The app's stored Identity choice — the clientSecret is write-only, never echoed. */
export interface AppAuthRecord {
  mode: 'oidc';
  issuer: string;
  clientId: string;
  audience: string | null;
  hasClientSecret: boolean;
  updatedAt: string;
}

/** `GET /api/apps/:scope/auth` — `auth: null` ⇒ the vertical's builtin sign-in. */
export interface AppAuthView {
  auth: AppAuthRecord | null;
  /** The redirect URL to register at an external issuer; null while no hostname is bound. */
  callbackUrl: string | null;
}

/** `PUT /api/apps/:scope/auth` — saved always; `delivered` says whether the running app got it. */
export interface AppAuthUpdateResult {
  delivered: boolean;
  note?: string;
}

/** A DNS record the tenant must publish for a custom domain (§4.7). */
export interface DnsRecord {
  type: 'hostname' | 'txt';
  name: string;
  value: string;
  status: string | null;
}

/** One custom domain row for the account-level Domains view (`GET /api/domains`). */
export interface DomainRow {
  hostname: string;
  appScopeId: string;
  /** The app (vertical install) this domain fronts. */
  app: string;
  surface: string;
  status: 'pending' | 'verifying' | 'active' | 'failed';
  statusNote: string | null;
  /** Canonical for its (scope, surface) — the "primary" tag. */
  primary: boolean;
  createdAt: string;
  /** DNS records to publish while it is not yet active. */
  validationRecords: DnsRecord[];
}

/** The raw binding a bind/verify returns (`POST /api/domains`, `/verify`). */
export interface HostnameBinding {
  hostname: string;
  status: 'pending' | 'verifying' | 'active' | 'failed';
  statusNote?: string | null;
  validationRecords?: DnsRecord[];
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

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    credentials: 'include',
    headers: { 'content-type': 'application/json', ...(init?.headers as Record<string, string>) },
    ...init,
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new ApiError(res.status, body?.error ?? `${res.status} ${res.statusText}`);
  }
  return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
}

/** Invocation aggregates for one deployed version of a team vertical (last N hours). */
export interface ObservabilityRow {
  vertical: string;
  version: string;
  service: string;
  requests: number;
  errors: number;
  subrequests: number;
  /** Per-request CPU time quantiles, microseconds. */
  cpuTimeP50: number;
  cpuTimeP99: number;
}

/** One recent log event from a team vertical's deployed service. */
export interface ObservabilityLogEvent {
  timestamp: number | null;
  level: string | null;
  message: string | null;
  service: string | null;
  outcome: string | null;
  /** Neutral enrichments carried through the observability seam (observability.ts). */
  trigger: string | null;
  eventType: string | null;
  entrypoint: string | null;
  requestId: string | null;
  cpuTimeMs: number | null;
  wallTimeMs: number | null;
  /** The backend's full event — powers the per-row expand-to-JSON drill-down. */
  raw?: unknown;
}

export const api = {
  /** `null` when there is no session (the worker answers 401); onboarding when teamless. */
  me: async (): Promise<MeResult | null> => {
    try {
      return await call<MeResult>('/me');
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return null;
      throw e;
    }
  },
  /** Create a team (first team or another); the server switches to it, so reload after. */
  createTeam: (name: string) =>
    call<{ teamId: string }>('/teams', { method: 'POST', body: JSON.stringify({ name }) }),
  /** Switch the active team; the server pins it in a cookie, so the caller reloads after. */
  switchTeam: (teamId: string) =>
    call<void>('/teams/switch', { method: 'POST', body: JSON.stringify({ teamId }) }),
  /** Leave the current team (detaches your login); reload after — you'll land in another
   *  team or onboarding if it was your last. */
  leaveTeam: () => call<void>('/teams/leave', { method: 'POST' }),
  /** Delete the current organization (owner-only; confirmed by retyping its name). */
  deleteTeam: (confirm: string) =>
    call<void>('/teams/delete', { method: 'POST', body: JSON.stringify({ confirm }) }),
  catalog: () => call<CatalogEntry[]>('/catalog'),
  /** The current team's roster (active members + outstanding invites), one page newest-first. */
  listMembers: (opts?: PageOpts) => call<ListPage<Member>>(`/members${pageQs(opts)}`),
  /** Invite someone at a role; returns a shareable accept link (no email delivery yet). */
  inviteMember: (email: string, roleKey: InviteRole) =>
    call<{ invitationId: string; acceptUrl: string }>('/members/invite', {
      method: 'POST',
      body: JSON.stringify({ email, roleKey }),
    }),
  /** Re-send a pending invite's email; returns the (possibly refreshed) link + whether it was accepted for delivery. */
  resendInvite: (invitationId: string) =>
    call<{ invitationId: string; acceptUrl: string; emailDelivered: boolean }>('/members/resend-invite', {
      method: 'POST',
      body: JSON.stringify({ invitationId }),
    }),
  /** Withdraw a pending invite. */
  revokeInvite: (invitationId: string) =>
    call<void>('/members/revoke-invite', { method: 'POST', body: JSON.stringify({ invitationId }) }),
  /** Remove an active member (revokes their role). The owner cannot be removed. */
  removeMember: (memberId: string) =>
    call<void>('/members/remove', { method: 'POST', body: JSON.stringify({ memberId }) }),
  /** Preview an invite (unauthenticated): the team + invited email, for prefill + the accept screen. */
  previewInvite: (token: string) =>
    call<{ teamName: string; email: string; roleKey: InviteRole }>(
      `/invites/preview?token=${encodeURIComponent(token)}`,
    ),
  /** Accept an invite token; the server switches to the team, so the caller reloads after. */
  acceptInvite: (token: string) =>
    call<{ teamId: string; already?: boolean }>('/invites/accept', {
      method: 'POST',
      body: JSON.stringify({ token }),
    }),
  /** My apps, one page newest-first; follow `nextCursor` for older ones. */
  listApps: (opts?: PageOpts) => call<ListPage<AppRow>>(`/apps${pageQs(opts)}`),
  createApp: (input: { verticalSlug: string; name: string; auth?: AppAuthChoice; config?: Record<string, string> }) =>
    call<AppRow>('/apps', { method: 'POST', body: JSON.stringify(input) }),
  // -- custom domains (§4.7) -------------------------------------------------
  listDomains: (opts?: PageOpts) => call<ListPage<DomainRow>>(`/domains${pageQs(opts)}`),
  addDomain: (input: { hostname: string; appScopeId: string; surface?: string }) =>
    call<HostnameBinding>('/domains', { method: 'POST', body: JSON.stringify(input) }),
  verifyDomain: (hostname: string) =>
    call<HostnameBinding>(`/domains/${encodeURIComponent(hostname)}/verify`, { method: 'POST' }),
  removeDomain: (hostname: string) =>
    call<void>(`/domains/${encodeURIComponent(hostname)}`, { method: 'DELETE' }),
  deleteApp: (id: string) => call<void>(`/apps/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  retryApp: (scopeId: string) => call<AppRow>(`/apps/${encodeURIComponent(scopeId)}/retry`, { method: 'POST' }),
  /** Resume an app stuck at 'provisioning' — re-runs the idempotent install tail in place (#424). */
  resumeApp: (scopeId: string) => call<AppRow>(`/apps/${encodeURIComponent(scopeId)}/resume`, { method: 'POST' }),
  /** One page of the app's audit trail, newest first; `nextCursor` walks older activity. */
  appEvents: (scopeId: string, opts?: PageOpts) =>
    call<ListPage<AppEvent>>(`/apps/${encodeURIComponent(scopeId)}/events${pageQs(opts)}`),
  /** The install's durable step record (#424) — rendered live while an install runs. */
  installSteps: (scopeId: string) => call<InstallStep[]>(`/apps/${encodeURIComponent(scopeId)}/steps`),
  /** One page of the app scope's control-plane audit log (#479), newest first; `nextCursor` walks older. */
  auditLog: (scopeId: string, opts?: PageOpts) =>
    call<ListPage<AuditEntry>>(`/apps/${encodeURIComponent(scopeId)}/audit${pageQs(opts)}`),
  /** The app's vertical version registry (one page of versions, newest first) + channels +
   *  the version THIS scope actually runs (`boundVersionId`). `cursor` walks older versions. */
  appDeployments: (scopeId: string, opts?: PageOpts) =>
    call<AppDeployments>(`/apps/${encodeURIComponent(scopeId)}/deployments${pageQs(opts)}`),
  /** The declared permission surface (D-39, #336) of the version this app runs, plus the
   *  update target's, for the Permissions tab's table + update diff. */
  appPermissions: (scopeId: string) => call<AppPermissionsView>(`/apps/${encodeURIComponent(scopeId)}/permissions`),
  /** The scopes an app spans (Data tab switcher) — several for a multi-scope vertical, one otherwise. */
  appScopes: (scopeId: string) => call<AppScope[]>(`/apps/${encodeURIComponent(scopeId)}/scopes`),
  /** The tables of the app's own database (Data tab). */
  appTables: (scopeId: string) => call<ScopeTable[]>(`/apps/${encodeURIComponent(scopeId)}/tables`),
  /** A bounded page of one table of the app's database. */
  appTableRows: (scopeId: string, table: string, opts: { limit?: number; offset?: number } = {}) => {
    const q = new URLSearchParams();
    if (opts.limit != null) q.set('limit', String(opts.limit));
    if (opts.offset != null) q.set('offset', String(opts.offset));
    const qs = q.toString();
    return call<ScopeTablePage>(
      `/apps/${encodeURIComponent(scopeId)}/tables/${encodeURIComponent(table)}${qs ? `?${qs}` : ''}`,
    );
  },
  /** One read-only SQL statement against the app's database (the Data tab's console). */
  appQuery: (scopeId: string, sql: string) =>
    call<ScopeQueryResult>(`/apps/${encodeURIComponent(scopeId)}/query`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sql }),
    }),
  /** Move the app to its vertical's current prod version (rebind the scope). No-op if already current. */
  updateApp: (scopeId: string, opts?: { snapshot?: boolean }) =>
    call<UpdateResult>(`/apps/${encodeURIComponent(scopeId)}/update`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ snapshot: opts?.snapshot ?? false }),
    }),
  /** The app's pre-migration rewind points (#286), newest first. */
  appBookmarks: (scopeId: string) =>
    call<MigrationBookmark[]>(`/apps/${encodeURIComponent(scopeId)}/bookmarks`),
  /** Rewind the app to a pre-migration bookmark (#286's backout) — schema AND data;
   *  every write since the bookmark is discarded. Refused past the 24h window. */
  rewindApp: (scopeId: string, bookmark: string) =>
    call<{ rewindingTo: string }>(`/apps/${encodeURIComponent(scopeId)}/rewind`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ bookmark }),
    }),
  /** The app's snapshots (test copies), newest first. */
  appSnapshots: (scopeId: string) =>
    call<SnapshotRow[]>(`/apps/${encodeURIComponent(scopeId)}/snapshots`),
  /** Create a test copy; ttlDays omitted = kept until deleted. */
  createSnapshot: (scopeId: string, opts?: { ttlDays?: number }) =>
    call<{ id: string; expiresAt: string | null }>(`/apps/${encodeURIComponent(scopeId)}/snapshots`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(opts ?? {}),
    }),
  deleteSnapshot: (scopeId: string, snapshotId: string) =>
    call<{ deleted: string }>(
      `/apps/${encodeURIComponent(scopeId)}/snapshots/${encodeURIComponent(snapshotId)}`,
      { method: 'DELETE' },
    ),
  /** The app's data as a downloadable dump (PII-masked in connected mode). */
  exportAppData: (scopeId: string) => call<AppDataDump>(`/apps/${encodeURIComponent(scopeId)}/export`),
  /** Replace the app's data with an uploaded dump; a safety copy is forked first. */
  restoreAppData: (scopeId: string, tables: DumpTable[]) =>
    call<RestoreResult>(`/apps/${encodeURIComponent(scopeId)}/restore`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tables }),
    }),
  /** The app's env-spec + current values (secrets masked). */
  appEnv: (scopeId: string) => call<AppEnvView>(`/apps/${encodeURIComponent(scopeId)}/env`),
  /** Upsert env values; an empty value leaves a key unchanged (untouched secret). */
  setAppEnv: (scopeId: string, entries: Array<{ key: string; value: string; secret: boolean }>) =>
    call<AppEnvUpdateResult>(`/apps/${encodeURIComponent(scopeId)}/env`, {
      method: 'PUT',
      body: JSON.stringify({ entries }),
    }),
  /** Remove one env var. */
  deleteAppEnv: (scopeId: string, key: string) =>
    call<void>(`/apps/${encodeURIComponent(scopeId)}/env/${encodeURIComponent(key)}`, { method: 'DELETE' }),
  /** The app's hostname bindings + the vertical's declared surfaces (Domains tab). */
  appHostnames: (scopeId: string) => call<AppHostnamesView>(`/apps/${encodeURIComponent(scopeId)}/hostnames`),
  /** Bind a hostname to a surface: platform-minted (`domain` omitted, lands active) or a custom domain (lands pending). */
  addAppHostname: (scopeId: string, input: { surface: string; domain?: string }) =>
    call<AppHostnameRow>(`/apps/${encodeURIComponent(scopeId)}/hostnames`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  /** Unbind one hostname (the default hostname is refused). */
  removeAppHostname: (scopeId: string, hostname: string) =>
    call<{ deleted: string }>(
      `/apps/${encodeURIComponent(scopeId)}/hostnames/${encodeURIComponent(hostname)}`,
      { method: 'DELETE' },
    ),
  /** The app's Identity choice (secret redacted) + its OIDC callback URL. */
  appAuth: (scopeId: string) => call<AppAuthView>(`/apps/${encodeURIComponent(scopeId)}/auth`),
  /** Update the Identity choice; a blank clientSecret keeps the stored one. */
  setAppAuth: (scopeId: string, choice: AppAuthChoice) =>
    call<AppAuthUpdateResult>(`/apps/${encodeURIComponent(scopeId)}/auth`, {
      method: 'PUT',
      body: JSON.stringify(choice),
    }),
  listDeployments: () => call<Deployment[]>('/deployments'),

  // -- observability (design/observability.md §5, view 2) -------------------
  // Metrics/logs for THIS team's pushed verticals only — the worker narrows by
  // owned deployment refs. 501 = the platform has no observability backend.
  observabilityMetrics: (hours = 24, vertical?: string) =>
    call<ObservabilityRow[]>(
      `/observability/metrics?hours=${hours}${vertical ? `&vertical=${encodeURIComponent(vertical)}` : ''}`,
    ),
  observabilityLogs: (q: { service: string; level?: string; search?: string; hours?: number; limit?: number }) => {
    const p = new URLSearchParams({ service: q.service });
    if (q.level) p.set('level', q.level);
    if (q.search) p.set('search', q.search);
    if (q.hours) p.set('hours', String(q.hours));
    if (q.limit) p.set('limit', String(q.limit));
    return call<ObservabilityLogEvent[]>(`/observability/logs?${p.toString()}`);
  },
  /** The tenant's GitHub-import state — connection status + the selected account's repos. */
  gitRepos: (account?: string) =>
    call<GitReposResult>(`/github/repos${account ? `?account=${encodeURIComponent(account)}` : ''}`),
  /** A repo's branches, for the import step's branch picker. */
  gitBranches: (repo: string, account?: string) =>
    call<{ branches: Array<{ name: string }> }>(
      `/github/branches?repo=${encodeURIComponent(repo)}${account ? `&account=${encodeURIComponent(account)}` : ''}`,
    ),
  /** One-click deploy setup: commit the workflow + write the scoped push credential. */
  setupCi: (repo: string, branch: string, account?: string) =>
    call<SetupCiResult>('/github/setup-ci', {
      method: 'POST',
      body: JSON.stringify({ repo, branch, ...(account ? { account } : {}) }),
    }),
  /** The manual path's workflow YAML (same generator the one-click commit uses). */
  workflowPreview: (repo: string, branch: string) =>
    call<WorkflowPreview>(
      `/github/workflow-preview?repo=${encodeURIComponent(repo)}&branch=${encodeURIComponent(branch)}`,
    ),
  promoteDeployment: (
    slug: string,
    channel: 'prod',
    versionId: string,
    acknowledge?: { permissionChange?: boolean; migrationChange?: boolean },
  ) =>
    call<void>(`/deployments/${encodeURIComponent(slug)}/promote`, {
      method: 'POST',
      body: JSON.stringify({ channel, versionId, ...(acknowledge ? { acknowledge } : {}) }),
    }),
  /** Remove one of my verticals (versions + channels included). Refused while any app
   *  still runs it — delete the apps first — and for a published vertical (staff-only). */
  deleteDeployment: (slug: string) =>
    call<void>(`/deployments/${encodeURIComponent(slug)}`, { method: 'DELETE' }),
  /** One channel's promotion timeline (newest first) — the rollback picker's data. */
  channelHistory: (slug: string, channel: 'prod') =>
    call<ChannelHistoryEntry[]>(
      `/deployments/${encodeURIComponent(slug)}/channels/${encodeURIComponent(channel)}/history`,
    ),

  // -- per-scope rollout + builder previews (#509) --------------------------
  /** Pin THIS app's scope to a specific admitted version (canary / catch-up / test env),
   *  vs `updateApp` which always rebinds to wherever prod points. `snapshot` forks first. */
  bindAppVersion: (scopeId: string, versionId: string, opts?: { snapshot?: boolean }) =>
    call<void>(`/apps/${encodeURIComponent(scopeId)}/bind`, {
      method: 'POST',
      body: JSON.stringify({ versionId, ...(opts?.snapshot ? { snapshot: true } : {}) }),
    }),
  /** A vertical's live builder previews (each a fork/clean-room scope + `--<tag>` URL). */
  listPreviews: (slug: string) => call<VerticalPreview[]>(`/deployments/${encodeURIComponent(slug)}/previews`),
  /** Create (or reuse, per tag) a preview of an admitted version. `ttlHours: null` pins it
   *  (a test env); `empty` provisions a clean-room scope when there is no prod to fork. */
  createPreview: (
    slug: string,
    input: { tag: string; versionId: string; ttlHours?: number | null; empty?: boolean; sourceScopeId?: string; surface?: string; refresh?: boolean },
  ) =>
    call<PreviewCreated>(`/deployments/${encodeURIComponent(slug)}/previews`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  /** Reap one preview by tag (idempotent). */
  deletePreview: (slug: string, tag: string) =>
    call<{ deleted: string | null }>(
      `/deployments/${encodeURIComponent(slug)}/previews/${encodeURIComponent(tag)}`,
      { method: 'DELETE' },
    ),
  /** Attach a custom domain to a preview scope — what turns a pinned preview into a
   *  test environment at a stable address (crm-test.ahero.se). Lands pending, walks DNS. */
  addPreviewDomain: (
    slug: string,
    tag: string,
    input: { domain: string; surface?: string; canonical?: boolean },
  ) =>
    call<AppHostnameRow>(
      `/deployments/${encodeURIComponent(slug)}/previews/${encodeURIComponent(tag)}/domain`,
      { method: 'POST', body: JSON.stringify(input) },
    ),
};

/**
 * Auth is a full-page redirect — the OIDC round-trip needs a real navigation.
 * `returnTo` is a same-origin path the callback returns to (e.g. an invite link);
 * `loginHint` prefills the email at the IdP; `screenHint` opens sign-up vs log-in.
 */
export const signIn = (
  opts: { returnTo?: string; loginHint?: string; screenHint?: 'signup' | 'login' } = {},
) => {
  const p = new URLSearchParams();
  if (opts.returnTo) p.set('returnTo', opts.returnTo);
  if (opts.loginHint) p.set('login_hint', opts.loginHint);
  if (opts.screenHint) p.set('screen_hint', opts.screenHint);
  const qs = p.toString();
  window.location.href = `/api/auth/login${qs ? `?${qs}` : ''}`;
};
/** Connect GitHub — a full-page redirect to the App install flow (returns to /apps/new). */
export const connectGithub = () => {
  window.location.href = '/api/github/connect';
};
export const signOut = (opts: { returnTo?: string } = {}) => {
  const rt = typeof opts?.returnTo === 'string' ? opts.returnTo : undefined;
  // Always federated: signed-out visits redirect straight to the IdP, so a logout
  // that left the IdP's SSO cookie alive would silently sign the user right back in.
  window.location.href = `/api/auth/logout?federated${rt ? `&returnTo=${encodeURIComponent(rt)}` : ''}`;
};
