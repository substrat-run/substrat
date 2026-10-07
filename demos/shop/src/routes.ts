import { isPage, listPageQuery, nextPageLink, PAGE_LINK_HEADER } from '@substrat-run/contracts';
import { Hono } from 'hono';
import type { Context } from 'hono';
import { PermissionDenied, type ScopeStub } from '@substrat-run/kernel';
import type { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { externalInput, externalJson, problemResponse } from '@substrat-run/vertical-host';
import { resolvePrincipal, type AuthAdapter, type AuthResult } from './auth-adapters.js';

/**
 * The shop's HTTP surface, apart from the process that serves it (`server.ts`), so a test
 * can drive the routes themselves — a scenario calls `invoke()` and never meets a route's
 * mapping from query string to input (#2080).
 *
 * `adapters` resolve the caller, in precedence order; `auth` answers the relying-party
 * endpoints under `/api/auth/*`.
 */
export function shopApi(
  host: SqliteScopeHost,
  adapters: AuthAdapter[],
  auth: (req: Request) => Response | Promise<Response>,
): Hono {
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
  /** A request body, through the platform's one door (#2073): a caller cannot ask for row cursors. */
  async function body(c: Context): Promise<Record<string, unknown>> {
    return externalInput(await c.req.json<Record<string, unknown>>());
  }

  // The relying-party endpoints — the redirect out to the issuer, the callback back, and
  // sign-out. No sign-up and no password: this vertical hosts neither.
  app.on(['POST', 'GET'], '/api/auth/*', (c) => auth(c.req.raw));

  // Who am I right now, my role hint (for nav), and my customer id for checkout.
  app.get('/api/me', async (c) => {
    const r = await resolvePrincipal(adapters, c.req.raw.headers);
    if (!r) return c.json({ authenticated: false, role: 'public' });
    const authenticated = r.via === 'oidc';
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

  // The shared vocabulary, rather than this app's own five lines of it (#113 phase 4).
  // `/out of stock/` was the tell: a status read out of a sentence the code saying it did
  // not know it was on. Every refusal in `module.ts` names its code now.
  app.onError((err, c) => problemResponse(c, err));

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
    // #2073: serialised through the platform's one door, as the generated routes are.
    if (!isPage(result)) return externalJson(c, result);
    const link = nextPageLink(c.req.url, result.nextCursor);
    if (link) c.header(PAGE_LINK_HEADER, link);
    return externalJson(c, result.entries);
  }

  app.get('/api/catalog', async (c) =>
    jsonPage(
      c,
      await (await stub(c)).invoke('shop/catalog', {
        includeUnpublished: c.req.query('includeUnpublished') === '1',
      }),
    ),
  );
  app.post('/api/carts', async (c) => externalJson(c, await (await stub(c)).invoke('shop/create-cart')));
  app.get('/api/carts/:id', async (c) => externalJson(c, await (await stub(c)).invoke('shop/cart', { cartId: c.req.param('id') })));
  app.post('/api/carts/:id/lines', async (c) =>
    externalJson(c, await (await stub(c)).invoke('shop/add-to-cart', { ...(await body(c)), cartId: c.req.param('id') })),
  );
  app.patch('/api/carts/:id/lines/:lineId', async (c) =>
    externalJson(
      c,
      await (await stub(c)).invoke('shop/set-line-qty', {
        ...(await body(c)),
        cartId: c.req.param('id'),
        lineId: c.req.param('lineId'),
      }),
    ),
  );
  app.delete('/api/carts/:id/lines/:lineId', async (c) =>
    externalJson(c, await (await stub(c)).invoke('shop/remove-line', { cartId: c.req.param('id'), lineId: c.req.param('lineId') })),
  );
  app.post('/api/carts/:id/quote', async (c) =>
    externalJson(c, await (await stub(c)).invoke('shop/quote', { ...(await body(c)), cartId: c.req.param('id') })),
  );
  app.post('/api/carts/:id/checkout', async (c) =>
    externalJson(c, await (await stub(c)).invoke('shop/checkout', { ...(await body(c)), cartId: c.req.param('id') })),
  );

  // portal
  // The page params ride the query, so the `Link` header's `?cursor=` is followed rather than
  // ignored — without them the portal only ever reached its first page (#2080).
  app.get('/api/portal/orders', async (c) =>
    jsonPage(c, await (await stub(c)).invoke('shop/portal-orders', listPageQuery.partial().parse(c.req.query()))),
  );

  // admin — catalogue
  app.post('/api/products', async (c) => externalJson(c, await (await stub(c)).invoke('shop/create-product', await body(c))));
  app.post('/api/products/:id/variants', async (c) =>
    externalJson(c, await (await stub(c)).invoke('shop/add-variant', { ...(await body(c)), productId: c.req.param('id') })),
  );
  app.post('/api/products/:id/publish', async (c) =>
    externalJson(c, await (await stub(c)).invoke('shop/publish-product', { ...(await body(c)), productId: c.req.param('id') })),
  );
  app.get('/api/stock', async (c) => jsonPage(c, await (await stub(c)).invoke('shop/stock-overview')));
  app.post('/api/variants/:id/stock', async (c) =>
    externalJson(c, await (await stub(c)).invoke('shop/set-stock', { ...(await body(c)), variantId: c.req.param('id') })),
  );
  app.post('/api/discounts', async (c) => externalJson(c, await (await stub(c)).invoke('shop/create-discount', await body(c))));
  app.post('/api/customers', async (c) => externalJson(c, await (await stub(c)).invoke('shop/create-customer', await body(c))));

  // admin — orders
  app.get('/api/orders', async (c) => jsonPage(c, await (await stub(c)).invoke('shop/orders')));
  app.get('/api/orders/:id', async (c) => externalJson(c, await (await stub(c)).invoke('shop/order', { orderId: c.req.param('id') })));
  app.post('/api/orders/:id/fulfil', async (c) => externalJson(c, await (await stub(c)).invoke('shop/fulfil-order', { orderId: c.req.param('id') })));
  app.post('/api/orders/:id/close', async (c) => externalJson(c, await (await stub(c)).invoke('shop/close-order', { orderId: c.req.param('id') })));

  // invoicing (reused engine)
  app.get('/api/invoicing', async (c) => externalJson(c, await (await stub(c)).invoke('invoicing/list')));
  app.get('/api/invoicing/:id', async (c) => externalJson(c, await (await stub(c)).invoke('invoicing/get', { underlagId: c.req.param('id') })));
  app.post('/api/invoicing/:id/export', async (c) => externalJson(c, await (await stub(c)).invoke('invoicing/export', { underlagId: c.req.param('id') })));

  return app;
}
