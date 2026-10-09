/**
 * `pnpm test:workerd-rejections` (#2131): the workerd setup file, held to the cases it exists for,
 * by running suites that leave a rejection where it must be caught — in workerd, through vitest,
 * as a real suite runs. The fixtures live beside the adapter that supplies their Durable Object
 * (`packages/adapter-cloudflare/rejection-fixtures`); they fail on purpose, so their config is
 * never part of `pnpm test`. Needs the build, like the adapter's own suite.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';

const adapter = resolve(import.meta.dirname, '../../packages/adapter-cloudflare');
const scratch = mkdtempSync(join(tmpdir(), 'workerd-rejections-'));
/** @type {Map<string, { status: string, message: string, tests: string[] }>} */
const files = new Map();

before(() => {
  const report = join(scratch, 'report.json');
  const run = spawnSync(
    join(adapter, 'node_modules/.bin/vitest'),
    ['run', '-c', 'vitest.rejection-fixtures.config.ts', '--reporter=json', `--outputFile=${report}`],
    { cwd: adapter, encoding: 'utf8', timeout: 300_000 },
  );
  // Each test below judges one fixture file; the run as a whole fails by design.
  assert.equal(run.error, undefined, String(run.error));
  for (const file of JSON.parse(readFileSync(report, 'utf8')).testResults) {
    files.set(basename(file.name), {
      status: file.status,
      message: file.message ?? '',
      tests: file.assertionResults.map((/** @type {{ status: string }} */ t) => t.status),
    });
  }
});
after(() => rmSync(scratch, { recursive: true, force: true }));

/** The file failed while every test in it passed: only the file-level check can have failed it. */
function failedAsAFile(name, raised) {
  const file = files.get(name);
  assert.ok(file, `${name} did not run`);
  assert.equal(file.status, 'failed', `${name} passed`);
  assert.deepEqual(new Set(file.tests), new Set(['passed']));
  assert.match(file.message, raised);
}

test('twin: rejections every caller observes fail nothing', () => {
  const file = files.get('awaited.fixture.ts');
  assert.equal(file?.status, 'passed', file?.message);
});

test('a rejection that lands in a later test fails the file, though a retry passes that test', () => {
  failedAsAFile('cross-test.fixture.ts', /a rejection nobody handled, landed during "b: .*": cross-test/);
});

test('a rejection the last test left due on the next turn fails the file', () => {
  failedAsAFile('late-timer.fixture.ts', /late-timer: raised after the last test/);
});
