/**
 * `GET /api/portal/orders` pages (#2080): the route hands `limit` and `cursor` from the query
 * to `shop/portal-orders`, so following the `Link` header reaches the next page.
 *
 * It used to invoke the operation with no input at all, while `jsonPage` still wrote a
 * `Link` from the page's cursor: following it answered page one again, and a portal
 * customer never saw past it. A scenario cannot see that — it calls `invoke()` and never
 * meets the route — so this drives the Hono app `server.ts` serves.
 *
 * The caller is resolved by a test adapter rather than an OIDC session: what is under test is
 * the route's mapping from query string to input, not sign-in.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ScopeStub } from '@substrat-run/kernel';
import type { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { buildShopHost, seedShop, type OrderRow, type ShopWorld } from '../src/index.js';
import { publicAuth, type AuthAdapter } from '../src/auth-adapters.js';
import { shopApi } from '../src/routes.js';

let dir: string;
let host: SqliteScopeHost;
let w: ShopWorld;
let app: ReturnType<typeof shopApi>;
/** Elin's orders, newest first. */
const hers: string[] = [];

async function checkout(who: ScopeStub, customerId: string): Promise<string> {
  const cart = await who.invoke<{ id: string }>('shop/create-cart');
  await who.invoke('shop/add-to-cart', { cartId: cart.id, variantId: w.chelbesaVariantId, qty: 1 });
  return (await who.invoke<{ order: OrderRow }>('shop/checkout', { cartId: cart.id, customerId })).order.id;
}

/** The `rel="next"` target of a `Link` header, or null. */
function nextOf(res: Response): string | null {
  return /<([^>]+)>;\s*rel="next"/.exec(res.headers.get('Link') ?? '')?.[1] ?? null;
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'shop-portal-route-'));
  host = buildShopHost(dir);
  w = await seedShop(host, dir);
  const astrid = await host.getScope(w.astrid, w.t1, w.s1);
  const elin = await host.getScope(w.elin, w.t1, w.s1);
  const otto = await host.getScope(w.otto, w.t1, w.s1);
  await astrid.invoke('shop/set-stock', { variantId: w.chelbesaVariantId, onHand: 20 });
  for (let i = 0; i < 3; i++) {
    hers.unshift(await checkout(elin, w.elinCustomerId!));
    await checkout(otto, w.ottoCustomerId!);
  }
  const asElin: AuthAdapter = {
    id: 'test',
    async resolve(headers) {
      return headers.get('x-test-as') === 'elin'
        ? { principal: w.elin, tenantId: w.t1, scopeId: w.s1, via: 'test', display: 'Elin', role: 'customer' }
        : null;
    },
  };
  app = shopApi(host, [asElin, publicAuth(w)], async () => {
    throw new Error('this test signs nobody in');
  });
});

afterAll(async () => {
  await host.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('GET /api/portal/orders walks its pages (#2080)', () => {
  it('two pages through the Link header: her orders in order, then the end', async () => {
    const get = (url: string) => app.request(url, { headers: { 'x-test-as': 'elin' } });

    const first = await get('http://shop.test/api/portal/orders?limit=2');
    expect(first.status).toBe(200);
    expect(((await first.json()) as OrderRow[]).map((o) => o.id)).toEqual(hers.slice(0, 2));
    const next = nextOf(first);
    expect(next).not.toBeNull();

    const second = await get(next!);
    expect(second.status).toBe(200);
    expect(((await second.json()) as OrderRow[]).map((o) => o.id)).toEqual(hers.slice(2));
    // A short page is the end of the walk: no Link to follow.
    expect(nextOf(second)).toBeNull();
  });

  it('a limit is honoured, and one past the ceiling is refused rather than ignored', async () => {
    const get = (url: string) => app.request(url, { headers: { 'x-test-as': 'elin' } });
    const one = await get('http://shop.test/api/portal/orders?limit=1');
    expect(((await one.json()) as OrderRow[]).map((o) => o.id)).toEqual(hers.slice(0, 1));
    expect((await get('http://shop.test/api/portal/orders?limit=100000')).status).toBe(400);
  });
});
