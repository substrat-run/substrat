import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installClosure, needsBefore, publishWaves, unservedReason, waitUntilServed } from './registry-wait.mjs';
import { REGISTRY, fakeRegistry, membersOf } from './registry-fake.test-helper.mjs';

// The shape of the real graph: contracts under kernel under the CLI, a private app beside them.
const MEMBERS = membersOf({
  '@s/contracts': ['1.0.0'],
  '@s/kernel': ['1.0.0', { '@s/contracts': 'workspace:^' }],
  '@s/cli': ['2.0.0', { '@s/kernel': 'workspace:^', '@s/contracts': 'workspace:*', zod: 'catalog:' }],
  // A peer edge orders like a dependency; a dev edge and a registry range do not.
  '@s/engine': ['3.0.0', {}, { peerDependencies: { '@s/kernel': 'workspace:^' }, devDependencies: { '@s/cli': 'workspace:*' } }],
  '@s/pinned': ['1.0.0', { '@s/cli': '^2.0.0' }],
  '@s/app': ['0.0.0', { '@s/cli': 'workspace:*' }, { private: true }],
});

test('waves put every public package after the workspace packages it installs', () => {
  assert.deepEqual(publishWaves(MEMBERS), [['@s/contracts', '@s/pinned'], ['@s/kernel'], ['@s/cli', '@s/engine']]);
  assert.deepEqual(needsBefore(['@s/cli', '@s/engine'], MEMBERS), [
    { name: '@s/contracts', version: '1.0.0' },
    { name: '@s/kernel', version: '1.0.0' },
  ]);
  assert.deepEqual(installClosure(['@s/cli', '@s/app'], MEMBERS).map((t) => t.name), ['@s/cli', '@s/contracts', '@s/kernel']);
});

test('a runtime cycle has no wave order, and names its members', () => {
  const cyclic = membersOf({ a: ['1.0.0', { b: 'workspace:*' }], b: ['1.0.0', { a: 'workspace:*' }], c: ['1.0.0'] });
  assert.throws(() => publishWaves(cyclic), /depend on each other at runtime.*: a, b$/);
});

test('served means listed by the abbreviated packument AND a tarball answering 200, asked in that order', async () => {
  const npm = fakeRegistry();
  const target = { name: '@s/contracts', version: '1.0.0' };
  const ask = () => unservedReason(target, { registry: REGISTRY, fetch: npm.fetch });

  assert.equal(await ask(), 'the registry has no packument for it yet');
  npm.publish('@s/contracts', '1.0.0', { listAfterMs: 10, tarballAfterMs: 20 });
  assert.equal(await ask(), 'the packument does not list it yet');
  // An unlisted version's tarball is never requested, so the poll cannot get a 404 cached for it.
  assert.ok(npm.requests.every((r) => !r.url.endsWith('.tgz')));
  await npm.sleep(10);
  // Release #3222's scaffold: listed, and the tarball still 404.
  assert.equal(await ask(), 'its tarball answered 404');
  await npm.sleep(10);
  assert.equal(await ask(), null);
  assert.equal(npm.requests.at(-1).method, 'HEAD');
  assert.equal(npm.requests.at(-2).url, `${REGISTRY}/@s%2fcontracts`);
});

test('the wait asks until every target is served, and a failed request is waited out, not thrown', async () => {
  const npm = fakeRegistry();
  npm.publish('@s/contracts', '1.0.0', { listAfterMs: 25_000, tarballAfterMs: 45_000 });
  npm.publish('@s/kernel', '1.0.0');
  let failures = 1;
  const flaky = async (url, init) => {
    if (failures-- > 0) throw new Error('ECONNRESET');
    return npm.fetch(url, init);
  };
  const lines = [];
  const missing = await waitUntilServed(
    [{ name: '@s/contracts', version: '1.0.0' }, { name: '@s/kernel', version: '1.0.0' }, { name: '@s/kernel', version: '1.0.0' }],
    { registry: REGISTRY, fetch: flaky, sleep: npm.sleep, now: npm.now, intervalMs: 10_000, timeoutMs: 60_000, log: (l) => lines.push(l) },
  );
  assert.deepEqual(missing, []);
  assert.equal(npm.now(), 50_000);
  assert.equal(lines.length, 5);
});

test('the wait is bounded, and resolves to what npm still does not serve with the reason it gave', async () => {
  const npm = fakeRegistry();
  npm.publish('@s/contracts', '1.0.0', { listAfterMs: 0, tarballAfterMs: Infinity });
  npm.publish('@s/kernel', '1.0.0');
  const missing = await waitUntilServed(
    [{ name: '@s/contracts', version: '1.0.0' }, { name: '@s/kernel', version: '1.0.0' }],
    { registry: REGISTRY, fetch: npm.fetch, sleep: npm.sleep, now: npm.now, intervalMs: 10_000, timeoutMs: 30_000, log: () => {} },
  );
  assert.deepEqual(missing, [{ name: '@s/contracts', version: '1.0.0', reason: 'its tarball answered 404' }]);
  assert.equal(npm.now(), 30_000);
});
