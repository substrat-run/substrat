# WooCommerce (online store)

Reads a [WooCommerce](https://woocommerce.com/) store's **products** and **orders** and lands them
into a scope through the consuming app's own operation, in a **provider-neutral commerce shape**,
and writes two things back when your app asks: a **stock count**, and an **order completed**.
Your app codes against that shape rather than against WooCommerce, so a second store platform's
connector can land the same records into the same operation.

::: warning Not yet verified against a production store
The client and its mock are written from WooCommerce's REST API documentation and its source code.
The mock encodes that reading, so the two can agree with each other while both disagree with a
real store. `test/live.test.ts` checks the reading against a real WooCommerce, started in Docker by
CI's `woocommerce-live` job, and can be pointed at any store with a Read key (its write-back case
runs only against the store CI seeds).
:::

## At a glance

| | |
|---|---|
| **Provider** | WooCommerce (WordPress), REST API `wc/v3` |
| **Category** | Commerce |
| **Status** | **Built, not yet verified against a production store** — polled reads, two writes on request |
| **Package** | `@substrat-run/connector-woocommerce` — private until its first release |
| **Consumes** | `woocommerce.stock-set-requested`, `woocommerce.order-complete-requested` |
| **Lands** | `commerceChange` from `@substrat-run/contracts`, one product or order per call |

## What it consumes

Reads ask for nothing. Orders happen at the store, and the platform finds out by looking: the
connection is polled every quarter of an hour, and each pass reads only what changed at the store
since the last one.

Writes are the two events your app emits, described under [Writing back](#writing-back).

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
  carries its SKU (`null` when it has none: a variation without a SKU of its own reports `null`, not
  the product's SKU WooCommerce fills in for it), its options (`Size: L`), its `price`, a
  `compareAtPrice` when it is on sale, and
  its `stock`: whether the store counts it (`manageStock`), the `quantity` (`null` when it does
  not count it, never `0`), and its `status` (`in_stock`, `out_of_stock`, `on_backorder`). When the
  product keeps one count for all its variations, every variant reports that count with
  `sharedWithProduct: true`: show it, but do not add the variants up. A sale moves the count and
  saves the product, so the next pass lands it.
- **`order`** — number, the store's status word, `paidAt`, `cancelled`, the currency, the total
  and its tax, shipping and discount breakdown, the customer as the order records them, billing and
  shipping addresses, the customer's note, and one line per item sold. Each line names the
  `variantId` it sold, the same id the product's variant carries, or `null` for a line the catalogue
  does not hold.

A product or order that leaves the store arrives through the same operation with
**`change: 'removed'`**, its id (`productId` or `orderId`), `removal` and `observedAt`:

- **`trashed`** — moved to the store's trash. It can still be restored, and then arrives as an
  upsert again.
- **`deleted`** — gone for good, including a trashed one whose trash was emptied (reported again
  as `deleted`).

What a removal means is for your app to decide: archive it, hide it, or keep an order for the
books. A cancelled or refunded order is not a removal; that is its status, on its upsert. Only an
id your app was handed is ever reported, and a removal can arrive more than once, like any change.
Every upsert now has `change: 'upsert'`, so branch on `change` as well as `record`.

Money is always a decimal string with its currency, never a float. A value that is not a decimal
amount is refused, not rounded, and the pass reports which record and field it was. Orders carry
personal data (names, an email address, addresses): declare those columns as such in your app.

## The credential

A **store URL** and a **REST API key**, made in WooCommerce under *Settings → Advanced → REST API*:

- give the key **Read** permission if your app only reads, or **Read/Write** if it
  [writes back](#writing-back): a Read key's write is refused by the store, and the request fails;
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

## One connection per store

A connection is **one store**, named by the address WordPress reports for itself (its home URL, without
the `https://` or a trailing slash). Connecting decides which:

- A key for a store the app is already connected to **replaces that store's key** and keeps
  everything the connection has done, so the next pass carries on where the last one stopped. It does
  not matter which spelling of the address the key is pasted with (`www.` or not) as long as both reach
  the same store.
- A key for **another store** becomes a connection of its own, listed beside the first. Each is bound
  and polled on its own, and every record says which connection it came from.
- A store that **moves to another domain** is a new store to the platform: connect the new address,
  then disconnect the old one. The new connection's first pass reads the whole store again, so your
  operation sees every record once more, under the new connection.

### A store that connects its own shop

When each of your app's installs is a store with its own shop, connect each shop as **that
install's own**, from inside the app rather than from the dashboard's form: your app calls the
platform's connection relay with `owner: 'scope'` for the install it is serving, then binds it, and
declares the landing as `bind: 'on-request'`:

```ts
connections: [
  { provider: 'woocommerce', operation: 'shop/record-commerce', permission: 'commerce:record', bind: 'on-request' },
],
```

Each install then receives its own shop's products and orders and nothing from the others. Orders
carry customers' names, email addresses and postal addresses, so this is the shape to use whenever
installs are different businesses or branches. The dashboard lists such a connection on that
install's Integrations tab only, marked as its own, and disconnecting it there stops that install's
sync and no other.

With the default landing, a connection is the whole app's and is bound on every install, so every
install receives every connected shop's records.

A connection made before connections were keyed on their store holds no store. Pasting a key for
**the same store** still replaces its key. A key for **another store** is refused, and nothing is
stored: disconnect it first, and the next key makes a connection keyed on its store.

## The flow

Each pass, for each bound install:

1. Read the store's currency (products state none, so their prices are in the store's).
2. Read products changed since the last pass, oldest change first. For a variable product, read its
   variations. Land each product.
3. Read orders changed since the last pass the same way, and land each. A saved-but-unplaced
   block checkout (`checkout-draft`) is passed over.
4. Once an hour (every fourth pass), check the products and orders it has delivered: which are
   still there, which are in the trash, and, read one by one, which the store says no longer
   exist. Land each newly trashed or deleted one as a removal.
5. Remember how far it got, and which ids it has delivered.

The walk restarts from the last change landed on every request rather than paging by number, so a
product saved while a pass is reading cannot push another one out of sight. A pass reads at most
ten pages of each, so a store's first pass (everything it ever sold) is spread over several passes;
the connection's activity says **catching up** until it is done.

## A record that cannot land

One product or order that cannot land never holds up the ones after it, or the orders:

- **A row the connector cannot read faithfully** — a price with a decimal comma or a thousands
  separator, a stock count that is not a number, a date that is not a date — is **skipped** at once.
  It is never reshaped into something close: a price that is not a decimal does not become one.
  WordPress's zero date (`0000-00-00 00:00:00`) is read as "not set", so a row whose modified date is
  zero is placed by its created date.
- **Any other failure on one record** — reading its variations, or your app's landing operation
  throwing for it — makes that resource's walk **wait** at it, and the pass tries it first next
  time. Orders and the hourly check still run. After three passes in a row it is skipped too.
- A failure that is not about one record — the key refused, the store rate-limiting, the landing
  permission taken away — ends the pass as before, and nothing is skipped.

A skipped record is kept with its error, tried again by id once an hour, and leaves the list the
moment it lands — then, or when it is next saved at the store. The connection's activity says
**stalled at product 123** while a walk waits, and **synced — 2 skipped** when it moved past some,
with each record's error beside it. Your app reads the same per binding with
`listBindings({ ...access, health: true })` ([reference](/reference/vertical-host#listbindings-request)),
the tenant's connection bound to the scope included.

## Writing back

Your app asks for a write by emitting an event from one of its own operations, and registers both
events for routing in its host setup with `declareWooCommerceConnector(host)`. The platform
dispatches the request within seconds and writes it to the store.

```ts
// Set a variant's stock count.
ctx.emit({
  type: 'woocommerce.stock-set-requested',
  schemaVersion: 1,
  entity: { entityType: 'article', entityId: article.id }, // your own record the request is about
  payload: {
    requestId,                          // your own id for the request
    connectionId: product.connectionId, // the connection the product was landed from
    productId: '42',
    variantId: '42', // the variant's id: the product's own for a product without variants
    quantity: 7,     // the count to SET, not a difference
  },
});

// Mark an order completed (WooCommerce's "fulfilled and complete").
ctx.emit({
  type: 'woocommerce.order-complete-requested',
  schemaVersion: 1,
  entity: { entityType: 'order', entityId: order.id },
  payload: { requestId, connectionId: order.connectionId, orderId: '1001' },
});
```

The ids and the `connectionId` are the ones the record's `commerceChange` carried. The payload
schemas are exported as `woocommerceStockSetRequested` and `woocommerceOrderCompleteRequested`.

After the write, the record **lands again through your landing operation as it now stands**, as an
ordinary upsert. Your app sees the store's answer within seconds, in the shape it already reads, and
the next pass lands it once more, as delivery allows.

- **Which store.** A request is written only through a connection **bound to the install that
  asked**: an install cannot write to a store it is not delivered from. This also covers an app
  connected to several stores and an install that connected its own shop.
- **Stock is set, not adjusted.** A redelivered request writes the same number again, so it is safe
  to repeat. The price is that a sale at the store between your read and the write is overwritten:
  WooCommerce has no compare-and-set. A count the store did not track is tracked from the write on.
  For a variant whose count is its product's (`sharedWithProduct`), the product's count is set,
  and every variant of it reports the new count.
- **An order** already completed is not written again. A cancelled, refunded, failed, trashed or
  draft order is refused, not revived.
- **When it fails.** The landing permission not delivered yet, a rate limit or an outage: the
  request is retried. These fail the request for good:
  - a connection **not bound to the install** that asked: unbound since the record was landed, or
    never this install's. Binding it later does not retry the request; send a new one once it is
    bound;
  - a key without Write permission;
  - a product, variant or order the store does not hold;
  - a value the store refuses;
  - an order that cannot be completed.

  Your app is not told: no failure lands in your operation. It shows on the platform's failure
  record and the connection's health.

## What's missing

- **A variant changed on its own.** WooCommerce does not mark a variable product as changed when
  only one of its variations is edited, so such a change reaches your app the next time the product
  itself is saved.
- **A removal sooner than the hourly check.** Deletes are found by asking, not told.
- **Refunds and fulfilment as records of their own**, and a **customer register**.
- **A write receipt in your app.** A refused write lands nothing, so your app learns of a write by
  the record landing changed, not by an answer to its request.
- **More writes** — prices, product details, refunds, shipment tracking.
- **Webhooks**, as a hint to read sooner than the next pass.
