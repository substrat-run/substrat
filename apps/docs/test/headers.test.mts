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
import { assertNoUnallowedOrigins, csp, externalResourceUrls } from '../.vitepress/headers.mts';

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
    const policy = csp(["'sha256-abc'"], 'https://ticket0.example');
    expect(policy).toContain(`script-src 'self' 'sha256-abc' https://ticket0.example`);
    expect(policy).toContain(`connect-src 'self' https://ticket0.example`);
  });

  it('leaves the directives bare when the widget is off', () => {
    const policy = csp(["'sha256-abc'"]);
    expect(policy).toContain(`script-src 'self' 'sha256-abc';`);
    expect(policy).toContain(`connect-src 'self';`);
  });
});
