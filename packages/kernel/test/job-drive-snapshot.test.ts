import { describe, expect, it } from 'vitest';
import type { ScopeStub } from '../src/scope-host.js';
import { runDueJobRuns, type JobRunRow, type JobRunStore } from '../src/job-run.js';
import { memoryJobStore } from './job-store-memory.js';

/**
 * #1834 (#2028 review r3): a drive's selection is ONE snapshot of due keys, and each run is
 * claimed just before it runs (#2034). A store paged across several reads met rows another writer moved
 * in between, and a drive ran one twice or skipped it. Here a hook moves rows AFTER the snapshot
 * and BEFORE the claims, and the drive must act on each row as it is at its claim, each at most
 * once, leaving anything that moved to the next drive. Two OVERLAPPING drives are
 * `job-lease.test.ts`'s.
 */
const NOW = '2026-10-04T12:00:00.000Z';
const PAST = '2026-10-04T11:00:00.000Z';
const FUTURE = '2026-10-04T13:00:00.000Z';

function rowOf(id: string, nextAttemptAt: string | null = null): JobRunRow {
  return {
    id,
    module_id: '@test/jobs',
    job: 'count',
    instance: id,
    payload: '{}',
    subject_id: null,
    status: 'running',
    cursor: null,
    counters: '{}',
    attempts: 0,
    last_error: null,
    started_at: PAST,
    updated_at: PAST,
    next_attempt_at: nextAttemptAt,
    ended_at: null,
  };
}

const storeOf = memoryJobStore;

/** Drive once with `limit`, counting each run's passes. With `advance`, a pass leaves its run going. */
async function drive(store: JobRunStore, ran: string[], limit: number, advance = false) {
  return runDueJobRuns({
    store,
    handlerFor: () => ({
      handler: (pass) => {
        ran.push(pass.run.id);
        return { done: !advance };
      },
    }),
    now: () => NOW,
    openScope: async () => ({}) as ScopeStub,
    limit,
  });
}

describe('#1834: a drive acts on one snapshot, each row claimed before it runs', () => {
  it('twin: nothing moves, and the snapshot runs in due order up to the limit', async () => {
    const ran: string[] = [];
    const { store } = storeOf([rowOf('A'), rowOf('B'), rowOf('C')]);
    expect(await drive(store, ran, 2)).toMatchObject({ attempted: 2, completed: 2 });
    expect(ran).toEqual(['A', 'B']);
  });

  it('a run moved past now after the snapshot is skipped at its claim, and the next drive takes it', async () => {
    const ran: string[] = [];
    const { store, table } = storeOf([rowOf('A'), rowOf('B'), rowOf('C')], {
      afterSnapshot: (rows) => {
        const b = rows.get('B')!;
        if (b.next_attempt_at === null) rows.set('B', { ...b, next_attempt_at: FUTURE }); // a concurrent defer, once
      },
    });
    expect(await drive(store, ran, 2)).toMatchObject({ attempted: 1, completed: 1 });
    expect(ran).toEqual(['A']); // B was picked, then moved: not run. C was not picked: next drive's.
    table.set('B', { ...table.get('B')!, next_attempt_at: PAST }); // its wait is over
    expect(await drive(store, ran, 2)).toMatchObject({ attempted: 2, completed: 2 });
    expect(ran).toEqual(['A', 'B', 'C']);
  });

  it('a run a concurrent drive finished after the snapshot is skipped, never run again', async () => {
    const ran: string[] = [];
    const { store } = storeOf([rowOf('A'), rowOf('B')], {
      afterSnapshot: (rows) => rows.set('B', { ...rows.get('B')!, status: 'done' }),
    });
    expect(await drive(store, ran, 2)).toMatchObject({ attempted: 1, completed: 1 });
    expect(ran).toEqual(['A']);
  });

  // Its pass ADVANCES, so after it the run is still running and due: only the dedupe, not the
  // claim, stands between the repeated key and a second pass in the same drive.
  it('a key the snapshot names twice runs once in the drive', async () => {
    const ran: string[] = [];
    const { store } = storeOf([rowOf('A'), rowOf('B')], { duplicate: 'A' });
    expect(await drive(store, ran, 3, true)).toMatchObject({ attempted: 2, advanced: 2 });
    expect(ran).toEqual(['A', 'B']);
  });

  it('a run that became due after the snapshot is not lost: the next drive runs it', async () => {
    const ran: string[] = [];
    const { store } = storeOf([rowOf('A'), rowOf('D', FUTURE)], {
      afterSnapshot: (rows) => rows.set('D', { ...rows.get('D')!, next_attempt_at: PAST }),
    });
    expect(await drive(store, ran, 2)).toMatchObject({ attempted: 1 });
    expect(ran).toEqual(['A']);
    expect(await drive(store, ran, 2)).toMatchObject({ attempted: 1 });
    expect(ran).toEqual(['A', 'D']);
  });
});
