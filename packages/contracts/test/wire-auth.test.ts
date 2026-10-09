import { describe, expect, it } from 'vitest';
import { PLATFORM_SECRET_HEADER } from '../src/wire-headers.js';
import { assertPlatformCall, PlatformCallError, secretMatches } from '../src/wire-auth.js';

/**
 * The receiving side of K-31. An open provisioning endpoint lets a stranger mint
 * tenants inside the vertical, so every case here is about refusing.
 */

const headers = (h: Record<string, string>) => ({
  get: (name: string) => h[name.toLowerCase()] ?? null,
});

describe('assertPlatformCall', () => {
  it('accepts a call carrying the configured secret', () => {
    expect(() =>
      assertPlatformCall(headers({ [PLATFORM_SECRET_HEADER]: 'shhh' }), {
        expectedSecret: 'shhh',
      }),
    ).not.toThrow();
  });

  it('REFUSES when no secret is configured', () => {
    // The opposite of the router secret, on purpose. There, unset means "no router",
    // which a standalone deploy legitimately wants. Here it would mean "anyone may
    // provision" — so a template copied without configuration must refuse.
    expect(() => assertPlatformCall(headers({ [PLATFORM_SECRET_HEADER]: 'anything' }))).toThrow(
      PlatformCallError,
    );
    expect(() => assertPlatformCall(headers({}))).toThrow(/not configured/);
  });

  it('refuses a missing or wrong secret', () => {
    expect(() => assertPlatformCall(headers({}), { expectedSecret: 'shhh' })).toThrow(
      PlatformCallError,
    );
    expect(() =>
      assertPlatformCall(headers({ [PLATFORM_SECRET_HEADER]: 'guess' }), {
        expectedSecret: 'shhh',
      }),
    ).toThrow(PlatformCallError);
  });

  it('does not accept a prefix or a length match alone', () => {
    for (const presented of ['s', 'shh', 'shhhh', '', 'xxxx']) {
      expect(() =>
        assertPlatformCall(headers({ [PLATFORM_SECRET_HEADER]: presented }), {
          expectedSecret: 'shhh',
        }),
      ).toThrow(PlatformCallError);
    }
  });

  it('does not accept the router secret in place of the platform one', () => {
    // Two different authorities. A vertical that conflated them would let anything
    // the router can reach also provision.
    expect(() =>
      assertPlatformCall(headers({ 'x-substrat-router': 'shhh' }), { expectedSecret: 'shhh' }),
    ).toThrow(PlatformCallError);
  });
});

describe('secretMatches', () => {
  it('matches only the same string', () => {
    expect(secretMatches('s3cret', 's3cret')).toBe(true);
    expect(secretMatches('s3creT', 's3cret')).toBe(false);
    expect(secretMatches('s3cre', 's3cret')).toBe(false);
    expect(secretMatches('s3crett', 's3cret')).toBe(false);
  });

  it('refuses an absent or empty presented value', () => {
    expect(secretMatches(null, 's3cret')).toBe(false);
    expect(secretMatches('', 's3cret')).toBe(false);
  });
});
