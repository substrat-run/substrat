import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import type { Context } from 'hono';
import {
  platformActorId, principalId, type PrincipalId } from '@substrat-run/contracts';
import Database from 'better-sqlite3';
import { PermissionDenied, ulid, type ScopeStub } from '@substrat-run/kernel';
import { mountOperations, problemResponse } from '@substrat-run/vertical-host';
import {
  handlebarInvoicingRoutes,
  handlebarOperations,
  handlebarProtocolRoutes,
  handlebarWorkorderRoutes,
} from './operations.js';
import { buildAuthNode, migrateAuth } from './auth-node.js';
import {
  betterAuthAdapter,
  devHeaderAdapter,
  resolvePrincipal,
  type AuthAdapter,
} from './auth-adapters.js';
import { buildBikeShopHost, seedBikeShop, type BikeShopWorld } from './index.js';

/**
 * Dev API server for the Handlebar demo. Deliberately thin: authenticate
 * (dev principal picker via x-principal header, gated on ALLOW_DEV_HEADER) →
 * getScope → invoke. Every
 * route is a wrapper over an operation; there is no business logic here.
 * Runs on :8872 so it can sit next to the Callout demo (:8871).
 */

const dataDir = join(dirname(fileURLToPath(import.meta.url)), '..', '.data');
mkdirSync(dataDir, { recursive: true });

const host = buildBikeShopHost(dataDir);
const world: BikeShopWorld = await seedBikeShop(host, dataDir);

const PORT = Number(process.env.PORT ?? 8872);
const WEB_PORT = Number(process.env.WEB_PORT ?? 5272);

const auth = buildAuthNode(dataDir, `http://localhost:${PORT}`, [
  `http://localhost:${PORT}`,
  `http://localhost:${WEB_PORT}`,
]);
await migrateAuth(auth);

const CAST: Record<string, { name: string; role: string; principal: PrincipalId }> = {
  greta: { name: 'Greta (verkstadschef)', role: 'workshop-admin', principal: world.greta },
  mans: { name: 'Måns (mekaniker)', role: 'mechanic', principal: world.mans },
  lisbeth: { name: 'Lisbeth (portal, Crescent)', role: 'portal', principal: world.lisbeth },
  otto: { name: 'Otto (portal, Bianchi)', role: 'portal', principal: world.otto },
  rutger: { name: 'Rutger (annan verkstad!)', role: 'attacker', principal: world.rutger },
};

const app = new Hono();

/**
 * Real auth first; the dev header only if explicitly opted in.
 *
 * A template teaches by example, so the example is a session. The header stays for
 * local iteration because it is genuinely useful, and stays OFF by default because
 * a copied template inherits its defaults.
 */
const NODE = { tenantId: world.t1, scopeId: world.s1 };
const adapters: AuthAdapter[] = [betterAuthAdapter(auth, host, NODE)];
if (process.env.ALLOW_DEV_HEADER === 'true') adapters.push(devHeaderAdapter());

async function principalOf(c: Context): Promise<PrincipalId> {
  const result = await resolvePrincipal(adapters, c.req.raw.headers);
  // Authenticated-but-unknown reads the same as unauthenticated: whether an email
  // belongs to this workshop is not a question an outsider gets answered.
  if (!result) throw new PermissionDenied('not authenticated');
  return result.principal;
}

async function stub(c: Context): Promise<ScopeStub> {
  return host.getScope(await principalOf(c), world.t1, world.s1);
}

// `mountOperations` decides the STATUS for everything the kernel itself names — a refused
// permission, an input that failed to parse (#791) — and re-throws it as an HTTPException.
// `problemResponse` turns whatever arrives into this app's error envelope, which is a
// problem document since #113 phase 4 and still carries `{ error }` for the SPA.
app.onError((err, c) => problemResponse(c, err));

app.get('/api/cast', (c) => c.json(CAST));

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
app.get('/api/repairs/:id/timeline', async (c) =>
  c.json(
    await (await stub(c)).invoke('bike-shop/timeline', {
      entityType: 'workorder',
      entityId: c.req.param('id'),
    }),
  ),
);
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

// Better Auth owns /api/auth/*. Mounted last so it cannot shadow a demo route.
app.on(['GET', 'POST'], '/api/auth/*', (c) => auth.handler(c.req.raw));

await seedPersonaLogins();

serve({ fetch: app.fetch, port: PORT });
console.log(`Handlebar demo API on http://localhost:${PORT} — data in ${dataDir}`);

/**
 * Demo logins for the cast, so the template runs with a real session out of the
 * box rather than only with the dev header.
 *
 * Idempotent on both sides: sign-up throws when the email exists, in which case
 * the id is read back, and an already-linked identity is skipped. The two stores
 * have independent lifecycles — the world may exist while Better Auth's tables are
 * fresh — so neither may assume the other is empty.
 */
async function seedPersonaLogins(): Promise<void> {
  const staff = platformActorId.parse(ulid());
  const db = new Database(join(dataDir, 'better-auth.sqlite'), { readonly: true });
  try {
    for (const [key, p] of Object.entries(CAST)) {
      const email = `${key}@handlebar.test`;
      let externalId: string | undefined;
      try {
        externalId = (
          await auth.api.signUpEmail({
            body: { email, password: 'handlebar-demo', name: p.name },
          })
        ).user.id;
      } catch {
        externalId = (db.prepare('SELECT id FROM user WHERE email = ?').get(email) as
          | { id: string }
          | undefined)?.id;
      }
      if (!externalId) continue;
      if (await host.admin.resolveIdentity(world.t1, 'better-auth', externalId)) continue;
      await host.admin.linkIdentity(staff, {
        provider: 'better-auth',
        externalId,
        principal: p.principal,
        tenantId: world.t1,
        scopeId: world.s1,
      });
    }
  } finally {
    db.close();
  }
}
