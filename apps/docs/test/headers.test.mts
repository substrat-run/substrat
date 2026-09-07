/**
 * The origin guard, driven by hand-written markup rather than by a built site.
 *
 * A built site only contains the tags VitePress happens to emit today, so running
 * the guard over `dist` proves nothing about the case that actually bites: someone
 * adds a font or an analytics snippet, writes it in a shape the parser misses, and
 * the build stays green while the resource dies in production. These are the shapes.
 */
import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertNoUnallowedOrigins,
  csp,
  externalResourceUrls,
  deskOrigins,
} from '../.vitepress/headers.mts';

const FONT = 'https://fonts.example/style.css';

describe('externalResourceUrls', () => {
  it('collects a stylesheet with rel before href', () => {
    expect(externalResourceUrls(`<link rel="stylesheet" href="${FONT}">`)).toEqual([FONT]);
  });

  // The regression: valid markup, and every attribute in the other order.
  it('collects a stylesheet with href before rel', () => {
    expect(externalResourceUrls(`<link href="${FONT}" rel="stylesheet">`)).toEqual([FONT]);
  });

  it('collects preload and modulepreload in either order', () => {
    const html = [
      `<link href="${FONT}" rel="preload" as="style">`,
      `<link rel="modulepreload" href="https://cdn.example/m.js">`,
      `<link as="script" href="https://cdn.example/p.js" rel="preload">`,
    ].join('\n');
    expect(externalResourceUrls(html)).toEqual([
      FONT,
      'https://cdn.example/m.js',
      'https://cdn.example/p.js',
    ]);
  });

  it('reads single-quoted and unquoted attribute values', () => {
    const html = [
      `<link href='${FONT}' rel='stylesheet'>`,
      `<script src='https://cdn.example/a.js'></script>`,
      `<link rel=stylesheet href=https://cdn.example/b.css>`,
    ].join('\n');
    expect(externalResourceUrls(html)).toEqual([
      FONT,
      'https://cdn.example/a.js',
      'https://cdn.example/b.css',
    ]);
  });

  it('collects script, img and iframe sources', () => {
    const html = [
      `<script defer src="https://cdn.example/a.js"></script>`,
      `<img alt="" src="https://cdn.example/a.png">`,
      `<iframe src="https://video.example/embed" title="v"></iframe>`,
    ].join('\n');
    expect(externalResourceUrls(html)).toEqual([
      'https://cdn.example/a.js',
      'https://cdn.example/a.png',
      'https://video.example/embed',
    ]);
  });

  it('ignores what the CSP does not govern', () => {
    const html = [
      // A navigation link is not a fetch, and the site links out on every page.
      `<a href="https://github.com/substrat-run/substrat">source</a>`,
      // Neither are the rel values that only hint at a connection.
      `<link rel="canonical" href="https://substrat.net/">`,
      `<link rel="dns-prefetch" href="https://fonts.example">`,
      // Inline scripts are covered by their hash, not by an origin.
      `<script>console.log('inline')</script>`,
      // Same-origin and inlined payloads need no entry.
      `<script src="/assets/app.js"></script>`,
      `<img src="data:image/gif;base64,R0lGOD">`,
    ].join('\n');
    expect(externalResourceUrls(html)).toEqual([]);
  });
});

function siteWith(html: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'docs-headers-'));
  mkdirSync(join(dir, 'guide'), { recursive: true });
  writeFileSync(join(dir, 'index.html'), '<html><body>nothing external</body></html>');
  writeFileSync(join(dir, 'guide', 'page.html'), html);
  return dir;
}

describe('assertNoUnallowedOrigins', () => {
  it('names the offending origin, whichever order the attributes are in', () => {
    const dir = siteWith(`<link href="${FONT}" rel="stylesheet">`);
    expect(() => assertNoUnallowedOrigins(dir, [])).toThrowError(/https:\/\/fonts\.example/);
  });

  it('passes an origin the policy allows', () => {
    const dir = siteWith(`<script src="https://ticket0.example/widget.js"></script>`);
    expect(() => assertNoUnallowedOrigins(dir, ['https://ticket0.example'])).not.toThrow();
  });

  it('passes a site that loads nothing external', () => {
    const dir = siteWith(`<script src="/assets/app.js"></script>`);
    expect(() => assertNoUnallowedOrigins(dir, [])).not.toThrow();
  });
});

describe('csp', () => {
  it('names the widget origin in both the directives that have to agree', () => {
    const policy = csp(["'sha256-abc'"], ['https://ticket0.example']);
    expect(policy).toContain(`script-src 'self' 'sha256-abc' https://ticket0.example`);
    expect(policy).toContain(`connect-src 'self' https://ticket0.example`);
  });

  it('leaves the directives bare when the widget is off', () => {
    const policy = csp(["'sha256-abc'"]);
    expect(policy).toContain(`script-src 'self' 'sha256-abc';`);
    expect(policy).toContain(`connect-src 'self';`);
  });
});

/**
 * The desk a page names itself.
 *
 * This is the case the built site cannot show: the widget appends its `<script>` from
 * JavaScript and a signup form `fetch`es from script, so the origin guard sees nothing,
 * the build is green, and the browser is the first thing to notice — on production,
 * where the header is real.
 */
describe('deskOrigins', () => {
  function pages(...markdown: string[]): string {
    const dir = mkdtempSync(join(tmpdir(), 'docs-widget-'));
    mkdirSync(join(dir, 'guide'), { recursive: true });
    markdown.forEach((md, i) => writeFileSync(join(dir, 'guide', `p${i}.md`), md));
    return dir;
  }

  it('reads the desk out of a mounted component', () => {
    const dir = pages('# Support\n\n<Ticket0Widget desk="https://ticket0.example" />\n');
    expect(deskOrigins(dir)).toEqual(['https://ticket0.example']);
  });

  it('reduces a desk to its origin and reports each one once', () => {
    const dir = pages(
      `<Ticket0Widget desk="https://ticket0.example/" />`,
      `<Ticket0Widget class="x" desk='https://ticket0.example' />`,
      `<Ticket0Widget desk="https://other.example" />`,
    );
    expect(deskOrigins(dir)).toEqual(['https://other.example', 'https://ticket0.example']);
  });

  it('finds nothing in pages that mount nothing', () => {
    expect(deskOrigins(pages('# Just prose'))).toEqual([]);
  });

  /**
   * The generalization, and the reason it is keyed on the attribute rather than on a
   * list of component names: a signup form talks to the same desk over `fetch`, and it
   * has to reach the policy without anybody editing a regex in a security file.
   */
  it('reads the desk off any component that names one', () => {
    const dir = pages(
      `<SignupForm kind="newsletter" desk="https://ticket0.example" />`,
      `<Marketing desk="https://ticket0.example" />`,
    );
    expect(deskOrigins(dir)).toEqual(['https://ticket0.example']);
  });

  // A plain HTML element must not be able to widen the policy — only a Vue component,
  // which is what the leading capital is doing in the pattern.
  it('ignores a desk attribute on an ordinary element', () => {
    expect(deskOrigins(pages('<div desk="https://evil.example">hi</div>'))).toEqual([]);
  });

  /**
   * The near-miss, which is the one a word boundary lets through: `\bdesk` matches the
   * `desk` in `data-desk`, because the boundary sits between the hyphen and the `d`. An
   * attribute nothing reads would then have decided what the site may load.
   */
  it('ignores an attribute that merely ends in "desk"', () => {
    const dir = pages(
      '<SignupForm data-desk="https://third-party.example" />',
      '<Ticket0Widget my-desk="https://other.example" />',
    );
    expect(deskOrigins(dir)).toEqual([]);
  });

  /**
   * And the one a whitespace requirement still lets through: text that reads like an
   * attribute but sits inside another attribute's VALUE. A regex over a tag cannot know
   * where a value ends, which is why the scan parses the attributes instead.
   */
  it('ignores a desk that is text inside another attribute’s value', () => {
    const dir = pages(
      `<SignupForm title='demo desk="https://third-party.example"' />`,
      `<Ticket0Widget alt="a desk='https://other.example' in prose" />`,
    );
    expect(deskOrigins(dir)).toEqual([]);
  });

  // The parser must not lose the real one when a decoy attribute sits beside it.
  it('finds the real desk beside an attribute that mentions one', () => {
    const dir = pages(
      `<SignupForm title='demo desk="https://third-party.example"' desk="https://ticket0.example" />`,
    );
    expect(deskOrigins(dir)).toEqual(['https://ticket0.example']);
  });

  // The regression itself: the desk the checked-in pages name — the support widget, and
  // now the two signup forms — has to end up in the policy with the site-wide flag
  // unset, which is how production builds.
  it('puts every desk the docs mount into the policy', () => {
    const docs = fileURLToPath(new URL('..', import.meta.url));
    const desks = deskOrigins(docs);
    expect(desks).toContain('https://ticket0.substrat.net');
    const policy = csp([], desks);
    expect(policy).toContain(`script-src 'self' ${desks.join(' ')}`);
    expect(policy).toContain(`connect-src 'self' ${desks.join(' ')}`);
  });
});
