import { addressParser, decodeWords } from 'postal-mime';
import type { MailInAuthResult } from '@substrat-run/contracts';

/**
 * The header block of a raw message, read without parsing the body — what the SMTP-time checks
 * need, and nothing that costs a full MIME parse while the sender waits.
 */

/** The most bytes read looking for the end of the header block. A longer block is malformed. */
export const MAX_HEADER_BYTES = 256 * 1024;

/** The authserv-id Cloudflare Email Routing stamps its results with. */
export const CLOUDFLARE_AUTHSERV_ID = 'mx.cloudflare.net';

export interface HeaderField {
  /** Lowercased. */
  name: string;
  /** Unfolded, untrimmed of internal whitespace. */
  value: string;
}

/** The fields of the header block, in the order they appear — topmost first. Null when there is no block. */
export function headerFields(raw: Uint8Array): HeaderField[] | null {
  const limit = Math.min(raw.byteLength, MAX_HEADER_BYTES);
  let end = -1;
  for (let i = 0; i + 1 < limit; i++) {
    if (raw[i] === 0x0a && raw[i + 1] === 0x0a) {
      end = i;
      break;
    }
    if (i + 3 < limit && raw[i] === 0x0d && raw[i + 1] === 0x0a && raw[i + 2] === 0x0d && raw[i + 3] === 0x0a) {
      end = i;
      break;
    }
  }
  if (end < 0) return null;
  // Headers are 7-bit by RFC 5322; latin1 keeps every byte one character, so nothing is lost or
  // invented before decodeWords sees an encoded word.
  let text = '';
  for (let i = 0; i < end; i++) text += String.fromCharCode(raw[i]!);
  const fields: HeaderField[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (/^[ \t]/.test(line)) {
      const last = fields[fields.length - 1];
      if (last) last.value += ` ${line.trim()}`;
      continue;
    }
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    fields.push({ name: line.slice(0, colon).trim().toLowerCase(), value: line.slice(colon + 1).trim() });
  }
  return fields;
}

/** The first field of that name, decoded, or null. */
export function firstHeader(fields: readonly HeaderField[], name: string): string | null {
  const f = fields.find((x) => x.name === name);
  return f ? decodeWords(f.value) : null;
}

/** The first address a header names, lowercased, or null. */
export function firstAddress(value: string | null): string | null {
  if (!value) return null;
  for (const a of addressParser(value, { flatten: true })) {
    if (a.address) return a.address.trim().toLowerCase();
  }
  return null;
}

export const domainOf = (address: string): string => address.slice(address.lastIndexOf('@') + 1).toLowerCase();

export interface AuthVerdict {
  /** Whether a result stamped by the trusted receiver was found at all. */
  stamped: boolean;
  spf: MailInAuthResult;
  dkim: MailInAuthResult;
  dmarc: MailInAuthResult;
  /** `smtp.mailfrom` of the SPF result, lowercased: the domain SPF judged. */
  spfDomain: string | null;
  /** `header.d` of every passing DKIM signature, lowercased. */
  dkimDomains: string[];
  /** `header.from` of the DMARC result, lowercased. */
  dmarcDomain: string | null;
}

const NO_VERDICT: AuthVerdict = {
  stamped: false,
  spf: 'unknown',
  dkim: 'unknown',
  dmarc: 'unknown',
  spfDomain: null,
  dkimDomains: [],
  dmarcDomain: null,
};

/**
 * What the receiving MX said about the message — the TOPMOST `Authentication-Results` (or
 * `ARC-Authentication-Results`) field whose authserv-id is the trusted one, and no other.
 *
 * Only the topmost is read because a receiver PREPENDS its field: anything below it came with the
 * message, and a sender can write any `Authentication-Results` it likes into its own headers,
 * `mx.cloudflare.net` included. A field naming another receiver is skipped, never trusted, and so is
 * every trusted-looking one under the first.
 */
export function authVerdict(fields: readonly HeaderField[], authservId: string = CLOUDFLARE_AUTHSERV_ID): AuthVerdict {
  const id = authservId.toLowerCase();
  const field = fields.find((f) => {
    if (f.name !== 'authentication-results' && f.name !== 'arc-authentication-results') return false;
    // ARC's form carries `i=N;` before the authserv-id.
    const head = f.value.replace(/^\s*i\s*=\s*\d+\s*;\s*/i, '');
    const serv = head.split(';')[0]!.trim().split(/\s+/)[0]!.toLowerCase();
    return serv === id;
  });
  if (!field) return NO_VERDICT;
  const verdict: AuthVerdict = { ...NO_VERDICT, stamped: true, spf: 'none', dkim: 'none', dmarc: 'none', dkimDomains: [] };
  const clauses = field.value.replace(/^\s*i\s*=\s*\d+\s*;\s*/i, '').split(';').slice(1);
  for (const raw of clauses) {
    const clause = raw.replace(/\([^)]*\)/g, ' ').trim();
    const m = /^(spf|dkim|dmarc)\s*=\s*([a-z]+)/i.exec(clause);
    if (!m) continue;
    const method = m[1]!.toLowerCase() as 'spf' | 'dkim' | 'dmarc';
    const result: MailInAuthResult = m[2]!.toLowerCase() === 'pass' ? 'pass' : m[2]!.toLowerCase() === 'none' ? 'none' : 'fail';
    const prop = (name: string) => {
      const p = new RegExp(`(?:^|\\s)${name.replace('.', '\\.')}\\s*=\\s*("?)([^\\s";]+)\\1`, 'i').exec(clause);
      return p ? p[2]!.toLowerCase() : null;
    };
    if (method === 'spf') {
      // A message can carry one SPF result; a later one does not overwrite a pass.
      if (verdict.spf !== 'pass') {
        verdict.spf = result;
        const from = prop('smtp.mailfrom');
        verdict.spfDomain = from ? (from.includes('@') ? domainOf(from) : from) : null;
      }
    } else if (method === 'dkim') {
      if (result === 'pass') {
        verdict.dkim = 'pass';
        const d = prop('header.d') ?? prop('header.i');
        if (d) verdict.dkimDomains.push(d.includes('@') ? domainOf(d) : d);
      } else if (verdict.dkim !== 'pass') {
        verdict.dkim = result;
      }
    } else if (verdict.dmarc !== 'pass') {
      verdict.dmarc = result;
      verdict.dmarcDomain = prop('header.from');
    }
  }
  return verdict;
}

/**
 * True when one domain is the other or under it — DMARC's relaxed alignment, approximated without a
 * public suffix list. The shorter of the two must still hold a dot, so a bare suffix (`com`) never
 * aligns with everything under it.
 */
const aligned = (a: string, b: string): boolean => {
  if (a === b) return true;
  const [short, long] = a.length < b.length ? [a, b] : [b, a];
  return short.includes('.') && long.endsWith(`.${short}`);
};

/**
 * Whether the `From:` address is proven: DMARC passed for its domain, or a DKIM signature that
 * passed is aligned with it. Without one of those the header is a claim anyone can make.
 */
export function headerFromProven(v: AuthVerdict, from: string): boolean {
  const domain = domainOf(from);
  if (v.dmarc === 'pass' && v.dmarcDomain !== null && aligned(v.dmarcDomain, domain)) return true;
  return v.dkimDomains.some((d) => aligned(d, domain));
}

/** Whether the envelope sender is proven: SPF passed for its domain. */
export function envelopeFromProven(v: AuthVerdict, envelopeFrom: string): boolean {
  if (v.spf !== 'pass') return false;
  const domain = domainOf(envelopeFrom);
  return v.spfDomain !== null && aligned(v.spfDomain, domain);
}

/** Whether `address` is on `allowlist` (whole addresses, or `@domain` entries). */
export function allowed(allowlist: readonly string[], address: string): boolean {
  const a = address.toLowerCase();
  return allowlist.some((e) => (e.startsWith('@') ? domainOf(a) === e.slice(1) : a === e));
}
