import { describe, expect, it } from 'vitest';
import { stripeSignatureHeader, verifyStripeSignature } from '../src/index.js';

/** Stripe's webhook signature: over the exact body, under the endpoint's secret, inside the tolerance. */
const SECRET = 'whsec_test_secret';
const BODY = '{"id":"evt_1","type":"checkout.session.completed"}';
const AT = 1_763_200_000;

describe('stripe webhook signature', () => {
  it('accepts a signature over the exact body, inside the tolerance either way', async () => {
    const header = await stripeSignatureHeader(SECRET, BODY, AT);
    expect(await verifyStripeSignature(SECRET, BODY, header, AT + 299)).toBe(true);
    expect(await verifyStripeSignature(SECRET, BODY, header, AT - 299)).toBe(true);
  });

  it('accepts any one matching v1 while a secret is being rolled', async () => {
    const good = (await stripeSignatureHeader(SECRET, BODY, AT)).split('v1=')[1];
    expect(await verifyStripeSignature(SECRET, BODY, `t=${AT},v1=${'0'.repeat(64)},v1=${good}`, AT)).toBe(true);
  });

  it.each([
    ['a changed body', async () => [SECRET, `${BODY} `, await stripeSignatureHeader(SECRET, BODY, AT), AT]],
    ['another secret', async () => [SECRET, BODY, await stripeSignatureHeader('whsec_other', BODY, AT), AT]],
    ['a stale timestamp', async () => [SECRET, BODY, await stripeSignatureHeader(SECRET, BODY, AT), AT + 301]],
    ['a v0 signature only', async () => [SECRET, BODY, (await stripeSignatureHeader(SECRET, BODY, AT)).replace('v1=', 'v0='), AT]],
    ['no header', async () => [SECRET, BODY, null, AT]],
    ['an empty secret', async () => ['', BODY, await stripeSignatureHeader(SECRET, BODY, AT), AT]],
  ] as [string, () => Promise<[string, string, string | null, number]>][])('refuses %s', async (_, args) => {
    const [secret, body, header, now] = await args();
    expect(await verifyStripeSignature(secret, body, header, now)).toBe(false);
  });
});
