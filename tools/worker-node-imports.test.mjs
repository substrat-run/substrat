import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { builtinsAllowedBy, refusedBuiltins, workerNodeImportOffence } from '../packages/cli/dist/worker-node-imports.js';

/** A worker entry on disk that imports `specifiers` statically (and `dynamic` through import()). */
function entry(specifiers, dynamic = []) {
  const dir = mkdtempSync(join(tmpdir(), 'worker-node-imports-'));
  const lines = specifiers.map((s, i) => `import * as m${i} from ${JSON.stringify(s)}; void m${i};`);
  lines.push(...dynamic.map((s, i) => `export const later${i} = () => import(${JSON.stringify(s)});`));
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
    assert.equal(found.importPaths.length, 2);
  } finally {
    w.done();
  }
});

test('a dynamic import of a builtin is refused, including one behind a typeof guard', async () => {
  const w = entry([], ['node:crypto']);
  try {
    const found = await refusedBuiltins(w.path, []);
    assert.deepEqual(found.refused, ['node:crypto']);
    assert.match(workerNodeImportOffence(w.path, [], found), /worker\.js -> node:crypto/);
    assert.deepEqual((await refusedBuiltins(w.path, ['nodejs_compat'])).refused, []);
  } finally {
    w.done();
  }
});

test('a guarded dynamic import is refused; a clean Worker passes', async () => {
  const w = entry([]);
  try {
    writeFileSync(w.path, `export default { fetch: () => new Response('ok') };\nexport const probe = () => typeof process === 'undefined' ? undefined : import('node:async_hooks');`);
    assert.deepEqual((await refusedBuiltins(w.path, [])).refused, ['node:async_hooks']);
    writeFileSync(w.path, `export default { fetch: () => new Response('ok') };`);
    assert.deepEqual((await refusedBuiltins(w.path, [])).refused, []);
  } finally {
    w.done();
  }
});

test('a transitive dependency is named from entry through importer to builtin', async () => {
  const w = entry([]);
  try {
    writeFileSync(w.path, `import './dependency.js'; export default { fetch: () => new Response('ok') };`);
    writeFileSync(join(w.path, '..', 'dependency.js'), `import 'node:crypto';`);
    const found = await refusedBuiltins(w.path, []);
    assert.match(workerNodeImportOffence(w.path, [], found), /worker\.js -> .*dependency\.js -> node:crypto/);
  } finally {
    w.done();
  }
});

test('a transitive CommonJS require of a builtin is refused without nodejs_compat', async () => {
  const w = entry([]);
  try {
    writeFileSync(w.path, `import './dependency.cjs'; export default { fetch: () => new Response('ok') };`);
    writeFileSync(join(w.path, '..', 'dependency.cjs'), `const crypto = require('node:crypto'); module.exports = crypto;`);
    const found = await refusedBuiltins(w.path, []);
    assert.deepEqual(found.refused, ['node:crypto']);
    assert.match(workerNodeImportOffence(w.path, [], found), /worker\.js -> .*dependency\.cjs -> node:crypto/);
    assert.deepEqual((await refusedBuiltins(w.path, ['nodejs_compat'])).refused, []);
  } finally {
    w.done();
  }
});

test('the shared IdentityDO bundles for a flagless OIDC worker', async () => {
  const path = new URL('../packages/vertical-auth/src/identity-do.ts', import.meta.url).pathname;
  assert.deepEqual(await refusedBuiltins(path, []), { refused: [], importPaths: [] });
});
