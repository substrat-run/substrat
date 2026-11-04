import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { scopeStoreObjectName, scopeStoreScriptName } from '@substrat-run/contracts';
import { generateScopeStoreKeyPair, issueScopeStoreEnvelope } from '@substrat-run/contracts/scope-store-envelope';
import { storeScriptAsUploaded } from '../../../tools/workerd-as-uploaded.mjs';

/**
 * The scope-store hop on workerd (#2207).
 *
 * A vertical fetches `store.substrat.internal`. Egress hands the call to the
 * router's `ScopeStoreCalls` entrypoint with the dispatch parameters, and the
 * router signs the envelope and addresses the store script. The vertical
 * holds neither the namespace nor the key.
 *
 * The store script is the one that ships: the platform's store entry in front of
 * the counter test driver, uploaded as the platform uploads it (#2289), so the
 * router's signature meets the entry's check. The workers vitest pool cannot start
 * a Durable Object on a second script, so this suite starts workerd through
 * Miniflare. Miniflare's local dispatch namespace does not host a user worker, so
 * the entrypoint's `get` checks the script name `handleStoreCall` chose and fetches
 * the store. A real dispatch-namespace upload is still #2210.
 *
 * Every worker runs at the compatibility date the router and the control plane
 * deploy at.
 */

const TENANT = '01JTESTATTACHTENANT000000A';
const SCOPE = '01J00000000000000000000S01';
const OTHER = '01J00000000000000000000S02';
const SCRIPT = scopeStoreScriptName('docs', 'graph');
const compatibilityDate = '2025-01-01';

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

let mf: Miniflare;
let callerKey = '';

const bundle = async (entry: string) =>
  (
    await build({
      entryPoints: [fileURLToPath(new URL(entry, import.meta.url).href)],
      bundle: true,
      format: 'esm',
      platform: 'neutral',
      conditions: ['workerd', 'worker', 'import'],
      mainFields: ['module', 'main'],
      external: ['cloudflare:workers'],
      write: false,
    })
  ).outputFiles[0]!.text;

beforeAll(async () => {
  const caller = await generateScopeStoreKeyPair();
  const platform = await generateScopeStoreKeyPair();
  callerKey = caller.privateKey;
  const store = await storeScriptAsUploaded(fileURLToPath(new URL('../../../packages/control-plane-api/', import.meta.url)), {
    driverMain: 'store-entry/counter.ts',
    className: 'CounterStore',
    script: SCRIPT,
    callerPublicKeys: [caller.publicKey],
    platformPublicKeys: [platform.publicKey],
  });
  mf = new Miniflare({
    workers: [
      {
        name: 'vertical',
        modules: true,
        script: VERTICAL,
        compatibilityDate,
        outboundService: 'egress',
      },
      {
        name: 'egress',
        modules: [{ type: 'ESModule', path: 'worker.mjs', contents: await bundle('../src/worker.ts') }],
        compatibilityDate,
        bindings: {
          OUTBOUND_POLICY: {
            slug: 'docs',
            tenant: TENANT,
            scope: SCOPE,
            stores: [{ binding: 'GRAPH', driver: 'graph' }],
          },
        },
        serviceBindings: {
          STORE_CALLS: { name: 'router', entrypoint: 'ScopeStoreCalls' },
        },
      },
      {
        name: 'router',
        modules: [{ type: 'ESModule', path: 'worker.mjs', contents: await bundle('./store-hop-entry.ts') }],
        compatibilityDate,
        bindings: { STORE_CALLER_KEY: callerKey },
        serviceBindings: { STORE: SCRIPT },
      },
      {
        name: SCRIPT,
        modules: store.modules.map((path) => ({ type: 'ESModule' as const, path: basename(path), contents: readFileSync(path) })),
        compatibilityDate,
        compatibilityFlags: store.compatibilityFlags,
        bindings: store.text,
        durableObjects: { [store.binding]: store.className },
      },
    ],
  });
}, 60_000);

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

/** A call made straight at the store script, signed with the router's key. */
async function direct(name: string, operation: string, options: { script?: string; iat?: number } = {}) {
  const body = JSON.stringify({ objectName: name, operation });
  const issued = await issueScopeStoreEnvelope({
    privateKey: callerKey,
    aud: 'caller',
    script: options.script ?? SCRIPT,
    name,
    op: operation,
    body,
    iat: options.iat,
  });
  const res = await (await mf.getWorker(SCRIPT)).fetch('https://store/invoke', {
    method: 'POST',
    headers: { 'x-substrat-store-envelope': issued.header, 'x-substrat-store-signature': issued.signature },
    body,
  });
  return `${res.status} ${await res.text()}`;
}

describe('a vertical reaches only its own scope store (#2207)', () => {
  it('the router signs a call the store entry admits, and another scope is refused before the store', async () => {
    const own = await call({ scopeId: SCOPE, binding: 'GRAPH', operation: 'increment', input: { by: 2 } });
    expect(own, own.text).toEqual({ status: 200, text: JSON.stringify({ result: 2 }) });

    const other = await call({ scopeId: OTHER, binding: 'GRAPH', operation: 'increment', input: { by: 5 } });
    expect(other.status).toBe(403);
    // Nothing reached the other scope's object: the router refused before it signed.
    expect(await direct(scopeStoreObjectName(TENANT, 'docs', OTHER, 'GRAPH'), 'read')).toBe('200 {"result":0}');
    expect(await direct(scopeStoreObjectName(TENANT, 'docs', SCOPE, 'GRAPH'), 'read')).toBe('200 {"result":2}');
  }, 20_000);

  it("the store's refusal reaches the vertical in its envelope, and an answer outside it is bad_envelope", async () => {
    const ask = (operation: string) => call({ scopeId: SCOPE, binding: 'GRAPH', operation });
    expect(await ask('refuse')).toEqual({
      status: 404,
      text: JSON.stringify({ error: { code: 'session.unknown', status: 404, body: { message: 'no session s1' } } }),
    });
    // A 5xx body is the store's traceback: it never reaches the vertical, not even as raw bytes.
    expect(await ask('fail')).toEqual({ status: 500, text: JSON.stringify({ error: { code: 'host_failed', status: 500 } }) });
    expect(await ask('garble')).toEqual({ status: 502, text: JSON.stringify({ error: { code: 'bad_envelope', status: 502 } }) });
  }, 20_000);

  it("an envelope signed for another driver's script, or out of the window, is refused at this one (#2287)", async () => {
    const name = scopeStoreObjectName(TENANT, 'docs', SCOPE, 'GRAPH');
    expect(await direct(name, 'read')).toMatch(/^200 /);
    expect(await direct(name, 'read', { script: scopeStoreScriptName('docs', 'blobs') })).toBe('401 unauthorized: script');
    expect(await direct(name, 'read', { iat: Math.floor(Date.now() / 1000) - 120 })).toBe('401 unauthorized: stale');
  }, 20_000);
});
