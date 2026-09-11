/**
 * The browser's read of a dropped file — a PREVIEW, and authoritative for nothing.
 *
 * This exists so correcting an inferred type feels immediate instead of costing a round trip
 * per guess. Every number that reaches a rollup — the content hash, the row count, the
 * observations, the counts — comes from the server re-reading the bytes it stored. A design
 * whose claim is "numbers you can stand behind" cannot take them from the client that
 * submitted them, so nothing here is ever sent as a fact.
 *
 * It deliberately reads only the first SLICE OF BYTES of a large file — `readHead` below — and
 * that is the whole point rather than an optimisation. Calling `file.text()` first would
 * materialise a month of logs in the tab to show six rows of it, which is the opposite of what
 * a bounded preview is for.
 */

/** Enough bytes for a shape, not a census. A few hundred rows of log lines fit comfortably. */
const HEAD_BYTES = 256 * 1024;

/**
 * The first `HEAD_BYTES` of a file, decoded, with the last line dropped when it was cut.
 *
 * A byte slice lands mid-record whenever the file is longer than the slice, and a half-line
 * parsed as a whole one would show a column count that is simply wrong. Dropping it costs one
 * sampled row and removes a class of confusing preview.
 */
export async function readHead(file: File): Promise<{ text: string; truncated: boolean }> {
  const truncated = file.size > HEAD_BYTES;
  const text = new TextDecoder().decode(await file.slice(0, HEAD_BYTES).arrayBuffer());
  if (!truncated) return { text, truncated };
  const cut = text.lastIndexOf('\n');
  return { text: cut === -1 ? text : text.slice(0, cut), truncated };
}

export interface PreviewColumn {
  name: string;
  /**
   * The distinct values seen, when there are few enough to be a KIND rather than data.
   *
   * Null once a column exceeds the cap: a column with thousands of distinct values is data,
   * and offering it as a discriminator would invite a source with one variant per request id.
   * The cap is what makes the proposal safe to accept without thinking about it.
   */
  values: string[] | null;
  /** What the sampled values look like. The schema editor offers this as a starting point. */
  inferred: 'text' | 'int' | 'decimal' | 'timestamp' | 'bool';
  /** How many sampled rows had no value — the unknown bucket, visible before anything is saved. */
  empty: number;
}

export interface Preview {
  /** What the browser thinks this file is. The server sniffs it again and decides. */
  format: 'csv' | 'jsonl';
  delimiter: string | null;
  /** The column the app proposes as the instant, or null when nothing looks like one. */
  suggestedTime: string | null;
  columns: PreviewColumn[];
  rows: Record<string, string>[];
  sampled: number;
  /** True when the file was longer than the sample — so the screen can say so. */
  truncated: boolean;
  /** Present when the file cannot be read at all; the drop zone shows it instead of a table. */
  problem?: string;
}

const SAMPLE_ROWS = 50;

/**
 * Above this many distinct values a column stops looking like a kind and starts looking like
 * data. Deliberately small: the kinds in a real stream are a handful, and a generous cap would
 * propose `sessionId` as cheerfully as `type`.
 */
const MAX_KIND_VALUES = 25;

const DELIMITERS = [',', ';', '\t', '|'];

/** Whichever delimiter yields the most cells in the header — counted outside quotes, so a
 *  comma inside `"Doe, Jane"` cannot make the comma win in a semicolon file. */
function sniffDelimiter(headerLine: string): string {
  let best = ',';
  let bestCount = 0;
  for (const d of DELIMITERS) {
    const n = splitCsvLine(headerLine, d).length;
    if (n > bestCount) { best = d; bestCount = n; }
  }
  return best;
}

const MAX_DEPTH = 8;

/** A nested value flattened to dotted paths. An array is ONE field holding its JSON — see
 *  `src/ingest.ts` for why indexing it would manufacture a field explosion. */
function flatten(value: unknown, prefix = '', depth = 0, out: Record<string, string> = {}): Record<string, string> {
  if (value === null || value === undefined) { out[prefix || 'value'] = ''; return out; }
  if (depth > MAX_DEPTH || Array.isArray(value)) { out[prefix || 'value'] = JSON.stringify(value); return out; }
  if (typeof value === 'object') {
    // An empty object contributes nothing — see `src/ingest.ts`: a `{}` leaf would make a path
    // a leaf on one record and a branch on the next, which no schema can declare once.
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      flatten(v, prefix ? `${prefix}.${k}` : k, depth + 1, out);
    }
    return out;
  }
  out[prefix || 'value'] = String(value);
  return out;
}

/**
 * The columns that could be a KIND, by one rule used everywhere.
 *
 * A kind REPEATS. A column whose every value is distinct is an identifier or a timestamp and
 * can never be one, so the test is few values RELATIVE to rows read rather than few values —
 * `occurred_at` with six distinct values in six rows is not a candidate however small six is.
 *
 * Exported because two panes ask the question and they must not answer it differently: the
 * ingest pane once hinted that a column looked like a kind while the Kinds pane refused to
 * offer it, which is worse than either answer alone.
 */
export function kindCandidates(preview: Preview): PreviewColumn[] {
  const ceiling = Math.max(2, Math.floor(preview.sampled / 2));
  return preview.columns.filter((c) => c.values && c.values.length > 1 && c.values.length <= ceiling);
}

/**
 * The combinations of discriminator values the sample actually contains.
 *
 * A PROPOSAL, and the count beside each one is why it is worth reading rather than
 * accepting: a combination seen twice in fifty rows is probably not a kind, and the person
 * looking at the file is the one who can tell.
 */
export function observedKinds(preview: Preview, discriminators: string[]): { selector: string[]; n: number }[] {
  if (discriminators.length === 0) return [];
  const counts = new Map<string, { selector: string[]; n: number }>();
  for (const row of preview.rows) {
    // Trailing levels a record does not reach are dropped, which is what makes the selector a
    // PREFIX: a page record carrying no `event` proposes `[page]` and not `[page, '']`.
    const selector: string[] = [];
    for (const d of discriminators) {
      const v = row[d] ?? '';
      if (v === '') break;
      selector.push(v);
    }
    if (selector.length === 0) continue;
    const key = JSON.stringify(selector);
    const hit = counts.get(key) ?? { selector, n: 0 };
    hit.n += 1;
    counts.set(key, hit);
  }
  return [...counts.values()].sort((a, b) => b.n - a.n);
}

/**
 * Which column most looks like the instant.
 *
 * A proposal, never a decision — the person confirms it, because "which column is when" is a
 * judgement about the export rather than a property of the bytes. Name first (a column called
 * `created_at` is a better guess than one that merely parses), then anything whose sampled
 * values all read as dates.
 */
function suggestTime(columns: string[], rows: Record<string, string>[]): string | null {
  const byName = columns.find((c) => /(date|time|stamp|created|occurred)/i.test(c));
  if (byName) return byName;
  return (
    columns.find((c) => {
      const seen = rows.map((r) => r[c] ?? '').filter((v) => v !== '');
      return seen.length > 0 && seen.every((v) => !Number.isNaN(Date.parse(v)));
    }) ?? null
  );
}

function splitCsvLine(line: string, delimiter = ','): string[] {
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

function inferType(values: string[]): PreviewColumn['inferred'] {
  const seen = values.filter((v) => v !== '');
  if (seen.length === 0) return 'text';
  if (seen.every((v) => /^-?\d+$/.test(v))) return 'int';
  if (seen.every((v) => /^-?\d+(\.\d+)?$/.test(v))) return 'decimal';
  if (seen.every((v) => /^\d{4}-\d{2}-\d{2}T/.test(v))) return 'timestamp';
  if (seen.every((v) => v === 'true' || v === 'false')) return 'bool';
  return 'text';
}

export function previewFile(text: string, truncatedBytes = false): Preview {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '');
  const empty = (problem: string, format: 'csv' | 'jsonl' = 'csv', delimiter: string | null = null): Preview =>
    ({ format, delimiter, suggestedTime: null, columns: [], rows: [], sampled: 0, truncated: truncatedBytes, problem });
  if (lines.length === 0) return empty('the file is empty');

  const format: 'csv' | 'jsonl' = /^[[{]/.test(text.trimStart()) ? 'jsonl' : 'csv';
  let rows: Record<string, string>[] = [];
  let columns: string[] = [];
  let delimiter: string | null = null;

  if (format === 'csv') {
    delimiter = sniffDelimiter(lines[0]!);
    columns = splitCsvLine(lines[0]!, delimiter).map((h) => h.trim());
    rows = lines
      .slice(1, SAMPLE_ROWS + 1)
      .map((l) => splitCsvLine(l, delimiter!))
      .filter((cells) => cells.length === columns.length)
      .map((cells) => Object.fromEntries(columns.map((h, i) => [h, cells[i] ?? ''])));
  } else {
    const seen = new Set<string>();
    for (const line of lines.slice(0, SAMPLE_ROWS)) {
      try {
        const value: unknown = JSON.parse(line);
        for (const item of Array.isArray(value) ? value : [value]) {
          if (item === null || typeof item !== 'object' || Array.isArray(item)) continue;
          const flat = flatten(item);
          Object.keys(flat).forEach((k) => seen.add(k));
          rows.push(flat);
        }
      } catch {
        /* an unreadable line contributes no names; the server reports it as malformed */
      }
    }
    columns = [...seen];
  }

  if (columns.length === 0) return empty('no readable records in the sample', format, delimiter);

  const cols = columns.map((name) => {
    const seen = new Set<string>();
    let tooMany = false;
    for (const r of rows) {
      const v = r[name] ?? '';
      if (v === '') continue;
      seen.add(v);
      if (seen.size > MAX_KIND_VALUES) {
        tooMany = true;
        break;
      }
    }
    return {
      name,
      inferred: inferType(rows.map((r) => r[name] ?? '')),
      empty: rows.filter((r) => (r[name] ?? '') === '').length,
      values: tooMany ? null : [...seen].sort(),
    };
  });

  return {
    format,
    delimiter,
    suggestedTime: suggestTime(columns, rows),
    columns: cols,
    rows,
    sampled: rows.length,
    // Truncated when the sample ran out of ROWS or the byte slice ran out of FILE — a reader
    // needs to know the preview is partial, not which limit stopped it.
    truncated: truncatedBytes || (format === 'csv' ? lines.length - 1 > rows.length : lines.length > rows.length),
  };
}

