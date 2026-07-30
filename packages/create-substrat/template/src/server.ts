import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import type { Context } from 'hono';
import { PermissionDenied, type ScopeStub } from '@substrat-run/kernel';
import type { PrincipalId } from '@substrat-run/contracts';
import { buildBikeShopHost, seedBikeShop, type BikeShopWorld } from './seed.js';

// ============================================================================
// A deliberately THIN dev API. Each route authenticates (a dev principal picker
// via the `x-principal` header — a real deployment swaps in a session), gets the
// scope, and invokes ONE operation. There is no business logic here: every rule
// lives in an operation or an engine.
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

app.onError((err, c) => {
  const message = err instanceof Error ? err.message : String(err);
  if (err instanceof PermissionDenied) return c.json({ error: message }, 403);
  if (/invalid transition|immutable|already/.test(message)) return c.json({ error: message }, 409);
  if (/not found|unknown scope|unknown operation/.test(message)) return c.json({ error: message }, 404);
  return c.json({ error: message }, 400);
});

app.get('/api/cast', (c) => c.json(CAST));

// Customers, bikes, price list (the vertical's own tables).
app.get('/api/customers', async (c) => c.json(await (await stub(c)).invoke('shop/list-customers')));
app.post('/api/customers', async (c) =>
  c.json(await (await stub(c)).invoke('shop/create-customer', await c.req.json())),
);
app.post('/api/customers/:id/bikes', async (c) =>
  c.json(
    await (await stub(c)).invoke('shop/register-bike', {
      customerId: c.req.param('id'),
      ...(await c.req.json<Record<string, unknown>>()),
    }),
  ),
);
app.get('/api/prices', async (c) => c.json(await (await stub(c)).invoke('shop/price-list')));
app.post('/api/prices', async (c) =>
  c.json(await (await stub(c)).invoke('shop/upsert-price', await c.req.json())),
);

// Repairs — the vertical's create/complete/close wrap the engine; assign/start/
// report/get/list are the engine's own operations, invoked directly.
app.get('/api/repairs', async (c) =>
  c.json(await (await stub(c)).invoke('workorder/list', { status: c.req.query('status') })),
);
app.post('/api/repairs', async (c) =>
  c.json(await (await stub(c)).invoke('shop/create-repair', await c.req.json())),
);
app.get('/api/repairs/:id', async (c) =>
  c.json(await (await stub(c)).invoke('workorder/get', { orderId: c.req.param('id') })),
);
app.get('/api/repairs/:id/timeline', async (c) =>
  c.json(
    await (await stub(c)).invoke('shop/timeline', {
      entityType: 'workorder',
      entityId: c.req.param('id'),
    }),
  ),
);
app.post('/api/repairs/:id/assign', async (c) =>
  c.json(
    await (await stub(c)).invoke('workorder/assign', {
      orderId: c.req.param('id'),
      ...(await c.req.json<Record<string, unknown>>()),
    }),
  ),
);
app.post('/api/repairs/:id/start', async (c) =>
  c.json(await (await stub(c)).invoke('workorder/start', { orderId: c.req.param('id') })),
);
app.post('/api/repairs/:id/time', async (c) =>
  c.json(
    await (await stub(c)).invoke('workorder/report-time', {
      orderId: c.req.param('id'),
      ...(await c.req.json<Record<string, unknown>>()),
    }),
  ),
);
app.post('/api/repairs/:id/material', async (c) =>
  c.json(
    await (await stub(c)).invoke('workorder/report-material', {
      orderId: c.req.param('id'),
      ...(await c.req.json<Record<string, unknown>>()),
    }),
  ),
);
app.post('/api/repairs/:id/complete', async (c) =>
  c.json(await (await stub(c)).invoke('shop/complete-repair', { orderId: c.req.param('id') })),
);
app.post('/api/repairs/:id/close', async (c) =>
  c.json(await (await stub(c)).invoke('shop/close-repair', { orderId: c.req.param('id') })),
);

// The customer portal — the per-entity proof walk.
app.get('/api/portal/repairs', async (c) =>
  c.json(await (await stub(c)).invoke('shop/portal-repairs')),
);

// Invoicing (the sibling engine, fed by event).
app.get('/api/invoicing', async (c) => c.json(await (await stub(c)).invoke('invoicing/list')));
app.get('/api/invoicing/:id', async (c) =>
  c.json(await (await stub(c)).invoke('invoicing/get', { underlagId: c.req.param('id') })),
);
app.post('/api/invoicing/:id/export', async (c) =>
  c.json(await (await stub(c)).invoke('invoicing/export', { underlagId: c.req.param('id') })),
);

const PORT = Number(process.env.PORT ?? 8873);
serve({ fetch: app.fetch, port: PORT });
console.log(`Bike-shop API on http://localhost:${PORT} — data in ${dataDir}`);
console.log(`Pick a principal with the "x-principal" header: ${Object.keys(CAST).join(', ')}`);
