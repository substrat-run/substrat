import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import type { Context } from 'hono';
import { PermissionDenied, type ScopeStub } from '@substrat-run/kernel';
import type { PrincipalId } from '@substrat-run/contracts';
import { buildBikeShopHost, seedBikeShop, type BikeShopWorld } from './seed.js';
import { mountApi } from './routes.js';

// ============================================================================
// The DEV entrypoint. It owns exactly three things — a SQLite host on disk, the
// `x-principal` persona picker, and the port — and then mounts `routes.ts`, the
// same route table `worker.ts` mounts. There is no business logic here and no
// route here either: a route added to this file would exist in dev and 404 in
// production, which is the one failure this split exists to prevent.
// ============================================================================

const dataDir = join(dirname(fileURLToPath(import.meta.url)), '..', '.data');
mkdirSync(dataDir, { recursive: true });

const host = buildBikeShopHost(dataDir);
const world: BikeShopWorld = await seedBikeShop(host, dataDir);

// The dev cast, keyed by the `x-principal` header value. Every entry is a real
// principal with real tuples — nothing here is a bypass.
const CAST: Record<string, { name: string; principal: PrincipalId }> = {
  greta: { name: 'Greta (workshop-admin)', principal: world.greta },
  mans: { name: 'Måns (mechanic)', principal: world.mans },
  lisbeth: { name: 'Lisbeth (portal customer)', principal: world.lisbeth },
  otto: { name: 'Otto (portal customer)', principal: world.otto },
  rutger: { name: 'Rutger (other shop — attacker)', principal: world.rutger },
};

function principalOf(c: Context): PrincipalId {
  const who = c.req.header('x-principal') ?? 'greta';
  const entry = CAST[who];
  if (!entry) throw new PermissionDenied(`unknown principal: ${who}`);
  return entry.principal;
}

function stub(c: Context): Promise<ScopeStub> {
  return host.getScope(principalOf(c), world.t1, world.s1);
}

const app = new Hono();

// The persona picker — genuinely dev-only, so it stays out of the shared table.
// Its ABSENCE in the worker is how a client can tell it is talking to a real
// deployment; the worker answers `/api/me` instead.
app.get('/api/cast', (c) => c.json(CAST));

// Everything else — including `/api/invoke` and the shared error envelope.
mountApi(app, stub);

const PORT = Number(process.env.PORT ?? 8873);
serve({ fetch: app.fetch, port: PORT });
console.log(`Bike-shop API on http://localhost:${PORT} — data in ${dataDir}`);
console.log(`Pick a principal with the "x-principal" header: ${Object.keys(CAST).join(', ')}`);
