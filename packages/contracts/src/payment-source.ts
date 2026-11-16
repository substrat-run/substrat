import { z } from 'zod';
import { instant } from './ids.js';
import { currencyCode, moneyAmount } from './money.js';

/**
 * Payment-source vocabulary (#3189): what a vertical sees of a payment it asked a provider to take,
 * whichever provider takes it.
 *
 * A payment source is a connector whose far side takes money from a buyer: a hosted checkout the
 * buyer is sent to, and the outcome the provider reports afterwards. The first is Stripe; Swish and
 * Klarna are the next this vocabulary has to hold. A vertical codes against these names, so moving
 * from one provider to another keeps its landing operation, its tables and the schemas it parses.
 * The CONNECTION is still the provider's (its credential, its probe, its binding).
 *
 * One shape crosses today, {@link paymentChange}, landed through the vertical's own operation, one
 * checkout per invoke. The invariants a provider's connector holds, which no schema here can:
 *
 * - **The outcome is read from the provider, never from a callback's body.** A webhook only tells
 *   the connector to look; what lands is what the provider answers when asked. So a forged or
 *   replayed callback can at most cause a re-read.
 * - **Delivery is at least once, keyed by `checkoutId`.** A landing operation upserts by it and may
 *   see the same status twice. `status` only moves forward (`open` → `processing` → `paid` or
 *   `failed`; `open` → `expired`), so a vertical that sees an older status after a newer one keeps
 *   the newer.
 * - **`reference` is the vertical's own.** It is what the vertical passed when it asked for the
 *   checkout (an order id, an invoice id), handed back unchanged, so the landing operation finds
 *   its own row without a lookup table.
 * - **Money is a decimal string with its currency**, converted from the provider's minor units
 *   exactly, never through a float.
 * - **`live` says whether real money moved.** A provider's test mode completes checkouts with test
 *   cards, so a vertical that ships goods or unlocks access checks it, or refuses test payments in
 *   production itself.
 *
 * What is NOT here, by decision:
 *
 * - **Refunds and disputes.** They change a paid checkout after the fact and want their own record
 *   and their own permission; `change` is a discriminator so they can be added without a bump.
 * - **Subscriptions.** A recurring charge is a different lifecycle from a one-off checkout.
 * - **Line items.** The vertical sent them and holds them; the outcome carries the total charged.
 *
 * `customerEmail` is personal data. A vertical that lands it declares the column as such.
 */

/**
 * Where a checkout stands.
 *
 * - `open`: the buyer has not finished.
 * - `processing`: the buyer finished, and the payment method settles later (a bank debit).
 * - `paid`: the money is the seller's. The only status a vertical should deliver against.
 * - `failed`: the buyer finished, and the payment did not go through.
 * - `expired`: the checkout closed before the buyer finished. Nothing was charged.
 */
export const paymentCheckoutStatus = z.enum(['open', 'processing', 'paid', 'failed', 'expired']);
export type PaymentCheckoutStatus = z.infer<typeof paymentCheckoutStatus>;

/** The statuses a checkout cannot leave. */
export const FINAL_PAYMENT_CHECKOUT_STATUSES: readonly PaymentCheckoutStatus[] = ['paid', 'failed', 'expired'];

/**
 * A checkout as it now stands at the provider.
 *
 * `status` is the one fact a vertical branches on; `providerStatus` is the provider's own words for
 * display, and branching on it binds a vertical to one provider. `amount` is the total the checkout
 * charges (or charged), tax included when the provider adds it.
 */
export const paymentCheckoutUpsert = z.object({
  record: z.literal('checkout'),
  change: z.literal('upsert'),
  connectionId: z.string().min(1),
  /** The checkout's id at the provider — the stable key. */
  checkoutId: z.string().min(1),
  /** The vertical's own reference, exactly as it asked for the checkout. */
  reference: z.string().min(1),
  status: paymentCheckoutStatus,
  providerStatus: z.string(),
  live: z.boolean(),
  currency: currencyCode,
  amount: moneyAmount,
  /** When the provider took the money, or `null` until it has. */
  paidAt: instant.nullable(),
  customerEmail: z.string().nullable(),
  createdAt: instant.nullable(),
  /**
   * When the connector read this status from the provider. A provider that keeps no "last changed"
   * time (Stripe's checkout does not) is read on observation, which is what orders two deliveries.
   */
  observedAt: instant,
});
export type PaymentCheckoutUpsert = z.infer<typeof paymentCheckoutUpsert>;

/**
 * What a payment connector lands through the binding's operation, one checkout per invoke — parsed
 * with this schema on the way out, so a vertical compiled against one version of a connector gets a
 * throw rather than a reshaped record from another.
 */
export const paymentChange = z.discriminatedUnion('record', [paymentCheckoutUpsert]);
export type PaymentChange = z.infer<typeof paymentChange>;
