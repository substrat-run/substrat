import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findBareRegExps } from './bare-regexp.mjs';

const lines = (src) => findBareRegExps(src).map((f) => f.line);

test('refuses a RegExp literal as a toMatchObject value', () => {
  assert.deepEqual(lines("expect(x).toMatchObject({ detail: /zzz/ });"), [1]);
});

test('refuses it nested in objects and arrays, and across lines', () => {
  const src = [
    'expect(x).toMatchObject({',
    '  status: "failed",',
    '  inner: { list: [{ detail: /sha256/i }] },',
    '});',
  ].join('\n');
  assert.deepEqual(lines(src), [3]);
});

test('refuses new RegExp(...) and RegExp(...), once each', () => {
  assert.deepEqual(lines("expect(x).toMatchObject({ a: new RegExp('zzz'), b: RegExp(/q/) });"), [1, 1]);
});

test('refuses a RegExp as the whole argument, in a chain, and in a conditional', () => {
  assert.equal(findBareRegExps('expect(x).toMatchObject(/zzz/);').length, 1);
  assert.equal(findBareRegExps('await expect(p).resolves.toMatchObject({ a: /z/ });').length, 1);
  assert.equal(findBareRegExps('expect(x).toMatchObject({ a: c ? /z/ : /y/ });').length, 2);
});

test('accepts expect.stringMatching, the remedy', () => {
  assert.deepEqual(findBareRegExps('expect(x).toMatchObject({ detail: expect.stringMatching(/zzz/) });'), []);
});

test('accepts any asymmetric matcher around the pattern: they compare with equals', () => {
  assert.deepEqual(findBareRegExps('expect(x).toMatchObject({ n: expect.objectContaining({ d: /z/ }) });'), []);
  assert.deepEqual(findBareRegExps('expect(x).toMatchObject({ n: expect.arrayContaining([/z/]) });'), []);
});

test('accepts a pattern used as a function argument or member inside the object', () => {
  assert.deepEqual(findBareRegExps("expect(x).toMatchObject({ id: raw.replace(/-/g, '') });"), []);
  assert.deepEqual(findBareRegExps('expect(x).toMatchObject({ [/z/.source]: 1 });'), []);
});

test('accepts the forms that work: toEqual, objectContaining, toHaveProperty, toMatch, toThrow', () => {
  assert.deepEqual(findBareRegExps('expect(x).toEqual({ a: /z/ });'), []);
  assert.deepEqual(findBareRegExps('expect(x).toEqual(expect.objectContaining({ a: /z/ }));'), []);
  assert.deepEqual(findBareRegExps("expect(x).toHaveProperty('a', /z/);"), []);
  assert.deepEqual(findBareRegExps('expect(x.detail).toMatch(/z/);'), []);
  assert.deepEqual(findBareRegExps('expect(f).toThrow(/z/);'), []);
});

test('is not fooled by strings, templates, comments or a division', () => {
  assert.deepEqual(findBareRegExps("const s = 'toMatchObject({ a: /z/ })';"), []);
  assert.deepEqual(findBareRegExps('// expect(x).toMatchObject({ a: /z/ })'), []);
  assert.deepEqual(findBareRegExps('expect(x).toMatchObject({ a: `${y / 2} /z/` });'), []);
  assert.deepEqual(findBareRegExps('expect(x).toMatchObject({ a: n / 2, b: m / 3 });'), []);
  assert.deepEqual(findBareRegExps("expect(x).toMatchObject({ a: 'a/b', b: 1 }); const r = /z/;"), []);
});

test('a template with a ${} that holds braces and a regex does not derail the scan', () => {
  const src = 'const t = `${ {a: 1}.a } ${ /x/.source }`;\nexpect(x).toMatchObject({ a: /z/ });';
  assert.deepEqual(lines(src), [2]);
});

test('a slash inside a regex character class does not end the literal', () => {
  assert.deepEqual(lines('expect(x).toMatchObject({ a: /[/]z/ });'), [1]);
});

test('reports the line of the pattern, not of the call', () => {
  assert.deepEqual(lines('\n\nexpect(x).toMatchObject({\n  a: 1,\n  b: /z/,\n});'), [5]);
});

test('a division after ) or ] is a division, not the start of a pattern', () => {
  assert.deepEqual(findBareRegExps('expect(x).toMatchObject({ a: (n) / 2, b: arr[0] / 3 });'), []);
});

test('only a toMatchObject CALL is read, not a mention of the name', () => {
  assert.deepEqual(findBareRegExps('const m = { toMatchObject: 1, a: /z/ };'), []);
  assert.deepEqual(findBareRegExps('expect(m.toMatchObject).toBeDefined(); const r = { a: /z/ };'), []);
});
