/**
 * Callout (the FSM demo vertical) as a deployable Cloudflare Worker.
 *
 * This is the same vertical the pure-SQLite demo runs, deployed onto the
 * Durable-Object adapter as a SANDBOX-CLEAN, control-plane-less vertical
 * (scope-local-permissions.md Phase 3): one `ScopeDO` per scope (kernel + engines
 * + the Callout module bundled in) that evaluates permissions from its own storage,
 * and a thin Hono API that authenticates → getScope → invoke. No CONTROL_PLANE
 * binding — the router asserts the node, and permissions live in the scope. Proof
 * that a pushed vertical runs on the real Cloudflare runtime with every kernel
 * guarantee below the API surface.
 *
 * Local run:  wrangler dev            (real workerd, no account)
 * Deploy:     substrat push           (into the WfP dispatch namespace)
 */
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import {
  principalId,
  scopeId,
  tenantId,
  queryScopeInput,
  readScopeTableInput,
  entitlementGrant,
  projectedIdentityLink,
  z,
} from '@substrat-run/contracts';
import type { PrincipalId, ScopeId, TenantId } from '@substrat-run/contracts';
import { defineScopeDO, CloudflareScopeHost } from '@substrat-run/adapter-cloudflare';
import {
  assertPlatformCall,
  PlatformCallError,
  readRoutedNode,
  RouterAssertionError,
  ulid,
} from '@substrat-run/kernel';
import { ROLES } from './provision.js';
import { CALLOUT_ENV } from './manifest.js';
import { workorderModule } from '@substrat-run/engine-workorder';
import { invoicingModule } from '@substrat-run/engine-invoicing';
import { protocolModule } from '@substrat-run/engine-protocol';
import { calloutModule } from './module.js';
import { serveAsset } from './assets.js';
import { mountApi } from './routes.js';
import {
  AUTH_CONFIG_KEY,
  AuthConfigError,
  IdentityDO,
  instanceAuthFor,
  mintOwnerClaimLink,
  sha256Hex,
  type AuthProvider,
} from '@substrat-run/vertical-auth';

// Registration order is a migration-ordering contract (protocol before callout).
const MODULES = [workorderModule, invoicingModule, protocolModule, calloutModule];

/** The scope-DO class = the app binary: kernel + engines + Callout, bundled. */
export const ScopeDO = defineScopeDO(MODULES, {});
/** The per-tenant identity DO (shared @substrat-run/vertical-auth) — bound as AUTH; wrangler needs the export. */
export { IdentityDO };

/** The (tenant, scope) a request is addressed to. */
export interface DemoNode {
  tenantId: TenantId;
  scopeId: ScopeId;
}

// A fixed dev node (valid ULIDs). Behind the router the node comes from the resolved
// hostname — this is ONLY the fallback for local `wrangler dev`, where there is no router to
// assert one, and is gated on ALLOW_DEV_NODE (never set in prod).
//
// This is an ADDRESS, not an identity: it says which instance an un-routed local request
// belongs to, and grants nobody anything. The principal still comes from a verified login,
// which is the whole difference from the `ALLOW_DEV_HEADER` this replaced — that one named
// the CALLER, and trusting a header to do that is a cross-tenant hole with a UI.
const DEV_NODE: DemoNode = {
  tenantId: tenantId.parse('01JZ0000000000000000000001'),
  scopeId: scopeId.parse('01JZ0000000000000000000002'),
};

interface Env {
  // A sandbox-clean vertical (scope-local-permissions.md Phase 3): its ONLY durable stores
  // are its OWN DO classes — SCOPE (business data, per scope) and AUTH (identity, per
  // tenant). No shared D1 `AUTH_DB`, no CONTROL_PLANE binding, no service binding — all
  // refused by assertSandboxContract. AUTH being an OWN class is what keeps it legal.
  SCOPE: DurableObjectNamespace;
  AUTH: DurableObjectNamespace<IdentityDO>;
  /**
   * Which auth the app runs — the config section. OIDC-only (oidc-only-demos.md): a
   * delivered per-scope `substrat:auth` (`mode: 'oidc'`) builds the relying-party flow;
   * absent that, `AUTH_PROVIDER=oidc` verifies a bearer token against `OIDC_ISSUER`
   * [+ `OIDC_AUDIENCE`]. There is no built-in credential store. Declared in CALLOUT_ENV
   * (src/manifest.ts) and read ONLY through `instanceAuthFor`'s settings pass — a
   * delivered per-scope value overrides these deployment-wide bindings (#398). Typed here
   * so `wrangler dev --var` works.
   */
  AUTH_PROVIDER?: string;
  OIDC_ISSUER?: string;
  OIDC_AUDIENCE?: string;
  /** Local `wrangler dev` only: when 'true', fall back to DEV_NODE when no router asserted a
   *  node. Addresses an instance; authenticates nobody. NEVER set in prod. */
  ALLOW_DEV_NODE?: string;
  /**
   * Shared secret the router presents (K-26). A CP-less vertical trusts the router's
   * asserted node absolutely — it is the tenant it serves — so this secret is how the
   * vertical knows the assertion came from the router and not a forged request.
   */
  ROUTER_SECRET?: string;
  /**
   * Shared secret the CONTROL PLANE presents to provision an instance here (K-31).
   * Separate from ROUTER_SECRET: the router may say which tenant a request is for and
   * must not be able to create one. Unset ⇒ provisioning is refused entirely.
   */
  PLATFORM_SECRET?: string;
}

/**
 * Which tenant/scope this request is for.
 *
 * Behind the router: whatever the hostname resolved to. Local `wrangler dev`
 * (ALLOW_DEV_NODE): the fixed dev node. Neither: refuse — an unrouted request in a multi-tenant
 * deployment has no defensible default, and picking one would mean serving somebody
 * else's data.
 */
function nodeFor(req: Request, env: Env): DemoNode {
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
  throw new HTTPException(503, {
    message: 'no scope was asserted for this request (missing router assertion)',
  });
}

/**
 * The coordinator is stateless — rebuilt per request; durable state is in the DOs.
 * CP-less (scope-local-permissions.md Phase 3): NO control plane. Permissions are
 * evaluated from each scope's own storage; the router asserts the node (tenant,
 * scope) from the shared directory, so this vertical trusts it rather than reading
 * a directory it has no binding to. It is a sandbox-clean vertical: its only
 * durable stores are its own `SCOPE` DO class and `AUTH_DB`.
 */
function hostFor(env: Env): CloudflareScopeHost {
  const host = new CloudflareScopeHost({ scope: env.SCOPE });
  for (const m of MODULES) host.registerModule(m);
  return host;
}

/** The request's own origin — used to build absolute invite-accept links. */
const originOf = (req: Request): string => new URL(req.url).origin;

/** The tenant's identity DO stub — the sub→principal directory + owner-of-record + invites. */
function identityDo(env: Env, node: DemoNode) {
  return env.AUTH.get(env.AUTH.idFromName(node.tenantId));
}

export { AUTH_CONFIG_KEY };

/**
 * Everything this instance was configured with, in one DO hop — delivered auth choice,
 * declared settings (CALLOUT_ENV, resolved delivered > binding > manifest default, #398),
 * and the tenant's session secret. The composition is `@substrat-run/vertical-auth`'s
 * (#972); this only names the vertical's env spec and re-raises its refusals as Hono
 * exceptions so the error envelope keeps the status.
 */
async function authWiringFor(env: Env, node: DemoNode) {
  return instanceAuthFor({
    directory: identityDo(env, node),
    scopeId: node.scopeId,
    envSpec: CALLOUT_ENV,
    env: env as unknown as Record<string, unknown>,
  });
}

/**
 * The `AuthProvider` for this request, chosen by CONFIG — the whole point of the contract.
 * Per-SCOPE first (a delivered `substrat:auth`), then the deployment default
 * (`AUTH_PROVIDER=oidc`), then fail closed. The app never learns which; it only ever holds
 * an `AuthProvider`.
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
 * Resolve the caller to a PrincipalId for op invocation, PROVIDER-AGNOSTICALLY: the configured
 * provider verifies the request → a subject, and the tenant's identity DO maps that subject →
 * a principal in this scope (claiming the owner seat on first login). Null ⇒ nobody (fail
 * closed).
 *
 * There is ONE path, in every environment. This used to begin with an `x-principal` branch for
 * local dev — a header that named the caller and was believed — which meant the login a
 * developer exercised was not the login a customer runs, and the deployable carried an
 * impersonation bypass one environment variable from being live. Locally the issuer is now
 * `@substrat-run/dev-issuer`; picking a user there is a real OIDC round-trip, and the only
 * thing that differs from production is which issuer answers.
 */
async function principalFor(env: Env, req: Request): Promise<PrincipalId | null> {
  const subject = await (await authProviderFor(env, req)).resolve(req.headers);
  if (!subject) return null;
  const node = nodeFor(req, env);
  const principal = await identityDo(env, node).resolvePrincipal(node.scopeId, subject.sub);
  return principal ? principalId.parse(principal) : null;
}

/**
 * Parse, don't trust — even from the platform. A malformed id reaching the kernel is
 * a worse failure than a rejected call, and this is the one entry point where the
 * caller is not a session we already resolved.
 */
const provisionInstanceBody = z.object({
  tenantId,
  scopeId,
  owner: principalId,
  slug: z.string().min(1),
  name: z.string().min(1),
  // #310: the tenant's entitlements, projected so ctx.entitlement + the per-operation gate
  // work in this CP-less vertical without a control-plane binding (#304). Optional.
  entitlements: z.array(entitlementGrant).optional(),
  // #406: the tenant's identity links, projected so the auth adapter can resolve
  // (provider, externalId) → principal from the scope's own storage. Optional.
  identityLinks: z.array(projectedIdentityLink).optional(),
});

const app = new Hono<{ Bindings: Env }>();

// Identity/credentials/sessions live entirely at the OIDC issuer (oidc-only-demos.md): the
// vertical runs no credential store and hosts no sign-up. `/api/auth/*` is the relying-party
// flow only — `/login` → issuer → `/callback` → session cookie → `/logout`; the provider's
// handle 404s every other credential path (sign-up, password, reset), which live at the issuer.
app.on(['GET', 'POST'], '/api/auth/*', async (c) => (await authProviderFor(c.env, c.req.raw)).handle(c.req.raw));

/** The verified subject behind the current session, or null — the contract's `resolve`. */
app.get('/api/session', async (c) => c.json(await (await authProviderFor(c.env, c.req.raw)).resolve(c.req.raw.headers)));

/**
 * Provision ONE instance of this vertical, on the platform's instruction (K-31).
 *
 * The control plane decides an instance should exist and calls this, because only the
 * vertical can create a usable scope DO — the DO class bundles the modules and lives
 * in this deployment. The platform cannot do it on the vertical's behalf.
 *
 * Deliberately NOT under `/api/*`: that prefix is the tenant-facing surface behind the
 * router, and this is a platform-to-vertical call that must never be reachable from a
 * tenant's session. It is authenticated by the platform secret alone — no principal,
 * no scope, because at this moment neither exists yet.
 *
 * Idempotent, so a retried call after a partial failure converges rather than
 * duplicating. That matters more than usual here: K-31 makes this the second phase of a
 * two-phase creation, and the reconciliation sweep re-runs exactly this.
 */
app.post('/internal/provision', async (c) => {
  try {
    assertPlatformCall(c.req.raw.headers, { expectedSecret: c.env.PLATFORM_SECRET });
  } catch (e) {
    if (e instanceof PlatformCallError) throw new HTTPException(403, { message: e.message });
    throw e;
  }

  const body = provisionInstanceBody.parse(await c.req.json());
  // CP-less (scope-local-permissions.md Phase 3): the shared control plane already
  // owns this scope's directory row + entitlements (the dashboard wrote them before
  // calling here), so this vertical sets up only the scope's OWN state — migrate,
  // project the role defs, grant the owner office-admin at scope level, evaluate
  // permissions locally. No tenant, no control plane.
  await hostFor(c.env).provisionScopeLocal({
    tenantId: body.tenantId,
    scopeId: body.scopeId,
    owner: body.owner,
    roles: ROLES,
    ownerRoleKey: 'office-admin',
    entitlements: body.entitlements,
    identityLinks: body.identityLinks,
  });
  // Record the owner seat: whoever first signs in and reaches this scope claims it (becomes
  // office-admin), whichever provider verifies them. This is how a provisioned instance
  // becomes usable by a real login without the platform knowing the login's subject up front.
  await identityDo(c.env, { tenantId: body.tenantId, scopeId: body.scopeId }).setPendingOwner(body.scopeId, body.owner);
  return c.json({ tenantId: body.tenantId, scopeId: body.scopeId, owner: body.owner }, 201);
});

/**
 * Upsert per-instance config on the platform's instruction (vertical-auth-detach.md §2.2) —
 * the delivery half of the dashboard's Env tab, and how a scope's `substrat:auth` issuer
 * choice arrives. Stored in the tenant's identity DO, keyed by scope; the body carries the
 * tenant id because a platform call has no router assertion to derive it from. Idempotent.
 */
app.post('/internal/configure', async (c) => {
  try {
    assertPlatformCall(c.req.raw.headers, { expectedSecret: c.env.PLATFORM_SECRET });
  } catch (e) {
    if (e instanceof PlatformCallError) throw new HTTPException(403, { message: e.message });
    throw e;
  }
  const body = z
    .object({
      tenantId,
      scopeId,
      entries: z.array(z.object({ key: z.string().min(1), value: z.string() })).min(1),
    })
    .parse(await c.req.json());
  await identityDo(c.env, { tenantId: body.tenantId, scopeId: body.scopeId }).setScopeConfig(body.scopeId, body.entries);
  return c.json({ applied: body.entries.length });
});

/**
 * The owner seat (#925), on the platform's instruction: what state it is in, and a claim
 * link for one that sits empty after the first-sign-in window. Callout mounts its
 * `/internal` surface by hand (it predates @substrat-run/vertical-host), so these are the
 * two routes `mountPlatformSurface` would have installed — same gate, same shapes.
 */
app.get('/internal/owner-seat', async (c) => {
  try {
    assertPlatformCall(c.req.raw.headers, { expectedSecret: c.env.PLATFORM_SECRET });
  } catch (e) {
    if (e instanceof PlatformCallError) throw new HTTPException(403, { message: e.message });
    throw e;
  }
  const ref = { tenantId: tenantId.parse(c.req.query('tenantId')), scopeId: scopeId.parse(c.req.query('scopeId')) };
  return c.json(await identityDo(c.env, ref).ownerSeat(ref.scopeId));
});

app.post('/internal/owner-claim', async (c) => {
  try {
    assertPlatformCall(c.req.raw.headers, { expectedSecret: c.env.PLATFORM_SECRET });
  } catch (e) {
    if (e instanceof PlatformCallError) throw new HTTPException(403, { message: e.message });
    throw e;
  }
  const body = z.object({ tenantId, scopeId, origin: z.string().url() }).parse(await c.req.json());
  const link = await mintOwnerClaimLink(
    identityDo(c.env, { tenantId: body.tenantId, scopeId: body.scopeId }),
    body.scopeId,
    body.origin,
  );
  if (!link) {
    throw new HTTPException(409, {
      message: `the owner seat of scope ${body.scopeId} is already claimed — nothing to mint a claim link for`,
    });
  }
  return c.json(link, 201);
});

/**
 * Read-only introspection of a scope's OWN database on the platform's instruction
 * (kernel-design §5.4's admin-query RPC) — the console/dashboard "Data" view. The
 * scope's data DO lives HERE (K-31), so the control plane delegates to the vertical;
 * the scope id is trusted from the platform-secret-gated call (the control plane did
 * the K-3 cross-check + audit). Read-only, table-shaped, no SQL.
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

// The SQL console (#219): one read-only statement, enforced in the DO (the kernel's
// textual gate + a transaction that always rolls back). The gate's refusal is the
// caller's mistake, not this worker's fault — 400, relayed verbatim by the platform.
app.post('/internal/query', async (c) => {
  try {
    assertPlatformCall(c.req.raw.headers, { expectedSecret: c.env.PLATFORM_SECRET });
  } catch (e) {
    if (e instanceof PlatformCallError) throw new HTTPException(403, { message: e.message });
    throw e;
  }
  const body = queryScopeInput.extend({ scopeId }).parse(await c.req.json());
  try {
    return c.json(await hostFor(c.env).introspectScopeQuery(body.scopeId, { sql: body.sql }));
  } catch (e) {
    if (e instanceof Error && e.message.includes('read-only console')) {
      throw new HTTPException(400, { message: e.message });
    }
    throw e;
  }
});

// Scope-storage lifecycle (preview-and-snapshots.md §9, the ratified trust line):
// copy a scope into a sibling DO / wipe a reaped fork — both entirely inside this
// deployment, so no scope bytes ever cross to the platform. The directory half
// (provenance row, activation, bind; the fork-only refusal) lives on the control
// plane's side of the call.
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

// The full dump behind a governed `scope pull` (preview-and-snapshots.md §8): the one
// /internal verb that deliberately moves scope bytes out — the control plane in front
// of it is the gate (staff-only, audited, masked by default, jurisdiction-checked).
app.get('/internal/export', async (c) => {
  try {
    assertPlatformCall(c.req.raw.headers, { expectedSecret: c.env.PLATFORM_SECRET });
  } catch (e) {
    if (e instanceof PlatformCallError) throw new HTTPException(403, { message: e.message });
    throw e;
  }
  const scope = scopeId.parse(c.req.query('scopeId'));
  return c.json(await hostFor(c.env).exportScopeLocal(scope));
});

/** Resolve the caller (any provider) → the routed node → a scope stub. 401 if nobody. */
async function stub(c: { env: Env; req: { raw: Request } }) {
  const node = nodeFor(c.req.raw, c.env);
  const principal = await principalFor(c.env, c.req.raw);
  if (!principal) throw new HTTPException(401, { message: 'unauthorized' });
  // CP-less (scope-local-permissions.md Phase 3): lifecycle is the router's gate — it
  // forwards only an active scope and asserts the node. The vertical trusts that node and
  // opens the scope; permissions evaluate from the scope's own storage.
  return hostFor(c.env).getScope(principal, node.tenantId, node.scopeId);
}

/**
 * Gate an admin-only action: resolve the caller's scope, then require they hold
 * `office-admin` (managing who can access the workspace is the owner/admin's authority).
 * `callout/whoami` reads the role from the scope's own grants, so this is the scope-local
 * permission model, not a second source of truth. Throws 401 (no session) / 403 (not admin).
 */
async function requireAdmin(c: { env: Env; req: { raw: Request } }) {
  const scope = await stub(c);
  const who = (await scope.invoke('callout/whoami', undefined)) as { role: string };
  if (who.role !== 'office-admin') throw new HTTPException(403, { message: 'only an admin can manage invites' });
  return scope;
}

/**
 * The resolved identity behind the current request, in the shape the SPA's session mode
 * centres on: `{ principal, display, role, via }`. The principal comes from the auth seam;
 * the role hint comes from the scope itself (`callout/whoami`), so a hosted owner (holding
 * `office-admin`) and an invited technician each land on the right chrome. 401 when nobody.
 */
app.get('/api/me', async (c) => {
  const node = nodeFor(c.req.raw, c.env);
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
  const who = (await scope.invoke('callout/whoami', undefined)) as { role: string };
  // The display name the issuer asserted — cheap to re-resolve, and it keeps the SPA's shape
  // total whether or not the issuer sends `name`.
  const subject = await authProviderFor(c.env, c.req.raw)
    .then((p) => p.resolve(c.req.raw.headers))
    .catch(() => null);
  return c.json({
    principal,
    display: subject?.name ?? subject?.email ?? 'You',
    role: who.role,
    via: 'oidc',
  });
});

const inviteBody = z.object({
  email: z.string().email().optional(),
  /** One of the vertical's roles (office-admin | technician) — validated against ROLES. */
  roleKey: z.string().min(1),
});

/**
 * Invites (the post-setup join path — invite-only). Admin-only. Creating one pre-mints a
 * member principal, grants it the chosen role at scope level, and records the invite in the
 * tenant's identity DO keyed by the token's hash; the plaintext token rides only in the
 * returned accept link. The roles a teammate can be invited at are this vertical's ROLES.
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
 * Accept an invite: the invitee has just signed in (via the issuer) and now claims it while
 * authenticated. Binds their subject → the invite's pre-minted principal in the identity
 * directory; `/api/me` then resolves them as that member.
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
 * which already holds `office-admin` from provision. One answer for every way it can fail, so a
 * probe learns nothing about which.
 */
app.post('/api/claim-owner', async (c) => {
  const node = nodeFor(c.req.raw, c.env);
  const subject = await (await authProviderFor(c.env, c.req.raw)).resolve(c.req.raw.headers);
  if (!subject) throw new HTTPException(401, { message: 'sign in before claiming this workspace' });
  const { token } = z.object({ token: z.string().min(1) }).parse(await c.req.json());
  const principal = await identityDo(c.env, node).claimOwner(node.scopeId, subject.sub, await sha256Hex(token));
  if (!principal) throw new HTTPException(400, { message: 'this claim link is invalid, expired, or already used' });
  return c.json({ ok: true, principal });
});

// The whole data API — the SAME route table the node server mounts (src/routes.ts),
// which also installs the shared fail-closed error handler. Here the stub
// authenticates via Better Auth on the Durable-Object adapter.
mountApi(app, stub);

// Serve the built SPA for everything that isn't an /api/* route. This MUST come
// after all API routes so Hono handles /api/* (especially /api/auth/*) first; the
// catch-all then serves the inlined SPA (src/assets.ts), returning index.html for
// unknown client routes (SPA fallback). A pushed sandbox-clean vertical has no
// ASSETS binding — the SPA is bundled into the worker itself. Single origin →
// Better Auth's session cookie is same-origin, no CORS.
app.all('*', (c) => serveAsset(new URL(c.req.url)));

export default app;
