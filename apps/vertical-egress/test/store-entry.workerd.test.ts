import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Miniflare } from 'miniflare';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { scopeStoreObjectName, scopeStoreScriptName } from '@substrat-run/contracts';
import {
  bytesToBase64Url,
  base64UrlToBytes,
  generateScopeStoreKeyPair,
  issueScopeStoreEnvelope,
} from '@substrat-run/contracts/scope-store-envelope';
import { storeScriptAsUploaded } from '../../../tools/workerd-as-uploaded.mjs';

/**
 * The counter kind behind the platform's store entry, on workerd, uploaded as the platform
 * uploads it (#2289). L4: each refusal leaves the counter where it was. L5: an object is bound
 * to the id of the name it was addressed by, so a valid envelope for another name does not
 * open it, a used object or a fresh one. The kind is handed the exact body the entry verified,
 * and an env without the entry's own bindings.
 */

const SCRIPT = scopeStoreScriptName('docs', 'counter');
const NAME = scopeStoreObjectName('01JTESTATTACHTENANT000000A', 'docs', '01J00000000000000000000S01', 'GRAPH');
const OTHER = scopeStoreObjectName('01JTESTATTACHTENANT000000A', 'docs', '01J00000000000000000000S02', 'GRAPH');
const FRESH = scopeStoreObjectName('01JTESTATTACHTENANT000000A', 'docs', '01J00000000000000000000S03', 'GRAPH');

let mf: Miniflare;
let callerKey = '';
let platformKey = '';
let callerKid = '';
let platformKid = '';

const compatibilityDate = '2025-01-01';

beforeAll(async () => {
  const caller = await generateScopeStoreKeyPair();
  const platform = await generateScopeStoreKeyPair();
  callerKey = caller.privateKey;
  platformKey = platform.privateKey;
  callerKid = caller.kid;
  platformKid = platform.kid;
  const uploaded = await storeScriptAsUploaded(fileURLToPath(new URL('../../../packages/control-plane-api/', import.meta.url)), {
    kindMain: 'store-entry/counter.ts',
    className: 'CounterStore',
    script: SCRIPT,
    callerPublicKeys: [caller.publicKey],
    platformPublicKeys: [platform.publicKey],
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
        compatibilityDate,
        bindings: uploaded.text,
        durableObjects: { [uploaded.binding]: uploaded.className },
      },
      {
        // The same upload with one key listed for both audiences: the entry refuses everything.
        name: 'misconfigured',
        modules,
        compatibilityDate,
        bindings: { ...uploaded.text, SUBSTRAT_STORE_PLATFORM_KEYS: caller.publicKey },
        durableObjects: { [uploaded.binding]: uploaded.className },
      },
      {
        // Addresses the store's object class directly, under an id of its own choosing.
        name: 'probe',
        modules: true,
        script: `export default { async fetch(request, env) {
          const name = new URL(request.url).searchParams.get('name') ?? '';
          const object = env.SUBSTRAT_STORE.get(env.SUBSTRAT_STORE.idFromName(name));
          return object.fetch(new Request(request.url, { method: 'POST', headers: request.headers, body: await request.arrayBuffer() }));
        } }`,
        compatibilityDate,
        durableObjects: { SUBSTRAT_STORE: { className: uploaded.className, scriptName: 'store' } },
      },
    ],
  });
}, 60_000);

afterAll(async () => {
  await mf?.dispose();
});

interface Call {
  name?: string;
  op?: string;
  aud?: 'caller' | 'platform';
  key?: string;
  script?: string;
  iat?: number;
  /** The body as sent, when it differs from the body signed. */
  sent?: string;
  body?: string;
  headers?: (issued: { header: string; signature: string }) => Record<string, string>;
  worker?: 'store' | 'misconfigured';
}

async function call(c: Call = {}): Promise<{ status: number; text: string }> {
  const name = c.name ?? NAME;
  const op = c.op ?? 'increment';
  const body = c.body ?? JSON.stringify({ operation: op, input: { by: 1 }, objectName: name });
  const issued = await issueScopeStoreEnvelope({
    privateKey: c.key ?? callerKey,
    aud: c.aud ?? 'caller',
    script: c.script ?? SCRIPT,
    name,
    op,
    body,
    iat: c.iat,
  });
  const headers = c.headers?.(issued) ?? { 'x-substrat-store-envelope': issued.header, 'x-substrat-store-signature': issued.signature };
  const res = await (await mf.getWorker(c.worker ?? 'store')).fetch('https://store/invoke', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: c.sent ?? body,
  });
  return { status: res.status, text: await res.text() };
}

/**
 * A call whose canonical lines are signed by hand with `key`: how a pair the issuer will not
 * mint, (caller, substrat.*) or (platform, a kind operation), reaches the store at all.
 */
async function signedByHand(key: string, aud: 'caller' | 'platform', op: string, kid: string): Promise<{ status: number; text: string }> {
  const body = JSON.stringify({ operation: op, objectName: NAME });
  const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body)))]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  const canonical = ['1', aud, kid, SCRIPT, NAME, op, digest, String(Math.floor(Date.now() / 1000)), 'AAAAAAAAAAAAAAAAAAAAAA'].join('\n');
  const pkcs8 = base64UrlToBytes(key)!;
  const signingKey = await crypto.subtle.importKey('pkcs8', pkcs8 as Uint8Array<ArrayBuffer>, { name: 'Ed25519' }, false, ['sign']);
  const signature = bytesToBase64Url(new Uint8Array(await crypto.subtle.sign('Ed25519', signingKey, new TextEncoder().encode(canonical))));
  const res = await (await mf.getWorker('store')).fetch('https://store/invoke', {
    method: 'POST',
    headers: { 'x-substrat-store-envelope': bytesToBase64Url(new TextEncoder().encode(canonical)), 'x-substrat-store-signature': signature },
    body,
  });
  return { status: res.status, text: await res.text() };
}

const counter = async () => JSON.parse((await call({ op: 'read' })).text) as { result: number };

describe('the counter behind the store entry (#2289)', () => {
  it('admits a signed call, and the kind gets the exact body verified and none of the entry bindings', async () => {
    expect(await call()).toEqual({ status: 200, text: JSON.stringify({ result: 1 }) });
    // Spacing and key order a re-serialization would change: the kind sees the bytes as signed.
    const odd = `{ "objectName" : ${JSON.stringify(NAME)},"operation":"echo" , "input": {"é": 1} }`;
    const echoed = await call({ op: 'echo', body: odd });
    expect(echoed.status).toBe(200);
    expect((JSON.parse(echoed.text) as { result: string }).result).toBe(odd);
    const env = await call({ op: 'env' });
    expect(JSON.parse(env.text)).toEqual({ result: [] });
  });

  it('admits the platform audience for a reserved operation, and nothing else for it', async () => {
    const size = await call({ op: 'substrat.size', aud: 'platform', key: platformKey });
    expect(size.status).toBe(200);
    expect(JSON.parse(size.text)).toEqual({ result: { bytes: (await counter()).result } });
    const before = (await counter()).result;
    expect(await signedByHand(callerKey, 'caller', 'substrat.wipe', callerKid)).toEqual({ status: 401, text: 'unauthorized: audience' });
    expect(await signedByHand(platformKey, 'platform', 'increment', platformKid)).toEqual({ status: 401, text: 'unauthorized: audience' });
    expect((await counter()).result).toBe(before);
  });

  it('refuses each forged, stale, edited or misaddressed call before the kind runs', async () => {
    const before = (await counter()).result;
    const now = Math.floor(Date.now() / 1000);
    const refusals: [string, Call][] = [
      ['unauthorized: missing', { headers: () => ({}) }],
      ['unauthorized: missing', { headers: (i) => ({ 'x-substrat-store-envelope': i.header }) }],
      ['unauthorized: kid', { key: platformKey }],
      ['unauthorized: stale', { iat: now - 120 }],
      ['unauthorized: stale', { iat: now + 120 }],
      ['unauthorized: digest', { sent: JSON.stringify({ operation: 'increment', input: { by: 100 }, objectName: NAME }) }],
      ['unauthorized: body', { body: JSON.stringify({ operation: 'read', input: { by: 1 }, objectName: NAME }) }],
      ['unauthorized: body', { body: JSON.stringify({ operation: 'increment', input: { by: 1 }, objectName: OTHER }) }],
      ['unauthorized: script', { script: scopeStoreScriptName('docs', 'graph') }],
      [
        'unauthorized: signature',
        {
          headers: (i) => {
            const lines = new TextDecoder().decode(base64UrlToBytes(i.header)).split('\n');
            lines[5] = 'decrement';
            return { 'x-substrat-store-envelope': bytesToBase64Url(new TextEncoder().encode(lines.join('\n'))), 'x-substrat-store-signature': i.signature };
          },
        },
      ],
      [
        'unauthorized: malformed',
        {
          headers: (i) => {
            const lines = new TextDecoder().decode(base64UrlToBytes(i.header)).split('\n');
            lines[0] = '2';
            return { 'x-substrat-store-envelope': bytesToBase64Url(new TextEncoder().encode(lines.join('\n'))), 'x-substrat-store-signature': i.signature };
          },
        },
      ],
      ['this store script is not configured', { worker: 'misconfigured' }],
    ];
    for (const [expected, c] of refusals) {
      const res = await call(c);
      expect(res.text, expected).toBe(expected);
      expect(res.status, expected).toBe(expected.startsWith('unauthorized') ? 401 : 503);
    }
    expect((await counter()).result).toBe(before);
  });

  it('an object answers only to the name whose id it has, used or fresh (L5)', async () => {
    const before = (await counter()).result;
    const probe = await mf.getWorker('probe');
    for (const addressed of [NAME, FRESH]) {
      const body = JSON.stringify({ operation: 'increment', input: { by: 1 }, objectName: OTHER });
      const issued = await issueScopeStoreEnvelope({ privateKey: callerKey, aud: 'caller', script: SCRIPT, name: OTHER, op: 'increment', body });
      const res = await probe.fetch(`https://probe/invoke?name=${encodeURIComponent(addressed)}`, {
        method: 'POST',
        headers: { 'x-substrat-store-envelope': issued.header, 'x-substrat-store-signature': issued.signature },
        body,
      });
      expect(`${res.status} ${await res.text()}`).toBe('401 unauthorized: object');
    }
    expect((await counter()).result).toBe(before);
    // The twin: addressed by its own name's id, the probe is admitted.
    const body = JSON.stringify({ operation: 'read', objectName: NAME });
    const issued = await issueScopeStoreEnvelope({ privateKey: callerKey, aud: 'caller', script: SCRIPT, name: NAME, op: 'read', body });
    const own = await probe.fetch(`https://probe/invoke?name=${encodeURIComponent(NAME)}`, {
      method: 'POST',
      headers: { 'x-substrat-store-envelope': issued.header, 'x-substrat-store-signature': issued.signature },
      body,
    });
    expect(own.status).toBe(200);
  });

  it('accepts the same envelope again inside the window: no nonce memory (RFC Q2)', async () => {
    const body = JSON.stringify({ operation: 'increment', input: { by: 1 }, objectName: NAME });
    const issued = await issueScopeStoreEnvelope({ privateKey: callerKey, aud: 'caller', script: SCRIPT, name: NAME, op: 'increment', body });
    const store = await mf.getWorker('store');
    const send = () =>
      store.fetch('https://store/invoke', {
        method: 'POST',
        headers: { 'x-substrat-store-envelope': issued.header, 'x-substrat-store-signature': issued.signature },
        body,
      });
    const before = (await counter()).result;
    expect((await send()).status).toBe(200);
    expect((await send()).status).toBe(200);
    expect((await counter()).result).toBe(before + 2);
  });

  it("forwards the object's alarm to the kind, which keeps one instance across calls", async () => {
    expect((await call({ op: 'arm' })).status).toBe(200);
    let alarms = 0;
    for (let i = 0; i < 100 && alarms === 0; i++) {
      alarms = (JSON.parse((await call({ op: 'alarmed' })).text) as { result: number }).result;
      if (alarms === 0) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(alarms).toBe(1);
    const seen = async () => (JSON.parse((await call({ op: 'seen' })).text) as { result: number }).result;
    const first = await seen();
    expect(first).toBeGreaterThan(1);
    expect(await seen()).toBe(first + 1);
  });
});
