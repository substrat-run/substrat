import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

/**
 * #2563: `readTombstoneTable` is the one table read that is NOT guarded against a scope the
 * deployment does not hold, because the carry asks a wiped copy for its tombstone. Nothing that
 * shows a person data may reach it by accident, so the files that mention it are named here: a new
 * one fails this test and has to be argued into the list. The name is judged wherever it appears
 * (a call, a destructuring, a bracket access, a `bind`, a callback), in every tracked source file
 * of the repo, not only in the shape of a call.
 */
const DEFINERS = [
  'packages/adapter-cloudflare/src/host.ts',
  'packages/adapter-sqlite/src/index.ts',
  'packages/vertical-host/src/index.ts', // the vertical's route, without `held=1`
  'packages/control-plane-api/src/vertical-client.ts',
];
const CALLERS = [
  'packages/control-plane-api/src/api.ts', // isCarriedAway
  'packages/control-plane-api/src/scope-copy-cleanup.ts', // hasCarriedAwayTombstone
];

const root = fileURLToPath(new URL('../../..', import.meta.url));

const isSource = (f: string) =>
  /\.(?:[cm]?[jt]sx?)$/.test(f) && !/(?:^|\/)(?:test|tests|dist|node_modules)\//.test(f) && !/\.(?:test|spec)\./.test(f);

it('only the carry and its cleanup reach readTombstoneTable, and only the hosts and client define it', () => {
  const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    .split('\0')
    .filter(isSource);
  expect(tracked.length).toBeGreaterThan(1000); // the scan saw the repo, not an empty list
  const mentioning = tracked.filter((f) => readFileSync(`${root}${f}`, 'utf8').includes('readTombstoneTable'));
  expect(mentioning.sort()).toEqual([...DEFINERS, ...CALLERS].sort());
});
