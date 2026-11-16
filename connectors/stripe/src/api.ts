import { z } from 'zod';
import type { ConnectorConnection } from '@substrat-run/kernel';

/**
 * A thin, typed client over the Stripe REST API. Every call goes through the connection's `fetch`,
 * never a global one: that is what gets it a timeout, an egress policy, and health recorded against
 * the right connection.
 *
 * ## The version is pinned
 *
 * Every request carries `Stripe-Version: {@link STRIPE_API_VERSION}`. Without it Stripe answers in
 * the account's default version, which the account's owner can move in their dashboard, and a
 * field this client reads could change shape under a running connection. The webhook endpoint the
 * connector registers is pinned to the same version.
 *
 * ## The key
 *
 * The credential is one secret key, sent as a Bearer token and nowhere else. A restricted key
 * (`rk_…`) is what a tenant should paste, with exactly the permissions {@link STRIPE_KEY_PERMISSIONS}
 * lists; a full secret key (`sk_…`) works and is more than the connector needs. A publishable key
 * (`pk_…`) is refused by the schema: it cannot create a Checkout Session.
 *
 * Bodies are `application/x-www-form-urlencoded` with Stripe's bracket notation for nesting
 * (`line_items[0][price_data][currency]=sek`), which is the only body Stripe's API takes.
 */
export const STRIPE_API_BASE = 'https://api.stripe.com';
export const STRIPE_API_VERSION = '2024-06-20';

/**
 * What a restricted key needs, in the words of Stripe's key editor: Checkout Sessions to open a
 * checkout and read it back, Events to read a webhook's event back by its id, Webhook Endpoints to
 * register the platform's endpoint on the account. Without the last, payments are still found, by
 * polling, only later. Account read is optional: without it Stripe still names the account (by id,
 * in its refusal), and with it Test connection also shows the account's name.
 */
export const STRIPE_KEY_PERMISSIONS = [
  'Checkout Sessions: Write',
  'Events: Read',
  'Webhook Endpoints: Write',
  'Account: Read (optional, names the account by its name in Test connection)',
] as const;

/** The account and mode a connection is pinned to, `acct_…:live` or `acct_…:test`. */
const ACCOUNT_REF = /^acct_[A-Za-z0-9]+:(live|test)$/;

/**
 * The credential as it is stored: the key, and the account and mode it was found to reach when it
 * was connected (`account`, written by the platform's preparation, never by the person pasting —
 * see `prepareStripeCandidate`). Absent on a credential stored some other way, in which case the
 * connector asks Stripe.
 */
export const stripeSecret = z.object({
  secretKey: z
    .string()
    .regex(/^(sk|rk)_(live|test)_[A-Za-z0-9]+$/, 'a Stripe secret or restricted key (sk_… or rk_…); a publishable key (pk_…) cannot open a checkout'),
  account: z.string().regex(ACCOUNT_REF, 'a Stripe account and mode (acct_…:live or acct_…:test)').optional(),
});
export type StripeSecret = z.infer<typeof stripeSecret>;

/** Whether a key moves real money. Read from the key, which is what Stripe itself decides by. */
export const isLiveKey = (secretKey: string): boolean => /^(sk|rk)_live_/.test(secretKey);

/** One Stripe account in one mode, as a connection is pinned to it: `acct_123:live`. */
export const stripeAccountRef = (accountId: string, live: boolean): string => `${accountId}:${live ? 'live' : 'test'}`;

/**
 * A Stripe API failure, with what a caller branches on.
 *
 * - `refused`: the key is not valid (401).
 * - `forbidden`: the key is valid and lacks a permission this call needs (403) — a restricted key
 *   made without one of {@link STRIPE_KEY_PERMISSIONS}.
 *
 * The message carries Stripe's own `message`, `type` and `code`, with any key fragment Stripe
 * echoes masked, so no message here can carry credential material.
 */
export class StripeApiError extends Error {
  readonly status: number;
  readonly type: string | null;
  readonly code: string | null;
  readonly refused: boolean;
  readonly forbidden: boolean;
  constructor(message: string, status: number, type: string | null = null, code: string | null = null) {
    super(maskKeys(message));
    this.name = 'StripeApiError';
    this.status = status;
    this.type = type;
    this.code = code;
    this.refused = status === 401;
    this.forbidden = status === 403;
  }
}

/** Stripe quotes keys in some errors (masked by Stripe, but not always all of it). Mask what it left. */
export function maskKeys(text: string): string {
  return text.replace(/\b(sk|rk|pk|whsec)_(live_|test_)?[A-Za-z0-9*]+/g, '$1_$2••••');
}

/** Stripe's error body is `{ error: { type, code, message } }`. */
function errorOf(body: string, status: number): { message: string; type: string | null; code: string | null } {
  try {
    const e = (JSON.parse(body) as { error?: { message?: unknown; type?: unknown; code?: unknown } }).error;
    if (e && typeof e.message === 'string') {
      return { message: e.message, type: typeof e.type === 'string' ? e.type : null, code: typeof e.code === 'string' ? e.code : null };
    }
  } catch {
    // Not JSON: a proxy's page. Its text is not worth quoting.
  }
  return { message: `HTTP ${status}`, type: null, code: null };
}

// Provider shapes. Extra fields are ignored; a field Stripe may send as `null` reads `null` as absent.
const optStr = () => z.string().nullable().optional().transform((v) => v ?? null);

export const stripeAccount = z.object({
  id: z.string(),
  business_profile: z.object({ name: optStr() }).nullable().optional(),
  settings: z.object({ dashboard: z.object({ display_name: optStr() }).nullable().optional() }).nullable().optional(),
  country: optStr(),
  default_currency: optStr(),
});
export type StripeAccount = z.infer<typeof stripeAccount>;

const stripeCharge = z.object({ id: z.string(), created: z.number().int(), status: optStr() });

export const stripePaymentIntent = z.object({
  id: z.string(),
  /** `processing` while a delayed method settles; `requires_payment_method` after it failed. */
  status: z.string(),
  latest_charge: z.union([z.string(), stripeCharge]).nullable().optional().transform((v) => v ?? null),
});

export const stripeCheckoutSession = z.object({
  id: z.string(),
  /** `open`, `complete` or `expired`. */
  status: z.string().nullable(),
  /** `paid`, `unpaid` or `no_payment_required`. */
  payment_status: z.string(),
  amount_total: z.number().int().nullable(),
  currency: z.string().nullable(),
  client_reference_id: optStr(),
  customer_email: optStr(),
  customer_details: z.object({ email: optStr() }).nullable().optional().transform((v) => v ?? null),
  created: z.number().int(),
  expires_at: z.number().int(),
  /** The hosted page. Stripe stops answering it once the session is no longer open. */
  url: optStr(),
  livemode: z.boolean(),
  metadata: z.record(z.string(), z.string()).nullable().optional().transform((v) => v ?? {}),
  payment_intent: z.union([z.string(), stripePaymentIntent]).nullable().optional().transform((v) => v ?? null),
});
export type StripeCheckoutSession = z.infer<typeof stripeCheckoutSession>;

export const stripeEvent = z.object({
  id: z.string(),
  type: z.string(),
  created: z.number().int(),
  livemode: z.boolean(),
  data: z.object({ object: z.object({ id: z.string().optional(), object: z.string().optional() }).passthrough() }),
});
export type StripeEvent = z.infer<typeof stripeEvent>;

export const stripeWebhookEndpoint = z.object({
  id: z.string(),
  url: z.string(),
  /** Answered once, when the endpoint is created; never on a read. */
  secret: z.string().optional(),
});
export type StripeWebhookEndpoint = z.infer<typeof stripeWebhookEndpoint>;

const list = <T extends z.ZodTypeAny>(item: T) => z.object({ data: z.array(item), has_more: z.boolean() });

/** A value Stripe's bracket notation can carry. */
export type FormValue = string | number | boolean | null | undefined | FormValue[] | { [key: string]: FormValue };

/** Stripe's form body: nested objects and arrays as bracketed keys; `null` and `undefined` left out. */
export function formEncode(params: Record<string, FormValue>): string {
  const pairs: string[] = [];
  const walk = (key: string, value: FormValue): void => {
    if (value === null || value === undefined) return;
    if (Array.isArray(value)) {
      value.forEach((v, i) => walk(`${key}[${i}]`, v));
    } else if (typeof value === 'object') {
      for (const [k, v] of Object.entries(value)) walk(`${key}[${k}]`, v);
    } else {
      pairs.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
    }
  };
  for (const [k, v] of Object.entries(params)) walk(k, v);
  return pairs.join('&');
}

export interface StripeApiOptions {
  /** For a test deployment pointed at a stub. Unset means the real API. */
  apiBase?: string;
  /** Injected so a test can wait through a 429 without sleeping. */
  sleep?: (ms: number) => Promise<void>;
  /** How many 429s in a row a request sits out. Zero disables the retry, which is what a probe wants. */
  maxRateLimitRetries?: number;
}

/** The first wait after a 429; doubled each time. Stripe sends no `Retry-After` to read instead. */
const RETRY_BASE_MS = 1_000;

export class StripeApi {
  private readonly conn: ConnectorConnection;
  private readonly apiBase: string;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly maxRateLimitRetries: number;

  constructor(conn: ConnectorConnection, options?: StripeApiOptions) {
    this.conn = conn;
    this.apiBase = (options?.apiBase ?? STRIPE_API_BASE).replace(/\/+$/, '');
    this.sleep = options?.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.maxRateLimitRetries = options?.maxRateLimitRetries ?? 2;
  }

  private secret(): StripeSecret {
    const parsed = stripeSecret.safeParse(this.conn.secret);
    // Names the field, never its value.
    if (!parsed.success) throw new StripeApiError(`incomplete Stripe credential: ${parsed.error.issues.map((i) => i.message).join(', ')}`, 400);
    return parsed.data;
  }

  /** Whether this connection's key moves real money. */
  live(): boolean {
    return isLiveKey(this.secret().secretKey);
  }

  private asked: Promise<string> | undefined;

  /**
   * The account and mode this connection is pinned to ({@link stripeAccountRef}): the one stored with
   * the key, or, for a credential stored without one, what Stripe names for the key (asked once).
   */
  accountRef(): Promise<string> {
    const pinned = this.secret().account;
    if (pinned) return Promise.resolve(pinned);
    this.asked ??= this.namedAccount().then(({ id }) => stripeAccountRef(id, this.live()));
    return this.asked;
  }

  /**
   * Which account the key belongs to — the cheapest call that names it. A key with Account read gets
   * the account; a restricted key without it is refused, and Stripe names the account in the refusal
   * (`account` is then null). A refusal that names none is passed on as the 403 it is.
   */
  async namedAccount(): Promise<{ id: string; account: StripeAccount | null }> {
    try {
      const account = await this.account();
      return { id: account.id, account };
    } catch (err) {
      if (!(err instanceof StripeApiError) || !err.forbidden) throw err;
      const id = /\bacct_[A-Za-z0-9]+/.exec(err.message)?.[0];
      if (!id) throw new StripeApiError('Stripe did not say which account this key belongs to; give the restricted key Account: Read', 403);
      return { id, account: null };
    }
  }

  private async call<T extends z.ZodTypeAny>(
    method: 'GET' | 'POST',
    path: string,
    shape: T,
    options: { body?: Record<string, FormValue>; idempotencyKey?: string } = {},
  ): Promise<z.infer<T>> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.secret().secretKey}`,
      'Stripe-Version': STRIPE_API_VERSION,
      Accept: 'application/json',
    };
    let body: string | undefined;
    if (method === 'POST') {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      body = formEncode(options.body ?? {});
      // A POST is retried after a 429 below; the key makes the retry the same request to Stripe.
      if (options.idempotencyKey) headers['Idempotency-Key'] = options.idempotencyKey;
    }
    const what = `${method} ${path.split('?')[0]}`;
    for (let attempt = 0; ; attempt += 1) {
      const res = await this.conn.fetch(`${this.apiBase}${path}`, { method, headers, ...(body !== undefined ? { body } : {}) });
      const text = await res.text();
      if (res.ok) {
        let json: unknown;
        try {
          json = JSON.parse(text);
        } catch {
          throw new StripeApiError(`Stripe ${what} answered something that is not JSON`, 502);
        }
        const parsed = shape.safeParse(json);
        if (!parsed.success) {
          const first = parsed.error.issues[0];
          throw new StripeApiError(`Stripe ${what} answered an unexpected shape (${first ? `${first.path.join('.')}: ${first.message}` : 'unreadable'})`, 502);
        }
        return parsed.data;
      }
      if (res.status === 429 && attempt < this.maxRateLimitRetries && (method === 'GET' || options.idempotencyKey)) {
        await this.sleep(RETRY_BASE_MS * 2 ** attempt);
        continue;
      }
      const e = errorOf(text, res.status);
      throw new StripeApiError(`Stripe ${what} failed (${res.status}${e.code ? ` ${e.code}` : ''}): ${e.message}`, res.status, e.type, e.code);
    }
  }

  /** The account the key belongs to. A restricted key without Account read answers 403. */
  account(): Promise<StripeAccount> {
    return this.call('GET', '/v1/account', stripeAccount);
  }

  /** One Checkout Session, if any — the probe's check that the key may use Checkout at all. */
  async anyCheckoutSession(): Promise<void> {
    await this.call('GET', '/v1/checkout/sessions?limit=1', list(z.unknown()));
  }

  /** One webhook endpoint, if any — the probe's check that the key may register one. */
  async anyWebhookEndpoint(): Promise<void> {
    await this.call('GET', '/v1/webhook_endpoints?limit=1', list(z.unknown()));
  }

  createCheckoutSession(body: Record<string, FormValue>, idempotencyKey: string): Promise<StripeCheckoutSession> {
    return this.call('POST', '/v1/checkout/sessions', stripeCheckoutSession, { body, idempotencyKey });
  }

  /** A session with its PaymentIntent and that intent's latest charge, which is what its outcome is read from. */
  checkoutSession(id: string): Promise<StripeCheckoutSession> {
    const expand = `expand[]=payment_intent&expand[]=${encodeURIComponent('payment_intent.latest_charge')}`;
    return this.call('GET', `/v1/checkout/sessions/${encodeURIComponent(id)}?${expand}`, stripeCheckoutSession);
  }

  /** Close an open session so it can no longer be paid. Stripe refuses one that is not open. */
  expireCheckoutSession(id: string): Promise<StripeCheckoutSession> {
    return this.call('POST', `/v1/checkout/sessions/${encodeURIComponent(id)}/expire`, stripeCheckoutSession, { idempotencyKey: `expire-${id}` });
  }

  event(id: string): Promise<StripeEvent> {
    return this.call('GET', `/v1/events/${encodeURIComponent(id)}`, stripeEvent);
  }

  createWebhookEndpoint(body: Record<string, FormValue>, idempotencyKey: string): Promise<StripeWebhookEndpoint> {
    return this.call('POST', '/v1/webhook_endpoints', stripeWebhookEndpoint, { body, idempotencyKey });
  }
}
