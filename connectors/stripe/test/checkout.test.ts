import { afterEach, describe, expect, it } from 'vitest';
import { STRIPE_API_VERSION, STRIPE_WEBHOOK_EVENTS, StripeApi, StripeCheckoutRefusal, stripeConnectionActivity } from '../src/index.js';
import { StripeMock } from '../src/mock.js';
import { CALLBACK_BASE, world, type World } from './world.js';

/**
 * The payment round trip against `StripeMock`: a bound scope opens a checkout, Stripe's webhook (or
 * the sweep) finds the outcome, and each new status lands once, in the neutral payment shape,
 * through the vertical's own operation as the connection itself.
 */
let w: World | undefined;
afterEach(() => {
  w?.close();
  w = undefined;
});

const posts = (mock: StripeMock) => mock.requests.filter((r) => r.startsWith('POST'));

describe('stripe connector — opening a checkout', () => {
  it('refuses a scope the connection is not bound to, before calling Stripe', async () => {
    const mock = new StripeMock();
    w = await world(mock);
    await expect(w.checkout()).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/nowhere to land/) });
    expect(mock.requests).toEqual([]);
  });

  it('opens one session for the order in minor units, and registers the webhook endpoint once', async () => {
    const mock = new StripeMock();
    w = await world(mock);
    await w.bind();
    const answer = await w.checkout({ customerEmail: 'asa@example.com' });
    expect(answer).toEqual({
      connectionId: w.connId,
      checkoutId: expect.stringMatching(/^cs_test_/),
      url: expect.stringMatching(/^https:\/\/checkout\.stripe\.com\//),
      expiresAt: '2026-11-15T11:00:00.000Z',
      live: false,
    });
    expect((await w.checkout({ reference: 'order-30', expiresInMinutes: 30 })).expiresAt).toBe('2026-11-15T10:31:00.000Z');
    const session = mock.sessions.get(answer.checkoutId)!;
    // 2 × 99.50 + 50 SEK, in öre.
    expect(session).toMatchObject({ amount_total: 24900, currency: 'sek', client_reference_id: 'order-17', customer_email: 'asa@example.com' });
    expect(session.metadata).toEqual({ substrat_connection: w.connId, substrat_scope: w.scopeId, substrat_reference: 'order-17' });
    expect(mock.endpoints).toEqual([
      {
        id: expect.any(String),
        url: expect.stringMatching(new RegExp(`^${CALLBACK_BASE}/hooks/stripe/${w.connId}/[0-9a-f]{64}$`)),
        secret: expect.any(String),
        enabledEvents: [...STRIPE_WEBHOOK_EVENTS],
        apiVersion: STRIPE_API_VERSION,
      },
    ]);
    await w.checkout({ reference: 'order-18' });
    expect(mock.endpoints).toHaveLength(1);
  });

  it('answers the same open session for the same ask, and closes it for a changed one', async () => {
    const mock = new StripeMock();
    w = await world(mock);
    await w.bind();
    const first = await w.checkout();
    const sessionsBefore = posts(mock).filter((r) => r === 'POST /v1/checkout/sessions').length;
    expect(await w.checkout()).toEqual(first);
    expect(posts(mock).filter((r) => r === 'POST /v1/checkout/sessions')).toHaveLength(sessionsBefore);

    const changed = await w.checkout({ lines: [{ name: 'Mug', quantity: 3, unitAmount: '99.50' }] });
    expect(changed.checkoutId).not.toBe(first.checkoutId);
    expect(mock.sessions.get(first.checkoutId)!.status).toBe('expired');
    // The closed one's outcome reached the scope before the new one opened.
    expect(w.landed.map((c) => [c.checkoutId, c.status])).toEqual([
      [first.checkoutId, 'open'],
      [first.checkoutId, 'expired'],
    ]);
  });

  it('refuses a second ask for a reference while the first is still opening its session', async () => {
    const mock = new StripeMock();
    w = await world(mock);
    await w.bind();
    // Hold the first ask's call to Stripe open, so the second arrives mid-opening.
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const direct = mock.fetch;
    w.options.fetch = (async (url: string, init?: { method?: string }) => {
      if (init?.method === 'POST' && url.endsWith('/v1/checkout/sessions')) await held;
      return direct(url, init as never);
    }) as typeof direct;
    const first = w.checkout();
    await expect(w.checkout()).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/being opened/) });
    release();
    const opened = await first;
    expect(mock.sessions.size).toBe(1);
    // Once opened, the claim holds the session, and the same ask is answered from it.
    expect((await w.checkout()).checkoutId).toBe(opened.checkoutId);
  });

  it.each([
    [{ currency: 'ISK', lines: [{ name: 'Mug', quantity: 1, unitAmount: '100' }] }, /does not charge in it/],
    [{ lines: [{ name: 'Mug', quantity: 1, unitAmount: '9.995' }] }, /never rounded/],
  ])('refuses money it would have to guess at: %j', async (over, why) => {
    const mock = new StripeMock();
    w = await world(mock);
    await w.bind();
    const err = await w.checkout(over).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StripeCheckoutRefusal);
    expect(err).toMatchObject({ status: 400, message: expect.stringMatching(why) });
    expect(posts(mock)).toEqual([]);
  });
});

describe('stripe connector — hearing the outcome', () => {
  it('lands a card payment from the webhook once, reads it from Stripe, and then refuses the reference', async () => {
    const mock = new StripeMock();
    w = await world(mock);
    await w.bind();
    const { checkoutId } = await w.checkout();
    const event = mock.pay(checkoutId);

    const outcome = await w.deliver(event);
    expect(outcome).toEqual({ accepted: true, result: { eventId: event.id, type: 'checkout.session.completed', checkoutId, status: 'paid', landed: true } });
    expect(w.landed).toEqual([
      {
        record: 'checkout',
        change: 'upsert',
        connectionId: w.connId,
        checkoutId,
        reference: 'order-17',
        status: 'paid',
        providerStatus: 'complete/paid/succeeded',
        live: false,
        currency: 'SEK',
        amount: '249.00',
        paidAt: '2026-11-15T10:00:00.000Z',
        customerEmail: 'buyer@example.com',
        createdAt: '2026-11-15T10:00:00.000Z',
        observedAt: '2026-11-15T10:00:00.000Z',
      },
    ]);
    // The event and the session were both read back from Stripe.
    expect(mock.requests).toContain(`GET /v1/events/${event.id}`);

    // Stripe delivers again (it does): nothing lands twice, and the sweep agrees.
    expect(await w.deliver(event)).toMatchObject({ accepted: true, result: { status: 'paid', landed: false } });
    expect(await w.sweep()).toMatchObject({ found: 1, checked: 0, landed: 0, webhook: 'registered', failed: [] });
    expect(w.landed).toHaveLength(1);

    await expect(w.checkout()).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/already paid/) });
  });

  it('follows a delayed payment through processing to failed, and lets the reference be paid again', async () => {
    const mock = new StripeMock();
    w = await world(mock);
    await w.bind();
    const { checkoutId } = await w.checkout();
    mock.payLater(checkoutId);
    await w.sweep();
    expect(w.landed.map((c) => c.status)).toEqual(['processing']);
    await expect(w.checkout()).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/settling/) });

    mock.settle(checkoutId, false);
    await w.sweep();
    expect(w.landed.map((c) => [c.status, c.paidAt])).toEqual([
      ['processing', null],
      ['failed', null],
    ]);
    const again = await w.checkout();
    expect(again.checkoutId).not.toBe(checkoutId);
  });

  it.each([
    ['a wrong token', { token: 'f'.repeat(64) }, /token mismatch/],
    ['a body changed after signing', { body: '{"id":"evt_test_Forged"}' }, /signature/],
    ['a delivery replayed an hour later', { at: Math.floor(Date.parse('2026-11-15T09:00:00Z') / 1000) }, /signature/],
  ])('rejects %s without asking Stripe anything', async (_, tamper, reason) => {
    const mock = new StripeMock();
    w = await world(mock);
    await w.bind();
    const { checkoutId } = await w.checkout();
    const event = mock.pay(checkoutId);
    const before = mock.requests.length;
    expect(await w.deliver(event, tamper)).toEqual({ accepted: false, reason: expect.stringMatching(reason) });
    expect(mock.requests.length).toBe(before);
    expect(w.landed).toEqual([]);
  });

  it('finds the outcome by polling where the key may not register an endpoint', async () => {
    const mock = new StripeMock({ webhooksAllowed: false });
    w = await world(mock);
    await w.bind();
    const { checkoutId } = await w.checkout();
    mock.lapse(checkoutId);
    expect(await w.sweep()).toMatchObject({ found: 1, checked: 1, landed: 1, webhook: 'failed', failed: [] });
    expect(w.landed.map((c) => c.status)).toEqual(['expired']);
    const activity = await stripeConnectionActivity(w.host, w.connId);
    expect(activity.entries[0]).toMatchObject({ title: 'Webhook endpoint', status: 'not registered — outcomes are polled', facts: [{ label: 'Why', value: expect.stringMatching(/permissions/) }] });
  });

  it.each([
    ['adopts a session this connection opened whose row was never written', true, 1],
    ['lands nothing for a session opened outside this connection', false, 0],
  ])('%s', async (_, ours, landings) => {
    const mock = new StripeMock();
    w = await world(mock);
    await w.bind();
    await w.checkout({ reference: 'order-1' }); // registers the endpoint
    // Opened at Stripe directly: as this connection would have (the directory write after it
    // failed), or by the tenant's own dashboard.
    const api = new StripeApi({ id: w.connId, tenantId: w.tenantId, vertical: 'shop', provider: 'stripe', secret: mock.secret, expiresAt: null, fetch: mock.fetch });
    const metadata = ours ? { substrat_connection: w.connId, substrat_scope: w.scopeId, substrat_reference: 'order-2' } : {};
    const session = await api.createCheckoutSession(
      { mode: 'payment', success_url: 'https://x/s', cancel_url: 'https://x/c', line_items: [{ quantity: 1, price_data: { currency: 'sek', unit_amount: 1000, product_data: { name: 'Mug' } } }], metadata },
      'direct',
    );
    const outcome = await w.deliver(mock.pay(session.id));
    expect(outcome).toMatchObject({ accepted: true, result: { checkoutId: session.id, landed: ours } });
    expect(w.landed.filter((c) => c.checkoutId === session.id)).toHaveLength(landings);
    if (ours) expect(w.landed.at(-1)).toMatchObject({ reference: 'order-2', status: 'paid', amount: '10.00' });
  });
});
