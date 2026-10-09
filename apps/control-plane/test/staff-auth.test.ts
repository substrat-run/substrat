import { SELF, env } from 'cloudflare:test';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { mintSession, SESSION_COOKIE, type OidcEnv } from '@substrat-run/oidc-rp';
import { ulid } from '@substrat-run/kernel';
import { oidcStaffBearerReader, oidcStaffSessionReader, staffRefusalOf, type StaffAuthEnv } from '../src/staff-auth.js';

/**
 * The staff roster keys on the session's email, so only an address the issuer asserted
 * `email_verified: true` about counts (#1359) — by default, with nothing configured.
 * `false` and an absent claim are both refused. Both readers (cookie and CLI bearer) are
 * held to it, since either one reaches the same roster. `OIDC_ALLOW_UNVERIFIED_EMAIL` is
 * the break-glass, and it logs.
 */

const EMAIL = 'verified-staff@substrat.run';
const oidcEnv = { SESSION_SECRET: env.SESSION_SECRET } as unknown as OidcEnv;
const ALLOW: StaffAuthEnv = { ...oidcEnv, OIDC_ALLOW_UNVERIFIED_EMAIL: 'true' };

function sessionFor(emailVerified: boolean | undefined): Promise<string> {
  return mintSession(oidcEnv, { id: ulid(), email: EMAIL, emailVerified });
}

const cookie = (t: string) => new Headers({ cookie: `${SESSION_COOKIE}=${t}` });
const bearer = (t: string) => new Headers({ authorization: `Bearer ${t}` });

const TRANSPORTS = [
  ['cookie', cookie],
  ['bearer', bearer],
] as const;

const READERS = [
  ['cookie', oidcStaffSessionReader, cookie],
  ['bearer', oidcStaffBearerReader, bearer],
] as const;

let warn: MockInstance<typeof console.warn>;
beforeEach(() => {
  warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => warn.mockRestore());

describe.each(READERS)('staff %s reader', (_, reader, headersFor) => {
  it.each([
    ['true', true, { email: EMAIL }],
    ['false', false, null],
    ['absent', undefined, null],
  ] as const)('by default: a claim that is %s resolves to %o', async (_label, verified, expected) => {
    expect(await reader(oidcEnv)(headersFor(await sessionFor(verified)))).toEqual(expected);
  });

  it.each([
    ['false', false],
    ['absent', undefined],
  ] as const)('the break-glass admits a %s claim, and logs that it did', async (_label, verified) => {
    expect(await reader(ALLOW)(headersFor(await sessionFor(verified)))).toEqual({ email: EMAIL });
    expect(warn.mock.calls.some((c) => String(c[0]).includes('admitted'))).toBe(true);
  });

  it('no session is still no identity', async () => {
    expect(await reader(oidcEnv)(new Headers())).toBeNull();
    expect(await reader(ALLOW)(new Headers())).toBeNull();
  });
});

describe('staffRefusalOf — the sentence a refused session is shown', () => {
  it.each(TRANSPORTS)('names "sign in again" for a %s session that predates the claim', async (_, headersFor) => {
    expect(await staffRefusalOf(oidcEnv, headersFor(await sessionFor(undefined)))).toMatch(/sign in again/);
  });

  it('names verification for an address the issuer called unverified', async () => {
    expect(await staffRefusalOf(oidcEnv, cookie(await sessionFor(false)))).toMatch(/not verified/);
  });

  it('says nothing for a verified session, for none at all, or with the break-glass on', async () => {
    expect(await staffRefusalOf(oidcEnv, cookie(await sessionFor(true)))).toBeNull();
    expect(await staffRefusalOf(oidcEnv, new Headers())).toBeNull();
    expect(await staffRefusalOf(ALLOW, cookie(await sessionFor(undefined)))).toBeNull();
  });
});

/**
 * The same, end to end in workerd, against a ROSTERED address — the case the issue is
 * about: a session carrying an address that is on the roster, where only the claim decides.
 */
describe('a rostered address, through the deployed API', () => {
  beforeAll(async () => {
    await env.AUTH_DB.exec(
      'CREATE TABLE IF NOT EXISTS staff_actor (email TEXT PRIMARY KEY, actor TEXT NOT NULL, name TEXT, added_at TEXT NOT NULL, added_by TEXT, revoked_at TEXT)',
    );
    await env.AUTH_DB.prepare(
      'INSERT OR REPLACE INTO staff_actor (email, actor, name, added_at, revoked_at) VALUES (?, ?, NULL, ?, NULL)',
    )
      .bind(EMAIL, ulid(), new Date().toISOString())
      .run();
  });

  const tenants = (headers: Headers) => SELF.fetch('https://cp.test/api/tenants', { headers });

  it.each(TRANSPORTS)('a verified %s session acts as staff', async (_, headersFor) => {
    expect((await tenants(headersFor(await sessionFor(true)))).status).toBe(200);
  });

  describe.each(TRANSPORTS)('a %s session', (_, headersFor) => {
    it.each([
      ['unverified', false, /not verified/],
      ['with no claim', undefined, /sign in again/],
    ] as const)('%s is refused, and told what to do', async (_label, verified, says) => {
      const res = await tenants(headersFor(await sessionFor(verified)));
      expect(res.status).toBe(401);
      expect(((await res.json()) as { error: string }).error).toMatch(says);
    });
  });

  it('a request with no session keeps the plain 401', async () => {
    const res = await tenants(new Headers());
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'unauthenticated' });
  });
});
