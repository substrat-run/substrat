/**
 * The relay's own signing — ES256 over Web Crypto, because the relay must hand every
 * tenant issuer an `id_token` it can verify against a JWKS, and that is the whole of
 * what it mints.
 *
 * P-256 rather than RSA: the key is generated inside the Durable Object on first use and
 * never leaves it, so nothing about it has to interoperate with an existing key, and a
 * P-256 keypair is generated in microseconds where a 2048-bit RSA one is slow enough to
 * be felt on a cold start. Every OIDC client library that speaks `ES256` accepts it, and
 * Better Auth's generic-OAuth path — the one a tenant issuer federates through — reads
 * the algorithm off the JWKS rather than assuming.
 *
 * Web Crypto only (no `node:crypto`), which is the platform rule and also what makes
 * these functions runnable unchanged in the vitest process that tests them.
 */

/** Base64url, no padding — the only encoding a JWT uses. */
export function b64url(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = '';
  for (const byte of view) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function b64urlDecode(value: string): Uint8Array {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, '='));
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

const encoder = new TextEncoder();

/** A generated signing key, as it is persisted: the pair in JWK form plus its `kid`. */
export interface SigningKey {
  kid: string;
  privateJwk: JsonWebKey;
  publicJwk: JsonWebKey;
}

/**
 * Mint a fresh ES256 keypair. The `kid` is random rather than a thumbprint: a thumbprint
 * is a fine identifier but makes rotation look like a no-op if the same key is ever
 * re-imported, and a random id makes "which key signed this" answerable from the token
 * alone with no arithmetic.
 */
export async function generateSigningKey(): Promise<SigningKey> {
  // Web Crypto's types return unions, because what `generateKey` and `exportKey` produce
  // depends on the algorithm and the format — both of which are literals here.
  const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
  const privateJwk = (await crypto.subtle.exportKey('jwk', pair.privateKey)) as JsonWebKey;
  const publicJwk = (await crypto.subtle.exportKey('jwk', pair.publicKey)) as JsonWebKey;
  const kid = b64url(crypto.getRandomValues(new Uint8Array(8)));
  return { kid, privateJwk, publicJwk };
}

/** The JWKS entry for a key — public half only, with the fields a verifier keys off. */
export function publicJwkOf(key: SigningKey): JsonWebKey & { kid: string; use: string; alg: string } {
  const { d, ...pub } = key.publicJwk as JsonWebKey & { d?: string };
  return { ...pub, kid: key.kid, use: 'sig', alg: 'ES256' };
}

async function importPrivate(key: SigningKey): Promise<CryptoKey> {
  return crypto.subtle.importKey('jwk', key.privateJwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
}

/** Sign a claim set as a compact JWS. */
export async function signJwt(key: SigningKey, claims: Record<string, unknown>): Promise<string> {
  const header = b64url(encoder.encode(JSON.stringify({ alg: 'ES256', typ: 'JWT', kid: key.kid })));
  const payload = b64url(encoder.encode(JSON.stringify(claims)));
  const body = `${header}.${payload}`;
  const signature = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    await importPrivate(key),
    encoder.encode(body),
  );
  return `${body}.${b64url(signature)}`;
}

/**
 * Verify a token this relay minted and return its claims, or null.
 *
 * Used for the access token the relay hands back — `/userinfo` has no session and no
 * store to look the caller up in, so the token IS the record. Expiry is checked here
 * against `now`, which the caller passes so a test can be explicit about it rather than
 * sleeping.
 *
 * Every way a token can be wrong answers the same `null`, INCLUDING the ways that throw:
 * `atob` rejects a segment that is not base64 and `JSON.parse` rejects a payload that is
 * not an object, and the argument for the whole token being the record is that an
 * attacker-supplied string reaches this function. A throw would escape the handler as a
 * 500 on the relay's origin, where a failed authentication belongs — and would also tell
 * the caller, by status alone, that their guess was malformed rather than merely wrong.
 */
export async function verifyJwt(
  key: SigningKey,
  token: string,
  now: number,
): Promise<Record<string, unknown> | null> {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [header, payload, signature] = parts as [string, string, string];
  try {
    const publicKey = await crypto.subtle.importKey(
      'jwk',
      publicJwkOf(key) as JsonWebKey,
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify'],
    );
    const ok = await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      publicKey,
      b64urlDecode(signature),
      encoder.encode(`${header}.${payload}`),
    );
    if (!ok) return null;
    const claims = JSON.parse(new TextDecoder().decode(b64urlDecode(payload))) as Record<string, unknown>;
    if (typeof claims !== 'object' || claims === null) return null;
    const exp = typeof claims.exp === 'number' ? claims.exp : 0;
    if (exp * 1000 <= now) return null;
    return claims;
  } catch {
    return null;
  }
}

/**
 * The claims of a JWT WITHOUT verifying it.
 *
 * Deliberately named for what it does, because it is used in exactly one place where that
 * is sound: reading the `id_token` an upstream just handed us over a TLS connection, in
 * direct response to a code we minted the request for. The signature adds nothing there —
 * we are the audience, the channel is authenticated, and the alternative is fetching and
 * caching Google's and Apple's JWKS to re-verify a token we asked for ourselves. That is
 * the case OIDC Core §3.1.3.7 rule 6 names outright: a token received over a TLS-validated
 * channel direct from the Token Endpoint may be validated by that channel in place of its
 * signature. It must never be used on a token that arrived from a caller — `verifyJwt` is
 * the function for those.
 */
export function unverifiedClaims(token: string): Record<string, unknown> {
  const payload = token.split('.')[1];
  if (!payload) return {};
  try {
    return JSON.parse(new TextDecoder().decode(b64urlDecode(payload))) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** SHA-256, base64url — the PKCE `S256` transform and how client secrets are stored. */
export async function sha256b64url(value: string): Promise<string> {
  return b64url(await crypto.subtle.digest('SHA-256', encoder.encode(value)));
}

/** A random, URL-safe opaque token: flow ids, authorization codes, client secrets. */
export function randomToken(bytes = 32): string {
  return b64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

/**
 * Constant-time string comparison, for the one place a secret is compared by value (the
 * platform registration call). Length is allowed to leak; the content is not.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
