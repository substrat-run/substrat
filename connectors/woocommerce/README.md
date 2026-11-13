# @substrat-run/connector-woocommerce

The Substrat connector for [WooCommerce](https://woocommerce.com/). Reads a store's products and
orders on a poll and lands them into a scope through the consuming app's own operation, in the
provider-neutral commerce shape (`commerceChange` in `@substrat-run/contracts`).

Full documentation: **[substrat.net/connectors/woocommerce](https://substrat.net/connectors/woocommerce)**.

> **Not yet verified against a production store.** The client and `src/mock.ts` encode one reading
> of the WooCommerce REST API (`wc/v3`). `test/live.test.ts` checks that reading against a real
> store: CI's `woocommerce-live` job starts one from `docker/`, and it runs against any store when
> `WOOCOMMERCE_STORE_URL`, `WOOCOMMERCE_CONSUMER_KEY` and `WOOCOMMERCE_CONSUMER_SECRET` are set.

## What it is

- **Poll-only and read-only.** Every call is a `GET`; the key needs Read permission only.
- **A keyset walk over "changed since"**, per resource, so a product saved mid-walk cannot push
  another out of sight. Correct whether `modified_after` includes its boundary or not.
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

`test/commerce-source-suite.ts` is the behaviour every commerce-source connector shares, written
against a harness. It moves to `packages/contract-tests` when a second store platform's connector
runs it.
