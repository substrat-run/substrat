/**
 * Apple's client secret, which is not a secret anyone can store.
 *
 * Every other provider hands you a string. Apple hands you a `.p8` private key and
 * expects a freshly signed ES256 JWT in the `client_secret` field of each token request,
 * with a lifetime Apple caps at six months. That is precisely the work a tenant should
 * never inherit — a credential that silently expires twice a year is a support incident
 * with a delay fuse — and it is the strongest single argument for a platform-held client.
 *
 * Minted per token request rather than cached. The signature costs microseconds, a cached
 * secret is one more thing that can be stale at exactly the wrong moment, and a Durable
 * Object is not where a derived credential wants to live.
 */
import { b64url } from './jwt.js';

const encoder = new TextEncoder();

export interface AppleSecretInput {
  /** The Services ID — Apple's name for what OAuth calls the client id. */
  clientId: string;
  teamId: string;
  keyId: string;
  /** The `.p8` file's contents, PEM-wrapped PKCS#8. */
  privateKeyPem: string;
}

/**
 * Import a PEM-wrapped PKCS#8 P-256 key. Wrangler hands multi-line secrets back with
 * their newlines intact, but a value pasted through a form or a CI variable often arrives
 * with literal `\n` instead, so both are accepted — the alternative is a signature that
 * fails with an error naming neither cause.
 */
async function importPrivateKey(pem: string): Promise<CryptoKey> {
  const body = pem
    .replace(/\\n/g, '\n')
    .replace(/-----BEGIN [^-]+-----/, '')
    .replace(/-----END [^-]+-----/, '')
    .replace(/\s+/g, '');
  const der = Uint8Array.from(atob(body), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey('pkcs8', der, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
}

/**
 * Sign one client-secret assertion. Six months is Apple's documented ceiling and is used
 * in full: nothing re-reads this token, so a shorter life buys no revocability, and the
 * `iat` is what Apple judges freshness by.
 */
export async function signAppleClientSecret(input: AppleSecretInput, now: number): Promise<string> {
  const issuedAt = Math.floor(now / 1000);
  const header = b64url(encoder.encode(JSON.stringify({ alg: 'ES256', kid: input.keyId })));
  const payload = b64url(
    encoder.encode(
      JSON.stringify({
        iss: input.teamId,
        iat: issuedAt,
        exp: issuedAt + 15777000,
        aud: 'https://appleid.apple.com',
        sub: input.clientId,
      }),
    ),
  );
  const body = `${header}.${payload}`;
  const signature = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    await importPrivateKey(input.privateKeyPem),
    encoder.encode(body),
  );
  return `${body}.${b64url(signature)}`;
}
