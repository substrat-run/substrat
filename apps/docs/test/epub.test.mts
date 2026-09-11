/**
 * The EPUB edition (#1401).
 *
 * An EPUB fails in a way that is uniquely bad to debug: a reader that dislikes the
 * archive shows a blank chapter, or refuses the file with no reason, rather than
 * reporting what is wrong. So the rules that produce those silences are asserted
 * here — `mimetype` first and stored, every content document strict XML, and every
 * file declared in the manifest and placed in the spine.
 */
import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { unzipSync, strFromU8 } from 'fflate';
import { parseXml } from '@rgrove/parse-xml';
import { buildEpub, readCover } from '../.vitepress/epub.mjs';
import { bookChapters } from '../.vitepress/sidebar.mjs';

const SRC = resolve(fileURLToPath(import.meta.url), '../..');
const epub = buildEpub(SRC, readCover(SRC));
const files = unzipSync(epub);
const text = (path: string): string => strFromU8(files[path]!);

const OPF = 'EPUB/package.opf';
const opf = parseXml(text(OPF));

/** Every `<item>`/`<itemref>` in the package document, as plain objects. */
function elements(name: string): Record<string, string>[] {
  const out: Record<string, string>[] = [];
  const walk = (node: { name?: string; attributes?: Record<string, string>; children?: unknown[] }): void => {
    if (node.name === name && node.attributes) out.push(node.attributes);
    for (const child of node.children ?? []) walk(child as typeof node);
  };
  walk(opf as unknown as Parameters<typeof walk>[0]);
  return out;
}

describe('the archive', () => {
  it('puts mimetype first and stores it uncompressed', () => {
    // A reader sniffs these bytes at a fixed offset. Deflated or later in the
    // archive, every file is present and the result is not an EPUB.
    expect(Object.keys(files)[0]).toBe('mimetype');
    expect(text('mimetype')).toBe('application/epub+zip');
    // Read the local file header at offset 0 rather than trusting a magic offset:
    // bytes 8-9 are the compression method (0 = stored), 26-27 the filename length and
    // 28-29 the extra-field length. The payload starts after both, and a reader that
    // seeks a fixed offset only finds the right bytes when the extra field is empty.
    const nameLen = epub[26]! | (epub[27]! << 8);
    const extraLen = epub[28]! | (epub[29]! << 8);
    expect(epub[8]! | (epub[9]! << 8)).toBe(0); // stored, not deflated
    expect(extraLen).toBe(0);
    const start = 30 + nameLen + extraLen;
    expect(strFromU8(epub.slice(start, start + 20))).toBe('application/epub+zip');
  });

  it('points container.xml at the package document', () => {
    expect(text('META-INF/container.xml')).toContain(`full-path="${OPF}"`);
  });
});

describe('the content documents', () => {
  const docs = Object.keys(files).filter((f) => /\.(xhtml|opf|ncx|xml)$/.test(f));

  it('covers the title page, nav, and one file per chapter', () => {
    expect(docs.filter((d) => d.startsWith('EPUB/text/'))).toHaveLength(bookChapters().length);
  });

  it.each(docs)('%s parses as strict XML', (doc) => {
    // Not "renders in a browser" — XHTML is XML, so an unclosed <br> is fatal.
    expect(() => parseXml(text(doc))).not.toThrow();
  });

  it('links between chapters stay inside the book', () => {
    const front = text('EPUB/text/index.xhtml');
    expect(front).toContain('href="05-one-event.xhtml"');
  });

  it('links out of the book point at pages, not markdown twins', () => {
    const ch5 = text('EPUB/text/05-one-event.xhtml');
    expect(ch5).toContain('href="https://substrat.net/concepts/events"');
    expect(ch5).not.toContain('.md"');
  });

  it('invents no links — linkify would read PERMISSIONS.md as a hostname', () => {
    for (const doc of docs.filter((d) => d.endsWith('.xhtml'))) {
      expect(text(doc)).not.toMatch(/href="http:\/\/[A-Z]/);
    }
  });
});

describe('the package document', () => {
  const items = elements('item');
  const spine = elements('itemref').map((i) => i.idref);

  it('declares every file in the archive', () => {
    const declared = new Set(items.map((i) => `EPUB/${i.href}`));
    const payload = Object.keys(files).filter(
      (f) => f !== 'mimetype' && !f.startsWith('META-INF/') && f !== OPF,
    );
    expect(payload.filter((f) => !declared.has(f))).toEqual([]);
  });

  it('declares no file the archive lacks', () => {
    expect(items.map((i) => `EPUB/${i.href}`).filter((f) => !(f in files))).toEqual([]);
  });

  it('places every chapter in the spine, in reading order', () => {
    const chapters = bookChapters().map((c) => c.link.replace(/^\/book\/?/, '') || 'index');
    expect(spine.slice(2)).toEqual(chapters);
    expect(spine.slice(0, 2)).toEqual(['titlepage', 'nav']);
  });

  it('names a nav document and a raster cover', () => {
    expect(items.find((i) => i.properties === 'nav')?.href).toBe('nav.xhtml');
    const cover = items.find((i) => (i.properties ?? '').includes('cover-image'));
    expect(cover?.['media-type']).toBe('image/png');
    expect(files[`EPUB/${cover!.href}`]!.length).toBeGreaterThan(1000);
  });

  it('keeps a stable identifier so a re-download is not a second book', () => {
    expect(text(OPF)).toContain('urn:uuid:5f3b9c62-8a4e-4d17-9f21-7c6e0b2a4d83');
  });

  it('stamps dcterms:modified in the only format the spec accepts', () => {
    expect(text(OPF)).toMatch(
      /<meta property="dcterms:modified">\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z<\/meta>/,
    );
  });
});
