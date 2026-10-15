import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  base64UrlToBytes,
  bytesToBase64Url,
  canonicalScopeStoreEnvelope,
  generateScopeStoreKeyPair,
  issueScopeStoreEnvelope,
  parseScopeStoreEnvelope,
  parseScopeStorePublicKeys,
  RESERVED_STORE_OPERATIONS,
  scopeStoreBodyDigest,
  scopeStoreEnvelopeAdmits,
  scopeStoreEnvelopeFresh,
  ScopeStoreKeyError,
  scopeStoreKeyId,
  scopeStorePublicKeysFrom,
  verifyScopeStoreCall,
  verifyScopeStoreEnvelope,
  type ScopeStoreEnvelope,
} from '../src/scope-store-envelope.js';

const vector = JSON.parse(readFileSync(new URL('./vectors/scope-store-envelope.json', import.meta.url), 'utf8')) as {
  privateKeyPkcs8: string;
  publicKey: string;
  kid: string;
  script: string;
  body: string;
  canonical: string;
  signature: string;
  header: string;
  staleCanonical: string;
  staleSignature: string;
  windowSeconds: number;
};

const NAME = 'tenant/vertical/scope/graph';
const NOW = 1_700_000_000;
const OTHER_SCRIPT = 'substrat-store-blobs-vertical';

const encode = (text: string) => bytesToBase64Url(new TextEncoder().encode(text));

/** The same 32 bytes spelled differently: a 43-character key has 2 unused trailing bits. */
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const alias = (key: string) => key.slice(0, -1) + ALPHABET[ALPHABET.indexOf(key.at(-1)!) ^ 1];
const bodyFor = (op: string, name = NAME) => JSON.stringify({ objectName: name, operation: op, input: {} });

/** The vector's own call, verified as the store whose script it names. */
const verify = (input: Partial<Parameters<typeof verifyScopeStoreCall>[0]> = {}) =>
  verifyScopeStoreCall({
    envelope: vector.header,
    signature: vector.signature,
    body: vector.body,
    keys: { caller: [vector.publicKey], platform: [] },
    script: vector.script,
    nowSeconds: NOW,
    ...input,
  });

/** The canonical lines of the vector with one replaced, carried under the ORIGINAL signature. */
const tampered = (index: number, value: string) => {
  const lines = vector.canonical.split('\n');
  lines[index] = value;
  return encode(lines.join('\n'));
};

describe('scope store envelope (#2287)', () => {
  it('reproduces the shared vector, which is what another language verifies against', async () => {
    const issued = await issueScopeStoreEnvelope({
      privateKey: vector.privateKeyPkcs8,
      aud: 'caller',
      script: vector.script,
      name: NAME,
      op: 'read',
      body: vector.body,
      iat: NOW,
      nonce: 'AAAAAAAAAAAAAAAAAAAAAA',
    });
    expect(issued.canonical).toBe(vector.canonical);
    expect(issued.signature).toBe(vector.signature);
    expect(issued.header).toBe(vector.header);
    expect(issued.envelope.kid).toBe(vector.kid);
    expect(await scopeStoreKeyId(vector.publicKey)).toBe(vector.kid);
    expect(await verifyScopeStoreEnvelope(vector.publicKey, vector.canonical, vector.signature)).toBe(true);
    expect(await verifyScopeStoreEnvelope(vector.publicKey, vector.staleCanonical, vector.staleSignature)).toBe(true);
    expect(await verify()).toMatchObject({ ok: true, envelope: { aud: 'caller', kid: vector.kid, script: vector.script, name: NAME } });
  });

  it('a field changed under the original signature is refused, whichever field it is', async () => {
    const digestOf = await scopeStoreBodyDigest(bodyFor('write'));
    // Lines: v, aud, kid, script, name, op, digest, iat, nonce.
    for (const [index, value] of [
      [3, OTHER_SCRIPT],
      [4, 'tenant/vertical/scope/other'],
      [5, 'write'],
      [6, digestOf],
      [7, String(NOW + 1)],
      [8, 'BAAAAAAAAAAAAAAAAAAAAA'],
    ] as const) {
      expect(await verify({ envelope: tampered(index, value) }), `line ${index}`).toEqual({ ok: false, refusal: 'signature' });
    }
    // The audience flipped to one that admits the operation is still the wrong signature
    // (a key for that audience is listed, the signature is the caller's).
    const asPlatform = tampered(1, 'platform');
    expect(await verify({ envelope: asPlatform })).toEqual({ ok: false, refusal: 'audience' });
  });

  it('refuses a body edited after signing, and a body naming another object or operation', async () => {
    expect(await verify({ body: vector.body.replace('{}', '{"x":1}') })).toEqual({ ok: false, refusal: 'digest' });
    for (const body of [bodyFor('read', 'tenant/vertical/scope/other'), bodyFor('write')]) {
      const issued = await issueScopeStoreEnvelope({
        privateKey: vector.privateKeyPkcs8, aud: 'caller', script: vector.script, name: NAME, op: 'read', body, iat: NOW,
      });
      expect(await verify({ envelope: issued.header, signature: issued.signature, body })).toEqual({ ok: false, refusal: 'body' });
    }
    const notJson = 'not json';
    const issued = await issueScopeStoreEnvelope({
      privateKey: vector.privateKeyPkcs8, aud: 'caller', script: vector.script, name: NAME, op: 'read', body: notJson, iat: NOW,
    });
    expect(await verify({ envelope: issued.header, signature: issued.signature, body: notJson })).toEqual({ ok: false, refusal: 'body' });
  });

  it("refuses an envelope signed for another script, compared as an opaque string", async () => {
    expect(await verify({ script: OTHER_SCRIPT })).toEqual({ ok: false, refusal: 'script' });
    expect(await verify({ script: `${vector.script} ` })).toEqual({ ok: false, refusal: 'script' });
    // Any string the signer chose is carried and compared, not parsed.
    const opaque = 'tenant-grain:anything/at all';
    const issued = await issueScopeStoreEnvelope({
      privateKey: vector.privateKeyPkcs8, aud: 'caller', script: opaque, name: NAME, op: 'read', body: vector.body, iat: NOW,
    });
    expect(await verify({ envelope: issued.header, signature: issued.signature, script: opaque })).toMatchObject({ ok: true });
  });

  it('refuses outside the window on either side, and admits its edges', async () => {
    const w = vector.windowSeconds;
    expect(await verify({ nowSeconds: NOW + w })).toMatchObject({ ok: true });
    expect(await verify({ nowSeconds: NOW - w })).toMatchObject({ ok: true });
    expect(await verify({ nowSeconds: NOW + w + 1 })).toEqual({ ok: false, refusal: 'stale' });
    expect(await verify({ nowSeconds: NOW - w - 1 })).toEqual({ ok: false, refusal: 'stale' });
    expect(scopeStoreEnvelopeFresh(NOW, NOW + w)).toBe(true);
    expect(scopeStoreEnvelopeFresh(NOW, NOW + w + 1)).toBe(false);
  });

  it('accepts the same envelope again inside the window: no nonce memory (RFC Q2), by design', async () => {
    expect(await verify()).toMatchObject({ ok: true });
    expect(await verify({ nowSeconds: NOW + 30 })).toMatchObject({ ok: true });
  });

  it('refuses an unknown key id, and picks the listed key whose id matches', async () => {
    const other = await generateScopeStoreKeyPair();
    expect(await verify({ keys: { caller: [other.publicKey], platform: [] } })).toEqual({ ok: false, refusal: 'kid' });
    expect(await verify({ keys: { caller: [], platform: [vector.publicKey] } })).toEqual({ ok: false, refusal: 'kid' });
    // Rotation: both keys listed, either signer verifies.
    const both = { caller: [other.publicKey, vector.publicKey], platform: [] };
    expect(await verify({ keys: both })).toMatchObject({ ok: true });
    const fresh = await issueScopeStoreEnvelope({
      privateKey: other.privateKey, aud: 'caller', script: vector.script, name: NAME, op: 'read', body: vector.body, iat: NOW,
    });
    expect(fresh.envelope.kid).toBe(other.kid);
    expect(await verify({ envelope: fresh.header, signature: fresh.signature, keys: both })).toMatchObject({ ok: true });
    // The kid line rewritten to a listed key's id, under another key's signature.
    expect(await verify({ envelope: tampered(2, other.kid), keys: both })).toEqual({ ok: false, refusal: 'signature' });
  });

  it('refuses a missing, truncated or malformed signature and header', async () => {
    expect(await verify({ signature: null })).toEqual({ ok: false, refusal: 'missing' });
    expect(await verify({ envelope: '' })).toEqual({ ok: false, refusal: 'missing' });
    expect(await verify({ signature: vector.signature.slice(0, -2) })).toEqual({ ok: false, refusal: 'signature' });
    expect(await verify({ signature: vector.staleSignature })).toEqual({ ok: false, refusal: 'signature' });
    expect(await verify({ signature: 'not a signature!' })).toEqual({ ok: false, refusal: 'signature' });
    expect(await verify({ envelope: vector.header.slice(0, -4) })).toEqual({ ok: false, refusal: 'malformed' });
    expect(await verify({ envelope: 'not base64!' })).toEqual({ ok: false, refusal: 'malformed' });
    expect(await verify({ envelope: bytesToBase64Url(new Uint8Array([0xff, 0xfe])) })).toEqual({ ok: false, refusal: 'malformed' });
  });

  it('refuses an unknown version, and a line the encoder cannot emit', async () => {
    expect(await verify({ envelope: tampered(0, '2') })).toEqual({ ok: false, refusal: 'malformed' });
    for (const [index, value] of [
      [1, 'vertical'],
      [2, 'short'],
      [6, 'A'.repeat(64)],
      [7, '-5'],
      [7, '017'],
      [7, '9999999999999999'],
      [8, 'n'],
      [8, 'A'.repeat(23)],
      [3, ''],
    ] as const) {
      expect(await verify({ envelope: tampered(index, value) }), `line ${index} = ${value}`).toEqual({ ok: false, refusal: 'malformed' });
    }
    expect(await verify({ envelope: encode(`${vector.canonical}\n`) })).toEqual({ ok: false, refusal: 'malformed' });
    const valid = parseScopeStoreEnvelope(vector.canonical)!;
    const bad = (patch: Partial<ScopeStoreEnvelope>) => () => canonicalScopeStoreEnvelope({ ...valid, ...patch } as ScopeStoreEnvelope);
    expect(bad({ name: 'a\nb' })).toThrow(/newline/);
    expect(bad({ iat: -1 })).toThrow(/iat/);
    expect(bad({ nonce: 'n' })).toThrow(/malformed/);
    expect(bad({ v: 2 as 1 })).toThrow(/version/);
  });

  it('admits only the (v, aud, op) pairs in its closed table', async () => {
    for (const op of RESERVED_STORE_OPERATIONS) {
      expect(scopeStoreEnvelopeAdmits(1, 'platform', op)).toBe(true);
      expect(scopeStoreEnvelopeAdmits(1, 'caller', op)).toBe(false);
    }
    expect(scopeStoreEnvelopeAdmits(1, 'caller', 'read')).toBe(true);
    expect(scopeStoreEnvelopeAdmits(1, 'platform', 'read')).toBe(false);
    expect(scopeStoreEnvelopeAdmits(1, 'platform', 'substrat.unknown')).toBe(false);
    expect(scopeStoreEnvelopeAdmits(1, 'caller', 'substrat.unknown')).toBe(false);
    expect(scopeStoreEnvelopeAdmits(2, 'caller', 'read')).toBe(false);
    expect(scopeStoreEnvelopeAdmits(1, 'toString', 'read')).toBe(false);
    expect(scopeStoreEnvelopeAdmits(1, '__proto__', 'read')).toBe(false);

    // Signed validly by the key listed for that audience, a pair the table refuses is refused.
    const signedAs = async (aud: 'caller' | 'platform', op: string) => {
      const body = bodyFor(op);
      const envelope = { ...parseScopeStoreEnvelope(vector.canonical)!, aud, op, digest: await scopeStoreBodyDigest(body) };
      const canonical = [envelope.v, aud, envelope.kid, envelope.script, NAME, op, envelope.digest, NOW, envelope.nonce].join('\n');
      const key = await crypto.subtle.importKey(
        'pkcs8', base64UrlToBytes(vector.privateKeyPkcs8)! as Uint8Array<ArrayBuffer>, { name: 'Ed25519' }, false, ['sign'],
      );
      const signature = bytesToBase64Url(new Uint8Array(await crypto.subtle.sign('Ed25519', key, new TextEncoder().encode(canonical))));
      const keys = { caller: aud === 'caller' ? [vector.publicKey] : [], platform: aud === 'platform' ? [vector.publicKey] : [] };
      return verify({ envelope: encode(canonical), signature, body, keys });
    };
    expect(await signedAs('caller', 'substrat.wipe')).toEqual({ ok: false, refusal: 'audience' });
    expect(await signedAs('platform', 'read')).toEqual({ ok: false, refusal: 'audience' });
    expect(await signedAs('platform', 'substrat.wipe')).toMatchObject({ ok: true });
    expect(await signedAs('caller', 'read')).toMatchObject({ ok: true });
    // And the signer will not mint one.
    await expect(
      issueScopeStoreEnvelope({ privateKey: vector.privateKeyPkcs8, aud: 'caller', script: 's', name: NAME, op: 'substrat.wipe', body: '{}' }),
    ).rejects.toThrow(/does not send/);
  });

  it('a signing key that is set but unusable is a ScopeStoreKeyError that does not carry the key', async () => {
    const raw = vector.publicKey;
    for (const key of ['not base64!', raw, bytesToBase64Url(new Uint8Array(48))]) {
      const error = await issueScopeStoreEnvelope({ privateKey: key, aud: 'caller', script: 's', name: NAME, op: 'read', body: '{}' }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ScopeStoreKeyError);
      expect(String((error as Error).message)).not.toContain(key);
    }
  });

  it('parses a public key list, and refuses an empty, short, duplicate, aliased or private entry', async () => {
    const other = await generateScopeStoreKeyPair();
    expect(parseScopeStorePublicKeys(` ${vector.publicKey} , ${other.publicKey}`)).toEqual([vector.publicKey, other.publicKey]);
    // The alias is the same key: same bytes, same kid.
    expect(base64UrlToBytes(alias(vector.publicKey))).toEqual(base64UrlToBytes(vector.publicKey));
    expect(await scopeStoreKeyId(alias(vector.publicKey))).toBe(vector.kid);
    for (const text of [
      '', ',', `${vector.publicKey},`, `${vector.publicKey},${vector.publicKey}`, vector.privateKeyPkcs8, 'abc',
      alias(vector.publicKey), `${vector.publicKey},${alias(vector.publicKey)}`,
    ]) {
      expect(() => parseScopeStorePublicKeys(text), text).toThrow();
    }
  });

  it('refuses one key configured for both audiences, in either spelling (L16)', async () => {
    const other = await generateScopeStoreKeyPair();
    expect(scopeStorePublicKeysFrom({ caller: vector.publicKey, platform: other.publicKey })).toEqual({
      caller: [vector.publicKey],
      platform: [other.publicKey],
    });
    expect(() => scopeStorePublicKeysFrom({ caller: vector.publicKey, platform: `${other.publicKey},${vector.publicKey}` })).toThrow(/both audiences/);
    expect(() => scopeStorePublicKeysFrom({ caller: vector.publicKey, platform: alias(vector.publicKey) })).toThrow(/canonical/);

    // And the verifier refuses the call itself when handed such lists, whichever audience signed.
    for (const keys of [
      { caller: [vector.publicKey], platform: [vector.publicKey] },
      { caller: [vector.publicKey], platform: [alias(vector.publicKey)] },
      { caller: [alias(vector.publicKey), other.publicKey], platform: [vector.publicKey] },
    ]) {
      expect(await verify({ keys })).toEqual({ ok: false, refusal: 'keys' });
    }
    const asPlatform = await issueScopeStoreEnvelope({
      privateKey: vector.privateKeyPkcs8, aud: 'platform', script: vector.script, name: NAME, op: 'substrat.wipe', body: bodyFor('substrat.wipe'), iat: NOW,
    });
    const shared = { caller: [vector.publicKey], platform: [vector.publicKey] };
    expect(await verify({ envelope: asPlatform.header, signature: asPlatform.signature, body: bodyFor('substrat.wipe'), keys: shared })).toEqual({ ok: false, refusal: 'keys' });
    // The twin: separate keys, the platform call verifies.
    expect(
      await verify({ envelope: asPlatform.header, signature: asPlatform.signature, body: bodyFor('substrat.wipe'), keys: { caller: [other.publicKey], platform: [vector.publicKey] } }),
    ).toMatchObject({ ok: true });
  });

  it('refuses a small-order public key in either sign, so a forged signature under it matches nothing', async () => {
    const hex = (h: string) => Uint8Array.from(h.match(/../g)!.map((b) => parseInt(b, 16)));
    const smallOrder = [
      '0000000000000000000000000000000000000000000000000000000000000000',
      '0100000000000000000000000000000000000000000000000000000000000000',
      '26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05',
      'c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a',
      'ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f',
      'edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f',
      'eeffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f',
    ];
    for (const point of smallOrder) {
      for (const signBit of [0, 0x80]) {
        const bytes = hex(point);
        bytes[31] = (bytes[31]! & 0x7f) | signBit;
        const key = bytesToBase64Url(bytes);
        expect(() => parseScopeStorePublicKeys(key), `${point} sign ${signBit}`).toThrow(/small-order/);
        await expect(scopeStoreKeyId(key)).rejects.toThrow(/small-order/);
      }
    }

    // Why: under the identity key, R = identity and S = 0 is a signature of every message for a
    // verifier that does not refuse it. The store's verifier never matches such a key.
    const identity = bytesToBase64Url(hex(smallOrder[1]!));
    const forged = bytesToBase64Url(new Uint8Array([...hex(smallOrder[1]!), ...new Uint8Array(32)]));
    const kidOf = async (key: string) =>
      bytesToBase64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', base64UrlToBytes(key)! as Uint8Array<ArrayBuffer>)).slice(0, 8));
    for (const key of [identity, bytesToBase64Url(hex(smallOrder[2]!))]) {
      const lines = vector.canonical.split('\n');
      lines[2] = await kidOf(key);
      const envelope = encode(lines.join('\n'));
      expect(await verify({ envelope, signature: forged, keys: { caller: [key], platform: [] } })).toEqual({ ok: false, refusal: 'kid' });
    }
    // The twin: the vector's real key is still found by its id.
    expect(await verify({ keys: { caller: [identity, vector.publicKey], platform: [] } })).toMatchObject({ ok: true });
  });

  it('the iat grammar admits exactly the safe integers the encoder emits', () => {
    const lines = vector.canonical.split('\n');
    lines[7] = '999999999999999';
    expect(parseScopeStoreEnvelope(lines.join('\n'))?.iat).toBe(999_999_999_999_999);
    lines[7] = '9999999999999999';
    expect(parseScopeStoreEnvelope(lines.join('\n'))).toBeUndefined();
  });
});
