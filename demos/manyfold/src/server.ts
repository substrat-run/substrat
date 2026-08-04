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
import { buildDemoHost, seedDemo, type ManyfoldWorld } from './index.js';
import { ROLES } from './provision.js';
import { mountApi } from './routes.js';
import { API_DOCUMENT } from './api.js';
import { DOCS_HTML } from './docs.js';

/**
 * Dev API server for Manyfold. Deliberately thin: resolve (principal, site) → getScope →
 * invoke. Every route is a wrapper over an operation; no business logic here.
 *
 * OIDC-only (oidc-only-demos.md): the vertical runs no credential store, so this dev server
 * hosts NO accounts and NO `/api/auth/*`. Local dev authenticates with the `x-principal`
 * persona picker (defaulting to a cast member so the app runs out of the box) — an
 * impersonation bypass that only ever exists on this dev-only Node server, never the worker.
 * A real login is the OIDC round-trip, exercised via the worker against a running
 * `demos/auth-server` issuer.
 *
 * Multi-scope is the twist: `x-site` selects which of the tenant's sites (scopes) the
 * request runs against — that is site SELECTION, not auth.
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

// The demo cast: their seeded principals (roles are held per site — see seed.ts). Dev picks one
// with the `x-principal` header; with none set the server defaults to the first, so the app runs
// out of the box. These are principal ids, NOT logins — real accounts live at the OIDC issuer.
const CAST: Array<{ principal: PrincipalId; name: string }> = [
  { principal: world.maja, name: 'Maja Lindqvist' },
  { principal: world.emil, name: 'Emil Berg' },
  { principal: world.sofia, name: 'Sofia Ruiz' },
];
const DEFAULT_PERSONA = CAST[0]!;
const nameOf = (p: PrincipalId): string => CAST.find((c) => c.principal === p)?.name ?? 'You';

// ── Identity: dev persona (x-principal) + selected site ───────────────────────

/**
 * The dev principal: the `x-principal` header if it names one, else the default persona so the
 * app is usable without a picker. Dev-only — this Node server is never deployed; the worker is
 * the production surface and authenticates via OIDC.
 */
function devPrincipal(headers: Headers): PrincipalId {
  const raw = headers.get('x-principal');
  if (raw) {
    const parsed = principalId.safeParse(raw);
    if (parsed.success) return parsed.data;
  }
  return DEFAULT_PERSONA.principal;
}

/** Which of the tenant's sites (scopes) this request targets — `x-site` slug, default cafe. */
function siteScope(headers: Headers): ScopeId {
  const slug = headers.get('x-site') ?? 'cafe';
  const site = siteBySlug.get(slug);
  if (!site) throw new HTTPException(404, { message: `unknown site: ${slug}` });
  return site.scopeId;
}

async function stub(c: Context): Promise<ScopeStub> {
  const principal = devPrincipal(c.req.raw.headers);
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

// No /api/auth/* here: the vertical runs no credential store (oidc-only-demos.md). Dev auth is
// the x-principal persona picker; real login is the OIDC round-trip via the worker + issuer.

// The tenant's sites — the in-app site switcher's list. Public: it is just the switcher's
// options; the kernel still checks every op per site. Mirrors the worker's shape.
app.get('/api/sites', (c) => c.json(world.sites.map((s) => ({ slug: s.slug, name: s.name }))));

// Who am I, in the selected site, and what may I do — the worker's `can` shape. Dev always
// resolves a persona (default or `x-principal`), so there is no anonymous state here.
app.get('/api/me', async (c) => {
  const principal = devPrincipal(c.req.raw.headers);
  const scope = siteScope(c.req.raw.headers);
  const who = (await (await host.getScope(principal, world.t1, scope)).invoke('manyfold/whoami', undefined)) as {
    can: Record<string, boolean>;
  };
  return c.json({ key: principal, display: nameOf(principal), site: scope, can: who.can });
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
  // Dev has no credential store: the `x-principal` persona IS the identity, so there is no login
  // to bind. The invited principal already holds its role (granted at create), so accepting just
  // consumes the invite — switch to it with `x-principal` to see the member's view. (In the
  // worker, this binds the invitee's OIDC subject to the member principal in the IdentityDO.)
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
  `    personas ${CAST.map((c) => c.name).join(', ')}  ·  default: ${DEFAULT_PERSONA.name} (set x-principal to switch)`,
  '',
];
console.log(lines.join('\n'));
