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
import { buildEpub, figureRequests, readCover } from '../.vitepress/epub.mjs';
import { renderFigures } from '../.vitepress/figures.mjs';
import { bookChapters } from '../.vitepress/sidebar.mjs';

const SRC = resolve(fileURLToPath(import.meta.url), '../..');
/**
 * The real archive, figures and all. Rendering them stands up a Vite server and
 * server-renders five Vue components, which is slow enough to be worth doing once
 * for the file — and worth doing at all, because the figures are exactly the part
 * that turns a chapter into XML a reader refuses.
 */
const requests = figureRequests(SRC);
const epub = buildEpub(SRC, readCover(SRC), await renderFigures(SRC, requests));
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

/** Everything an XML parser has to accept, and the chapters among them. */
const docs = Object.keys(files).filter((f) => /\.(xhtml|opf|ncx|xml)$/.test(f));
const chapterDocs = docs.filter((d) => d.startsWith('EPUB/text/'));

describe('the content documents', () => {
  it('covers the title page, nav, and one file per chapter', () => {
    expect(chapterDocs).toHaveLength(bookChapters().length);
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

  it('does not double the numbering on the contents page', () => {
    // Every chapter title already opens with its number, and EPUB 3 requires the toc
    // to be an ordered list — whose markers a reader draws too. The class is what the
    // stylesheet suppresses them through; an `epub|type` selector is not reliably
    // supported, so the hook has to be a plain class.
    const nav = text('EPUB/nav.xhtml');
    expect(nav).toContain('class="toc"');
    expect(text('EPUB/style.css')).toContain('.toc ol { list-style: none;');
  });

  it('invents no links — linkify would read PERMISSIONS.md as a hostname', () => {
    for (const doc of docs.filter((d) => d.endsWith('.xhtml'))) {
      expect(text(doc)).not.toMatch(/href="http:\/\/[A-Z]/);
    }
  });
});

describe('the figures', () => {
  /**
   * The chapters that draw one, and what they draw. Pinned rather than derived:
   * deriving it from the same walk that produced the archive would assert that the
   * code agrees with itself, and the failure this guards against is a component
   * quietly dropping out of a chapter.
   */
  it('renders every diagram the chapters ask for', () => {
    expect(requests.map((r) => r.name)).toEqual([
      'LayerStack',
      'TenancyTree',
      'ScopeTopology',
      'PermissionPipeline',
      'BlastRadius',
    ]);
  });

  it('leaves no chapter holding a pointer at the web page instead', () => {
    for (const doc of chapterDocs) {
      expect(text(doc)).not.toContain('rendered at the HTML page');
    }
  });

  it('puts the components own markup in the chapter', () => {
    const ch2 = text('EPUB/text/02-tenants-and-scopes.xhtml');
    expect(ch2).toContain('class="figure figure--TenancyTree"');
    expect(ch2).toContain('class="figure figure--ScopeTopology"');
    // The label the SVG carries for a reader who cannot see it.
    expect(ch2).toContain('aria-label="A tenant is a billing and identity boundary');
  });

  /**
   * An inline `<svg>` in XHTML is only SVG if it says so — without the namespace it
   * is eleven unknown elements in the XHTML namespace, which a reader draws as
   * nothing at all while the document still parses.
   */
  it('declares the SVG namespace on every inline svg', () => {
    for (const doc of chapterDocs) {
      for (const [, attrs] of text(doc).matchAll(/<svg([^>]*)>/g)) {
        expect(attrs).toContain('xmlns="http://www.w3.org/2000/svg"');
      }
    }
  });

  it('carries no scope attribute a stylesheet no longer names', () => {
    for (const doc of chapterDocs) {
      expect(text(doc)).not.toMatch(/data-v-[0-9a-f]/);
    }
  });

  /**
   * The stylesheet has to carry both halves or the figure arrives unstyled: the
   * component's own rules, confined to its wrapper so two components' `.fig` do not
   * collide, and the design tokens those rules resolve against — which on the web
   * come from a theme an EPUB never loads.
   */
  it('scopes each component stylesheet to its own figure', () => {
    const css = text('EPUB/style.css');
    expect(css).toContain('.figure--ScopeTopology .fbox');
    expect(css).toContain('.figure--TenancyTree .tbox');
    expect(css).toContain('.figure--LayerStack .layerstack');
  });

  it('brings the design tokens the rules resolve against', () => {
    const css = text('EPUB/style.css');
    expect(css).toContain('--layer-kernel:');
    expect(css).toContain('--surface-card:');
    expect(css).toContain('--font-sans:');
  });

  it('still builds a book when no figures are rendered', () => {
    // The sync path: prose twins in place of the pictures, rather than five holes.
    const plain = unzipSync(buildEpub(SRC));
    expect(strFromU8(plain['EPUB/text/02-tenants-and-scopes.xhtml']!)).toContain(
      'Diagram — the topology, adapter-neutral.',
    );
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
    const chapters = bookChapters().map(
      (c) => `ch-${c.link.replace(/^\/book\/?/, '') || 'index'}`,
    );
    expect(spine.slice(2)).toEqual(chapters);
    expect(spine.slice(0, 2)).toEqual(['titlepage', 'nav']);
  });

  it('names a nav document and a raster cover', () => {
    expect(items.find((i) => i.properties === 'nav')?.href).toBe('nav.xhtml');
    const cover = items.find((i) => (i.properties ?? '').includes('cover-image'));
    expect(cover?.['media-type']).toBe('image/png');
    expect(files[`EPUB/${cover!.href}`]!.length).toBeGreaterThan(1000);
  });

  /**
   * The bug that made the first cut of this file unopenable, and the reason this
   * assertion exists rather than a comment: an OPF `id` is an XML `ID`, whose name
   * production forbids a LEADING DIGIT. The obvious id for a chapter is its slug, and
   * ten of eleven slugs start with one — so `01-why-a-substrate` produced a package
   * document that would not parse, and Apple Books declined the file with no reason
   * given. A strict XML parser does not catch it: well-formedness has nothing to say
   * about the `ID` datatype, which only the OPF schema imposes.
   */
  const XML_NAME = /^[A-Za-z_][A-Za-z0-9._-]*$/;

  it('gives every manifest item an id that is a valid XML name', () => {
    const bad = items.map((i) => i.id).filter((id) => !XML_NAME.test(id!));
    expect(bad).toEqual([]);
  });

  it('references only valid XML names from the spine', () => {
    expect(spine.filter((ref) => !XML_NAME.test(ref!))).toEqual([]);
  });

  it('gives every item a distinct id', () => {
    const ids = items.map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
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
