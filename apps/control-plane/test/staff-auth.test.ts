import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { mintSession, SESSION_COOKIE, type OidcEnv } from '@substrat-run/oidc-rp';
import { ulid } from '@substrat-run/kernel';
import { oidcStaffBearerReader, oidcStaffSessionReader, type StaffAuthEnv } from '../src/staff-auth.js';

/**
 * `OIDC_REQUIRE_EMAIL_VERIFIED` (#1359): the staff roster keys on the session's email, so
 * with the gate on only an address the issuer asserted verified counts. Off, nothing
 * changes. On, it fails closed — `false` and an absent claim are both refused, because an
 * issuer saying nothing cannot be told apart from one saying "unverified". Both readers
 * (cookie and CLI bearer) are held to it, since either one reaches the same roster.
 */

const EMAIL = 'staff@substrat.run';
const oidcEnv = { SESSION_SECRET: env.SESSION_SECRET } as unknown as OidcEnv;

function envWith(flag?: string): StaffAuthEnv {
  return { ...oidcEnv, OIDC_REQUIRE_EMAIL_VERIFIED: flag };
}

function sessionFor(emailVerified: boolean | undefined): Promise<string> {
  return mintSession(oidcEnv, { id: ulid(), email: EMAIL, emailVerified });
}

const READERS = [
  ['cookie', oidcStaffSessionReader, (t: string) => new Headers({ cookie: `${SESSION_COOKIE}=${t}` })],
  ['bearer', oidcStaffBearerReader, (t: string) => new Headers({ authorization: `Bearer ${t}` })],
] as const;

describe.each(READERS)('staff %s reader and OIDC_REQUIRE_EMAIL_VERIFIED', (_, reader, headersFor) => {
  it.each([
    ['true', true],
    ['false', false],
    ['absent', undefined],
  ] as const)('off: a session whose claim is %s still resolves', async (_label, verified) => {
    const headers = headersFor(await sessionFor(verified));
    expect(await reader(envWith())(headers)).toEqual({ email: EMAIL });
    // Only the exact spelling turns it on — anything else is still off.
    expect(await reader(envWith('1'))(headers)).toEqual({ email: EMAIL });
  });

  it('on: a verified address resolves', async () => {
    const headers = headersFor(await sessionFor(true));
    expect(await reader(envWith('true'))(headers)).toEqual({ email: EMAIL });
  });

  it('on: an address the issuer called unverified resolves to no staff identity', async () => {
    const headers = headersFor(await sessionFor(false));
    expect(await reader(envWith('true'))(headers)).toBeNull();
  });

  it('on: an absent claim is refused, not trusted', async () => {
    const headers = headersFor(await sessionFor(undefined));
    expect(await reader(envWith('true'))(headers)).toBeNull();
  });

  it('on or off: no session is still no identity', async () => {
    expect(await reader(envWith('true'))(new Headers())).toBeNull();
    expect(await reader(envWith())(new Headers())).toBeNull();
  });
});
