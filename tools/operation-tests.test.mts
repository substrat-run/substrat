import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { basePattern, untested } from './operation-tests.mts';
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

test('on the base an operation counts as named only as a whole quoted name, not inside a longer one', () => {
  const re = new RegExp(basePattern(['todo/create', 'a.b']), 'g');
  const found = (text: string): string[] => [...text.matchAll(re)].map((m) => m[0].slice(1, -1));
  assert.deepEqual(found(`invoke('todo/create-list')`), []);
  assert.deepEqual(found(`invoke('todo/create')`), ['todo/create']);
  assert.deepEqual(found('"todo/create"; `todo/create`'), ['todo/create', 'todo/create']);
  assert.deepEqual(found(`'aXb'`), [], 'a regex metacharacter in a name is literal');
});

test('an operation named only in a comment is not tested', () => {
  const tests = ["// TODO 'todo/a'\n/* invoke('todo/b') */\ninvoke('todo/c');"];
  assert.deepEqual(untested(['todo/a', 'todo/b', 'todo/c'], tests), ['todo/a', 'todo/b']);
});
