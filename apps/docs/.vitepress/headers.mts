/**
 * The security headers Cloudflare Pages serves with the built site.
 *
 * Pages reads a `_headers` file from the output directory, so this is written
 * into the build the same way the llms.txt artifacts are — by `buildEnd`, into
 * a gitignored `dist`. There is deliberately no checked-in copy: the policy
 * below is the source of truth, `_headers` is build output, and a hand-edit to
 * it cannot survive the next build.
 *
 * ## Why the script hashes are computed rather than written down
 *
 * VitePress inlines three scripts into every page: the dark-mode probe (which
 * has to run before first paint or the page flashes white), the macOS class
 * toggle, and `window.__VP_HASH_MAP__`. The first two are fixed strings; the
 * third embeds a content hash of every page in the site and therefore CHANGES
 * ON EVERY BUILD.
 *
 * That rules out both alternatives. A checked-in hash list would be wrong the
 * first time anyone edited a page — and wrong in the worst way, because the
 * page still renders, only unstyled and stuck in light mode. `'unsafe-inline'`
 * would work forever and buy nothing: it re-permits exactly the injected
 * `<script>` the policy exists to stop.
 *
 * So the hashes are read back out of the HTML VitePress just wrote. Three
 * distinct scripts across 107 pages today; the count is derived, not assumed.
 *
 * ## What is deliberately loose
 *
 * `style-src` keeps `'unsafe-inline'`. Mermaid injects a `<style>` element per
 * diagram at render time and sets inline `style` attributes as it lays them
 * out, so hashing is not available — the content does not exist until the
 * browser has drawn the diagram. An injected stylesheet is a defacement and a
 * data-exfiltration side channel, which is worth naming rather than implying
 * this policy is airtight; it is not script execution.
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';

/** Inline `<script>` — one with a `src` is a fetch, governed by the origin list instead. */
const INLINE_SCRIPT = /<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/g;

function htmlFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...htmlFiles(path));
    else if (entry.name.endsWith('.html')) out.push(path);
  }
  return out;
}

/**
 * Every distinct inline script in the built site, as a CSP source expression.
 *
 * Sorted so a rebuild that changes nothing produces a byte-identical `_headers`
 * — directory order is not guaranteed, and a policy that churns for no reason
 * is one nobody reads the diff of.
 */
export function inlineScriptHashes(outDir: string): string[] {
  const hashes = new Set<string>();
  for (const file of htmlFiles(outDir)) {
    const html = readFileSync(file, 'utf8');
    for (const [, body] of html.matchAll(INLINE_SCRIPT)) {
      hashes.add(`'sha256-${createHash('sha256').update(body ?? '', 'utf8').digest('base64')}'`);
    }
  }
  return [...hashes].sort();
}

/**
 * The policy, as the directive list.
 *
 * `widgetOrigin` is the ticket0 support widget's API when the opt-in build flag
 * is set (config.mts). It is a real third-party script on the docs origin, so
 * it has to be named in both `script-src` and `connect-src` — and the fact that
 * it has to be named is most of why this file is worth having.
 */
export function csp(scriptHashes: string[], widgetOrigin?: string): string {
  const script = ["'self'", ...scriptHashes, widgetOrigin].filter(Boolean);
  const connect = ["'self'", widgetOrigin].filter(Boolean);
  return [
    `default-src 'self'`,
    `script-src ${script.join(' ')}`,
    // See the header: mermaid styles diagrams after the policy is written.
    `style-src 'self' 'unsafe-inline'`,
    // data: — katex and mermaid inline small raster/SVG payloads.
    `img-src 'self' data:`,
    // data: — vp-icons.css inlines its woff2 as base64. Without this the nav,
    // sidebar and external-link icons silently vanish; 96 blocked loads per page.
    `font-src 'self' data:`,
    `connect-src ${connect.join(' ')}`,
    // The site embeds nothing and is embedded by nothing.
    `frame-ancestors 'none'`,
    `frame-src 'none'`,
    `object-src 'none'`,
    // A docs site posts nowhere; both close an injected-markup escape route
    // that script-src does not cover.
    `base-uri 'none'`,
    `form-action 'none'`,
  ].join('; ');
}

/**
 * The tags that can load a subresource the CSP governs.
 *
 * Navigation links are deliberately not collected — CSP does not govern where an
 * `<a href>` goes, and the site links out to GitHub on every page.
 */
const RESOURCE_TAG = /<(script|link|img|iframe)\b([^>]*)>/gi;

/** One attribute: bare, or double-, single- or un-quoted. */
const ATTRIBUTE = /([a-zA-Z_:][-\w:.]*)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s"'`=<>]+))?/g;

/**
 * A tag's attributes, by lowercased name.
 *
 * Order and quote style are the whole point of parsing rather than matching. The
 * regex this replaced required `rel` before `href` and double quotes on both, so
 * `<link href="https://fonts.example/x.css" rel="stylesheet">` — which is what
 * VitePress emits for a `head` entry whose object happens to put `href` first —
 * walked straight past the guard and failed in the browser instead.
 */
function attributes(raw: string): Map<string, string> {
  const attrs = new Map<string, string>();
  for (const match of raw.matchAll(ATTRIBUTE)) {
    const name = (match[1] ?? '').toLowerCase();
    const value = match[2] ?? '';
    const unquoted = /^["']/.test(value) ? value.slice(1, -1) : value;
    // First wins, as a browser does with a repeated attribute.
    if (name && !attrs.has(name)) attrs.set(name, unquoted);
  }
  return attrs;
}

/** The `rel` values that make a `<link href>` a fetch rather than a hint or a link. */
const FETCHING_RELS = new Set(['stylesheet', 'preload', 'modulepreload']);

/**
 * Every absolute http(s) subresource the HTML loads.
 *
 * Exported for the test: the parsing is the part with the sharp edge, and driving
 * it through a built site would only prove the cases that site happens to contain.
 */
export function externalResourceUrls(html: string): string[] {
  const urls: string[] = [];
  for (const match of html.matchAll(RESOURCE_TAG)) {
    const tag = (match[1] ?? '').toLowerCase();
    const attrs = attributes(match[2] ?? '');
    const url =
      tag === 'link'
        ? (attrs.get('rel') ?? '')
            .toLowerCase()
            .split(/\s+/)
            .some((rel) => FETCHING_RELS.has(rel))
          ? attrs.get('href')
          : undefined
        : attrs.get('src');
    // A relative or `data:` URL is same-origin or already named in the policy;
    // only another origin can be the thing the CSP has not been told about.
    if (url && /^https?:\/\//i.test(url)) urls.push(url);
  }
  return urls;
}

/**
 * Refuse to emit a policy the built site already violates.
 *
 * The failure this guards against is silent and one-directional: add a font from
 * Google, an analytics snippet, an embedded video, and the page keeps building,
 * keeps passing every test in the repo, and loses that resource only once it is
 * behind the real header in production. The browser is the only thing that would
 * have told you, and by then it is telling a visitor.
 *
 * So the check runs where the policy is written, against the HTML it is written
 * for, and says which origin to add and to which directive.
 */
export function assertNoUnallowedOrigins(outDir: string, allowed: readonly string[]): void {
  const permitted = new Set(allowed.map((o) => new URL(o).origin));
  const offenders = new Map<string, string>();
  for (const file of htmlFiles(outDir)) {
    for (const url of externalResourceUrls(readFileSync(file, 'utf8'))) {
      const origin = new URL(url).origin;
      if (!permitted.has(origin)) offenders.set(origin, file);
    }
  }
  if (offenders.size === 0) return;
  const lines = [...offenders].map(([origin, file]) => `  ${origin} (first seen in ${file})`);
  throw new Error(
    `headers.mts: the built site loads resources from origins the CSP does not allow:\n${lines.join('\n')}\n` +
      `Add each to the right directive in csp() — or drop the resource. Shipping as-is ` +
      `builds green and breaks in the browser, on production only.`,
  );
}

/** Write `_headers` into the built site. */
export function emitHeaders(outDir: string, widgetOrigin?: string): string {
  assertNoUnallowedOrigins(outDir, widgetOrigin ? [widgetOrigin] : []);
  const policy = csp(inlineScriptHashes(outDir), widgetOrigin);
  const body = [
    '# GENERATED by .vitepress/headers.mts during `vitepress build` — do not edit by hand.',
    '# The script hashes are read out of the built HTML, so they follow every rebuild.',
    '/*',
    `  Content-Security-Policy: ${policy}`,
    '  X-Frame-Options: DENY',
    '  X-Content-Type-Options: nosniff',
    '  Referrer-Policy: strict-origin-when-cross-origin',
    // No camera/mic/geolocation anywhere on a documentation site.
    '  Permissions-Policy: accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()',
    '  Strict-Transport-Security: max-age=31536000; includeSubDomains',
    '',
  ].join('\n');
  writeFileSync(resolve(outDir, '_headers'), body);
  return policy;
}
