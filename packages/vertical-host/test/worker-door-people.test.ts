/**
 * The hosted people door (#3161, docs/rfc/dependent-people.md): `workerDoor({ people })` for a
 * DEPENDENT that takes its people from a master app, and `refreshTokens` + `peerAs` for the master
 * calling it as the signed-in person.
 *
 * The issuer and the peer transport are one stubbed `fetch` (peer calls go to the reserved
 * address, the issuer to its own); the person contract's door, the delegated-token client and the
 * refresh store are the real ones from `@substrat-run/vertical-auth`. The provider is a stand-in
 * whose `resolveOnBehalf` admits a token only for the actors and channel it was configured with,
 * which is the one fact this door owns about verification.
 */
import { Hono, type Context } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PEER_CALL_URL,
  PEER_CLIENT_OPERATION,
  TOKEN_TYPE,
  principalId,
  scopeId,
  tenantId,
  type PrincipalId,
} from '@substrat-run/contracts';
import { ulid } from '@substrat-run/kernel';
import type { AuthSubject } from '@substrat-run/vertical-auth/provider';

const ISSUER = 'https://team-auth-door.test';
const TOKEN_ENDPOINT = `${ISSUER}/oauth2/token`;
const GOOD = 'eyJhbGciOiJSUzI1NiJ9.delegated.sig';

let subject: AuthSubject | null = null;
let identity: { mode: 'oidc'; issuer: string; clientId: string; clientSecret?: string } | null = null;
const wired: Array<{ delegation?: { actors: readonly string[]; channels?: readonly string[] }; refreshStore?: unknown }> = [];

vi.mock('@substrat-run/vertical-auth', async () => {
  const provider = await vi.importActual<typeof import('@substrat-run/vertical-auth/oidc-rp-provider')>(
    '@substrat-run/vertical-auth/oidc-rp-provider',
  );
  return {
    AuthConfigError: class extends Error {},
    IdentityDO: class {},
    authorizationServersOf: ({ identity: id }: { identity: { issuer?: string } | null }) => (id?.issuer ? [id.issuer] : []),
    instanceAuthFor: async (opts: (typeof wired)[number]) => {
      wired.push(opts);
      return {
        identity,
        settings: {},
        provider: () => ({
          resolve: async () => subject,
          handle: async () => new Response('login'),
          // Verifies what a real provider would: the token, an actor configured on the peer channel.
          resolveOnBehalf: async (token: string) =>
            token === GOOD && opts.delegation?.actors.includes('todo-client') && opts.delegation.channels?.includes('peer')
              ? { sub: 'ada-sub', email: 'ada@example.com', name: null, emailVerified: true, delegation: { actor: 'todo-client', scope: ['notes:read'] } }
              : null,
        }),
      };
    },
    mintOwnerClaimLink: vi.fn(),
    placesReporter: () => ({}),
    reportScopeMembers: vi.fn(),
    verifiedEmailOf: provider.verifiedEmailOf,
  };
});
vi.mock('@substrat-run/vertical-auth/owner-claim-routes', () => ({ mountOwnerClaim: vi.fn() }));
vi.mock('@substrat-run/vertical-auth/session-route', async () => ({
  ...(await vi.importActual<typeof import('@substrat-run/vertical-auth/session-route')>('@substrat-run/vertical-auth/session-route')),
  mountSession: vi.fn(),
}));

const { workerDoor } = await import('../src/worker-door.js');
const { problemResponse } = await import('../src/errors.js');
const { mountOwnerClaim } = await import('@substrat-run/vertical-auth/owner-claim-routes');

const node = { tenantId: tenantId.parse(ulid()), scopeId: scopeId.parse(ulid()) };
const ada: PrincipalId = principalId.parse(ulid());

/** One stubbed network: the peer address, by operation, and the issuer. Records every body. */
interface Net {
  peer: Array<Record<string, unknown>>;
  issuer: Array<Record<string, string>>;
  person: unknown;
  clientIds: Record<string, string | null | 'down'>;
  refresh: { status: number; body: unknown };
  exchange: { status: number; body: unknown };
}
let net: Net;

const b64 = (o: unknown) => btoa(JSON.stringify(o)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
const idToken = (sub: string) => `${b64({ alg: 'RS256' })}.${b64({ iss: ISSUER, sub })}.sig`;

beforeEach(() => {
  wired.length = 0;
  subject = null;
  identity = null;
  net = {
    peer: [],
    issuer: [],
    person: { person: { id: ada, status: 'active', roles: ['admin'] } },
    clientIds: { todo: 'todo-client', 'acme/todo': 'todo-client', notes: 'notes-client' },
    refresh: { status: 200, body: { id_token: idToken('ada-sub'), refresh_token: 'rt-2' } },
    exchange: {
      status: 200,
      body: { access_token: 'delegated-at', issued_token_type: TOKEN_TYPE.accessToken, token_type: 'Bearer', scope: 'notes:read', expires_in: 300 },
    },
  };
  vi.stubGlobal('fetch', (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url === PEER_CALL_URL) {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      net.peer.push(body);
      if (body['operation'] === PEER_CLIENT_OPERATION) {
        const id = net.clientIds[String(body['vertical'])];
        return id === 'down' ? Response.json({ error: 'not answering' }, { status: 503 }) : Response.json({ result: { clientId: id ?? null } });
      }
      if (body['operation'] === 'todo/resolve-person') {
        return net.person === 'down' ? Response.json({ error: 'not answering' }, { status: 503 }) : Response.json({ result: net.person });
      }
      return Response.json({ result: { ran: body['operation'] } });
    }
    if (url === `${ISSUER}/.well-known/openid-configuration`) {
      return Response.json({ issuer: ISSUER, token_endpoint: TOKEN_ENDPOINT, jwks_uri: `${ISSUER}/jwks` });
    }
    if (url === TOKEN_ENDPOINT) {
      const form = Object.fromEntries(new URLSearchParams(String(init?.body)));
      net.issuer.push(form);
      const answer = form['grant_type'] === 'refresh_token' ? net.refresh : net.exchange;
      return Response.json(answer.body, { status: answer.status });
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as typeof fetch);
});
/** Every console line a case wrote: no token, minted or presented, is ever among them. */
let consoleLines: () => string = () => '';
beforeEach(() => {
  const seen = (['log', 'info', 'debug'] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
  const kept = (['warn', 'error'] as const).map((m) => vi.spyOn(console, m));
  consoleLines = () => [...seen, ...kept].flatMap((spy) => spy.mock.calls).map((c) => JSON.stringify(c)).join('\n');
});
afterEach(() => {
  expect(consoleLines()).not.toMatch(/delegated-at|eyJhbGciOiJSUzI1NiJ9\.delegated|rt-1|rt-2/);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** The tenant's identity directory, in memory: the people copies and a session's refresh token. */
function directoryOf(refresh: { sub: string; refreshToken: string } | null = { sub: 'ada-sub', refreshToken: 'rt-1' }) {
  const logins = new Map<string, unknown>();
  const seated = new Map<string, string[]>();
  return {
    resolvePrincipal: vi.fn(async () => ada),
    openInviteFor: async () => null,
    setPendingOwner: vi.fn(),
    bindPersona: vi.fn(async () => {}),
    personLogin: async (_s: string, sub: string) => logins.get(sub) ?? null,
    savePersonLogin: async (_s: string, sub: string, copy: unknown) => void logins.set(sub, copy),
    personSeated: async (_s: string, p: string) => seated.get(p) ?? [],
    savePersonSeated: async (_s: string, p: string, roles: string[]) => void seated.set(p, roles),
    sessionRefresh: vi.fn(async () => refresh),
    putSessionRefresh: vi.fn(async () => {}),
    deleteSessionRefresh: vi.fn(async () => {}),
  };
}

function hostOf() {
  const stub = { tenantId: node.tenantId, scopeId: node.scopeId, invoke: vi.fn() };
  return {
    stub,
    getScope: vi.fn(async () => stub),
    grantSelfShapesLocal: vi.fn(async () => []),
    assignScopeRole: vi.fn(async () => {}),
    revokeScopeRole: vi.fn(async () => true),
  };
}

const PEOPLE = {
  master: 'todo',
  resolveOperation: 'todo/resolve-person',
  roles: (master: readonly string[]) => (master.includes('admin') ? ['editor'] : []),
  // What this dependent's manifest declares: the master may act with both notepad keys, on peer.
  delegations: [{ actor: 'todo', permissions: ['notes:read', 'notes:write'], channels: ['peer'] }],
};

function dependent(directory = directoryOf(), host = hostOf(), people: Parameters<typeof workerDoor>[0]['people'] = PEOPLE) {
  const door = workerDoor<object>({
    directory: () => directory as never,
    nodeFor: () => node,
    hostFor: () => host as never,
    envSpec: [],
    people,
  });
  return { door, directory, host };
}

/** A request through the door's `scope`, answered as the platform's envelope would answer it. */
async function signIn(door: ReturnType<typeof dependent>['door']) {
  const app = new Hono<{ Bindings: object }>();
  app.onError((err, c) => problemResponse(c, err));
  app.get('/', async (c) => {
    await door.scope(c);
    return c.text('in');
  });
  return app.request('/');
}

const signedIn = (over: Partial<AuthSubject> = {}): AuthSubject => ({
  sub: 'ada-sub', email: 'ada@example.com', name: 'Ada', emailVerified: true, ...over,
});

describe('a dependent signs a person in through its master (#3161)', () => {
  it('admits who the master says, seats the mapped roles as a person’s, and never reads the owner seat', async () => {
    identity = { mode: 'oidc', issuer: ISSUER, clientId: 'notes-client' };
    subject = signedIn();
    const { door, directory, host } = dependent();
    const res = await signIn(door);
    expect(res.status).toBe(200);
    expect(net.peer).toEqual([
      { vertical: 'todo', operation: 'todo/resolve-person', input: { issuer: ISSUER, sub: 'ada-sub', verifiedEmail: 'ada@example.com' } },
    ]);
    expect(host.getScope).toHaveBeenCalledWith(ada, node.tenantId, node.scopeId, { verifiedEmail: 'ada@example.com' });
    expect(directory.bindPersona).toHaveBeenCalledWith(node.scopeId, 'ada-sub', ada);
    expect(host.assignScopeRole).toHaveBeenCalledWith(node.scopeId, ada, 'editor', 'person');
    expect(directory.resolvePrincipal).not.toHaveBeenCalled();
  });

  it('a role the master takes away is unseated here at the next answer', async () => {
    subject = signedIn();
    // A copy that is never fresh, so every request asks the master again.
    const { door, host } = dependent(undefined, undefined, { ...PEOPLE, ttlSeconds: 0 });
    expect((await signIn(door)).status).toBe(200);
    net.person = { person: { id: ada, status: 'active', roles: [] } };
    expect((await signIn(door)).status).toBe(200);
    expect(host.revokeScopeRole).toHaveBeenCalledWith(node.scopeId, ada, 'editor');
  });

  it.each([
    ['blocked', { person: { id: ada, status: 'blocked', roles: ['admin'] } }, 403, 'forbidden'],
    ['unknown', { person: null }, 403, 'forbidden'],
    ['a master that does not answer', 'down', 503, 'unavailable'],
  ] as const)('refuses %s: %i problem, and opens no scope', async (_label, person, status, code) => {
    subject = signedIn();
    net.person = person;
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { door, host } = dependent();
    const res = await signIn(door);
    expect(res.status).toBe(status);
    expect(res.headers.get('content-type')).toBe('application/problem+json');
    expect(await res.json()).toMatchObject({ code });
    expect(host.getScope).not.toHaveBeenCalled();
    expect(host.assignScopeRole).not.toHaveBeenCalled();
  });

  it('owns no people: no invites, no join, no owner-claim route, and no claim link minted', async () => {
    const base = { directory: () => ({}) as never, nodeFor: () => node, hostFor: () => ({}) as never, envSpec: [], people: PEOPLE };
    expect(() => workerDoor<object>({ ...base, join: async () => ({}) })).toThrow(/names neither `invites` nor `join`/);
    expect(() => workerDoor<object>({ ...base, invites: {} as never })).toThrow(/names neither `invites` nor `join`/);
    const { door } = dependent();
    vi.mocked(mountOwnerClaim).mockClear();
    door.mount(new Hono());
    expect(mountOwnerClaim).not.toHaveBeenCalled();
    await expect(door.platform.mintOwnerClaim({}, node, { origin: 'https://notes.test' })).rejects.toThrow(/no owner seat to claim/);
  });
});

describe('a dependent takes a call made for a person (#3161)', () => {
  const caller = (vertical: string, tenantSlug?: string) => ({ vertical, scope: scopeId.parse(ulid()), ...(tenantSlug ? { tenantSlug } : {}) });

  it('from its master, with a token the provider verifies against the master’s own client: admitted, capped to the token’s scope', async () => {
    identity = { mode: 'oidc', issuer: ISSUER, clientId: 'notes-client' };
    const { door, host } = dependent();
    const answer = await door.platform.delegatedPeer!({}, node, caller('todo'), GOOD);
    expect(answer).toEqual({ admitted: true, principal: ada, scope: ['notes:read'], actor: 'todo-client' });
    // The actor was asked of the master itself, and only the peer channel was opened.
    expect(net.peer[0]).toEqual({ vertical: 'todo', operation: PEER_CLIENT_OPERATION });
    expect(wired.at(-1)!.delegation).toEqual({ actors: ['todo-client'], channels: ['peer'] });
    // Admitted as their own sign-in would be: the same seat, as a person's.
    expect(host.assignScopeRole).toHaveBeenCalledWith(node.scopeId, ada, 'editor', 'person');
  });

  it('a master pushed pinned to the tenant is the same master', async () => {
    identity = { mode: 'oidc', issuer: ISSUER, clientId: 'notes-client' };
    const { door } = dependent();
    expect(await door.platform.delegatedPeer!({}, node, caller('acme/todo', 'acme'), GOOD)).toMatchObject({ admitted: true });
  });

  it('from any other app, holding the same valid token: not-master, and nothing is asked of anyone', async () => {
    identity = { mode: 'oidc', issuer: ISSUER, clientId: 'notes-client' };
    const { door, host } = dependent();
    expect(await door.platform.delegatedPeer!({}, node, caller('acme/stranger'), GOOD)).toEqual({ admitted: false, reason: 'not-master' });
    expect(net.peer).toEqual([]);
    expect(host.getScope).not.toHaveBeenCalled();
  });

  it('the token’s keys are capped to what this version declares for the master on the peer channel', async () => {
    identity = { mode: 'oidc', issuer: ISSUER, clientId: 'notes-client' };
    // The token still carries notes:read (the issuer's copy lags); this version declares notes:write only.
    const { door } = dependent(undefined, undefined, { ...PEOPLE, delegations: [{ actor: 'todo', permissions: ['notes:write'], channels: ['peer'] }] });
    expect(await door.platform.delegatedPeer!({}, node, caller('todo'), GOOD)).toMatchObject({ admitted: true, scope: [] });
  });

  it.each([
    ['no delegation at all', []],
    ['one for the master off the peer channel', [{ actor: 'todo', permissions: ['notes:read'] }]],
    ['one for another app', [{ actor: 'stranger', permissions: ['notes:read'], channels: ['peer'] }]],
  ] as const)('with %s declared, a call from the master is token-refused before anything is asked', async (_label, delegations) => {
    identity = { mode: 'oidc', issuer: ISSUER, clientId: 'notes-client' };
    const { door, host } = dependent(undefined, undefined, { ...PEOPLE, delegations });
    expect(await door.platform.delegatedPeer!({}, node, caller('todo'), GOOD)).toEqual({ admitted: false, reason: 'token-refused' });
    expect(net.peer).toEqual([]);
    expect(host.assignScopeRole).not.toHaveBeenCalled();
  });

  it('a token that does not verify is token-refused', async () => {
    identity = { mode: 'oidc', issuer: ISSUER, clientId: 'notes-client' };
    const { door } = dependent();
    expect(await door.platform.delegatedPeer!({}, node, caller('todo'), 'eyJ.forged.sig')).toEqual({ admitted: false, reason: 'token-refused' });
  });

  it('a master that does not say which client it is fails closed as unavailable, and the operator is told', async () => {
    net.clientIds['todo'] = 'down';
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { door } = dependent();
    expect(await door.platform.delegatedPeer!({}, node, caller('todo'), GOOD)).toEqual({ admitted: false, reason: 'unavailable' });
    expect(JSON.parse(String(errors.mock.calls[0]![0]))).toMatchObject({ host: 'door-master-client-unavailable', master: 'todo', code: 'unavailable' });
    expect(JSON.stringify(errors.mock.calls)).not.toContain(GOOD);
  });

  it('answers PEER_CLIENT_OPERATION with its own delivered client, and null when it signs in at no issuer', async () => {
    const { door } = dependent();
    expect(await door.platform.peerClient({}, node)).toEqual({ clientId: null });
    identity = { mode: 'oidc', issuer: ISSUER, clientId: 'notes-client' };
    expect(await door.platform.peerClient({}, node)).toEqual({ clientId: 'notes-client' });
  });
});

describe('a master calls its plugin as the signed-in person: peerAs (#3161)', () => {
  function master(directory = directoryOf()) {
    const door = workerDoor<object>({
      directory: () => directory as never,
      nodeFor: () => node,
      hostFor: () => hostOf() as never,
      envSpec: [],
      refreshTokens: true,
    });
    const app = new Hono<{ Bindings: object }>();
    app.onError((err, c) => problemResponse(c, err));
    app.get('/', async (c: Context<{ Bindings: object }>) => c.json(await door.peerAs(c, 'notes', 'notes/list', { item: 'i-1' })));
    return { door, app, directory };
  }

  // A session of its own per case: `delegatedToken` keeps tokens per (issuer, client, sid) for the
  // isolate, so a shared sid would answer a later case from an earlier one's tokens.
  let sid: string;
  beforeEach(() => {
    identity = { mode: 'oidc', issuer: ISSUER, clientId: 'todo-client', clientSecret: 's3cret' };
    sid = `sid-${ulid()}`;
    subject = signedIn({ sid });
  });

  it('refreshes the session, exchanges for the plugin’s client, and calls it with the token', async () => {
    const { app, directory } = master();
    const res = await app.request('/');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ran: 'notes/list' });
    // Sign-in keeps refresh tokens: the store was handed to the provider.
    expect(wired[0]!.refreshStore).toBeDefined();
    expect(net.issuer.map((f) => f['grant_type'])).toEqual(['refresh_token', 'urn:ietf:params:oauth:grant-type:token-exchange']);
    expect(net.issuer[1]).toMatchObject({ audience: 'notes-client', client_id: 'todo-client', requested_token_type: TOKEN_TYPE.accessToken });
    expect(directory.putSessionRefresh).toHaveBeenCalledWith(sid, { sub: 'ada-sub', refreshToken: 'rt-2' });
    expect(net.peer.at(-1)).toEqual({ vertical: 'notes', operation: 'notes/list', input: { item: 'i-1' }, onBehalf: { token: 'delegated-at' } });
  });

  it.each([
    ['a session that keeps no refresh token (no sid)', () => { subject = signedIn(); }, 401, 'unauthenticated'],
    ['reauth: the refresh token is gone', () => {}, 401, 'unauthenticated'],
    ['refused: the issuer grants no peer delegation to the plugin', () => { net.exchange = { status: 400, body: { error: 'unauthorized_client' } }; }, 403, 'forbidden'],
    ['unavailable: the issuer fails', () => { net.refresh = { status: 500, body: {} }; }, 503, 'unavailable'],
    ['a plugin that signs in at no issuer', () => { net.clientIds['notes'] = null; }, 403, 'forbidden'],
  ] as const)('%s: %i problem, and the plugin is never called', async (label, arrange, status, code) => {
    arrange();
    const { app } = master(directoryOf(label.startsWith('reauth') ? null : undefined));
    const res = await app.request('/');
    expect(res.status).toBe(status);
    expect(res.headers.get('content-type')).toBe('application/problem+json');
    expect(await res.json()).toMatchObject({ code });
    expect(net.peer.filter((b) => b['operation'] === 'notes/list')).toEqual([]);
  });
});
