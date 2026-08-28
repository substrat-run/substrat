/**
 * Manyfold (CMS) as a deployable Cloudflare Worker — SANDBOX-CLEAN and control-plane-less
 * (scope-local-permissions.md Phase 3; the policy "every vertical is sandbox-clean, only the
 * dashboard is privileged"). Its ONLY durable stores are its OWN DO classes: `SCOPE` (one
 * per site — kernel + the Manyfold module, bundled) and `AUTH` (identity, one per tenant).
 * No CONTROL_PLANE binding, no service binding, no ASSETS binding — assertSandboxContract
 * refuses those and the push would be rejected.
 *
 * MULTI-SCOPE is native here: one `SCOPE` namespace, `idFromName(tenant, site)` = one DO per
 * site. The router asserts the TENANT (+ a home site); the app selects the active site with
 * `x-scope`; the worker opens that site's DO and evaluates permissions from its own storage.
 * Reaching another tenant's scope is impossible — getScope validates the (tenant, scope) pair.
 *
 * Local run:  wrangler dev          (real workerd, no account; ALLOW_DEV_NODE)
 * Deploy:     substrat push         (into the WfP dispatch namespace)
 */
import { Hono } from 'hono';
import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { principalId, scopeId, tenantId, z, type PrincipalId, type TenantId, type ScopeId } from '@substrat-run/contracts';
import { defineScopeDO, CloudflareScopeHost } from '@substrat-run/adapter-cloudflare';
import { mountPlatformSurface } from '@substrat-run/vertical-host';
import { PLATFORM_REQUEST_HEADER, readRoutedNode, RouterAssertionError, ulid, type ScopeStub } from '@substrat-run/kernel';
import {
  IdentityDO,
  mintOwnerClaimLink,
  oidcAuthProvider,
  oidcRpAuthProvider,
  sha256Hex,
  type AuthProvider,
} from '@substrat-run/vertical-auth';
import { MODULES, ROLES } from './provision.js';
import { serveAsset } from './assets.js';
import { mountApi } from './routes.js';
import { API_DOCUMENT } from './api.js';
import { DOCS_HTML } from './docs.js';

/** The scope-DO class = the app binary: kernel + the Manyfold module, bundled. */
export const ScopeDO = defineScopeDO(MODULES, {});
/** The per-tenant identity DO (shared @substrat-run/vertical-auth) — bound as AUTH. */
export { IdentityDO };

interface SiteNode {
  tenantId: TenantId;
  scopeId: ScopeId;
}

// A fixed dev node (valid ULIDs) — ONLY the fallback for local `wrangler dev`, where there
// is no router to assert one, gated on ALLOW_DEV_NODE (never set in prod).
//
// This is an ADDRESS, not an identity: it says which instance an un-routed local request
// belongs to and grants nobody anything. The principal still comes from a verified login.
const DEV_NODE: SiteNode = {
  tenantId: tenantId.parse('01JZ0000000000000000MNY001'),
  scopeId: scopeId.parse('01JZ0000000000000000MNY002'),
};

interface Env {
  SCOPE: DurableObjectNamespace;
  AUTH: DurableObjectNamespace<IdentityDO>;
  AUTH_PROVIDER?: string;
  OIDC_ISSUER?: string;
  OIDC_AUDIENCE?: string;
  ALLOW_DEV_NODE?: string;
  ROUTER_SECRET?: string;
  PLATFORM_SECRET?: string;
}

/**
 * The routed (tenant, HOME site) — from the router assertion (or the dev node), with NO
 * app-level site selection applied. This is what the auth provider keys on (it needs only the
 * tenant — one IdentityDO per tenant), and the base that `nodeFor` refines with the app's
 * selected site.
 */
function baseNode(req: Request, env: Env): SiteNode {
  let routed;
  try {
    routed = readRoutedNode(req.headers, { expectedSecret: env.ROUTER_SECRET });
  } catch (e) {
    if (e instanceof RouterAssertionError) throw new HTTPException(400, { message: e.message });
    throw e;
  }
  const base: SiteNode | null = routed
    ? { tenantId: routed.tenantId, scopeId: routed.scopeId }
    : env.ALLOW_DEV_NODE === 'true'
      ? DEV_NODE
      : null;
  if (!base) throw new HTTPException(503, { message: 'no scope was asserted for this request (missing router assertion)' });
  return base;
}

/**
 * Which (tenant, SITE) this request is for. Tenant + home site come from the router assertion
 * (`baseNode`). The app may select ANOTHER site of the SAME tenant, either by scope id
 * (`x-scope`) or — how the in-app switcher does it — by site slug (`x-site`), resolved through
 * the tenant's own site registry (M2). Either way the selected scope is trusted only in that it
 * belongs to the asserted tenant: the registry is per-tenant, and `getScope` re-checks the
 * (tenant, scope) pair, so reaching a different tenant's scope is impossible.
 */
async function nodeFor(req: Request, env: Env): Promise<SiteNode> {
  const base = baseNode(req, env);
  const requested = req.headers.get('x-scope');
  const byId = requested ? scopeId.safeParse(requested) : null;
  if (byId?.success) return { tenantId: base.tenantId, scopeId: byId.data };
  const site = req.headers.get('x-site');
  if (site) {
    const resolved = await identityDo(env, base).resolveSiteScope(site);
    const bySlug = resolved ? scopeId.safeParse(resolved) : null;
    if (bySlug?.success) return { tenantId: base.tenantId, scopeId: bySlug.data };
  }
  return base;
}

function hostFor(env: Env): CloudflareScopeHost {
  const host = new CloudflareScopeHost({ scope: env.SCOPE });
  for (const m of MODULES) host.registerModule(m);
  return host;
}

const originOf = (req: Request): string => new URL(req.url).origin;
const identityDo = (env: Env, node: SiteNode) => env.AUTH.get(env.AUTH.idFromName(node.tenantId));

/**
 * The scope's DELIVERED auth choice (`substrat:auth`, the dashboard configured at install /
 * Settings), stored in the tenant's identity DO. OIDC-only (oidc-only-demos.md): `oidc` is the
 * only supported mode; a malformed / `builtin` entry fails this parse → "no choice delivered".
 */
const authChoice = z.object({
  mode: z.literal('oidc'),
  issuer: z.string().url().optional(),
  clientId: z.string().min(1).optional(),
  clientSecret: z.string().optional(),
  audience: z.string().optional(),
  cookieDomain: z.string().min(1).optional(),
});
const AUTH_CONFIG_KEY = 'substrat:auth';

/** The scope's auth wiring in one DO hop: the delivered choice + the tenant's session secret. */
async function authWiringFor(env: Env, base: SiteNode) {
  const wiring = await identityDo(env, base).authWiring(base.scopeId);
  const raw = wiring.config[AUTH_CONFIG_KEY];
  let choice: z.infer<typeof authChoice> | null = null;
  if (raw) {
    try {
      const parsed = authChoice.safeParse(JSON.parse(raw));
      choice = parsed.success ? parsed.data : null;
    } catch {
      choice = null;
    }
  }
  return { choice, sessionSecret: wiring.sessionSecret };
}

/**
 * The `AuthProvider` for this request, chosen by CONFIG (oidc-only-demos.md): the vertical runs
 * no credential store. A delivered `substrat:auth` (mode 'oidc') builds the relying-party
 * provider (browser login at the issuer, cookie sessions signed with the tenant's DO-minted
 * secret, bearer fallback for API clients); a standalone `AUTH_PROVIDER=oidc` verifies bearer
 * tokens against OIDC_ISSUER. Anything else is unconfigured — fail closed.
 */
async function authProviderFor(env: Env, req: Request): Promise<AuthProvider> {
  const base = baseNode(req, env);
  const { choice, sessionSecret } = await authWiringFor(env, base);
  if (choice?.mode === 'oidc') {
    if (!choice.issuer || !choice.clientId) {
      throw new HTTPException(503, { message: "this instance's OIDC configuration is incomplete — set issuer and clientId" });
    }
    return oidcRpAuthProvider({
      issuer: choice.issuer,
      clientId: choice.clientId,
      clientSecret: choice.clientSecret ?? '',
      sessionSecret,
      ...(choice.audience ? { audience: choice.audience } : {}),
      ...(choice.cookieDomain ? { cookieDomain: choice.cookieDomain } : {}),
    });
  }
  if (env.AUTH_PROVIDER === 'oidc') {
    if (!env.OIDC_ISSUER) throw new HTTPException(500, { message: 'AUTH_PROVIDER=oidc but OIDC_ISSUER is unset' });
    return oidcAuthProvider({ issuer: env.OIDC_ISSUER, ...(env.OIDC_AUDIENCE ? { audience: env.OIDC_AUDIENCE } : {}) });
  }
  throw new HTTPException(503, {
    message: "this instance has no identity provider configured — deliver substrat:auth with mode 'oidc'",
  });
}

/**
 * Resolve the caller → a PrincipalId in the selected site (provider-agnostic). Null ⇒ nobody.
 * ONE path in every environment: the `x-principal` branch that used to open this function
 * shipped an impersonation bypass one environment variable from being live.
 */
async function principalFor(env: Env, req: Request): Promise<PrincipalId | null> {
  const subject = await (await authProviderFor(env, req)).resolve(req.headers);
  if (!subject) return null;
  const node = await nodeFor(req, env);
  const principal = await identityDo(env, node).resolvePrincipal(node.scopeId, subject.sub);
  return principal ? principalId.parse(principal) : null;
}

const app = new Hono<{ Bindings: Env }>();

// Identity/credentials/sessions live entirely at the OIDC issuer (oidc-only-demos.md): the
// vertical runs no credential store and hosts no sign-up. `/api/auth/*` is the relying-party
// flow only (login → issuer → callback → session cookie → logout); the provider's handle 404s
// every other credential path (sign-up, password, reset), which live at the issuer.
app.on(['GET', 'POST'], '/api/auth/*', async (c) => (await authProviderFor(c.env, c.req.raw)).handle(c.req.raw));
app.get('/api/session', async (c) => c.json(await (await authProviderFor(c.env, c.req.raw)).resolve(c.req.raw.headers)));

// Who am I, in the selected site, and what may I do — needs-setup aware (first-run).
app.get('/api/me', async (c) => {
  const node = await nodeFor(c.req.raw, c.env);
  const principal = await principalFor(c.env, c.req.raw);
  if (!principal) {
    // An unclaimed seat says HOW it can be claimed (#925): by signing in, while the first-sign-in
    // window is open; by a claim link from the dashboard once it has closed. The SPA's copy
    // depends on which, and it must not offer a sign-in that binds nobody.
    const seat = await identityDo(c.env, node).ownerSeat(node.scopeId);
    return seat.state === 'unclaimed'
      ? c.json({ status: 'needs-setup', firstSignInOpen: seat.firstSignIn?.open ?? false })
      : c.json({ error: 'unauthorized' }, 401);
  }
  const scope = await hostFor(c.env).getScope(principal, node.tenantId, node.scopeId);
  const who = (await scope.invoke('manyfold/whoami', undefined)) as { can: Record<string, boolean> };
  const subject = await (await authProviderFor(c.env, c.req.raw)).resolve(c.req.raw.headers).catch(() => null);
  return c.json({ key: principal, display: subject?.name ?? subject?.email ?? 'You', site: node.scopeId, can: who.can });
});

// The tenant's sites — the in-app site switcher's list (M2). Tenant-level (not per-scope), so it
// reads from `baseNode` (the routed tenant) and needs no site selection; the app calls it at
// bootstrap, before a site is chosen. Empty until sites are provisioned. `{ slug, name }` mirrors
// the dev server's shape; the app selects a site by slug via `x-site`, which `nodeFor` resolves.
app.get('/api/sites', async (c) => {
  const sites = await identityDo(c.env, baseNode(c.req.raw, c.env)).listSites();
  return c.json(sites.map((s) => ({ slug: s.slug, name: s.name })));
});

const requestSiteBody = z.object({ slug: z.string().min(1), name: z.string().min(1) });

// Create a new site (multi-scope-manyfold.md M3). Runs `manyfold/request-site` as the caller in
// their current site (its permission check gates on `content:manage-sites`), enqueuing a platform
// intent the control plane drains. 202 + the request id (the app polls `/api/sites`); the stub's
// #458 hook flags the response for a prompt drain (the router kick, Phase D3), else the sweep catches it.
app.post('/api/sites', async (c) => {
  const scope = await stub(c);
  const result = await scope.invoke('manyfold/request-site', requestSiteBody.parse(await c.req.json()));
  return c.json(result as Record<string, unknown>, 202);
});

// Archive a site by slug. Runs `manyfold/archive-site` as the caller (its `content:manage-sites`
// gate), enqueuing an `archive-scope` intent the platform drains; then optimistically drops it from
// the tenant's registry so the switcher updates immediately (the platform archives it directory-side).
app.post('/api/sites/:slug/archive', async (c) => {
  const base = baseNode(c.req.raw, c.env);
  const id = identityDo(c.env, base);
  const target = await id.resolveSiteScope(c.req.param('slug'));
  if (!target) throw new HTTPException(404, { message: 'unknown site' });
  const scope = await stub(c);
  const result = await scope.invoke('manyfold/archive-site', { scopeId: target });
  await id.forgetSite(target);
  return c.json(result as Record<string, unknown>, 202);
});

// The platform's entire /internal/* contract — provision, reconcile, introspection, the
// read-only SQL console, platform-request drain, snapshot/delete/export/restore, and
// bookmarks/rewind — plus the guaranteed { error } envelope, authored once in
// @substrat-run/vertical-host (issue #510) and mounted here. Manyfold's provision hook
// also registers the site in the per-tenant registry (M2), and reconcile re-sources the
// owner from the durable owner-of-record for a #332 repair. No per-instance config here.
mountPlatformSurface<Env>(app, {
  platformSecret: (env) => env.PLATFORM_SECRET,
  hostFor,
  roles: ROLES,
  ownerRoleKey: 'admin',
  onProvision: async (env, b) => {
    const id = identityDo(env, { tenantId: b.tenantId, scopeId: b.scopeId });
    await id.setPendingOwner(b.scopeId, b.owner);
    // Remember this site in the vertical's own per-tenant registry (M2), so the app can list
    // and switch between its sites without reaching the control-plane directory. Idempotent.
    if (b.slug && b.name) await id.recordSite(b.scopeId, b.slug, b.name);
  },
  resolveOwner: async (env, ref) => {
    const owner = await identityDo(env, ref).getOwnerOfRecord(ref.scopeId);
    return owner ? principalId.parse(owner) : null;
  },
  // The owner seat as the platform may see it, and the claim link it may mint for one that
  // sits empty after the first-sign-in window (#925). Both read the same directory the
  // provision hook above writes.
  ownerSeat: (env, ref) => identityDo(env, ref).ownerSeat(ref.scopeId),
  mintOwnerClaim: (env, ref, input) => mintOwnerClaimLink(identityDo(env, ref), ref.scopeId, input.origin),
});

// Resolve the caller + selected site → a scope stub. 401 if nobody. Shared route table.
// The stub carries the #458 drain hint: any operation that enqueues a platform intent
// flags this response, and the router kicks an immediate drain (#381) — no per-route wiring.
async function stub(c: Context<{ Bindings: Env }>): Promise<ScopeStub> {
  const node = await nodeFor(c.req.raw, c.env);
  const principal = await principalFor(c.env, c.req.raw);
  if (!principal) throw new HTTPException(401, { message: 'unauthorized' });
  return hostFor(c.env).getScope(principal, node.tenantId, node.scopeId, {
    onPlatformRequests: () => c.header(PLATFORM_REQUEST_HEADER, '1'),
  });
}

// ── Members & invites (the post-setup join path — admin-only) ────────────────

/** Gate an admin-only action: resolve the caller's scope, then require content:admin. */
async function requireAdmin(c: Context<{ Bindings: Env }>): Promise<ScopeStub> {
  const scope = await stub(c);
  const who = (await scope.invoke('manyfold/whoami', undefined)) as { can: { admin: boolean } };
  if (!who.can.admin) throw new HTTPException(403, { message: 'only an admin can manage members' });
  return scope;
}

const inviteBody = z.object({ email: z.string().email().optional(), roleKey: z.string().min(1) });

/** Who I am, for the members view (display + role) — needs-setup aware handled by /api/me. */
app.get('/api/invites', async (c) => {
  const node = await nodeFor(c.req.raw, c.env);
  await requireAdmin(c);
  return c.json({ roles: ROLES.map((r) => r.key), invites: await identityDo(c.env, node).listInvites(node.scopeId) });
});

/** Create an invite: mint a member principal, grant it the chosen role at scope level, record
 *  the invite by token HASH (the plaintext token rides only in the returned accept link). */
app.post('/api/invites', async (c) => {
  const node = await nodeFor(c.req.raw, c.env);
  await requireAdmin(c);
  const { email, roleKey } = inviteBody.parse(await c.req.json());
  if (!ROLES.some((r) => r.key === roleKey)) throw new HTTPException(400, { message: `unknown role '${roleKey}'` });
  const principal = principalId.parse(ulid());
  const token = (crypto.randomUUID() + crypto.randomUUID()).replace(/-/g, ''); // 256 bits, URL-safe
  await hostFor(c.env).assignScopeRole(node.scopeId, principal, roleKey);
  await identityDo(c.env, node).createInvite(node.scopeId, principal, roleKey, email ?? null, await sha256Hex(token));
  return c.json({ principal, roleKey, email: email ?? null, acceptUrl: `${originOf(c.req.raw)}/?invite=${token}` }, 201);
});

app.post('/api/invites/:principal/revoke', async (c) => {
  const node = await nodeFor(c.req.raw, c.env);
  await requireAdmin(c);
  await identityDo(c.env, node).revokeInvite(node.scopeId, c.req.param('principal'));
  return c.body(null, 204);
});

/** Accept an invite: the invitee has signed up (allowed by the token), and now binds their
 *  login to the pre-minted member principal. */
app.post('/api/accept-invite', async (c) => {
  const node = await nodeFor(c.req.raw, c.env);
  const subject = await (await authProviderFor(c.env, c.req.raw)).resolve(c.req.raw.headers);
  if (!subject) throw new HTTPException(401, { message: 'sign in before accepting an invite' });
  const { token } = z.object({ token: z.string().min(1) }).parse(await c.req.json());
  const principal = await identityDo(c.env, node).claimInvite(node.scopeId, subject.sub, await sha256Hex(token));
  if (!principal) throw new HTTPException(400, { message: 'this invite is invalid or already used' });
  return c.json({ ok: true, principal });
});

/**
 * Claim the owner seat by link (#925): the installer signed in at the issuer and now presents
 * the token the dashboard minted for this workspace. Binds their subject → the owner principal,
 * which already holds `admin` from provision. One answer for every way it can fail, so a
 * probe learns nothing about which.
 */
app.post('/api/claim-owner', async (c) => {
  const node = await nodeFor(c.req.raw, c.env);
  const subject = await (await authProviderFor(c.env, c.req.raw)).resolve(c.req.raw.headers);
  if (!subject) throw new HTTPException(401, { message: 'sign in before claiming this workspace' });
  const { token } = z.object({ token: z.string().min(1) }).parse(await c.req.json());
  const principal = await identityDo(c.env, node).claimOwner(node.scopeId, subject.sub, await sha256Hex(token));
  if (!principal) throw new HTTPException(400, { message: 'this claim link is invalid, expired, or already used' });
  return c.json({ ok: true, principal });
});

// The OpenAPI document + Scalar reference (design/api-surface.md). Session-gated
// like the rest of /api/* — the spec enumerates the surface. The docs page
// redirects a signed-out human to the SPA's login instead of a bare 401.
app.get('/openapi.json', async (c) => {
  const principal = await principalFor(c.env, c.req.raw);
  if (!principal) throw new HTTPException(401, { message: 'unauthorized' });
  return c.json(API_DOCUMENT);
});
app.get('/api/docs', async (c) => {
  const principal = await principalFor(c.env, c.req.raw);
  if (!principal) return c.redirect('/');
  return c.html(DOCS_HTML);
});

mountApi(app, stub);

// Unmatched /api/* must fail as JSON — never fall through to the SPA. The dev server
// (server.ts) exposes some routes the worker doesn't (e.g. /api/personas); if those
// reached the catch-all they'd return index.html with a 200, and the client would parse
// the HTML as `{}` — silently turning `Persona[]` into an object and crashing `.find`.
app.all('/api/*', (c) => c.json({ error: `unknown route: ${new URL(c.req.raw.url).pathname}` }, 404));

// The SPA is inlined into the worker (no ASSETS binding — sandbox-clean); this is the
// catch-all behind /api/* and /internal/*.
app.all('*', (c) => serveAsset(new URL(c.req.raw.url)));

export default app;
