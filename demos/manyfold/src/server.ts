import { mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import Database from 'better-sqlite3';
import type { ScopeStub } from '@substrat-run/kernel';
import { PLATFORM_REQUEST_HEADER, ulid } from '@substrat-run/kernel';
import { platformActorId, principalId, z, type PlatformActorId, type PrincipalId, type ScopeId } from '@substrat-run/contracts';
import { devLogin, type DevCaller } from '@substrat-run/dev-issuer';
import { buildDemoHost, seedDemo, type ManyfoldWorld } from './index.js';
import { DEV_PROVIDER } from './personas.js';
import { ROLES } from './provision.js';
import { mountApi } from './routes.js';
import { API_DOCUMENT } from './api.js';
import { DOCS_HTML } from './docs.js';

/**
 * Dev API server for Manyfold. Deliberately thin: resolve (principal, site) → getScope →
 * invoke. Every route is a wrapper over an operation; no business logic here.
 *
 * OIDC-only (oidc-only-demos.md) and, since the dev issuer, with no dev branch: this server
 * runs the same relying-party flow the worker does, against whichever issuer `OIDC_ISSUER`
 * names. What stood here was an `x-principal` header that defaulted to the first persona —
 * so the app came up already signed in as somebody, which is the one thing a hosted instance
 * never does, and the sign-in screen was consequently unreachable in dev.
 *
 * Multi-scope is the twist, and it is untouched: `x-site` selects which of the tenant's sites
 * (scopes) the request runs against. Selection is not authentication — the login says who you
 * are, the site says where, and the kernel re-checks your authority in that scope either way.
 */

const dataDir = join(dirname(fileURLToPath(import.meta.url)), '..', '.data');
mkdirSync(dataDir, { recursive: true });

// Dev ports sit in the private 887x/527x block. Override: PORT=… WEB_PORT=… pnpm --filter … dev
const port = Number(process.env.PORT ?? 8876);
const webPort = Number(process.env.WEB_PORT ?? 5276);
const apiOrigin = `http://localhost:${port}`;
const webOrigin = `http://localhost:${webPort}`;

const host = buildDemoHost(dataDir);
const world: ManyfoldWorld = await seedDemo(host, dataDir);

const staff: PlatformActorId = platformActorId.parse(ulid());
const siteBySlug = new Map(world.sites.map((s) => [s.slug, s]));

// ── Identity: the relying party + the selected site ──────────────────────────

/**
 * The relying party — login, callback, logout, and `sub` → principal through the identity
 * directory. Identical to the worker's; only the issuer differs, and it differs by config.
 */
const login = devLogin({ directory: host.admin, actor: staff, provider: DEV_PROVIDER });

/** The caller, or 401. Manyfold takes the TENANT from the link and the scope from `x-site`. */
async function callerFor(c: Context): Promise<DevCaller> {
  const caller = await login.caller(c.req.raw.headers);
  if (!caller) throw new HTTPException(401, { message: 'unauthorized' });
  return caller;
}

/** Which of the tenant's sites (scopes) this request targets — `x-site` slug, default cafe. */
function siteScope(headers: Headers): ScopeId {
  const slug = headers.get('x-site') ?? 'cafe';
  const site = siteBySlug.get(slug);
  if (!site) throw new HTTPException(404, { message: `unknown site: ${slug}` });
  return site.scopeId;
}

async function stub(c: Context): Promise<ScopeStub> {
  const { principal } = await callerFor(c);
  // #458 parity with the worker: flag responses whose operation enqueued a platform
  // intent. No router locally, so the header is inert — but visible when driving the API.
  return host.getScope(principal, world.t1, siteScope(c.req.raw.headers), {
    onPlatformRequests: () => c.header(PLATFORM_REQUEST_HEADER, '1'),
  });
}

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const app = new Hono();

app.onError((err, c) => {
  if (err instanceof HTTPException) return err.getResponse();
  const m = err instanceof Error ? err.message : String(err);
  if (/permission denied/i.test(m)) return c.json({ error: m }, 403);
  if (/not found|unknown scope/.test(m)) return c.json({ error: m }, 404);
  return c.json({ error: m }, 400);
});

// The relying-party endpoints — login, callback, logout. Accounts, passwords and sign-up
// live at the issuer; the vertical runs no credential store (oidc-only-demos.md).
app.on(['GET', 'POST'], '/api/auth/*', (c) => login.handle(c.req.raw));

// The tenant's sites — the in-app site switcher's list. Public: it is just the switcher's
// options; the kernel still checks every op per site. Mirrors the worker's shape.
app.get('/api/sites', (c) => c.json(world.sites.map((s) => ({ slug: s.slug, name: s.name }))));

// Who am I, in the selected site, and what may I do — the worker's `can` shape, and its 401
// too: with a real login there IS an anonymous state here now, and the app's sign-in screen
// is reachable in dev for the first time.
app.get('/api/me', async (c) => {
  const caller = await login.caller(c.req.raw.headers);
  if (!caller) return c.json({ error: 'unauthorized' }, 401);
  const scope = siteScope(c.req.raw.headers);
  const who = (await (await host.getScope(caller.principal, world.t1, scope)).invoke('manyfold/whoami', undefined)) as {
    can: Record<string, boolean>;
  };
  return c.json({ key: caller.principal, display: caller.display, site: scope, can: who.can });
});

// ── Members & invites (the post-setup join path — admin-only) ────────────────
// A small node store keyed by (scope, principal); the pre-minted principal holds the role
// immediately (a grant), and accepting binds the invitee's login to it. Mirrors the worker.
const invitesDb = new Database(join(dataDir, 'invites.sqlite'));
invitesDb.pragma('journal_mode = WAL');
invitesDb.exec(
  `CREATE TABLE IF NOT EXISTS manyfold_dev_invites (
     scope_id TEXT NOT NULL, principal TEXT NOT NULL, role_key TEXT NOT NULL,
     email TEXT, token_hash TEXT NOT NULL, created_at INTEGER NOT NULL,
     PRIMARY KEY (scope_id, principal));`,
);

const inviteBody = z.object({ email: z.string().email().optional(), roleKey: z.string().min(1) });

/** Require the caller to hold admin in the selected site (content:admin). */
async function requireAdmin(c: Context): Promise<void> {
  const who = (await (await stub(c)).invoke('manyfold/whoami', undefined)) as { can: { admin: boolean } };
  if (!who.can.admin) throw new HTTPException(403, { message: 'only an admin can manage members' });
}

app.get('/api/invites', async (c) => {
  await requireAdmin(c);
  const scope = siteScope(c.req.raw.headers);
  const invites = invitesDb
    .prepare('SELECT principal, role_key as roleKey, email, created_at as createdAt FROM manyfold_dev_invites WHERE scope_id = ? ORDER BY created_at DESC')
    .all(scope);
  return c.json({ roles: ROLES.map((r) => r.key), invites });
});

app.post('/api/invites', async (c) => {
  await requireAdmin(c);
  const scope = siteScope(c.req.raw.headers);
  const { email, roleKey } = inviteBody.parse(await c.req.json());
  if (!ROLES.some((r) => r.key === roleKey)) throw new HTTPException(400, { message: `unknown role '${roleKey}'` });
  const principal = principalId.parse(ulid());
  const token = (crypto.randomUUID() + crypto.randomUUID()).replace(/-/g, ''); // 256 bits, URL-safe
  await host.admin.assignRole(staff, { principalId: principal, roleKey, node: { tenantId: world.t1, scopeId: scope } });
  invitesDb
    .prepare('INSERT INTO manyfold_dev_invites (scope_id, principal, role_key, email, token_hash, created_at) VALUES (?,?,?,?,?,?)')
    .run(scope, principal, roleKey, email ?? null, await sha256Hex(token), Date.now());
  // The invite link opens the WEB app (Vite), not this API origin.
  return c.json({ principal, roleKey, email: email ?? null, acceptUrl: `${webOrigin}/?invite=${token}` }, 201);
});

app.post('/api/invites/:principal/revoke', async (c) => {
  await requireAdmin(c);
  const scope = siteScope(c.req.raw.headers);
  invitesDb.prepare('DELETE FROM manyfold_dev_invites WHERE scope_id = ? AND principal = ?').run(scope, c.req.param('principal'));
  return c.body(null, 204);
});

app.post('/api/accept-invite', async (c) => {
  // Accepting consumes the invite; the invited principal already holds its role (granted at
  // create). It does NOT rebind your login the way the worker does: the worker's IdentityDO is
  // keyed per (scope, sub) and can hold several bindings for one subject, while the SQLite
  // directory behind this server is keyed per (tenant, provider, sub) and holds exactly one.
  // To see the member's view locally, sign in as the persona that was invited.
  const { token } = z.object({ token: z.string().min(1) }).parse(await c.req.json());
  const row = invitesDb
    .prepare('SELECT scope_id as scopeId, principal FROM manyfold_dev_invites WHERE token_hash = ?')
    .get(await sha256Hex(token)) as { scopeId: string; principal: string } | undefined;
  if (!row) throw new HTTPException(400, { message: 'this invite is invalid or already used' });
  invitesDb.prepare('DELETE FROM manyfold_dev_invites WHERE scope_id = ? AND principal = ?').run(row.scopeId, row.principal);
  return c.json({ ok: true, principal: row.principal });
});

// The OpenAPI document + Scalar reference (design/api-surface.md). Open in dev (no credential
// store); the worker gates it on a real session.
app.get('/openapi.json', (c) => c.json(API_DOCUMENT));
app.get('/api/docs', (c) => c.html(DOCS_HTML));
const scalarJs = join(
  dirname(fileURLToPath(import.meta.url)),
  '..', 'node_modules', '@scalar', 'api-reference', 'dist', 'browser', 'standalone.js',
);
app.get('/assets/scalar-api-reference.js', (c) =>
  c.body(readFileSync(scalarJs, 'utf8'), 200, { 'content-type': 'text/javascript; charset=utf-8' }),
);

// The whole data API — shared with the Cloudflare Worker (src/routes.ts).
mountApi(app, stub);

serve({ fetch: app.fetch, port });

const lines = [
  '',
  '  substrat · Manyfold API — multi-scope headless CMS',
  '  ' + '─'.repeat(52),
  `      vertical API   ${apiOrigin}`,
  `      app (vite)     ${webOrigin}`,
  '  ' + '─'.repeat(52),
  `    data     ${dataDir}`,
  `    sites    ${world.sites.map((s) => s.slug).join(', ')}`,
  `    auth     OIDC · ${login.issuer}`,
  '',
];
console.log(lines.join('\n'));
