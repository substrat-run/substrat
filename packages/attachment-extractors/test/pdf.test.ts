import { readFileSync } from 'node:fs';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_ATTACHMENT_TEXT_BOUNDS,
  EXTRACTION_STRIDE,
  runAttachmentExtractor,
  type AttachmentExtractor,
  type ExtractionOutcome,
  type ExtractionSignal,
} from '@substrat-run/kernel';
import { DEFAULT_EXTRACTOR_BOUNDS, PDF_OBJECTS_MAX, PDF_STREAM_MAX, PDF_XREF_SECTIONS, docxExtractor, htmlExtractor, pdfExtractor, pdfTables, textExtractor } from '../src/index.js';
import { PDF_RETAINED_BASE, PDF_RETAINED_FACTOR, pdfCMap, pdfCodeMap, pdfDecoders, pdfExtract, pdfFontCosts, pdfLexer } from '../src/pdf.js';
import { CALL_COST, Pace, Retained } from '../src/shared.js';
import { zip } from './zip.js';

/** A `Pace` that counts the work charged to it: what a decoder did, not only what it returned. */
class CountingPace extends Pace {
  charged = 0;
  turns = 0;
  override charge(units: number): void {
    this.charged += units;
    super.charge(units);
  }
  override async turn(): Promise<void> {
    if (this.room <= 0) this.turns += 1;
    await super.turn();
  }
}
const counting = () => new CountingPace({ aborted: false });
/** A pace whose stride leaves room to decode only `width` string bytes at a time: every window edge, exercised. */
class NarrowPace extends CountingPace {
  constructor(private readonly width: number) {
    super({ aborted: false });
  }
  override get room(): number {
    return Math.min(super.room, this.width * pdfFontCosts.decodePerByte);
  }
}

/**
 * The PDF extractor, through the kernel's own enforcement (`runAttachmentExtractor`), so an
 * outcome here is what a host records. Real producers' files are in the contract suite, which
 * runs on both adapters; here are the cases no producer writes: every feature in isolation,
 * every bound, and hostile files — each of which must end `failed` or `empty`, promptly.
 */
const pdf = pdfExtractor();
const run = (body: Uint8Array, maxTextBytes = DEFAULT_ATTACHMENT_TEXT_BOUNDS.maxTextBytes): Promise<ExtractionOutcome> =>
  runAttachmentExtractor(pdf, { body, contentType: 'application/pdf', filename: 'f.pdf' }, { ...DEFAULT_ATTACHMENT_TEXT_BOUNDS, maxTextBytes });
const textOf = (o: ExtractionOutcome): string => {
  if (o.status !== 'indexed') throw new Error(`expected indexed, got ${JSON.stringify(o)}`);
  return o.text;
};

const MIB = 1024 * 1024;
const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
/** Bytes 0–255 as written, for content that is not UTF-8. */
const bin = (s: string): Uint8Array => {
  // A plain loop: the test inputs run to tens of MiB, where `Uint8Array.from` with a callback crawls.
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i += 1) out[i] = s.charCodeAt(i);
  return out;
};
const cat = (...parts: (string | Uint8Array)[]): Uint8Array => {
  const bytes = parts.map((p) => (typeof p === 'string' ? bin(p) : p));
  const out = new Uint8Array(bytes.reduce((n, b) => n + b.length, 0));
  let at = 0;
  for (const b of bytes) {
    out.set(b, at);
    at += b.length;
  }
  return out;
};

async function deflate(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data]).stream().pipeThrough(new CompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** A stream object's body: the dictionary (with a correct `/Length`), then the data. */
const stream = (dict: string, data: Uint8Array | string): Uint8Array => {
  const bytes = typeof data === 'string' ? bin(data) : data;
  return cat(`<< /Length ${bytes.length} ${dict} >>\nstream\n`, bytes, '\nendstream');
};

interface Built {
  bytes: Uint8Array;
  /** Byte offset of each object, by number. */
  offsets: Map<number, number>;
  /** Where the cross-reference section starts. */
  xrefAt: number;
}

/**
 * A PDF from object bodies, numbered from 1, with a classic cross-reference table — the way a
 * plain writer lays one out. `trailer` adds to the trailer dictionary; `prefix` is a file this
 * one is an incremental update of, whose objects keep their offsets.
 */
function build(objects: Map<number, string | Uint8Array> | (string | Uint8Array)[], opts: { trailer?: string; prefix?: Uint8Array } = {}): Built {
  const entries = Array.isArray(objects) ? objects.map((o, i) => [i + 1, o] as const) : [...objects];
  const parts: Uint8Array[] = [opts.prefix ?? bin('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n')];
  let at = parts[0]!.length;
  const offsets = new Map<number, number>();
  for (const [num, body] of entries) {
    const obj = cat(`${num} 0 obj\n`, body, '\nendobj\n');
    offsets.set(num, at);
    parts.push(obj);
    at += obj.length;
  }
  const xrefAt = at;
  const rows = entries.map(([num]) => `${num} 1\n${String(offsets.get(num)).padStart(10, '0')} 00000 n \n`).join('');
  const size = Math.max(...entries.map(([n]) => n)) + 1;
  parts.push(bin(`xref\n0 1\n0000000000 65535 f \n${rows}trailer\n<< /Size ${size} /Root 1 0 R ${opts.trailer ?? ''} >>\nstartxref\n${xrefAt}\n%%EOF\n`));
  return { bytes: cat(...parts), offsets, xrefAt };
}

const CATALOG = '<< /Type /Catalog /Pages 2 0 R >>';
const PAGES = '<< /Type /Pages /Kids [3 0 R] /Count 1 >>';
const PAGE = '<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>';
const HELVETICA = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>';

/** One page drawing `content` in Helvetica; `extra` objects are numbered from 6. */
const onePage = (content: Uint8Array | string, opts: { contentDict?: string; font?: string; extra?: (string | Uint8Array)[]; page?: string; trailer?: string } = {}) =>
  build([CATALOG, PAGES, opts.page ?? PAGE, opts.font ?? HELVETICA, stream(opts.contentDict ?? '', content), ...(opts.extra ?? [])], { trailer: opts.trailer });

/** Whatever the file, the answer is an outcome, and it comes promptly: within `withinMs` of CPU. */
async function settles(body: Uint8Array, withinMs = 5_000): Promise<ExtractionOutcome> {
  const t0 = cpuMs();
  const outcome = await run(body);
  expect(cpuMs() - t0).toBeLessThan(withinMs);
  return outcome;
}

describe('pdf: what it reads', () => {
  it('a real producer: Quartz, a TrueType font in MacRomanEncoding with no ToUnicode', async () => {
    const text = textOf(await run(new Uint8Array(readFileSync(new URL('./fixtures/quartz-macroman.pdf', import.meta.url)))));
    expect(text).toContain('Inspection protocol');
    expect(text).toContain('The drainage culvert shows moderate erosion near the outflow.');
    expect(text).toContain('Åtgärd: byt ut rörstycket före vintern.');
  });

  it('shows strings by every operator, escapes decoded, lines and kerned gaps kept apart', async () => {
    const content = [
      'BT /F1 12 Tf 72 700 Td (Line \\(one\\) caf\\351) Tj',
      '0 -14 Td <48657820737472696e67> Tj',
      "T* (third line) '",
      'T* [(kern)-30(ed)-400(gap)] TJ',
      '10 0 Td (after) Tj ET',
    ].join('\n');
    expect(textOf(await run(onePage(content).bytes))).toBe('Line (one) café\nHex string\n\nthird line\nkerned gap after');
  });

  it('decodes /Differences glyph names: accents composed, uniXXXX, ligatures and suffixes', async () => {
    const font =
      '<< /Type /Font /Subtype /Type1 /BaseFont /X /Encoding << /BaseEncoding /WinAnsiEncoding ' +
      '/Differences [1 /aacute /uni00E9 /f_i /a.sc /odieresis /fl] >> >>';
    expect(textOf(await run(onePage('BT /F1 9 Tf (\\001\\002\\003\\004\\005\\006 x) Tj ET', { font }).bytes))).toBe('áéfiaöfl x');
    expect(pdfTables.MAC_ROMAN.slice(0x80).every((c) => typeof c === 'string')).toBe(true);
    expect(pdfTables.glyphText('Ccedilla')).toBe('Ç');
    expect(pdfTables.glyphText('nothing-known')).toBe('');
  });

  it('reads a Type0 font through its ToUnicode CMap: bfchar, bfrange by start and by array', async () => {
    const cmap = [
      '/CIDInit /ProcSet findresource begin 12 dict begin begincmap',
      '1 begincodespacerange <0000> <FFFF> endcodespacerange',
      '2 beginbfchar <0001> <0048> <0002> <0069> endbfchar',
      '2 beginbfrange <0010> <0012> <0061> <0020> <0021> [<00C5> <00F6>] endbfrange',
      'endcmap end end',
    ].join('\n');
    const font = '<< /Type /Font /Subtype /Type0 /BaseFont /X /Encoding /Identity-H /ToUnicode 6 0 R >>';
    const outcome = await run(onePage('BT /F1 9 Tf <000100020010001100120020> Tj <0021> Tj ET', { font, extra: [stream('', cmap)] }).bytes);
    expect(textOf(outcome)).toBe('HiabcÅö');
  });

  it('a later CMap definition wins every code it names — a range over a range, a code over a range, and a range over a code', async () => {
    const map = await cmapOf(
      'begincmap',
      // An earlier, longer range and a later, shorter one inside it: codes the shorter one does
      // not reach still map through the longer one.
      '2 beginbfrange <0000> <00FF> <0041> <0010> <0012> <0061> endbfrange',
      // A range over a code written before it, and a code over a range written before it.
      '1 beginbfchar <0100> <005A> endbfchar',
      '2 beginbfrange <0100> <0101> <0030> <0200> <0202> <0030> endbfrange',
      '1 beginbfchar <0201> <0021> endbfchar',
      'endcmap',
    );
    expect([0x00, 0x0f, 0x10, 0x12, 0x13, 0x20, 0xff].map((c) => map.get(2, c))).toEqual(['A', 'P', 'a', 'c', 'T', 'a', String.fromCharCode(0x140)]);
    expect([0x100, 0x101, 0x200, 0x201, 0x202].map((c) => map.get(2, c))).toEqual(['0', '1', '0', '!', '2']);
  });

  it('however many definitions name a code, the last one written wins it — at, and past, what a code count once capped', async () => {
    // 131 072 definitions of one code, then one more: the later wins. A count of codes defined
    // used to stop at 131 072 and keep the earlier mapping (Codex #2075 r1).
    const repeated = Array.from({ length: 1_310 }, () => `100 beginbfchar ${'<0001> <0041> '.repeat(100)}endbfchar`);
    const many = await cmapOf('begincmap', ...repeated, '72 beginbfchar', '<0001> <0041> '.repeat(72), 'endbfchar', '1 beginbfchar <0001> <0042> endbfchar', 'endcmap');
    expect(many.get(2, 1)).toBe('B');
    // Two ranges of 65 536 codes fill that count exactly; a code over one of them still wins.
    const full = await cmapOf('begincmap', '2 beginbfrange <0000> <FFFF> <0041> <010000> <01FFFF> <0041> endbfrange', '1 beginbfchar <0007> <005A> endbfchar', 'endcmap');
    expect([full.get(2, 7), full.get(2, 8), full.get(3, 0x10007)]).toEqual(['Z', 'I', 'H']);
  });

  it('a CMap\'s map agrees, code for code, with its definitions applied in order', async () => {
    // A seeded generator: the same 300 CMaps on every run.
    let seed = 0x2075;
    const rand = (n: number): number => {
      seed = (seed * 1_103_515_245 + 12_345) >>> 0;
      return (seed >>> 8) % n;
    };
    const hex = (bytes: number[]) => `<${bytes.map((b) => b.toString(16).padStart(2, '0')).join('')}>`;
    const codeHex = (len: number, code: number) => hex(len === 1 ? [code] : [code >> 8, code & 0xff]);
    for (let round = 0; round < 300; round += 1) {
      const sections: string[] = [];
      // What the CMap means, written per code the way a writer reads it: each definition in turn.
      const expected = new Map<string, string>();
      // Every fourth CMap names a handful of codes over and over: many definitions of each.
      const crowded = round % 4 === 3;
      for (let d = crowded ? rand(60) + 20 : rand(12) + 1; d > 0; d -= 1) {
        const len = rand(2) + 1;
        const from = crowded ? rand(4) : rand(40);
        // Destinations of one to four bytes, their last byte near the top so a count carries.
        const dst = Array.from({ length: rand(4) + 1 }, () => (rand(2) ? 0xf0 + rand(16) : rand(256)));
        const kind = rand(3);
        if (kind === 0) {
          sections.push(`1 beginbfchar ${codeHex(len, from)} ${hex(dst)} endbfchar`);
          expected.set(`${len}:${from}`, utf16(dst));
        } else {
          const to = from + rand(30);
          if (kind === 1) {
            sections.push(`1 beginbfrange ${codeHex(len, from)} ${codeHex(len, to)} ${hex(dst)} endbfrange`);
            for (let c = from; c <= to; c += 1) {
              const b = [...dst];
              const last = b[b.length - 1]! + (c - from);
              b[b.length - 1] = last & 0xff;
              if (b.length >= 2 && last > 0xff) b[b.length - 2] = (b[b.length - 2]! + (last >> 8)) & 0xff;
              expected.set(`${len}:${c}`, utf16(b));
            }
          } else {
            const each = Array.from({ length: rand(to - from + 2) }, () => [rand(256), rand(256)]);
            sections.push(`1 beginbfrange ${codeHex(len, from)} ${codeHex(len, to)} [${each.map(hex).join(' ')}] endbfrange`);
            each.forEach((b, k) => {
              if (from + k <= to) expected.set(`${len}:${from + k}`, utf16(b));
            });
          }
        }
      }
      const map = await cmapOf('begincmap', ...sections, 'endcmap');
      for (const len of [1, 2]) {
        for (let code = 0; code < 80; code += 1) {
          expect(map.get(len, code), `round ${round}, ${len}-byte code ${code}: ${sections.join(' | ')}`).toBe(expected.get(`${len}:${code}`));
        }
      }
    }
  });

  it('gives nothing for a composite font with no ToUnicode — glyph ids are not text', async () => {
    const font = '<< /Type /Font /Subtype /Type0 /BaseFont /X /Encoding /Identity-H >>';
    expect(await run(onePage('BT /F1 9 Tf <00410042> Tj ET', { font }).bytes)).toEqual({ status: 'empty', extractor: 'pdf' });
  });

  it('decodes Flate, ASCIIHex, ASCII85, RunLength and LZW content — and a filter chain', async () => {
    const content = 'BT /F1 9 Tf (decoded wapiti) Tj ET';
    const hex = Array.from(bin(content), (b) => b.toString(16).padStart(2, '0')).join('') + '>';
    const a85 = ascii85(bin(content));
    const rl = cat(Uint8Array.of(content.length - 1), content, Uint8Array.of(128));
    const cases: [string, Uint8Array][] = [
      ['/Filter /FlateDecode', await deflate(bin(content))],
      ['/Filter /ASCIIHexDecode', bin(hex)],
      ['/Filter /ASCII85Decode', bin(a85)],
      ['/Filter /RunLengthDecode', rl],
      ['/Filter /LZWDecode', lzwEncode(bin(content))],
      ['/Filter [/ASCIIHexDecode /FlateDecode]', bin(Array.from(await deflate(bin(content)), (b) => b.toString(16).padStart(2, '0')).join('') + '>')],
    ];
    for (const [dict, data] of cases) {
      expect(textOf(await run(onePage(data, { contentDict: dict }).bytes)), dict).toBe('decoded wapiti');
    }
  });

  it('keeps what a damaged Flate stream inflated before the damage', async () => {
    const whole = await deflate(bin(`BT /F1 9 Tf (kept before the damage) Tj ${'0 0 Td '.repeat(4000)}(lost) Tj ET`));
    const cut = whole.subarray(0, Math.floor(whole.length * 0.6));
    expect(textOf(await run(onePage(cut, { contentDict: '/Filter /FlateDecode' }).bytes))).toContain('kept before the damage');
  });

  it('reads a cross-reference stream with a PNG predictor, and objects inside an object stream', async () => {
    const objs: string[] = [CATALOG, PAGES, PAGE, HELVETICA];
    const content = stream('', 'BT /F1 9 Tf (from the object stream) Tj ET');
    // Objects 1–4 live in object stream 6; 5 (the content) and 6 at file offsets; 7 is the xref stream.
    let header = '';
    let body = '';
    for (const [i, o] of objs.entries()) {
      header += `${i + 1} ${body.length} `;
      body += `${o}\n`;
    }
    const objstm = stream(`/Type /ObjStm /N 4 /First ${header.length}`, header + body);
    const head = bin('%PDF-1.7\n');
    const o5 = cat('5 0 obj\n', content, '\nendobj\n');
    const o6 = cat('6 0 obj\n', objstm, '\nendobj\n');
    const off5 = head.length;
    const off6 = off5 + o5.length;
    const off7 = off6 + o6.length;
    // /W [1 4 2], rows for objects 0–7, each PNG-filtered "Up" against the row before.
    const rows: number[][] = [
      [0, 0, 0, 0, 0, 0xff, 0xff],
      ...[0, 1, 2, 3].map((i) => [2, 0, 0, 0, 6, 0, i]),
      [1, ...u32(off5), 0, 0],
      [1, ...u32(off6), 0, 0],
      [1, ...u32(off7), 0, 0],
    ];
    const filtered: number[] = [];
    rows.forEach((row, r) => filtered.push(2, ...row.map((b, i) => (b - (r > 0 ? rows[r - 1]![i]! : 0)) & 0xff)));
    const xs = stream(
      '/Type /XRef /Size 8 /W [1 4 2] /Root 1 0 R /Filter /FlateDecode /DecodeParms << /Predictor 12 /Columns 7 >>',
      await deflate(Uint8Array.from(filtered)),
    );
    const file = cat(head, o5, o6, '7 0 obj\n', xs, `\nendobj\nstartxref\n${off7}\n%%EOF\n`);
    expect(textOf(await run(file))).toBe('from the object stream');
  });

  it('reads the NEWEST version of an object an incremental update replaced', async () => {
    const first = onePage('BT /F1 9 Tf (the original draft) Tj ET');
    const update = build(new Map([[5, stream('', 'BT /F1 9 Tf (the amended text) Tj ET')]]), {
      prefix: first.bytes,
      trailer: `/Prev ${first.xrefAt}`,
    });
    expect(textOf(await run(update.bytes))).toBe('the amended text');
  });

  it('falls back to scanning for objects when the cross-reference data points nowhere', async () => {
    const { bytes, xrefAt } = onePage('BT /F1 9 Tf (found by the scan) Tj ET');
    const broken = cat(bytes.subarray(0, xrefAt), 'trailer\n<< /Root 1 0 R >>\nstartxref\n999999\n%%EOF\n');
    expect(textOf(await run(broken))).toBe('found by the scan');
    // A table that READS but points the catalog at another object: what the table made of it
    // is forgotten before the scan, or the scan would be handed that miss again.
    const wrong = onePage('BT /F1 9 Tf (found past a wrong offset) Tj ET');
    const at1 = String(wrong.offsets.get(1)).padStart(10, '0');
    const at2 = String(wrong.offsets.get(2)).padStart(10, '0');
    const misdirected = bin(new TextDecoder('latin1').decode(wrong.bytes).replace(`${at1} 00000 n`, `${at2} 00000 n`));
    expect(textOf(await run(misdirected))).toBe('found past a wrong offset');
    // And with no trailer at all: the catalog is found among the objects.
    expect(textOf(await run(bytes.subarray(0, xrefAt)))).toBe('found by the scan');
  });

  it('draws form XObjects, skips inline image data, and reads a stream whose /Length is wrong', async () => {
    const page =
      '<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R >> /XObject << /X1 6 0 R >> >> /Contents 5 0 R >>';
    const form = stream('/Type /XObject /Subtype /Form /BBox [0 0 10 10]', 'BT /F1 9 Tf (inside the form) Tj ET');
    const content = cat('BT /F1 9 Tf (before) Tj ET\nBI /W 4 /H 1 /BPC 8 /CS /G ID ', '(no) Tj\xff', '\nEI\n/X1 Do\nBT /F1 9 Tf (after) Tj ET');
    const wrongLength = cat('<< /Length 3 >>\nstream\n', content, '\nendstream');
    const file = build([CATALOG, PAGES, page, HELVETICA, wrongLength, form]).bytes;
    expect(textOf(await run(file))).toBe('before\ninside the form\nafter');
  });

  it('refuses an encrypted file, saying so', async () => {
    const outcome = await run(onePage('BT /F1 9 Tf (secret) Tj ET', { trailer: '/Encrypt << /Filter /Standard /V 1 >>' }).bytes);
    expect(outcome).toEqual({ status: 'failed', extractor: 'pdf', detail: 'the PDF is encrypted, and encrypted PDFs are not read' });
  });

  it('stops collecting past twice the text cap and says the text was cut', async () => {
    const content = `BT /F1 9 Tf ${'(spoonbill sentence) Tj T* '.repeat(2000)}ET`;
    const outcome = await run(onePage(content).bytes, 1024);
    expect(outcome).toMatchObject({ status: 'indexed', truncated: true });
  });
});

describe('pdf: valid documents the budgets never cut — at the default bounds', () => {
  // The twin of the hostile files: each bound is sized so a real document reads whole. A file
  // here that came back truncated would be a bound charging what nothing holds.
  const whole = async (file: Uint8Array, words: string[]) => {
    const outcome = await run(file);
    expect(outcome).toMatchObject({ status: 'indexed', truncated: false });
    expect(textOf(outcome).split(/\s+/).filter(Boolean)).toEqual(words);
  };

  it('2 000 simple fonts on one page, each drawing its own word', async () => {
    const n = 2_000;
    const fonts = Array.from({ length: n }, (_, i) => `/F${i} ${i + 5} 0 R`).join(' ');
    const page = `<< /Type /Page /Parent 2 0 R /Resources << /Font << ${fonts} >> >> /Contents 4 0 R >>`;
    const content = Array.from({ length: n }, (_, i) => `BT /F${i} 9 Tf 0 ${-i} Td (w${i}) Tj ET`).join('\n');
    // Half of them re-encode a few codes, as subset fonts do.
    const font = (i: number) =>
      `<< /Type /Font /Subtype /Type1 /BaseFont /Sub${i} /Encoding ${i % 2 ? '/WinAnsiEncoding' : '<< /BaseEncoding /WinAnsiEncoding /Differences [65 /A /B /C] >>'} >>`;
    await whole(build([CATALOG, PAGES, page, stream('', content), ...Array.from({ length: n }, (_, i) => font(i))]).bytes, Array.from({ length: n }, (_, i) => `w${i}`));
  }, 30_000);

  it('1 000 pages sharing one resource dictionary and one font', async () => {
    const n = 1_000;
    // 1 catalog, 2 the page tree, 3… the pages, then the resources, the font and each page's content.
    const resources = n + 3;
    const kids = Array.from({ length: n }, (_, i) => `${i + 3} 0 R`).join(' ');
    const pages = Array.from({ length: n }, (_, i) => `<< /Type /Page /Parent 2 0 R /Resources ${resources} 0 R /Contents ${resources + 2 + i} 0 R >>`);
    const contents = Array.from({ length: n }, (_, i) => stream('', `BT /F1 9 Tf (page${i}) Tj ET`));
    const file = build([CATALOG, `<< /Type /Pages /Kids [${kids}] /Count ${n} >>`, ...pages, `<< /Font << /F1 ${resources + 1} 0 R >> >>`, HELVETICA, ...contents]).bytes;
    await whole(file, Array.from({ length: n }, (_, i) => `page${i}`));
  }, 30_000);

  it('a CJK font: a ToUnicode of 20 000 codes and a range, every code drawn', async () => {
    const n = 20_000;
    const code = (i: number) => (i + 1).toString(16).padStart(4, '0');
    const sections = Array.from({ length: n / 100 }, (_, k) =>
      `100 beginbfchar ${Array.from({ length: 100 }, (_, j) => `<${code(k * 100 + j)}> <${(0x4e00 + k * 100 + j).toString(16)}>`).join(' ')} endbfchar`);
    const cmap = `begincmap\n1 begincodespacerange <0000> <FFFF> endcodespacerange\n${sections.join('\n')}\n1 beginbfrange <F000> <F0FF> <3041> endbfrange\nendcmap`;
    const drawn = `<${Array.from({ length: n }, (_, i) => code(i)).join('')}> Tj <F000F001F002> Tj`;
    const built = onePage(`BT /F1 9 Tf ${drawn} ET`, {
      font: '<< /Type /Font /Subtype /Type0 /BaseFont /X /Encoding /Identity-H /ToUnicode 6 0 R >>',
      extra: [stream('', cmap)],
    }).bytes;
    const expected = String.fromCharCode(...Array.from({ length: n }, (_, i) => 0x4e00 + i)) + '\u3041\u3042\u3043';
    const outcome = await run(built);
    expect(outcome).toMatchObject({ status: 'indexed', truncated: false });
    expect(textOf(outcome).replace(/\s+/g, '')).toBe(expected);
  }, 30_000);

  it('a few pages of text among 24 MiB of images', async () => {
    // Images are drawn, never decoded: their bytes count against the file's size, not its memory.
    const image = (i: number) => stream(`/Type /XObject /Subtype /Image /Width 2048 /Height 1024 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode`, new Uint8Array(6 * MIB).fill(0x30 + i));
    const xobjects = Array.from({ length: 4 }, (_, i) => `/Im${i} ${i + 6} 0 R`).join(' ');
    const page = `<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R >> /XObject << ${xobjects} >> >> /Contents 5 0 R >>`;
    const content = Array.from({ length: 4 }, (_, i) => `q 400 0 0 200 0 ${i * 200} cm /Im${i} Do Q BT /F1 9 Tf (figure${i}) Tj ET`).join('\n');
    const file = build([CATALOG, PAGES, page, HELVETICA, stream('', content), ...Array.from({ length: 4 }, (_, i) => image(i))]).bytes;
    expect(file.length).toBeGreaterThan(24 * MIB);
    await whole(file, ['figure0', 'figure1', 'figure2', 'figure3']);
  }, 30_000);
});

describe('pdf: hostile files end failed or empty, promptly, and never throw', () => {
  it('a deflate bomb: one stream decoding past the per-stream bound fails the file', async () => {
    const bomb = await deflate(new Uint8Array(PDF_STREAM_MAX + 1024));
    expect(bomb.length).toBeLessThan(64 * 1024);
    const outcome = await settles(onePage(bomb, { contentDict: '/Filter /FlateDecode' }).bytes);
    expect(outcome).toEqual({ status: 'failed', extractor: 'pdf', detail: 'a PDF stream decodes past the extraction bound' });
  });

  it('a bomb split across streams: the total budget ends the reading — empty, never more decoded', async () => {
    const piece = await deflate(new Uint8Array(PDF_STREAM_MAX - 1024));
    const page = '<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R >> >> /Contents [5 0 R 6 0 R 7 0 R] >>';
    const file = build([CATALOG, PAGES, page, HELVETICA, ...[0, 1, 2].map(() => stream('/Filter /FlateDecode', piece))]).bytes;
    expect(await settles(file)).toEqual({ status: 'empty', extractor: 'pdf' });
  });

  it('an UNFILTERED stream is held to both decoded budgets, at the limit and one byte past it', async () => {
    // Content of exactly `size` bytes: the text first, then strings, then spaces to the byte.
    const sized = (size: number): string => {
      let content = 'BT /F1 9 Tf (raw head) Tj ET\n';
      const block = `(${'x'.repeat(200_000)}) z\n`;
      while (content.length + block.length <= size - 1_000) content += block;
      return content + ' '.repeat(size - content.length);
    };
    expect(textOf(await run(onePage(sized(PDF_STREAM_MAX)).bytes))).toBe('raw head');
    expect(await run(onePage(sized(PDF_STREAM_MAX + 1)).bytes)).toEqual({
      status: 'failed',
      extractor: 'pdf',
      detail: 'a PDF stream decodes past the extraction bound',
    });
    // The file-wide budget: at it the text is whole; one byte past, it is read up to the budget.
    const small = pdfExtractor({ ...DEFAULT_EXTRACTOR_BOUNDS, maxInflatedBytes: 4096 });
    const runSmall = (body: Uint8Array) =>
      runAttachmentExtractor(small, { body, contentType: 'application/pdf', filename: 'f.pdf' }, DEFAULT_ATTACHMENT_TEXT_BOUNDS);
    const head = 'BT /F1 9 Tf (raw head) Tj ET\n';
    const page = (size: number) => onePage(head + ' '.repeat(size - head.length)).bytes;
    expect(await runSmall(page(4096))).toMatchObject({ status: 'indexed', text: 'raw head', truncated: false });
    expect(await runSmall(page(4097))).toMatchObject({ status: 'indexed', text: 'raw head', truncated: true });
  });

  it('a predictor whose declared rows are huge allocates and walks nothing past the data — and paces inside a wide row', async () => {
    const huge = new Map<string, unknown>([['Predictor', 12], ['Columns', 1 << 20], ['Colors', 32], ['BitsPerComponent', 16]]);
    // 64 MiB rows declared, a few bytes of data: nothing decoded, charged or allocated.
    const pace = counting();
    const before = process.memoryUsage().arrayBuffers;
    expect(await pdfDecoders.unpredict(new Uint8Array(1000), huge as never, pace)).toHaveLength(0);
    expect(process.memoryUsage().arrayBuffers - before).toBeLessThan(1024 * 1024);
    expect(pace.charged).toBe(0);
    // The file: a tiny Flate stream with those parameters settles at once, empty.
    const tiny = onePage(await deflate(new Uint8Array(10)), {
      contentDict: '/Filter /FlateDecode /DecodeParms << /Predictor 12 /Columns 1048576 /Colors 32 /BitsPerComponent 16 >>',
    });
    expect(tiny.bytes.length).toBeLessThan(1024);
    expect(await settles(tiny.bytes, 200)).toEqual({ status: 'empty', extractor: 'pdf' });
    // Two real 4 MiB rows: the work INSIDE a row is cut to strides, so it yields (and could be
    // aborted) every stride, not once per row.
    const wide = new Map<string, unknown>([['Predictor', 12], ['Columns', 1 << 20], ['Colors', 4]]);
    const rowPace = counting();
    const rows = new Uint8Array(2 * (4 * 1024 * 1024 + 1)).fill(2);
    expect(await pdfDecoders.unpredict(rows, wide as never, rowPace)).toHaveLength(8 * 1024 * 1024);
    expect(rowPace.turns).toBeGreaterThanOrEqual(30);
  });

  it('every byte-at-a-time decoder stops as the budget is spent — it never materialises its output first', async () => {
    const BUDGET = 1024;
    const content = new Uint8Array(1024 * 1024).fill(0x41);
    const hex = bin(`${'41'.repeat(content.length)}>`); // the content's bytes, 0x41 each
    // Each would decode a MiB; each input is a MiB or more of work if read to the end.
    const cases: [string, (pace: Pace, budget: { remaining: number }) => Promise<{ data: Uint8Array; exhausted: boolean }>][] = [
      ['ASCIIHex', (pace, budget) => pdfDecoders.asciiHex(hex, budget, pace)],
      ['ASCII85', (pace, budget) => pdfDecoders.ascii85(bin(ascii85(content)), budget, pace)],
      ['RunLength', (pace, budget) => pdfDecoders.runLength(cat(...Array.from({ length: 8192 }, () => Uint8Array.of(129, 0x41))), budget, pace)],
      ['LZW', (pace, budget) => pdfDecoders.lzw(lzwEncode(content), true, budget, pace)],
    ];
    for (const [name, decode] of cases) {
      const pace = counting();
      const budget = { remaining: BUDGET };
      const decoded = await decode(pace, budget);
      expect(decoded, name).toMatchObject({ exhausted: true });
      expect(decoded.data.length, name).toBe(BUDGET);
      // The work done is one budget's worth, give or take one run or entry — never the MiB.
      expect(pace.charged, name).toBeLessThan(3 * BUDGET);
    }
  });

  it('the object scan never walks back over a digit run longer than a header — the timer is never held', async () => {
    // No xref, so the scan reads the file: an 8 MiB digit run ends at `obj`. It is not a header,
    // and reading back over it whole held the thread 433 ms (Codex #2062 r2).
    const file = cat('%PDF-1.7\n', '9'.repeat(8 * 1024 * 1024), ' 0 obj\n<< >>\nendobj\n');
    expect(await longestHold(file)).toBeLessThan(150);
    expect((await settles(file)).status).toBe('failed');
    // The twin: a header of ordinary width is still found by the scan.
    const { bytes, xrefAt } = onePage('BT /F1 9 Tf (scanned header) Tj ET');
    expect(textOf(await run(bytes.subarray(0, xrefAt)))).toBe('scanned header');
  });

  it('a CMap with twenty thousand code-space ranges places each code by a bounded search — the timer is never held', async () => {
    // 20 001 ranges and 5 000 codes ran `spaces.some` per code: about a second, timer starved
    // (Codex #2062 r2). The twin: the one range that matters still maps.
    const ranges = Array.from({ length: 20_001 }, (_, i) =>
      `1 begincodespacerange <${(i * 3 + 16).toString(16).padStart(4, '0')}> <${(i * 3 + 17).toString(16).padStart(4, '0')}> endcodespacerange`);
    const cmap = `begincmap\n1 begincodespacerange <0000> <0001> endcodespacerange\n${ranges.join('\n')}\n1 beginbfchar <0001> <0041> endbfchar endcmap`;
    const file = onePage(`BT /F1 9 Tf <${'0001'.repeat(5_000)}> Tj ET`, {
      font: '<< /Type /Font /Subtype /Type0 /BaseFont /X /Encoding /Identity-H /ToUnicode 6 0 R >>',
      extra: [stream('', cmap)],
    }).bytes;
    expect(await longestHold(file)).toBeLessThan(150);
    expect(textOf(await settles(file))).toBe('A'.repeat(5_000));
  });

  it('the lexer reads at most a token\'s bound of any comment, however long its line', () => {
    // A comment ran to its line's end before the bound was checked: 32 MiB read for nothing.
    const pace = counting();
    const comment = new Uint8Array(32 * 1024 * 1024).fill(0x63);
    comment[0] = 0x25; // `%`
    expect(() => pdfLexer(comment, pace).next()).toThrow(/longer than the extraction reads/);
    expect(pace.charged).toBeLessThan(EXTRACTION_STRIDE + 16);
  });

  it('a step of a tiny-step loop costs at least CALL_COST, so a stride holds a bounded number of steps', async () => {
    // Counted, not timed: a one-byte token, and a find that matches at once, each charge the floor.
    const tokens = counting();
    const lex = pdfLexer(bin('q '.repeat(10_000)), tokens);
    for (let i = 0; i < 10_000; i += 1) lex.next();
    expect(tokens.charged).toBeGreaterThanOrEqual(10_000 * CALL_COST);
    const finds = counting();
    const dashes = '-'.repeat(20_000);
    for (let p = 0, i = 0; i < 10_000; i += 1) p = (await finds.find(dashes, '--', p)) + 1;
    expect(finds.charged).toBeGreaterThanOrEqual(10_000 * CALL_COST);
  });

  it('a page that names one stream four hundred times joins nothing past the memory bound', async () => {
    // 96 references to a 1 MiB stream held ~100 MiB of ArrayBuffers before any budget looked
    // (Codex #2062 r3): the join was sized by the references, not by what was decoded.
    const page = `<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R >> >> /Contents [${'5 0 R '.repeat(400)}] >>`;
    const file = build([CATALOG, PAGES, page, HELVETICA, stream('', `BT /F1 9 Tf (once) Tj ET ${' '.repeat(MIB)}`)]).bytes;
    expect(file.length).toBeLessThan(2 * MIB);
    expect(await peakMemory(file)).toBeLessThan(96 * MIB);
    expect(await run(file)).toMatchObject({ status: 'empty' });
  });

  it('a CMap range is held as one entry, its destinations computed on lookup — never a string per code', async () => {
    // Two permitted ranges of 65 536 codes onto 512-byte destinations: a string per code grew
    // the heap by ~500 MiB from a 1.5 KiB file (Codex #2062 r3). The twin: codes still map.
    const base = `0041${'0020'.repeat(255)}`; // 'A' and 255 spaces: 512 bytes
    const cmap = `begincmap 1 begincodespacerange <0000> <FFFF> endcodespacerange 2 beginbfrange <0000> <FFFF> <${base}> <0100> <01FF> <${base}> endbfrange endcmap`;
    const file = cmapFont(cmap, '00000002');
    expect(file.length).toBeLessThan(4 * 1024);
    expect(await peakMemory(file)).toBeLessThan(32 * MIB);
    // Code 0 maps to the base ('A', then spaces); code 2 counts its last unit up by two ('"').
    expect(textOf(await run(file))).toBe('A A "');
  });

  it('one object parsed under 2 000 numbers is kept at most as often as the memory bound allows', async () => {
    // An array of 100 K numbers: the value whose memory per byte read is the worst, against
    // what a parsed object is charged. Uncharged, all 2 000 copies were parsed and kept. The
    // bound is the peak, not the clock: parsing to the budget is ~5 M tokens, which takes time.
    const file = sharedObject(`[${'1 '.repeat(100 * 1024)}]`);
    expect(await peakMemory(file)).toBeLessThan(PEAK_MIB * MIB);
    expect(await run(file)).toMatchObject({ status: 'empty' });
  }, 30_000);

  it('a CMap that defines one code past the memory budget ends the reading there, truncated', async () => {
    const retained = new Retained(DEFAULT_EXTRACTOR_BOUNDS.maxInflatedBytes * PDF_RETAINED_FACTOR + PDF_RETAINED_BASE);
    const out = await pdfExtract(await cmapFlood(5_800), DEFAULT_EXTRACTOR_BOUNDS.maxInflatedBytes, 512 * 1024, { aborted: false }, retained);
    expect(out.truncated).toBe(true);
    // Spent: no more than one definition's charge was left when the next one was refused.
    expect(retained.limit - retained.bytes).toBeLessThan(1024);
  }, 30_000);

  it('the same code defined 250 000 times inside the budget: read whole, and the last definition wins', async () => {
    const outcome = await run(await cmapFlood(2_500));
    expect(outcome).toMatchObject({ status: 'indexed', truncated: false });
    expect(textOf(outcome)).toBe('B');
  }, 30_000);

  it('sealing a CMap charges every heap step, however many definitions open at one code — counted, not timed', async () => {
    // One code named 250 000 times opens every definition at a single boundary; 250 000 codes
    // written descending open one each. Parsing and ordering cost the same; the difference is
    // the heap, which a charge per boundary (Codex #2075 r2) did not see at all.
    const n = 250_000;
    const sealed = async (code: (i: number) => number) => {
      const lines = Array.from({ length: n / 100 }, (_, k) =>
        `100 beginbfchar ${Array.from({ length: 100 }, (_, j) => `<${code(k * 100 + j).toString(16).padStart(6, '0')}> <0041>`).join(' ')} endbfchar`);
      const pace = counting();
      await pdfCMap(bin(`begincmap\n${lines.join('\n')}\nendcmap`), pace, new Retained(1 << 30));
      return pace.charged;
    };
    const crowded = await sealed(() => 1);
    const apart = await sealed((i) => 0xffffff - i);
    // A heap of up to n: at least 16 levels for most of the pushes.
    expect(crowded - apart).toBeGreaterThan((n / 2) * 16 * CALL_COST);
  }, 30_000);

  it('a string drawn through a CMap is charged a lookup per byte, so a long one is decoded a window at a time — counted, not timed', async () => {
    // Each byte is a code placed and mapped by binary searches; a token-long string of them,
    // charged as a byte scan, held the thread ~15–30 ms through a large CMap (Codex #2075 r2).
    const cmap = `begincmap 1 begincodespacerange <0000> <FFFF> endcodespacerange 1 beginbfrange <0000> <FFFF> <0041> endbfrange endcmap`;
    const charged = async (codes: number) => {
      const pace = counting();
      const file = cmapFont(cmap, '0001'.repeat(codes));
      const out = await pdfExtract(file, DEFAULT_EXTRACTOR_BOUNDS.maxInflatedBytes, 512 * 1024, { aborted: false }, undefined, pace);
      expect(out.text.trim()).toBe('B'.repeat(codes));
      return pace;
    };
    const short = await charged(1);
    const long = await charged(50_000);
    // 100 000 bytes more drawn, each decoded as a lookup (the lexing of their hex comes on top).
    expect(long.charged - short.charged).toBeGreaterThanOrEqual(100_000 * 32);
    expect(long.turns - short.turns).toBeGreaterThanOrEqual(10);
  });

  it('a string decoded a window at a time reads exactly as one pass — codes of one to four bytes, every edge mid-code', async () => {
    const cmap = [
      'begincmap',
      '4 begincodespacerange <00> <7F> <8000> <8FFF> <900000> <90FFFF> <A0000000> <A0FFFFFF> endcodespacerange',
      '4 beginbfchar <41> <0061> <8001> <0062> <900002> <0063> <A0000003> <0064> endbfchar',
      'endcmap',
    ].join('\n');
    // Adjacent 1- and 2-byte codes, and each length beside each other: windows of one to five
    // bytes put an edge at every offset inside every code.
    const file = cmapFont(cmap, '41' + '8001' + '900002' + 'A0000003' + '41' + '41' + '8001' + '4141' + 'A0000003' + '900002');
    for (const width of [0, 1, 2, 3, 4, 5]) {
      const pace = width ? new NarrowPace(width) : counting();
      const out = await pdfExtract(file, DEFAULT_EXTRACTOR_BOUNDS.maxInflatedBytes, 512 * 1024, { aborted: false }, undefined, pace);
      expect(out.text.trim(), `windows of ${width || 'a stride'}`).toBe('abcdaabaadc');
    }
  });

  it('a long string in a font it cannot read gives nothing, and the text around it still reads — in windows or in one', async () => {
    const page = '<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R /F2 6 0 R >> >> /Contents 5 0 R >>';
    const file = onePage(`BT /F1 9 Tf (before) Tj /F2 9 Tf <${'0102'.repeat(20_000)}> Tj /F1 9 Tf (after) Tj ET`, {
      page,
      extra: ['<< /Type /Font /Subtype /Type0 /BaseFont /X /Encoding /Identity-H >>'],
    }).bytes;
    for (const pace of [counting(), new NarrowPace(1), new NarrowPace(3)]) {
      const out = await pdfExtract(file, DEFAULT_EXTRACTOR_BOUNDS.maxInflatedBytes, 512 * 1024, { aborted: false }, undefined, pace);
      expect(out.text.trim()).toBe('beforeafter');
    }
  });

  it('decoded in windows of any width, a string reads as it does in one pass — over random mixes of code spaces', async () => {
    let seed = 0x1575;
    const rand = (n: number): number => {
      seed = (seed * 1_103_515_245 + 12_345) >>> 0;
      return (seed >>> 8) % n;
    };
    const hex = (bytes: number[]) => bytes.map((b) => b.toString(16).padStart(2, '0')).join('');
    for (let round = 0; round < 120; round += 1) {
      // One to four ranges, each of one to four bytes, sharing first bytes so lengths compete.
      const spaces = Array.from({ length: rand(4) + 1 }, () => {
        const len = rand(4) + 1;
        const first = 0x80 + rand(4);
        const lo = [first, ...Array.from({ length: len - 1 }, () => 0)];
        const hi = [first, ...Array.from({ length: len - 1 }, () => 0xff)];
        return { len, lo, hi };
      });
      const code = (sp: { len: number; lo: number[] }) => [sp.lo[0]!, ...Array.from({ length: sp.len - 1 }, () => rand(4))];
      const mapped = Array.from({ length: 12 }, () => code(spaces[rand(spaces.length)]!));
      const cmap = [
        'begincmap',
        `${spaces.length} begincodespacerange ${spaces.map((sp) => `<${hex(sp.lo)}> <${hex(sp.hi)}>`).join(' ')} endcodespacerange`,
        `${mapped.length} beginbfchar ${mapped.map((c, i) => `<${hex(c)}> <${(0x61 + i).toString(16).padStart(4, '0')}>`).join(' ')} endbfchar`,
        'endcmap',
      ].join('\n');
      // Mapped codes, codes in a space with no mapping, and bytes in no space at all.
      const drawn = Array.from({ length: rand(40) + 1 }, () => {
        const pick = rand(3);
        return pick === 0 ? mapped[rand(mapped.length)]! : pick === 1 ? code(spaces[rand(spaces.length)]!) : [rand(256)];
      }).flat();
      const file = cmapFont(cmap, hex(drawn));
      const once = await pdfExtract(file, DEFAULT_EXTRACTOR_BOUNDS.maxInflatedBytes, 512 * 1024, { aborted: false }, undefined, counting());
      for (const width of [1, 2, 3, 5, 7]) {
        const windowed = await pdfExtract(file, DEFAULT_EXTRACTOR_BOUNDS.maxInflatedBytes, 512 * 1024, { aborted: false }, undefined, new NarrowPace(width));
        expect(windowed.text, `round ${round}, windows of ${width}: <${hex(drawn)}>`).toBe(once.text);
      }
    }
  }, 30_000);

  it('sealing charges every push, every end and every pop — the whole account, exactly', async () => {
    // One code defined n times: n pushes into a growing heap at its first code, then n ends and
    // n pops from a shrinking one at the code past it. Every step of the sweep is in this sum,
    // so leaving out the end charge, or a pop's, is a different number.
    const n = 1_000;
    const map = pdfCodeMap(new Retained(1 << 30));
    for (let i = 0; i < n; i += 1) map.setChar(2, 1, 'A');
    const pace = counting();
    await map.seal(pace);
    const levels = (size: number) => 32 - Math.clz32(size + 1); // a sift through a heap of `size`
    let pushes = 0;
    let pops = 0;
    for (let size = 0; size < n; size += 1) pushes += levels(size);
    for (let size = n; size > 0; size -= 1) pops += levels(size);
    const passes = Math.ceil(Math.log2(n));
    const account = {
      ordered: 1, // the first pair is out of order: one check
      orders: 2 * n * passes, // two stable merge sorts, every element moved each pass
      boundaries: 2, // the code, and the code past it
      pushes,
      ends: n,
      pops,
    };
    expect(pace.charged).toBe(CALL_COST * Object.values(account).reduce((a, b) => a + b, 0));
    expect(map.get(2, 1)).toBe('A');
  });

  it('what the reader keeps is charged to the memory budget — counted, not timed', async () => {
    const charged = async (body: Uint8Array) => {
      const retained = new Retained(1 << 30);
      await pdfExtract(body, DEFAULT_EXTRACTOR_BOUNDS.maxInflatedBytes, 512 * 1024, { aborted: false }, retained);
      return retained.bytes;
    };
    const baseline = await charged(onePage('BT /F1 9 Tf (x) Tj ET').bytes);
    // A cached stream: its decoded bytes.
    expect(await charged(onePage(`BT /F1 9 Tf (x) Tj ET${' '.repeat(MIB)}`).bytes) - baseline).toBeGreaterThanOrEqual(MIB);
    // Cross-reference entries: a fixed cost each, however little they point at.
    const many = build(Array.from({ length: 2_000 }, (_, i) => (i === 0 ? CATALOG : i === 1 ? PAGES : i === 2 ? PAGE : i === 3 ? HELVETICA : i === 4 ? stream('', 'BT /F1 9 Tf (x) Tj ET') : 'null'))).bytes;
    expect(await charged(many) - baseline).toBeGreaterThanOrEqual(1_995 * 64);
    // Fonts: each one used holds a decoder — and a ToUnicode several fonts share is parsed once.
    const fonts = (n: number) => {
      const names = Array.from({ length: n }, (_, i) => `/F${i} ${i + 7} 0 R`).join(' ');
      const page = `<< /Type /Page /Parent 2 0 R /Resources << /Font << ${names} >> >> /Contents 5 0 R >>`;
      const content = Array.from({ length: n }, (_, i) => `BT /F${i} 9 Tf <0001> Tj ET`).join('\n');
      const cmap = `begincmap ${Array.from({ length: 50 }, (_, k) => `100 beginbfchar ${Array.from({ length: 100 }, (_, j) => `<${(k * 100 + j).toString(16).padStart(4, '0')}> <0041>`).join(' ')} endbfchar`).join(' ')} endcmap`;
      const font = '<< /Type /Font /Subtype /Type0 /BaseFont /X /Encoding /Identity-H /ToUnicode 6 0 R >>';
      return build([CATALOG, PAGES, page, HELVETICA, stream('', content), stream('', cmap), ...Array.from({ length: n }, () => font)]).bytes;
    };
    const one = await charged(fonts(1));
    const forty = await charged(fonts(40));
    // A decoder per font, charged what a composite decoder holds; and the 5 000-code CMap (over
    // 300 KiB of definitions and segments) once, not 40 times — a font's own objects aside.
    expect(forty - one).toBeGreaterThanOrEqual(39 * pdfFontCosts.composite);
    expect(forty - one).toBeLessThan(39 * (pdfFontCosts.composite + 2 * 1024));
    // A simple font: its table and closure, and each /Differences entry it adds.
    const simple = (differences: string) =>
      onePage('BT /F1 9 Tf (x) Tj ET', { font: `<< /Type /Font /Subtype /Type1 /BaseFont /X /Encoding << /Differences [${differences}] >> >>` }).bytes;
    const plain = await charged(simple(''));
    const named = await charged(simple(`32 ${'/a '.repeat(100)}`));
    expect(named - plain).toBeGreaterThanOrEqual(100 * pdfFontCosts.difference);
    const second = onePage('BT /F1 9 Tf (x) Tj /F2 9 Tf (y) Tj ET', {
      page: '<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R /F2 6 0 R >> >> /Contents 5 0 R >>',
      extra: [HELVETICA],
    }).bytes;
    expect(await charged(second) - baseline).toBeGreaterThanOrEqual(pdfFontCosts.simple);
  });

  it('a cross-reference chain that loops — on itself, through a second section, and through /XRefStm', async () => {
    // A fixed-width placeholder, so pointing it somewhere moves no byte offset in the file.
    const PLACEHOLDER = '/Prev 0000000000';
    const point = (bytes: Uint8Array, key: string, at: number) =>
      bin(new TextDecoder('latin1').decode(bytes).replace(PLACEHOLDER, `${key} ${String(at).padStart(PLACEHOLDER.length - key.length - 1, '0')}`));
    const looped = { status: 'failed', extractor: 'pdf', detail: 'the PDF cross-reference chain loops' };
    const one = onePage('BT /F1 9 Tf (never reached) Tj ET', { trailer: PLACEHOLDER });
    expect(await settles(point(one.bytes, '/Prev', one.xrefAt))).toEqual(looped);
    expect(await settles(point(one.bytes, '/XRefStm', one.xrefAt))).toEqual(looped);
    // A → B → A: the update's section names the first, and the first names the update.
    const first = onePage('BT /F1 9 Tf (a) Tj ET', { trailer: PLACEHOLDER });
    const second = build(new Map([[6, '<< >>']]), { prefix: first.bytes, trailer: `/Prev ${first.xrefAt}` });
    expect(await settles(point(second.bytes, '/Prev', second.xrefAt))).toEqual(looped);
  });

  it('a chain longer than the section bound', async () => {
    let file = onePage('BT /F1 9 Tf (deep) Tj ET');
    for (let i = 0; i < PDF_XREF_SECTIONS + 1; i += 1) {
      file = build(new Map([[6 + i, '<< >>']]), { prefix: file.bytes, trailer: `/Prev ${file.xrefAt}` });
    }
    expect(await settles(file.bytes)).toEqual({
      status: 'failed',
      extractor: 'pdf',
      detail: `the PDF has more than ${PDF_XREF_SECTIONS} cross-reference sections`,
    });
  });

  it('a huge object count — a classic subsection and a stream /Index — is refused before any is read', async () => {
    const { bytes, xrefAt } = onePage('BT /F1 9 Tf (x) Tj ET');
    const huge = cat(bytes.subarray(0, xrefAt), `xref\n0 1000000000\n0000000000 65535 f \ntrailer\n<< /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`);
    const refused = { status: 'failed', extractor: 'pdf', detail: `the PDF declares more than ${PDF_OBJECTS_MAX} objects` };
    expect(await settles(huge)).toEqual(refused);
    const xs = stream('/Type /XRef /Size 1000000000 /Index [0 1000000000] /W [1 4 2] /Root 1 0 R', new Uint8Array(70));
    const viaStream = cat(bytes.subarray(0, xrefAt), '9 0 obj\n', xs, `\nendobj\nstartxref\n${xrefAt}\n%%EOF\n`);
    expect(await settles(viaStream)).toEqual(refused);
  });

  it('nesting too deep — in the catalog it fails the file; in a page it costs only that page', async () => {
    const deep = `${'['.repeat(100_000)}${']'.repeat(100_000)}`;
    const inCatalog = build([`<< /Type /Catalog /Pages 2 0 R /Deep ${'['.repeat(200)}${']'.repeat(200)} >>`, PAGES, PAGE, HELVETICA, stream('', 'BT /F1 9 Tf (x) Tj ET')]);
    expect((await settles(inCatalog.bytes)).status).toBe('failed');
    const inPage = onePage(`BT /F1 9 Tf ${deep} (unreached) Tj ET`);
    expect(await settles(inPage.bytes)).toEqual({ status: 'empty', extractor: 'pdf' });
  });

  it('a page tree that loops fails; one that fans out without end stops at the node bound', async () => {
    const loop = build([CATALOG, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Pages /Kids [2 0 R] /Count 1 >>', HELVETICA]);
    expect(await settles(loop.bytes)).toEqual({ status: 'failed', extractor: 'pdf', detail: 'the PDF page tree loops' });
    // 100 × 100 × 100 leaves through shared nodes: a million pages from eight objects. One leaf
    // in a hundred draws text and the rest draw nothing, so the text stays far under the output
    // cap: only the node bound can end this walk early.
    const kids = (n: number) => `[${`${n} 0 R `.repeat(100)}]`;
    const fan = build([
      CATALOG,
      `<< /Type /Pages /Kids ${kids(6)} >>`,
      PAGE,
      HELVETICA,
      stream('', 'BT /F1 9 Tf (fanned) Tj ET'),
      `<< /Type /Pages /Kids ${kids(7)} >>`,
      `<< /Type /Pages /Kids [3 0 R ${'8 0 R '.repeat(99)}] >>`,
      '<< /Type /Page /Parent 2 0 R >>',
    ]);
    expect(await settles(fan.bytes, 20_000)).toMatchObject({ status: 'indexed', truncated: true });
  });

  it('a form that draws itself, and forms that fan out, are bounded', async () => {
    const page = (x: string) =>
      `<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R >> /XObject << ${x} >> >> /Contents 5 0 R >>`;
    const selfDrawing = build([CATALOG, PAGES, page('/X1 6 0 R'), HELVETICA, stream('', '/X1 Do'),
      stream('/Subtype /Form /Resources << /XObject << /X1 6 0 R >> /Font << /F1 4 0 R >> >>', 'BT /F1 9 Tf (once) Tj ET /X1 Do')]);
    expect(textOf(await settles(selfDrawing.bytes))).toBe('once');
    // Each form draws the next twice: 2^PDF_FORM_DEPTH_MAX draws at most, then the depth bound.
    const forms = Array.from({ length: 12 }, (_, i) =>
      stream(`/Subtype /Form /Resources << /XObject << /N ${7 + i} 0 R >> /Font << /F1 4 0 R >> >>`, 'BT /F1 9 Tf (f) Tj ET /N Do /N Do'));
    const fanned = build([CATALOG, PAGES, page('/N 6 0 R'), HELVETICA, stream('', '/N Do'), ...forms]);
    expect((await settles(fanned.bytes)).status).toBe('indexed');
  });

  it('a stream whose /Length names itself, and object streams that nest', async () => {
    const page = '<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>';
    const selfLength = build([CATALOG, PAGES, page, HELVETICA, cat('<< /Length 5 0 R >>\nstream\n', 'BT /F1 9 Tf (self length) Tj ET', '\nendstream')]);
    expect(textOf(await settles(selfLength.bytes))).toBe('self length');
    // Object 1 in object stream 6, which the cross-reference says is itself in object stream 1.
    const head = bin('%PDF-1.7\n');
    const rows = [
      [0, 0, 0, 0, 0, 0xff, 0xff],
      [2, 0, 0, 0, 6, 0, 0],
      [0, 0, 0, 0, 0, 0, 0],
      [0, 0, 0, 0, 0, 0, 0],
      [0, 0, 0, 0, 0, 0, 0],
      [0, 0, 0, 0, 0, 0, 0],
      [2, 0, 0, 0, 1, 0, 0],
      [1, ...u32(head.length), 0, 0],
    ];
    const xs = stream('/Type /XRef /Size 8 /W [1 4 2] /Root 1 0 R', Uint8Array.from(rows.flat()));
    const nested = cat(head, '7 0 obj\n', xs, `\nendobj\nstartxref\n${head.length}\n%%EOF\n`);
    expect(await settles(nested)).toEqual({ status: 'failed', extractor: 'pdf', detail: 'the PDF nests object streams' });
  });

  it('a token longer than the lexer reads: failed in the structure, an empty page in content', async () => {
    const long = `(${'x'.repeat(300 * 1024)})`;
    expect((await settles(build([`<< /Type /Catalog /Pages 2 0 R /Long ${long} >>`, PAGES, PAGE, HELVETICA, stream('', '')]).bytes)).status).toBe('failed');
    expect(await settles(onePage(`BT /F1 9 Tf ${long} Tj ET`).bytes)).toEqual({ status: 'empty', extractor: 'pdf' });
  });

  it('a long digit run that ends in a letter — the token shape that made a regular expression quadratic — stays linear, and abortable', async () => {
    // 60 000 digits then `x` held the thread 3.3 s through the old number pattern, past any abort.
    const shape = onePage(`BT /F1 9 Tf ${'1'.repeat(60_000)}x (after) Tj ET`).bytes;
    const t0 = cpuMs();
    expect(textOf(await run(shape))).toBe('after');
    expect(cpuMs() - t0).toBeLessThan(500);
    expectStoppedPromptly(await abortedMidway(shape));
  });

  it('a run near the token bound, of every token class, settles promptly and aborts within a stride', async () => {
    const near = 250 * 1024;
    const runs: [string, string][] = [
      ['digits ending in a letter', `${'7'.repeat(near)}q`],
      ['a signed decimal with a second dot', `-${'1'.repeat(near / 2)}.${'2'.repeat(near / 2 - 8)}.3`],
      ['signs', '+-'.repeat(near / 2)],
      ['a keyword', 'k'.repeat(near)],
      ['a name with escapes', `/${'#41a'.repeat(near / 4)}`],
      ['a literal string', `(${'\\(s'.repeat(near / 4)})`],
      ['a hex string', `<${'4a'.repeat(near / 2)}>`],
      ['a comment', `%${'c'.repeat(near)}\n`],
      ['whitespace', ' '.repeat(near)],
    ];
    for (const [label, token] of runs) {
      const file = onePage(`BT /F1 9 Tf ${token} (after) Tj ET`).bytes;
      const t0 = cpuMs();
      const outcome = await run(file);
      expect(['indexed', 'empty'], label).toContain(outcome.status);
      expect(cpuMs() - t0, label).toBeLessThan(1_000);
      expectStoppedPromptly(await abortedMidway(file), label);
    }
  });

  it('a truncated file, cut anywhere, settles', async () => {
    const { bytes } = onePage(await deflate(bin('BT /F1 9 Tf (the whole sentence) Tj ET')), { contentDict: '/Filter /FlateDecode' });
    for (let cut = 0; cut < bytes.length; cut += 7) {
      const outcome = await settles(bytes.subarray(0, cut));
      expect(['indexed', 'empty', 'failed'], `cut at ${cut}`).toContain(outcome.status);
    }
  });

  it('fuzz: a thousand mutated files — a real producer\'s and built ones — each settle without a throw', async () => {
    const seeds = [
      new Uint8Array(readFileSync(new URL('./fixtures/quartz-macroman.pdf', import.meta.url))),
      onePage(await deflate(bin('BT /F1 9 Tf [(fuzz)-300(seed)] TJ ET')), { contentDict: '/Filter /FlateDecode' }).bytes,
    ];
    let state = 0x2545f491;
    const rand = (n: number): number => {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      return (state >>> 0) % n;
    };
    for (let i = 0; i < 1000; i += 1) {
      const body = Uint8Array.from(seeds[i % seeds.length]!);
      for (let k = 0, n = 1 + rand(8); k < n; k += 1) {
        const at = rand(body.length);
        body[at] = rand(4) === 0 ? '()<>[]/%'.charCodeAt(rand(8)) : rand(256);
      }
      const t0 = cpuMs();
      const outcome = await run(rand(5) === 0 ? body.subarray(0, rand(body.length)) : body);
      expect(['indexed', 'empty', 'failed'], `mutation ${i}`).toContain(outcome.status);
      expect(cpuMs() - t0, `mutation ${i}`).toBeLessThan(2_000);
    }
  }, 120_000);

  it('aborted mid-parse on a large valid file, it answers within a stride', async () => {
    const content = `BT /F1 9 Tf ${'(a long valid line of prose) Tj T* '.repeat(200_000)}ET`;
    const file = onePage(await deflate(bin(content)), { contentDict: '/Filter /FlateDecode' }).bytes;
    const after = await abortedMidway(file, 20);
    expect(after.answer).toEqual({ failed: 'the extraction was aborted' });
    expectStoppedPromptly(after);
  });
});

// -- the abort-latency harness -------------------------------------------------------------
//
// The rule every parser here is held to: every loop over a file's bytes either runs through
// `Pace` or is bounded by a named constant. A loop that breaks it shows up as one thing — the
// thread held — so this table runs each adversarial shape under a short abort timer and asserts
// the timer fires on time, the extractor answers promptly once aborted, and the shape settles
// within a budget when left alone — never holding the thread longer than a stride's work for
// the whole of it. A new shape is one line in the table.

// The rows that bound the thread being HELD are CPU time (`cpuMs`), because holding the thread
// is spending CPU on it without a turn — and CPU time, unlike the wall clock, is not stretched
// by other processes starving this one. What an extraction does once ABORTED is counted
// (`afterAbort`), not timed at all: the work it charges and the turns it takes (#2085).

/** The most CPU spent between two turns of the loop, start to finish: a stride's work, with room. */
const HOLD_MS = 150;
/** The most CPU spent before a 5 ms abort timer gets its turn. */
const TIMER_SLACK_MS = 150;
/** The work an aborted extraction may still charge: at most the rest of the stride it was in. */
const ABORTED_UNITS = EXTRACTION_STRIDE;
/**
 * The loop turns an aborted extraction may take to answer: it answers at its next checkpoint,
 * and a timer's abort lands only at one, so none today — two allow a checkpoint's own yield.
 */
const ABORTED_TURNS = 2;
/** The most CPU a shape may spend settling, unaborted. */
const SETTLE_MS = 3_000;
/**
 * The most memory a shape may hold at its peak, over a collected baseline: the extraction's
 * `Retained` bound (36 MiB at the defaults), a decoding stream's transient copies (a few
 * `PDF_STREAM_MAX`), and the garbage a young generation holds between collections.
 */
const PEAK_MIB = 128;

const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

interface Shape {
  readonly name: string;
  readonly extractor: AttachmentExtractor;
  readonly contentType: string;
  readonly body: () => Promise<Uint8Array> | Uint8Array;
}

const P = pdf;
const pdfShape = (name: string, body: () => Promise<Uint8Array> | Uint8Array): Shape => ({ name, extractor: P, contentType: 'application/pdf', body });
const pageWith = (content: string) => onePage(content).bytes;
/** A Type0 font whose ToUnicode CMap is `cmap`, drawing `codes` (hex) on the page. */
const cmapFont = (cmap: string, codes: string) =>
  onePage(`BT /F1 9 Tf <${codes}> Tj ET`, {
    font: '<< /Type /Font /Subtype /Type0 /BaseFont /X /Encoding /Identity-H /ToUnicode 6 0 R >>',
    extra: [stream('', cmap)],
  }).bytes;

const SHAPES: readonly Shape[] = [
  // Round 2's blockers.
  pdfShape('scan fallback: an 8 MiB digit run before `obj`, no xref', () => cat('%PDF-1.7\n', '9'.repeat(8 * MIB), ' 0 obj\n<< >>\nendobj\n')),
  pdfShape('cmap: 20 001 code-space ranges, 5 000 codes drawn', () =>
    cmapFont(
      `begincmap\n${Array.from({ length: 20_001 }, (_, i) => `1 begincodespacerange <${(i * 3).toString(16).padStart(4, '0')}> <${(i * 3 + 1).toString(16).padStart(4, '0')}> endcodespacerange`).join('\n')}\n1 beginbfchar <0001> <0041> endbfchar endcmap`,
      '0001'.repeat(5_000),
    )),
  // Round 1's blocker, and its class: a run near the token bound of every token class.
  pdfShape('a digit run ending in a letter', () => pageWith(`${'1'.repeat(60_000)}x`)),
  // A loop of tiny steps: each token a byte, each step's fixed cost charged (`CALL_COST`).
  pdfShape('3 M one-byte tokens', () => pageWith('q '.repeat(3 * MIB))),
  pdfShape('a keyword at the token bound', () => pageWith('k'.repeat(250 * 1024))),
  pdfShape('a name with escapes at the token bound', () => pageWith(`/${'#41a'.repeat(60_000)}`)),
  pdfShape('a literal string at the token bound', () => pageWith(`(${'\\(s'.repeat(80_000)})`)),
  pdfShape('a hex string at the token bound', () => pageWith(`<${'4a'.repeat(125_000)}>`)),
  // The loops round 2's audit bounded.
  pdfShape('a 7 MiB comment in content', () => pageWith(`%${'c'.repeat(7 * MIB)}\n`)),
  pdfShape('a dictionary of 4 M non-name keys', () =>
    build([`<< /Type /Catalog /Pages 2 0 R /D << ${'1 '.repeat(4 * MIB)}>> >>`, PAGES, PAGE, HELVETICA, stream('', '')]).bytes),
  pdfShape('8 MiB of whitespace after a declared stream end', () =>
    build([CATALOG, PAGES, PAGE, HELVETICA, cat('<< /Length 2 >>\nstream\nET', ' '.repeat(8 * MIB), '\nendstream')]).bytes),
  pdfShape('a bfrange of 65 536 codes onto a 96 KiB destination', () =>
    cmapFont(`begincmap 1 beginbfrange <0000> <FFFF> <${'00'.repeat(96 * 1024)}> endbfrange endcmap`, '0001')),
  pdfShape('an LZW stream expanding a byte into a dictionary entry', () =>
    onePage(lzwEncode(new Uint8Array(MIB)), { contentDict: '/Filter /LZWDecode' }).bytes),
  // Round 1's should-fixes, and the bounds before them.
  pdfShape('an 8 MiB unfiltered stream', () => pageWith(' '.repeat(8 * MIB))),
  pdfShape('a predictor declaring 64 MiB rows', async () =>
    onePage(await deflate(new Uint8Array(10)), {
      contentDict: '/Filter /FlateDecode /DecodeParms << /Predictor 12 /Columns 1048576 /Colors 32 /BitsPerComponent 16 >>',
    }).bytes),
  pdfShape('a 16 MiB ASCIIHex stream', () => onePage(bin(`${'41'.repeat(8 * MIB)}>`), { contentDict: '/Filter /ASCIIHexDecode' }).bytes),
  pdfShape('a deflate bomb', async () => onePage(await deflate(new Uint8Array(PDF_STREAM_MAX + 1024)), { contentDict: '/Filter /FlateDecode' }).bytes),
  pdfShape('nesting 4 M deep in content', () => pageWith('['.repeat(4 * MIB))),
  pdfShape('an inline image with no end, 8 MiB', () => pageWith(`BI /W 1 ID ${'E'.repeat(8 * MIB)}`)),
  pdfShape('a billion declared objects', () => {
    const { bytes, xrefAt } = onePage('BT ET');
    return cat(bytes.subarray(0, xrefAt), `xref\n0 1000000000\ntrailer\n<< /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`);
  }),
  // Memory: allocations that grow with references, not with bytes (#2062 r3).
  pdfShape('a page naming one 1 MiB stream 400 times', () =>
    build([CATALOG, PAGES,
      `<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R >> >> /Contents [${'5 0 R '.repeat(400)}] >>`,
      HELVETICA, stream('', ' '.repeat(MIB))]).bytes),
  pdfShape('a CMap mapping 131 072 codes onto 512-byte destinations', () =>
    cmapFont(`begincmap 2 beginbfrange <0000> <FFFF> <${'0041'.repeat(256)}> <0100> <01FF> <${'0041'.repeat(256)}> endbfrange endcmap`, '0001')),
  // A string: as many bytes kept per parse as a dense array, at a fraction of the lexing. The
  // array, whose memory per byte is the worst, is held to the peak in its own test above.
  pdfShape('one 200 KiB string parsed under 2 000 numbers', () => sharedObject(`(${'x'.repeat(200 * 1024)})`)),
  pdfShape('a CMap of 131 072 single codes written in descending order, each resolved against the rest', () => {
    // Out of order, so the definitions are swept into segments rather than taken as written.
    const sections = Array.from({ length: 1_311 }, (_, k) =>
      `100 beginbfchar ${Array.from({ length: 100 }, (_, j) => `<${(0x1_ffff - k * 100 - j).toString(16).padStart(6, '0')}> <0041>`).join(' ')} endbfchar`);
    return cmapFont(`begincmap\n1 begincodespacerange <000000> <FFFFFF> endcodespacerange\n${sections.join('\n')}\nendcmap`, '01ffff');
  }),
  // 580 000 definitions in under 8 MiB decoded: the budget, not a count, ends them as they are parsed.
  pdfShape('a CMap defining one code until the memory budget is spent', () => cmapFlood(5_800)),
  // 250 000, inside the budget: they all reach `seal`, which opens every one at a single boundary.
  pdfShape('a CMap defining one code 250 000 times, inside the memory budget', () => cmapFlood(2_500)),
  pdfShape('500 fonts sharing one ToUnicode of 30 000 codes', () => {
    const chars = Array.from({ length: 300 }, (_, k) =>
      `100 beginbfchar ${Array.from({ length: 100 }, (_, j) => `<${(k * 100 + j).toString(16).padStart(4, '0')}> <00410042>`).join(' ')} endbfchar`).join('\n');
    const fonts = Array.from({ length: 500 }, (_, i) => `/F${i} ${i + 7} 0 R`).join(' ');
    const page = `<< /Type /Page /Parent 2 0 R /Resources << /Font << ${fonts} >> >> /Contents 5 0 R >>`;
    const content = Array.from({ length: 500 }, (_, i) => `BT /F${i} 9 Tf <0001> Tj ET`).join('\n');
    const font = '<< /Type /Font /Subtype /Type0 /BaseFont /X /Encoding /Identity-H /ToUnicode 6 0 R >>';
    return build([CATALOG, PAGES, page, HELVETICA, stream('', content), stream('', `begincmap\n${chars}\nendcmap`), ...Array.from({ length: 500 }, () => font)]).bytes;
  }),
  pdfShape('a form drawn 50 000 times', () =>
    build([CATALOG, PAGES,
      '<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R >> /XObject << /X 6 0 R >> >> /Contents 5 0 R >>',
      HELVETICA, stream('', '/X Do '.repeat(50_000)),
      stream('/Subtype /Form /Resources << /Font << /F1 4 0 R >> >>', `BT /F1 9 Tf (form) Tj ET ${' '.repeat(64 * 1024)}`)]).bytes),
  pdfShape('a million pages through shared page-tree nodes', () => {
    const kids = (n: number) => `[${`${n} 0 R `.repeat(100)}]`;
    return build([CATALOG, `<< /Type /Pages /Kids ${kids(6)} >>`, PAGE, HELVETICA, stream('', 'BT /F1 9 Tf (fanned) Tj ET'),
      `<< /Type /Pages /Kids ${kids(7)} >>`, `<< /Type /Pages /Kids ${kids(3)} >>`]).bytes;
  }),
  // The other parsers, for the same rule.
  { name: 'html: a 16 MiB unclosed comment', extractor: htmlExtractor(), contentType: 'text/html', body: () => enc(`<p>x</p><!--${'-'.repeat(16 * MIB)}`) },
  { name: 'html: 2 M unclosed tags', extractor: htmlExtractor(), contentType: 'text/html', body: () => enc('<a '.repeat(2 * MIB)) },
  { name: 'text: 32 MiB of one line', extractor: textExtractor(), contentType: 'text/plain', body: () => new Uint8Array(32 * MIB).fill(0x61) },
  { name: 'docx: 20 000 central-directory entries', extractor: docxExtractor(), contentType: DOCX, body: () =>
    zip([{ name: 'word/document.xml', data: enc('<w:t>x</w:t>') }, ...Array.from({ length: 19_999 }, (_, i) => ({ name: `p/${i}`, data: new Uint8Array(0), method: 0 }))]) },
  { name: 'docx: a part inflating past the budget', extractor: docxExtractor(), contentType: DOCX, body: () =>
    zip([{ name: 'word/document.xml', data: new Uint8Array(17 * MIB).fill(0x20) }]) },
  { name: 'docx: one 8 MiB unclosed tag', extractor: docxExtractor(), contentType: DOCX, body: () =>
    zip([{ name: 'word/document.xml', data: enc(`<w:t ${'a'.repeat(8 * MIB)}`) }]) },
];

describe('the abort-latency harness: no shape holds the thread, aborted or not', () => {
  it.each(SHAPES.map((shape) => [shape.name, shape] as const))('%s', async (_name, shape) => {
    const body = await shape.body();
    const extract = (signal: { aborted: boolean }) =>
      shape.extractor.extract({ body, contentType: shape.contentType, filename: 'f', maxTextBytes: 512 * 1024, signal: signal as ExtractionSignal });

    // Aborted by a timer a few ms in: the timer must get its turn, and the answer come promptly.
    let firedAtCpu = 0;
    const startedCpu = cpuMs();
    const aborted = await afterAbort(extract, () => new Promise<void>((resolve) => setTimeout(() => ((firedAtCpu = cpuMs()), resolve()), 5)));
    expect(firedAtCpu - startedCpu, 'the abort timer was held').toBeLessThan(TIMER_SLACK_MS);
    expectStoppedPromptly(aborted);

    // Left alone, it settles within budget with an answer, never a throw, and never holds the
    // thread longer than a stride's work at any point along the way.
    const t0 = cpuMs();
    const outcome = await extract({ aborted: false });
    expect(cpuMs() - t0, 'the shape did not settle in time').toBeLessThan(SETTLE_MS);
    expect('text' in outcome || 'failed' in outcome).toBe(true);
    expect(await longestHold(body, shape.extractor, shape.contentType), 'the thread was held').toBeLessThan(HOLD_MS);
    // And never holds more memory than the bound allows, at its peak.
    expect(await peakMemory(body, shape.extractor, shape.contentType), 'memory held at the peak').toBeLessThan(PEAK_MIB * MIB);
  }, 30_000);
});

/** A PDF extraction aborted mid-way — `afterMs` in, on a timer's turn — and what it did after. */
const abortedMidway = (body: Uint8Array, afterMs = 0) =>
  afterAbort(
    (signal) => pdf.extract({ body, contentType: 'application/pdf', filename: 'f.pdf', maxTextBytes: 1 << 30, signal: signal as ExtractionSignal }),
    () => new Promise((resolve) => setTimeout(resolve, afterMs)),
  );

/** It stopped within the stride it was in, and answered at its next checkpoint. */
function expectStoppedPromptly(after: { units: number; turns: number }, label?: string): void {
  expect(after.units, label ?? 'work done after the abort').toBeLessThanOrEqual(ABORTED_UNITS);
  expect(after.turns, label ?? 'turns taken to answer after the abort').toBeLessThanOrEqual(ABORTED_TURNS);
}

/**
 * The longest the thread was held while `body` was extracted: the widest gap between ticks of a
 * 1 ms interval running beside it, start to finish — not only the first few milliseconds.
 */
async function longestHold(body: Uint8Array, extractor: AttachmentExtractor = pdf, contentType = 'application/pdf'): Promise<number> {
  let last = cpuMs();
  let worst = 0;
  const tick = setInterval(() => {
    const now = cpuMs();
    worst = Math.max(worst, now - last);
    last = now;
  }, 1);
  try {
    await extractor.extract({ body, contentType, filename: 'f', maxTextBytes: 1 << 30, signal: { aborted: false } });
  } finally {
    clearInterval(tick);
  }
  return Math.max(worst, cpuMs() - last);
}

/**
 * Milliseconds of CPU this thread has spent. Starvation by other processes stretches the wall
 * clock but not this, so a bound on it is a bound on the work done, at any load (#2085).
 */
function cpuMs(): number {
  const { user, system } = process.threadCpuUsage();
  return (user + system) / 1000;
}

/**
 * What an extraction does once its signal is aborted, counted rather than timed (#2085): the
 * units of work it charges to its `Pace` after the abort, and the turns of the event loop it
 * takes to answer. Work bounds what a parser does after it should have stopped; turns bound
 * how long it may sit idle — awaiting a timer, say — before it notices. Neither moves with the
 * machine's load, where an elapsed time measures both and the scheduler besides.
 */
async function afterAbort(
  extract: (signal: { aborted: boolean }) => Promise<unknown>,
  abortWhen: () => Promise<void>,
): Promise<{ answer: unknown; units: number; turns: number }> {
  const charge = vi.spyOn(Pace.prototype, 'charge');
  try {
    const signal = { aborted: false };
    const extracting = extract(signal);
    await abortWhen();
    signal.aborted = true;
    const from = charge.mock.calls.length;
    let turns = 0;
    let answered = false;
    const spin = () => setImmediate(() => answered || ((turns += 1), spin()));
    spin();
    const answer = await extracting;
    answered = true;
    return { answer, units: charge.mock.calls.slice(from).reduce((n, [units]) => n + units, 0), turns };
  } finally {
    charge.mockRestore();
  }
}

// A collector to call, so a peak is measured from a settled heap rather than from garbage.
setFlagsFromString('--expose-gc');
const collect = runInNewContext('gc') as () => void;

/**
 * The most memory held while `body` was extracted, over a collected baseline: heap plus
 * external (ArrayBuffers), sampled every millisecond beside the extraction, start to finish.
 */
async function peakMemory(body: Uint8Array, extractor: AttachmentExtractor = pdf, contentType = 'application/pdf'): Promise<number> {
  const held = () => {
    const m = process.memoryUsage();
    return m.heapUsed + m.external;
  };
  collect();
  const base = held();
  let peak = base;
  const tick = setInterval(() => {
    peak = Math.max(peak, held());
  }, 1);
  try {
    await extractor.extract({ body, contentType, filename: 'f', maxTextBytes: 512 * 1024, signal: { aborted: false } });
    peak = Math.max(peak, held());
  } finally {
    clearInterval(tick);
  }
  return peak - base;
}

/**
 * An object stream whose header names 2 000 object numbers at the same offset, and a page tree
 * whose kids are those numbers: `value`'s bytes, parsed and kept once per number.
 */
function sharedObject(value: string): Uint8Array {
  const nums = Array.from({ length: 2_000 }, (_, i) => i + 10);
  const header = nums.map((n) => `${n} 0`).join(' ') + ' ';
  const objstm = stream(`/Type /ObjStm /N ${nums.length} /First ${header.length}`, header + value);
  const kids = `[${nums.map((n) => `${n} 0 R`).join(' ')}]`;
  const head = bin('%PDF-1.7\n');
  const o1 = cat('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');
  const o2 = cat(`2 0 obj\n<< /Type /Pages /Kids ${kids} >>\nendobj\n`);
  const o3 = cat('3 0 obj\n', objstm, '\nendobj\n');
  const offs = [head.length, head.length + o1.length, head.length + o1.length + o2.length];
  const xrefAt = offs[2]! + o3.length;
  // Objects 10…2009 live in object stream 3: a cross-reference stream says so.
  const rows: number[] = [];
  for (let n = 0; n < 2_010; n += 1) {
    if (n === 0) rows.push(0, 0, 0, 0, 0, 0xff, 0xff);
    else if (n <= 3) rows.push(1, ...u32(offs[n - 1]!), 0, 0);
    else if (n < 10) rows.push(0, 0, 0, 0, 0, 0, 0);
    else rows.push(2, 0, 0, 0, 3, (n - 10) >> 8, (n - 10) & 0xff);
  }
  const xs = stream('/Type /XRef /Size 2010 /W [1 4 2] /Root 1 0 R', Uint8Array.from(rows));
  return cat(head, o1, o2, o3, '4 0 obj\n', xs, `\nendobj\nstartxref\n${xrefAt}\n%%EOF\n`);
}

/** A CMap's code → text map, parsed from its lines. */
async function cmapOf(...lines: string[]): Promise<{ get(length: number, code: number): string | undefined }> {
  return (await pdfCMap(bin(lines.join('\n')), counting(), new Retained(1 << 30))).map;
}

/** Bytes as UTF-16BE text, an odd last byte on its own — the way a CMap destination reads. */
function utf16(b: number[]): string {
  let s = '';
  for (let i = 0; i + 1 < b.length; i += 2) s += String.fromCharCode((b[i]! << 8) | b[i + 1]!);
  if (b.length % 2 === 1) s += String.fromCharCode(b[b.length - 1]!);
  return s;
}

/**
 * A Type0 font whose ToUnicode names code 1 `sections` × 100 times as `A`, then once more as
 * `B`, drawing code 1: a Flate stream, so the CMap's size is not the file's.
 */
async function cmapFlood(sections: number): Promise<Uint8Array> {
  const section = `100 beginbfchar ${'<0001> <0041> '.repeat(100)}endbfchar\n`;
  const cmap = enc(`begincmap\n${section.repeat(sections)}1 beginbfchar <0001> <0042> endbfchar\nendcmap`);
  return onePage('BT /F1 9 Tf <0001> Tj ET', {
    font: '<< /Type /Font /Subtype /Type0 /BaseFont /X /Encoding /Identity-H /ToUnicode 6 0 R >>',
    extra: [stream('/Filter /FlateDecode', await deflate(cmap))],
  }).bytes;
}

/** Big-endian 4 bytes. */
function u32(n: number): number[] {
  return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
}

/** ASCII85, as a writer encodes it, with the `~>` end. */
function ascii85(data: Uint8Array): string {
  let out = '';
  for (let i = 0; i < data.length; i += 4) {
    const chunk = [0, 1, 2, 3].map((k) => data[i + k] ?? 0);
    let v = ((chunk[0]! << 24) | (chunk[1]! << 16) | (chunk[2]! << 8) | chunk[3]!) >>> 0;
    const digits: string[] = [];
    for (let k = 0; k < 5; k += 1) {
      digits.unshift(String.fromCharCode((v % 85) + 33));
      v = Math.floor(v / 85);
    }
    out += digits.slice(0, Math.min(5, data.length - i + 1)).join('');
  }
  return `${out}~>`;
}

/** LZW as PDF writes it: 9–12-bit codes, a clear code first, early change. */
function lzwEncode(data: Uint8Array): Uint8Array {
  const out: number[] = [];
  let acc = 0;
  let bits = 0;
  let width = 9;
  const put = (code: number) => {
    acc = (acc << width) | code;
    bits += width;
    while (bits >= 8) {
      out.push((acc >> (bits - 8)) & 0xff);
      bits -= 8;
      acc &= (1 << bits) - 1;
    }
  };
  // The dictionary as a trie — (prefix code, next byte) → code — so a long run of one byte,
  // whose entries grow to a thousand bytes, costs a lookup per byte rather than a string each.
  const dict = new Map<number, number>();
  let next = 258;
  put(256);
  let w = -1;
  for (const b of data) {
    if (w < 0) {
      w = b;
      continue;
    }
    const found = dict.get(w * 256 + b);
    if (found !== undefined) {
      w = found;
      continue;
    }
    put(w);
    dict.set(w * 256 + b, next++);
    if (next + 1 >= 1 << width && width < 12) width += 1;
    w = b;
  }
  if (w >= 0) put(w);
  put(257);
  if (bits > 0) out.push((acc << (8 - bits)) & 0xff);
  return Uint8Array.from(out);
}
