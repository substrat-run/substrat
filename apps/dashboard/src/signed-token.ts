/**
 * HMAC-signed claim tokens (invite links, OAuth state) with per-purpose keys.
 *
 * `SESSION_SECRET` is the only signing secret the dashboard holds, and oidc-rp already
 * signs the session cookie with it raw. Signing other things with the same raw key would
 * mean one MAC family for every token the worker mints, so a signature minted for one
 * purpose could be presented for another wherever the payload shapes overlap (#968).
 * Instead each purpose derives its own HMAC key from `SESSION_SECRET` with HKDF-SHA-256
 * and a fixed `info` label: the cookie key, the invite key and the OAuth-state key are
 * cryptographically independent while the operator still rotates one secret.
 *
 * Rotating `SESSION_SECRET` therefore invalidates every outstanding token of every
 * purpose at once — for invites that is fine, a pending invite is re-mintable via
 * resend; for OAuth state the flow is ten minutes and single-use anyway.
 *
 * Web Crypto only (Workers, Node and browsers agree), so this file is node-testable
 * where `worker.ts` (which imports `cloudflare:workers`) is not.
 */

import { b64url, b64urlToBytes } from './b64.js';

/** The purposes the dashboard signs for. The `:v1` is the key-derivation version. */
export const INVITE_TOKEN_PURPOSE = 'substrat-dashboard:invite-token:v1';
export const GITHUB_STATE_PURPOSE = 'substrat-dashboard:github-oauth-state:v1';
export const CONNECT_LINK_PURPOSE = 'substrat-dashboard:connect-link:v1';

const HKDF_SALT = 'substrat-dashboard';

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

/**
 * The HMAC-SHA-256 key for one purpose: HKDF-SHA-256(ikm = secret, salt = fixed,
 * info = purpose). Distinct purposes yield unrelated keys, and none of them equals
 * the raw secret oidc-rp imports for the session cookie.
 */
export async function purposeKey(secret: string, purpose: string): Promise<CryptoKey> {
  const ikm = await crypto.subtle.importKey('raw', enc(secret), 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: enc(HKDF_SALT), info: enc(purpose) },
    ikm,
    { name: 'HMAC', hash: 'SHA-256', length: 256 },
    false,
    ['sign', 'verify'],
  );
}

/** `<base64url(JSON claim)>.<base64url(HMAC)>`, signed with the purpose's derived key. */
export async function signClaim(secret: string, purpose: string, claim: object): Promise<string> {
  const body = b64url(enc(JSON.stringify(claim)));
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', await purposeKey(secret, purpose), enc(body)));
  return `${body}.${b64url(sig)}`;
}

/**
 * The claim if the signature verifies under this purpose's key and `exp` (epoch ms)
 * is still ahead of `now`; `null` otherwise — a token minted for another purpose, or
 * with the raw secret, verifies as `null` exactly like a forged one.
 */
export async function verifyClaim<T extends { exp: number }>(
  secret: string,
  purpose: string,
  token: string,
  now: number,
): Promise<T | null> {
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [body, sig] = parts;
  if (!body || !sig) return null;
  let ok = false;
  try {
    ok = await crypto.subtle.verify('HMAC', await purposeKey(secret, purpose), b64urlToBytes(sig), enc(body));
  } catch {
    return null;
  }
  if (!ok) return null;
  try {
    const claim = JSON.parse(new TextDecoder().decode(b64urlToBytes(body))) as T;
    return typeof claim.exp === 'number' && claim.exp > now ? claim : null;
  } catch {
    return null;
  }
}
