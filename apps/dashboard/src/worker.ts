/**
 * The Dashboard — the tenant-facing self-service surface, as a Cloudflare Worker.
 * See docs/design/dashboard.md. M0: sign up → your own tenant is bootstrapped →
 * create an app (a scope running a vertical, in YOUR tenant) → list your apps.
 *
 * The tenant is never a request argument: it is the account the authenticated user
 * owns, so a caller can only ever provision into their own tenant (§4). For M0 the
 * apps run in THIS deployment (the ScopeDO bundles the app verticals); in
 * production each app is a separate vertical deployment reached via the control
 * plane.
 */
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { principalId, scopeId, tenantId, orgId, platformActorId, connectionId, queryScopeInput, readScopeTableInput, scopeDumpTable, listPageQuery, pageOf, LIST_PAGE_MAX, z, type EnvVarSpec, type PermissionKey, type PermissionRegistry, type TenantId } from '@substrat-run/contracts';
import { defineScopeDO, ControlPlaneDO, CloudflareScopeHost } from '@substrat-run/adapter-cloudflare';
import { ulid, webCryptoSecretBox, type ScopeHost, type SecretBox } from '@substrat-run/kernel';
import { protocolModule } from '@substrat-run/engine-protocol';
import { workorderModule } from '@substrat-run/engine-workorder';
import { invoicingModule } from '@substrat-run/engine-invoicing';
import { invitesModule } from '@substrat-run/engine-invites';
// The worker-safe subpath: the Callout domain module + perms only, never the demo's
// seed/auth (node + better-auth). M0 bundles the vertical here as a stand-in; the
// production model deploys Callout separately (dashboard.md §6) and — per master-plan
// D-33 — a demo is a template that is COPIED, not imported. This import is the M0 seam.
import { calloutModule } from '@substrat-run/demo-callout/module';
// The worker-safe subpath of the Meridian (HR) vertical: its domain module only, never
// the demo's node/better-auth seed. M0 bundles it here, same seam as Callout.
import { meridianModule } from '@substrat-run/demo-meridian/module';
import { manyfoldModule } from '@substrat-run/demo-manyfold/module';
import { CATALOG, ensureCatalog, availableCatalog, oidcIssuerProviderSlugs } from './catalog.js';
import { mountOidcRoutes, verifySession, SESSION_COOKIE, type OidcEnv } from '@substrat-run/oidc-rp';
import { dashboardModule, type DashboardAppRow } from './module.js';
import { createApp, deprovisionApp, retryApp, resumeApp, updateApp, snapshotApp, listAppSnapshots, deleteAppSnapshot, exportAppData, restoreAppData, listAppHostnames, resolveDefaultHostname, addAppHostname, removeAppHostname, provisionDashboard, reconcileRoles, ensureRosterSeeded, slugify, installEntitlements, type DashboardNode } from './provision.js';
import { authConfigFor, type AppAuthChoice } from './auth-wiring.js';
import { listDeploymentsFromCp, listDeploymentsFromHost, verticalDeploymentFromCp, verticalDeploymentFromHost, verticalDeploymentPageFromCp, verticalDeploymentPageFromHost, versionRegistryFromHost, assertOwned } from './deployments.js';
import { ControlPlaneError, TenantNarrowedControlPlane } from './authority.js';
import { transportFor, senderFor, teamInviteEmail } from './email.js';
import { deployWorkflowYaml, githubConfig, installUrl, installationAccount, listInstallationRepos, listRepoBranches, setupRepoCi } from './github.js';
import { sealForGithub } from './github-seal.js';
import { b64url, b64urlToBytes } from './b64.js';
import type { SendEmailBinding } from '@substrat-run/adapter-email';

/** The identity provider: the platform's AuthHero instance, via the identity pool. */
const PROVIDER = 'authhero';

/**
 * The selected-team cookie. Identity (who you are) lives on `sb_session`; this
 * carries only WHICH of your teams the portal is currently scoped to — kept
 * separate so a team switch never touches the login. It is NOT a security
 * boundary: every read re-verifies the named team is one the caller actually
 * belongs to (`listIdentityTenants`), so a forged value can only ever name a
 * team you are already a member of, and otherwise falls back to your default.
 */
const TEAM_COOKIE = 'sb_team';
const TEAM_COOKIE_MAXAGE = 60 * 60 * 24 * 365;
const teamCookieOpts = (origin: string) => ({
  httpOnly: true,
  secure: origin.startsWith('https:'),
  sameSite: 'Lax' as const,
  path: '/',
  maxAge: TEAM_COOKIE_MAXAGE,
});

// The app binary: the Dashboard vertical + the verticals an app can run. M0 bundles
// the app verticals into this deployment's ScopeDO (see the file header), so every
// module a catalog entry needs must be here: Documents (protocol), Callout — the
// field-service vertical composing workorder + invoicing + protocol — and Meridian,
// the HR vertical (its core domain is vertical code on the kernel; it composes
// protocol for onboarding only).
const MODULES = [dashboardModule, invitesModule, protocolModule, workorderModule, invoicingModule, calloutModule, meridianModule, manyfoldModule];
export const ScopeDO = defineScopeDO(MODULES, {});
export { ControlPlaneDO };

const STAFF = platformActorId.parse('01JZ000000000000000000DAS1');

// The catalog (verticals a customer can instantiate + their provisioning specifics) and
// its availability rules live in ./catalog.ts — kept free of Cloudflare imports so the
// connected-mode gating is unit-testable. `CATALOG`/`ensureCatalog`/`availableCatalog`
// are imported at the top of the file.

interface Env extends OidcEnv {
  SCOPE: DurableObjectNamespace;
  CONTROL_PLANE: DurableObjectNamespace;
  /**
   * CONNECTED mode (production): a service binding to `substrat-control-plane` — the
   * shared directory the router reads. When bound (with a service token), apps are
   * provisioned there through the tenant-narrowed seam (§4) so they are REACHABLE,
   * rather than into this deployment's own DOs. Absent ⇒ the M0 embedded path.
   */
  CONTROL_PLANE_SVC?: Fetcher;
  /** Shared service credential the control plane resolves to its service actor. */
  CP_SERVICE_TOKEN?: string;
  /** The platform actor id stamped on shared-plane writes (a fixed dashboard actor). */
  CP_ACTOR?: string;
  /**
   * Cloudflare Email Service `send_email` binding — invite + transactional mail.
   * Absent ⇒ the in-memory mock (local dev has no sending domain), so an invite
   * still succeeds; only the email is dropped.
   */
  EMAIL?: SendEmailBinding;
  /** Sender address for platform mail (default `no-reply@send.substrat.net`); domain must be onboarded. */
  EMAIL_FROM?: string;
  /**
   * GitHub App credentials for the repo-import flow (connections.md §3.5.1). Secrets;
   * absent ⇒ the Git-import surface reports "not configured" rather than erroring.
   * The private key is PKCS#8 PEM (RS256); the slug builds the install URL.
   */
  GITHUB_APP_ID?: string;
  GITHUB_APP_SLUG?: string;
  GITHUB_APP_PRIVATE_KEY?: string;
  /**
   * The control plane's PUBLIC base URL (e.g. `https://console.substrat.net/api`) — what
   * a customer repo's CI needs as `SUBSTRAT_CP_URL`, since GitHub Actions cannot reach
   * the service binding. A plain var (wrangler.jsonc), not a secret. Absent ⇒ the
   * one-click CI setup 501s (the manual instructions remain).
   */
  CP_PUBLIC_URL?: string;
  /**
   * The AES-256 key that seals stored connection credentials (connections.md §3.3).
   * base64 of 32 bytes (`openssl rand -base64 32`). A DEDICATED secret — never derived
   * from SESSION_SECRET, so the two rotate independently; rotating this without keeping
   * the old key makes existing sealed credentials unreadable. Absent ⇒ the host fails
   * closed on any credential write (no plaintext fallback). `SECRET_BOX_KEY_ID` labels
   * the key for rotation (stored per-ciphertext); defaults to `sb1`.
   */
  SECRET_BOX_KEY?: string;
  SECRET_BOX_KEY_ID?: string;
}

const DASHBOARD_CP_ACTOR = platformActorId.parse('01JZ000000000000000000DASH');

/**
 * The tenant-narrowed control-plane seam for a caller (§4), or `null` in embedded
 * mode. The tenant is pinned to the caller's own — read from their dashboard node,
 * never a request argument — so provisioning cannot escape their tenant.
 */
function controlPlaneFor(env: Env, tenantId: DashboardNode['tenantId']): TenantNarrowedControlPlane | null {
  if (!env.CONTROL_PLANE_SVC || !env.CP_SERVICE_TOKEN) return null;
  return new TenantNarrowedControlPlane({
    // Host is ignored over a service binding; the control-plane API mounts at `/api`.
    baseUrl: 'https://control-plane/api',
    actor: env.CP_ACTOR ?? DASHBOARD_CP_ACTOR,
    serviceToken: env.CP_SERVICE_TOKEN,
    tenantId,
    fetch: env.CONTROL_PLANE_SVC.fetch.bind(env.CONTROL_PLANE_SVC),
  });
}

/** The AES-256 SecretBox that seals connection credentials, or undefined when unset
 *  (the host then fails closed on any credential write — never stores plaintext). */
/**
 * Mirror one login's identity link for a team into the SHARED control plane
 * (CONNECTED mode; a no-op without the service binding). The builder plane —
 * `substrat login`'s whoami and the CLI push's session auth — resolves
 * `userId → tenants` against the shared plane's directory, but identity links
 * are written at sign-up/invite-accept into THIS deployment's own
 * ControlPlaneDO, a different DO entirely; the mirror is what makes an
 * interactive `substrat push` find a workspace. Best-effort by design: the
 * local link stays authoritative, a plane outage must never fail sign-up or
 * invite-accept, and `/api/me` re-mirrors on every load — which is also the
 * backfill for teams created before this mirror existed.
 */
async function mirrorBuilderIdentity(env: Env, host: ScopeHost, userId: string, t: TenantId): Promise<void> {
  const cp = controlPlaneFor(env, t);
  if (!cp) return;
  try {
    const team = await host.admin.getTenant(STAFF, t);
    if (!team || team.status !== 'active') return;
    const mapped = await host.admin.resolveIdentity(t, PROVIDER, userId);
    if (!mapped) return;
    await cp.ensureTenant(team.slug, team.name);
    // `ensureTenant` is a no-op for an existing row, so a tenant first mirrored at
    // app-provision time keeps its placeholder name (historically the login's email)
    // forever — sync the display name so the CLI's workspace picker shows the team.
    // Read-then-patch to keep the quiet path writeless (this runs on every /api/me).
    const shared = await cp.getTenant();
    if (shared && shared.name !== team.name) await cp.setTenantName(team.name);
    await cp.linkIdentity({
      provider: PROVIDER,
      externalId: userId,
      principal: mapped.principal,
      ...(mapped.scopeId ? { scopeId: mapped.scopeId } : {}),
    });
  } catch {
    // best-effort: re-mirrored on the next /api/me
  }
}

function secretBoxFor(env: Env): SecretBox | undefined {
  if (!env.SECRET_BOX_KEY) return undefined;
  const key = b64urlToBytes(env.SECRET_BOX_KEY.trim());
  if (key.length !== 32) throw new Error(`SECRET_BOX_KEY must decode to 32 bytes (got ${key.length}) — use \`openssl rand -base64 32\``);
  return webCryptoSecretBox(env.SECRET_BOX_KEY_ID ?? 'sb1', key);
}

/** The coordinator is stateless — rebuilt per request; durable state lives in the DOs + D1. */
function hostFor(env: Env): CloudflareScopeHost {
  const host = new CloudflareScopeHost({ scope: env.SCOPE, controlPlane: env.CONTROL_PLANE, secretBox: secretBoxFor(env) });
  for (const m of MODULES) host.registerModule(m);
  return host;
}

/** A globally-unique, URL-safe team slug from its name + the tenant id tail. */
function teamSlug(name: string, tenantId: string): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'team';
  // The tenant ULID is unique, so its tail disambiguates two teams sharing a name.
  const tail = tenantId.toLowerCase().replace(/[^a-z0-9]/g, '').slice(-6) || 'x';
  return `${base}-${tail}`;
}

// -- signed invite token -----------------------------------------------------
// The invite link carries WHERE to accept (which tenant/scope/invitation) in an
// HMAC-signed token (Web Crypto, SESSION_SECRET — the same secret oidc-rp signs
// with). The token is routing, not the secret: the real gate is the invites
// engine re-hashing the recipient's verified email at accept, so a tampered or
// leaked token can only ever accept an invitation sent to the holder's own email.
// Signing just stops the tenant/scope fields being forged to probe other scopes.

interface InviteClaim {
  tenantId: string;
  scopeId: string;
  invitationId: string;
  exp: number;
}

function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

async function signInviteToken(env: Env, claim: Omit<InviteClaim, 'exp'>): Promise<string> {
  const payload: InviteClaim = { ...claim, exp: Date.now() + 14 * 24 * 60 * 60 * 1000 };
  const body = b64url(new TextEncoder().encode(JSON.stringify(payload)));
  const sig = new Uint8Array(
    await crypto.subtle.sign('HMAC', await hmacKey(env.SESSION_SECRET), new TextEncoder().encode(body)),
  );
  return `${body}.${b64url(sig)}`;
}

async function verifyInviteToken(env: Env, token: string): Promise<InviteClaim | null> {
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const ok = await crypto.subtle.verify(
    'HMAC',
    await hmacKey(env.SESSION_SECRET),
    b64urlToBytes(sig),
    new TextEncoder().encode(body),
  );
  if (!ok) return null;
  try {
    const claim = JSON.parse(new TextDecoder().decode(b64urlToBytes(body))) as InviteClaim;
    return claim.exp > Date.now() ? claim : null;
  } catch {
    return null;
  }
}

// -- signed OAuth state (connections.md §3.5.1) ------------------------------
// The in-scope `begin-connection` op authorizes the connect (permission check +
// the authorizing principal); the worker mints THIS token from that result and
// passes it through the provider's install redirect. At the callback we verify the
// signature — proving the connect was authorized in-scope by this principal for
// this tenant — before effecting the sealed `createConnection`. Signing (not the
// secret) is what stops the tenant/principal fields being forged to attach a
// connection to someone else's tenant; short-lived because it is single-use.

interface GithubStateClaim {
  tenantId: string;
  principal: string;
  provider: string;
  nonce: string;
  exp: number;
}

async function signGithubState(env: Env, claim: Omit<GithubStateClaim, 'exp' | 'nonce'>): Promise<string> {
  const payload: GithubStateClaim = { ...claim, nonce: crypto.randomUUID(), exp: Date.now() + 10 * 60 * 1000 };
  const body = b64url(new TextEncoder().encode(JSON.stringify(payload)));
  const sig = new Uint8Array(
    await crypto.subtle.sign('HMAC', await hmacKey(env.SESSION_SECRET), new TextEncoder().encode(body)),
  );
  return `${body}.${b64url(sig)}`;
}

async function verifyGithubState(env: Env, token: string): Promise<GithubStateClaim | null> {
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const ok = await crypto.subtle.verify(
    'HMAC',
    await hmacKey(env.SESSION_SECRET),
    b64urlToBytes(sig),
    new TextEncoder().encode(body),
  );
  if (!ok) return null;
  try {
    const claim = JSON.parse(new TextDecoder().decode(b64urlToBytes(body))) as GithubStateClaim;
    return claim.exp > Date.now() ? claim : null;
  } catch {
    return null;
  }
}

/** One team the signed-in user belongs to — a tenant, named for the switcher. */
interface Team {
  id: TenantId;
  name: string;
  slug: string;
}

/** The teams a login belongs to, resolved to display names for the switcher. */
async function listTeams(host: ScopeHost, tenants: readonly TenantId[]): Promise<Team[]> {
  const teams: Team[] = [];
  for (const t of tenants) {
    const tenant = await host.admin.getTenant(STAFF, t);
    if (tenant && tenant.status === 'active') teams.push({ id: t, name: tenant.name, slug: tenant.slug });
  }
  return teams;
}

/**
 * Resolve the caller's node for one of their teams — the selected team if they are
 * genuinely a member of it (verified: `selectedTeamId` must be in `tenants`), else
 * their first/default team. `null` when the caller belongs to no team, or the
 * chosen team has no resolvable principal/dashboard scope. `tenants` is passed in
 * (already fetched) so the caller reads the directory once.
 */
async function resolveNode(
  host: ScopeHost,
  tenants: readonly TenantId[],
  userId: string,
  selectedTeamId: string | undefined,
): Promise<DashboardNode | null> {
  // A non-active tenant (a deleted organization) never resolves — belt to the
  // unlinkIdentity at delete time, so a lingering identity row can't land anyone
  // in a dead team.
  const active: TenantId[] = [];
  for (const cand of tenants) {
    if ((await host.admin.getTenant(STAFF, cand))?.status === 'active') active.push(cand);
  }
  const t = active.find((x) => x === selectedTeamId) ?? active[0];
  if (!t) return null;
  const mapped = await host.admin.resolveIdentity(t, PROVIDER, userId);
  const dash = (await host.admin.listScopes(STAFF, { tenantId: t, vertical: 'dashboard' }))[0];
  if (!mapped || !dash) return null;
  // Self-heal role drift: a tenant provisioned before a permission was added to a role
  // (e.g. dashboard:manage-integrations) gets its role set brought current here, once.
  await reconcileRoles(host, STAFF, t);
  return { tenantId: t, scopeId: dash.id, principal: mapped.principal };
}

/**
 * The authenticated customer's account node — the tenant, their dashboard scope,
 * and their principal in that tenant. Derived from the OIDC session (the ID token
 * `sub`) plus the selected-team cookie, NOT the URL.
 *
 * A login can belong to several teams (tenants), so `selectedTeamId` picks which
 * one this request is scoped to; the selection can never name a team you are not
 * in. `null` when there is no session OR the login belongs to no team yet — a
 * teamless login is routed to onboarding by `/api/me`, never here. This resolver
 * is READ-ONLY: teams are created explicitly (`createTeam` / `POST /api/teams`),
 * not as a side effect of resolving who you are — the roster self-heal below only
 * ever completes a team that already exists.
 */
async function resolveAccount(
  host: ScopeHost,
  env: Env,
  sessionToken: string | undefined,
  selectedTeamId?: string,
): Promise<DashboardNode | null> {
  const user = await verifySession(env, sessionToken);
  if (!user) return null;
  // The pool must exist before we can ask which tenants a login is in (central topology).
  await host.admin.registerIdentityPool(STAFF, { provider: PROVIDER, topology: 'central', tenantId: null });
  const tenants = await host.admin.listIdentityTenants(STAFF, PROVIDER, user.id);
  const node = await resolveNode(host, tenants, user.id, selectedTeamId);
  // Pre-roster teams (#191) get their empty roster seeded here — the email is only
  // in hand at this layer (the session), which is why the heal lives on this path.
  if (node) await ensureRosterSeeded(host, STAFF, node, user.email ?? '');
  return node;
}

/**
 * Create a NEW team for the signed-in user: a tenant, a dashboard scope, and the
 * user as its owner, with their identity linked into it. Used for both the first
 * team (signup onboarding) and additional teams ("New team") — the same move, since
 * the identity directory keys a login's principal per-tenant (K-22), so the same
 * `sub` becomes the owner of each team it creates. Bootstrapping ONE team is the
 * only action that cannot be tenant-narrowed (there is no tenant yet), so it stays
 * a controlled platform action, gated by the authenticated session.
 */
async function createTeam(host: ScopeHost, env: Env, user: { id: string; email?: string | null }, name: string): Promise<DashboardNode> {
  await host.admin.registerIdentityPool(STAFF, { provider: PROVIDER, topology: 'central', tenantId: null });
  const t = tenantId.parse(ulid());
  const s = scopeId.parse(ulid());
  const owner = principalId.parse(ulid());
  await provisionDashboard(host, { tenantId: t, scopeId: s, owner, slug: teamSlug(name, t), name });
  await host.admin.linkIdentity(STAFF, {
    provider: PROVIDER,
    externalId: user.id,
    principal: owner,
    tenantId: t,
    scopeId: s,
  });
  // Seed the roster: one default org to key invitations on, and the owner as the
  // first (active) member. Invoked in-scope as the owner (who holds every key).
  const org = orgId.parse(ulid());
  await host.admin.createOrg(STAFF, { id: org, tenantId: t, slug: 'team', name });
  const scope = await host.getScope(owner, t, s);
  await scope.invoke('dashboard/init-team', { orgId: org, ownerEmail: user.email ?? '' });
  // Mirror the owner into the shared plane's directory so `substrat push` can
  // resolve this workspace immediately (see mirrorBuilderIdentity).
  await mirrorBuilderIdentity(env, host, user.id, t);
  return { tenantId: t, scopeId: s, principal: owner };
}

/** An Identity choice as the API accepts it — install form and Settings tab alike. */
const appAuthChoiceBody = z.discriminatedUnion('source', [
  z.object({ source: z.literal('auth-server'), scopeId: z.string().min(1) }),
  z.object({
    source: z.literal('external'),
    issuer: z.string().url(),
    clientId: z.string().min(1),
    clientSecret: z.string().optional(),
    audience: z.string().optional(),
  }),
]);

const createAppBody = z.object({
  verticalSlug: z.string().min(1),
  name: z.string().min(1),
  /** The Identity section's choice (vertical-auth-detach.md §2.4). Absent ⇒ builtin. */
  auth: appAuthChoiceBody.optional(),
  /**
   * The install form's config values (#426), keyed by env-spec key. The handler narrows
   * them to the vertical's DECLARED spec (the manifest is the allow-list, exactly as
   * `resolveScopedEnvSpec` reads) — an undeclared key is dropped, not delivered.
   */
  config: z.record(z.string(), z.string()).optional(),
});

/**
 * Resolve an API Identity choice to a concrete issuer. An `auth-server` choice names
 * one of the CALLER'S own apps and is resolved to its issuer origin from THEIR app
 * list — it must be an ACTIVE instance of a vertical that PROVIDES `oidc-issuer`
 * (manifest `provides`, #427 — no longer the hardcoded `auth-server` slug), with a
 * bound hostname; anything else is a 400 now rather than a dangling issuer later.
 */
function resolveAuthChoice(
  choice: z.infer<typeof appAuthChoiceBody>,
  apps: DashboardAppRow[],
  providerSlugs: ReadonlySet<string>,
): AppAuthChoice {
  if (choice.source === 'external') {
    const { source, ...rest } = choice;
    return { source, ...rest };
  }
  const issuerApp = apps.find((a) => a.app_scope_id === choice.scopeId);
  if (!issuerApp || !providerSlugs.has(issuerApp.vertical_slug)) {
    throw new HTTPException(400, { message: 'the chosen auth server is not one of your apps that provides oidc-issuer' });
  }
  if (issuerApp.status !== 'active' || !issuerApp.hostname) {
    throw new HTTPException(400, { message: `auth server '${issuerApp.name}' is not active yet — wait for it to provision` });
  }
  return { source: 'auth-server', issuer: `https://${issuerApp.hostname}` };
}

/**
 * The slugs whose instances count as `oidc-issuer` providers for this caller (#427):
 * capability-declared verticals from the local registry + the shared plane's catalog
 * (same lookup ladder every other install read uses), plus the legacy `auth-server`
 * slug for rows pushed before `provides` existed.
 */
async function oidcProviderSlugsFor(
  host: ReturnType<typeof hostFor>,
  cp?: TenantNarrowedControlPlane | null,
): Promise<Set<string>> {
  await ensureCatalog(host, STAFF);
  const local = await host.admin.listVerticals(STAFF);
  const remote = cp ? await cp.listCatalog().catch(() => []) : [];
  return oidcIssuerProviderSlugs(local, remote);
}

// A builder self-serves every channel of a PRIVATE vertical — prod included, which is
// what makes rollback (promote an older version) a dashboard action. Prod on a LISTED
// vertical is refused in the handler: publishing widened the audience, so that gate is
// staff again (marketplace-publish.md §2). `acknowledge` carries the digest-change
// confirmations the registry demands when permissions/migrations differ.
const promoteBody = z.object({
  channel: z.enum(['dev', 'staging', 'prod']),
  versionId: z.string().min(1),
  acknowledge: z
    .object({ permissionChange: z.boolean().optional(), migrationChange: z.boolean().optional() })
    .optional(),
});

const app = new Hono<{ Bindings: Env }>();

// The Dashboard SPA (apps/dashboard/web) is served by the Workers Assets binding
// configured in wrangler.jsonc: asset requests are answered before this worker
// runs, and its `single-page-application` not-found handling serves index.html
// for any non-asset, non-`/api` path so the client router can take over. This
// worker owns only `/api/*` (below).

// OIDC relying party (AuthHero): /api/auth/login → /callback → /logout.
mountOidcRoutes(app);

/**
 * The catalog — the verticals you can instantiate, from the registry. In CONNECTED
 * mode (a shared control plane is bound) we only advertise verticals that plane can
 * actually provision (`connected !== false`); offering one it can't would hand the
 * user a marketplace tile whose install always 501s. Embedded/standalone bundles every
 * module in-process, so it lists them all. Mode is detected exactly as provisioning is
 * (`controlPlaneFor`): both keys present ⇒ connected.
 */
/**
 * A vertical's install specifics — REGISTRY-DRIVEN (marketplace-publish.md §3): read
 * `entitlements`/`ownerGrants` off the registry row (carried on push from the manifest), with
 * the hardcoded `CATALOG` as the fallback for a first-party not yet re-seeded. Throws 400 if the
 * vertical is unknown to both. This is what lets a pushed vertical install with no catalog edit.
 */
async function installSpecFor(
  host: ReturnType<typeof hostFor>,
  slug: string,
  cp?: TenantNarrowedControlPlane | null,
): Promise<{ entitlements: string[]; ownerGrants: PermissionKey[]; envSpec: EnvVarSpec[] }> {
  await ensureCatalog(host, STAFF);
  const registered = (await host.admin.listVerticals(STAFF)).find((v) => v.slug === slug);
  const cat = CATALOG[slug];
  if (registered || cat) {
    return {
      // A vertical that declares no `entitlements` still gates on its own
      // `entitlementKey` (slug, by convention) — derive it, or the install grants
      // NOTHING and every gated operation fails closed on first use (#443).
      entitlements: installEntitlements(slug, registered?.entitlements, cat?.entitlements),
      ownerGrants: (registered?.ownerGrants ?? cat?.ownerGrants ?? []) as PermissionKey[],
      envSpec: registered?.envSpec ?? cat?.envSpec ?? [],
    };
  }
  // Connected mode: a pushed vertical registers on the SHARED plane, not this deployment's
  // own registry — read its install spec from there (visibility-filtered to published + the
  // caller's own, so a private slug from another tenant stays unknown here).
  const remote = cp ? (await cp.listCatalog()).find((v) => v.slug === slug) : undefined;
  if (!remote) throw new HTTPException(400, { message: `unknown vertical '${slug}'` });
  return {
    entitlements: installEntitlements(slug, remote.entitlements),
    ownerGrants: (remote.ownerGrants ?? []) as PermissionKey[],
    envSpec: (remote.envSpec as EnvVarSpec[] | undefined) ?? [],
  };
}

app.get('/api/catalog', async (c) => {
  const host = hostFor(c.env);
  // Registry-driven (marketplace-publish.md §3): show published verticals + the caller's own.
  const node = await resolveAccount(host, c.env, getCookie(c, SESSION_COOKIE), getCookie(c, TEAM_COOKIE));
  await ensureCatalog(host, STAFF);
  const rows = availableCatalog(await host.admin.listVerticals(STAFF), { tenantId: node?.tenantId ?? null });
  // Connected mode: pushed verticals live in the SHARED plane's registry, not this
  // deployment's own — merge the caller's own + published ones in. Local wins on a shared
  // slug: the builtin seed here is refreshed each boot, the plane's copy may lag.
  const cp = node ? controlPlaneFor(c.env, node.tenantId) : null;
  if (cp) {
    for (const v of await cp.listCatalog()) {
      if (!rows.some((r) => r.slug === v.slug)) {
        rows.push({
          slug: v.slug,
          name: v.name,
          owned: v.owned,
          listed: v.listed,
          source: v.source,
          ...(v.envSpec?.length ? { envSpec: v.envSpec as EnvVarSpec[] } : {}),
          ...(v.provides?.length ? { provides: v.provides } : {}),
          ...(v.requires?.length ? { requires: v.requires } : {}),
        });
      }
    }
  }
  // Installability: a builtin is bundled (embedded) or statically bound/promoted on the
  // plane; a pushed vertical is installable only once a version is PROMOTED TO PROD —
  // offering it earlier would sell an install that fails at provision time. The UI shows
  // a not-yet-promoted owned vertical disabled, pointing at the Verticals page.
  const catalog = await Promise.all(
    rows.map(async (v) => ({
      ...v,
      installable:
        v.source === 'builtin' ||
        (cp ? await cp.listChannels(v.slug) : await host.admin.listChannels(STAFF, v.slug)).some((ch) => ch.channel === 'prod'),
    })),
  );
  return c.json(catalog);
});

/**
 * Who am I — three states: no session ⇒ 401; a session with no team yet ⇒
 * `{ needsOnboarding }` (the app shows "name your first team"); otherwise my
 * current team, my teams, and my dashboard node. Resolving is READ-ONLY — a
 * teamless login is NOT silently bootstrapped; it must create a team explicitly.
 */
app.get('/api/me', async (c) => {
  const host = hostFor(c.env);
  const user = await verifySession(c.env, getCookie(c, SESSION_COOKIE));
  if (!user) return c.json({ error: 'unauthorized' }, 401);
  await host.admin.registerIdentityPool(STAFF, { provider: PROVIDER, topology: 'central', tenantId: null });
  const tenants = await host.admin.listIdentityTenants(STAFF, PROVIDER, user.id);
  if (tenants.length === 0) {
    return c.json({ needsOnboarding: true, email: user.email ?? null, name: user.name ?? null });
  }
  const node = await resolveNode(host, tenants, user.id, getCookie(c, TEAM_COOKIE));
  if (!node) return c.json({ error: 'unauthorized' }, 401);
  // Re-mirror this login's links into the shared plane's directory off the hot
  // path — the backfill for teams created before the mirror existed, and the
  // self-heal when a best-effort mirror was missed (see mirrorBuilderIdentity).
  c.executionCtx.waitUntil(Promise.all(tenants.map((t) => mirrorBuilderIdentity(c.env, host, user.id, t))));
  // The dashboard scope carries no display identity — the shell shows the signed-in
  // email/name, which live on the OIDC session, so surface them alongside the teams.
  return c.json({
    principal: node.principal,
    tenant: node.tenantId,
    dashboardScope: node.scopeId,
    email: user.email ?? null,
    name: user.name ?? null,
    teams: await listTeams(host, tenants),
    currentTeamId: node.tenantId,
  });
});

/**
 * Create a team — the signup-onboarding move AND the in-app "New team" action share
 * this one endpoint. The new team is provisioned with the caller as owner and their
 * identity linked, then the `sb_team` cookie is pointed at it so the portal opens on
 * the new team after the client reloads.
 */
const createTeamBody = z.object({ name: z.string().trim().min(1).max(100) });
app.post('/api/teams', async (c) => {
  const user = await verifySession(c.env, getCookie(c, SESSION_COOKIE));
  if (!user) throw new HTTPException(401, { message: 'unauthorized' });
  const { name } = createTeamBody.parse(await c.req.json());
  const host = hostFor(c.env);
  const node = await createTeam(host, c.env, user, name);
  setCookie(c, TEAM_COOKIE, node.tenantId, teamCookieOpts(new URL(c.req.url).protocol));
  return c.json({ teamId: node.tenantId }, 201);
});

/**
 * Switch the current team — validates the caller is a member, then pins the choice
 * in the `sb_team` cookie. The whole portal (apps, domains, billing) re-scopes to
 * the selected tenant on the next load, because every handler resolves the node
 * from this cookie. Naming a team you are not in is refused, not silently ignored.
 */
const switchTeamBody = z.object({ teamId: z.string().min(1) });
app.post('/api/teams/switch', async (c) => {
  const token = getCookie(c, SESSION_COOKIE);
  const user = await verifySession(c.env, token);
  if (!user) throw new HTTPException(401, { message: 'unauthorized' });
  const { teamId } = switchTeamBody.parse(await c.req.json());
  const host = hostFor(c.env);
  await host.admin.registerIdentityPool(STAFF, { provider: PROVIDER, topology: 'central', tenantId: null });
  const tenants = await host.admin.listIdentityTenants(STAFF, PROVIDER, user.id);
  if (!tenants.some((t) => t === teamId)) {
    throw new HTTPException(403, { message: 'not a member of that team' });
  }
  setCookie(c, TEAM_COOKIE, teamId, teamCookieOpts(new URL(c.req.url).protocol));
  return c.body(null, 204);
});

/**
 * Leave a team — the caller detaches themselves: mark their roster row revoked, then
 * sever their identity link so the team leaves their switcher and they can no longer
 * resolve into it. The selected-team cookie is cleared so the next load re-resolves
 * (another team, or onboarding if this was their last). Self-service; no role needed
 * beyond membership. Leaving the team you have selected — no team id argument.
 */
app.post('/api/teams/leave', async (c) => {
  const host = hostFor(c.env);
  const node = await resolveAccount(host, c.env, getCookie(c, SESSION_COOKIE), getCookie(c, TEAM_COOKIE));
  if (!node) throw new HTTPException(401, { message: 'unauthorized' });
  const scope = await host.getScope(node.principal, node.tenantId, node.scopeId);
  await scope.invoke('dashboard/leave-self', {});
  await host.admin.unlinkIdentity(STAFF, node.tenantId, node.principal);
  // Sever the shared plane's mirrored link too (best-effort — see mirrorBuilderIdentity).
  await controlPlaneFor(c.env, node.tenantId)?.unlinkIdentity(node.principal).catch(() => {});
  deleteCookie(c, TEAM_COOKIE, { path: '/' });
  return c.body(null, 204);
});

/**
 * Delete the organization — the Settings danger zone. OWNER-ONLY (the in-scope op
 * checks the roster) and confirmed by retyping the organization name, re-verified
 * here so the UI gate is never the only gate. Tombstone-shaped end to end: every
 * app is deprovisioned (scope archived, hostname off), the roster revoked, the
 * tenant flipped to `deleting` (never hard-deleted — the audit trail stays), and
 * every member's identity link severed so the team drops out of all switchers.
 */
app.post('/api/teams/delete', async (c) => {
  const host = hostFor(c.env);
  const node = await resolveAccount(host, c.env, getCookie(c, SESSION_COOKIE), getCookie(c, TEAM_COOKIE));
  if (!node) throw new HTTPException(401, { message: 'unauthorized' });
  const body = z.object({ confirm: z.string() }).parse(await c.req.json().catch(() => ({})));
  const team = await host.admin.getTenant(STAFF, node.tenantId);
  if (!team || body.confirm.trim().toLowerCase() !== team.name.trim().toLowerCase()) {
    throw new HTTPException(400, { message: 'type the organization name to confirm deletion' });
  }
  const dash = await host.getScope(node.principal, node.tenantId, node.scopeId);
  // Owner check + roster revocation, in-scope, BEFORE any platform effect.
  const { members } = (await dash.invoke('dashboard/delete-team', {})) as {
    members: Array<{ principal: string; roleKey: string }>;
  };
  // Deprovision every app — the same per-app path as deleting one by hand, so
  // shared-plane scopes archive and hostnames stop resolving. Best-effort per app:
  // one stuck app must not leave the rest running.
  const apps = (await dash.invoke('dashboard/list-apps', {})) as DashboardAppRow[];
  const cp = controlPlaneFor(c.env, node.tenantId) ?? undefined;
  for (const a of apps) {
    try {
      await deprovisionApp(host, {
        node,
        appScopeId: scopeId.parse(a.app_scope_id),
        hostname: a.hostname,
        controlPlane: cp,
      });
    } catch {
      // recorded on the app's own trail; the org delete proceeds
    }
  }
  await host.admin.setTenantStatus(STAFF, node.tenantId, 'deleting');
  for (const m of members) {
    try {
      await host.admin.unlinkIdentity(STAFF, node.tenantId, principalId.parse(m.principal));
      // The shared plane's mirrored link goes with it (best-effort).
      if (cp) await cp.unlinkIdentity(principalId.parse(m.principal));
    } catch {
      // an already-unlinked member (e.g. left earlier) is fine
    }
  }
  deleteCookie(c, TEAM_COOKIE, { path: '/' });
  return c.body(null, 204);
});

/**
 * Every GET list below shares the platform-wide pagination convention (contracts
 * pagination.ts): `?limit&cursor` in (default 20), `{ entries, nextCursor }` out,
 * keyset on the list's own sort key. The module ops stay unbounded when unpaged.
 */
const pageParams = (c: { req: { query(key: string): string | undefined } }) =>
  listPageQuery.parse({ limit: c.req.query('limit'), cursor: c.req.query('cursor') });

/**
 * The current team's roster — active members + outstanding invites, one page newest-
 * first (`{ entries, nextCursor }`, keyset on the roster row id). Org-bounded small,
 * but the envelope is the ONE list-read shape (contracts pagination.ts).
 */
app.get('/api/members', async (c) => {
  const host = hostFor(c.env);
  const node = await resolveAccount(host, c.env, getCookie(c, SESSION_COOKIE), getCookie(c, TEAM_COOKIE));
  if (!node) throw new HTTPException(401, { message: 'unauthorized' });
  const page = pageParams(c);
  const scope = await host.getScope(node.principal, node.tenantId, node.scopeId);
  const members = (await scope.invoke('dashboard/list-members', {
    limit: page.limit,
    cursor: page.cursor,
  })) as Array<{ id: string }>;
  return c.json(pageOf(members, page.limit, (m) => m.id));
});

/**
 * Invite a member to the current team at a role. The in-scope op enforces the §5.1
 * bound (invite only at a role you already hold) and composes the invites engine,
 * then we email the invitee an accept link.
 *
 * The email is sent HERE, host-side, because this is the only place the raw address
 * exists: the invites engine hashes the identifier and the `invites.sent` event
 * carries only the hash (piiClass 'none'), so no outbox executor could recover an
 * address to send to. Delivery is best-effort — the invitation is already committed,
 * so a send failure is reported (`emailDelivered: false`) rather than rolling back a
 * recorded invite; the returned `acceptUrl` lets the inviter share the link manually
 * and is what a resend would use.
 */
/**
 * Mint a fresh accept link for an invitation and mail it to the invitee. Shared by
 * the initial invite and the resend button: both send the SAME message with the raw
 * address (only ever in hand host-side) and a freshly-signed 14-day token. Delivery is
 * best-effort — the invitation is already committed, so a send failure is reported
 * (`emailDelivered: false`), never thrown, and the returned `acceptUrl` is always a
 * shareable fallback. Cloudflare Email Service is asynchronous, so a successful send
 * lands the recipient in `queued` (accepted, in flight), not `delivered` — count either.
 */
async function mailInvite(
  env: Env,
  host: ScopeHost,
  origin: string,
  node: DashboardNode,
  inviterName: string | null | undefined,
  to: string,
  invitationId: string,
): Promise<{ acceptUrl: string; emailDelivered: boolean }> {
  const token = await signInviteToken(env, {
    tenantId: node.tenantId,
    scopeId: node.scopeId,
    invitationId,
  });
  const acceptUrl = `${origin}/invite/${token}`;
  const team = await host.admin.getTenant(STAFF, node.tenantId);
  let emailDelivered = false;
  try {
    const result = await transportFor(env).send(
      teamInviteEmail({
        to,
        from: senderFor(env),
        teamName: team?.name ?? 'your team',
        inviterName,
        acceptUrl,
      }),
    );
    emailDelivered = result.delivered.length + result.queued.length > 0;
  } catch (err) {
    console.error('invite email send failed:', err instanceof Error ? err.message : err);
  }
  return { acceptUrl, emailDelivered };
}

const inviteMemberBody = z.object({
  email: z.string().trim().min(1),
  roleKey: z.enum(['admin', 'member', 'viewer']),
});
app.post('/api/members/invite', async (c) => {
  const host = hostFor(c.env);
  const user = await verifySession(c.env, getCookie(c, SESSION_COOKIE));
  if (!user) throw new HTTPException(401, { message: 'unauthorized' });
  const node = await resolveAccount(host, c.env, getCookie(c, SESSION_COOKIE), getCookie(c, TEAM_COOKIE));
  if (!node) throw new HTTPException(401, { message: 'unauthorized' });
  const body = inviteMemberBody.parse(await c.req.json());
  const scope = await host.getScope(node.principal, node.tenantId, node.scopeId);
  const { invitationId } = (await scope.invoke('dashboard/invite-member', body)) as { invitationId: string };
  const { acceptUrl, emailDelivered } = await mailInvite(
    c.env,
    host,
    new URL(c.req.url).origin,
    node,
    user.name,
    body.email,
    invitationId,
  );
  return c.json({ invitationId, acceptUrl, emailDelivered }, 201);
});

/**
 * Re-send a pending invite's email — the resend button. Re-mints the accept link and
 * mails it again to the address kept in the readable roster (the invites engine stores
 * only a hash). The in-scope op re-checks manage-members + the §5.1 role bound and
 * refreshes a lapsed invitation; a 404 means there is no such pending invite to resend.
 */
app.post('/api/members/resend-invite', async (c) => {
  const host = hostFor(c.env);
  const user = await verifySession(c.env, getCookie(c, SESSION_COOKIE));
  if (!user) throw new HTTPException(401, { message: 'unauthorized' });
  const node = await resolveAccount(host, c.env, getCookie(c, SESSION_COOKIE), getCookie(c, TEAM_COOKIE));
  if (!node) throw new HTTPException(401, { message: 'unauthorized' });
  const { invitationId } = z.object({ invitationId: z.string().min(1) }).parse(await c.req.json());
  const scope = await host.getScope(node.principal, node.tenantId, node.scopeId);
  const resent = (await scope.invoke('dashboard/resend-invite', { invitationId })) as
    | { invitationId: string; email: string; roleKey: string }
    | null;
  if (!resent) throw new HTTPException(404, { message: 'no such pending invite' });
  const { acceptUrl, emailDelivered } = await mailInvite(
    c.env,
    host,
    new URL(c.req.url).origin,
    node,
    user.name,
    resent.email,
    resent.invitationId,
  );
  return c.json({ invitationId: resent.invitationId, acceptUrl, emailDelivered });
});

/** Withdraw a pending invite from the current team. */
app.post('/api/members/revoke-invite', async (c) => {
  const host = hostFor(c.env);
  const node = await resolveAccount(host, c.env, getCookie(c, SESSION_COOKIE), getCookie(c, TEAM_COOKIE));
  if (!node) throw new HTTPException(401, { message: 'unauthorized' });
  const { invitationId } = z.object({ invitationId: z.string().min(1) }).parse(await c.req.json());
  const scope = await host.getScope(node.principal, node.tenantId, node.scopeId);
  await scope.invoke('dashboard/revoke-invite', { invitationId });
  return c.body(null, 204);
});

/**
 * Remove an active member: mark the roster row revoked AND revoke their kernel role
 * (`unassignRole`) so access is actually cut — the projection alone would not. The
 * op authorizes (manage-members) and returns the principal + role to unassign; the
 * owner cannot be removed. Their identity link is left, so the team still appears in
 * their own switcher but resolves to no permissions (fully hiding it needs a kernel
 * `unlinkIdentity` — a follow-up).
 */
app.post('/api/members/remove', async (c) => {
  const host = hostFor(c.env);
  const node = await resolveAccount(host, c.env, getCookie(c, SESSION_COOKIE), getCookie(c, TEAM_COOKIE));
  if (!node) throw new HTTPException(401, { message: 'unauthorized' });
  const { memberId } = z.object({ memberId: z.string().min(1) }).parse(await c.req.json());
  const scope = await host.getScope(node.principal, node.tenantId, node.scopeId);
  const removed = (await scope.invoke('dashboard/remove-member', { memberId })) as { principal: string; roleKey: string } | null;
  if (removed) {
    const principal = principalId.parse(removed.principal);
    // Cut access (revoke the role) AND sever their login from the team, so it also
    // disappears from their own switcher rather than lingering as a dead entry.
    await host.admin.unassignRole(DASHBOARD_CP_ACTOR, {
      principalId: principal,
      roleKey: removed.roleKey,
      node: { tenantId: node.tenantId, scopeId: null },
    });
    await host.admin.unlinkIdentity(STAFF, node.tenantId, principal);
    // And the shared plane's mirrored link, so their CLI push loses the
    // workspace too (best-effort — see mirrorBuilderIdentity).
    await controlPlaneFor(c.env, node.tenantId)?.unlinkIdentity(principal).catch(() => {});
  }
  return c.body(null, 204);
});

/**
 * Preview an invite for the accept screen + login prefill. UNAUTHENTICATED on purpose:
 * the signed token is the authority (the link was mailed to the invitee), and this
 * reveals only that invite's own team name + address — access itself still requires the
 * verified-email hash at accept-time. Used before sign-in to prefill `login_hint`, so a
 * first-time invitee signs up with the right email and lands in the team, not onboarding.
 */
app.get('/api/invites/preview', async (c) => {
  const token = c.req.query('token');
  if (!token) throw new HTTPException(400, { message: 'missing token' });
  const claim = await verifyInviteToken(c.env, token);
  if (!claim) throw new HTTPException(404, { message: 'this invite link is invalid or has expired' });
  const t = tenantId.parse(claim.tenantId);
  const s = scopeId.parse(claim.scopeId);
  const host = hostFor(c.env);
  // Mint an ephemeral principal to reach the scope — the op does no permission check
  // (same pattern as accept-invite), so no role is needed to read the invite's own data.
  const scope = await host.getScope(principalId.parse(ulid()), t, s);
  const preview = (await scope.invoke('dashboard/preview-invite', { invitationId: claim.invitationId })) as
    | { email: string; roleKey: string }
    | null;
  if (!preview) throw new HTTPException(404, { message: 'this invite link is invalid or has expired' });
  const team = await host.admin.getTenant(STAFF, t);
  return c.json({ teamName: team?.name ?? 'a team', email: preview.email, roleKey: preview.roleKey });
});

/**
 * Accept an invitation. The recipient is logged in (verified email), presents the
 * signed token. We mint their principal, accept in-scope (the engine re-hashes their
 * email — the real gate), then effect access: assign the invited role at the tenant
 * node and link their identity so future logins resolve into this team. Idempotent:
 * an already-member just switches; a re-used/settled invitation fails at the engine.
 */
app.post('/api/invites/accept', async (c) => {
  const user = await verifySession(c.env, getCookie(c, SESSION_COOKIE));
  if (!user) throw new HTTPException(401, { message: 'unauthorized' });
  const { token } = z.object({ token: z.string().min(1) }).parse(await c.req.json());
  const claim = await verifyInviteToken(c.env, token);
  if (!claim) throw new HTTPException(400, { message: 'this invite link is invalid or has expired' });
  const t = tenantId.parse(claim.tenantId);
  const s = scopeId.parse(claim.scopeId);

  const host = hostFor(c.env);
  await host.admin.registerIdentityPool(STAFF, { provider: PROVIDER, topology: 'central', tenantId: null });
  // Already in this team? Nothing to accept — just switch to it (idempotent link click).
  if (await host.admin.resolveIdentity(t, PROVIDER, user.id)) {
    setCookie(c, TEAM_COOKIE, t, teamCookieOpts(new URL(c.req.url).protocol));
    return c.json({ teamId: t, already: true });
  }

  const principal = principalId.parse(ulid());
  const scope = await host.getScope(principal, t, s);
  // The engine verifies the hash of the recipient's VERIFIED email; a mismatch throws.
  const { roleKey } = (await scope.invoke('dashboard/accept-invite', {
    invitationId: claim.invitationId,
    identifier: user.email ?? '',
  })) as { roleKey: string };

  // Effect access: the role at the tenant node (§5.1 was enforced when it was sent),
  // and the identity link so future logins land in this team.
  await host.admin.assignRole(DASHBOARD_CP_ACTOR, {
    principalId: principal,
    roleKey,
    node: { tenantId: t, scopeId: null },
  });
  await host.admin.linkIdentity(STAFF, {
    provider: PROVIDER,
    externalId: user.id,
    principal,
    tenantId: t,
    scopeId: s,
  });
  // Mirror the new member into the shared plane's directory so they can
  // `substrat push` for this workspace too (see mirrorBuilderIdentity).
  await mirrorBuilderIdentity(c.env, host, user.id, t);
  setCookie(c, TEAM_COOKIE, t, teamCookieOpts(new URL(c.req.url).protocol));
  return c.json({ teamId: t });
});

/** My apps — one page, newest first (`{ entries, nextCursor }`, keyset on the row id). */
app.get('/api/apps', async (c) => {
  const host = hostFor(c.env);
  const node = await resolveAccount(host, c.env, getCookie(c, SESSION_COOKIE), getCookie(c, TEAM_COOKIE));
  if (!node) throw new HTTPException(401, { message: 'unauthorized' });
  const page = pageParams(c);
  const dash = await host.getScope(node.principal, node.tenantId, node.scopeId);
  const apps = (await dash.invoke('dashboard/list-apps', { limit: page.limit, cursor: page.cursor })) as DashboardAppRow[];
  // Self-heal the URL from the live directory: the hostname column is a snapshot
  // taken at install time, and an install whose bind was recorded late (or repaired
  // platform-side) leaves it null forever while the router happily serves the app.
  // The directory is the source of truth for hostnames — join it for the gaps.
  const cp = controlPlaneFor(c.env, node.tenantId);
  if (cp) {
    for (const a of apps) {
      const sid = scopeId.parse(a.app_scope_id);
      // One directory read serves both heals below; null = "unknown, change nothing".
      const dir = await cp.scopeStatus(sid);
      // Reconcile a stale 'provisioning' row against the DIRECTORY — the source of
      // truth (#424 case 4): a healed retry can complete the whole platform sequence
      // without ever updating the dashboard's own record, which then spins forever.
      // Old enough to not be a LIVE install (whose row flips via mark-app-active in
      // seconds); directory 'active' ⇒ project it onto our row, hostname included.
      // Best-effort: a viewer session lacks the mark-active permission — the invoke
      // just fails and the row heals on an owner's next visit instead.
      if (
        dir?.status === 'active' &&
        a.status === 'provisioning' &&
        Date.parse(a.created_at) < Date.now() - RECONCILE_AFTER_MS
      ) {
        const live = (await cp.listHostnames(sid).catch(() => [])).find((h) => h.status === 'active');
        const healed = (await dash
          .invoke('dashboard/mark-app-active', {
            appScopeId: a.app_scope_id,
            ...(live ? { hostname: live.hostname } : {}),
          })
          .catch(() => null)) as DashboardAppRow | null;
        if (healed) {
          a.status = healed.status;
          a.hostname = healed.hostname;
        }
      }
      // Reconcile the row's LINEAGE against the directory (#389): a staff
      // rebind-vertical moves the scope onto a different lineage (builtin
      // 'manyfold' → tenant-owned 'acme/manyfold') and only the directory knows —
      // the stale slug here misroutes the Update path (prod channels resolve by
      // `vertical_slug`) and the version display. Best-effort like mark-app-active
      // above: a viewer session lacks the permission and heals on an owner's visit.
      if (dir?.vertical && a.vertical_slug && dir.vertical !== a.vertical_slug) {
        const healed = (await dash
          .invoke('dashboard/reconcile-app-vertical', {
            appScopeId: a.app_scope_id,
            verticalSlug: dir.vertical,
          })
          .catch(() => null)) as DashboardAppRow | null;
        if (healed) a.vertical_slug = healed.vertical_slug;
      }
      if (a.hostname || a.status !== 'active') continue;
      const live = (await cp.listHostnames(scopeId.parse(a.app_scope_id)).catch(() => []))
        .find((h) => h.status === 'active');
      if (live) a.hostname = live.hostname;
    }
  }
  return c.json(pageOf(apps, page.limit, (a) => a.id));
});

/**
 * A 'provisioning' row older than this is reconciled against the directory on read.
 * Long enough that a LIVE install (seconds end-to-end) is never touched mid-flight;
 * short enough that a stranded row heals on the next page load rather than spinning.
 */
const RECONCILE_AFTER_MS = 2 * 60 * 1000;

/**
 * The install's durable step record (#424): the sequence
 * directory → provision → activate → hostname → identity, each with
 * status/attempts/last_error — rendered live by the Apps view while an install runs,
 * and the diagnosis (the failed step + the downstream error VERBATIM) once one fails.
 * Read from the caller's OWN dashboard scope, so tenant-scoped like the events trail.
 */
app.get('/api/apps/:scopeId/steps', async (c) => {
  const host = hostFor(c.env);
  const node = await resolveAccount(host, c.env, getCookie(c, SESSION_COOKIE), getCookie(c, TEAM_COOKIE));
  if (!node) throw new HTTPException(401, { message: 'unauthorized' });
  const dash = await host.getScope(node.principal, node.tenantId, node.scopeId);
  return c.json(await dash.invoke('dashboard/install-steps', { appScopeId: c.req.param('scopeId') }));
});

/**
 * The account-level Domains view (#305, §4.7). A "domain" here is a CUSTOM hostname —
 * the platform `*.substrat.run` default each app already rides is managed automatically
 * and not listed (it is exactly each app's `hostname`, so it is subtracted out). Each row
 * carries the app it fronts, its issuance status, and — while `pending`/`verifying`/
 * `failed` — the DNS records the tenant must publish. Empty when the control plane is not
 * connected (dev), like the rest of the CONNECTED-mode surface.
 */
app.get('/api/domains', async (c) => {
  const host = hostFor(c.env);
  const node = await resolveAccount(host, c.env, getCookie(c, SESSION_COOKIE), getCookie(c, TEAM_COOKIE));
  if (!node) throw new HTTPException(401, { message: 'unauthorized' });
  const page = pageParams(c);
  const cp = controlPlaneFor(c.env, node.tenantId);
  if (!cp) return c.json({ entries: [], nextCursor: null });
  const dash = await host.getScope(node.principal, node.tenantId, node.scopeId);
  // Unpaged: names + default hostnames must cover EVERY app, whatever page of domains this is.
  const apps = (await dash.invoke('dashboard/list-apps', {})) as DashboardAppRow[];
  const appName = new Map(apps.map((a) => [a.app_scope_id, a.name]));
  // Each app's auto-managed default hostname — subtracted so the list shows only the
  // custom domains a tenant added on top (the platform mint is not a "domain" to manage).
  const defaults = new Set(apps.map((a) => a.hostname).filter(Boolean) as string[]);
  // Walk the CP's hostname pages (keyset on the hostname — the cursor passes straight
  // through) until this page of CUSTOM domains is full: the defaults filter can shrink
  // a CP page below the limit, so one CP page is not necessarily one page here.
  const domains: Array<Record<string, unknown> & { hostname: string }> = [];
  let cursor = page.cursor;
  for (;;) {
    const res = await cp
      .listTenantHostnamesPage({ limit: LIST_PAGE_MAX, cursor })
      .catch(() => ({ entries: [], nextCursor: null as string | null }));
    for (const h of res.entries) {
      if (defaults.has(h.hostname)) continue;
      domains.push({
        hostname: h.hostname,
        appScopeId: h.scopeId,
        app: appName.get(h.scopeId) ?? h.scopeId,
        surface: h.surface,
        status: h.status,
        statusNote: h.statusNote ?? null,
        primary: h.canonical,
        createdAt: h.createdAt,
        validationRecords: h.validationRecords ?? [],
      });
      if (domains.length >= page.limit) break;
    }
    if (domains.length >= page.limit || res.nextCursor === null) break;
    cursor = res.nextCursor;
  }
  return c.json(pageOf(domains, page.limit, (d) => d.hostname));
});

const bindDomainBody = z.object({
  hostname: z.string().trim().min(1).max(253),
  appScopeId: z.string().min(1),
  surface: z.string().trim().min(1).default('app'),
});

/**
 * Add a custom domain to one of the tenant's apps (§4.7). The app must be the caller's
 * own — verified against list-apps — and the bind kicks off Cloudflare-for-SaaS issuance
 * in the control plane; the row comes back `verifying` with the DNS records to publish.
 * Bound as a non-canonical alias so the app's working default is never demoted out from
 * under it — the domain serves the moment it validates, alongside the default.
 */
app.post('/api/domains', async (c) => {
  const host = hostFor(c.env);
  const node = await resolveAccount(host, c.env, getCookie(c, SESSION_COOKIE), getCookie(c, TEAM_COOKIE));
  if (!node) throw new HTTPException(401, { message: 'unauthorized' });
  const cp = controlPlaneFor(c.env, node.tenantId);
  if (!cp) throw new HTTPException(501, { message: 'control plane not connected' });
  const body = bindDomainBody.parse(await c.req.json());
  const dash = await host.getScope(node.principal, node.tenantId, node.scopeId);
  const apps = (await dash.invoke('dashboard/list-apps', {})) as DashboardAppRow[];
  if (!apps.some((a) => a.app_scope_id === body.appScopeId)) {
    throw new HTTPException(404, { message: 'app not found' });
  }
  const row = await cp.bindHostname({
    hostname: body.hostname.toLowerCase(),
    scopeId: scopeId.parse(body.appScopeId),
    surface: body.surface,
    canonical: false,
  });
  return c.json(row, 201);
});

/** Re-poll a custom domain's issuance ("check again"). Tenant-narrowed by the CP. */
app.post('/api/domains/:hostname/verify', async (c) => {
  const host = hostFor(c.env);
  const node = await resolveAccount(host, c.env, getCookie(c, SESSION_COOKIE), getCookie(c, TEAM_COOKIE));
  if (!node) throw new HTTPException(401, { message: 'unauthorized' });
  const cp = controlPlaneFor(c.env, node.tenantId);
  if (!cp) throw new HTTPException(501, { message: 'control plane not connected' });
  return c.json(await cp.verifyHostname(c.req.param('hostname')));
});

/** Remove a custom domain — releases the CF custom hostname and drops the binding. */
app.delete('/api/domains/:hostname', async (c) => {
  const host = hostFor(c.env);
  const node = await resolveAccount(host, c.env, getCookie(c, SESSION_COOKIE), getCookie(c, TEAM_COOKIE));
  if (!node) throw new HTTPException(401, { message: 'unauthorized' });
  const cp = controlPlaneFor(c.env, node.tenantId);
  if (!cp) throw new HTTPException(501, { message: 'control plane not connected' });
  const name = c.req.param('hostname').toLowerCase();
  const own = await cp.listTenantHostnames().catch(() => []);
  const match = own.find((h) => h.hostname === name);
  if (!match) throw new HTTPException(404, { message: 'domain not found' });
  await cp.unbindHostname(scopeId.parse(match.scopeId), name);
  return c.json({ deleted: name });
});

/**
 * One app's audit trail (Activity panel) — created / active / failed(+reason) / deleted,
 * one page newest-first (`{ entries, nextCursor }`, keyset on the event id). Read from
 * the caller's OWN dashboard scope, so the events are naturally tenant-scoped:
 * another tenant's app-scope-id has no events here.
 */
app.get('/api/apps/:scopeId/events', async (c) => {
  const host = hostFor(c.env);
  const node = await resolveAccount(host, c.env, getCookie(c, SESSION_COOKIE), getCookie(c, TEAM_COOKIE));
  if (!node) throw new HTTPException(401, { message: 'unauthorized' });
  const page = pageParams(c);
  const dash = await host.getScope(node.principal, node.tenantId, node.scopeId);
  const events = (await dash.invoke('dashboard/app-events', {
    appScopeId: c.req.param('scopeId'),
    limit: page.limit,
    cursor: page.cursor,
  })) as Array<{ id: string }>;
  return c.json(pageOf(events, page.limit, (e) => e.id));
});

/**
 * One app's Deployments tab — its vertical's REAL version registry + which version each
 * channel points at (the `prod` one is what the app runs). Read-only: for a platform
 * vertical the versions are managed by the Substrat team; this just surfaces the truth
 * (so "am I on 0.0.9?" is answerable). The app must be the caller's own.
 */
app.get('/api/apps/:scopeId/deployments', async (c) => {
  const host = hostFor(c.env);
  const node = await resolveAccount(host, c.env, getCookie(c, SESSION_COOKIE), getCookie(c, TEAM_COOKIE));
  if (!node) throw new HTTPException(401, { message: 'unauthorized' });
  // The versions list pages (`?limit&cursor`, default 20, newest first — the order the
  // tab always rendered); channels stay complete (~3). `nextCursor` walks older versions.
  const page = pageParams(c);
  const dash = await host.getScope(node.principal, node.tenantId, node.scopeId);
  const apps = (await dash.invoke('dashboard/list-apps', {})) as DashboardAppRow[];
  const appRow = apps.find((a) => a.app_scope_id === c.req.param('scopeId'));
  if (!appRow) throw new HTTPException(404, { message: 'app not found' });
  const cp = controlPlaneFor(c.env, node.tenantId);
  const scope = scopeId.parse(appRow.app_scope_id);
  // The vertical's version registry AND the version THIS scope is actually pinned to
  // (the router dispatches on the latter). They differ when prod moved after install —
  // which is exactly the "the tab says 0.0.12 but I run 0.0.9" confusion this answers.
  // `mine` decides `owned`: whether the app's vertical is one this tenant pushed, which
  // is what makes prod promotion self-serve (while private) instead of a staff action —
  // the UI words the tab differently for each.
  const [deployment, boundVersionId, mine] = cp
    ? await Promise.all([verticalDeploymentPageFromCp(cp, appRow.vertical_slug, page), cp.boundVersionId(scope), cp.listVerticals()])
    : await Promise.all([
        verticalDeploymentPageFromHost(host, STAFF, appRow.vertical_slug, page),
        host.admin.getScopeRecord(STAFF, node.tenantId, scope).then((r) => r?.verticalVersionId ?? null),
        host.admin.listVerticals(STAFF).then((vs) => vs.filter((v) => v.ownerTenant === node.tenantId)),
      ]);
  const ownRecord = mine.find((v) => v.slug === appRow.vertical_slug);
  return c.json({
    ...deployment,
    owned: !!ownRecord,
    listed: ownRecord ? !!ownRecord.listed : deployment.listed,
    boundVersionId,
  });
});

/**
 * One app's Permissions tab (#336, D-39): the declared permission surface — keys,
 * roles, entity-grant shapes — of the version this app actually RUNS, plus the version
 * an available update would move it to, so the tab can diff the two before that update.
 * This is the tenant-facing rendering of the permission-diff human checkpoint; it only
 * READS the registry — approving a widened role stays a human decision on Verticals.
 *
 * Authorized in the caller's OWN dashboard scope like every app-scoped read: the app is
 * resolved from the tenant-scoped `list-apps`, so a foreign scope id 404s. Connected mode
 * reads the registry through the tenant-narrowed control plane; embedded mode reads the
 * host's retained manifest with the platform STAFF actor.
 */
app.get('/api/apps/:scopeId/permissions', async (c) => {
  const host = hostFor(c.env);
  const node = await resolveAccount(host, c.env, getCookie(c, SESSION_COOKIE), getCookie(c, TEAM_COOKIE));
  if (!node) throw new HTTPException(401, { message: 'unauthorized' });
  const dash = await host.getScope(node.principal, node.tenantId, node.scopeId);
  const apps = (await dash.invoke('dashboard/list-apps', {})) as DashboardAppRow[];
  const appRow = apps.find((a) => a.app_scope_id === c.req.param('scopeId'));
  if (!appRow) throw new HTTPException(404, { message: 'app not found' });
  const cp = controlPlaneFor(c.env, node.tenantId);
  const scope = scopeId.parse(appRow.app_scope_id);
  const slug = appRow.vertical_slug;
  // Same two reads the Deployments tab makes: the vertical's version registry + the version
  // THIS scope is pinned to. "Running" is the router's truth (the bound version); an update
  // diff compares against the prod channel head, not merely the newest push.
  const [deployment, boundVersionId] = cp
    ? await Promise.all([verticalDeploymentFromCp(cp, slug), cp.boundVersionId(scope)])
    : await Promise.all([
        verticalDeploymentFromHost(host, STAFF, slug),
        host.admin.getScopeRecord(STAFF, node.tenantId, scope).then((r) => r?.verticalVersionId ?? null),
      ]);
  const prod = deployment.channels.find((ch) => ch.channel === 'prod');
  // Fall back to the prod head only when the scope is unpinned (static binding) — mirrors
  // the Deployments tab's `running` derivation exactly.
  const runningId = boundVersionId ?? prod?.versionId ?? null;
  const runningVersion = runningId ? deployment.versions.find((v) => v.id === runningId) : undefined;
  // An update is offered iff prod points somewhere other than where this scope is pinned.
  const updateId = prod && prod.versionId !== boundVersionId ? prod.versionId : null;
  const updateVersion = updateId ? deployment.versions.find((v) => v.id === updateId) : undefined;

  const registryOf = (versionId: string | null): Promise<PermissionRegistry | null> => {
    if (!versionId) return Promise.resolve(null);
    return cp ? cp.versionRegistry(slug, versionId) : versionRegistryFromHost(host, STAFF, slug, versionId);
  };
  const [runningRegistry, updateRegistry] = await Promise.all([registryOf(runningId), registryOf(updateId)]);

  return c.json({
    running: { versionId: runningId, version: runningVersion?.version ?? null, registry: runningRegistry },
    update: updateId
      ? { versionId: updateId, version: updateVersion?.version ?? null, registry: updateRegistry }
      : null,
  });
});

/**
 * The scopes an app spans — the Data tab's scope switcher (M4 of multi-scope-manyfold.md).
 * A multi-scope vertical (Manyfold: one site per scope) has several; the Data tab browses one
 * at a time and this lets the user pick which. Same authorization as the table reads: the app
 * is resolved from the tenant-scoped `list-apps` (a foreign scope id 404s), and the list is
 * tenant-narrowed to the app's vertical. Only browsable scopes (active/provisioning) are
 * returned; the viewed app scope is flagged so the UI opens on it.
 */
app.get('/api/apps/:scopeId/scopes', async (c) => {
  const host = hostFor(c.env);
  const node = await resolveAccount(host, c.env, getCookie(c, SESSION_COOKIE), getCookie(c, TEAM_COOKIE));
  if (!node) throw new HTTPException(401, { message: 'unauthorized' });
  const dash = await host.getScope(node.principal, node.tenantId, node.scopeId);
  const apps = (await dash.invoke('dashboard/list-apps', {})) as DashboardAppRow[];
  const appRow = apps.find((a) => a.app_scope_id === c.req.param('scopeId'));
  if (!appRow) throw new HTTPException(404, { message: 'app not found' });
  const cp = controlPlaneFor(c.env, node.tenantId);
  const scopes = cp
    ? await cp.listScopes(appRow.vertical_slug)
    : await host.admin.listScopes(STAFF, { tenantId: node.tenantId, vertical: appRow.vertical_slug });
  return c.json(
    (scopes ?? [])
      .filter((s) => s.status === 'active' || s.status === 'provisioning')
      .map((s) => ({ scopeId: s.id, name: s.name, status: s.status, isDefault: s.id === appRow.app_scope_id })),
  );
});

/**
 * Resolve the scope a Data-tab request addresses, authorized against the caller's own apps.
 * The scope switcher (multi-scope-manyfold M4) browses ANY scope of an app's vertical —
 * Manyfold's per-site scopes among them — so the addressed scope is either an app's own
 * default scope (the common case, matched directly against `list-apps`) OR a secondary scope
 * of a vertical the tenant owns an app of. Only a direct-match miss pays for the per-vertical
 * `listScopes` walk. A scope in neither is a 404, and tenant isolation holds because both
 * `list-apps` and `listScopes` are tenant-pinned below the seam (K-3).
 */
async function resolveBrowsableScope(
  host: ScopeHost,
  env: Env,
  node: DashboardNode,
  apps: DashboardAppRow[],
  requested: string,
): Promise<{ appRow: DashboardAppRow; scope: ReturnType<typeof scopeId.parse> }> {
  const direct = apps.find((a) => a.app_scope_id === requested);
  if (direct) return { appRow: direct, scope: scopeId.parse(direct.app_scope_id) };
  const cp = controlPlaneFor(env, node.tenantId);
  const seen = new Set<string>();
  for (const app of apps) {
    if (seen.has(app.vertical_slug)) continue;
    seen.add(app.vertical_slug);
    const scopes = cp
      ? await cp.listScopes(app.vertical_slug)
      : await host.admin.listScopes(STAFF, { tenantId: node.tenantId, vertical: app.vertical_slug });
    const hit = (scopes ?? []).find((s) => s.id === requested && (s.status === 'active' || s.status === 'provisioning'));
    if (hit) return { appRow: app, scope: scopeId.parse(hit.id) };
  }
  throw new HTTPException(404, { message: 'app not found' });
}

/**
 * One app's Data tab — a read-only window into the app's OWN database (kernel-design
 * §5.4's admin-query RPC). Two reads: the table list, and a bounded page of one table.
 *
 * Authorized in the caller's OWN dashboard scope: the addressed scope is resolved from the
 * tenant-scoped `list-apps` (its default scope) or the tenant's own vertical scopes (a
 * secondary site scope) via `resolveBrowsableScope`, so another tenant's scope id is a 404
 * here — and the platform layer cross-checks (tenantId, scopeId) again below (K-3). Connected
 * mode reads through the tenant-narrowed control plane; embedded mode reads the host directly
 * with the platform STAFF actor. Read-only by construction — no user SQL.
 */
app.get('/api/apps/:scopeId/tables', async (c) => {
  const host = hostFor(c.env);
  const node = await resolveAccount(host, c.env, getCookie(c, SESSION_COOKIE), getCookie(c, TEAM_COOKIE));
  if (!node) throw new HTTPException(401, { message: 'unauthorized' });
  const dash = await host.getScope(node.principal, node.tenantId, node.scopeId);
  const apps = (await dash.invoke('dashboard/list-apps', {})) as DashboardAppRow[];
  const { scope } = await resolveBrowsableScope(host, c.env, node, apps, c.req.param('scopeId'));
  const cp = controlPlaneFor(c.env, node.tenantId);
  const tables = cp
    ? await cp.listScopeTables(scope)
    : await host.admin.listScopeTables(STAFF, node.tenantId, scope);
  // Never emit an empty 200: an undefined here means the control plane answered with a
  // non-JSON body (e.g. a route it doesn't have yet), which must surface as an error the
  // UI can show — not a silent empty response the client parses as "Unexpected end of JSON".
  if (tables == null) throw new HTTPException(502, { message: 'the platform returned no data for this scope' });
  return c.json(tables);
});

app.get('/api/apps/:scopeId/tables/:table', async (c) => {
  const host = hostFor(c.env);
  const node = await resolveAccount(host, c.env, getCookie(c, SESSION_COOKIE), getCookie(c, TEAM_COOKIE));
  if (!node) throw new HTTPException(401, { message: 'unauthorized' });
  const dash = await host.getScope(node.principal, node.tenantId, node.scopeId);
  const apps = (await dash.invoke('dashboard/list-apps', {})) as DashboardAppRow[];
  const { scope } = await resolveBrowsableScope(host, c.env, node, apps, c.req.param('scopeId'));
  const input = readScopeTableInput.parse({
    table: c.req.param('table'),
    limit: c.req.query('limit') ? Number(c.req.query('limit')) : undefined,
    offset: c.req.query('offset') ? Number(c.req.query('offset')) : undefined,
  });
  const cp = controlPlaneFor(c.env, node.tenantId);
  const page = cp
    ? await cp.readScopeTable(scope, input)
    : await host.admin.readScopeTable(STAFF, node.tenantId, scope, input);
  if (page == null) throw new HTTPException(502, { message: 'the platform returned no data for this table' });
  return c.json(page);
});

// The SQL console (#219): one read-only statement against the app's own database.
// Same authorization walk as the table reads (the app must be the caller's own);
// enforcement lives below the seam — the kernel's gate plus the adapter's backstop —
// and a gate refusal surfaces as the platform's 400, message intact, for the UI.
app.post('/api/apps/:scopeId/query', async (c) => {
  const host = hostFor(c.env);
  const node = await resolveAccount(host, c.env, getCookie(c, SESSION_COOKIE), getCookie(c, TEAM_COOKIE));
  if (!node) throw new HTTPException(401, { message: 'unauthorized' });
  const dash = await host.getScope(node.principal, node.tenantId, node.scopeId);
  const apps = (await dash.invoke('dashboard/list-apps', {})) as DashboardAppRow[];
  const { scope } = await resolveBrowsableScope(host, c.env, node, apps, c.req.param('scopeId'));
  const input = queryScopeInput.parse(await c.req.json());
  const cp = controlPlaneFor(c.env, node.tenantId);
  try {
    const result = cp
      ? await cp.queryScope(scope, input.sql)
      : await host.admin.queryScope(STAFF, node.tenantId, scope, input);
    if (result == null) throw new HTTPException(502, { message: 'the platform returned no data for this query' });
    return c.json(result);
  } catch (e) {
    // The gate's refusal is the caller's mistake — relay the message for the console
    // UI instead of letting it collapse into a generic 500.
    if (e instanceof Error && e.message.includes('read-only console')) {
      throw new HTTPException(400, { message: e.message });
    }
    throw e;
  }
});

/**
 * Move an installed app to its vertical's current prod version — the rebind that
 * promotion alone doesn't do (an app stays pinned to its install-time version). Idempotent:
 * a no-op when already current. Authorized in the caller's own dashboard scope; the app
 * must be theirs.
 */
app.post('/api/apps/:scopeId/update', async (c) => {
  const host = hostFor(c.env);
  const node = await resolveAccount(host, c.env, getCookie(c, SESSION_COOKIE), getCookie(c, TEAM_COOKIE));
  if (!node) throw new HTTPException(401, { message: 'unauthorized' });
  const dash = await host.getScope(node.principal, node.tenantId, node.scopeId);
  const apps = (await dash.invoke('dashboard/list-apps', {})) as DashboardAppRow[];
  const appRow = apps.find((a) => a.app_scope_id === c.req.param('scopeId'));
  if (!appRow) throw new HTTPException(404, { message: 'app not found' });
  // `snapshot` = fork-before-promote (§4): snapshot the data first when the update
  // crosses a migration boundary. Body is optional — a bare POST updates as before.
  const body = z
    .object({ snapshot: z.boolean().optional() })
    .parse(await c.req.json().catch(() => ({})));
  const result = await updateApp(host, {
    node,
    appScopeId: scopeId.parse(appRow.app_scope_id),
    verticalSlug: appRow.vertical_slug,
    snapshot: body.snapshot,
    controlPlane: controlPlaneFor(c.env, node.tenantId) ?? undefined,
  });
  return c.json(result);
});

/**
 * #286: the PITR bookmarks an app recorded before its migration passes — the rewind
 * points the Deployments tab offers for a backout. Same ownership check as every
 * per-app route; connected-plane only (PITR is a Durable-Object-plane mechanism).
 */
app.get('/api/apps/:scopeId/bookmarks', async (c) => {
  const host = hostFor(c.env);
  const node = await resolveAccount(host, c.env, getCookie(c, SESSION_COOKIE), getCookie(c, TEAM_COOKIE));
  if (!node) throw new HTTPException(401, { message: 'unauthorized' });
  const dash = await host.getScope(node.principal, node.tenantId, node.scopeId);
  const apps = (await dash.invoke('dashboard/list-apps', {})) as DashboardAppRow[];
  const appRow = apps.find((a) => a.app_scope_id === c.req.param('scopeId'));
  if (!appRow) throw new HTTPException(404, { message: 'app not found' });
  const cp = controlPlaneFor(c.env, node.tenantId);
  if (!cp) return c.json([]);
  return c.json(await cp.migrationBookmarks(scopeId.parse(appRow.app_scope_id)));
});

/**
 * #286's backout: rewind an app to a pre-migration bookmark — schema AND data,
 * discarding every write since the bookmark. Deliberately loud in its contract:
 * the scope DO refuses a bookmark older than 24h, and the UI carries the caveat.
 * Audited on the control plane below the seam.
 */
app.post('/api/apps/:scopeId/rewind', async (c) => {
  const host = hostFor(c.env);
  const node = await resolveAccount(host, c.env, getCookie(c, SESSION_COOKIE), getCookie(c, TEAM_COOKIE));
  if (!node) throw new HTTPException(401, { message: 'unauthorized' });
  const dash = await host.getScope(node.principal, node.tenantId, node.scopeId);
  const apps = (await dash.invoke('dashboard/list-apps', {})) as DashboardAppRow[];
  const appRow = apps.find((a) => a.app_scope_id === c.req.param('scopeId'));
  if (!appRow) throw new HTTPException(404, { message: 'app not found' });
  const body = z.object({ bookmark: z.string().min(1) }).parse(await c.req.json());
  const cp = controlPlaneFor(c.env, node.tenantId);
  if (!cp) throw new HTTPException(501, { message: 'rewind needs the shared control plane' });
  return c.json(await cp.rewindScope(scopeId.parse(appRow.app_scope_id), body.bookmark));
});

/**
 * The Snapshots tab (preview-and-snapshots.md §3): create a test copy of an app's
 * data, list the copies, delete one. Same authority as managing the app
 * (`dashboard:provision-app`, checked in-scope); the app must be the caller's own.
 * A copy is an ARCHIVE fork — it never receives traffic, never runs consumers, and
 * expires on the chosen TTL (the GC sweep reaps it) unless kept.
 */
app.get('/api/apps/:scopeId/snapshots', async (c) => {
  const host = hostFor(c.env);
  const node = await resolveAccount(host, c.env, getCookie(c, SESSION_COOKIE), getCookie(c, TEAM_COOKIE));
  if (!node) throw new HTTPException(401, { message: 'unauthorized' });
  const dash = await host.getScope(node.principal, node.tenantId, node.scopeId);
  const apps = (await dash.invoke('dashboard/list-apps', {})) as DashboardAppRow[];
  const appRow = apps.find((a) => a.app_scope_id === c.req.param('scopeId'));
  if (!appRow) throw new HTTPException(404, { message: 'app not found' });
  const snapshots = await listAppSnapshots(host, {
    node,
    appScopeId: scopeId.parse(appRow.app_scope_id),
    controlPlane: controlPlaneFor(c.env, node.tenantId) ?? undefined,
  });
  return c.json(snapshots);
});

app.post('/api/apps/:scopeId/snapshots', async (c) => {
  const host = hostFor(c.env);
  const node = await resolveAccount(host, c.env, getCookie(c, SESSION_COOKIE), getCookie(c, TEAM_COOKIE));
  if (!node) throw new HTTPException(401, { message: 'unauthorized' });
  const dash = await host.getScope(node.principal, node.tenantId, node.scopeId);
  const apps = (await dash.invoke('dashboard/list-apps', {})) as DashboardAppRow[];
  const appRow = apps.find((a) => a.app_scope_id === c.req.param('scopeId'));
  if (!appRow) throw new HTTPException(404, { message: 'app not found' });
  const body = z
    .object({ ttlDays: z.number().int().positive().max(365).optional() })
    .parse(await c.req.json().catch(() => ({})));
  const created = await snapshotApp(host, {
    node,
    appScopeId: scopeId.parse(appRow.app_scope_id),
    ttlDays: body.ttlDays,
    appHostname: appRow.hostname,
    controlPlane: controlPlaneFor(c.env, node.tenantId) ?? undefined,
  });
  return c.json(created, 201);
});

app.delete('/api/apps/:scopeId/snapshots/:snapshotId', async (c) => {
  const host = hostFor(c.env);
  const node = await resolveAccount(host, c.env, getCookie(c, SESSION_COOKIE), getCookie(c, TEAM_COOKIE));
  if (!node) throw new HTTPException(401, { message: 'unauthorized' });
  const dash = await host.getScope(node.principal, node.tenantId, node.scopeId);
  const apps = (await dash.invoke('dashboard/list-apps', {})) as DashboardAppRow[];
  const appRow = apps.find((a) => a.app_scope_id === c.req.param('scopeId'));
  if (!appRow) throw new HTTPException(404, { message: 'app not found' });
  // The snapshot must be a fork OF THIS APP — a snapshot id belonging to another
  // scope (or a non-fork) 404s here before any platform call.
  const snapshots = await listAppSnapshots(host, {
    node,
    appScopeId: scopeId.parse(appRow.app_scope_id),
    controlPlane: controlPlaneFor(c.env, node.tenantId) ?? undefined,
  });
  const snap = snapshots.find((s) => s.id === c.req.param('snapshotId'));
  if (!snap) throw new HTTPException(404, { message: 'snapshot not found' });
  await deleteAppSnapshot(host, {
    node,
    appScopeId: scopeId.parse(appRow.app_scope_id),
    snapshotScopeId: scopeId.parse(snap.id),
    controlPlane: controlPlaneFor(c.env, node.tenantId) ?? undefined,
  });
  return c.json({ deleted: snap.id });
});

/**
 * Export & import (preview-and-snapshots.md §8 — the dashboard half of the CLI's
 * `scope pull`/`scope restore`). GET hands back the app's data as a dump the CLI
 * and the Import button both accept; connected mode arrives MASKED from the CP
 * (this surface has no break-glass). POST loads an uploaded dump into the app,
 * replacing its data wholesale — the helper forks a safety copy first, so the
 * response names the fork to back out to. Same authority as managing the app.
 */
app.get('/api/apps/:scopeId/export', async (c) => {
  const host = hostFor(c.env);
  const node = await resolveAccount(host, c.env, getCookie(c, SESSION_COOKIE), getCookie(c, TEAM_COOKIE));
  if (!node) throw new HTTPException(401, { message: 'unauthorized' });
  const dash = await host.getScope(node.principal, node.tenantId, node.scopeId);
  const apps = (await dash.invoke('dashboard/list-apps', {})) as DashboardAppRow[];
  const appRow = apps.find((a) => a.app_scope_id === c.req.param('scopeId'));
  if (!appRow) throw new HTTPException(404, { message: 'app not found' });
  const dump = await exportAppData(host, {
    node,
    appScopeId: scopeId.parse(appRow.app_scope_id),
    controlPlane: controlPlaneFor(c.env, node.tenantId) ?? undefined,
  });
  return c.json(dump);
});

app.post('/api/apps/:scopeId/restore', async (c) => {
  const host = hostFor(c.env);
  const node = await resolveAccount(host, c.env, getCookie(c, SESSION_COOKIE), getCookie(c, TEAM_COOKIE));
  if (!node) throw new HTTPException(401, { message: 'unauthorized' });
  const dash = await host.getScope(node.principal, node.tenantId, node.scopeId);
  const apps = (await dash.invoke('dashboard/list-apps', {})) as DashboardAppRow[];
  const appRow = apps.find((a) => a.app_scope_id === c.req.param('scopeId'));
  if (!appRow) throw new HTTPException(404, { message: 'app not found' });
  // The upload is a pulled export or a local `.dump.json` — only `tables` matters
  // here; any tenantId/scopeId in the file are provenance, never authority.
  const body = z.object({ tables: z.array(scopeDumpTable).min(1) }).parse(await c.req.json());
  const result = await restoreAppData(host, {
    node,
    appScopeId: scopeId.parse(appRow.app_scope_id),
    tables: body.tables,
    appHostname: appRow.hostname,
    controlPlane: controlPlaneFor(c.env, node.tenantId) ?? undefined,
  });
  return c.json(result);
});

/**
 * One app's environment/config (the Env tab). GET returns the vertical's declared
 * env-spec (placeholder + description per key, from the catalog/manifest) alongside the
 * app's current values — secret values are never echoed (write-only). PUT upserts values;
 * DELETE removes one key. The app must be the caller's own, and managing config is the
 * same authority as managing the app. Delivery to the running app scope is a later step
 * (a hosted vertical reads its per-scope config at runtime); this is the authoring surface.
 */
app.get('/api/apps/:scopeId/env', async (c) => {
  const host = hostFor(c.env);
  const node = await resolveAccount(host, c.env, getCookie(c, SESSION_COOKIE), getCookie(c, TEAM_COOKIE));
  if (!node) throw new HTTPException(401, { message: 'unauthorized' });
  const dash = await host.getScope(node.principal, node.tenantId, node.scopeId);
  const apps = (await dash.invoke('dashboard/list-apps', {})) as DashboardAppRow[];
  const appRow = apps.find((a) => a.app_scope_id === c.req.param('scopeId'));
  if (!appRow) throw new HTTPException(404, { message: 'app not found' });
  // The env-spec comes from the REGISTRY (a vertical declares it in its manifest; the
  // registry carries it), so a pushed builder vertical works the same as a builtin. In
  // CONNECTED mode a pushed vertical registers on the SHARED plane, not this
  // deployment's registry — same lookup ladder as installSpecFor: local registry, the
  // hardcoded catalog, then the shared plane's catalog.
  await ensureCatalog(host, STAFF);
  const registered = (await host.admin.listVerticals(STAFF)).find((v) => v.slug === appRow.vertical_slug);
  let spec = registered?.envSpec ?? CATALOG[appRow.vertical_slug]?.envSpec;
  if (!spec) {
    const cp = controlPlaneFor(c.env, node.tenantId);
    const remote = cp ? (await cp.listCatalog()).find((v) => v.slug === appRow.vertical_slug) : undefined;
    spec = (remote?.envSpec as typeof spec) ?? [];
  }
  const values = await dash.invoke('dashboard/list-app-env', { appScopeId: appRow.app_scope_id });
  return c.json({ spec, values });
});

app.put('/api/apps/:scopeId/env', async (c) => {
  const host = hostFor(c.env);
  const node = await resolveAccount(host, c.env, getCookie(c, SESSION_COOKIE), getCookie(c, TEAM_COOKIE));
  if (!node) throw new HTTPException(401, { message: 'unauthorized' });
  const dash = await host.getScope(node.principal, node.tenantId, node.scopeId);
  const apps = (await dash.invoke('dashboard/list-apps', {})) as DashboardAppRow[];
  const appRow = apps.find((a) => a.app_scope_id === c.req.param('scopeId'));
  if (!appRow) throw new HTTPException(404, { message: 'app not found' });
  const body = await c.req.json<{ entries?: Array<{ key: string; value: string; secret?: boolean }> }>();
  const entries = (body.entries ?? []).filter((e) => e && typeof e.key === 'string');
  if (entries.length === 0) return c.json({ saved: 0, delivered: false });
  const saved = await dash.invoke('dashboard/set-app-env', { appScopeId: appRow.app_scope_id, entries });
  // DELIVER to the running app scope (vertical-auth-detach.md §2.2), not just author:
  // the control plane routes the entries to the deployment holding the scope's DO. This
  // is a LIVE delivery, not a next-deploy binding — env-spec `default:` values ride as
  // worker bindings (per script, shared across every install), so a per-install override
  // can only reach the app through this per-scope channel, never through `resolveEnvSpec`.
  //
  // Report the outcome HONESTLY, exactly as the auth PUT does (#374): a save whose
  // delivery 501s — the deployment has no `/internal/configure`, or no version is bound —
  // is otherwise indistinguishable from success, which is the "no error anywhere" the
  // issue describes. The value stays authored here either way.
  let delivered = false;
  let note: string | undefined;
  const cp = controlPlaneFor(c.env, node.tenantId);
  if (cp) {
    try {
      await cp.configureInstance(
        scopeId.parse(appRow.app_scope_id),
        entries.map((e) => ({ key: e.key, value: e.value })),
      );
      delivered = true;
    } catch (e) {
      const cause = e instanceof Error ? e.message : String(e);
      note =
        e instanceof ControlPlaneError && e.status === 501
          ? `Saved, but not applied — the app's deployment did not accept live config (${cause}). ` +
            `A hosted vertical must read its per-scope config at runtime (add /internal/configure ` +
            `support and bind a version); save again to retry once it does.`
          : `Saved, but not applied: ${cause}`;
    }
  } else {
    note = 'Saved. This deployment has no delivery seam (embedded mode) — the app reads authored config.';
  }
  return c.json({ ...(saved as Record<string, unknown>), delivered, ...(note ? { note } : {}) });
});

app.delete('/api/apps/:scopeId/env/:key', async (c) => {
  const host = hostFor(c.env);
  const node = await resolveAccount(host, c.env, getCookie(c, SESSION_COOKIE), getCookie(c, TEAM_COOKIE));
  if (!node) throw new HTTPException(401, { message: 'unauthorized' });
  const dash = await host.getScope(node.principal, node.tenantId, node.scopeId);
  const apps = (await dash.invoke('dashboard/list-apps', {})) as DashboardAppRow[];
  const appRow = apps.find((a) => a.app_scope_id === c.req.param('scopeId'));
  if (!appRow) throw new HTTPException(404, { message: 'app not found' });
  await dash.invoke('dashboard/delete-app-env', { appScopeId: appRow.app_scope_id, key: c.req.param('key') });
  return c.body(null, 204);
});

/**
 * The app's hostname bindings (the Domains tab; K-26 multi-surface). One scope can
 * front more than one app — the hostname decides which surface the vertical serves
 * (`readRoutedNode(...).surface`), so giving a surface a URL is exactly a binding.
 * GET lists the bindings plus the vertical's DECLARED surfaces (registry ladder,
 * same as the env-spec: pushed verticals declare them in package.json `substrat.surfaces`)
 * so the UI offers a picker; free text stays valid — the declaration is UX, not contract.
 */
app.get('/api/apps/:scopeId/hostnames', async (c) => {
  const host = hostFor(c.env);
  const node = await resolveAccount(host, c.env, getCookie(c, SESSION_COOKIE), getCookie(c, TEAM_COOKIE));
  if (!node) throw new HTTPException(401, { message: 'unauthorized' });
  const dash = await host.getScope(node.principal, node.tenantId, node.scopeId);
  const apps = (await dash.invoke('dashboard/list-apps', {})) as DashboardAppRow[];
  const appRow = apps.find((a) => a.app_scope_id === c.req.param('scopeId'));
  if (!appRow) throw new HTTPException(404, { message: 'app not found' });
  const bindings = await listAppHostnames(host, {
    node,
    appScopeId: scopeId.parse(appRow.app_scope_id),
    controlPlane: controlPlaneFor(c.env, node.tenantId) ?? undefined,
  });
  // Declared surfaces: local registry first, then the shared plane's catalog for a
  // vertical pushed there — the same lookup ladder the Env tab's spec uses.
  await ensureCatalog(host, STAFF);
  const registered = (await host.admin.listVerticals(STAFF)).find((v) => v.slug === appRow.vertical_slug);
  let surfaces = registered?.surfaces;
  if (!surfaces) {
    const cp = controlPlaneFor(c.env, node.tenantId);
    const remote = cp ? (await cp.listCatalog()).find((v) => v.slug === appRow.vertical_slug) : undefined;
    surfaces = remote?.surfaces ?? [];
  }
  return c.json({ bindings, surfaces, defaultHostname: appRow.hostname });
});

/**
 * Bind a hostname to a surface of this app. A platform hostname (`domain` omitted)
 * is minted from the app's own label and lands ACTIVE — it rides the wildcard cert.
 * A custom domain lands PENDING and walks the §4.2 lifecycle. Same authority as
 * managing the app; recorded on the activity trail (`hostname-bound`).
 */
app.post('/api/apps/:scopeId/hostnames', async (c) => {
  const host = hostFor(c.env);
  const node = await resolveAccount(host, c.env, getCookie(c, SESSION_COOKIE), getCookie(c, TEAM_COOKIE));
  if (!node) throw new HTTPException(401, { message: 'unauthorized' });
  const dash = await host.getScope(node.principal, node.tenantId, node.scopeId);
  const apps = (await dash.invoke('dashboard/list-apps', {})) as DashboardAppRow[];
  const appRow = apps.find((a) => a.app_scope_id === c.req.param('scopeId'));
  if (!appRow) throw new HTTPException(404, { message: 'app not found' });
  const body = z
    .object({ surface: z.string().min(1).max(32), domain: z.string().min(1).max(253).optional() })
    .parse(await c.req.json());
  try {
    const bound = await addAppHostname(host, {
      node,
      appScopeId: scopeId.parse(appRow.app_scope_id),
      surface: body.surface,
      ...(body.domain ? { customDomain: body.domain } : {}),
      appHostname: appRow.hostname,
      controlPlane: controlPlaneFor(c.env, node.tenantId) ?? undefined,
    });
    return c.json(bound, 201);
  } catch (e) {
    if (e instanceof Error && /permission denied/.test(e.message)) throw e;
    throw new HTTPException(409, { message: e instanceof Error ? e.message : 'could not bind hostname' });
  }
});

/** Unbind one hostname. The app's default hostname is refused (409) — deleting the app retires it. */
app.delete('/api/apps/:scopeId/hostnames/:hostname', async (c) => {
  const host = hostFor(c.env);
  const node = await resolveAccount(host, c.env, getCookie(c, SESSION_COOKIE), getCookie(c, TEAM_COOKIE));
  if (!node) throw new HTTPException(401, { message: 'unauthorized' });
  const dash = await host.getScope(node.principal, node.tenantId, node.scopeId);
  const apps = (await dash.invoke('dashboard/list-apps', {})) as DashboardAppRow[];
  const appRow = apps.find((a) => a.app_scope_id === c.req.param('scopeId'));
  if (!appRow) throw new HTTPException(404, { message: 'app not found' });
  try {
    await removeAppHostname(host, {
      node,
      appScopeId: scopeId.parse(appRow.app_scope_id),
      hostname: c.req.param('hostname'),
      defaultHostname: appRow.hostname,
      controlPlane: controlPlaneFor(c.env, node.tenantId) ?? undefined,
    });
  } catch (e) {
    if (e instanceof Error && /permission denied/.test(e.message)) throw e;
    const message = e instanceof Error ? e.message : 'could not unbind hostname';
    throw new HTTPException(/not bound/.test(message) ? 404 : 409, { message });
  }
  return c.json({ deleted: c.req.param('hostname').toLowerCase() });
});

/**
 * The app's Identity choice (vertical-auth-detach.md §2.4) as authored at install or
 * updated since — clientSecret redacted (write-only), `auth: null` ⇒ the vertical's
 * builtin sign-in. The callback URL rides along so a user registering the client at an
 * external issuer can copy it from the same card.
 */
app.get('/api/apps/:scopeId/auth', async (c) => {
  const host = hostFor(c.env);
  const node = await resolveAccount(host, c.env, getCookie(c, SESSION_COOKIE), getCookie(c, TEAM_COOKIE));
  if (!node) throw new HTTPException(401, { message: 'unauthorized' });
  const dash = await host.getScope(node.principal, node.tenantId, node.scopeId);
  const apps = (await dash.invoke('dashboard/list-apps', {})) as DashboardAppRow[];
  const appRow = apps.find((a) => a.app_scope_id === c.req.param('scopeId'));
  if (!appRow) throw new HTTPException(404, { message: 'app not found' });
  const auth = await dash.invoke('dashboard/get-app-auth', { appScopeId: appRow.app_scope_id });
  // The callback URL derives from the app's hostname. Prefer the stored column, but fall
  // back to the live router bindings so a null column (a bind whose activation step threw
  // during provisioning) doesn't hide the URL the app is actually reachable at.
  const cp = controlPlaneFor(c.env, node.tenantId);
  const hostname = await resolveDefaultHostname(host, {
    node,
    appScopeId: scopeId.parse(appRow.app_scope_id),
    stored: appRow.hostname,
    ...(cp ? { controlPlane: cp } : {}),
  });
  return c.json({ auth, callbackUrl: hostname ? `https://${hostname}/api/auth/callback` : null });
});

/**
 * Update the app's Identity choice. Authors the record first (a blank clientSecret
 * keeps the stored one), then DELIVERS it to the running scope — and reports honestly:
 * `delivered: false` with a readable note when the app's deployment cannot receive
 * live config (its 501), instead of failing the save or pretending it applied.
 */
app.put('/api/apps/:scopeId/auth', async (c) => {
  const host = hostFor(c.env);
  const node = await resolveAccount(host, c.env, getCookie(c, SESSION_COOKIE), getCookie(c, TEAM_COOKIE));
  if (!node) throw new HTTPException(401, { message: 'unauthorized' });
  const dash = await host.getScope(node.principal, node.tenantId, node.scopeId);
  const apps = (await dash.invoke('dashboard/list-apps', {})) as DashboardAppRow[];
  const appRow = apps.find((a) => a.app_scope_id === c.req.param('scopeId'));
  if (!appRow) throw new HTTPException(404, { message: 'app not found' });
  const cp = controlPlaneFor(c.env, node.tenantId);
  const choice = resolveAuthChoice(appAuthChoiceBody.parse(await c.req.json()), apps, await oidcProviderSlugsFor(host, cp));
  // Prefer the stored column, but fall back to the live router bindings: an app can be
  // fully reachable while its dashboard column is null (a bind whose activation step threw
  // during provisioning), and refusing the save on that stale bookkeeping is the #294 bug.
  const hostname = await resolveDefaultHostname(host, {
    node,
    appScopeId: scopeId.parse(appRow.app_scope_id),
    stored: appRow.hostname,
    ...(cp ? { controlPlane: cp } : {}),
  });
  if (!hostname) {
    throw new HTTPException(400, { message: 'this app has no hostname yet, so the OIDC callback URL cannot be formed' });
  }
  const config = await authConfigFor(choice, {
    appName: appRow.name,
    redirectUri: `https://${hostname}/api/auth/callback`,
  });
  // Author first — the merged config (stored secret filled in) is what gets delivered.
  const merged = (await dash.invoke('dashboard/set-app-auth', {
    appScopeId: appRow.app_scope_id,
    config,
  })) as Record<string, string>;
  let delivered = false;
  let note: string | undefined;
  if (cp) {
    try {
      await cp.configureInstance(scopeId.parse(appRow.app_scope_id), [
        { key: 'substrat:auth', value: JSON.stringify(merged) },
      ]);
      delivered = true;
    } catch (e) {
      note =
        e instanceof ControlPlaneError && e.status === 501
          ? `Saved, but not applied: this app's deployment cannot receive auth settings while running (no live-config support). It applies once the vertical adds /internal/configure.`
          : `Saved, but not applied: ${e instanceof Error ? e.message : String(e)}`;
    }
  } else {
    note = 'Saved. This deployment has no delivery seam (embedded mode) — the app reads authored config.';
  }
  return c.json({ delivered, ...(note ? { note } : {}) });
});

/** Create an app — provisioned into MY tenant (from the session), authorized in-scope. */
app.post('/api/apps', async (c) => {
  const host = hostFor(c.env);
  const node = await resolveAccount(host, c.env, getCookie(c, SESSION_COOKIE), getCookie(c, TEAM_COOKIE));
  if (!node) throw new HTTPException(401, { message: 'unauthorized' });
  const body = createAppBody.parse(await c.req.json());
  // Connected (prod): provision on the shared control plane through the tenant-narrowed
  // seam so the app is reachable via the router. Absent the binding: the M0 embedded path.
  const cp = controlPlaneFor(c.env, node.tenantId);
  // The install kill-switch, embedded-mode edge (connected mode is enforced by the
  // control plane's instances route): a blocked vertical takes no new installs.
  const registeredVertical = (await host.admin.listVerticals(STAFF)).find((v) => v.slug === body.verticalSlug);
  if (registeredVertical?.installsBlocked) {
    throw new HTTPException(403, { message: `new installs of '${body.verticalSlug}' are blocked` });
  }
  const { entitlements, ownerGrants, envSpec } = await installSpecFor(host, body.verticalSlug, cp);
  // The install form's config, narrowed to the DECLARED spec (#426): the spec is the
  // allow-list, and it also carries the secret flag the authoring store needs — the
  // client never gets to say what is or isn't a secret.
  const appConfig = envSpec
    .filter((s) => (body.config?.[s.key] ?? '') !== '')
    .map((s) => ({ key: s.key, value: body.config![s.key]!, secret: s.secret }));
  const user = await verifySession(c.env, getCookie(c, SESSION_COOKIE));
  // The team's human handle, suffixed into the default hostname
  // (`callout-sesamy.global.substrat.run`). From the TEAM record, not the user.
  const team = await host.admin.getTenant(STAFF, node.tenantId);
  const teamHandle = team?.name ? slugify(team.name) : undefined;
  // The Identity choice (vertical-auth-detach.md §2.4), resolved to a concrete issuer
  // (`resolveAuthChoice` above — an auth-server pick must be one of the caller's own).
  let appAuth: AppAuthChoice | undefined;
  if (body.auth) {
    const apps =
      body.auth.source === 'auth-server'
        ? ((await (await host.getScope(node.principal, node.tenantId, node.scopeId)).invoke('dashboard/list-apps', {})) as DashboardAppRow[])
        : [];
    const providers = body.auth.source === 'auth-server' ? await oidcProviderSlugsFor(host, cp) : new Set<string>();
    appAuth = resolveAuthChoice(body.auth, apps, providers);
  }
  const appRow = await createApp(host, {
    node,
    appScopeId: scopeId.parse(ulid()),
    verticalSlug: body.verticalSlug,
    name: body.name,
    appEntitlements: entitlements,
    appOwnerGrants: ownerGrants,
    teamHandle,
    controlPlane: cp ?? undefined,
    // The TEAM's name, never the login's — this seeds the shared directory's tenant
    // row, which the CLI's workspace picker displays.
    tenantName: team?.name ?? 'Workspace',
    ...(appAuth ? { appAuth } : {}),
    ...(appConfig.length > 0 ? { appConfig } : {}),
  });
  return c.json(appRow, 201);
});

/** Delete an app — deprovisions its scope + takes its hostname offline, in MY tenant. */
app.delete('/api/apps/:id', async (c) => {
  const host = hostFor(c.env);
  const node = await resolveAccount(host, c.env, getCookie(c, SESSION_COOKIE), getCookie(c, TEAM_COOKIE));
  if (!node) throw new HTTPException(401, { message: 'unauthorized' });
  // Resolve the app to its scope id + hostname from the caller's OWN apps only — the
  // :id is theirs or it does not exist to them (list-apps is tenant-scoped).
  const dash = await host.getScope(node.principal, node.tenantId, node.scopeId);
  const apps = (await dash.invoke('dashboard/list-apps', {})) as DashboardAppRow[];
  const appRow = apps.find((a) => a.id === c.req.param('id'));
  if (!appRow) throw new HTTPException(404, { message: 'app not found' });
  await deprovisionApp(host, {
    node,
    appScopeId: scopeId.parse(appRow.app_scope_id),
    hostname: appRow.hostname,
    controlPlane: controlPlaneFor(c.env, node.tenantId) ?? undefined,
  });
  return c.body(null, 204);
});

/**
 * Retry a FAILED app — re-attempt provisioning for real. A first attempt can leave
 * a half-provisioned scope (e.g. the directory row landed but the vertical instance
 * didn't), so we best-effort tear that down, then re-provision fresh under a new
 * scope with the same vertical + name via the proven create path. That path marks
 * the row `failed` again and surfaces the REAL error if it still can't come up, so
 * Retry re-tries instead of showing a placeholder. Only a `failed` app is retryable;
 * the app must be one of the caller's own (list-apps is tenant-scoped).
 */
app.post('/api/apps/:scopeId/retry', async (c) => {
  const host = hostFor(c.env);
  const node = await resolveAccount(host, c.env, getCookie(c, SESSION_COOKIE), getCookie(c, TEAM_COOKIE));
  if (!node) throw new HTTPException(401, { message: 'unauthorized' });
  const dash = await host.getScope(node.principal, node.tenantId, node.scopeId);
  const apps = (await dash.invoke('dashboard/list-apps', {})) as DashboardAppRow[];
  const appRow = apps.find((a) => a.app_scope_id === c.req.param('scopeId'));
  if (!appRow) throw new HTTPException(404, { message: 'app not found' });
  if (appRow.status !== 'failed') throw new HTTPException(409, { message: 'only a failed app can be retried' });
  const cp = controlPlaneFor(c.env, node.tenantId);
  const { entitlements, ownerGrants } = await installSpecFor(host, appRow.vertical_slug, cp);
  const team = await host.admin.getTenant(STAFF, node.tenantId);
  const appRowNew = await retryApp(host, {
    node,
    failedScopeId: scopeId.parse(appRow.app_scope_id),
    hostname: appRow.hostname,
    newScopeId: scopeId.parse(ulid()),
    verticalSlug: appRow.vertical_slug,
    name: appRow.name,
    appEntitlements: entitlements,
    appOwnerGrants: ownerGrants,
    controlPlane: cp ?? undefined,
    // The TEAM's name, never the login's (same as create).
    tenantName: team?.name ?? 'Workspace',
  });
  return c.json(appRowNew, 201);
});

/**
 * Resume an app STUCK at `provisioning` (#424 case 4) — the worker died between the
 * platform effect and `mark-app-active`, or the browser closed mid-create, and the row
 * has rendered as an eternal spinner ever since. Re-runs the idempotent install tail in
 * place, against the SAME scope (unlike Retry's fresh-scope re-create), so it converges
 * to `active` — or surfaces the real blocker and marks the row `failed`, which unlocks
 * Retry. Only a `provisioning` app is resumable; it must be the caller's own.
 */
app.post('/api/apps/:scopeId/resume', async (c) => {
  const host = hostFor(c.env);
  const node = await resolveAccount(host, c.env, getCookie(c, SESSION_COOKIE), getCookie(c, TEAM_COOKIE));
  if (!node) throw new HTTPException(401, { message: 'unauthorized' });
  const dash = await host.getScope(node.principal, node.tenantId, node.scopeId);
  const apps = (await dash.invoke('dashboard/list-apps', {})) as DashboardAppRow[];
  const appRow = apps.find((a) => a.app_scope_id === c.req.param('scopeId'));
  if (!appRow) throw new HTTPException(404, { message: 'app not found' });
  if (appRow.status !== 'provisioning') {
    throw new HTTPException(409, { message: 'only an app stuck provisioning can be resumed' });
  }
  const cp = controlPlaneFor(c.env, node.tenantId);
  const { entitlements, ownerGrants } = await installSpecFor(host, appRow.vertical_slug, cp);
  const team = await host.admin.getTenant(STAFF, node.tenantId);
  const resumed = await resumeApp(host, {
    node,
    appScopeId: scopeId.parse(appRow.app_scope_id),
    verticalSlug: appRow.vertical_slug,
    name: appRow.name,
    appEntitlements: entitlements,
    appOwnerGrants: ownerGrants,
    // Same hostname scheme as create, so the resume mints the URL the install would have.
    teamHandle: team?.name ? slugify(team.name) : undefined,
    controlPlane: cp ?? undefined,
    tenantName: team?.name ?? 'Workspace',
  });
  return c.json(resumed);
});

/**
 * My deployments (builder-plane.md Phase 4) — the verticals THIS tenant pushed, with
 * their versions + channels. Connected mode reads the shared plane (tenant-filtered);
 * embedded reads the local host. Either way the tenant is the caller's own, from session.
 */
app.get('/api/deployments', async (c) => {
  const host = hostFor(c.env);
  const node = await resolveAccount(host, c.env, getCookie(c, SESSION_COOKIE), getCookie(c, TEAM_COOKIE));
  if (!node) throw new HTTPException(401, { message: 'unauthorized' });
  const cp = controlPlaneFor(c.env, node.tenantId);
  const deployments = cp
    ? await listDeploymentsFromCp(cp)
    : await listDeploymentsFromHost(host, STAFF, node.tenantId);
  return c.json(deployments);
});

/**
 * Observability for MY pushed verticals (design/observability.md §5, view 2). Both
 * routes are thin: the owner-narrowing lives in `TenantNarrowedControlPlane`
 * (rows filtered to owned deployment refs; an unowned ref in the logs query answers
 * `[]` without ever reaching the plane). Connected mode only — embedded mode has no
 * observability backend, and 501 is the platform's shape for an absent capability;
 * the plane's own 501 (no backend configured there either) passes through as such.
 */
const cpObservability = async <T>(read: () => Promise<T>): Promise<T> => {
  try {
    return await read();
  } catch (e) {
    if (e instanceof ControlPlaneError && e.status === 501) {
      throw new HTTPException(501, { message: 'observability is not configured on this platform' });
    }
    throw e;
  }
};

app.get('/api/observability/metrics', async (c) => {
  const host = hostFor(c.env);
  const node = await resolveAccount(host, c.env, getCookie(c, SESSION_COOKIE), getCookie(c, TEAM_COOKIE));
  if (!node) throw new HTTPException(401, { message: 'unauthorized' });
  const cp = controlPlaneFor(c.env, node.tenantId);
  if (!cp) throw new HTTPException(501, { message: 'observability requires the shared control plane' });
  const hours = Number(c.req.query('hours') ?? '24');
  return c.json(await cpObservability(() => cp.observabilityMetrics(Number.isFinite(hours) ? hours : 24)));
});

app.get('/api/observability/logs', async (c) => {
  const host = hostFor(c.env);
  const node = await resolveAccount(host, c.env, getCookie(c, SESSION_COOKIE), getCookie(c, TEAM_COOKIE));
  if (!node) throw new HTTPException(401, { message: 'unauthorized' });
  const cp = controlPlaneFor(c.env, node.tenantId);
  if (!cp) throw new HTTPException(501, { message: 'observability requires the shared control plane' });
  const service = c.req.query('service');
  if (!service) throw new HTTPException(400, { message: 'service is required' });
  const hours = Number(c.req.query('hours') ?? '1');
  const limit = Number(c.req.query('limit') ?? '100');
  const level = c.req.query('level') || undefined;
  return c.json(
    await cpObservability(() =>
      cp.observabilityLogs({
        service,
        level,
        hours: Number.isFinite(hours) ? hours : 1,
        limit: Number.isFinite(limit) ? limit : 100,
      }),
    ),
  );
});

/**
 * Promote one of MY verticals. dev/staging always; `prod` while the vertical is PRIVATE
 * (its blast radius is this tenant alone — merge-to-main deploys and dashboard rollback
 * both land here). Prod on a LISTED vertical is refused: publishing widened the audience,
 * so that promotion is a staff decision again. The slug is verified to be one of the
 * caller's own deployments before anything is promoted; the registry additionally
 * refuses non-admitted versions and unacknowledged digest changes below the seam.
 */
app.post('/api/deployments/:slug/promote', async (c) => {
  const host = hostFor(c.env);
  const node = await resolveAccount(host, c.env, getCookie(c, SESSION_COOKIE), getCookie(c, TEAM_COOKIE));
  if (!node) throw new HTTPException(401, { message: 'unauthorized' });
  const body = promoteBody.parse(await c.req.json());
  const slug = c.req.param('slug');
  const cp = controlPlaneFor(c.env, node.tenantId);
  const deployments = cp
    ? await listDeploymentsFromCp(cp)
    : await listDeploymentsFromHost(host, STAFF, node.tenantId);
  assertOwned(deployments, slug); // your vertical, or 4xx
  const target = deployments.find((d) => d.slug === slug);
  if (body.channel === 'prod' && target?.listed) {
    throw new HTTPException(403, { message: 'production for a published vertical is promoted by the Substrat team' });
  }
  if (cp) {
    await cp.promote(slug, body.channel, body.versionId, body.acknowledge);
  } else {
    await host.admin.promoteVersion(STAFF, slug, body.channel, body.versionId, body.acknowledge);
  }
  return c.body(null, 204);
});

/**
 * One channel's promotion timeline (newest first) — the rollback picker. Each entry is a
 * recorded go-live moment: version, what it replaced, who, and exactly when (the instant
 * a PITR restore would rewind the data to). Owned-slug-checked like promote above.
 */
app.get('/api/deployments/:slug/channels/:channel/history', async (c) => {
  const host = hostFor(c.env);
  const node = await resolveAccount(host, c.env, getCookie(c, SESSION_COOKIE), getCookie(c, TEAM_COOKIE));
  if (!node) throw new HTTPException(401, { message: 'unauthorized' });
  const slug = c.req.param('slug');
  const channel = z.enum(['dev', 'staging', 'prod']).parse(c.req.param('channel'));
  const cp = controlPlaneFor(c.env, node.tenantId);
  if (cp) {
    assertOwned(await listDeploymentsFromCp(cp), slug);
    return c.json(await cp.channelHistory(slug, channel));
  }
  assertOwned(await listDeploymentsFromHost(host, STAFF, node.tenantId), slug);
  return c.json(await host.admin.listChannelHistory(STAFF, slug, channel));
});

// -- Git import (GitHub App) — connections.md §3.5.1 -------------------------
// The dashboard vertical holds the connection; keyed (tenant, 'dashboard', 'github').
const GIT_VERTICAL = 'dashboard';

/**
 * Begin a GitHub connection. Authorize IN-SCOPE first (the tenant admin's
 * permission-checked act via `begin-connection`), then redirect to the App's install
 * page carrying a signed state that binds this connect to the authorizing principal +
 * tenant. B's authority originates here — not in the callback, not from a platform actor.
 */
app.get('/api/github/connect', async (c) => {
  const cfg = githubConfig(c.env);
  if (!cfg) throw new HTTPException(503, { message: 'GitHub is not configured' });
  const host = hostFor(c.env);
  const node = await resolveAccount(host, c.env, getCookie(c, SESSION_COOKIE), getCookie(c, TEAM_COOKIE));
  if (!node) throw new HTTPException(401, { message: 'unauthorized' });
  const dash = await host.getScope(node.principal, node.tenantId, node.scopeId);
  // Throws "permission denied" (→ 403 via onError) if the caller may not connect providers.
  const { principal } = (await dash.invoke('dashboard/begin-connection', { provider: 'github' })) as { principal: string };
  const state = await signGithubState(c.env, { tenantId: node.tenantId, principal, provider: 'github' });
  return c.redirect(installUrl(cfg, state));
});

/**
 * The App install callback. Verify the signed state (the connect was authorized
 * in-scope by this principal for this tenant) AND that the callback's session is that
 * same principal, then record the connection: the installationId sealed, attributed to
 * the principal (`createdBy`), effected with platform authority.
 */
app.get('/api/github/callback', async (c) => {
  const cfg = githubConfig(c.env);
  if (!cfg) throw new HTTPException(503, { message: 'GitHub is not configured' });
  const installationId = c.req.query('installation_id');
  const stateToken = c.req.query('state');
  if (!installationId || !stateToken) throw new HTTPException(400, { message: 'missing installation_id or state' });
  const state = await verifyGithubState(c.env, stateToken);
  if (!state) throw new HTTPException(400, { message: 'invalid or expired state' });

  const host = hostFor(c.env);
  const node = await resolveAccount(host, c.env, getCookie(c, SESSION_COOKIE), getCookie(c, TEAM_COOKIE));
  if (!node || node.principal !== state.principal || node.tenantId !== state.tenantId) {
    throw new HTTPException(403, { message: 'state does not match your session' });
  }

  const account = await installationAccount(cfg, installationId);
  // Reconnect cleanly: revoke any live github connection first (uniqueness ignores revoked rows).
  const existing = await host.admin.listConnections(STAFF, { tenantId: node.tenantId, vertical: GIT_VERTICAL, provider: 'github' });
  for (const conn of existing) await host.admin.revokeConnection(STAFF, conn.id);
  await host.admin.createConnection(STAFF, {
    id: connectionId.parse(ulid()),
    tenantId: node.tenantId,
    vertical: GIT_VERTICAL,
    provider: 'github',
    label: account ? `GitHub — ${account}` : 'GitHub',
    externalAccountRef: account ?? undefined,
    scopes: ['contents:read', 'metadata:read'],
    secret: { installationId },
    createdBy: node.principal, // B: the authorizing principal, never STAFF.
  });
  // Back to the create-app flow; the Git card re-fetches and shows the repos. No query
  // suffix — it would land inside the hash fragment and break the SPA's route parse.
  return c.redirect('/#/apps/new');
});

/**
 * List the repos the tenant granted us — `{ connected: false }` when no connection
 * exists yet (the UI shows Connect). The installation token is minted fresh from the
 * stored installationId on each call, so nothing durable is a bearer secret.
 */
app.get('/api/github/repos', async (c) => {
  const cfg = githubConfig(c.env);
  if (!cfg) return c.json({ configured: false, connected: false, repos: [] });
  const host = hostFor(c.env);
  const node = await resolveAccount(host, c.env, getCookie(c, SESSION_COOKIE), getCookie(c, TEAM_COOKIE));
  if (!node) throw new HTTPException(401, { message: 'unauthorized' });
  const conn = (await host.admin.listConnections(STAFF, { tenantId: node.tenantId, vertical: GIT_VERTICAL, provider: 'github' }))[0];
  if (!conn) return c.json({ configured: true, connected: false, repos: [] });
  const open = await host.admin.openConnection(node.tenantId, GIT_VERTICAL, 'github');
  const installationId = open?.secret.installationId;
  if (!installationId) return c.json({ configured: true, connected: false, repos: [] });
  const repos = await listInstallationRepos(cfg, installationId);
  return c.json({ configured: true, connected: true, account: conn.externalAccountRef, repos });
});

/** The connected installation's id for this tenant, or null (worker-local helper). */
async function githubInstallationFor(
  host: ReturnType<typeof hostFor>,
  tenantId: DashboardNode['tenantId'],
): Promise<string | null> {
  const open = await host.admin.openConnection(tenantId, GIT_VERTICAL, 'github');
  return open?.secret.installationId ?? null;
}

/** A repo's branches — the import step's branch picker. */
app.get('/api/github/branches', async (c) => {
  const cfg = githubConfig(c.env);
  if (!cfg) throw new HTTPException(503, { message: 'GitHub is not configured' });
  const host = hostFor(c.env);
  const node = await resolveAccount(host, c.env, getCookie(c, SESSION_COOKIE), getCookie(c, TEAM_COOKIE));
  if (!node) throw new HTTPException(401, { message: 'unauthorized' });
  const repo = c.req.query('repo');
  if (!repo || !/^[^/\s]+\/[^/\s]+$/.test(repo)) throw new HTTPException(400, { message: 'missing or malformed repo (owner/name)' });
  const installationId = await githubInstallationFor(host, node.tenantId);
  if (!installationId) throw new HTTPException(409, { message: 'GitHub is not connected' });
  return c.json({ branches: await listRepoBranches(cfg, installationId, repo) });
});

const setupCiBody = z.object({
  repo: z.string().regex(/^[^/\s]+\/[^/\s]+$/),
  branch: z.string().min(1).max(200),
});

/**
 * One-click deploy setup on an imported repo (the git-import happy path): mint a
 * TENANT-SCOPED push token on the control plane (never the platform service token —
 * the token authenticates repo CI as a builder for this tenant only), write it as the
 * repo's `SUBSTRAT_SERVICE_TOKEN` Actions secret, and commit the deploy workflow to
 * the chosen branch. Authorized in-scope first (`begin-connection` = the
 * `dashboard:manage-integrations` check), the same gate as connecting GitHub itself.
 */
app.post('/api/github/setup-ci', async (c) => {
  const cfg = githubConfig(c.env);
  if (!cfg) throw new HTTPException(503, { message: 'GitHub is not configured' });
  const host = hostFor(c.env);
  const node = await resolveAccount(host, c.env, getCookie(c, SESSION_COOKIE), getCookie(c, TEAM_COOKIE));
  if (!node) throw new HTTPException(401, { message: 'unauthorized' });
  const body = setupCiBody.parse(await c.req.json());

  // Permission check, in-scope (throws → 403 via onError if the caller may not manage integrations).
  const dash = await host.getScope(node.principal, node.tenantId, node.scopeId);
  await dash.invoke('dashboard/begin-connection', { provider: 'github' });

  const installationId = await githubInstallationFor(host, node.tenantId);
  if (!installationId) throw new HTTPException(409, { message: 'GitHub is not connected' });

  const cp = controlPlaneFor(c.env, node.tenantId);
  const cpUrl = c.env.CP_PUBLIC_URL;
  if (!cp || !cpUrl) {
    throw new HTTPException(501, { message: 'one-click CI setup needs the shared control plane (CP_PUBLIC_URL) on this deployment' });
  }
  const { token, tenantSlug } = await cp.mintPushToken();

  const slug = slugify(body.repo.split('/').pop() ?? 'app');
  const workflowPath = '.github/workflows/substrat-deploy.yml';
  const result = await setupRepoCi(cfg, installationId, {
    repoFullName: body.repo,
    branch: body.branch,
    workflowPath,
    workflowContent: deployWorkflowYaml(body.branch, slug, cpUrl),
    secretName: 'SUBSTRAT_SERVICE_TOKEN',
    secretValue: token,
    seal: sealForGithub,
  });
  if ('needsPermissions' in result) {
    // Structured, not an HTTP error: the UI offers the re-approve link + manual path.
    return c.json({ ok: false, needsPermissions: true });
  }
  return c.json({
    ok: true,
    workflowPath,
    workflowUpdated: result.workflowUpdated,
    branch: body.branch,
    // What the pushed versions will be registered under (builder-plane.md §5).
    vertical: `${tenantSlug}/${slug}`,
  });
});

/** The manual path's copy-paste workflow — same generator as the committed one (github.ts). */
app.get('/api/github/workflow-preview', async (c) => {
  const node = await resolveAccount(hostFor(c.env), c.env, getCookie(c, SESSION_COOKIE), getCookie(c, TEAM_COOKIE));
  if (!node) throw new HTTPException(401, { message: 'unauthorized' });
  const repo = c.req.query('repo') ?? 'owner/app';
  const branch = c.req.query('branch') ?? 'main';
  const slug = slugify(repo.split('/').pop() ?? 'app');
  return c.json({
    workflowPath: '.github/workflows/substrat-deploy.yml',
    workflow: deployWorkflowYaml(branch, slug, c.env.CP_PUBLIC_URL ?? 'https://console.substrat.net/api'),
  });
});

app.onError((err, c) => {
  const status = err instanceof HTTPException ? err.status : 400;
  const m = err instanceof Error ? err.message : String(err);
  if (status === 400 && /permission denied/.test(m)) return c.json({ error: m }, 403);
  // A slug that isn't the caller's own deployment reads as not-found, not a leak.
  if (status === 400 && /not one of your deployments/.test(m)) return c.json({ error: m }, 404);
  return c.json({ error: m }, status);
});

export default app;
