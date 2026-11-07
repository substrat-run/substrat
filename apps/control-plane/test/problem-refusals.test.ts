import { SELF, createExecutionContext, env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { DEV_ACTOR_HEADER } from '@substrat-run/control-plane-api';
import { PROBLEM_CONTENT_TYPE, PROBLEM_TYPE_BLANK, problem, problemTypeFor, type ErrorCode } from '@substrat-run/contracts';
import { ulid } from '@substrat-run/kernel';
import { mintSession, SESSION_COOKIE, pkceS256, type OidcEnv } from '@substrat-run/oidc-rp';
import worker, { RelayGateway } from '../src/worker.js';
import { ConnectionRelayError } from '@substrat-run/control-plane-api';
import { refuseRelayed } from '../src/problem.js';

/**
 * #113: the worker's OWN routes (the staff roster, the builder lookup, the support identity,
 * the `/api` auth rewrite, the CLI login broker) answer a refusal as an RFC 9457 problem
 * document — the media type, a body the published schema accepts, and the `error` sentence
 * a client read before, unchanged. `control-plane-api`'s routes are held by its own suite.
 *
 * Each refusal is paired with the success of the same route (see the twins below): a
 * helper that stamped the problem media type on every answer would pass the refusals alone.
 */
const ACTOR = ulid();
const authed = { [DEV_ACTOR_HEADER]: ACTOR, 'content-type': 'application/json' };
const oidcEnv = { SESSION_SECRET: env.SESSION_SECRET } as unknown as OidcEnv;

async function expectProblem(res: Response, status: number, detail: string, code?: ErrorCode) {
  expect(res.status).toBe(status);
  expect(res.headers.get('content-type')).toBe(PROBLEM_CONTENT_TYPE);
  const body = (await res.json()) as Record<string, unknown>;
  expect(problem.safeParse(body).success).toBe(true);
  expect(body.status).toBe(status);
  expect(body.detail).toBe(detail);
  // The deprecated duplicate every client of these routes read before.
  expect(body.error).toBe(detail);
  expect(body.type).toBe(code ? problemTypeFor(code) : PROBLEM_TYPE_BLANK);
  if (code) expect(body.code).toBe(code);
}

const post = (path: string, body: unknown, headers: Record<string, string> = authed) =>
  SELF.fetch(`https://cp.test${path}`, { method: 'POST', headers, body: JSON.stringify(body) });

describe('members surface refusals', () => {
  beforeAll(async () => {
    await env.AUTH_DB.exec(
      'CREATE TABLE IF NOT EXISTS staff_actor (email TEXT PRIMARY KEY, actor TEXT NOT NULL, name TEXT, added_at TEXT NOT NULL, added_by TEXT, revoked_at TEXT)',
    );
  });

  it('401 without a platform actor', async () => {
    await expectProblem(await SELF.fetch('https://cp.test/api/members'), 401, 'unauthenticated', 'unauthenticated');
  });

  it('501 when no roster store is bound — about:blank, no taxonomy code', async () => {
    const res = await worker.fetch(new Request('https://cp.test/api/members', { headers: authed }), {
      ...env,
      AUTH_DB: undefined,
    } as never);
    await expectProblem(res, 501, 'no roster store bound');
  });

  it('400 on a malformed email, grant and revoke alike', async () => {
    await expectProblem(await post('/api/members/staff', { email: 'nope' }), 400, 'a valid email is required', 'validation_failed');
    await expectProblem(await post('/api/members/staff/revoke', {}), 400, 'a valid email is required', 'validation_failed');
  });

  it('404 revoking someone who is not an active member', async () => {
    await expectProblem(
      await post('/api/members/staff/revoke', { email: 'ghost@substrat.example' }),
      404,
      'ghost@substrat.example is not an active staff member',
      'not_found',
    );
  });

  it('409 revoking the last active member; the success twins stay plain JSON', async () => {
    // The roster is shared across this file's tests, so make the member under test the only
    // active one by tombstoning every other row first.
    await env.AUTH_DB.prepare('UPDATE staff_actor SET revoked_at = ? WHERE revoked_at IS NULL')
      .bind(new Date().toISOString())
      .run();
    const grant = await post('/api/members/staff', { email: 'only@substrat.example' });
    expect(grant.status).toBe(200);
    expect(grant.headers.get('content-type')).toContain('application/json');
    expect(grant.headers.get('content-type')).not.toContain('problem');

    await expectProblem(
      await post('/api/members/staff/revoke', { email: 'only@substrat.example' }),
      409,
      'cannot revoke the last active staff member',
      'conflict',
    );

    // A second member makes the same revoke succeed — the refusal above was the guard, not the route.
    await post('/api/members/staff', { email: 'second@substrat.example' });
    const ok = await post('/api/members/staff/revoke', { email: 'only@substrat.example' });
    expect(ok.status).toBe(200);
    expect(ok.headers.get('content-type')).not.toContain('problem');
  });
});

describe('POST /internal/builder/identity-tenants refusals', () => {
  const lookup = (body: unknown, headers: Record<string, string>) =>
    post('/internal/builder/identity-tenants', body, { 'content-type': 'application/json', ...headers });

  it('403 without the service token', async () => {
    await expectProblem(await lookup({ externalId: 'sub' }, {}), 403, 'service token required', 'forbidden');
  });

  it('400 without an externalId; with one it answers plain JSON', async () => {
    const token = { 'x-service-token': 'test-service-token' };
    await expectProblem(
      await lookup({}, token),
      400,
      'externalId (the OIDC subject) is required',
      'validation_failed',
    );
    const ok = await lookup({ externalId: 'sub' }, token);
    expect(ok.status).toBe(200);
    expect(ok.headers.get('content-type')).not.toContain('problem');
  });
});

/**
 * The relay routes (#113 remainder, PR A): a refusal the route decided carries its code; one a
 * relay's error class threw is `about:blank` by its status, since those classes name no code
 * yet. `error` stays the sentence the vertical-host and email readers parse today.
 */
describe('the /internal relay routes answer problem documents', () => {
  const SECRET = 'problem-refusals-relay-secret';
  const relayEnv = (over: Record<string, unknown> = {}) => ({ ...env, PLATFORM_SECRET: SECRET, ...over }) as never;
  const relay = (path: string, body: unknown, over: Record<string, unknown> = {}, headers: Record<string, string> = { 'x-substrat-platform': SECRET }) =>
    worker.fetch(
      new Request(`https://cp.test${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) }),
      relayEnv(over),
    );
  const ids = { tenantId: ulid(), scopeId: ulid() };

  it('403 forbidden on every relay without the platform credential', async () => {
    for (const path of [
      '/internal/drain-scope',
      '/internal/email/send',
      '/internal/connections/upsert',
      '/internal/connections/bind',
      '/internal/connections/connect-url',
      '/internal/connections/connect-links',
      '/internal/mail-in/address',
    ]) {
      const res = await relay(path, ids, {}, {});
      expect(res.status, path).toBe(403);
      expect(res.headers.get('content-type'), path).toBe(PROBLEM_CONTENT_TYPE);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.code, path).toBe('forbidden');
      expect(body.error, path).toBe(body.detail);
    }
  });

  it('a refusal the route decided carries its code; the drain twin stays plain JSON', async () => {
    await expectProblem(await relay('/internal/drain-scope', {}), 400, 'tenantId and scopeId (ULIDs) are required', 'validation_failed');
    await expectProblem(
      await relay('/internal/email/send', ids),
      400,
      'tenantId, scopeId (ULIDs) and {to, subject, html, text} are required',
      'validation_failed',
    );
    await expectProblem(
      await relay('/internal/mail-in/address', { ...ids, action: 'get' }),
      403,
      "a mail-in address needs a proven caller — call the relay from the vertical's worker, not from inside a Durable Object",
      'forbidden',
    );
    const ok = await relay('/internal/drain-scope', { ...ids, platformRequests: false });
    expect(ok.status).toBe(200);
    expect(ok.headers.get('content-type')).not.toContain('problem');
  });

  it("a relay class's refusal carries the code its status does, with the sentence it always had", async () => {
    const res = await relay('/internal/connections/upsert', {});
    expect(res.status).toBe(400);
    expect(res.headers.get('content-type')).toBe(PROBLEM_CONTENT_TYPE);
    const body = (await res.json()) as Record<string, unknown>;
    expect(problem.safeParse(body).success).toBe(true);
    expect(body).toMatchObject({
      type: problemTypeFor('validation_failed'),
      code: 'validation_failed',
      detail: expect.stringMatching(/^invalid connection relay request: /),
    });
    expect(body.error).toBe(body.detail);
  });

  it('a relay status the catalog has no code at stays about:blank, the probe riding beside it', async () => {
    const probe = { ok: false, detail: 'the provider refused the token' };
    const res = refuseRelayed(new ConnectionRelayError('the credential did not pass its probe', 422, probe as never), { probe });
    expect(res.status).toBe(422);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ type: PROBLEM_TYPE_BLANK, status: 422, error: 'the credential did not pass its probe', probe });
    expect(body.code).toBeUndefined();
  });

  it('the relay gateway refuses an unreadable caller as validation_failed', async () => {
    const res = await new RelayGateway(createExecutionContext(), relayEnv()).fetch(
      new Request('https://cp.test/internal/email/send', { method: 'POST', headers: { 'x-substrat-platform': SECRET }, body: '{}' }),
    );
    await expectProblem(res, 400, 'relay gateway: the caller is missing or unreadable', 'validation_failed');
  });

  it('a throw no route caught is internal with no detail, never a text 500', async () => {
    // No directory binding: the email relay's scope read throws something nobody typed.
    const res = await relay('/internal/email/send', { ...ids, to: 'a@example.com', subject: 's', html: '<p>h</p>', text: 'h' }, { CONTROL_PLANE: undefined });
    expect(res.status).toBe(500);
    expect(res.headers.get('content-type')).toBe(PROBLEM_CONTENT_TYPE);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ type: problemTypeFor('internal'), code: 'internal' });
    expect(body.detail).toBeUndefined();
  });
});

describe('GET /api/support/identity', () => {
  const withDesk = { ...env, SUPPORT_DESK_ORIGIN: 'https://desk.test', SUPPORT_WIDGET_SECRET: 'desk-secret' } as never;

  it('401 without a staff session', async () => {
    const res = await worker.fetch(new Request('https://cp.test/api/support/identity'), withDesk);
    await expectProblem(res, 401, 'unauthenticated', 'unauthenticated');
  });

  it('no desk configured is still an unremarkable { desk: null }', async () => {
    const res = await worker.fetch(new Request('https://cp.test/api/support/identity'), {
      ...env,
      SUPPORT_DESK_ORIGIN: undefined,
    } as never);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ desk: null });
  });
});

describe('the /api 401 rewrite and the CLI login broker', () => {
  it('a session the roster refused is answered as a problem naming why', async () => {
    const stale = await mintSession(oidcEnv, { id: ulid(), email: 'stale@substrat.run' });
    const res = await SELF.fetch('https://cp.test/api/tenants', {
      headers: { cookie: `${SESSION_COOKIE}=${stale}` },
    });
    expect(res.status).toBe(401);
    expect(res.headers.get('content-type')).toBe(PROBLEM_CONTENT_TYPE);
    const body = (await res.json()) as Record<string, unknown>;
    expect(problem.safeParse(body).success).toBe(true);
    expect(body.code).toBe('unauthenticated');
    expect(body.detail).toMatch(/sign in again/);
    expect(body.error).toBe(body.detail);
  });

  const exchange = (body: unknown) => post('/api/auth/cli/token', body, { 'content-type': 'application/json' });

  it('400 on a missing code or verifier', async () => {
    await expectProblem(await exchange({}), 400, 'missing code or verifier', 'validation_failed');
  });

  it('400 on an invalid code', async () => {
    await expectProblem(
      await exchange({ code: 'garbage', verifier: 'v' }),
      400,
      'invalid or expired code',
      'validation_failed',
    );
  });

  it('400 on a wrong verifier; the right one exchanges for a plain JSON token', async () => {
    const session = await mintSession(oidcEnv, { id: ulid(), email: 'cli@substrat.run', emailVerified: true });
    const verifier = 'a-random-verifier-value-1234567890';
    const auth = await SELF.fetch(
      `https://cp.test/api/auth/cli?port=8976&state=s&challenge=${encodeURIComponent(await pkceS256(verifier))}`,
      { headers: { cookie: `${SESSION_COOKIE}=${session}` }, redirect: 'manual' },
    );
    const code = new URL(auth.headers.get('location')!).searchParams.get('code')!;
    await expectProblem(await exchange({ code, verifier: 'not-it' }), 400, 'pkce verification failed', 'validation_failed');
    const ok = await exchange({ code, verifier });
    expect(ok.status).toBe(200);
    expect(ok.headers.get('content-type')).toContain('application/json');
    expect(ok.headers.get('content-type')).not.toContain('problem');
  });
});
