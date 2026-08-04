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
import { principalId, scopeId, tenantId, queryScopeInput, readScopeTableInput, entitlementGrant, projectedIdentityLink, resolveScopedEnvSpec, z } from '@substrat-run/contracts';
import { defineScopeDO, CloudflareScopeHost } from '@substrat-run/adapter-cloudflare';
import {
  assertPlatformCall,
  PlatformCallError,
  readRoutedNode,
  RouterAssertionError,
  ulid,
} from '@substrat-run/kernel';
import type { PrincipalId } from '@substrat-run/contracts';
import { EMPLOYEE_SELF, MODULES, ROLES } from './provision.js';
import { MERIDIAN_ENV } from './manifest.js';
import { API, API_DOCUMENT } from './api.js';
import { DOCS_HTML } from './docs.js';
import { serveAsset } from './assets.js';
import type { CompanyNode } from './auth-adapters.js';
import {
  IdentityDO,
  oidcAuthProvider,
  oidcRpAuthProvider,
  type AuthProvider,
} from '@substrat-run/vertical-auth';

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
   * Declared in MERIDIAN_ENV (src/manifest.ts) and read ONLY through
   * `resolveScopedEnvSpec` in `authWiringFor` — a delivered per-scope value overrides
   * these deployment-wide bindings (#398). Typed here so `wrangler dev --var` works.
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
 * The scope's DELIVERED auth choice (vertical-auth-detach.md §2.2/§2.3) — the
 * `substrat:auth` entry the dashboard configured at install or in Settings, stored in the
 * tenant's identity DO. Parsed leniently: an absent or malformed entry means "no choice
 * delivered" and the deployment-level default below applies, so a bad delivery can never
 * lock an instance out.
 */
const authChoice = z.object({
  // OIDC-only (oidc-only-demos.md): the vertical runs no credential store, so `oidc` is the
  // only supported mode. A delivered `builtin` (or anything else) fails this parse → treated
  // as "no choice" → the deployment default / a fail-closed 503, never a local account store.
  mode: z.literal('oidc'),
  issuer: z.string().url().optional(),
  clientId: z.string().min(1).optional(),
  clientSecret: z.string().optional(),
  audience: z.string().optional(),
  /** Share the login across every surface under this parent domain (K-26 multi-surface;
   *  `egeryds.se` covers `crm.` + `eka.`). Validated against the request host where the
   *  cookie is set (vertical-auth); applies under either mode. */
  cookieDomain: z.string().min(1).optional(),
});
export const AUTH_CONFIG_KEY = 'substrat:auth';

/**
 * The scope's auth wiring, in one DO hop: delivered config + the tenant's session secret.
 * `settings` is the ORDINARY declared environment (MERIDIAN_ENV) resolved through
 * `resolveScopedEnvSpec` over the same delivered map — per-scope Env-tab value > worker
 * binding > manifest default (#398). Every read of a declared key goes through it; a bare
 * `env.X` read would only ever see the deployment-wide default (the silent-defaults bug,
 * #374). No extra DO round-trip: the delivered map is already in hand.
 */
async function authWiringFor(env: Env, node: CompanyNode) {
  const wiring = await identityDo(env, node).authWiring(node.scopeId);
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
  const settings = resolveScopedEnvSpec(MERIDIAN_ENV, env as unknown as Record<string, unknown>, wiring.config).values;
  return { choice, sessionSecret: wiring.sessionSecret, settings };
}

/**
 * The `AuthProvider` for this request, chosen by CONFIG — the whole point of the contract.
 *
 * Per-SCOPE first (hosted): a delivered `substrat:auth` with `mode: 'oidc'` builds the
 * full relying-party provider (browser login at the issuer, cookie sessions signed with
 * the tenant's DO-minted secret, bearer fallback for API clients) — one script, many
 * issuers. `mode: 'builtin'` (or nothing delivered) falls through to the DEPLOYMENT
 * default: `AUTH_PROVIDER=oidc` env verifies bearer tokens against a fixed issuer
 * (standalone deploys), else Better Auth in the tenant's AUTH DO. The app never learns
 * which; it only ever holds an `AuthProvider`.
 */
async function authProviderFor(env: Env, req: Request): Promise<AuthProvider> {
  const node = nodeFor(req, env);
  const { choice, sessionSecret, settings } = await authWiringFor(env, node);
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
  if (settings.AUTH_PROVIDER === 'oidc') {
    if (!settings.OIDC_ISSUER) throw new HTTPException(500, { message: 'AUTH_PROVIDER=oidc but OIDC_ISSUER is unset' });
    return oidcAuthProvider({ issuer: settings.OIDC_ISSUER, ...(settings.OIDC_AUDIENCE ? { audience: settings.OIDC_AUDIENCE } : {}) });
  }
  // No builtin credential store any more (oidc-only-demos.md): the vertical owns no accounts.
  // A scope authenticates either through a delivered `substrat:auth` issuer (the RP branch
  // above) or a standalone `AUTH_PROVIDER=oidc` bearer issuer. Anything else is unconfigured —
  // fail closed rather than silently minting local Better-Auth accounts.
  throw new HTTPException(503, {
    message: "this instance has no identity provider configured — deliver substrat:auth with mode 'oidc'",
  });
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
  const subject = await (await authProviderFor(env, req)).resolve(req.headers);
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
  // #310: the tenant's entitlements, projected into the scope so ctx.entitlement + the
  // per-operation gate work here without a control-plane binding (#304). Optional so an
  // older platform (or one that hasn't granted any) provisions unchanged.
  entitlements: z.array(entitlementGrant).optional(),
  // #406: the tenant's identity links, projected so an external-IdP auth adapter could
  // resolve (provider, externalId) → principal scope-locally. Optional.
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
    entitlements: body.entitlements,
    identityLinks: body.identityLinks,
  });
  // Record the owner seat: whoever first signs in and reaches this scope claims it (becomes
  // hr-admin), whichever provider verifies them. This is how a provisioned instance becomes
  // usable by a real login without the platform knowing the login's subject up front.
  await identityDo(c.env, { tenantId: body.tenantId, scopeId: body.scopeId }).setPendingOwner(body.scopeId, body.owner);
  return c.json({ tenantId: body.tenantId, scopeId: body.scopeId, owner: body.owner }, 201);
});

/** A reconcile carries no owner — the vertical re-sources it from its own owner-of-record (#332). */
const reconcileInstanceBody = z.object({
  tenantId,
  scopeId,
  entitlements: z.array(entitlementGrant).optional(),
  identityLinks: z.array(projectedIdentityLink).optional(),
});

/**
 * Repair a scope stuck at the #332 lockout: role definitions projected but no principal holding a
 * role (e.g. a promote recreated this scope's DO storage, #321), so `permission_source = 'local'`
 * enforces against an empty tuple table and every login denies. The builder can't call the
 * platform-secret-gated `/internal/provision`, so the control plane calls THIS on their behalf
 * after checking they own the vertical. It re-sources the owner from this vertical's durable
 * owner-of-record — which lives in the per-tenant IdentityDO, a different DO from the wiped scope
 * DO, so it survives — and re-runs the idempotent provision. No owner in the body: the platform
 * never persisted one. Platform-secret gated; NOT under /api/*. Idempotent.
 */
app.post('/internal/reconcile', async (c) => {
  try {
    assertPlatformCall(c.req.raw.headers, { expectedSecret: c.env.PLATFORM_SECRET });
  } catch (e) {
    if (e instanceof PlatformCallError) throw new HTTPException(403, { message: e.message });
    throw e;
  }
  const body = reconcileInstanceBody.parse(await c.req.json());
  const owner = await identityDo(c.env, {
    tenantId: body.tenantId,
    scopeId: body.scopeId,
  }).getOwnerOfRecord(body.scopeId);
  if (!owner) {
    // No owner of record: a scope never provisioned through this vertical (a legacy install
    // predating owner-of-record, or a wrong scope id). There is nobody to re-grant, so refuse
    // actionably rather than silently succeed against a scope that would still deny every login.
    throw new HTTPException(409, {
      message: `no owner of record for scope ${body.scopeId} — cannot reconcile; re-run the full install`,
    });
  }
  await hostFor(c.env).provisionScopeLocal({
    tenantId: body.tenantId,
    scopeId: body.scopeId,
    owner: principalId.parse(owner),
    roles: ROLES,
    ownerRoleKey: 'hr-admin',
    entitlements: body.entitlements,
    identityLinks: body.identityLinks,
  });
  return c.json({ tenantId: body.tenantId, scopeId: body.scopeId, owner });
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

// The full dump behind a governed `scope pull` (preview-and-snapshots.md §8): the one
// /internal verb that deliberately moves scope bytes out; the control plane is the gate.
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

// The write half (§8): load a dump into one existing scope, replacing its data — the
// governed restore/backout, and the data hop of adopt-serving (#286). After the import
// the vertical's OWN role definitions are re-projected: a dump from a CP-full world
// carries tuples but no role definitions, and without the repair every check denies
// while /me still names the role. Roles are code-defined, so re-projecting is safe.
app.post('/internal/restore', async (c) => {
  try {
    assertPlatformCall(c.req.raw.headers, { expectedSecret: c.env.PLATFORM_SECRET });
  } catch (e) {
    if (e instanceof PlatformCallError) throw new HTTPException(403, { message: e.message });
    throw e;
  }
  const body = z
    .object({
      tenantId: tenantId.optional(),
      scopeId,
      tables: z.array(
        z.object({
          name: z.string(),
          ddl: z.string(),
          columns: z.array(z.string()),
          rows: z.array(z.array(z.unknown())),
        }),
      ),
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
  try {
    assertPlatformCall(c.req.raw.headers, { expectedSecret: c.env.PLATFORM_SECRET });
  } catch (e) {
    if (e instanceof PlatformCallError) throw new HTTPException(403, { message: e.message });
    throw e;
  }
  const scope = scopeId.parse(c.req.query('scopeId'));
  return c.json(await hostFor(c.env).migrationBookmarksLocal(scope));
});

// #286's backout: rewind one scope's ENTIRE storage — schema and data — to a
// pre-migration bookmark, discarding every write since. The scope DO enforces the
// freshness window (24h without force) and restarts itself to complete the restore;
// the control plane is the gate and the auditor.
app.post('/internal/rewind', async (c) => {
  try {
    assertPlatformCall(c.req.raw.headers, { expectedSecret: c.env.PLATFORM_SECRET });
  } catch (e) {
    if (e instanceof PlatformCallError) throw new HTTPException(403, { message: e.message });
    throw e;
  }
  const body = z
    .object({ scopeId, bookmark: z.string().min(1), force: z.boolean().optional() })
    .parse(await c.req.json());
  return c.json(
    await hostFor(c.env).rewindScopeLocal(body.scopeId, body.bookmark, { force: body.force }),
  );
});

/**
 * Upsert per-instance config on the platform's instruction (vertical-auth-detach.md
 * §2.2) — the delivery half of the dashboard's Env tab, and how a scope's
 * `substrat:auth` issuer choice arrives. Stored in the tenant's identity DO (the
 * vertical's harness store), keyed by scope; the body carries the tenant id because a
 * platform call has no router assertion to derive it from. Idempotent upserts.
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

// Any OTHER platform verb is honestly unimplemented: JSON 501, never the SPA fallback —
// an /internal/* request that reaches the SPA returns 200 text/html, which the platform's
// JSON parse turns into an opaque "internal error" (the auth-server incident, 2026-07-25).
app.all('/internal/*', (c) =>
  c.json({ error: `meridian does not implement ${c.req.method} ${new URL(c.req.url).pathname}` }, 501),
);

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
  const subject = await (await authProviderFor(c.env, c.req.raw)).resolve(c.req.raw.headers);
  if (!subject) throw new HTTPException(401, { message: 'sign in before accepting an invite' });
  const { token } = z.object({ token: z.string().min(1) }).parse(await c.req.json());
  const principal = await identityDo(c.env, node).claimInvite(node.scopeId, subject.sub, await sha256Hex(token));
  if (!principal) throw new HTTPException(400, { message: 'this invite is invalid or already used' });
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
