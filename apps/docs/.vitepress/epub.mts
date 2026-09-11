/**
 * The EPUB edition of the book (#1401) — `/book.epub`, one file that opens in Apple
 * Books, Kobo, Calibre or anything else that reads EPUB 3.
 *
 * `book.txt` and `book/read.html` already exist, and neither is a book on a phone:
 * a reader wants a table of contents it can jump around in, remembered position,
 * adjustable type, and a cover in its library. That is a packaging format, not a
 * bigger HTML file, so this builds a real one.
 *
 * ## What an EPUB actually is
 *
 * A zip with rules. The ones that bite, all of which are enforced below:
 *
 *   1. `mimetype` MUST be the FIRST entry and MUST be STORED, not deflated. A reader
 *      sniffs the file by reading those bytes at a fixed offset, so a compressed or
 *      later-placed `mimetype` is not a valid EPUB even though every file is present.
 *   2. Content documents are XHTML — **XML**, not HTML5. An unclosed `<br>` is a
 *      parse error, not a tolerated sloppiness, and the failure mode in a reader is a
 *      blank chapter rather than a message. `markdown-it`'s `xhtmlOut` is what keeps
 *      the rendered markdown on the right side of that.
 *   3. Every file in the zip must be declared in the package manifest, and every
 *      readable document must appear in the spine, in reading order.
 *
 * ## Why it is generated and not checked in
 *
 * Same reason as the other two editions (book.mts): a committed `.epub` is a second,
 * drifting transcript of eleven chapters, and a binary one nobody can review in a
 * diff. It is built in `buildEnd` from `bookPages()` — the same list the nav renders
 * — so it cannot contain a different book from the one on the site.
 *
 * The cover is the one exception, and deliberately so: `EPUB/cover.png` is a checked-in
 * **asset** (`apps/docs/assets/book-cover.png`), not a generated file. It carries no
 * GENERATED header and claims no gate, because it is art rather than a derivation —
 * the same category as a logo. `assets/book-cover.svg` beside it is what it was drawn
 * from, and `pnpm --filter @substrat-run/docs cover` re-renders one from the other with
 * `rsvg-convert`. That is a tool nobody's CI has, which is exactly why this is an asset
 * pair a human maintains and not a build step that would be red everywhere but here.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { zipSync, strToU8 } from 'fflate';
import MarkdownIt from 'markdown-it';
import { bookPages, type BookPage } from './book.mjs';
import { SITE, type Artifact } from './llms.mjs';

const TITLE = 'Substrat, end to end';
const AUTHOR = 'Substrat';
const LANGUAGE = 'en';

/**
 * The book's identity, as readers use it.
 *
 * A stable URN rather than a fresh UUID per build: a reader keyed on the identifier
 * treats a changed one as a DIFFERENT book, so re-downloading after a docs update
 * would shelve a second copy beside the first and lose the reader's position in it.
 * The edition moves in `dcterms:modified` instead, which is what that field is for.
 */
const BOOK_ID = 'urn:uuid:5f3b9c62-8a4e-4d17-9f21-7c6e0b2a4d83';

/** XML text escape. Attribute values go through the same one — `"` is covered. */
const xml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * `xhtmlOut` is the whole reason this renderer is separate from the one in book.mts:
 * it closes void elements (`<br />`, `<hr />`), without which a chapter is an XML
 * parse error and a reader shows nothing at all.
 *
 * `linkify` is OFF, and that is a fix rather than a default. It reads a bare token
 * like `PERMISSIONS.md` as a hostname — `.md` is Moldova — and ships a link to a
 * domain nobody owns. The book's own links are all explicit markdown, so autolinking
 * could only ever invent one; the flattened prose of `<PermissionPipeline />` is where
 * it did.
 */
const md = new MarkdownIt({ html: true, xhtmlOut: true, linkify: false, typographer: false });

/** `05-one-event` → `text/05-one-event.xhtml`; the front matter keeps its own name. */
const fileFor = (page: BookPage): string => `text/${page.slug}.xhtml`;

/**
 * The manifest id for a chapter.
 *
 * The `ch-` prefix is not decoration. A manifest `id` is an XML `ID`, and an XML name
 * **may not start with a digit** — so `01-why-a-substrate`, the obvious id, is invalid,
 * and an EPUB whose package document fails to parse is one Apple Books silently
 * declines to open. Ten chapters are numbered, so ten ids were wrong.
 *
 * A strict XML parser does not catch this: `id` is only an `ID` by virtue of the OPF
 * schema, and well-formedness has nothing to say about it. `idOf` is therefore the one
 * place ids are minted, and `test/epub.test.mts` holds every id in the package document
 * to the XML name production directly.
 */
const idOf = (page: BookPage): string => `ch-${page.slug}`;

/**
 * Fix up the twin's links for a reader holding a phone.
 *
 * `toTwin` makes every link absolute and points it at the `.md` twin. Both are right
 * for `book.txt` — a reader of that file has no site root, and wants markdown when it
 * follows a link. Both are wrong here, in different ways:
 *
 *   - A cross-reference to another **chapter** should turn the page, not leave for
 *     Safari. Those become relative `.xhtml` links, which is why the EPUB keeps one
 *     file per chapter rather than one long document.
 *   - A link **out** of the book (`/concepts/model`) genuinely does go to the web, but
 *     to the *page* — a human tapping it wants the rendered article, not the raw
 *     markdown twin. So the `.md` comes off.
 *
 * `/book.txt` and `/book/read.html` survive both rules intact: they are the other
 * editions, they really do live on the web, and neither is inside this file.
 */
function relinkForEpub(html: string): string {
  return html
    .replace(
      new RegExp(`${SITE}/book/([a-z0-9-]+)\\.md`, 'g'),
      (_m, slug: string) => `${slug}.xhtml`,
    )
    .replace(new RegExp(`${SITE}/book/index\\.md`, 'g'), 'index.xhtml')
    .replace(new RegExp(`(${SITE}/[^"']*?)\\.md(?=["'#])`, 'g'), '$1');
}

/** One chapter as an XHTML document. */
function chapterDoc(page: BookPage): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="${LANGUAGE}" xml:lang="${LANGUAGE}">
<head>
<meta charset="UTF-8"/>
<title>${xml(page.text)}</title>
<link rel="stylesheet" type="text/css" href="../style.css"/>
</head>
<body epub:type="${page.slug === 'index' ? 'frontmatter' : 'bodymatter'}">
<section epub:type="chapter">
${relinkForEpub(md.render(page.markdown))}
</section>
</body>
</html>
`;
}

/** The title page — the first thing the reader sees on opening. */
function titlePage(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="${LANGUAGE}" xml:lang="${LANGUAGE}">
<head>
<meta charset="UTF-8"/>
<title>${xml(TITLE)}</title>
<link rel="stylesheet" type="text/css" href="style.css"/>
</head>
<body epub:type="frontmatter">
<section epub:type="titlepage" class="titlepage">
<h1 class="booktitle">Substrat,<br/>end to end</h1>
<p class="subtitle">How the pieces join — ten chapters, front to back.</p>
<p class="imprint">${xml(SITE)}</p>
</section>
</body>
</html>
`;
}

/** The EPUB 3 navigation document. Doubles as the reader's table of contents. */
function navDoc(pages: BookPage[]): string {
  const items = pages
    .map((p) => `      <li><a href="${fileFor(p)}">${xml(p.text)}</a></li>`)
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="${LANGUAGE}" xml:lang="${LANGUAGE}">
<head>
<meta charset="UTF-8"/>
<title>Contents</title>
<link rel="stylesheet" type="text/css" href="style.css"/>
</head>
<body>
<nav epub:type="toc" id="toc" class="toc">
  <h1>Contents</h1>
  <ol>
${items}
  </ol>
</nav>
<nav epub:type="landmarks" hidden="hidden">
  <ol>
    <li><a epub:type="toc" href="nav.xhtml">Contents</a></li>
    <li><a epub:type="bodymatter" href="${fileFor(pages[1]!)}">Start of content</a></li>
  </ol>
</nav>
</body>
</html>
`;
}

/**
 * The EPUB 2 navigation map.
 *
 * EPUB 3 replaced it with `nav.xhtml` above, and it is included anyway because
 * several shipping readers still look for it first and show an empty table of
 * contents when it is absent. It costs a kilobyte.
 */
function ncxDoc(pages: BookPage[]): string {
  const points = pages
    .map(
      (p, i) => `  <navPoint id="nav${i + 1}" playOrder="${i + 1}">
    <navLabel><text>${xml(p.text)}</text></navLabel>
    <content src="${fileFor(p)}"/>
  </navPoint>`,
    )
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
<head>
  <meta name="dtb:uid" content="${BOOK_ID}"/>
  <meta name="dtb:depth" content="1"/>
  <meta name="dtb:totalPageCount" content="0"/>
  <meta name="dtb:maxPageNumber" content="0"/>
</head>
<docTitle><text>${xml(TITLE)}</text></docTitle>
<navMap>
${points}
</navMap>
</ncx>
`;
}

/** The package document: metadata, every file in the zip, and the reading order. */
function packageDoc(pages: BookPage[], modified: string, hasCover: boolean): string {
  const chapterItems = pages
    .map(
      (p) =>
        `    <item id="${idOf(p)}" href="${fileFor(p)}" media-type="application/xhtml+xml"/>`,
    )
    .join('\n');
  const spine = pages.map((p) => `    <itemref idref="${idOf(p)}"/>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="book-id" xml:lang="${LANGUAGE}">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="book-id">${BOOK_ID}</dc:identifier>
    <dc:title>${xml(TITLE)}</dc:title>
    <dc:creator>${xml(AUTHOR)}</dc:creator>
    <dc:language>${LANGUAGE}</dc:language>
    <dc:publisher>${xml(AUTHOR)}</dc:publisher>
    <dc:description>How Substrat works, end to end: the path of one request, the life of one event, the two clocks, and everything a reference page cannot say about how the pieces join.</dc:description>
    <dc:source>${xml(`${SITE}/book/`)}</dc:source>
    <meta property="dcterms:modified">${modified}</meta>
${hasCover ? '    <meta name="cover" content="cover-image"/>\n' : ''}  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
    <item id="style" href="style.css" media-type="text/css"/>
    <item id="titlepage" href="titlepage.xhtml" media-type="application/xhtml+xml"/>
${hasCover ? '    <item id="cover-image" href="cover.png" media-type="image/png" properties="cover-image"/>\n' : ''}${chapterItems}
  </manifest>
  <spine toc="ncx">
    <itemref idref="titlepage"/>
    <itemref idref="nav"/>
${spine}
  </spine>
</package>
`;
}

/** The reading stylesheet. Restrained on purpose — the reader owns type size and theme. */
const STYLE = `@namespace epub "http://www.idpf.org/2007/ops";

body { margin: 0 5%; line-height: 1.5; widows: 2; orphans: 2; }
h1, h2, h3, h4 { line-height: 1.25; margin: 1.6em 0 0.6em; page-break-after: avoid; }
h1 { font-size: 1.6em; margin-top: 0; }
h2 { font-size: 1.25em; }
h3 { font-size: 1.08em; }
p { margin: 0 0 0.9em; text-align: left; }
a { text-decoration: underline; }
code, pre { font-family: "SF Mono", Menlo, Consolas, monospace; }
code { font-size: 0.85em; }
pre { font-size: 0.72em; line-height: 1.4; padding: 0.7em; margin: 0 0 1em;
      background: rgba(127,127,127,0.12); border-radius: 4px;
      white-space: pre-wrap; word-wrap: break-word; page-break-inside: avoid; }
pre code { font-size: 1em; }
blockquote { margin: 0 0 1em 1em; padding-left: 0.9em;
             border-left: 3px solid rgba(127,127,127,0.5); font-style: italic; }
ul, ol { margin: 0 0 1em; padding-left: 1.3em; }
li { margin-bottom: 0.35em; }
hr { border: 0; border-top: 1px solid rgba(127,127,127,0.4); margin: 2em 0; }
table { border-collapse: collapse; width: 100%; font-size: 0.8em; margin: 0 0 1em; }
th, td { border: 1px solid rgba(127,127,127,0.5); padding: 0.35em 0.5em;
         text-align: left; vertical-align: top; }
th { font-weight: bold; }

/*
 * The contents page numbers itself twice otherwise. EPUB 3 requires the toc to be an
 * ordered list, and a reader draws that list's markers — but every chapter title opens
 * with its own number, because the number is part of the chapter's name and has to
 * survive into a reader's own table-of-contents panel, which ignores this stylesheet.
 * So the title keeps the number and the list marker goes.
 */
.toc ol { list-style: none; padding-left: 0; }
.toc ol li { margin-bottom: 0.6em; }
.toc ol a { text-decoration: none; }

.titlepage { text-align: center; padding-top: 22%; }
.booktitle { font-size: 2.1em; line-height: 1.15; margin: 0 0 0.7em; }
.subtitle { font-size: 1.05em; font-style: italic; margin: 0 0 3em; }
.imprint { font-size: 0.85em; }
`;

/**
 * Build the EPUB.
 *
 * `mimetype` is added first with `level: 0` (stored). fflate writes entries in the
 * order given, so those two facts together are what make the archive an EPUB rather
 * than a zip full of EPUB-shaped files.
 */
export function buildEpub(srcDir: string, coverPng?: Uint8Array): Uint8Array {
  const pages = bookPages(srcDir);
  // Second-resolution UTC, which is the only form `dcterms:modified` accepts.
  const modified = `${new Date().toISOString().slice(0, 19)}Z`;
  const hasCover = coverPng !== undefined && coverPng.length > 0;

  const files: Record<string, [Uint8Array, { level: 0 | 6 }]> = {
    mimetype: [strToU8('application/epub+zip'), { level: 0 }],
    'META-INF/container.xml': [
      strToU8(`<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="EPUB/package.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>
`),
      { level: 6 },
    ],
    'EPUB/package.opf': [strToU8(packageDoc(pages, modified, hasCover)), { level: 6 }],
    'EPUB/nav.xhtml': [strToU8(navDoc(pages)), { level: 6 }],
    'EPUB/toc.ncx': [strToU8(ncxDoc(pages)), { level: 6 }],
    'EPUB/style.css': [strToU8(STYLE), { level: 6 }],
    'EPUB/titlepage.xhtml': [strToU8(titlePage()), { level: 6 }],
  };
  if (hasCover) files['EPUB/cover.png'] = [coverPng, { level: 6 }];
  for (const page of pages) {
    files[`EPUB/${fileFor(page)}`] = [strToU8(chapterDoc(page)), { level: 6 }];
  }

  return zipSync(files as unknown as Parameters<typeof zipSync>[0], { level: 6 });
}

/** The checked-in cover asset, or undefined when it is absent. */
export function readCover(srcDir: string): Uint8Array | undefined {
  try {
    return new Uint8Array(readFileSync(join(srcDir, 'assets/book-cover.png')));
  } catch {
    return undefined;
  }
}

export function epubArtifacts(srcDir: string): Artifact[] {
  return [{ path: 'book.epub', contents: buildEpub(srcDir, readCover(srcDir)) }];
}
