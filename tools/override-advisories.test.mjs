// node --test tools/override-advisories.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { check, inRange, overriddenName, parseOverrides } from './override-advisories.mjs';

const yaml = `packages:
  - 'packages/*'

overrides:
  # a comment inside the block

  hono: 4.13.8   # trailing
  better-sqlite3: 13.0.3
  '@scope/pkg': "1.2.3"
  'a>b': 2.0.0

peerDependencyRules:
  allowedVersions:
    x>y: '13'
`;

const adv = (over) => ({
  github_advisory_id: 'GHSA-aaaa-bbbb-cccc',
  module_name: 'hono',
  severity: 'low',
  title: 'something',
  url: 'https://github.com/advisories/GHSA-aaaa-bbbb-cccc',
  vulnerable_versions: '<4.13.9',
  patched_versions: '>=4.13.9',
  ...over,
});
const report = (...advisories) => ({ advisories: Object.fromEntries(advisories.map((a, i) => [String(i), a])) });
const overrides = { hono: '4.13.8', 'better-sqlite3': '13.0.3' };

test('parses the overrides block and stops at the next top-level key', () => {
  assert.deepEqual(parseOverrides(yaml), { hono: '4.13.8', 'better-sqlite3': '13.0.3', '@scope/pkg': '1.2.3', 'a>b': '2.0.0' });
});

test('no overrides block is an empty map', () => {
  assert.deepEqual(parseOverrides("packages:\n  - 'x'\n"), {});
});

test('names the package an override key selects', () => {
  assert.equal(overriddenName('hono'), 'hono');
  assert.equal(overriddenName('a>b'), 'b');
  assert.equal(overriddenName('b@<2'), 'b');
  assert.equal(overriddenName('@s/p@1'), '@s/p');
  assert.equal(overriddenName('@s/p'), '@s/p');
});

test('range matching', () => {
  assert.ok(inRange('4.12.30', '>=4.12.0 <4.12.34'));
  assert.ok(!inRange('4.12.34', '>=4.12.0 <4.12.34'));
  assert.ok(inRange('4.12.34', '<=4.12.34'));
  assert.ok(inRange('1.0.0', '<1.0.0 || >=1.0.0 <1.1.0'));
  assert.ok(!inRange('2.0.0', '<1.0.0 || >=1.0.0 <1.1.0'));
  assert.ok(inRange('1.0.0-rc.1', '<1.0.0'));
  assert.throws(() => inRange('1.0.0', '^1.0.0'));
});

test('an advisory of ANY severity against a pinned version is a hit', () => {
  for (const severity of ['low', 'moderate', 'high', 'critical']) {
    const { hits } = check(overrides, report(adv({ severity })));
    assert.equal(hits.length, 1, severity);
    assert.equal(hits[0].name, 'hono');
    assert.equal(hits[0].version, '4.13.8');
  }
});

test('reported per package', () => {
  const { hits } = check(
    overrides,
    report(adv({ github_advisory_id: 'GHSA-1' }), adv({ module_name: 'better-sqlite3', vulnerable_versions: '>=13.0.0 <13.1.0', github_advisory_id: 'GHSA-2' })),
  );
  assert.deepEqual(hits.map((h) => h.name), ['better-sqlite3', 'hono']);
});

test('the pinned version is what is judged: a fixed pin is clean', () => {
  const { hits } = check(overrides, report(adv({ vulnerable_versions: '<4.13.8' })));
  assert.deepEqual(hits, []);
});

test('an advisory on a package that is not overridden is ignored', () => {
  const { hits } = check(overrides, report(adv({ module_name: 'vite', severity: 'moderate', vulnerable_versions: '<99.0.0' })));
  assert.deepEqual(hits, []);
});

test('an override with no advisory passes', () => {
  assert.deepEqual(check(overrides, report()), { hits: [], unjudgeable: [] });
});

test('an ignored GHSA id stays expressible, and only that id', () => {
  const both = report(adv({ github_advisory_id: 'GHSA-1' }), adv({ github_advisory_id: 'GHSA-2' }));
  const { hits } = check(overrides, both, ['GHSA-1']);
  assert.deepEqual(hits.map((h) => h.advisory.github_advisory_id), ['GHSA-2']);
});

test('fails closed: no advisories map means the lookup failed', () => {
  assert.throws(() => check(overrides, { error: { code: 'ENOTFOUND' } }), /lookup failed/);
  assert.throws(() => check(overrides, null), /lookup failed/);
});

test('fails closed: a non-exact override cannot be judged and is not green', () => {
  const r = check({ hono: '^4.13.8', 'better-sqlite3': '13.0.3' }, report());
  assert.deepEqual(r.unjudgeable, ['hono: ^4.13.8']);
});
