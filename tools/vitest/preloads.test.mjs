/**
 * Every node preload is `--require`d everywhere node suites run (#2387).
 *
 * The preloads in this directory turn what node would allow into what production refuses — a
 * Durable Object's LIKE limit, its SQL limits, an operation that never checked a permission. Each
 * is wired into three places by hand: the root `pnpm test`, CI's test step and `pnpm
 * test:affected`. A preload missing from one of them does not fail anything: the suites run
 * without it and pass, which is the gate turned off with nothing saying so. So this reads the
 * three places and refuses one that leaves a `*.cjs` here out.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');

/** Every preload: each CommonJS file in this directory. */
const preloads = readdirSync(here).filter((f) => f.endsWith('.cjs')).sort();

/** The text of each place a node suite's NODE_OPTIONS is assembled. */
const sites = {
  'package.json `test`': JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).scripts.test,
  '.github/workflows/ci.yml test step': readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8')
    .split('\n')
    .filter((line) => line.trim().startsWith('NODE_OPTIONS:'))
    .join('\n'),
  'tools/test-affected.mjs': readFileSync(join(root, 'tools/test-affected.mjs'), 'utf8')
    .split('\n')
    .filter((line) => line.includes('NODE_OPTIONS'))
    .join('\n'),
};

/** The preloads a site's text does not `--require`. */
export function missingFrom(text, names) {
  // A path token, where a workflow expression (`${{ github.workspace }}`) may hold spaces.
  const path = String.raw`(?:\$\{\{[^}]*\}\}|[^\s"'\`])*`;
  return names.filter((name) => !new RegExp(`--require=${path}tools/vitest/${name.replace(/\./g, '\\.')}`).test(text));
}

test('the directory holds the preloads this gate is about', () => {
  for (const name of ['like-pattern-limit.cjs', 'sql-limits.cjs', 'unchecked-operations.cjs']) {
    assert.ok(preloads.includes(name), name);
  }
});

for (const [site, text] of Object.entries(sites)) {
  test(`${site} requires every preload`, () => {
    assert.ok(text.length > 0, `${site}: found no NODE_OPTIONS to read — the reader is out of date`);
    assert.deepEqual(missingFrom(text, preloads), [], `${site} leaves these preloads out`);
  });
}

test('a site that leaves one out is named — and one that requires all is not', () => {
  const all = '--require=$PWD/tools/vitest/a.cjs --require=$PWD/tools/vitest/b.cjs';
  assert.deepEqual(missingFrom(all, ['a.cjs', 'b.cjs']), []);
  assert.deepEqual(missingFrom('--require=${{ github.workspace }}/tools/vitest/a.cjs', ['a.cjs']), []);
  assert.deepEqual(missingFrom('--require=$PWD/tools/vitest/a.cjs', ['a.cjs', 'b.cjs']), ['b.cjs']);
  // Named in a comment, or without `--require`, is not required.
  assert.deepEqual(missingFrom('# tools/vitest/b.cjs\n--require=$PWD/tools/vitest/a.cjs', ['a.cjs', 'b.cjs']), ['b.cjs']);
  // A name that is only a prefix of another does not count as the other.
  assert.deepEqual(missingFrom('--require=$PWD/tools/vitest/ab.cjs', ['b.cjs']), ['b.cjs']);
});
