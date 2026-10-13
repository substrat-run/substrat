import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { scopeStoreObjectName, scopeStoreScriptName, signScopeStoreName } from '@substrat-run/contracts';

/**
 * The scope-store hop on workerd (#2207).
 *
 * A vertical fetches `store.substrat.internal`. Egress hands the call to the
 * router's `ScopeStoreCalls` entrypoint with the dispatch parameters, and the
 * router signs the object name and addresses the store script. The vertical
 * holds neither the namespace nor the key.
 *
 * The workers vitest pool cannot start a Durable Object on a second script, so
 * this suite starts workerd through Miniflare. The router's `handleStoreCall`
 * is the production function. Miniflare's local dispatch namespace does not
 * host a user worker, so the entrypoint's `get` checks the script name
 * `handleStoreCall` chose and fetches the store. A real dispatch-namespace
 * upload is still #2210.
 */

const TENANT = '01JTESTATTACHTENANT000000A';
const SCOPE = '01J00000000000000000000S01';
const OTHER = '01J00000000000000000000S02';
const KEY = 'store-hop-key';
const SCRIPT = scopeStoreScriptName('docs', 'ontomate');

const VERTICAL = `export default {
  async fetch(request) {
    const res = await fetch('https://store.substrat.internal/invoke', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: await request.text(),
    });
    return new Response(await res.text(), { status: res.status, headers: { 'content-type': res.headers.get('content-type') ?? 'text/plain' } });
  },
};`;

/** The store script. The object remembers the first name it accepted. */
const STORE = `import { DurableObject } from 'cloudflare:workers';
export class StoreObject extends DurableObject {
  async fetch(request) {
    const name = new URL(request.url).searchParams.get('name') ?? '';
    const remembered = await this.ctx.storage.get('name');
    if (typeof remembered !== 'string') {
      await this.ctx.storage.put('name', name);
      return Response.json({ result: { name } });
    }
    if (remembered !== name) return new Response('unauthorized', { status: 401 });
    return Response.json({ result: { name: remembered } });
  }
}
let calls = 0;
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/calls') return Response.json({ calls });
    calls += 1;
    const body = await request.json();
    const name = typeof body.objectName === 'string' ? body.objectName : '';
    const mac = request.headers.get('x-substrat-store-mac') ?? '';
    const audience = request.headers.get('x-substrat-store-audience') ?? '';
    if (!(await verify(env.SUBSTRAT_STORE_HMAC_KEY, name, mac))) return new Response('unauthorized', { status: 401 });
    if (String(body.operation ?? '').startsWith('substrat.') && audience !== 'platform') {
      return Response.json({ error: { code: 'forbidden', status: 403 } }, { status: 403 });
    }
    // A test may address a different object than the signed name. Production
    // signs and addresses the same name; this is how the reviewer's attack is
    // reproduced against an object that already remembers one.
    const addressed = request.headers.get('x-substrat-store-address') ?? name;
    const object = env.STORE.get(env.STORE.idFromName(addressed));
    return object.fetch('https://object/?name=' + encodeURIComponent(name));
  },
};
function base64UrlToBytes(value) {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return undefined;
  const padded = value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - (value.length % 4)) % 4);
  try {
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch { return undefined; }
}
async function verify(secret, objectName, signature) {
  const bytes = base64UrlToBytes(signature);
  if (!bytes) return false;
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  return crypto.subtle.verify('HMAC', key, copy, new TextEncoder().encode(objectName));
}
`;

let egressBundle = '';
let routerBundle = '';
let mf: Miniflare;

beforeAll(async () => {
  const egress = await build({
    entryPoints: [fileURLToPath(new URL('../src/worker.ts', import.meta.url).href)],
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    conditions: ['workerd', 'worker', 'import'],
    mainFields: ['module', 'main'],
    write: false,
  });
  egressBundle = egress.outputFiles[0]!.text;
  const router = await build({
    entryPoints: [fileURLToPath(new URL('./store-hop-entry.ts', import.meta.url).href)],
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    conditions: ['workerd', 'worker', 'import'],
    mainFields: ['module', 'main'],
    external: ['cloudflare:workers'],
    write: false,
  });
  routerBundle = router.outputFiles[0]!.text;
  mf = new Miniflare({
    workers: [
      {
        name: 'vertical',
        modules: true,
        script: VERTICAL,
        compatibilityDate: '2025-01-01',
        outboundService: 'egress',
      },
      {
        name: 'egress',
        modules: [{ type: 'ESModule', path: 'worker.mjs', contents: egressBundle }],
        compatibilityDate: '2025-01-01',
        bindings: {
          OUTBOUND_POLICY: {
            slug: 'docs',
            tenant: TENANT,
            scope: SCOPE,
            stores: [{ binding: 'GRAPH', kind: 'ontomate' }],
          },
        },
        serviceBindings: {
          STORE_CALLS: { name: 'router', entrypoint: 'ScopeStoreCalls' },
        },
      },
      {
        name: 'router',
        modules: [{ type: 'ESModule', path: 'worker.mjs', contents: routerBundle }],
        compatibilityDate: '2025-01-01',
        bindings: { STORE_HMAC_KEY: KEY },
        serviceBindings: { STORE: SCRIPT },
      },
      {
        name: SCRIPT,
        modules: true,
        script: STORE,
        compatibilityDate: '2025-01-01',
        bindings: { SUBSTRAT_STORE_HMAC_KEY: KEY },
        durableObjects: { STORE: 'StoreObject' },
      },
    ],
  });
});

afterAll(async () => {
  await mf?.dispose();
});

async function call(body: unknown): Promise<{ status: number; text: string }> {
  const vertical = await mf.getWorker('vertical');
  const res = await vertical.fetch('https://vertical/invoke', {
    method: 'POST',
    body: JSON.stringify(body),
  });
  return { status: res.status, text: await res.text() };
}

describe('a vertical reaches only its own scope store (#2207)', () => {
  it('tenant 1 cannot open tenant 2, and a signature for another name does not', async () => {
    const own = await call({ scopeId: SCOPE, binding: 'GRAPH', operation: 'read' });
    expect(own.status).toBe(200);
    expect(own.text).toContain(scopeStoreObjectName(TENANT, 'docs', SCOPE, 'GRAPH'));

    const before = await (await mf.getWorker(SCRIPT)).fetch('https://store/calls');
    const callsBefore = (await before.json()) as { calls: number };

    const other = await call({ scopeId: OTHER, binding: 'GRAPH', operation: 'read' });
    expect(other.status).toBe(403);

    const after = await (await mf.getWorker(SCRIPT)).fetch('https://store/calls');
    const callsAfter = (await after.json()) as { calls: number };
    expect(callsAfter.calls).toBe(callsBefore.calls);

    const ownName = scopeStoreObjectName(TENANT, 'docs', SCOPE, 'GRAPH');
    const otherName = scopeStoreObjectName(TENANT, 'docs', OTHER, 'GRAPH');
    const store = await mf.getWorker(SCRIPT);
    const attacked = await store.fetch('https://store/invoke', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-substrat-store-mac': await signScopeStoreName(KEY, otherName),
        'x-substrat-store-audience': 'caller',
        'x-substrat-store-address': ownName,
      },
      body: JSON.stringify({ objectName: otherName, operation: 'read' }),
    });
    expect(attacked.status).toBe(401);
  });
});
