/**
 * What each subpath brings with it. An element registers itself and pulls in its Web Awesome
 * components as a side effect, so a bundler cannot shake one out of the package root: importing
 * `SubAvatar` from there ships the entity table too. A subpath is the way around that, and it
 * only saves anything while its module stays clear of the other elements. Read from the source,
 * because importing an element needs a DOM this suite does not have.
 */
import { describe, expect, it } from 'vitest';
import pkg from '../package.json';

const ELEMENTS = ['avatar', 'entity-table', 'user-menu'];

/** Which elements each subpath ships. `./user-menu` draws a `<sub-avatar>`, so it carries one. */
const CARRIES: Record<string, string[]> = {
  './avatar': ['avatar'],
  './user-menu': ['avatar', 'user-menu'],
  './entity-table': ['entity-table'],
  './entity-table-model': [],
  './session': [],
  './controls': [],
};

/** `./jsx` is types and `./themes/*` is CSS, so neither has a module graph to hold. */
const NOT_MODULES = new Set(['.', './jsx', './themes/*']);

const exported = Object.keys(pkg.exports);

declare global {
  interface ImportMeta {
    glob(pattern: string, options: { query: string; import: string; eager: true }): Record<string, string>;
  }
}

/** Every module's text. Vite's glob, not `node:fs`: this is a browser package, with no node types to compile against. */
const SOURCES = import.meta.glob('../src/**/*.ts', { query: '?raw', import: 'default', eager: true });

/** The specifiers a module imports at run time: every `import`/`export … from` that is not type-only. */
function runtimeImports(source: string): string[] {
  const statements = source.matchAll(/^\s*(import|export)\s+(type\s+)?[^;]*?\bfrom\s+['"]([^'"]+)['"]/gms);
  const bare = source.matchAll(/^\s*import\s+['"]([^'"]+)['"]/gm);
  return [
    ...[...statements].filter(([, , type]) => !type).map(([, , , spec]) => spec!),
    ...[...bare].map(([, spec]) => spec!),
  ];
}

const sourceOf = (module: string) => SOURCES[`../src/${module}.ts`]!;

/** Everything a module brings at run time: the modules under `src` by name, and the packages by specifier. */
function reach(module: string, seen = new Set<string>()): Set<string> {
  if (seen.has(module)) return seen;
  seen.add(module);
  for (const spec of runtimeImports(sourceOf(module))) {
    if (spec.startsWith('.')) reach(new URL(spec, `file:///${module}`).pathname.slice(1).replace(/\.js$/, ''), seen);
    else seen.add(spec);
  }
  return seen;
}

describe('subpaths', () => {
  it('holds every module subpath the package exports', () => {
    expect(exported.filter((path) => !NOT_MODULES.has(path)).sort()).toEqual(Object.keys(CARRIES).sort());
  });

  it.each(Object.entries(CARRIES))('%s ships only the elements it names', (path, elements) => {
    const reached = reach(path.slice(2));
    expect(ELEMENTS.filter((element) => reached.has(element))).toEqual([...elements].sort());
  });

  it.each(['./entity-table-model', './session'])('%s imports nothing, so a helper costs no element', (path) => {
    expect([...reach(path.slice(2))]).toEqual([path.slice(2)]);
  });

  it('gives every module the root exports a subpath, so no helper forces the root import', () => {
    const modules = runtimeImports(sourceOf('index')).map((spec) => spec.replace(/\.js$/, ''));
    expect(exported).toEqual(expect.arrayContaining(modules));
  });
});
