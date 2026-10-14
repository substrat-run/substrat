/**
 * The signed envelope a scope-store call carries (#2287, RFC scope-stores §10.3).
 *
 * Ed25519 over a canonical encoding of every field the store acts on. The router signs
 * audience `caller` and the control plane signs audience `platform`, each with its own
 * key. A store script holds only the public keys. The encoding is seven lines joined by
 * `\n`, with no trailing newline, so a verifier in another language can rebuild it:
 *
 * ```
 * 1
 * caller|platform
 * <object name>
 * <operation>
 * <sha256 hex of the request body>
 * <iat, unix seconds>
 * <nonce, base64url of 16 bytes>
 * ```
 *
 * A field must not contain a newline. The signature is base64url over those exact UTF-8
 * bytes. An envelope is fresh for {@link SCOPE_STORE_ENVELOPE_WINDOW_SECONDS} on either
 * side of the verifier's clock.
 */

declare const btoa: (input: string) => string;
declare const atob: (input: string) => string;

export const SCOPE_STORE_ENVELOPE_VERSION = 1;
export const SCOPE_STORE_ENVELOPE_WINDOW_SECONDS = 60;

export interface ScopeStoreEnvelope {
  readonly v: 1;
  readonly aud: 'caller' | 'platform';
  readonly name: string;
  readonly op: string;
  readonly digest: string;
  readonly iat: number;
  readonly nonce: string;
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

/** Seven lines, no trailing newline. Throws when a field could be split by the encoding. */
export function canonicalScopeStoreEnvelope(envelope: ScopeStoreEnvelope): string {
  if (envelope.v !== SCOPE_STORE_ENVELOPE_VERSION) throw new Error(`unknown store envelope version ${envelope.v}`);
  for (const field of [envelope.aud, envelope.name, envelope.op, envelope.digest, envelope.nonce]) {
    if (field.includes('\n')) throw new Error('a store envelope field contains a newline');
  }
  if (!Number.isInteger(envelope.iat)) throw new Error('a store envelope iat is not an integer');
  return [
    String(envelope.v),
    envelope.aud,
    envelope.name,
    envelope.op,
    envelope.digest,
    String(envelope.iat),
    envelope.nonce,
  ].join('\n');
}

/** The envelope those bytes name, or undefined when they are not version 1. */
export function parseScopeStoreEnvelope(canonical: string): ScopeStoreEnvelope | undefined {
  const lines = canonical.split('\n');
  if (lines.length !== 7) return undefined;
  const [version, aud, name, op, digest, iatText, nonce] = lines;
  if (version !== '1' || (aud !== 'caller' && aud !== 'platform')) return undefined;
  if (!name || !op || !digest || !nonce || !iatText) return undefined;
  if (!/^[0-9a-f]{64}$/.test(digest) || !/^-?\d+$/.test(iatText)) return undefined;
  return { v: 1, aud, name, op, digest, iat: Number(iatText), nonce };
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

/** Sign the canonical bytes. `pkcs8` is the PKCS8 private key, base64url. */
export async function signScopeStoreEnvelope(pkcs8: string, canonical: string): Promise<string> {
  const bytes = base64UrlToBytes(pkcs8);
  if (!bytes) throw new Error('store envelope key is not base64url');
  const key = await crypto.subtle.importKey('pkcs8', copyBytes(bytes), { name: 'Ed25519' }, false, ['sign']);
  const signature = await crypto.subtle.sign('Ed25519', key, new TextEncoder().encode(canonical));
  return bytesToBase64Url(new Uint8Array(signature));
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
  if (!keyBytes || !sigBytes) return false;
  try {
    const key = await crypto.subtle.importKey('raw', copyBytes(keyBytes), { name: 'Ed25519' }, false, ['verify']);
    return crypto.subtle.verify('Ed25519', key, copyBytes(sigBytes), new TextEncoder().encode(canonical));
  } catch {
    return false;
  }
}

export interface IssuedScopeStoreEnvelope {
  readonly envelope: ScopeStoreEnvelope;
  readonly canonical: string;
  /** base64url of the canonical UTF-8 bytes. This is what the header carries. */
  readonly header: string;
  readonly signature: string;
}

/** Build, digest and sign one envelope. `iat` and `nonce` default to now and 16 random bytes. */
export async function issueScopeStoreEnvelope(input: {
  readonly privateKey: string;
  readonly aud: ScopeStoreEnvelope['aud'];
  readonly name: string;
  readonly op: string;
  readonly body: string;
  readonly iat?: number;
  readonly nonce?: string;
}): Promise<IssuedScopeStoreEnvelope> {
  const envelope: ScopeStoreEnvelope = {
    v: 1,
    aud: input.aud,
    name: input.name,
    op: input.op,
    digest: await scopeStoreBodyDigest(input.body),
    iat: input.iat ?? Math.floor(Date.now() / 1000),
    nonce: input.nonce ?? bytesToBase64Url(crypto.getRandomValues(new Uint8Array(16))),
  };
  const canonical = canonicalScopeStoreEnvelope(envelope);
  return {
    envelope,
    canonical,
    header: bytesToBase64Url(new TextEncoder().encode(canonical)),
    signature: await signScopeStoreEnvelope(input.privateKey, canonical),
  };
}
