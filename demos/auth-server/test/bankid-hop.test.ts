import { describe, expect, it } from 'vitest';
import { BANKID_ROOT_CA } from '../src/bankid.js';
import { BankIdHopError, hopBankIdTransport } from '../src/bankid-transport-hop.js';

/**
 * The hosted BankID transport (docs/rfc/mtls-hop.md): one RP call becomes one call to the
 * platform's sign-in relay, carrying the certificate, and BankID's answer comes back in the
 * `{ status, body }` every other transport returns — so `bankid.ts` and the plugin cannot tell
 * which one they were handed. The relay's own half is apps/social-relay/test/mtls.test.ts.
 */

const hop = { origin: 'https://relay.example.test', clientId: 'install-1', clientSecret: 's3cret:+/' };
const cfg = { environment: 'test' as const, clientCert: 'CERT', clientKey: 'KEY' };

function relay(status: number, answer: unknown) {
  const calls: { url: string; init: { headers: Record<string, string>; body: string } }[] = [];
  const fetchImpl = async (url: string, init: { headers: Record<string, string>; body: string }) => {
    calls.push({ url, init });
    return { ok: status >= 200 && status < 300, status, json: async () => answer };
  };
  return { calls, fetchImpl };
}

describe('the hop transport', () => {
  it("sends the RP call, the install's certificate and BankID's root to the relay, and returns BankID's answer", async () => {
    const r = relay(200, { status: 200, body: { orderRef: 'o-1' }, stages: [] });
    const answer = await hopBankIdTransport(hop, cfg, r.fetchImpl)('https://appapi2.test.bankid.com/rp/v6.0/auth', { endUserIp: '203.0.113.7' });

    expect(answer).toEqual({ status: 200, body: { orderRef: 'o-1' } });
    expect(r.calls).toHaveLength(1);
    const { url, init } = r.calls[0]!;
    // The relay is told the environment and the path; it chooses BankID's host itself.
    expect(url).toBe('https://relay.example.test/mtls/bankid/test/rp/v6.0/auth');
    expect(init.headers.authorization).toBe(`Basic ${btoa('install-1:s3cret%3A%2B%2F')}`);
    expect(JSON.parse(String(init.body))).toEqual({
      certPem: 'CERT',
      keyPem: 'KEY',
      caPem: BANKID_ROOT_CA.test,
      body: { endUserIp: '203.0.113.7' },
    });
  });

  it('turns a relay refusal into an error naming its stage', async () => {
    const r = relay(502, { status: 502, stage: 'tls.handshake', detail: 'tls: invalid peer certificate: UnknownIssuer', stages: [{ stage: 'tls.config', ms: 2 }] });
    const failure = await hopBankIdTransport(hop, cfg, r.fetchImpl)('https://appapi2.test.bankid.com/rp/v6.0/collect', {}).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(BankIdHopError);
    expect(failure).toMatchObject({ stage: 'tls.handshake', message: 'tls: invalid peer certificate: UnknownIssuer', stages: [{ stage: 'tls.config', ms: 2 }] });
  });
});
