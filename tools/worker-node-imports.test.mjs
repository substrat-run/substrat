import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { builtinsAllowedBy, refusedBuiltins } from './worker-node-imports.mjs';

/** A worker entry on disk that imports `specifiers` statically (and `dynamic` through import()). */
function entry(specifiers, dynamic = []) {
  const dir = mkdtempSync(join(tmpdir(), 'worker-node-imports-'));
  const lines = specifiers.map((s, i) => `import * as m${i} from ${JSON.stringify(s)}; void m${i};`);
  lines.push(...dynamic.map((s) => `export const later = () => import(${JSON.stringify(s)});`));
  lines.push(`export default { fetch: () => new Response('ok') };`);
  writeFileSync(join(dir, 'worker.js'), lines.join('\n'));
  return { path: join(dir, 'worker.js'), done: () => rmSync(dir, { recursive: true, force: true }) };
}

test('nodejs_compat gives every builtin, nodejs_als async_hooks alone, no flag none', () => {
  assert.equal(builtinsAllowedBy(['nodejs_compat']), 'all');
  assert.equal(builtinsAllowedBy(['nodejs_compat_v2']), 'all');
  assert.deepEqual([...builtinsAllowedBy(['nodejs_als'])].sort(), ['async_hooks', 'node:async_hooks']);
  assert.deepEqual([...builtinsAllowedBy([])], []);
  assert.deepEqual([...builtinsAllowedBy(['no_nodejs_als', 'streams_enable_constructors'])], []);
});

test('a worker with only nodejs_als that imports node:buffer is refused; async_hooks is not', async () => {
  const w = entry(['node:async_hooks', 'node:buffer']);
  try {
    assert.deepEqual((await refusedBuiltins(w.path, ['nodejs_als'])).refused, ['node:buffer']);
    assert.deepEqual((await refusedBuiltins(w.path, ['nodejs_compat'])).refused, []);
  } finally {
    w.done();
  }
});

test('a worker with only nodejs_als that imports async_hooks alone passes', async () => {
  const w = entry(['node:async_hooks']);
  try {
    assert.deepEqual((await refusedBuiltins(w.path, ['nodejs_als'])).refused, []);
  } finally {
    w.done();
  }
});

test('a flagless worker is refused any static builtin import, bare or prefixed, and names who imports it', async () => {
  const w = entry(['node:async_hooks', 'events']);
  try {
    const found = await refusedBuiltins(w.path, []);
    assert.deepEqual(found.refused.sort(), ['events', 'node:async_hooks']);
    assert.equal(found.importedBy.length, 1);
  } finally {
    w.done();
  }
});

test('a dynamic import of a builtin is not a static one', async () => {
  const w = entry([], ['node:crypto']);
  try {
    assert.deepEqual((await refusedBuiltins(w.path, [])).refused, []);
  } finally {
    w.done();
  }
});

test('the shared IdentityDO bundles for a flagless OIDC worker', async () => {
  const path = new URL('../packages/vertical-auth/src/identity-do.ts', import.meta.url).pathname;
  assert.deepEqual(await refusedBuiltins(path, []), { refused: [], importedBy: [] });
});
