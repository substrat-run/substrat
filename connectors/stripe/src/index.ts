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
  type OpenConnection,
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
  stripeAccountRef,
  stripeSecret,
  STRIPE_API_VERSION,
  type StripeCheckoutSession,
  type StripeSecret,
} from './api.js';
import { currencyOf, fromMinorUnits, StripeMoneyError, toMinorUnits } from './money.js';
import { verifyStripeSignature } from './signature.js';

export {
  formEncode,
  isLiveKey,
  maskKeys,
  StripeApi,
  StripeApiError,
  stripeAccountRef,
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
 *
 * ## One account, one mode
 *
 * A connection is pinned to ONE Stripe account in ONE mode, named `acct_…:live` or `acct_…:test`
 * ({@link stripeAccountRef}). Everything it keeps — the webhook endpoint, every checkout, every
 * reference it refuses — is only true of that account in that mode, so:
 *
 * - **A connection is keyed on its account** (#3211): the platform takes its `externalAccountRef`
 *   from the account the connect-time probe names, so a pasted key for the same account and mode
 *   rotates that account's connection and keeps everything, and a key for another account, or the
 *   same account's other mode (going live from a test key), becomes a connection of its own. One
 *   app may hold several, each opened by its account ({@link StripeBinding.externalAccountRef}), and
 *   a checkout goes through the one bound to the scope.
 * - **A replacement key is still judged before it is stored** ({@link prepareStripeCandidate}, the
 *   platform's preparation of a candidate credential), for the connection that holds no account: one
 *   made before connections were keyed, which a key for another account or mode cannot replace
 *   (refused, nothing stored) until it is disconnected.
 * - **What is stored records the account it was written under** (the webhook row, each checkout
 *   row), so a key that reached the connection some other way is never used to read or write what
 *   another account's key wrote: a checkout of another account is not read, and the webhook is
 *   registered again on the account the key reaches, under a new token.
 *
 * What nobody can prevent is Stripe losing what it held: the account closed, or its test data
 * deleted. A checkout Stripe no longer has is held as missing. Nothing lands for it (its outcome is
 * unknown, not failed), the sweep stops asking about it, and its reference stays refused while a
 * live payment for it may have been taken. A revoked key is the other thing nobody prevents, and
 * needs nothing of its own: every call is refused until a key for the same account is pasted.
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
/** How long a reference claimed for an opening stays claimed if the opening never finishes. */
const CLAIM_MS = 2 * 60 * 1000;

/**
 * Stripe takes an expiry from 30 minutes to 24 hours after it creates the session, measured on its
 * clock when the request lands; asking for exactly either bound is refused after a little latency.
 */
function stripeExpirySeconds(minutes: number): number {
  return Math.min(Math.max(minutes * 60, 30 * 60 + 60), 24 * 60 * 60 - 60);
}

const BINDING_PREFIX = 'stripe:binding:';
const CHECKOUT_PREFIX = 'stripe:checkout:';
const REFERENCE_PREFIX = 'stripe:reference:';
const WEBHOOK_KEY = 'stripe:webhook';
/** Where the last sweep that could not read every outstanding checkout stopped. */
const SWEEP_CURSOR_KEY = 'stripe:sweep-cursor';
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
  /**
   * WHICH Stripe account's connection this is (#3211): the connection's `externalAccountRef`, the
   * account and mode its probe named ({@link stripeAccountRef}). A tenant may connect several Stripe
   * accounts to one app, each its own connection, so the credential cannot be found from the tenant
   * and vertical alone: the sweep opens it by this. Recorded at bind from the connection being bound;
   * absent on a binding of a connection made before connections were keyed on the account, which is
   * the app's only Stripe connection.
   */
  externalAccountRef?: string | null;
  boundAt: string;
}

/** What a reference is held by: the session opened for it, or a claim while one is being opened. */
interface StripeReferenceRow {
  checkoutId?: string;
  claimedAt?: string;
  /** Kept once the paid checkout's own row is pruned, so the reference is never charged again. */
  paidAt?: string;
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
  /** The account and mode it was opened on ({@link stripeAccountRef}); it is read with no other. */
  account: string;
  /** When Stripe answered that it no longer has this session (the account closed, its test data deleted). */
  missingAt?: string;
}

/** `account`: the account and mode ({@link stripeAccountRef}) the endpoint was registered on. */
export type StripeWebhookRow =
  | { state: 'registered'; endpointId: string; secret: string; token: string; url: string; account: string; tenantId: string; vertical: string; registeredAt: string }
  | { state: 'failed'; url: string; error: string; account: string; tenantId: string; vertical: string; attemptedAt: string };

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
  /** Checkouts one sweep re-reads; {@link STRIPE_CHECKOUTS_PER_SWEEP} unless a test says otherwise. */
  checkoutsPerSweep?: number;
}

/**
 * Stripe no longer has a session this connection opened, on the account and mode it was opened on:
 * the account was closed, or its test data deleted. The row is marked, and its outcome stays unknown.
 */
export class StripeCheckoutMissing extends Error {
  constructor(readonly checkoutId: string) {
    super(`Stripe no longer has checkout ${checkoutId} (its account was closed, or its test data deleted); its outcome cannot be read`);
    this.name = 'StripeCheckoutMissing';
  }
}

/**
 * State written under one Stripe account met a key for another, or for the other mode. Not read:
 * a connection is pinned to one account and mode, and only a key the platform's preparation skipped
 * can reach this.
 */
export class StripeAccountMismatch extends Error {
  constructor(what: string, written: string, reached: string) {
    super(`${what} was written under Stripe account ${written}, and this connection's key reaches ${reached}; a connection stays on one account and mode, so it is not read with this key`);
    this.name = 'StripeAccountMismatch';
  }
}

/**
 * A candidate key the platform will not store, with the status the connection relay answers: 422
 * for a key that cannot be this connection's (another account or mode, or one Stripe will not
 * name), 503 for a Stripe that did not answer. Nothing is stored either way.
 */
export class StripeKeyRefusal extends Error {
  constructor(
    message: string,
    readonly status: 422 | 503,
  ) {
    super(maskKeys(message));
    this.name = 'StripeKeyRefusal';
  }
}

/**
 * A checkout the relay refuses, with the status it answers: 400 for an ask Stripe or this connector
 * will not charge, 409 for a reference or connection in the wrong state, 503 for a Stripe that did
 * not answer usefully. Carries Stripe's own words only where they are the vertical's to act on.
 */
export class StripeCheckoutRefusal extends Error {
  constructor(
    message: string,
    readonly status: 400 | 409 | 503,
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
    /** The connection's `externalAccountRef`. See {@link StripeBinding.externalAccountRef}. */
    externalAccountRef?: string | null;
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
    ...(input.externalAccountRef ? { externalAccountRef: input.externalAccountRef } : {}),
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
  connection: { id: ConnectionId; tenantId: string; vertical: string; externalAccountRef?: string | null },
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

  const conn = await openStripeConnection(host.admin, options.fetch, connection.tenantId, connection.vertical, options.timeoutMs ?? 20_000, {
    account: connection.externalAccountRef,
    expected: connection.id,
  });
  const api = new StripeApi(conn, { apiBase: options.apiBase, sleep: options.sleep });
  const account = await api.accountRef();

  const refKey = await referenceKey(scopeId, request.reference);
  const held = await host.admin.getConnectorState(connection.id, refKey);
  const ref = typeof held === 'object' && held !== null ? (held as StripeReferenceRow) : null;
  const busy = () => new StripeCheckoutRefusal(`a checkout for reference '${request.reference}' is being opened by another request; ask again in a moment`, 409);
  if (ref?.paidAt) throw new StripeCheckoutRefusal(`reference '${request.reference}' is already paid (${ref.checkoutId})`, 409);
  if (ref && !ref.checkoutId && now - Date.parse(ref.claimedAt ?? '') < CLAIM_MS) throw busy();
  const previous = ref?.checkoutId ? await checkoutRowOf(host, connection.id, ref.checkoutId) : null;
  if (previous) {
    const reused = await reuseOrClose(host, connection.id, api, previous, digest, now, options);
    if (reused) return reused;
  }
  // One ask opens a session for a reference at a time. Without the claim, two asks arriving together
  // would both find nothing open, both open a session, and the buyer could pay both.
  const claim: StripeReferenceRow = { claimedAt: iso(now) };
  if (!(await host.admin.swapConnectorState(connection.id, refKey, held, claim))) throw busy();

  const expiresAt = Math.floor(now / 1000) + stripeExpirySeconds(request.expiresInMinutes ?? DEFAULT_EXPIRY_MINUTES);
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
    // Nothing was opened: let the next ask have the reference.
    await host.admin.swapConnectorState(connection.id, refKey, claim, held ?? null).catch(() => undefined);
    if (err instanceof StripeApiError && err.refused) {
      throw new StripeCheckoutRefusal("Stripe no longer accepts this connection's key; the tenant reconnects Stripe", 409);
    }
    if (err instanceof StripeApiError && err.forbidden) {
      throw new StripeCheckoutRefusal("this connection's key may not open a checkout; it needs Checkout Sessions: Write", 409);
    }
    if (err instanceof StripeApiError && err.status >= 400 && err.status < 500) {
      // Stripe refused what was asked (an amount below its minimum, a currency the account does
      // not take): the vertical's to fix, in Stripe's own words.
      throw new StripeCheckoutRefusal(`Stripe refused the checkout: ${err.message}`, 400);
    }
    throw err;
  }
  if (!session.url) throw new StripeCheckoutRefusal('Stripe opened the checkout without a page to send the buyer to', 503);

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
    account,
  };
  await host.admin.putConnectorState(connection.id, checkoutKey(session.id), row);
  // Published only while this ask still holds its claim: one that stalled past CLAIM_MS may have been
  // overtaken by a later ask, and two payable sessions for one reference is what the claim prevents.
  if (!(await host.admin.swapConnectorState(connection.id, refKey, claim, { checkoutId: session.id }))) {
    await api.expireCheckoutSession(session.id).catch(() => undefined);
    throw busy();
  }
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
  let status: PaymentCheckoutStatus;
  try {
    ({ status } = await reconcileStripeCheckout(host, connectionId, api, previous, options));
  } catch (err) {
    if (err instanceof StripeAccountMismatch) throw new StripeCheckoutRefusal(`reference '${previous.reference}' cannot be charged: ${err.message}`, 409);
    if (!(err instanceof StripeCheckoutMissing)) throw err;
    // Stripe no longer has it. What landed is all that is known of it.
    if (previous.landed === 'paid') throw new StripeCheckoutRefusal(`reference '${previous.reference}' is already paid (${previous.checkoutId})`, 409);
    // A final outcome already landed, or a test-mode session, which never moves money: free to charge.
    if (isFinal(previous.landed) || !previous.live) return null;
    throw new StripeCheckoutRefusal(
      `reference '${previous.reference}' has a live checkout (${previous.checkoutId}) that Stripe no longer has, so whether it was paid cannot be read, ` +
        `and the reference stays refused. A new reference is not guarded against this one: use one only after confirming, from the account's payments in Stripe, that the order was not paid`,
      409,
    );
  }
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
  // Asked of the account it was opened on, or not at all: another account's Stripe would answer that
  // it has no such session, which says nothing about whether it was paid.
  const account = await api.accountRef();
  if (row.account !== account) throw new StripeAccountMismatch(`checkout ${row.checkoutId}`, row.account, account);
  let session: StripeCheckoutSession;
  try {
    session = await api.checkoutSession(row.checkoutId);
  } catch (err) {
    // Asked of its own account and mode, a not-found is Stripe no longer having it.
    if (!(err instanceof StripeApiError) || err.status !== 404) throw err;
    const held = (await checkoutRowOf(host, connectionId, row.checkoutId)) ?? row;
    // Lost to a concurrent writer: the next read marks it.
    if (held.missingAt === undefined) await host.admin.swapConnectorState(connectionId, checkoutKey(row.checkoutId), held, { ...held, missingAt: iso(nowOf(options)) });
    throw new StripeCheckoutMissing(row.checkoutId);
  }
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
  /** Outstanding checkouts Stripe no longer has, held as missing and not asked about again. */
  missing: number;
  webhook: 'registered' | 'failed' | 'poll-only';
  failed: { scopeId: string; error: string; said?: string }[];
}

/** Re-read every open or settling checkout of this connection — the poll floor the platform schedules. */
export async function sweepStripe(host: ScopeHost, connectionId: ConnectionId, options: StripeConnectorOptions): Promise<StripeSweepResult> {
  const bindings = await listStripeBindings(host, connectionId);
  const rows = (await host.admin.listConnectorState(connectionId, CHECKOUT_PREFIX))
    .filter((r) => r.value !== null && typeof r.value === 'object')
    .map((r) => r.value as StripeCheckoutRow);
  const result: StripeSweepResult = { found: bindings.length, checked: 0, landed: 0, caughtUp: true, pruned: 0, missing: 0, webhook: 'poll-only', failed: [] };
  const anchor = bindings[0] ?? rows[0];
  if (!anchor) return result;

  const now = nowOf(options);
  // Which account's connection this is: a binding records it, and every row this connection wrote
  // names the account its key reached, which is the one a keyed connection is for (#3211).
  const account = bindings.find((b) => b.externalAccountRef)?.externalAccountRef ?? rows[0]?.account;
  const conn = await openStripeConnection(host.admin, options.fetch, anchor.tenantId, anchor.vertical, options.timeoutMs ?? 30_000, {
    account,
    expected: connectionId,
  });
  const api = new StripeApi(conn, { apiBase: options.apiBase, sleep: options.sleep });
  if (options.callbackBase) {
    result.webhook = (await ensureStripeWebhook(host, { id: connectionId, tenantId: anchor.tenantId, vertical: anchor.vertical }, api, options)).state;
  }

  // Read in turn from where the last pass stopped, so checkouts that stay outstanding for days (a
  // bank debit settling, a scope since unbound) cannot hold every pass and keep newer ones unread.
  const cap = options.checkoutsPerSweep ?? STRIPE_CHECKOUTS_PER_SWEEP;
  const order = (r: StripeCheckoutRow) => `${r.createdAt}|${r.checkoutId}`;
  // A checkout Stripe has said it no longer has is not asked about again.
  const unsettled = rows.filter((r) => !isFinal(r.landed));
  const outstanding = unsettled.filter((r) => r.missingAt === undefined).sort((a, b) => order(a).localeCompare(order(b)));
  result.missing = unsettled.length - outstanding.length;
  const cursor = await host.admin.getConnectorState(connectionId, SWEEP_CURSOR_KEY);
  const from = typeof cursor === 'string' ? Math.max(0, outstanding.findIndex((r) => order(r) > cursor)) : 0;
  const batch = [...outstanding.slice(from), ...outstanding.slice(0, from)].slice(0, cap);
  result.caughtUp = outstanding.length <= cap;
  if (!result.caughtUp) await host.admin.putConnectorState(connectionId, SWEEP_CURSOR_KEY, order(batch.at(-1)!));
  else if (typeof cursor === 'string') await host.admin.putConnectorState(connectionId, SWEEP_CURSOR_KEY, null);
  for (const row of batch) {
    result.checked += 1;
    try {
      if ((await reconcileStripeCheckout(host, connectionId, api, row, options)).landed) result.landed += 1;
    } catch (err) {
      const error = maskKeys(err instanceof Error ? err.message : String(err));
      if (err instanceof StripeCheckoutMissing) {
        result.missing += 1;
        result.failed.push({ scopeId: row.scopeId, error, said: `Stripe no longer has the payment for '${row.reference}'; its outcome is unknown, and nothing lands for it` });
        continue;
      }
      if (err instanceof StripeAccountMismatch) {
        result.failed.push({ scopeId: row.scopeId, error, said: `the payment for '${row.reference}' is on a Stripe account this connection's key does not reach; it is not read` });
        continue;
      }
      result.failed.push({ scopeId: row.scopeId, error: `checkout ${row.checkoutId}: ${error}`, said: `a payment outcome for '${row.reference}' did not land; it is tried again on the next pass` });
    }
  }

  const keepFrom = now - STRIPE_SETTLED_KEEP_DAYS * 24 * 60 * 60 * 1000;
  for (const row of rows) {
    if (!row.settledAt || Date.parse(row.settledAt) >= keepFrom) continue;
    await host.admin.putConnectorState(connectionId, checkoutKey(row.checkoutId), null);
    const refKey = await referenceKey(row.scopeId, row.reference);
    const ref = await host.admin.getConnectorState(connectionId, refKey);
    if (typeof ref === 'object' && ref !== null && (ref as StripeReferenceRow).checkoutId === row.checkoutId) {
      // A paid reference stays refused after its row goes; any other is free to be charged again.
      const kept: StripeReferenceRow | null = row.landed === 'paid' ? { checkoutId: row.checkoutId, paidAt: row.settledAt } : null;
      await host.admin.putConnectorState(connectionId, refKey, kept);
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
 * registered at the current origin on the account the key reaches, or when a failed attempt there
 * is less than an hour old. An endpoint on another account (a key the platform's preparation
 * skipped) is left behind and a new one registered under a new token, so the old one's calls are
 * refused. A key without Webhook Endpoints write leaves the connection poll-only, which the row records.
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
  const account = await api.accountRef();
  const here = held?.url.startsWith(`${base}/`) === true && held.account === account;
  if (held?.state === 'registered' && here) return { state: 'registered' };
  const now = nowOf(options);
  if (held?.state === 'failed' && here && now - Date.parse(held.attemptedAt) < WEBHOOK_RETRY_MS) return { state: 'failed' };

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
    next = { state: 'registered', endpointId: endpoint.id, secret: endpoint.secret, token, url, account, tenantId: connection.tenantId, vertical: connection.vertical, registeredAt: iso(now) };
  } catch (err) {
    const error = maskKeys(err instanceof Error ? err.message : String(err));
    next = { state: 'failed', url, error, account, tenantId: connection.tenantId, vertical: connection.vertical, attemptedAt: iso(now) };
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

  const conn = await openStripeConnection(host.admin, options.fetch, held.tenantId, held.vertical, options.timeoutMs ?? 20_000, {
    account: held.account,
    expected: id.data,
  });
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
    account: await api.accountRef(),
  };
  if (!(await host.admin.swapConnectorState(connectionId, checkoutKey(checkoutId), undefined, row))) {
    return checkoutRowOf(host, connectionId, checkoutId);
  }
  return row;
}

// ---------------------------------------------------------------------------------------------
// Probes, and what a console reads
// ---------------------------------------------------------------------------------------------

/** A connection for a credential that is not stored yet: no row, so nothing is recorded against one. */
function candidateConnection(secret: StripeSecret, options: StripeConnectorOptions): ConnectorConnection {
  return {
    id: connectionIdSchema.parse('00000000000000000000000000'), // no row yet; never read
    tenantId: '',
    vertical: '',
    provider: 'stripe',
    secret,
    // A secret key does not expire; it is rolled or deleted in Stripe.
    expiresAt: null,
    fetch: deadlineFetch(options.fetch, options.timeoutMs ?? 15_000),
  };
}

/**
 * Probe a credential that is not stored yet — the connect-time check.
 *
 * Three reads, each saying something different: the account (whose Stripe is this, and in which
 * mode — the account and mode the connection is pinned to; a restricted key without Account read is
 * named by Stripe's refusal, and refused only if that names no account), Checkout Sessions (may this
 * key open a checkout at all — refused if not, since that is the whole connector), and webhook
 * endpoints (may it register one — if not, outcomes are found by polling, which the answer says).
 */
export async function probeStripeSecret(secret: Record<string, string>, options: StripeConnectorOptions): Promise<ConnectionProbe> {
  const parsed = stripeSecret.safeParse(secret);
  if (!parsed.success) return failed(true, `invalid Stripe credential: ${parsed.error.issues.map((i) => i.message).join(', ')}`);
  return probeWith(candidateConnection(parsed.data, options), options);
}

/** Probe the credential a live connection already holds. Verifying is itself a use. */
export async function probeStripeConnection(
  host: ScopeHost,
  connection: StripeConnectionRef,
  options: StripeConnectorOptions,
): Promise<ConnectionProbe> {
  const conn = await openStripeConnection(host.admin, options.fetch, connection.tenantId, connection.vertical, options.timeoutMs ?? 15_000, {
    account: connection.externalAccountRef,
    expected: connection.id,
  });
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
const NOT_ACCEPTED = 'Stripe does not accept this key: it is mistyped, rolled or deleted';

async function probeWith(conn: ConnectorConnection, options: StripeConnectorOptions): Promise<ConnectionProbe> {
  // A probe answers a person waiting on a form: a 429 is "busy, try again", not a wait.
  const api = new StripeApi(conn, { apiBase: options.apiBase, maxRateLimitRetries: 0 });
  const mode = api.live() ? 'Live — real payments' : 'Test — no real money moves';
  let named: Awaited<ReturnType<StripeApi['namedAccount']>>;
  try {
    named = await api.namedAccount();
  } catch (err) {
    const refused = err instanceof StripeApiError && (err.refused || err.forbidden);
    return failed(refused, err instanceof StripeApiError && err.refused ? NOT_ACCEPTED : String((err as Error).message ?? err));
  }
  const label = named.account ? (named.account.settings?.dashboard?.display_name ?? named.account.business_profile?.name ?? null) : null;
  const facts: { label: string; value: string }[] = [];
  if (named.account?.country) facts.push({ label: 'Country', value: named.account.country });
  if (named.account?.default_currency) facts.push({ label: 'Default currency', value: named.account.default_currency.toUpperCase() });
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
    // The account and mode the connection is pinned to, and keyed on (#3211): the platform makes
    // this its `externalAccountRef`, so a key for another account or mode is another connection.
    accountRef: stripeAccountRef(named.id, api.live()),
    accountLabel: clip(label ?? named.id),
    facts: [
      { label: 'Account', value: named.id },
      ...(named.account === null ? [{ label: 'Account name', value: 'not readable with this key (Account: Read is optional)' }] : []),
      { label: 'Mode', value: mode },
      ...facts,
      { label: 'Webhooks', value: webhooks },
    ],
    error: null,
  };
}

/**
 * The platform's preparation of a candidate key (`ConnectionInspector.prepareCandidate`), run
 * before the key is stored, on every way a key reaches a connection. It pins the key to the account
 * and mode Stripe names for it, stored with the key as `account`, whatever the paste carried.
 *
 * On a replacement (`previous` is the live connection's credential) it refuses, before anything is
 * stored, a key for another account or the same account's other mode: nothing the connection keeps
 * is true of that one. Since #3211 the platform keys a Stripe connection on the account its probe
 * names, so `previous` is the same account's credential and this holds trivially — except for a
 * connection made before that, which holds no account and is still shown as `previous` to every
 * key. Refusing there is what stops another account's key replacing it; disconnected, the next key
 * makes a keyed connection. The same account and mode is a rotation, and keeps everything.
 *
 * A key whose account Stripe will not name is refused too, and so is any key when Stripe does not
 * answer (a 503, nothing stored): unpinned, the next replacement could not be judged.
 */
export function prepareStripeCandidate(
  options: StripeConnectorOptions,
): (candidate: Record<string, string>, previous: Record<string, string> | undefined) => Promise<{ secret: Record<string, string> }> {
  return async (candidate, previous) => {
    const parsed = stripeSecret.safeParse(candidate);
    if (!parsed.success) throw new StripeKeyRefusal(`invalid Stripe credential: ${parsed.error.issues.map((i) => i.message).join(', ')}`, 422);
    const api = new StripeApi(candidateConnection({ secretKey: parsed.data.secretKey }, options), { apiBase: options.apiBase, maxRateLimitRetries: 0 });
    let id: string;
    try {
      ({ id } = await api.namedAccount());
    } catch (err) {
      if (err instanceof StripeApiError && err.refused) throw new StripeKeyRefusal(NOT_ACCEPTED, 422);
      if (err instanceof StripeApiError && err.forbidden) throw new StripeKeyRefusal(err.message, 422);
      throw new StripeKeyRefusal(`Stripe did not say which account this key belongs to, so nothing was stored; try again in a moment (${clip(String((err as Error).message ?? err))})`, 503);
    }
    const account = stripeAccountRef(id, api.live());
    if (previous !== undefined) {
      const pinned = stripeSecret.safeParse(previous).data?.account;
      const [pinnedId, pinnedMode] = pinned?.split(':') ?? [];
      const [, mode] = account.split(':');
      const asNew = 'connect it as a new connection: disconnect Stripe, then connect again with this key';
      if (pinned === undefined) {
        throw new StripeKeyRefusal(`this connection's current key was stored without the Stripe account it belongs to, so a replacement cannot be checked against it; ${asNew}`, 422);
      }
      if (pinnedId !== id) {
        throw new StripeKeyRefusal(`this key belongs to another Stripe account (${id}) than the one this connection is for (${pinnedId}); a connection stays on one account, so ${asNew}`, 422);
      }
      if (pinnedMode !== mode) {
        throw new StripeKeyRefusal(`this is a ${mode}-mode key, and this connection is for ${pinnedId} in ${pinnedMode} mode; a connection stays in one mode, so ${asNew}`, 422);
      }
    }
    return { secret: { secretKey: parsed.data.secretKey, account } };
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
            facts: [{ label: 'Account', value: webhook.account }, ...(webhook.state === 'registered' ? [] : [{ label: 'Why', value: clip(webhook.error) }])],
          },
        ]
      : []),
    ...rows.map(({ key, row }) => ({
      key,
      title: `${row.reference} — ${row.vertical} ${row.scopeId}`,
      reference: row.checkoutId,
      status: row.missingAt !== undefined ? 'missing — Stripe no longer has it; its outcome is unknown' : (row.landed ?? 'opened'),
      at: instant.parse(row.settledAt ?? row.createdAt),
      facts: [
        { label: 'Account', value: row.account },
        { label: 'Mode', value: row.live ? 'live' : 'test' },
        { label: 'Opened', value: row.createdAt },
        { label: 'Expires', value: row.expiresAt },
      ],
    })),
  ];
  return connectionActivity.parse({ source: 'ledger', entries, live: false });
}

/** The stored credential, reduced: the key's kind and mode, and its last four characters. */
export async function stripeCredentialSummary(host: ScopeHost, connection: StripeConnectionRef): Promise<ConnectionCredential> {
  const open = await openStripeCredential(host.admin, connection.tenantId, connection.vertical, {
    account: connection.externalAccountRef,
    expected: connection.id,
  });
  const { secretKey, account } = stripeSecret.parse(open.secret);
  const prefix = /^(sk|rk)_(live|test)_/.exec(secretKey)?.[0] ?? '';
  return {
    fields: [
      { key: 'secretKey', label: isLiveKey(secretKey) ? 'Secret key (live)' : 'Secret key (test)', value: `${prefix}••••${secretKey.slice(-4)}`, masked: true },
      // An identifier, whole: the account and mode the connection is pinned to.
      ...(account ? [{ key: 'account', label: 'Stripe account', value: account, masked: false }] : []),
    ],
  };
}

// ---------------------------------------------------------------------------------------------
// Plumbing
// ---------------------------------------------------------------------------------------------

/**
 * A Stripe connection as a caller knows it: its tenant and vertical, and — where the caller holds
 * the row — its id and `externalAccountRef`, the Stripe account and mode it is keyed on (#3211).
 */
export interface StripeConnectionRef {
  id?: ConnectionId;
  tenantId: string;
  vertical: string;
  externalAccountRef?: string | null;
}

/**
 * Open one Stripe connection's credential (#3211).
 *
 * A tenant may connect several Stripe accounts to one app, one connection each, keyed on the
 * account (`externalAccountRef`), so a read that names no account throws once there are two.
 * `account` names it: the connection's own ref where the caller holds the row, else the account a
 * binding or a row this connection wrote records, which for a keyed connection is its ref. With no
 * connection on that account — a connection made before connections were keyed holds none, and is
 * then the app's only one — the read names no account.
 *
 * `expected` is the connection the caller acts for. The credential that reads and the identity that
 * lands must be the same connection, so whatever the account found, another connection is refused.
 */
async function openStripeCredential(
  admin: HostAdmin,
  tenant: string,
  vertical: string,
  select: { account?: string | null; expected?: ConnectionId },
): Promise<OpenConnection> {
  const t = tenantIdSchema.parse(tenant);
  const open =
    (select.account ? await admin.openConnection(t, vertical, 'stripe', select.account) : undefined) ??
    (await admin.openConnection(t, vertical, 'stripe'));
  if (!open) throw new Error(`no live 'stripe' connection for tenant ${tenant} / vertical '${vertical}'`);
  if (select.expected !== undefined && open.id !== select.expected) {
    throw new Error(`the live 'stripe' connection for tenant ${tenant} / vertical '${vertical}' is ${open.id}, not ${select.expected}`);
  }
  return open;
}

/** {@link openStripeCredential}, with health recorded on every call it makes. */
async function openStripeConnection(
  admin: HostAdmin,
  fetchImpl: FetchLike,
  tenant: string,
  vertical: string,
  timeoutMs: number,
  select: { account?: string | null; expected?: ConnectionId } = {},
): Promise<ConnectorConnection> {
  const open = await openStripeCredential(admin, tenant, vertical, select);
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
