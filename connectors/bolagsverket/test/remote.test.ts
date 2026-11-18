import { describe, expect, it } from 'vitest';
import { CONNECTOR_PROBE_PATH } from '@substrat-run/contracts';
import { fetchLikeOf } from '@substrat-run/kernel';
import { bolagsverketCallConfig, bolagsverketEgressHosts, serveBolagsverketCall } from '../src/remote.js';
import { API_BASE, CREDENTIAL, TOKEN, TOKEN_URL, fakeFetch } from './fixture.js';

/** The script's serving half (docs/rfc/connector-scripts.md). The transport is the control plane's workerd suite. */
const CONFIG = bolagsverketCallConfig({ environment: 'test', tokenUrl: TOKEN_URL, apiBase: API_BASE });
const candidate = { role: 'probe-candidate', provider: 'bolagsverket', secret: CREDENTIAL, config: CONFIG };
const serve = (body: unknown, fake = fakeFetch([{ status: 200, body: '' }], { status: 200, body: { ...TOKEN, scope: 'vardefulla-datamangder:read' } })) =>
  serveBolagsverketCall(CONNECTOR_PROBE_PATH, 'POST', body, fetchLikeOf(fake.fetch));

describe('the Bolagsverket connector script', () => {
  it('probes a candidate, reporting each provider call as a use and writing no state', async () => {
    const answer = await serve(candidate);
    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({ ok: true, result: { ok: true, refused: false }, state: [] });
    expect((answer.body as { uses: unknown[] }).uses).toEqual([
      { ok: true, status: 200, durationMs: expect.any(Number) },
      { ok: true, status: 200, durationMs: expect.any(Number) },
    ]);
    expect(JSON.stringify(answer.body)).not.toContain(CREDENTIAL.clientSecret);
  });

  it.each([
    ['a malformed call', { role: 'probe-candidate' }, /not a connector call/],
    ['a vertical-defined provider', { ...candidate, provider: 'acme.docbox' }, /not a connector call/],
    ['another first-party provider', { ...candidate, provider: 'fortnox' }, /serves bolagsverket, not fortnox/],
    ['an unknown configuration key', { ...candidate, config: { ...CONFIG, region: 'eu' } }, /unknown Bolagsverket configuration: region/],
    ['an unknown environment', { ...candidate, config: { environment: 'staging' } }, /unknown Bolagsverket environment/],
  ])('refuses %s as a 400, never as a refused credential, and calls nothing', async (_, body, error) => {
    const fake = fakeFetch([]);
    const answer = await serve(body, fake);
    expect(answer).toEqual({ status: 400, body: { error: expect.stringMatching(error) } });
    expect(fake.calls).toEqual([]);
  });

  it('serves the connection-level roles only, on the probe path only', async () => {
    const connection = { id: '01J00000000000000000000001', tenantId: '01J00000000000000000000000', vertical: 'meridian', provider: 'bolagsverket', externalAccountRef: null, expiresAt: null, secret: CREDENTIAL };
    const bind = { role: 'bind', provider: 'bolagsverket', connection, scopeId: '01J00000000000000000000002', options: {} };
    expect(await serve(bind)).toEqual({ status: 400, body: { error: expect.stringMatching(/bind is not served/) } });
    expect((await serveBolagsverketCall('/internal/connector-call', 'POST', candidate, fetchLikeOf(fakeFetch([]).fetch))).status).toBe(404);
    expect((await serveBolagsverketCall(CONNECTOR_PROBE_PATH, 'GET', null, fetchLikeOf(fakeFetch([]).fetch))).status).toBe(405);
  });

  it('names the token and API hosts of the environment, or of the overrides, as its egress', () => {
    expect(bolagsverketEgressHosts({})).toEqual(['portal.api.bolagsverket.se', 'gw.api.bolagsverket.se']);
    expect(bolagsverketEgressHosts({ environment: 'test' })).toEqual(['portal-accept2.api.bolagsverket.se', 'gw-accept2.api.bolagsverket.se']);
    expect(bolagsverketEgressHosts({ tokenUrl: TOKEN_URL, apiBase: API_BASE })).toEqual(['token.invalid', 'api.invalid']);
  });
});
