/**
 * The zero-import subpaths (#1998): the kernel's, and the contracts ones the platform's entry
 * reaches. They exist for one reason: the platform's entry bundles them in front of every
 * deployed vertical (#1893), and either package root would bring contracts' schemas, and
 * zod, with it. So a subpath module imports nothing at run time but another subpath module
 * of its own package. Its type imports are erased; anything else would land in every
 * vertical's upload.
 */
import { readFileSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';
import { describe, expect, it } from 'vitest';

/** Each subpath of a package as `[package-relative subpath, absolute source file]`. */
function subpathsOf(pkgDir: string): (readonly [string, string])[] {
  const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')) as {
    exports: Record<string, { default: string }>;
  };
  return Object.entries(pkg.exports)
    .filter(([path]) => path !== '.')
    .map(([path, entry]) => [path, join(pkgDir, entry.default.replace(/^\.\/dist\/(.*)\.js$/, 'src/$1.ts'))] as const);
}

/**
 * The one kernel subpath held to nothing above, by name: `./testing` (#1835) mints operations for
 * the contract suites. No entry bundles it — boundary-lint R2 refuses its import from module code —
 * so what it imports reaches a test runner and never an upload.
 */
const TEST_ONLY = new Set(['./testing']);

const KERNEL = subpathsOf(join(import.meta.dirname, '..')).filter(([path]) => !TEST_ONLY.has(path));
const CONTRACTS = subpathsOf(join(import.meta.dirname, '../../contracts'));

/** The specifiers a module imports at run time: every `import`/`export … from` that is not type-only. */
function runtimeImports(source: string): string[] {
  const statements = source.matchAll(/^\s*(import|export)\s+(type\s+)?[^;]*?\bfrom\s+['"]([^'"]+)['"]/gms);
  const bare = source.matchAll(/^\s*import\s+['"]([^'"]+)['"]/gm);
  return [
    ...[...statements].filter(([, , type]) => !type).map(([, , , spec]) => spec!),
    ...[...bare].map(([, spec]) => spec!),
  ];
}

/** A module's runtime imports that are NOT another subpath module of the same package. */
function strayImports(file: string, siblings: readonly (readonly [string, string])[]): string[] {
  const allowed = new Set(siblings.map(([, f]) => normalize(f)));
  return runtimeImports(readFileSync(file, 'utf8')).filter(
    (spec) => !(spec.startsWith('.') && allowed.has(normalize(join(dirname(file), spec.replace(/\.js$/, '.ts'))))),
  );
}

describe('zero-import subpaths (#1998)', () => {
  it('the kernel has the two the platform entry reaches, contracts the three', () => {
    expect(KERNEL.map(([path]) => path).sort()).toEqual(['./invocation-line', './ulid']);
    // And the exemption names a subpath that exists, so it cannot outlive what it exempts.
    const all = subpathsOf(join(import.meta.dirname, '..')).map(([path]) => path);
    expect([...TEST_ONLY].filter((path) => !all.includes(path))).toEqual([]);
    expect(CONTRACTS.map(([path]) => path).sort()).toEqual(['./invocation-record', './wire-auth', './wire-headers']);
  });

  it.each(KERNEL)('kernel %s imports nothing at run time', (_, file) => {
    expect(strayImports(file, KERNEL)).toEqual([]);
  });

  it.each(CONTRACTS)('contracts %s imports nothing at run time but a sibling subpath', (_, file) => {
    expect(strayImports(file, CONTRACTS)).toEqual([]);
  });

  it('its positive twins: a sibling import is seen and allowed, and a root import is seen and refused', () => {
    const wireAuth = CONTRACTS.find(([path]) => path === './wire-auth')![1];
    expect(runtimeImports(readFileSync(wireAuth, 'utf8'))).toEqual(['./wire-headers.js']);
    const index = join(import.meta.dirname, '../src/index.ts');
    expect(strayImports(index, KERNEL).length).toBeGreaterThan(0);
  });
});
