import { describe, expect, it } from 'vitest';
import { connectionId } from '@substrat-run/contracts';
import { globalFetch, type ConnectorConnection } from '@substrat-run/kernel';
import { WooCommerceApi, wcOrder, wcProduct } from '../src/api.js';
import { orderChange, productChange } from '../src/commerce.js';
import { probeWooCommerceSecret } from '../src/index.js';
import { currencyCode } from '@substrat-run/contracts';

/**
 * A real WooCommerce store — the mock's reading, checked.
 *
 * Runs only when `WOOCOMMERCE_STORE_URL`, `WOOCOMMERCE_CONSUMER_KEY` and
 * `WOOCOMMERCE_CONSUMER_SECRET` are set: CI's `woocommerce-live` job sets them for the store it
 * starts from `docker/` (WordPress and WooCommerce at pinned versions, seeded by `docker/seed.sh`),
 * and a person can point them at any store with a Read key. `WOOCOMMERCE_ALLOW_LOCAL_HTTP=1` admits
 * that local store's `http://localhost`; the platform never sets it.
 *
 * Read-only: every call is a GET, so it is safe against a real shop.
 *
 * What only a real store can prove:
 *
 * 1. Basic auth with the key is accepted (the local store is told it is behind TLS, so WooCommerce
 *    takes the same path a production store does).
 * 2. `system_status` with nested `_fields` answers the four leaves the probe reads.
 * 3. `orderby=modified&order=asc` with `modified_after` and `dates_are_gmt` is accepted and filters.
 * 4. The sent shapes map: every product and order on the first page survives the mapping.
 * 5. Asked by id (`include`), a store leaves the trash out of `status=any` and answers it under
 *    `status=trash`, and reading a deleted id answers the `…_invalid_id` 404 — the three answers
 *    the reconcile pass tells a trashed record from a deleted one by (#3224). Needs the seeded ids
 *    `docker/seed.sh` prints; skipped against a store that has none.
 * 6. A stock change made the way a sale makes it moves the modified date of the product it belongs
 *    to — for a simple product, and for a variable product when only its variation's count changed
 *    — so the products' walk delivers it within one sweep (#3223). Also needs the seeded ids.
 * 7. A variation with no SKU of its own is sent its product's SKU, and the mapping reports it as
 *    having none. Needs the seeded id.
 */
const env = process.env;
const secret =
  env.WOOCOMMERCE_STORE_URL && env.WOOCOMMERCE_CONSUMER_KEY && env.WOOCOMMERCE_CONSUMER_SECRET
    ? { storeUrl: env.WOOCOMMERCE_STORE_URL, consumerKey: env.WOOCOMMERCE_CONSUMER_KEY, consumerSecret: env.WOOCOMMERCE_CONSUMER_SECRET }
    : null;
const stock = env.WOOCOMMERCE_STOCK_CHANGED_AFTER
  ? {
      after: env.WOOCOMMERCE_STOCK_CHANGED_AFTER,
      simple: Number(env.WOOCOMMERCE_STOCK_SIMPLE),
      variable: Number(env.WOOCOMMERCE_STOCK_VARIABLE),
      variation: Number(env.WOOCOMMERCE_STOCK_VARIATION),
      shared: Number(env.WOOCOMMERCE_STOCK_SHARED),
    }
  : null;
const skuLess = env.WOOCOMMERCE_SKU_LESS ? Number(env.WOOCOMMERCE_SKU_LESS) : null;
const allowLocalHttp = env.WOOCOMMERCE_ALLOW_LOCAL_HTTP === '1';
const removed =
  env.WOOCOMMERCE_TRASHED_PRODUCT && env.WOOCOMMERCE_DELETED_PRODUCT && env.WOOCOMMERCE_TRASHED_ORDER && env.WOOCOMMERCE_DELETED_ORDER
    ? {
        products: { trashed: Number(env.WOOCOMMERCE_TRASHED_PRODUCT), deleted: Number(env.WOOCOMMERCE_DELETED_PRODUCT) },
        orders: { trashed: Number(env.WOOCOMMERCE_TRASHED_ORDER), deleted: Number(env.WOOCOMMERCE_DELETED_ORDER) },
      }
    : null;

const connection = (): ConnectorConnection => ({
  id: connectionId.parse('00000000000000000000000000'),
  tenantId: '',
  vertical: '',
  provider: 'woocommerce',
  secret: secret!,
  expiresAt: null,
  // `globalFetch`, never the bare global (#1291, `lint:bound-fetch`).
  fetch: (input, init) => globalFetch(input, { ...init, signal: AbortSignal.timeout(30_000) }),
});

describe.skipIf(secret === null)('woocommerce connector — live', () => {
  const api = () => new WooCommerceApi(connection(), { allowLocalHttp });

  it('probes the store and names it', async () => {
    const probe = await probeWooCommerceSecret(secret!, { fetch: globalFetch, allowLocalHttp });
    console.log(`woocommerce: ${JSON.stringify(probe.facts)}`);
    expect(probe).toMatchObject({ ok: true, error: null });
  });

  it('maps every product and order on the first page of changes', async () => {
    const client = api();
    const currency = currencyCode.parse((await client.storeInfo()).settings.currency);
    const products = (await client.changedPage('products', null, 1)).map((r) => wcProduct.parse(r));
    for (const p of products) {
      const variations = p.type === 'variable' ? await client.variations(p.id) : [];
      expect(productChange('live', currency, p, variations).variants.length).toBeGreaterThan(0);
    }
    const orders = (await client.changedPage('orders', null, 1)).map((r) => wcOrder.parse(r));
    for (const o of orders) if (o.status !== 'checkout-draft') orderChange('live', o);
    console.log(`woocommerce: ${products.length} product(s), ${orders.length} order(s) on the first page`);
  });

  it('filters by modified_after: nothing has changed after the last change', async () => {
    const client = api();
    const products = (await client.changedPage('products', null, 1)).map((r) => wcProduct.parse(r));
    const last = products.at(-1);
    if (!last?.date_modified_gmt) return;
    // Oldest first: the last row of the only page is the newest change.
    const after = (await client.changedPage('products', last.date_modified_gmt, 1)).map((r) => wcProduct.parse(r));
    expect(after.filter((p) => p.date_modified_gmt! > last.date_modified_gmt!)).toEqual([]);
    console.log(`woocommerce: modified_after ${last.date_modified_gmt} answered ${after.length} row(s) (1 = inclusive, 0 = exclusive)`);
  });

  it.skipIf(removed === null).each(['products', 'orders'] as const)(
    'tells %s in the trash from those deleted for good, asked by id',
    async (resource) => {
      const client = api();
      const { trashed, deleted } = removed![resource];
      const live = (await client.changedPage(resource, null, 1)).map((r) => (r as { id: number }).id).slice(0, 5);
      expect(live.length).toBeGreaterThan(0);
      expect(await client.presentIds(resource, [...live, trashed, deleted], 'any')).toEqual(new Set(live));
      expect(await client.presentIds(resource, [...live, trashed, deleted], 'trash')).toEqual(new Set([trashed]));
      expect(await client.statusOf(resource, trashed)).toBe('trash');
      expect(await client.statusOf(resource, deleted)).toBeNull();
      expect(await client.statusOf(resource, live[0]!)).not.toBeNull();
    },
  );

  it.skipIf(stock === null)('sees a sale\'s stock change on the products walk: a simple product, and a variation keeping its own count', async () => {
    const client = api();
    const currency = currencyCode.parse((await client.storeInfo()).settings.currency);
    const changed = (await client.changedPage('products', stock!.after, 1)).map((r) => wcProduct.parse(r));
    console.log(`woocommerce: changed since the stock change: ${JSON.stringify(changed.map((p) => [p.id, p.date_modified_gmt]))}`);
    const simple = changed.find((p) => p.id === stock!.simple);
    const variable = changed.find((p) => p.id === stock!.variable);
    expect(simple, 'the simple product is in the changed list').toBeDefined();
    expect(variable, 'the variable product is in the changed list though only its variation changed').toBeDefined();
    expect(productChange('live', currency, simple!, []).variants[0]?.stock).toEqual({
      manageStock: true,
      quantity: 3,
      status: 'in_stock',
      providerStatus: 'instock',
      sharedWithProduct: false,
    });
    const own = productChange('live', currency, variable!, await client.variations(variable!.id)).variants;
    expect(own.find((v) => v.variantId === String(stock!.variation))?.stock).toMatchObject({ manageStock: true, quantity: 5, sharedWithProduct: false });
  });

  it.skipIf(skuLess === null)("sends a SKU-less variation its product's SKU, and the mapping reports none", async () => {
    const client = api();
    const currency = currencyCode.parse((await client.storeInfo()).settings.currency);
    const row = (await client.changedPage('products', null, 1)).map((r) => wcProduct.parse(r)).find((p) => p.id === skuLess);
    expect(row?.sku).toBe('GK-40');
    const variations = await client.variations(row!.id);
    expect(variations.map((v) => v.sku), 'the store fills an empty variation SKU from the product').toEqual(['GK-40', 'GK-40']);
    expect(productChange('live', currency, row!, variations).variants.map((v) => v.sku)).toEqual([null, null]);
  });

  it.skipIf(stock === null)('reports a count the product keeps for all its variations on each variant, as shared', async () => {
    const client = api();
    const currency = currencyCode.parse((await client.storeInfo()).settings.currency);
    const row = (await client.changedPage('products', null, 1)).map((r) => wcProduct.parse(r)).find((p) => p.id === stock!.shared);
    expect(row).toBeDefined();
    const variants = productChange('live', currency, row!, await client.variations(row!.id)).variants;
    expect(variants.map((v) => v.stock)).toEqual([
      { manageStock: true, quantity: 20, status: 'in_stock', providerStatus: 'instock', sharedWithProduct: true },
    ]);
  });
});
