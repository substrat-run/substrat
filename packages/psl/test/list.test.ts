import { describe, expect, it } from 'vitest';
import {
  getPublicSuffix,
  getRegistrableDomain,
  isPublicSuffix,
  sameRegistrableDomain,
} from '../src/index.js';

describe('getPublicSuffix', () => {
  // The canonical checks from https://publicsuffix.org/list/ test data.
  it.each([
    ['com', 'com'],
    ['example.com', 'com'],
    ['www.example.com', 'com'],
    ['uk.com', 'uk.com'], // a listed second-level suffix
    ['example.uk.com', 'uk.com'],
    ['co.uk', 'co.uk'],
    ['bbc.co.uk', 'co.uk'],
    ['a.b.bbc.co.uk', 'co.uk'],
    ['pages.dev', 'pages.dev'], // Cloudflare, PRIVATE section
    ['app.pages.dev', 'pages.dev'],
    ['workers.dev', 'workers.dev'],
    ['foo.workers.dev', 'workers.dev'],
  ])('%s → %s', (host, suffix) => {
    expect(getPublicSuffix(host)).toBe(suffix);
  });

  it('applies wildcard rules (*.ck)', () => {
    expect(getPublicSuffix('foo.ck')).toBe('foo.ck');
    expect(getPublicSuffix('bar.foo.ck')).toBe('foo.ck');
  });

  it('applies exception rules (!www.ck beats *.ck)', () => {
    // www.ck is an exception, so its public suffix drops back to `ck`.
    expect(getPublicSuffix('www.ck')).toBe('ck');
    expect(getPublicSuffix('b.www.ck')).toBe('ck');
  });

  it('falls back to the rightmost label for an unknown TLD', () => {
    expect(getPublicSuffix('example.invalidtld')).toBe('invalidtld');
  });

  it('rejects malformed hosts', () => {
    expect(getPublicSuffix('')).toBeNull();
    expect(getPublicSuffix('.')).toBeNull();
    expect(getPublicSuffix('a..b')).toBeNull();
  });
});

describe('isPublicSuffix', () => {
  it('flags bare suffixes', () => {
    expect(isPublicSuffix('com')).toBe(true);
    expect(isPublicSuffix('co.uk')).toBe(true);
    expect(isPublicSuffix('pages.dev')).toBe(true);
  });
  it('does not flag registrable domains', () => {
    expect(isPublicSuffix('acme.com')).toBe(false);
    expect(isPublicSuffix('bbc.co.uk')).toBe(false);
    // .run is an ordinary ICANN gTLD, so the platform apex is registrable, NOT a
    // public suffix — its cross-tenant risk is guarded by an explicit apex refusal,
    // not the PSL (control-plane.md §4.7 / cookie-domain.ts).
    expect(isPublicSuffix('substrat.run')).toBe(false);
  });
});

describe('getRegistrableDomain', () => {
  it.each([
    ['www.example.com', 'example.com'],
    ['example.com', 'example.com'],
    ['a.b.bbc.co.uk', 'bbc.co.uk'],
    ['app.acme.pages.dev', 'acme.pages.dev'],
    ['egeryds.se', 'egeryds.se'],
    ['crm.egeryds.se', 'egeryds.se'],
  ])('%s → %s', (host, reg) => {
    expect(getRegistrableDomain(host)).toBe(reg);
  });

  it('is null for a bare public suffix', () => {
    expect(getRegistrableDomain('com')).toBeNull();
    expect(getRegistrableDomain('co.uk')).toBeNull();
  });
});

describe('sameRegistrableDomain', () => {
  it('groups sibling surfaces', () => {
    expect(sameRegistrableDomain('crm.acme.com', 'hr.acme.com')).toBe(true);
    expect(sameRegistrableDomain('acme.com', 'acme.co.uk')).toBe(false);
    expect(sameRegistrableDomain('co.uk', 'bbc.co.uk')).toBe(false);
  });
});
