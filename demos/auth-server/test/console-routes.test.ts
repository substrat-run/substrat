import { describe, expect, it } from 'vitest';
// The `.js` extension is the one `nodenext` insists on for a relative import; vitest resolves
// it back to the `.ts` beside it, which is the file that actually exists. `paths.ts` rather than
// `routes.ts` on purpose: the latter pulls in `@substrat-run/ui`, a bundler-resolved TSX package
// this program cannot compile, and the routing that matters here is deliberately not in it.
import {
  BANKID_SETTINGS_PATH,
  applicationDetailId,
  detailTarget,
  isBankIdSettingsPath,
  providerDetailId,
  userDetailId,
} from '../app/src/console/paths.js';

/**
 * The console's dynamic routing, which is browser code with a server-shaped duty. `returnTarget`
 * hands its answer to an upstream provider as `callbackURL` and reads it back out of a redirect,
 * and `detailTarget` is the half of it that judges a path nobody wrote down in advance — so the
 * parsers below are the whole of what decides whether a pasted address bar can ride out of
 * Google and back into this issuer as somewhere else entirely.
 *
 * Tested here rather than in the app: `demos/auth-server/app` has no suite of its own.
 */
describe('console routes', () => {
  it('keeps a user detail, an application detail and a provider detail', () => {
    expect(detailTarget('/users/nAxYqEBu1TjNldd5DZbCEmXV2mDhRfCz')).toBe(
      '/users/nAxYqEBu1TjNldd5DZbCEmXV2mDhRfCz',
    );
    // The console's own row is the literal `console`; a self-registered relying party may hold
    // a UUID. Both are places, and both go through the wider alphabet.
    expect(detailTarget('/applications/console')).toBe('/applications/console');
    expect(detailTarget('/applications/2f1c9a30-6d4b-4c19-9c0e-9b1a7f2e4d55')).toBe(
      '/applications/2f1c9a30-6d4b-4c19-9c0e-9b1a7f2e4d55',
    );
    // A provider id is a catalogue slug or one an operator named a generic OIDC upstream, and
    // this is what makes `returnTarget` keep it: a pasted `/providers/acme-sso` that survives
    // the sign-in it triggers is the whole reason the screen has a URL.
    expect(detailTarget('/providers/google')).toBe('/providers/google');
    expect(detailTarget('/providers/acme-sso')).toBe('/providers/acme-sso');
  });

  it('keeps BankID’s configuration screen, which is a path rather than an id', () => {
    // The one detail screen with nothing to identify — there is a single BankID configuration
    // per issuer, no client id and no registered redirect URI. It is still the link an operator
    // pastes, and still what a stale session's sign-in must not throw away.
    expect(detailTarget('/bankid/settings')).toBe(BANKID_SETTINGS_PATH);
    expect(isBankIdSettingsPath('/bankid/settings')).toBe(true);
  });

  it('claims nothing about a path that is not a detail screen', () => {
    // A section path is `returnTarget`'s own business — the literal table it checks first. The
    // four OIDC hand-off paths are in neither: they are where the browser already is.
    for (const path of [
      '/applications',
      '/users',
      '/providers',
      // BankID's own section path included: it is in the table, so `detailTarget` must not
      // claim it as well — the two halves of `returnTarget` answer for different paths.
      '/bankid',
      '/login',
      '/signup',
      '/consent',
      '/reset-password',
      '/nope',
    ]) {
      expect(detailTarget(path)).toBeNull();
      expect(isBankIdSettingsPath(path)).toBe(false);
    }
  });

  it('refuses anything that would make the return target a redirect rather than a path', () => {
    for (const hostile of [
      '/applications/evil.example/path',
      '/applications/https://evil.example',
      '/applications//evil.example',
      '/applications/a%2f%2fevil.example',
      '/applications/a\\evil.example',
      '/users//evil.example',
      '/users/a:b',
      '/providers/evil.example/path',
      '/providers/https://evil.example',
      '/providers//evil.example',
      '/providers/a%2f%2fevil.example',
      '/providers/a\\evil.example',
      // BankID's segment is a literal, so anything that is not exactly it is not it — a tail,
      // a doubled slash, a different case, or a query somebody put in a `pathname`.
      '/bankid/settings/x',
      '/bankid/settings/',
      '/bankid//settings',
      '/bankid/https://evil.example',
      '/bankid/settings?next=https://evil.example',
      '/BankID/settings',
      '//bankid/settings',
      '/bankid/settings#x',
    ]) {
      expect(detailTarget(hostile)).toBeNull();
    }
  });

  it('holds a provider id to the lowercase slug the issuer will actually accept', () => {
    // `GENERIC_ID_PATTERN` in `src/providers.ts` — lowercase, digits, interior hyphens, and no
    // more than 40 characters, because the id becomes the callback path segment an upstream has
    // registered. Restating it in the browser can only be too strict, never too loose.
    expect(providerDetailId('/providers/Google')).toBeNull();
    expect(providerDetailId('/providers/-acme')).toBeNull();
    expect(providerDetailId('/providers/acme-')).toBeNull();
    expect(providerDetailId('/providers/acme_sso')).toBeNull();
    expect(providerDetailId(`/providers/${'a'.repeat(41)}`)).toBeNull();
    expect(providerDetailId(`/providers/${'a'.repeat(40)}`)).toBe('a'.repeat(40));
    // A single character is an id; the section path and a trailing slash are not.
    expect(providerDetailId('/providers/x')).toBe('x');
    expect(providerDetailId('/providers')).toBeNull();
    expect(providerDetailId('/providers/')).toBeNull();
  });

  it('refuses an id that is nothing but dots, which a browser resolves away rather than visits', () => {
    expect(applicationDetailId('/applications/..')).toBeNull();
    expect(applicationDetailId('/applications/.')).toBeNull();
    // …but a dot inside a real id is fine.
    expect(applicationDetailId('/applications/app.example.com')).toBe('app.example.com');
  });

  it('parses only its own section', () => {
    expect(userDetailId('/applications/abc')).toBeNull();
    expect(userDetailId('/providers/abc')).toBeNull();
    expect(applicationDetailId('/users/abc')).toBeNull();
    expect(applicationDetailId('/providers/abc')).toBeNull();
    expect(providerDetailId('/users/abc')).toBeNull();
    expect(providerDetailId('/applications/abc')).toBeNull();
    // A section path is not a detail path — `/applications` has no trailing id.
    expect(applicationDetailId('/applications')).toBeNull();
    expect(applicationDetailId('/applications/')).toBeNull();
    // BankID crosses in both directions: its own path is nobody else's detail, and `bankid`
    // read as an id belongs to whichever section it appears under.
    expect(userDetailId('/bankid/settings')).toBeNull();
    expect(applicationDetailId('/bankid/settings')).toBeNull();
    expect(providerDetailId('/bankid/settings')).toBeNull();
    expect(isBankIdSettingsPath('/providers/bankid')).toBe(false);
    expect(isBankIdSettingsPath('/users/bankid')).toBe(false);
    // `bankid` IS a legitimate provider id — it is a catalogue-shaped slug — and that screen
    // is the providers one, not this one.
    expect(providerDetailId('/providers/bankid')).toBe('bankid');
  });
});
