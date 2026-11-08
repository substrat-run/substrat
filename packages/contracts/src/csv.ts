/**
 * CSV a spreadsheet opens as data, never as a formula.
 *
 * A CSV export is opened in Excel, LibreOffice or Google Sheets, and every one of them runs a
 * cell that starts with `=`, `+`, `-` or `@` as a formula. So a contact somebody named
 * `=HYPERLINK("http://example.net","x")` reaches the exported file as a working link, and the
 * DDE spellings reach the person who opened it. RFC 4180 quoting does not help: a quoted
 * `"=1+1"` is evaluated just the same. What helps is OWASP's CSV-injection guidance: a value
 * starting with one of those characters, a tab, a carriage return or a line feed is written
 * with a leading `'`, which makes the spreadsheet read it as text. The `'` stays visible in
 * the cell; that is the price of the cell being inert.
 *
 * ```ts
 * import { csvTable } from '@substrat-run/contracts';
 * const csv = csvTable(['name', 'email'], rows.map((r) => [r.name, r.email]));
 * ```
 *
 * What each value is written as:
 *
 * - a **string** is guarded as above, then quoted per RFC 4180 when it holds a comma, a
 *   double quote, a CR or an LF (a `"` doubled). A string that is wholly a decimal number
 *   (`-12.50`, `+46`) is left as it is: read as a formula it is only that number, and money
 *   in Substrat is a string, so a refund would otherwise reach the sheet as text no sum adds.
 * - a **number** is written as `String(n)`, never guarded: a number's text cannot call
 *   anything, and `-5` should stay a number. `NaN` and `Infinity` throw rather than write a
 *   word into a numeric column.
 * - a **boolean** is `true` / `false`; **`null` and `undefined`** are an empty cell.
 *
 * Anything else throws a `TypeError` rather than writing `[object Object]`.
 *
 * Comma-separated, CRLF line endings, every record ending in CRLF, as RFC 4180 has it.
 *
 * boundary-lint R13 refuses cells joined by hand in module code that writes CSV, and points
 * here.
 */
export type CsvValue = string | number | boolean | null | undefined;

/** Starts a formula in a spreadsheet (OWASP), or is stripped before one is looked for. */
const FORMULA_START = /^[=+\-@\t\r\n]/;
/** A plain decimal number: inert as a formula, so it keeps its sign and stays a number. */
const DECIMAL = /^[-+]?\d+(?:\.\d+)?$/;
/** What RFC 4180 says a field must be quoted for. */
const NEEDS_QUOTES = /[",\r\n]/;

/** One field, guarded against formula injection and quoted for a comma-separated file. */
export function csvCell(value: CsvValue): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'boolean') return String(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(`csvCell: ${value} is not a finite number`);
    return String(value);
  }
  if (typeof value !== 'string') {
    throw new TypeError(`csvCell: a ${typeof value} is not a string, number, boolean or null`);
  }
  const text = FORMULA_START.test(value) && !DECIMAL.test(value) ? `'${value}` : value;
  return NEEDS_QUOTES.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/**
 * A whole CSV file: the header record, then one record per row, every cell through
 * `csvCell`. A row with a different number of cells from the header throws a `RangeError`,
 * since a spreadsheet would shift every column after the gap without a word.
 */
export function csvTable(header: readonly string[], rows: Iterable<readonly CsvValue[]>): string {
  const record = (cells: readonly CsvValue[]): string => `${cells.map(csvCell).join(',')}\r\n`;
  let out = record(header);
  let n = 0;
  for (const row of rows) {
    n += 1;
    if (row.length !== header.length) {
      throw new RangeError(`csvTable: row ${n} has ${row.length} cells, the header ${header.length}`);
    }
    out += record(row);
  }
  return out;
}
