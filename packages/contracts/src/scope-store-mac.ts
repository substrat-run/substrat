/**
 * The signature a scope-store object checks before it answers (#2210).
 *
 * HMAC-SHA256 over the object name, Web Crypto only. The control plane holds
 * the key and signs. The store script holds the same key and verifies. A
 * vertical's script is not given the key: it never signs, and a call with no
 * signature, or a signature over a different name, is not this object's call.
 */

declare const btoa: (input: string) => string;
declare const atob: (input: string) => string;

function bytesToBase64Url(bytes: ArrayBuffer): string {
  const view = new Uint8Array(bytes);
  let binary = '';
  for (const byte of view) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

function base64UrlToBytes(value: string): Uint8Array | undefined {
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

async function hmacKey(secret: string, usage: 'sign' | 'verify'): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    [usage],
  );
}

/** Sign an object name. The result is base64url, with no padding. */
export async function signScopeStoreName(secret: string, objectName: string): Promise<string> {
  const key = await hmacKey(secret, 'sign');
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(objectName));
  return bytesToBase64Url(mac);
}

/**
 * Whether `signature` is the HMAC of `objectName` under `secret`. A malformed
 * signature is false. The comparison is Web Crypto's verify, not a string compare.
 */
export async function verifyScopeStoreName(secret: string, objectName: string, signature: string): Promise<boolean> {
  const bytes = base64UrlToBytes(signature);
  if (!bytes) return false;
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  const key = await hmacKey(secret, 'verify');
  return crypto.subtle.verify('HMAC', key, copy, new TextEncoder().encode(objectName));
}
