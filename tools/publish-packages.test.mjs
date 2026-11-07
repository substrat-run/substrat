import { test } from 'node:test';
import assert from 'node:assert/strict';
import { failureOf, publishUntilSettled } from './publish-packages.mjs';

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
