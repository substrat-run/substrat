# @substrat-run/connector-stripe

The Substrat connector for [Stripe](https://stripe.com/). A vertical opens a hosted Checkout
Session through its tenant's own Stripe account, and the outcome lands back in the scope through
the consuming app's own operation, in the provider-neutral payment shape (`paymentChange` in
`@substrat-run/contracts`).

Full documentation: **[substrat.net/connectors/stripe](https://substrat.net/connectors/stripe)**.

> **Not yet verified against a Stripe account.** The client and `src/mock.ts` encode one reading of
> Stripe's API at version `2024-06-20`. A run against a test-mode account is what checks it.

## What it is

- **Three halves.** `createStripeCheckout` (the control plane's checkout relay, inside the
  vertical's request), `handleStripeCallback` (the webhook), `sweepStripe` (the poll floor).
- **A webhook is a hint.** Token and signature are checked, then the event and the session are
  read back from Stripe; only Stripe's answers land.
- **Money is exact.** Decimal strings to minor units by `BigInt`, never rounded, with the
  currencies Stripe counts differently refused by name (`src/money.ts`).
- **Host code**, never module code.
