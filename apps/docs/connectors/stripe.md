# Stripe (payments)

Lets your app take a payment through **your tenant's own [Stripe](https://stripe.com/) account**.
Your app opens a hosted checkout, the buyer pays on Stripe's page, and the outcome lands back in
your app through your own operation, in a **provider-neutral payment shape**. Your app codes against
that shape rather than against Stripe, so a second payment provider's connector can land the same
records into the same operation.

Card data never reaches your app or the platform: the buyer types it into Stripe's page.

::: warning Not yet verified against a Stripe account
The client and its mock are written from Stripe's API reference. The mock encodes that reading, so
the two can agree with each other while both disagree with Stripe. Until a run against a test-mode
account has checked it, treat this connector as built, not proven.
:::

## At a glance

| | |
|---|---|
| **Provider** | Stripe, REST API pinned to version `2024-06-20` |
| **Category** | Payments |
| **Status** | **Built, not yet verified against a Stripe account** |
| **Package** | `@substrat-run/connector-stripe` — private until its first release |
| **Your app calls** | `requestCheckout()` from `@substrat-run/vertical-host`, in its worker |
| **Lands** | `paymentChange` from `@substrat-run/contracts`, one checkout per call |

## Connecting

In the dashboard, open the app's **Integrations** and connect **Stripe** with a **restricted key**,
made in Stripe under *Developers → API keys → Create restricted key*, with:

| Permission | Why |
|---|---|
| Checkout Sessions: **Write** | to open a checkout and read its outcome |
| Events: **Read** | to read a webhook's event back from Stripe |
| Webhook Endpoints: **Write** | to register the platform's webhook on your account |
| Account: **Read** (optional) | lets *Test connection* show your account's name, not only its id |

**Test connection** says which account the key belongs to, whether it is **live** or **test**
mode, and whether it may register the webhook. A test key (`rk_test_…`) completes checkouts with
Stripe's test cards and moves no money, which is what you want while building.

The connection is for **that account in that mode**, and stays so. Going live from a test key is a
new connection: see [Replacing the key](#replacing-the-key).

Without *Webhook Endpoints: Write* the connection still works: the platform finds each outcome by
asking Stripe on its regular pass, minutes later instead of seconds.

## How a binding comes into existence

Declare the landing in your module manifest:

```ts
connections: [
  { provider: 'stripe', operation: 'shop/record-payment', permission: 'payment:record' },
],
```

Once a Stripe connection exists for the app, the platform grants the connection `payment:record`
on each install and binds it. A Stripe binding takes no options. A checkout is only opened for a
bound scope, so a payment always has somewhere to land.

## Opening a checkout

Your operation decides what to charge: it is the permission-checked act. Your worker then asks the
platform for the checkout, inside the same request, and sends the buyer to the page it answers:

```ts
import { requestCheckout } from '@substrat-run/vertical-host';

const order = await scope.invoke('shop/checkout', { cartId });
const { url } = await requestCheckout({
  controlPlaneUrl: env.CONTROL_PLANE_URL,
  platformSecret: env.PLATFORM_SECRET,
  tenantId,
  scopeId,
  provider: 'stripe',
  reference: order.id,
  currency: 'SEK',
  lines: order.lines, // [{ name, quantity, unitAmount: '99.50' }]
  successUrl: 'https://shop.example.com/thanks',
  cancelUrl: 'https://shop.example.com/cart',
});
return c.redirect(url, 303);
```

- **`reference` is yours** — an order id, an invoice id — and comes back on every landing.
- **Amounts are decimal strings**, converted to Stripe's minor units exactly. An amount with more
  decimals than its currency carries is refused rather than rounded, and so are the few currencies
  Stripe counts differently from their ISO decimals (ISK, HUF, TWD, UGX and the three-decimal ones).
- **One reference is never paid twice.** Asking again with the same order while its checkout is
  open answers the same page; a changed order closes the open checkout first; once a payment for
  the reference has gone through or is settling, the ask is refused with `409`.
- **A preview or fork never charges anyone.** The ask is refused with `403`.

## What lands

One `paymentChange` per call, `record: 'checkout'`, which your operation upserts by `checkoutId`.
Delivery is **at least once**, and each status lands once as it is reached:

| `status` | Means |
|---|---|
| `open` | the buyer has not finished |
| `processing` | the buyer finished with a method that settles later (a bank debit) |
| `paid` | the money is yours — the only status to deliver against |
| `failed` | the delayed payment did not go through; the reference may be charged again |
| `expired` | the checkout closed unpaid |

Each also carries the total `amount` and `currency`, `paidAt`, the buyer's email, and **`live`**:
`false` for a test-mode key. If your app ships goods or unlocks access, check `live`, or refuse test
payments in production yourself.

## How the outcome is found

1. **Stripe's webhook.** The platform registers one endpoint per connection on your account. A
   call is checked twice (the token in its URL, and Stripe's signature over the exact body) and is
   then only a *hint*: the platform reads the event and the checkout back from Stripe, and lands
   what Stripe answers. A forged or replayed call can at most cause a re-read.
2. **The regular pass.** Every open or settling checkout is read again, so a lost webhook only
   delays an outcome.

## Replacing the key

A Stripe connection belongs to **one Stripe account, in one mode** (live or test). Everything the
platform keeps for it — the webhook endpoint, every checkout it opened, every `reference` it has
been asked to charge — is about that account and mode, and is meaningless to any other.

- **A new key for the same account and mode** (you rolled the key in Stripe, or made a new
  restricted key) replaces the old one, and everything carries on: the webhook, the open
  checkouts, and the guard against charging a `reference` twice.
- **A key for another account, or for the other mode, is refused**, and nothing is stored: the
  old key stays in place. The dashboard says which account and mode the key belongs to.

To move to another account, or **to go live from a test key**, connect it as a new connection:
disconnect Stripe, then connect again with the new key. Before you do:

- **Let open checkouts finish.** Once disconnected, the platform stops reading the old account,
  so a payment made there after that never lands in your app. Check the app's open and settling
  checkouts first (the connection's activity lists them).
- **The new connection starts with no history.** The guard that refuses to charge a `reference`
  twice knows only what its own connection opened, so a `reference` paid through the old
  connection is not refused by the new one. Do not ask the new connection to charge an order that
  may already have been paid through the old one.
- **The old account keeps the webhook endpoint** the platform registered there. Delete it in that
  account's Stripe dashboard.

### When Stripe loses a checkout

Two things nobody can prevent. If the key is **revoked or deleted in Stripe**, every call is
refused until you paste a new key for the same account and mode; nothing is lost, and the next pass
reads whatever happened in between. If Stripe **no longer has a checkout** (the account's test data
was deleted, or the account closed), its outcome cannot be read: nothing lands for it, and the
platform stops asking. A test-mode checkout's `reference` may then be charged again, since it never
moved money, unless it had already landed as `paid`. A live checkout's `reference` stays refused,
because it may have been paid. Charging the order under a new `reference` is outside the platform's
guard against paying twice, so do that only after you have confirmed in Stripe that the order was
not paid.

## Not in this release

Refunds, disputes, subscriptions, saved customers, and Stripe Connect (onboarding a business
through Stripe's own flow, with a platform fee). Checkouts opened outside the platform (in your
Stripe dashboard, or by another integration) never land.
