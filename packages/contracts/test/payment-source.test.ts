import { describe, it, expect } from 'vitest';
import { connectionCheckoutRequest, paymentChange } from '../src/index.js';

/**
 * The payment-source shapes (#3189): what a vertical parses of a checkout, whichever provider took
 * it, and what it may ask the checkout relay for.
 */
const checkout = {
  record: 'checkout',
  change: 'upsert',
  connectionId: 'c1',
  checkoutId: 'cs_test_1',
  reference: 'order-17',
  status: 'paid',
  providerStatus: 'complete/paid',
  live: false,
  currency: 'SEK',
  amount: '249.00',
  paidAt: '2026-11-15T10:00:00Z',
  customerEmail: null,
  createdAt: null,
  observedAt: '2026-11-15T10:00:01Z',
};

const request = {
  tenantId: '01JZ0000000000000000000002',
  scopeId: '01JZ0000000000000000000003',
  provider: 'stripe',
  reference: 'order-17',
  currency: 'SEK',
  lines: [{ name: 'Mug', quantity: 2, unitAmount: '124.50' }],
  successUrl: 'https://shop.example.com/paid',
  cancelUrl: 'https://shop.example.com/cart',
};

describe('payment-source shapes (#3189)', () => {
  it('accepts a checkout and normalises its instants', () => {
    expect(paymentChange.parse(checkout).paidAt).toBe('2026-11-15T10:00:00.000Z');
  });

  it.each([
    [{ amount: 249 }, 'an amount as a number'],
    [{ status: 'complete' }, "a provider's own status word"],
    [{ live: 'false' }, 'live as a string'],
    [{ record: 'refund' }, 'a record kind nobody declared'],
  ] as [Record<string, unknown>, string][])('refuses the checkout %j — %s', (over) => {
    expect(paymentChange.safeParse({ ...checkout, ...over }).success).toBe(false);
  });

  it('accepts a checkout request', () => {
    expect(connectionCheckoutRequest.parse(request).lines[0]!.unitAmount).toBe('124.50');
  });

  it.each([
    [{ lines: [] }, 'no line'],
    [{ lines: [{ name: 'Mug', quantity: 1, unitAmount: '-1.00' }] }, 'a negative price'],
    [{ lines: [{ name: 'Mug', quantity: 0, unitAmount: '1.00' }] }, 'a zero quantity'],
    [{ successUrl: 'javascript:alert(1)' }, 'a return URL that is not http(s)'],
    [{ expiresInMinutes: 10 }, 'an expiry shorter than the provider takes'],
    [{ amount: '1.00' }, 'a field the relay does not take'],
  ] as [Record<string, unknown>, string][])('refuses the request %j — %s', (over) => {
    expect(connectionCheckoutRequest.safeParse({ ...request, ...over }).success).toBe(false);
  });
});
