/**
 * A master calling its plugin as the signed-in person, on dev servers (#3161). The plugin's half
 * (`devPeople.delegated`) is driven with tokens this issuer mints by the peer exchange; the
 * master's half (`devDelegate`) end to end: the master's relying party signs Ada in with
 * `offline_access` through the real login round-trip, and the call goes through the local broker
 * to a plugin on its own host, where it runs as Ada under the keys the issuer delegated.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { HTTPException } from 'hono/http-exception';
import {
  TOKEN_EXCHANGE_GRANT_TYPE,
  TOKEN_TYPE,
  errorCodeOf,
  permissionKey,
  type PersonResolveInput,
  type PlatformActorId,
  type PrincipalId,
  type ScopeId,
  type TenantId,
} from '@substrat-run/contracts';
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { createLocalVerticalBroker } from '@substrat-run/adapter-sqlite/vertical-broker';
import { delegationCeilingMod } from '@substrat-run/contract-tests';
import { createDevIssuer } from '../src/issuer.js';
import { devDelegate, devLogin, devRefreshStore } from '../src/harness.js';
import { devPeople, type DevPeopleHost } from '../src/people.js';

// Loopback, as the real dev issuer is: the relying party accepts a plain-http issuer only there.
const ISSUER = 'http://localhost:18881';
const APP = 'http://master.test';
const MASTER_CLIENT = 'master-client';
const PLUGIN_CLIENT = 'plugin-client';
const STRANGER_CLIENT = 'stranger-client';
const MASTER = 'acme/master';
const PLUGIN = 'acme/plugin';
const STRANGER = 'acme/stranger';
const PROVIDER = 'oidc:dev-issuer';
const A = permissionKey.parse('ceiling:a');
const B = permissionKey.parse('ceiling:b');

const app = createDevIssuer({
  personas: [
    { sub: 'dev|ada', name: 'Ada', email: 'ada@example.test' },
    { sub: 'dev|cleo', name: 'Cleo', email: 'cleo@example.test' },
  ],
  allowedRedirectPrefixes: [APP],
  delegations: [{ host: PLUGIN_CLIENT, actor: MASTER_CLIENT, permissions: [A], channels: ['peer'] }],
});

let realFetch: typeof globalThis.fetch;
beforeAll(() => {
  realFetch = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const req = input instanceof Request && !init ? input : new Request(input as RequestInfo | URL, init);
    if (!req.url.startsWith(ISSUER)) return realFetch(input as RequestInfo, init);
    return Promise.resolve(app.fetch(req));
  }) as typeof globalThis.fetch;
});
afterAll(() => {
  globalThis.fetch = realFetch;
});

/** A valid ULID from a small number. */
const id = (n: number) => `01JZ${String(n).padStart(22, '0')}`;
const T = id(1) as TenantId;
const ADA = id(2) as PrincipalId;
const STAFF = id(3) as PlatformActorId;

const directory = { listIdentityTenants: async () => [], resolveIdentity: async () => undefined };
/** The plugin's relying party: takes `peer` tokens the master obtains for it. */
const pluginLogin = devLogin({
  issuer: ISSUER,
  clientId: PLUGIN_CLIENT,
  delegation: { actors: [MASTER_CLIENT], channels: ['peer'] },
  directory,
  actor: STAFF,
  provider: PROVIDER,
});

/** Todo-shaped master answers: Ada is an active owner, nobody else is anyone. */
const resolved: PersonResolveInput[] = [];
const resolve = async (login: PersonResolveInput) => {
  resolved.push(login);
  return { person: login.sub === 'dev|ada' ? { id: ADA, status: 'active' as const, roles: ['owner'] } : null };
};
const roles = (master: readonly string[]) => (master.includes('owner') ? ['both'] : []);

const post = (path: string, body: URLSearchParams | Record<string, unknown>) =>
  app.fetch(
    new Request(`${ISSUER}${path}`, {
      method: 'POST',
      ...(body instanceof URLSearchParams
        ? { body }
        : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    }),
  );

/** What the master obtains for the plugin: the peer exchange of the person's id_token. */
const peerToken = async (sub: string) => {
  const { id_token } = (await (await post('/dev/token', { sub, audience: MASTER_CLIENT })).json()) as { id_token: string };
  const res = await post(
    '/token',
    new URLSearchParams({
      grant_type: TOKEN_EXCHANGE_GRANT_TYPE,
      client_id: MASTER_CLIENT,
      subject_token: id_token,
      subject_token_type: TOKEN_TYPE.idToken,
      requested_token_type: TOKEN_TYPE.accessToken,
      audience: PLUGIN_CLIENT,
    }),
  );
  return ((await res.json()) as { access_token: string }).access_token;
};

describe('devPeople.delegated: the plugin’s door for a call made for a person (#3161)', () => {
  const seated: string[] = [];
  const host: DevPeopleHost = {
    admin: {
      linkIdentity: async () => {},
      assignRole: async (_actor, a) => void seated.push(a.roleKey),
      unassignRole: async () => {},
    },
  };
  const node = { tenantId: T, scopeId: id(4) as ScopeId };
  const peopleWith = (master?: string) =>
    devPeople({
      login: pluginLogin,
      ...(master === undefined ? {} : { master }),
      db: new Database(':memory:'),
      host,
      actor: STAFF,
      provider: PROVIDER,
      node,
      resolve,
      roles,
    });
  const people = peopleWith(MASTER);

  it('admits the person the token names, as their sign-in would be, and hands back the delegated keys', async () => {
    const answer = await people.delegated({ token: await peerToken('dev|ada'), callerVertical: MASTER });
    expect(answer).toEqual({
      caller: {
        principal: ADA,
        ...node,
        sub: 'dev|ada',
        display: 'ada@example.test',
        email: 'ada@example.test',
        verifiedEmail: null,
      },
      scope: [A],
      actor: MASTER_CLIENT,
    });
    expect(seated).toEqual(['both']);
    // Asked about with the issuer's verified address, as the person contract allows.
    expect(resolved.at(-1)).toEqual({ issuer: ISSUER, sub: 'dev|ada', verifiedEmail: 'ada@example.test' });
  });

  it('refuses any caller but the master before reading the token, and every caller when no master is named', async () => {
    const asked = resolved.length;
    const token = await peerToken('dev|ada');
    expect(await people.delegated({ token, callerVertical: STRANGER })).toEqual({ refused: 'not-master' });
    expect(await peopleWith().delegated({ token, callerVertical: MASTER })).toEqual({ refused: 'not-master' });
    expect(resolved.length).toBe(asked);
  });

  it('refuses a token that is not a peer delegation for this client: the person’s own sign-in token included', async () => {
    const { access_token } = (await (await post('/dev/token', { sub: 'dev|ada', audience: PLUGIN_CLIENT })).json()) as { access_token: string };
    expect(await people.delegated({ token: access_token, callerVertical: MASTER })).toEqual({ refused: 'token-refused' });
    expect(await people.delegated({ token: 'not-a-token', callerVertical: MASTER })).toEqual({ refused: 'token-refused' });
  });
});

describe('devDelegate: the master calls its plugin as the signed-in person, end to end (#3161)', () => {
  const dirs: string[] = [];
  const hostIn = () => {
    const dir = mkdtempSync(join(tmpdir(), 'dev-issuer-delegate-'));
    dirs.push(dir);
    return new SqliteScopeHost({ dir });
  };
  const master = hostIn();
  const plugin = hostIn();
  const stranger = hostIn();
  const masterScope = id(10) as ScopeId;
  const pluginScope = id(11) as ScopeId;
  const strangerScope = id(12) as ScopeId;

  const store = devRefreshStore(new Database(':memory:'));
  const masterLogin = devLogin({ issuer: ISSUER, clientId: MASTER_CLIENT, refreshStore: store, directory, actor: STAFF, provider: PROVIDER });
  const people = devPeople({
    login: pluginLogin,
    master: MASTER,
    db: new Database(':memory:'),
    host: plugin,
    actor: STAFF,
    provider: PROVIDER,
    node: { tenantId: T, scopeId: pluginScope },
    resolve,
    roles,
  });
  const broker = createLocalVerticalBroker(
    { [MASTER]: master, [PLUGIN]: plugin, [STRANGER]: stranger },
    {
      [PLUGIN]: {
        clientId: PLUGIN_CLIENT,
        delegated: async (call) => {
          const answer = await people.delegated({ token: call.token, callerVertical: call.caller.vertical });
          return 'refused' in answer
            ? { admitted: false, reason: answer.refused }
            : { admitted: true, principal: answer.caller.principal, scope: answer.scope, actor: answer.actor };
        },
      },
      // Signs people in, and the issuer delegates nothing to it.
      [STRANGER]: { clientId: STRANGER_CLIENT },
    },
  );
  const peer = broker.clientFor({ vertical: MASTER, tenantId: T, scopeId: masterScope });
  const delegate = devDelegate({ login: masterLogin, store, peer });

  /** Ada signs in at the master through its relying party, with the issuer's picker. */
  let session: Headers;
  const signIn = async (): Promise<Headers> => {
    const cookieOf = (res: Response) =>
      res.headers.getSetCookie().map((c) => c.split(';')[0]!).filter((c) => !c.endsWith('=')).join('; ');
    const begin = await masterLogin.handle(new Request(`${APP}/api/auth/login`));
    const picked = await app.fetch(new Request(`${begin.headers.get('location')}&sub=${encodeURIComponent('dev|ada')}`, { redirect: 'manual' }));
    const done = await masterLogin.handle(new Request(picked.headers.get('location') ?? '', { headers: { cookie: cookieOf(begin) } }));
    expect(done.status).toBe(302);
    return new Headers({ cookie: cookieOf(done) });
  };

  beforeAll(async () => {
    plugin.registerModule(delegationCeilingMod);
    const scopes: [SqliteScopeHost, ScopeId, string][] = [[master, masterScope, MASTER], [plugin, pluginScope, PLUGIN], [stranger, strangerScope, STRANGER]];
    for (const [host, scopeId, vertical] of scopes) {
      await host.admin.createTenant(STAFF, { id: T, slug: 'delegate-tenant', name: 'Delegate' });
      await host.provisionScope(STAFF, { tenantId: T, scopeId, vertical });
      await host.admin.activateScope(STAFF, T, scopeId);
    }
    await plugin.admin.grantEntitlement(STAFF, T, 'delegation-ceiling');
    await plugin.admin.registerIdentityPool(STAFF, { provider: PROVIDER, topology: 'central', tenantId: null });
    await plugin.admin.defineRole(STAFF, T, { key: 'both', permissions: [A, B], source: 'vertical' });
    session = await signIn();
  });

  afterAll(async () => {
    for (const host of [master, plugin, stranger]) await host.close();
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  const statusOf = (call: Promise<unknown>) =>
    call.then(
      () => 'answered',
      (e: unknown) => (e instanceof HTTPException ? e.status : errorCodeOf(e)),
    );

  it('runs as the person in the plugin, capped to the keys the issuer delegated', async () => {
    await expect(delegate.invoke(session, PLUGIN, 'ceiling/a')).resolves.toEqual({ ok: true });
    // Ada holds B in the plugin; the master was delegated A only.
    expect(await statusOf(delegate.invoke(session, PLUGIN, 'ceiling/b'))).toBe('permission_denied');
  });

  it('401 for a session that keeps no refresh token: a bearer has no sid, and a forgotten row is gone', async () => {
    const { access_token } = (await (await post('/dev/token', { sub: 'dev|ada', audience: MASTER_CLIENT })).json()) as { access_token: string };
    const bearer = await delegate.invoke(new Headers({ authorization: `Bearer ${access_token}` }), PLUGIN, 'ceiling/a').catch((e: unknown) => e);
    expect(bearer).toMatchObject({ status: 401, message: expect.stringContaining('sign in again') });
    const { sid } = (await masterLogin.subject(session))!;
    await store.delete(sid!);
    const forgotten = await delegate.invoke(session, PLUGIN, 'ceiling/a').catch((e: unknown) => e);
    expect(forgotten).toMatchObject({ status: 401, message: expect.stringContaining('keeps no refresh token') });
    session = await signIn();
  });

  it('403 when the issuer delegates nothing to the plugin, 503 when it cannot be reached', async () => {
    expect(await statusOf(delegate.invoke(session, STRANGER, 'ceiling/a'))).toBe(403);
    const unreachable = devDelegate({
      login: {
        issuer: 'http://localhost:1',
        clientId: MASTER_CLIENT,
        subject: async () => ({ sub: 'dev|ada', email: null, name: null, sid: 'a-session' }),
      },
      store,
      peer,
    });
    expect(await statusOf(unreachable.invoke(session, PLUGIN, 'ceiling/a'))).toBe(503);
  });
});
