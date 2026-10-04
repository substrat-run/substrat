import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `identifyEmail` (#1359): whether a session's address may be used as WHO someone is. One
 * function decides it for the control plane's staff roster, the builder studio's staff
 * check, and the dashboard's invite accept, roster heal and support identity — so holding
 * it here holds all of them.
 *
 * Required by default, with nothing configured. `false` and an absent claim are both
 * refused, and told apart, because they ask the person for different things. The one way
 * round it is `OIDC_ALLOW_UNVERIFIED_EMAIL="true"`, and it is loud.
 *
 * The module is re-imported per test: the opt-out announces itself once per isolate, and
 * the "once" is part of what is under test.
 */

const EMAIL = 'staff@acme.test';
const ON = { OIDC_ALLOW_UNVERIFIED_EMAIL: 'true' };

let mod: typeof import('../src/email-identity.js');
let warn: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  vi.resetModules();
  mod = await import('../src/email-identity.js');
  warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => warn.mockRestore());

const user = (emailVerified: boolean | undefined) => ({ id: 'sub-1', email: EMAIL, emailVerified });

describe('by default — nothing configured', () => {
  it('a verified address identifies its holder', () => {
    expect(mod.identifyEmail({}, user(true))).toEqual({ email: EMAIL });
  });

  it('an address the issuer called unverified is refused as `unverified`', () => {
    expect(mod.identifyEmail({}, user(false))).toEqual({ email: null, refused: 'unverified' });
  });

  it('an absent claim is refused as `unasserted`, not trusted', () => {
    // What every session minted before the claim was carried looks like (#1373).
    expect(mod.identifyEmail({}, user(undefined))).toEqual({ email: null, refused: 'unasserted' });
  });

  it('no address is never an identifier, whatever the claim says', () => {
    for (const email of [undefined, '']) {
      const noAddress = { id: 'sub-1', email, emailVerified: true };
      expect(mod.identifyEmail({}, noAddress)).toEqual({ email: null, refused: 'no-email' });
      expect(mod.identifyEmail(ON, noAddress)).toEqual({ email: null, refused: 'no-email' });
    }
  });

  it('logs nothing — refusing is the normal case, not an event', () => {
    mod.identifyEmail({}, user(false));
    mod.identifyEmail({}, user(undefined));
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('the break-glass: OIDC_ALLOW_UNVERIFIED_EMAIL', () => {
  it.each([
    ['false', false],
    ['absent', undefined],
  ] as const)('admits a %s claim, and says it did', (_label, emailVerified) => {
    expect(mod.identifyEmail(ON, user(emailVerified))).toEqual({ email: EMAIL });
    const lines = warn.mock.calls.map((c) => String(c[0]));
    expect(lines.some((l) => l.includes('OIDC_ALLOW_UNVERIFIED_EMAIL=true'))).toBe(true);
    expect(lines.some((l) => l.includes('admitted') && l.includes('sub-1'))).toBe(true);
  });

  it('announces itself once per isolate, and logs every admission', () => {
    mod.identifyEmail(ON, user(false));
    mod.identifyEmail(ON, user(undefined));
    const lines = warn.mock.calls.map((c) => String(c[0]));
    expect(lines.filter((l) => l.includes('is accepted as an identifier'))).toHaveLength(1);
    expect(lines.filter((l) => l.includes('admitted'))).toHaveLength(2);
  });

  it('never writes the address it admitted into the log', () => {
    mod.identifyEmail(ON, user(false));
    for (const call of warn.mock.calls) expect(String(call[0])).not.toContain(EMAIL);
  });

  it('a verified address does not need it, and is not logged', () => {
    expect(mod.identifyEmail(ON, user(true))).toEqual({ email: EMAIL });
    expect(warn).not.toHaveBeenCalled();
  });

  it('only the exact spelling turns it on', () => {
    for (const flag of ['1', 'TRUE', 'yes', 'false', '']) {
      expect(mod.identifyEmail({ OIDC_ALLOW_UNVERIFIED_EMAIL: flag }, user(false)).email).toBeNull();
    }
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('emailRefusalMessage', () => {
  it('asks a session that predates the claim to sign in again', () => {
    expect(mod.emailRefusalMessage('unasserted')).toMatch(/sign in again/);
  });

  it('asks an unverified address to be verified', () => {
    expect(mod.emailRefusalMessage('unverified')).toMatch(/not verified/);
  });
});

describe('emailRefusalOf — the rule alone', () => {
  it('classifies without the break-glass and without logging', () => {
    expect(mod.emailRefusalOf({ email: EMAIL, emailVerified: true })).toBeNull();
    expect(mod.emailRefusalOf({ email: EMAIL, emailVerified: false })).toBe('unverified');
    expect(mod.emailRefusalOf({ email: EMAIL })).toBe('unasserted');
    expect(mod.emailRefusalOf({ emailVerified: true })).toBe('no-email');
    expect(warn).not.toHaveBeenCalled();
  });
});
