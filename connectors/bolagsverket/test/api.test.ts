import { describe, expect, it } from 'vitest';
import { BolagsverketApi } from '../src/api.js';
import { BolagsverketError } from '../src/errors.js';
import { organisationValidation } from '../src/organisation.js';
import { RATE_LIMIT_REQUESTS, RATE_LIMIT_WINDOW_MS } from '../src/throttle.js';
import { ACTIVE, API_BASE, BANKRUPT, CREDENTIAL, DEREGISTERED, TOKEN, TOKEN_URL, fakeFetch, manualTime, type Reply } from './fixture.js';

function client(api: Reply[], token?: Reply) {
  const time = manualTime();
  const fake = fakeFetch(api, token);
  return { ...fake, ...time, api: new BolagsverketApi(CREDENTIAL, fake.fetch, time.options) };
}

async function failure(p: Promise<unknown>): Promise<BolagsverketError> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(BolagsverketError);
  return err as BolagsverketError;
}

describe('validateOrganisation', () => {
  it('asks with the canonical number and normalises the record', async () => {
    const { api, calls } = client([{ status: 200, body: ACTIVE }]);
    const result = await api.validateOrganisation('16556000-0001');

    expect(result).toEqual({
      exists: true,
      orgnr: '5560000001',
      name: 'Exempelbolaget Ö AB',
      legalForm: { code: '49', label: 'Övriga aktiebolag' },
      status: 'active',
      statusDetail: null,
      address: { street: 'Exempelgatan 1', postalCode: '11122', city: 'STOCKHOLM', country: null },
      sni: [{ code: '62010', label: 'Dataprogrammering' }],
      registeredAt: '1999-04-01',
      source: { provider: 'bolagsverket', environment: 'prod' },
      fetchedAt: '2026-11-04T09:00:00.000Z',
    });
    expect(organisationValidation.parse(result)).toEqual(result);

    const [mint, lookup] = calls;
    expect(mint!.url).toBe(TOKEN_URL);
    expect(String(mint!.init?.body)).toBe(
      'grant_type=client_credentials&client_id=placeholder-client&client_secret=placeholder-secret' +
        '&scope=vardefulla-datamangder%3Aread%20vardefulla-datamangder%3Aping',
    );
    expect(lookup!.url).toBe(`${API_BASE}/organisationer`);
    expect(lookup!.init).toMatchObject({
      method: 'POST',
      headers: { Authorization: 'Bearer placeholder-token' },
      body: JSON.stringify({ identitetsbeteckning: '5560000001' }),
    });
  });

  it.each([
    ['deregistered', DEREGISTERED, 'Fusion'],
    ['bankruptcy', BANKRUPT, 'Konkurs inledd'],
  ])('reads a %s entry', async (status, body, statusDetail) => {
    const { api } = client([{ status: 200, body }]);
    expect(await api.validateOrganisation('5560000001')).toMatchObject({ exists: true, status, statusDetail });
  });

  const procedures = (list: unknown[]) => ({
    pagandeAvvecklingsEllerOmstruktureringsforfarande: { pagandeAvvecklingsEllerOmstruktureringsforfarandeLista: list },
  });
  it.each([
    ['an empty deregistration block as active', { avregistreradOrganisation: { avregistreringsdatum: null } }, 'active', null],
    [
      'a bankruptcy second in the procedure list',
      procedures([{ kod: 'RE', klartext: 'Företagsrekonstruktion inledd' }, { kod: 'KK', klartext: 'Konkurs inledd' }]),
      'bankruptcy',
      'Konkurs inledd',
    ],
    ['a procedure entry with no code and no text as no status', procedures([{ kod: null, klartext: null }]), 'active', null],
  ])('reads %s', async (_, patch, status, statusDetail) => {
    const body = { organisationer: [{ ...ACTIVE.organisationer[0], ...patch }] };
    const { api } = client([{ status: 200, body }]);
    expect(await api.validateOrganisation('5560000001')).toMatchObject({ exists: true, status, statusDetail });
  });

  it('reads a 403 as refused', async () => {
    const { api } = client([{ status: 403, body: { message: 'Forbidden' } }]);
    expect(await failure(api.validateOrganisation('5560000001'))).toMatchObject({ code: 'refused', status: 403 });
  });

  it.each([
    ['a 404', { status: 404, body: { message: 'Not found' } }],
    ['an empty list', { status: 200, body: { organisationer: [] } }],
    ['an entry for another number', { status: 200, body: { organisationer: [{ organisationsidentitet: { identitetsbeteckning: '7160000001' } }] } }],
  ])('answers exists: false on %s', async (_, reply) => {
    const { api } = client([reply]);
    expect(await api.validateOrganisation('5560000001')).toEqual({
      exists: false,
      orgnr: '5560000001',
      source: { provider: 'bolagsverket', environment: 'prod' },
      fetchedAt: '2026-11-04T09:00:00.000Z',
    });
  });

  it('refuses an invalid number without a single request', async () => {
    const { api, calls } = client([]);
    const err = await failure(api.validateOrganisation('811218-9876'));
    expect(err).toMatchObject({ code: 'invalid_orgnr', reason: 'personnummer' });
    expect(calls).toEqual([]);
  });

  it.each([
    ['a 5xx', { status: 503, body: 'Service Unavailable' }],
    ['a 200 that is not JSON', { status: 200, body: '<html>gateway</html>' }],
  ])('maps %s to upstream', async (_, reply) => {
    const { api } = client([reply]);
    const err = await failure(api.validateOrganisation('5560000001'));
    expect(err.code).toBe('upstream');
    expect(err.refused).toBe(false);
  });
});

describe('token', () => {
  it('is minted once, reused, and re-minted near expiry', async () => {
    const ok = { status: 200, body: { organisationer: [] } };
    const { api, calls, advance } = client([ok, ok, ok]);
    await api.validateOrganisation('5560000001');
    await api.validateOrganisation('5560000001');
    expect(calls.filter((c) => c.url === TOKEN_URL)).toHaveLength(1);

    advance(3600_000 - 30_000);
    await api.validateOrganisation('5560000001');
    expect(calls.filter((c) => c.url === TOKEN_URL)).toHaveLength(2);
  });

  it('re-mints once on a 401, and a second 401 is refused', async () => {
    const recovered = client([{ status: 401, body: '' }, { status: 200, body: ACTIVE }]);
    expect(await recovered.api.validateOrganisation('5560000001')).toMatchObject({ exists: true });
    expect(recovered.calls.filter((c) => c.url === TOKEN_URL)).toHaveLength(2);

    const refused = client([{ status: 401, body: '' }, { status: 401, body: '{"message":"Invalid token"}' }]);
    const err = await failure(refused.api.validateOrganisation('5560000001'));
    expect(err).toMatchObject({ code: 'refused', status: 401, message: expect.stringMatching(/Invalid token/) });
  });

  it('is minted once for concurrent callers', async () => {
    const ok = { status: 200, body: { organisationer: [] } };
    const { api, calls } = client([ok, ok]);
    await Promise.all([api.validateOrganisation('5560000001'), api.validateOrganisation('5560000001')]);
    expect(calls.filter((c) => c.url === TOKEN_URL)).toHaveLength(1);
  });

  it('reads a token endpoint that does not answer as upstream', async () => {
    const time = manualTime();
    const down = new BolagsverketApi(CREDENTIAL, async () => {
      throw new Error('getaddrinfo ENOTFOUND');
    }, time.options);
    expect(await failure(down.ping())).toMatchObject({ code: 'upstream', message: expect.stringMatching(/ENOTFOUND/) });
  });

  it('reads expires_in sent as a string', async () => {
    const ok = { status: 200, body: { organisationer: [] } };
    const { api, calls, advance } = client([ok, ok], { status: 200, body: { ...TOKEN, expires_in: '3600' } });
    await api.validateOrganisation('5560000001');
    // Past the 300 s fallback lifetime, inside the stated hour: still the first token.
    advance(600_000);
    await api.validateOrganisation('5560000001');
    expect(calls.filter((c) => c.url === TOKEN_URL)).toHaveLength(1);
  });

  it('carries no response body on a token answer it cannot parse', async () => {
    const { api } = client([], { status: 200, body: { access_token: 'placeholder-token', expires_in: 'soon' } });
    const err = await failure(api.ping());
    expect(err).toMatchObject({ code: 'upstream', body: '' });
  });

  it('reads an invalid_client mint as refused', async () => {
    const { api, apiCalls } = client([], { status: 400, body: { error: 'invalid_client', error_description: 'Bad client' } });
    const err = await failure(api.ping());
    expect(err).toMatchObject({ code: 'refused', status: 400, message: expect.stringMatching(/Bad client/) });
    expect(apiCalls()).toEqual([]);
  });
});

describe('rate limit', () => {
  it('defaults to the provider limit of 60 requests a minute', () => {
    expect([RATE_LIMIT_REQUESTS, RATE_LIMIT_WINDOW_MS]).toEqual([60, 60_000]);
  });

  it(`holds request ${RATE_LIMIT_REQUESTS + 1} until the first leaves the window`, async () => {
    const replies = Array.from({ length: RATE_LIMIT_REQUESTS + 1 }, () => ({ status: 200, body: '' }));
    const { api, slept, advance } = client(replies);
    await api.ping();
    advance(1_000);
    for (let i = 1; i < RATE_LIMIT_REQUESTS; i += 1) await api.ping();
    expect(slept).toEqual([]);
    await api.ping();
    expect(slept).toEqual([RATE_LIMIT_WINDOW_MS - 1_000]);
  });

  it('waits as Retry-After says, and gives up with the wait once retries run out', async () => {
    const limited = { status: 429, body: '', headers: { 'Retry-After': '7' } };
    const recovered = client([limited, { status: 200, body: '' }]);
    await recovered.api.ping();
    expect(recovered.slept).toEqual([7_000]);

    const time = manualTime();
    const fake = fakeFetch([limited, limited]);
    const probe = new BolagsverketApi(CREDENTIAL, fake.fetch, { ...time.options, maxRateLimitRetries: 1 });
    const err = await failure(probe.ping());
    expect(err).toMatchObject({ code: 'rate_limited', retryAfterSeconds: 7 });
  });

  it('caps a long Retry-After at two windows', async () => {
    const { api, slept } = client([{ status: 429, body: '', headers: { 'Retry-After': '3600' } }, { status: 200, body: '' }]);
    await api.ping();
    expect(slept).toEqual([120_000]);
  });
});
