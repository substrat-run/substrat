import { describe, expect, it } from 'vitest';
// Browser code, tested from the issuer's suite for the reason `console-routes.test.ts` gives:
// the app has no suite of its own, and this module imports nothing at all.
import { enabledFor, toggledMetadata, type PolicyHolder } from '../app/src/views/connections/policy.js';

/**
 * A connection's Applications tab is a VIEW of each client's `metadata.signIn` — so a toggle
 * that writes the wrong policy quietly gives an application a sign-in method or takes one away,
 * and nobody sees it until a person is refused at authorize. These pin what a toggle writes.
 */
const client = (metadata?: Record<string, unknown>): PolicyHolder => ({ metadata });
const OFFERED = [{ id: 'google' }, { id: 'github' }, { id: 'password' }];

describe('toggling a connection for an application', () => {
  it('reads an absent policy as every connection enabled', () => {
    expect(enabledFor(client(), 'google')).toBe(true);
    expect(enabledFor(client(), 'password')).toBe(true);
    expect(enabledFor(client({ signIn: { providers: ['github'] } }), 'google')).toBe(false);
    expect(enabledFor(client({ signIn: { password: false } }), 'password')).toBe(false);
  });

  it('pins a client that followed every upstream to an explicit list of the others', () => {
    // "every upstream but this one" has no stored spelling, so turning one OFF writes the rest —
    // never the database id, which is `password`'s business rather than a provider.
    const written = toggledMetadata(client({ theme: { colorPrimary: '#123456' } }), 'google', false, OFFERED);
    expect(written).toEqual({ theme: { colorPrimary: '#123456' }, signIn: { providers: ['github'] } });
  });

  it('refuses to pin when the offered list has not loaded, rather than storing "none"', () => {
    expect(() => toggledMetadata(client(), 'google', false, null)).toThrow(/not loaded/);
  });

  it('adds to and removes from an explicit list, keeping every other policy key', () => {
    const stored = client({ signIn: { providers: ['github'], domainRoutes: [{ domains: ['acme.example'], provider: 'github' }] } });
    expect(toggledMetadata(stored, 'google', true, OFFERED)).toEqual({
      signIn: { providers: ['github', 'google'], domainRoutes: [{ domains: ['acme.example'], provider: 'github' }] },
    });
    expect(toggledMetadata(stored, 'github', false, OFFERED)).toEqual({
      signIn: { providers: [], domainRoutes: [{ domains: ['acme.example'], provider: 'github' }] },
    });
  });

  it('writes the database as the absence of `password`, and drops a policy left empty', () => {
    const off = toggledMetadata(client({ other: 1 }), 'password', false, OFFERED);
    expect(off).toEqual({ other: 1, signIn: { password: false } });
    // Back on: `password` absent is the default, and a `signIn` with nothing in it is no policy.
    expect(toggledMetadata(client(off), 'password', true, OFFERED)).toEqual({ other: 1 });
  });
});
