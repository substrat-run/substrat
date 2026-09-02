/**
 * A SIE4 reader — the Swedish standard accounting interchange format, which is how
 * this connector reads a whole year's bookkeeping in one request instead of walking
 * per-voucher REST endpoints.
 *
 * Deliberately a parser over a *text* input, with no I/O of its own: the decoding
 * from ISO-8859-1 happens at the seam that owns the bytes ({@link FortnoxApi.sieFile}),
 * so this file is pure and testable against a fixture, and a caller reading SIE from
 * somewhere else (an upload, an archive) can use it unchanged.
 *
 * ## What it reads, and what it deliberately ignores
 *
 * Posts read: `#FNAMN`, `#ORGNR`, `#VALUTA`, `#RAR`, `#KONTO`, `#DIM`, `#OBJEKT`,
 * `#VER` and its `#TRANS` rows. Everything else — `#IB`/`#UB`/`#RES` balances,
 * `#KTYP`, `#SRU`, the file metadata — is skipped, and skipped ON PURPOSE rather
 * than by omission:
 *
 * - **`#IB`/`#UB` are derived, and including them double-counts.** They are the
 *   opening and closing balances the vouchers already sum to. A reader that adds
 *   them to the `#TRANS` rows reports every balance twice over.
 * - Everything else is metadata this connector has no use for. An unknown post is
 *   ignored rather than fatal: SIE files carry vendor extensions, and refusing a
 *   file over a post we do not read would break on a Fortnox release that adds one.
 */

/** A parsed `#KONTO` — the chart of accounts. */
export interface SieAccount {
  number: string;
  name: string;
}

/** A parsed `#DIM` — a dimension. Dimension `1` is kostnadsställe (cost centre). */
export interface SieDimension {
  number: string;
  name: string;
}

/** A parsed `#OBJEKT` — one value within a dimension, e.g. a specific property. */
export interface SieObject {
  dimension: string;
  code: string;
  name: string;
}

/** One `#TRANS` row inside a voucher. */
export interface SieTransaction {
  account: string;
  /**
   * The object list, as `dimension → object code`.
   *
   * `{"1" "2001"}` becomes `{ '1': '2001' }`. Dimension 1 is the cost centre, which
   * is what lets a caller break a ledger down per property/unit with no extra API
   * call and no per-object filtering in the request.
   */
  objects: Record<string, string>;
  /** Debit-positive, as SIE defines it. See {@link SieLedger} on the sign convention. */
  amount: string;
  /** `YYYY-MM-DD` when the row carries its own date; otherwise the voucher's. */
  date: string;
  text: string;
  quantity: string | null;
}

/** One `#VER` — a voucher and its rows. */
export interface SieVoucher {
  series: string;
  number: string;
  /** `YYYY-MM-DD`, normalized from SIE's `YYYYMMDD`. */
  date: string;
  text: string;
  transactions: SieTransaction[];
}

/**
 * A whole SIE4 file, parsed.
 *
 * ## The sign convention, stated once
 *
 * SIE amounts are **debit-positive**. A cost account therefore carries a positive
 * amount for a cost, and a revenue account (a credit) carries a *negative* one. That
 * is correct double-entry and it is not what a report wants to show, so a consumer
 * normalizes with a per-account sign when it maps to its own vocabulary. This parser
 * does not normalize: inventing a sign here would put business meaning in a format
 * reader, and the mapping is the vertical's to own.
 */
export interface SieLedger {
  company: string;
  organizationNumber: string;
  /** From `#VALUTA`; `'SEK'` when the file names none, which is the Fortnox default. */
  currency: string;
  /** From `#RAR 0 …` — the year this file covers, when it says. */
  range: { from: string; to: string } | null;
  accounts: SieAccount[];
  dimensions: SieDimension[];
  objects: SieObject[];
  vouchers: SieVoucher[];
}

/**
 * Split one SIE line into fields, honouring quoting and object lists.
 *
 * Three things make this more than `line.split(' ')`, and all three appear in real
 * Fortnox output:
 *
 * 1. **Quoted fields** hold spaces — `"Hyra juni"` is one field, and an account name
 *    is almost always quoted.
 * 2. **Backslash escapes** inside quotes — `\"` and `\\` — so a name containing a
 *    quote does not end the field early.
 * 3. **Object lists** are brace-delimited and hold their own quoted fields, so
 *    `{"1" "2001"}` must survive as ONE field for the caller to unpack.
 */
export function splitSieLine(line: string): string[] {
  const fields: string[] = [];
  let i = 0;
  while (i < line.length) {
    const ch = line[i]!;
    if (ch === ' ' || ch === '\t') {
      i += 1;
      continue;
    }
    if (ch === '{') {
      // Brace-delimited object list, kept whole (quotes inside are not terminators).
      let depth = 0;
      let start = i;
      let inQuote = false;
      while (i < line.length) {
        const c = line[i]!;
        if (inQuote) {
          if (c === '\\') i += 1;
          else if (c === '"') inQuote = false;
        } else if (c === '"') inQuote = true;
        else if (c === '{') depth += 1;
        else if (c === '}') {
          depth -= 1;
          if (depth === 0) {
            i += 1;
            break;
          }
        }
        i += 1;
      }
      fields.push(line.slice(start, i));
      continue;
    }
    if (ch === '"') {
      let out = '';
      i += 1;
      while (i < line.length) {
        const c = line[i]!;
        if (c === '\\' && i + 1 < line.length) {
          out += line[i + 1];
          i += 2;
          continue;
        }
        if (c === '"') {
          i += 1;
          break;
        }
        out += c;
        i += 1;
      }
      fields.push(out);
      continue;
    }
    let start = i;
    while (i < line.length && line[i] !== ' ' && line[i] !== '\t') i += 1;
    fields.push(line.slice(start, i));
  }
  return fields;
}

/** Unpack `{"1" "2001" "6" "A"}` into `{ '1': '2001', '6': 'A' }`. Empty `{}` → `{}`. */
function parseObjectList(field: string | undefined): Record<string, string> {
  if (field === undefined || !field.startsWith('{')) return {};
  const inner = field.slice(1, field.endsWith('}') ? -1 : undefined);
  const parts = splitSieLine(inner);
  const objects: Record<string, string> = {};
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const dim = parts[i]!;
    const code = parts[i + 1]!;
    if (dim !== '' && code !== '') objects[dim] = code;
  }
  return objects;
}

/** `YYYYMMDD` → `YYYY-MM-DD`. Anything else is passed through unchanged. */
export function sieDate(raw: string | undefined): string {
  if (raw === undefined) return '';
  const digits = raw.trim();
  if (!/^\d{8}$/.test(digits)) return digits;
  return `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}`;
}

/**
 * Normalize a SIE amount to the exact decimal string the platform's money helpers
 * take.
 *
 * SIE writes amounts with a `.` decimal separator and no thousands grouping, but
 * real files carry `-50000`, `-50000.00` and `1 234.50` alike, and a stray
 * non-breaking space has been seen in exported names. Everything is normalized to a
 * plain signed decimal string — never a float, per the platform's money rule, because
 * `parseFloat` on a ledger is how a rounding error becomes an accounting discrepancy.
 */
export function sieAmount(raw: string | undefined): string {
  if (raw === undefined) return '0';
  const cleaned = raw.replace(/[\s\u00a0]/g, '').replace(',', '.');
  if (!/^[+-]?\d*\.?\d*$/.test(cleaned) || cleaned === '' || cleaned === '-' || cleaned === '+') {
    return '0';
  }
  return cleaned.startsWith('+') ? cleaned.slice(1) : cleaned;
}

/**
 * Parse a SIE4 document.
 *
 * Tolerant by design: an unknown post is skipped, a malformed `#TRANS` outside a
 * voucher is ignored rather than fatal, and a voucher block that never closes still
 * yields the rows it had. A ledger reader that refuses a whole year over one odd line
 * is worse than one that reports what it could read — the caller can see the totals
 * and the account coverage, which is where a real problem shows up anyway.
 */
export function parseSie4(text: string): SieLedger {
  const ledger: SieLedger = {
    company: '',
    organizationNumber: '',
    currency: 'SEK',
    range: null,
    accounts: [],
    dimensions: [],
    objects: [],
    vouchers: [],
  };

  let current: SieVoucher | null = null;
  let inBlock = false;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '') continue;

    if (line === '{') {
      inBlock = true;
      continue;
    }
    if (line === '}') {
      inBlock = false;
      current = null;
      continue;
    }
    if (!line.startsWith('#')) continue;

    const fields = splitSieLine(line);
    const post = fields[0];

    switch (post) {
      case '#FNAMN':
        ledger.company = fields[1] ?? '';
        break;
      case '#ORGNR':
        ledger.organizationNumber = fields[1] ?? '';
        break;
      case '#VALUTA':
        if (fields[1]) ledger.currency = fields[1];
        break;
      case '#RAR':
        // `#RAR 0 <from> <to>` — year 0 is the file's own year; -1 is the previous
        // one, which Fortnox includes for comparison and which we do not want.
        if (fields[1] === '0') {
          ledger.range = { from: sieDate(fields[2]), to: sieDate(fields[3]) };
        }
        break;
      case '#KONTO':
        if (fields[1]) ledger.accounts.push({ number: fields[1], name: fields[2] ?? '' });
        break;
      case '#DIM':
        if (fields[1]) ledger.dimensions.push({ number: fields[1], name: fields[2] ?? '' });
        break;
      case '#OBJEKT':
        if (fields[1] && fields[2]) {
          ledger.objects.push({ dimension: fields[1], code: fields[2], name: fields[3] ?? '' });
        }
        break;
      case '#VER': {
        // `#VER <serie> <nr> <datum> [text] [regdatum] [sign]`
        current = {
          series: fields[1] ?? '',
          number: fields[2] ?? '',
          date: sieDate(fields[3]),
          text: fields[4] ?? '',
          transactions: [],
        };
        ledger.vouchers.push(current);
        break;
      }
      case '#TRANS': {
        // `#TRANS <konto> <objektlista> <belopp> [transdat] [transtext] [kvantitet] [sign]`
        // Only inside a voucher block: a `#TRANS` with no `#VER` above it has nothing
        // to attach to, and silently inventing a voucher for it would fabricate data.
        if (current === null) break;
        current.transactions.push({
          account: fields[1] ?? '',
          objects: parseObjectList(fields[2]),
          amount: sieAmount(fields[3]),
          date: fields[4] ? sieDate(fields[4]) : current.date,
          text: fields[5] ?? '',
          quantity: fields[6] ? sieAmount(fields[6]) : null,
        });
        break;
      }
      // `#BTRANS` (removed) and `#RTRANS` (corrected) describe edits to a row that
      // `#TRANS` already states in its final form. Counting them double-counts the
      // correction, so both are skipped exactly like the balance posts.
      default:
        break;
    }
    void inBlock;
  }

  return ledger;
}
