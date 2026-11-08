import { describe, it, expect } from 'vitest';
import { csvCell, csvTable, type CsvValue } from '../src/index.js';

describe('csvCell', () => {
  it.each<[string, CsvValue, string]>([
    ['plain text as it is', 'Ada Lovelace', 'Ada Lovelace'],
    ['a formula, guarded and then quoted', '=HYPERLINK("http://example.net","x")', `"'=HYPERLINK(""http://example.net"",""x"")"`],
    ['a leading +', '+cmd', "'+cmd"],
    ['a leading -', '-2+3', "'-2+3"],
    ['a leading @', '@SUM(A1)', "'@SUM(A1)"],
    ['a leading tab', '\t=1', "'\t=1"],
    ['a leading CR, quoted for the CR', '\r=1', `"'\r=1"`],
    ['a leading LF, quoted for the LF', '\n=1', `"'\n=1"`],
    ['a decimal string keeps its sign', '-12.50', '-12.50'],
    ['a signed integer string', '+46', '+46'],
    ['a comma, quoted', 'Acme, Inc.', '"Acme, Inc."'],
    ['a double quote, doubled', 'say "hi"', '"say ""hi"""'],
    ['an LF inside, quoted', 'line 1\nline 2', '"line 1\nline 2"'],
    ['a = after the first character is not a formula', 'a=b', 'a=b'],
    ['a number, never guarded', -5, '-5'],
    ['a fraction', 2.5, '2.5'],
    ['a boolean', false, 'false'],
    ['null, an empty cell', null, ''],
    ['undefined, an empty cell', undefined, ''],
  ])('%s', (_, value, written) => {
    expect(csvCell(value)).toBe(written);
  });

  it('refuses what it would otherwise write as a word', () => {
    expect(() => csvCell(Number.NaN)).toThrow(/NaN is not a finite number/);
    expect(() => csvCell(Number.NEGATIVE_INFINITY)).toThrow(TypeError);
    // Outside the type, but a caller holding `any` gets the refusal rather than `[object Object]`.
    expect(() => csvCell({} as unknown as string)).toThrow(/a object is not a string/);
  });
});

describe('csvTable', () => {
  it('writes the header and every row through csvCell, each record ending in CRLF', () => {
    expect(csvTable(['name', 'total, SEK'], [['=1+1', '-12.50'], [null, 3]])).toBe(
      `name,"total, SEK"\r\n'=1+1,-12.50\r\n,3\r\n`,
    );
  });

  it('refuses a row whose width is not the header’s', () => {
    expect(() => csvTable(['a', 'b'], [['1', '2'], ['3']])).toThrow(/row 2 has 1 cells, the header 2/);
  });
});
