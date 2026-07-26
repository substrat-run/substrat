import { describe, it, expect } from 'vitest';
import { registerOidcClient, authConfigFor } from '../src/auth-wiring.js';

/**
 * Install-time identity wiring (vertical-auth-detach.md §2.4): dynamic client
 * registration against an issuer's discovery document, and the `substrat:auth` value a
 * choice resolves to. The fetch is injected, so these drive the real code paths —
 * discovery, RFC 7591 body/response mapping, failure surfacing — without a network.
 */

const ISSUER = 'https://auth-acme.global.substrat.test';

function issuerFetch(overrides: { registration?: () => unknown } = {}): {
  fetchImpl: typeof fetch;
  registrations: Array<Record<string, unknown>>;
} {
  const registrations: Array<Record<string, unknown>> = [];
  const fetchImpl = (async (input: unknown, init?: { body?: unknown }) => {
    const url = String(input);
    if (url === `${ISSUER}/.well-known/openid-configuration`) {
      return Response.json({ issuer: ISSUER, registration_endpoint: `${ISSUER}/api/auth/oauth2/register` });
    }
    if (url === `${ISSUER}/api/auth/oauth2/register`) {
      registrations.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      if (overrides.registration) return overrides.registration() as Response;
      return Response.json({ client_id: 'generated-id', client_secret: 'generated-secret' });
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as unknown as typeof fetch;
  return { fetchImpl, registrations };
}

describe('registerOidcClient', () => {
  it('registers at the DISCOVERED endpoint with the callback redirect and secret-post auth', async () => {
    const { fetchImpl, registrations } = issuerFetch();
    const client = await registerOidcClient(
      ISSUER,
      { appName: 'People', redirectUri: 'https://people-acme.global.substrat.test/api/auth/callback' },
      fetchImpl,
    );
    expect(client).toEqual({ clientId: 'generated-id', clientSecret: 'generated-secret' });
    expect(registrations).toEqual([
      {
        client_name: 'People',
        redirect_uris: ['https://people-acme.global.substrat.test/api/auth/callback'],
        // oidc-rp presents the secret in the token-request BODY, so the client must be
        // registered to match — a basic-auth-only client would fail every exchange.
        token_endpoint_auth_method: 'client_secret_post',
      },
    ]);
  });

  it('surfaces a refusal with the issuer named, and rejects a credential-less response', async () => {
    const refusing = issuerFetch({ registration: () => Response.json({ error: 'registration disabled' }, { status: 403 }) });
    await expect(
      registerOidcClient(ISSUER, { appName: 'X', redirectUri: 'https://x/cb' }, refusing.fetchImpl),
    ).rejects.toThrow(/registration at .* failed \(403\)/);

    const empty = issuerFetch({ registration: () => Response.json({}) });
    await expect(
      registerOidcClient(ISSUER, { appName: 'X', redirectUri: 'https://x/cb' }, empty.fetchImpl),
    ).rejects.toThrow(/no client credentials/);
  });
});

describe('authConfigFor', () => {
  it('external: passes the hand-configured issuer through verbatim', async () => {
    const cfg = await authConfigFor(
      { source: 'external', issuer: 'https://auth.example.com', clientId: 'cid', clientSecret: 'cs', audience: 'aud' },
      { appName: 'People', redirectUri: 'https://people/cb' },
    );
    expect(cfg).toEqual({ mode: 'oidc', issuer: 'https://auth.example.com', clientId: 'cid', clientSecret: 'cs', audience: 'aud' });
  });

  it('auth-server: registers the client first, then wires its minted credentials', async () => {
    const calls: Array<{ issuer: string; appName: string; redirectUri: string }> = [];
    const cfg = await authConfigFor(
      { source: 'auth-server', issuer: ISSUER },
      {
        appName: 'People',
        redirectUri: 'https://people/cb',
        registerClient: async (issuer, input) => {
          calls.push({ issuer, ...input });
          return { clientId: 'minted-id', clientSecret: 'minted-secret' };
        },
      },
    );
    expect(calls).toEqual([{ issuer: ISSUER, appName: 'People', redirectUri: 'https://people/cb' }]);
    expect(cfg).toEqual({ mode: 'oidc', issuer: ISSUER, clientId: 'minted-id', clientSecret: 'minted-secret' });
  });
});
