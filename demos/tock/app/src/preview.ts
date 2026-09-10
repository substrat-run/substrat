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
  /** What the sampled values look like. The schema editor offers this as a starting point. */
  inferred: 'text' | 'int' | 'decimal' | 'timestamp' | 'bool';
  /** How many sampled rows had no value — the unknown bucket, visible before anything is saved. */
  empty: number;
}

export interface Preview {
  columns: PreviewColumn[];
  rows: Record<string, string>[];
  sampled: number;
  /** True when the file was longer than the sample — so the screen can say so. */
  truncated: boolean;
  /** Present when the file cannot be read at all; the drop zone shows it instead of a table. */
  problem?: string;
}

const SAMPLE_ROWS = 50;

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
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
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
  if (lines.length < 2) return { columns: [], rows: [], sampled: 0, truncated: false, problem: 'the file has no rows under its header' };

  const header = splitCsvLine(lines[0]!).map((h) => h.trim());
  if (!header.includes('occurred_at') || !header.includes('subject'))
    return {
      columns: [],
      rows: [],
      sampled: 0,
      truncated: false,
      problem: `a delivered file needs an 'occurred_at' and a 'subject' column; this one has: ${header.join(', ')}`,
    };

  const body = lines.slice(1, SAMPLE_ROWS + 1);
  const rows = body
    .map((l) => splitCsvLine(l))
    .filter((cells) => cells.length === header.length)
    .map((cells) => Object.fromEntries(header.map((h, i) => [h, cells[i] ?? ''])));

  const columns = header
    // The two structural columns are not fields a schema models; they are how a record is
    // addressed. Showing them as modellable would invite someone to mark `subject` a dimension,
    // which is the one value this design never stores.
    .filter((h) => h !== 'occurred_at' && h !== 'subject')
    .map((name) => ({
      name,
      inferred: inferType(rows.map((r) => r[name] ?? '')),
      empty: rows.filter((r) => (r[name] ?? '') === '').length,
    }));

  // Truncated when the sample ran out of ROWS or when the byte slice ran out of FILE — a
  // reader only needs to know the preview is partial, not which limit stopped it.
  return { columns, rows, sampled: rows.length, truncated: truncatedBytes || lines.length - 1 > body.length };
}
