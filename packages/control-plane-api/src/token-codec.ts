/**
 * The wire codec the platform's stateless HMAC credentials share — push tokens
 * (`push-token.ts`) and tenant tokens (`tenant-token.ts`).
 *
 * Shape: `<prefix>.<b64url payload>.<b64url HMAC-SHA256 sig>`, verified against a
 * secret the holder never sees. One implementation rather than one per credential,
 * because the two must not drift: a verification that differs between them is a
 * difference neither credential's own suite would notice, and the whole point of the
 * prefix is that a reader discriminates WITHOUT trying every secret it holds.
 *
 * The prefix is inside the signed input, never only in front of it. So a payload
 * minted under one prefix cannot be replayed under another even where two deployments
 * happen to configure the same secret for both — the signature is over the pair.
 *
 * Web Crypto only (`globalThis.crypto`): the same API in Node, workerd and a browser,
 * which is what lets this live in a package both a Worker and a Node host import.
 */

const enc = new TextEncoder();

const b64url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const b64urlToBytes = (s: string): Uint8Array<ArrayBuffer> =>
  Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0)) as Uint8Array<ArrayBuffer>;

async function hmacKey(secret: string, usage: KeyUsage): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [usage]);
}

/** Does this presented value claim to be a `<prefix>.…` token at all? */
export function hasTokenPrefix(prefix: string, presented: string): boolean {
  return presented.startsWith(`${prefix}.`);
}

/** Sign a claim into a `<prefix>.<payload>.<sig>` token. */
export async function signToken(prefix: string, secret: string, claim: unknown): Promise<string> {
  const payload = b64url(enc.encode(JSON.stringify(claim)));
  const signingInput = `${prefix}.${payload}`;
  const sig = new Uint8Array(
    await crypto.subtle.sign('HMAC', await hmacKey(secret, 'sign'), enc.encode(signingInput)),
  );
  return `${signingInput}.${b64url(sig)}`;
}

/**
 * Verify a token's prefix, shape and signature → its decoded payload, or null.
 *
 * The payload comes back as `unknown` deliberately: the signature proves WE minted it,
 * and nothing more. Whether the fields are still the ones the caller needs is the
 * caller's own parse — a format bump must fail closed, not arrive half-typed.
 */
export async function openToken(prefix: string, secret: string, token: string): Promise<unknown | null> {
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== prefix) return null;
  const [, payload, sig] = parts as [string, string, string];
  let ok = false;
  try {
    ok = await crypto.subtle.verify(
      'HMAC',
      await hmacKey(secret, 'verify'),
      b64urlToBytes(sig),
      enc.encode(`${prefix}.${payload}`),
    );
  } catch {
    return null;
  }
  if (!ok) return null;
  try {
    return JSON.parse(new TextDecoder().decode(b64urlToBytes(payload))) as unknown;
  } catch {
    return null;
  }
}
