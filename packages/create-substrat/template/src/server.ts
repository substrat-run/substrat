import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { platformActorId } from '@substrat-run/contracts';
import { ulid, type ScopeStub } from '@substrat-run/kernel';
import { devLogin } from '@substrat-run/dev-issuer';
import { buildBikeShopHost, linkDevPersonas, seedBikeShop, type BikeShopWorld } from './seed.js';
import { DEV_PROVIDER } from './personas.js';
import { mountApi } from './routes.js';

// ============================================================================
// The DEV entrypoint. It owns exactly three things — a SQLite host on disk, the
// relying-party login, and the port — and then mounts `routes.ts`, the same
// route table `worker.ts` mounts. There is no business logic here and no route
// here either: a route added to this file would exist in dev and 404 in
// production, which is the one failure this split exists to prevent.
//
// ── AUTH ────────────────────────────────────────────────────────────────────
// An ordinary OpenID Connect round-trip, against whatever `OIDC_ISSUER` names.
// `pnpm dev` starts `@substrat-run/dev-issuer` on :8879 — a real provider whose
// only shortcut is that you pick a name instead of typing a password — so the
// login you exercise locally is the one your users will run, and pointing this
// at Auth0, Keycloak or your own issuer is a change of configuration, not code.
//
// There is deliberately NO dev header here. A header naming the caller is an
// impersonation bypass; kept for convenience it becomes a second auth path that
// no deployment runs, and one environment variable away from being live.
// Impersonation for scripts lives at the issuer instead:
//   curl -XPOST localhost:8879/dev/token -d '{"sub":"dev|greta"}'
//
// ── THE VITE PROXY, IF YOU ADD ONE ──────────────────────────────────────────
// Do not set `changeOrigin` on a proxy in front of this server: the OIDC
// `redirect_uri` is derived from the forwarded Host header, and rewriting it
// sends the login callback to the API port instead of back to your app.
// ============================================================================

const dataDir = join(dirname(fileURLToPath(import.meta.url)), '..', '.data');
mkdirSync(dataDir, { recursive: true });

const host = buildBikeShopHost(dataDir);
const world: BikeShopWorld = await seedBikeShop(host, dataDir);
await linkDevPersonas(host, world);

// The local platform actor (a stub locally): directory reads are stamped with it.
const staffActor = platformActorId.parse(ulid());

/**
 * The relying party — login, callback, logout, plus `sub` → principal through the
 * identity directory. The persona's tenant and scope come out of the link the seed
 * wrote, which is why signing in as Rutger lands in the OTHER shop and every one of
 * this shop's rows stays out of reach.
 */
// Both ports are bound in THIS file so they move together: `substrat.devServers` names
// it for the API and for the issuer alike, and `ISSUER_PORT=… PORT=… pnpm dev` shifts the
// pair without either end losing track of the other.
const ISSUER_PORT = Number(process.env.ISSUER_PORT ?? 8879);
const login = devLogin({
  directory: host.admin,
  actor: staffActor,
  provider: DEV_PROVIDER,
  issuer: process.env.OIDC_ISSUER ?? `http://localhost:${ISSUER_PORT}`,
});

const app = new Hono();

// Login, callback, logout. Accounts and passwords live at the issuer; this vertical
// runs no credential store of its own.
app.on(['GET', 'POST'], '/api/auth/*', (c) => login.handle(c.req.raw));

/** Who is signed in, or 401 — the same question `worker.ts` answers. */
app.get('/api/me', async (c) => {
  const caller = await login.caller(c.req.raw.headers);
  if (!caller) return c.json({ error: 'unauthorized' }, 401);
  return c.json({ principal: caller.principal, display: caller.display });
});

async function stub(c: Context): Promise<ScopeStub> {
  const caller = await login.caller(c.req.raw.headers);
  if (!caller) throw new HTTPException(401, { message: 'unauthorized' });
  return host.getScope(caller.principal, caller.tenantId, caller.scopeId);
}

// Everything else — including `/api/invoke` and the shared error envelope.
mountApi(app, stub);

const PORT = Number(process.env.PORT ?? 8873);
serve({ fetch: app.fetch, port: PORT });
console.log(`Bike-shop API on http://localhost:${PORT} — data in ${dataDir}`);
console.log(`Sign in at http://localhost:${PORT}/api/auth/login — issuer: ${login.issuer}`);
