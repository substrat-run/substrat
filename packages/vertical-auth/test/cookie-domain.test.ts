import { describe, it, expect } from 'vitest';
import { cookieDomainDecision, expireBetterAuthDomainCookies, forwardIdentityCookieConfig, resolveCookieDomain } from '../src/cookie-domain.js';

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

  it('rejects platform hostnames that can span other tenants', () => {
    const host = 'desk.global.substrat.run';
    expect(resolveCookieDomain('substrat.run', host)).toBeNull();
    expect(resolveCookieDomain('global.substrat.run', host)).toBeNull();
    expect(resolveCookieDomain('desk.global.substrat.run', host)).toBeNull();
    expect(resolveCookieDomain('.GLOBAL.TEST.SUBSTRAT.RUN', 'desk.global.test.substrat.run')).toBeNull();
    expect(resolveCookieDomain('eu.substrat.run', 'desk.eu.substrat.run')).toBeNull();
    expect(resolveCookieDomain('acme.se', 'desk.acme.se')).toBe('acme.se');
  });

  it('rejects every configured platform zone and retains the old cookie domain for cleanup', () => {
    const bases = ['example.net', 'second.example.org'];
    expect(cookieDomainDecision('global.example.net', 'desk.global.example.net', bases)).toEqual({
      domain: null, cleanupDomain: 'global.example.net',
    });
    expect(cookieDomainDecision('.SECOND.EXAMPLE.ORG', 'desk.second.example.org', bases)).toEqual({
      domain: null, cleanupDomain: 'second.example.org',
    });
    expect(cookieDomainDecision('global.substrat.run', 'desk.global.substrat.run', bases).cleanupDomain)
      .toBe('global.substrat.run');
    expect(cookieDomainDecision('customer.example.net.au', 'desk.customer.example.net.au', bases))
      .toEqual({ domain: 'customer.example.net.au', cleanupDomain: null });
  });

  it('passes through absence unchanged (host-only is the default)', () => {
    expect(resolveCookieDomain(undefined, HOST)).toBeNull();
    expect(resolveCookieDomain('', HOST)).toBeNull();
  });
});

it('expires legacy Better Auth domain cookies while preserving the response', async () => {
  const original = new Response('ok', { status: 200, headers: { 'set-cookie': 'current=value; Path=/' } });
  const cleaned = expireBetterAuthDomainCookies(original, 'https://desk.global.example.net', 'global.example.net');
  expect(await cleaned.text()).toBe('ok');
  const cookies = (cleaned.headers as Headers & { getSetCookie(): string[] }).getSetCookie();
  expect(cookies).toContain('current=value; Path=/');
  for (const name of ['session_token', 'session_data', 'account_data', 'dont_remember']) {
    expect(cookies).toContain(`__Secure-better-auth.${name}=; Path=/; Domain=global.example.net; Max-Age=0; HttpOnly; SameSite=Lax; Secure`);
  }
});

it('does not forward caller-supplied internal cookie settings to the identity DO', () => {
  const request = new Request('https://desk.global.example.net/api/auth/session', {
    headers: {
      'x-substrat-cookie-domain': 'global.example.net',
      'x-substrat-platform-base-domains': 'example.net',
    },
  });
  const withoutConfig = forwardIdentityCookieConfig(request);
  expect(withoutConfig.headers.get('x-substrat-cookie-domain')).toBeNull();
  expect(withoutConfig.headers.get('x-substrat-platform-base-domains')).toBeNull();

  const configured = forwardIdentityCookieConfig(request, {
    cookieDomain: 'global.substrat.run', platformBaseDomains: ['substrat.run'],
  });
  expect(configured.headers.get('x-substrat-cookie-domain')).toBe('global.substrat.run');
  expect(configured.headers.get('x-substrat-platform-base-domains')).toBe('substrat.run');
});
