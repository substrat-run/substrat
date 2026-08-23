import { isPage, nextPageLink, PAGE_LINK_HEADER } from '@substrat-run/contracts';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import type { Context } from 'hono';
import { PermissionDenied, type ScopeStub } from '@substrat-run/kernel';
import { buildShopHost, seedShop, type ShopWorld } from './index.js';
import { buildAuth, migrateAuth } from './auth.js';
import {
  betterAuthAdapter,
  publicAuth,
  resolvePrincipal,
  seedPersonaLogins,
  type AuthAdapter,
  type AuthResult,
} from './auth-adapters.js';

/**
 * Dev API server for the Kallkälla Kaffe demo. Deliberately thin: resolve the
 * principal (Better Auth session, or the anonymous browse-only fallback) →
 * getScope → invoke. Every route is a wrapper over an operation.
 */

const dataDir = join(dirname(fileURLToPath(import.meta.url)), '..', '.data');
mkdirSync(dataDir, { recursive: true });

// Dev ports sit in a private 887x/527x block, clear of the Vite (5173) and
// Wrangler (8787) defaults that every other project on the machine also wants.
// Override without editing: PORT=… WEB_PORT=… ADMIN_PORT=… pnpm dev
//
// Two front ends, one API: the storefront (:5273) and the admin dashboard
// (:5274) are separate Vite apps that both proxy /api to this server. There is
// one kernel and one permission check behind both — the split is chrome and
// audience, never a second source of truth.
const PORT = Number(process.env.PORT ?? 8873);
const WEB_PORT = Number(process.env.WEB_PORT ?? 5273);
const ADMIN_PORT = Number(process.env.ADMIN_PORT ?? 5274);
const WEB_ORIGIN = process.env.WEB_ORIGIN ?? `http://localhost:${WEB_PORT}`;
const ADMIN_ORIGIN = process.env.ADMIN_ORIGIN ?? `http://localhost:${ADMIN_PORT}`;

const host = buildShopHost(dataDir);
const world: ShopWorld = await seedShop(host, dataDir);

// Better Auth — its own store, migrated on startup, then seed the persona logins.
const auth = buildAuth(dataDir, PORT, [WEB_ORIGIN, ADMIN_ORIGIN]);
await migrateAuth(auth);
await seedPersonaLogins(auth, host, world, dataDir);

// Mounted auth adapters, in precedence order: a real Better Auth session wins;
// otherwise the anonymous fallback (browse-only). The public adapter must be last.
const ENABLED = (process.env.AUTH ?? 'better-auth,public').split(',').map((s) => s.trim());
const adapters: AuthAdapter[] = [];
if (ENABLED.includes('better-auth')) adapters.push(betterAuthAdapter(auth, host, world));
if (ENABLED.includes('public')) adapters.push(publicAuth(world));

const app = new Hono();

async function resolve(c: Context): Promise<AuthResult> {
  const r = await resolvePrincipal(adapters, c.req.raw.headers);
  if (!r) throw new PermissionDenied('not authenticated');
  return r;
}
async function stub(c: Context): Promise<ScopeStub> {
  const r = await resolve(c);
  return host.getScope(r.principal, r.tenantId, r.scopeId);
}
async function body(c: Context): Promise<Record<string, unknown>> {
  return c.req.json<Record<string, unknown>>();
}

// Better Auth owns everything under /api/auth/* (sign-up, sign-in, session, …).
app.on(['POST', 'GET'], '/api/auth/*', (c) => auth.handler(c.req.raw));

// Who am I right now, my role hint (for nav), and my customer id for checkout.
app.get('/api/me', async (c) => {
  const r = await resolvePrincipal(adapters, c.req.raw.headers);
  if (!r) return c.json({ authenticated: false, role: 'public' });
  const authenticated = r.via === 'better-auth';
  let customerId: string | null = null;
  if (authenticated) {
    try {
      const s = await host.getScope(r.principal, r.tenantId, r.scopeId);
      customerId = (await s.invoke<{ id: string } | null>('shop/my-customer'))?.id ?? null;
    } catch {
      customerId = null;
    }
  }
  return c.json({ authenticated, principal: r.principal, display: r.display, via: r.via, role: r.role, customerId });
});

app.onError((err, c) => {
  if (err instanceof PermissionDenied) return c.json({ error: err.message }, 403);
  if (/permission denied/.test(err.message)) return c.json({ error: err.message }, 403);
  if (/not found|unknown scope/.test(err.message)) return c.json({ error: err.message }, 404);
  if (/out of stock/.test(err.message)) return c.json({ error: err.message }, 409);
  return c.json({ error: err.message }, 400);
});


// storefront — `?includeUnpublished=1` is how the catalogue admin sees drafts;
// the operation gates that flag on catalog:manage, so the storefront's own
// anonymous callers get the published rows and nothing more.
/**
 * A paged operation's result, projected onto the wire (#829/#811).
 *
 * The BODY stays what it always was — the entries — and the walk rides in a
 * `Link` header. That is what let shop's four list reads adopt paging without
 * renaming a response either front-end consumes: the storefront and the back
 * office both still receive arrays.
 *
 * `packages/vertical-host` does exactly this for a hosted vertical's generated
 * routes; shop hand-writes its own, so it applies the same projection here.
 */
function jsonPage(c: Context, result: unknown) {
  if (!isPage(result)) return c.json(result as never);
  const link = nextPageLink(c.req.url, result.nextCursor);
  if (link) c.header(PAGE_LINK_HEADER, link);
  return c.json(result.entries as never);
}

app.get('/api/catalog', async (c) =>
  jsonPage(
    c,
    await (await stub(c)).invoke('shop/catalog', {
      includeUnpublished: c.req.query('includeUnpublished') === '1',
    }),
  ),
);
app.post('/api/carts', async (c) => c.json(await (await stub(c)).invoke('shop/create-cart')));
app.get('/api/carts/:id', async (c) => c.json(await (await stub(c)).invoke('shop/cart', { cartId: c.req.param('id') })));
app.post('/api/carts/:id/lines', async (c) =>
  c.json(await (await stub(c)).invoke('shop/add-to-cart', { ...(await body(c)), cartId: c.req.param('id') })),
);
app.patch('/api/carts/:id/lines/:lineId', async (c) =>
  c.json(
    await (await stub(c)).invoke('shop/set-line-qty', {
      ...(await body(c)),
      cartId: c.req.param('id'),
      lineId: c.req.param('lineId'),
    }),
  ),
);
app.delete('/api/carts/:id/lines/:lineId', async (c) =>
  c.json(await (await stub(c)).invoke('shop/remove-line', { cartId: c.req.param('id'), lineId: c.req.param('lineId') })),
);
app.post('/api/carts/:id/quote', async (c) =>
  c.json(await (await stub(c)).invoke('shop/quote', { ...(await body(c)), cartId: c.req.param('id') })),
);
app.post('/api/carts/:id/checkout', async (c) =>
  c.json(await (await stub(c)).invoke('shop/checkout', { ...(await body(c)), cartId: c.req.param('id') })),
);

// portal
app.get('/api/portal/orders', async (c) =>
  jsonPage(c, await (await stub(c)).invoke('shop/portal-orders')),
);

// admin — catalogue
app.post('/api/products', async (c) => c.json(await (await stub(c)).invoke('shop/create-product', await body(c))));
app.post('/api/products/:id/variants', async (c) =>
  c.json(await (await stub(c)).invoke('shop/add-variant', { ...(await body(c)), productId: c.req.param('id') })),
);
app.post('/api/products/:id/publish', async (c) =>
  c.json(await (await stub(c)).invoke('shop/publish-product', { ...(await body(c)), productId: c.req.param('id') })),
);
app.get('/api/stock', async (c) => jsonPage(c, await (await stub(c)).invoke('shop/stock-overview')));
app.post('/api/variants/:id/stock', async (c) =>
  c.json(await (await stub(c)).invoke('shop/set-stock', { ...(await body(c)), variantId: c.req.param('id') })),
);
app.post('/api/discounts', async (c) => c.json(await (await stub(c)).invoke('shop/create-discount', await body(c))));
app.post('/api/customers', async (c) => c.json(await (await stub(c)).invoke('shop/create-customer', await body(c))));

// admin — orders
app.get('/api/orders', async (c) => jsonPage(c, await (await stub(c)).invoke('shop/orders')));
app.get('/api/orders/:id', async (c) => c.json(await (await stub(c)).invoke('shop/order', { orderId: c.req.param('id') })));
app.post('/api/orders/:id/fulfil', async (c) => c.json(await (await stub(c)).invoke('shop/fulfil-order', { orderId: c.req.param('id') })));
app.post('/api/orders/:id/close', async (c) => c.json(await (await stub(c)).invoke('shop/close-order', { orderId: c.req.param('id') })));

// invoicing (reused engine)
app.get('/api/invoicing', async (c) => c.json(await (await stub(c)).invoke('invoicing/list')));
app.get('/api/invoicing/:id', async (c) => c.json(await (await stub(c)).invoke('invoicing/get', { underlagId: c.req.param('id') })));
app.post('/api/invoicing/:id/export', async (c) => c.json(await (await stub(c)).invoke('invoicing/export', { underlagId: c.req.param('id') })));

serve({ fetch: app.fetch, port: PORT });
console.log(`Kallkälla shop demo API on http://localhost:${PORT} — data in ${dataDir}`);
console.log(`  auth adapters: ${adapters.map((a) => a.id).join(', ')}`);
console.log(`  storefront: ${WEB_ORIGIN} · admin: ${ADMIN_ORIGIN}`);
