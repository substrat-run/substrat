import { beforeAll, describe, expect, it, vi } from 'vitest';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import { DELEGATION_ASSERTION_AUDIENCE, SHARED_ISSUER_CONFIG_KEY, mcpResourceOf } from '@substrat-run/contracts';
import { oidcRpAuthProvider, type OidcRpConfig } from '../src/oidc-rp-provider.js';
import { oidcAuthProvider } from '../src/oidc.js';
import { AUTH_CONFIG_KEY, instanceAuthFor, type InstanceDelegation } from '../src/instance-auth.js';
import type { AuthSubject } from '../src/provider.js';

/**
 * Delegated bearers (#1824): another app of the team, the ACTOR, calling this app's MCP
 * endpoint for one of its users with a token the team auth-server minted by RFC 8693
 * exchange (`demos/auth-server/src/token-exchange.ts`, stage B).
 *
 * Such a token is the user as `sub`, the actor as `act.sub` and as the authorized party,
 * this app's MCP resource as `aud`, and a `scope` of this app's permission keys. Before
 * this, `isOwnToken` rule 1 took it as the plain user on every route and never read `act`.
 *
 * Each rule below is pinned by a refused case beside an admitted twin that differs in the
 * one thing the rule reads, and the last block holds every ordinary (non-delegated) token
 * to exactly what it did before, on every route and on the no-URL path every demo uses.
 */

const ISSUER = 'https://team-auth.test';
const APP_A = 'https://desk-a.example';
const APP_B = 'https://desk-b.example';
const RESOURCE_A = mcpResourceOf(APP_A);
const RESOURCE_B = mcpResourceOf(APP_B);
const MCP_A = RESOURCE_A;
const REST_A = `${APP_A}/api/tickets`;
const USERINFO = `${ISSUER}/oauth2/userinfo`;
const ACTOR = 'helpdesk';

const base: Omit<OidcRpConfig, 'clientId'> = {
  issuer: ISSUER,
  clientSecret: 'client-secret',
  sessionSecret: 'session-secret-000000000000000000000001',
};
/** Desk A, on the team issuer, with no opinion about delegation — every host today. */
const plain: OidcRpConfig = { ...base, clientId: 'desk-a', sharedIssuer: true };
/** Desk A, opted in for one actor. */
const opted: OidcRpConfig = { ...plain, delegation: { actors: [ACTOR] } };

let privateKey: CryptoKey;
let otherKey: CryptoKey;

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

interface SignOptions {
  issuer?: string;
  /** Seconds from now; `null` signs a token with no `exp` at all. */
  expiresIn?: number | null;
  /** `iat`, in seconds from now; `null` signs a token with no `iat`. */
  issuedAt?: number | null;
  key?: CryptoKey;
}

/** A token with exactly these claims, plus iss/sub and (unless told otherwise) iat and exp. */
async function token(claims: Record<string, unknown>, opts: SignOptions = {}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const jwt = new SignJWT({ email: 'pat@acme.test', ...claims })
    .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
    .setIssuer(opts.issuer ?? ISSUER)
    .setSubject('user-1');
  if (opts.issuedAt !== null) jwt.setIssuedAt(now + (opts.issuedAt ?? 0));
  if (opts.expiresIn !== null) jwt.setExpirationTime(now + (opts.expiresIn ?? 300));
  return jwt.sign(opts.key ?? privateKey);
}

/** The claims stage B mints, for desk A's endpoint and the helpdesk actor. */
const delegatedClaims = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  aud: RESOURCE_A,
  azp: ACTOR,
  client_id: ACTOR,
  scope: 'tickets:read orders:read',
  act: { iss: ISSUER, sub: ACTOR },
  substrat_delegation: { stage: 'access', host: 'scope-host', actor: 'scope-actor' },
  ...over,
});
const delegated = (over: Record<string, unknown> = {}, opts?: SignOptions) => token(delegatedClaims(over), opts);

const bearer = (t: string, extra: Record<string, string> = {}) => new Headers({ authorization: `Bearer ${t}`, ...extra });

/** Resolve `t` at `cfg` as a request to `url` (or, with `url: null`, by Host alone). */
async function resolveAt(cfg: OidcRpConfig, t: string, url: string | null = MCP_A): Promise<AuthSubject | null> {
  return url === null
    ? oidcRpAuthProvider(cfg).resolve(bearer(t, { host: 'desk-a.example' }))
    : oidcRpAuthProvider(cfg).resolve(bearer(t), url);
}
const subAt = async (cfg: OidcRpConfig, t: string, url: string | null = MCP_A) => (await resolveAt(cfg, t, url))?.sub ?? null;

describe('a delegated token is admitted only where the host opted in', () => {
  it('admits the stage-B shape at the MCP endpoint, and says who acts and within what', async () => {
    const subject = await resolveAt(opted, await delegated());
    expect(subject?.sub).toBe('user-1');
    expect(subject?.delegation).toEqual({ actor: ACTOR, scope: ['tickets:read', 'orders:read'] });
  });

  it('refuses it without the option — on the team issuer, an external one and a deployment default', async () => {
    const t = await delegated();
    expect(await resolveAt(plain, t)).toBeNull();
    expect(await resolveAt({ ...base, clientId: 'desk-a' }, t)).toBeNull();
    expect(await resolveAt({ ...plain, audience: RESOURCE_A }, t)).toBeNull();
    expect(await oidcAuthProvider({ issuer: ISSUER }).resolve(bearer(t), MCP_A)).toBeNull();
    // Twin: the same token without `act` is a user's MCP token, which rule 1 admits as before.
    const { act: _act, substrat_delegation: _marker, ...withoutAct } = delegatedClaims();
    expect(await subAt(plain, await token(withoutAct))).toBe('user-1');
    expect((await oidcAuthProvider({ issuer: ISSUER }).resolve(bearer(await token(withoutAct)), MCP_A))?.sub).toBe('user-1');
  });

  it('refuses it when the option names no actor, or other actors', async () => {
    const t = await delegated();
    expect(await resolveAt({ ...plain, delegation: { actors: [] } }, t)).toBeNull();
    expect(await resolveAt({ ...plain, delegation: { actors: ['someone-else'] } }, t)).toBeNull();
    expect(await subAt({ ...plain, delegation: { actors: ['someone-else', ACTOR] } }, t)).toBe('user-1');
  });

  it('needs the shared issuer, which is what names the resource the token is for', async () => {
    const external: OidcRpConfig = { ...base, clientId: 'desk-a', delegation: { actors: [ACTOR] } };
    expect(await resolveAt(external, await delegated())).toBeNull();
  });
});

describe('the actor', () => {
  it('refuses an actor the option does not name, even when the token is otherwise whole', async () => {
    const t = await delegated({ azp: 'intruder', client_id: 'intruder', act: { iss: ISSUER, sub: 'intruder' } });
    expect(await resolveAt(opted, t)).toBeNull();
    expect(await subAt({ ...plain, delegation: { actors: ['intruder'] } }, t)).toBe('user-1');
  });

  it('refuses a chain of actors: no exchange mints one, and nothing reads past the first', async () => {
    expect(await resolveAt(opted, await delegated({ act: { iss: ISSUER, sub: ACTOR, act: { sub: 'earlier' } } }))).toBeNull();
  });

  it('refuses an act that is not one actor of this issuer', async () => {
    for (const act of [ACTOR, null, [], {}, { sub: ACTOR }, { iss: 'https://elsewhere.test', sub: ACTOR }, { iss: ISSUER, sub: 7 }]) {
      expect(await resolveAt(opted, await delegated({ act }))).toBeNull();
    }
    expect(await subAt(opted, await delegated({ act: { iss: ISSUER, sub: ACTOR } }))).toBe('user-1');
  });

  it('refuses a token not issued to the actor it names', async () => {
    expect(await resolveAt(opted, await delegated({ azp: 'mcp-client' }))).toBeNull();
    expect(await resolveAt(opted, await delegated({ client_id: 'desk-a' }))).toBeNull();
    expect(await resolveAt(opted, await delegated({ azp: undefined, client_id: undefined }))).toBeNull();
    // Either party alone is enough when it is the actor.
    expect(await subAt(opted, await delegated({ client_id: undefined }))).toBe('user-1');
    expect(await subAt(opted, await delegated({ azp: undefined }))).toBe('user-1');
  });
});

describe('the audience and the request', () => {
  it("refuses another app's resource, our client id, several audiences and none", async () => {
    for (const aud of [RESOURCE_B, 'desk-a', [RESOURCE_A, USERINFO], [RESOURCE_A, RESOURCE_A], [], undefined]) {
      expect(await resolveAt(opted, await delegated({ aud }))).toBeNull();
    }
    expect(await subAt(opted, await delegated({ aud: [RESOURCE_A] }))).toBe('user-1');
  });

  it('refuses it on a REST route, with no URL, and on another origin — only the MCP endpoint applies its scope', async () => {
    const t = await delegated();
    expect(await resolveAt(opted, t, REST_A)).toBeNull();
    expect(await resolveAt(opted, t, null)).toBeNull();
    expect(await resolveAt(opted, t, mcpResourceOf(APP_B))).toBeNull();
    expect(await resolveAt(opted, t, `${APP_A}/api/mcp/extra`)).toBeNull();
    expect(await resolveAt(opted, t, 'not a url')).toBeNull();
    // The query string is not part of the resource.
    expect(await subAt(opted, t, `${MCP_A}?session=1`)).toBe('user-1');
  });

  it('refuses an audience that is this origin but not its MCP resource, even at that very URL', async () => {
    expect(await resolveAt(opted, await delegated({ aud: REST_A }), REST_A)).toBeNull();
  });
});

describe('the scope and the lifetime', () => {
  it('refuses a delegation that delegates nothing: no scope, an empty one, or not a string', async () => {
    for (const scope of [undefined, '', '   ', ['tickets:read'], 7]) {
      expect(await resolveAt(opted, await delegated({ scope }))).toBeNull();
    }
  });

  it('reads the scope with the grammar the exchange writes, one copy of each key', async () => {
    const subject = await resolveAt(opted, await delegated({ scope: ' tickets:read  tickets:read orders:read ' }));
    expect(subject?.delegation?.scope).toEqual(['tickets:read', 'orders:read']);
  });

  it('refuses a delegated token with no expiry, and an expired one', async () => {
    expect(await resolveAt(opted, await delegated({}, { expiresIn: null }))).toBeNull();
    expect(await resolveAt(opted, await delegated({}, { expiresIn: -60 }))).toBeNull();
    expect(await subAt(opted, await delegated({}, { expiresIn: 60 }))).toBe('user-1');
  });

  it('refuses one that lives longer than the exchange mints, has no iat, or was issued ahead of this clock', async () => {
    expect(await resolveAt(opted, await delegated({}, { expiresIn: 600 }))).toBeNull();
    expect(await resolveAt(opted, await delegated({}, { expiresIn: 60 * 60 * 24 * 365 * 10 }))).toBeNull();
    expect(await resolveAt(opted, await delegated({}, { issuedAt: null }))).toBeNull();
    // A lifetime inside the bound, but starting two minutes from now.
    expect(await resolveAt(opted, await delegated({}, { issuedAt: 120, expiresIn: 420 }))).toBeNull();
    // Twins: exactly the exchange's lifetime, and an iat within the stated skew.
    expect(await subAt(opted, await delegated({}, { expiresIn: 300 }))).toBe('user-1');
    expect(await subAt(opted, await delegated({}, { issuedAt: 20, expiresIn: 320 }))).toBe('user-1');
  });

  it('takes a lower bound, never a higher one, and admits nothing on a bound that is not a positive number', async () => {
    const withBound = (maxLifetimeSeconds: number): OidcRpConfig => ({ ...plain, delegation: { actors: [ACTOR], maxLifetimeSeconds } });
    expect(await resolveAt(withBound(60), await delegated({}, { expiresIn: 300 }))).toBeNull();
    expect(await subAt(withBound(60), await delegated({}, { expiresIn: 60 }))).toBe('user-1');
    expect(await resolveAt(withBound(900), await delegated({}, { expiresIn: 600 }))).toBeNull();
    expect(await subAt(withBound(900), await delegated({}, { expiresIn: 300 }))).toBe('user-1');
    for (const bound of [0, -1, Number.NaN]) {
      expect(await resolveAt(withBound(bound), await delegated({}, { expiresIn: 30 }))).toBeNull();
      // Even one whose `exp` precedes its `iat`, which no bound of zero or less would catch alone.
      expect(await resolveAt(withBound(bound), await delegated({}, { issuedAt: 25, expiresIn: 20 }))).toBeNull();
    }
  });

  it('keeps the signature and issuer checks: a forged or foreign token is nobody', async () => {
    expect(await resolveAt(opted, await delegated({}, { key: otherKey }))).toBeNull();
    expect(await resolveAt(opted, await delegated({}, { issuer: 'https://elsewhere.test' }))).toBeNull();
  });
});

describe("a token for another app's MCP endpoint is not ours, even when issued to our client", () => {
  it('refuses a plugin-minted MCP token for desk B whose client is desk A, at desk A', async () => {
    const forB = await token({ aud: [RESOURCE_B, USERINFO], azp: 'desk-a', client_id: 'desk-a' });
    expect(await resolveAt(plain, forB, REST_A)).toBeNull();
    expect(await resolveAt(plain, forB, null)).toBeNull();
    // However the endpoint is spelled.
    for (const aud of [
      'https://DESK-B.example/api/mcp',
      'https://desk-b.example:443/api/mcp',
      `${APP_B}/api/mcp/`,
      `${APP_B}/api/%6Dcp`,
      `${APP_B}//api//mcp`,
      `${APP_B}/API/MCP`,
    ]) {
      expect(await resolveAt(plain, await token({ aud, azp: 'desk-a' }), REST_A)).toBeNull();
    }
    // Twin: a URL on desk B that is not its MCP endpoint is no resource, so rule 2 judges it.
    expect(await subAt(plain, await token({ aud: `${APP_B}/api/mcp/extra`, azp: 'desk-a' }), REST_A)).toBe('user-1');
  });

  it('refuses one for our own MCP endpoint on a sibling hostname, at a REST route here', async () => {
    // A compatibility fact, pinned: rule 2 admitted it before, and no client mints it.
    const sibling = await token({ aud: mcpResourceOf('https://crm.acme.example'), azp: 'desk-a', client_id: 'desk-a' });
    expect(await resolveAt(plain, sibling, REST_A)).toBeNull();
    expect(await resolveAt(plain, sibling, null)).toBeNull();
  });

  it("refuses the stage-B token at the actor's own API, with or without the actor opting in itself", async () => {
    const actorApp: OidcRpConfig = { ...base, clientId: ACTOR, sharedIssuer: true };
    const t = await delegated();
    expect(await resolveAt(actorApp, t, 'https://helpdesk.example/api/tickets')).toBeNull();
    expect(await resolveAt({ ...actorApp, delegation: { actors: [ACTOR] } }, t, 'https://helpdesk.example/api/tickets')).toBeNull();
    // And without `act` too: that is the rule above, not the delegation one.
    const { act: _act, substrat_delegation: _marker, ...withoutAct } = delegatedClaims();
    expect(await resolveAt(actorApp, await token(withoutAct), 'https://helpdesk.example/api/tickets')).toBeNull();
  });

  it('still admits a token issued to us for a URL that is no MCP endpoint, and one naming our own resource too', async () => {
    expect(await subAt(plain, await token({ aud: USERINFO, azp: 'desk-a', client_id: 'desk-a' }), REST_A)).toBe('user-1');
    expect(await subAt(plain, await token({ aud: `${ISSUER}/api/auth`, azp: 'desk-a' }), REST_A)).toBe('user-1');
    expect(await subAt(plain, await token({ aud: [RESOURCE_A, RESOURCE_B], azp: 'mcp-client' }), REST_A)).toBe('user-1');
  });
});

describe("the exchange's first step is a bearer nowhere", () => {
  /** The stage-A assertion: addressed to the actor and a marker, no authorized party. */
  const assertionClaims = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    aud: [ACTOR, DELEGATION_ASSERTION_AUDIENCE],
    scope: 'tickets:read',
    may_act: { iss: ISSUER, sub: ACTOR },
    substrat_delegation: { stage: 'assertion', host: 'scope-host', actor: 'scope-actor', host_client: 'desk-a' },
    ...over,
  });
  const actorWithAudience: OidcRpConfig = { ...base, clientId: ACTOR, sharedIssuer: true, audience: ACTOR };
  const actorExternal: OidcRpConfig = { ...base, clientId: ACTOR };

  it('refuses it where a delivered audience or an external issuer would otherwise take it as the user', async () => {
    for (const cfg of [actorWithAudience, actorExternal, { ...base, clientId: ACTOR, sharedIssuer: true }]) {
      expect(await resolveAt(cfg, await token(assertionClaims()), 'https://helpdesk.example/api/tickets')).toBeNull();
    }
  });

  it('refuses it on either marker alone', async () => {
    expect(await resolveAt(actorWithAudience, await token(assertionClaims({ substrat_delegation: undefined })), REST_A)).toBeNull();
    expect(await resolveAt(actorWithAudience, await token(assertionClaims({ may_act: undefined })), REST_A)).toBeNull();
  });

  it('twin: the same audience rule still admits a token with neither marker', async () => {
    const plainToken = await token(assertionClaims({ may_act: undefined, substrat_delegation: undefined }));
    expect(await subAt(actorWithAudience, plainToken, REST_A)).toBe('user-1');
    expect(await subAt(actorExternal, plainToken, REST_A)).toBe('user-1');
  });
});

describe('the option reaches the verifier, and never leaks between configurations', () => {
  it('does not share a cached verifier between configurations that differ only in `delegation`', async () => {
    const t = await delegated();
    // Each order, so whichever is built first cannot answer for the other.
    expect(await resolveAt(plain, t)).toBeNull();
    expect(await subAt(opted, t)).toBe('user-1');
    expect(await resolveAt(plain, t)).toBeNull();
    const other: OidcRpConfig = { ...plain, delegation: { actors: ['someone-else'] } };
    expect(await subAt({ ...plain, delegation: { actors: [ACTOR] } }, t)).toBe('user-1');
    expect(await resolveAt(other, t)).toBeNull();
    // And between configurations that differ only in the lifetime bound.
    const tight: OidcRpConfig = { ...plain, delegation: { actors: [ACTOR], maxLifetimeSeconds: 60 } };
    expect(await resolveAt(tight, t)).toBeNull();
    expect(await subAt(opted, t)).toBe('user-1');
    expect(await resolveAt(tight, t)).toBeNull();
  });

  it('threads through instanceAuthFor, as a hosted vertical builds its provider', async () => {
    const choice = JSON.stringify({ mode: 'oidc', issuer: ISSUER, clientId: 'desk-a', clientSecret: 'cs' });
    const providerFor = async (delegation?: { actors: string[] }) =>
      (
        await instanceAuthFor({
          directory: {
            authWiring: async () => ({
              config: { [AUTH_CONFIG_KEY]: choice, [SHARED_ISSUER_CONFIG_KEY]: 'true' },
              sessionSecret: 'session-secret-000000000000000000000001',
            }),
          },
          scopeId: 'scope-1',
          envSpec: [],
          env: {},
          ...(delegation ? { delegation } : {}),
        })
      ).provider();
    const t = await delegated();
    expect((await (await providerFor({ actors: [ACTOR] })).resolve(bearer(t), MCP_A))?.delegation?.actor).toBe(ACTOR);
    expect(await (await providerFor()).resolve(bearer(t), MCP_A)).toBeNull();
  });
});

/**
 * An actor's client id is per team auth server, so a script serving many installs reads each
 * install's list from what was delivered to it. One resolver, many lists: the verifier is
 * keyed by the list it resolved to, never by the function.
 */
describe('delegation.actors read from the delivered wiring', () => {
  const choice = JSON.stringify({ mode: 'oidc', issuer: ISSUER, clientId: 'desk-a', clientSecret: 'cs' });
  const ACTORS_KEY = 'acme:delegation-actors';
  const providerWith = async (extra: Record<string, string>, delegation: InstanceDelegation) =>
    (
      await instanceAuthFor({
        directory: {
          authWiring: async () => ({
            config: { [AUTH_CONFIG_KEY]: choice, [SHARED_ISSUER_CONFIG_KEY]: 'true', ...extra },
            sessionSecret: 'session-secret-000000000000000000000001',
          }),
        },
        scopeId: 'scope-1',
        envSpec: [],
        env: {},
        delegation,
      })
    ).provider();
  const fromConfig: InstanceDelegation = { actors: (w) => JSON.parse(w.config[ACTORS_KEY] ?? '[]') as string[] };

  it('admits the actor one install lists and refuses it at an install listing another, through one resolver', async () => {
    const t = await delegated();
    const listsIt = await providerWith({ [ACTORS_KEY]: JSON.stringify([ACTOR]) }, fromConfig);
    const listsOther = await providerWith({ [ACTORS_KEY]: JSON.stringify(['someone-else']) }, fromConfig);
    expect((await listsIt.resolve(bearer(t), MCP_A))?.delegation?.actor).toBe(ACTOR);
    expect(await listsOther.resolve(bearer(t), MCP_A)).toBeNull();
    expect((await listsIt.resolve(bearer(t), MCP_A))?.delegation?.actor).toBe(ACTOR);
  });

  it('hands the resolver the parsed identity beside the delivered map', async () => {
    let seen: string | undefined;
    await (await providerWith({}, { actors: (w) => ((seen = w.identity?.issuer), [ACTOR]) })).resolve(bearer(await delegated()), MCP_A);
    expect(seen).toBe(ISSUER);
  });

  it('fails closed when the resolver throws, or answers nothing usable — and leaves ordinary sign-in alone', async () => {
    const t = await delegated();
    const own = await token({ aud: 'desk-a' });
    const broken: InstanceDelegation[] = [
      { actors: () => { throw new Error('bad config'); } },
      { actors: () => [] },
      { actors: () => 'helpdesk' as unknown as string[] },
      { actors: () => [ACTOR, ''] },
      { actors: () => [ACTOR, 7] as unknown as string[] },
      { actors: () => Promise.resolve([ACTOR]) as unknown as string[] },
    ];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      for (const delegation of broken) {
        const p = await providerWith({}, delegation);
        expect(await p.resolve(bearer(t), MCP_A)).toBeNull();
        expect((await p.resolve(bearer(own), REST_A))?.sub).toBe('user-1');
      }
      // The line names the failure, never the message, which may quote delivered configuration.
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/delegation\.actors threw/), { error: 'Error' });
    } finally {
      warn.mockRestore();
    }
  });

  it('takes a static list the same way', async () => {
    expect((await (await providerWith({}, { actors: [ACTOR] })).resolve(bearer(await delegated()), MCP_A))?.sub).toBe('user-1');
    expect(await (await providerWith({}, { actors: ['', ACTOR] })).resolve(bearer(await delegated()), MCP_A)).toBeNull();
  });
});

/**
 * The twin of every refusal above: a token WITHOUT `act` resolves exactly as it did before
 * this change, under every configuration used here — opted in or not — on a REST route, at
 * the MCP endpoint, and by Host alone (every demo calls `resolve(headers)` with no URL).
 */
describe('an ordinary token is exactly what it was, opted in or not', () => {
  const routes: Array<[string, string | null]> = [
    ['a REST route', REST_A],
    ['the MCP endpoint', MCP_A],
    ['no URL (Host only)', null],
  ];
  const configs: Array<[string, OidcRpConfig]> = [
    ['not opted in', plain],
    ['opted in', opted],
  ];

  for (const [configName, cfg] of configs) {
    for (const [routeName, url] of routes) {
      it(`${configName}, ${routeName}: our id_token, a token issued to us, and a user's MCP token are admitted, with no delegation`, async () => {
        for (const claims of [
          { aud: 'desk-a' },
          { aud: USERINFO, azp: 'desk-a', client_id: 'desk-a' },
          { aud: [RESOURCE_A, USERINFO], azp: 'mcp-client', client_id: 'mcp-client' },
        ]) {
          const subject = await resolveAt(cfg, await token(claims), url);
          expect(subject?.sub).toBe('user-1');
          expect(subject?.delegation).toBeUndefined();
        }
      });

      it(`${configName}, ${routeName}: another client's id_token and another vertical's MCP token are refused`, async () => {
        expect(await resolveAt(cfg, await token({ aud: 'desk-b' }), url)).toBeNull();
        expect(await resolveAt(cfg, await token({ aud: [RESOURCE_B, USERINFO], azp: 'mcp-client' }), url)).toBeNull();
      });
    }
  }

  it('an external issuer still admits any token it signed that carries no act', async () => {
    const external: OidcRpConfig = { ...base, clientId: 'crm-web' };
    expect(await subAt(external, await token({ aud: 'some-other-client' }), REST_A)).toBe('user-1');
    expect(await subAt(external, await token({}), null)).toBe('user-1');
  });
});
