/**
 * Meridian (HR) vertical as a deployable Cloudflare Worker — SANDBOX-CLEAN and
 * control-plane-less (scope-local-permissions.md Phase 3), the shape a vertical must
 * have to be pushed into the Workers-for-Platforms dispatch namespace and provisioned
 * by the shared control plane (assertSandboxContract refuses a CONTROL_PLANE binding or
 * a service binding to a platform worker).
 *
 * One `ScopeDO` per scope (kernel + protocol engine + the Meridian module bundled) that
 * evaluates permissions from its OWN storage; a thin Hono API that authenticates →
 * getScope → invoke; the built SPA inlined into the worker (no ASSETS binding — WfP
 * static assets are a separate upload path). No ControlPlaneDO, no CONTROL_PLANE_SVC, no
 * Scrive cron — the router asserts the node, the shared plane owns the directory + audit.
 *
 * Local run:  wrangler dev            (real workerd, no account; ALLOW_DEV_HEADER)
 * Deploy:     substrat push           (into the WfP dispatch namespace) — see DEPLOY.md
 */
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { principalId, scopeId, tenantId, readScopeTableInput, z } from '@substrat-run/contracts';
import { defineScopeDO, CloudflareScopeHost } from '@substrat-run/adapter-cloudflare';
import {
  assertPlatformCall,
  PlatformCallError,
  readRoutedNode,
  RouterAssertionError,
  ulid,
} from '@substrat-run/kernel';
import type { PrincipalId } from '@substrat-run/contracts';
import { MODULES, ROLES } from './provision.js';
import { serveAsset } from './assets.js';
import type { CompanyNode } from './auth-adapters.js';
import { IdentityDO, doAuthProvider, oidcAuthProvider, type AuthProvider } from '@substrat-run/vertical-auth';

/** The scope-DO class = the app binary: kernel + protocol + Meridian, bundled. */
export const ScopeDO = defineScopeDO(MODULES, {});
/** The per-tenant identity DO (shared @substrat-run/vertical-auth) — bound as AUTH; wrangler needs the export. */
export { IdentityDO };

// A fixed dev node (valid ULIDs). Behind the router the node comes from the resolved
// hostname; this is ONLY the fallback for local `wrangler dev`, where there is no router
// to assert one, and is gated on ALLOW_DEV_HEADER (never set in prod).
const DEV_NODE: CompanyNode = {
  tenantId: tenantId.parse('01JZ0000000000000000MER001'),
  scopeId: scopeId.parse('01JZ0000000000000000MER002'),
};

interface Env {
  // A sandbox-clean vertical (scope-local-permissions.md Phase 3): its ONLY durable stores
  // are its OWN DO classes — SCOPE (business data, per scope) and AUTH (identity, per
  // tenant). No shared D1 `AUTH_DB`, no CONTROL_PLANE binding, no service binding — all
  // refused by assertSandboxContract. AUTH being an OWN class is what keeps it legal.
  SCOPE: DurableObjectNamespace;
  AUTH: DurableObjectNamespace<IdentityDO>;
  /**
   * Which auth the app runs — the config section. `better-auth-do` (default): Better Auth
   * in the per-tenant AUTH DO. `oidc`: verify a bearer token against an OIDC issuer
   * (`OIDC_ISSUER` [+ `OIDC_AUDIENCE`]) — covers Supabase, Auth0, AuthHero, Keycloak, …
   * The app never changes; only this config + the provider behind the contract does.
   */
  AUTH_PROVIDER?: string;
  OIDC_ISSUER?: string;
  OIDC_AUDIENCE?: string;
  // No BETTER_AUTH_SECRET: the IdentityDO generates its own per-tenant signing secret in
  // its own storage, so there is no shared worker secret to set. The built SPA is inlined
  // into the worker (src/assets.ts) — no ASSETS binding here either.
  /** Local dev only: when 'true', trust the `x-principal` header. NEVER set in prod. */
  ALLOW_DEV_HEADER?: string;
  /** Shared secret the router presents (K-26): how the vertical knows the asserted node came from the router. */
  ROUTER_SECRET?: string;
  /** Shared secret the CONTROL PLANE presents to provision/link here (K-31). Unset ⇒ refused. */
  PLATFORM_SECRET?: string;
}

/**
 * Which tenant/scope this request is for. Behind the router: whatever the hostname
 * resolved to (signed headers). Local dev (ALLOW_DEV_HEADER): the fixed dev node.
 * Neither: refuse — an unrouted request in a multi-tenant deployment has no defensible
 * default, and picking one would mean serving somebody else's data.
 */
function nodeFor(req: Request, env: Env): CompanyNode {
  let routed;
  try {
    routed = readRoutedNode(req.headers, { expectedSecret: env.ROUTER_SECRET });
  } catch (e) {
    if (e instanceof RouterAssertionError) throw new HTTPException(400, { message: e.message });
    throw e;
  }
  if (routed) return { tenantId: routed.tenantId, scopeId: routed.scopeId };
  if (env.ALLOW_DEV_HEADER === 'true') return DEV_NODE;
  throw new HTTPException(503, { message: 'no scope was asserted for this request (missing router assertion)' });
}

/**
 * The coordinator is stateless — rebuilt per request; durable state is in the DOs.
 * CP-less: NO control plane. Permissions evaluate from each scope's own storage; the
 * router asserts the node, so this vertical trusts it rather than reading a directory it
 * has no binding to. Its only durable stores are its own `SCOPE` DO class and `AUTH_DB`.
 */
function hostFor(env: Env): CloudflareScopeHost {
  const host = new CloudflareScopeHost({ scope: env.SCOPE });
  for (const m of MODULES) host.registerModule(m);
  return host;
}

const originOf = (req: Request): string => new URL(req.url).origin;

/** SHA-256 hex of a string (Web Crypto — same in workerd, Node, browsers). Invite tokens are
 *  stored + compared only as hashes, so a DB read never yields a usable token. */
async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** The tenant's identity DO stub — the sub→principal directory (and Better Auth, if chosen). */
function identityDo(env: Env, node: CompanyNode) {
  return env.AUTH.get(env.AUTH.idFromName(node.tenantId));
}

/**
 * The `AuthProvider` for this request, chosen by CONFIG — the whole point of the contract.
 * `oidc` verifies a bearer token against the configured issuer (Supabase / Auth0 / AuthHero
 * / Keycloak); default `better-auth-do` runs Better Auth in the tenant's AUTH DO. The app
 * never learns which; it only ever holds an `AuthProvider`.
 */
function authProviderFor(env: Env, req: Request): AuthProvider {
  if ((env.AUTH_PROVIDER ?? 'better-auth-do') === 'oidc') {
    if (!env.OIDC_ISSUER) throw new HTTPException(500, { message: 'AUTH_PROVIDER=oidc but OIDC_ISSUER is unset' });
    return oidcAuthProvider({ issuer: env.OIDC_ISSUER, ...(env.OIDC_AUDIENCE ? { audience: env.OIDC_AUDIENCE } : {}) });
  }
  return doAuthProvider(identityDo(env, nodeFor(req, env)), originOf(req));
}

/**
 * Resolve the caller to a PrincipalId for op invocation, PROVIDER-AGNOSTICALLY: the dev
 * header (local only), else the configured provider verifies the request → a subject, and
 * the tenant's identity DO maps that subject → a principal in this scope (claiming the
 * owner seat on first login). Null ⇒ nobody (fail closed).
 */
async function principalFor(env: Env, req: Request): Promise<PrincipalId | null> {
  if (env.ALLOW_DEV_HEADER === 'true') {
    const raw = req.headers.get('x-principal');
    const parsed = raw ? principalId.safeParse(raw) : null;
    if (parsed?.success) return parsed.data;
  }
  const subject = await authProviderFor(env, req).resolve(req.headers);
  if (!subject) return null;
  const node = nodeFor(req, env);
  const principal = await identityDo(env, node).resolvePrincipal(node.scopeId, subject.sub);
  return principal ? principalId.parse(principal) : null;
}

const provisionInstanceBody = z.object({
  tenantId,
  scopeId,
  owner: principalId,
  slug: z.string().min(1),
  name: z.string().min(1),
});

const app = new Hono<{ Bindings: Env }>();

/**
 * Open sign-up is allowed ONLY during first-run setup (the owner seat unclaimed). Once the
 * admin has claimed it, this instance is invite-only: a stranger who finds the URL can no
 * longer self-register. (Better-Auth-DO only; an OIDC deployment never hits this route — its
 * users come from the issuer.) Must be registered BEFORE the /api/auth/* catch-all forward.
 */
app.post('/api/auth/sign-up/email', async (c) => {
  const node = nodeFor(c.req.raw, c.env);
  const id = identityDo(c.env, node);
  // Allowed during first-run setup (creates the admin), OR when the request carries a valid
  // unclaimed invite token (`?invite=<token>`) — that's how an invited teammate registers
  // after the workspace is closed. Anything else is refused.
  const token = new URL(c.req.raw.url).searchParams.get('invite');
  const allowed =
    (await id.needsSetup(node.scopeId)) || (token ? await id.inviteExists(node.scopeId, await sha256Hex(token)) : false);
  if (!allowed) {
    return c.json({ error: 'Sign-up is closed for this workspace — ask an admin to invite you.' }, 403);
  }
  return authProviderFor(c.env, c.req.raw).handle(c.req.raw);
});

// Identity/credentials/sessions live in the tenant's own AuthDO — the worker just forwards
// the /api/auth/* surface to it through the AuthProvider contract (it never runs Better Auth).
app.on(['GET', 'POST'], '/api/auth/*', (c) => authProviderFor(c.env, c.req.raw).handle(c.req.raw));

/** The verified subject behind the current session, or null — the contract's `resolve`. */
app.get('/api/session', async (c) => c.json(await authProviderFor(c.env, c.req.raw).resolve(c.req.raw.headers)));

/**
 * Provision ONE instance on the platform's instruction (K-31), CP-less. The shared
 * control plane already owns this scope's directory row + entitlements (the dashboard
 * wrote them before calling here), so the vertical sets up only the scope's OWN state:
 * migrate the module tables, project the role defs, grant the owner `hr-admin` at scope
 * level. No tenant, no control plane. Platform-secret gated; NOT under /api/*. Idempotent.
 */
app.post('/internal/provision', async (c) => {
  try {
    assertPlatformCall(c.req.raw.headers, { expectedSecret: c.env.PLATFORM_SECRET });
  } catch (e) {
    if (e instanceof PlatformCallError) throw new HTTPException(403, { message: e.message });
    throw e;
  }
  const body = provisionInstanceBody.parse(await c.req.json());
  await hostFor(c.env).provisionScopeLocal({
    tenantId: body.tenantId,
    scopeId: body.scopeId,
    owner: body.owner,
    roles: ROLES,
    ownerRoleKey: 'hr-admin',
  });
  // Record the owner seat: whoever first signs in and reaches this scope claims it (becomes
  // hr-admin), whichever provider verifies them. This is how a provisioned instance becomes
  // usable by a real login without the platform knowing the login's subject up front.
  await identityDo(c.env, { tenantId: body.tenantId, scopeId: body.scopeId }).setPendingOwner(body.scopeId, body.owner);
  return c.json({ tenantId: body.tenantId, scopeId: body.scopeId, owner: body.owner }, 201);
});

/**
 * Read-only introspection of a scope's OWN database on the platform's instruction
 * (kernel-design §5.4's admin-query RPC) — this is what the console/dashboard "Data"
 * view reads. The scope's data DO lives HERE (K-31), so the control plane delegates to
 * the vertical; the scope id is trusted from the platform-secret-gated call (the control
 * plane already did the K-3 cross-check + audit). Read-only, table-shaped, no SQL.
 */
app.get('/internal/tables', async (c) => {
  try {
    assertPlatformCall(c.req.raw.headers, { expectedSecret: c.env.PLATFORM_SECRET });
  } catch (e) {
    if (e instanceof PlatformCallError) throw new HTTPException(403, { message: e.message });
    throw e;
  }
  const scope = scopeId.parse(c.req.query('scopeId'));
  return c.json(await hostFor(c.env).introspectScopeTables(scope));
});

app.get('/internal/tables/:table', async (c) => {
  try {
    assertPlatformCall(c.req.raw.headers, { expectedSecret: c.env.PLATFORM_SECRET });
  } catch (e) {
    if (e instanceof PlatformCallError) throw new HTTPException(403, { message: e.message });
    throw e;
  }
  const scope = scopeId.parse(c.req.query('scopeId'));
  const input = readScopeTableInput.parse({
    table: c.req.param('table'),
    limit: c.req.query('limit') ? Number(c.req.query('limit')) : undefined,
    offset: c.req.query('offset') ? Number(c.req.query('offset')) : undefined,
  });
  return c.json(await hostFor(c.env).introspectScopeTable(scope, input));
});

// Scope-storage lifecycle (preview-and-snapshots.md §9): copy a scope into a sibling
// DO / wipe a reaped fork — both inside this deployment; no bytes cross the boundary.
app.post('/internal/snapshot', async (c) => {
  try {
    assertPlatformCall(c.req.raw.headers, { expectedSecret: c.env.PLATFORM_SECRET });
  } catch (e) {
    if (e instanceof PlatformCallError) throw new HTTPException(403, { message: e.message });
    throw e;
  }
  const body = z
    .object({ sourceScopeId: scopeId, newScopeId: scopeId })
    .parse(await c.req.json());
  return c.json(await hostFor(c.env).snapshotScopeLocal(body.sourceScopeId, body.newScopeId), 201);
});

app.post('/internal/delete-scope', async (c) => {
  try {
    assertPlatformCall(c.req.raw.headers, { expectedSecret: c.env.PLATFORM_SECRET });
  } catch (e) {
    if (e instanceof PlatformCallError) throw new HTTPException(403, { message: e.message });
    throw e;
  }
  const body = z.object({ scopeId }).parse(await c.req.json());
  await hostFor(c.env).deleteScopeLocal(body.scopeId);
  return c.json({ deleted: body.scopeId });
});

/** Resolve the caller (any provider) → the routed node → a scope stub. 401 if nobody. */
async function stub(c: { env: Env; req: { raw: Request } }) {
  const node = nodeFor(c.req.raw, c.env);
  const principal = await principalFor(c.env, c.req.raw);
  if (!principal) throw new HTTPException(401, { message: 'unauthorized' });
  // CP-less: lifecycle is the router's gate — it forwards only an active scope and asserts
  // the node. The vertical trusts that node and opens the scope; permissions evaluate locally.
  return hostFor(c.env).getScope(principal, node.tenantId, node.scopeId);
}

/**
 * Gate an admin-only action: resolve the caller's scope, then require they hold `hr-admin`
 * (managing who can access the workspace is the owner/admin's authority). `hr/whoami` reads
 * the role from the scope's own grants, so this is the scope-local permission model, not a
 * second source of truth. Throws 401 (no session) / 403 (not an admin).
 */
async function requireAdmin(c: { env: Env; req: { raw: Request } }) {
  const scope = await stub(c);
  const who = (await scope.invoke('hr/whoami', undefined)) as { role: string };
  if (who.role !== 'hr-admin') throw new HTTPException(403, { message: 'only an admin can manage invites' });
  return scope;
}

const inviteBody = z.object({
  email: z.string().email().optional(),
  /** One of the vertical's roles (hr-admin | manager | payroll) — validated against ROLES. */
  roleKey: z.string().min(1),
});

/**
 * Who am I, in the shape the SPA centres on: `{ key, display, role, country, employeeId }`.
 * The principal comes from the auth seam; the role hint + linked employee come from the
 * scope itself (`hr/whoami`), so a real hosted owner (holding `hr-admin`) lands on the
 * admin surface and an employee on their own work — the same shape the dev server serves.
 */
app.get('/api/me', async (c) => {
  const node = nodeFor(c.req.raw, c.env);
  // Resolve the caller via the configured provider (Better-Auth-DO / OIDC), mapping the
  // subject → principal (claiming the owner seat on first login).
  const principal = await principalFor(c.env, c.req.raw);
  if (!principal) {
    // No principal yet. If the owner seat is unclaimed, this instance is awaiting first-run
    // setup — tell the SPA to show "create the admin account", not a bare sign-in.
    const needsSetup = await identityDo(c.env, node).needsSetup(node.scopeId);
    return needsSetup ? c.json({ status: 'needs-setup' }) : c.json({ error: 'unauthorized' }, 401);
  }
  const scope = await hostFor(c.env).getScope(principal, node.tenantId, node.scopeId);
  const who = (await scope.invoke('hr/whoami', undefined)) as {
    role: string;
    country: 'SE' | 'ES';
    employeeId: string | null;
  };
  // A display name when the provider carries one (the dev-header path carries none) — the
  // subject is cheap to re-resolve and keeps the SPA shape total.
  const subject = await authProviderFor(c.env, c.req.raw).resolve(c.req.raw.headers).catch(() => null);
  return c.json({
    key: principal,
    display: subject?.name ?? subject?.email ?? 'You',
    role: who.role,
    country: who.country,
    employeeId: who.employeeId,
  });
});

/**
 * The persona switcher is a DEV affordance (the demo's cast of characters). A real hosted
 * instance has one signed-in user and no cast, so this is empty — the app hides the
 * switcher when the cast is empty. Kept as an explicit route (rather than a 404 the SPA
 * catch-all would swallow) so the client gets clean JSON.
 */
app.get('/api/cast', (c) => c.json([]));

/**
 * Invites (the post-setup join path — invite-only, decision with the team). Admin-only.
 * Creating one pre-mints a member principal, grants it the chosen role at scope level, and
 * records the invite in the tenant's identity DO keyed by the token's hash; the plaintext
 * token rides only in the returned accept link. The roles a teammate can be invited at are
 * this vertical's ROLES (hr-admin | manager | payroll) — employees are added separately.
 */
app.get('/api/invites', async (c) => {
  const node = nodeFor(c.req.raw, c.env);
  await requireAdmin(c);
  return c.json({ roles: ROLES.map((r) => r.key), invites: await identityDo(c.env, node).listInvites(node.scopeId) });
});

app.post('/api/invites', async (c) => {
  const node = nodeFor(c.req.raw, c.env);
  await requireAdmin(c);
  const { email, roleKey } = inviteBody.parse(await c.req.json());
  if (!ROLES.some((r) => r.key === roleKey)) throw new HTTPException(400, { message: `unknown role '${roleKey}'` });
  const principal = principalId.parse(ulid());
  // A long, URL-safe token; only its hash is stored. Two UUIDs = 256 bits of entropy.
  const token = (crypto.randomUUID() + crypto.randomUUID()).replace(/-/g, '');
  await hostFor(c.env).assignScopeRole(node.scopeId, principal, roleKey);
  await identityDo(c.env, node).createInvite(node.scopeId, principal, roleKey, email ?? null, await sha256Hex(token));
  return c.json({ principal, roleKey, email: email ?? null, acceptUrl: `${originOf(c.req.raw)}/?invite=${token}` }, 201);
});

app.post('/api/invites/:principal/revoke', async (c) => {
  const node = nodeFor(c.req.raw, c.env);
  await requireAdmin(c);
  await identityDo(c.env, node).revokeInvite(node.scopeId, c.req.param('principal'));
  return c.body(null, 204);
});

/**
 * Accept an invite: the invitee has just signed up (with the token, so sign-up was allowed),
 * and now claims it while authenticated. Binds their subject → the invite's pre-minted
 * principal in the identity directory; `/api/me` then resolves them as that member.
 */
app.post('/api/accept-invite', async (c) => {
  const node = nodeFor(c.req.raw, c.env);
  const subject = await authProviderFor(c.env, c.req.raw).resolve(c.req.raw.headers);
  if (!subject) throw new HTTPException(401, { message: 'sign in before accepting an invite' });
  const { token } = z.object({ token: z.string().min(1) }).parse(await c.req.json());
  const principal = await identityDo(c.env, node).claimInvite(node.scopeId, subject.sub, await sha256Hex(token));
  if (!principal) throw new HTTPException(400, { message: 'this invite is invalid or already used' });
  return c.json({ ok: true, principal });
});

// Generic invoke: the kernel checks the permission inside every operation, so a generic
// route is exactly as safe as an explicit table — and far less code.
app.post('/api/invoke', async (c) => {
  const { op, input } = await c.req.json<{ op: string; input?: unknown }>();
  return c.json((await (await stub(c)).invoke(op, input)) ?? null);
});

// Serve the inlined SPA for everything that isn't an /api or /internal route. MUST come
// after all those routes so Hono handles /api/auth/* etc. first; the catch-all then serves
// the bundled SPA (src/assets.ts), returning index.html for unknown client routes.
app.all('*', (c) => serveAsset(new URL(c.req.url)));

app.onError((err, c) => {
  const status = err instanceof HTTPException ? err.status : 400;
  const m = err instanceof Error ? err.message : String(err);
  if (status === 400 && /permission denied/.test(m)) return c.json({ error: m }, 403);
  if (status === 400 && /not found|unknown scope/.test(m)) return c.json({ error: m }, 404);
  return c.json({ error: m }, status);
});

export default app;
