/**
 * This vertical as a deployable Cloudflare Worker — SANDBOX-CLEAN and
 * control-plane-less: the shape `substrat push` deploys into the platform's
 * dispatch namespace. Its ONLY durable store is its OWN `SCOPE` DO class
 * (kernel + engines + this vertical, bundled); no CONTROL_PLANE binding, no
 * service bindings, no ASSETS binding — the platform refuses those.
 *
 * `substrat push` derives the deploy config from `substrat.runtimeNeeds` in
 * package.json (entry = this file, stores = the DO classes exported here) —
 * you never author wrangler config.
 *
 * ── THE AUTH SEAM ────────────────────────────────────────────────────────────
 * This starter resolves a caller ONLY through the `x-principal` dev header,
 * gated on ALLOW_DEV_HEADER — an impersonation bypass by design, for local
 * `wrangler dev` and smoke tests. In production the gate is off and every
 * /api/* call is 401 until you wire real auth into `authenticatedPrincipal`
 * below (a session/bearer verifier that maps a login → PrincipalId — see
 * @substrat-run/vertical-auth, the platform's pluggable AuthProvider +
 * per-tenant identity DO, for the intended shape). Deploying with the dev
 * header enabled is a cross-tenant hole with a UI. ──────────────────────────
 */
import { Hono } from 'hono';
import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import {
  entitlementGrant,
  principalId,
  projectedIdentityLink,
  queryScopeInput,
  readScopeTableInput,
  scopeId,
  tenantId,
  z,
  type PrincipalId,
  type ScopeId,
  type TenantId,
} from '@substrat-run/contracts';
import { CloudflareScopeHost, defineScopeDO } from '@substrat-run/adapter-cloudflare';
import {
  assertPlatformCall,
  PlatformCallError,
  readRoutedNode,
  RouterAssertionError,
  type ScopeStub,
} from '@substrat-run/kernel';
import { MODULES, OWNER_ROLE_KEY, ROLES } from './provision.js';

/** The scope-DO class = the app binary: kernel + engines + this vertical, bundled. */
export const ScopeDO = defineScopeDO(MODULES, {});

interface Node {
  tenantId: TenantId;
  scopeId: ScopeId;
}

// A fixed dev node (valid ULIDs) — ONLY the fallback for local `wrangler dev`,
// where there is no router to assert one; gated on ALLOW_DEV_HEADER (never set
// in prod).
const DEV_NODE: Node = {
  tenantId: tenantId.parse('01JZ00000000000000000DEV01'),
  scopeId: scopeId.parse('01JZ00000000000000000DEV02'),
};

interface Env {
  /** One DO per scope — the vertical's only durable store (sandbox-clean). */
  SCOPE: DurableObjectNamespace;
  /** Local dev only: when 'true', trust the `x-principal` header. NEVER set in prod. */
  ALLOW_DEV_HEADER?: string;
  /** Shared secret the router presents (how this worker knows the asserted node is real). */
  ROUTER_SECRET?: string;
  /** Shared secret the platform presents on /internal/* calls. */
  PLATFORM_SECRET?: string;
}

/** The routed (tenant, scope) — from the router assertion, or the dev node. */
function nodeFor(req: Request, env: Env): Node {
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

function hostFor(env: Env): CloudflareScopeHost {
  const host = new CloudflareScopeHost({ scope: env.SCOPE });
  for (const m of MODULES) host.registerModule(m);
  return host;
}

/**
 * THE AUTH SEAM (see the header comment): resolve the caller to a PrincipalId,
 * or null for nobody. Replace the body with a real session/bearer verifier
 * before exposing this worker to users — the dev header is dev-only.
 */
async function authenticatedPrincipal(req: Request, env: Env): Promise<PrincipalId | null> {
  if (env.ALLOW_DEV_HEADER === 'true') {
    const parsed = principalId.safeParse(req.headers.get('x-principal') ?? '');
    if (parsed.success) return parsed.data;
  }
  return null; // ← wire real auth here
}

/** Resolve caller + routed node → a scope stub. 401 if nobody. */
async function stub(c: Context<{ Bindings: Env }>): Promise<ScopeStub> {
  const node = nodeFor(c.req.raw, c.env);
  const principal = await authenticatedPrincipal(c.req.raw, c.env);
  if (!principal) throw new HTTPException(401, { message: 'unauthorized' });
  return hostFor(c.env).getScope(principal, node.tenantId, node.scopeId);
}

const app = new Hono<{ Bindings: Env }>();

app.onError((err, c) => {
  if (err instanceof HTTPException) return err.getResponse();
  const m = err instanceof Error ? err.message : String(err);
  if (/permission denied/i.test(m)) return c.json({ error: m }, 403);
  if (/not found|unknown scope/i.test(m)) return c.json({ error: m }, 404);
  if (/invalid transition|immutable/i.test(m)) return c.json({ error: m }, 409);
  return c.json({ error: m }, 400);
});

// Who am I — resolves the caller without invoking anything.
app.get('/api/me', async (c) => {
  const principal = await authenticatedPrincipal(c.req.raw, c.env);
  if (!principal) return c.json({ error: 'unauthorized' }, 401);
  return c.json({ principal });
});

// Generic invoke: the kernel checks a permission inside EVERY operation, so a
// generic route is exactly as safe as one route per operation.
app.post('/api/invoke', async (c) => {
  const { op, input } = await c.req.json<{ op: string; input?: unknown }>();
  return c.json((await (await stub(c)).invoke(op, input)) ?? null);
});

// ── /internal/* — the platform-gated management contract ────────────────────
// The control plane provisions, heals, inspects and restores installs through
// these routes. A vertical without them cannot be installed or repaired, so
// keep the FULL set even though your app code never calls them.

function gatePlatform(c: { env: Env; req: { raw: Request } }): void {
  try {
    assertPlatformCall(c.req.raw.headers, { expectedSecret: c.env.PLATFORM_SECRET });
  } catch (e) {
    if (e instanceof PlatformCallError) throw new HTTPException(403, { message: e.message });
    throw e;
  }
}

const provisionBody = z.object({
  tenantId,
  scopeId,
  owner: principalId,
  slug: z.string().min(1),
  name: z.string().min(1),
  entitlements: z.array(entitlementGrant).optional(),
  identityLinks: z.array(projectedIdentityLink).optional(),
});

// Provision ONE scope on the platform's instruction, CP-lessly: migrate the
// modules, project this vertical's roles + the tenant's entitlements locally,
// grant the owner their role at scope level. Platform-secret gated; idempotent.
app.post('/internal/provision', async (c) => {
  gatePlatform(c);
  const body = provisionBody.parse(await c.req.json());
  await hostFor(c.env).provisionScopeLocal({
    tenantId: body.tenantId,
    scopeId: body.scopeId,
    owner: body.owner,
    roles: ROLES,
    ownerRoleKey: OWNER_ROLE_KEY,
    entitlements: body.entitlements,
    identityLinks: body.identityLinks,
  });
  return c.json({ tenantId: body.tenantId, scopeId: body.scopeId, owner: body.owner }, 201);
});

// Repair (reconcile): re-deliver roles/entitlements/identity links to a scope.
// This starter has no durable owner-of-record store (that lives with real auth
// — the auth seam), so the owner must be re-supplied; without one the refusal
// names the remedy instead of healing wrongly.
const reconcileBody = provisionBody.partial({ owner: true, slug: true, name: true });
app.post('/internal/reconcile', async (c) => {
  gatePlatform(c);
  const body = reconcileBody.parse(await c.req.json());
  if (!body.owner) {
    throw new HTTPException(409, {
      message:
        'no owner of record: this starter keeps none (an identity store — the auth seam — owns it). ' +
        'Re-run the full install, or wire auth and record the owner durably.',
    });
  }
  await hostFor(c.env).provisionScopeLocal({
    tenantId: body.tenantId,
    scopeId: body.scopeId,
    owner: body.owner,
    roles: ROLES,
    ownerRoleKey: OWNER_ROLE_KEY,
    entitlements: body.entitlements,
    identityLinks: body.identityLinks,
  });
  return c.json({ tenantId: body.tenantId, scopeId: body.scopeId, owner: body.owner });
});

// Read-only scope-table introspection (console/dashboard Data view).
app.get('/internal/tables', async (c) => {
  gatePlatform(c);
  return c.json(await hostFor(c.env).introspectScopeTables(scopeId.parse(c.req.query('scopeId'))));
});
app.get('/internal/tables/:table', async (c) => {
  gatePlatform(c);
  const scope = scopeId.parse(c.req.query('scopeId'));
  const input = readScopeTableInput.parse({
    table: c.req.param('table'),
    limit: c.req.query('limit') ? Number(c.req.query('limit')) : undefined,
    offset: c.req.query('offset') ? Number(c.req.query('offset')) : undefined,
  });
  return c.json(await hostFor(c.env).introspectScopeTable(scope, input));
});
// The SQL console: one read-only statement, enforced in the DO.
app.post('/internal/query', async (c) => {
  gatePlatform(c);
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

// Platform-intent drain surface: the control plane PULLS pending intents from
// this deployment's scope DOs and journals outcomes back.
app.get('/internal/platform-requests', async (c) => {
  gatePlatform(c);
  const t = tenantId.parse(c.req.query('tenantId'));
  const s = scopeId.parse(c.req.query('scopeId'));
  return c.json(await hostFor(c.env).listPlatformRequests(t, s));
});

// Scope-storage lifecycle: snapshot/delete/export/restore/bookmarks/rewind —
// what `substrat scope pull`/`restore` and the in-place update backout use.
app.post('/internal/snapshot', async (c) => {
  gatePlatform(c);
  const body = z.object({ sourceScopeId: scopeId, newScopeId: scopeId }).parse(await c.req.json());
  return c.json(await hostFor(c.env).snapshotScopeLocal(body.sourceScopeId, body.newScopeId), 201);
});
app.post('/internal/delete-scope', async (c) => {
  gatePlatform(c);
  const body = z.object({ scopeId }).parse(await c.req.json());
  await hostFor(c.env).deleteScopeLocal(body.scopeId);
  return c.json({ deleted: body.scopeId });
});
app.get('/internal/export', async (c) => {
  gatePlatform(c);
  return c.json(await hostFor(c.env).exportScopeLocal(scopeId.parse(c.req.query('scopeId'))));
});
app.post('/internal/restore', async (c) => {
  gatePlatform(c);
  const body = z
    .object({
      tenantId: tenantId.optional(),
      scopeId,
      tables: z.array(
        z.object({ name: z.string(), ddl: z.string(), columns: z.array(z.string()), rows: z.array(z.array(z.unknown())) }),
      ),
    })
    .parse(await c.req.json());
  const host = hostFor(c.env);
  const result = await host.restoreScopeLocal(body.scopeId, body.tables);
  // Re-project role definitions after an import — a dump may carry tuples but
  // no role definitions; roles are code-defined, so re-projecting is always safe.
  if (body.tenantId) await host.projectRolesLocal(body.tenantId, body.scopeId, ROLES);
  return c.json(result);
});
app.get('/internal/bookmarks', async (c) => {
  gatePlatform(c);
  return c.json(await hostFor(c.env).migrationBookmarksLocal(scopeId.parse(c.req.query('scopeId'))));
});
app.post('/internal/rewind', async (c) => {
  gatePlatform(c);
  const body = z
    .object({ scopeId, bookmark: z.string().min(1), force: z.boolean().optional() })
    .parse(await c.req.json());
  return c.json(await hostFor(c.env).rewindScopeLocal(body.scopeId, body.bookmark, { force: body.force }));
});

// Unmatched /api/* fails as JSON; everything else gets a pointer, not a UI —
// this starter ships no SPA (add one and inline it at build time when you do).
app.all('/api/*', (c) => c.json({ error: `unknown route: ${new URL(c.req.raw.url).pathname}` }, 404));
app.all('*', (c) =>
  c.json({
    service: 'substrat vertical',
    api: 'POST /api/invoke { op, input }',
    docs: 'https://substrat.net',
  }),
);

export default app;
