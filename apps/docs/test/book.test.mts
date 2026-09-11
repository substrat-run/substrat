/**
 * The single-file book editions (#1401).
 *
 * The web book and the printed book are the same eleven files, transformed —
 * headings pushed down a level, the front matter's duplicate title dropped, each
 * chapter's "Next" link removed because in one file the next chapter is the next
 * paragraph. Those transformations are exactly where a silent regression would
 * live: nothing about a book with two `h1`s or a stray "Next →" fails a build.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bookChapters } from '../.vitepress/sidebar.mjs';
import { bookMarkdown, bookHtml } from '../.vitepress/book.mjs';

const SRC = resolve(fileURLToPath(import.meta.url), '../..');
const md = bookMarkdown(SRC);

describe('the concatenated book', () => {
  it('has exactly one h1 — the book is one document, not eleven', () => {
    expect(md.split('\n').filter((l) => /^# /.test(l))).toEqual(['# Substrat, end to end']);
  });

  it('carries every chapter as an h2, in sidebar order', () => {
    // The front matter contributes h2s of its own, so assert the chapter titles are
    // present in order rather than that they are the only h2s.
    const chapterTitles = bookChapters()
      .slice(1)
      .map((c) => `## ${c.text}`);
    const found = md.split('\n').filter((l) => chapterTitles.includes(l));
    expect(found).toEqual(chapterTitles);
  });

  it('drops the per-page Next links', () => {
    expect(md).not.toContain('**Next:**');
    expect(md).not.toContain('That is the end of the book.');
  });

  it('flattens theme components to their prose rather than leaving tags', () => {
    // `<ScopeTopology />` and friends are Vue; in a file there is nothing to render
    // them, so `toTwin` must have replaced each with the text it draws.
    expect(md).not.toMatch(/^<[A-Z]\w*[^>]*\/>$/m);
    expect(md).toContain('No query crosses these lines');
  });

  it('rewrites internal links to absolute ones — a file reader has no site root', () => {
    const relative = [...md.matchAll(/\]\((\/[^)]*)\)/g)].map((m) => m[1]);
    expect(relative).toEqual([]);
  });

  it('leaves fenced code alone when demoting headings', () => {
    // Chapter 5 quotes SQL containing no `#`, but chapter 8 quotes shell. A `#` line
    // inside a fence must not have gained one.
    expect(md).not.toMatch(/^#+ substrat push$/m);
  });
});

describe('the printable edition', () => {
  const html = bookHtml(SRC);

  it('is a self-contained page with no scripts', () => {
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).not.toContain('<script');
  });

  it('titles itself and names its canonical URL', () => {
    expect(html).toContain('<title>Substrat, end to end</title>');
    expect(html).toContain('https://substrat.net/book/read.html');
  });

  it('renders every chapter', () => {
    for (const chapter of bookChapters().slice(1)) {
      // markdown-it slugs nothing by default, so match the rendered text.
      expect(html).toContain(chapter.text.replace(/&/g, '&amp;'));
    }
  });
});

/**
 * The printable edition is written in `buildEnd`, so VitePress has no route for it.
 * Its router intercepts every same-origin link whose extension it does not recognise
 * as a file — `.html` is one of those — and a link it intercepts but cannot resolve
 * renders the 404 page. The one anchor the router skips is one carrying `target`, so
 * the link on the book's front page is raw HTML, and that is load-bearing rather than
 * stylistic. Nothing else in this repo would notice it turning back into `[…](…)`.
 */
describe('the link to the printable edition', () => {
  const source = readFileSync(join(SRC, 'book/index.md'), 'utf8');

  it('is a raw anchor with a target, which is what makes the SPA router leave it alone', () => {
    expect(source).toContain('<a href="/book/read.html" target="_self">');
    expect(source).not.toContain('](/book/read.html)');
  });

  it('is a plain markdown link again in the twin, which has no router', () => {
    // `toTwin` unwraps the anchor and then absolutizes it, exactly as it would have
    // done for a markdown link — a reader of book.txt is offline and wants both.
    expect(md).toContain('[book/read.html](https://substrat.net/book/read.html)');
    expect(md).not.toContain('<a href=');
  });
});
