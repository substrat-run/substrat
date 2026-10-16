/**
 * The signed envelope a scope-store call carries (#2287, RFC scope-stores §10.3).
 *
 * Ed25519 over a canonical encoding of every field the store acts on. The router signs
 * audience `caller` and the control plane signs audience `platform`, each with its own
 * private key. A store script holds only public keys, a list per audience, so a key can be
 * rotated without a moment where no key verifies. The encoding is nine lines joined by
 * `\n`, with no trailing newline, so a verifier in another language can rebuild it:
 *
 * ```
 * 1
 * caller|platform
 * <kid: base64url of the first 8 bytes of SHA-256 over the raw public key>
 * <store script name>
 * <object name>
 * <operation>
 * <sha256 hex of the exact request body>
 * <iat, unix seconds>
 * <nonce, base64url of 16 bytes>
 * ```
 *
 * The signature is base64url over those exact UTF-8 bytes. An envelope is fresh for
 * {@link SCOPE_STORE_ENVELOPE_WINDOW_SECONDS} on either side of the verifier's clock. A
 * store does not remember nonces (RFC Q2): an envelope replayed inside the window, at the
 * same script and object with the same body, is accepted again. The reserved operations are
 * idempotent, and a driver operation's retry safety is the vertical's.
 *
 * The script line is an opaque string compared for equality: the signer builds it, the
 * verifier is told its own. Nothing here parses it.
 *
 * This module imports nothing, so a store entry can load it as one file.
 */

declare const btoa: (input: string) => string;
declare const atob: (input: string) => string;

export const SCOPE_STORE_ENVELOPE_VERSION = 1;
export const SCOPE_STORE_ENVELOPE_WINDOW_SECONDS = 60;
/** The request header carrying base64url of the canonical bytes. */
export const SCOPE_STORE_ENVELOPE_HEADER = 'x-substrat-store-envelope';
/** The request header carrying the base64url signature. */
export const SCOPE_STORE_SIGNATURE_HEADER = 'x-substrat-store-signature';

/**
 * The operations only the platform may send to a scope store (#2207). A vertical's
 * stub refuses every one of them. A driver's registration has to answer all of them,
 * `substrat.erase` included, before a hosted deploy may store tenant data.
 */
export const RESERVED_STORE_OPERATIONS = [
  'substrat.export',
  'substrat.import',
  'substrat.size',
  'substrat.wipe',
  'substrat.erase',
] as const;
export type ReservedStoreOperation = (typeof RESERVED_STORE_OPERATIONS)[number];

export type ScopeStoreAudience = 'caller' | 'platform';

export interface ScopeStoreEnvelope {
  readonly v: 1;
  readonly aud: ScopeStoreAudience;
  readonly kid: string;
  readonly script: string;
  readonly name: string;
  readonly op: string;
  readonly digest: string;
  readonly iat: number;
  readonly nonce: string;
}

/**
 * Which operations each (version, audience) admits. Closed: a pair not in this table is
 * refused. `platform` sends exactly the reserved operations, and `caller` sends anything
 * else, never a `substrat.*` name.
 */
const ADMITTED: Readonly<Record<'1', Readonly<Record<ScopeStoreAudience, (op: string) => boolean>>>> = {
  '1': {
    platform: (op) => (RESERVED_STORE_OPERATIONS as readonly string[]).includes(op),
    caller: (op) => !op.startsWith('substrat.'),
  },
};

/** Whether this version admits `op` from `aud`. */
export function scopeStoreEnvelopeAdmits(v: number, aud: string, op: string): boolean {
  const byAudience = Object.hasOwn(ADMITTED, String(v)) ? ADMITTED[String(v) as '1'] : undefined;
  if (!byAudience || !Object.hasOwn(byAudience, aud)) return false;
  return byAudience[aud as ScopeStoreAudience](op);
}

export function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

export function base64UrlToBytes(value: string): Uint8Array | undefined {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return undefined;
  const padded = value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - (value.length % 4)) % 4);
  try {
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return undefined;
  }
}

function copyBytes(bytes: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  return copy;
}

/**
 * Whether `text` is the canonical base64url of exactly `length` bytes: it decodes to that many
 * bytes and re-encodes to the same text, so its unused trailing bits are zero and no second
 * spelling names the same value.
 */
function isCanonicalBase64Url(text: string, length: number): boolean {
  const bytes = base64UrlToBytes(text);
  return bytes?.length === length && bytesToBase64Url(bytes) === text;
}

const NONCE = /^[A-Za-z0-9_-]{22}$/;
const KID = /^[A-Za-z0-9_-]{11}$/;
const DIGEST = /^[0-9a-f]{64}$/;
// At most 15 digits, so every value it admits is a safe integer, as the encoder requires.
const IAT = /^(0|[1-9]\d{0,14})$/;

/** Nine lines, no trailing newline. Throws on a field the parser would refuse. */
export function canonicalScopeStoreEnvelope(envelope: ScopeStoreEnvelope): string {
  if (envelope.v !== SCOPE_STORE_ENVELOPE_VERSION) throw new Error(`unknown store envelope version ${envelope.v}`);
  for (const field of [envelope.aud, envelope.kid, envelope.script, envelope.name, envelope.op, envelope.digest, envelope.nonce]) {
    if (field.length === 0) throw new Error('a store envelope field is empty');
    if (field.includes('\n')) throw new Error('a store envelope field contains a newline');
  }
  if (!Number.isSafeInteger(envelope.iat) || envelope.iat < 0) throw new Error('a store envelope iat is not a non-negative integer');
  const canonical = [
    String(envelope.v),
    envelope.aud,
    envelope.kid,
    envelope.script,
    envelope.name,
    envelope.op,
    envelope.digest,
    String(envelope.iat),
    envelope.nonce,
  ].join('\n');
  if (!parseScopeStoreEnvelope(canonical)) throw new Error('a store envelope field is malformed');
  return canonical;
}

/** The envelope those bytes name, or undefined when they are not exactly what the encoder emits. */
export function parseScopeStoreEnvelope(canonical: string): ScopeStoreEnvelope | undefined {
  const lines = canonical.split('\n');
  if (lines.length !== 9) return undefined;
  const [version, aud, kid, script, name, op, digest, iatText, nonce] = lines as [
    string, string, string, string, string, string, string, string, string,
  ];
  if (version !== '1' || (aud !== 'caller' && aud !== 'platform')) return undefined;
  if (!script || !name || !op) return undefined;
  if (!KID.test(kid) || !DIGEST.test(digest) || !IAT.test(iatText) || !NONCE.test(nonce)) return undefined;
  // The kid is 8 bytes and the nonce 16, each in canonical base64url. IAT's grammar already
  // admits only the decimal text `String(n)` gives for a safe integer n: no sign, no leading zero.
  if (!isCanonicalBase64Url(kid, 8) || !isCanonicalBase64Url(nonce, 16)) return undefined;
  return { v: 1, aud, kid, script, name, op, digest, iat: Number(iatText), nonce };
}

/** SHA-256 of the exact request body, lowercase hex. */
export async function scopeStoreBodyDigest(body: string): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body));
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Whether `iat` is inside the freshness window of `nowSeconds`. */
export function scopeStoreEnvelopeFresh(
  iat: number,
  nowSeconds: number,
  windowSeconds = SCOPE_STORE_ENVELOPE_WINDOW_SECONDS,
): boolean {
  return Math.abs(nowSeconds - iat) <= windowSeconds;
}

/**
 * The encodings of Ed25519's eight small-order points, with the sign bit (the top bit of the
 * last byte) cleared, including the non-canonical encodings p and p+1 of y: the list libsodium
 * refuses. Under such a key a forged signature verifies for many messages (with the identity,
 * R = identity and S = 0 verifies for any message under some verifiers), so no store accepts one.
 */
const SMALL_ORDER_KEYS = [
  '0000000000000000000000000000000000000000000000000000000000000000', // y = 0, order 4
  '0100000000000000000000000000000000000000000000000000000000000000', // the identity, order 1
  '26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05', // order 8
  'c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a', // order 8
  'ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f', // y = p - 1, order 2
  'edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f', // y = p, a non-canonical 0
  'eeffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f', // y = p + 1, a non-canonical identity
];

/** Whether 32 key bytes encode a small-order point, in either sign. */
function isSmallOrderKey(bytes: Uint8Array): boolean {
  const unsigned = Uint8Array.from(bytes);
  unsigned[31] = unsigned[31]! & 0x7f;
  const hex = [...unsigned].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return SMALL_ORDER_KEYS.includes(hex);
}

/**
 * The key id of a raw Ed25519 public key (base64url): base64url of SHA-256's first 8 bytes.
 * Throws on a key that is not 32 bytes or encodes a small-order point, so a verifier given one
 * never matches it.
 */
export async function scopeStoreKeyId(publicKey: string): Promise<string> {
  const bytes = base64UrlToBytes(publicKey);
  if (!bytes || bytes.length !== 32) throw new Error('a store public key is not 32 bytes of base64url');
  if (isSmallOrderKey(bytes)) throw new Error('a store public key is a small-order point');
  const hash = await crypto.subtle.digest('SHA-256', copyBytes(bytes));
  return bytesToBase64Url(new Uint8Array(hash).slice(0, 8));
}

/**
 * A store's public keys for one audience, as configured: raw Ed25519 keys, base64url,
 * separated by commas (whitespace around each is ignored). Throws on an empty list, a key
 * that is not 32 bytes, a small-order point, a key not in canonical base64url (its unused trailing bits set, so
 * two spellings would name one key), or the same key twice. Rotation is: add the new key,
 * switch the signer, then drop the old key.
 */
export function parseScopeStorePublicKeys(text: string): readonly string[] {
  const keys = text.split(',').map((key) => key.trim());
  if (keys.length === 0 || keys.some((key) => key.length === 0)) {
    throw new Error('a store public key list is empty or has an empty entry');
  }
  const seen = new Set<string>();
  for (const key of keys) {
    const bytes = base64UrlToBytes(key);
    if (bytes?.length !== 32) throw new Error('a store public key is not 32 bytes of base64url');
    if (isSmallOrderKey(bytes)) throw new Error('a store public key is a small-order point');
    // Canonical means the bytes re-encode to the same text, so equal text is equal bytes.
    if (bytesToBase64Url(bytes) !== key) throw new Error('a store public key is not canonical base64url');
    if (seen.has(key)) throw new Error('a store public key is listed twice');
    seen.add(key);
  }
  return keys;
}

/**
 * Both audiences' public keys, from their configured lists. Throws on anything
 * {@link parseScopeStorePublicKeys} refuses, and on a key listed for both audiences: whoever
 * holds the `caller` private key could then sign `platform` envelopes, `substrat.erase`
 * included (L16). A store builds its keys only through this.
 */
export function scopeStorePublicKeysFrom(config: { readonly caller: string; readonly platform: string }): ScopeStorePublicKeys {
  const caller = parseScopeStorePublicKeys(config.caller);
  const platform = parseScopeStorePublicKeys(config.platform);
  if (caller.some((key) => platform.includes(key))) {
    throw new Error('a store public key is listed for both audiences');
  }
  return { caller, platform };
}

/**
 * A fresh Ed25519 pair in the shapes this module takes: the PKCS8 private key a signer holds
 * and the raw public key a store lists, both base64url, with the key id the envelope names.
 */
export async function generateScopeStoreKeyPair(): Promise<{
  readonly privateKey: string;
  readonly publicKey: string;
  readonly kid: string;
}> {
  const pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  const privateKey = bytesToBase64Url(new Uint8Array((await crypto.subtle.exportKey('pkcs8', pair.privateKey)) as ArrayBuffer));
  const publicKey = bytesToBase64Url(new Uint8Array((await crypto.subtle.exportKey('raw', pair.publicKey)) as ArrayBuffer));
  return { privateKey, publicKey, kid: await scopeStoreKeyId(publicKey) };
}

interface SigningKey {
  readonly key: CryptoKey;
  readonly kid: string;
}

/** Import a PKCS8 Ed25519 private key (base64url) and derive its key id from its public half. */
async function signingKey(pkcs8: string): Promise<SigningKey> {
  const bytes = base64UrlToBytes(pkcs8);
  if (!bytes) throw new ScopeStoreKeyError('the store signing key is not base64url');
  let jwk: JsonWebKey;
  let key: CryptoKey;
  try {
    // Extractable only so its public half (`x`) can be read for the key id; it never leaves here.
    key = await crypto.subtle.importKey('pkcs8', copyBytes(bytes), { name: 'Ed25519' }, true, ['sign']);
    jwk = (await crypto.subtle.exportKey('jwk', key)) as JsonWebKey;
  } catch {
    throw new ScopeStoreKeyError('the store signing key is not an Ed25519 PKCS8 key');
  }
  if (typeof jwk.x !== 'string') throw new ScopeStoreKeyError('the store signing key has no public half');
  return { key, kid: await scopeStoreKeyId(jwk.x) };
}

/** A signing key that is present but cannot be used. Its message never carries the key. */
export class ScopeStoreKeyError extends Error {
  override readonly name = 'ScopeStoreKeyError';
}

/**
 * Whether `signature` is the Ed25519 signature of `canonical` under the raw public key.
 * A malformed key or signature is false.
 */
export async function verifyScopeStoreEnvelope(
  publicKey: string,
  canonical: string,
  signature: string,
): Promise<boolean> {
  const keyBytes = base64UrlToBytes(publicKey);
  const sigBytes = base64UrlToBytes(signature);
  if (!keyBytes || !sigBytes || sigBytes.length !== 64) return false;
  try {
    const key = await crypto.subtle.importKey('raw', copyBytes(keyBytes), { name: 'Ed25519' }, false, ['verify']);
    return await crypto.subtle.verify('Ed25519', key, copyBytes(sigBytes), new TextEncoder().encode(canonical));
  } catch {
    return false;
  }
}

export interface IssuedScopeStoreEnvelope {
  readonly envelope: ScopeStoreEnvelope;
  readonly canonical: string;
  /** base64url of the canonical UTF-8 bytes. {@link SCOPE_STORE_ENVELOPE_HEADER} carries it. */
  readonly header: string;
  /** {@link SCOPE_STORE_SIGNATURE_HEADER} carries it. */
  readonly signature: string;
}

/**
 * Build, digest and sign one envelope. `iat` and `nonce` default to now and 16 random bytes.
 * Throws {@link ScopeStoreKeyError} when the key is unusable, and an Error when a field is.
 */
export async function issueScopeStoreEnvelope(input: {
  readonly privateKey: string;
  readonly aud: ScopeStoreAudience;
  readonly script: string;
  readonly name: string;
  readonly op: string;
  readonly body: string;
  readonly iat?: number;
  readonly nonce?: string;
}): Promise<IssuedScopeStoreEnvelope> {
  const signer = await signingKey(input.privateKey);
  const envelope: ScopeStoreEnvelope = {
    v: 1,
    aud: input.aud,
    kid: signer.kid,
    script: input.script,
    name: input.name,
    op: input.op,
    digest: await scopeStoreBodyDigest(input.body),
    iat: input.iat ?? Math.floor(Date.now() / 1000),
    nonce: input.nonce ?? bytesToBase64Url(crypto.getRandomValues(new Uint8Array(16))),
  };
  if (!scopeStoreEnvelopeAdmits(envelope.v, envelope.aud, envelope.op)) {
    throw new Error(`audience '${envelope.aud}' does not send '${envelope.op}'`);
  }
  const canonical = canonicalScopeStoreEnvelope(envelope);
  const signature = await crypto.subtle.sign('Ed25519', signer.key, new TextEncoder().encode(canonical));
  return {
    envelope,
    canonical,
    header: bytesToBase64Url(new TextEncoder().encode(canonical)),
    signature: bytesToBase64Url(new Uint8Array(signature)),
  };
}

/** The public keys a store verifies with, per audience. */
export interface ScopeStorePublicKeys {
  readonly caller: readonly string[];
  readonly platform: readonly string[];
}

/** Why a call was refused. A store answers every one of them the same way, 401. */
export type ScopeStoreRefusal =
  | 'missing'
  | 'malformed'
  | 'audience'
  | 'kid'
  | 'signature'
  | 'digest'
  | 'stale'
  | 'script'
  | 'body'
  | 'keys';

export type ScopeStoreCallVerdict =
  | { readonly ok: true; readonly envelope: ScopeStoreEnvelope }
  | { readonly ok: false; readonly refusal: ScopeStoreRefusal };

/**
 * Every envelope check a store makes on a call before the driver's class runs (RFC §10.3
 * checks 1–4, L4, L5), in one place, so a store entry carries no copy. The object binding
 * (check 5: the object's id is `idFromName` of the signed name) is the entry's, because it
 * needs the object's id; so is reading the configured keys and script name.
 *
 * `script` is the store script's own name, compared with the signed line for equality.
 * The body must be JSON naming the signed operation as `operation` and the signed object
 * as `objectName`, so the signed name is the one the driver is asked about.
 */
export async function verifyScopeStoreCall(input: {
  readonly envelope: string | null | undefined;
  readonly signature: string | null | undefined;
  readonly body: string;
  readonly keys: ScopeStorePublicKeys;
  readonly script: string;
  readonly nowSeconds: number;
  readonly windowSeconds?: number;
}): Promise<ScopeStoreCallVerdict> {
  const refuse = (refusal: ScopeStoreRefusal): ScopeStoreCallVerdict => ({ ok: false, refusal });
  if (!input.envelope || !input.signature) return refuse('missing');
  const bytes = base64UrlToBytes(input.envelope);
  if (!bytes) return refuse('malformed');
  let canonical: string;
  try {
    canonical = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return refuse('malformed');
  }
  const envelope = parseScopeStoreEnvelope(canonical);
  if (!envelope) return refuse('malformed');
  if (!scopeStoreEnvelopeAdmits(envelope.v, envelope.aud, envelope.op)) return refuse('audience');
  // Key ids are over the decoded bytes, so two spellings of one key share an id. A key the
  // other audience also lists refuses every call: its holder could sign for either (L16).
  const kidsOf = async (keys: readonly string[]) => {
    const kids = new Map<string, string>();
    for (const key of keys) {
      try {
        kids.set(await scopeStoreKeyId(key), key);
      } catch {
        // A malformed listed key verifies nothing.
      }
    }
    return kids;
  };
  const own = await kidsOf(input.keys[envelope.aud]);
  const other = await kidsOf(input.keys[envelope.aud === 'caller' ? 'platform' : 'caller']);
  if ([...own.keys()].some((kid) => other.has(kid))) return refuse('keys');
  const publicKey = own.get(envelope.kid);
  if (!publicKey) return refuse('kid');
  if (!(await verifyScopeStoreEnvelope(publicKey, canonical, input.signature))) return refuse('signature');
  if (envelope.digest !== (await scopeStoreBodyDigest(input.body))) return refuse('digest');
  if (!scopeStoreEnvelopeFresh(envelope.iat, input.nowSeconds, input.windowSeconds)) return refuse('stale');
  if (envelope.script !== input.script) return refuse('script');
  let parsed: unknown;
  try {
    parsed = JSON.parse(input.body);
  } catch {
    return refuse('body');
  }
  const field = (key: string) => (typeof parsed === 'object' && parsed !== null ? Reflect.get(parsed, key) : undefined);
  if (field('operation') !== envelope.op || field('objectName') !== envelope.name) return refuse('body');
  return { ok: true, envelope };
}
