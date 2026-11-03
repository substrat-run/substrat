import { describe, expect, it } from 'vitest';
import {
  STORE_CALL_MAX_BYTES,
  STORE_CALL_TOO_LARGE_CODE,
  SCOPE_DUMP_PAGE_MAX_BYTES,
  scopeStoreBodyBytes,
} from '@substrat-run/contracts';
import { generateScopeStoreKeyPair, issueScopeStoreEnvelope } from '@substrat-run/contracts/scope-store-envelope';
import { STORE_CALLER_KEYS_VAR, STORE_ENTRY_PYTHON_VERIFIER_SOURCE, STORE_PLATFORM_KEYS_VAR, STORE_SCRIPT_VAR } from '../src/store-entry.generated.js';

/**
 * How a store entry bounds a call's body (#2811), run on the verifier both entries ship: the
 * TypeScript entry bundles it and the Python entry imports it. A body over `STORE_CALL_MAX_BYTES` is
 * refused with 413 in the store envelope, and a `Content-Length` over it is refused before a byte of
 * the body is read. The entries running under workerd are in apps/vertical-egress/test/store-entry.workerd.test.ts
 * and packages/store-entry-python/probe.mjs.
 */
interface Refusal {
  ok: false;
  status: number;
  message: string;
  contentType?: string;
}
type Verified = { ok: true; envelope: { name: string; op: string }; body: ArrayBuffer } | Refusal;
const entry = (await import(`data:text/javascript;base64,${Buffer.from(STORE_ENTRY_PYTHON_VERIFIER_SOURCE).toString('base64')}`)) as {
  verifiedStoreCall(request: { headers: Headers; body: ReadableStream<Uint8Array> | null }, env: Record<string, unknown>): Promise<Verified>;
};

const SCRIPT = 'substrat-store-counter-docs';
const NAME = 'tenant/vertical/scope/graph';
const caller = await generateScopeStoreKeyPair();
const platform = await generateScopeStoreKeyPair();
const env = { [STORE_SCRIPT_VAR]: SCRIPT, [STORE_CALLER_KEYS_VAR]: caller.publicKey, [STORE_PLATFORM_KEYS_VAR]: platform.publicKey };

/** A body of exactly `bytes` UTF-8 bytes naming the signed operation and object, padded with `fill`. */
function bodyOf(bytes: number, fill = 'x'): string {
  const frame = (pad: string) => JSON.stringify({ operation: 'put', objectName: NAME, input: { pad } });
  const base = scopeStoreBodyBytes(frame(''));
  const unit = scopeStoreBodyBytes(fill);
  const count = Math.floor((bytes - base) / unit);
  const body = frame(fill.repeat(count) + 'x'.repeat(bytes - base - count * unit));
  expect(scopeStoreBodyBytes(body)).toBe(bytes);
  return body;
}

async function headersFor(body: string, extra: Record<string, string> = {}): Promise<Headers> {
  const issued = await issueScopeStoreEnvelope({ privateKey: caller.privateKey, aud: 'caller', script: SCRIPT, name: NAME, op: 'put', body });
  return new Headers({ 'x-substrat-store-envelope': issued.header, 'x-substrat-store-signature': issued.signature, ...extra });
}

/** A body stream that counts how often it was asked for a chunk, and whether it was cancelled. */
function stream(bytes: Uint8Array, chunk = 64 * 1024) {
  const seen = { pulls: 0, cancelled: false };
  let at = 0;
  // A high water mark of 0: nothing is pulled until the reader asks.
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        seen.pulls += 1;
        if (at >= bytes.length) return controller.close();
        controller.enqueue(bytes.slice(at, at + chunk));
        at += chunk;
      },
      cancel() {
        seen.cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
  return { body, seen };
}

const TOO_LARGE = {
  ok: false,
  status: 413,
  contentType: 'application/json',
};
const envelopeOf = (refusal: Refusal) => JSON.parse(refusal.message) as { error: { code: string; status: number; body: { limit: number } } };

describe('the limit on a store call', () => {
  it('holds a dump page and the call around it, and is the largest size measured to pass', () => {
    expect(STORE_CALL_MAX_BYTES).toBeGreaterThan(SCOPE_DUMP_PAGE_MAX_BYTES);
    expect(STORE_CALL_MAX_BYTES - SCOPE_DUMP_PAGE_MAX_BYTES).toBeGreaterThanOrEqual(512 * 1024);
    expect(STORE_CALL_MAX_BYTES).toBeLessThanOrEqual(5_000_000);
  });
});

describe('verifiedStoreCall', () => {
  it('refuses a Content-Length over the limit before it reads any of the body', async () => {
    const bytes = new TextEncoder().encode(bodyOf(STORE_CALL_MAX_BYTES + 1));
    const { body, seen } = stream(bytes);
    const answer = await entry.verifiedStoreCall({ headers: await headersFor('{}', { 'content-length': String(bytes.length) }), body }, env);
    expect(answer).toMatchObject(TOO_LARGE);
    expect(envelopeOf(answer as Refusal)).toEqual({
      error: { code: STORE_CALL_TOO_LARGE_CODE, status: 413, body: { message: expect.stringContaining('5000000'), limit: STORE_CALL_MAX_BYTES } },
    });
    expect(seen).toEqual({ pulls: 0, cancelled: false });
  });

  it('refuses a body over the limit with no Content-Length, and stops reading at the limit', async () => {
    const bytes = new Uint8Array(STORE_CALL_MAX_BYTES * 3);
    const { body, seen } = stream(bytes);
    const answer = await entry.verifiedStoreCall({ headers: await headersFor('{}'), body }, env);
    expect(answer).toMatchObject(TOO_LARGE);
    expect(seen.cancelled).toBe(true);
    // It read the chunk that crossed the limit and no more, not the other two thirds of the body.
    expect(seen.pulls).toBeLessThanOrEqual(Math.ceil(STORE_CALL_MAX_BYTES / (64 * 1024)) + 2);
  });

  it('refuses a body over the limit whose Content-Length is false, in either direction', async () => {
    const bytes = new TextEncoder().encode(bodyOf(STORE_CALL_MAX_BYTES + 1));
    for (const declared of ['12', '0', '-5', 'many', '']) {
      const { body, seen } = stream(bytes);
      const answer = await entry.verifiedStoreCall({ headers: await headersFor('{}', { 'content-length': declared }), body }, env);
      expect(answer, `content-length ${JSON.stringify(declared)}`).toMatchObject(TOO_LARGE);
      expect(seen.cancelled).toBe(true);
    }
  });

  it('refuses at one byte over and admits at the limit, handing on the exact bytes', async () => {
    const atLimit = bodyOf(STORE_CALL_MAX_BYTES);
    const bytes = new TextEncoder().encode(atLimit);
    const { body } = stream(bytes);
    const admitted = await entry.verifiedStoreCall({ headers: await headersFor(atLimit, { 'content-length': String(bytes.length) }), body }, env);
    expect(admitted.ok).toBe(true);
    expect(Buffer.from((admitted as { body: ArrayBuffer }).body).equals(Buffer.from(bytes))).toBe(true);

    const over = bodyOf(STORE_CALL_MAX_BYTES + 1);
    const overBytes = new TextEncoder().encode(over);
    expect(await entry.verifiedStoreCall({ headers: await headersFor(over), body: stream(overBytes).body }, env)).toMatchObject(TOO_LARGE);
  });

  it('verifies a non-ASCII body as signed and hands on the same bytes, however the chunks fall', async () => {
    // Two-, three- and four-byte characters, with chunk sizes that split them.
    const text = bodyOf(100_000, 'é€😀');
    const bytes = new TextEncoder().encode(text);
    for (const chunk of [1, 2, 3, 5, 4096, bytes.length]) {
      const { body } = stream(bytes, chunk);
      const answer = await entry.verifiedStoreCall({ headers: await headersFor(text), body }, env);
      expect(answer.ok, `chunk ${chunk}`).toBe(true);
      const handed = Buffer.from((answer as { body: ArrayBuffer }).body);
      expect(handed.equals(Buffer.from(bytes)), `chunk ${chunk}`).toBe(true);
      expect(new TextDecoder().decode(handed)).toBe(text);
    }
  }, 60_000);

  describe('the bytes verified are the bytes handed on', () => {
    const enc = (text: string) => new TextEncoder().encode(text);
    const cat = (...parts: Uint8Array[]) => Uint8Array.from(parts.flatMap((part) => [...part]));
    const DIGEST = { ok: false, status: 401, message: 'unauthorized: digest' };
    const verify = async (signed: string, sent: Uint8Array) =>
      entry.verifiedStoreCall({ headers: await headersFor(signed), body: stream(sent).body }, env);

    it('refuses a BOM in front of a body signed without one', async () => {
      const text = bodyOf(500);
      expect(await verify(text, cat(Uint8Array.of(0xef, 0xbb, 0xbf), enc(text)))).toEqual(DIGEST);
    });

    it('refuses FF in place of the three bytes of a U+FFFD, and a truncated multi-byte sequence', async () => {
      const text = bodyOf(500, 'x').replace('xxxx', 'a�b');
      const good = enc(text);
      const at = good.findIndex((b, i) => b === 0xef && good[i + 1] === 0xbf && good[i + 2] === 0xbd);
      expect(at).toBeGreaterThan(0);
      expect(await verify(text, cat(good.slice(0, at), Uint8Array.of(0xff), good.slice(at + 3)))).toEqual(DIGEST);
      // The same body, cut inside the three bytes, and a two-byte character cut after its lead byte.
      expect(await verify(text, cat(good.slice(0, at), Uint8Array.of(0xef, 0xbf), good.slice(at + 3)))).toEqual(DIGEST);
      const e = bodyOf(500).replace('xxxx', 'é');
      const eb = enc(e);
      const lead = eb.indexOf(0xc3);
      expect(await verify(e, cat(eb.slice(0, lead + 1), eb.slice(lead + 2)))).toEqual(DIGEST);
    });

    it('admits a canonical body with a literal U+FFFD, bytes unchanged', async () => {
      const text = bodyOf(500).replace('xxxx', 'a�b');
      const answer = await verify(text, enc(text));
      expect(answer.ok).toBe(true);
      expect(Buffer.from((answer as { body: ArrayBuffer }).body).equals(Buffer.from(enc(text)))).toBe(true);
    });

    it('admits a U+FEFF inside a signed body with its bytes, and refuses one that leads it: a body is JSON', async () => {
      const inside = bodyOf(500).replace('xxxx', 'a﻿b');
      const answer = await verify(inside, enc(inside));
      expect(answer.ok).toBe(true);
      expect(Buffer.from((answer as { body: ArrayBuffer }).body).equals(Buffer.from(enc(inside)))).toBe(true);
      // Signed as it is sent, a leading U+FEFF is not JSON, so the verifier's body check refuses it.
      const leading = '﻿' + bodyOf(500);
      expect(await verify(leading, enc(leading))).toEqual({ ok: false, status: 401, message: 'unauthorized: body' });
    });
  });

  it('still refuses a body that is not what was signed, and a call with no body', async () => {
    const text = bodyOf(1000);
    const edited = new TextEncoder().encode(text.replace('xxxx', 'xxxy'));
    expect(await entry.verifiedStoreCall({ headers: await headersFor(text), body: stream(edited).body }, env)).toEqual({
      ok: false,
      status: 401,
      message: 'unauthorized: digest',
    });
    expect(await entry.verifiedStoreCall({ headers: await headersFor('{}'), body: null }, env)).toMatchObject({ ok: false, status: 401 });
    expect(await entry.verifiedStoreCall({ headers: new Headers(), body: null }, env)).toEqual({ ok: false, status: 401, message: 'unauthorized: missing' });
  });

  it('answers a store that is not configured with 503 whatever the size', async () => {
    const bytes = new TextEncoder().encode(bodyOf(1000));
    expect(await entry.verifiedStoreCall({ headers: await headersFor('{}'), body: stream(bytes).body }, {})).toEqual({
      ok: false,
      status: 503,
      message: 'this store script is not configured',
    });
  });
});
