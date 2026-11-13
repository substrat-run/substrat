# WooCommerce (online store)

Reads a [WooCommerce](https://woocommerce.com/) store's **products** and **orders** and lands them
into a scope through the consuming app's own operation, in a **provider-neutral commerce shape**.
Your app codes against that shape rather than against WooCommerce, so a second store platform's
connector can land the same records into the same operation.

::: warning Not yet verified against a production store
The client and its mock are written from WooCommerce's REST API documentation and its source code.
The mock encodes that reading, so the two can agree with each other while both disagree with a
real store. `test/live.test.ts` checks the reading against a real WooCommerce, started in Docker by
CI's `woocommerce-live` job, and can be pointed at any store with a Read key.
:::

## At a glance

| | |
|---|---|
| **Provider** | WooCommerce (WordPress), REST API `wc/v3` |
| **Category** | Commerce |
| **Status** | **Built, not yet verified against a production store** — poll-only, read-only |
| **Package** | `@substrat-run/connector-woocommerce` — private until its first release |
| **Consumes** | *nothing* — this connector answers no event |
| **Lands** | `commerceChange` from `@substrat-run/contracts`, one product or order per call |

## What it consumes

**Nothing.** Nobody inside a scope asks for an order: orders happen at the store, and the platform
finds out by looking. The connection is polled every quarter of an hour, and each pass reads only
what changed at the store since the last one.

## How a binding comes into existence

The consuming app declares the landing in its module manifest:

```ts
connections: [
  { provider: 'woocommerce', operation: 'shop/record-commerce', permission: 'commerce:record' },
],
```

Once a WooCommerce connection exists for the app, the platform grants the connection
`commerce:record` on each install and binds it. A WooCommerce binding takes no options. The
operation receives one `commerceChange` per call and must upsert by the record's id: delivery is
**at least once**.

## What lands

`record` says which kind it is:

- **`product`** — name, slug, public URL, `listed` (published for sale), the store's own status
  word, the store's currency, and **at least one variant**. A product sold without variants (a
  WooCommerce *simple* product) lands with one variant whose id is the product's id. Each variant
  carries its SKU, its options (`Size: L`), its `price`, and a `compareAtPrice` when it is on sale.
- **`order`** — number, the store's status word, `paidAt`, `cancelled`, the currency, the total
  and its tax, shipping and discount breakdown, the customer as the order records them, billing and
  shipping addresses, the customer's note, and one line per item sold. Each line names the
  `variantId` it sold, the same id the product's variant carries, or `null` for a line the catalogue
  does not hold.

Money is always a decimal string with its currency, never a float. A value that is not a decimal
amount is refused, not rounded, and the pass reports which record and field it was. Orders carry
personal data (names, an email address, addresses): declare those columns as such in your app.

## The credential

A **store URL** and a **REST API key**, made in WooCommerce under *Settings → Advanced → REST API*:

- give the key **Read** permission, since the connector never writes;
- make it as an **administrator or shop manager**, since connecting reads the store's own settings
  (its URL, WooCommerce version and currency), which WooCommerce shows only to those roles.

The key is sent as HTTP Basic credentials over HTTPS, never in a URL. The store URL must be
`https://` on the default port and name a public host: an IP address, `localhost` and private
network names (`.local`, `.internal`) are refused before anything is sent.

Some hosts run PHP in a way that drops the `Authorization` header before WooCommerce sees it.
WooCommerce's own workaround is to put the key in the URL's query string, which this connector
refuses to do. On such a host, **Test connection** reports the key as missing or invalid. The host
has to pass the header through: on Apache, a `SetEnvIf Authorization` rule in `.htaccess`.

**Test connection** answers which of these went wrong: no WooCommerce store at that address, a key
the store refuses, or a key whose user is not a manager. On success it names the store by the URL
WordPress reports for itself, its WooCommerce version and its currency.

## The flow

Each pass, for each bound install:

1. Read the store's currency (products state none, so their prices are in the store's).
2. Read products changed since the last pass, oldest change first. For a variable product, read its
   variations. Land each product.
3. Read orders changed since the last pass the same way, and land each. A saved-but-unplaced
   block checkout (`checkout-draft`) is passed over.
4. Remember how far it got.

The walk restarts from the last change landed on every request rather than paging by number, so a
product saved while a pass is reading cannot push another one out of sight. A pass reads at most
ten pages of each, so a store's first pass (everything it ever sold) is spread over several passes;
the connection's activity says **catching up** until it is done. A record that cannot be read
faithfully stops its resource's walk at that record, keeping everything landed before it, and the
next pass starts there.

## What's missing

- **A variant changed on its own.** WooCommerce does not mark a variable product as changed when
  only one of its variations is edited, so such a change reaches your app the next time the product
  itself is saved.
- **Deletes.** A deleted product or order is not in a "changed since" list; only upserts land.
- **Stock levels**, **refunds and fulfilment as records of their own**, and a **customer register**.
- **Writing back** — marking an order fulfilled, setting stock.
- **Webhooks**, as a hint to read sooner than the next pass.
