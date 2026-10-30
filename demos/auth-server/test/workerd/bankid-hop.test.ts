import { env, runInDurableObject } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ulid } from '@substrat-run/kernel';
import { SOCIAL_RELAY_CONFIG_KEY } from '@substrat-run/contracts';
import { putBankIdConfig } from '../../src/bankid.js';
import type { AuthServerDO } from '../../src/auth-do.js';

afterEach(() => { vi.restoreAllMocks(); });

describe('BankID through the platform relay, in the deployed Durable Object', () => {
  it('starts no order before a connection test has passed', async () => {
    const egress = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      throw new Error(`unexpected egress: ${String(input)}`);
    });
    const scope = ulid();
    const stub = env.AUTH.get(env.AUTH.idFromName(scope));
    // A hosted install the platform has registered at its relay: BankID goes through the hop.
    const issuer = 'https://id.substrat.net/github';
    const delivery = {
      clientId: 'relay-client-1',
      clientSecret: 'secret-1',
      providers: [{ id: 'github', label: 'GitHub', issuer, endpoints: { issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, userinfo_endpoint: `${issuer}/userinfo` } }],
    };
    await runInDurableObject(stub, (instance) =>
      (instance as unknown as AuthServerDO).provisionInstance({ tenantId: ulid(), scopeId: scope, slug: 'acme-auth', name: 'Acme Auth' }, [
        { key: SOCIAL_RELAY_CONFIG_KEY, value: JSON.stringify(delivery) },
      ]),
    );
    await runInDurableObject(stub, (_instance, state) => {
      putBankIdConfig(state.storage.sql, { environment: 'test', clientCert: 'CERT', clientKey: 'KEY', allowSignup: true, disabled: false });
    });

    const res = await stub.fetch(new Request('https://auth-server.test/api/auth/bankid/start', {
      method: 'POST', headers: { origin: 'https://auth-server.test', 'content-type': 'application/json' }, body: '{}',
    }));
    expect(res.status).toBe(404);
    expect(egress).not.toHaveBeenCalled();
  });
});
