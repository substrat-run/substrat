import { test } from 'node:test';
import assert from 'node:assert/strict';
import { failureOf, publishInWaves, publishUntilSettled } from './publish-packages.mjs';
import { waitUntilServed } from './registry-wait.mjs';
import { REGISTRY, fakeRegistry, membersOf } from './registry-fake.test-helper.mjs';

// npm's own lines, as the release runs printed them.
const STAGED = `npm error code E409
npm error 409 Conflict - PUT https://registry.npmjs.org/@substrat-run%2fmodel-view - Cannot publish over previously staged version "0.6.34".
`;
const CONFLICT = 'npm error code TLOG_CREATE_ENTRY_ERROR\n';
const NOT_FOUND = 'npm error code E404\nnpm error 404 Not Found - PUT https://registry.npmjs.org/@substrat-run%2fnew\n';

/** A publish whose runs answer in turn, the last repeating, and a wait that records each call. */
function scripted(...answers) {
  const calls = { runs: 0, waits: [] };
  const run = async () => answers[Math.min(calls.runs++, answers.length - 1)];
  const wait = async (ms) => void calls.waits.push(ms);
  return { run, wait, calls };
}

const failed = (failure) => ({ code: 1, failure });
const passed = { code: 0, failure: null };

test('reads the two failures a later run clears, and no other', () => {
  assert.equal(failureOf(CONFLICT), 'conflict');
  assert.equal(failureOf(STAGED), 'staged');
  assert.equal(failureOf(NOT_FOUND), null);
  assert.equal(failureOf('npm error code E409\nnpm error 409 Conflict - something else\n'), null);
});

test('retries a transparency-log conflict once, without waiting', async () => {
  const { run, wait, calls } = scripted(failed('conflict'));
  assert.equal(await publishUntilSettled(run, { wait }), 1);
  assert.equal(calls.runs, 2);
  assert.deepEqual(calls.waits, []);
});

test('waits out a staged version, and passes once npm lists it', async () => {
  const { run, wait, calls } = scripted(failed('staged'), failed('staged'), passed);
  assert.equal(await publishUntilSettled(run, { wait, waitMs: 5 }), 0);
  assert.equal(calls.runs, 3);
  assert.deepEqual(calls.waits, [5, 5]);
});

test('gives up on a staged version after its waits', async () => {
  const { run, wait, calls } = scripted(failed('staged'));
  assert.equal(await publishUntilSettled(run, { wait, waits: 2 }), 1);
  assert.equal(calls.runs, 3);
});

test('stops at once on any other failure', async () => {
  const { run, wait, calls } = scripted(failed(null));
  assert.equal(await publishUntilSettled(run, { wait }), 1);
  assert.equal(calls.runs, 1);
});

test('the default waits outlast the longest lag seen, 4 minutes 7 seconds', async () => {
  const { run, wait, calls } = scripted(failed('staged'));
  await publishUntilSettled(run, { wait });
  assert.ok(calls.waits.reduce((sum, ms) => sum + ms, 0) > 247_000);
});

// Release #3222's shape: the CLI pins contracts and kernel, and npm serves each upload a while after taking it.
const RELEASE = membersOf({
  '@s/contracts': ['2.0.0'],
  '@s/kernel': ['2.0.0', { '@s/contracts': 'workspace:^' }],
  '@s/cli': ['1.1.0', { '@s/kernel': 'workspace:^', '@s/contracts': 'workspace:^' }],
});

/** Publish into `npm` with the given lag per package, recording what was published when, and what each publish could install. */
function releaseInto(npm, lag) {
  const published = [];
  const servedNow = async (name) => {
    const [reason] = (await waitUntilServed([{ name, version: RELEASE.get(name).version }], { registry: REGISTRY, fetch: npm.fetch, timeoutMs: 0, log: () => {} }));
    return reason === undefined;
  };
  const options = {
    log: () => {},
    publishWave: async (wave) => {
      for (const name of wave) {
        const deps = Object.keys(RELEASE.get(name).manifest.dependencies);
        published.push({ name, at: npm.now(), depsServed: (await Promise.all(deps.map(servedNow))).every(Boolean) });
        npm.publish(name, RELEASE.get(name).version, lag[name] ?? {});
      }
      return 0;
    },
    waitFor: (needs) => waitUntilServed(needs, { registry: REGISTRY, fetch: npm.fetch, sleep: npm.sleep, now: npm.now, intervalMs: 10_000, timeoutMs: 120_000, log: () => {} }),
  };
  return { published, options };
}

test('each wave is published only once npm serves every workspace package it pins', async () => {
  const npm = fakeRegistry();
  const { published, options } = releaseInto(npm, {
    '@s/contracts': { listAfterMs: 15_000, tarballAfterMs: 35_000 },
    '@s/kernel': { listAfterMs: 5_000 },
  });
  assert.equal(await publishInWaves(RELEASE, options), 0);
  assert.deepEqual(published, [
    { name: '@s/contracts', at: 0, depsServed: true },
    { name: '@s/kernel', at: 40_000, depsServed: true },
    { name: '@s/cli', at: 50_000, depsServed: true },
  ]);
});

test('a dependency npm never serves stops the release before anything that pins it, naming the version', async () => {
  const npm = fakeRegistry();
  const { published, options } = releaseInto(npm, { '@s/contracts': { listAfterMs: 0, tarballAfterMs: Infinity } });
  const lines = [];
  assert.equal(await publishInWaves(RELEASE, { ...options, log: (l) => lines.push(l) }), 1);
  assert.deepEqual(published.map((p) => p.name), ['@s/contracts']);
  assert.match(lines.at(-1), /wave 2 of 3 and every wave after it are NOT published:\n  @s\/contracts@2\.0\.0: its tarball answered 404/);
});

test('a wave that fails to publish stops the waves after it, with its exit code', async () => {
  const waves = [];
  const code = await publishInWaves(RELEASE, { log: () => {}, waitFor: async () => [], publishWave: async (wave) => (waves.push(wave), 7) });
  assert.equal(code, 7);
  assert.deepEqual(waves, [['@s/contracts']]);
});
