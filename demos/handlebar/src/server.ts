import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import type { Context } from 'hono';
import {
  PAGE_LINK_HEADER,
  listPageQuery,
  nextPageLink,
  platformActorId,
  type Page,
  type TimelineEntry,
} from '@substrat-run/contracts';
import { PermissionDenied, ulid, type ScopeStub } from '@substrat-run/kernel';
import { mountOperations, problemResponse } from '@substrat-run/vertical-host';
import {
  handlebarInvoicingRoutes,
  handlebarOperations,
  handlebarProtocolRoutes,
  handlebarWorkorderRoutes,
} from './operations.js';
import { devLogin } from '@substrat-run/dev-issuer';
import { buildBikeShopHost, seedBikeShop, linkDevPersonas, type BikeShopWorld } from './index.js';
import { DEV_PROVIDER } from './personas.js';

/**
 * Dev API server for the Handlebar demo. Deliberately thin: authenticate → getScope →
 * invoke. Every route is a wrapper over an operation; there is no business logic here.
 * Runs on :8872 so it can sit next to the Callout demo (:8871).
 *
 * Authentication is an ordinary OIDC round-trip against whatever `OIDC_ISSUER` names —
 * locally `@substrat-run/dev-issuer`, a real provider you sign into by picking a name.
 * It replaced an `x-principal` header that named any principal and was believed: an
 * impersonation bypass, and in a vertical whose app had no login screen at all, also the
 * only "login" anybody reading this would ever have seen.
 *
 * The workshop runs no credential store. Which principal a login IS lives in the identity
 * directory, and a subject with no link there resolves to nobody — registering an email
 * does not make you staff at a bike workshop.
 */

const dataDir = join(dirname(fileURLToPath(import.meta.url)), '..', '.data');
mkdirSync(dataDir, { recursive: true });

const host = buildBikeShopHost(dataDir);
const world: BikeShopWorld = await seedBikeShop(host, dataDir);

const PORT = Number(process.env.PORT ?? 8872);
const WEB_PORT = Number(process.env.WEB_PORT ?? 5272);

const staff = platformActorId.parse(ulid());
const login = devLogin({ directory: host.admin, actor: staff, provider: DEV_PROVIDER });
await linkDevPersonas(host, world);

const app = new Hono();

/**
 * The caller, and the node they belong to. `login.caller` asks the directory which tenant
 * this subject lives in — a legitimate question here, because the pool is CENTRAL and a
 * persona is linked in exactly one. That link is what carries Rutger into t2/s2 while
 * everyone else lands in t1/s1, so the cross-tenant beat survives with no persona table
 * in this file.
 *
 * Authenticated-but-unlinked reads the same as unauthenticated: whether an email belongs
 * to this workshop is not a question an outsider gets answered.
 */
async function stub(c: Context): Promise<ScopeStub> {
  const caller = await login.caller(c.req.raw.headers);
  if (!caller) throw new PermissionDenied('not authenticated');
  return host.getScope(caller.principal, caller.tenantId, caller.scopeId);
}

// `mountOperations` decides the STATUS for everything the kernel itself names — a refused
// permission, an input that failed to parse (#791) — and re-throws it as an HTTPException.
// `problemResponse` turns whatever arrives into this app's error envelope, which is a
// problem document since #113 phase 4 and still carries `{ error }` for the SPA.
app.onError((err, c) => problemResponse(c, err));

// The relying-party endpoints. Accounts and passwords live at the issuer; this vertical
// has no credential store and hosts no sign-up.
app.on(['GET', 'POST'], '/api/auth/*', (c) => login.handle(c.req.raw));

/** Who is signed in — the shape the app's header renders, or 401. */
app.get('/api/me', async (c) => {
  const caller = await login.caller(c.req.raw.headers);
  if (!caller) return c.json({ error: 'unauthorized' }, 401);
  return c.json({ principal: caller.principal, display: caller.display });
});

// ---------------------------------------------------------------------------
// The two routes that supply a CONSTANT the caller does not choose.
//
// `protocol/list-for-entity` takes an ordinary `z.string()`: it belongs to an engine
// that knows nothing about repairs, so binding it would put `entityType` in the query
// string and let a caller list the protocols on anything in the scope. This is where
// the vertical stops being entity-agnostic, so it says 'workorder' here and the
// operation stays unbound.
//
// `bike-shop/timeline` is no longer that shape (#890): its `entityType` is
// `z.enum(['workorder', 'protocol'])` — a repair's spine and a condition report's,
// which are the two this vertical reads. The route picks the first because that is
// the screen it feeds.
//
// Registered before the derived table: neither can be shadowed by it today, but
// "the hand-written exception wins" is the ordering that stays safe as the
// declared table grows.
// ---------------------------------------------------------------------------
// The page projection, by hand (#829). `mountOperations` does this for every
// DECLARED route — body is the entries, the walk rides in a `Link` header — and a
// hand-mounted route gets none of it. So since this operation became paged (#811)
// it has answered `{ entries, nextCursor }` while the app typed it `TimelineEntry[]`
// and called `.map` on it: a live break in the browser that no scenario sees,
// because the scenarios invoke the operation and never the route (#800).
app.get('/api/repairs/:id/timeline', async (c) => {
  const page = await (await stub(c)).invoke<Page<TimelineEntry>>('bike-shop/timeline', {
    entityType: 'workorder',
    entityId: c.req.param('id'),
    ...listPageQuery.partial().parse(c.req.query()),
  });
  const link = nextPageLink(c.req.url, page.nextCursor);
  if (link) c.header(PAGE_LINK_HEADER, link);
  return c.json(page.entries);
});
app.get('/api/repairs/:id/protocols', async (c) =>
  c.json(
    await (await stub(c)).invoke('protocol/list-for-entity', {
      entityType: 'workorder',
      entityId: c.req.param('id'),
    }),
  ),
);

/**
 * Everything else, derived from the declarations.
 *
 * There was a 129-line table here, and every line restated a method and a path the
 * operations already declare. It had drifted: `bike-shop/price-list` declared
 * `GET /price-list` while this file served `/prices`, and nothing could notice,
 * because the declaration was decorative.
 *
 * `workorder/close` is absent from `handlebarWorkorderRoutes` and that absence is
 * load-bearing — the engine's default binding is WITHDRAWN in this host, because a
 * repair is not closed until the customer counter-signs the tillståndsrapport.
 * `bike-shop/close-repair` is the only door.
 */
mountOperations(
  app,
  {
    ...handlebarOperations,
    ...handlebarWorkorderRoutes,
    ...handlebarProtocolRoutes,
    ...handlebarInvoicingRoutes,
  },
  stub,
);

serve({ fetch: app.fetch, port: PORT });
console.log(`Handlebar demo API on http://localhost:${PORT} — data in ${dataDir}`);
console.log(`  auth: OIDC · ${login.issuer}`);
