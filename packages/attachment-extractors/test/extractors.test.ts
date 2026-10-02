import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ATTACHMENT_TEXT_BOUNDS,
  assertAttachmentExtractors,
  chooseAttachmentExtractor,
  runAttachmentExtractor,
  type ExtractionOutcome,
} from '@substrat-run/kernel';
import { DEFAULT_EXTRACTOR_BOUNDS, defaultAttachmentExtractors, type ExtractorBounds } from '../src/index.js';

/**
 * The parsers, each through the kernel's own enforcement (`runAttachmentExtractor`) — so an
 * outcome here is exactly what a host would record for the file.
 */
type Bounds = Partial<ExtractorBounds> & { maxTextBytes?: number };
const ex = async (contentType: string, body: Uint8Array, bounds: Bounds = {}): Promise<ExtractionOutcome> => {
  const { maxTextBytes, ...parsing } = bounds;
  const extractor = chooseAttachmentExtractor(
    defaultAttachmentExtractors({ ...DEFAULT_EXTRACTOR_BOUNDS, ...parsing }),
    contentType,
    'f',
  );
  if (!extractor) throw new Error(`no extractor accepts '${contentType}'`);
  return runAttachmentExtractor(
    extractor,
    { body, contentType, filename: 'f' },
    { ...DEFAULT_ATTACHMENT_TEXT_BOUNDS, ...(maxTextBytes === undefined ? {} : { maxTextBytes }) },
  );
};

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const PPTX = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';

// -- a minimal zip writer, for archives no producer would write ----------------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
const crc32 = (data: Uint8Array): number => {
  let c = 0xffffffff;
  for (const b of data) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

async function deflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

interface Part {
  name: string;
  data: Uint8Array;
  /** 0 = stored, 8 = deflate (default), anything else is written as-is. */
  method?: number;
  /** Override what the headers DECLARE the inflated size to be — a bomb lies here. */
  declaredSize?: number;
  /** Replace the compressed bytes outright (corrupt data). */
  raw?: Uint8Array;
  flags?: number;
}

async function zip(parts: Part[]): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const p of parts) {
    const method = p.method ?? 8;
    const body = p.raw ?? (method === 8 ? await deflateRaw(p.data) : p.data);
    const name = enc(p.name);
    const size = p.declaredSize ?? p.data.length;
    const crc = crc32(p.data);
    const local = new Uint8Array(30 + name.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, p.flags ?? 0, true);
    lv.setUint16(8, method, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, body.length, true);
    lv.setUint32(22, size, true);
    lv.setUint16(26, name.length, true);
    local.set(name, 30);
    const cd = new Uint8Array(46 + name.length);
    const cv = new DataView(cd.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, p.flags ?? 0, true);
    cv.setUint16(10, method, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, body.length, true);
    cv.setUint32(24, size, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true);
    cd.set(name, 46);
    chunks.push(local, body);
    central.push(cd);
    offset += local.length + body.length;
  }
  const cdSize = central.reduce((n, c) => n + c.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, parts.length, true);
  ev.setUint16(10, parts.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, offset, true);
  const all = [...chunks, ...central, eocd];
  const out = new Uint8Array(all.reduce((n, c) => n + c.length, 0));
  let o = 0;
  for (const c of all) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

const docxXml = (body: string) =>
  `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="w"><w:body>${body}</w:body></w:document>`;
const docxOf = async (body: string, extra: Part[] = []) =>
  zip([{ name: '[Content_Types].xml', data: enc('<Types/>') }, { name: 'word/document.xml', data: enc(docxXml(body)) }, ...extra]);
const indexedText = (o: ExtractionOutcome): string => {
  if (o.status !== 'indexed') throw new Error(`expected indexed, got ${JSON.stringify(o)}`);
  return o.text;
};

// -- routing ---------------------------------------------------------------------------

describe('which extractor reads a file', () => {
  const nameFor = (contentType: string, filename: string) =>
    chooseAttachmentExtractor(defaultAttachmentExtractors(), contentType, filename)?.name ?? null;

  it('routes by the declared type, parameters and case ignored', () => {
    expect(nameFor('text/plain; charset=UTF-8', 'a.bin')).toBe('text');
    expect(nameFor('TEXT/CSV', 'a')).toBe('text');
    expect(nameFor('text/markdown', 'a')).toBe('text');
    expect(nameFor('text/html', 'a')).toBe('html');
    expect(nameFor('application/xhtml+xml', 'a')).toBe('html');
    expect(nameFor(DOCX, 'a')).toBe('docx');
    expect(nameFor(XLSX, 'a')).toBe('xlsx');
    expect(nameFor(PPTX, 'a')).toBe('pptx');
  });

  it('reads the extension only when the type says nothing — never against a specific type', () => {
    expect(nameFor('application/octet-stream', 'Brief.DOCX')).toBe('docx');
    expect(nameFor('', 'notes.md')).toBe('text');
    expect(nameFor('', 'page.htm')).toBe('html');
    expect(nameFor('image/png', 'looks-like.txt')).toBeNull();
    expect(nameFor('application/octet-stream', 'blob.bin')).toBeNull();
  });

  it('has no extractor for a PDF, an image or a legacy office file — the kernel records those unsupported', () => {
    expect(nameFor('application/pdf', 'a.pdf')).toBeNull();
    expect(nameFor('image/jpeg', 'a.jpg')).toBeNull();
    expect(nameFor('application/msword', 'a.doc')).toBeNull();
  });

  it('declares each input bound to the kernel, under names a host can record', () => {
    const list = defaultAttachmentExtractors({ maxInputBytes: 1234, maxInflatedBytes: 1 });
    expect(list.map((e) => [e.name, e.maxInputBytes])).toEqual([
      ['text', 1234],
      ['html', 1234],
      ['docx', 1234],
      ['xlsx', 1234],
      ['pptx', 1234],
    ]);
    expect(() => assertAttachmentExtractors(list)).not.toThrow();
  });
});

// -- text and html ------------------------------------------------------------------------

describe('text and html', () => {
  it('decodes a declared charset, a UTF-16 BOM, and falls back to UTF-8 on an unknown label', async () => {
    expect(indexedText(await ex('text/plain; charset=iso-8859-1', new Uint8Array([0x63, 0x61, 0x66, 0xe9])))).toBe('café');
    expect(indexedText(await ex('text/plain', new Uint8Array([0xff, 0xfe, 0x68, 0x00, 0x69, 0x00])))).toBe('hi');
    expect(indexedText(await ex('text/plain; charset=no-such-label', enc('räksmörgås')))).toBe('räksmörgås');
  });

  it('normalizes: CRLF, runs of blanks, control characters, three or more newlines', async () => {
    const text = indexedText(await ex('text/plain', enc('a\r\n\r\n\r\n\r\nb\t\t c\u0000d\u0007')));
    expect(text).toBe('a\n\nb cd');
  });

  it('records a file with only whitespace as empty, not as indexed', async () => {
    expect(await ex('text/plain', enc(' \n\t '))).toEqual({ status: 'empty', extractor: 'text' });
  });

  it('strips markup, drops script and style bodies, decodes entities, keeps blocks apart', async () => {
    const html =
      '<html><head><style>p{x:1}</style><script>let s = "<p>scripted</p>";</script></head>' +
      '<body><!-- comment --><p>one&nbsp;&amp;&#32;two</p><p>caf&eacute; &#xE4;r &unknownentity;</p>' +
      '<table><tr><td>cell</td><td>next</td></tr></table></body></html>';
    const text = indexedText(await ex('text/html', enc(html)));
    expect(text).not.toMatch(/scripted|x:1|comment/);
    expect(text).toContain('one & two');
    expect(text).toContain('café är &unknownentity;');
    expect(text).toContain('cell next');
    expect(text.split('\n')).toContain('one & two');
  });

  it('drops an UNCLOSED script, style or comment through to the end — even one cut off inside its tag', async () => {
    const html = (s: string) => ex('text/html', enc(s));
    expect(indexedText(await html('<p>visible words</p><script>var leaked = "scriptsource";'))).toBe('visible words');
    expect(indexedText(await html('<p>kept</p><STYLE type="text/css">.x { content: "stylesource" }'))).toBe('kept');
    expect(indexedText(await html('<p>kept</p><script src="https://cut-off-mid-tag'))).toBe('kept');
    expect(indexedText(await html('<p>kept</p><!-- an unclosed comment with commentsource'))).toBe('kept');
    // The twins: a CLOSED script leaves the text after it, and a cut-off page keeps what
    // came before the script it was cut in.
    expect(indexedText(await html('<script>x()</script><p>after it</p>'))).toBe('after it');
    expect(indexedText(await html('<p>before</p><script>a()</script><p>between</p><script>b(')))
      .toBe('before\n\nbetween');
  });

  it('cuts at the UTF-8 cap on a code point boundary and says so', async () => {
    const bounds = { maxTextBytes: 10 };
    const out = await ex('text/plain', enc('abcdefghi€€€'), bounds);
    expect(out).toEqual({ status: 'indexed', extractor: 'text', text: 'abcdefghi', truncated: true });
  });

  it('refuses bytes over its input bound, the second line behind the kernel\'s check on the recorded size', async () => {
    const bounds = { maxInputBytes: 4 };
    expect(await ex('text/plain', enc('hello'), bounds)).toEqual({
      status: 'failed',
      extractor: 'text',
      detail: 'the file is 5 bytes, over the 4-byte input bound',
    });
  });
});

// -- OOXML ---------------------------------------------------------------------------

describe('docx, xlsx and pptx', () => {
  it('docx: text runs joined, paragraphs apart, tabs and breaks kept, deleted text dropped', async () => {
    const body =
      '<w:p><w:r><w:t>Index</w:t></w:r><w:r><w:t xml:space="preserve">ation </w:t></w:r>' +
      '<w:r><w:t>clause</w:t></w:r><w:r><w:tab/><w:t>A&amp;B</w:t></w:r></w:p>' +
      '<w:p><w:r><w:t>line one</w:t><w:br/><w:t>line two</w:t></w:r></w:p>' +
      '<w:p><w:del><w:r><w:delText>struck out</w:delText></w:r></w:del>' +
      '<w:r><w:instrText>PAGE</w:instrText></w:r><w:r><w:t><![CDATA[kept <cdata>]]></w:t></w:r></w:p>';
    const text = indexedText(await ex(DOCX, await docxOf(body)));
    expect(text).toBe('Indexation clause A&B\nline one\nline two\nkept <cdata>');
  });

  it('docx: footnotes and headers after the body, so a cut keeps the body', async () => {
    const file = await docxOf('<w:p><w:r><w:t>body first</w:t></w:r></w:p>', [
      { name: 'word/header1.xml', data: enc('<w:hdr xmlns:w="w"><w:p><w:r><w:t>the header</w:t></w:r></w:p></w:hdr>') },
      { name: 'word/footnotes.xml', data: enc('<w:footnotes xmlns:w="w"><w:p><w:r><w:t>a footnote</w:t></w:r></w:p></w:footnotes>') },
    ]);
    expect(indexedText(await ex(DOCX, file))).toBe('body first\n\na footnote\n\nthe header');
  });

  it('xlsx: shared strings and inline strings, never a phonetic guide or a cell value', async () => {
    const file = await zip([
      { name: 'xl/workbook.xml', data: enc('<workbook/>') },
      {
        name: 'xl/sharedStrings.xml',
        data: enc('<sst><si><t>Item</t></si><si><r><t>Rich </t></r><r><t>run</t></r><rPh><t>ruby</t></rPh></si></sst>'),
      },
      {
        name: 'xl/worksheets/sheet1.xml',
        data: enc('<worksheet><sheetData><row><c t="s"><v>0</v></c><c><v>4242</v></c><c t="inlineStr"><is><t>inline</t></is></c></row></sheetData></worksheet>'),
      },
    ]);
    const text = indexedText(await ex(XLSX, file));
    expect(text).toBe('Item\nRich run\n\ninline');
    expect(text).not.toMatch(/ruby|4242/);
  });

  it('pptx: slides in numeric order, then their notes — and a stored (uncompressed) part reads too', async () => {
    const slide = (t: string) => enc(`<p:sld><a:p><a:r><a:t>${t}</a:t></a:r></a:p></p:sld>`);
    const file = await zip([
      { name: 'ppt/presentation.xml', data: enc('<p:presentation/>') },
      { name: 'ppt/slides/slide10.xml', data: slide('ten') },
      { name: 'ppt/slides/slide2.xml', data: slide('two'), method: 0 },
      { name: 'ppt/notesSlides/notesSlide1.xml', data: slide('a note') },
      { name: 'ppt/slides/slide1.xml', data: slide('one') },
    ]);
    expect(indexedText(await ex(PPTX, file))).toBe('one\n\ntwo\n\nten\n\na note');
  });

  it('a docx past the text cap is cut, and stops reading parts it would only cut off', async () => {
    const para = `<w:p><w:r><w:t>${'word '.repeat(50)}</w:t></w:r></w:p>`;
    const file = await docxOf(para.repeat(40), [
      { name: 'word/footer1.xml', data: enc(`<w:ftr xmlns:w="w">${para}</w:ftr>`) },
    ]);
    const out = await ex(DOCX, file, { maxTextBytes: 1000 });
    expect(out).toMatchObject({ status: 'indexed', truncated: true });
    expect(enc(indexedText(out)).length).toBeLessThanOrEqual(1000);
  });

  describe('a file that is not what it says, legibly', () => {
    const fails = async (body: Uint8Array, detail: RegExp, bounds?: Bounds, type = DOCX) => {
      const out = await ex(type, body, bounds);
      expect(out).toEqual({ status: 'failed', extractor: expect.any(String), detail: expect.stringMatching(detail) });
      return out;
    };

    it('not a zip at all', () => fails(enc('plain words, SECRETWORD inside'), /not a zip archive/));
    it('a zip that is not a docx', async () =>
      fails(await zip([{ name: 'xl/workbook.xml', data: enc('<w/>') }]), /not a docx file/));
    it('an encrypted entry', async () =>
      fails(
        await zip([{ name: 'word/document.xml', data: enc(docxXml('<w:p/>')), flags: 1 }]),
        /encrypted/,
      ));
    it('corrupt deflate data', async () =>
      fails(
        await zip([{ name: 'word/document.xml', data: enc(docxXml('<w:p/>')), raw: new Uint8Array([0xff, 0xff, 0xff, 0xff]) }]),
        /not valid deflate data/,
      ));
    it('an unsupported compression method', async () =>
      fails(await zip([{ name: 'word/document.xml', data: enc(docxXml('<w:p/>')), method: 12 }]), /compression method/));

    it('a zip bomb whose header lies about its size: the inflate counter refuses it', async () => {
      const bomb = new Uint8Array(1024 * 1024); // a megabyte of zeros deflates to about a kilobyte
      const file = await zip([{ name: 'word/document.xml', data: bomb, declaredSize: 10 }]);
      expect(file.length).toBeLessThan(4096);
      await fails(file, /inflates past the extraction bound/, { maxInflatedBytes: 64 * 1024 });
    });

    it('a part whose declared size is already over the bound is refused before inflating', async () => {
      const file = await zip([{ name: 'word/document.xml', data: enc(docxXml('<w:p/>')), declaredSize: 1_000_000 }]);
      await fails(file, /inflates past/, { maxInflatedBytes: 1000 });
    });

    it('the inflate budget is per FILE, across its parts', async () => {
      const part = enc(docxXml(`<w:p><w:r><w:t>${'x'.repeat(600)}</w:t></w:r></w:p>`));
      const file = await docxOf('<w:p/>', [
        { name: 'word/header1.xml', data: part },
        { name: 'word/header2.xml', data: part },
      ]);
      // Each part fits alone; together they do not.
      await fails(file, /inflates past/, { maxInflatedBytes: 1000 });
    });

    it('never quotes the file in its detail', async () => {
      const out = await fails(enc('plain words, SECRETWORD inside'), /./);
      expect(JSON.stringify(out)).not.toContain('SECRETWORD');
    });
  });
});

