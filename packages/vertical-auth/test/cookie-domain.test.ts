import { describe, it, expect } from 'vitest';
import { resolveCookieDomain } from '../src/cookie-domain.js';

/**
 * The validation that stands between a delivered `cookieDomain` and a Set-Cookie header.
 * Wrong configs must degrade to host-only (null) — never to a broken sign-in, and never
 * to a cookie broader than the configured parent.
 */
describe('resolveCookieDomain', () => {
  const HOST = 'crm.acme.se';

  it('accepts the parent domain of the request host (the multi-surface case)', () => {
    expect(resolveCookieDomain('acme.se', HOST)).toBe('acme.se');
    expect(resolveCookieDomain('acme.se', 'eka.acme.se')).toBe('acme.se');
  });

  it('accepts the host itself (an apex serving its own surface)', () => {
    expect(resolveCookieDomain('acme.se', 'acme.se')).toBe('acme.se');
  });

  it('normalizes a leading dot and case (both appear in hand-typed configs)', () => {
    expect(resolveCookieDomain('.Acme.SE', HOST)).toBe('acme.se');
  });

  it('rejects a domain the host is not under — a cookie the browser would drop anyway', () => {
    expect(resolveCookieDomain('other.se', HOST)).toBeNull();
    // A partial-label match is NOT a suffix: `me.se` must not cover `acme.se`.
    expect(resolveCookieDomain('me.se', HOST)).toBeNull();
  });

  it('rejects a bare TLD — never a session boundary', () => {
    expect(resolveCookieDomain('se', HOST)).toBeNull();
  });

  it('rejects a public suffix even when the host is under it (D-35 PSL guard)', () => {
    // `co.uk` and `pages.dev` look like ordinary two-label domains, but they are
    // registrable suffixes — a cookie on them spans every tenant, so it must degrade.
    expect(resolveCookieDomain('co.uk', 'acme.co.uk')).toBeNull();
    expect(resolveCookieDomain('pages.dev', 'acme.pages.dev')).toBeNull();
    // The registrable domain one level down is fine.
    expect(resolveCookieDomain('acme.co.uk', 'crm.acme.co.uk')).toBe('acme.co.uk');
  });

  it('passes through absence unchanged (host-only is the default)', () => {
    expect(resolveCookieDomain(undefined, HOST)).toBeNull();
    expect(resolveCookieDomain('', HOST)).toBeNull();
  });
});
