import { describe, expect, it } from 'vitest';
import {
  assertPlatformCall,
  EXPORTED_EVENTS_HEADER,
  kickFlags,
  PLATFORM_REQUEST_HEADER,
  PLATFORM_SECRET_HEADER,
  PlatformCallError,
} from '../src/platform-call.js';

/**
 * The vertical's side of K-31. An open provisioning endpoint lets a stranger mint
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

/**
 * #1705 PR 2 — the kick's two response flags, as one call a worker spreads into `getScope`'s
 * options. Each callback raises its own header and nothing else; the router reads exactly these
 * names (it hardcodes them, since it does not depend on the kernel).
 */
describe('kickFlags (#1705 PR 2)', () => {
  it('raises each flag under its own header, only when its callback fires', () => {
    const set: [string, string][] = [];
    const flags = kickFlags((name, value) => set.push([name, value]));
    expect(set).toEqual([]);
    flags.onPlatformRequests?.(2);
    expect(set).toEqual([[PLATFORM_REQUEST_HEADER, '1']]);
    flags.onExportedEvents?.(1);
    expect(set).toEqual([
      [PLATFORM_REQUEST_HEADER, '1'],
      [EXPORTED_EVENTS_HEADER, '1'],
    ]);
    expect([PLATFORM_REQUEST_HEADER, EXPORTED_EVENTS_HEADER]).toEqual([
      'x-substrat-platform-request',
      'x-substrat-exported-events',
    ]);
  });
});
