/**
 * Reading a delivered file — HOST code, and the only place bytes are ever looked at.
 *
 * Module code cannot reach a blob: capabilities come from `ctx`, and `ctx` has no blob. So the
 * file lands here, is parsed here, and only parsed records cross into an operation. That is
 * also why `tock/profile-run` declares no HTTP route — if it did, a browser could hand records
 * in and every count would be a claim by whoever submitted it rather than something the server
 * read for itself.
 *
 * `node:*` is fine in this file and never in `module.ts`.
 */

/** One parsed record, in the shape `tock/profile-run` accepts. */
export interface ParsedRecord {
  occurredAt: string;
  /** Raw. Hashed against the day's salt inside the operation, and never stored. */
  subject: string;
  fields: Record<string, string | null>;
}

export interface ParsedFile {
  records: ParsedRecord[];
  /** Half-open, from the earliest record to the day after the latest. */
  periodFrom: string;
  periodTo: string;
  /** Lines that could not be read as a record at all — reported, never silently dropped. */
  malformed: number;
}

/**
 * A small CSV reader: a header row, then one record per line.
 *
 * Deliberately small rather than a dependency. It handles quoted fields and doubled quotes
 * inside them, which is what real log exports produce; it does not handle embedded newlines,
 * and a file containing one would be counted as malformed rather than silently mis-read. A
 * production reader belongs in a library, and the boundary this file draws would not move.
 */
function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (ch === '"') {
        quoted = false;
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      out.push(field);
      field = '';
    } else {
      field += ch;
    }
  }
  out.push(field);
  return out;
}

/** The day after an instant, as the half-open end of a period. */
function dayAfter(instant: string): string {
  const [y, m, d] = instant.slice(0, 10).split('-').map(Number) as [number, number, number];
  const next = new Date(Date.UTC(y, m - 1, d + 1));
  return `${next.toISOString().slice(0, 10)}T00:00:00.000Z`;
}

/**
 * Two columns are structural and the rest are the record's fields.
 *
 * `occurred_at` is when it happened and `subject` is who it was — the raw identifier the
 * operation hashes and discards. Everything else is data whose meaning a schema decides
 * later, which is why nothing here consults one: profiling records what ARRIVED, and a parser
 * that filtered by the declared shape would destroy the evidence a deviation is made of.
 */
export function parseDeliveredFile(text: string): ParsedFile {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '');
  if (lines.length === 0) throw new Error('the file is empty');

  const header = splitCsvLine(lines[0]!).map((h) => h.trim());
  const at = header.indexOf('occurred_at');
  const who = header.indexOf('subject');
  if (at === -1 || who === -1)
    throw new Error("a delivered file needs an 'occurred_at' and a 'subject' column; this one has: " + header.join(', '));

  const records: ParsedRecord[] = [];
  let malformed = 0;
  for (const line of lines.slice(1)) {
    const cells = splitCsvLine(line);
    if (cells.length !== header.length) {
      malformed += 1;
      continue;
    }
    const fields: Record<string, string | null> = {};
    header.forEach((name, i) => {
      if (i === at || i === who) return;
      const value = cells[i] ?? '';
      // An empty cell is an absent value, not an empty string. The distinction is the whole
      // of the unknown bucket, and collapsing it here would put it beyond recovery.
      fields[name] = value === '' ? null : value;
    });
    records.push({ occurredAt: cells[at]!, subject: cells[who]!, fields });
  }
  if (records.length === 0) throw new Error(`no readable records (${malformed} malformed line(s))`);

  const instants = records.map((r) => r.occurredAt).sort();
  return {
    records,
    periodFrom: `${instants[0]!.slice(0, 10)}T00:00:00.000Z`,
    periodTo: dayAfter(instants[instants.length - 1]!),
    malformed,
  };
}

/** SHA-256 over the bytes, as `sha256:<hex>`. Web Crypto, the same API everywhere. */
export async function contentHashOf(bytes: Uint8Array): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes as unknown as ArrayBuffer);
  const hex = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return `sha256:${hex}`;
}

/**
 * How many records go into one `profile-run` call.
 *
 * Small enough that one invocation stays well inside a scope's time budget, large enough that
 * a day of logs is a handful of calls rather than thousands. The operation is resumable by
 * design, so this is a tuning number and not a correctness one.
 */
export const PROFILE_BATCH = 500;
