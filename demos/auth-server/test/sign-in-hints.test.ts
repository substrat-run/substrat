import { describe, expect, it } from 'vitest';
import { entryScreen, signInHintsOf } from '../app/src/auth/sign-in-hints.js';

/**
 * What the hand-off screens make of a relying party's hints (#3345). The issuer half (the hints
 * being signed into the query, `prompt=create` becoming `screen_hint=signup`) is in
 * `signup.test.ts`; this is the screen's half, which no server test reaches.
 */
const signed = (extra: Record<string, string>): string =>
  new URLSearchParams({ client_id: 'client-a', response_type: 'code', ...extra, sig: 'signature' }).toString();

describe('the hints a signed authorize query carries', () => {
  it.each([
    ['an address', 'invitee@acme.test', 'invitee@acme.test'],
    ['an address with spaces around it', '  invitee@acme.test ', 'invitee@acme.test'],
    ['a subject id, not an address', 'usr_01JABCDEF', null],
    ['markup', '<b>x</b>@acme.test', null],
    ['no domain dot', 'invitee@localhost', null],
    ['two addresses', 'a@acme.test b@acme.test', null],
  ])('pre-fills %s only when it is one', (_label, hint, expected) => {
    expect(signInHintsOf(signed({ login_hint: hint })).loginHint).toBe(expected);
  });

  it('opens sign-up for screen_hint=signup alone, and reads nothing without a pending request', () => {
    expect(signInHintsOf(signed({ screen_hint: 'signup' }))).toEqual({ loginHint: null, signUp: true });
    expect(signInHintsOf(signed({ screen_hint: 'login' })).signUp).toBe(false);
    expect(signInHintsOf(null)).toEqual({ loginHint: null, signUp: false });
  });
});

describe('the screen a person lands on', () => {
  it.each([
    ['sign-up asked and open', { askedSignUp: true, signUpOpen: true, socialError: false }, 'signup'],
    ['sign-up asked and closed: sign-in, saying so', { askedSignUp: true, signUpOpen: false, socialError: false }, 'closed'],
    ['a refused social sign-in: sign-in, which shows why', { askedSignUp: true, signUpOpen: true, socialError: true }, 'signin'],
    ['nothing asked', { askedSignUp: false, signUpOpen: true, socialError: false }, 'signin'],
  ] as const)('%s', (_label, input, expected) => {
    expect(entryScreen(input)).toBe(expected);
  });
});
