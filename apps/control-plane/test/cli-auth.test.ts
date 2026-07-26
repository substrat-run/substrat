import { SELF, env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { mintSession, pkceS256, verifySession, SESSION_COOKIE, type OidcEnv } from '@substrat-run/oidc-rp';
import { ulid } from '@substrat-run/kernel';

/**
 * The CLI login broker (cli-auth.ts) end-to-end, in workerd: a browser session →
 * PKCE code → exchange → a bearer session the deploy surface accepts, gated by the
 * SAME staff roster as the cookie. The security properties under test: the real token
 * never rides the loopback redirect (only a PKCE-bound code does), the exchange fails
 * without the matching verifier, and a bearer for a non-rostered user is refused.
 */

const oidcEnv = { SESSION_SECRET: env.SESSION_SECRET } as unknown as OidcEnv;
const STAFF_EMAIL = 'cli@substrat.run';
// A real ULID (Crockford base32 — no I/L/O/U), else the roster fails closed on it.
const STAFF_ACTOR = ulid();

/** Mint the signed session a logged-in browser would hold (the cookie the broker reads). */
function sessionFor(email: string): Promise<string> {
  return mintSession(oidcEnv, { id: ulid(), email, name: 'CLI Tester' });
}

async function seedRoster(email: string, actor: string): Promise<void> {
  await env.AUTH_DB.exec(
    'CREATE TABLE IF NOT EXISTS staff_actor (email TEXT PRIMARY KEY, actor TEXT NOT NULL, name TEXT, added_at TEXT NOT NULL, revoked_at TEXT)',
  );
  await env.AUTH_DB.prepare(
    'INSERT OR REPLACE INTO staff_actor (email, actor, name, added_at, revoked_at) VALUES (?, ?, NULL, ?, NULL)',
  )
    .bind(email, actor, new Date().toISOString())
    .run();
}

describe('CLI login broker', () => {
  beforeAll(() => seedRoster(STAFF_EMAIL, STAFF_ACTOR));

  it('bounces to browser login when there is no session', async () => {
    const res = await SELF.fetch(
      'https://cp.test/api/auth/cli?port=8976&state=st&challenge=ch',
      { redirect: 'manual' },
    );
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toMatch(/^\/api\/auth\/login\?returnTo=/);
  });

  it('fresh=1 skips a live session and forces an IdP re-prompt, without looping', async () => {
    // A live browser session that would normally short-circuit straight to a code…
    const session = await sessionFor(STAFF_EMAIL);
    const res = await SELF.fetch(
      'https://cp.test/api/auth/cli?port=8976&state=st&challenge=ch&fresh=1',
      { headers: { cookie: `${SESSION_COOKIE}=${session}` }, redirect: 'manual' },
    );
    // …is ignored: the broker bounces through browser login with prompt=login, and the
    // returnTo has `fresh` stripped so the post-login bounce uses the NEW session
    // instead of looping back into the forced re-prompt.
    expect(res.status).toBe(302);
    const loc = res.headers.get('location')!;
    expect(loc).toMatch(/^\/api\/auth\/login\?returnTo=/);
    expect(loc).toContain('prompt=login');
    const returnTo = new URL(loc, 'https://cp.test').searchParams.get('returnTo')!;
    expect(returnTo).not.toContain('fresh');
    expect(returnTo).toContain('port=8976');
  });

  it('logout?federated falls back to a local redirect when discovery is unavailable', async () => {
    // No OIDC_ISSUER in the test env, so the end-session discovery fails — the logout
    // must still clear the cookie and land locally, never 500.
    const res = await SELF.fetch('https://cp.test/api/auth/logout?federated', { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/');
    expect(res.headers.get('set-cookie')).toContain(`${SESSION_COOKIE}=;`);
  });

  it('completes the PKCE round-trip and issues a bearer the deploy surface accepts', async () => {
    const verifier = 'a-random-verifier-value-1234567890';
    const challenge = await pkceS256(verifier);
    const session = await sessionFor(STAFF_EMAIL);

    // 1. Authorize with a session cookie → 302 to the loopback with a code, NOT a token.
    const authRes = await SELF.fetch(
      `https://cp.test/api/auth/cli?port=8976&state=st123&challenge=${encodeURIComponent(challenge)}`,
      { headers: { cookie: `${SESSION_COOKIE}=${session}` }, redirect: 'manual' },
    );
    expect(authRes.status).toBe(302);
    const loc = new URL(authRes.headers.get('location')!);
    expect(loc.host).toBe('127.0.0.1:8976');
    expect(loc.searchParams.get('state')).toBe('st123');
    const code = loc.searchParams.get('code')!;
    expect(code).toBeTruthy();

    // 2. The code alone is useless — the wrong verifier is refused.
    const bad = await SELF.fetch('https://cp.test/api/auth/cli/token', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code, verifier: 'not-the-verifier' }),
    });
    expect(bad.status).toBe(400);

    // 3. Exchange code + verifier → the session token (over the direct POST, not a URL).
    const exch = await SELF.fetch('https://cp.test/api/auth/cli/token', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code, verifier }),
    });
    expect(exch.status).toBe(200);
    const { token } = (await exch.json()) as { token: string };
    expect(token).toBeTruthy();
    // (diagnostic) the issued token must itself verify to the rostered email.
    expect(await verifySession(oidcEnv, token)).toMatchObject({ email: STAFF_EMAIL });

    // 4. The bearer authenticates against the deploy/admin surface, via the roster.
    const authed = await SELF.fetch('https://cp.test/api/tenants', {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(authed.status).toBe(200);
  });

  it('refuses a bearer for a user who is not on the roster (fail closed)', async () => {
    const session = await sessionFor('stranger@example.com');
    const verifier = 'another-verifier-abcdefghijklmnop';
    const challenge = await pkceS256(verifier);
    const authRes = await SELF.fetch(
      `https://cp.test/api/auth/cli?port=8976&state=s&challenge=${encodeURIComponent(challenge)}`,
      { headers: { cookie: `${SESSION_COOKIE}=${session}` }, redirect: 'manual' },
    );
    const code = new URL(authRes.headers.get('location')!).searchParams.get('code')!;
    const { token } = (await (
      await SELF.fetch('https://cp.test/api/auth/cli/token', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code, verifier }),
      })
    ).json()) as { token: string };

    // A valid, correctly-exchanged session — but the email is not rostered, so the
    // platform-actor auth fails closed. Authentication proved who; the roster is who *may*.
    const res = await SELF.fetch('https://cp.test/api/tenants', {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(401);
  });
});
