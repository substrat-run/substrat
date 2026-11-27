# @substrat-run/connector-woocommerce

The Substrat connector for [WooCommerce](https://woocommerce.com/). Reads a store's products and
orders on a poll and lands them into a scope through the consuming app's own operation, in the
provider-neutral commerce shape (`commerceChange` in `@substrat-run/contracts`). Writes a stock
count or an order's completion back to the store when the app asks.

Full documentation: **[substrat.net/connectors/woocommerce](https://substrat.net/connectors/woocommerce)**.

> **Not yet verified against a production store.** The client and `src/mock.ts` encode one reading
> of the WooCommerce REST API (`wc/v3`). `test/live.test.ts` checks that reading against a real
> store: CI's `woocommerce-live` job starts one from `docker/`, and it runs against any store when
> `WOOCOMMERCE_STORE_URL`, `WOOCOMMERCE_CONSUMER_KEY` and `WOOCOMMERCE_CONSUMER_SECRET` are set.

## What it is

- **Reads by poll.** Every read is a `GET`; an app that only reads needs a Read key.
- **Writes on request** (#3136). The app emits `woocommerce.stock-set-requested` or
  `woocommerce.order-complete-requested`; the dispatch (`woocommerceConnector`) writes it through
  the connection bound to the asking scope, then lands the record as it now stands. Needs a
  Read/Write key. Absolute writes, so a redelivery is safe.
- **A keyset walk over "changed since"**, per resource, so a product saved mid-walk cannot push
  another out of sight. Correct whether `modified_after` includes its boundary or not.
- **Deletes by reconcile**: once an hour it asks the store about the ids it delivered and reports
  each trashed or deleted one through the same landing operation (`change: 'removed'`).
- **Host code**, never module code. The store URL is tenant input and is judged before it is
  called (`src/store-url.ts`).

## Run the live test locally

```sh
docker compose -f docker/compose.yaml up -d db wordpress
docker compose -f docker/compose.yaml run --rm -T cli sh /seed/seed.sh > .woo.env
set -a; . ./.woo.env; set +a
WOOCOMMERCE_STORE_URL=http://localhost:8080 WOOCOMMERCE_ALLOW_LOCAL_HTTP=1 pnpm exec vitest run test/live.test.ts
docker compose -f docker/compose.yaml down -v
```

The seed prints a Read/Write key too (`WOOCOMMERCE_WRITE_…`) and the records the write-back case
writes to. That case is skipped without them, so the test stays read-only against a real shop.

`commerceSourceSuite` in `@substrat-run/contract-tests` is the behaviour every commerce-source
connector shares, written against a harness; `test/commerce-source.test.ts` runs it on the mock, and
`connectors/shopify` runs the same suite on its own.
