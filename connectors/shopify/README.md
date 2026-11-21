# @substrat-run/connector-shopify

The Substrat connector for [Shopify](https://www.shopify.com/). Reads a shop's products and orders on
a poll and lands them into a scope through the consuming app's own operation, in the provider-neutral
commerce shape (`commerceChange` in `@substrat-run/contracts`) — the same shape the WooCommerce
connector lands, so a vertical written against one takes the other's records unchanged.

Full documentation: **[substrat.net/connectors/shopify](https://substrat.net/connectors/shopify)**.

> **Not yet verified against a real shop.** The client and `src/mock.ts` encode one reading of
> Shopify's Admin GraphQL API (version `2026-10`). `test/live.test.ts` checks that reading against a
> real shop when `SHOPIFY_SHOP`, `SHOPIFY_CLIENT_ID` and `SHOPIFY_CLIENT_SECRET` are set. No CI job
> runs it: Shopify has no shop to start in a container.

## What it is

- **Poll-only and read-only.** Every query is a read; the app needs `read_products` and
  `read_orders`. `read_all_orders` (granted by Shopify on request) reaches orders older than 60 days,
  and `read_customers` names the customer account on each order.
- **The credential is a Dev Dashboard app's client ID and secret**, installed on the merchant's own
  shop. Each pass mints a short-lived access token from them (OAuth client credentials) and stores
  none.
- **A keyset walk over `updated_at`**, per resource, following Shopify's own GraphQL cursors, and
  leaving the last two minutes for the next pass while Shopify's search index catches up.
- **Deletes by reconcile**: once an hour it asks the shop about the ids it delivered (`nodes`) and
  reports each missing one through the same landing operation (`change: 'removed'`). Orders only with
  `read_all_orders`, since without it an old order vanishes from view and would read as deleted.
- **Host code**, never module code. The shop must be a `<handle>.myshopify.com` name
  (`src/shop-domain.ts`), so the platform never sends the client secret anywhere else.

## Run the live test

```sh
SHOPIFY_SHOP=acme.myshopify.com SHOPIFY_CLIENT_ID=… SHOPIFY_CLIENT_SECRET=… pnpm exec vitest run test/live.test.ts
```

`commerceSourceSuite` in `@substrat-run/contract-tests` is the behaviour every commerce-source
connector shares; `test/commerce-source.test.ts` runs it on the mock, as WooCommerce's does.
