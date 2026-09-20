import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  errorCodeOf,
  moduleId,
  permissionKey,
  platformActorId,
  principalId,
  scopeId,
  tenantId,
  type PrincipalId,
  type ScopeId,
} from '@substrat-run/contracts';
import { ulid, type JobPassContext, type ScopeHost } from '@substrat-run/kernel';
import type { ScopeHostFixture } from './scope-host-suite.js';
import { jobsMod } from './modules.js';

const JOBS_MODULE = moduleId.parse('@test/jobs');

/**
 * The fourth driver's contract (#1577), against both adapters.
 *
 * What this pins is the difference between the run driver and the three that came
 * before it: a run STOPS and CARRIES ON. Every assertion is written so it can only
 * pass if work actually survived a boundary, never because a counter in the test
 * process happened to agree with itself:
 *
 * - The walk's steps write through a real operation into the scope, into a table with
 *   no unique key, so a repeated step is a DUPLICATE ROW — loud, not absorbed.
 * - The interruption is a handler that throws AFTER a step committed, which is what a
 *   worker eviction looks like from the driver's side: the step's effect happened and
 *   the pass never returned, which is the state resume has to be correct about.
 * - Coalescing is asserted on the RUN ID, because "returns the live run" is a claim
 *   about identity; two rows sharing a key would satisfy any count-based check.
 *
 * **A scope per test, deliberately.** `runDueJobs` is a SCOPE-wide driver — that is
 * what it is for — so runs one test leaves behind are due work for the next one, and
 * assertions like "nothing is due now" would be about the suite's history rather than
 * about the driver. One scope each makes every count in here absolute.
 */
export function jobRunContractSuite(
  adapterName: string,
  makeFixture: () => Promise<ScopeHostFixture>,
): void {
  describe(`resumable run driver (#1577): ${adapterName}`, () => {
    let fixture: ScopeHostFixture;
    let host: ScopeHost;
    const t = tenantId.parse(ulid());
    const reader: PrincipalId = principalId.parse(ulid());
    const staff = platformActorId.parse(ulid());

    /**
     * The step after which the next pass "is evicted" — set by a test, consumed once.
     */
    let evictAfter: string | null = null;

    /** Passes that have entered the walk handler — the replay counter. */
    let passes = 0;

    /** A scope of its own, with the module's system grant on it. */
    const newScope = async (): Promise<ScopeId> => {
      const s = scopeId.parse(ulid());
      await host.provisionScope(staff, { tenantId: t, scopeId: s, vertical: 'jobs-vertical' });
      await host.admin.activateScope(staff, t, s);
      // A job's authority is an ordinary system grant — the same tuple a schedule's
      // declaration projects, written by hand because this module declares no
      // schedules. Nothing about a job invents a second way in.
      await host.admin.grantToSystem(staff, {
        moduleId: JOBS_MODULE,
        permission: permissionKey.parse('jobs:write'),
        node: { tenantId: t, scopeId: s },
        grantedBy: staff,
      });
      return s;
    };

    const items = async (s: ScopeId): Promise<string[]> => {
      const stub = await host.getScope(reader, t, s);
      return (await stub.invoke('jobs/items')) as string[];
    };

    const runOf = async (s: ScopeId, id: string) =>
      (await host.jobRuns(t, s)).find((r) => r.id === id);

    beforeAll(async () => {
      fixture = await makeFixture();
      host = fixture.host;
      host.registerModule(jobsMod);

      /**
       * The walk: a bounded chunk per pass, resuming at the cursor.
       *
       * `pass.count` sits OUTSIDE the step and `scope.invoke` sits INSIDE it, and that
       * split is the whole demonstration. On a replay the loop re-runs for every item
       * in the chunk — so the counter re-accumulates and is right — while the committed
       * steps return their memo and write nothing. If the memo ever stops working the
       * counter still agrees with itself and the SCOPE grows a duplicate; only the
       * scope can tell you.
       */
      host.registerJob(
        JOBS_MODULE,
        'walk',
        async (pass: JobPassContext) => {
          passes += 1;
          const { total, chunk } = pass.payload as { total: number; chunk: number };
          const from = (pass.cursor as number | null) ?? 0;
          const to = Math.min(from + chunk, total);
          const scope = await pass.scope();
          for (let i = from; i < to; i += 1) {
            const item = `item-${i}`;
            await pass.step(item, () => scope.invoke('jobs/record', { item }));
            pass.count('walked');
            if (evictAfter === item) {
              evictAfter = null;
              throw new Error(`evicted after ${item}`);
            }
          }
          return { cursor: to, done: to >= total };
        },
        // Immediate retries: `backoffAt` skips jitter at zero delay, so a re-drive in
        // the same millisecond is due rather than racing the wall clock.
        { maxAttempts: 4, baseDelayMs: 0 },
      );

      // A job whose step never succeeds — the terminal-failure half of the contract.
      host.registerJob(
        JOBS_MODULE,
        'doomed',
        async (pass: JobPassContext) => {
          await pass.step('always-fails', () => {
            throw new Error('upstream said no');
          });
          return { done: true };
        },
        { maxAttempts: 3, baseDelayMs: 0 },
      );

      // A job that asks for one step name twice in one pass — the determinism rule's
      // mechanical half. Both bodies would run on a fresh pass and only the first
      // would ever be recorded, so the second is refused rather than memo-aliased.
      host.registerJob(
        JOBS_MODULE,
        'ambiguous',
        async (pass: JobPassContext) => {
          await pass.step('same', () => 1);
          await pass.step('same', () => 2);
          return { done: true };
        },
        { maxAttempts: 2, baseDelayMs: 0 },
      );

      await host.admin.createTenant(staff, { id: t, slug: 'jobs', name: 'Jobs' });
      await host.admin.grantEntitlement(staff, t, 'jobs');
    });

    afterAll(async () => {
      await fixture.cleanup();
    });

    it('joins the run already in flight instead of starting a second', async () => {
      const s = await newScope();
      const first = await host.startJobRun(t, s, {
        moduleId: JOBS_MODULE,
        job: 'walk',
        instance: 'source-a',
        payload: { total: 5, chunk: 2 },
      });
      const second = await host.startJobRun(t, s, {
        moduleId: JOBS_MODULE,
        job: 'walk',
        instance: 'source-a',
        // A DIFFERENT payload, deliberately: a join returns the live run unchanged, so
        // the walk already happening is not quietly re-aimed by whoever asked second.
        payload: { total: 500, chunk: 2 },
      });
      expect(second.id).toBe(first.id);
      expect(second.payload).toEqual({ total: 5, chunk: 2 });
      expect(await host.jobRuns(t, s, { job: 'walk' })).toHaveLength(1);

      // A different INSTANCE is a different walk and does not join.
      const other = await host.startJobRun(t, s, {
        moduleId: JOBS_MODULE,
        job: 'walk',
        instance: 'source-b',
        payload: { total: 4, chunk: 2 },
      });
      expect(other.id).not.toBe(first.id);
      expect(await host.jobRuns(t, s, { job: 'walk' })).toHaveLength(2);
    });

    it('resumes from the last committed cursor, and repeats no step before it', async () => {
      const s = await newScope();
      const run = await host.startJobRun(t, s, {
        moduleId: JOBS_MODULE,
        job: 'walk',
        instance: 'source-a',
        payload: { total: 5, chunk: 2 },
      });

      // Pass 1 commits the first chunk: items 0 and 1, cursor 2.
      let report = await host.runDueJobs(t, s);
      expect(report).toMatchObject({ attempted: 1, advanced: 1, completed: 0, failed: 0 });
      expect(await items(s)).toEqual(['item-0', 'item-1']);
      expect((await runOf(s, run.id))?.cursor).toBe(2);

      // Pass 2 is EVICTED after item-2: its write committed, the pass did not return.
      evictAfter = 'item-2';
      const before = passes;
      report = await host.runDueJobs(t, s);
      expect(report.retrying).toBe(1);
      expect(await items(s)).toEqual(['item-0', 'item-1', 'item-2']);
      // Nothing the evicted pass produced was committed: the cursor is still where
      // pass 1 left it, so "resume" cannot be satisfied by the cursor having moved.
      const evicted = await runOf(s, run.id);
      expect(evicted?.cursor).toBe(2);
      expect(evicted?.status).toBe('running');
      expect(evicted?.lastError).toContain('evicted after item-2');
      expect(evicted?.attempts).toBe(1);

      // Pass 3 replays the SAME chunk from cursor 2. item-2's step returns its memo
      // and writes nothing; item-3 runs for the first time. A broken memo shows up
      // here as a second 'item-2' in the scope.
      report = await host.runDueJobs(t, s);
      expect(report.advanced).toBe(1);
      expect(await items(s)).toEqual(['item-0', 'item-1', 'item-2', 'item-3']);
      expect(passes).toBe(before + 2);

      // Pass 4 finishes the walk.
      report = await host.runDueJobs(t, s);
      expect(report.completed).toBe(1);
      expect(await items(s)).toEqual(['item-0', 'item-1', 'item-2', 'item-3', 'item-4']);

      const done = await runOf(s, run.id);
      expect(done?.status).toBe('done');
      expect(done?.cursor).toBe(5);
      expect(done?.endedAt).not.toBeNull();
      expect(done?.lastError).toBeNull();
      expect(done?.attempts).toBe(0);
      // The counter re-accumulated across the replayed chunk and still totals 5 — an
      // uncommitted pass's counts are discarded, and the replay puts them back.
      expect(done?.counters).toEqual({ walked: 5 });

      // Terminal: a finished run is never picked up again, and a start against the
      // same key opens a FRESH run rather than joining the finished one.
      expect((await host.runDueJobs(t, s)).attempted).toBe(0);
      const again = await host.startJobRun(t, s, {
        moduleId: JOBS_MODULE,
        job: 'walk',
        instance: 'source-a',
        payload: { total: 0, chunk: 2 },
      });
      expect(again.id).not.toBe(run.id);
      expect((await host.jobRuns(t, s, { job: 'walk' })).map((r) => r.status)).toEqual([
        'running',
        'done',
      ]);
    });

    it('walks to the end in one call when the caller has a budget', async () => {
      const s = await newScope();
      const run = await host.startJobRun(t, s, {
        moduleId: JOBS_MODULE,
        job: 'walk',
        instance: 'budget',
        payload: { total: 5, chunk: 2 },
      });
      // Three passes' worth of chunks, asked for in one call: the second pass reads
      // back the cursor the first one COMMITTED rather than a value carried in memory.
      const report = await host.runDueJobs(t, s, { maxPasses: 5 });
      expect(report).toMatchObject({ attempted: 1, advanced: 2, completed: 1 });
      expect(await items(s)).toEqual(['item-0', 'item-1', 'item-2', 'item-3', 'item-4']);
      expect((await runOf(s, run.id))?.status).toBe('done');
    });

    it('fails the run when a step exhausts its retries, and never throws at the driver', async () => {
      const s = await newScope();
      const run = await host.startJobRun(t, s, { moduleId: JOBS_MODULE, job: 'doomed' });
      // maxAttempts 3: two retries, then terminal.
      for (const expected of [1, 2]) {
        const report = await host.runDueJobs(t, s);
        expect(report.retrying).toBe(1);
        expect((await runOf(s, run.id))?.attempts).toBe(expected);
      }
      const last = await host.runDueJobs(t, s);
      expect(last.failed).toBe(1);
      expect(last.errors).toHaveLength(1);
      expect(last.errors[0]!.runId).toBe(run.id);
      expect(last.errors[0]!.error).toContain('upstream said no');

      const failed = await runOf(s, run.id);
      expect(failed?.status).toBe('failed');
      expect(failed?.lastError).toContain("step 'always-fails'");
      expect(failed?.lastError).toContain('upstream said no');
      expect(failed?.endedAt).not.toBeNull();
      // Terminal: not picked up again, and the driver returned a report rather than
      // throwing at whoever was holding the tick.
      expect((await host.runDueJobs(t, s)).attempted).toBe(0);
    });

    it('refuses a payload carrying bytes, naming the path', async () => {
      const s = await newScope();
      const start = host.startJobRun(t, s, {
        moduleId: JOBS_MODULE,
        job: 'walk',
        instance: 'bytes',
        payload: { source: { id: 'abc', bytes: new Uint8Array([1, 2, 3]) } },
      });
      const err = await start.catch((e: unknown) => e);
      expect(errorCodeOf(err)).toBe('validation_failed');
      expect((err as Error).message).toContain('payload.source.bytes');
      expect((err as { extensions?: { errors?: { path: string }[] } }).extensions?.errors?.[0]?.path).toBe(
        'payload.source.bytes',
      );
      // Refused BEFORE a row exists — a run is never recorded carrying a value it
      // could not resume from.
      expect(await host.jobRuns(t, s)).toEqual([]);
    });

    it('refuses a payload carrying a class instance or a function, naming the path', async () => {
      const s = await newScope();
      await expect(
        host.startJobRun(t, s, {
          moduleId: JOBS_MODULE,
          job: 'walk',
          instance: 'date',
          payload: { since: new Date('2026-01-01T00:00:00.000Z') },
        }),
      ).rejects.toThrow(/payload\.since is a Date/);
      await expect(
        host.startJobRun(t, s, {
          moduleId: JOBS_MODULE,
          job: 'walk',
          instance: 'fn',
          payload: { steps: [() => 1] },
        }),
      ).rejects.toThrow(/payload\.steps\.0 is a function/);
      expect(await host.jobRuns(t, s)).toEqual([]);
    });

    it('refuses two steps under one name in one pass', async () => {
      const s = await newScope();
      const run = await host.startJobRun(t, s, { moduleId: JOBS_MODULE, job: 'ambiguous' });
      const report = await host.runDueJobs(t, s);
      // Reported like any other pass failure — the refusal is loud, not fatal.
      expect(report.retrying).toBe(1);
      expect((await runOf(s, run.id))?.lastError).toContain('already run in this pass');
    });

    it('leaves a run whose job this host does not register untouched', async () => {
      const s = await newScope();
      const run = await host.startJobRun(t, s, {
        moduleId: JOBS_MODULE,
        job: 'not-registered-here',
        payload: { any: 'thing' },
      });
      const report = await host.runDueJobs(t, s);
      expect(report.attempted).toBe(0);
      const untouched = await runOf(s, run.id);
      expect(untouched?.status).toBe('running');
      expect(untouched?.attempts).toBe(0);
      expect(untouched?.lastError).toBeNull();
    });
  });
}
