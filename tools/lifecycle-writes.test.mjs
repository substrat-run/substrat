import { spawnSync } from 'node:child_process';
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

test('a helper is named by its own head, not by a statement above it with no semicolon', () => {
  const text = `
const limit = 3
function moveTo(ctx, row, state) {
  ctx.sql.exec('UPDATE shop_orders SET status = ? WHERE id = ?', [state, row.id]);
}
function ship(ctx, row) { assertTransition(lc, 'order', row.status, 'shop/ship'); moveTo(ctx, row, 'shipped'); }`;
  assert.deepEqual(at(text), []);
});

test('a state named only in the WHERE clause is a read, not a write', () => {
  const text = `
function rename(ctx, row) {
  ctx.sql.exec('UPDATE shop_orders SET title = ?, updated_at = ? WHERE id = ? AND status = ?', [row.title, ctx.now(), row.id, 'open']);
}`;
  assert.deepEqual(at(text), []);
});

test('a SQL string literal before the state column does not hide the write', () => {
  const text = `
function close(ctx, row) {
  ctx.sql.exec("UPDATE shop_orders SET resolution = 'fixed', status = 'closed' WHERE id = ?", [row.id]);
}`;
  assert.deepEqual(at(text), [3]);
});

test('a schema-qualified table and UPDATE OR … are writes too', () => {
  const text = `
function a(ctx, id) { ctx.sql.exec("UPDATE main.shop_orders SET status = 'x' WHERE id = ?", [id]); }
function b(ctx, id) { ctx.sql.exec("UPDATE OR IGNORE shop_orders SET status = 'x' WHERE id = ?", [id]); }
function c(ctx, id) { ctx.sql.exec('UPDATE OR REPLACE "main"."shop_orders" SET status = ? WHERE id = ?', ['x', id]); }`;
  assert.deepEqual(at(text), [2, 3, 4]);
});

test('an upsert that sets the state on conflict is a write', () => {
  const text = `
function upsert(ctx, id) {
  ctx.sql.exec(\`INSERT INTO shop_orders (id, status) VALUES (?, 'new')
    ON CONFLICT (id) DO UPDATE SET status = excluded.status\`, [id]);
}
function seedRow(ctx, id) {
  ctx.sql.exec(\`INSERT INTO shop_orders (id, status) VALUES (?, 'new') ON CONFLICT (id) DO UPDATE SET title = excluded.title\`, [id]);
}`;
  assert.deepEqual(at(text), [3]);
});

test('KNOWN GAP: a guard counts whichever lifecycle it asks about', () => {
  // The tripwire reads text, not which lifecycle a call names: asking about an invoice covers a
  // later order write in the same function. Documented here so a fix shows up as this test changing.
  const text = `
function both(ctx, row) {
  assertTransition(invoiceLifecycle, 'invoice', row.invoiceStatus, 'x/send');
  ctx.sql.exec("UPDATE shop_orders SET status = 'sent' WHERE id = ?", [row.id]);
}`;
  assert.deepEqual(at(text), []);
});

test('a quoted state column is a write; a quoted column that only starts with its name is not', () => {
  const text = `
function a(ctx, id) { ctx.sql.exec('UPDATE shop_orders SET "status" = ? WHERE id = ?', ['x', id]); }
function b(ctx, id) { ctx.sql.exec('UPDATE shop_orders SET [status] = ? WHERE id = ?', ['x', id]); }
function c(ctx, id) { ctx.sql.exec('UPDATE shop_orders SET "status_note" = ? WHERE id = ?', ['x', id]); }`;
  assert.deepEqual(at(text), [2, 3]);
});

test('a row-value SET that names the state is a write; one that does not, or reads it in a subquery, is not', () => {
  const text = `
function a(ctx, id) { ctx.sql.exec('UPDATE shop_orders SET (status, note) = (?, ?) WHERE id = ?', ['x', 'n', id]); }
function b(ctx, id) { ctx.sql.exec('UPDATE shop_orders SET (note, "status") = (?, ?) WHERE id = ?', ['n', 'x', id]); }
function c(ctx, id) { ctx.sql.exec('UPDATE shop_orders SET (note, title) = (?, ?) WHERE id = ?', ['n', 't', id]); }
function d(ctx, id) { ctx.sql.exec('UPDATE shop_orders SET total = (SELECT status FROM shop_lines WHERE id = ?)', [id]); }`;
  assert.deepEqual(at(text), [2, 3]);
});

test('REPLACE INTO and INSERT OR REPLACE INTO naming the state replace a row\'s state; plain INSERT, and REPLACE without it, do not', () => {
  const text = `
function a(ctx, id) { ctx.sql.exec('REPLACE INTO shop_orders (id, status) VALUES (?, ?)', [id, 'x']); }
function b(ctx, id) { ctx.sql.exec('INSERT OR REPLACE INTO main.shop_orders (id, "status") VALUES (?, ?)', [id, 'x']); }
function c(ctx, id) { ctx.sql.exec('INSERT INTO shop_orders (id, status) VALUES (?, ?)', [id, 'new']); }
function d(ctx, id) { ctx.sql.exec('REPLACE INTO shop_orders (id, note) VALUES (?, ?)', [id, 'n']); }
function e(ctx, id) { ctx.sql.exec('REPLACE INTO shop_lines (id, status) VALUES (?, ?)', [id, 'x']); }`;
  assert.deepEqual(at(text), [2, 3]);
});

test('a subquery before the state column does not end the SET list at its WHERE', () => {
  const text = `
function a(ctx, id) { ctx.sql.exec('UPDATE shop_orders SET total = (SELECT sum(x) FROM shop_lines WHERE shop_lines.o = ?), status = ? WHERE id = ?', [id, 'x', id]); }
function b(ctx, id) { ctx.sql.exec('UPDATE shop_orders SET (note, status) = (SELECT n, s FROM shop_lines WHERE id = ?) WHERE id = ?', [id, id]); }
function c(ctx, id) { ctx.sql.exec('UPDATE shop_orders SET total = (SELECT count(*) FROM shop_lines WHERE status = ?) WHERE id = ?', ['x', id]); }`;
  assert.deepEqual(at(text), [2, 3]);
});

test('a semicolon inside a SQL string literal does not end the SET list', () => {
  const text = `
function a(ctx, id) { ctx.sql.exec("UPDATE shop_orders SET note = 'a;b', status = ? WHERE id = ?", ['x', id]); }`;
  assert.deepEqual(at(text), [2]);
});

test('nesting of any depth, and a paren inside a literal, before the state column do not hide the write', () => {
  const text = `
function a(ctx, id) { ctx.sql.exec('UPDATE shop_orders SET total = coalesce(nullif(sum(x), 0), 1), status = ? WHERE id = ?', ['x', id]); }
function b(ctx, id) { ctx.sql.exec('UPDATE shop_orders SET total = (SELECT coalesce(sum(x), 0) FROM shop_lines), status = ? WHERE id = ?', ['x', id]); }
function c(ctx, id) { ctx.sql.exec("UPDATE shop_orders SET note = 'see (1', status = ? WHERE id = ?", ['x', id]); }
function d(ctx, id) { ctx.sql.exec("UPDATE shop_orders SET meta = json_set(meta, '$.a', json(?)), status = ? WHERE id = ?", ['{}', 'x', id]); }`;
  assert.deepEqual(at(text), [2, 3, 4, 5]);
});

test('the state read inside a SET value is not a write of it', () => {
  const text = `
function a(ctx, id) { ctx.sql.exec("UPDATE shop_orders SET priority = CASE WHEN status = 'open' THEN 1 ELSE 0 END WHERE id = ?", [id]); }
function b(ctx, id) { ctx.sql.exec('UPDATE shop_orders SET note = status || ? WHERE id = ?', ['!', id]); }
function c(ctx, id) { ctx.sql.exec('UPDATE shop_orders SET (note, title) = (SELECT status, title FROM shop_lines WHERE id = ?) WHERE id = ?', [id, id]); }`;
  assert.deepEqual(at(text), []);
});

test('REPLACE INTO with no column list replaces every column, the state among them', () => {
  const text = `
function a(ctx, id) { ctx.sql.exec('REPLACE INTO shop_orders SELECT * FROM shop_orders_staging WHERE id = ?', [id]); }
function b(ctx, id) { ctx.sql.exec('INSERT OR REPLACE INTO shop_orders VALUES (?, ?)', [id, 'x']); }`;
  assert.deepEqual(at(text), [2, 3]);
});

test('a guard in a sibling branch does not cover the write; one in an enclosing block does', () => {
  const text = `
function a(ctx, row, fast) {
  if (fast) {
    assertTransition(lc, 'order', row.status, 'shop/ship');
  } else {
    ctx.sql.exec("UPDATE shop_orders SET status = 'shipped' WHERE id = ?", [row.id]);
  }
}
function b(ctx, row, fast) {
  assertTransition(lc, 'order', row.status, 'shop/ship');
  if (fast) {
    ctx.sql.exec("UPDATE shop_orders SET status = 'shipped' WHERE id = ?", [row.id]);
  }
}`;
  assert.deepEqual(at(text), [6]);
});

test('the scan is linear: a 30-deep run of open parens and a very long SET list finish in milliseconds', { timeout: 10_000 }, () => {
  // In a child with a hard kill: a scanner that hangs (a backtracking regex, a loop that stops
  // advancing) blocks the thread synchronously, which no in-process test timeout can interrupt.
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { unguardedWrites } from ${JSON.stringify(new URL('./lifecycle-writes.mjs', import.meta.url).href)};
    const LC = [{ entity: 'order', table: 'shop_orders', field: 'status' }];
    const at = (text) => unguardedWrites([{ path: 'demos/shop/src/module.ts', text }], LC).map((h) => h.line);
    const wrap = (set) => "function a(ctx) { ctx.sql.exec('UPDATE shop_orders SET " + set + "'); }";
    const deep = wrap('total = ' + '('.repeat(30) + '1, status = ?');
    const nested = wrap('total = ' + '('.repeat(30) + '1' + ')'.repeat(30) + ', status = ?');
    const items = Array.from({ length: 5000 }, (_, i) => 'c' + i + ' = ' + '('.repeat(i % 7) + '?' + ')'.repeat(i % 7));
    const long = wrap(items.join(', ') + ', status = ?');
    const ms = [deep, nested, long].map((text) => { const s = performance.now(); at(text); return performance.now() - s; });
    console.log(JSON.stringify({ ms, nested: at(nested), long: at(long) }));
  `], { encoding: 'utf8', timeout: 8_000 });
  assert.equal(run.signal, null, 'the scan did not finish within 8 s and was killed');
  assert.equal(run.status, 0, run.stderr);
  const { ms, nested, long } = JSON.parse(run.stdout);
  for (const m of ms) assert.ok(m < 500, `took ${m} ms`);
  // Thirty unclosed parens leave the state at depth 30, which is no SET target; closed, it is one.
  assert.deepEqual(nested, [1]);
  assert.deepEqual(long, [1]);
});

test('SQL comments in a SET clause are skipped like literals', () => {
  const text = `
function a(ctx, id) { ctx.sql.exec('UPDATE shop_orders SET note = ? /* WHERE */, status = ? WHERE id = ?', ['n', 'x', id]); }
function b(ctx, id) { ctx.sql.exec(\`UPDATE shop_orders SET note = ? -- ; WHERE
  , status = ? WHERE id = ?\`, ['n', 'x', id]); }
function c(ctx, id) { ctx.sql.exec('UPDATE shop_orders SET /* status = */ note = ? WHERE id = ?', ['n', id]); }`;
  assert.deepEqual(at(text), [2, 3]);
});
