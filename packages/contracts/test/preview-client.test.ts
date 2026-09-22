import { describe, it, expect } from 'vitest';
import { previewClientCheck, previewClientMint } from '../src/index.js';

/**
 * The redirect URIs the preview-client protocol accepts (#1704): https, no fragment, no
 * credentials — and no loopback, not even the forms a local issuer would use. A preview and
 * the app it forks are both hosted; a loopback redirect at a hosted issuer is refused.
 */
const ulid = '01J2Q8Z3V9K4W7X2M5N6P7ENV1';
const mint = (redirectUri: string, postLogoutRedirectUri = 'https://desk--pr-7.acme.test/') => ({
  tenantId: ulid,
  scopeId: ulid,
  parentScopeId: ulid,
  parentRedirectUris: ['https://desk.acme.test/api/auth/callback'],
  previewScopeId: ulid,
  redirectUri,
  postLogoutRedirectUri,
  clientName: 'Desk (pr-7)',
});

describe('preview-client redirect URIs (#1704)', () => {
  it('the WHATWG URL hostname of an IPv6 loopback keeps its brackets (pinned, since a check once assumed otherwise)', () => {
    expect(new URL('http://[::1]:8080/cb').hostname).toBe('[::1]');
    expect(new URL('http://localhost/cb').hostname).toBe('localhost');
  });

  it('accepts the preview’s own https callback', () => {
    expect(previewClientMint.safeParse(mint('https://desk--pr-7.acme.test/api/auth/callback')).success).toBe(true);
  });

  it.each([
    'http://localhost:8871/api/auth/callback',
    'http://127.0.0.1/api/auth/callback',
    'http://[::1]/api/auth/callback',
    'https://localhost/api/auth/callback#frag',
    'https://user:pw@desk--pr-7.acme.test/api/auth/callback',
    'http://desk--pr-7.acme.test/api/auth/callback',
    'javascript:alert(1)',
    'not a url',
  ])('refuses %s — as a redirect, as a post-logout target, and as a parent callback', (uri) => {
    expect(previewClientMint.safeParse(mint(uri)).success).toBe(false);
    expect(previewClientMint.safeParse(mint('https://desk--pr-7.acme.test/api/auth/callback', uri)).success).toBe(false);
    expect(
      previewClientCheck.safeParse({ tenantId: ulid, scopeId: ulid, parentScopeId: ulid, parentRedirectUris: [uri] }).success,
    ).toBe(false);
  });
});
