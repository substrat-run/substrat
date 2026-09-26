import { beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { SignJWT, compactVerify, generateKeyPair, type CryptoKey } from 'jose';
import { TOKEN_EXCHANGE_GRANT_TYPE, TOKEN_TYPE, scopeId, tenantId } from '@substrat-run/contracts';
import { ulid } from '@substrat-run/kernel';
import { SCHEMA_STATEMENTS } from '../db/ddl.generated.js';
import type { SqlExec } from '../src/introspect.js';
import { grantFor, parseDelegationsEntry, syncDelegations } from '../src/delegations.js';
import { syncPlaceRegistrations } from '../src/places.js';
import { syncPlatformResources } from '../src/resources.js';
import { EXCHANGED_TOKEN_TTL_SECONDS, exchangeToken, type TokenExchangeDeps } from '../src/token-exchange.js';

/**
 * Token exchange (#1824): the platform's delegation grants and the decision the token
 * endpoint makes over them, against a real SQLite carrying the issuer's real DDL.
 *
 * The registries are written by their own production code — `syncPlaceRegistrations`,
 * `syncPlatformResources`, `syncDelegations` — and the tokens are real JWS, signed and
 * verified with a real key pair. Only the client authentication is a table of secrets, and
 * the clock is a number: the real ones are the DO's, and the workerd suite drives those.
 */

const ISSUER = 'https://auth.acme.test';
const TEAM = tenantId.parse(ulid());
const OTHER_TEAM = tenantId.parse(ulid());
const DESK = scopeId.parse(ulid());
const HELP = scopeId.parse(ulid());
const CRM = scopeId.parse(ulid());
const ELSEWHERE = scopeId.parse(ulid());
const DESK_MCP = 'https://desk.acme.test/api/mcp';
const CRM_MCP = 'https://crm.acme.test/api/mcp';

const CLIENT = {
  desk: { id: 'desk-client', secret: 'desk-secret' },
  help: { id: 'help-client', secret: 'help-secret' },
  crm: { id: 'crm-client', secret: 'crm-secret' },
  elsewhere: { id: 'elsewhere-client', secret: 'elsewhere-secret' },
  /** Open DCR: authenticates, and is no place. */
  stranger: { id: 'stranger-client', secret: 'stranger-secret' },
  /** The help desk's client after a rotation: same app, new client. */
  helpRotated: { id: 'help-client-rotated', secret: 'help-rotated-secret' },
  /** Registered for Basic rather than the form body. */
  basicDesk: { id: 'basic-desk-client', secret: 'basic-desk-secret' },
} as const;

const T0 = 1_900_000_000;

function sqlExecOf(database: Database.Database): SqlExec {
  return {
    exec(query: string, ...bindings: unknown[]) {
      const stmt = database.prepare(query);
      if (!stmt.reader) {
        stmt.run(...(bindings as []));
        return { columnNames: [], toArray: () => [], raw: () => [][Symbol.iterator]() };
      }
      const objects = stmt.all(...(bindings as [])) as Record<string, unknown>[];
      return {
        columnNames: stmt.columns().map((c) => c.name),
        toArray: () => objects,
        raw: () => (stmt.raw(true).all(...(bindings as [])) as unknown[][]).values(),
      };
    },
  };
}

let sql: SqlExec;
let now: number;
let issuerKey: { privateKey: CryptoKey; publicKey: CryptoKey };
let strangerKey: { privateKey: CryptoKey; publicKey: CryptoKey };

const signWith = (key: CryptoKey, payload: Record<string, unknown>) =>
  new SignJWT(payload as never).setProtectedHeader({ alg: 'EdDSA', kid: 'k1' }).sign(key);

function deps(): TokenExchangeDeps {
  const secrets = new Map<string, string>(Object.values(CLIENT).map((c) => [c.id, c.secret]));
  return {
    sql,
    issuer: ISSUER,
    nowSeconds: now,
    authenticate: async (id, secret) => secrets.get(id) === secret,
    verify: async (token) => {
      try {
        const { payload } = await compactVerify(token, issuerKey.publicKey);
        return JSON.parse(new TextDecoder().decode(payload)) as Record<string, unknown>;
      } catch {
        return null;
      }
    },
    sign: (payload) => signWith(issuerKey.privateKey, payload),
  };
}

const claimsOf = (token: string) => JSON.parse(atob(token.split('.')[1]!.replace(/-/g, '+').replace(/_/g, '/'))) as Record<string, unknown>;

/** The user's id_token for a client, as the plugin mints one: `aud` the client, no `azp`. */
const idTokenFor = (clientId: string, extra: Record<string, unknown> = {}) =>
  signWith(issuerKey.privateKey, { iss: ISSUER, sub: 'user-ann', aud: clientId, iat: now, exp: now + 3600, ...extra });

type Client = { id: string; secret: string };

/** A token-exchange POST, authenticated in the body (`client_secret_post`). */
function exchange(client: Client | null, params: Record<string, string | string[]>, authorization: string | null = null) {
  const form = new URLSearchParams({ grant_type: TOKEN_EXCHANGE_GRANT_TYPE });
  if (client) {
    form.set('client_id', client.id);
    form.set('client_secret', client.secret);
  }
  for (const [k, v] of Object.entries(params)) for (const one of [v].flat()) form.append(k, one);
  return exchangeToken(deps(), form, authorization);
}

const stageA = (subject: string, extra: Record<string, string | string[]> = {}, client: Client = CLIENT.desk) =>
  exchange(client, { subject_token: subject, subject_token_type: TOKEN_TYPE.idToken, audience: CLIENT.help.id, ...extra });

const stageB = (assertion: string, extra: Record<string, string | string[]> = {}, client: Client = CLIENT.help) =>
  exchange(client, { subject_token: assertion, subject_token_type: TOKEN_TYPE.jwt, resource: DESK_MCP, ...extra });

async function assertion(scope?: string): Promise<string> {
  const res = await stageA(await idTokenFor(CLIENT.desk.id), scope ? { scope } : {});
  expect(res.status).toBe(200);
  return res.body['access_token'] as string;
}

const register = (team: string, apps: { appScopeId: string; clientId: string; hostname: string }[]) =>
  syncPlaceRegistrations(
    sql,
    { tenantId: team, registrations: apps.map((a) => ({ ...a, appScopeId: scopeId.parse(a.appScopeId), name: a.hostname })) },
    now * 1000,
  );

const TEAM_APPS = [
  { appScopeId: DESK, clientId: CLIENT.desk.id, hostname: 'desk.acme.test' },
  { appScopeId: HELP, clientId: CLIENT.help.id, hostname: 'help.acme.test' },
  { appScopeId: CRM, clientId: CLIENT.crm.id, hostname: 'crm.acme.test' },
];

const delegate = (host: string, value: unknown) =>
  syncDelegations(sql, parseDelegationsEntry(`substrat:delegations:${host}`, typeof value === 'string' ? value : JSON.stringify(value)), now * 1000);

beforeEach(async () => {
  const db = new Database(':memory:');
  for (const stmt of SCHEMA_STATEMENTS) db.exec(stmt);
  sql = sqlExecOf(db);
  now = T0;
  issuerKey = await generateKeyPair('EdDSA');
  strangerKey = await generateKeyPair('EdDSA');
  for (const c of Object.values(CLIENT)) {
    sql.exec(
      'INSERT INTO oauth_client (id, client_id, redirect_uris, token_endpoint_auth_method) VALUES (?, ?, ?, ?)',
      c.id,
      c.id,
      '["https://rp.acme.test/cb"]',
      c === CLIENT.basicDesk ? 'client_secret_basic' : 'client_secret_post',
    );
  }
  register(TEAM, TEAM_APPS);
  register(OTHER_TEAM, [{ appScopeId: ELSEWHERE, clientId: CLIENT.elsewhere.id, hostname: 'elsewhere.test' }]);
  syncPlatformResources(sql, { appScopeId: DESK, identifiers: [DESK_MCP] }, now * 1000);
  syncPlatformResources(sql, { appScopeId: CRM, identifiers: [CRM_MCP] }, now * 1000);
  delegate(DESK, [{ actor: HELP, permissions: ['tickets.read', 'tickets.comment'] }]);
});

describe('delegation grants, as the platform delivers them (#1824)', () => {
  const key = `substrat:delegations:${DESK}`;

  it('parses a host’s whole set, and reads "" and [] as delegating to nobody', () => {
    expect(parseDelegationsEntry(key, JSON.stringify([{ actor: HELP, permissions: ['a.read'] }]))).toEqual({
      hostAppScopeId: DESK,
      grants: [{ actor: HELP, permissions: ['a.read'] }],
    });
    expect(parseDelegationsEntry(key, '')).toEqual({ hostAppScopeId: DESK, grants: [] });
    expect(parseDelegationsEntry(key, '[]')).toEqual({ hostAppScopeId: DESK, grants: [] });
  });

  it.each([
    ['a host that is not a scope id', 'substrat:delegations:not-a-ulid', '[]'],
    ['a value that is not JSON', key, '{nope'],
    ['a value that is not an array', key, JSON.stringify({ actor: HELP, permissions: ['a'] })],
    ['an actor that is not a scope id', key, JSON.stringify([{ actor: 'help', permissions: ['a'] }])],
    ['an empty permission list', key, JSON.stringify([{ actor: HELP, permissions: [] }])],
    ['an empty permission', key, JSON.stringify([{ actor: HELP, permissions: [''] }])],
    ['a permission a scope string would split', key, JSON.stringify([{ actor: HELP, permissions: ['tickets read'] }])],
    ['a permission over 128 characters', key, JSON.stringify([{ actor: HELP, permissions: ['p'.repeat(129)] }])],
    ['65 permissions', key, JSON.stringify([{ actor: HELP, permissions: Array.from({ length: 65 }, (_, i) => `p${i}`) }])],
    ['an actor named twice', key, JSON.stringify([{ actor: HELP, permissions: ['a'] }, { actor: HELP, permissions: ['b'] }])],
    ['an unknown key', key, JSON.stringify([{ actor: HELP, permissions: ['a'], extra: true }])],
  ])('refuses %s', (_why, k, value) => {
    expect(() => parseDelegationsEntry(k, value)).toThrow();
  });

  it('makes one host’s rows exactly the delivered set: grants, updates, revokes, and leaves other hosts alone', () => {
    delegate(CRM, [{ actor: HELP, permissions: ['crm.read'] }]);
    expect(delegate(DESK, [{ actor: HELP, permissions: ['tickets.read'] }, { actor: CRM, permissions: ['tickets.read'] }])).toEqual({
      granted: [CRM],
      updated: [HELP],
      revoked: [],
    });
    expect(grantFor(sql, DESK, HELP)).toEqual({ permissions: ['tickets.read'] });
    expect(grantFor(sql, DESK, CRM)).toEqual({ permissions: ['tickets.read'] });

    expect(delegate(DESK, [{ actor: CRM, permissions: ['tickets.read'] }])).toEqual({ granted: [], updated: [], revoked: [HELP] });
    expect(grantFor(sql, DESK, HELP)).toBeUndefined();
    // A grant is directional: the CRM's own grant to the help desk is untouched.
    expect(grantFor(sql, CRM, HELP)).toEqual({ permissions: ['crm.read'] });

    expect(delegate(DESK, '')).toEqual({ granted: [], updated: [], revoked: [CRM] });
    expect(sql.exec('SELECT host_app_scope_id FROM delegation_grant').toArray()).toEqual([{ host_app_scope_id: CRM }]);
  });

  it('writes nothing when the same set is delivered again', () => {
    const before = sql.exec('SELECT * FROM delegation_grant').toArray();
    expect(delegate(DESK, [{ actor: HELP, permissions: ['tickets.read', 'tickets.comment'] }])).toEqual({
      granted: [],
      updated: [],
      revoked: [],
    });
    expect(sql.exec('SELECT * FROM delegation_grant').toArray()).toEqual(before);
  });

  it('a damaged row grants nothing', () => {
    sql.exec('UPDATE delegation_grant SET permissions = ? WHERE host_app_scope_id = ?', '[]', DESK);
    expect(grantFor(sql, DESK, HELP)).toBeUndefined();
    sql.exec('UPDATE delegation_grant SET permissions = ? WHERE host_app_scope_id = ?', 'not json', DESK);
    expect(grantFor(sql, DESK, HELP)).toBeUndefined();
  });
});

describe('token exchange: who is asking (#1824)', () => {
  it('refuses a request with no client authentication, and one with the wrong secret', async () => {
    const subject = await idTokenFor(CLIENT.desk.id);
    const none = await exchange(null, { subject_token: subject, subject_token_type: TOKEN_TYPE.idToken, audience: CLIENT.help.id });
    expect(none.status).toBe(401);
    expect(none.body['error']).toBe('invalid_client');
    const wrong = await stageA(subject, {}, { id: CLIENT.desk.id, secret: 'not-the-secret' });
    expect(wrong.status).toBe(401);
    expect(wrong.body['error']).toBe('invalid_client');
  });

  it('authenticates before reading any registry: a registered and an unknown client are refused alike', async () => {
    const subject = await idTokenFor(CLIENT.desk.id);
    const registered = await stageA(subject, {}, { id: CLIENT.desk.id, secret: 'wrong' });
    const unknown = await stageA(subject, {}, { id: 'no-such-client', secret: 'wrong' });
    expect(unknown).toEqual(registered);
  });

  it('takes HTTP Basic from a client registered for it, and says so on a failure', async () => {
    register(TEAM, [...TEAM_APPS.filter((a) => a.appScopeId !== DESK), { appScopeId: DESK, clientId: CLIENT.basicDesk.id, hostname: 'desk.acme.test' }]);
    const subject = await idTokenFor(CLIENT.basicDesk.id);
    const basic = (id: string, secret: string) => `Basic ${btoa(`${encodeURIComponent(id)}:${encodeURIComponent(secret)}`)}`;
    const params = { subject_token: subject, subject_token_type: TOKEN_TYPE.idToken, audience: CLIENT.help.id };
    const ok = await exchange(null, params, basic(CLIENT.basicDesk.id, CLIENT.basicDesk.secret));
    expect(ok.status).toBe(200);
    const bad = await exchange(null, params, basic(CLIENT.basicDesk.id, 'wrong'));
    expect(bad.status).toBe(401);
    expect(bad.wwwAuthenticate).toMatch(/^Basic/);
    // The other way round: a client registered for the form body presenting Basic.
    const mismatched = await exchange(null, { ...params, subject_token: await idTokenFor(CLIENT.desk.id) }, basic(CLIENT.desk.id, CLIENT.desk.secret));
    expect(mismatched.status).toBe(401);
    expect(mismatched.body['error']).toBe('invalid_client');
  });

  it('refuses two authentication methods at once', async () => {
    const res = await stageA(await idTokenFor(CLIENT.desk.id), {}, CLIENT.desk);
    expect(res.status).toBe(200);
    const both = await exchange(
      CLIENT.desk,
      { subject_token: await idTokenFor(CLIENT.desk.id), subject_token_type: TOKEN_TYPE.idToken, audience: CLIENT.help.id },
      `Basic ${btoa(`${CLIENT.desk.id}:${CLIENT.desk.secret}`)}`,
    );
    expect(both.body['error']).toBe('invalid_request');
  });

  it('refuses a client the platform never registered, however valid its credentials', async () => {
    const res = await stageA(await idTokenFor(CLIENT.stranger.id), {}, CLIENT.stranger);
    expect(res.status).toBe(400);
    expect(res.body['error']).toBe('unauthorized_client');
  });

  it('refuses a request without a subject token, and one with an actor token', async () => {
    const missing = await exchange(CLIENT.desk, { subject_token_type: TOKEN_TYPE.idToken, audience: CLIENT.help.id });
    expect(missing.body['error']).toBe('invalid_request');
    const actor = await stageA(await idTokenFor(CLIENT.desk.id), { actor_token: 'x', actor_token_type: TOKEN_TYPE.jwt });
    expect(actor.body['error']).toBe('invalid_request');
  });
});

describe('token exchange A: the host asks for an assertion addressed to the actor (#1824)', () => {
  it('issues a short-lived assertion for the actor, scoped to the grant', async () => {
    const res = await stageA(await idTokenFor(CLIENT.desk.id));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      issued_token_type: TOKEN_TYPE.jwt,
      token_type: 'N_A',
      expires_in: EXCHANGED_TOKEN_TTL_SECONDS,
      scope: 'tickets.read tickets.comment',
    });
    expect(res.body).not.toHaveProperty('refresh_token');
    const claims = claimsOf(res.body['access_token'] as string);
    expect(claims).toMatchObject({
      iss: ISSUER,
      sub: 'user-ann',
      aud: CLIENT.help.id,
      azp: CLIENT.desk.id,
      client_id: CLIENT.desk.id,
      scope: 'tickets.read tickets.comment',
      may_act: { iss: ISSUER, sub: CLIENT.help.id },
      substrat_delegation: { stage: 'assertion', host: DESK, actor: HELP },
      iat: T0,
      exp: T0 + EXCHANGED_TOKEN_TTL_SECONDS,
    });
    expect(typeof claims['jti']).toBe('string');
  });

  it('narrows to the requested scope, and refuses a scope the grant does not cover', async () => {
    const narrowed = await stageA(await idTokenFor(CLIENT.desk.id), { scope: 'tickets.read tickets.delete' });
    expect(narrowed.body['scope']).toBe('tickets.read');
    const outside = await stageA(await idTokenFor(CLIENT.desk.id), { scope: 'tickets.delete' });
    expect(outside.body['error']).toBe('invalid_scope');
  });

  it('refuses a subject token signed by another key, from another issuer, expired, or with no subject', async () => {
    const forged = await signWith(strangerKey.privateKey, { iss: ISSUER, sub: 'user-ann', aud: CLIENT.desk.id, exp: now + 60 });
    const foreign = await idTokenFor(CLIENT.desk.id, { iss: 'https://other.test' });
    const expired = await idTokenFor(CLIENT.desk.id, { exp: now });
    const early = await idTokenFor(CLIENT.desk.id, { nbf: now + 60 });
    const anonymous = await idTokenFor(CLIENT.desk.id, { sub: undefined });
    for (const subject of [forged, foreign, expired, early, anonymous, 'not-a-jwt']) {
      const res = await stageA(subject);
      expect(res.body['error']).toBe('invalid_grant');
    }
  });

  it('refuses a subject that is already delegated: no chaining', async () => {
    const acted = await idTokenFor(CLIENT.desk.id, { act: { sub: CLIENT.help.id } });
    expect((await stageA(acted)).body['error']).toBe('invalid_grant');
    // Another exchange's product, presented back at A by the host it names.
    const delegated = await idTokenFor(CLIENT.desk.id, { substrat_delegation: { stage: 'access', host: DESK, actor: HELP } });
    expect((await stageA(delegated)).body['error']).toBe('invalid_grant');
    const minted = await assertion();
    expect((await stageA(minted, { subject_token_type: TOKEN_TYPE.jwt })).body['error']).toBe('invalid_grant');
  });

  it('refuses a subject token that was not issued to the host', async () => {
    const cases = [
      await idTokenFor(CLIENT.crm.id),
      await idTokenFor(CLIENT.desk.id, { azp: CLIENT.crm.id }),
      await idTokenFor(CLIENT.desk.id, { client_id: CLIENT.crm.id }),
      // Every authorized party present must be the host, not merely one of them.
      await idTokenFor(CLIENT.desk.id, { azp: CLIENT.desk.id, client_id: CLIENT.crm.id }),
      await idTokenFor(CLIENT.desk.id, { aud: [CLIENT.desk.id, CLIENT.crm.id] }),
      await idTokenFor(CLIENT.desk.id, { aud: CRM_MCP }),
      // An MCP client's access token for the host's own endpoint is that client's, not the host's.
      await idTokenFor(CLIENT.desk.id, { aud: DESK_MCP, azp: CLIENT.stranger.id, client_id: CLIENT.stranger.id }),
    ];
    for (const subject of cases) expect((await stageA(subject)).body['error']).toBe('invalid_grant');
  });

  it('accepts the host’s own access token: issued to it, or with no party and one of its resources as audience', async () => {
    const issued = await idTokenFor(CLIENT.desk.id, { aud: 'https://anything.test', azp: CLIENT.desk.id, client_id: CLIENT.desk.id });
    expect((await stageA(issued, { subject_token_type: TOKEN_TYPE.accessToken })).status).toBe(200);
    const forResource = await idTokenFor(CLIENT.desk.id, { aud: [DESK_MCP, `${ISSUER}/api/auth/oauth2/userinfo`] });
    expect((await stageA(forResource, { subject_token_type: TOKEN_TYPE.accessToken })).status).toBe(200);
  });

  it('refuses an unsupported subject token type', async () => {
    const res = await stageA(await idTokenFor(CLIENT.desk.id), { subject_token_type: 'urn:ietf:params:oauth:token-type:saml2' });
    expect(res.body['error']).toBe('invalid_request');
  });

  it('refuses a missing audience, and one that is not a place of the same team', async () => {
    const subject = await idTokenFor(CLIENT.desk.id);
    const params = { subject_token: subject, subject_token_type: TOKEN_TYPE.idToken };
    expect((await exchange(CLIENT.desk, params)).body['error']).toBe('invalid_request');
    expect((await exchange(CLIENT.desk, { ...params, audience: [CLIENT.help.id, CLIENT.crm.id] })).body['error']).toBe('invalid_request');
    expect((await stageA(subject, { audience: CLIENT.stranger.id })).body['error']).toBe('invalid_target');
    // Another team's app, even with a grant naming its scope.
    delegate(DESK, [{ actor: HELP, permissions: ['tickets.read'] }, { actor: ELSEWHERE, permissions: ['tickets.read'] }]);
    const elsewhere = await stageA(subject, { audience: CLIENT.elsewhere.id });
    expect(elsewhere.body['error']).toBe('invalid_target');
  });

  it('refuses an actor the host does not delegate to — and a grant is one-directional', async () => {
    const res = await stageA(await idTokenFor(CLIENT.desk.id), { audience: CLIENT.crm.id });
    expect(res.body).toEqual({ error: 'invalid_target', error_description: `this client does not delegate to ${CLIENT.crm.id}` });
    // The help desk may act for the desk; the desk may not act for the help desk.
    const reverse = await stageA(await idTokenFor(CLIENT.help.id), { audience: CLIENT.desk.id }, CLIENT.help);
    expect(reverse.body['error']).toBe('invalid_target');
  });
});

describe('token exchange B: the actor asks for a token for the host’s MCP endpoint (#1824)', () => {
  it('issues an access token for the host’s resource, acting for the user', async () => {
    const minted = await assertion();
    now += 10;
    const res = await stageB(minted);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      issued_token_type: TOKEN_TYPE.accessToken,
      token_type: 'Bearer',
      scope: 'tickets.read tickets.comment',
      // Never past the assertion it came from.
      expires_in: EXCHANGED_TOKEN_TTL_SECONDS - 10,
    });
    expect(res.body).not.toHaveProperty('refresh_token');
    expect(claimsOf(res.body['access_token'] as string)).toMatchObject({
      iss: ISSUER,
      sub: 'user-ann',
      aud: DESK_MCP,
      azp: CLIENT.help.id,
      client_id: CLIENT.help.id,
      act: { iss: ISSUER, sub: CLIENT.help.id },
      substrat_delegation: { stage: 'access', host: DESK, actor: HELP },
      iat: T0 + 10,
      exp: T0 + EXCHANGED_TOKEN_TTL_SECONDS,
    });
  });

  it('scopes to what was asked, what the assertion carries, and what the grant allows NOW', async () => {
    const minted = await assertion('tickets.read tickets.comment');
    expect((await stageB(minted, { scope: 'tickets.comment' })).body['scope']).toBe('tickets.comment');
    expect((await stageB(minted, { scope: 'tickets.delete' })).body['error']).toBe('invalid_scope');
    delegate(DESK, [{ actor: HELP, permissions: ['tickets.read', 'tickets.delete'] }]);
    expect((await stageB(minted)).body['scope']).toBe('tickets.read');
    delegate(DESK, [{ actor: HELP, permissions: ['tickets.delete'] }]);
    expect((await stageB(minted)).body['error']).toBe('invalid_scope');
  });

  it('refuses once the grant is revoked, even for an assertion minted while it stood', async () => {
    const minted = await assertion();
    delegate(DESK, '');
    const res = await stageB(minted);
    expect(res.status).toBe(400);
    expect(res.body['error']).toBe('invalid_grant');
    // The twin: delivered again, the same assertion works.
    delegate(DESK, [{ actor: HELP, permissions: ['tickets.read'] }]);
    expect((await stageB(minted)).status).toBe(200);
  });

  it('refuses when the actor’s client has been re-registered to another app', async () => {
    const minted = await assertion();
    // The help desk's client now belongs to the CRM, and the help desk to a new client.
    register(TEAM, [
      TEAM_APPS[0]!,
      { appScopeId: HELP, clientId: 'help-client-2', hostname: 'help.acme.test' },
      { appScopeId: CRM, clientId: CLIENT.help.id, hostname: 'crm.acme.test' },
    ]);
    expect((await stageB(minted)).body['error']).toBe('invalid_grant');
  });

  it('refuses when the host’s client is no longer bound to the host', async () => {
    const minted = await assertion();
    register(TEAM, TEAM_APPS.filter((a) => a.appScopeId !== DESK));
    expect((await stageB(minted)).body['error']).toBe('invalid_grant');
  });

  it('refuses an assertion addressed to another client, and one presented by the host itself', async () => {
    const minted = await assertion();
    delegate(DESK, [{ actor: HELP, permissions: ['tickets.read'] }, { actor: CRM, permissions: ['tickets.read'] }]);
    expect((await stageB(minted, {}, CLIENT.crm)).body['error']).toBe('invalid_grant');
    expect((await stageB(minted, {}, CLIENT.desk)).body['error']).toBe('invalid_grant');
  });

  it('refuses an assertion addressed to the actor app’s previous client', async () => {
    const minted = await assertion();
    // The help desk's client rotated in place: the app is the same, the client is not.
    register(TEAM, [TEAM_APPS[0]!, { appScopeId: HELP, clientId: CLIENT.helpRotated.id, hostname: 'help.acme.test' }, TEAM_APPS[2]!]);
    expect((await stageB(minted, {}, CLIENT.helpRotated)).body['error']).toBe('invalid_grant');
  });

  it('refuses an issuer-signed token that names the right apps but is not an assertion', async () => {
    const minted = claimsOf(await assertion());
    const access = await signWith(issuerKey.privateKey, {
      ...minted,
      substrat_delegation: { stage: 'access', host: DESK, actor: HELP },
    });
    expect((await stageB(access)).body['error']).toBe('invalid_grant');
    // The twin: the same claims as an assertion are accepted.
    expect((await stageB(await signWith(issuerKey.privateKey, minted))).status).toBe(200);
  });

  it('refuses an assertion that has expired, and a token of the right shape this issuer did not sign', async () => {
    const minted = await assertion();
    now += EXCHANGED_TOKEN_TTL_SECONDS;
    expect((await stageB(minted)).body['error']).toBe('invalid_grant');
    now = T0;
    const forged = await signWith(strangerKey.privateKey, claimsOf(minted));
    expect((await stageB(forged)).body['error']).toBe('invalid_grant');
  });

  it('refuses an access token presented as an assertion: B takes only A’s product', async () => {
    const access = (await stageB(await assertion())).body['access_token'] as string;
    const res = await stageB(access);
    expect(res.body['error']).toBe('invalid_grant');
  });

  it('refuses a subject token type other than jwt', async () => {
    const res = await stageB(await assertion(), { subject_token_type: TOKEN_TYPE.accessToken });
    expect(res.body['error']).toBe('invalid_request');
  });

  it('refuses a missing resource, two resources, and a resource that is not the host’s', async () => {
    const minted = await assertion();
    const params = { subject_token: minted, subject_token_type: TOKEN_TYPE.jwt };
    expect((await exchange(CLIENT.help, params)).body['error']).toBe('invalid_request');
    expect((await stageB(minted, { resource: [DESK_MCP, DESK_MCP] })).body['error']).toBe('invalid_target');
    expect((await stageB(minted, { resource: CRM_MCP })).body['error']).toBe('invalid_target');
    expect((await stageB(minted, { resource: 'https://nobody.test/api/mcp' })).body['error']).toBe('invalid_target');
  });
});
