/**
 * A certificate the OWNER generated (#3281): their private key and the certificate their Entra
 * admin already uploaded, read and checked before the pair is sealed with the rest of the
 * credential exactly as a platform-generated pair is.
 *
 * Web Crypto only, like the rest of the module. Every refusal is a {@link Microsoft365CertificateRefusal}
 * whose message is written here and names no byte of what was given: a refusal travels as a
 * problem document to the dialog, and an error from a parser could quote its input. The
 * certificate's thumbprint is the one exception, and it is public — Entra shows it to anyone
 * with the app registration open.
 */
import {
  fromBase64,
  pkcs8FromPkcs1,
  privateKeyShape,
  readCertificateFacts,
  rsaPrivateJwk,
  rsaPublicJwk,
  thumbprintSha1Hex,
  toBase64,
} from './x509.js';

/** A supplied pair the platform will not store, and why — in words, never with the input. Answers 422. */
export class Microsoft365CertificateRefusal extends Error {
  readonly status = 422 as const;
  constructor(message: string) {
    super(message);
    this.name = 'Microsoft365CertificateRefusal';
  }
}

/** The longest key or certificate text read. A 4096-bit PEM key is about 3.3 KB; a chain a few more. */
export const MAX_SUPPLIED_BYTES = 64 * 1024;

/** The smallest RSA key Entra takes for a certificate credential. */
export const MIN_RSA_BITS = 2048;

/** A supplied pair, checked: PKCS#8 base64 and DER base64, as a generated pair is stored. */
export interface SuppliedPair {
  privateKey: string;
  certificate: string;
  notAfter: string;
}

const EXPORT_UNENCRYPTED =
  'Export it without a password and choose that file instead — for example ' +
  '`openssl pkcs8 -topk8 -nocrypt -in key.pem -out key-unencrypted.pem` — and delete the unencrypted copy once the connection is saved.';

const PFX_HINT =
  'A .pfx or .p12 file holds both halves behind a password: split it first with ' +
  '`openssl pkcs12 -in cert.pfx -nocerts -nodes -out key.pem` and `openssl pkcs12 -in cert.pfx -clcerts -nokeys -out cert.pem`.';

/**
 * Read and check the owner's pair at `now`: the key is an unencrypted RSA key of at least
 * {@link MIN_RSA_BITS} bits, the certificate is one X.509 certificate, still valid, carrying that
 * key's public half. The certificate's DER is kept byte for byte, so the thumbprint shown is the
 * one Entra shows for the certificate it holds.
 */
export async function readSuppliedPair(keyText: string, certificateText: string, now: Date): Promise<SuppliedPair> {
  const missing = [
    ...(keyText.trim() === '' ? ['the private key'] : []),
    ...(certificateText.trim() === '' ? ['the certificate'] : []),
  ];
  if (missing.length > 0) {
    throw new Microsoft365CertificateRefusal(
      `to sign in with your own certificate, give both the private key and the certificate — ${missing.join(' and ')} ${missing.length > 1 ? 'are' : 'is'} missing`,
    );
  }
  const pkcs8 = readPrivateKey(keyText);
  const certificate = readCertificate(certificateText);
  const facts = readCertificateFacts(certificate)!;

  let priv: JsonWebKey;
  try {
    priv = await rsaPrivateJwk(pkcs8);
  } catch {
    throw new Microsoft365CertificateRefusal(`the private key could not be read as an RSA key. ${PFX_HINT}`);
  }
  const bits = modulusBits(priv.n);
  if (bits < MIN_RSA_BITS) {
    throw new Microsoft365CertificateRefusal(
      `the private key is a ${bits}-bit RSA key; Entra needs at least ${MIN_RSA_BITS} bits — generate a new pair`,
    );
  }
  let pub: JsonWebKey;
  try {
    pub = await rsaPublicJwk(facts.spki);
  } catch {
    throw new Microsoft365CertificateRefusal(
      "the certificate's key is not an RSA key; Entra signs in with RSA certificates only — generate an RSA pair",
    );
  }
  const certificateBase64 = toBase64(certificate);
  if (pub.n !== priv.n || pub.e !== priv.e) {
    throw new Microsoft365CertificateRefusal(
      `the private key does not belong to this certificate (thumbprint ${await thumbprintSha1Hex(certificateBase64)}): ` +
        'choose the key that was generated with it — Entra shows the thumbprint of the certificate it holds',
    );
  }
  if (!(facts.notAfter.getTime() > now.getTime())) {
    throw new Microsoft365CertificateRefusal(
      `the certificate expired on ${facts.notAfter.toISOString().slice(0, 10)}; Entra no longer accepts it — supply a new pair, or let the platform generate one`,
    );
  }
  return { privateKey: toBase64(pkcs8), certificate: certificateBase64, notAfter: facts.notAfter.toISOString() };
}

/**
 * The private key, as PKCS#8 DER: from PEM (`PRIVATE KEY`, or `RSA PRIVATE KEY` converted), or
 * from the base64 of a binary key file. An encrypted key is refused with how to export it
 * unencrypted; a key of another kind with what Entra needs instead.
 */
function readPrivateKey(text: string): Uint8Array {
  limit(text, 'private key');
  if (text.includes('-----BEGIN')) {
    const blocks = pemBlocks(text);
    const labels = new Set(blocks.map((b) => b.label));
    if (labels.has('ENCRYPTED PRIVATE KEY')) {
      throw new Microsoft365CertificateRefusal(`the private key is encrypted (password-protected). ${EXPORT_UNENCRYPTED}`);
    }
    const rsa = blocks.find((b) => b.label === 'RSA PRIVATE KEY');
    if (rsa) {
      if (/proc-type:\s*4\s*,\s*encrypted/i.test(rsa.headers) || /dek-info:/i.test(rsa.headers)) {
        throw new Microsoft365CertificateRefusal(`the private key is encrypted (password-protected). ${EXPORT_UNENCRYPTED}`);
      }
      return fromDer(rsa.body, 'pkcs1');
    }
    const pkcs8 = blocks.find((b) => b.label === 'PRIVATE KEY');
    if (pkcs8) return fromDer(pkcs8.body, 'pkcs8');
    if (labels.has('EC PRIVATE KEY') || labels.has('DSA PRIVATE KEY') || labels.has('OPENSSH PRIVATE KEY')) {
      throw new Microsoft365CertificateRefusal(
        'the private key is not an RSA key in PEM form; Entra signs in with RSA certificates only — generate an RSA pair (for example `openssl req -x509 -newkey rsa:2048 -nodes …`)',
      );
    }
    if (labels.has('CERTIFICATE')) {
      throw new Microsoft365CertificateRefusal(
        'the private key field holds a certificate, not a private key: choose the key file (it begins with -----BEGIN PRIVATE KEY----- or -----BEGIN RSA PRIVATE KEY-----)',
      );
    }
    throw new Microsoft365CertificateRefusal(
      `the private key could not be read: give the PEM file that begins with -----BEGIN PRIVATE KEY----- or -----BEGIN RSA PRIVATE KEY-----. ${PFX_HINT}`,
    );
  }
  return fromDer(base64Bytes(text), 'any');
}

function fromDer(der: Uint8Array | undefined, expected: 'pkcs8' | 'pkcs1' | 'any'): Uint8Array {
  const shape = der && privateKeyShape(der);
  if (shape === 'pkcs8-encrypted') {
    throw new Microsoft365CertificateRefusal(`the private key is encrypted (password-protected). ${EXPORT_UNENCRYPTED}`);
  }
  if (shape === 'pkcs8-not-rsa') {
    throw new Microsoft365CertificateRefusal(
      'the private key is not an RSA key; Entra signs in with RSA certificates only — generate an RSA pair',
    );
  }
  if (der && shape === 'pkcs1' && expected !== 'pkcs8') return pkcs8FromPkcs1(der);
  if (der && shape === 'pkcs8' && expected !== 'pkcs1') return der;
  throw new Microsoft365CertificateRefusal(
    `the private key could not be read: give the PEM file that begins with -----BEGIN PRIVATE KEY----- or -----BEGIN RSA PRIVATE KEY-----. ${PFX_HINT}`,
  );
}

/** The certificate, as DER: the first `CERTIFICATE` block of a PEM file (a chain's leaf), or a `.cer` in DER. */
function readCertificate(text: string): Uint8Array {
  limit(text, 'certificate');
  let der: Uint8Array | undefined;
  if (text.includes('-----BEGIN')) {
    const blocks = pemBlocks(text);
    const cert = blocks.find((b) => b.label === 'CERTIFICATE');
    if (!cert) {
      if (blocks.some((b) => b.label.endsWith('PRIVATE KEY'))) {
        throw new Microsoft365CertificateRefusal(
          'the certificate field holds a private key, not the certificate: choose the .cer or .pem file that begins with -----BEGIN CERTIFICATE-----',
        );
      }
      throw new Microsoft365CertificateRefusal(
        'the certificate could not be read: give the .cer file (DER or PEM, beginning -----BEGIN CERTIFICATE-----) that was uploaded to the app registration',
      );
    }
    der = cert.body;
  } else {
    der = base64Bytes(text);
  }
  if (!der || !readCertificateFacts(der)) {
    throw new Microsoft365CertificateRefusal(
      'the certificate could not be read: give the .cer file (DER or PEM, beginning -----BEGIN CERTIFICATE-----) that was uploaded to the app registration',
    );
  }
  return der;
}

function limit(text: string, what: string) {
  if (text.length > MAX_SUPPLIED_BYTES) {
    throw new Microsoft365CertificateRefusal(`the ${what} is larger than ${MAX_SUPPLIED_BYTES / 1024} KB; that is not one ${what}`);
  }
}

interface PemBlock {
  label: string;
  /** RFC 1421 header lines (`Proc-Type: …`), when the block has any. */
  headers: string;
  body: Uint8Array | undefined;
}

/**
 * Every PEM block in the text, in order. Scanned by index rather than one regular expression with
 * a back-reference: the text is the caller's, and a back-reference is what makes a pattern slow
 * on input built to be slow.
 */
function pemBlocks(text: string): PemBlock[] {
  const out: PemBlock[] = [];
  const begin = /-----BEGIN ([A-Z0-9 ]{1,40})-----/g;
  let m: RegExpExecArray | null;
  while ((m = begin.exec(text))) {
    const label = m[1]!;
    const endMarker = `-----END ${label}-----`;
    const end = text.indexOf(endMarker, begin.lastIndex);
    if (end < 0) break;
    const inner = text.slice(begin.lastIndex, end);
    const lines = inner.split(/\r?\n/);
    const headerLines = lines.filter((l) => l.includes(':'));
    const body = lines.filter((l) => !l.includes(':')).join('');
    out.push({ label, headers: headerLines.join('\n'), body: base64Bytes(body) });
    begin.lastIndex = end + endMarker.length;
  }
  return out;
}

/** Base64 (whitespace ignored) as bytes; `undefined` when it is not base64. */
function base64Bytes(text: string): Uint8Array | undefined {
  const compact = text.replace(/\s+/g, '');
  if (compact === '' || !/^[A-Za-z0-9+/]+={0,2}$/.test(compact)) return undefined;
  try {
    return fromBase64(compact);
  } catch {
    return undefined;
  }
}

/** A JWK modulus's size in bits. */
function modulusBits(n: string | undefined): number {
  if (!n) return 0;
  const bytes = fromBase64(n.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(n.length / 4) * 4, '='));
  let bits = bytes.length * 8;
  for (let i = 0; i < bytes.length && bytes[i] === 0; i++) bits -= 8;
  const lead = bytes.find((b) => b !== 0) ?? 0;
  for (let mask = 0x80; mask > 0 && !(lead & mask); mask >>= 1) bits--;
  return bits;
}
