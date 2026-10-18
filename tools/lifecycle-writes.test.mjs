import { test } from 'node:test';
import assert from 'node:assert/strict';
import { guardNames, inScope, lifecyclesOf, unguardedWrites } from './lifecycle-writes.mjs';

const LC = [{ entity: 'order', table: 'shop_orders', field: 'status' }];
const at = (text, path = 'demos/shop/src/module.ts') => unguardedWrites([{ path, text }], LC).map((h) => h.line);

test('a write after assertTransition in its function passes', () => {
  const text = `
function ship(ctx, row) {
  assertTransition(lc, 'order', row.status, 'shop/ship');
  ctx.sql.exec("UPDATE shop_orders SET status = 'shipped' WHERE id = ?", [row.id]);
}`;
  assert.deepEqual(at(text), []);
});

test('a write with an inline guard instead of the lifecycle is refused, with its line', () => {
  const text = `
function ship(ctx, row) {
  if (row.status !== 'paid') throw conflict('wrong_status');
  ctx.sql.exec("UPDATE shop_orders SET status = 'shipped' WHERE id = ?", [row.id]);
}`;
  assert.deepEqual(at(text), [4]);
});

test('transitionFor counts: the engine keeps its own refusal', () => {
  const text = `
function exportIt(ctx, row) {
  if (!transitionFor(lc, row.status, 'x/export')) throw conflict('immutable');
  ctx.sql.exec(\`UPDATE shop_orders SET status = 'exported' WHERE id = ?\`, [row.id]);
}`;
  assert.deepEqual(at(text), []);
});

test('a local wrapper that calls the lifecycle counts, and its own declaration does not cover the file', () => {
  const text = `
function requireTransition(row, op) {
  assertTransition(lc, 'order', row.status, op);
}
function ship(ctx, row) {
  requireTransition(row, 'shop/ship');
  ctx.sql.exec("UPDATE shop_orders SET status = 'shipped' WHERE id = ?", [row.id]);
}
function cancel(ctx, row) {
  ctx.sql.exec("UPDATE shop_orders SET status = 'cancelled' WHERE id = ?", [row.id]);
}`;
  assert.deepEqual(at(text), [10]);
  assert.ok(guardNames(text).has('requireTransition'));
});

test('a wrapper is one level only: a function calling the wrapper is not itself a guard', () => {
  const text = `
function requireTransition(row, op) { assertTransition(lc, 'order', row.status, op); }
function ship(ctx, row) {
  requireTransition(row, 'shop/ship');
  ctx.sql.exec("UPDATE shop_orders SET status = 'shipped' WHERE id = ?", [row.id]);
}`;
  assert.deepEqual([...guardNames(text)].sort(), ['assertTransition', 'requireTransition', 'transitionFor']);
});

test('a guard in a sibling function does not cover a write in another', () => {
  const text = `
function check(row) { const ok = transitionFor(lc, row.status, 'shop/ship'); return ok; }
function ship(ctx, row) {
  ctx.sql.exec("UPDATE shop_orders SET status = 'shipped' WHERE id = ?", [row.id]);
}`;
  // \`check\` is a wrapper, but nobody calls it before the write.
  assert.deepEqual(at(text), [4]);
});

test('a guard in a function with an object-literal return type does not cover a later function', () => {
  const text = `
function complete(ctx, row): { order: Order; total: Money } {
  assertTransition(lc, 'order', row.status, 'shop/complete');
  ctx.sql.exec("UPDATE shop_orders SET status = 'completed' WHERE id = ?", [row.id]);
  return { order: row, total: '0' };
}
function start(ctx, row): Order {
  ctx.sql.exec("UPDATE shop_orders SET status = 'started' WHERE id = ?", [row.id]);
  return row;
}`;
  assert.deepEqual(at(text), [8]);
});

test('a single writer helper is covered when every caller asks first', () => {
  const text = `
function moveTo(ctx, row, state) {
  ctx.sql.exec('UPDATE shop_orders SET status = ?, updated_at = ? WHERE id = ?', [state, ctx.now(), row.id]);
}
function step(row, op) { return assertTransition(lc, 'order', row.status, op).to; }
function ship(ctx, row) { const next = step(row, 'shop/ship'); moveTo(ctx, row, next); }
function cancel(ctx, row) { moveTo(ctx, row, step(row, 'shop/cancel')); }`;
  assert.deepEqual(at(text), []);
});

test('the helper is refused when one caller does not ask, and when nothing calls it', () => {
  const asked = `
function moveTo(ctx, row, state) {
  ctx.sql.exec('UPDATE shop_orders SET status = ? WHERE id = ?', [state, row.id]);
}
function ship(ctx, row) { assertTransition(lc, 'order', row.status, 'shop/ship'); moveTo(ctx, row, 'shipped'); }
function force(ctx, row) { moveTo(ctx, row, 'shipped'); }`;
  assert.deepEqual(at(asked), [3]);
  const orphan = `
function moveTo(ctx, row, state) {
  ctx.sql.exec('UPDATE shop_orders SET status = ? WHERE id = ?', [state, row.id]);
}`;
  assert.deepEqual(at(orphan), [3]);
});

test('a write that does not set the state field, or to another table, is not judged', () => {
  const text = `
function touch(ctx, id) {
  ctx.sql.exec('UPDATE shop_orders SET updated_at = ? WHERE id = ?', [ctx.now(), id]);
  ctx.sql.exec("UPDATE shop_lines SET status = 'x' WHERE id = ?", [id]);
}`;
  assert.deepEqual(at(text), []);
});

test('the table is matched quoted, and the field anywhere in the SET list', () => {
  const text = `
function ship(ctx, id) {
  ctx.sql.exec('UPDATE "shop_orders" SET updated_at = ?, status = ? WHERE id = ?', [ctx.now(), 'x', id]);
}`;
  assert.deepEqual(at(text), [3]);
});

test('a comment naming the statement is not a write', () => {
  assert.deepEqual(at(`// UPDATE shop_orders SET status = 'x'\nconst a = 1;`), []);
});

test('tests, seeds, migrations and code outside src/ are out of scope', () => {
  for (const path of ['demos/shop/test/x.test.ts', 'demos/shop/src/seed.ts', 'demos/shop/src/migrations.generated.ts', 'demos/shop/src/x.test.ts', 'demos/shop/server.ts']) {
    assert.equal(inScope(path), false, path);
  }
  assert.equal(inScope('demos/shop/src/module.ts'), true);
});

test('the lifecycles are read off model.json: entity table and declared field', () => {
  const model = { entities: { order: { table: 'shop_orders' } }, lifecycles: { order: { field: 'status', initial: 'new', states: {} } } };
  assert.deepEqual(lifecyclesOf(model), LC);
  assert.deepEqual(lifecyclesOf({ entities: {} }), []);
});
