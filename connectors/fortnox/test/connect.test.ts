import { describe, expect, it } from 'vitest';
import { FortnoxApiError, FortnoxMock, completeFortnoxConsent } from '../src/index.js';

/**
 * The consent completion (#1220) — the exported sequence a hosted connect flow runs
 * when Fortnox's redirect comes back: exchange the code, discover the company, prove
 * the client-credentials premise. Driven against {@link FortnoxMock}, whose
 * authorization-code branch spends the code on first use exactly as Fortnox does.
 */
describe('completeFortnoxConsent', () => {
  const options = (mock: FortnoxMock) => ({
    clientId: 'client-id',
    clientSecret: 'client-secret',
    redirectUri: 'https://app.example/api/integrations/fortnox/callback',
    fetch: mock.fetch,
    oauthBase: mock.oauthBase,
    apiBase: mock.apiBase,
  });

  it('assembles the sealed-ready triple and names the company it belongs to', async () => {
    const mock = new FortnoxMock({ consentCode: 'code-1' });
    const done = await completeFortnoxConsent({ ...options(mock), code: 'code-1' });

    // The third credential value is the DISCOVERED DatabaseNumber, as a string —
    // the one value no person can type, and the whole reason the flow exists.
    expect(done.secret).toEqual({
      clientId: 'client-id',
      clientSecret: 'client-secret',
      tenantId: '123456',
    });
    expect(done.company.CompanyName).toBe('Testbolaget AB');
    expect(done.company.OrganizationNumber).toBe('556677-8899');
    // The premise is proven with a real client-credentials mint plus a scoped read —
    // two tokens total: the consent exchange's and the client-credentials one.
    expect(done.financialYears).toBe(2);
    expect(mock.mints).toHaveLength(2);
  });

  it('surfaces a spent code as Fortnox words it — the reloaded-callback-tab case', async () => {
    const mock = new FortnoxMock({ consentCode: 'code-1' });
    await completeFortnoxConsent({ ...options(mock), code: 'code-1' });
    await expect(completeFortnoxConsent({ ...options(mock), code: 'code-1' })).rejects.toThrow(
      /code spent or unknown/,
    );
  });

  it('refuses a company with no DatabaseNumber rather than keying a connection on "undefined"', async () => {
    const mock = new FortnoxMock({
      consentCode: 'code-1',
      company: { CompanyName: 'Trasig AB', OrganizationNumber: '556000-0000', DatabaseNumber: undefined as never },
    });
    await expect(completeFortnoxConsent({ ...options(mock), code: 'code-1' })).rejects.toThrow(
      /DatabaseNumber/,
    );
  });

  it('reports a refused exchange as a FortnoxApiError carrying the provider status', async () => {
    const mock = new FortnoxMock({ consentCode: 'code-1' });
    const err = await completeFortnoxConsent({ ...options(mock), code: 'wrong-code' }).catch((e) => e as unknown);
    expect(err).toBeInstanceOf(FortnoxApiError);
    expect((err as FortnoxApiError).status).toBe(400);
  });
});
