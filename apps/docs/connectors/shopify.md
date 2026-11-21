# Shopify (online store)

Reads a [Shopify](https://www.shopify.com/) shop's **products** and **orders** and lands them into a
scope through the consuming app's own operation, in the same **provider-neutral commerce shape** the
[WooCommerce connector](/connectors/woocommerce) lands. An app written against that shape takes
either store's records through one operation, with no change.

::: warning Not yet verified against a real shop
The client and its mock are written from Shopify's Admin GraphQL API documentation. The mock encodes
that reading, so the two can agree with each other while both disagree with a real shop.
`test/live.test.ts` checks the reading against a real shop when it is given an app's credentials;
unlike WooCommerce, there is no shop to start in a container, so no CI job runs it yet.
:::

## At a glance

| | |
|---|---|
| **Provider** | Shopify, Admin GraphQL API `2026-10` |
| **Category** | Commerce |
| **Status** | **Built, not yet verified against a real shop** — poll-only, read-only |
| **Package** | `@substrat-run/connector-shopify` — private until its first release |
| **Consumes** | *nothing* — this connector answers no event |
| **Lands** | `commerceChange` from `@substrat-run/contracts`, one product or order per call |

## What it consumes

**Nothing.** Orders happen at the shop, and the platform finds out by looking. The connection is
polled every quarter of an hour, and each pass reads only what changed at the shop since the last
one.

## How a binding comes into existence

Exactly as for WooCommerce, with the provider's name:

```ts
connections: [
  { provider: 'shopify', operation: 'shop/record-commerce', permission: 'commerce:record' },
],
```

An app that takes both stores declares both, pointing at the same operation. A Shopify binding takes
no options. The operation receives one `commerceChange` per call and must upsert by the record's id:
delivery is **at least once**.

## What lands

The fields are the [WooCommerce page's](/connectors/woocommerce#what-lands); where Shopify differs:

- **Ids** are the number at the end of Shopify's id, the one the admin shows in its URLs.
- **A product sold without options** lands with one variant, untitled and with no options, whose id
  is Shopify's own variant id — not the product's, as on WooCommerce. Key on `variantId` and never
  assume either.
- **Stock** is the variant's count over every location. Shopify has no stock-status word, so
  `status` is worked out: stock Shopify does not track is `in_stock` (Shopify sells it regardless), a
  count above zero is `in_stock`, and at zero a variant set to keep selling is `on_backorder`,
  otherwise `out_of_stock`. `sharedWithProduct` is always `false`.
- **An order's money** is in the currency the customer paid in, which a shop selling in several
  currencies may differ from the shop's own. A product's prices are in the shop's currency.
- **Line amounts exclude tax**, as the shape says, also where the shop's prices include it (the norm
  in Sweden and the EU): the tax Shopify states for the line is subtracted, exactly. The one figure
  Shopify does not give is a discounted line's price before the discount without tax; it is the price
  divided by one plus the line's tax rate, rounded to the cent.
- **`paidAt`**: Shopify records no paid-at time. A paid order (also when since refunded) is paid at
  its last successful payment, and any other order has none.
- **`customerId`** is set only when the app holds `read_customers`; without it, it is `null` for
  every order, not only for guest checkouts.

A product or order deleted at the shop arrives with **`change: 'removed'`** and `removal: 'deleted'`.
Shopify has no trash, so `trashed` never arrives; an archived product is a status (`listed: false`),
not a removal.

## The credential

Shopify no longer lets a merchant create the admin "custom app" that showed a permanent access token
(since 1 January 2026). What replaces it is an app in **Shopify's Dev Dashboard**:

1. In the Dev Dashboard, create an app, and in its version give it the **`read_products`** and
   **`read_orders`** scopes. Add **`read_all_orders`** to read orders older than 60 days (Shopify
   approves that one on request) and **`read_customers`** to name the customer account on each order.
   Orders carry names, email addresses and addresses, so the app needs Shopify's protected customer
   data access for those fields too.
2. Release the version and **install the app on your shop**.
3. Paste into the dashboard: the **shop** (`acme.myshopify.com`, or just `acme`), and the app's
   **client ID** and **client secret** from its Settings page.

Each pass trades the client ID and secret for an access token that lasts about a day, and keeps it
only for that pass. Shopify grants this only for an app and a shop in the same organization, which a
merchant's own app on their own shop is.

The shop must be its permanent **`<name>.myshopify.com`** address (under *Settings → Domains*), never
the shop's own domain: that is the only host Shopify answers its Admin API at, and the platform sends
the client secret nowhere else.

**Test connection** answers which of these went wrong: no shop at that name, a client the shop
refuses (wrong ID or secret, the app not installed, or an app of another organization), an app
without the scopes a sync needs, or an app without protected customer data access, which it checks by
reading one order the way a sync does. On success it names the shop, its currency, how far back its orders
reach (every order, or the last 60 days without `read_all_orders`), and whether orders name the
customer account.

## One connection per shop

A connection is **one shop**, named by its `myshopify.com` address. Credentials for the same shop
replace the old ones and keep where the sync had got to; credentials for another shop become a
connection of their own. As for WooCommerce, an install that is its own business connects its own
shop with `owner: 'scope'` and `bind: 'on-request'` ([how](/connectors/woocommerce#a-store-that-connects-its-own-shop)).

## The flow

Each pass, for each bound install:

1. Mint an access token, and read the shop's currency and the scopes the app holds.
2. Read products changed since the last pass, oldest change first, with their variants (more than
   ten are read in a second request). Land each product.
3. Read orders changed since the last pass the same way, and land each.
4. Once an hour, ask the shop about every product and order it has delivered, a hundred at a time,
   and land each one the shop no longer has as a removal. **Orders are checked only when the app
   holds `read_all_orders`**: without it, Shopify hides an order once it is 60 days old, which looks
   exactly like a deleted one. A removal your app refuses is reported again at the next check, and
   the others are reported meanwhile.
5. Remember how far it got, and which ids it has delivered.

Giving the app `read_all_orders` later makes the next pass read every order again from the start,
once, so the older ones arrive too (with the recent ones again, as upserts).

A change from the last two minutes is left for the next pass, because Shopify answers a "changed
since" question from a search index that can lag a save by a few seconds. A pass reads at most 600
products and 160 orders (in smaller pages if Shopify finds a page too costly to answer), and the
next pass reads on from exactly where it stopped, so a shop's first pass and a bulk edit of
thousands of products are spread over several passes; the activity says **catching up** until it is
done.

A record that cannot land is handled as on WooCommerce ([how](/connectors/woocommerce#a-record-that-cannot-land)).

## What's missing

- **Stock that changes without the product.** Stock rides on the product, and a pass sees it when
  the product's last-changed time moves. Whether every Shopify stock change moves it is not yet
  verified; if it does not, such a change arrives the next time the product is saved.
- **Orders older than 60 days without `read_all_orders`**, and deleted orders without it.
- **Refunds and fulfilment as records of their own**, and a **customer register**.
- **Writing back** — marking an order fulfilled, setting stock.
- **Webhooks**, as a hint to read sooner than the next pass.
