// node --test tools/override-advisories.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ACCEPT_FILE, GRACE_DAYS, check, inRange, overriddenName, parseOverrides, readAccepts, staleness, stalenessFails } from './override-advisories.mjs';

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
  // a `>` that opens a comparator is not the parent separator
  assert.equal(overriddenName('hono@>4'), 'hono');
  assert.equal(overriddenName('parent>hono@>=4'), 'hono');
  assert.equal(overriddenName('@s/parent@1>hono@>=4 <5'), 'hono');
});

test('an exact pin under a comparator selector is still judged against its package', () => {
  for (const key of ['hono@>4', 'parent>hono@>=4']) {
    const { hits } = check({ [key]: '4.13.8' }, report(adv()));
    assert.deepEqual(hits.map((h) => [h.name, h.key]), [['hono', key]]);
  }
});

test('range matching', () => {
  assert.ok(inRange('4.12.30', '>=4.12.0 <4.12.34'));
  assert.ok(!inRange('4.12.34', '>=4.12.0 <4.12.34'));
  assert.ok(inRange('4.12.34', '<=4.12.34'));
  assert.ok(inRange('1.0.0', '<1.0.0 || >=1.0.0 <1.1.0'));
  assert.ok(!inRange('2.0.0', '<1.0.0 || >=1.0.0 <1.1.0'));
  assert.ok(inRange('1.0.0-rc.1', '<1.0.0'));
  // SemVer prerelease precedence, not string order
  assert.ok(inRange('1.0.0-rc.2', '<1.0.0-rc.10'));
  assert.ok(!inRange('1.0.0-rc.10', '<1.0.0-rc.2'));
  assert.ok(inRange('1.0.0-1', '<1.0.0-alpha'));
  assert.ok(inRange('1.0.0-alpha', '<1.0.0-alpha.1'));
  assert.ok(inRange('1.0.0-rc.1', '=1.0.0-rc.1'));
  // the whole suffix survives a second hyphen
  assert.ok(!inRange('1.0.0-rc-1.2', '=1.0.0-rc-1.1'));
  assert.ok(inRange('1.0.0-rc-1.1', '<1.0.0-rc-1.2'));
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

// `pnpm view <name> time --json`, trimmed: hono's real dates around the 4.13.8 pin.
const times = {
  created: '2021-12-14T00:00:00.000Z',
  modified: '2026-10-04T03:53:48.117Z',
  '4.13.8': '2026-09-15T07:31:34.010Z',
  '4.13.9': '2026-09-24T01:32:02.438Z',
  '4.13.13': '2026-10-04T03:53:48.117Z',
  '5.0.0': '2026-08-01T00:00:00.000Z',
  '4.14.0-rc.1': '2026-08-01T00:00:00.000Z',
};
const at = (iso) => new Date(iso);
const after = (iso, days) => new Date(Date.parse(iso) + days * 24 * 60 * 60 * 1000);

test('stale once the first newer release on the line is more than GRACE_DAYS old', () => {
  const s = staleness('4.13.8', times, after(times['4.13.9'], GRACE_DAYS + 1));
  assert.deepEqual(s, { latest: '4.13.13', behindSince: times['4.13.9'], stale: true });
});

test('not stale inside the grace window, counted from the FIRST newer release', () => {
  assert.equal(staleness('4.13.8', times, after(times['4.13.9'], GRACE_DAYS - 1)).stale, false);
  // 4.13.13 is younger; it is 4.13.9's age that says how long the pin has been behind
  assert.equal(staleness('4.13.8', times, after(times['4.13.13'], GRACE_DAYS - 5)).stale, true);
});

test('the latest release on the line is never stale, however old', () => {
  assert.equal(staleness('4.13.13', times, at('2030-01-01')), null);
});

test('a newer major and a prerelease are not newer releases on the line', () => {
  const only = { '4.13.13': times['4.13.13'], '5.0.0': '2020-01-01T00:00:00Z', '4.14.0-rc.1': '2020-01-01T00:00:00Z' };
  assert.equal(staleness('4.13.13', only, at('2030-01-01')), null);
});

test('below 1.0.0 the minor is the line', () => {
  const zero = { '0.4.1': '2020-01-01T00:00:00Z', '0.4.2': '2020-02-01T00:00:00Z', '0.5.0': '2020-01-01T00:00:00Z' };
  assert.equal(staleness('0.4.2', zero, at('2030-01-01')), null);
  assert.equal(staleness('0.4.1', zero, at('2030-01-01')).latest, '0.4.2');
});

const pins = [{ key: 'hono', name: 'hono', version: '4.13.8' }];
const entry = (over) => ({ package: 'hono', version: '4.13.8', reason: 'waiting on a fix', expires: '2026-11-01', ...over });

test('an accept entry holds its pin through its expiry day, and not after', () => {
  assert.deepEqual([...readAccepts([entry()], pins, at('2026-11-01T23:00:00Z')).held], ['hono@4.13.8']);
  const r = readAccepts([entry()], pins, at('2026-11-02T00:00:00Z'));
  assert.deepEqual([...r.held], []);
  assert.deepEqual(r.expired, [entry()]);
});

test('an accept entry that names no current pin, or is malformed, is an error', () => {
  assert.match(readAccepts([entry({ version: '4.13.7' })], pins, at('2026-10-01')).errors[0], /no override pins hono@4\.13\.7/);
  for (const bad of [entry({ reason: ' ' }), entry({ expires: 'soon' }), { package: 'hono' }]) {
    assert.equal(readAccepts([bad], pins, at('2026-10-01')).errors.length, 1, JSON.stringify(bad));
  }
  assert.equal(readAccepts({}, pins, at('2026-10-01')).errors.length, 1);
});

test('an empty accept list holds nothing', () => {
  assert.deepEqual(readAccepts([], pins, at('2026-10-01')), { held: new Set(), expired: [], errors: [] });
});

test('staleness fails every run that is not a pull request, unknown events included', () => {
  for (const event of ['schedule', 'push', 'workflow_dispatch', undefined, 'merge_group']) {
    assert.equal(stalenessFails({ event }), true, String(event));
  }
});

test('on a pull request staleness fails only when the PR touches the pins', () => {
  const same = { baseOverrides: { hono: '4.13.8' }, headOverrides: { hono: '4.13.8' } };
  assert.equal(stalenessFails({ event: 'pull_request', changedFiles: ['README.md', 'pnpm-workspace.yaml'], ...same }), false);
  assert.equal(stalenessFails({ event: 'pull_request', changedFiles: ['pnpm-lock.yaml'], ...same }), true);
  assert.equal(stalenessFails({ event: 'pull_request', changedFiles: [ACCEPT_FILE], ...same }), true);
  assert.equal(stalenessFails({ event: 'pull_request', baseOverrides: { hono: '4.13.8' }, headOverrides: { hono: '4.13.9' } }), true);
  assert.equal(stalenessFails({ event: 'pull_request', baseOverrides: { hono: '4.13.8' }, headOverrides: { hono: '4.13.8', x: '1.0.0' } }), true);
  // key order is not a change
  assert.equal(stalenessFails({ event: 'pull_request', baseOverrides: { a: '1.0.0', b: '1.0.0' }, headOverrides: { b: '1.0.0', a: '1.0.0' } }), false);
});
