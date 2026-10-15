import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { RESERVED_STORE_OPERATIONS } from '@substrat-run/contracts';
import { createScopeStoreEnsurer, ed25519PublicKey, STORE_SCRIPT_ENTRY } from '../src/store-script.js';
import { STORE_OBJECT_CLASS } from '../src/store-entry.generated.js';

const vector = JSON.parse(
  readFileSync(new URL('../../contracts/test/vectors/scope-store-envelope.json', import.meta.url), 'utf8'),
) as { privateKeyPkcs8: string; publicKey: string };

afterEach(() => vi.unstubAllGlobals());

const release = {
  release: '1.0.0',
  entry: 'kind_counter.py',
  modules: [{ name: 'kind_counter.py', content: new TextEncoder().encode('class Store:\n    pass\n') }],
};

function ensurer(loadRelease: () => Promise<typeof release | undefined> = async () => release) {
  return createScopeStoreEnsurer({
    accountId: 'acct',
    namespace: 'ns',
    apiToken: 'tok',
    callerPublicKey: vector.publicKey,
    platformPublicKey: vector.publicKey,
    kinds: [{
      kind: 'graph',
      runtime: 'python',
      className: 'Store',
      operations: ['read'],
      platformOperations: [...RESERVED_STORE_OPERATIONS],
      publishers: 'staff',
    }],
    loadRelease,
  });
}

describe('a store script is uploaded before the vertical (#2210)', () => {
  it('the platform public key is the raw half of the PKCS8 key', async () => {
    expect(await ed25519PublicKey(vector.privateKeyPkcs8)).toBe(vector.publicKey);
  });

  it('the first upload is a Python worker whose metadata matches a pywrangler deploy', async () => {
    const puts: { url: string; meta: Record<string, unknown>; entry: string }[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: { method?: string; body?: FormData }) => {
      if (url.endsWith('/settings')) return new Response('{}', { status: 404 });
      const form = init?.body;
      puts.push({
        url,
        meta: JSON.parse(await (form!.get('metadata') as File).text()),
        entry: await (form!.get(STORE_SCRIPT_ENTRY) as File).text(),
      });
      return new Response('{}', { status: 200 });
    }));
    await ensurer()({ vertical: 'acme/crm', stores: [{ binding: 'GRAPH', kind: 'graph' }] });
    expect(puts).toHaveLength(1);
    expect(puts[0]!.url).toContain('/scripts/');
    expect(puts[0]!.meta).toMatchObject({
      main_module: STORE_SCRIPT_ENTRY,
      compatibility_date: '2026-03-01',
      compatibility_flags: ['python_workers'],
      migrations: { new_tag: 'v1', new_sqlite_classes: [STORE_OBJECT_CLASS] },
    });
    const bindings = puts[0]!.meta['bindings'] as { name: string; text?: string; class_name?: string }[];
    expect(bindings.map((b) => b.name)).toEqual([
      'SUBSTRAT_STORE',
      'SUBSTRAT_STORE_VERTICAL',
      'SUBSTRAT_STORE_CALLER_KEY',
      'SUBSTRAT_STORE_PLATFORM_KEY',
      'SUBSTRAT_STORE_RELEASE',
    ]);
    expect(bindings.find((b) => b.name === 'SUBSTRAT_STORE')?.class_name).toBe(STORE_OBJECT_CLASS);
    expect(bindings.find((b) => b.name === 'SUBSTRAT_STORE_VERTICAL')?.text).toBe('acme/crm');
    expect(puts[0]!.entry).toContain('from kind_counter import Store as StoreKind');
    expect(puts[0]!.entry).not.toContain('from kind_counter import CounterStore');
  });

  it('a script already at that release is not uploaded again, and a new release sends no second migration', async () => {
    let stored = '1.0.0';
    const methods: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: { method?: string; body?: FormData }) => {
      methods.push(`${init?.method ?? 'GET'} ${url.endsWith('/settings') ? 'settings' : 'script'}`);
      if (url.endsWith('/settings')) {
        return new Response(JSON.stringify({ result: { bindings: [{ name: 'SUBSTRAT_STORE_RELEASE', text: stored }] } }), { status: 200 });
      }
      const meta = JSON.parse(await (init!.body!.get('metadata') as File).text()) as { migrations?: unknown };
      expect(meta.migrations).toBeUndefined();
      stored = '2.0.0';
      return new Response('{}', { status: 200 });
    }));
    const run = ensurer(async () => release);
    await run({ vertical: 'acme/crm', stores: [{ binding: 'GRAPH', kind: 'graph' }] });
    expect(methods).toEqual(['GET settings']);
    await ensurer(async () => ({ ...release, release: '2.0.0' }))({
      vertical: 'acme/crm',
      stores: [{ binding: 'GRAPH', kind: 'graph' }],
    });
    expect(methods).toEqual(['GET settings', 'GET settings', 'PUT script']);
  });

  it('a kind with no published release is refused before any upload', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    await expect(ensurer(async () => undefined)({ vertical: 'acme/crm', stores: [{ binding: 'GRAPH', kind: 'graph' }] })).rejects.toThrow(/no published release/);
    expect(fetch).not.toHaveBeenCalled();
  });
});
