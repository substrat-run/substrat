import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bytesToBase64Url, issueScopeStoreEnvelope, scopeStoreObjectName, scopeStoreScriptName } from '@substrat-run/contracts';

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
    const raw = await request.text();
    const body = JSON.parse(raw);
    const canonicalBytes = base64UrlToBytes(request.headers.get('x-substrat-store-envelope') ?? '');
    const signature = request.headers.get('x-substrat-store-signature') ?? '';
    if (!canonicalBytes) return new Response('unauthorized', { status: 401 });
    const canonical = new TextDecoder().decode(canonicalBytes);
    const lines = canonical.split('\\n');
    if (lines.length !== 7) return new Response('unauthorized', { status: 401 });
    const audience = lines[1];
    const name = lines[2];
    const digest = lines[4];
    const iat = Number(lines[5]);
    if (!Number.isInteger(iat) || Math.abs(Math.floor(Date.now() / 1000) - iat) > 60) return new Response('unauthorized', { status: 401 });
    if (name !== body.objectName) return new Response('unauthorized', { status: 401 });
    const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw));
    const hex = [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('');
    if (hex !== digest) return new Response('unauthorized', { status: 401 });
    if (!(await verify(env.SUBSTRAT_STORE_CALLER_KEY, canonical, signature))) return new Response('unauthorized', { status: 401 });
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
async function verify(publicKey, canonical, signature) {
  const keyBytes = base64UrlToBytes(publicKey);
  const sigBytes = base64UrlToBytes(signature);
  if (!keyBytes || !sigBytes) return false;
  const keyCopy = new ArrayBuffer(keyBytes.byteLength);
  new Uint8Array(keyCopy).set(keyBytes);
  const sigCopy = new ArrayBuffer(sigBytes.byteLength);
  new Uint8Array(sigCopy).set(sigBytes);
  try {
    const key = await crypto.subtle.importKey('raw', keyCopy, { name: 'Ed25519' }, false, ['verify']);
    return crypto.subtle.verify('Ed25519', key, sigCopy, new TextEncoder().encode(canonical));
  } catch { return false; }
}
`;

let egressBundle = '';
let routerBundle = '';
let mf: Miniflare;
let callerKey = '';

beforeAll(async () => {
  const pair = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  callerKey = bytesToBase64Url(new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey)));
  const callerPublic = bytesToBase64Url(new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey)));
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
        // Ed25519 in WebCrypto needs a workerd this new. 2025-01-01 does not sign.
        compatibilityDate: '2026-03-01',
        bindings: { STORE_CALLER_KEY: callerKey },
        serviceBindings: { STORE: SCRIPT },
      },
      {
        name: SCRIPT,
        modules: true,
        script: STORE,
        compatibilityDate: '2026-03-01',
        bindings: { SUBSTRAT_STORE_CALLER_KEY: callerPublic },
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
});
