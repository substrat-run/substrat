import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Miniflare } from 'miniflare';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bytesToBase64Url, issueScopeStoreEnvelope } from '@substrat-run/contracts';
import { storeScriptAsUploaded } from '../../../tools/workerd-as-uploaded.mjs';

/**
 * The counter kind behind the store entry, on workerd (#2289). L4: a bad signature,
 * a digest that is not the body, an audience that does not match the operation, a
 * stale issue time, each refused before the counter moves. L5: an object that
 * remembers one name refuses a valid envelope for another.
 */

const VERTICAL = 'docs';
const NAME = '01JTESTATTACHTENANT000000A/docs/01J00000000000000000000S01/GRAPH';
const OTHER = '01JTESTATTACHTENANT000000A/docs/01J00000000000000000000S02/GRAPH';

let mf: Miniflare;
let callerKey = '';
let platformKey = '';

beforeAll(async () => {
  const caller = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  const platform = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  callerKey = bytesToBase64Url(new Uint8Array(await crypto.subtle.exportKey('pkcs8', caller.privateKey)));
  platformKey = bytesToBase64Url(new Uint8Array(await crypto.subtle.exportKey('pkcs8', platform.privateKey)));
  const uploaded = await storeScriptAsUploaded(fileURLToPath(new URL('../../../packages/control-plane-api/', import.meta.url)), {
    kindMain: 'store-entry/counter.ts',
    className: 'CounterStore',
    vertical: VERTICAL,
    callerPublicKey: bytesToBase64Url(new Uint8Array(await crypto.subtle.exportKey('raw', caller.publicKey))),
    platformPublicKey: bytesToBase64Url(new Uint8Array(await crypto.subtle.exportKey('raw', platform.publicKey))),
  });
  const modules = uploaded.modules.map((path: string) => ({
    type: 'ESModule' as const,
    path: basename(path),
    contents: readFileSync(path),
  }));
  mf = new Miniflare({
    workers: [
      {
        name: 'store',
        modules,
        compatibilityDate: '2026-03-01',
        bindings: uploaded.text,
        durableObjects: { [uploaded.binding]: uploaded.className },
      },
      {
        name: 'probe',
        modules: true,
        script: `export default { async fetch(request, env) {
          const name = new URL(request.url).searchParams.get('name') ?? '';
          const object = env.SUBSTRAT_STORE.get(env.SUBSTRAT_STORE.idFromName(name));
          return object.fetch(new Request(request.url, { method: 'POST', headers: request.headers, body: await request.arrayBuffer() }));
        } }`,
        compatibilityDate: '2026-03-01',
        durableObjects: { SUBSTRAT_STORE: { className: uploaded.className, scriptName: 'store' } },
      },
    ],
  });
}, 60_000);

afterAll(async () => {
  await mf?.dispose();
});

async function call(name: string, operation: string, key = callerKey, aud: 'caller' | 'platform' = 'caller'): Promise<Response> {
  const body = JSON.stringify({ operation, input: { by: 1 }, objectName: name });
  const issued = await issueScopeStoreEnvelope({ privateKey: key, aud, name, op: operation, body });
  const store = await mf.getWorker('store');
  return store.fetch('https://store/invoke', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-substrat-store-envelope': issued.header,
      'x-substrat-store-signature': issued.signature,
    },
    body,
  });
}

describe('the counter behind the store entry (#2289)', () => {
  it('checks the envelope before the kind runs, and an object keeps the first name it accepted', async () => {
    const first = await call(NAME, 'increment');
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ result: 1 });

    const forged = await call(NAME, 'increment', platformKey, 'caller');
    expect(forged.status).toBe(401);

    const staleBody = JSON.stringify({ operation: 'increment', input: { by: 1 }, objectName: NAME });
    const stale = await issueScopeStoreEnvelope({
      privateKey: callerKey,
      aud: 'caller',
      name: NAME,
      op: 'increment',
      body: staleBody,
      iat: Math.floor(Date.now() / 1000) - 120,
    });
    const store = await mf.getWorker('store');
    const staleResponse = await store.fetch('https://store/invoke', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-substrat-store-envelope': stale.header,
        'x-substrat-store-signature': stale.signature,
      },
      body: staleBody,
    });
    expect(staleResponse.status).toBe(401);

    const reserved = await call(NAME, 'substrat.wipe');
    expect(reserved.status).toBe(401);

    const read = await call(NAME, 'read');
    expect(await read.json()).toEqual({ result: 1 });

    const probeBody = JSON.stringify({ operation: 'increment', input: { by: 1 }, objectName: OTHER });
    const issued = await issueScopeStoreEnvelope({
      privateKey: callerKey,
      aud: 'caller',
      name: OTHER,
      op: 'increment',
      body: probeBody,
    });
    const probe = await mf.getWorker('probe');
    const attacked = await probe.fetch(`https://probe/invoke?name=${encodeURIComponent(NAME)}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-substrat-store-envelope': issued.header,
        'x-substrat-store-signature': issued.signature,
      },
      body: probeBody,
    });
    expect(attacked.status).toBe(401);
    const after = await call(NAME, 'read');
    expect(await after.json()).toEqual({ result: 1 });
  }, 20_000);
});
