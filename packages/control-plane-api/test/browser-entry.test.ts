import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');

/** Every module a file pulls in at RUN time: `import type` / `export type` are erased. */
function runtimeSpecifiers(file: string): string[] {
  const text = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const out: string[] = [];
  for (const m of text.matchAll(/^\s*(import|export)\s+(type\s+)?([\s\S]*?)\sfrom\s+'([^']+)'/gm)) {
    if (m[2]) continue;
    // `import { type A, B }` keeps B at run time; `import { type A }` alone is erased too,
    // but is not used here, so it is read conservatively as a run-time import.
    out.push(m[4]!);
  }
  for (const m of text.matchAll(/^\s*import\s+'([^']+)'/gm)) out.push(m[1]!);
  return out;
}

/** The bare (package) specifiers reachable from `entry` at run time, following relative imports. */
function externalsOf(entry: string, seen = new Set<string>()): Set<string> {
  const externals = new Set<string>();
  const visit = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    for (const spec of runtimeSpecifiers(file)) {
      if (spec.startsWith('.')) visit(resolve(dirname(file), spec.replace(/\.js$/, '.ts')));
      else externals.add(spec);
    }
  };
  visit(entry);
  return externals;
}

describe('the browser entry', () => {
  it('reaches nothing at run time but fetch, contracts and the client package', () => {
    // A bundler follows the import graph of the subpath; one stray `hono` or `node:*` import
    // here ships the server to every console visitor, and no unit test would notice. The
    // client package is Apache-2.0 and holds its own line (its entry test: contracts only).
    expect([...externalsOf(join(SRC, 'browser.ts'))].sort()).toEqual([
      '@substrat-run/contracts',
      '@substrat-run/control-plane-client',
    ]);
  });

  it('the scan sees a server import when there is one (the positive twin)', () => {
    // index.ts is the server entry: it must read as reaching hono, or the test above is blind.
    expect(externalsOf(join(SRC, 'index.ts')).has('hono')).toBe(true);
  });

  it('is a published subpath of the package, pointing at files the build emits', () => {
    const pkg = JSON.parse(readFileSync(join(SRC, '..', 'package.json'), 'utf8'));
    expect(pkg.exports['./browser']).toEqual({
      types: './dist/browser.d.ts',
      default: './dist/browser.js',
    });
    expect(existsSync(join(SRC, 'browser.ts'))).toBe(true);
  });
});
