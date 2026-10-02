import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { errorCodeOf, type AttachmentRecord, type Decision, type PermissionKey } from '@substrat-run/contracts';
import {
  ATTACHMENT_SEARCH_OWNER_MAX,
  ATTACHMENT_SEARCH_TOO_MANY_OWNERS,
  ATTACHMENT_TEXT_DDL,
  ATTACHMENT_TEXT_JOB,
  ATTACHMENT_TEXT_MODULE,
  assertJobRegistrable,
  attachmentTextJob,
  enqueueAttachmentText,
  readAttachmentText,
  reconcileAttachmentText,
  recordAttachmentText,
  searchAttachments,
  type AttachmentSearchGate,
  type AttachmentTextSource,
} from '../src/attachment-text.js';
import {
  DEFAULT_EXTRACTION_BOUNDS,
  extractAttachmentText,
  extractorFor,
  truncateUtf8,
  type ExtractionBounds,
  type ExtractionOutcome,
} from '../src/attachment-extract.js';
import { JOB_RUN_DDL, type JobPassContext } from '../src/job-run.js';
import { attachmentSha256, type ScopedSql, type SqlValue } from '../src/scope-host.js';
import { SearchTermTooShort, searchMatchExpression } from '../src/search-index.js';

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

describe('extractorFor', () => {
  it('routes by the declared type, parameters and case ignored', () => {
    expect(extractorFor('text/plain; charset=UTF-8', 'a.bin')).toEqual({ extractor: 'text' });
    expect(extractorFor('TEXT/CSV', 'a')).toEqual({ extractor: 'text' });
    expect(extractorFor('text/markdown', 'a')).toEqual({ extractor: 'text' });
    expect(extractorFor('text/html', 'a')).toEqual({ extractor: 'html' });
    expect(extractorFor('application/xhtml+xml', 'a')).toEqual({ extractor: 'html' });
    expect(extractorFor(DOCX, 'a')).toEqual({ extractor: 'docx' });
    expect(extractorFor(XLSX, 'a')).toEqual({ extractor: 'xlsx' });
    expect(extractorFor(PPTX, 'a')).toEqual({ extractor: 'pptx' });
  });

  it('reads the extension only when the type says nothing — never against a specific type', () => {
    expect(extractorFor('application/octet-stream', 'Brief.DOCX')).toEqual({ extractor: 'docx' });
    expect(extractorFor('', 'notes.md')).toEqual({ extractor: 'text' });
    expect(extractorFor('image/png', 'looks-like.txt')).toMatchObject({ unsupported: expect.any(String) });
    expect(extractorFor('application/octet-stream', 'blob.bin')).toMatchObject({ unsupported: expect.any(String) });
  });

  it('says why a PDF, an image or a legacy office file gets no extractor', () => {
    expect(extractorFor('application/pdf', 'a.pdf')).toEqual({ unsupported: expect.stringMatching(/PDF/) });
    expect(extractorFor('image/jpeg', 'a.jpg')).toEqual({ unsupported: expect.stringMatching(/OCR/) });
    expect(extractorFor('application/msword', 'a.doc')).toEqual({
      unsupported: "no extractor for content type 'application/msword'",
    });
  });
});

// -- text and html ------------------------------------------------------------------------

describe('text and html', () => {
  const ex = (contentType: string, body: Uint8Array, bounds?: ExtractionBounds) =>
    extractAttachmentText({ contentType, filename: 'f', body }, bounds);

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
    const bounds = { ...DEFAULT_EXTRACTION_BOUNDS, maxTextBytes: 10 };
    const out = await ex('text/plain', enc('abcdefghi€€€'), bounds);
    expect(out).toEqual({ status: 'indexed', extractor: 'text', text: 'abcdefghi', truncated: true });
  });

  it('truncateUtf8 never splits a character', () => {
    expect(truncateUtf8('aé', 2)).toEqual({ text: 'a', truncated: true });
    expect(truncateUtf8('aé', 3)).toEqual({ text: 'aé', truncated: false });
    expect(truncateUtf8('a😀', 4)).toEqual({ text: 'a', truncated: true });
    expect(truncateUtf8('a😀', 5)).toEqual({ text: 'a😀', truncated: false });
  });

  it('refuses a file over the input bound without reading it', async () => {
    const bounds = { ...DEFAULT_EXTRACTION_BOUNDS, maxInputBytes: 4 };
    expect(await ex('text/plain', enc('hello'), bounds)).toEqual({
      status: 'failed',
      extractor: 'text',
      detail: 'the file is 5 bytes, over the 4-byte extraction bound',
    });
  });
});

// -- OOXML ---------------------------------------------------------------------------

describe('docx, xlsx and pptx', () => {
  const ex = (contentType: string, body: Uint8Array, bounds?: ExtractionBounds) =>
    extractAttachmentText({ contentType, filename: 'f', body }, bounds);

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
    const out = await ex(DOCX, file, { ...DEFAULT_EXTRACTION_BOUNDS, maxTextBytes: 1000 });
    expect(out).toMatchObject({ status: 'indexed', truncated: true });
    expect(enc(indexedText(out)).length).toBeLessThanOrEqual(1000);
  });

  describe('a file that is not what it says, legibly', () => {
    const fails = async (body: Uint8Array, detail: RegExp, bounds?: ExtractionBounds, type = DOCX) => {
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
      await fails(file, /inflates past the extraction bound/, { ...DEFAULT_EXTRACTION_BOUNDS, maxInflatedBytes: 64 * 1024 });
    });

    it('a part whose declared size is already over the bound is refused before inflating', async () => {
      const file = await zip([{ name: 'word/document.xml', data: enc(docxXml('<w:p/>')), declaredSize: 1_000_000 }]);
      await fails(file, /inflates past/, { ...DEFAULT_EXTRACTION_BOUNDS, maxInflatedBytes: 1000 });
    });

    it('the inflate budget is per FILE, across its parts', async () => {
      const part = enc(docxXml(`<w:p><w:r><w:t>${'x'.repeat(600)}</w:t></w:r></w:p>`));
      const file = await docxOf('<w:p/>', [
        { name: 'word/header1.xml', data: part },
        { name: 'word/header2.xml', data: part },
      ]);
      // Each part fits alone; together they do not.
      await fails(file, /inflates past/, { ...DEFAULT_EXTRACTION_BOUNDS, maxInflatedBytes: 1000 });
    });

    it('never quotes the file in its detail', async () => {
      const out = await fails(enc('plain words, SECRETWORD inside'), /./);
      expect(JSON.stringify(out)).not.toContain('SECRETWORD');
    });
  });
});

// -- the SQL, against a real SQLite ----------------------------------------------------

const ATTACHMENTS_DDL = `CREATE TABLE _substrat_attachments (
  id TEXT PRIMARY KEY, entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, filename TEXT NOT NULL,
  content_type TEXT NOT NULL, size INTEGER NOT NULL, sha256 TEXT NOT NULL, visibility TEXT NOT NULL,
  created_by TEXT NOT NULL, created_at TEXT NOT NULL)`;

function scope() {
  const db = new DatabaseSync(':memory:');
  db.exec(ATTACHMENTS_DDL);
  db.exec(JOB_RUN_DDL);
  db.exec(ATTACHMENT_TEXT_DDL);
  // The kernel's spine handle shape, over node SQLite — what `spineSql` is over better-sqlite3.
  const sql: ScopedSql = {
    query: <T>(q: string, params: readonly SqlValue[] = []) => db.prepare(q).all(...(params as never[])) as T[],
    exec: (q: string, params: readonly SqlValue[] = []) => ({
      changes: Number(db.prepare(q).run(...(params as never[])).changes),
    }),
  };
  const attach = (id: string, entityId = 'e1') =>
    db
      .prepare(`INSERT INTO _substrat_attachments VALUES (?, 'item', ?, 'f.txt', 'text/plain', 1, ?, 'internal', 'p', ?)`)
      .run(id, entityId, '0'.repeat(64), '2026-10-01T00:00:00.000Z');
  const one = (q: string, ...params: (string | number)[]) =>
    db.prepare(q).get(...params) as Record<string, unknown> | undefined;
  const count = (q: string, ...params: (string | number)[]) => Number(one(q, ...params)!.n);
  const matches = (word: string) =>
    count(
      'SELECT count(*) AS n FROM _substrat_search__attachments WHERE _substrat_search__attachments MATCH ?',
      searchMatchExpression(word, 'prefix'),
    );
  const ctx = { sql };
  return { db, sql, attach, one, count, matches, ctx };
}

const indexed = (text: string): ExtractionOutcome => ({ status: 'indexed', extractor: 'text', text, truncated: false });

describe('the text rows and their index', () => {
  it('queues a pending row and ONE live run; a second queue joins it and leaves the row alone', () => {
    const s = scope();
    s.attach('A1');
    enqueueAttachmentText(s.sql, 'A1', 'R1', '2026-10-01T00:00:00.000Z');
    recordAttachmentText(s.sql, 'A1', indexed('kept text'), '2026-10-01T00:00:01.000Z');
    enqueueAttachmentText(s.sql, 'A1', 'R2', '2026-10-01T00:00:02.000Z');
    expect(s.count("SELECT count(*) AS n FROM _substrat_job_runs WHERE instance = 'A1'")).toBe(1);
    expect(s.one("SELECT id, module_id, job, payload, status FROM _substrat_job_runs")).toEqual({
      id: 'R1',
      module_id: ATTACHMENT_TEXT_MODULE,
      job: ATTACHMENT_TEXT_JOB,
      payload: '{"attachmentId":"A1"}',
      status: 'running',
    });
    // The twin: once that run has finished, a re-queue starts a new one.
    s.db.prepare("UPDATE _substrat_job_runs SET status = 'done'").run();
    enqueueAttachmentText(s.sql, 'A1', 'R3', '2026-10-01T00:00:03.000Z');
    expect(s.count("SELECT count(*) AS n FROM _substrat_job_runs WHERE status = 'running'")).toBe(1);
    expect(s.one('SELECT status, body FROM _substrat_search__attachment_text')).toEqual({ status: 'indexed', body: 'kept text' });
  });

  it('writing the same outcome twice leaves one row and one match', () => {
    const s = scope();
    s.attach('A1');
    enqueueAttachmentText(s.sql, 'A1', 'R1', 't');
    expect(recordAttachmentText(s.sql, 'A1', indexed('the platypus clause'), 't1')).toBe(true);
    expect(recordAttachmentText(s.sql, 'A1', indexed('the platypus clause'), 't2')).toBe(true);
    expect(s.count('SELECT count(*) AS n FROM _substrat_search__attachment_text')).toBe(1);
    expect(s.matches('platypus')).toBe(1);
    // A changed outcome replaces the old terms rather than adding to them.
    recordAttachmentText(s.sql, 'A1', indexed('the wombat clause'), 't3');
    expect([s.matches('platypus'), s.matches('wombat')]).toEqual([0, 1]);
    expect(s.one('SELECT body_bytes, truncated, updated_at FROM _substrat_search__attachment_text')).toEqual({
      body_bytes: 17,
      truncated: 0,
      updated_at: 't3',
    });
  });

  it('a write for an attachment removed meanwhile is refused and writes nothing — the twin lands', () => {
    const s = scope();
    s.attach('A1');
    enqueueAttachmentText(s.sql, 'A1', 'R1', 't');
    s.db.prepare("DELETE FROM _substrat_attachments WHERE id = 'A1'").run();
    expect(recordAttachmentText(s.sql, 'A1', indexed('the tapir memo'), 't1')).toBe(false);
    expect(s.count('SELECT count(*) AS n FROM _substrat_search__attachment_text')).toBe(0);
    expect(s.matches('tapir')).toBe(0);
    s.attach('A2');
    expect(recordAttachmentText(s.sql, 'A2', indexed('the tapir memo'), 't1')).toBe(true);
    expect(s.matches('tapir')).toBe(1);
  });

  it('deleting the attachment row removes its text row and its index entries, by trigger', () => {
    const s = scope();
    s.attach('A1');
    s.attach('A2');
    recordAttachmentText(s.sql, 'A1', indexed('axolotl one'), 't');
    recordAttachmentText(s.sql, 'A2', indexed('axolotl two'), 't');
    s.db.prepare("DELETE FROM _substrat_attachments WHERE id = 'A1'").run();
    expect(s.count("SELECT count(*) AS n FROM _substrat_search__attachment_text WHERE attachment_id = 'A1'")).toBe(0);
    expect(s.matches('axolotl')).toBe(1);
    expect(s.matches('one')).toBe(0);
  });

  it('reconcile drops orphaned text and queues every attachment without any', () => {
    const s = scope();
    s.attach('A1');
    s.attach('A2');
    recordAttachmentText(s.sql, 'A1', indexed('okapi kept'), 't');
    // A row whose attachment a restore rewound away: written straight past the guard.
    s.db.prepare(`INSERT INTO _substrat_search__attachment_text (attachment_id, status, body, updated_at)
                  VALUES ('GONE', 'indexed', 'okapi orphan', 't')`).run();
    let n = 0;
    expect(reconcileAttachmentText(s.sql, () => `R${(n += 1)}`, 't')).toEqual({ removed: 1, queued: 1 });
    expect(s.matches('orphan')).toBe(0);
    expect(s.matches('kept')).toBe(1);
    expect(s.one("SELECT status FROM _substrat_search__attachment_text WHERE attachment_id = 'A2'")).toEqual({ status: 'pending' });
    expect(s.count("SELECT count(*) AS n FROM _substrat_job_runs WHERE instance = 'A2'")).toBe(1);
    // Idempotent: nothing left to do.
    expect(reconcileAttachmentText(s.sql, () => 'R-again', 't')).toEqual({ removed: 0, queued: 0 });
  });

  it('readAttachmentText: null when nothing was recorded, a stalled pending as failed, the rest as written', () => {
    const s = scope();
    expect(readAttachmentText(s.ctx, 'NOPE')).toBeNull();
    s.attach('A1');
    enqueueAttachmentText(s.sql, 'A1', 'R1', 't0');
    expect(readAttachmentText(s.ctx, 'A1')).toMatchObject({ status: 'pending', detail: null });
    s.db.prepare("UPDATE _substrat_job_runs SET status = 'failed', last_error = 'blob store unreachable'").run();
    expect(readAttachmentText(s.ctx, 'A1')).toMatchObject({
      status: 'failed',
      detail: 'extraction run failed: blob store unreachable',
    });
    recordAttachmentText(s.sql, 'A1', { status: 'indexed', extractor: 'docx', text: 'é', truncated: true }, 't1');
    expect(readAttachmentText(s.ctx, 'A1')).toEqual({
      attachmentId: 'A1',
      status: 'indexed',
      extractor: 'docx',
      bytes: 2,
      truncated: true,
      detail: null,
      updatedAt: 't1',
    });
    recordAttachmentText(s.sql, 'A1', { status: 'unsupported', detail: 'no extractor' }, 't2');
    expect(readAttachmentText(s.ctx, 'A1')).toMatchObject({ status: 'unsupported', extractor: null, bytes: null, detail: 'no extractor' });
  });

});

describe('searchAttachments: authorize first, then match over readable owners', () => {
  /**
   * A gate over one target type, `item`, whose answers the test decides: `wide` at the scope,
   * `readable` per owning entity ('throw' for an evaluator failure). `asked` records each
   * check in order — `<scope>` or the entity id — which is what shows the work done.
   */
  const gate = (opts: { wide?: boolean | 'throw'; readable?: (entityId: string) => boolean | 'throw' }) => {
    const asked: string[] = [];
    const answer = (a: boolean | 'throw' | undefined): Decision => {
      if (a === 'throw') throw new Error('evaluator down');
      return (a ? { allowed: true, proof: [] } : { allowed: false }) as unknown as Decision;
    };
    const g: AttachmentSearchGate = {
      targets: new Map([['item', { read: 'p:read' as PermissionKey }]]),
      check: async (_permission, entity) => {
        asked.push(entity ? entity.entityId : '<scope>');
        return answer(entity ? opts.readable?.(entity.entityId) : opts.wide);
      },
    };
    return { g, asked };
  };
  const indexAll = (s: ReturnType<typeof scope>, rows: [id: string, entityId: string, text: string][]) => {
    for (const [id, entityId, text] of rows) {
      s.attach(id, entityId);
      recordAttachmentText(s.sql, id, indexed(text), 't');
    }
  };
  const ids = (records: { id: string }[]) => records.map((r) => r.id);

  it('a caller who reads the type at the scope is wide: one check, every match newest first', async () => {
    const s = scope();
    indexAll(s, [['A1', 'e1', 'quokka one'], ['A3', 'e3', 'quokka three'], ['A2', 'e2', 'quokka two']]);
    // A text row with no attachment row is never a hit, wide or not.
    s.db.prepare(`INSERT INTO _substrat_search__attachment_text (attachment_id, status, body, updated_at)
                  VALUES ('A9', 'indexed', 'quokka orphan', 't')`).run();
    const { g, asked } = gate({ wide: true });
    expect(ids(await searchAttachments(s.sql, g, 'quokka', 20))).toEqual(['A3', 'A2', 'A1']);
    expect(ids(await searchAttachments(s.sql, g, 'quokka', 2))).toEqual(['A3', 'A2']);
    expect(asked).toEqual(['<scope>', '<scope>']);
    // Records, parsed: what `open` would hand back.
    expect((await searchAttachments(s.sql, g, 'three', 20))[0]).toMatchObject({
      id: 'A3',
      entity: { entityType: 'item', entityId: 'e3' },
      createdAt: '2026-10-01T00:00:00.000Z',
    });
  });

  it('a narrowed caller: the limit runs over readable rows, however many newer denied matches there are', async () => {
    const s = scope();
    const rows: [string, string, string][] = [['A0000', 'e-ok', 'quokka readable']];
    for (let i = 1; i <= 1200; i += 1) rows.push([`A${String(i).padStart(4, '0')}`, 'e-no', 'quokka hidden']);
    indexAll(s, rows);
    const { g, asked } = gate({ wide: false, readable: (e) => e === 'e-ok' });
    expect(ids(await searchAttachments(s.sql, g, 'quokka', 1))).toEqual(['A0000']);
    // The work is one check per OWNER, in owner order — not per match, and not in match order.
    expect(asked).toEqual(['<scope>', 'e-no', 'e-ok']);
    // The control: the same caller in a scope without the hidden matches gets the same page.
    const control = scope();
    indexAll(control, [['A0000', 'e-ok', 'quokka readable']]);
    expect(ids(await searchAttachments(control.sql, gate({ readable: (e) => e === 'e-ok' }).g, 'quokka', 1))).toEqual([
      'A0000',
    ]);
  });

  it('refuses past the owner cap — the same answer for every term — and never for a wide caller', async () => {
    const s = scope();
    const rows: [string, string, string][] = [];
    for (let i = 0; i <= ATTACHMENT_SEARCH_OWNER_MAX; i += 1) {
      rows.push([`A${String(i).padStart(5, '0')}`, `e${i}`, i === 0 ? 'quokka the only match' : 'filler words']);
    }
    indexAll(s, rows);
    const refusalOf = async (term: string) => {
      const err = await searchAttachments(s.sql, gate({ readable: () => true }).g, term, 20).then(
        () => undefined,
        (e: unknown) => e,
      );
      return { code: errorCodeOf(err), reason: (err as { extensions?: { reason?: string } }).extensions?.reason };
    };
    const refused = { code: 'forbidden', reason: ATTACHMENT_SEARCH_TOO_MANY_OWNERS };
    expect(await refusalOf('quokka')).toEqual(refused); // a term with a match
    expect(await refusalOf('nothingmatchesthis')).toEqual(refused); // and one without
    expect(ids(await searchAttachments(s.sql, gate({ wide: true }).g, 'quokka', 20))).toEqual(['A00000']);
  });

  it('counts only owners WITH text toward the cap — the twin of the refusal, at the cap', async () => {
    const s = scope();
    const rows: [string, string, string][] = [];
    for (let i = 0; i < ATTACHMENT_SEARCH_OWNER_MAX; i += 1) rows.push([`A${String(i).padStart(5, '0')}`, `e${i}`, 'quokka']);
    indexAll(s, rows);
    // Past the cap in attachment rows, but these owners have no text: not counted.
    for (let i = 0; i < 10; i += 1) s.attach(`B${i}`, `no-text-${i}`);
    const { g } = gate({ readable: (e) => e === 'e7' });
    expect(ids(await searchAttachments(s.sql, g, 'quokka', 20))).toEqual(['A00007']);
  });

  it('reads a check that throws as a refusal — at the scope not wide, at an owner not readable', async () => {
    const s = scope();
    indexAll(s, [['A1', 'boom', 'quokka a'], ['A2', 'fine', 'quokka b']]);
    const { g } = gate({ wide: 'throw', readable: (e) => (e === 'boom' ? 'throw' : true) });
    expect(ids(await searchAttachments(s.sql, g, 'quokka', 20))).toEqual(['A2']);
  });

  it('judges the term before any check, and answers nothing readable with no match at all', async () => {
    const s = scope();
    indexAll(s, [['A1', 'e1', 'quokka']]);
    const short = gate({ wide: true });
    await expect(searchAttachments(s.sql, short.g, 'q', 20)).rejects.toBeInstanceOf(SearchTermTooShort);
    expect(short.asked).toEqual([]);
    expect(await searchAttachments(s.sql, gate({ readable: () => false }).g, 'quokka', 20)).toEqual([]);
  });
});

describe('assertJobRegistrable', () => {
  it("refuses any job under the kernel's own module id, and nothing else", () => {
    expect(() => assertJobRegistrable(ATTACHMENT_TEXT_MODULE, ATTACHMENT_TEXT_JOB)).toThrow(/reserved/);
    expect(() => assertJobRegistrable(ATTACHMENT_TEXT_MODULE, 'some-later-kernel-job')).toThrow(/reserved/);
    expect(() => assertJobRegistrable('@acme/vertical', ATTACHMENT_TEXT_JOB)).not.toThrow();
  });
});

// -- the job -------------------------------------------------------------------------

describe('attachmentTextJob', () => {
  const recordOf = async (over: Partial<AttachmentRecord>, body = enc('the kinkajou note')): Promise<AttachmentRecord> => ({
    id: 'A1',
    entity: { entityType: 'item', entityId: 'e1' },
    filename: 'n.txt',
    contentType: 'text/plain',
    size: body.length,
    sha256: await attachmentSha256(body),
    visibility: 'internal',
    createdBy: 'p',
    createdAt: '2026-10-01T00:00:00.000Z' as AttachmentRecord['createdAt'],
    ...over,
  });
  const run = async (source: Partial<AttachmentTextSource>, payload: unknown = { attachmentId: 'A1' }, bounds?: ExtractionBounds) => {
    const written: ExtractionOutcome[] = [];
    let fetched = 0;
    const counters: Record<string, number> = {};
    const pass = {
      run: { id: 'R1', moduleId: ATTACHMENT_TEXT_MODULE, job: ATTACHMENT_TEXT_JOB, instance: 'A1' },
      payload,
      cursor: null,
      counters,
      count: (name: string, by = 1) => {
        counters[name] = (counters[name] ?? 0) + by;
      },
      step: () => {
        throw new Error('the extraction job takes no steps');
      },
      scope: () => {
        throw new Error('the extraction job opens no scope');
      },
    } as unknown as JobPassContext;
    const handler = attachmentTextJob(
      {
        record: source.record ?? (async () => recordOf({})),
        bytes: async (r) => {
          fetched += 1;
          return (source.bytes ?? (async () => enc('the kinkajou note')))(r);
        },
        write: async (id, outcome) => {
          written.push(outcome);
          return source.write ? source.write(id, outcome) : true;
        },
      },
      bounds,
    );
    const result = await handler(pass);
    return { result, written, fetched, counters };
  };

  it('extracts, writes, and finishes in one pass', async () => {
    const r = await run({});
    expect(r.result).toEqual({ done: true });
    expect(r.written).toEqual([{ status: 'indexed', extractor: 'text', text: 'the kinkajou note', truncated: false }]);
    expect(r.counters).toEqual({ indexed: 1 });
  });

  it('never fetches the bytes of a type it cannot read, or of a file over the input bound', async () => {
    const pdf = await run({ record: async () => recordOf({ contentType: 'application/pdf' }) });
    expect([pdf.fetched, pdf.written[0]?.status]).toEqual([0, 'unsupported']);
    const big = await run(
      { record: async () => recordOf({ size: 10_000 }) },
      undefined,
      { ...DEFAULT_EXTRACTION_BOUNDS, maxInputBytes: 100 },
    );
    expect([big.fetched, big.written[0]]).toEqual([
      0,
      { status: 'failed', extractor: 'text', detail: 'the file is 10000 bytes, over the 100-byte extraction bound' },
    ]);
  });

  it('records bytes that are gone, or not the recorded ones, as failed — retrying cannot fix either', async () => {
    expect((await run({ bytes: async () => null })).written[0]).toMatchObject({ status: 'failed', detail: /missing/ });
    expect((await run({ bytes: async () => enc('different bytes!!') })).written[0]).toMatchObject({
      status: 'failed',
      detail: /sha256/,
    });
  });

  it('lets a store that throws fail the pass, so the driver retries it', async () => {
    await expect(run({ bytes: async () => Promise.reject(new Error('R2 unavailable')) })).rejects.toThrow('R2 unavailable');
  });

  it('a removed attachment finishes the run as gone — before reading, or at the write', async () => {
    const before = await run({ record: async () => null });
    expect([before.written, before.counters, before.fetched]).toEqual([[], { gone: 1 }, 0]);
    const during = await run({ write: async () => false });
    expect(during.counters).toEqual({ gone: 1 });
  });

  it('refuses a payload that names no attachment', async () => {
    await expect(run({}, { other: 1 })).rejects.toThrow(/attachmentId/);
  });
});
