const encoder = new TextEncoder();

/** HMAC-SHA256 of `name`, base64. Web Crypto, so the same function runs in workerd and in Node. */
export async function sign(key, name) {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    encoder.encode(key),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = new Uint8Array(
    await crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(name)),
  );
  let binary = '';
  for (const byte of mac) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/**
 * The object cannot read the name it was addressed by (`idFromName` does not
 * round-trip), so the caller presents the name and a signature over it. A
 * signature for a different name must not pass.
 */
export async function verify(key, name, signature) {
  if (!key || !signature) return false;
  const expected = await sign(key, name);
  if (expected.length !== signature.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  return diff === 0;
}
