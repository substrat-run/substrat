import { mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import Database from 'better-sqlite3';
import type { ScopeStub } from '@substrat-run/kernel';
import { ulid } from '@substrat-run/kernel';
import { platformActorId, principalId, z, type PlatformActorId, type PrincipalId, type ScopeId } from '@substrat-run/contracts';
import { buildDemoHost, seedDemo, type ManyfoldWorld } from './index.js';
import { ROLES } from './provision.js';
import { buildAuthNode, migrateAuth } from './auth-node.js';
import { mountApi } from './routes.js';
import { API_DOCUMENT } from './api.js';
import { DOCS_HTML } from './docs.js';

/**
 * Dev API server for Manyfold. Deliberately thin: resolve (principal, site) → getScope →
 * invoke. Every route is a wrapper over an operation; no business logic here.
 *
 * Auth is REAL and the same shape as the deployed worker: a Better Auth session cookie →
 * a verified subject → the principal that login is bound to (the kernel's identity
 * directory). There is NO `x-principal` impersonation bypass — dev and prod authenticate
 * the same way; the dev server just seeds a login per cast member so the demo runs out of
 * the box, and prints the credentials on startup.
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

// Better Auth — its own store, migrated on startup. The browser hits /api/auth/* through
// the Vite proxy, so BOTH origins must be trusted or login silently fails on the one left out.
const auth = buildAuthNode(dataDir, apiOrigin, [apiOrigin, webOrigin]);
await migrateAuth(auth);

const staff: PlatformActorId = platformActorId.parse(ulid());
const siteBySlug = new Map(world.sites.map((s) => [s.slug, s]));

// The demo cast: a real login each, bound to the seeded principal (roles are held per site
// — see seed.ts). Sign in as any of these; the password is shared for the demo.
const DEMO_PASSWORD = 'manyfold-demo';
const LOGINS: Array<{ principal: PrincipalId; email: string; name: string }> = [
  { principal: world.maja, email: 'maja@manyfold.test', name: 'Maja Lindqvist' },
  { principal: world.emil, email: 'emil@manyfold.test', name: 'Emil Berg' },
  { principal: world.sofia, email: 'sofia@manyfold.test', name: 'Sofia Ruiz' },
];

/** Seed a login per cast member and bind it to their principal. Idempotent on both stores. */
async function seedPersonaLogins(): Promise<void> {
  const db = new Database(join(dataDir, 'better-auth.sqlite'), { readonly: true });
  try {
    for (const p of LOGINS) {
      let externalId: string | undefined;
      try {
        externalId = (await auth.api.signUpEmail({ body: { email: p.email, password: DEMO_PASSWORD, name: p.name } })).user.id;
      } catch {
        externalId = (db.prepare('SELECT id FROM user WHERE email = ?').get(p.email) as { id: string } | undefined)?.id;
      }
      if (!externalId) continue;
      if (await host.admin.resolveIdentity(world.t1, 'better-auth', externalId)) continue;
      await host.admin.linkIdentity(staff, {
        provider: 'better-auth',
        externalId,
        principal: p.principal,
        tenantId: world.t1,
        scopeId: world.cafe,
      });
    }
  } finally {
    db.close();
  }
}

// ── Identity: session → principal + selected site ────────────────────────────

/** The Better Auth session's subject → the principal that login is bound to, or null. */
async function principalFromSession(headers: Headers): Promise<PrincipalId | null> {
  const session = await auth.api.getSession({ headers });
  if (!session?.user) return null;
  const mapped = await host.admin.resolveIdentity(world.t1, 'better-auth', session.user.id);
  return mapped ? principalId.parse(mapped.principal) : null;
}

/** Which of the tenant's sites (scopes) this request targets — `x-site` slug, default cafe. */
function siteScope(headers: Headers): ScopeId {
  const slug = headers.get('x-site') ?? 'cafe';
  const site = siteBySlug.get(slug);
  if (!site) throw new HTTPException(404, { message: `unknown site: ${slug}` });
  return site.scopeId;
}

async function stub(c: Context): Promise<ScopeStub> {
  const principal = await principalFromSession(c.req.raw.headers);
  if (!principal) throw new HTTPException(401, { message: 'unauthorized' });
  return host.getScope(principal, world.t1, siteScope(c.req.raw.headers));
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

// Better Auth owns /api/auth/* (sign-up, sign-in, sign-out, session). Open in dev — a login
// unknown to the directory resolves to nobody (401 from /api/me), same as the worker.
app.on(['GET', 'POST'], '/api/auth/*', (c) => auth.handler(c.req.raw));

// The tenant's sites — the in-app site switcher's list. Public: it is just the switcher's
// options; the kernel still checks every op per site. Mirrors the worker's shape.
app.get('/api/sites', (c) => c.json(world.sites.map((s) => ({ slug: s.slug, name: s.name }))));

// Who am I, in the selected site, and what may I do — the worker's `can` shape. 401 = anon.
app.get('/api/me', async (c) => {
  const principal = await principalFromSession(c.req.raw.headers);
  if (!principal) return c.json({ error: 'unauthorized' }, 401);
  const scope = siteScope(c.req.raw.headers);
  const who = (await (await host.getScope(principal, world.t1, scope)).invoke('manyfold/whoami', undefined)) as {
    can: Record<string, boolean>;
  };
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  return c.json({ key: principal, display: session?.user?.name ?? session?.user?.email ?? 'You', site: scope, can: who.can });
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
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!session?.user) throw new HTTPException(401, { message: 'sign in before accepting an invite' });
  const { token } = z.object({ token: z.string().min(1) }).parse(await c.req.json());
  const row = invitesDb
    .prepare('SELECT scope_id as scopeId, principal FROM manyfold_dev_invites WHERE token_hash = ?')
    .get(await sha256Hex(token)) as { scopeId: string; principal: string } | undefined;
  if (!row) throw new HTTPException(400, { message: 'this invite is invalid or already used' });
  await host.admin.linkIdentity(staff, {
    provider: 'better-auth',
    externalId: session.user.id,
    principal: principalId.parse(row.principal),
    tenantId: world.t1,
    scopeId: row.scopeId as ScopeId,
  });
  invitesDb.prepare('DELETE FROM manyfold_dev_invites WHERE scope_id = ? AND principal = ?').run(row.scopeId, row.principal);
  return c.json({ ok: true, principal: row.principal });
});

// The OpenAPI document + Scalar reference (design/api-surface.md). Session-gated like the
// rest of /api/* — the persona headers are gone, so the docs require a real login too.
app.get('/openapi.json', async (c) => {
  if (!(await principalFromSession(c.req.raw.headers))) throw new HTTPException(401, { message: 'unauthorized' });
  return c.json(API_DOCUMENT);
});
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

await seedPersonaLogins();

serve({ fetch: app.fetch, port });

const lines = [
  '',
  '  substrat · Manyfold API — multi-scope headless CMS',
  '  ' + '─'.repeat(52),
  `      vertical API   ${apiOrigin}`,
  `      app (vite)     ${webOrigin}`,
  '  ' + '─'.repeat(52),
  `    data   ${dataDir}`,
  `    sites  ${world.sites.map((s) => s.slug).join(', ')}`,
  `    logins ${LOGINS.map((l) => l.email).join(', ')}  ·  password: ${DEMO_PASSWORD}`,
  '',
];
console.log(lines.join('\n'));
