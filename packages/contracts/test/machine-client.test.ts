import { describe, it, expect } from 'vitest';
import { issuerScopes, issuerScopesOfManifestJson, machineClientEnsure } from '../src/index.js';

/**
 * An app's declared issuer scopes (#3134): scope tokens of the issuer's machine APIs, never a
 * scope a person grants by signing in, and never one the issuer's comma-separated ceiling
 * could not name.
 */
const ulid = '01J2Q8Z3V9K4W7X2M5N6P7ENV1';

describe('declared issuer scopes (#3134)', () => {
  it('accepts the scopes of the issuer’s machine APIs', () => {
    expect(issuerScopes.safeParse(['read:users', 'users:provision']).success).toBe(true);
  });

  it.each([
    [['openid'], 'a sign-in scope'],
    [['offline_access'], 'a sign-in scope'],
    [['read:users,users:provision'], 'a comma'],
    [['read users'], 'a space'],
    [['read:"users"'], 'a quote'],
    [[''], 'an empty scope'],
    [['read:users', 'read:users'], 'a scope named twice'],
    [Array.from({ length: 33 }, (_, i) => `scope:${i}`), 'more than 32'],
  ])('refuses %j — %s', (scopes) => {
    expect(issuerScopes.safeParse(scopes).success).toBe(false);
    expect(
      machineClientEnsure.safeParse({ tenantId: ulid, scopeId: ulid, appScopeId: ulid, clientName: 'Desk', scopes }).success,
    ).toBe(false);
  });

  it('reads a stored manifest’s declaration, and reads none as an empty list', () => {
    expect(issuerScopesOfManifestJson(JSON.stringify({ issuerScopes: ['read:users', 'openid', 7, 'read:users'] }))).toEqual([
      'read:users',
    ]);
    expect(issuerScopesOfManifestJson(JSON.stringify({ calls: [] }))).toEqual([]);
    expect(issuerScopesOfManifestJson('not json')).toEqual([]);
    expect(issuerScopesOfManifestJson(null)).toEqual([]);
  });
});
