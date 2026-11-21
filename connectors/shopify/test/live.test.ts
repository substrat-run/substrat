import { describe, expect, it } from 'vitest';
import { connectionId, currencyCode } from '@substrat-run/contracts';
import { globalFetch, type ConnectorConnection } from '@substrat-run/kernel';
import { ShopifyApi, SHOPIFY_ORDERS_PAGE, SHOPIFY_PRODUCTS_PAGE, shopifyOrder, shopifyProduct, type ShopifyOperation } from '../src/api.js';
import { orderChange, productChange } from '../src/commerce.js';
import { probeShopifySecret } from '../src/index.js';

/**
 * A real Shopify shop — the mock's reading, checked.
 *
 * Runs only when `SHOPIFY_SHOP`, `SHOPIFY_CLIENT_ID` and `SHOPIFY_CLIENT_SECRET` are set: a Dev
 * Dashboard app with `read_products` and `read_orders`, installed on a shop of the same
 * organization (a development store does). No CI job runs it yet — Shopify has no shop to start in a
 * container, as WooCommerce has — so it is the step a person runs before trusting the connector with
 * a merchant's shop, and again on every move of `SHOPIFY_API_VERSION`.
 *
 * Read-only: every query is a read, so it is safe against a real shop.
 *
 * What only a real shop can prove:
 *
 * 1. The client-credentials grant mints a token for this app and shop.
 * 2. Every query the connector sends passes Shopify's schema at the pinned version — the mock
 *    answers by operation name and never parses one.
 * 3. `updated_at:>='…'` with `sortKey: UPDATED_AT` is accepted and filters.
 * 4. The sent shapes map: every product and order on the first page survives the mapping.
 * 5. A full changed-list page REQUESTS less than Shopify's 1 000-point single-query limit, at the
 *    page sizes `src/api.ts` estimated: the cost Shopify reports, not the estimate. Orders are
 *    measured with and (where the app holds `read_customers`) without the customer field.
 */
const env = process.env;
const secret =
  env.SHOPIFY_SHOP && env.SHOPIFY_CLIENT_ID && env.SHOPIFY_CLIENT_SECRET
    ? { shop: env.SHOPIFY_SHOP, clientId: env.SHOPIFY_CLIENT_ID, clientSecret: env.SHOPIFY_CLIENT_SECRET }
    : null;

describe.skipIf(secret === null)('shopify, against a real shop', () => {
  const conn: ConnectorConnection = {
    id: connectionId.parse('00000000000000000000000000'),
    tenantId: '',
    vertical: '',
    provider: 'shopify',
    secret: secret ?? {},
    expiresAt: null,
    fetch: globalFetch,
  };

  it('probes the credential and names the shop', async () => {
    const result = await probeShopifySecret(secret!, { fetch: globalFetch });
    expect(result, result.error ?? '').toMatchObject({ ok: true });
    expect(result.accountRef).toMatch(/\.myshopify\.com$/);
  });

  it('requests less than 1 000 points for a full page of products and of orders', async () => {
    const costs: [ShopifyOperation, number][] = [];
    const api = new ShopifyApi(conn, { onCost: (operation, cost) => void costs.push([operation, cost]) });
    const info = await api.shopInfo();
    const customers = info.currentAppInstallation.accessScopes.some((s) => s.handle === 'read_customers');
    await api.graphql('ChangedProducts', { first: SHOPIFY_PRODUCTS_PAGE, after: null, query: null });
    for (const withCustomers of customers ? [false, true] : [false]) {
      await api.graphql('ChangedOrders', { first: SHOPIFY_ORDERS_PAGE, after: null, query: null, customers: withCustomers });
    }
    const pages = costs.filter(([operation]) => operation !== 'ShopInfo');
    expect(pages.length).toBe(customers ? 3 : 2);
    for (const [operation, cost] of pages) expect(cost, operation).toBeLessThan(1000);
  }, 60_000);

  it('reads and maps the first page of products and orders through every query the sync sends', async () => {
    const api = new ShopifyApi(conn);
    const info = await api.shopInfo();
    const currency = currencyCode.parse(info.shop.currencyCode);
    const customers = info.currentAppInstallation.accessScopes.some((s) => s.handle === 'read_customers');
    const products = await api.changedPage('products', '2000-01-01T00:00:00Z', null, customers);
    for (const raw of products.nodes) {
      const row = shopifyProduct.parse(raw);
      const more = row.variants.pageInfo.hasNextPage && row.variants.pageInfo.endCursor ? await api.moreVariants(row.id, row.variants.pageInfo.endCursor) : [];
      productChange('live', currency, row, [...row.variants.nodes, ...more]);
      expect(await api.record('products', Number(row.id.split('/').pop()), customers)).not.toBeNull();
    }
    const orders = await api.changedPage('orders', '2000-01-01T00:00:00Z', null, customers);
    for (const raw of orders.nodes) {
      const row = shopifyOrder.parse(raw);
      const more = row.lineItems.pageInfo.hasNextPage && row.lineItems.pageInfo.endCursor ? await api.moreLineItems(row.id, row.lineItems.pageInfo.endCursor) : [];
      orderChange('live', row, [...row.lineItems.nodes, ...more]);
    }
    const ids = products.nodes.map((n) => Number((n as { id: string }).id.split('/').pop()));
    if (ids.length > 0) expect([...(await api.presentIds('products', ids.slice(0, 100)))].sort()).toEqual(ids.slice(0, 100).sort());
  }, 60_000);
});
