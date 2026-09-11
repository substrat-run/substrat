/**
 * The book's diagrams, rendered for a format that has no JavaScript (#1401).
 *
 * Five chapters draw a figure — `<LayerStack />`, `<TenancyTree />`,
 * `<ScopeTopology />`, `<PermissionPipeline />`, `<BlastRadius />` — and on the web
 * those are Vue components in `theme/components`. Every other edition of the book
 * flattened them to the prose twin in the sibling `*.content.mts` (see `alt.mts`),
 * which is the right answer for `llms.txt` and the wrong one for a reader holding a
 * phone: the whole point of a figure is that the shape arrives before the sentence.
 *
 * So the EPUB gets the picture. Not a redrawing of it — the component itself,
 * server-rendered from the same source the site builds, so there is no second
 * drawing to fall behind the first. Vite does the loading (`.vue` + `<script setup
 * lang="ts">` + the `.content.mts` imports are its job, not ours) and Vue's own SSR
 * renderer produces the markup.
 *
 * ## The three things that make it EPUB-shaped rather than web-shaped
 *
 *   1. **XHTML, not HTML5.** A content document is parsed as XML, where a stray
 *      `&nbsp;` is an undeclared entity and an unclosed tag is a fatal error — and a
 *      reader's response to either is a blank chapter, with no message. `toXhtml`
 *      below is what keeps the SSR output on the right side of that.
 *   2. **No scope ids.** Vue isolates `.fig` in one component from `.fig` in another
 *      with a `data-v-…` attribute per component. We strip those and wrap each figure
 *      in `.figure--<Name>` instead, prefixing the component's own selectors to match
 *      (`scopeCss`). Same isolation, no dependence on a hash the plugin is free to
 *      change.
 *   3. **The tokens travel with it.** The stylesheet is written against design tokens
 *      (`var(--surface-card)`, `var(--layer-kernel)`), which live in `theme/tokens`
 *      and reach the site through the theme's own CSS. An EPUB loads none of that, so
 *      the `:root` declarations are copied onto the figure wrapper — the light set
 *      only. That is deliberate: each figure paints its own card, so it stays legible
 *      when the reader has put the page into night mode, which a half-inherited
 *      palette would not.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createServer } from 'vite';
import vue from '@vitejs/plugin-vue';
import { createSSRApp } from 'vue';
import { renderToString } from 'vue/server-renderer';

/** One `<Name prop="value" />` occurrence, as `toTwin` hands it over. */
export interface FigureRequest {
  name: string;
  props: Record<string, string>;
}

/** Rendered figures, keyed by `figureKey` — a component plus the props it was given. */
export type FigureSet = Map<string, string>;

/**
 * The cache key for one rendering.
 *
 * Props are part of it because a component that takes them draws a different picture
 * for each (`<StateMachine engine="booking" />`). Sorted, so two spellings of the
 * same props are one entry.
 */
export function figureKey(name: string, props: Record<string, string> = {}): string {
  const entries = Object.entries(props).sort(([a], [b]) => a.localeCompare(b));
  return entries.length === 0
    ? name
    : `${name}?${entries.map(([k, v]) => `${k}=${v}`).join('&')}`;
}

/** The component half of a `figureKey` — `StateMachine?engine=booking` → `StateMachine`. */
export const componentOf = (key: string): string => key.split('?')[0]!;

const componentFile = (name: string): string =>
  `/.vitepress/theme/components/${name}.vue`;

/**
 * The named entities a template may carry that XML does not declare.
 *
 * Vue's template compiler already decodes the ones written in a template — `&uarr;`
 * arrives as `↑`. These survive because they come through `v-html` out of a content
 * module, which is inserted verbatim. Three today; an unknown one is left alone and
 * caught by the strict XML parse in `test/epub.test.mts` rather than silently
 * shipping a chapter no reader will open.
 */
const XML_ENTITIES: Record<string, string> = {
  '&nbsp;': ' ',
  '&uarr;': '↑',
  '&darr;': '↓',
};

/**
 * Vue's SSR HTML → a fragment an XML parser accepts.
 *
 * Vue helps more than it looks: it closes every element it writes, including the SVG
 * ones (`<polygon …></polygon>`), so there are no void tags to repair. What is left
 * is the scope attributes, its fragment-boundary comments, the entities above, and
 * the namespace — an inline `<svg>` in XHTML is only SVG if it says so.
 */
function toXhtml(html: string): string {
  let out = html
    .replace(/\s+data-v-[0-9a-f]+(?=[\s/>])/g, '')
    .replace(/<!--[\s\S]*?-->/g, '');
  for (const [entity, char] of Object.entries(XML_ENTITIES)) {
    out = out.replaceAll(entity, char);
  }
  return out.replace(
    /<svg(?![^>]*\sxmlns=)/g,
    '<svg xmlns="http://www.w3.org/2000/svg"',
  );
}

/**
 * Render the components behind `requests`, once each.
 *
 * One Vite server for the whole set: standing it up is the expensive part, and the
 * book asks for five figures. `configFile: false` is deliberate — this must not pick
 * up `.vitepress/config.mts` and recurse into the build that called it.
 */
export async function renderFigures(
  srcDir: string,
  requests: FigureRequest[],
): Promise<FigureSet> {
  const wanted = new Map<string, FigureRequest>();
  for (const request of requests) {
    wanted.set(figureKey(request.name, request.props), request);
  }
  const figures: FigureSet = new Map();
  if (wanted.size === 0) return figures;

  const server = await createServer({
    root: srcDir,
    configFile: false,
    logLevel: 'error',
    appType: 'custom',
    server: { middlewareMode: true, hmr: false },
    // Nothing in this server is served to a browser, so crawling the graph for
    // dependencies to pre-bundle is work with no output.
    optimizeDeps: { noDiscovery: true, include: [] },
    plugins: [vue()],
  });
  try {
    for (const [key, request] of wanted) {
      const module = await server.ssrLoadModule(componentFile(request.name));
      const html = await renderToString(
        createSSRApp(module.default as Parameters<typeof createSSRApp>[0], request.props),
      );
      figures.set(
        key,
        `<div class="figure figure--${request.name}">${toXhtml(html)}</div>`,
      );
    }
  } finally {
    await server.close();
  }
  return figures;
}

/** A component's `<style scoped>` blocks, concatenated; '' when it has none. */
function scopedStyle(srcDir: string, name: string): string {
  const sfc = readFileSync(
    join(srcDir, '.vitepress/theme/components', `${name}.vue`),
    'utf8',
  );
  return [...sfc.matchAll(/<style scoped>([\s\S]*?)<\/style>/g)]
    .map((m) => m[1]!)
    .join('\n');
}

/** At-rules whose body is a block of rules, and therefore has to be scoped too. */
const NESTED_AT_RULES = new Set(['media', 'supports', 'container', 'layer']);

/** Split a selector list on commas that are not inside `(...)`. */
function splitSelectors(list: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = '';
  for (const char of list) {
    if (char === '(') depth += 1;
    else if (char === ')') depth -= 1;
    if (char === ',' && depth === 0) {
      out.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  out.push(current);
  return out;
}

/**
 * One selector, rewritten to apply only inside the figure's wrapper.
 *
 * `:deep(code)` becomes plain `code`: the pierce operator exists to reach past Vue's
 * scope attribute, and there is no scope attribute here — a descendant selector is
 * what it always meant.
 */
function prefixSelector(selector: string, prefix: string): string {
  const cleaned = selector
    .replace(/::v-deep\s*\(([^)]*)\)/g, '$1')
    .replace(/:deep\s*\(([^)]*)\)/g, '$1')
    .trim();
  return cleaned ? `${prefix} ${cleaned}` : prefix;
}

/**
 * Rewrite a stylesheet so every rule in it is confined to `prefix`.
 *
 * A hand-rolled walk rather than a CSS parser, because the input is one component's
 * scoped block: rules, the occasional `@media`, and `content: ""`. It is
 * string-aware so that a brace inside a quoted value cannot end a block early, and
 * it recurses into the at-rules that contain rules while leaving `@keyframes` and
 * `@font-face` — whose bodies are not selectors — exactly as written.
 */
export function scopeCss(css: string, prefix: string): string {
  const source = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const out: string[] = [];
  let prelude = '';
  let index = 0;

  /** Read from `index` to the matching close brace; returns the body. */
  const readBlock = (): string => {
    let depth = 0;
    const start = index;
    let quote = '';
    for (; index < source.length; index += 1) {
      const char = source[index]!;
      if (quote) {
        if (char === '\\') index += 1;
        else if (char === quote) quote = '';
        continue;
      }
      if (char === '"' || char === "'") quote = char;
      else if (char === '{') depth += 1;
      else if (char === '}') {
        depth -= 1;
        if (depth === 0) {
          index += 1;
          return source.slice(start + 1, index - 1);
        }
      }
    }
    return source.slice(start + 1);
  };

  while (index < source.length) {
    const char = source[index]!;
    if (char === '{') {
      const body = readBlock();
      const head = prelude.trim();
      prelude = '';
      if (head.startsWith('@')) {
        const name = /^@([\w-]+)/.exec(head)?.[1] ?? '';
        out.push(
          NESTED_AT_RULES.has(name)
            ? `${head} {\n${scopeCss(body, prefix)}\n}`
            : `${head} {${body}}`,
        );
      } else {
        const selectors = splitSelectors(head)
          .map((s) => prefixSelector(s, prefix))
          .join(', ');
        out.push(`${selectors} {${body}}`);
      }
      continue;
    }
    if (char === ';' && prelude.trim().startsWith('@')) {
      // `@import` / `@charset` — a statement, not a block.
      out.push(`${prelude.trim()};`);
      prelude = '';
      index += 1;
      continue;
    }
    prelude += char;
    index += 1;
  }
  return out.join('\n');
}

/** The design-token files, in the order the theme loads them. */
const TOKEN_FILES = ['colors.css', 'typography.css', 'spacing.css', 'effects.css'];

/**
 * Every `--token: value` declared on `:root`, as one block.
 *
 * Light only, and only the first `:root` of each file — the dark overrides live
 * behind `[data-theme="dark"]`, a switch an EPUB has no way to throw. Custom
 * properties inherit, so declaring them on the wrapper is the same resolution the
 * browser performs, without touching a `:root` the reading system owns.
 */
function tokenDeclarations(srcDir: string): string {
  const declarations: string[] = [];
  for (const file of TOKEN_FILES) {
    const css = readFileSync(join(srcDir, '.vitepress/theme/tokens', file), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '');
    const root = /:root\s*\{([\s\S]*?)\}/.exec(css);
    if (root) declarations.push(root[1]!.trim());
  }
  return declarations.join('\n');
}

/**
 * The stylesheet for a set of figures: the tokens they resolve against, a card to
 * sit on, and each component's own scoped rules confined to its wrapper.
 */
export function figureCss(srcDir: string, names: string[]): string {
  const unique = [...new Set(names)].sort();
  if (unique.length === 0) return '';
  const parts = [
    `/* Figures — the book's diagrams, from .vitepress/theme/components. */`,
    `.figure {\n${tokenDeclarations(srcDir)}\n}`,
    // A figure is a card, so a reader in night mode gets a picture painted on its
    // own light ground rather than near-black strokes on a near-black page.
    `.figure { background: var(--surface-card); color: var(--text-primary);
  padding: 10px 12px; margin: 1.4em 0; border-radius: 6px;
  page-break-inside: avoid; break-inside: avoid; }`,
    `.figure svg { display: block; width: 100%; height: auto; }`,
    `.figure p, .figure h3 { margin: 0; }`,
  ];
  for (const name of unique) {
    const scoped = scopedStyle(srcDir, name).trim();
    if (scoped) parts.push(scopeCss(scoped, `.figure--${name}`).trim());
  }
  return `${parts.join('\n\n')}\n`;
}
