import { describe, expect, it } from 'vitest';
import { emailRefusedAsIdentifier } from '../src/email-identifier.js';

/**
 * `OIDC_REQUIRE_EMAIL_VERIFIED` on the dashboard (#1359). One predicate decides the three
 * places the session's address becomes an identity — `POST /api/invites/accept` (403),
 * the legacy roster heal (seeds nothing) and `/api/support/identity` (`{ desk: null }`) —
 * so holding it here holds all three. Off, nothing is refused. On, it fails closed:
 * `false` and an absent claim are both refused, because an issuer saying nothing cannot
 * be told apart from one saying "unverified".
 */

const CLAIMS = [
  ['true', true],
  ['false', false],
  ['absent', undefined],
] as const;

describe('emailRefusedAsIdentifier', () => {
  it.each(CLAIMS)('off: a session whose claim is %s is not refused', (_label, emailVerified) => {
    expect(emailRefusedAsIdentifier({}, { emailVerified })).toBe(false);
    // Only the exact spelling turns it on — anything else is still off.
    for (const flag of ['1', 'TRUE', 'yes', 'false', '']) {
      expect(emailRefusedAsIdentifier({ OIDC_REQUIRE_EMAIL_VERIFIED: flag }, { emailVerified })).toBe(false);
    }
  });

  it('on: a verified address is not refused', () => {
    expect(emailRefusedAsIdentifier({ OIDC_REQUIRE_EMAIL_VERIFIED: 'true' }, { emailVerified: true })).toBe(false);
  });

  it('on: an address the issuer called unverified is refused', () => {
    expect(emailRefusedAsIdentifier({ OIDC_REQUIRE_EMAIL_VERIFIED: 'true' }, { emailVerified: false })).toBe(true);
  });

  it('on: an absent claim is refused, not trusted', () => {
    expect(emailRefusedAsIdentifier({ OIDC_REQUIRE_EMAIL_VERIFIED: 'true' }, {})).toBe(true);
  });
});
