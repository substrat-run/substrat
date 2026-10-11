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

export async function generateCertificate(opts: {
  commonName: string;
  now: Date;
  /** Fills the serial number's bytes. Defaults to `crypto.getRandomValues`; a test fixes it. */
  random?: (bytes: Uint8Array) => Uint8Array;
}): Promise<GeneratedCertificate> {
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
  const serial = (opts.random ?? ((b) => crypto.getRandomValues(b)))(new Uint8Array(16));
  if (serial.length !== 16) throw new Error(`random() must return the 16 serial bytes it was given, got ${serial.length}`);
  // Positive, and never a leading zero byte: DER wants the shortest INTEGER, and a strict parser
  // (OpenSSL, so Node) refuses `00 xx` with xx < 0x80 — one serial in 256 once it was only masked.
  serial[0] = (serial[0]! & 0x7f) | 0x40;
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

/**
 * Is this stored certificate one Entra and OpenSSL will read, and does it carry THIS private key?
 *
 * Web Crypto only, like the rest of the module (module code has no `node:crypto`): the outer
 * structure is walked by hand so the serial can be held to DER's shortest, positive form (the
 * check Web Crypto never makes, and the one #2189's certificates failed), the signature is verified
 * with the certificate's own key, and that key's modulus and exponent are compared with the
 * private key's. Returns false on anything unreadable; never throws.
 */
export async function certificateMatchesKey(certificateBase64: string, privateKeyBase64: string): Promise<boolean> {
  try {
    const der = fromBase64(certificateBase64);
    const cert = readTlv(der, 0, 0x30);
    if (!cert || cert.end !== der.length) return false;
    const tbs = readTlv(der, cert.body, 0x30);
    const alg = tbs && readTlv(der, tbs.end, 0x30);
    const sig = alg && readTlv(der, alg.end, 0x03);
    if (!tbs || !alg || !sig || sig.end !== cert.end) return false;
    // tbs: [0] version, serial, algorithm, issuer, validity, subject, spki
    const version = readTlv(der, tbs.body, 0xa0);
    const serial = version && readTlv(der, version.end, 0x02);
    if (!serial || !isShortestPositive(der.subarray(serial.body, serial.end))) return false;
    // Both algorithm fields (RFC 5280 §4.1.1.2 makes them agree) must be the sha256WithRSAEncryption
    // this module signs with, which is the algorithm the verification below uses.
    const expectedAlgorithm = seq(oid(OID_SHA256_WITH_RSA), nul());
    const sameAs = (t: { start: number; end: number }) => equal(der.subarray(t.start, t.end), expectedAlgorithm);
    if (!sameAs(alg)) return false;
    let at = serial.end;
    let spki: { start: number; body: number; end: number } | undefined;
    for (let i = 0; i < 5; i++) {
      const t = readTlv(der, at);
      if (!t) return false;
      if (i === 0 && !sameAs(t)) return false;
      if (i === 4) spki = t;
      at = t.end;
    }
    if (!spki || at !== tbs.end) return false;
    const publicKey = await crypto.subtle.importKey(
      'spki',
      der.subarray(spki.start, spki.end),
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      true,
      ['verify'],
    );
    const signature = der.subarray(sig.body + 1, sig.end); // after the unused-bits octet
    if (!(await crypto.subtle.verify('RSASSA-PKCS1-v1_5', publicKey, signature, der.subarray(tbs.start, tbs.end)))) {
      return false;
    }
    const privateKey = await crypto.subtle.importKey(
      'pkcs8',
      fromBase64(privateKeyBase64),
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      true,
      ['sign'],
    );
    const pub = await crypto.subtle.exportKey('jwk', publicKey);
    const priv = await crypto.subtle.exportKey('jwk', privateKey);
    return pub.n === priv.n && pub.e === priv.e;
  } catch {
    return false;
  }
}

/** One TLV at `at`: where it starts, where its body starts, where it ends. `tag` checks the tag when given. */
function readTlv(
  b: Uint8Array,
  at: number,
  tag?: number,
): { start: number; body: number; end: number } | undefined {
  if (at + 2 > b.length || (tag !== undefined && b[at] !== tag)) return undefined;
  let len = b[at + 1]!;
  let body = at + 2;
  if (len & 0x80) {
    const n = len & 0x7f;
    if (n === 0 || n > 3 || body + n > b.length) return undefined;
    len = 0;
    for (let i = 0; i < n; i++) len = len * 256 + b[body + i]!;
    if (len < 0x80 || b[body] === 0) return undefined; // long form only where short will not do
    body += n;
  }
  return body + len > b.length ? undefined : { start: at, body, end: body + len };
}

/** A DER INTEGER body that is positive and has no redundant leading octet. */
function isShortestPositive(body: Uint8Array): boolean {
  if (body.length === 0 || body[0]! & 0x80) return false;
  return !(body.length > 1 && body[0] === 0 && !(body[1]! & 0x80));
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

/** @internal exported for its own test. */
export function integer(bytes: Uint8Array): Uint8Array {
  // Unsigned big-endian → DER INTEGER, the shortest form: no redundant leading zeros, and one
  // leading zero when the high bit would otherwise read as negative.
  let start = 0;
  while (start < bytes.length - 1 && bytes[start] === 0) start++;
  const magnitude = bytes.subarray(start);
  return tlv(0x02, magnitude[0]! & 0x80 ? concat(new Uint8Array([0]), magnitude) : magnitude);
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

function equal(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
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
