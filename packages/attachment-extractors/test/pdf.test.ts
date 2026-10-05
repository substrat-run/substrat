import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ATTACHMENT_TEXT_BOUNDS,
  runAttachmentExtractor,
  type ExtractionOutcome,
  type ExtractionSignal,
} from '@substrat-run/kernel';
import { DEFAULT_EXTRACTOR_BOUNDS, PDF_OBJECTS_MAX, PDF_STREAM_MAX, PDF_XREF_SECTIONS, pdfExtractor, pdfTables } from '../src/index.js';
import { pdfDecoders } from '../src/pdf.js';
import { Pace } from '../src/shared.js';

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

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
/** Bytes 0–255 as written, for content that is not UTF-8. */
const bin = (s: string): Uint8Array => Uint8Array.from(s, (c) => c.charCodeAt(0));
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

/** Whatever the file, the answer is an outcome, and it comes promptly. */
async function settles(body: Uint8Array, withinMs = 5_000): Promise<ExtractionOutcome> {
  const t0 = performance.now();
  const outcome = await run(body);
  expect(performance.now() - t0).toBeLessThan(withinMs);
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
    const t0 = performance.now();
    expect(textOf(await run(shape))).toBe('after');
    expect(performance.now() - t0).toBeLessThan(500);
    expect(await abortLatency(shape)).toBeLessThan(100);
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
      const t0 = performance.now();
      const outcome = await run(file);
      expect(['indexed', 'empty'], label).toContain(outcome.status);
      expect(performance.now() - t0, label).toBeLessThan(1_000);
      expect(await abortLatency(file), label).toBeLessThan(100);
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
      const t0 = performance.now();
      const outcome = await run(rand(5) === 0 ? body.subarray(0, rand(body.length)) : body);
      expect(['indexed', 'empty', 'failed'], `mutation ${i}`).toContain(outcome.status);
      expect(performance.now() - t0, `mutation ${i}`).toBeLessThan(2_000);
    }
  }, 120_000);

  it('aborted mid-parse on a large valid file, it answers within a stride', async () => {
    const content = `BT /F1 9 Tf ${'(a long valid line of prose) Tj T* '.repeat(200_000)}ET`;
    const file = onePage(await deflate(bin(content)), { contentDict: '/Filter /FlateDecode' }).bytes;
    const signal: { aborted: boolean } = { aborted: false };
    const extracting = pdf.extract({ body: file, contentType: 'application/pdf', filename: 'f.pdf', maxTextBytes: 1 << 30, signal: signal as ExtractionSignal });
    await new Promise((resolve) => setTimeout(resolve, 20));
    signal.aborted = true;
    const t0 = performance.now();
    expect(await extracting).toEqual({ failed: 'the extraction was aborted' });
    expect(performance.now() - t0).toBeLessThan(250);
  });
});

/**
 * How long an extraction takes to answer once its signal is aborted mid-way: started, aborted
 * on the next timer turn, timed from the abort.
 */
async function abortLatency(body: Uint8Array): Promise<number> {
  const signal: { aborted: boolean } = { aborted: false };
  const extracting = pdf.extract({ body, contentType: 'application/pdf', filename: 'f.pdf', maxTextBytes: 1 << 30, signal: signal as ExtractionSignal });
  await new Promise((resolve) => setTimeout(resolve, 0));
  signal.aborted = true;
  const t0 = performance.now();
  await extracting;
  return performance.now() - t0;
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
  const dict = new Map<string, number>();
  for (let i = 0; i < 256; i += 1) dict.set(String.fromCharCode(i), i);
  let next = 258;
  put(256);
  let w = '';
  for (const b of data) {
    const wc = w + String.fromCharCode(b);
    if (dict.has(wc)) {
      w = wc;
      continue;
    }
    put(dict.get(w)!);
    dict.set(wc, next++);
    if (next + 1 >= 1 << width && width < 12) width += 1;
    w = String.fromCharCode(b);
  }
  if (w) put(dict.get(w)!);
  put(257);
  if (bits > 0) out.push((acc << (8 - bits)) & 0xff);
  return Uint8Array.from(out);
}
