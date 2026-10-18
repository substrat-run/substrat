import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { untested } from './operation-tests.mts';
import { testFiles } from './package-registrations.mts';

test('an operation named in a test, in any quote, is tested', () => {
  const ops = ['todo/a', 'todo/b', 'todo/c'];
  assert.deepEqual(untested(ops, [`invoke('todo/a')`, `invoke("todo/b")`, 'invoke(`todo/c`)']), []);
});

test('an operation no test names is listed', () => {
  assert.deepEqual(untested(['todo/a', 'todo/b'], [`invoke('todo/a', {})`]), ['todo/b']);
});

test('an apostrophe in prose before the call does not hide it', () => {
  assert.deepEqual(untested(['todo/a'], [`it('doesn't fail', () => invoke('todo/a'))`]), []);
});

test('a prefix of a longer name does not count as naming it', () => {
  assert.deepEqual(untested(['todo/list'], [`invoke('todo/list-shares')`]), ['todo/list']);
});

test('test files are *.test / *.spec anywhere and any source under test/, never node_modules or dist', () => {
  const dir = mkdtempSync(join(tmpdir(), 'operation-tests-'));
  try {
    const put = (rel: string): void => {
      mkdirSync(join(dir, rel, '..'), { recursive: true });
      writeFileSync(join(dir, rel), '');
    };
    ['src/module.ts', 'src/module.test.ts', 'test/scenario.test.ts', 'test/support.ts', 'app/src/x.spec.tsx', 'node_modules/p/a.test.ts', 'dist/a.test.js'].forEach(put);
    assert.deepEqual(testFiles(dir).map((f) => relative(dir, f)).sort(), ['app/src/x.spec.tsx', 'src/module.test.ts', 'test/scenario.test.ts', 'test/support.ts']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
