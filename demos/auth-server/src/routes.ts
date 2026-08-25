/**
 * The auth-server's HTTP surface (`routes.ts`, the conventional harness name), split from
 * `worker.ts` so it never touches
 * `cloudflare:workers` and node tests can drive it with a fake `AUTH` namespace.
 *
 * Which issuer DO answers depends on how the request arrived:
 *
 *   - HOSTED (dispatch namespace, behind the router): the router asserts
 *     `hostname → (tenant, scope)` in signed headers (K-26), and the SCOPE id names the
 *     DO — one issuer per installed Auth Server app.
 *   - STANDALONE (own worker, own hostname, no router): no assertion ⇒ the fixed
 *     single-issuer name — the original deployment shape, unchanged.
 *
 * The platform surface (K-31) is `/internal/*`, gated by `PLATFORM_SECRET`:
 * `/internal/provision` materializes an instance, `/internal/configure` delivers config,
 * `/internal/tables` answers the §5.4 introspection reads (secrets redacted in the DO),
 * `/internal/export` dumps an instance in full and `/internal/delete-scope` wipes one
 * (#590 — backed-up reap, wipe, and data-carrying rebind);
 * every OTHER `/internal/*` path answers a JSON 501 — NEVER the SPA fallback. (A platform
 * call once fell through to the SPA catch-all, returned 200 text/html, and surfaced as
 * "Provisioning failed — internal error" in the dashboard. The fallback route and its
 * test pin the fix.)
 */
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { tenantId, scopeId, principalId, readScopeTableInput } from '@substrat-run/contracts';
import {
  readRoutedNode,
  RouterAssertionError,
  assertPlatformCall,
  PlatformCallError,
} from '@substrat-run/kernel';
import type { AuthServerStub } from './do-contract.js';
import { serveAsset } from './assets.js';

/**
 * The worker env, structurally: `AUTH` is the real `DurableObjectNamespace<AuthServerDO>`
 * in production and a plain fake in tests (method params are bivariant, so both satisfy
 * this). `ROUTER_SECRET`/`PLATFORM_SECRET` are injected by the WfP uploader on the hosted
 * path and simply unset on a standalone deploy.
 */
export interface Env {
  AUTH: { idFromName(name: string): unknown; get(id: unknown): unknown };
  /** Optional issuer pin; unset ⇒ the issuer derives from each request's own origin. */
  PUBLIC_ORIGIN?: string;
  /** Shared secret the router presents (K-26). Unset ⇒ standalone (no router expected). */
  ROUTER_SECRET?: string;
  /** Shared secret the platform presents to provision here (K-31). Unset ⇒ refused. */
  PLATFORM_SECRET?: string;
}

/** The STANDALONE issuer's fixed DO name — one deployment, one issuer (the original shape). */
const STANDALONE_ISSUER = 'auth-server';

function stubFor(env: Env, name: string): AuthServerStub {
  return env.AUTH.get(env.AUTH.idFromName(name)) as AuthServerStub;
}

/**
 * The issuer DO for THIS request: the routed scope's own issuer behind the router, the
 * fixed single issuer standalone. Present-but-wrong router headers are a 400, never a
 * fall-through — collapsing them into "standalone" would let a spoofed assertion reach
 * the shared fixed-name DO.
 *
 * Routed assertions are honored ONLY when `ROUTER_SECRET` is configured. A standalone
 * deploy has a PUBLIC route, so an unsigned `x-substrat-scope` header is attacker
 * reachable — honoring it would let a stranger address (and bootstrap) a phantom issuer
 * DO under the real hostname. No secret ⇒ every request is the one standalone issuer.
 */
function issuerFor(env: Env, req: Request): AuthServerStub {
  if (!env.ROUTER_SECRET) return stubFor(env, STANDALONE_ISSUER);
  let routed;
  try {
    routed = readRoutedNode(req.headers, { expectedSecret: env.ROUTER_SECRET });
  } catch (e) {
    if (e instanceof RouterAssertionError) throw new HTTPException(400, { message: e.message });
    throw e;
  }
  return stubFor(env, routed ? routed.scopeId : STANDALONE_ISSUER);
}

/** Throw 403 unless the request proves it came from the platform (fails closed unconfigured). */
function assertPlatform(env: Env, req: Request): void {
  try {
    assertPlatformCall(req.headers, { expectedSecret: env.PLATFORM_SECRET });
  } catch (e) {
    if (e instanceof PlatformCallError) throw new HTTPException(403, { message: e.message });
    throw e;
  }
}

const provisionInstanceBody = z.object({
  tenantId,
  scopeId,
  owner: principalId,
  slug: z.string().min(1),
  name: z.string().min(1),
  /** Per-instance config delivered WITH provisioning (e.g. the bootstrap ADMIN_*). */
  config: z.record(z.string().min(1), z.string()).optional(),
});

const configureInstanceBody = z.object({
  scopeId,
  entries: z.array(z.object({ key: z.string().min(1), value: z.string() })).min(1),
});

const app = new Hono<{ Bindings: Env }>();

/**
 * Pre-auth state: is the issuer awaiting its first administrator, and is self-service
 * sign-up open? The SPA picks between "create the first admin", "sign in" and "sign up"
 * from this one read — all three screens are reachable by someone with no session, so it
 * is the one route here that authenticates nobody.
 */
app.get('/api/setup-state', async (c) => c.json(await issuerFor(c.env, c.req.raw).issuerState()));

/**
 * Create the first administrator — allowed only while the issuer has zero users (the DO
 * enforces this fail-closed). After this, all account creation goes through the admin API,
 * which requires an existing admin.
 */
app.post('/api/setup', async (c) => {
  const body = await c.req.json<{ email?: string; password?: string; name?: string }>();
  if (!body.email || !body.password || !body.name) {
    throw new HTTPException(400, { message: 'email, password and name are required' });
  }
  if (body.password.length < 8) throw new HTTPException(400, { message: 'password must be at least 8 characters' });
  try {
    const { id } = await issuerFor(c.env, c.req.raw).setupFirstAdmin(new URL(c.req.url).origin, {
      email: body.email,
      password: body.password,
      name: body.name,
    });
    return c.json({ ok: true, id }, 201);
  } catch (e) {
    throw new HTTPException(409, { message: e instanceof Error ? e.message : 'setup failed' });
  }
});

/**
 * The issuer's OWN admin API — the relying-party registry and the sign-up setting, which
 * Better Auth has no endpoints for. Forwarded whole to the issuer DO (`/__admin/*`), where
 * the `admin` gate and the SQLite both live; the worker adds no gate of its own, exactly as
 * it adds none in front of Better Auth's admin API below. MUST precede the SPA catch-all.
 */
app.all('/api/admin/*', (c) => {
  const url = new URL(c.req.url);
  url.pathname = url.pathname.replace('/api/admin', '/__admin');
  return issuerFor(c.env, c.req.raw).fetch(new Request(url, c.req.raw));
});

/** The verified subject + role behind the current session, or null (the SPA's session probe). */
app.get('/api/session', async (c) => {
  const res = await issuerFor(c.env, c.req.raw).fetch(
    new Request(`${new URL(c.req.url).origin}/__session`, { headers: c.req.raw.headers }),
  );
  return c.json(await res.json());
});

/**
 * OIDC discovery and the RFC 8414 authorization-server metadata, at the ROOT — where a
 * standard relying party looks, deriving `{issuer}/.well-known/openid-configuration` from the
 * issuer it was configured with.
 *
 * This used to REWRITE the path: the 1.6 plugin served the document under the Better Auth
 * base path, so the root was an alias onto `/api/auth/.well-known/…`. `oauthProvider` answers
 * the root itself, and that alias now points at a 404 — so this forwards the request
 * unchanged and the rewriting is gone rather than kept "just in case".
 */
app.get('/.well-known/:document{(openid-configuration|oauth-authorization-server)}', (c) =>
  issuerFor(c.env, c.req.raw).fetch(c.req.raw),
);

// The whole Better Auth surface — sign-in/up, password reset, the OIDC endpoints
// (authorize, token, userinfo, jwks, register, endsession), and the admin API — lives in the
// issuer DO. The worker only forwards; it never runs Better Auth itself. Better Auth's own
// admin endpoints enforce the `admin` role, so no extra gating is needed here.
app.on(['GET', 'POST', 'OPTIONS'], '/api/auth/*', (c) => issuerFor(c.env, c.req.raw).fetch(c.req.raw));

/**
 * Provision ONE instance on the platform's instruction (K-31). The shared control plane
 * owns this scope's directory row + entitlements already; the vertical's job is only its
 * OWN state — waking the scope's issuer DO materializes it (schema + signing secret), and
 * the metadata write records what it is. Platform-secret gated; NOT under `/api/*`.
 * Idempotent (the reconciliation sweep re-runs exactly this). The DO is addressed by the
 * BODY's scope id — a platform call carries no router assertion.
 */
app.post('/internal/provision', async (c) => {
  assertPlatform(c.env, c.req.raw);
  const body = provisionInstanceBody.parse(await c.req.json());
  await stubFor(c.env, body.scopeId).provisionInstance(
    { tenantId: body.tenantId, scopeId: body.scopeId, slug: body.slug, name: body.name },
    body.config ? Object.entries(body.config).map(([key, value]) => ({ key, value })) : undefined,
  );
  return c.json({ tenantId: body.tenantId, scopeId: body.scopeId, owner: body.owner }, 201);
});

/**
 * Upsert per-instance config on the platform's instruction (vertical-auth-detach.md
 * §2.2) — the delivery half of the dashboard's Env tab. Same gate and addressing as
 * provisioning: platform-secret, the BODY's scope id. Idempotent upserts; the DO decides
 * what the keys mean (only declared env-spec keys take effect).
 */
app.post('/internal/configure', async (c) => {
  assertPlatform(c.env, c.req.raw);
  const body = configureInstanceBody.parse(await c.req.json());
  await stubFor(c.env, body.scopeId).setInstanceConfig(body.entries);
  return c.json({ applied: body.entries.length });
});

/**
 * Read-only introspection of one instance's issuer DB (§5.4's admin-query RPC) — what the
 * dashboard's Data tab reads, via the control plane's `VerticalClient`. Same gate and
 * addressing as provisioning: platform-secret, the QUERY's scope id (a platform call
 * carries no router assertion). The DO redacts secret-bearing columns before answering,
 * so no credential material ever leaves it. MUST precede the `/internal/*` 501 catch-all.
 */
app.get('/internal/tables', async (c) => {
  assertPlatform(c.env, c.req.raw);
  const scope = scopeId.parse(c.req.query('scopeId'));
  return c.json(await stubFor(c.env, scope).introspectTables());
});

app.get('/internal/tables/:table', async (c) => {
  assertPlatform(c.env, c.req.raw);
  const scope = scopeId.parse(c.req.query('scopeId'));
  const input = readScopeTableInput.parse({
    table: c.req.param('table'),
    limit: c.req.query('limit') ? Number(c.req.query('limit')) : undefined,
    offset: c.req.query('offset') ? Number(c.req.query('offset')) : undefined,
  });
  try {
    return c.json(await stubFor(c.env, scope).introspectTable(input.table, input.limit, input.offset));
  } catch (e) {
    // The DO refuses names outside its live schema; that is an addressing miss (404),
    // not a bad request — the control plane relays the vertical's status verbatim.
    if (e instanceof Error && e.message.startsWith('unknown table')) {
      throw new HTTPException(404, { message: e.message });
    }
    throw e;
  }
});

/**
 * The scope's FULL dump (#590) — the one verb here that deliberately moves instance
 * bytes out, and deliberately UNredacted (see `dump.ts`): a dump exists to rebuild the
 * issuer elsewhere, so the credentials must ride along. The control-plane route in
 * front is the gate, the auditor, and the default masker — same trust line as every
 * other vertical's export. Same addressing as provisioning: the QUERY's scope id.
 * What this buys an auth-server install: retire-with-backup (#493) stops refusing,
 * and a data-carrying `rebindScopeVertical` can move it between lineages.
 */
app.get('/internal/export', async (c) => {
  assertPlatform(c.env, c.req.raw);
  const scope = scopeId.parse(c.req.query('scopeId'));
  return c.json(await stubFor(c.env, scope).exportDump());
});

/**
 * Wipe one instance's storage irreversibly (#590) — the vertical's half of a reap or a
 * carried rebind. The refusals (backup-first, fork-only, directory cleanup) live on the
 * control plane, which calls this BEFORE deleting the directory row, so a crash between
 * the two converges on retry — and `storageStranded` stops appearing for these installs.
 * Same gate and addressing as provisioning: platform-secret, the BODY's scope id.
 */
app.post('/internal/delete-scope', async (c) => {
  assertPlatform(c.env, c.req.raw);
  const body = z.object({ scopeId }).parse(await c.req.json());
  await stubFor(c.env, body.scopeId).destroyStorage();
  return c.json({ deleted: body.scopeId });
});

/**
 * Every OTHER platform verb (snapshot, restore, rewind …) is honestly unimplemented:
 * a JSON 501 the control plane's error mapping can surface verbatim. This MUST precede the
 * SPA catch-all — an `/internal/*` request that falls through to the SPA returns 200
 * text/html, which the platform's JSON parse turns into an unrecognized throw and the
 * dashboard renders as "internal error" (the 2026-07-25 provisioning incident).
 */
app.all('/internal/*', (c) =>
  c.json({ error: `auth-server does not implement ${c.req.method} ${new URL(c.req.url).pathname}` }, 501),
);

// Serve the inlined admin SPA for everything else. MUST come last so the routes above win.
app.all('*', (c) => serveAsset(new URL(c.req.url)));

app.onError((err, c) => {
  const status = err instanceof HTTPException ? err.status : 400;
  return c.json({ error: err instanceof Error ? err.message : String(err) }, status);
});

export default app;
