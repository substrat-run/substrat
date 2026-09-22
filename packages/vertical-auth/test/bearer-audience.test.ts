import { beforeAll, describe, expect, it, vi } from 'vitest';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import { SHARED_ISSUER_CONFIG_KEY, mcpResourceOf } from '@substrat-run/contracts';
import { oidcRpAuthProvider, type OidcRpConfig } from '../src/oidc-rp-provider.js';
import { AUTH_CONFIG_KEY, instanceAuthFor } from '../src/instance-auth.js';

/**
 * A vertical's bearer fallback on a SHARED issuer (#1683).
 *
 * Every client of a team auth-server gets tokens signed by one JWKS with one `iss`. So a
 * bearer that verifies says who signed it and nothing about whom it is for, and before this
 * a vertical accepted any of them on every route: another client's `id_token`, another
 * vertical's MCP access token. The dashboard now marks such an issuer
 * (`SHARED_ISSUER_CONFIG_KEY`) and the relying party admits only the app's OWN tokens.
 *
 * Each accepted shape has a refused twin that differs in the one claim the rule reads, and
 * the external-issuer path — no marker — is pinned as unchanged, because those installs
 * have a knob of their own (`audience`) and nobody asked them to change.
 *
 * The real-token half, against Better Auth itself, is in
 * `demos/auth-server/test/mcp-resources.test.ts`.
 */

const ISSUER = 'https://team-auth.test';
const APP_A = 'https://desk-a.example';
const APP_B = 'https://desk-b.example';
const RESOURCE_A = mcpResourceOf(APP_A);
const RESOURCE_B = mcpResourceOf(APP_B);
const USERINFO = `${ISSUER}/oauth2/userinfo`;

const base: Omit<OidcRpConfig, 'clientId'> = {
  issuer: ISSUER,
  clientSecret: 'client-secret',
  sessionSecret: 'session-secret-000000000000000000000001',
};
const teamA: OidcRpConfig = { ...base, clientId: 'desk-a', sharedIssuer: true };
const teamB: OidcRpConfig = { ...base, clientId: 'desk-b', sharedIssuer: true };

let privateKey: CryptoKey;

beforeAll(async () => {
  const pair = await generateKeyPair('RS256');
  privateKey = pair.privateKey as CryptoKey;
  const jwks = { keys: [{ ...(await exportJWK(pair.publicKey)), alg: 'RS256', kid: 'k1' }] };
  vi.stubGlobal('fetch', (async (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url === `${ISSUER}/.well-known/openid-configuration`) return Response.json({ issuer: ISSUER, jwks_uri: `${ISSUER}/jwks` });
    if (url === `${ISSUER}/jwks`) return Response.json(jwks);
    throw new Error(`unexpected fetch in test: ${url}`);
  }) as typeof fetch);
});

/** A token this issuer signed, with exactly the claims given (plus iss/sub/iat/exp). */
async function token(claims: Record<string, unknown>, issuer = ISSUER): Promise<string> {
  return new SignJWT({ email: 'pat@acme.test', ...claims })
    .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
    .setIssuer(issuer)
    .setSubject('user-1')
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(privateKey);
}

const bearer = (t: string, extra: Record<string, string> = {}) => new Headers({ authorization: `Bearer ${t}`, ...extra });

/** Resolve `t` at `cfg` as a request to `url` — the REST route's view of the caller. */
const at = async (cfg: OidcRpConfig, t: string, url = `${APP_A}/api/tickets`) =>
  (await oidcRpAuthProvider(cfg).resolve(bearer(t), url))?.sub ?? null;

describe('on a shared issuer, a bearer must be this app’s own', () => {
  it("admits its own id_token (aud = its client id, no azp) — and refuses another client's", async () => {
    expect(await at(teamA, await token({ aud: 'desk-a' }))).toBe('user-1');
    expect(await at(teamA, await token({ aud: 'desk-b' }))).toBeNull();
    // An anonymous dynamic registrant's id_token is the same shape as desk-b's.
    expect(await at(teamA, await token({ aud: 'dcr-client-9f3' }))).toBeNull();
  });

  it('admits a token issued to its client (azp / client_id = its id) whatever the aud — and refuses one issued to another', async () => {
    expect(await at(teamA, await token({ aud: USERINFO, azp: 'desk-a', client_id: 'desk-a' }))).toBe('user-1');
    expect(await at(teamA, await token({ aud: USERINFO, client_id: 'desk-a' }))).toBe('user-1');
    expect(await at(teamA, await token({ aud: USERINFO, azp: 'desk-b', client_id: 'desk-b' }))).toBeNull();
  });

  it('admits an access token for its own MCP resource from any client — and refuses one for another vertical', async () => {
    // The shape Better Auth mints for an MCP client: the resource plus userinfo, azp = the client.
    const forA = await token({ aud: [RESOURCE_A, USERINFO], azp: 'mcp-client', client_id: 'mcp-client' });
    const forB = await token({ aud: [RESOURCE_B, USERINFO], azp: 'mcp-client', client_id: 'mcp-client' });
    expect(await at(teamA, forA)).toBe('user-1');
    expect(await at(teamA, forB)).toBeNull();
    // Our resource is where the request landed: the same token for A is not ours at B's origin.
    expect(await at(teamA, forA, `${APP_B}/api/tickets`)).toBeNull();
  });

  it('reads the origin from Host when the caller passes no URL (every caller before #1683)', async () => {
    const forA = await token({ aud: [RESOURCE_A, USERINFO], azp: 'mcp-client' });
    const forB = await token({ aud: [RESOURCE_B, USERINFO], azp: 'mcp-client' });
    const resolve = (t: string, host?: string) => oidcRpAuthProvider(teamA).resolve(bearer(t, host ? { host } : {}));
    expect((await resolve(forA, 'desk-a.example'))?.sub).toBe('user-1');
    expect((await resolve(forA, 'DESK-A.example'))?.sub).toBe('user-1');
    expect(await resolve(forB, 'desk-a.example')).toBeNull();
    // No Host: nothing names our resource.
    expect(await resolve(forA)).toBeNull();
    // The resource half never widens the client half: our id_token needs no origin at all.
    expect((await resolve(await token({ aud: 'desk-a' })))?.sub).toBe('user-1');
  });

  it('refuses a token that names nobody: no aud and no authorized party', async () => {
    expect(await at(teamA, await token({}))).toBeNull();
  });

  it('refuses our id in a multi-valued aud unless azp says the token was handed to us (OIDC Core 3.1.3.7)', async () => {
    expect(await at(teamA, await token({ aud: ['desk-a', 'desk-b'] }))).toBeNull();
    expect(await at(teamA, await token({ aud: ['desk-a', 'desk-b'], azp: 'desk-b' }))).toBeNull();
    expect(await at(teamA, await token({ aud: ['desk-a', 'desk-b'], azp: 'desk-a' }))).toBe('user-1');
  });

  it('refuses a present authorized party that is someone else, even with our id as the aud', async () => {
    expect(await at(teamA, await token({ aud: 'desk-a', azp: 'desk-b' }))).toBeNull();
    // Both present, disagreeing: every present one must be us.
    expect(await at(teamA, await token({ aud: 'desk-a', azp: 'desk-a', client_id: 'desk-b' }))).toBeNull();
  });

  it('keeps the signature and issuer checks it always had', async () => {
    expect(await at(teamA, await token({ aud: 'desk-a' }, 'https://elsewhere.test'))).toBeNull();
  });

  it('never lets two apps on one issuer share a verifier (the isolate cache is keyed by client)', async () => {
    const ofA = await token({ aud: 'desk-a' });
    const ofB = await token({ aud: 'desk-b' });
    expect(await at(teamA, ofA)).toBe('user-1');
    expect(await at(teamB, ofB)).toBe('user-1');
    expect(await at(teamB, ofA)).toBeNull();
    expect(await at(teamA, ofB)).toBeNull();
  });
});

describe('an external issuer — no shared-issuer marker — is exactly what it was', () => {
  const external: OidcRpConfig = { ...base, clientId: 'crm-web' };

  it('admits any token its issuer signed, as before: the operator’s knob is `audience`', async () => {
    // Deliberately pinned: tightening this would lock out installs whose own clients send
    // tokens with some other `aud`, which is not the hole #1683 is about.
    expect(await at(external, await token({ aud: 'some-other-client' }))).toBe('user-1');
    expect(await at(external, await token({}))).toBe('user-1');
  });

  it('holds a delivered audience exactly: a Supabase-shaped access token (aud "authenticated")', async () => {
    const supabase = await token({ aud: 'authenticated', role: 'authenticated', session_id: 's-1' });
    const withAudience: OidcRpConfig = { ...external, audience: 'authenticated' };
    expect(await at(withAudience, supabase)).toBe('user-1');
    expect(await at(withAudience, await token({ aud: 'anon' }))).toBeNull();
    // And a delivered audience keeps winning even where the marker is set: it is the
    // operator's explicit answer, stricter than "our own".
    const markedWithAudience: OidcRpConfig = { ...teamA, audience: 'authenticated' };
    expect(await at(markedWithAudience, supabase)).toBe('user-1');
    expect(await at(markedWithAudience, await token({ aud: 'desk-a' }))).toBeNull();
  });
});

describe('the marker, as a vertical receives it (instanceAuthFor)', () => {
  const choice = JSON.stringify({ mode: 'oidc', issuer: ISSUER, clientId: 'desk-a', clientSecret: 'cs' });
  const providerFor = async (config: Record<string, string>) =>
    (
      await instanceAuthFor({
        directory: { authWiring: async () => ({ config, sessionSecret: 'session-secret-000000000000000000000001' }) },
        scopeId: 'scope-1',
        envSpec: [],
        env: {},
      })
    ).provider();

  it("delivered 'true', another client's id_token is refused and our own admitted", async () => {
    const p = await providerFor({ [AUTH_CONFIG_KEY]: choice, [SHARED_ISSUER_CONFIG_KEY]: 'true' });
    expect(await p.resolve(bearer(await token({ aud: 'desk-b' })), `${APP_A}/api/x`)).toBeNull();
    expect((await p.resolve(bearer(await token({ aud: 'desk-a' })), `${APP_A}/api/x`))?.sub).toBe('user-1');
  });

  it("absent or cleared (''), the bearer path is unchanged", async () => {
    for (const config of [{ [AUTH_CONFIG_KEY]: choice }, { [AUTH_CONFIG_KEY]: choice, [SHARED_ISSUER_CONFIG_KEY]: '' }]) {
      const p = await providerFor(config);
      expect((await p.resolve(bearer(await token({ aud: 'desk-b' })), `${APP_A}/api/x`))?.sub).toBe('user-1');
    }
  });
});
