// The static half of tools/peer-floor.mjs, held so a rule that stopped refusing is red.
// The floor half installs from npm and is exercised by `pnpm lint:peer-floor` itself.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inRange, parseRange, staticProblems } from './peer-floor.mjs';

const WORKSPACE = { '@substrat-run/kernel': '0.213.0', '@substrat-run/contracts': '0.213.0' };
const RANGE = '>=0.213.0 <1.0.0';
const good = () => ({
  peerDependencies: { '@substrat-run/kernel': RANGE, '@substrat-run/contracts': RANGE },
  devDependencies: { '@substrat-run/kernel': 'workspace:*', '@substrat-run/contracts': 'workspace:*' },
});

test('a peer pair in the shape, admitting the workspace, with workspace:* dev links, holds', () => {
  assert.deepEqual(staticProblems(good(), WORKSPACE), []);
});

test('each broken rule is refused', () => {
  const cases = [
    ['a regular dependency', (m) => (m.dependencies = { '@substrat-run/kernel': 'workspace:^' }), /regular dependency/],
    ['a missing peer', (m) => delete m.peerDependencies['@substrat-run/contracts'], /contracts is not a peerDependency/],
    ['a caret range', (m) => (m.peerDependencies['@substrat-run/kernel'] = '^0.213.0'), /not of the shape/],
    ['a floor above the workspace', (m) => (m.peerDependencies['@substrat-run/kernel'] = '>=0.214.0 <1.0.0'), /does not admit the workspace's 0\.213\.0/],
    ['no workspace link', (m) => (m.devDependencies['@substrat-run/kernel'] = 'workspace:^'), /workspace:\*/],
  ];
  for (const [name, breakIt, expected] of cases) {
    const m = good();
    breakIt(m);
    const problems = staticProblems(m, WORKSPACE);
    assert.equal(problems.length, 1, `${name}: ${problems.join('; ')}`);
    assert.match(problems[0], expected, name);
  }
});

test('the range reads its floor and ceiling', () => {
  const r = parseRange('>=0.213.0 <1.0.0');
  assert.equal(r.floor, '0.213.0');
  assert.ok(inRange('0.213.0', r) && inRange('0.999.4', r));
  assert.ok(!inRange('0.212.9', r) && !inRange('1.0.0', r));
});
