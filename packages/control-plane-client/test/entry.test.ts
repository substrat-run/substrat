import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const PKG = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(PKG, 'src');

/** Every module a file pulls in at RUN time: `import type` / `export type` are erased. */
function runtimeSpecifiers(file: string): string[] {
  const text = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const out: string[] = [];
  for (const m of text.matchAll(/^\s*(import|export)\s+(type\s+)?([\s\S]*?)\sfrom\s+'([^']+)'/gm)) {
    if (m[2]) continue;
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

describe('the package entry', () => {
  it('reaches nothing at run time but fetch and @substrat-run/contracts', () => {
    // The package is Apache-2.0 and imported into a browser bundle and the CLI: one stray
    // `hono` or `node:*` import here would ship the AGPL server (or a Node builtin) to
    // every one of them, and no unit test of behaviour would notice.
    expect([...externalsOf(join(SRC, 'index.ts'))]).toEqual(['@substrat-run/contracts']);
  });

  it('the scan sees a server import when there is one (the positive twin)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cp-client-scan-'));
    writeFileSync(join(dir, 'entry.ts'), "import { Hono } from 'hono';\nexport { Hono };\n");
    expect([...externalsOf(join(dir, 'entry.ts'))]).toEqual(['hono']);
  });

  it('declares only Apache-2.0 workspace dependencies', () => {
    const pkg = JSON.parse(readFileSync(join(PKG, 'package.json'), 'utf8'));
    expect(pkg.license).toBe('Apache-2.0');
    expect(Object.keys(pkg.dependencies)).toEqual(['@substrat-run/contracts']);
  });
});
