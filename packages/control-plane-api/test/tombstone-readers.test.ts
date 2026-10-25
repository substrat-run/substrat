import { execFileSync } from 'node:child_process';
import { expect, it } from 'vitest';

/**
 * #2563: `readTombstoneTable` is the one table read that is NOT guarded against a scope the
 * deployment does not hold, because the carry asks a wiped copy for its tombstone. Nothing that
 * shows a person data may reach it by accident, so its callers are named here: a new caller fails
 * this test and has to be argued into the list.
 */
const ALLOWED_CALLERS = [
  'packages/control-plane-api/src/api.ts', // isCarriedAway
  'packages/control-plane-api/src/scope-copy-cleanup.ts', // hasCarriedAwayTombstone
  'packages/vertical-host/src/index.ts', // the vertical's route, without `held=1`
];

it('only the carry and its cleanup call readTombstoneTable', () => {
  const out = execFileSync('git', ['grep', '-l', '-E', '\\.readTombstoneTable\\(', '--', 'apps', 'packages', ':(exclude)**/test/**', ':(exclude)**/dist/**'], {
    encoding: 'utf8',
    cwd: new URL('../../..', import.meta.url).pathname,
  });
  expect(out.split('\n').filter(Boolean).sort()).toEqual([...ALLOWED_CALLERS].sort());
});
