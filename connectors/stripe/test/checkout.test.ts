import { afterEach, describe, expect, it } from 'vitest';
import type { FetchLike } from '@substrat-run/kernel';
import { STRIPE_API_VERSION, STRIPE_WEBHOOK_EVENTS, StripeApi, StripeCheckoutRefusal, prepareStripeCandidate, stripeConnectionActivity } from '../src/index.js';
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
    // Either may win the claim: the loser is refused without waiting, the winner waits on Stripe.
    const asks = [w.checkout(), w.checkout()];
    const refused = await Promise.any(asks.map((ask) => ask.then(() => Promise.reject(new Error('opened')), (err: unknown) => err)));
    expect(refused).toMatchObject({ status: 409, message: expect.stringMatching(/being opened/) });
    release();
    const settled = await Promise.allSettled(asks);
    const opened = settled.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []));
    expect(opened).toHaveLength(1);
    expect(mock.sessions.size).toBe(1);
    // Once opened, the claim holds the session, and the same ask is answered from it.
    expect((await w.checkout()).checkoutId).toBe(opened[0]!.checkoutId);
  });

  it('closes the session of an ask that stalled past its claim, rather than publish a second payable one', async () => {
    const mock = new StripeMock();
    w = await world(mock);
    await w.bind();
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const direct = mock.fetch;
    let stalls = 1;
    w.options.fetch = (async (url: string, init?: { method?: string }) => {
      if (init?.method === 'POST' && url.endsWith('/v1/checkout/sessions') && stalls-- > 0) await held;
      return direct(url, init as never);
    }) as typeof direct;
    const stalled = w.checkout().catch((err: unknown) => err);
    await new Promise((r) => setImmediate(r));
    w.clock.ms += 3 * 60 * 1000; // past the claim
    const later = await w.checkout();
    release();
    expect(await stalled).toMatchObject({ status: 409, message: expect.stringMatching(/being opened/) });
    const sessions = [...mock.sessions.values()];
    expect(sessions.map((s) => [s.id === later.checkoutId, s.status])).toEqual(expect.arrayContaining([[true, 'open'], [false, 'expired']]));
    expect((await w.checkout()).checkoutId).toBe(later.checkoutId);
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

    // Its row is let go after the keep window; the reference stays refused.
    w.clock.ms += 31 * 24 * 60 * 60 * 1000;
    expect(await w.sweep()).toMatchObject({ pruned: 1 });
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
    expect(activity.entries[0]).toMatchObject({ title: 'Webhook endpoint', status: 'not registered — outcomes are polled', facts: [{ label: 'Account', value: 'acct_1MockAccount:test' }, { label: 'Why', value: expect.stringMatching(/permissions/) }] });
  });

  it('reads outstanding checkouts in turn, so ones that stay open cannot keep a newer outcome unread', async () => {
    const mock = new StripeMock({ webhooksAllowed: false });
    w = await world(mock);
    await w.bind();
    w.options.checkoutsPerSweep = 2;
    const ids: string[] = [];
    for (const reference of ['order-1', 'order-2', 'order-3']) {
      ids.push((await w.checkout({ reference })).checkoutId);
      w.clock.ms += 1000;
    }
    mock.pay(ids[2]!);
    expect(await w.sweep()).toMatchObject({ checked: 2, landed: 2, caughtUp: false });
    expect(await w.sweep()).toMatchObject({ checked: 2, caughtUp: false });
    expect(w.landed.filter((c) => c.status === 'paid').map((c) => c.checkoutId)).toEqual([ids[2]]);
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

describe('stripe connector — one account, one mode', () => {
  /** Stripe as several accounts behind one fetch: each request answered by the account its key belongs to. */
  const accounts = (...mocks: StripeMock[]): FetchLike =>
    (async (input: string, init?: { headers?: Record<string, string> }) => {
      const mock = mocks.find((m) => init?.headers?.['Authorization'] === `Bearer ${m.secretKey}`) ?? mocks[0]!;
      return mock.fetch(input, init as never);
    }) as unknown as FetchLike;

  it('keeps the webhook and every checkout through a rolled key for the same account and mode', async () => {
    const mock = new StripeMock({ secretKey: 'rk_live_51Before00000000', accountId: 'acct_1Same' });
    w = await world(mock);
    await w.bind();
    const { checkoutId } = await w.checkout();
    mock.roll('rk_live_51Rolled00000000');
    await w.repaste('rk_live_51Rolled00000000');
    expect((await w.host.admin.openConnection(w.tenantId, 'shop', 'stripe'))!.secret).toEqual({ secretKey: 'rk_live_51Rolled00000000', account: 'acct_1Same:live' });
    // The endpoint registered under the old key still answers: its call is heard, and the payment lands.
    expect(await w.deliver(mock.pay(checkoutId))).toMatchObject({ accepted: true, result: { checkoutId, status: 'paid', landed: true } });
    expect(await w.sweep()).toMatchObject({ webhook: 'registered', failed: [] });
    expect(mock.endpoints).toHaveLength(1);
  });

  it.each([
    ['a key for another account', 'rk_live_51Other000000000', 'acct_1Other', undefined, /another Stripe account \(acct_1Other\).*\(acct_1Same\).*new connection/],
    ['a test key for the same account', 'rk_test_51Same0000000000', 'acct_1Same', undefined, /test-mode key.*acct_1Same in live mode.*new connection/],
    ['any key, when the stored one was kept without its account', 'rk_live_51Rolled00000000', 'acct_1Same', { secretKey: 'rk_live_51Before00000000' }, /stored without the Stripe account.*new connection/],
  ] as const)('refuses %s at replacement, before anything is stored', async (_, secretKey, accountId, stored, error) => {
    const before = new StripeMock({ secretKey: 'rk_live_51Before00000000', accountId: 'acct_1Same' });
    const candidate = new StripeMock({ secretKey, accountId });
    w = await world(before, { fetch: accounts(before, candidate) });
    if (stored) await w.overwriteKey(stored);
    const kept = (await w.host.admin.openConnection(w.tenantId, 'shop', 'stripe'))!.secret;
    await expect(w.repaste(secretKey)).rejects.toMatchObject({ name: 'StripeKeyRefusal', status: 422, message: expect.stringMatching(error) });
    expect((await w.host.admin.openConnection(w.tenantId, 'shop', 'stripe'))!.secret).toEqual(kept);
  });

  it.each([
    ['will not name', { accountReadable: false, refusalNamesAccount: false }, 422, /Account: Read/],
    ['did not answer for', { rateLimitFirst: 1 }, 503, /nothing was stored; try again/],
  ] as const)('stores no key whose account Stripe %s, so every stored key is pinned', async (_, options, status, error) => {
    const mock = new StripeMock(options);
    await expect(prepareStripeCandidate({ fetch: mock.fetch })(mock.secret, undefined)).rejects.toMatchObject({ status, message: expect.stringMatching(error) });
  });

  it.each([
    ['live', 'refused', 'rk_live_51Gone0000000000', 409],
    ['test', 'free', 'rk_test_51Gone0000000000', null],
  ] as const)('holds a %s checkout Stripe no longer has: nothing lands, it is not asked again, and its reference is %s', async (_, __, secretKey, refusal) => {
    const mock = new StripeMock({ secretKey });
    w = await world(mock);
    await w.bind();
    const { checkoutId } = await w.checkout();
    await w.sweep();
    mock.forget(checkoutId);
    expect(await w.sweep()).toMatchObject({ checked: 1, missing: 1, failed: [{ said: expect.stringMatching(/no longer has the payment for 'order-17'/) }] });
    const asked = mock.requests.length;
    expect(await w.sweep()).toMatchObject({ checked: 0, missing: 1, failed: [] });
    expect(mock.requests).toHaveLength(asked);
    expect(w.landed.filter((c) => c.checkoutId === checkoutId).map((c) => c.status)).toEqual(['open']);
    const again = w.checkout();
    if (refusal) await expect(again).rejects.toMatchObject({ status: refusal, message: expect.stringMatching(/no longer has.*stays refused/) });
    else expect((await again).checkoutId).not.toBe(checkoutId);
  });

  it('runs each of two accounts connected to one app on its own key (#3211)', async () => {
    const a = new StripeMock({ secretKey: 'rk_live_51First000000000', accountId: 'acct_1First' });
    const b = new StripeMock({ secretKey: 'rk_live_51Second00000000', accountId: 'acct_1Second' });
    w = await world(a, { fetch: accounts(a, b), keyed: true });
    b.useClock(() => w!.clock.ms);
    await w.bind();
    const second = await w.addAccount(b);
    // With two live Stripe connections, a read that names no account throws: each opens by its own.
    const first = await w.checkout();
    const other = await second.checkout();
    expect([...a.sessions.keys()]).toEqual([first.checkoutId]);
    expect([...b.sessions.keys()]).toEqual([other.checkoutId]);
    expect([a.endpoints.length, b.endpoints.length]).toEqual([1, 1]);
    expect(await w.deliver(a.pay(first.checkoutId))).toMatchObject({ accepted: true, result: { checkoutId: first.checkoutId, landed: true } });
    expect(await w.sweep()).toMatchObject({ failed: [] });
    expect(await second.sweep()).toMatchObject({ checked: 1, failed: [] });
    expect((await w.probe()).accountRef).toBe('acct_1First:live');
    expect((await second.probe()).accountRef).toBe('acct_1Second:live');
  });

  it('reads none of what another account wrote with a key that reached the connection past the replacement check', async () => {
    const before = new StripeMock({ secretKey: 'rk_live_51Before00000000', accountId: 'acct_1Old' });
    const after = new StripeMock({ secretKey: 'rk_live_51After000000000', accountId: 'acct_1New' });
    w = await world(before, { fetch: accounts(before, after) });
    after.useClock(() => w!.clock.ms);
    await w.bind();
    const open = await w.checkout();
    // Stored with no account, as only a write past the platform's preparation can: the connector asks Stripe.
    await w.overwriteKey({ secretKey: after.secretKey });

    expect(await w.sweep()).toMatchObject({ webhook: 'registered', missing: 0, failed: [{ said: expect.stringMatching(/'order-17'.*does not reach; it is not read/) }] });
    expect(after.requests.filter((r) => r.includes(open.checkoutId))).toEqual([]);
    expect(after.endpoints).toHaveLength(1);
    // The old account's endpoint is refused before anything is read; the reference is not charged again.
    expect(await w.deliver(before.pay(open.checkoutId))).toEqual({ accepted: false, reason: 'token mismatch' });
    await expect(w.checkout()).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/acct_1Old:live.*acct_1New:live/) });
  });
});
