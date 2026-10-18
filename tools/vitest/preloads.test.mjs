/**
 * Every node preload is `--require`d everywhere node suites run (#2387).
 *
 * The preloads in this directory turn what node would allow into what production refuses — a
 * Durable Object's LIKE limit, its SQL limits, an operation that never checked a permission. Each
 * is wired into three places by hand: the root `pnpm test`, CI's test step and `pnpm
 * test:affected`. A preload missing from one of them does not fail anything: the suites run
 * without it and pass, which is the gate turned off with nothing saying so. So this reads the
 * three places, line by line (a second job's NODE_OPTIONS is judged on its own, never covered by
 * the first's), and refuses one that leaves a `*.cjs` here out. It holds `node-options.mjs` too,
 * the command CLAUDE.md quotes for running one package as CI does.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { nodeOptions, preloadFiles } from './node-options.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');

const preloads = preloadFiles();

/** The lines of a file that assemble NODE_OPTIONS, each judged ON ITS OWN — one per job or call. */
export function nodeOptionLines(text, isLine) {
  return text.split('\n').filter(isLine);
}

/** The preloads one line does not `--require`. */
export function missingFrom(text, names) {
  // A path token, where a workflow expression (`${{ github.workspace }}`) may hold spaces.
  const path = String.raw`(?:\$\{\{[^}]*\}\}|[^\s"'\`])*`;
  return names.filter((name) => !new RegExp(`--require=${path}tools/vitest/${name.replace(/\./g, '\\.')}`).test(text));
}

/** Each line that leaves a preload out, with what it leaves out. */
export function incompleteLines(lines, names) {
  return lines.map((line) => ({ line: line.trim(), missing: missingFrom(line, names) })).filter((r) => r.missing.length > 0);
}

const workflowLine = (line) => line.trim().startsWith('NODE_OPTIONS:');

/** Each place a node suite's NODE_OPTIONS is assembled, as the lines that assemble it. */
const sites = {
  'package.json `test`': [JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).scripts.test],
  '.github/workflows/ci.yml': nodeOptionLines(readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8'), workflowLine),
  'tools/test-affected.mjs': nodeOptionLines(readFileSync(join(root, 'tools/test-affected.mjs'), 'utf8'), (l) =>
    l.includes('NODE_OPTIONS:'),
  ),
  'tools/vitest/node-options.mjs (the command CLAUDE.md quotes)': [nodeOptions()],
};

test('the directory holds the preloads this gate is about', () => {
  for (const name of ['like-pattern-limit.cjs', 'sql-limits.cjs', 'unchecked-operations.cjs']) {
    assert.ok(preloads.includes(name), name);
  }
});

for (const [site, lines] of Object.entries(sites)) {
  test(`${site}: every line that sets NODE_OPTIONS requires every preload`, () => {
    assert.ok(lines.length > 0, `${site}: found no NODE_OPTIONS to read — the reader is out of date`);
    assert.deepEqual(incompleteLines(lines, preloads), [], `${site} leaves preloads out`);
  });
}

test('CLAUDE.md quotes the one source, not a hand-written list', () => {
  const doc = readFileSync(join(root, 'CLAUDE.md'), 'utf8');
  assert.ok(doc.includes('NODE_OPTIONS="$(node tools/vitest/node-options.mjs)"'));
  assert.deepEqual(
    nodeOptionLines(doc, (l) => /NODE_OPTIONS="--require/.test(l)),
    [],
    'CLAUDE.md spells a preload list out by hand',
  );
});

test('a line that leaves one out is named — and one that requires all is not', () => {
  const all = '--require=$PWD/tools/vitest/a.cjs --require=$PWD/tools/vitest/b.cjs';
  assert.deepEqual(missingFrom(all, ['a.cjs', 'b.cjs']), []);
  assert.deepEqual(missingFrom('--require=${{ github.workspace }}/tools/vitest/a.cjs', ['a.cjs']), []);
  assert.deepEqual(missingFrom('--require=$PWD/tools/vitest/a.cjs', ['a.cjs', 'b.cjs']), ['b.cjs']);
  // Named in a comment, or without `--require`, is not required.
  assert.deepEqual(missingFrom('# tools/vitest/b.cjs\n--require=$PWD/tools/vitest/a.cjs', ['a.cjs', 'b.cjs']), ['b.cjs']);
  // A name that is only a prefix of another does not count as the other.
  assert.deepEqual(missingFrom('--require=$PWD/tools/vitest/ab.cjs', ['b.cjs']), ['b.cjs']);
});

test('one complete job does not cover an incomplete one in the same workflow', () => {
  const workflow = [
    'jobs:',
    '  shard:',
    '    env:',
    '      NODE_OPTIONS: --require=${{ github.workspace }}/tools/vitest/a.cjs --require=${{ github.workspace }}/tools/vitest/b.cjs',
    '  other:',
    '    env:',
    '      NODE_OPTIONS: --require=${{ github.workspace }}/tools/vitest/a.cjs',
  ].join('\n');
  const lines = nodeOptionLines(workflow, workflowLine);
  assert.equal(lines.length, 2);
  assert.deepEqual(
    incompleteLines(lines, ['a.cjs', 'b.cjs']).map((r) => r.missing),
    [['b.cjs']],
  );
  // Twin: both complete, nothing reported.
  assert.deepEqual(incompleteLines([lines[0], lines[0]], ['a.cjs', 'b.cjs']), []);
});

test('node-options.mjs prints every preload when started through a symlink', () => {
  // A checkout reached through a linked path: the script must not mistake itself for an import
  // and print nothing, which would leave NODE_OPTIONS empty and every preload off.
  const dir = mkdtempSync(join(tmpdir(), 'node-options-'));
  try {
    const link = join(dir, 'node-options.mjs');
    symlinkSync(join(here, 'node-options.mjs'), link);
    const printed = execFileSync(process.execPath, [link], { encoding: 'utf8' });
    assert.equal(printed, nodeOptions());
    assert.deepEqual(missingFrom(printed, preloads), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  // Twin: started by its own path, the same answer.
  assert.equal(execFileSync(process.execPath, [join(here, 'node-options.mjs')], { encoding: 'utf8' }), nodeOptions());
});
