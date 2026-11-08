/**
 * Fixtures for `problem-refusals.mjs` (#113): a refusal built with a literal status outside the
 * problem helpers is found, a problem serialization is not, and the allowlist is held to its
 * exact count in both directions.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inScope, judge, refusalsIn } from './problem-refusals.mjs';

const lines = (src) => refusalsIn(src).map((f) => f.line);

test('every response builder with a literal refusal status is found, on its line', () => {
  const src = [
    "app.get('/a', (c) => c.json({ error: 'gone' }, 404));",
    "app.get('/b', (c) => c.text('bad', 400));",
    "app.get('/c', () => new Response('no', { status: 401 }));",
    "app.get('/d', () => Response.json({ error: 'x' }, { status: 503 }));",
    "app.get('/e', (c) => { c.status(403); return c.json({ error: 'x' }); });",
    "app.get('/f', (c) => c.json({ error: 'x' }, ok ? 200 : 409));",
    "app.get('/g', (c) => c.body(null, 404 as ContentfulStatusCode));",
    "app.get('/h', (c) => c.html(page, 403));",
    "app.get('/i', (c) => c.newResponse(null, 405));",
  ].join('\n');
  assert.deepEqual(lines(src), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
});

test("Hono's ResponseInit overload is judged by its `status`, on every builder", () => {
  const src = [
    "c.json({ error: 'gone' }, { status: 404 });",
    "c.text('bad', { status: 400, headers: { 'x-a': 'b' } });",
    'c.body(null, { status: 403 });',
    'c.html(page, { status: 401 });',
    'c.newResponse(null, { status: 410 });',
    'c.json({ ok: true }, { status: 200 });',
    'c.json(body, { headers });',
    "c.json(p, { status: 404, headers: { 'content-type': PROBLEM_CONTENT_TYPE } });",
  ].join('\n');
  assert.deepEqual(lines(src), [1, 2, 3, 4, 5]);
});

test('its twin: a call that serves the problem media type is a helper, and is not found', () => {
  const src = [
    "c.body(JSON.stringify(p), 404, { 'content-type': PROBLEM_CONTENT_TYPE });",
    "new Response(JSON.stringify(p), { status: 401, headers: { 'content-type': 'application/problem+json' } });",
    'c.body(json, 409, { ...headers, "content-type": `application/problem+json; charset=utf-8` });',
  ].join('\n');
  assert.deepEqual(lines(src), []);
});

test('JSX is parsed only where a file can hold it, and a file that cannot be parsed is named', () => {
  assert.deepEqual(refusalsIn("const n = <number>x;\nc.json({ error: 'x' }, 404);", 'apps/x/src/a.ts').map((f) => f.line), [2]);
  assert.deepEqual(refusalsIn('c.html(<p>closed</p>, 403);', 'apps/x/src/a.tsx').map((f) => f.line), [1]);
  // Babel refuses this valid TypeScript (a typed arrow in a ternary branch): red, with the file named.
  const path = 'apps/x/src/b.ts';
  const text = "const f = ok\n  ? async (h: string): Promise<void> => {}\n  : async (h: string): Promise<void> => {};\nc.json({ error: 'x' }, 404);";
  assert.match(judge([{ path, text }], []).offences[0], /^apps\/x\/src\/b\.ts: cannot be parsed/);
});

test('a computed status, a success status, and a call written in a comment or a string are not judged', () => {
  const src = [
    'c.json(body, status);',
    'new Response(body, init);',
    'c.json({ ok: true }, 201);',
    'c.redirect(url, 302);',
    "// c.json({ error: 'x' }, 404)",
    "const doc = \"c.json({ error: 'x' }, 404)\";",
  ].join('\n');
  assert.deepEqual(lines(src), []);
});

test('the allowlist is exact: more sites, fewer sites, and a vanished file are each red', () => {
  const path = 'apps/x/src/worker.ts';
  const two = "c.json({ error: 'a' }, 404);\nc.json({ error: 'b' }, 400);";
  const entries = [
    { path, sites: 1, kind: 'protocol', area: 'x', reason: 'r' },
    { path, sites: 1, kind: 'pending', area: 'x', reason: 'r' },
  ];
  // Entries for one file are summed.
  assert.deepEqual(judge([{ path, text: two }], entries).offences, []);
  assert.match(judge([{ path, text: `${two}\nc.text('c', 403);` }], entries).offences[0], /3 refusal\(s\) .* ALLOWED says 2/);
  assert.match(judge([{ path, text: "c.json({ error: 'a' }, 404);" }], entries).offences[0], /ALLOWED says 2 site\(s\), the file has 1/);
  assert.match(judge([], entries).offences[0], /gone or out of scope/);
  // A file whose last site went, and that builds no response at all any more, is held to zero.
  assert.match(judge([{ path, text: 'export const x = 1;' }], entries).offences[0], /ALLOWED says 2 site\(s\), the file has 0/);
  // A file with no entry is reported site by site, a generic call and a file naming no `Response` included.
  assert.match(judge([{ path, text: two }], []).offences[0], /^apps\/x\/src\/worker\.ts:1 {2}c\.json/);
  assert.match(judge([{ path, text: "c.json<Body>({ error: 'a' }, 404);" }], []).offences[0], /^apps\/x\/src\/worker\.ts:1 {2}c\.json<Body>/);
});

test('an ALLOWED entry with an unknown kind, an empty reason or no sites is red, and the totals stay numbers', () => {
  const path = 'apps/x/src/worker.ts';
  const { offences, totals } = judge(
    [{ path, text: "c.json({ error: 'a' }, 404);" }],
    [
      { path, sites: 1, kind: 'whatever', area: 'x', reason: 'r' },
      { path, sites: 1, kind: 'pending', area: 'x', reason: '' },
      { path, sites: 0, kind: 'pending', area: 'x', reason: 'r' },
    ],
  );
  assert.match(offences[0], /kind must be 'protocol' or 'pending', not "whatever"/);
  assert.match(offences[1], /`reason` must be a non-empty string/);
  assert.match(offences[2], /`sites` must be a whole number/);
  assert.deepEqual(totals, { protocol: 0, pending: 0 });
});

test('route code is read; tests, browser apps, configs, test support and generated files are not', () => {
  for (const path of ['apps/router/src/worker.ts', 'demos/todo/src/app.ts', 'packages/create-substrat/template/src/server.ts']) {
    assert.equal(inScope(path), true, path);
  }
  for (const path of [
    'apps/router/test/worker.test.ts',
    'apps/dashboard/web/src/api.ts',
    'demos/todo/app/src/main.tsx',
    'apps/control-plane/vitest.config.ts',
    'packages/contract-tests/src/scope-host-suite.ts',
    'packages/psl/src/data.generated.ts',
    'tools/problem-refusals.mjs',
    'spikes/x/src/worker.ts',
  ]) {
    assert.equal(inScope(path), false, path);
  }
});
