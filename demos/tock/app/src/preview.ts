/**
 * The browser's read of a dropped file — a PREVIEW, and authoritative for nothing.
 *
 * This exists so correcting an inferred type feels immediate instead of costing a round trip
 * per guess. Every number that reaches a rollup — the content hash, the row count, the
 * observations, the counts — comes from the server re-reading the bytes it stored. A design
 * whose claim is "numbers you can stand behind" cannot take them from the client that
 * submitted them, so nothing here is ever sent as a fact.
 *
 * It deliberately reads only the first slice of a large file: the modelling conversation needs
 * a shape, not a census, and holding a month of logs in a tab to show six rows would make the
 * screen worse rather than better.
 */

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

export function previewFile(text: string): Preview {
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

  return { columns, rows, sampled: rows.length, truncated: lines.length - 1 > body.length };
}
