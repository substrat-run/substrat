import {
  connectionActivity,
  connectionId as connectionIdSchema,
  FINAL_PAYMENT_CHECKOUT_STATUSES,
  instant,
  paymentChange,
  scopeId as scopeIdSchema,
  tenantId as tenantIdSchema,
  type ConnectionActivity,
  type ConnectionCheckoutRequest,
  type ConnectionCheckoutResult,
  type ConnectionCredential,
  type ConnectionId,
  type ConnectionProbe,
  type PaymentChange,
  type PaymentCheckoutStatus,
} from '@substrat-run/contracts';
import type { ConnectorConnection, FetchLike, HostAdmin, ScopeHost } from '@substrat-run/kernel';
import { deadlineFetch, settleConnectionUse } from '@substrat-run/kernel';
import {
  isLiveKey,
  maskKeys,
  StripeApi,
  StripeApiError,
  stripeSecret,
  STRIPE_API_VERSION,
  type StripeCheckoutSession,
} from './api.js';
import { currencyOf, fromMinorUnits, StripeMoneyError, toMinorUnits } from './money.js';
import { verifyStripeSignature } from './signature.js';

export {
  formEncode,
  isLiveKey,
  maskKeys,
  StripeApi,
  StripeApiError,
  stripeSecret,
  STRIPE_API_BASE,
  STRIPE_API_VERSION,
  STRIPE_KEY_PERMISSIONS,
  type FormValue,
  type StripeApiOptions,
  type StripeCheckoutSession,
  type StripeSecret,
} from './api.js';
export { currencyOf, fromMinorUnits, stripeExponent, StripeMoneyError, STRIPE_MAX_AMOUNT, toMinorUnits } from './money.js';
export { stripeSignatureHeader, verifyStripeSignature, STRIPE_SIGNATURE_TOLERANCE_SECONDS } from './signature.js';
export { StripeMock, type StripeMockOptions } from './mock.js';

/**
 * The Stripe connector — a vertical takes a payment through its tenant's own Stripe account
 * (#3189), and the outcome lands in the scope in the provider-neutral payment shape
 * (`paymentChange` in `@substrat-run/contracts`).
 *
 * The vertical codes against that shape, not against Stripe: the landing operation, its tables and
 * the schema it parses stay the same when a second payment provider's connector lands the same
 * records. What stays Stripe's is the connection — the key, the probe, the webhook endpoint.
 *
 * ## The round trip
 *
 * 1. **Open.** A vertical's operation decides what to charge (it is the authorizing act), and its
 *    worker asks the platform's checkout relay, inside the request, for a Checkout Session
 *    ({@link createStripeCheckout}). The buyer is sent to Stripe's hosted page; card data never
 *    reaches the vertical or the platform.
 * 2. **Hear.** Stripe calls the platform's webhook ({@link handleStripeCallback}). The call is a
 *    hint: its token and signature are checked, then the event is read back from Stripe by id, and
 *    the session is read back from Stripe before anything lands. A forged or replayed callback can
 *    at most cause a re-read.
 * 3. **Look.** The sweep re-reads every checkout still open or settling ({@link sweepStripe}), so a
 *    lost webhook, or an account where the key may not register one, only delays an outcome.
 * 4. **Land.** A status the scope has not seen yet lands through the binding's operation, as the
 *    connection itself, once per status (`open`, then `processing`, then `paid`/`failed`/`expired`).
 *
 * ## Where the data lands, and why the connector does not decide
 *
 * As for WooCommerce: {@link bindStripeScope} names the scope, the operation the outcomes land
 * through and the permission it checks, and refuses a binding whose connection does not hold it.
 * A checkout is only opened for a bound scope, so a payment always has somewhere to land.
 *
 * ## One reference is never paid twice through this door
 *
 * The checkout relay keys each session by the vertical's `reference`. Asked again with the same
 * request while the session is open, it answers the same session; with a different request, it
 * closes the open one first; once a payment for the reference has settled or is settling, it
 * refuses. A buyer with two tabs open on two sessions for one order is what this exists to stop.
 *
 * ## What it does NOT do, and says so
 *
 * - **Refunds, disputes, subscriptions, saved customers.** Not in this release (see the shape's
 *   "What is NOT here").
 * - **Sessions it did not open.** A session made in the tenant's Stripe dashboard, or by another
 *   integration, is never landed. The one exception is a session this connection opened whose
 *   directory row was not written (the call to Stripe succeeded and the write after it did not): the
 *   webhook adopts it, by the connection and scope it carries in its metadata.
 * - **Rolling the webhook secret.** The endpoint is registered once per connection and its signing
 *   secret kept in the connection's connector state. A changed platform origin registers a new one
 *   beside the old; the old is left to the tenant to delete in Stripe.
 */

/**
 * The standing grants this connector requires — deliberately empty, for WooCommerce's reason: the
 * permission is whatever the consumer's landing operation checks, so it is verified at bind time.
 */
export const STRIPE_CONNECTION_GRANTS = [] as const;

/** The webhook ingress route, mounted on the control plane. The token is per connection. */
export const STRIPE_CALLBACK_ROUTE = '/hooks/stripe/:connectionId/:token';
export const stripeCallbackPath = (connectionId: string, token: string): string => `/hooks/stripe/${connectionId}/${token}`;

/** The events the registered endpoint asks for: every way a Checkout Session's outcome moves. */
export const STRIPE_WEBHOOK_EVENTS = [
  'checkout.session.completed',
  'checkout.session.async_payment_succeeded',
  'checkout.session.async_payment_failed',
  'checkout.session.expired',
] as const;

/** How many open or settling checkouts one sweep re-reads at most. */
export const STRIPE_CHECKOUTS_PER_SWEEP = 50;
/** How long a settled checkout's row is kept, for the activity view and the reference check. */
export const STRIPE_SETTLED_KEEP_DAYS = 30;
/** How long after a failed webhook registration the next one is tried. */
const WEBHOOK_RETRY_MS = 60 * 60 * 1000;
/** A session is reused only while it stays open at least this much longer. */
const REUSE_MARGIN_MS = 5 * 60 * 1000;
const DEFAULT_EXPIRY_MINUTES = 60;

const BINDING_PREFIX = 'stripe:binding:';
const CHECKOUT_PREFIX = 'stripe:checkout:';
const REFERENCE_PREFIX = 'stripe:reference:';
const WEBHOOK_KEY = 'stripe:webhook';
const bindingKey = (scope: string): string => `${BINDING_PREFIX}${scope}`;
const checkoutKey = (checkoutId: string): string => `${CHECKOUT_PREFIX}${checkoutId}`;
const referenceKey = async (scope: string, reference: string): Promise<string> => `${REFERENCE_PREFIX}${scope}:${await sha256Hex(reference)}`;

export interface StripeBinding {
  scopeId: string;
  tenantId: string;
  vertical: string;
  /** The operation each `paymentChange` lands through — the vertical's, named by whoever binds. */
  operation: string;
  /** The permission `operation` checks, which the connection must hold on `scopeId`. */
  permission: string;
  boundAt: string;
}

/** One session this connection opened, as the directory keeps it. */
export interface StripeCheckoutRow {
  checkoutId: string;
  scopeId: string;
  tenantId: string;
  vertical: string;
  reference: string;
  /** The request it was opened for, digested — what decides whether a repeat ask may reuse it. */
  digest: string;
  url: string | null;
  live: boolean;
  createdAt: string;
  expiresAt: string;
  /** The last status landed in the scope, or `null` before the first. */
  landed: PaymentCheckoutStatus | null;
  /** When a final status landed. */
  settledAt: string | null;
}

export type StripeWebhookRow =
  | { state: 'registered'; endpointId: string; secret: string; token: string; url: string; tenantId: string; vertical: string; registeredAt: string }
  | { state: 'failed'; url: string; error: string; tenantId: string; vertical: string; attemptedAt: string };

export interface StripeConnectorOptions {
  fetch: FetchLike;
  /** For a test deployment pointed at a stub. Unset means the real API. */
  apiBase?: string;
  timeoutMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /**
   * The control plane's public origin, which the webhook endpoint is registered under. Absent, the
   * connection is poll-only: complete, just slower.
   */
  callbackBase?: string;
}

/** A checkout the relay refuses, with the status it answers. Never carries the provider's raw answer. */
export class StripeCheckoutRefusal extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409 | 502,
  ) {
    super(message);
    this.name = 'StripeCheckoutRefusal';
  }
}

const nowOf = (options: { now?: () => number }): number => options.now?.() ?? Date.now();
const iso = (ms: number): string => new Date(ms).toISOString();

// ---------------------------------------------------------------------------------------------
// Bindings
// ---------------------------------------------------------------------------------------------

/** Declare that a connection's checkouts for one scope land there. Refuses a binding whose grant is missing. */
export async function bindStripeScope(
  host: ScopeHost,
  input: {
    connectionId: ConnectionId;
    tenantId: string;
    scopeId: string;
    vertical: string;
    operation: string;
    permission: string;
    /** Internal automatic-pass path: the declaration was checked and its grant follows this write. */
    grantPreflighted?: boolean;
    now?: () => number;
  },
): Promise<StripeBinding> {
  const tenant = tenantIdSchema.parse(input.tenantId);
  const scope = scopeIdSchema.parse(input.scopeId);
  const held =
    input.grantPreflighted ||
    (await host.connectionGrantsInScope(tenant, scope)).some(
      (g: { connectionId: string; permission: string }) => g.connectionId === input.connectionId && g.permission === input.permission,
    );
  if (!held) {
    throw new Error(
      `connection ${input.connectionId} does not hold '${input.permission}' on scope ${input.scopeId} — ` +
        `a paid checkout would then fail to land. Grant it first (grantToConnection), then bind.`,
    );
  }
  const binding: StripeBinding = {
    scopeId: input.scopeId,
    tenantId: input.tenantId,
    vertical: input.vertical,
    operation: input.operation,
    permission: input.permission,
    boundAt: iso(input.now?.() ?? Date.now()),
  };
  await host.admin.putConnectorState(input.connectionId, bindingKey(input.scopeId), binding);
  return binding;
}

/** Every scope this connection lands checkouts in. Tombstones are left out. */
export async function listStripeBindings(host: ScopeHost, connectionId: ConnectionId): Promise<StripeBinding[]> {
  const rows = await host.admin.listConnectorState(connectionId, BINDING_PREFIX);
  return rows.filter((r) => r.value !== null && typeof r.value === 'object').map((r) => r.value as StripeBinding);
}

/** Stop landing in one scope. Checkouts already open for it keep their rows, and fail to land until it is bound again. */
export async function unbindStripeScope(host: ScopeHost, connectionId: ConnectionId, scopeId: string): Promise<void> {
  await host.admin.putConnectorState(connectionId, bindingKey(scopeId), null);
}

async function bindingOf(host: ScopeHost, connectionId: ConnectionId, scopeId: string): Promise<StripeBinding | null> {
  const value = await host.admin.getConnectorState(connectionId, bindingKey(scopeId));
  return value !== null && typeof value === 'object' ? (value as StripeBinding) : null;
}

async function checkoutRowOf(host: ScopeHost, connectionId: ConnectionId, checkoutId: string): Promise<StripeCheckoutRow | null> {
  const value = await host.admin.getConnectorState(connectionId, checkoutKey(checkoutId));
  return value !== null && typeof value === 'object' ? (value as StripeCheckoutRow) : null;
}

// ---------------------------------------------------------------------------------------------
// Opening a checkout
// ---------------------------------------------------------------------------------------------

/**
 * Open a Checkout Session for one bound scope — the checkout relay's provider half. The relay has
 * already established the caller as that scope, refused a preview, and found this connection; what
 * is decided here is whether the reference may be charged, and what Stripe is asked for.
 */
export async function createStripeCheckout(
  host: ScopeHost,
  connection: { id: ConnectionId; tenantId: string; vertical: string },
  scopeId: string,
  request: Pick<ConnectionCheckoutRequest, 'reference' | 'currency' | 'lines' | 'successUrl' | 'cancelUrl' | 'customerEmail' | 'expiresInMinutes'>,
  options: StripeConnectorOptions,
): Promise<ConnectionCheckoutResult> {
  if (!(await bindingOf(host, connection.id, scopeId))) {
    throw new StripeCheckoutRefusal(
      `connection ${connection.id} is not bound to this scope, so a payment would have nowhere to land; bind it first`,
      409,
    );
  }
  const now = nowOf(options);
  const lineItems = request.lines.map((line) => {
    try {
      return {
        quantity: line.quantity,
        price_data: { currency: request.currency.toLowerCase(), unit_amount: toMinorUnits(line.unitAmount, request.currency), product_data: { name: line.name } },
      };
    } catch (err) {
      if (err instanceof StripeMoneyError) throw new StripeCheckoutRefusal(`line '${line.name}': ${err.message}`, 400);
      throw err;
    }
  });
  const digest = await sha256Hex(
    JSON.stringify([request.currency, request.lines, request.successUrl, request.cancelUrl, request.customerEmail ?? null, request.expiresInMinutes ?? null]),
  );

  const conn = await openStripeConnection(host.admin, options.fetch, connection.tenantId, connection.vertical, options.timeoutMs ?? 20_000, connection.id);
  const api = new StripeApi(conn, { apiBase: options.apiBase, sleep: options.sleep });

  const refKey = await referenceKey(scopeId, request.reference);
  const held = await host.admin.getConnectorState(connection.id, refKey);
  const previous = typeof held === 'object' && held !== null ? await checkoutRowOf(host, connection.id, (held as { checkoutId: string }).checkoutId) : null;
  if (previous) {
    const reused = await reuseOrClose(host, connection.id, api, previous, digest, now, options);
    if (reused) return reused;
  }

  const expiresAt = Math.floor(now / 1000) + (request.expiresInMinutes ?? DEFAULT_EXPIRY_MINUTES) * 60;
  const metadata = { substrat_connection: connection.id, substrat_scope: scopeId, substrat_reference: request.reference };
  let session: StripeCheckoutSession;
  try {
    session = await api.createCheckoutSession(
      {
        mode: 'payment',
        client_reference_id: request.reference,
        success_url: request.successUrl,
        cancel_url: request.cancelUrl,
        customer_email: request.customerEmail,
        expires_at: expiresAt,
        line_items: lineItems,
        metadata,
        payment_intent_data: { metadata },
      },
      // Fresh per call: it makes a 429 retry inside this call the same request, and nothing more. A
      // key derived from the ask would hand a later ask for the same reference Stripe's stored
      // answer — the session that ask is replacing.
      `substrat-checkout-${mintToken()}`,
    );
  } catch (err) {
    if (err instanceof StripeApiError && err.refused) {
      throw new StripeCheckoutRefusal("Stripe no longer accepts this connection's key; the tenant reconnects Stripe", 502);
    }
    if (err instanceof StripeApiError && err.forbidden) {
      throw new StripeCheckoutRefusal("this connection's key may not open a checkout; it needs Checkout Sessions: Write", 502);
    }
    if (err instanceof StripeApiError && err.status >= 400 && err.status < 500) {
      // Stripe refused what was asked (an amount below its minimum, a currency the account does
      // not take): the vertical's to fix, in Stripe's own words.
      throw new StripeCheckoutRefusal(`Stripe refused the checkout: ${err.message}`, 400);
    }
    throw err;
  }
  if (!session.url) throw new StripeCheckoutRefusal('Stripe opened the checkout without a page to send the buyer to', 502);

  const row: StripeCheckoutRow = {
    checkoutId: session.id,
    scopeId,
    tenantId: connection.tenantId,
    vertical: connection.vertical,
    reference: request.reference,
    digest,
    url: session.url,
    live: session.livemode,
    createdAt: iso(session.created * 1000),
    expiresAt: iso(session.expires_at * 1000),
    landed: null,
    settledAt: null,
  };
  await host.admin.putConnectorState(connection.id, checkoutKey(session.id), row);
  await host.admin.putConnectorState(connection.id, refKey, { checkoutId: session.id });
  // Best effort, never the buyer's problem: without an endpoint the sweep finds the outcome.
  await ensureStripeWebhook(host, connection, api, options).catch(() => undefined);
  return { connectionId: connection.id, checkoutId: session.id, url: session.url, expiresAt: instant.parse(row.expiresAt), live: session.livemode };
}

/**
 * What a repeat ask for a reference gets: the same session (same request, still open), a refusal
 * (a payment for it settled or is settling), or nothing — meaning open a new one, after closing the
 * previous one if it was still open.
 */
async function reuseOrClose(
  host: ScopeHost,
  connectionId: ConnectionId,
  api: StripeApi,
  previous: StripeCheckoutRow,
  digest: string,
  now: number,
  options: StripeConnectorOptions,
): Promise<ConnectionCheckoutResult | null> {
  // The scope's view may be behind Stripe's: read the truth before deciding on it.
  const { status } = await reconcileStripeCheckout(host, connectionId, api, previous, options);
  if (status === 'paid') throw new StripeCheckoutRefusal(`reference '${previous.reference}' is already paid (${previous.checkoutId})`, 409);
  if (status === 'processing') {
    throw new StripeCheckoutRefusal(`a payment for reference '${previous.reference}' is settling (${previous.checkoutId}); ask again once it has failed`, 409);
  }
  if (status !== 'open') return null;
  if (previous.digest === digest && previous.url && Date.parse(previous.expiresAt) - now > REUSE_MARGIN_MS) {
    return { connectionId, checkoutId: previous.checkoutId, url: previous.url, expiresAt: instant.parse(previous.expiresAt), live: previous.live };
  }
  // Stripe refuses to close a session that completed between the read above and now; the read
  // below is what decides either way, so the refusal itself says nothing.
  await api.expireCheckoutSession(previous.checkoutId).catch(() => undefined);
  const after = await reconcileStripeCheckout(host, connectionId, api, previous, options);
  if (after.status === 'paid') throw new StripeCheckoutRefusal(`reference '${previous.reference}' was paid while it was being re-opened (${previous.checkoutId})`, 409);
  if (after.status !== 'expired' && after.status !== 'failed') {
    throw new StripeCheckoutRefusal(`reference '${previous.reference}' could not be re-opened: its checkout is ${after.status}`, 409);
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Reading an outcome back, and landing it
// ---------------------------------------------------------------------------------------------

const RANK: Record<PaymentCheckoutStatus, number> = { open: 0, processing: 1, paid: 2, failed: 2, expired: 2 };
const isFinal = (status: PaymentCheckoutStatus | null): boolean => status !== null && FINAL_PAYMENT_CHECKOUT_STATUSES.includes(status);

/** A session's outcome in the neutral words, read only from what Stripe answered. */
export function checkoutStatusOf(session: StripeCheckoutSession): PaymentCheckoutStatus {
  if (session.status === 'expired') return 'expired';
  if (session.status !== 'complete') return 'open';
  if (session.payment_status === 'paid' || session.payment_status === 'no_payment_required') return 'paid';
  // Complete and unpaid: a delayed method (a bank debit) settling, or one that failed.
  const intent = typeof session.payment_intent === 'object' ? session.payment_intent : null;
  if (intent?.status === 'succeeded') return 'paid';
  if (intent?.status === 'requires_payment_method' || intent?.status === 'canceled') return 'failed';
  return 'processing';
}

/** The `paymentChange` a session stands at — parsed with the published schema on the way out. */
export function paymentChangeOf(connectionId: string, row: Pick<StripeCheckoutRow, 'reference'>, session: StripeCheckoutSession, observedAt: string): PaymentChange {
  const status = checkoutStatusOf(session);
  const intent = typeof session.payment_intent === 'object' ? session.payment_intent : null;
  const charge = intent && typeof intent.latest_charge === 'object' ? intent.latest_charge : null;
  if (session.currency === null || session.amount_total === null) {
    throw new StripeApiError(`Stripe answered checkout ${session.id} with no amount or currency`, 502);
  }
  return paymentChange.parse({
    record: 'checkout',
    change: 'upsert',
    connectionId,
    checkoutId: session.id,
    reference: row.reference,
    status,
    providerStatus: [session.status ?? 'unknown', session.payment_status, ...(intent ? [intent.status] : [])].join('/'),
    live: session.livemode,
    currency: currencyOf(session.currency),
    amount: fromMinorUnits(session.amount_total, session.currency),
    // When the charge was made; a checkout that needed no payment was "paid" when it was seen so.
    paidAt: status === 'paid' ? (charge ? iso(charge.created * 1000) : observedAt) : null,
    customerEmail: session.customer_details?.email ?? session.customer_email ?? null,
    createdAt: iso(session.created * 1000),
    observedAt,
  });
}

/**
 * Re-read one session from Stripe and land its status if the scope has not seen it. A status that
 * would move backwards (a stale read) is not landed. Throws when the landing fails, so the caller
 * reports it and the next sweep tries again.
 */
export async function reconcileStripeCheckout(
  host: ScopeHost,
  connectionId: ConnectionId,
  api: StripeApi,
  row: StripeCheckoutRow,
  options: { now?: () => number },
): Promise<{ status: PaymentCheckoutStatus; landed: boolean }> {
  const session = await api.checkoutSession(row.checkoutId);
  const status = checkoutStatusOf(session);
  // Re-read the row: a webhook and a sweep can both be here, and the newer one wins.
  const current = (await checkoutRowOf(host, connectionId, row.checkoutId)) ?? row;
  if (current.landed !== null && (status === current.landed || RANK[status] <= RANK[current.landed])) {
    return { status: current.landed, landed: false };
  }
  const binding = await bindingOf(host, connectionId, current.scopeId);
  if (!binding) throw new Error(`scope ${current.scopeId} is no longer bound; checkout ${current.checkoutId} (${status}) is held until it is`);
  const observedAt = iso(nowOf(options));
  const change = paymentChangeOf(connectionId, current, session, observedAt);
  const scope = await host.getConnectorScope(connectionId, scopeIdSchema.parse(current.scopeId));
  await scope.invoke(binding.operation, change);
  const next: StripeCheckoutRow = { ...current, landed: status, settledAt: isFinal(status) ? observedAt : null, url: status === 'open' ? current.url : null };
  // Lost to a concurrent writer: it read at least what this did, so its row stands.
  await host.admin.swapConnectorState(connectionId, checkoutKey(current.checkoutId), current, next);
  return { status, landed: true };
}

export interface StripeSweepResult {
  /** Scopes bound to this connection. */
  found: number;
  /** Checkouts re-read this pass. */
  checked: number;
  /** Statuses landed this pass. */
  landed: number;
  /** False when more open checkouts waited than one pass reads. */
  caughtUp: boolean;
  /** Settled rows past {@link STRIPE_SETTLED_KEEP_DAYS} let go this pass. */
  pruned: number;
  webhook: 'registered' | 'failed' | 'poll-only';
  failed: { scopeId: string; error: string; said?: string }[];
}

/** Re-read every open or settling checkout of this connection — the poll floor the platform schedules. */
export async function sweepStripe(host: ScopeHost, connectionId: ConnectionId, options: StripeConnectorOptions): Promise<StripeSweepResult> {
  const bindings = await listStripeBindings(host, connectionId);
  const rows = (await host.admin.listConnectorState(connectionId, CHECKOUT_PREFIX))
    .filter((r) => r.value !== null && typeof r.value === 'object')
    .map((r) => r.value as StripeCheckoutRow);
  const result: StripeSweepResult = { found: bindings.length, checked: 0, landed: 0, caughtUp: true, pruned: 0, webhook: 'poll-only', failed: [] };
  const anchor = bindings[0] ?? rows[0];
  if (!anchor) return result;

  const now = nowOf(options);
  const conn = await openStripeConnection(host.admin, options.fetch, anchor.tenantId, anchor.vertical, options.timeoutMs ?? 30_000, connectionId);
  const api = new StripeApi(conn, { apiBase: options.apiBase, sleep: options.sleep });
  if (options.callbackBase) {
    result.webhook = (await ensureStripeWebhook(host, { id: connectionId, tenantId: anchor.tenantId, vertical: anchor.vertical }, api, options)).state;
  }

  const outstanding = rows.filter((r) => !isFinal(r.landed)).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  result.caughtUp = outstanding.length <= STRIPE_CHECKOUTS_PER_SWEEP;
  for (const row of outstanding.slice(0, STRIPE_CHECKOUTS_PER_SWEEP)) {
    result.checked += 1;
    try {
      if ((await reconcileStripeCheckout(host, connectionId, api, row, options)).landed) result.landed += 1;
    } catch (err) {
      const error = maskKeys(err instanceof Error ? err.message : String(err));
      result.failed.push({ scopeId: row.scopeId, error: `checkout ${row.checkoutId}: ${error}`, said: `a payment outcome for '${row.reference}' did not land; it is tried again on the next pass` });
    }
  }

  const keepFrom = now - STRIPE_SETTLED_KEEP_DAYS * 24 * 60 * 60 * 1000;
  for (const row of rows) {
    if (!row.settledAt || Date.parse(row.settledAt) >= keepFrom) continue;
    await host.admin.putConnectorState(connectionId, checkoutKey(row.checkoutId), null);
    const refKey = await referenceKey(row.scopeId, row.reference);
    const ref = await host.admin.getConnectorState(connectionId, refKey);
    if (typeof ref === 'object' && ref !== null && (ref as { checkoutId?: string }).checkoutId === row.checkoutId) {
      await host.admin.putConnectorState(connectionId, refKey, null);
    }
    result.pruned += 1;
  }
  return result;
}

// ---------------------------------------------------------------------------------------------
// The webhook: registered by the connector, answered by the control plane
// ---------------------------------------------------------------------------------------------

/**
 * Register this connection's webhook endpoint on the Stripe account, once. Nothing when it is
 * registered at the current origin, or when a failed attempt is less than an hour old. A key
 * without Webhook Endpoints write leaves the connection poll-only, which the row records.
 */
export async function ensureStripeWebhook(
  host: ScopeHost,
  connection: { id: ConnectionId; tenantId: string; vertical: string },
  api: StripeApi,
  options: StripeConnectorOptions,
): Promise<{ state: 'registered' | 'failed' | 'poll-only' }> {
  if (!options.callbackBase) return { state: 'poll-only' };
  const base = options.callbackBase.replace(/\/+$/, '');
  // The raw value is what the swap below compares against: `undefined` for no row, `null` for a tombstone.
  const raw = await host.admin.getConnectorState(connection.id, WEBHOOK_KEY);
  const held = raw as StripeWebhookRow | null | undefined;
  if (held?.state === 'registered' && held.url.startsWith(`${base}/`)) return { state: 'registered' };
  const now = nowOf(options);
  if (held?.state === 'failed' && held.url.startsWith(`${base}/`) && now - Date.parse(held.attemptedAt) < WEBHOOK_RETRY_MS) return { state: 'failed' };

  const token = mintToken();
  const url = `${base}${stripeCallbackPath(connection.id, token)}`;
  let next: StripeWebhookRow;
  try {
    const endpoint = await api.createWebhookEndpoint(
      {
        url,
        enabled_events: [...STRIPE_WEBHOOK_EVENTS],
        api_version: STRIPE_API_VERSION,
        description: `Substrat: checkout outcomes for connection ${connection.id}`,
        metadata: { substrat_connection: connection.id },
      },
      `substrat-webhook-${connection.id}-${token}`,
    );
    if (!endpoint.secret) throw new StripeApiError('Stripe registered the endpoint without answering its signing secret', 502);
    next = { state: 'registered', endpointId: endpoint.id, secret: endpoint.secret, token, url, tenantId: connection.tenantId, vertical: connection.vertical, registeredAt: iso(now) };
  } catch (err) {
    const error = maskKeys(err instanceof Error ? err.message : String(err));
    next = { state: 'failed', url, error, tenantId: connection.tenantId, vertical: connection.vertical, attemptedAt: iso(now) };
  }
  // Two passes registering at once: the loser's endpoint is never answered, and is left in Stripe.
  await host.admin.swapConnectorState(connection.id, WEBHOOK_KEY, raw, next);
  return { state: next.state };
}

/** What the ingress did with one callback. Every rejection is one answer to the caller; the reason is the log's. */
export type StripeCallbackOutcome =
  | { accepted: false; reason: string }
  | { accepted: true; result: { eventId: string; type: string; checkoutId: string | null; status: PaymentCheckoutStatus | null; landed: boolean } };

/**
 * The webhook ingress. Nothing here trusts the body: the token in the URL and the signature over
 * the body establish that the call came from the endpoint this connection registered, and then the
 * event is read back from Stripe by id and the session by its id, and only Stripe's answers land.
 * Nothing short of a verified call causes provider egress. A throw after verification is the
 * caller's 500, so Stripe delivers again; the sweep covers what is never delivered.
 */
export async function handleStripeCallback(
  host: ScopeHost,
  ref: { connectionId: string; token: string },
  request: { body: string; signature: string | null },
  options: StripeConnectorOptions,
): Promise<StripeCallbackOutcome> {
  const id = connectionIdSchema.safeParse(ref.connectionId);
  if (!id.success) return { accepted: false, reason: 'malformed connection id' };
  const held = (await host.admin.getConnectorState(id.data, WEBHOOK_KEY)) as StripeWebhookRow | null | undefined;
  if (held?.state !== 'registered') return { accepted: false, reason: 'no endpoint registered for this connection' };
  if (!(await tokensMatch(ref.token, held.token))) return { accepted: false, reason: 'token mismatch' };
  if (!(await verifyStripeSignature(held.secret, request.body, request.signature, Math.floor(nowOf(options) / 1000)))) {
    return { accepted: false, reason: 'signature did not verify' };
  }
  let eventId: unknown;
  try {
    eventId = (JSON.parse(request.body) as { id?: unknown }).id;
  } catch {
    return { accepted: false, reason: 'body is not JSON' };
  }
  if (typeof eventId !== 'string' || !/^evt_[A-Za-z0-9]+$/.test(eventId)) return { accepted: false, reason: 'no event id' };

  const conn = await openStripeConnection(host.admin, options.fetch, held.tenantId, held.vertical, options.timeoutMs ?? 20_000, id.data);
  const api = new StripeApi(conn, { apiBase: options.apiBase, sleep: options.sleep });
  const event = await api.event(eventId);
  const checkoutId = event.type.startsWith('checkout.session.') && event.data.object.object === 'checkout.session' ? (event.data.object.id ?? null) : null;
  if (!checkoutId) return { accepted: true, result: { eventId, type: event.type, checkoutId: null, status: null, landed: false } };

  let row = await checkoutRowOf(host, id.data, checkoutId);
  if (!row) row = await adopt(host, id.data, api, checkoutId, held);
  if (!row) return { accepted: true, result: { eventId, type: event.type, checkoutId, status: null, landed: false } };
  const { status, landed } = await reconcileStripeCheckout(host, id.data, api, row, options);
  return { accepted: true, result: { eventId, type: event.type, checkoutId, status, landed } };
}

/**
 * A session this connection opened whose row was never written: Stripe answered the create and the
 * directory write after it failed. Recognised by the connection and scope its metadata names, and
 * only for a scope still bound — anything else on the account is not this connector's to land.
 */
async function adopt(
  host: ScopeHost,
  connectionId: ConnectionId,
  api: StripeApi,
  checkoutId: string,
  held: { tenantId: string; vertical: string },
): Promise<StripeCheckoutRow | null> {
  const session = await api.checkoutSession(checkoutId);
  const scopeId = session.metadata['substrat_scope'];
  const reference = session.metadata['substrat_reference'];
  if (session.metadata['substrat_connection'] !== connectionId || !scopeId || !reference) return null;
  if (!(await bindingOf(host, connectionId, scopeId))) return null;
  const row: StripeCheckoutRow = {
    checkoutId,
    scopeId,
    tenantId: held.tenantId,
    vertical: held.vertical,
    reference,
    digest: '',
    url: session.url,
    live: session.livemode,
    createdAt: iso(session.created * 1000),
    expiresAt: iso(session.expires_at * 1000),
    landed: null,
    settledAt: null,
  };
  if (!(await host.admin.swapConnectorState(connectionId, checkoutKey(checkoutId), undefined, row))) {
    return checkoutRowOf(host, connectionId, checkoutId);
  }
  return row;
}

// ---------------------------------------------------------------------------------------------
// Probes, and what a console reads
// ---------------------------------------------------------------------------------------------

/**
 * Probe a credential that is not stored yet — the connect-time check.
 *
 * Three reads, each saying something different: the account (whose Stripe is this — a restricted
 * key without Account read cannot say, and is not refused for it), Checkout Sessions (may this key
 * open a checkout at all — refused if not, since that is the whole connector), and webhook
 * endpoints (may it register one — if not, outcomes are found by polling, which the answer says).
 */
export async function probeStripeSecret(secret: Record<string, string>, options: StripeConnectorOptions): Promise<ConnectionProbe> {
  const parsed = stripeSecret.safeParse(secret);
  if (!parsed.success) return failed(true, `invalid Stripe credential: ${parsed.error.issues.map((i) => i.message).join(', ')}`);
  const conn: ConnectorConnection = {
    id: connectionIdSchema.parse('00000000000000000000000000'), // no row yet; never read
    tenantId: '',
    vertical: '',
    provider: 'stripe',
    secret: parsed.data,
    // A secret key does not expire; it is rolled or deleted in Stripe.
    expiresAt: null,
    fetch: deadlineFetch(options.fetch, options.timeoutMs ?? 15_000),
  };
  return probeWith(conn, options);
}

/** Probe the credential a live connection already holds. Verifying is itself a use. */
export async function probeStripeConnection(
  host: ScopeHost,
  connection: { tenantId: string; vertical: string },
  options: StripeConnectorOptions,
): Promise<ConnectionProbe> {
  const conn = await openStripeConnection(host.admin, options.fetch, connection.tenantId, connection.vertical, options.timeoutMs ?? 15_000);
  return probeWith(conn, options);
}

const failed = (refused: boolean, error: string): ConnectionProbe => ({
  ok: false,
  refused,
  accountRef: null,
  accountLabel: null,
  facts: [],
  error: maskKeys(error).slice(0, 600),
});

const clip = (s: string, n = 200): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

async function probeWith(conn: ConnectorConnection, options: StripeConnectorOptions): Promise<ConnectionProbe> {
  // A probe answers a person waiting on a form: a 429 is "busy, try again", not a wait.
  const api = new StripeApi(conn, { apiBase: options.apiBase, maxRateLimitRetries: 0 });
  const mode = api.live() ? 'Live — real payments' : 'Test — no real money moves';
  let accountId: string | null = null;
  let label: string | null = null;
  const facts: { label: string; value: string }[] = [];
  try {
    const account = await api.account();
    accountId = account.id;
    label = account.settings?.dashboard?.display_name ?? account.business_profile?.name ?? account.id;
    if (account.country) facts.push({ label: 'Country', value: account.country });
    if (account.default_currency) facts.push({ label: 'Default currency', value: account.default_currency.toUpperCase() });
  } catch (err) {
    if (!(err instanceof StripeApiError) || !err.forbidden) {
      const refused = err instanceof StripeApiError && err.refused;
      return failed(refused, refused ? 'Stripe does not accept this key: it is mistyped, rolled or deleted' : String((err as Error).message ?? err));
    }
    // A restricted key without Account read: valid, and Stripe names the account in the refusal.
    accountId = /\bacct_[A-Za-z0-9]+/.exec(err.message)?.[0] ?? null;
  }
  try {
    await api.anyCheckoutSession();
  } catch (err) {
    const forbidden = err instanceof StripeApiError && err.forbidden;
    return failed(forbidden, forbidden ? 'the key cannot open a checkout: give the restricted key Checkout Sessions: Write' : String((err as Error).message ?? err));
  }
  let webhooks = 'Can register the platform’s endpoint — outcomes arrive within seconds';
  try {
    await api.anyWebhookEndpoint();
  } catch (err) {
    if (!(err instanceof StripeApiError) || !err.forbidden) return failed(false, String((err as Error).message ?? err));
    webhooks = 'Not permitted — outcomes are found by polling, minutes later. Give the key Webhook Endpoints: Write to fix';
  }
  return {
    ok: true,
    refused: false,
    // Left null, as WooCommerce's is: one Stripe account per (tenant, vertical), so a re-paste rotates
    // the one connection in place. The account is named in the label and the facts.
    accountRef: null,
    accountLabel: label === null ? accountId : clip(label),
    facts: [
      { label: 'Account', value: accountId ?? 'not named by Stripe' },
      ...(label === null ? [{ label: 'Account name', value: 'not readable with this key (Account: Read is optional)' }] : []),
      { label: 'Mode', value: mode },
      ...facts,
      { label: 'Webhooks', value: webhooks },
    ],
    error: null,
  };
}

/** What this connection has been doing, for a console — its webhook, then one entry per checkout it keeps. */
export async function stripeConnectionActivity(host: ScopeHost, connectionId: ConnectionId): Promise<ConnectionActivity> {
  const webhook = (await host.admin.getConnectorState(connectionId, WEBHOOK_KEY)) as StripeWebhookRow | null | undefined;
  const rows = (await host.admin.listConnectorState(connectionId, CHECKOUT_PREFIX))
    .filter(({ value }) => value !== null && typeof value === 'object')
    .map(({ key, value }) => ({ key, row: value as StripeCheckoutRow }))
    .sort((a, b) => b.row.createdAt.localeCompare(a.row.createdAt));
  const entries = [
    ...(webhook
      ? [
          {
            key: WEBHOOK_KEY,
            title: 'Webhook endpoint',
            reference: webhook.state === 'registered' ? webhook.endpointId : null,
            status: webhook.state === 'registered' ? 'registered' : 'not registered — outcomes are polled',
            at: instant.parse(webhook.state === 'registered' ? webhook.registeredAt : webhook.attemptedAt),
            facts: webhook.state === 'registered' ? [] : [{ label: 'Why', value: clip(webhook.error) }],
          },
        ]
      : []),
    ...rows.map(({ key, row }) => ({
      key,
      title: `${row.reference} — ${row.vertical} ${row.scopeId}`,
      reference: row.checkoutId,
      status: row.landed ?? 'opened',
      at: instant.parse(row.settledAt ?? row.createdAt),
      facts: [
        { label: 'Mode', value: row.live ? 'live' : 'test' },
        { label: 'Opened', value: row.createdAt },
        { label: 'Expires', value: row.expiresAt },
      ],
    })),
  ];
  return connectionActivity.parse({ source: 'ledger', entries, live: false });
}

/** The stored credential, reduced: the key's kind and mode, and its last four characters. */
export async function stripeCredentialSummary(host: ScopeHost, connection: { tenantId: string; vertical: string }): Promise<ConnectionCredential> {
  const open = await host.admin.openConnection(tenantIdSchema.parse(connection.tenantId), connection.vertical, 'stripe');
  if (!open) throw new Error(`no live 'stripe' connection for tenant ${connection.tenantId} / vertical '${connection.vertical}'`);
  const { secretKey } = stripeSecret.parse(open.secret);
  const prefix = /^(sk|rk)_(live|test)_/.exec(secretKey)?.[0] ?? '';
  return {
    fields: [
      { key: 'secretKey', label: isLiveKey(secretKey) ? 'Secret key (live)' : 'Secret key (test)', value: `${prefix}••••${secretKey.slice(-4)}`, masked: true },
    ],
  };
}

// ---------------------------------------------------------------------------------------------
// Plumbing
// ---------------------------------------------------------------------------------------------

/** Open the live Stripe connection for a (tenant, vertical), with health recorded. */
async function openStripeConnection(
  admin: HostAdmin,
  fetchImpl: FetchLike,
  tenant: string,
  vertical: string,
  timeoutMs: number,
  expected?: ConnectionId,
): Promise<ConnectorConnection> {
  const open = await admin.openConnection(tenantIdSchema.parse(tenant), vertical, 'stripe');
  if (!open) throw new Error(`no live 'stripe' connection for tenant ${tenant} / vertical '${vertical}'`);
  // The credential that reads and the identity that lands must be the same connection.
  if (expected !== undefined && open.id !== expected) {
    throw new Error(`the live 'stripe' connection for tenant ${tenant} / vertical '${vertical}' is ${open.id}, not ${expected}`);
  }
  const bounded = deadlineFetch(fetchImpl, timeoutMs);
  return {
    ...open,
    fetch: async (input, init) => {
      const started = Date.now();
      try {
        const res = await bounded(input, init);
        await admin.recordConnectionUse(open.id, settleConnectionUse('stripe', Date.now() - started, { response: res }));
        return res;
      } catch (err) {
        await admin.recordConnectionUse(open.id, settleConnectionUse('stripe', Date.now() - started, { error: err }));
        throw err;
      }
    },
  };
}

function mintToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function sha256Hex(text: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
  return [...digest].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Constant-time: both are digested first, and the digests compared, so neither length nor content leaks. */
async function tokensMatch(presented: string, stored: string): Promise<boolean> {
  const [a, b] = await Promise.all([sha256Hex(presented), sha256Hex(stored)]);
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
