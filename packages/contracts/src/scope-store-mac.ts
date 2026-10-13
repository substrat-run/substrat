/**
 * The signature a scope-store object checks before it answers (#2210).
 *
 * HMAC-SHA256 over the object name, Web Crypto only. It binds no audience, operation or time,
 * so it is not the store's authentication: RFC scope-stores §10.3 replaces it with a signed
 * envelope (migration step 5).
 *
 * @internal Not a supported API: exported only so the platform's own signer and the store
 * fixture share one implementation until the §10.3 envelope replaces it.
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

/**
 * Sign an object name. The result is base64url, with no padding.
 *
 * @internal Not a supported API; replaced by the RFC scope-stores §10.3 envelope (step 5).
 */
export async function signScopeStoreName(secret: string, objectName: string): Promise<string> {
  const key = await hmacKey(secret, 'sign');
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(objectName));
  return bytesToBase64Url(mac);
}

/**
 * Whether `signature` is the HMAC of `objectName` under `secret`. A malformed
 * signature is false. The comparison is Web Crypto's verify, not a string compare.
 *
 * @internal Not a supported API; replaced by the RFC scope-stores §10.3 envelope (step 5).
 */
export async function verifyScopeStoreName(secret: string, objectName: string, signature: string): Promise<boolean> {
  const bytes = base64UrlToBytes(signature);
  if (!bytes) return false;
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  const key = await hmacKey(secret, 'verify');
  return crypto.subtle.verify('HMAC', key, copy, new TextEncoder().encode(objectName));
}
