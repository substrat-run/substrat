/**
 * Stripe's webhook signature, checked the way Stripe documents it, with Web Crypto.
 *
 * Stripe signs `${timestamp}.${rawBody}` with HMAC-SHA256 under the endpoint's signing secret (the
 * whole `whsec_…` string is the key) and sends `Stripe-Signature: t=<unix>,v1=<hex>[,v1=<hex>…]`.
 * More than one `v1` arrives while a secret is being rolled; any one matching is enough. `v0` is a
 * test-mode scheme and is never accepted.
 *
 * The body must be the bytes Stripe sent, unparsed: a JSON round trip reorders nothing in practice
 * and still changes whitespace, and the signature is over the text.
 *
 * A valid signature does not make the body a fact. The connector reads the event back from Stripe
 * by its id before acting, so all a valid signature buys is that the hint came from Stripe.
 */

/** How far a signed timestamp may sit from now, either way — Stripe's own default. */
export const STRIPE_SIGNATURE_TOLERANCE_SECONDS = 300;

export async function verifyStripeSignature(
  secret: string,
  rawBody: string,
  header: string | null | undefined,
  nowSeconds: number,
  toleranceSeconds = STRIPE_SIGNATURE_TOLERANCE_SECONDS,
): Promise<boolean> {
  if (!header || !secret) return false;
  let timestamp: number | null = null;
  const signatures: string[] = [];
  for (const part of header.split(',')) {
    const at = part.indexOf('=');
    if (at < 0) continue;
    const key = part.slice(0, at).trim();
    const value = part.slice(at + 1).trim();
    if (key === 't' && /^\d+$/.test(value)) timestamp = Number(value);
    else if (key === 'v1' && /^[0-9a-f]{64}$/.test(value)) signatures.push(value);
  }
  if (timestamp === null || signatures.length === 0) return false;
  if (Math.abs(nowSeconds - timestamp) > toleranceSeconds) return false;
  const expected = await hmacHex(secret, `${timestamp}.${rawBody}`);
  let matched = false;
  // Every candidate is compared in full, so the time taken says nothing about which one matched.
  for (const candidate of signatures) if (sameHex(candidate, expected)) matched = true;
  return matched;
}

/** The `Stripe-Signature` header for `rawBody` at `timestamp` — the mock's and the tests' signer. */
export async function stripeSignatureHeader(secret: string, rawBody: string, timestamp: number): Promise<string> {
  return `t=${timestamp},v1=${await hmacHex(secret, `${timestamp}.${rawBody}`)}`;
}

async function hmacHex(secret: string, message: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(message)));
  return [...mac].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Constant-time over two 64-character hex strings (both are, by the header parse and the HMAC). */
function sameHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
