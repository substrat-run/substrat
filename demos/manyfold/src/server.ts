import { mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { ScopeStub } from '@substrat-run/kernel';
import type { PrincipalId, ScopeId } from '@substrat-run/contracts';
import { buildDemoHost, seedDemo, type ManyfoldWorld } from './index.js';
import { mountApi } from './routes.js';
import { API_DOCUMENT } from './api.js';
import { DOCS_HTML } from './docs.js';

/**
 * Dev API server for Manyfold. Deliberately thin: resolve (principal, site) from the
 * dev headers → getScope → invoke. Every route is a wrapper over an operation; no
 * business logic here. The `x-principal`/`x-site` picker is a DEV impersonation
 * bypass — fine for a local demo, replaced by the vertical's own IdentityDO auth when
 * hosted (vertical-auth). Multi-scope is the twist: `x-site` selects which of the
 * tenant's sites (scopes) the request runs against.
 */

const dataDir = join(dirname(fileURLToPath(import.meta.url)), '..', '.data');
mkdirSync(dataDir, { recursive: true });

// Dev ports sit in the private 887x/527x block. Override: PORT=… WEB_PORT=… pnpm --filter … dev
const port = Number(process.env.PORT ?? 8876);
const webPort = Number(process.env.WEB_PORT ?? 5276);

const host = buildDemoHost(dataDir);
const world: ManyfoldWorld = await seedDemo(host, dataDir);

// The dev persona picker: who you can be, and the role each holds per site. The app
// sends `x-principal` (id) + `x-site` (slug); the server maps both.
interface Persona {
  id: PrincipalId;
  name: string;
  roles: Record<string, string>; // site slug → role
}
const PERSONAS: Persona[] = [
  { id: world.maja, name: 'Maja Lindqvist', roles: { cafe: 'admin', padel: 'admin', law: 'admin' } },
  { id: world.emil, name: 'Emil Berg', roles: { cafe: 'publisher', padel: 'author', law: 'viewer' } },
  { id: world.sofia, name: 'Sofia Ruiz', roles: { cafe: 'author' } },
];
const siteBySlug = new Map(world.sites.map((s) => [s.slug, s]));

function resolve(c: Context): { principal: Persona; scopeId: ScopeId; siteSlug: string } {
  const pid = c.req.header('x-principal');
  const persona = PERSONAS.find((p) => p.id === pid);
  if (!persona) throw new HTTPException(401, { message: 'unauthorized: unknown x-principal' });
  const siteSlug = c.req.header('x-site') ?? 'cafe';
  const site = siteBySlug.get(siteSlug);
  if (!site) throw new HTTPException(404, { message: `unknown site: ${siteSlug}` });
  return { principal: persona, scopeId: site.scopeId, siteSlug };
}

async function stub(c: Context): Promise<ScopeStub> {
  const { principal, scopeId } = resolve(c);
  return host.getScope(principal.id, world.t1, scopeId);
}

const app = new Hono();

// Dev-only picker surfaces (the worker replaces these with real IdentityDO auth).
app.get('/api/personas', (c) => c.json(PERSONAS.map((p) => ({ id: p.id, name: p.name, roles: p.roles }))));
app.get('/api/sites', (c) => c.json(world.sites.map((s) => ({ slug: s.slug, name: s.name }))));
app.get('/api/me', (c) => {
  const { principal, siteSlug } = resolve(c);
  return c.json({ principal: principal.id, name: principal.name, site: siteSlug, role: principal.roles[siteSlug] ?? null });
});

// The OpenAPI document + Scalar reference (design/api-surface.md). Dev posture:
// open like every other dev route — the persona headers are the auth here. The
// renderer is served from the pinned package, never a CDN.
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
  `      vertical API   http://localhost:${port}`,
  `      app (vite)     http://localhost:${webPort}`,
  '  ' + '─'.repeat(52),
  `    data   ${dataDir}`,
  `    sites  ${world.sites.map((s) => s.slug).join(', ')}`,
  `    try    curl -s -XPOST localhost:${port}/api/op/list-delivery \\`,
  `             -H 'x-principal: ${world.emil}' -H 'x-site: cafe' -H 'content-type: application/json' -d '{}'`,
  '',
];
console.log(lines.join('\n'));
