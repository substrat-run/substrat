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
import { principalId, scopeId, tenantId, orgId, platformActorId, connectionId, readScopeTableInput, z, type PermissionKey, type TenantId } from '@substrat-run/contracts';
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
import { CATALOG, ensureCatalog, availableCatalog } from './catalog.js';
import { mountOidcRoutes, verifySession, SESSION_COOKIE, type OidcEnv } from '@substrat-run/oidc-rp';
import { dashboardModule, type DashboardAppRow } from './module.js';
import { createApp, deprovisionApp, retryApp, updateApp, snapshotApp, listAppSnapshots, deleteAppSnapshot, provisionDashboard, reconcileRoles, ensureRosterSeeded, slugify, type DashboardNode } from './provision.js';
import { listDeploymentsFromCp, listDeploymentsFromHost, verticalDeploymentFromCp, verticalDeploymentFromHost, assertOwned } from './deployments.js';
import { TenantNarrowedControlPlane } from './authority.js';
import { transportFor, senderFor, teamInviteEmail } from './email.js';
import { githubConfig, installUrl, installationAccount, listInstallationRepos, listRepoBranches, setupRepoCi } from './github.js';
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
async function createTeam(host: ScopeHost, user: { id: string; email?: string | null }, name: string): Promise<DashboardNode> {
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
  return { tenantId: t, scopeId: s, principal: owner };
}

const createAppBody = z.object({
  verticalSlug: z.string().min(1),
  name: z.string().min(1),
});

// A builder self-serves dev/staging only; prod is refused in the handler (model B).
const promoteBody = z.object({
  channel: z.enum(['dev', 'staging', 'prod']),
  versionId: z.string().min(1),
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
): Promise<{ entitlements: string[]; ownerGrants: PermissionKey[] }> {
  await ensureCatalog(host, STAFF);
  const registered = (await host.admin.listVerticals(STAFF)).find((v) => v.slug === slug);
  const cat = CATALOG[slug];
  if (registered || cat) {
    return {
      entitlements: registered?.entitlements ?? cat?.entitlements ?? [],
      ownerGrants: (registered?.ownerGrants ?? cat?.ownerGrants ?? []) as PermissionKey[],
    };
  }
  // Connected mode: a pushed vertical registers on the SHARED plane, not this deployment's
  // own registry — read its install spec from there (visibility-filtered to published + the
  // caller's own, so a private slug from another tenant stays unknown here).
  const remote = cp ? (await cp.listCatalog()).find((v) => v.slug === slug) : undefined;
  if (!remote) throw new HTTPException(400, { message: `unknown vertical '${slug}'` });
  return {
    entitlements: remote.entitlements ?? [],
    ownerGrants: (remote.ownerGrants ?? []) as PermissionKey[],
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
        rows.push({ slug: v.slug, name: v.name, owned: v.owned, listed: v.listed, source: v.source });
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
  const node = await createTeam(host, user, name);
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
    } catch {
      // an already-unlinked member (e.g. left earlier) is fine
    }
  }
  deleteCookie(c, TEAM_COOKIE, { path: '/' });
  return c.body(null, 204);
});

/** The current team's roster — active members + outstanding invites. */
app.get('/api/members', async (c) => {
  const host = hostFor(c.env);
  const node = await resolveAccount(host, c.env, getCookie(c, SESSION_COOKIE), getCookie(c, TEAM_COOKIE));
  if (!node) throw new HTTPException(401, { message: 'unauthorized' });
  const scope = await host.getScope(node.principal, node.tenantId, node.scopeId);
  return c.json(await scope.invoke('dashboard/list-members', {}));
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
  setCookie(c, TEAM_COOKIE, t, teamCookieOpts(new URL(c.req.url).protocol));
  return c.json({ teamId: t });
});

/** My apps. */
app.get('/api/apps', async (c) => {
  const host = hostFor(c.env);
  const node = await resolveAccount(host, c.env, getCookie(c, SESSION_COOKIE), getCookie(c, TEAM_COOKIE));
  if (!node) throw new HTTPException(401, { message: 'unauthorized' });
  const dash = await host.getScope(node.principal, node.tenantId, node.scopeId);
  return c.json(await dash.invoke('dashboard/list-apps', {}));
});

/**
 * One app's audit trail (Activity panel) — created / active / failed(+reason) / deleted.
 * Read from the caller's OWN dashboard scope, so the events are naturally tenant-scoped:
 * another tenant's app-scope-id has no events here.
 */
app.get('/api/apps/:scopeId/events', async (c) => {
  const host = hostFor(c.env);
  const node = await resolveAccount(host, c.env, getCookie(c, SESSION_COOKIE), getCookie(c, TEAM_COOKIE));
  if (!node) throw new HTTPException(401, { message: 'unauthorized' });
  const dash = await host.getScope(node.principal, node.tenantId, node.scopeId);
  return c.json(await dash.invoke('dashboard/app-events', { appScopeId: c.req.param('scopeId') }));
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
  const dash = await host.getScope(node.principal, node.tenantId, node.scopeId);
  const apps = (await dash.invoke('dashboard/list-apps', {})) as DashboardAppRow[];
  const appRow = apps.find((a) => a.app_scope_id === c.req.param('scopeId'));
  if (!appRow) throw new HTTPException(404, { message: 'app not found' });
  const cp = controlPlaneFor(c.env, node.tenantId);
  const scope = scopeId.parse(appRow.app_scope_id);
  // The vertical's version registry AND the version THIS scope is actually pinned to
  // (the router dispatches on the latter). They differ when prod moved after install —
  // which is exactly the "the tab says 0.0.12 but I run 0.0.9" confusion this answers.
  const [deployment, boundVersionId] = cp
    ? await Promise.all([verticalDeploymentFromCp(cp, appRow.vertical_slug), cp.boundVersionId(scope)])
    : await Promise.all([
        verticalDeploymentFromHost(host, STAFF, appRow.vertical_slug),
        host.admin.getScopeRecord(STAFF, node.tenantId, scope).then((r) => r?.verticalVersionId ?? null),
      ]);
  return c.json({ ...deployment, boundVersionId });
});

/**
 * One app's Data tab — a read-only window into the app's OWN database (kernel-design
 * §5.4's admin-query RPC). Two reads: the table list, and a bounded page of one table.
 *
 * Authorized in the caller's OWN dashboard scope: the app is resolved from the
 * tenant-scoped `list-apps`, so another tenant's scope id is a 404 here — and the
 * platform layer cross-checks (tenantId, scopeId) again below (K-3). Connected mode
 * reads through the tenant-narrowed control plane; embedded mode reads the host
 * directly with the platform STAFF actor. Read-only by construction — no user SQL.
 */
app.get('/api/apps/:scopeId/tables', async (c) => {
  const host = hostFor(c.env);
  const node = await resolveAccount(host, c.env, getCookie(c, SESSION_COOKIE), getCookie(c, TEAM_COOKIE));
  if (!node) throw new HTTPException(401, { message: 'unauthorized' });
  const dash = await host.getScope(node.principal, node.tenantId, node.scopeId);
  const apps = (await dash.invoke('dashboard/list-apps', {})) as DashboardAppRow[];
  const appRow = apps.find((a) => a.app_scope_id === c.req.param('scopeId'));
  if (!appRow) throw new HTTPException(404, { message: 'app not found' });
  const scope = scopeId.parse(appRow.app_scope_id);
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
  const appRow = apps.find((a) => a.app_scope_id === c.req.param('scopeId'));
  if (!appRow) throw new HTTPException(404, { message: 'app not found' });
  const scope = scopeId.parse(appRow.app_scope_id);
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
  // registry carries it), so a pushed builder vertical works the same as a builtin — the
  // catalog is only a fallback for a not-yet-seeded registry.
  await ensureCatalog(host, STAFF);
  const registered = (await host.admin.listVerticals(STAFF)).find((v) => v.slug === appRow.vertical_slug);
  const spec = registered?.envSpec ?? CATALOG[appRow.vertical_slug]?.envSpec ?? [];
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
  if (entries.length === 0) return c.json({ saved: 0 });
  return c.json(await dash.invoke('dashboard/set-app-env', { appScopeId: appRow.app_scope_id, entries }));
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

/** Create an app — provisioned into MY tenant (from the session), authorized in-scope. */
app.post('/api/apps', async (c) => {
  const host = hostFor(c.env);
  const node = await resolveAccount(host, c.env, getCookie(c, SESSION_COOKIE), getCookie(c, TEAM_COOKIE));
  if (!node) throw new HTTPException(401, { message: 'unauthorized' });
  const body = createAppBody.parse(await c.req.json());
  // Connected (prod): provision on the shared control plane through the tenant-narrowed
  // seam so the app is reachable via the router. Absent the binding: the M0 embedded path.
  const cp = controlPlaneFor(c.env, node.tenantId);
  const { entitlements, ownerGrants } = await installSpecFor(host, body.verticalSlug, cp);
  const user = await verifySession(c.env, getCookie(c, SESSION_COOKIE));
  // The team's human handle, suffixed into the default hostname
  // (`callout-sesamy.global.substrat.run`). From the TEAM record, not the user.
  const team = await host.admin.getTenant(STAFF, node.tenantId);
  const teamHandle = team?.name ? slugify(team.name) : undefined;
  const appRow = await createApp(host, {
    node,
    appScopeId: scopeId.parse(ulid()),
    verticalSlug: body.verticalSlug,
    name: body.name,
    appEntitlements: entitlements,
    appOwnerGrants: ownerGrants,
    teamHandle,
    controlPlane: cp ?? undefined,
    tenantName: user?.name ?? user?.email ?? 'Workspace',
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
  const user = await verifySession(c.env, getCookie(c, SESSION_COOKIE));
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
    tenantName: user?.name ?? user?.email ?? 'Workspace',
  });
  return c.json(appRowNew, 201);
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
 * Promote one of MY verticals to a NON-PROD channel. `prod` is refused here — production
 * promotion + admission stay a staff decision (model B, self-serve-deploy.md §3). The slug
 * is verified to be one of the caller's own deployments before anything is promoted.
 */
app.post('/api/deployments/:slug/promote', async (c) => {
  const host = hostFor(c.env);
  const node = await resolveAccount(host, c.env, getCookie(c, SESSION_COOKIE), getCookie(c, TEAM_COOKIE));
  if (!node) throw new HTTPException(401, { message: 'unauthorized' });
  const body = promoteBody.parse(await c.req.json());
  if (body.channel === 'prod') {
    throw new HTTPException(403, { message: 'production is promoted by the Substrat team' });
  }
  const slug = c.req.param('slug');
  const cp = controlPlaneFor(c.env, node.tenantId);
  if (cp) {
    assertOwned(await listDeploymentsFromCp(cp), slug); // your vertical, or 4xx
    await cp.promote(slug, body.channel, body.versionId);
  } else {
    assertOwned(await listDeploymentsFromHost(host, STAFF, node.tenantId), slug);
    await host.admin.promoteVersion(STAFF, slug, body.channel, body.versionId);
  }
  return c.body(null, 204);
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

/**
 * The workflow the setup commits — kept in the worker (not the SPA) so the committed
 * file and the manual instructions can never drift from what the platform expects.
 * Exported to the UI via `GET /api/github/workflow-preview` for the manual path.
 */
function deployWorkflowYaml(branch: string, slug: string, cpUrl: string): string {
  return `name: Deploy to Substrat
on:
  push:
    branches: [${branch}]
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - run: npx @substrat-run/cli push . --slug ${slug} --version 0.1.\${{ github.run_number }}
        env:
          SUBSTRAT_SERVICE_TOKEN: \${{ secrets.SUBSTRAT_SERVICE_TOKEN }}
          SUBSTRAT_CP_URL: ${cpUrl}
`;
}

/** The manual path's copy-paste workflow — same generator as the committed one. */
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
