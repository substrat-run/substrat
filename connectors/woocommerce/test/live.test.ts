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
 */
const env = process.env;
const secret =
  env.WOOCOMMERCE_STORE_URL && env.WOOCOMMERCE_CONSUMER_KEY && env.WOOCOMMERCE_CONSUMER_SECRET
    ? { storeUrl: env.WOOCOMMERCE_STORE_URL, consumerKey: env.WOOCOMMERCE_CONSUMER_KEY, consumerSecret: env.WOOCOMMERCE_CONSUMER_SECRET }
    : null;
const allowLocalHttp = env.WOOCOMMERCE_ALLOW_LOCAL_HTTP === '1';

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
});
