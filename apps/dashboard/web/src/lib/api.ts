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
export interface AppRow {
  id: string;
  app_scope_id: string;
  vertical_slug: string;
  name: string;
  status: 'provisioning' | 'active' | 'failed';
  hostname: string | null;
  created_by: string;
  created_at: string;
}

/** One entry in an app's audit trail (Activity panel) — a lifecycle transition. */
export interface AppEvent {
  id: string;
  app_scope_id: string;
  kind: 'created' | 'active' | 'failed' | 'deleted' | 'updated';
  /** Failure reason / bound hostname / the version move / the vertical slug — depending on `kind`. */
  detail: string | null;
  actor: string;
  created_at: string;
}

/** One version of a deployed vertical — mirrors the worker's DeploymentVersion. */
export interface DeploymentVersion {
  id: string;
  version: string;
  admission: 'pending' | 'admitted' | 'rejected' | string;
  admissionNote: string | null;
  deploymentRef: string | null;
  createdAt: string;
}

/** A vertical this tenant pushed — the Deployments view's row (builder-plane.md Phase 4). */
export interface Deployment {
  slug: string; // full registry id, e.g. `acme-co/helpdesk`
  displaySlug: string; // bare name for display, `helpdesk`
  name: string;
  source: string;
  versions: DeploymentVersion[];
  channels: Array<{ channel: string; versionId: string }>;
  /**
   * The version THIS scope is actually pinned to (the router dispatches on it) — set on
   * the per-app deployments read. It can lag the `prod` channel: an app installed when
   * prod was 0.0.9 stays on 0.0.9 until updated. `null` ⇒ unpinned (static binding).
   */
  boundVersionId?: string | null;
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
  /** The connected GitHub account (org/user login), when connected. */
  account?: string | null;
  repos: GitRepo[];
}

/** One table in an app's database — the Data tab's left list (mirrors ScopeTable). */
export interface ScopeTable {
  name: string;
  rowCount: number;
  /** `_substrat_*` spine + SQLite internals — grouped apart from the vertical's own tables. */
  system: boolean;
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
  catalog: () => call<CatalogEntry[]>('/catalog'),
  /** The current team's roster (active members + outstanding invites). */
  listMembers: () => call<Member[]>('/members'),
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
  listApps: () => call<AppRow[]>('/apps'),
  createApp: (input: { verticalSlug: string; name: string }) =>
    call<AppRow>('/apps', { method: 'POST', body: JSON.stringify(input) }),
  deleteApp: (id: string) => call<void>(`/apps/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  retryApp: (scopeId: string) => call<AppRow>(`/apps/${encodeURIComponent(scopeId)}/retry`, { method: 'POST' }),
  appEvents: (scopeId: string) => call<AppEvent[]>(`/apps/${encodeURIComponent(scopeId)}/events`),
  /** The app's vertical version registry + channels + the version THIS scope actually runs (`boundVersionId`). */
  appDeployments: (scopeId: string) => call<Deployment>(`/apps/${encodeURIComponent(scopeId)}/deployments`),
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
  /** Move the app to its vertical's current prod version (rebind the scope). No-op if already current. */
  updateApp: (scopeId: string, opts?: { snapshot?: boolean }) =>
    call<UpdateResult>(`/apps/${encodeURIComponent(scopeId)}/update`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ snapshot: opts?.snapshot ?? false }),
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
  /** The app's env-spec + current values (secrets masked). */
  appEnv: (scopeId: string) => call<AppEnvView>(`/apps/${encodeURIComponent(scopeId)}/env`),
  /** Upsert env values; an empty value leaves a key unchanged (untouched secret). */
  setAppEnv: (scopeId: string, entries: Array<{ key: string; value: string; secret: boolean }>) =>
    call<{ saved: number }>(`/apps/${encodeURIComponent(scopeId)}/env`, {
      method: 'PUT',
      body: JSON.stringify({ entries }),
    }),
  /** Remove one env var. */
  deleteAppEnv: (scopeId: string, key: string) =>
    call<void>(`/apps/${encodeURIComponent(scopeId)}/env/${encodeURIComponent(key)}`, { method: 'DELETE' }),
  listDeployments: () => call<Deployment[]>('/deployments'),
  /** The tenant's GitHub-import state — connection status + the repos it can see. */
  gitRepos: () => call<GitReposResult>('/github/repos'),
  promoteDeployment: (slug: string, channel: 'dev' | 'staging', versionId: string) =>
    call<void>(`/deployments/${encodeURIComponent(slug)}/promote`, {
      method: 'POST',
      body: JSON.stringify({ channel, versionId }),
    }),
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
/** Connect GitHub — a full-page redirect to the App install flow (returns to #/apps/new). */
export const connectGithub = () => {
  window.location.href = '/api/github/connect';
};
export const signOut = (opts: { returnTo?: string } = {}) => {
  const rt = typeof opts?.returnTo === 'string' ? opts.returnTo : undefined;
  window.location.href = `/api/auth/logout${rt ? `?returnTo=${encodeURIComponent(rt)}` : ''}`;
};
