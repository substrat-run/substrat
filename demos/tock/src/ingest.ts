/**
 * Reading a delivered file — HOST code, and the only place bytes are ever looked at.
 *
 * Module code cannot reach a blob: capabilities come from `ctx`, and `ctx` has no blob. So the
 * file lands here, is parsed here, and only parsed records cross into an operation. That is
 * also why `tock/profile-run` declares no HTTP route — if it did, a browser could hand records
 * in and every count would be a claim by whoever submitted it rather than something the server
 * read for itself.
 *
 * ## Nothing here is named in advance
 *
 * The first version required columns literally called `occurred_at` and `subject`, which is
 * fine for a file written for this app and useless for every file that already exists. A real
 * export arrives semicolon-delimited with fifty columns and no column called `subject`.
 *
 * So the reader takes the two structural columns as ARGUMENTS. Which columns those are is
 * decided per run, at send time, from the preview — see the `format`/`time_field` comment on
 * the run entity for why that mapping cannot live in the schema.
 *
 * `node:*` is fine in this file and never in `module.ts`.
 */

/** One parsed record, in the shape `tock/profile-run` accepts. */
export interface ParsedRecord {
  occurredAt: string;
  /** Raw, hashed against the day's salt inside the operation, never stored. Empty = no subject. */
  subject: string;
  fields: Record<string, string | null>;
}

export type FileFormat = 'csv' | 'jsonl';

/** How a file is to be read, and which of its columns carry the structural facts. */
export interface ReadPlan {
  format: FileFormat;
  /** The character between CSV cells. Null for `jsonl`. */
  delimiter: string | null;
  timeField: string;
  /** Null when the file has nothing to de-duplicate on — every row then counts once. */
  subjectField: string | null;
}

export interface ParsedFile {
  records: ParsedRecord[];
  periodFrom: string;
  periodTo: string;
  /** Lines that could not be read as a record — reported, never silently mis-read. */
  malformed: number;
}

// ── shape detection ─────────────────────────────────────────────────────────

/**
 * The delimiters worth guessing between, in the order a tie is broken.
 *
 * Comma first because it is the default everywhere, semicolon second because it is what a
 * spreadsheet exports in a locale that uses the comma as a decimal separator — which is the
 * single most common reason a "CSV" refuses to parse.
 */
const DELIMITERS = [',', ';', '\t', '|'] as const;

/**
 * Which delimiter the header row uses, by whichever yields the most cells.
 *
 * Counted OUTSIDE quotes, so a comma inside `"Doe, Jane"` does not make the comma look like
 * the winner in a semicolon file — which is exactly the case that would otherwise pick wrong.
 */
export function sniffDelimiter(headerLine: string): string {
  let best = ',';
  let bestCount = 0;
  for (const d of DELIMITERS) {
    const n = splitDelimited(headerLine, d).length;
    if (n > bestCount) {
      best = d;
      bestCount = n;
    }
  }
  return best;
}

/** JSON Lines if the first non-blank character opens an object or an array. */
export function sniffFormat(text: string): FileFormat {
  const first = text.trimStart()[0];
  return first === '{' || first === '[' ? 'jsonl' : 'csv';
}

function splitDelimited(line: string, delimiter: string): string[] {
  const out: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === delimiter) {
      out.push(field);
      field = '';
    } else field += ch;
  }
  out.push(field);
  return out;
}

// ── nested values ───────────────────────────────────────────────────────────

/** Deep enough for real payloads, shallow enough that a cyclic-ish shape cannot run away. */
const MAX_DEPTH = 8;

/**
 * A nested object, flattened to dotted paths: `{ billing: { city: 'Oslo' } }` → `billing.city`.
 *
 * **An array becomes ONE field holding its JSON**, not one field per index. Indexing would mint
 * `tags.0`, `tags.1`, `tags.2` … and a file whose arrays vary in length would grow a new field
 * name for every length any row ever had — the field explosion the deviations view exists to
 * report, manufactured by the reader itself. One field per array is stable, and a schema can
 * still ignore it.
 *
 * `null` stays null rather than becoming `"null"`: an absent value is the whole of the unknown
 * bucket, and a reader that stringifies it puts it beyond recovery downstream. An empty STRING
 * is left alone for the opposite reason — JSON has a null and this producer did not use it, so
 * turning `""` into absent would be the reader inventing a meaning the file did not carry. (The
 * CSV path does convert an empty cell, because CSV has no way to say null at all.)
 *
 * **An empty object contributes nothing.** Emitting a `"{}"` leaf for it reads as faithful and
 * creates a path that is a LEAF on one record and a BRANCH on the next — `details.request.qs`
 * beside `details.request.qs.client_id` — which no schema can declare once. An object
 * contributes its leaves; an object with no leaves contributes none.
 */
export function flatten(value: unknown, prefix = '', depth = 0, out: Record<string, string | null> = {}): Record<string, string | null> {
  if (depth > MAX_DEPTH) {
    out[prefix || 'value'] = JSON.stringify(value);
    return out;
  }
  if (value === null || value === undefined) {
    out[prefix || 'value'] = null;
    return out;
  }
  if (Array.isArray(value)) {
    out[prefix || 'value'] = JSON.stringify(value);
    return out;
  }
  if (typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      flatten(v, prefix ? `${prefix}.${k}` : k, depth + 1, out);
    }
    return out;
  }
  out[prefix || 'value'] = String(value);
  return out;
}

// ── reading ─────────────────────────────────────────────────────────────────

/** Every field path a file contains, for the screen that asks which one is the timestamp. */
export function fieldsOf(text: string, plan: Pick<ReadPlan, 'format' | 'delimiter'>): string[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '');
  if (lines.length === 0) return [];
  if (plan.format === 'csv') return splitDelimited(lines[0]!, plan.delimiter ?? ',').map((h) => h.trim());
  // JSON records need not agree on their keys, so the union of a sample is the honest answer.
  const seen = new Set<string>();
  for (const line of lines.slice(0, 200)) {
    try {
      for (const k of Object.keys(flatten(JSON.parse(line)))) seen.add(k);
    } catch {
      /* a line that will be reported as malformed cannot contribute names */
    }
  }
  return [...seen];
}

/** The day after an instant, as the half-open end of a period. */
function dayAfter(instant: string): string {
  const [y, m, d] = instant.slice(0, 10).split('-').map(Number) as [number, number, number];
  const next = new Date(Date.UTC(y, m - 1, d + 1));
  return `${next.toISOString().slice(0, 10)}T00:00:00.000Z`;
}

/**
 * Read a delivered file into records, using the plan the run was opened with.
 *
 * The structural columns are REMOVED from `fields` — they are how a record is addressed rather
 * than data a schema models, and leaving the subject in would store the raw identifier the
 * hashing exists to avoid storing.
 */
export function parseDeliveredFile(text: string, plan: ReadPlan): ParsedFile {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '');
  if (lines.length === 0) throw new Error('the file is empty');

  const records: ParsedRecord[] = [];
  let malformed = 0;

  const take = (all: Record<string, string | null>) => {
    const when = all[plan.timeField];
    const ms = when === null || when === undefined ? Number.NaN : Date.parse(when);
    // A record whose instant does not parse is malformed, not a record with a bad timestamp:
    // the period is derived from these values, so one unreadable cell would otherwise poison
    // the whole run rather than the single line it came from.
    if (Number.isNaN(ms)) {
      malformed += 1;
      return;
    }
    const fields = { ...all };
    delete fields[plan.timeField];
    if (plan.subjectField) delete fields[plan.subjectField];
    records.push({
      occurredAt: new Date(ms).toISOString(),
      subject: plan.subjectField ? (all[plan.subjectField] ?? '') : '',
      fields,
    });
  };

  if (plan.format === 'csv') {
    const header = splitDelimited(lines[0]!, plan.delimiter ?? ',').map((h) => h.trim());
    if (!header.includes(plan.timeField))
      throw new Error(`the file has no column called '${plan.timeField}'; it has: ${header.join(', ')}`);
    if (plan.subjectField && !header.includes(plan.subjectField))
      throw new Error(`the file has no column called '${plan.subjectField}'; it has: ${header.join(', ')}`);

    for (const line of lines.slice(1)) {
      const cells = splitDelimited(line, plan.delimiter ?? ',');
      if (cells.length !== header.length) {
        malformed += 1;
        continue;
      }
      const all: Record<string, string | null> = {};
      // An empty cell is an absent value, not an empty string. The distinction is the whole
      // of the unknown bucket, and collapsing it here would put it beyond recovery.
      header.forEach((name, i) => {
        const v = cells[i] ?? '';
        all[name] = v === '' ? null : v;
      });
      take(all);
    }
  } else {
    for (const line of lines) {
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        malformed += 1;
        continue;
      }
      // A top-level array on one line is a batch of records, which is what a pretty-printed
      // export collapses to. Anything else is one record.
      const batch = Array.isArray(value) ? value : [value];
      for (const item of batch) {
        if (item === null || typeof item !== 'object' || Array.isArray(item)) {
          malformed += 1;
          continue;
        }
        take(flatten(item));
      }
    }
  }

  if (records.length === 0) throw new Error(`no readable records (${malformed} unreadable line(s))`);

  // Every instant is normalised ISO above, so lexicographic order IS chronological.
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
