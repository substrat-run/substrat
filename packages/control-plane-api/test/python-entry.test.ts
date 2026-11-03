import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  STORE_CALLER_KEYS_VAR,
  STORE_CLASS_PLACEHOLDER,
  STORE_ENTRY_PYTHON_SOURCE,
  STORE_ENTRY_PYTHON_VERIFIER_SOURCE,
  STORE_DRIVER_PLACEHOLDER,
  STORE_FENCE_KEY,
  STORE_OBJECT_BINDING,
  STORE_OBJECT_CLASS,
  STORE_PLATFORM_KEYS_VAR,
  STORE_RESERVED_BINDING_PREFIX,
  STORE_SCRIPT_VAR,
  STORE_VERIFIER_MODULE,
} from '../src/store-entry.generated.js';
import { generateScopeStoreKeyPair, STORE_FENCE_OPERATION } from '@substrat-run/contracts/scope-store-envelope';
import { STORE_PYTHON_DATA_CONTENT_TYPE, withPythonStoreEntry } from '../src/store-entry.js';

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

  it('runs the fence the JavaScript entry runs, from the verifier module, around every driver call (D-70)', () => {
    expect(STORE_ENTRY_PYTHON_SOURCE).toContain(`FENCE_OPERATION = "${STORE_FENCE_OPERATION}"`);
    // Running under both SDK shapes: apps/vertical-egress/test/store-entry-python.workerd.test.ts.
    expect(STORE_ENTRY_PYTHON_SOURCE).toContain('getattr(self.ctx, "_ctx", self.ctx)');
    expect(STORE_ENTRY_PYTHON_SOURCE).toContain('.storeObjectFence(state.storage)');
    expect(STORE_ENTRY_PYTHON_SOURCE).toContain('.storeFenceWipeBody(call.body)');
    // Every driver call in `fetch`, and the alarm, sits inside a try whose finally settles the fence.
    const object = STORE_ENTRY_PYTHON_SOURCE.slice(STORE_ENTRY_PYTHON_SOURCE.indexOf('    async def fetch(self, request):'), STORE_ENTRY_PYTHON_SOURCE.indexOf('class Default('));
    expect(object.match(/await self\._driver_object\(\)\.fetch/g)).toHaveLength(2);
    expect(object.match(/await fence\.reassert\(\)/g)).toHaveLength(1);
    expect(object.match(/await fence\.leave\(\)/g)).toHaveLength(2);
    expect(object).toContain('await fence.admitAlarm()');
  });

  it('carries no switch that addresses an object other than the signed one', () => {
    expect(STORE_ENTRY_PYTHON_SOURCE).not.toMatch(/ALLOW_ADDRESS|parse_qs|urlparse/);
  });

  it('keeps the body in JavaScript: one bounded read in the verifier, no text() and no Python copy of it (#2811)', () => {
    expect(STORE_ENTRY_PYTHON_SOURCE).toContain('verifier.verifiedStoreCall(request.js_object');
    expect(STORE_ENTRY_PYTHON_SOURCE).not.toMatch(/\.text\(\)|\.to_py\(|\.to_bytes\(|bytes\(|str\(call\.body|\.arrayBuffer\(/);
    expect(STORE_ENTRY_PYTHON_SOURCE).not.toContain('\r');
  });

  it('parses no envelope of its own', () => {
    expect(STORE_ENTRY_PYTHON_SOURCE).not.toMatch(/split\("\\n"\)|b64decode|hashlib|importKey/);
  });

  it('uploads vendored python_modules as Data and does not ship the workers runtime SDK', async () => {
    expect(STORE_ENTRY_PYTHON_SOURCE).toContain('from workers import');
    const platform = await generateScopeStoreKeyPair();
    const script = withPythonStoreEntry(
      {
        entry: 'driver_counter/store.py',
        modules: [
          { name: 'driver_counter/store.py', content: new TextEncoder().encode('class CounterStore: pass\n') },
          { name: 'python_modules/vendor_probe/__init__.py', content: new TextEncoder().encode('def label():\n    return "vendor-probe"\n') },
          { name: 'python_modules/vendor_probe/payload.txt', content: new TextEncoder().encode('payload-ok\n') },
        ],
      },
      { className: 'CounterStore', script: vector.script!, callerPublicKeys: [vector.publicKey!], platformPublicKeys: [platform.publicKey] },
    );
    const types = Object.fromEntries(script.modules.map((module) => [module.name, module.contentType]));
    expect(types['driver_counter/store.py']).toBe('text/x-python');
    expect(types['python_modules/vendor_probe/__init__.py']).toBe(STORE_PYTHON_DATA_CONTENT_TYPE);
    expect(types['python_modules/vendor_probe/payload.txt']).toBe(STORE_PYTHON_DATA_CONTENT_TYPE);
    expect(script.modules.some((module) => /(^|\/)(workers|js|pyodide)(\/|\.py$)/.test(module.name))).toBe(false);
  });
});

describe('the fence the Python entry imports, as shipped (D-70)', () => {
  const shipped = verifier as unknown as {
    storeObjectFence(storage: { get(key: string): Promise<unknown>; put(key: string, value: unknown): Promise<void> }): {
      admit(envelope: { aud: string; op: string }): Promise<{ ok: boolean; status?: number }>;
      close(): Promise<{ ok: boolean }>;
      leave(): Promise<void>;
    };
    storeFenceWipeBody(body: ArrayBuffer): ArrayBuffer;
  };

  it('marks the object under the name the entry shares, and refuses a caller from then on', async () => {
    const stored = new Map<string, unknown>();
    const fence = shipped.storeObjectFence({ get: async (key) => stored.get(key), put: async (key, value) => void stored.set(key, value) });
    expect(await fence.admit({ aud: 'caller', op: 'read' })).toEqual({ ok: true });
    await fence.leave();
    expect(await fence.close()).toEqual({ ok: true });
    expect([...stored.keys()]).toEqual([STORE_FENCE_KEY]);
    expect(await fence.admit({ aud: 'caller', op: 'read' })).toMatchObject({ ok: false, status: 410 });
  });

  it('hands the driver the fence as the wipe it answers', () => {
    const body = new TextEncoder().encode(JSON.stringify({ operation: 'substrat.fence', objectName: 'n' })).buffer;
    expect(JSON.parse(new TextDecoder().decode(shipped.storeFenceWipeBody(body)))).toEqual({ operation: 'substrat.wipe', objectName: 'n' });
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
