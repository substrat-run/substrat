import { describe, expect, it } from 'vitest';
import { identifyingEmailOf } from '../src/email-identifier.js';

/**
 * `OIDC_REQUIRE_EMAIL_VERIFIED` on the dashboard (#1359). One function decides the three
 * places the session's address becomes an identity — `POST /api/invites/accept` (403 on
 * null), the legacy roster heal (seeds nothing on null) and `/api/support/identity`
 * (`{ desk: null }` on null) — so holding it here holds all three. Off, any address the
 * session carries is returned. On, it fails closed: `false` and an absent claim both
 * resolve to null, because an issuer saying nothing cannot be told apart from one saying
 * "unverified".
 */

const EMAIL = 'owner@acme.test';
const ON = { OIDC_REQUIRE_EMAIL_VERIFIED: 'true' };

const CLAIMS = [
  ['true', true],
  ['false', false],
  ['absent', undefined],
] as const;

describe('identifyingEmailOf', () => {
  it.each(CLAIMS)('off: a session whose claim is %s still resolves to its address', (_label, emailVerified) => {
    expect(identifyingEmailOf({}, { email: EMAIL, emailVerified })).toBe(EMAIL);
    // Only the exact spelling turns it on — anything else is still off.
    for (const flag of ['1', 'TRUE', 'yes', 'false', '']) {
      expect(identifyingEmailOf({ OIDC_REQUIRE_EMAIL_VERIFIED: flag }, { email: EMAIL, emailVerified })).toBe(EMAIL);
    }
  });

  it('on: a verified address resolves', () => {
    expect(identifyingEmailOf(ON, { email: EMAIL, emailVerified: true })).toBe(EMAIL);
  });

  it('on: an address the issuer called unverified resolves to null', () => {
    expect(identifyingEmailOf(ON, { email: EMAIL, emailVerified: false })).toBeNull();
  });

  it('on: an absent claim is refused, not trusted', () => {
    expect(identifyingEmailOf(ON, { email: EMAIL })).toBeNull();
  });

  it('on or off: a session with no address is never an identifier, whatever it claims', () => {
    for (const email of [undefined, '']) {
      expect(identifyingEmailOf({}, { email, emailVerified: true })).toBeNull();
      expect(identifyingEmailOf(ON, { email, emailVerified: true })).toBeNull();
    }
  });
});
