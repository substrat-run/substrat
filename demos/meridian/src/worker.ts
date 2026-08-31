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
 * Local run:  wrangler dev            (real workerd, no account; ALLOW_DEV_NODE)
 * Deploy:     substrat push           (into the WfP dispatch namespace) — see DEPLOY.md
 */
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { principalId, scopeId, tenantId, z,
  isPage,
  nextPageLink,
  PAGE_LINK_HEADER,
} from '@substrat-run/contracts';
import { defineScopeDO, CloudflareScopeHost } from '@substrat-run/adapter-cloudflare';
import { mountPlatformSurface } from '@substrat-run/vertical-host';
import {
  PLATFORM_REQUEST_HEADER,
  readRoutedNode,
  RouterAssertionError,
  ulid,
} from '@substrat-run/kernel';
import { declareScriveConnector } from '@substrat-run/connector-scrive';
import type { PrincipalId, ScopeId, TenantId } from '@substrat-run/contracts';
import { EMPLOYEE_SELF, MODULES, ROLES } from './provision.js';
import { MERIDIAN_ENV } from './manifest.js';
import { API, API_DOCUMENT } from './api.js';
import { DOCS_HTML } from './docs.js';
import {
  AuthConfigError,
  IdentityDO,
  instanceAuthFor,
  mintOwnerClaimLink,
  sha256Hex,
  type AuthProvider,
} from '@substrat-run/vertical-auth';

/** The scope-DO class = the app binary: kernel + protocol + Meridian, bundled. */
export const ScopeDO = defineScopeDO(MODULES, {});
/** The per-tenant identity DO (shared @substrat-run/vertical-auth) — bound as AUTH; wrangler needs the export. */
export { IdentityDO };

/** The (tenant, scope) a request is addressed to. */
export interface CompanyNode {
  tenantId: TenantId;
  scopeId: ScopeId;
}

// A fixed dev node (valid ULIDs). Behind the router the node comes from the resolved
// hostname; this is ONLY the fallback for local `wrangler dev`, where there is no router
// to assert one, and is gated on ALLOW_DEV_NODE (never set in prod).
//
// This is an ADDRESS, not an identity: it says which instance an un-routed local request
// belongs to, and grants nobody anything. The principal still comes from a verified login.
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
   * Which auth the app runs — the config section. OIDC-only (oidc-only-demos.md): there is
   * no builtin credential store, so `oidc` verifies a bearer token against an OIDC issuer
   * (`OIDC_ISSUER` [+ `OIDC_AUDIENCE`]) — covers Supabase, Auth0, AuthHero, Keycloak, … —
   * and anything else leaves the instance unconfigured, which fails closed.
   * The app never changes; only this config + the provider behind the contract does.
   * Declared in MERIDIAN_ENV (src/manifest.ts) and read ONLY through
   * `instanceAuthFor`'s settings pass in `authWiringFor` — a delivered per-scope value overrides
   * these deployment-wide bindings (#398). Typed here so `wrangler dev --var` works.
   */
  AUTH_PROVIDER?: string;
  OIDC_ISSUER?: string;
  OIDC_AUDIENCE?: string;
  // No BETTER_AUTH_SECRET: the IdentityDO generates its own per-tenant signing secret in
  // its own storage, so there is no shared worker secret to set. The built SPA is inlined
  // into the worker (src/assets.ts) — no ASSETS binding here either.
  /** Local dev only: when 'true', trust the `x-principal` header. NEVER set in prod. */
  ALLOW_DEV_NODE?: string;
  /** Shared secret the router presents (K-26): how the vertical knows the asserted node came from the router. */
  ROUTER_SECRET?: string;
  /** Shared secret the CONTROL PLANE presents to provision/link here (K-31). Unset ⇒ refused. */
  PLATFORM_SECRET?: string;
}

/**
 * Which tenant/scope this request is for. Behind the router: whatever the hostname
 * resolved to (signed headers). Local `wrangler dev` (ALLOW_DEV_NODE): the fixed dev node.
 * Neither: refuse — an unrouted request in a multi-tenant deployment has no defensible
 * default, and picking one would mean serving somebody else's data.
 */
function nodeFor(req: Request, env: Env): CompanyNode {
  let routed;
  try {
    routed = readRoutedNode(req.headers, {
      expectedSecret: env.ROUTER_SECRET,
      // #966: an unsigned assertion is refused unless this is an un-routed dev instance.
      allowUnsigned: env.ALLOW_DEV_NODE === 'true',
    });
  } catch (e) {
    if (e instanceof RouterAssertionError) throw new HTTPException(400, { message: e.message });
    throw e;
  }
  if (routed) return { tenantId: routed.tenantId, scopeId: routed.scopeId };
  if (env.ALLOW_DEV_NODE === 'true') return DEV_NODE;
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
  // #574 phase 3: the SAME registration the node self-host makes (seed.ts) — but on
  // this CP-less host the handler never runs. Registering it is what tells the host
  // which events are connector deliveries, so the drain routes each one onto the
  // platform-requests surface as a `connector:scrive` intent and the platform (which
  // holds the directory, the sealed credential and the egress) dispatches it. Options
  // like `baseUrl`/`callbackUrl` are deliberately absent: they are the DISPATCHING
  // host's concern, configured where the handler actually executes — which is why this
  // is `declare…` and not `register…` with an empty options bag (#990).
  declareScriveConnector(host);
  return host;
}

const originOf = (req: Request): string => new URL(req.url).origin;

/** The tenant's identity DO stub — the sub→principal directory (and Better Auth, if chosen). */
function identityDo(env: Env, node: CompanyNode) {
  return env.AUTH.get(env.AUTH.idFromName(node.tenantId));
}

/**
 * Everything this instance was configured with, in ONE DO hop — the delivered
 * `substrat:auth` choice, the declared settings (MERIDIAN_ENV, resolved delivered >
 * binding > manifest default, #398) and the tenant's session secret.
 *
 * Every read of a declared key goes through this; a bare `env.X` read would only ever
 * see the deployment-wide default (the silent-defaults bug, #374). The composition
 * itself is `@substrat-run/vertical-auth`'s (#972) — four demos used to carry a copy.
 */
async function authWiringFor(env: Env, node: CompanyNode) {
  return instanceAuthFor({
    directory: identityDo(env, node),
    scopeId: node.scopeId,
    envSpec: MERIDIAN_ENV,
    env: env as unknown as Record<string, unknown>,
  });
}

/**
 * The `AuthProvider` for this request, chosen by CONFIG — the whole point of the
 * contract. Per-SCOPE first (a delivered `substrat:auth` issuer builds the full
 * relying-party flow), then the DEPLOYMENT default (`AUTH_PROVIDER=oidc` verifies bearer
 * tokens against a fixed issuer), then fail closed: there is no builtin credential store
 * any more (oidc-only-demos.md), so an unconfigured instance refuses rather than silently
 * minting local accounts. The app never learns which; it only ever holds an
 * `AuthProvider`.
 */
async function authProviderFor(env: Env, req: Request): Promise<AuthProvider> {
  const instance = await authWiringFor(env, nodeFor(req, env));
  try {
    return instance.provider();
  } catch (err) {
    if (err instanceof AuthConfigError) throw new HTTPException(err.status, { message: err.message });
    throw err;
  }
}

/**
 * Resolve the caller to a PrincipalId for op invocation, PROVIDER-AGNOSTICALLY: the
 * configured provider verifies the request → a subject, and the tenant's identity DO maps
 * that subject → a principal in this scope (claiming the owner seat on first login).
 * Null ⇒ nobody (fail closed).
 *
 * ONE path, in every environment. The `x-principal` branch that used to open this function
 * meant the login exercised locally was not the login a customer runs, and shipped an
 * impersonation bypass one environment variable from being live.
 */
async function principalFor(env: Env, req: Request): Promise<PrincipalId | null> {
  const subject = await (await authProviderFor(env, req)).resolve(req.headers);
  if (!subject) return null;
  const node = nodeFor(req, env);
  const principal = await identityDo(env, node).resolvePrincipal(node.scopeId, subject.sub);
  return principal ? principalId.parse(principal) : null;
}

const app = new Hono<{ Bindings: Env }>();

// Identity/credentials/sessions live entirely at the OIDC issuer (oidc-only-demos.md): the
// vertical runs no credential store and hosts no sign-up. `/api/auth/*` is the relying-party
// flow only — `/login` → issuer → `/callback` → session cookie → `/logout`; the provider's
// handle 404s every other credential path (sign-up, password, reset), which live at the issuer.
app.on(['GET', 'POST'], '/api/auth/*', async (c) => (await authProviderFor(c.env, c.req.raw)).handle(c.req.raw));

/** The verified subject behind the current session, or null — the contract's `resolve`. */
app.get('/api/session', async (c) => c.json(await (await authProviderFor(c.env, c.req.raw)).resolve(c.req.raw.headers)));

// The platform's entire /internal/* contract — provision, reconcile, introspection, the
// read-only SQL console, platform-request drain, snapshot/delete/export/restore,
// bookmarks/rewind, and per-instance configure — plus the guaranteed { error } envelope,
// authored once in @substrat-run/vertical-host (issue #510) and mounted here. The three
// flavored routes take Meridian's own hooks: the pending-owner claim, the owner-of-record
// re-source for a #332 reconcile, and the identity-DO config store.
mountPlatformSurface<Env>(app, {
  platformSecret: (env) => env.PLATFORM_SECRET,
  hostFor,
  roles: ROLES,
  ownerRoleKey: 'hr-admin',
  onProvision: (env, b) =>
    identityDo(env, { tenantId: b.tenantId, scopeId: b.scopeId }).setPendingOwner(b.scopeId, b.owner),
  resolveOwner: async (env, ref) => {
    const owner = await identityDo(env, ref).getOwnerOfRecord(ref.scopeId);
    return owner ? principalId.parse(owner) : null;
  },
  onConfigure: (env, b) =>
    identityDo(env, { tenantId: b.tenantId, scopeId: b.scopeId }).setScopeConfig(b.scopeId, b.entries),
  // The owner seat as the platform may see it, and the claim link it may mint for one that
  // sits empty after the first-sign-in window (#925). Both read the same directory the
  // provision hook above writes.
  ownerSeat: (env, ref) => identityDo(env, ref).ownerSeat(ref.scopeId),
  mintOwnerClaim: (env, ref, input) => mintOwnerClaimLink(identityDo(env, ref), ref.scopeId, input.origin),
});

// Any OTHER platform verb is honestly unimplemented: JSON 501, never the SPA fallback —
// an /internal/* request that reaches the SPA returns 200 text/html, which the platform's
// JSON parse turns into an opaque "internal error" (the auth-server incident, 2026-07-25).
app.all('/internal/*', (c) =>
  c.json({ error: `meridian does not implement ${c.req.method} ${new URL(c.req.url).pathname}` }, 501),
);

/** Resolve the caller (any provider) → the routed node → a scope stub. 401 if nobody. */
async function stub(c: { env: Env; req: { raw: Request }; header?: (name: string, value: string) => void }) {
  const node = nodeFor(c.req.raw, c.env);
  const principal = await principalFor(c.env, c.req.raw);
  if (!principal) throw new HTTPException(401, { message: 'unauthorized' });
  // CP-less: lifecycle is the router's gate — it forwards only an active scope and asserts
  // the node. The vertical trusts that node and opens the scope; permissions evaluate locally.
  return hostFor(c.env).getScope(principal, node.tenantId, node.scopeId, {
    // #458/#574: an invoke that enqueued platform intents — including a connector
    // delivery the inline drain just routed — flags the response so the router kicks
    // an immediate platform drain instead of waiting for the sweep.
    onPlatformRequests: () => c.header?.(PLATFORM_REQUEST_HEADER, '1'),
  });
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
    // An unclaimed seat says HOW it can be claimed (#925): by signing in, while the first-sign-in
    // window is open; by a claim link from the dashboard once it has closed. The SPA's copy
    // depends on which, and it must not offer a sign-in that binds nobody.
    const seat = await identityDo(c.env, node).ownerSeat(node.scopeId);
    return seat.state === 'unclaimed'
      ? c.json({ status: 'needs-setup', firstSignInOpen: seat.firstSignIn?.open ?? false })
      : c.json({ error: 'unauthorized' }, 401);
  }
  const scope = await hostFor(c.env).getScope(principal, node.tenantId, node.scopeId);
  const who = (await scope.invoke('hr/whoami', undefined)) as {
    role: string;
    country: 'SE' | 'ES';
    employeeId: string | null;
  };
  // The display name the issuer asserted — cheap to re-resolve, and it keeps the SPA's
  // shape total whether or not the issuer sends `name`.
  const subject = await authProviderFor(c.env, c.req.raw)
    .then((p) => p.resolve(c.req.raw.headers))
    .catch(() => null);
  return c.json({
    key: principal,
    display: subject?.name ?? subject?.email ?? 'You',
    role: who.role,
    country: who.country,
    employeeId: who.employeeId,
  });
});

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
 * which already holds `hr-admin` from provision. One answer for every way it can fail, so a
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

/**
 * After an employee record is created with a login attached (`principalRef`), issue that
 * principal the self-service grants narrowed to their OWN record — `time:report`,
 * `absence:request`, `expense:submit` and the read/sign siblings (EMPLOYEE_SELF). Those keys
 * live in NO role (an hr-admin holds `time:read`, never `time:report`); an employee's
 * authority is a per-record grant, exactly as the demo seed issues one. Without this a linked
 * employee lands on "My work" yet every log-time is denied — the tab is on, the grant is not.
 * Idempotent, and only ever reached by a caller who already passed create-employee's own
 * `employee:manage` check inside the operation, so no fresh authority is minted here.
 */
async function grantEmployeeSelf(env: Env, node: CompanyNode, result: unknown): Promise<void> {
  const row = result as { id?: string; principal_ref?: string | null } | null;
  if (!row?.id || !row.principal_ref) return;
  // A real login is always a principal id here; anything else is not a grantable subject, so
  // skip rather than throw AFTER the record was already written by the (succeeded) operation.
  const principal = principalId.safeParse(row.principal_ref);
  if (!principal.success) return;
  const host = hostFor(env);
  for (const permission of EMPLOYEE_SELF) {
    await host.grantEntityLocal(node.scopeId, principal.data, permission, { entityType: 'employee', entityId: row.id });
  }
}

// Generic invoke: the kernel checks the permission inside every operation, so a generic
// route is exactly as safe as an explicit table — and far less code. The SPA's path;
// undocumented in the OpenAPI document (one path with a union body reads as nothing).
app.post('/api/invoke', async (c) => {
  const { op, input } = await c.req.json<{ op: string; input?: unknown }>();
  const result = (await (await stub(c)).invoke(op, input)) ?? null;
  if (op === 'hr/create-employee') await grantEmployeeSelf(c.env, nodeFor(c.req.raw, c.env), result);
  return c.json(result);
});

// The DOCUMENTED invoke surface (design/api-surface.md §2.2): one URL per operation —
// `POST /api/op/hr/create-employee` — which is what makes /api/docs readable and its
// try-it client usable. Same kernel, same permission checks; only names the catalog
// documents resolve, so the spec and the surface cannot disagree.
app.post('/api/op/*', async (c) => {
  const name = decodeURIComponent(new URL(c.req.url).pathname.slice('/api/op/'.length));
  if (!(name in API)) return c.json({ error: `unknown operation: ${name}` }, 404);
  const body = await c.req.text();
  const result = (await (await stub(c)).invoke(name, body ? JSON.parse(body) : undefined)) ?? null;
  if (name === 'hr/create-employee') await grantEmployeeSelf(c.env, nodeFor(c.req.raw, c.env), result);
  return c.json(result);
});

// The OpenAPI 3.1 document, built from the operation catalog — the same schemas the
// handlers parse. Session-gated like the rest of /api/*: the spec enumerates the
// surface, so it is for signed-in callers, not anonymous traffic.
app.get('/openapi.json', async (c) => {
  const principal = await principalFor(c.env, c.req.raw);
  if (!principal) throw new HTTPException(401, { message: 'unauthorized' });
  return c.json(API_DOCUMENT);
});

// Scalar over /openapi.json, self-hosted (docs.ts). No session → the SPA's login,
// not a bare 401 — a human typed this URL.
app.get('/api/docs', async (c) => {
  const principal = await principalFor(c.env, c.req.raw);
  if (!principal) return c.redirect('/');
  return c.html(DOCS_HTML);
});

// No SPA catch-all: the built app is served by the runtime's own asset layer (#340,
// wrangler.jsonc `assets`) — from the edge, without invoking this worker. The worker sees
// only what `run_worker_first` routes to it (/api/*, /internal/*, /openapi.json); every
// other path is a static file, or index.html via the single-page-application fallback.
// A request that reaches here is therefore a worker-first prefix with no matching route.
app.all('*', (c) => c.json({ error: 'not found' }, 404));

export default app;
