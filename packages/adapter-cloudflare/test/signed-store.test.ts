import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { scopeStoreObjectName, signScopeStoreName } from '@substrat-run/contracts';

/**
 * A fixture store across two scripts (#2210): this test worker calls `test/signed-store-worker.js`
 * through a service binding. The fixture is not the platform's store entry module and checks
 * only the name-only MAC (see its header). The signature is made here with contracts' signer,
 * from a key that is not a binding on this worker; the fixture verifies with contracts' module.
 */
const SECRET = 'scope-store-test-key';

const call = async (name: string, mac: string): Promise<Response> =>
  env.SIGNED_STORE.fetch(`https://scope-store/?name=${encodeURIComponent(name)}`, {
    headers: { 'x-substrat-store-mac': mac },
  });

describe('a fixture store behind a name MAC, on workerd (#2210)', () => {
  const name = scopeStoreObjectName('01TENANT', 'acme/crm', '01SCOPE', 'GRAPH');

  it('refuses an empty, malformed, wrong-key or other-name MAC', async () => {
    const valid = await signScopeStoreName(SECRET, name);
    for (const mac of [
      '',
      'not a mac!',
      valid.slice(0, -2),
      await signScopeStoreName('another-key', name),
      await signScopeStoreName(SECRET, `${name}-other`),
    ]) {
      expect((await call(name, mac)).status, mac).toBe(401);
    }
  });

  it('admits a MAC over its own name, and answers the same name again', async () => {
    const mac = await signScopeStoreName(SECRET, name);
    for (let i = 0; i < 2; i++) {
      const response = await call(name, mac);
      expect(response.status).toBe(200);
      const body: unknown = await response.json();
      const result = typeof body === 'object' && body !== null ? Reflect.get(body, 'result') : undefined;
      expect(typeof result === 'object' && result !== null ? Reflect.get(result, 'name') : undefined).toBe(name);
    }
  });
});
