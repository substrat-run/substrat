/**
 * The K-43 guard in `declared-deps.mjs`: the kernel and the adapters never depend on the
 * attachment parsers. Each refusal beside the allow next to it, so a check that refused
 * everything — or nothing — cannot pass.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { FORBIDDEN_EDGES, forbiddenEdgeProblems } from './declared-deps.mjs';

const PARSERS = '@substrat-run/attachment-extractors';
const kernel = (extra = {}) => ({ name: '@substrat-run/kernel', ...extra });
const adapter = (extra = {}) => ({ name: '@substrat-run/adapter-sqlite', ...extra });

test('refuses the parsers as a runtime dependency of the kernel or an adapter', () => {
  for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies']) {
    assert.deepEqual(forbiddenEdgeProblems(kernel({ [field]: { [PARSERS]: 'workspace:^' } }), {}), [
      `@substrat-run/kernel declares '${PARSERS}' in ${field} (K-43)`,
    ]);
  }
  assert.equal(forbiddenEdgeProblems(adapter({ dependencies: { [PARSERS]: 'workspace:^' } }), {}).length, 1);
});

test('refuses a reference in source or shipped types — an import, a re-export, a type import', () => {
  for (const text of [
    `import { defaultAttachmentExtractors } from '${PARSERS}';`,
    `export { textExtractor } from '${PARSERS}';`,
    `export declare const x: import('${PARSERS}').ExtractorBounds;`,
  ]) {
    assert.deepEqual(forbiddenEdgeProblems(adapter(), { 'src/index.ts': text }), [
      `@substrat-run/adapter-sqlite references '${PARSERS}' in src/index.ts (K-43)`,
    ]);
  }
});

test('allows the twins: an adapter devDependency, a comment naming it, and any other package', () => {
  assert.deepEqual(forbiddenEdgeProblems(adapter({ devDependencies: { [PARSERS]: 'workspace:^' } }), {}), []);
  assert.deepEqual(
    forbiddenEdgeProblems(adapter(), { 'src/index.ts': `// passed in by the host, never imported from '${PARSERS}'` }),
    [],
  );
  assert.deepEqual(
    forbiddenEdgeProblems(
      { name: '@substrat-run/contract-tests', dependencies: { [PARSERS]: 'workspace:^' } },
      { 'src/x.ts': `import { textExtractor } from '${PARSERS}';` },
    ),
    [],
  );
});

test('names the kernel and both adapters, and the repo as it stands has no forbidden edge', () => {
  assert.deepEqual(Object.keys(FORBIDDEN_EDGES).sort(), [
    '@substrat-run/adapter-cloudflare',
    '@substrat-run/adapter-sqlite',
    '@substrat-run/kernel',
  ]);
  const root = new URL('..', import.meta.url).pathname;
  const walk = (dir, out = []) => {
    if (!existsSync(dir)) return out;
    for (const e of readdirSync(dir)) {
      const p = join(dir, e);
      if (e === 'node_modules') continue;
      if (statSync(p).isDirectory()) walk(p, out);
      else if (/\.(ts|tsx|mts)$/.test(p)) out.push(p);
    }
    return out;
  };
  for (const dir of ['packages/kernel', 'packages/adapter-sqlite', 'packages/adapter-cloudflare']) {
    const abs = join(root, dir);
    const pj = JSON.parse(readFileSync(join(abs, 'package.json'), 'utf8'));
    const files = Object.fromEntries(
      [...walk(join(abs, 'src')), ...walk(join(abs, 'dist'))].map((f) => [relative(abs, f), readFileSync(f, 'utf8')]),
    );
    assert.deepEqual(forbiddenEdgeProblems(pj, files), [], dir);
  }
});
