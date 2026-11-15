import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { SignJWT, generateKeyPair } from 'jose';
import { TOKEN_EXCHANGE_GRANT_TYPE, TOKEN_TYPE } from '@substrat-run/contracts';
import type { FetchLike } from '@substrat-run/kernel';
import { DelegatedTokenError, delegatedToken, type DelegatedTokenDeps } from '../src/delegate.js';
import { SESSION_REFRESH_DDL, sqlRefreshStore, type RefreshStore } from '../src/session-refresh.js';
import type { RegistrySql } from '../src/site-registry.js';

/**
 * The master's half of a delegated peer call (#3161), against a stubbed issuer token endpoint and
 * a real SQLite refresh store: refresh the session's token, keep a rotated one, exchange the fresh
 * `id_token`, and fail in three kinds a caller can tell apart.
 */

const ISSUER = 'https://team-auth-delegate.test';
const TOKEN_ENDPOINT = `${ISSUER}/oauth2/token`;
const NOW = Date.UTC(2026, 10, 15, 9);

let key: CryptoKey;
beforeAll(async () => {
  key = (await generateKeyPair('RS256')).privateKey as CryptoKey;
  vi.stubGlobal('fetch', (async (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url === `${ISSUER}/.well-known/openid-configuration`) {
      return Response.json({ issuer: ISSUER, token_endpoint: TOKEN_ENDPOINT, jwks_uri: `${ISSUER}/jwks` });
    }
    throw new Error(`unexpected fetch in test: ${url}`);
  }) as typeof fetch);
});

const idTokenOf = (sub: string) =>
  new SignJWT({}).setProtectedHeader({ alg: 'RS256' }).setIssuer(ISSUER).setSubject(sub).setExpirationTime('5m').sign(key);

interface Seen {
  form: Record<string, string>;
  authorization: string | null;
}

/** A token endpoint whose answers a test sets, and the store a session's token lives in. */
function world() {
  const db = new Database(':memory:');
  for (const stmt of SESSION_REFRESH_DDL) db.exec(stmt);
  const sql: RegistrySql = {
    exec(query, ...params) {
      const stmt = db.prepare(query);
      if (stmt.reader) return stmt.all(...params) as Record<string, unknown>[];
      stmt.run(...params);
      return [];
    },
  };
  const store: RefreshStore = sqlRefreshStore(sql);
  const state = {
    seen: [] as Seen[],
    /** The refresh tokens the issuer still takes, and what each rotates to (or itself). */
    live: new Map<string, string>([['rt-1', 'rt-2']]),
    idTokenSub: 'ada',
    exchange: { status: 200, body: {} as Record<string, unknown> } as { status: number; body: unknown } | 'down',
    refresh: null as { status: number; body: unknown } | null,
    /** Run between the refresh request arriving and its answer — another isolate, say. */
    meanwhile: async () => {},
  };
  state.exchange = {
    status: 200,
    body: {
      access_token: 'delegated-at',
      issued_token_type: TOKEN_TYPE.accessToken,
      token_type: 'Bearer',
      expires_in: 300,
      scope: 'notes:read',
    },
  };
  const fetch: FetchLike = async (url, init) => {
    expect(url).toBe(TOKEN_ENDPOINT);
    const form = Object.fromEntries(new URLSearchParams(String(init?.body)));
    state.seen.push({ form, authorization: init?.headers?.['authorization'] ?? null });
    let answer: { status: number; body: unknown };
    if (form['grant_type'] === 'refresh_token') {
      await state.meanwhile();
      const next = state.live.get(form['refresh_token']!);
      state.live.delete(form['refresh_token']!);
      if (next) state.live.set(next, `${next}+`);
      answer = state.refresh ?? (next
        ? { status: 200, body: { id_token: await idTokenOf(state.idTokenSub), refresh_token: next, access_token: 'at' } }
        : { status: 400, body: { error: 'invalid_grant' } });
    } else {
      if (state.exchange === 'down') throw new TypeError('network down');
      answer = state.exchange;
    }
    return new Response(JSON.stringify(answer.body), { status: answer.status, headers: { 'content-type': 'application/json' } });
  };
  const deps: DelegatedTokenDeps = {
    issuer: ISSUER,
    clientId: 'todo-client',
    clientSecret: 'todo-secret',
    store,
    fetch,
    now: () => new Date(NOW),
  };
  return { state, deps, store };
}

let w: ReturnType<typeof world>;
beforeEach(async () => {
  w = world();
  await w.store.put('sid-1', { sub: 'ada', refreshToken: 'rt-1' });
});

const ask = (deps: DelegatedTokenDeps = w.deps) => delegatedToken(deps, { sid: 'sid-1', audience: 'notes-client', scope: ['notes:read', 'notes:write'] });
const failure = async (run: Promise<unknown>) => {
  const err = await run.then(() => null, (e: unknown) => e);
  expect(err).toBeInstanceOf(DelegatedTokenError);
  const { kind, step, code, message } = err as DelegatedTokenError;
  // No token, sent or received, ever rides an error.
  expect(message).not.toMatch(/rt-\d|delegated-at|eyJ/);
  return { kind, step, code };
};

describe('delegatedToken', () => {
  it('refreshes, keeps the rotated token, and exchanges the fresh id_token for the plugin', async () => {
    expect(await ask()).toEqual({ token: 'delegated-at', scope: ['notes:read'], expiresAt: new Date(NOW + 300_000).toISOString() });
    const [refresh, exchange] = w.state.seen;
    expect(refresh!.form).toEqual({ grant_type: 'refresh_token', refresh_token: 'rt-1', client_id: 'todo-client', client_secret: 'todo-secret' });
    expect(exchange!.form).toEqual({
      grant_type: TOKEN_EXCHANGE_GRANT_TYPE,
      subject_token: expect.stringMatching(/^eyJ/),
      subject_token_type: TOKEN_TYPE.idToken,
      requested_token_type: TOKEN_TYPE.accessToken,
      audience: 'notes-client',
      scope: 'notes:read notes:write',
      client_id: 'todo-client',
      client_secret: 'todo-secret',
    });
    expect(await w.store.get('sid-1')).toEqual({ sub: 'ada', refreshToken: 'rt-2' });
  });

  it.each([3600, undefined])('never claims a token outlives what a verifier takes (expires_in %s)', async (expiresIn) => {
    const body = { access_token: 'delegated-at', issued_token_type: TOKEN_TYPE.accessToken, token_type: 'Bearer', expires_in: expiresIn };
    w.state.exchange = { status: 200, body };
    expect((await ask()).expiresAt).toBe(new Date(NOW + 300_000).toISOString());
  });

  it('authenticates with client_secret_basic when the client is registered for it, never both', async () => {
    await ask({ ...w.deps, tokenEndpointAuth: 'client_secret_basic' });
    for (const { form, authorization } of w.state.seen) {
      expect(authorization).toBe(`Basic ${btoa('todo-client:todo-secret')}`);
      expect(form).not.toHaveProperty('client_secret');
    }
  });

  it('shares one refresh between calls for one session at once, so a rotated token is never spent twice', async () => {
    const [a, b] = await Promise.all([ask(), ask()]);
    expect([a.token, b.token]).toEqual(['delegated-at', 'delegated-at']);
    expect(w.state.seen.map((s) => s.form['grant_type'])).toEqual(['refresh_token', TOKEN_EXCHANGE_GRANT_TYPE, TOKEN_EXCHANGE_GRANT_TYPE]);
  });

  it('is reauth, with no request, for a session that keeps no refresh token', async () => {
    expect(await failure(delegatedToken(w.deps, { sid: 'no-such-session', audience: 'notes-client' }))).toEqual({
      kind: 'reauth',
      step: 'refresh',
      code: null,
    });
    expect(w.state.seen).toEqual([]);
  });

  it('is reauth, and forgets the row, when the issuer refuses the refresh token', async () => {
    w.state.live.clear();
    expect(await failure(ask())).toEqual({ kind: 'reauth', step: 'refresh', code: 'invalid_grant' });
    expect(await w.store.get('sid-1')).toBeNull();
  });

  it('tries the newer token once when another refresh rotated the row meanwhile', async () => {
    w.state.live = new Map([['rt-other', 'rt-3']]);
    w.state.meanwhile = async () => {
      w.state.meanwhile = async () => {};
      await w.store.put('sid-1', { sub: 'ada', refreshToken: 'rt-other' });
    };
    expect((await ask()).token).toBe('delegated-at');
    expect(w.state.seen.map((s) => s.form['refresh_token'])).toEqual(['rt-1', 'rt-other', undefined]);
    expect(await w.store.get('sid-1')).toEqual({ sub: 'ada', refreshToken: 'rt-3' });
  });

  it('is reauth, and forgets the row, when the refreshed token names someone else', async () => {
    w.state.idTokenSub = 'mallory';
    expect(await failure(ask())).toEqual({ kind: 'reauth', step: 'refresh', code: null });
    expect(await w.store.get('sid-1')).toBeNull();
    expect(w.state.seen).toHaveLength(1);
  });

  it('is refused, with the issuer code, when the exchange is refused, and keeps the session', async () => {
    w.state.exchange = { status: 400, body: { error: 'unauthorized_client', error_description: 'no peer grant' } };
    expect(await failure(ask())).toEqual({ kind: 'refused', step: 'exchange', code: 'unauthorized_client' });
    expect(await w.store.get('sid-1')).toEqual({ sub: 'ada', refreshToken: 'rt-2' });
  });

  it('is refused, not reauth, when the refresh is refused for another reason than the grant', async () => {
    w.state.refresh = { status: 401, body: { error: 'invalid_client' } };
    expect(await failure(ask())).toEqual({ kind: 'refused', step: 'refresh', code: 'invalid_client' });
    expect(await w.store.get('sid-1')).not.toBeNull();
  });

  it.each<[string, () => void, 'refresh' | 'exchange']>([
    ['the issuer is unreachable', () => void (w.state.exchange = 'down'), 'exchange'],
    ['the issuer fails', () => void (w.state.refresh = { status: 503, body: { error: 'temporarily_unavailable' } }), 'refresh'],
    ['the refresh brings no id_token', () => void (w.state.refresh = { status: 200, body: { access_token: 'at' } }), 'refresh'],
    ['the exchange answers no access token', () => void (w.state.exchange = { status: 200, body: { token_type: 'Bearer' } }), 'exchange'],
  ])('is unavailable when %s', async (_name, arrange, step) => {
    arrange();
    expect(await failure(ask())).toEqual({ kind: 'unavailable', step, code: null });
  });
});
