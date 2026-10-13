import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { scopeStoreObjectName, signScopeStoreName } from '@substrat-run/contracts';

/**
 * Two scripts (#2210). This one stands in for the vertical: it can call the
 * store, and it does not hold the key. The signature is produced here the way
 * the control plane would produce it, from a key that is not a binding on
 * `env`. The store script checks it.
 */
const SECRET = 'scope-store-test-key';

describe('a signed scope store across two scripts (#2210)', () => {
  it('the vertical script is not given the key', () => {
    expect('SUBSTRAT_STORE_HMAC_KEY' in env).toBe(false);
  });

  it('answers a signature over its object name, and refuses any other', async () => {
    const name = scopeStoreObjectName('01TENANT', 'acme/crm', '01SCOPE', 'GRAPH');
    expect(name).not.toContain('1.0.0');
    const call = async (mac: string, claimed = name) => {
      const response = await env.SIGNED_STORE.fetch(`https://scope-store/?name=${encodeURIComponent(claimed)}`, {
        headers: { 'x-substrat-store-mac': mac },
      });
      return response.status;
    };
    expect(await call('')).toBe(401);
    expect(await call(await signScopeStoreName(SECRET, 'some-other-name'))).toBe(401);
    expect(await call(await signScopeStoreName(SECRET, name))).toBe(200);
    const other = scopeStoreObjectName('01OTHER', 'acme/crm', '01SCOPE', 'GRAPH');
    expect(await call(await signScopeStoreName(SECRET, other), other)).toBe(401);
    const again = await env.SIGNED_STORE.fetch(`https://scope-store/?name=${encodeURIComponent(name)}`, {
      headers: { 'x-substrat-store-mac': await signScopeStoreName(SECRET, name) },
    });
    const body: unknown = await again.json();
    const result = typeof body === 'object' && body !== null ? Reflect.get(body, 'result') : undefined;
    const stored = typeof result === 'object' && result !== null ? Reflect.get(result, 'name') : undefined;
    expect(stored).toBe(name);
  });
});