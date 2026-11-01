import { describe, expect, it } from 'vitest';
// The `.js` extension is the one `nodenext` insists on for a relative import; vitest resolves
// it back to the `.ts` beside it, which is the file that actually exists. `paths.ts` rather than
// `routes.ts` on purpose: the latter pulls in `@substrat-run/ui`, a bundler-resolved TSX package
// this program cannot compile, and the routing that matters here is deliberately not in it.
import {
  applicationDetail,
  connectionDetail,
  detailTarget,
  legacyTarget,
  logEntryId,
  userDetail,
} from '../app/src/console/paths.js';

/**
 * The console's dynamic routing, which is browser code with a server-shaped duty. `returnTarget`
 * hands its answer to an upstream provider as `callbackURL` and reads it back out of a redirect,
 * and `detailTarget` / `legacyTarget` are the halves of it that judge a path nobody wrote down
 * in advance — so the parsers below are the whole of what decides whether a pasted address bar
 * can ride out of Google and back into this issuer as somewhere else entirely.
 *
 * Tested here rather than in the app: `demos/auth-server/app` has no suite of its own.
 */
describe('console routes', () => {
  it('keeps every detail screen, on its default tab and on a named one', () => {
    const user = 'nAxYqEBu1TjNldd5DZbCEmXV2mDhRfCz';
    expect(detailTarget(`/users/${user}`)).toBe(`/users/${user}`);
    expect(detailTarget(`/users/${user}/sessions`)).toBe(`/users/${user}/sessions`);
    // The console's own row is the literal `console`; a self-registered relying party may hold
    // a UUID. Both are places, and both go through the wider alphabet.
    expect(detailTarget('/applications/console')).toBe('/applications/console');
    expect(detailTarget('/applications/2f1c9a30-6d4b-4c19-9c0e-9b1a7f2e4d55/raw')).toBe(
      '/applications/2f1c9a30-6d4b-4c19-9c0e-9b1a7f2e4d55/raw',
    );
    expect(detailTarget('/connections/acme-sso/applications')).toBe('/connections/acme-sso/applications');
    expect(detailTarget('/connections/password')).toBe('/connections/password');
    expect(detailTarget('/logs/42')).toBe('/logs/42');
  });

  it('spells the default tab out of the URL it re-composes', () => {
    // `/users/<id>/details` is the same place as `/users/<id>`, and only one of them is its URL.
    expect(detailTarget('/users/abc/details')).toBe('/users/abc');
    expect(detailTarget('/applications/console/settings')).toBe('/applications/console');
    expect(detailTarget('/connections/google/settings')).toBe('/connections/google');
  });

  it('claims nothing about a path that is not a detail screen', () => {
    // A section path is `returnTarget`'s own business — the literal table it checks first. The
    // four OIDC hand-off paths are in neither: they are where the browser already is.
    for (const path of ['/applications', '/users', '/connections', '/logs', '/login', '/signup', '/consent', '/reset-password', '/nope']) {
      expect(detailTarget(path)).toBeNull();
    }
  });

  it('refuses a tab that is not on the screen’s list', () => {
    expect(userDetail('/users/abc/branding')).toBeNull();
    expect(applicationDetail('/applications/console/sessions')).toBeNull();
    expect(connectionDetail('/connections/google/logs')).toBeNull();
    expect(detailTarget('/users/abc/details/x')).toBeNull();
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
      '/connections/evil.example/path',
      '/connections/https://evil.example',
      '/connections//evil.example',
      '/connections/a%2f%2fevil.example',
      '/connections/a\\evil.example',
      '/logs/1?next=https://evil.example',
      '/logs/0',
      '/logs/-1',
      '/logs/1/raw',
    ]) {
      expect(detailTarget(hostile)).toBeNull();
      expect(legacyTarget(hostile)).toBeNull();
    }
  });

  it('holds a connection id to the lowercase slug the issuer will actually accept', () => {
    // `GENERIC_ID_PATTERN` in `src/providers.ts` — lowercase, digits, interior hyphens, and no
    // more than 40 characters, because the id becomes the callback path segment an upstream has
    // registered. Restating it in the browser can only be too strict, never too loose.
    for (const bad of ['Google', '-acme', 'acme-', 'acme_sso', 'a'.repeat(41)]) {
      expect(connectionDetail(`/connections/${bad}`)).toBeNull();
    }
    expect(connectionDetail(`/connections/${'a'.repeat(40)}`)?.id).toBe('a'.repeat(40));
    expect(connectionDetail('/connections/x')?.id).toBe('x');
    expect(connectionDetail('/connections/')).toBeNull();
  });

  it('refuses an application id that is nothing but dots, which a browser resolves away', () => {
    expect(applicationDetail('/applications/..')).toBeNull();
    expect(applicationDetail('/applications/.')).toBeNull();
    expect(applicationDetail('/applications/app.example.com')?.id).toBe('app.example.com');
  });

  it('parses only its own section', () => {
    expect(userDetail('/applications/abc')).toBeNull();
    expect(applicationDetail('/users/abc')).toBeNull();
    expect(connectionDetail('/users/abc')).toBeNull();
    expect(logEntryId('/users/1')).toBeNull();
  });

  it('sends every pre-regroup URL to where that screen lives now', () => {
    // Bookmarks and support-thread links outlive a nav change; each old place has a new one.
    expect(legacyTarget('/providers')).toBe('/connections');
    expect(legacyTarget('/providers/google')).toBe('/connections/google');
    expect(legacyTarget('/providers/acme-sso')).toBe('/connections/acme-sso');
    expect(legacyTarget('/bankid')).toBe('/connections/bankid');
    expect(legacyTarget('/bankid/settings')).toBe('/connections/bankid');
    expect(legacyTarget('/access')).toBe('/security');
    expect(legacyTarget('/sign-in-log')).toBe('/logs');
    expect(legacyTarget('/issuer')).toBe('/settings');
    // A provider id out of the issuer's alphabet was never a place, and is not one now.
    expect(legacyTarget('/providers/Google')).toBeNull();
    expect(legacyTarget('/bankid/settings/x')).toBeNull();
  });
});
