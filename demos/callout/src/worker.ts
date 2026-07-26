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
  z,
} from '@substrat-run/contracts';
import { defineScopeDO, CloudflareScopeHost } from '@substrat-run/adapter-cloudflare';
import {
  assertPlatformCall,
  PlatformCallError,
  readRoutedNode,
  RouterAssertionError,
} from '@substrat-run/kernel';
import { ROLES } from './provision.js';
import { workorderModule } from '@substrat-run/engine-workorder';
import { invoicingModule } from '@substrat-run/engine-invoicing';
import { protocolModule } from '@substrat-run/engine-protocol';
import { calloutModule } from './module.js';
import { buildAuth, type Auth } from './auth.js';
import { serveAsset } from './assets.js';
import { mountApi } from './routes.js';
import {
  betterAuthAdapter,
  devHeaderAdapter,
  resolvePrincipal,
  type AuthAdapter,
  type DemoNode,
  type IdentityDirectory,
} from './auth-adapters.js';

// Registration order is a migration-ordering contract (protocol before callout).
const MODULES = [workorderModule, invoicingModule, protocolModule, calloutModule];

/** The scope-DO class = the app binary: kernel + engines + Callout, bundled. */
export const ScopeDO = defineScopeDO(MODULES, {});

// A fixed dev node (valid ULIDs). Behind the router the node comes from the resolved
// hostname — this is ONLY the fallback for local `wrangler dev`, where there is no
// router to assert one, and is gated on ALLOW_DEV_HEADER (never set in prod).
const DEV_NODE: DemoNode = {
  tenantId: tenantId.parse('01JZ0000000000000000000001'),
  scopeId: scopeId.parse('01JZ0000000000000000000002'),
};

interface Env {
  // A sandbox-clean vertical (scope-local-permissions.md Phase 3): its ONLY durable
  // stores are its own SCOPE DO class + AUTH_DB. No CONTROL_PLANE binding, no service
  // binding to a platform worker — assertSandboxContract refuses those.
  SCOPE: DurableObjectNamespace;
  AUTH_DB: D1Database;
  BETTER_AUTH_SECRET?: string;
  BASE_URL?: string;
  /** Local dev only: when 'true', trust the `x-principal` header. NEVER set in prod. */
  ALLOW_DEV_HEADER?: string;
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
 * Behind the router: whatever the hostname resolved to. Local dev (ALLOW_DEV_HEADER):
 * the fixed dev node. Neither: refuse — an unrouted request in a multi-tenant
 * deployment has no defensible default, and picking one would mean serving somebody
 * else's data.
 */
function nodeFor(req: Request, env: Env): DemoNode {
  let routed;
  try {
    routed = readRoutedNode(req.headers, { expectedSecret: env.ROUTER_SECRET });
  } catch (e) {
    if (e instanceof RouterAssertionError) throw new HTTPException(400, { message: e.message });
    throw e;
  }
  if (routed) return { tenantId: routed.tenantId, scopeId: routed.scopeId };
  if (env.ALLOW_DEV_HEADER === 'true') return DEV_NODE;
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

/** The request's own origin — Better Auth trusts it as baseURL, so login works on
 * any deployment (localhost, *.workers.dev, custom domain) with no config. */
const originOf = (req: Request): string => new URL(req.url).origin;

/**
 * The CP-less identity directory: with no control plane to bind identities into, the
 * vertical's OWN Better Auth store IS the id→principal map. The `principal_id` column
 * on the `user` row (migrations/0001) holds the binding — set on a user's first login,
 * read on every one after. One D1 store, no directory to reach across the network.
 */
function d1IdentityDirectory(db: D1Database): IdentityDirectory {
  return {
    async resolve(externalId) {
      const row = (await db
        .prepare('SELECT principal_id FROM user WHERE id = ?')
        .bind(externalId)
        .first()) as { principal_id: string | null } | null;
      if (!row?.principal_id) return null;
      // The scope is the request's own (single-scope-per-node here), so the binding
      // pins only the principal — the adapter falls back to the node's scope.
      return { principal: principalId.parse(row.principal_id), scopeId: null };
    },
    async bind(externalId, principal) {
      await db.prepare('UPDATE user SET principal_id = ? WHERE id = ?').bind(principal, externalId).run();
    },
  };
}

/**
 * The mounted auth seam: Better Auth (session cookie). The kernel only ever
 * receives the resolved `PrincipalId`. The `x-principal` dev-header adapter is
 * an impersonation bypass by design, so it is mounted ONLY when
 * `ALLOW_DEV_HEADER=true` (local dev) — secure by default, off in production.
 */
function authFor(
  env: Env,
  origin: string,
  node: DemoNode,
): { auth: Auth; host: CloudflareScopeHost; adapters: AuthAdapter[] } {
  const auth = buildAuth(env, origin);
  const host = hostFor(env);
  const adapters: AuthAdapter[] = [
    betterAuthAdapter(auth, host, node, d1IdentityDirectory(env.AUTH_DB)),
  ];
  if (env.ALLOW_DEV_HEADER === 'true') adapters.push(devHeaderAdapter(node));
  return { auth, host, adapters };
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
});

const app = new Hono<{ Bindings: Env }>();

// Edge authentication (M3): Better Auth owns identity/credentials/sessions in
// D1, mounted under /api/auth/*. A per-request instance (stateless coordinator).
app.on(['GET', 'POST'], '/api/auth/*', (c) => buildAuth(c.env, originOf(c.req.raw)).handler(c.req.raw));

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
  });
  return c.json({ tenantId: body.tenantId, scopeId: body.scopeId, owner: body.owner }, 201);
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

// A protected data route resolves the caller across the mounted adapters, then
// getScope for the router-asserted node. No adapter matched → 401 (fail closed).
async function stub(c: { env: Env; req: { raw: Request } }) {
  const node = nodeFor(c.req.raw, c.env);
  const { host, adapters } = authFor(c.env, originOf(c.req.raw), node);
  const result = await resolvePrincipal(adapters, c.req.raw.headers);
  if (!result) throw new HTTPException(401, { message: 'unauthorized' });
  // CP-less (scope-local-permissions.md Phase 3): lifecycle is the router's gate — it
  // resolves the hostname against the shared directory and forwards only an active
  // scope, asserting the node in signed headers. The vertical trusts that node and
  // opens the scope; permissions evaluate from the scope's own storage.
  return host.getScope(result.principal, result.tenantId, result.scopeId);
}

// The resolved identity behind the current request (principal, display, role), or 401.
app.get('/api/me', async (c) => {
  const { adapters } = authFor(c.env, originOf(c.req.raw), nodeFor(c.req.raw, c.env));
  const result = await resolvePrincipal(adapters, c.req.raw.headers);
  if (!result) return c.json({ error: 'unauthorized' }, 401);
  return c.json({
    principal: result.principal,
    display: result.display,
    role: result.role,
    via: result.via,
    tenant: result.tenantId,
    scope: result.scopeId,
  });
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
