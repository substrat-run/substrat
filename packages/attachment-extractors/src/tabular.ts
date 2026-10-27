/** Structured spreadsheet reading for host tools. No formulas, macros or links execute. */
import { ExtractionBoundExceeded, MalformedInput, Pace } from './shared.js';

export interface SpreadsheetSheet {
  name: string;
  /** Physical row numbers, one-based. Missing cells are null; text and decimals stay strings. */
  rows: { number: number; cells: (string | null)[] }[];
}
export interface Spreadsheet {
  sheets: SpreadsheetSheet[];
  /** Formula cells contain their cached result, which can be absent or stale. */
  formulaCells: number;
}

export const SPREADSHEET_LIMITS = {
  sheets: 32, rows: 10_000, columns: 256, cells: 100_000, cellCharacters: 32_768,
  totalCharacters: 2 * 1024 * 1024,
} as const;

function cellSize(value: string): string {
  if (value.length > SPREADSHEET_LIMITS.cellCharacters) throw new ExtractionBoundExceeded('a spreadsheet cell is too long');
  return value;
}

/** Strict quoted CSV/TSV, with embedded newlines and doubled quotes. Never coerces identifiers. */
export async function delimitedSheet(text: string, delimiter: ',' | ';' | '\t', pace: Pace): Promise<Spreadsheet> {
  const rows: SpreadsheetSheet['rows'] = [];
  let row: string[] = [];
  let value = '';
  let quoted = false;
  let closed = false;
  let cells = 0;
  let characters = 0;
  const field = () => {
    row.push(cellSize(value));
    characters += value.length;
    if (characters > SPREADSHEET_LIMITS.totalCharacters) throw new ExtractionBoundExceeded('the spreadsheet contains too much cell text');
    if (++cells > SPREADSHEET_LIMITS.cells || row.length > SPREADSHEET_LIMITS.columns) {
      throw new ExtractionBoundExceeded('the spreadsheet exceeds its cell or column limit');
    }
    value = '';
    closed = false;
  };
  const endRow = () => {
    field();
    if (rows.length >= SPREADSHEET_LIMITS.rows) throw new ExtractionBoundExceeded('the spreadsheet has too many rows');
    rows.push({ number: rows.length + 1, cells: row });
    row = [];
  };
  for (let at = 0; at < text.length; at++) {
    await pace.turn();
    pace.charge(1);
    const ch = text[at]!;
    if (quoted) {
      if (ch === '"') {
        if (text[at + 1] === '"') { value += '"'; at++; }
        else { quoted = false; closed = true; }
      } else value += ch;
    } else if (ch === delimiter) field();
    else if (ch === '\r' || ch === '\n') {
      if (ch === '\r' && text[at + 1] === '\n') at++;
      endRow();
    } else if (ch === '"' && !value && !closed) quoted = true;
    else {
      if (closed || ch === '"') throw new MalformedInput('invalid quoting in the delimited file');
      value += ch;
    }
    if (value.length > SPREADSHEET_LIMITS.cellCharacters) throw new ExtractionBoundExceeded('a spreadsheet cell is too long');
  }
  if (quoted) throw new MalformedInput('an unterminated quoted field in the delimited file');
  if (value.length || row.length || closed) endRow();
  return { sheets: [{ name: 'Sheet1', rows }], formulaCells: 0 };
}

type Attributes = Record<string, string>;
type XmlVisitor = { tag(name: string, attrs: Attributes, closing: boolean): void; text(text: string): void };
type Decode = (text: string) => Promise<string>;

/** A forward-only XML scan; DTD/entity declarations are refused, depth and attributes bounded. */
async function xml(xml: string, pace: Pace, decode: Decode, visitor: XmlVisitor, optional = false): Promise<void> {
  const stack: string[] = [];
  let rootSeen = false;
  for (let at = 0; at < xml.length;) {
    const lt = await pace.find(xml, '<', at);
    const end = lt < 0 ? xml.length : lt;
    if (end > at) {
      const text = xml.slice(at, end);
      if (!stack.length && await pace.scan(text, 0, (c) => c !== 32 && c !== 9 && c !== 10 && c !== 13) >= 0) {
        throw new MalformedInput('text outside the spreadsheet XML root');
      }
      if (stack.length) visitor.text(await decode(text));
    }
    if (lt < 0) break;
    at = lt + 1;
    if (xml.startsWith('!--', at) || xml.startsWith('?', at)) {
      const comment = xml.startsWith('!--', at);
      const marker = comment ? '-->' : '?>';
      const close = await pace.find(xml, marker, at + (comment ? 3 : 1));
      if (close < 0) throw new MalformedInput('unclosed spreadsheet XML comment or instruction');
      at = close + marker.length;
      continue;
    }
    if (xml[at] === '!') throw new MalformedInput('spreadsheet DTD and entity declarations are unsupported');
    let quote = 0;
    const gt = await pace.scan(xml, at, (c) => {
      if (quote) { if (c === quote) quote = 0; return false; }
      if (c === 34 || c === 39) { quote = c; return false; }
      return c === 62;
    });
    if (gt < 0) throw new MalformedInput('unclosed spreadsheet XML tag');
    const tag = xml.slice(at, gt);
    // Tag headers do not need to carry cell contents. This also bounds the attribute pass.
    if (tag.length > 16_384) throw new ExtractionBoundExceeded('a spreadsheet XML tag is too long');
    const match = /^(\/)?([A-Za-z_][\w:.-]*)([\s\S]*)$/.exec(tag);
    if (!match) throw new MalformedInput('invalid spreadsheet XML tag');
    const closing = !!match[1];
    const qualified = match[2]!;
    const name = qualified.slice(qualified.lastIndexOf(':') + 1);
    const selfClosing = !closing && tag.endsWith('/');
    const tail = match[3]!.slice(0, selfClosing ? -1 : undefined);
    const attrs: Attributes = Object.create(null);
    let pos = 0;
    let count = 0;
    while (pos < tail.length) {
      const space = /^\s+/.exec(tail.slice(pos));
      if (!space) throw new MalformedInput('invalid spreadsheet XML attribute');
      pos += space[0].length;
      if (pos === tail.length) break;
      if (closing || ++count > 64) throw new MalformedInput('invalid spreadsheet XML attributes');
      const attribute = /^([A-Za-z_][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/.exec(tail.slice(pos));
      if (!attribute || Object.hasOwn(attrs, attribute[1]!)) throw new MalformedInput('invalid spreadsheet XML attribute');
      attrs[attribute[1]!] = await decode(attribute[2] ?? attribute[3]!);
      pos += attribute[0].length;
    }
    if (closing) {
      if (stack.pop() !== qualified) throw new MalformedInput('mismatched spreadsheet XML tags');
      visitor.tag(name, attrs, true);
    } else {
      if (!stack.length) {
        if (rootSeen) throw new MalformedInput('spreadsheet XML has more than one root element');
        rootSeen = true;
      }
      visitor.tag(name, attrs, false);
      if (selfClosing) visitor.tag(name, attrs, true);
      else {
        stack.push(qualified);
        if (stack.length > 64) throw new ExtractionBoundExceeded('spreadsheet XML is too deeply nested');
      }
    }
    at = gt + 1;
  }
  if (stack.length) throw new MalformedInput('unclosed spreadsheet XML elements');
  if (!rootSeen && !(optional && xml.length === 0)) throw new MalformedInput('spreadsheet XML has no root element');
}

/** Resolves only workbook-local worksheet parts; external references never get fetched. */
export async function workbook(
  part: (name: string) => Promise<string>, pace: Pace, decode: Decode,
): Promise<Spreadsheet> {
  const sheets: { name: string; rel: string }[] = [];
  const relationships = new Map<string, string>();
  await xml(await part('xl/workbook.xml'), pace, decode, {
    tag(name, attrs, closing) {
      if (name !== 'sheet' || closing) return;
      if (sheets.length >= SPREADSHEET_LIMITS.sheets) throw new ExtractionBoundExceeded('the workbook has too many sheets');
      if (!attrs.name || !attrs['r:id']) throw new MalformedInput('a worksheet has no name or relationship');
      sheets.push({ name: attrs.name, rel: attrs['r:id'] });
    }, text() {},
  });
  await xml(await part('xl/_rels/workbook.xml.rels'), pace, decode, {
    tag(name, attrs, closing) {
      if (name !== 'Relationship' || closing || !attrs.Type?.endsWith('/worksheet')) return;
      if (!attrs.Id || !attrs.Target || attrs.TargetMode === 'External' || relationships.has(attrs.Id)) {
        throw new MalformedInput('invalid or external worksheet relationship');
      }
      const target = attrs.Target.startsWith('/') ? attrs.Target.slice(1) : `xl/${attrs.Target}`;
      if (!/^xl\/worksheets\/[^/\\]+\.xml$/.test(target)) throw new MalformedInput('unsupported worksheet path');
      relationships.set(attrs.Id, target);
    }, text() {},
  });
  const strings: string[] = [];
  let stringCharacters = 0;
  let inText = false;
  let phonetic = 0;
  let shared: string | undefined;
  await xml(await part('xl/sharedStrings.xml'), pace, decode, {
    tag(name, _attrs, closing) {
      if (name === 'rPh') phonetic += closing ? -1 : 1;
      if (name === 't') inText = !closing;
      if (name === 'si') {
        if (!closing) shared = '';
        else {
          if (strings.length >= SPREADSHEET_LIMITS.cells) throw new ExtractionBoundExceeded('too many shared strings');
          strings.push(cellSize(shared ?? ''));
          stringCharacters += shared?.length ?? 0;
          if (stringCharacters > SPREADSHEET_LIMITS.totalCharacters) throw new ExtractionBoundExceeded('too much shared string text');
          shared = undefined;
        }
      }
    },
    text(text) { if (shared !== undefined && inText && !phonetic) shared = cellSize(shared + text); },
  }, true);
  const result: Spreadsheet = { sheets: [], formulaCells: 0 };
  let totalRows = 0;
  let totalCells = 0;
  let totalCharacters = 0;
  for (const sheet of sheets) {
    const path = relationships.get(sheet.rel);
    if (!path) throw new MalformedInput('missing worksheet relationship');
    const output: SpreadsheetSheet = { name: sheet.name, rows: [] };
    let row: SpreadsheetSheet['rows'][number] | undefined;
    let column = 0;
    let type = '';
    let value = '';
    let capture = false;
    let cell = false;
    let formula = false;
    let hasValue = false;
    let previousRow = 0;
    let phonetic = 0;
    await xml(await part(path), pace, decode, {
      tag(name, attrs, closing) {
        if (name === 'row') {
          if (!closing) {
            if (row) throw new MalformedInput('nested worksheet rows');
            const number = attrs.r === undefined ? previousRow + 1 : Number(attrs.r);
            if (!Number.isSafeInteger(number) || number <= previousRow) throw new MalformedInput('invalid worksheet row number');
            if (++totalRows > SPREADSHEET_LIMITS.rows) throw new ExtractionBoundExceeded('the workbook has too many rows');
            previousRow = number;
            row = { number, cells: [] };
          } else if (row) { output.rows.push(row); row = undefined; }
        }
        if (name === 'c') {
          if (!row) throw new MalformedInput('a worksheet cell has no row');
          if (!closing) {
            if (cell) throw new MalformedInput('nested worksheet cells');
            const ref = attrs.r ? /^([A-Z]{1,3})([1-9][0-9]*)$/.exec(attrs.r) : null;
            if (attrs.r && (!ref || Number(ref[2]) !== row.number)) throw new MalformedInput('invalid cell reference');
            column = ref ? [...ref[1]!].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1 : row.cells.length;
            if (column < row.cells.length) throw new MalformedInput('duplicate or unordered worksheet cells');
            totalCells += column - row.cells.length + 1;
            if (column >= SPREADSHEET_LIMITS.columns || totalCells > SPREADSHEET_LIMITS.cells) {
              throw new ExtractionBoundExceeded('the workbook exceeds its cell or column limit');
            }
            type = attrs.t ?? 'n'; value = ''; cell = true; formula = false; hasValue = false;
          } else {
            if (formula) result.formulaCells++;
            let parsed: string | null = hasValue ? value : null;
            if (type === 's' && parsed !== null) {
              if (!/^[0-9]+$/.test(value) || strings[Number(value)] === undefined) throw new MalformedInput('invalid shared string index');
              parsed = strings[Number(value)]!;
            }
            if (type === 'b' && parsed !== null) {
              if (value !== '0' && value !== '1') throw new MalformedInput('invalid boolean cell');
              parsed = value === '1' ? 'true' : 'false';
            }
            if (type === 'e') throw new MalformedInput('the workbook contains a cell error');
            if (!['n', 's', 'b', 'str', 'inlineStr', 'd'].includes(type)) throw new MalformedInput('unsupported worksheet cell type');
            totalCharacters += parsed?.length ?? 0;
            if (totalCharacters > SPREADSHEET_LIMITS.totalCharacters) throw new ExtractionBoundExceeded('the workbook contains too much cell text');
            while (row.cells.length < column) row.cells.push(null);
            row.cells.push(parsed);
            cell = false;
          }
        }
        if (cell && name === 'f' && !closing) formula = true;
        if (name === 'rPh') phonetic += closing ? -1 : 1;
        if (cell && (name === 'v' || name === 't')) { capture = !closing; if (!closing) hasValue = true; }
      },
      text(text) { if (capture && cell && !phonetic) value = cellSize(value + text); },
    });
    result.sheets.push(output);
  }
  if (!result.sheets.length) throw new MalformedInput('the workbook contains no worksheets');
  return result;
}
