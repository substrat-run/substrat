import { describe, expect, it } from 'vitest';
import { readRoutedNode, RouterAssertionError } from '../src/routed-node.js';

/**
 * The vertical's side of K-26's trust boundary. Everything here is the difference
 * between "serves the right tenant" and "serves whichever tenant the caller named",
 * so the negative cases matter more than the happy one.
 */

const T = '01JZ0000000000000000000001';
const S = '01JZ0000000000000000000002';

const headers = (h: Record<string, string>) => ({
  get: (name: string) => h[name.toLowerCase()] ?? null,
});

const routed = (extra: Record<string, string> = {}) =>
  headers({ 'x-substrat-tenant': T, 'x-substrat-scope': S, ...extra });

/** The dev-router opt-out (#966): the only way an unsigned assertion is read. */
const unsigned = { allowUnsigned: true };

describe('readRoutedNode', () => {
  it('reads the asserted node', () => {
    const node = readRoutedNode(
      routed({ 'x-substrat-surface': 'back-office', 'x-substrat-vertical': 'shop' }),
      unsigned,
    );
    expect(node).toEqual({
      tenantId: T,
      scopeId: S,
      surface: 'back-office',
      verticalSlug: 'shop',
    });
  });

  it('defaults the surface, since most verticals have exactly one', () => {
    expect(readRoutedNode(routed(), unsigned)?.surface).toBe('app');
  });

  // -- fail closed without a secret (#966) -----------------------------------

  it('refuses an assertion it cannot verify: no secret configured, no opt-out', () => {
    // The hole this closes: a worker deployed without its ROUTER_SECRET used to
    // trust any x-substrat-* headers it was handed — a forged tenant from anyone
    // who could reach the script directly. Now that deployment is a visible outage.
    expect(() => readRoutedNode(routed())).toThrow(RouterAssertionError);
    expect(() => readRoutedNode(routed())).toThrow(/no ROUTER_SECRET configured/);
    expect(() => readRoutedNode(routed(), {})).toThrow(RouterAssertionError);
    expect(() => readRoutedNode(routed(), { expectedSecret: '' })).toThrow(RouterAssertionError);
  });

  it('reads an unsigned assertion only with the explicit opt-out', () => {
    expect(readRoutedNode(routed(), { allowUnsigned: true })).toMatchObject({
      tenantId: T,
      scopeId: S,
    });
    expect(() => readRoutedNode(routed(), { allowUnsigned: false })).toThrow(
      RouterAssertionError,
    );
  });

  it('still checks a configured secret when the opt-out is on', () => {
    // The opt-out covers the ABSENCE of a secret, never a mismatch against one.
    expect(() =>
      readRoutedNode(routed({ 'x-substrat-router': 'guess' }), {
        expectedSecret: 'shhh',
        allowUnsigned: true,
      }),
    ).toThrow(/not signed by a known router/);
    expect(() => readRoutedNode(routed(), { expectedSecret: 'shhh', allowUnsigned: true })).toThrow(
      RouterAssertionError,
    );
  });

  it('leaves the no-assertion path alone: null with or without a secret', () => {
    // An un-routed request is not an unsigned one. The standalone deploy and the
    // ALLOW_DEV_NODE instance both live here, and neither is affected.
    expect(readRoutedNode(headers({}))).toBeNull();
    expect(readRoutedNode(headers({}), unsigned)).toBeNull();
  });

  it('returns null when no router fronted the request', () => {
    // Not an error: a standalone single-tenant deploy is legitimate. The CALLER
    // decides what to do with it, which is why this is distinct from a throw.
    expect(readRoutedNode(headers({}))).toBeNull();
    expect(readRoutedNode(headers({ 'x-substrat-router': 'shhh' }), { expectedSecret: 'shhh' }))
      .toBeNull();
  });

  it('refuses an assertion without the router secret', () => {
    // The case this exists for: the vertical worker is publicly reachable (a
    // forgotten workers.dev toggle) and a stranger names a tenant.
    expect(() => readRoutedNode(routed(), { expectedSecret: 'shhh' })).toThrow(
      RouterAssertionError,
    );
  });

  it('refuses an assertion with the WRONG router secret', () => {
    expect(() =>
      readRoutedNode(routed({ 'x-substrat-router': 'guess' }), { expectedSecret: 'shhh' }),
    ).toThrow(RouterAssertionError);
  });

  it('accepts the assertion when the secret matches', () => {
    expect(
      readRoutedNode(routed({ 'x-substrat-router': 'shhh' }), { expectedSecret: 'shhh' }),
    ).toMatchObject({ tenantId: T, scopeId: S });
  });

  it('does not compare secrets by prefix or length alone', () => {
    for (const presented of ['s', 'shh', 'shhhh', '']) {
      expect(() =>
        readRoutedNode(routed({ 'x-substrat-router': presented }), { expectedSecret: 'shhh' }),
      ).toThrow(RouterAssertionError);
    }
  });

  it('refuses a half-assertion rather than guessing the other half', () => {
    // With the opt-out, so the refusal is about the half and not about the signature.
    expect(() => readRoutedNode(headers({ 'x-substrat-tenant': T }), unsigned)).toThrow(
      /incomplete/,
    );
    expect(() => readRoutedNode(headers({ 'x-substrat-scope': S }), unsigned)).toThrow(
      /incomplete/,
    );
  });

  it('refuses ids that are not ULIDs', () => {
    // Parse, don't trust — even from the router. A malformed id reaching getScope
    // is a worse failure than a rejected request.
    expect(() =>
      readRoutedNode(headers({ 'x-substrat-tenant': 'evil', 'x-substrat-scope': S }), unsigned),
    ).toThrow(/malformed id/);
    expect(() =>
      readRoutedNode(
        headers({ 'x-substrat-tenant': T, 'x-substrat-scope': '../../admin' }),
        unsigned,
      ),
    ).toThrow(/malformed id/);
  });

  it('checks the secret before it checks anything else', () => {
    // An unauthenticated caller must not be able to tell a malformed id from a
    // well-formed one — that is a probe of the id space.
    expect(() =>
      readRoutedNode(headers({ 'x-substrat-tenant': 'nonsense', 'x-substrat-scope': 'junk' }), {
        expectedSecret: 'shhh',
      }),
    ).toThrow(/not signed by a known router/);
  });
});
