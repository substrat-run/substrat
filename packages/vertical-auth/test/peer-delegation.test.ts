import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import { AUTH_DIAGNOSTICS_KEY, type AuthCheck } from '@substrat-run/contracts/auth-diagnostics';
import { SHARED_ISSUER_CONFIG_KEY, mcpResourceOf } from '@substrat-run/contracts';
import { oidcRpAuthProvider, type OidcRpConfig } from '../src/oidc-rp-provider.js';
import { AUTH_CONFIG_KEY, instanceAuthFor } from '../src/instance-auth.js';

/**
 * The `peer` channel (#3161): a master app calls this plugin as a person signed in to the master,
 * with a token the issuer minted by a one-step exchange — `aud` this plugin's client id, `act`
 * the master's client. Only `resolveOnBehalf` admits it, and `resolve` never does; an MCP-channel
 * delegation is the mirror image and is admitted only by `resolve` at the MCP endpoint.
 */

const ISSUER = 'https://team-auth.test';
const APP = 'https://notes.example';
const RESOURCE = mcpResourceOf(APP);
const MASTER = 'todo-client';

const base: OidcRpConfig = {
  issuer: ISSUER,
  clientId: 'notes-client',
  clientSecret: 'client-secret',
  sessionSecret: 'session-secret-000000000000000000000001',
  sharedIssuer: true,
};
/** The plugin, opted in for its master on the peer channel only. */
const peer: OidcRpConfig = { ...base, delegation: { actors: [MASTER], channels: ['peer'] } };
/** Opted in on both channels: the case where each door must still refuse the other's token. */
const both: OidcRpConfig = { ...base, delegation: { actors: [MASTER], channels: ['mcp', 'peer'] } };

let privateKey: CryptoKey;
let otherKey: CryptoKey;
let checks: AuthCheck[];
const slots = globalThis as Record<symbol, unknown>;
const recorder = slots[AUTH_DIAGNOSTICS_KEY];

beforeAll(async () => {
  const pair = await generateKeyPair('RS256');
  privateKey = pair.privateKey as CryptoKey;
  otherKey = (await generateKeyPair('RS256')).privateKey as CryptoKey;
  const jwks = { keys: [{ ...(await exportJWK(pair.publicKey)), alg: 'RS256', kid: 'k1' }] };
  vi.stubGlobal('fetch', (async (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url === `${ISSUER}/.well-known/openid-configuration`) return Response.json({ issuer: ISSUER, jwks_uri: `${ISSUER}/jwks` });
    if (url === `${ISSUER}/jwks`) return Response.json(jwks);
    throw new Error(`unexpected fetch in test: ${url}`);
  }) as typeof fetch);
});
beforeEach(() => {
  checks = [];
  slots[AUTH_DIAGNOSTICS_KEY] = { record: (check: AuthCheck) => checks.push(check) };
});
afterEach(() => {
  slots[AUTH_DIAGNOSTICS_KEY] = recorder;
});

interface SignOptions {
  expiresIn?: number;
  /** `iat` in seconds from now; `null` signs none. */
  issuedAt?: number | null;
  key?: CryptoKey;
}

async function token(claims: Record<string, unknown>, opts: SignOptions = {}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const jwt = new SignJWT({ email: 'ada@acme.test', email_verified: true, name: 'Ada', ...claims })
    .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
    .setIssuer(ISSUER)
    .setSubject('ada')
    .setExpirationTime(now + (opts.expiresIn ?? 300));
  if (opts.issuedAt !== null) jwt.setIssuedAt(now + (opts.issuedAt ?? 0));
  return jwt.sign(opts.key ?? privateKey);
}

/** What the issuer's peer exchange mints for the master, to call this plugin. */
const peerClaims = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  aud: 'notes-client',
  azp: MASTER,
  client_id: MASTER,
  scope: 'notes:read notes:write',
  act: { iss: ISSUER, sub: MASTER },
  substrat_delegation: { stage: 'peer', host: 'scope-notes', actor: 'scope-todo' },
  ...over,
});
const peerToken = (over: Record<string, unknown> = {}, opts?: SignOptions) => token(peerClaims(over), opts);
const onBehalf = async (cfg: OidcRpConfig, t: string) => oidcRpAuthProvider(cfg).resolveOnBehalf(t);
const reasons = () => checks.map((c) => c.reason);

describe('resolveOnBehalf admits a peer-channel delegation, and nothing else', () => {
  it('admits the exchange shape and reads the person as a sign-in would', async () => {
    expect(await onBehalf(peer, await peerToken())).toEqual({
      sub: 'ada',
      email: 'ada@acme.test',
      emailVerified: true,
      name: 'Ada',
      expiresAt: expect.any(String),
      delegation: { actor: MASTER, scope: ['notes:read', 'notes:write'] },
    });
    expect(reasons()).toEqual(['verified']);
  });

  it('refuses without the peer opt-in: no option, an mcp-only one (the default), no shared issuer', async () => {
    const t = await peerToken();
    expect(await onBehalf(base, t)).toBeNull();
    expect(await onBehalf({ ...base, delegation: { actors: [MASTER] } }, t)).toBeNull();
    expect(await onBehalf({ ...base, delegation: { actors: [MASTER], channels: ['mcp'] } }, t)).toBeNull();
    expect(await onBehalf({ ...base, delegation: { actors: [MASTER], channels: [] } }, t)).toBeNull();
    expect(await onBehalf({ ...peer, sharedIssuer: false }, t)).toBeNull();
    expect(reasons()).toEqual(Array(5).fill('delegation-refused'));
  });

  it("refuses a token minted for another app — a different plugin's client id, several audiences, an MCP resource", async () => {
    for (const aud of ['tasks-client', ['notes-client', 'tasks-client'], RESOURCE]) {
      expect(await onBehalf(both, await peerToken({ aud }))).toBeNull();
    }
    expect(reasons()).toEqual(Array(3).fill('token-not-for-app'));
  });

  it('refuses the MCP channel\'s delegated token, and an ordinary sign-in token of ours', async () => {
    const mcpDelegation = await token({ ...peerClaims({ aud: RESOURCE }), substrat_delegation: { stage: 'access' } });
    expect(await onBehalf(both, mcpDelegation)).toBeNull();
    // Our own id_token: `aud` is our client id, but nobody is acting.
    expect(await onBehalf(both, await token({ aud: 'notes-client' }))).toBeNull();
    expect(reasons()).toEqual(['token-not-for-app', 'delegation-refused']);
  });

  it('holds the actor to the option and the token to the actor', async () => {
    for (const over of [
      { act: { iss: ISSUER, sub: 'intruder' }, azp: 'intruder', client_id: 'intruder' },
      { act: { iss: ISSUER, sub: MASTER, act: { sub: 'earlier' } } },
      { act: { iss: 'https://elsewhere.test', sub: MASTER } },
      { azp: 'notes-client' },
      { azp: undefined, client_id: undefined },
    ]) {
      expect(await onBehalf(peer, await peerToken(over))).toBeNull();
    }
    expect(reasons()).toEqual(Array(5).fill('delegation-refused'));
  });

  it('holds it to a scope and a short life', async () => {
    expect(await onBehalf(peer, await peerToken({ scope: ' ' }))).toBeNull();
    expect(await onBehalf(peer, await peerToken({}, { expiresIn: 600 }))).toBeNull();
    expect(await onBehalf(peer, await peerToken({}, { issuedAt: null }))).toBeNull();
    expect(await onBehalf(peer, await peerToken({}, { issuedAt: 120, expiresIn: 420 }))).toBeNull();
    expect(await onBehalf({ ...base, delegation: { actors: [MASTER], channels: ['peer'], maxLifetimeSeconds: 60 } }, await peerToken())).toBeNull();
    expect(reasons()).toEqual(Array(5).fill('delegation-refused'));
  });

  it('keeps the signature check', async () => {
    expect(await onBehalf(peer, await peerToken({}, { key: otherKey }))).toBeNull();
    expect(reasons()).toEqual(['signature-invalid']);
  });
});

describe('resolve never admits a peer token', () => {
  it('refuses it as a bearer at a REST route, at the MCP endpoint with its channel, and by Host alone', async () => {
    const t = await peerToken();
    const auth = oidcRpAuthProvider(both);
    const bearer = new Headers({ authorization: `Bearer ${t}` });
    expect(await auth.resolve(bearer, `${APP}/api/notes`)).toBeNull();
    expect(await auth.resolve(bearer, RESOURCE, { delegated: { resource: RESOURCE } })).toBeNull();
    expect(await auth.resolve(new Headers({ authorization: `Bearer ${t}`, host: 'notes.example' }))).toBeNull();
    expect(reasons()).toEqual(Array(3).fill('delegation-refused'));
  });

  it('twin: the MCP-channel token is still admitted at the MCP endpoint when mcp is a channel, and not when only peer is', async () => {
    const mcpDelegation = await token(peerClaims({ aud: RESOURCE }));
    const at = (cfg: OidcRpConfig) =>
      oidcRpAuthProvider(cfg).resolve(new Headers({ authorization: `Bearer ${mcpDelegation}` }), RESOURCE, { delegated: { resource: RESOURCE } });
    expect((await at(both))?.delegation?.actor).toBe(MASTER);
    expect(await at(peer)).toBeNull();
  });
});

describe('instanceAuthFor carries channels the way it carries actors', () => {
  const choice = JSON.stringify({ mode: 'oidc', issuer: ISSUER, clientId: 'notes-client', clientSecret: 'cs' });
  const providerWith = async (channels: unknown) =>
    (
      await instanceAuthFor({
        directory: {
          authWiring: async () => ({
            config: { [AUTH_CONFIG_KEY]: choice, [SHARED_ISSUER_CONFIG_KEY]: 'true', 'acme:channels': '["peer"]' },
            sessionSecret: 'session-secret-000000000000000000000001',
          }),
        },
        scopeId: 'scope-notes',
        envSpec: [],
        env: {},
        delegation: { actors: [MASTER], channels: channels as never },
      })
    ).provider();

  it('admits a peer token through a static list and a resolver reading the wiring', async () => {
    const t = await peerToken();
    expect((await (await providerWith(['peer'])).resolveOnBehalf!(t))?.delegation?.actor).toBe(MASTER);
    const fromWiring = (w: { config: Record<string, string> }) => JSON.parse(w.config['acme:channels']!) as string[];
    expect((await (await providerWith(fromWiring)).resolveOnBehalf!(t))?.sub).toBe('ada');
  });

  it('fails closed on a resolver that throws or names an unknown channel, and absent means mcp alone', async () => {
    const t = await peerToken();
    const mcp = new Headers({ authorization: `Bearer ${await token(peerClaims({ aud: RESOURCE }))}` });
    const atMcp = async (channels: unknown) => (await providerWith(channels)).resolve(mcp, RESOURCE, { delegated: { resource: RESOURCE } });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      for (const channels of [() => { throw new Error('bad config'); }, ['peer', 'smtp'], 'peer']) {
        expect(await (await providerWith(channels)).resolveOnBehalf!(t)).toBeNull();
        // Closed on the MCP channel too, not fallen back to the default.
        expect(await atMcp(channels)).toBeNull();
      }
      expect(await (await providerWith(undefined)).resolveOnBehalf!(t)).toBeNull();
      expect((await atMcp(undefined))?.delegation?.actor).toBe(MASTER);
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/delegation\.channels threw/), { error: 'Error' });
    } finally {
      warn.mockRestore();
    }
  });
});
