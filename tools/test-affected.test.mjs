// node --test tools/test-affected.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ownersOf } from './test-affected.mjs';

const all = [
  { name: '@substrat-run/kernel', dir: 'packages/kernel' },
  { name: '@substrat-run/demo-todo', dir: 'demos/todo' },
  { name: '@substrat-run/demo-todo-app', dir: 'demos/todo/app' },
];

test('a file belongs to the member with the longest directory prefix', () => {
  assert.deepEqual(ownersOf(['demos/todo/app/src/App.tsx'], all), { owners: ['@substrat-run/demo-todo-app'], unowned: [] });
  assert.deepEqual(ownersOf(['demos/todo/src/module.ts'], all), { owners: ['@substrat-run/demo-todo'], unowned: [] });
});

test('a directory prefix must end at a path separator', () => {
  // packages/kernel-extra is not packages/kernel.
  assert.deepEqual(ownersOf(['packages/kernel-extra/src/x.ts'], all), { owners: [], unowned: ['packages/kernel-extra/src/x.ts'] });
});

test('files outside the package roots are left to ci-scope', () => {
  assert.deepEqual(ownersOf(['tools/ci-scope.mjs', 'docs/x.md', 'pnpm-lock.yaml'], all), { owners: [], unowned: [] });
});

test('owners are deduplicated and sorted', () => {
  const r = ownersOf(['packages/kernel/a.ts', 'demos/todo/b.ts', 'packages/kernel/c.ts'], all);
  assert.deepEqual(r.owners, ['@substrat-run/demo-todo', '@substrat-run/kernel']);
});
