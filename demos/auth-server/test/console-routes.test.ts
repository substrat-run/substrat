import { describe, expect, it } from 'vitest';
// The `.js` extension is the one `nodenext` insists on for a relative import; vitest resolves
// it back to the `.ts` beside it, which is the file that actually exists. `paths.ts` rather than
// `routes.ts` on purpose: the latter pulls in `@substrat-run/ui`, a bundler-resolved TSX package
// this program cannot compile, and the routing that matters here is deliberately not in it.
import { applicationDetailId, detailTarget, userDetailId } from '../app/src/console/paths.js';

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
  it('keeps a user detail and an application detail', () => {
    expect(detailTarget('/users/nAxYqEBu1TjNldd5DZbCEmXV2mDhRfCz')).toBe(
      '/users/nAxYqEBu1TjNldd5DZbCEmXV2mDhRfCz',
    );
    // The console's own row is the literal `console`; a self-registered relying party may hold
    // a UUID. Both are places, and both go through the wider alphabet.
    expect(detailTarget('/applications/console')).toBe('/applications/console');
    expect(detailTarget('/applications/2f1c9a30-6d4b-4c19-9c0e-9b1a7f2e4d55')).toBe(
      '/applications/2f1c9a30-6d4b-4c19-9c0e-9b1a7f2e4d55',
    );
  });

  it('claims nothing about a path that is not a detail screen', () => {
    // A section path is `returnTarget`'s own business — the literal table it checks first. The
    // four OIDC hand-off paths are in neither: they are where the browser already is.
    for (const path of ['/applications', '/users', '/login', '/signup', '/consent', '/reset-password', '/nope']) {
      expect(detailTarget(path)).toBeNull();
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
    ]) {
      expect(detailTarget(hostile)).toBeNull();
    }
  });

  it('refuses an id that is nothing but dots, which a browser resolves away rather than visits', () => {
    expect(applicationDetailId('/applications/..')).toBeNull();
    expect(applicationDetailId('/applications/.')).toBeNull();
    // …but a dot inside a real id is fine.
    expect(applicationDetailId('/applications/app.example.com')).toBe('app.example.com');
  });

  it('parses only its own section', () => {
    expect(userDetailId('/applications/abc')).toBeNull();
    expect(applicationDetailId('/users/abc')).toBeNull();
    // A section path is not a detail path — `/applications` has no trailing id.
    expect(applicationDetailId('/applications')).toBeNull();
    expect(applicationDetailId('/applications/')).toBeNull();
  });
});
