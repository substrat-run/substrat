import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { scopeStoreObjectName, scopeStoreScriptName } from '@substrat-run/contracts';
import { generateScopeStoreKeyPair, issueScopeStoreEnvelope } from '@substrat-run/contracts/scope-store-envelope';

/**
 * The scope-store hop on workerd (#2207).
 *
 * A vertical fetches `store.substrat.internal`. Egress hands the call to the
 * router's `ScopeStoreCalls` entrypoint with the dispatch parameters, and the
 * router signs the envelope and addresses the store script. The vertical
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
const SCRIPT = scopeStoreScriptName('docs', 'graph');

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

let egressBundle = '';
let routerBundle = '';
let storeBundle = '';
let mf: Miniflare;
let callerKey = '';

beforeAll(async () => {
  const caller = await generateScopeStoreKeyPair();
  const platform = await generateScopeStoreKeyPair();
  callerKey = caller.privateKey;
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
  const store = await build({
    entryPoints: [fileURLToPath(new URL('./store-hop-store.ts', import.meta.url).href)],
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    conditions: ['workerd', 'worker', 'import'],
    mainFields: ['module', 'main'],
    external: ['cloudflare:workers'],
    write: false,
  });
  storeBundle = store.outputFiles[0]!.text;
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
            stores: [{ binding: 'GRAPH', kind: 'graph' }],
          },
        },
        serviceBindings: {
          STORE_CALLS: { name: 'router', entrypoint: 'ScopeStoreCalls' },
        },
      },
      {
        name: 'router',
        modules: [{ type: 'ESModule', path: 'worker.mjs', contents: routerBundle }],
        // The router's deployed compatibility date (apps/router/wrangler.jsonc): it signs there.
        compatibilityDate: '2025-01-01',
        bindings: { STORE_CALLER_KEY: callerKey },
        serviceBindings: { STORE: SCRIPT },
      },
      {
        name: SCRIPT,
        modules: [{ type: 'ESModule', path: 'worker.mjs', contents: storeBundle }],
        compatibilityDate: '2025-01-01',
        bindings: { SCRIPT_NAME: SCRIPT, CALLER_KEYS: caller.publicKey, PLATFORM_KEYS: platform.publicKey },
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
    expect(own.status, own.text).toBe(200);
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
    const attackBody = JSON.stringify({ objectName: otherName, operation: 'read' });
    const issued = await issueScopeStoreEnvelope({
      privateKey: callerKey,
      aud: 'caller',
      script: SCRIPT,
      name: otherName,
      op: 'read',
      body: attackBody,
    });
    const store = await mf.getWorker(SCRIPT);
    const attacked = await store.fetch('https://store/invoke', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-substrat-store-envelope': issued.header,
        'x-substrat-store-signature': issued.signature,
        'x-substrat-store-address': ownName,
      },
      body: attackBody,
    });
    expect(attacked.status).toBe(401);
  }, 20_000);

  it("an envelope signed for another kind's script, or out of the window, is refused at this one (#2287)", async () => {
    const name = scopeStoreObjectName(TENANT, 'docs', SCOPE, 'GRAPH');
    const body = JSON.stringify({ objectName: name, operation: 'read' });
    const store = await mf.getWorker(SCRIPT);
    const send = async (script: string, iat?: number) => {
      const issued = await issueScopeStoreEnvelope({ privateKey: callerKey, aud: 'caller', script, name, op: 'read', body, iat });
      const res = await store.fetch('https://store/invoke', {
        method: 'POST',
        headers: { 'x-substrat-store-envelope': issued.header, 'x-substrat-store-signature': issued.signature },
        body,
      });
      return `${res.status} ${await res.text()}`;
    };
    expect(await send(SCRIPT)).toMatch(/^200 /);
    expect(await send(scopeStoreScriptName('docs', 'blobs'))).toBe('401 unauthorized: script');
    expect(await send(SCRIPT, Math.floor(Date.now() / 1000) - 120)).toBe('401 unauthorized: stale');
  }, 20_000);
});
