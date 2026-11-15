import { describe, expect, it } from 'vitest';
import { probeStripeSecret } from '../src/index.js';
import { StripeMock, type StripeMockOptions } from '../src/mock.js';

/**
 * The connect-time probe: a good key names the account and says whether money is real, a
 * restricted key is judged by what it may do rather than by whether it can read the account, and
 * each way a paste can be wrong is told apart — without the key ever appearing in the answer.
 */
const probe = (options: StripeMockOptions, secret?: Record<string, string>) => {
  const mock = new StripeMock(options);
  return probeStripeSecret(secret ?? mock.secret, { fetch: mock.fetch });
};

describe('stripe probe', () => {
  it('names the account, says it is test mode, and that outcomes arrive by webhook', async () => {
    expect(await probe({})).toEqual({
      ok: true,
      refused: false,
      accountRef: null,
      accountLabel: 'Acme Mugs',
      facts: [
        { label: 'Account', value: 'acct_1MockAccount' },
        { label: 'Mode', value: 'Test — no real money moves' },
        { label: 'Country', value: 'SE' },
        { label: 'Default currency', value: 'SEK' },
        { label: 'Webhooks', value: expect.stringMatching(/within seconds/) },
      ],
      error: null,
    });
  });

  it('says live mode for a live key', async () => {
    const answer = await probe({ secretKey: 'rk_live_51MockKey000000000000' });
    expect(answer.facts).toContainEqual({ label: 'Mode', value: 'Live — real payments' });
  });

  it('accepts a restricted key that may not read the account, naming the account from Stripe’s refusal', async () => {
    const answer = await probe({ accountReadable: false });
    expect(answer).toMatchObject({ ok: true, accountLabel: 'acct_1MockAccount' });
    expect(answer.facts).toContainEqual({ label: 'Account name', value: expect.stringMatching(/not readable/) });
  });

  it('accepts a key that may not register a webhook, and says outcomes will be polled', async () => {
    const answer = await probe({ webhooksAllowed: false });
    expect(answer.ok).toBe(true);
    expect(answer.facts).toContainEqual({ label: 'Webhooks', value: expect.stringMatching(/polling.*Webhook Endpoints: Write/) });
  });

  it.each([
    ['a key Stripe does not accept', {}, { secretKey: 'rk_test_51Wrong000000000000' }, true, /mistyped, rolled or deleted/],
    ['a key that may not open a checkout', { checkoutAllowed: false }, undefined, true, /Checkout Sessions: Write/],
    ['a publishable key', {}, { secretKey: 'pk_test_51Mock000000000000' }, true, /publishable key/],
    ['an empty paste', {}, { secretKey: '' }, true, /secret or restricted key/],
  ] as [string, StripeMockOptions, Record<string, string> | undefined, boolean, RegExp][])('fails on %s', async (_, options, secret, refused, error) => {
    const answer = await probe(options, secret);
    expect(answer).toMatchObject({ ok: false, refused, accountLabel: null, error: expect.stringMatching(error) });
    expect(JSON.stringify(answer)).not.toMatch(/51(Mock|Wrong)[0-9]{6}/);
  });
});
