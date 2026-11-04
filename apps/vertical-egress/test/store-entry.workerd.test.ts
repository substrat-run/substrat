import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { connect } from 'node:net';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Miniflare } from 'miniflare';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { STORE_CALL_MAX_BYTES, scopeStoreBodyBytes, scopeStoreObjectName, scopeStoreScriptName } from '@substrat-run/contracts';
import {
  bytesToBase64Url,
  base64UrlToBytes,
  generateScopeStoreKeyPair,
  issueScopeStoreEnvelope,
} from '@substrat-run/contracts/scope-store-envelope';
import { storeScriptAsUploaded } from '../../../tools/workerd-as-uploaded.mjs';

/**
 * The counter driver behind the platform's store entry, on workerd, uploaded as the platform
 * uploads it (#2289). L4: each refusal leaves the counter where it was. L5: an object is bound
 * to the id of the name it was addressed by, so a valid envelope for another name does not
 * open it, a used object or a fresh one. The driver is handed the exact body the entry verified,
 * and an env without the entry's own bindings. A body over STORE_CALL_MAX_BYTES is 413 at the entry
 * and at the object (#2811), before the driver is reached.
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
    driverMain: 'store-entry/counter.ts',
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
        compatibilityFlags: uploaded.compatibilityFlags,
        bindings: uploaded.text,
        durableObjects: { [uploaded.binding]: { className: uploaded.className, useSQLite: true } },
      },
      {
        // The same upload with one key listed for both audiences: the entry refuses everything.
        name: 'misconfigured',
        modules,
        compatibilityDate,
        compatibilityFlags: uploaded.compatibilityFlags,
        bindings: { ...uploaded.text, SUBSTRAT_STORE_PLATFORM_KEYS: caller.publicKey },
        durableObjects: { [uploaded.binding]: { className: uploaded.className, useSQLite: true } },
      },
      {
        // The same upload at a compatibility date where ctx.exports is on by default (2025-11-17).
        name: 'current',
        modules,
        compatibilityDate: '2026-03-01',
        compatibilityFlags: uploaded.compatibilityFlags,
        bindings: uploaded.text,
        durableObjects: { [uploaded.binding]: { className: uploaded.className, useSQLite: true } },
      },
      {
        // The twin: the same, without the upload's disable_ctx_exports, to show the probe sees it.
        name: 'exported',
        modules,
        compatibilityDate: '2026-03-01',
        compatibilityFlags: uploaded.compatibilityFlags.filter((flag) => flag !== 'disable_ctx_exports'),
        bindings: uploaded.text,
        durableObjects: { [uploaded.binding]: { className: uploaded.className, useSQLite: true } },
      },
      {
        // The same upload without its script name: the entry cannot compare the script line.
        name: 'unnamed',
        modules,
        compatibilityDate,
        compatibilityFlags: uploaded.compatibilityFlags,
        bindings: Object.fromEntries(Object.entries(uploaded.text).filter(([name]) => name !== 'SUBSTRAT_STORE_SCRIPT')),
        durableObjects: { [uploaded.binding]: { className: uploaded.className, useSQLite: true } },
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
        durableObjects: { SUBSTRAT_STORE: { className: uploaded.className, scriptName: 'store', useSQLite: true } },
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
  worker?: 'store' | 'misconfigured' | 'unnamed' | 'current' | 'exported';
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
 * mint, (caller, substrat.*) or (platform, a driver operation), reaches the store at all.
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
  it('admits a signed call, and the driver gets the exact body verified and none of the entry bindings', async () => {
    expect(await call()).toEqual({ status: 200, text: JSON.stringify({ result: 1 }) });
    // Spacing and key order a re-serialization would change: the driver sees the bytes as signed.
    const odd = `{ "objectName" : ${JSON.stringify(NAME)},"operation":"echo" , "input": {"é": 1} }`;
    const echoed = await call({ op: 'echo', body: odd });
    expect(echoed.status).toBe(200);
    expect((JSON.parse(echoed.text) as { result: string }).result).toBe(odd);
    const env = await call({ op: 'env' });
    expect(JSON.parse(env.text)).toEqual({ result: [] });
    // Nor through `import { env } from 'cloudflare:workers'`: the upload sets disallow_importable_env.
    const ambient = await call({ op: 'ambient' });
    expect(ambient.status).toBe(200);
    expect(JSON.parse(ambient.text)).toEqual({ result: [] });
  });

  it('at a current compatibility date the driver reaches nothing through ctx.exports, and the entry still admits', async () => {
    expect(await call({ worker: 'current', op: 'exports' })).toEqual({ status: 200, text: JSON.stringify({ result: [] }) });
    expect(await call({ worker: 'current', op: 'ambient' })).toEqual({ status: 200, text: JSON.stringify({ result: [] }) });
    expect(await call({ worker: 'current' })).toEqual({ status: 200, text: JSON.stringify({ result: 1 }) });
    // Without the flag, the same driver would hold a loopback to the entry's class and default export.
    expect(JSON.parse((await call({ worker: 'exported', op: 'exports' })).text)).toEqual({ result: ['SubstratStoreObject', 'default'] });
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

  it('refuses each forged, stale, edited or misaddressed call before the driver runs', async () => {
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
      ['this store script is not configured', { worker: 'unnamed' }],
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

  it('the object checks the call itself: unsigned, forged or stale, addressed by its own id, is refused', async () => {
    const before = (await counter()).result;
    const probe = await mf.getWorker('probe');
    const body = JSON.stringify({ operation: 'increment', input: { by: 1 }, objectName: NAME });
    const fresh = await issueScopeStoreEnvelope({ privateKey: callerKey, aud: 'caller', script: SCRIPT, name: NAME, op: 'increment', body });
    const stale = await issueScopeStoreEnvelope({
      privateKey: callerKey, aud: 'caller', script: SCRIPT, name: NAME, op: 'increment', body, iat: Math.floor(Date.now() / 1000) - 120,
    });
    const other = await issueScopeStoreEnvelope({ privateKey: callerKey, aud: 'caller', script: SCRIPT, name: NAME, op: 'read', body: '{}' });
    const cases: [string, Record<string, string>][] = [
      ['unauthorized: missing', {}],
      ['unauthorized: signature', { 'x-substrat-store-envelope': fresh.header, 'x-substrat-store-signature': other.signature }],
      ['unauthorized: stale', { 'x-substrat-store-envelope': stale.header, 'x-substrat-store-signature': stale.signature }],
    ];
    for (const [expected, headers] of cases) {
      const res = await probe.fetch(`https://probe/invoke?name=${encodeURIComponent(NAME)}`, { method: 'POST', headers, body });
      expect(`${res.status} ${await res.text()}`, expected).toBe(`401 ${expected}`);
    }
    expect((await counter()).result).toBe(before);
  });

  it('admits an envelope once: the same envelope again is refused before the driver runs (K-59)', async () => {
    const body = JSON.stringify({ operation: 'increment', input: { by: 1 }, objectName: NAME });
    const issued = await issueScopeStoreEnvelope({ privateKey: callerKey, aud: 'caller', script: SCRIPT, name: NAME, op: 'increment', body });
    const store = await mf.getWorker('store');
    const send = async () => {
      const res = await store.fetch('https://store/invoke', {
        method: 'POST',
        headers: { 'x-substrat-store-envelope': issued.header, 'x-substrat-store-signature': issued.signature },
        body,
      });
      return `${res.status} ${await res.text()}`;
    };
    const before = (await counter()).result;
    expect(await send()).toMatch(/^200 /);
    expect(await send()).toBe('401 unauthorized: nonce');
    expect((await counter()).result).toBe(before + 1);
  });

  it("forwards the object's alarm to the driver, which keeps one instance across calls", async () => {
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

  describe('the limit on a call body (#2811)', () => {
    const TOO_LARGE = `payload too large: at most ${STORE_CALL_MAX_BYTES} bytes`;

    /** A body of exactly `bytes` UTF-8 bytes naming the operation and the object, padded with `fill`. */
    const bodyOf = (bytes: number, operation: string, fill = 'x', objectName = NAME): string => {
      const frame = (pad: string) => JSON.stringify({ operation, input: { pad }, objectName });
      const base = scopeStoreBodyBytes(frame(''));
      const count = Math.floor((bytes - base) / scopeStoreBodyBytes(fill));
      const body = frame(fill.repeat(count) + 'x'.repeat(bytes - base - count * scopeStoreBodyBytes(fill)));
      expect(scopeStoreBodyBytes(body)).toBe(bytes);
      return body;
    };
    const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
    const sign = (body: string, op: string, name = NAME) => issueScopeStoreEnvelope({ privateKey: callerKey, aud: 'caller', script: SCRIPT, name, op, body });

    /**
     * A POST written by hand on a socket, so its `Content-Length` can be a size whose body is never
     * sent: the entry has to answer without waiting for it. Resolves with the status and body of
     * the answer, and rejects if none comes.
     */
    async function declared(length: number, partial: string): Promise<{ status: number; text: string }> {
      const issued = await sign(partial, 'put');
      const url = await mf.ready;
      return new Promise((resolve, reject) => {
        const socket = connect({ host: url.hostname, port: Number(url.port) });
        let received = '';
        const timer = setTimeout(() => {
          socket.destroy();
          reject(new Error('no answer before the body was sent'));
        }, 10_000);
        socket.on('data', (chunk) => {
          received += chunk.toString('utf8');
          const split = received.indexOf('\r\n\r\n');
          if (split < 0) return;
          const status = Number(received.slice(0, received.indexOf('\r\n')).split(' ')[1]);
          const lengthHeader = /content-length: (\d+)/i.exec(received.slice(0, split));
          const text = received.slice(split + 4);
          if (lengthHeader && text.length < Number(lengthHeader[1])) return;
          clearTimeout(timer);
          socket.destroy();
          resolve({ status, text });
        });
        socket.on('error', (error) => {
          clearTimeout(timer);
          reject(error);
        });
        socket.write(
          [
            'POST /invoke HTTP/1.1',
            'host: store',
            'content-type: application/json',
            `content-length: ${length}`,
            `x-substrat-store-envelope: ${issued.header}`,
            `x-substrat-store-signature: ${issued.signature}`,
            '',
            partial,
          ].join('\r\n'),
        );
      });
    }

    it('answers a Content-Length over the limit with 413 without waiting for the body', async () => {
      const before = (await counter()).result;
      const answer = await declared(STORE_CALL_MAX_BYTES + 1, '{"operation":"put"');
      expect(answer.status).toBe(413);
      expect(answer.text).toBe(TOO_LARGE);
      expect((await counter()).result).toBe(before);
    });

    it('answers a body over the limit sent without a Content-Length with 413, signed or not', async () => {
      const before = (await counter()).result;
      for (const signed of [true, false]) {
        const body = bodyOf(STORE_CALL_MAX_BYTES + 1, 'increment');
        const issued = await sign(body, 'increment');
        const encoded = new TextEncoder().encode(body);
        let at = 0;
        // A stream body goes out chunked, so the request has no Content-Length.
        const stream = new ReadableStream<Uint8Array>({
          pull(controller) {
            if (at >= encoded.length) return controller.close();
            controller.enqueue(encoded.slice(at, at + 256 * 1024));
            at += 256 * 1024;
          },
        });
        const res = await (await mf.getWorker('store')).fetch('https://store/invoke', {
          method: 'POST',
          headers: signed ? { 'x-substrat-store-envelope': issued.header, 'x-substrat-store-signature': issued.signature } : {},
          body: stream,
          duplex: 'half',
        });
        expect(res.status).toBe(413);
        expect(await res.text()).toBe(TOO_LARGE);
      }
      expect((await counter()).result).toBe(before);
    }, 30_000);

    it('admits a body at the limit and the driver receives the exact bytes, non-ASCII included', async () => {
      const body = bodyOf(STORE_CALL_MAX_BYTES, 'inspect', 'é€😀');
      const answer = await call({ op: 'inspect', body });
      expect(answer.status).toBe(200);
      expect(JSON.parse(answer.text)).toEqual({ result: { bytes: STORE_CALL_MAX_BYTES, sha256: sha256(body) } });
      // A smaller body echoes back as the same text, so the digest it was signed under still holds.
      const small = bodyOf(2_000, 'echo', 'é€😀');
      const echoed = await call({ op: 'echo', body: small });
      expect(echoed.status).toBe(200);
      expect((JSON.parse(echoed.text) as { result: string }).result).toBe(small);
    }, 60_000);

    it('hands the driver only bytes that were signed: a BOM, an FF for a U+FFFD, a cut sequence are refused', async () => {
      const before = (await counter()).result;
      const text = JSON.stringify({ operation: 'increment', input: { s: 'a�bé' }, objectName: NAME });
      const good = new TextEncoder().encode(text);
      const issued = await sign(text, 'increment');
      const headers = { 'x-substrat-store-envelope': issued.header, 'x-substrat-store-signature': issued.signature };
      const at = good.findIndex((b, i) => b === 0xef && good[i + 1] === 0xbf && good[i + 2] === 0xbd);
      const lead = good.lastIndexOf(0xc3);
      const variants: [string, number[]][] = [
        ['a BOM', [0xef, 0xbb, 0xbf, ...good]],
        ['an FF for the U+FFFD', [...good.slice(0, at), 0xff, ...good.slice(at + 3)]],
        ['a cut sequence', [...good.slice(0, lead + 1), ...good.slice(lead + 2)]],
      ];
      const store = await mf.getWorker('store');
      for (const [label, bytes] of variants) {
        const res = await store.fetch('https://store/invoke', { method: 'POST', headers, body: Uint8Array.from(bytes) });
        expect(`${res.status} ${await res.text()}`, label).toBe('401 unauthorized: digest');
      }
      expect((await counter()).result).toBe(before);
      // The canonical body, a literal U+FFFD in it, is admitted and reaches the driver as signed.
      const echoed = await call({ op: 'echo', body: JSON.stringify({ operation: 'echo', input: { s: 'a�bé﻿' }, objectName: NAME }) });
      expect(echoed.status).toBe(200);
      expect((JSON.parse(echoed.text) as { result: string }).result).toContain('a�bé﻿');
    });

    it('refuses a body one byte over the limit at the object too, before the driver runs', async () => {
      const before = (await counter()).result;
      const probe = await mf.getWorker('probe');
      const body = bodyOf(STORE_CALL_MAX_BYTES + 1, 'increment');
      const issued = await sign(body, 'increment');
      const res = await probe.fetch(`https://probe/invoke?name=${encodeURIComponent(NAME)}`, {
        method: 'POST',
        headers: { 'x-substrat-store-envelope': issued.header, 'x-substrat-store-signature': issued.signature },
        body,
      });
      expect(res.status).toBe(413);
      expect(await res.text()).toBe(TOO_LARGE);
      expect((await counter()).result).toBe(before);
    }, 30_000);
  });
});
