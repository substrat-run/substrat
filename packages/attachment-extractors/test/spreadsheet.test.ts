import { describe, expect, it } from 'vitest';
import { MalformedInput, readSpreadsheet, SPREADSHEET_LIMITS, textExtractor } from '../src/index.js';
import { zip, type Part } from './zip.js';

const enc = (text: string) => new TextEncoder().encode(text);
const csv = (text: string, delimiter?: ',' | ';' | '\t') => readSpreadsheet({
  body: enc(text), filename: 'input.csv', contentType: 'text/csv', delimiter,
});
const prolog = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const xlsxBytes = (sheet: string, extra: Part[] = []) => zip([
  { name: 'xl/workbook.xml', data: enc(`${prolog}<workbook xmlns:r="urn:relationships"><sheets><sheet name="Items &amp; amounts" sheetId="1" r:id="r1"/></sheets></workbook>`) },
  { name: 'xl/_rels/workbook.xml.rels', data: enc(`${prolog}<Relationships><Relationship Id="r1" Type="urn:office/worksheet" Target="worksheets/data.xml"/></Relationships>`) },
  { name: 'xl/worksheets/data.xml', data: enc(`${prolog}<worksheet><sheetData>${sheet}</sheetData></worksheet>`) },
  ...extra,
]);
const readXlsx = (body: Uint8Array) => readSpreadsheet({ filename: 'input.xlsx', contentType: 'application/octet-stream', body });
const xlsx = async (sheet: string, extra: Part[] = []) => readXlsx(await xlsxBytes(sheet, extra));

describe('structured spreadsheet input for imports and comparisons', () => {
  it('CSV preserves identifiers, decimal spelling, quoted separators, quotes, newlines and empty cells', async () => {
    const parsed = await csv('\ufeffcode,amount,note,empty\r\n001,12.50,"hello, ""world""\nnext",\r\n');
    expect(parsed).toEqual({ sheets: [{ name: 'Sheet1', rows: [
      { number: 1, cells: ['code', 'amount', 'note', 'empty'] },
      { number: 2, cells: ['001', '12.50', 'hello, "world"\nnext', ''] },
    ] }], formulaCells: 0 });
    expect((await csv('a;b\n001;2', ';')).sheets[0]!.rows[1]!.cells).toEqual(['001', '2']);
    const tsv = await readSpreadsheet({ body: enc('a\tb\n001\t2'), filename: 'input.tsv', contentType: 'text/tab-separated-values' });
    expect(tsv.sheets[0]!.rows[1]!.cells).toEqual(['001', '2']);
  });

  it('XLSX accepts standard XML prologs, follows relationships and preserves strings, coordinates, numbers and formula caches', async () => {
    const parsed = await xlsx(
      '<row r="2"><c r="A2" t="s"><v>0</v></c><c r="C2"><v>12.50</v></c><c r="D2" t="b"><v>1</v></c></row>' +
      '<row r="4"><c r="A4" t="inlineStr"><is><t>001</t></is></c><c r="B4"><f>C2*2</f><v>25</v></c><c r="C4"><f>1+1</f></c></row>',
      [{ name: 'xl/sharedStrings.xml', data: enc('<sst><si><r><t>Part </t></r><r><t>A &amp; B</t></r></si></sst>') }],
    );
    expect(parsed).toEqual({ sheets: [{ name: 'Items & amounts', rows: [
      { number: 2, cells: ['Part A & B', null, '12.50', 'true'] },
      { number: 4, cells: ['001', '25', null] },
    ] }], formulaCells: 2 });
  });

  it('refuses multiple XML roots and text outside a root, including after a self-closing root', async () => {
    for (const xml of ['<sst/><sst/>', '<sst></sst><sst/>', 'text<sst/>', '<sst/>text', '   ']) {
      await expect(xlsx('', [{ name: 'xl/sharedStrings.xml', data: enc(xml) }])).rejects.toThrow(MalformedInput);
    }
  });

  it('strictly decodes XML entities for imports and preserves escaped literal references', async () => {
    const inline = (text: string) => `<row><c t="inlineStr"><is><t>${text}</t></is></c></row>`;
    const parsed = await xlsx(inline('&lt;&gt;&apos;&quot;&amp;&#228;&#x1F600;&amp;bogus;'));
    expect(parsed.sheets[0]!.rows[0]!.cells).toEqual(['<>\'"&ä😀&bogus;']);
    for (const text of ['&bogus;', '&toString;', '&amp', '&#;', '&#0;', '&#xD800;', '&#x110000;']) {
      await expect(xlsx(inline(text))).rejects.toThrow(MalformedInput);
    }
  });

  it('refuses a local ZIP header whose name, flags or compression method disagrees with the directory', async () => {
    const original = await xlsxBytes('');
    for (const offset of [30, 6, 8]) {
      const corrupt = original.slice();
      // The fixture writer puts xl/workbook.xml first, with a local header at byte zero.
      corrupt[offset] = corrupt[offset]! ^ 1;
      await expect(readXlsx(corrupt)).rejects.toThrow('local and central zip headers disagree');
    }
  });

  it('refuses unused ZIP directory records whose extra or comment bytes extend past the directory', async () => {
    const unused = 'unused';
    const original = await xlsxBytes('', [{ name: unused, data: enc('unused') }]);
    // Last central record, followed by the writer's 22-byte, comment-free EOCD.
    const last = original.length - 22 - 46 - unused.length;
    for (const [field, size] of [[30, 1], [32, 0xffff]] as const) {
      const corrupt = original.slice();
      new DataView(corrupt.buffer).setUint16(last + field, size, true);
      await expect(readXlsx(corrupt)).rejects.toThrow(MalformedInput);
    }
  });

  it('refuses malformed input and limits instead of returning a partial import', async () => {
    for (const text of ['"unclosed', '"closed"junk', 'bad"quote', 'a'.repeat(SPREADSHEET_LIMITS.cellCharacters + 1), Array(257).fill('x').join(',')]) {
      await expect(csv(text)).rejects.toThrow();
    }
    for (const sheet of [
      '<row r="1"><c r="A1" t="s"><v>999</v></c></row>',
      '<row r="1"><c r="IW1"><v>1</v></c></row>',
      '<row r="1"><c r="A1" t="e"><v>#REF!</v></c></row>',
      '<row r="1"><c r="A1"><v>1</c></row>',
      '<!DOCTYPE x [<!ENTITY y "z">]>',
    ]) await expect(xlsx(sheet)).rejects.toThrow();
    await expect(readSpreadsheet({ body: enc('a,b'), filename: 'data.xls', contentType: 'application/vnd.ms-excel' })).rejects.toThrow();
    await expect(readSpreadsheet({ body: enc('a,b'), filename: 'data.csv', contentType: 'text/csv; charset=unknown' })).rejects.toThrow(MalformedInput);
  });

  it('reports invalid bytes and incomplete character flushes as malformed CSV and XLSX input', async () => {
    for (const bytes of [[0xff], [0xc3]]) {
      const body = new Uint8Array(bytes);
      await expect(readSpreadsheet({ body, filename: 'data.csv', contentType: 'text/csv' })).rejects.toThrow(MalformedInput);
      expect(await textExtractor().extract({
        body, filename: 'data.csv', contentType: 'text/csv', maxTextBytes: 1024, signal: { aborted: false },
      })).toEqual({ text: '\ufffd', truncated: false });
      for (const method of [0, 8]) {
        await expect(xlsx('', [{ name: 'xl/sharedStrings.xml', data: body, method }])).rejects.toThrow(MalformedInput);
      }
    }
  });

  it('bounds expanded shared-string output and honors cancellation', async () => {
    const large = 'a'.repeat(SPREADSHEET_LIMITS.cellCharacters);
    const cells = Array.from({ length: 65 }, () => '<c t="s"><v>0</v></c>').join('');
    await expect(xlsx(`<row>${cells}</row>`, [
      { name: 'xl/sharedStrings.xml', data: enc(`<sst><si><t>${large}</t></si></sst>`) },
    ])).rejects.toThrow('too much cell text');
    await expect(readSpreadsheet({
      body: enc('a,b'), filename: 'data.csv', contentType: 'text/csv', signal: { aborted: true },
    })).rejects.toThrow('aborted');
  });
});
