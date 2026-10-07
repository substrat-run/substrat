/**
 * A self-signed X.509 certificate for one connection's keypair, built with Web Crypto.
 *
 * The tenant uploads this certificate to its app registration; the private key never leaves
 * the platform. Entra reads nothing from the certificate but its public key and validity —
 * it is a key carrier, not a statement anyone verifies a chain for — so this builds the
 * smallest valid v3 certificate: a common name, a validity window, the key, a signature.
 *
 * DER is written by hand because the whole of what is needed is a dozen TLVs, and the
 * alternative is a dependency in a credential path. The cryptography is not hand-rolled:
 * every key, signature and digest here is `crypto.subtle`.
 */

const OID_SHA256_WITH_RSA = '1.2.840.113549.1.1.11';
const OID_COMMON_NAME = '2.5.4.3';

/** The keypair a connection holds, and the certificate the tenant uploads. */
export interface GeneratedCertificate {
  /** PKCS#8 private key, base64. */
  privateKey: string;
  /** The certificate, DER, base64. */
  certificate: string;
  /** ISO 8601. */
  notBefore: string;
  notAfter: string;
}

/** How long a generated certificate lives. The connection's expiry is set from it. */
export const CERTIFICATE_VALIDITY_DAYS = 365;

export async function generateCertificate(opts: { commonName: string; now: Date }): Promise<GeneratedCertificate> {
  const keys = (await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair;
  const spki = new Uint8Array(await crypto.subtle.exportKey('spki', keys.publicKey));
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', keys.privateKey));

  // A minute back, so a clock a little behind Entra's does not read the certificate as not yet valid.
  const notBefore = new Date(Math.floor(opts.now.getTime() / 1000) * 1000 - 60_000);
  const notAfter = new Date(notBefore.getTime() + CERTIFICATE_VALIDITY_DAYS * 86_400_000);
  const serial = crypto.getRandomValues(new Uint8Array(16));
  serial[0]! &= 0x7f; // positive
  const algorithm = seq(oid(OID_SHA256_WITH_RSA), nul());
  const name = seq(set(seq(oid(OID_COMMON_NAME), utf8(opts.commonName))));
  const tbs = seq(
    explicit(0, integer(new Uint8Array([2]))), // v3
    integer(serial),
    algorithm,
    name,
    seq(time(notBefore), time(notAfter)),
    name,
    spki,
  );
  const signature = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', keys.privateKey, tbs));
  const certificate = seq(tbs, algorithm, bitString(signature));
  return {
    privateKey: toBase64(pkcs8),
    certificate: toBase64(certificate),
    notBefore: notBefore.toISOString(),
    notAfter: notAfter.toISOString(),
  };
}

/** The certificate as PEM — what the tenant downloads and uploads to Entra. */
export function certificatePem(certificateBase64: string): string {
  const lines = certificateBase64.match(/.{1,64}/g) ?? [];
  return `-----BEGIN CERTIFICATE-----\n${lines.join('\n')}\n-----END CERTIFICATE-----\n`;
}

/** Base64url SHA-256 of the DER — the `x5t#S256` an assertion names its key by. */
export async function thumbprintS256(certificateBase64: string): Promise<string> {
  return toBase64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', fromBase64(certificateBase64))));
}

/**
 * Uppercase hex SHA-1 of the DER — the thumbprint Entra's **Certificates & secrets** page
 * shows, so the tenant can see the certificate they uploaded is the one this connection holds.
 * For display only; nothing is authenticated by it.
 */
export async function thumbprintSha1Hex(certificateBase64: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-1', fromBase64(certificateBase64)));
  return [...digest].map((b) => b.toString(16).padStart(2, '0')).join('').toUpperCase();
}

// ── DER ──────────────────────────────────────────────────────────────────────

function tlv(tag: number, body: Uint8Array): Uint8Array {
  return concat(new Uint8Array([tag]), length(body.length), body);
}

function length(n: number): Uint8Array {
  if (n < 0x80) return new Uint8Array([n]);
  const bytes: number[] = [];
  for (let v = n; v > 0; v >>= 8) bytes.unshift(v & 0xff);
  return new Uint8Array([0x80 | bytes.length, ...bytes]);
}

const seq = (...parts: Uint8Array[]) => tlv(0x30, concat(...parts));
const set = (...parts: Uint8Array[]) => tlv(0x31, concat(...parts));
const nul = () => new Uint8Array([0x05, 0x00]);
const utf8 = (s: string) => tlv(0x0c, new TextEncoder().encode(s));
const explicit = (n: number, inner: Uint8Array) => tlv(0xa0 + n, inner);
const bitString = (bytes: Uint8Array) => tlv(0x03, concat(new Uint8Array([0]), bytes));

function integer(bytes: Uint8Array): Uint8Array {
  // Unsigned big-endian → DER INTEGER: a leading zero when the high bit would read as negative.
  return tlv(0x02, bytes[0]! & 0x80 ? concat(new Uint8Array([0]), bytes) : bytes);
}

function oid(dotted: string): Uint8Array {
  const [a, b, ...rest] = dotted.split('.').map(Number);
  const out = [a! * 40 + b!];
  for (const n of rest) {
    const groups: number[] = [];
    let v = n;
    do {
      groups.unshift(v & 0x7f);
      v = Math.floor(v / 128);
    } while (v > 0);
    for (let i = 0; i < groups.length - 1; i++) groups[i]! |= 0x80;
    out.push(...groups);
  }
  return tlv(0x06, new Uint8Array(out));
}

function time(d: Date): Uint8Array {
  // UTCTime until 2050, GeneralizedTime after (RFC 5280 §4.1.2.5).
  const digits = d.toISOString().slice(0, 19).replace(/[-:T]/g, '');
  return d.getUTCFullYear() < 2050
    ? tlv(0x17, new TextEncoder().encode(`${digits.slice(2)}Z`))
    : tlv(0x18, new TextEncoder().encode(`${digits}Z`));
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

// ── base64 ───────────────────────────────────────────────────────────────────

export function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export function fromBase64(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export function toBase64Url(bytes: Uint8Array): string {
  return toBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
