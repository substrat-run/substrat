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
 * Local run:  wrangler dev          (real workerd, no account; ALLOW_DEV_HEADER)
 * Deploy:     substrat push         (into the WfP dispatch namespace)
 */
import { Hono } from 'hono';
import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { principalId, scopeId, tenantId, queryScopeInput, readScopeTableInput, z, type PrincipalId, type TenantId, type ScopeId } from '@substrat-run/contracts';
import { defineScopeDO, CloudflareScopeHost } from '@substrat-run/adapter-cloudflare';
import { assertPlatformCall, PlatformCallError, readRoutedNode, RouterAssertionError, ulid, type ScopeStub } from '@substrat-run/kernel';
import { IdentityDO, doAuthProvider, oidcAuthProvider, type AuthProvider } from '@substrat-run/vertical-auth';
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
// is no router to assert one, gated on ALLOW_DEV_HEADER (never set in prod).
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
  ALLOW_DEV_HEADER?: string;
  ROUTER_SECRET?: string;
  PLATFORM_SECRET?: string;
}

/**
 * Which (tenant, SITE) this request is for. Tenant + home site come from the router
 * assertion (or the dev node). The app may select ANOTHER site of the SAME tenant via
 * `x-scope`; that scope is trusted only in that it must belong to the asserted tenant —
 * getScope re-checks the pair, and the site's own permissions gate access. Reaching a
 * different tenant's scope is impossible.
 */
function nodeFor(req: Request, env: Env): SiteNode {
  let routed;
  try {
    routed = readRoutedNode(req.headers, { expectedSecret: env.ROUTER_SECRET });
  } catch (e) {
    if (e instanceof RouterAssertionError) throw new HTTPException(400, { message: e.message });
    throw e;
  }
  const base: SiteNode | null = routed
    ? { tenantId: routed.tenantId, scopeId: routed.scopeId }
    : env.ALLOW_DEV_HEADER === 'true'
      ? DEV_NODE
      : null;
  if (!base) throw new HTTPException(503, { message: 'no scope was asserted for this request (missing router assertion)' });
  const requested = req.headers.get('x-scope');
  const parsed = requested ? scopeId.safeParse(requested) : null;
  return parsed?.success ? { tenantId: base.tenantId, scopeId: parsed.data } : base;
}

function hostFor(env: Env): CloudflareScopeHost {
  const host = new CloudflareScopeHost({ scope: env.SCOPE });
  for (const m of MODULES) host.registerModule(m);
  return host;
}

const originOf = (req: Request): string => new URL(req.url).origin;
const identityDo = (env: Env, node: SiteNode) => env.AUTH.get(env.AUTH.idFromName(node.tenantId));

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function authProviderFor(env: Env, req: Request): AuthProvider {
  if ((env.AUTH_PROVIDER ?? 'better-auth-do') === 'oidc') {
    if (!env.OIDC_ISSUER) throw new HTTPException(500, { message: 'AUTH_PROVIDER=oidc but OIDC_ISSUER is unset' });
    return oidcAuthProvider({ issuer: env.OIDC_ISSUER, ...(env.OIDC_AUDIENCE ? { audience: env.OIDC_AUDIENCE } : {}) });
  }
  return doAuthProvider(identityDo(env, nodeFor(req, env)), originOf(req));
}

/** Resolve the caller → a PrincipalId in the selected site (provider-agnostic). Null ⇒ nobody. */
async function principalFor(env: Env, req: Request): Promise<PrincipalId | null> {
  if (env.ALLOW_DEV_HEADER === 'true') {
    const parsed = principalId.safeParse(req.headers.get('x-principal') ?? '');
    if (parsed.success) return parsed.data;
  }
  const subject = await authProviderFor(env, req).resolve(req.headers);
  if (!subject) return null;
  const node = nodeFor(req, env);
  const principal = await identityDo(env, node).resolvePrincipal(node.scopeId, subject.sub);
  return principal ? principalId.parse(principal) : null;
}

const app = new Hono<{ Bindings: Env }>();

// Open sign-up is allowed only during first-run setup or with a valid invite token.
app.post('/api/auth/sign-up/email', async (c) => {
  const node = nodeFor(c.req.raw, c.env);
  const id = identityDo(c.env, node);
  const token = new URL(c.req.raw.url).searchParams.get('invite');
  const allowed =
    (await id.needsSetup(node.scopeId)) || (token ? await id.inviteExists(node.scopeId, await sha256Hex(token)) : false);
  if (!allowed) return c.json({ error: 'Sign-up is closed for this workspace — ask an admin to invite you.' }, 403);
  return authProviderFor(c.env, c.req.raw).handle(c.req.raw);
});

app.on(['GET', 'POST'], '/api/auth/*', (c) => authProviderFor(c.env, c.req.raw).handle(c.req.raw));
app.get('/api/session', async (c) => c.json(await authProviderFor(c.env, c.req.raw).resolve(c.req.raw.headers)));

// Who am I, in the selected site, and what may I do — needs-setup aware (first-run).
app.get('/api/me', async (c) => {
  const node = nodeFor(c.req.raw, c.env);
  const principal = await principalFor(c.env, c.req.raw);
  if (!principal) {
    const needsSetup = await identityDo(c.env, node).needsSetup(node.scopeId);
    return needsSetup ? c.json({ status: 'needs-setup' }) : c.json({ error: 'unauthorized' }, 401);
  }
  const scope = await hostFor(c.env).getScope(principal, node.tenantId, node.scopeId);
  const who = (await scope.invoke('manyfold/whoami', undefined)) as { can: Record<string, boolean> };
  const subject = await authProviderFor(c.env, c.req.raw).resolve(c.req.raw.headers).catch(() => null);
  return c.json({ key: principal, display: subject?.name ?? subject?.email ?? 'You', site: node.scopeId, can: who.can });
});

const provisionBody = z.object({ tenantId, scopeId, owner: principalId, slug: z.string().min(1), name: z.string().min(1) });

// Provision ONE site on the platform's instruction (K-31), CP-less. The shared control plane
// already owns the directory row + entitlement; the vertical sets up only the site's OWN
// state: migrate tables, project roles, grant the owner `admin`, record the owner seat. A
// multi-site install calls this once per site. Platform-secret gated; idempotent.
app.post('/internal/provision', async (c) => {
  try {
    assertPlatformCall(c.req.raw.headers, { expectedSecret: c.env.PLATFORM_SECRET });
  } catch (e) {
    if (e instanceof PlatformCallError) throw new HTTPException(403, { message: e.message });
    throw e;
  }
  const body = provisionBody.parse(await c.req.json());
  await hostFor(c.env).provisionScopeLocal({
    tenantId: body.tenantId,
    scopeId: body.scopeId,
    owner: body.owner,
    roles: ROLES,
    ownerRoleKey: 'admin',
  });
  await identityDo(c.env, { tenantId: body.tenantId, scopeId: body.scopeId }).setPendingOwner(body.scopeId, body.owner);
  return c.json({ tenantId: body.tenantId, scopeId: body.scopeId, owner: body.owner }, 201);
});

// Read-only scope-table introspection for the console/dashboard Data view (platform-gated).
function gatePlatform(c: { env: Env; req: { raw: Request } }): void {
  try {
    assertPlatformCall(c.req.raw.headers, { expectedSecret: c.env.PLATFORM_SECRET });
  } catch (e) {
    if (e instanceof PlatformCallError) throw new HTTPException(403, { message: e.message });
    throw e;
  }
}
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
// The SQL console (#219): one read-only statement, enforced in the DO (gate + rolled-
// back transaction). A gate refusal is the caller's mistake — 400, relayed verbatim.
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
// Scope-storage lifecycle (preview-and-snapshots.md §9): copy a scope into a sibling
// DO / wipe a reaped fork — both inside this deployment; no bytes cross the boundary.
app.post('/internal/snapshot', async (c) => {
  gatePlatform(c);
  const body = z
    .object({ sourceScopeId: scopeId, newScopeId: scopeId })
    .parse(await c.req.json());
  return c.json(await hostFor(c.env).snapshotScopeLocal(body.sourceScopeId, body.newScopeId), 201);
});
app.post('/internal/delete-scope', async (c) => {
  gatePlatform(c);
  const body = z.object({ scopeId }).parse(await c.req.json());
  await hostFor(c.env).deleteScopeLocal(body.scopeId);
  return c.json({ deleted: body.scopeId });
});
// The full dump behind a governed `scope pull` (preview-and-snapshots.md §8): the one
// /internal verb that deliberately moves scope bytes out; the control plane is the gate.
app.get('/internal/export', async (c) => {
  gatePlatform(c);
  return c.json(await hostFor(c.env).exportScopeLocal(scopeId.parse(c.req.query('scopeId'))));
});
// The write half (§8): load a dump into one existing scope, replacing its data —
// the governed restore/backout. The control plane is the gate and the auditor.
// After the import, the vertical's OWN role definitions are re-projected: a dump
// from a CP-full world carries tuples but no role definitions (they live in that
// world's directory), and without the repair every check denies while the role
// still resolves. Roles are code-defined, so re-projecting is always safe.
app.post('/internal/restore', async (c) => {
  gatePlatform(c);
  const body = z
    .object({
      tenantId: tenantId.optional(),
      scopeId,
      tables: z.array(z.object({ name: z.string(), ddl: z.string(), columns: z.array(z.string()), rows: z.array(z.array(z.unknown())) })),
    })
    .parse(await c.req.json());
  const host = hostFor(c.env);
  const result = await host.restoreScopeLocal(body.scopeId, body.tables);
  if (body.tenantId) await host.projectRolesLocal(body.tenantId, body.scopeId, ROLES);
  return c.json(result);
});
// #286: the PITR bookmarks one scope recorded before its migration passes — the
// rewind points a backout offers. Metadata only; no scope bytes cross the boundary.
app.get('/internal/bookmarks', async (c) => {
  gatePlatform(c);
  return c.json(
    await hostFor(c.env).migrationBookmarksLocal(scopeId.parse(c.req.query('scopeId'))),
  );
});
// #286's backout: rewind one scope's ENTIRE storage — schema and data — to a
// pre-migration bookmark, discarding every write since. The scope DO enforces the
// freshness window (24h without force) and restarts itself to complete the restore.
app.post('/internal/rewind', async (c) => {
  gatePlatform(c);
  const body = z
    .object({ scopeId, bookmark: z.string().min(1), force: z.boolean().optional() })
    .parse(await c.req.json());
  return c.json(
    await hostFor(c.env).rewindScopeLocal(body.scopeId, body.bookmark, { force: body.force }),
  );
});

// Resolve the caller + selected site → a scope stub. 401 if nobody. Shared route table.
async function stub(c: Context<{ Bindings: Env }>): Promise<ScopeStub> {
  const node = nodeFor(c.req.raw, c.env);
  const principal = await principalFor(c.env, c.req.raw);
  if (!principal) throw new HTTPException(401, { message: 'unauthorized' });
  return hostFor(c.env).getScope(principal, node.tenantId, node.scopeId);
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
  const node = nodeFor(c.req.raw, c.env);
  await requireAdmin(c);
  return c.json({ roles: ROLES.map((r) => r.key), invites: await identityDo(c.env, node).listInvites(node.scopeId) });
});

/** Create an invite: mint a member principal, grant it the chosen role at scope level, record
 *  the invite by token HASH (the plaintext token rides only in the returned accept link). */
app.post('/api/invites', async (c) => {
  const node = nodeFor(c.req.raw, c.env);
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
  const node = nodeFor(c.req.raw, c.env);
  await requireAdmin(c);
  await identityDo(c.env, node).revokeInvite(node.scopeId, c.req.param('principal'));
  return c.body(null, 204);
});

/** Accept an invite: the invitee has signed up (allowed by the token), and now binds their
 *  login to the pre-minted member principal. */
app.post('/api/accept-invite', async (c) => {
  const node = nodeFor(c.req.raw, c.env);
  const subject = await authProviderFor(c.env, c.req.raw).resolve(c.req.raw.headers);
  if (!subject) throw new HTTPException(401, { message: 'sign in before accepting an invite' });
  const { token } = z.object({ token: z.string().min(1) }).parse(await c.req.json());
  const principal = await identityDo(c.env, node).claimInvite(node.scopeId, subject.sub, await sha256Hex(token));
  if (!principal) throw new HTTPException(400, { message: 'this invite is invalid or already used' });
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

// The SPA is inlined into the worker (no ASSETS binding — sandbox-clean); this is the
// catch-all behind /api/* and /internal/*.
app.all('*', (c) => serveAsset(new URL(c.req.raw.url)));

export default app;
