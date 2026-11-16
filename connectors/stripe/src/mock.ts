import type { FetchLike } from '@substrat-run/kernel';
import { STRIPE_API_BASE, STRIPE_API_VERSION } from './api.js';
import { stripeSignatureHeader } from './signature.js';

/**
 * A Stripe account in memory — the calls the connector makes, enough to run the probe, the
 * checkout round trip and the webhook without Stripe.
 *
 * **What a mock proves:** that our shape works — the pinned version, Bearer auth, the form body,
 * idempotency, the outcome read through the expanded PaymentIntent, the signed webhook. **What it
 * cannot prove:** that our reading of Stripe's API is right. The mock IS our reading; a run against
 * a test-mode account is what checks it.
 *
 * Strict where a convenient mock would let a client be wrong while every test passes:
 *
 * 1. **`Stripe-Version` must be the pinned one**, or the request is a 400.
 * 2. **A POST must be a form body and carry an `Idempotency-Key`.** Stripe takes a POST without
 *    one; this connector never sends one, so a missing key here is the connector's bug.
 * 3. **A reused idempotency key with a different body is a 400**, as Stripe answers it.
 * 4. **A session read without both expands answers `payment_intent` as a bare id**, so a client
 *    that forgets them cannot read an outcome.
 */
export interface StripeMockOptions {
  secretKey?: string;
  accountId?: string;
  /** Null: the account has no dashboard name and no business name. */
  accountName?: string | null;
  /** False: the key is a restricted key without Account read. */
  accountReadable?: boolean;
  /** False: the key is a restricted key without Checkout Sessions. */
  checkoutAllowed?: boolean;
  /** False: the key is a restricted key without Webhook Endpoints write. */
  webhooksAllowed?: boolean;
  /** Answer the first N requests with 429. */
  rateLimitFirst?: number;
  /** The mock's clock, in ms; `Date.now` by default. */
  now?: () => number;
}

type Json = Record<string, unknown>;

interface MockResponse {
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
  json(): Promise<unknown>;
}

const respond = (status: number, body: unknown): MockResponse => {
  const text = JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    text: async () => text,
    json: async () => JSON.parse(text) as unknown,
  };
};
const stripeError = (status: number, message: string, type = 'invalid_request_error', code?: string) =>
  respond(status, { error: { type, message, ...(code ? { code } : {}) } });

/** Stripe's bracket form, decoded into flat `key → value` pairs (arrays keep their brackets). */
function decodeForm(body: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const pair of body.split('&')) {
    if (pair === '') continue;
    const at = pair.indexOf('=');
    out.set(decodeURIComponent(pair.slice(0, at)), decodeURIComponent(pair.slice(at + 1).replace(/\+/g, ' ')));
  }
  return out;
}

interface MockSession {
  id: string;
  status: 'open' | 'complete' | 'expired';
  payment_status: 'paid' | 'unpaid' | 'no_payment_required';
  amount_total: number;
  currency: string;
  client_reference_id: string | null;
  customer_email: string | null;
  created: number;
  expires_at: number;
  livemode: boolean;
  metadata: Record<string, string>;
  intent: { id: string; status: string; charge: { id: string; created: number } | null };
}

export class StripeMock {
  readonly secretKey: string;
  readonly accountId: string;
  readonly requests: string[] = [];
  readonly sessions = new Map<string, MockSession>();
  readonly events = new Map<string, Json>();
  readonly endpoints: { id: string; url: string; secret: string; enabledEvents: string[]; apiVersion: string | null }[] = [];
  private readonly options: StripeMockOptions;
  private readonly idempotency = new Map<string, { body: string; answer: MockResponse }>();
  private counter = 0;
  private limited = 0;

  constructor(options: StripeMockOptions = {}) {
    this.options = options;
    this.secretKey = options.secretKey ?? 'rk_test_51MockKey000000000000';
    this.accountId = options.accountId ?? 'acct_1MockAccount';
  }

  /** What the connector's credential is: the one key this account accepts. */
  get secret(): { secretKey: string } {
    return { secretKey: this.secretKey };
  }

  private clock: (() => number) | undefined;

  /** Share a test's clock, so a session's times and the connector's agree. */
  useClock(now: () => number): void {
    this.clock = now;
  }

  private now(): number {
    return (this.clock ?? this.options.now)?.() ?? Date.now();
  }

  private seconds(): number {
    return Math.floor(this.now() / 1000);
  }

  private next(prefix: string): string {
    this.counter += 1;
    // Only a Checkout Session's id says its mode (`cs_test_…`); events, intents and charges do not.
    const mode = prefix === 'cs' ? (this.secretKey.includes('_live_') ? 'live_' : 'test_') : '';
    // The account is in every id, as Stripe's ids are unique across accounts: two mocks never share one.
    return `${prefix}_${mode}Mock${this.accountId.replace(/[^A-Za-z0-9]/g, '')}${String(this.counter).padStart(6, '0')}`;
  }

  get fetch(): FetchLike {
    return (async (input: string, init?: { method?: string; headers?: Record<string, string>; body?: unknown }) =>
      this.answer(input, init?.method ?? 'GET', init?.headers ?? {}, typeof init?.body === 'string' ? init.body : '')) as unknown as FetchLike;
  }

  private answer(input: string, method: string, headers: Record<string, string>, body: string): MockResponse {
    if (!input.startsWith(STRIPE_API_BASE)) throw new TypeError(`fetch failed: getaddrinfo ENOTFOUND (${input.slice(0, 40)})`);
    const pathAndQuery = input.slice(STRIPE_API_BASE.length);
    this.requests.push(`${method} ${pathAndQuery}`);
    if (this.limited < (this.options.rateLimitFirst ?? 0)) {
      this.limited += 1;
      return stripeError(429, 'Too many requests', 'rate_limit_error', 'rate_limit');
    }
    if (headers['Authorization'] !== `Bearer ${this.secretKey}`) {
      return stripeError(401, `Invalid API Key provided: ${(headers['Authorization'] ?? '').slice(7, 15)}****${(headers['Authorization'] ?? '').slice(-4)}`);
    }
    if (headers['Stripe-Version'] !== STRIPE_API_VERSION) return stripeError(400, `Invalid Stripe API version: ${headers['Stripe-Version']}`);
    const [path = '', query = ''] = pathAndQuery.split('?');
    if (method === 'POST') {
      if (headers['Content-Type'] !== 'application/x-www-form-urlencoded') return stripeError(400, 'a POST body must be form-encoded');
      const key = headers['Idempotency-Key'];
      if (!key) return stripeError(400, 'the connector sends every POST with an Idempotency-Key');
      const seen = this.idempotency.get(key);
      if (seen) {
        return seen.body === body
          ? seen.answer
          : stripeError(400, 'Keys for idempotent requests can only be used with the same parameters they were first used with.', 'idempotency_error');
      }
      const answer = this.post(path, decodeForm(body));
      if (answer.ok) this.idempotency.set(key, { body, answer });
      return answer;
    }
    return this.get(path, query);
  }

  private forbidden(permission: string): MockResponse {
    return stripeError(
      403,
      `The provided key '${this.secretKey.slice(0, 8)}*****${this.secretKey.slice(-4)}' does not have the required permissions for this endpoint on account '${this.accountId}'. Having the '${permission}' permission would allow this request to continue.`,
    );
  }

  private get(path: string, query: string): MockResponse {
    if (path === '/v1/account') {
      if (this.options.accountReadable === false) return this.forbidden('rak_accounts_kyc_basic_read');
      const name = this.options.accountName === undefined ? 'Acme Mugs' : this.options.accountName;
      return respond(200, { id: this.accountId, object: 'account', country: 'SE', default_currency: 'sek', business_profile: { name }, settings: { dashboard: { display_name: name } } });
    }
    if (path === '/v1/checkout/sessions') {
      if (this.options.checkoutAllowed === false) return this.forbidden('rak_checkout_session_read');
      return respond(200, { object: 'list', data: [], has_more: false });
    }
    if (path === '/v1/webhook_endpoints') {
      if (this.options.webhooksAllowed === false) return this.forbidden('rak_webhook_read');
      return respond(200, { object: 'list', data: [], has_more: false });
    }
    let m = /^\/v1\/checkout\/sessions\/([^/]+)$/.exec(path);
    if (m) {
      if (this.options.checkoutAllowed === false) return this.forbidden('rak_checkout_session_read');
      const session = this.sessions.get(decodeURIComponent(m[1]!));
      if (!session) return stripeError(404, `No such checkout.session: '${m[1]}'`, 'invalid_request_error', 'resource_missing');
      const expands = query.split('&').filter((p) => p.startsWith('expand')).map((p) => decodeURIComponent(p.split('=')[1] ?? ''));
      return respond(200, this.render(session, expands.includes('payment_intent') && expands.includes('payment_intent.latest_charge')));
    }
    m = /^\/v1\/webhook_endpoints\/([^/]+)$/.exec(path);
    if (m) {
      if (this.options.webhooksAllowed === false) return this.forbidden('rak_webhook_read');
      const endpoint = this.endpoints.find((e) => e.id === decodeURIComponent(m![1]!));
      if (!endpoint) return stripeError(404, `No such webhook endpoint: '${m[1]}'`, 'invalid_request_error', 'resource_missing');
      return respond(200, { id: endpoint.id, object: 'webhook_endpoint', url: endpoint.url, status: 'enabled' });
    }
    m = /^\/v1\/events\/([^/]+)$/.exec(path);
    if (m) {
      const event = this.events.get(decodeURIComponent(m[1]!));
      return event ? respond(200, event) : stripeError(404, `No such event: '${m[1]}'`, 'invalid_request_error', 'resource_missing');
    }
    return stripeError(404, `Unrecognized request URL (GET: ${path})`);
  }

  private post(path: string, form: Map<string, string>): MockResponse {
    if (path === '/v1/checkout/sessions') {
      if (this.options.checkoutAllowed === false) return this.forbidden('rak_checkout_session_write');
      if (form.get('mode') !== 'payment') return stripeError(400, 'mode must be payment here');
      const currencies = new Set<string>();
      let total = 0;
      for (let i = 0; form.has(`line_items[${i}][quantity]`); i += 1) {
        const unit = Number(form.get(`line_items[${i}][price_data][unit_amount]`));
        const quantity = Number(form.get(`line_items[${i}][quantity]`));
        if (!Number.isInteger(unit) || !form.get(`line_items[${i}][price_data][product_data][name]`)) return stripeError(400, `line_items[${i}] is incomplete`);
        currencies.add(form.get(`line_items[${i}][price_data][currency]`) ?? '');
        total += unit * quantity;
      }
      if (currencies.size !== 1) return stripeError(400, 'every line must be in one currency');
      const metadata: Record<string, string> = {};
      for (const [k, v] of form) {
        const mk = /^metadata\[(.+)\]$/.exec(k);
        if (mk) metadata[mk[1]!] = v;
      }
      const id = this.next('cs');
      const session: MockSession = {
        id,
        status: 'open',
        payment_status: total === 0 ? 'no_payment_required' : 'unpaid',
        amount_total: total,
        currency: [...currencies][0]!,
        client_reference_id: form.get('client_reference_id') ?? null,
        customer_email: form.get('customer_email') ?? null,
        created: this.seconds(),
        expires_at: Number(form.get('expires_at') ?? this.seconds() + 86_400),
        livemode: this.secretKey.includes('_live_'),
        metadata,
        intent: { id: this.next('pi'), status: 'requires_payment_method', charge: null },
      };
      this.sessions.set(id, session);
      return respond(200, this.render(session, false));
    }
    const m = /^\/v1\/checkout\/sessions\/([^/]+)\/expire$/.exec(path);
    if (m) {
      const session = this.sessions.get(decodeURIComponent(m[1]!));
      if (!session) return stripeError(404, `No such checkout.session: '${m[1]}'`, 'invalid_request_error', 'resource_missing');
      if (session.status !== 'open') return stripeError(400, `Only Checkout Sessions with a status in ["open"] can be expired.`);
      session.status = 'expired';
      this.emit('checkout.session.expired', session);
      return respond(200, this.render(session, false));
    }
    if (path === '/v1/webhook_endpoints') {
      if (this.options.webhooksAllowed === false) return this.forbidden('rak_webhook_write');
      const enabledEvents = [...form].filter(([k]) => k.startsWith('enabled_events[')).map(([, v]) => v);
      const endpoint = { id: this.next('we'), url: form.get('url') ?? '', secret: `whsec_${this.next('sec')}`, enabledEvents, apiVersion: form.get('api_version') ?? null };
      this.endpoints.push(endpoint);
      return respond(200, { id: endpoint.id, object: 'webhook_endpoint', url: endpoint.url, secret: endpoint.secret, status: 'enabled' });
    }
    return stripeError(404, `Unrecognized request URL (POST: ${path})`);
  }

  private render(session: MockSession, expanded: boolean): Json {
    const { intent, ...rest } = session;
    return {
      ...rest,
      object: 'checkout.session',
      customer_details: session.status === 'complete' ? { email: session.customer_email ?? 'buyer@example.com' } : null,
      url: session.status === 'open' ? `https://checkout.stripe.com/c/pay/${session.id}` : null,
      payment_intent: expanded
        ? { id: intent.id, object: 'payment_intent', status: intent.status, latest_charge: intent.charge ? { id: intent.charge.id, object: 'charge', created: intent.charge.created, status: 'succeeded' } : null }
        : intent.id,
    };
  }

  private emit(type: string, session: MockSession): Json {
    const event = { id: this.next('evt'), object: 'event', type, created: this.seconds(), livemode: session.livemode, data: { object: this.render(session, false) } };
    this.events.set(event.id, event);
    return event;
  }

  // ---- What a buyer, a bank and Stripe's clock do: each returns the event Stripe would send ----

  /** The buyer pays by card: the session completes paid at once. */
  pay(checkoutId: string): Json {
    const session = this.must(checkoutId);
    session.status = 'complete';
    session.payment_status = 'paid';
    session.intent = { ...session.intent, status: 'succeeded', charge: { id: this.next('ch'), created: this.seconds() } };
    return this.emit('checkout.session.completed', session);
  }

  /** The buyer finishes with a delayed method (a bank debit): complete, unpaid, settling. */
  payLater(checkoutId: string): Json {
    const session = this.must(checkoutId);
    session.status = 'complete';
    session.intent = { ...session.intent, status: 'processing' };
    return this.emit('checkout.session.completed', session);
  }

  /** The delayed method settles, or fails. */
  settle(checkoutId: string, succeeded: boolean): Json {
    const session = this.must(checkoutId);
    if (succeeded) {
      session.payment_status = 'paid';
      session.intent = { ...session.intent, status: 'succeeded', charge: { id: this.next('ch'), created: this.seconds() } };
      return this.emit('checkout.session.async_payment_succeeded', session);
    }
    session.intent = { ...session.intent, status: 'requires_payment_method' };
    return this.emit('checkout.session.async_payment_failed', session);
  }

  /** The session's time runs out with the buyer gone. */
  lapse(checkoutId: string): Json {
    const session = this.must(checkoutId);
    session.status = 'expired';
    return this.emit('checkout.session.expired', session);
  }

  /** What Stripe would POST to the one registered endpoint for `event`: the body and its signature header. */
  async delivery(event: Json, at = this.seconds()): Promise<{ url: string; body: string; signature: string }> {
    const endpoint = this.endpoints.at(-1);
    if (!endpoint) throw new Error('no webhook endpoint registered on the mock account');
    const body = JSON.stringify(event);
    return { url: endpoint.url, body, signature: await stripeSignatureHeader(endpoint.secret, body, at) };
  }

  private must(checkoutId: string): MockSession {
    const session = this.sessions.get(checkoutId);
    if (!session) throw new Error(`no session ${checkoutId}`);
    return session;
  }
}
