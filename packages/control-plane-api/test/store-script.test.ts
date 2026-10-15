import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest';
import { RESERVED_STORE_OPERATIONS, storeKindReleaseDigest, type StoreKindRegistration } from '@substrat-run/contracts';
import { generateScopeStoreKeyPair } from '@substrat-run/contracts/scope-store-envelope';
import { createScopeStoreEnsurer, createStoreCanaryEnsurer, STORE_BUILD_VAR, STORE_RELEASE_VAR } from '../src/store-script.js';
import {
  STORE_ENTRY_PYTHON_MODULE,
  STORE_ENTRY_PYTHON_VERIFIER_SOURCE,
  STORE_OBJECT_CLASS,
  STORE_PYTHON_COMPATIBILITY_DATE,
  STORE_VERIFIER_MODULE,
} from '../src/store-entry.generated.js';

/**
 * The store script upload (#2210, D-63), against a Cloudflare that keeps what was PUT and
 * answers its settings. What the upload builds is `withPythonStoreEntry` (store-entry.test.ts);
 * this holds what it sends, when, and what it refuses.
 */
afterEach(() => vi.unstubAllGlobals());

const bytes = (text: string) => new TextEncoder().encode(text);
const artifact = (source: string) => ({
  entry: 'kind_counter/store.py',
  sourceCommit: 'f'.repeat(40),
  modules: [
    { name: 'kind_counter/store.py', content: bytes(source) },
    // Not UTF-8: a module goes up as the bytes it is.
    { name: 'kind_counter/blob.py', content: new Uint8Array([0x23, 0xff, 0xfe, 0x0a]) },
  ],
});
const v1 = artifact('class Store:\n    pass\n');
const v2 = artifact('class Store:\n    version = 2\n');

let pins: StoreKindRegistration['releases'];
let caller: string;
let platform: string;
beforeAll(async () => {
  pins = [
    { sha256: await storeKindReleaseDigest(v1), sourceCommit: v1.sourceCommit, schema: 0 },
    { sha256: await storeKindReleaseDigest(v2), sourceCommit: v2.sourceCommit, schema: 0 },
  ];
  caller = (await generateScopeStoreKeyPair()).publicKey;
  platform = (await generateScopeStoreKeyPair()).publicKey;
});

type Put = { script: string; meta: Record<string, any>; parts: Map<string, { type: string; bytes: Uint8Array }> };

/** A dispatch namespace: scripts by name, their bindings readable back through settings. */
function cloudflare(options: { settingsStatus?: number; putStatus?: number } = {}) {
  const scripts = new Map<string, { name: string; text?: string }[]>();
  const puts: Put[] = [];
  const calls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: { method?: string; body?: FormData }) => {
      const script = decodeURIComponent(url.split('/scripts/')[1]!.split('/')[0]!);
      if (url.endsWith('/settings')) {
        calls.push(`GET ${script}`);
        if (options.settingsStatus) return new Response('{}', { status: options.settingsStatus });
        const bindings = scripts.get(script);
        return bindings ? Response.json({ result: { bindings } }) : new Response('{}', { status: 404 });
      }
      calls.push(`PUT ${script}`);
      const form = init!.body!;
      const parts = new Map<string, { type: string; bytes: Uint8Array }>();
      for (const [name, value] of form.entries()) {
        if (name === 'metadata' || typeof value === 'string') continue;
        parts.set(name, { type: value.type, bytes: new Uint8Array(await value.arrayBuffer()) });
      }
      const meta = JSON.parse(await (form.get('metadata') as File).text());
      puts.push({ script, meta, parts });
      if (options.putStatus) return new Response('{}', { status: options.putStatus });
      scripts.set(script, meta.bindings);
      return new Response('{}', { status: 200 });
    }),
  );
  return { scripts, puts, calls };
}

function ensurer(input: {
  rolledOut?: ReturnType<typeof artifact> | undefined;
  stored?: ReturnType<typeof artifact>[];
  callerKeys?: string[];
  releases?: StoreKindRegistration['releases'];
  asked?: { sha256?: string }[];
}) {
  return createScopeStoreEnsurer({
    accountId: 'acct',
    namespace: 'ns',
    apiToken: 'tok',
    callerPublicKeys: input.callerKeys ?? [caller],
    platformPublicKeys: [platform],
    kinds: [
      {
        kind: 'graph',
        releases: input.releases ?? pins,
        className: 'Store',
        operations: ['read'],
        platformOperations: [...RESERVED_STORE_OPERATIONS],
      },
    ],
    loadRelease: async ({ sha256 }) => {
      input.asked?.push({ ...(sha256 ? { sha256 } : {}) });
      if (sha256 === undefined) return 'rolledOut' in input ? input.rolledOut : v1;
      for (const candidate of input.stored ?? [v1, v2]) {
        if ((await storeKindReleaseDigest(candidate)) === sha256) return candidate;
      }
      return undefined;
    },
  });
}

const need = { vertical: 'acme/crm', stores: [{ binding: 'GRAPH', kind: 'graph' as const }] };
const SCRIPT = 'substrat-store-graph-acme_crm';
const text = (put: Put, name: string) => (put.meta.bindings as { name: string; text?: string }[]).find((b) => b.name === name)?.text;

describe('a store script is put in place before the vertical (#2210, D-63)', () => {
  it('the first upload is the Python entry, its verifier and the release, byte for byte', async () => {
    const cf = cloudflare();
    const asked: { sha256?: string }[] = [];
    await ensurer({ asked })(need);
    expect(asked).toEqual([{}]);
    expect(cf.puts).toHaveLength(1);
    const [put] = cf.puts as [Put];
    expect(put.script).toBe(SCRIPT);
    expect(put.meta).toMatchObject({
      main_module: STORE_ENTRY_PYTHON_MODULE,
      compatibility_date: STORE_PYTHON_COMPATIBILITY_DATE,
      compatibility_flags: ['python_workers', 'disallow_importable_env', 'disable_ctx_exports'],
      migrations: { new_tag: 'v1', new_sqlite_classes: [STORE_OBJECT_CLASS] },
    });
    expect((put.meta.bindings as { name: string }[]).map((b) => b.name)).toEqual([
      'SUBSTRAT_STORE',
      'SUBSTRAT_STORE_SCRIPT',
      'SUBSTRAT_STORE_CALLER_KEYS',
      'SUBSTRAT_STORE_PLATFORM_KEYS',
      STORE_RELEASE_VAR,
      STORE_BUILD_VAR,
    ]);
    expect(text(put, 'SUBSTRAT_STORE_SCRIPT')).toBe(SCRIPT);
    expect(text(put, STORE_RELEASE_VAR)).toBe(pins[0]!.sha256);
    expect([...put.parts.keys()]).toEqual([STORE_ENTRY_PYTHON_MODULE, STORE_VERIFIER_MODULE, 'kind_counter/store.py', 'kind_counter/blob.py']);
    const entry = new TextDecoder().decode(put.parts.get(STORE_ENTRY_PYTHON_MODULE)!.bytes);
    expect(entry).toContain('from kind_counter.store import Store as StoreKind');
    expect(put.parts.get(STORE_VERIFIER_MODULE)).toEqual({
      type: 'application/javascript+module',
      bytes: bytes(STORE_ENTRY_PYTHON_VERIFIER_SOURCE),
    });
    expect(put.parts.get('kind_counter/blob.py')).toEqual({ type: 'text/x-python', bytes: v1.modules[1]!.content });
  });

  it('a script built from the same inputs is left alone, and a push never moves its release', async () => {
    const cf = cloudflare();
    await ensurer({})(need);
    const asked: { sha256?: string }[] = [];
    // The publish flow has since rolled v2 out. A push still finds the script at v1 and keeps it.
    await ensurer({ rolledOut: v2, asked })(need);
    expect(asked).toEqual([{ sha256: pins[0]!.sha256 }]);
    expect(cf.calls).toEqual([`GET ${SCRIPT}`, `PUT ${SCRIPT}`, `GET ${SCRIPT}`]);
  });

  it('a rotated key list rebuilds the script at the release it runs, with no second migration', async () => {
    const cf = cloudflare();
    await ensurer({})(need);
    const next = (await generateScopeStoreKeyPair()).publicKey;
    await ensurer({ rolledOut: v2, callerKeys: [caller, next] })(need);
    expect(cf.puts).toHaveLength(2);
    const [first, second] = cf.puts as [Put, Put];
    expect(text(second, STORE_RELEASE_VAR)).toBe(pins[0]!.sha256);
    expect(text(second, 'SUBSTRAT_STORE_CALLER_KEYS')).toBe(`${caller},${next}`);
    expect(text(second, STORE_BUILD_VAR)).not.toBe(text(first, STORE_BUILD_VAR));
    expect(second.meta.migrations).toBeUndefined();
  });

  it('a script built from anything else (an older entry, say) is rebuilt at its release', async () => {
    const cf = cloudflare();
    await ensurer({})(need);
    const bindings = cf.scripts.get(SCRIPT)!;
    cf.scripts.set(SCRIPT, bindings.map((b) => (b.name === STORE_BUILD_VAR ? { ...b, text: 'an older build' } : b)));
    await ensurer({ rolledOut: v2 })(need);
    expect(cf.puts).toHaveLength(2);
    expect(text(cf.puts[1]!, STORE_RELEASE_VAR)).toBe(pins[0]!.sha256);
  });

  it('refuses (422) a release whose bytes are not pinned, before anything is sent', async () => {
    const cf = cloudflare();
    await expect(ensurer({ releases: [pins[1]!] })(need)).rejects.toMatchObject({ status: 422, message: /not pinned/ });
    // One byte more than the pinned release is another release.
    const tampered = { ...v1, modules: [{ ...v1.modules[0]!, content: bytes('class Store:\n    pass\n ') }, v1.modules[1]!] };
    await expect(ensurer({ rolledOut: tampered })(need)).rejects.toMatchObject({ status: 422, message: /not pinned/ });
    expect(cf.puts).toEqual([]);
  });

  it('refuses (422) a recorded release that loads as other bytes', async () => {
    const cf = cloudflare();
    await ensurer({})(need);
    cf.scripts.set(SCRIPT, cf.scripts.get(SCRIPT)!.map((b) => (b.name === STORE_BUILD_VAR ? { ...b, text: 'stale' } : b)));
    const swapped = createScopeStoreEnsurer({
      accountId: 'acct',
      namespace: 'ns',
      apiToken: 'tok',
      callerPublicKeys: [caller],
      platformPublicKeys: [platform],
      kinds: [{ kind: 'graph', releases: pins, className: 'Store', operations: [], platformOperations: [...RESERVED_STORE_OPERATIONS] }],
      loadRelease: async () => v2,
    });
    await expect(swapped(need)).rejects.toMatchObject({ status: 422, message: /loaded as other bytes/ });
    expect(cf.puts).toHaveLength(1);
  });

  it('refuses (422) the pinned modules under another entry: the entry is part of the pin', async () => {
    const cf = cloudflare();
    // The same bytes, with the entry importing another of them: not the release that was pinned.
    const moved = { ...v1, entry: 'kind_counter/blob.py' };
    await expect(ensurer({ rolledOut: moved })(need)).rejects.toMatchObject({ status: 422, message: /is not pinned/ });
    // And a script that runs v1 is not rebuilt onto the other entry under v1's sha256, even by a
    // loader that hands back v1's bytes with it.
    await ensurer({})(need);
    cf.puts.length = 0;
    cf.scripts.set(SCRIPT, cf.scripts.get(SCRIPT)!.map((b) => (b.name === STORE_BUILD_VAR ? { ...b, text: 'stale' } : b)));
    const entryMoved = createScopeStoreEnsurer({
      accountId: 'acct',
      namespace: 'ns',
      apiToken: 'tok',
      callerPublicKeys: [caller],
      platformPublicKeys: [platform],
      kinds: [{ kind: 'graph', releases: pins, className: 'Store', operations: [], platformOperations: [...RESERVED_STORE_OPERATIONS] }],
      loadRelease: async () => moved,
    });
    await expect(entryMoved(need)).rejects.toMatchObject({ status: 422, message: /loaded as other bytes/ });
    expect(cf.puts).toEqual([]);
  });

  it('sends the bytes it hashed, whatever the loader does with its own afterwards', async () => {
    const cf = cloudflare();
    const held = artifact('class Store:\n    pass\n');
    const original = new Uint8Array(held.modules[0]!.content);
    const digest = crypto.subtle.digest.bind(crypto.subtle);
    // The loader rewrites the array it handed over as soon as the hash starts.
    vi.spyOn(crypto.subtle, 'digest').mockImplementation(async (algorithm, data) => {
      held.modules[0]!.content.fill(0x21);
      return digest(algorithm, data);
    });
    try {
      await ensurer({ rolledOut: held })(need);
    } finally {
      vi.restoreAllMocks();
    }
    expect(cf.puts[0]!.parts.get('kind_counter/store.py')!.bytes).toEqual(original);
  });

  it('refuses (422) a release whose modules break the module rule', async () => {
    const cf = cloudflare();
    const bad = { ...v1, modules: [...v1.modules, { name: 'workers.py', content: bytes('') }] };
    const releases = [{ sha256: await storeKindReleaseDigest(bad), sourceCommit: v1.sourceCommit, schema: 0 }];
    await expect(ensurer({ rolledOut: bad, releases })(need)).rejects.toMatchObject({ status: 422, message: /workers\.py/ });
    expect(cf.puts).toEqual([]);
  });

  it('refuses (409) when there is no release to run, and a script that records none', async () => {
    const cf = cloudflare();
    await expect(ensurer({ rolledOut: undefined })(need)).rejects.toMatchObject({ status: 409, message: /no release rolled out/ });
    cf.scripts.set(SCRIPT, [{ name: 'SUBSTRAT_STORE' }]);
    await expect(ensurer({})(need)).rejects.toMatchObject({ status: 409, message: /records no release/ });
    cf.scripts.set(SCRIPT, [{ name: STORE_RELEASE_VAR, text: 'a'.repeat(64) }]);
    await expect(ensurer({})(need)).rejects.toMatchObject({ status: 409, message: /is not stored/ });
    expect(cf.puts).toEqual([]);
  });

  it("answers the runtime's own failures as 502", async () => {
    cloudflare({ settingsStatus: 500 });
    await expect(ensurer({})(need)).rejects.toMatchObject({ status: 502, message: /settings failed/ });
    cloudflare({ putStatus: 500 });
    await expect(ensurer({})(need)).rejects.toMatchObject({ status: 502, message: /upload failed/ });
  });
});

describe('a rollout moves a store script with `to`, and canaries in the platform script (#2300)', () => {
  it('moves the script to `to`, re-hashing it, and a second run with the same `to` uploads nothing', async () => {
    const cf = cloudflare();
    const ensure = ensurer({});
    await ensure(need);
    expect(text(cf.puts[0]!, STORE_RELEASE_VAR)).toBe(pins[0]!.sha256);
    const asked: { sha256?: string }[] = [];
    await ensurer({ asked })({ ...need, to: pins[1]!.sha256 });
    expect(asked).toEqual([{ sha256: pins[1]!.sha256 }]);
    expect(cf.puts).toHaveLength(2);
    expect(text(cf.puts[1]!, STORE_RELEASE_VAR)).toBe(pins[1]!.sha256);
    // Not a first upload: no class migration a second time.
    expect(cf.puts[1]!.meta.migrations).toBeUndefined();
    await ensurer({})({ ...need, to: pins[1]!.sha256 });
    expect(cf.puts).toHaveLength(2);
    // A push afterwards rebuilds at the release the script now records, not the current one.
    const pushAsked: { sha256?: string }[] = [];
    await ensurer({ asked: pushAsked })(need);
    expect(pushAsked).toEqual([{ sha256: pins[1]!.sha256 }]);
    expect(cf.puts).toHaveLength(2);
  });

  it('refuses (422) a `to` the loader answers with other bytes, and a stored release the pins do not hold', async () => {
    const cf = cloudflare();
    // The store holds v2's bytes under v1's key.
    const swapped = createScopeStoreEnsurer({
      accountId: 'acct',
      namespace: 'ns',
      apiToken: 'tok',
      callerPublicKeys: [caller],
      platformPublicKeys: [platform],
      kinds: [{ kind: 'graph', releases: pins, className: 'Store', operations: [], platformOperations: [...RESERVED_STORE_OPERATIONS] }],
      loadRelease: async () => v2,
    });
    await expect(swapped({ ...need, to: pins[0]!.sha256 })).rejects.toMatchObject({ status: 422, message: /loaded as other bytes/ });
    // A loader's own claim is held too, for a script that does not exist yet.
    const claimed = createScopeStoreEnsurer({
      accountId: 'acct',
      namespace: 'ns',
      apiToken: 'tok',
      callerPublicKeys: [caller],
      platformPublicKeys: [platform],
      kinds: [{ kind: 'graph', releases: pins, className: 'Store', operations: [], platformOperations: [...RESERVED_STORE_OPERATIONS] }],
      loadRelease: async () => ({ ...v2, sha256: pins[0]!.sha256 }),
    });
    await expect(claimed(need)).rejects.toMatchObject({ status: 422, message: /loaded as other bytes/ });
    await expect(ensurer({ releases: [pins[0]!] })({ ...need, to: pins[1]!.sha256 })).rejects.toMatchObject({ status: 422, message: /not pinned/ });
    expect(cf.puts).toEqual([]);
  });

  it("uploads the canary to the platform's own script, pinned and built like a vertical's", async () => {
    const cf = cloudflare();
    const canary = createStoreCanaryEnsurer({
      accountId: 'acct',
      namespace: 'ns',
      apiToken: 'tok',
      callerPublicKeys: [caller],
      platformPublicKeys: [platform],
      kinds: [{ kind: 'graph', releases: pins, className: 'Store', operations: [], platformOperations: [...RESERVED_STORE_OPERATIONS] }],
      loadRelease: async ({ sha256 }) => (sha256 === pins[1]!.sha256 ? v2 : undefined),
    });
    expect(await canary({ kind: 'graph', to: pins[1]!.sha256 })).toEqual({ scriptName: 'substrat-store-graph--canary' });
    expect(cf.puts.map((p) => p.script)).toEqual(['substrat-store-graph--canary']);
    expect(text(cf.puts[0]!, 'SUBSTRAT_STORE_SCRIPT')).toBe('substrat-store-graph--canary');
    expect(text(cf.puts[0]!, STORE_RELEASE_VAR)).toBe(pins[1]!.sha256);
    await expect(canary({ kind: 'graph', to: 'a'.repeat(64) })).rejects.toMatchObject({ status: 409 });
    await expect(canary({ kind: 'nokind', to: pins[1]!.sha256 })).rejects.toMatchObject({ status: 403 });
  });
});
