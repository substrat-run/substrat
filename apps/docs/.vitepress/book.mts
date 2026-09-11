/**
 * The single-file editions of the book (#1401).
 *
 * The book is eleven chapter pages with prev/next, which is the right shape for
 * reading it in a browser and the wrong shape for printing it, converting it with
 * `pandoc`, or handing it to a model in one shot. So the build also emits the whole
 * thing twice more:
 *
 *   - **`/book.txt`** — every chapter concatenated as plain markdown.
 *   - **`/book/read.html`** — the same content as one scrolling, printable page.
 *
 * Why this rides `buildEnd` rather than checking a concatenated file into the repo:
 * a checked-in copy would be a second, drifting transcript of eleven files, and the
 * repo's rule for a generated file is that something must *refuse* when it drifts.
 * Emitting into `outDir` removes the drift instead of policing it — there is no
 * second copy to fall behind. `pnpm lint:llms --check` covers the same ground for
 * the markdown twins, and the chapter list has exactly one home
 * (`bookChapters()` in sidebar.mts), read by the nav and by this file both.
 *
 * The markdown is the twin, not the raw source: `toTwin` is what flattens a
 * `<ScopeTopology />` to the prose it renders and rewrites internal links to
 * absolute ones. A reader of book.txt is offline, so a relative link would be dead.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import MarkdownIt from 'markdown-it';
import { bookChapters, fileForLink } from './sidebar.mjs';
import { SITE, toTwin, type Artifact } from './llms.mjs';

/** The book's own title, used for the `<title>` and the markdown H1. */
const TITLE = 'Substrat, end to end';

/** Strip a leading `---` frontmatter block. Chapters carry none today; cheap insurance. */
const stripFrontmatter = (raw: string): string =>
  raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');

/**
 * Drop a chapter's trailing `**Next:** [...]` navigation line.
 *
 * It is right on a web page and wrong in a single file, where the next chapter is
 * the next thing on the page — a "Next" link there tells the reader to jump to
 * where they already are.
 */
const stripNextLink = (body: string): string =>
  body.replace(/\n---\n+\s*(\*\*Next:\*\*|\*That is the end of the book\.)[\s\S]*$/, '\n');

/**
 * Push every heading down one level, so the concatenated book has ONE `h1` (its
 * title), each chapter as an `h2`, and each chapter's sections below that. On the
 * web each chapter is its own page and owns an `h1`; stacked into one document
 * those eleven `h1`s would be eleven documents rather than one book, and the print
 * rule below — a page break per chapter — would have nothing to key on.
 *
 * Fenced code is skipped: a `# comment` inside a shell block is not a heading.
 */
function demoteHeadings(body: string): string {
  let fenced = false;
  return body
    .split('\n')
    .map((line) => {
      if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
      if (fenced) return line;
      return /^#{1,5} /.test(line) ? `#${line}` : line;
    })
    .join('\n');
}

/** One chapter, as markdown ready to concatenate. `demote` is false for the front matter. */
function chapterMarkdown(srcDir: string, link: string, demote = true): string {
  const raw = readFileSync(join(srcDir, fileForLink(link)), 'utf8');
  const body = stripNextLink(stripFrontmatter(toTwin(raw, srcDir))).trimEnd();
  return demote ? demoteHeadings(body) : body;
}

/**
 * The whole book as one markdown document, chapters in sidebar order.
 *
 * The first chapter is the front matter ("How to read this"), whose own title IS the
 * book's title — so its heading is dropped rather than demoted, and the document's
 * single `h1` is written here instead. Otherwise the title would appear twice, once
 * as the document and once as its own first section.
 */
export function bookMarkdown(srcDir: string): string {
  const [frontLink, ...chapterLinks] = bookChapters();
  // The front matter keeps its own heading levels: it sits directly under the
  // document title with no chapter wrapper, so demoting it would open at `h3`.
  const front = chapterMarkdown(srcDir, frontLink!.link, false);
  const chapters = chapterLinks.map((c) => chapterMarkdown(srcDir, c.link));
  return [
    `# ${TITLE}`,
    '',
    `The Substrat book, in one file. Published at ${SITE}/book/ — this edition is`,
    'generated from those chapters at build time, so it cannot fall behind them.',
    '',
    front.replace(/^# .*\n+/, ''),
    '',
    chapters.join('\n\n---\n\n'),
    '',
  ].join('\n');
}

/**
 * The printable HTML edition.
 *
 * Deliberately self-contained and theme-free: no nav, no search, no site chrome,
 * one column, a print stylesheet. Its whole job is to be the thing you hit ⌘P on
 * or save as a PDF, which the chapter pages are bad at and this is good at.
 */
export function bookHtml(srcDir: string): string {
  const md = new MarkdownIt({ html: true, linkify: true, typographer: false });
  const body = md.render(bookMarkdown(srcDir));
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${TITLE}</title>
<link rel="canonical" href="${SITE}/book/read.html">
<style>
  :root { color-scheme: light dark; --fg: #1a1a1a; --muted: #5a5a5a; --bg: #fff;
          --rule: #e2e2e2; --code-bg: #f5f5f4; --accent: #0b6b62; }
  @media (prefers-color-scheme: dark) {
    :root { --fg: #e8e8e8; --muted: #a0a0a0; --bg: #16161a;
            --rule: #2e2e33; --code-bg: #202027; --accent: #5fd3c4; }
  }
  * { box-sizing: border-box; }
  body { margin: 0 auto; padding: 3rem 1.25rem 6rem; max-width: 44rem;
         background: var(--bg); color: var(--fg); line-height: 1.65;
         font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
         font-size: 17px; }
  h1, h2, h3, h4 { line-height: 1.25; font-weight: 650; margin: 2.5em 0 0.6em; }
  h1 { font-size: 2rem; margin-top: 0; }
  h1 + p { color: var(--muted); }
  h2 { font-size: 1.45rem; padding-top: 0.6em; border-top: 1px solid var(--rule); }
  h3 { font-size: 1.15rem; }
  p, ul, ol, blockquote, table { margin: 0 0 1.1em; }
  a { color: var(--accent); text-decoration: none; }
  a:hover { text-decoration: underline; }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.87em;
         background: var(--code-bg); padding: 0.15em 0.35em; border-radius: 4px; }
  pre { background: var(--code-bg); padding: 1rem; border-radius: 8px;
        overflow-x: auto; font-size: 0.85em; line-height: 1.5; }
  pre code { background: none; padding: 0; font-size: 1em; }
  blockquote { margin-left: 0; padding: 0.2em 0 0.2em 1.1em;
               border-left: 3px solid var(--accent); color: var(--muted); }
  table { border-collapse: collapse; width: 100%; font-size: 0.93em; display: block;
          overflow-x: auto; }
  th, td { border: 1px solid var(--rule); padding: 0.45em 0.7em; text-align: left;
           vertical-align: top; }
  th { background: var(--code-bg); font-weight: 600; }
  hr { border: 0; border-top: 1px solid var(--rule); margin: 3.5em 0; }
  @media print {
    body { max-width: none; font-size: 11pt; padding: 0; color: #000; background: #fff; }
    a { color: #000; text-decoration: underline; }
    h2 { break-before: page; }
    h1 + p { break-after: auto; }
    pre, blockquote, table { break-inside: avoid; }
  }
</style>
</head>
<body>
${body}
</body>
</html>
`;
}

export function bookArtifacts(srcDir: string): Artifact[] {
  return [
    { path: 'book.txt', contents: bookMarkdown(srcDir) },
    { path: 'book/read.html', contents: bookHtml(srcDir) },
  ];
}
