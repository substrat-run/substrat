/**
 * The kernel's subpath exports (#1998) exist for one reason: the platform's entry bundles
 * them in front of every deployed vertical (#1893), and the package root would bring
 * contracts, and zod, with it. So a subpath module imports nothing at run time. Its type
 * imports are erased, and anything else would land in every vertical's upload.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { secretMatches } from '../src/secret-match.js';

const root = join(import.meta.dirname, '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
  exports: Record<string, { default: string }>;
};
const SUBPATHS = Object.entries(pkg.exports)
  .filter(([path]) => path !== '.')
  .map(([path, entry]) => [path, entry.default.replace(/^\.\/dist\/(.*)\.js$/, 'src/$1.ts')] as const);

/** The specifiers a module imports at run time: every `import`/`export … from` that is not type-only. */
function runtimeImports(source: string): string[] {
  const statements = source.matchAll(/^\s*(import|export)\s+(type\s+)?[^;]*?\bfrom\s+['"]([^'"]+)['"]/gms);
  const bare = source.matchAll(/^\s*import\s+['"]([^'"]+)['"]/gm);
  return [
    ...[...statements].filter(([, , type]) => !type).map(([, , , spec]) => spec!),
    ...[...bare].map(([, spec]) => spec!),
  ];
}

describe('kernel subpaths import nothing at run time (#1998)', () => {
  it('there are the three the platform entry reaches', () => {
    expect(SUBPATHS.map(([path]) => path).sort()).toEqual(['./invocation-line', './secret-match', './ulid']);
  });

  it.each(SUBPATHS)('%s (%s)', (_, file) => {
    expect(runtimeImports(readFileSync(join(root, file), 'utf8'))).toEqual([]);
  });

  it('its positive twin: the root does import at run time, so the check can see one', () => {
    expect(runtimeImports(readFileSync(join(root, 'src/index.ts'), 'utf8'))).toContain('./ulid.js');
    expect(runtimeImports(readFileSync(join(root, 'src/platform-call.ts'), 'utf8'))).toContain('./secret-match.js');
  });
});

describe('secretMatches', () => {
  it('matches only the same string', () => {
    expect(secretMatches('s3cret', 's3cret')).toBe(true);
    expect(secretMatches('s3creT', 's3cret')).toBe(false);
    expect(secretMatches('s3cre', 's3cret')).toBe(false);
    expect(secretMatches('s3crett', 's3cret')).toBe(false);
  });

  it('refuses an absent or empty presented value', () => {
    expect(secretMatches(null, 's3cret')).toBe(false);
    expect(secretMatches('', 's3cret')).toBe(false);
  });
});
