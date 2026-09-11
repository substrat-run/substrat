import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Geist is self-hosted, and it reaches the ADMIN CONSOLE ONLY (#1278 constraints 6, 7).
 *
 * This SPA is one bundle serving two audiences: the issuer's operator, and every person a
 * relying party sends to /login. So the branding decision has a blast radius no rendering
 * test would notice — a `font-family` on `body` instead of `.console-root` puts a webfont
 * fetch on the sign-in path of every customer's app, and the screens still look right.
 * Nothing about that is visible in a snapshot; it is visible in the CSS, which is what
 * these cases read.
 *
 * They parse the source stylesheets rather than the built bundle deliberately. `app/dist`
 * is a build artifact this suite does not produce, and the property is a fact about what
 * the source SAYS — a reviewer editing `console.css` should get the red build, not a
 * deploy that quietly starts calling Google.
 */

const here = dirname(fileURLToPath(import.meta.url));
const appSrc = join(here, '..', 'app', 'src');

/** Every file under `app/src` with one of these extensions — the ban is on the bundle,
 *  not on one file, and a stylesheet is not the only way into the bundle. */
function sourcesUnder(dir: string, extensions: readonly string[]): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, name.name);
    if (name.isDirectory()) out.push(...sourcesUnder(full, extensions));
    else if (extensions.some((ext) => name.name.endsWith(ext))) out.push(full);
  }
  return out.sort();
}

/**
 * The stylesheet with its comments removed. Every case below reads this rather than the
 * raw file, because a comment is prose: `fonts.css` explains at length which CDN it exists
 * to avoid, and a check that cannot tell the explanation from the request would forbid
 * writing the explanation down.
 */
function code(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

/**
 * Rule blocks as `{ selector, body }`. A deliberately small parser: these files carry no
 * nested at-rules other than `@media`, which this flattens — `@media (max-width: 560px) {
 * .console-root .kv { … } }` yields the inner selector, which is the one the property
 * below is about.
 */
function rules(css: string): Array<{ selector: string; body: string }> {
  const out: Array<{ selector: string; body: string }> = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(code(css))) !== null) {
    out.push({ selector: (match[1] ?? '').trim(), body: (match[2] ?? '').trim() });
  }
  return out;
}

const read = (path: string) => ({ path: relative(appSrc, path), text: readFileSync(path, 'utf8') });
const sheets = sourcesUnder(appSrc, ['.css']).map(read);
const modules = sourcesUnder(appSrc, ['.ts', '.tsx']).map(read);

describe('the console webfonts are self-hosted', () => {
  it('no stylesheet reaches a font CDN, directly or through @substrat-run/ui', () => {
    for (const { path, text } of sheets) {
      // `@substrat-run/ui/styles.css` pulls `tokens/fonts.css`, which is an @import of
      // Google's CDN — so importing the barrel is the same defect as writing the URL out,
      // and both are named here rather than only the one that is easy to grep.
      expect(code(text), `${path} must not fetch a font over a CDN`).not.toMatch(
        /fonts\.(googleapis|gstatic)\.com/,
      );
      expect(code(text), `${path} must import @substrat-run/ui tokens individually, not the barrel`).not.toMatch(
        /@import\s+["']@substrat-run\/ui\/(styles\.css|tokens\/fonts\.css)["']/,
      );
    }
  });

  it('no module pulls a stylesheet that would put a face in the global bundle', () => {
    for (const { path, text } of modules) {
      // The bypass the case above cannot see, and the one most likely to be taken: Vite
      // lets a module `import '@fontsource/geist-sans/400.css'`, which is how `apps/docs`
      // self-hosts the same family. Done from `main.tsx` it is global — every subset, on
      // every screen, including the four that answer a relying party. The faces belong to
      // `console/fonts.css`, reached through `console.css`, and that is the only route in.
      expect(text, `${path} must not import a font stylesheet — use console/fonts.css`).not.toMatch(
        /import\s+["'][^"']*(fontsource|@substrat-run\/ui\/(styles\.css|tokens\/fonts\.css))[^"']*["']/,
      );
    }
  });

  it('ships the latin upright subset of each face and nothing else', () => {
    const fonts = sheets.find((s) => s.path === join('console', 'fonts.css'));
    expect(fonts, 'app/src/console/fonts.css is where the faces are declared').toBeDefined();

    const faces = rules(fonts!.text).filter((r) => r.selector === '@font-face');
    expect(faces).toHaveLength(2);

    const sources = faces.map((f) => /url\(([^)]+)\)/.exec(f.body)?.[1] ?? '');
    expect(sources).toEqual([
      '@fontsource-variable/geist/files/geist-latin-wght-normal.woff2',
      '@fontsource-variable/geist-mono/files/geist-mono-latin-wght-normal.woff2',
    ]);

    for (const face of faces) {
      // A variable face, so one file answers `--weight-regular` through `--weight-bold`.
      expect(face.body).toMatch(/font-weight:\s*100 900/);
      // Readable on the fallback stack from the first paint.
      expect(face.body).toMatch(/font-display:\s*swap/);
      // Without a unicode-range a Cyrillic name in the user list renders in Geist's
      // fallback glyphs instead of falling through to a system face that has the letters.
      expect(face.body).toMatch(/unicode-range:/);
    }
  });

  it('applies both families only under .console-root', () => {
    const applied: Array<{ path: string; selector: string }> = [];
    for (const { path, text } of sheets) {
      for (const rule of rules(text)) {
        // Two blocks name a family without applying it to anything, and neither makes a
        // browser fetch a file: `@font-face`, which DEFINES the family, and
        // `:root { --font-sans: 'Geist Variable', … }`, which only declares the token.
        // What costs a request is a rule that puts the family on elements — so that is
        // what is judged, and where it may appear is the whole property.
        if (rule.selector.startsWith('@font-face')) continue;
        if (!/font-family\s*:/.test(rule.body)) continue;
        if (!/Geist|var\(--font-(sans|mono)\)/.test(rule.body)) continue;
        applied.push({ path, selector: rule.selector });
      }
    }

    expect(applied.length, 'the console must apply the branded families somewhere').toBeGreaterThan(0);
    for (const { path, selector } of applied) {
      expect(
        selector.split(',').every((s) => s.trim().startsWith('.console-root')),
        `${path}: "${selector}" applies Geist outside the console — /login, /signup, /consent ` +
          'and /reset-password answer a relying party and must not fetch the issuer\'s branding',
      ).toBe(true);
    }
  });

  it('leaves the themed hand-off vocabulary on the system stack', () => {
    const tokens = sheets.find((s) => s.path === 'tokens.css');
    expect(tokens, 'app/src/tokens.css is the per-client theming contract').toBeDefined();
    // `tokens.css` is loaded last and is what `applyClientTheme` writes through. Geist
    // appearing in it would brand the screens that exist precisely to carry someone
    // else's brand. Comment-stripped, so the file stays free to explain why it is not here.
    expect(code(tokens!.text)).not.toMatch(/Geist/);
  });
});
