import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  STORE_CALLER_KEYS_VAR,
  STORE_CLASS_PLACEHOLDER,
  STORE_ENTRY_PYTHON_SOURCE,
  STORE_ENTRY_PYTHON_VERIFIER_SOURCE,
  STORE_DRIVER_PLACEHOLDER,
  STORE_OBJECT_BINDING,
  STORE_OBJECT_CLASS,
  STORE_PLATFORM_KEYS_VAR,
  STORE_RESERVED_BINDING_PREFIX,
  STORE_SCRIPT_VAR,
  STORE_VERIFIER_MODULE,
} from '../src/store-entry.generated.js';
import { generateScopeStoreKeyPair } from '@substrat-run/contracts/scope-store-envelope';

/**
 * The Python entry and its verifier, as the upload ships them (#2290). The entry running under
 * workerd is packages/store-entry-python/probe.mjs, which its own workflow runs; this suite holds
 * the shipped bytes to the names the TypeScript side uses, and runs the shipped verifier.
 */
const vector = JSON.parse(
  readFileSync(new URL('../../contracts/test/vectors/scope-store-envelope.json', import.meta.url), 'utf8'),
) as Record<string, string>;

type Verdict = { ok: true; envelope: { name: string } } | { ok: false; status: number; message: string };
const verifier = (await import(
  `data:text/javascript;base64,${Buffer.from(STORE_ENTRY_PYTHON_VERIFIER_SOURCE).toString('base64')}`
)) as { storeCallVerdict(headers: Headers, body: string, env: Record<string, unknown>): Promise<Verdict> };

describe('the Python entry, as shipped', () => {
  it('names what store-entry/names.ts names', () => {
    expect(STORE_ENTRY_PYTHON_SOURCE).toContain(`VERIFIER_MODULE = "./${STORE_VERIFIER_MODULE}"`);
    expect(STORE_ENTRY_PYTHON_SOURCE).toContain(`OBJECT_BINDING = "${STORE_OBJECT_BINDING}"`);
    expect(STORE_ENTRY_PYTHON_SOURCE).toContain(`RESERVED_BINDING_PREFIX = "${STORE_RESERVED_BINDING_PREFIX}"`);
    expect(STORE_ENTRY_PYTHON_SOURCE).toContain(`class ${STORE_OBJECT_CLASS}(DurableObject):`);
    expect(STORE_ENTRY_PYTHON_SOURCE).toContain(`from ${STORE_DRIVER_PLACEHOLDER} import ${STORE_CLASS_PLACEHOLDER} as StoreDriver`);
  });

  it('carries no switch that addresses an object other than the signed one', () => {
    expect(STORE_ENTRY_PYTHON_SOURCE).not.toMatch(/ALLOW_ADDRESS|parse_qs|urlparse/);
  });

  it('parses no envelope of its own', () => {
    expect(STORE_ENTRY_PYTHON_SOURCE).not.toMatch(/split\("\\n"\)|b64decode|hashlib|importKey/);
  });
});

describe('the verifier the Python entry imports', async () => {
  afterEach(() => vi.useRealTimers());
  const platform = await generateScopeStoreKeyPair();
  const env = { [STORE_SCRIPT_VAR]: vector.script, [STORE_CALLER_KEYS_VAR]: vector.publicKey, [STORE_PLATFORM_KEYS_VAR]: platform.publicKey };
  const headers = (signature = vector.signature!) =>
    new Headers({ 'x-substrat-store-envelope': vector.header!, 'x-substrat-store-signature': signature });

  it('is one module that imports nothing', () => {
    expect(STORE_ENTRY_PYTHON_VERIFIER_SOURCE).not.toMatch(/\bimport\b[^\n]*\bfrom\b/);
    expect(STORE_ENTRY_PYTHON_VERIFIER_SOURCE).toMatch(/export \{[^}]*storeCallVerdict/);
  });

  it('admits the shared vector at its iat, and refuses it a window later, or with another signature', async () => {
    const iat = Number(vector.canonical!.split('\n')[7]);
    vi.useFakeTimers({ now: iat * 1000, toFake: ['Date'] });
    const admitted = await verifier.storeCallVerdict(headers(), vector.body!, env);
    expect(admitted).toMatchObject({ ok: true, envelope: { name: 'tenant/vertical/scope/graph' } });
    expect(await verifier.storeCallVerdict(headers(vector.staleSignature), vector.body!, env)).toEqual({
      ok: false,
      status: 401,
      message: 'unauthorized: signature',
    });
    vi.setSystemTime((iat + Number(vector.windowSeconds) + 1) * 1000);
    expect(await verifier.storeCallVerdict(headers(), vector.body!, env)).toEqual({ ok: false, status: 401, message: 'unauthorized: stale' });
  });

  it('answers 503 to a store this upload did not configure, one key for both audiences included', async () => {
    const unconfigured = { ok: false, status: 503, message: 'this store script is not configured' };
    expect(await verifier.storeCallVerdict(headers(), vector.body!, { ...env, [STORE_SCRIPT_VAR]: '' })).toEqual(unconfigured);
    expect(await verifier.storeCallVerdict(headers(), vector.body!, { ...env, [STORE_PLATFORM_KEYS_VAR]: vector.publicKey })).toEqual(unconfigured);
  });
});
