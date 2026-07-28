import { describe, it, expect } from 'vitest';
import { resolveCookieDomain } from '../src/cookie-domain.js';

/**
 * The validation that stands between a delivered `cookieDomain` and a Set-Cookie header.
 * Wrong configs must degrade to host-only (null) — never to a broken sign-in, and never
 * to a cookie broader than the configured parent.
 */
describe('resolveCookieDomain', () => {
  const HOST = 'crm.egeryds.se';

  it('accepts the parent domain of the request host (the multi-surface case)', () => {
    expect(resolveCookieDomain('egeryds.se', HOST)).toBe('egeryds.se');
    expect(resolveCookieDomain('egeryds.se', 'eka.egeryds.se')).toBe('egeryds.se');
  });

  it('accepts the host itself (an apex serving its own surface)', () => {
    expect(resolveCookieDomain('egeryds.se', 'egeryds.se')).toBe('egeryds.se');
  });

  it('normalizes a leading dot and case (both appear in hand-typed configs)', () => {
    expect(resolveCookieDomain('.Egeryds.SE', HOST)).toBe('egeryds.se');
  });

  it('rejects a domain the host is not under — a cookie the browser would drop anyway', () => {
    expect(resolveCookieDomain('other.se', HOST)).toBeNull();
    // A partial-label match is NOT a suffix: `rydes.se` must not cover `egeryds.se`.
    expect(resolveCookieDomain('ryds.se', HOST)).toBeNull();
  });

  it('rejects a bare TLD — never a session boundary', () => {
    expect(resolveCookieDomain('se', HOST)).toBeNull();
  });

  it('passes through absence unchanged (host-only is the default)', () => {
    expect(resolveCookieDomain(undefined, HOST)).toBeNull();
    expect(resolveCookieDomain('', HOST)).toBeNull();
  });
});
