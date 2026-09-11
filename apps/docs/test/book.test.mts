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
import { resolve } from 'node:path';
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
