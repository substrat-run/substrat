import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  dataSubjectId,
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
import {
  CANCELLED_JOB_NOTE,
  REDACTED_INTENT_MARKER,
  REDACTED_JOB_NOTE,
  ulid,
  type JobPassContext,
  type ScopeHost,
} from '@substrat-run/kernel';
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

    /** What the `shapes` job's step handed its handler, once per pass. */
    const shapesSeen: { type: string; value: string }[] = [];

    /** How many times the `doomed` job's step BODY actually ran. */
    let doomedCalls = 0;

    /** The scope the `outlived` job erases its subject in — set by that test. */
    let shredScope: ScopeId | null = null;

    /**
     * A spine envelope as a job would hold a copy of one: what #1600's predicate keys on
     * is `subjectId` beside a `piiClass` other than `none`, at any depth.
     */
    const envelopeFor = (subject: string, said: string, piiClass = 'direct') => ({
      id: ulid(),
      type: 'crm.contact-imported',
      piiClass,
      subjectId: subject,
      payload: { name: said },
    });

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
            doomedCalls += 1;
            throw new Error('upstream said no');
          });
          return { done: true };
        },
        { maxAttempts: 3, baseDelayMs: 0 },
      );

      // A job whose handler hands back an explicitly-undefined cursor — a SUPPLIED
      // cursor, which must be refused rather than coalesced into "start over".
      host.registerJob(
        JOBS_MODULE,
        'undef-cursor',
        () => ({ cursor: undefined }),
        { maxAttempts: 2, baseDelayMs: 0 },
      );

      // A job whose step returns a value JSON cannot carry unchanged. What it returns
      // is recorded by the handler so the test can compare the first pass (which ran
      // the step) against the second (which replayed its memo).
      host.registerJob(
        JOBS_MODULE,
        'shapes',
        async (pass: JobPassContext) => {
          const got = await pass.step('shape', () => new Date('2026-01-01T00:00:00.000Z'));
          shapesSeen.push({ type: typeof got, value: String(got) });
          if (evictAfter === 'shape') {
            evictAfter = null;
            throw new Error('evicted after shape');
          }
          return { done: true };
        },
        { maxAttempts: 4, baseDelayMs: 0 },
      );

      // A job that does nothing but finish: no steps, no scope, no module table. The
      // healthy half of the malformed-row test, where the subject is that a run behind
      // a broken one still advances and nothing else.
      host.registerJob(JOBS_MODULE, 'inert', () => ({ done: true }));

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

      // A pass that outlives a subject erasure (#1632). Its first step hands back a copy
      // of the subject's classified event; the erasure lands WHILE the pass is still
      // working; the pass then runs another step and commits a cursor carrying the same
      // copy. Everything after the erasure is a stale writeback, and must change nothing.
      host.registerJob(
        JOBS_MODULE,
        'outlived',
        async (pass: JobPassContext) => {
          const { subject, fail } = pass.payload as { subject: string; fail?: boolean };
          const fetched = await pass.step('fetch', () => envelopeFor(subject, 'Anna Ek'));
          await host.admin.shredSubject(staff, t, shredScope!, dataSubjectId.parse(subject));
          await pass.step('after', () => envelopeFor(subject, 'Anna Ek'));
          // A FAILED pass keeps its step ledger — so this is the path on which a stale
          // step write would survive, where a commit would have dropped it anyway.
          if (fail) throw new Error('HTTP 502 while writing Anna Ek');
          return { cursor: { last: fetched }, done: false };
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

    /**
     * F1: two starts that race must still produce ONE run.
     *
     * `Promise.all` is a real interleave here, not a decoration: `startJobRun` is
     * `async` on both adapters, so the two calls genuinely suspend across the store
     * round trips and the second reaches its lookup before the first has inserted.
     * With the lookup and the insert as separate store calls both saw no live run
     * and both inserted — and nothing in the schema could refuse the second, by
     * design, since a crashed run has to stay restartable.
     */
    it('starts exactly one run when two starts race', async () => {
      const s = await newScope();
      const start = () =>
        host.startJobRun(t, s, {
          moduleId: JOBS_MODULE,
          job: 'walk',
          instance: 'racy',
          payload: { total: 2, chunk: 1 },
        });
      const [a, b, c] = await Promise.all([start(), start(), start()]);
      expect(b.id).toBe(a.id);
      expect(c.id).toBe(a.id);
      // The row count is the assertion that cannot be satisfied by luck: three
      // concurrent callers, one run.
      expect(await host.jobRuns(t, s, { instance: 'racy' })).toHaveLength(1);
    });

    /**
     * F8: `{ cursor: undefined }` is a SUPPLIED cursor, and supplying it used to
     * coalesce to null — silently restarting the walk. Refused now, by path.
     */
    it('refuses an explicitly undefined cursor rather than resetting the walk', async () => {
      const s = await newScope();
      const run = await host.startJobRun(t, s, { moduleId: JOBS_MODULE, job: 'undef-cursor' });
      const report = await host.runDueJobs(t, s);
      expect(report.retrying + report.failed).toBe(1);
      const after = await runOf(s, run.id);
      expect(after?.lastError).toContain('cursor is not queue-safe');
      // The cursor the last commit left is untouched — the pass did not "reset" it.
      expect(after?.cursor).toBeNull();
    });

    /** F5: a sparse array survives `forEach` and changes value through JSON. */
    it('refuses a payload carrying a hole in a sparse array', async () => {
      const s = await newScope();
      const holed = [1, 2, 3];
      // eslint-disable-next-line @typescript-eslint/no-array-delete
      delete holed[1];
      await expect(
        host.startJobRun(t, s, {
          moduleId: JOBS_MODULE,
          job: 'walk',
          instance: 'sparse',
          payload: { pages: holed },
        }),
      ).rejects.toThrow(/payload\.pages\.1 is a hole in a sparse array/);
      expect(await host.jobRuns(t, s)).toEqual([]);
    });

    /**
     * F7: a step must hand the handler the SAME shape whether it just ran or was
     * replayed from the memo. `walk-dates` returns a `Date` from its step; the first
     * pass is evicted after it, so the second pass reads the memo — and the two
     * passes must agree about what they got.
     */
    it('returns the same shape from a step whether it ran or was replayed', async () => {
      const s = await newScope();
      const run = await host.startJobRun(t, s, { moduleId: JOBS_MODULE, job: 'shapes' });
      shapesSeen.length = 0;
      evictAfter = 'shape';
      await host.runDueJobs(t, s);
      await host.runDueJobs(t, s);
      expect(shapesSeen).toHaveLength(2);
      // Ran, then replayed — and the handler could not tell the difference.
      expect(shapesSeen[0]).toEqual(shapesSeen[1]);
      expect((await runOf(s, run.id))?.status).toBe('done');
    });

    /**
     * F9: runs this host cannot drive must not hold the head of the queue forever.
     * Three unregistered runs are started first, so they sort ahead of the real one;
     * with the budget applied to the QUERY rather than to runnable runs, a limit of
     * 1 returned the same unrunnable row on every call and the real run never ran.
     */
    it('pages past runs it cannot drive instead of starving on them', async () => {
      const s = await newScope();
      for (const n of ['a', 'b', 'c']) {
        await host.startJobRun(t, s, { moduleId: JOBS_MODULE, job: 'absent-job', instance: n });
      }
      const real = await host.startJobRun(t, s, { moduleId: JOBS_MODULE, job: 'inert' });
      const report = await host.runDueJobs(t, s, { limit: 1 });
      expect(report.attempted).toBe(1);
      expect(report.completed).toBe(1);
      expect((await runOf(s, real.id))?.status).toBe('done');
    });

    it('refuses two steps under one name in one pass', async () => {
      const s = await newScope();
      const run = await host.startJobRun(t, s, { moduleId: JOBS_MODULE, job: 'ambiguous' });
      const report = await host.runDueJobs(t, s);
      // Reported like any other pass failure — the refusal is loud, not fatal.
      expect(report.retrying).toBe(1);
      expect((await runOf(s, run.id))?.lastError).toContain('already run in this pass');
    });

    /**
     * The per-run isolation, against the one input that is not a handler's fault.
     *
     * Every other failure in this suite arrives from inside a pass, where a `try` was
     * always going to catch it. A MALFORMED ROW arrives before the pass starts, and
     * decoding it used to sit above that `try` — so one bad row threw out of
     * `runJobPass`, out of `runDueJobRuns` (which does not wrap the call either) and
     * out of `runDueJobs` at whoever was holding the tick, taking every due run BEHIND
     * it down with it. Found by re-reading the diff; no test in the suite could reach
     * it, because nothing the public surface accepts produces such a row.
     *
     * A restore does. `importDump` replays a dump's rows verbatim
     * (preview-and-snapshots.md §3), so a dump written by another world — or edited by
     * hand — is the whole reproduction, and it is the same lever #1288's backfill test
     * uses. The broken row's id sorts before every ULID, so the due read reaches it
     * FIRST: if it is not contained, the healthy run behind it never runs.
     */
    it('contains a malformed run row instead of taking the drive down with it', async () => {
      const s = await newScope();
      await host.restoreScope(staff, t, s, {
        tenantId: t,
        scopeId: s,
        capturedAt: '2026-09-01T00:00:00.000Z',
        tables: [
          {
            name: '_substrat_job_runs',
            // Spelled out rather than referenced: the point is that code meeting a
            // FOREIGN table survives it, so this must not move when the DDL does.
            ddl:
              'CREATE TABLE _substrat_job_runs (id TEXT PRIMARY KEY, module_id TEXT NOT NULL, ' +
              'job TEXT NOT NULL, instance TEXT NOT NULL, payload TEXT NOT NULL, status TEXT NOT NULL, ' +
              'cursor TEXT, counters TEXT NOT NULL DEFAULT \'{}\', attempts INTEGER NOT NULL DEFAULT 0, ' +
              'last_error TEXT, started_at TEXT NOT NULL, updated_at TEXT NOT NULL, ' +
              'next_attempt_at TEXT, ended_at TEXT)',
            columns: [
              'id', 'module_id', 'job', 'instance', 'payload', 'status', 'cursor', 'counters',
              'attempts', 'last_error', 'started_at', 'updated_at', 'next_attempt_at', 'ended_at',
            ],
            rows: [
              [
                // Sorts before every ULID, so this row is read first.
                '00000000000000000000000000',
                JOBS_MODULE,
                'walk',
                'corrupt',
                '{"total":1,"chunk":1}',
                'running',
                null,
                'not json at all',
                0,
                null,
                '2026-09-01T00:00:00.000Z',
                '2026-09-01T00:00:00.000Z',
                null,
                null,
              ],
            ],
          },
        ],
      });
      // The healthy run is the INERT job, which touches no module table and needs no
      // grant. That is deliberate: a restore replays only the dump, so the scope's
      // module tables and its tuples came back empty, and the two adapters do not
      // agree about when those are rebuilt — the pure host clears its applied-migration
      // set on restore, while a warm ScopeDO keeps a memoised migration promise that
      // only `retryMigrations` or a cold start clears. That asymmetry is real and
      // predates this driver; making it this test's business would be asserting the
      // restore path under the name of the run driver. What IS this test's business is
      // that a run behind a malformed row still advances.
      const healthy = await host.startJobRun(t, s, {
        moduleId: JOBS_MODULE,
        job: 'inert',
        instance: 'healthy',
      });

      // Does not throw — and the run BEHIND the broken one still did its work.
      const report = await host.runDueJobs(t, s);
      expect(report.attempted).toBe(2);
      expect(report.completed).toBe(1);
      expect((await runOf(s, healthy.id))?.status).toBe('done');

      // The broken row was recorded as a failed pass, not skipped and not fatal.
      const broken = await runOf(s, '00000000000000000000000000');
      expect(broken?.status).toBe('running');
      expect(broken?.attempts).toBe(1);
      expect(broken?.lastError).toContain('JSON');
      expect(report.errors.map((e) => e.runId)).toEqual(['00000000000000000000000000']);
      // And the READ says the row could not be decoded rather than pretending it
      // could: empty counters WITH a reason, never a silent `{}` that reads as
      // "nothing counted". Reading it at all is the point — the driver recorded
      // evidence onto this row, and a strict decode would have made the whole list
      // (including the healthy run above) unreadable because of it.
      expect(broken?.decodeError).toContain('JSON');
      expect(broken?.counters).toEqual({});
      expect((await runOf(s, healthy.id))?.decodeError).toBeNull();
    });

    /**
     * F6: a step whose RECORDED attempts already reached its policy must not be
     * invoked one more time to discover what its own ledger row already says.
     *
     * The state is reachable by a stop between `recordStep` writing the final failed
     * attempt and the run patch marking the run terminal, so it is restored here
     * directly: a `running` run with `attempts = 0`, and beside it a step row with
     * `attempts = 3` (its policy's maximum) and a NULL result. The assertion is the
     * CALL COUNTER, because both the fixed and the broken code end with the run
     * `failed` — the difference is only whether somebody else's API was called once
     * more on the way there, which is exactly the cost being avoided.
     */
    it('does not re-invoke a step whose recorded attempts are already spent', async () => {
      const s = await newScope();
      const runId = '00000000000000000000000001';
      await host.restoreScope(staff, t, s, {
        tenantId: t,
        scopeId: s,
        capturedAt: '2026-09-01T00:00:00.000Z',
        tables: [
          {
            name: '_substrat_job_runs',
            ddl:
              'CREATE TABLE _substrat_job_runs (id TEXT PRIMARY KEY, module_id TEXT NOT NULL, ' +
              'job TEXT NOT NULL, instance TEXT NOT NULL, payload TEXT NOT NULL, status TEXT NOT NULL, ' +
              'cursor TEXT, counters TEXT NOT NULL DEFAULT \'{}\', attempts INTEGER NOT NULL DEFAULT 0, ' +
              'last_error TEXT, started_at TEXT NOT NULL, updated_at TEXT NOT NULL, ' +
              'next_attempt_at TEXT, ended_at TEXT)',
            columns: [
              'id', 'module_id', 'job', 'instance', 'payload', 'status', 'cursor', 'counters',
              'attempts', 'last_error', 'started_at', 'updated_at', 'next_attempt_at', 'ended_at',
            ],
            rows: [
              [
                runId, JOBS_MODULE, 'doomed', 'default', 'null', 'running', null, '{}', 0, null,
                '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z', null, null,
              ],
            ],
          },
          {
            name: '_substrat_job_steps',
            ddl:
              'CREATE TABLE _substrat_job_steps (run_id TEXT NOT NULL, step TEXT NOT NULL, ' +
              'result TEXT, attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT, ' +
              'recorded_at TEXT NOT NULL, PRIMARY KEY (run_id, step))',
            columns: ['run_id', 'step', 'result', 'attempts', 'last_error', 'recorded_at'],
            // attempts = 3 = `doomed`'s maxAttempts, result NULL = it never succeeded.
            rows: [[runId, 'always-fails', null, 3, 'upstream said no', '2026-09-01T00:00:00.000Z']],
          },
        ],
      });

      const before = doomedCalls;
      const report = await host.runDueJobs(t, s);
      // The step body was NOT run again — this is the whole assertion.
      expect(doomedCalls).toBe(before);
      expect(report.failed).toBe(1);
      const settled = await runOf(s, runId);
      expect(settled?.status).toBe('failed');
      // Settled on the error the ledger already held, not on a freshly-produced one.
      expect(settled?.lastError).toContain('upstream said no');
      expect(settled?.endedAt).not.toBeNull();
    });

    /**
     * A caller's `limit` is normalised before it reaches SQL. SQLite reads a
     * NEGATIVE limit as unbounded, and finished runs are retained — so `-1` asked
     * for the scope's entire history in one response, a read whose cost grows with
     * retention rather than with what was asked for.
     */
    it('clamps the operator read to a sane row budget', async () => {
      const s = await newScope();
      for (const n of ['a', 'b', 'c']) {
        await host.startJobRun(t, s, { moduleId: JOBS_MODULE, job: 'inert', instance: n });
      }
      expect(await host.jobRuns(t, s, { limit: -1 })).toHaveLength(1);
      expect(await host.jobRuns(t, s, { limit: 0 })).toHaveLength(1);
      // A fractional limit is a value SQLite refuses outright rather than rounds.
      expect(await host.jobRuns(t, s, { limit: 2.7 })).toHaveLength(2);
      expect(await host.jobRuns(t, s, { limit: 1_000_000 })).toHaveLength(3);
    });

    // -- subject erasure reaches the job-run tables (#1632) ----------------------
    //
    // A run's payload, its cursor and a step's memo are whatever a HOST handler handed
    // the driver — a walk of an external system, so an external system's output. None of
    // it carries a `subject_id`. What the erasure can read reliably is #1600's link: a
    // copy of a classified spine envelope, at any depth. These pin both halves of that —
    // what it reaches, and (the last test) what it deliberately does not.
    describe('subject erasure (#1632)', () => {
      const RUNS_DDL =
        'CREATE TABLE _substrat_job_runs (id TEXT PRIMARY KEY, module_id TEXT NOT NULL, ' +
        'job TEXT NOT NULL, instance TEXT NOT NULL, payload TEXT NOT NULL, status TEXT NOT NULL, ' +
        "cursor TEXT, counters TEXT NOT NULL DEFAULT '{}', attempts INTEGER NOT NULL DEFAULT 0, " +
        'last_error TEXT, started_at TEXT NOT NULL, updated_at TEXT NOT NULL, ' +
        'next_attempt_at TEXT, ended_at TEXT)';
      const RUN_COLUMNS = [
        'id', 'module_id', 'job', 'instance', 'payload', 'status', 'cursor', 'counters',
        'attempts', 'last_error', 'started_at', 'updated_at', 'next_attempt_at', 'ended_at',
      ];
      const STEPS_DDL =
        'CREATE TABLE _substrat_job_steps (run_id TEXT NOT NULL, step TEXT NOT NULL, ' +
        'result TEXT, attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT, ' +
        'recorded_at TEXT NOT NULL, PRIMARY KEY (run_id, step))';
      const STEP_COLUMNS = ['run_id', 'step', 'result', 'attempts', 'last_error', 'recorded_at'];
      const T0 = '2026-09-01T00:00:00.000Z';

      type Run = {
        id: string;
        payload: unknown;
        cursor?: unknown;
        status?: 'running' | 'done' | 'failed';
        lastError?: string | null;
      };
      type Step = { runId: string; step: string; result: unknown; lastError?: string | null };

      /** A scope holding exactly these rows — the only way to place a copy precisely. */
      const seeded = async (runs: Run[], steps: Step[]): Promise<ScopeId> => {
        const s = await newScope();
        await host.restoreScope(staff, t, s, {
          tenantId: t,
          scopeId: s,
          capturedAt: T0,
          tables: [
            {
              name: '_substrat_job_runs',
              ddl: RUNS_DDL,
              columns: RUN_COLUMNS,
              rows: runs.map((r) => {
                const status = r.status ?? 'failed';
                return [
                  r.id, JOBS_MODULE, 'absent-job', r.id, JSON.stringify(r.payload), status,
                  r.cursor === undefined ? null : JSON.stringify(r.cursor), '{}', 1,
                  r.lastError ?? null, T0, T0, null, status === 'running' ? null : T0,
                ];
              }),
            },
            {
              name: '_substrat_job_steps',
              ddl: STEPS_DDL,
              columns: STEP_COLUMNS,
              rows: steps.map((st) => [
                st.runId, st.step, JSON.stringify(st.result), 1, st.lastError ?? null, T0,
              ]),
            },
          ],
        });
        return s;
      };

      /** Every row of both job tables, as the dump carries them — raw, nothing decoded. */
      const rowsOf = async (s: ScopeId) => {
        const dump = await host.admin.exportScope(staff, t, s);
        const table = (name: string) => {
          const tb = dump.tables.find((x) => x.name === name)!;
          return tb.rows.map((r) => Object.fromEntries(tb.columns.map((c, i) => [c, r[i]])));
        };
        return {
          runs: table('_substrat_job_runs') as Record<string, string | null>[],
          steps: table('_substrat_job_steps') as Record<string, string | null>[],
        };
      };

      const tombstoneOf = (subject: string) => ({
        [REDACTED_INTENT_MARKER]: expect.objectContaining({ reason: 'subject-erasure', subjectId: subject }),
      });

      it('tombstones the payload, the cursor and a step memo that copy the subject\'s event', async () => {
        const erased = dataSubjectId.parse(ulid());
        const s = await seeded(
          [
            {
              id: 'run-a',
              payload: { source: 'crm', seed: envelopeFor(erased, 'Anna Ek') },
              cursor: { page: 3, last: envelopeFor(erased, 'Anna Ek') },
              lastError: 'HTTP 422: Anna Ek has no postal address',
            },
          ],
          [{ runId: 'run-a', step: 'fetch', result: [envelopeFor(erased, 'Anna Ek')], lastError: 'retry: Anna Ek' }],
        );
        expect(JSON.stringify(await rowsOf(s))).toContain('Anna Ek');

        const receipt = await host.admin.shredSubject(staff, t, s, erased);

        const { runs, steps } = await rowsOf(s);
        // THE property: no trace of the name in either table.
        expect(JSON.stringify({ runs, steps })).not.toContain('Anna Ek');
        const run = runs.find((r) => r.id === 'run-a')!;
        expect(JSON.parse(run.payload!)).toEqual(tombstoneOf(erased));
        expect(JSON.parse(run.cursor!)).toEqual(tombstoneOf(erased));
        expect(run.last_error).toBe(REDACTED_JOB_NOTE);
        // Already terminal: not re-dated, not reopened.
        expect(run.status).toBe('failed');
        expect(run.ended_at).toBe(T0);
        const step = steps.find((r) => r.run_id === 'run-a' && r.step === 'fetch')!;
        expect(JSON.parse(step.result!)).toEqual(tombstoneOf(erased));
        expect(step.last_error).toBe(REDACTED_JOB_NOTE);
        // Counted once per RUN — payload, cursor and a step are one job's worth of data,
        // not three. An honest receipt, not a count of rewritten cells.
        expect(receipt.jobRunsRedacted).toBe(1);
      });

      it('leaves another subject\'s run and steps exactly as they were', async () => {
        // The twin without which a redact-every-run bug passes the test above.
        const erased = dataSubjectId.parse(ulid());
        const spared = dataSubjectId.parse(ulid());
        const s = await seeded(
          [
            { id: 'run-mine', payload: envelopeFor(erased, 'Anna Ek') },
            {
              id: 'run-theirs',
              payload: envelopeFor(spared, 'Bo Lund'),
              cursor: { last: envelopeFor(spared, 'Bo Lund') },
              lastError: 'HTTP 422: Bo Lund has no postal address',
            },
          ],
          [{ runId: 'run-theirs', step: 'fetch', result: envelopeFor(spared, 'Bo Lund'), lastError: 'retry: Bo Lund' }],
        );
        const before = await rowsOf(s);

        const receipt = await host.admin.shredSubject(staff, t, s, erased);

        const after = await rowsOf(s);
        expect(after.runs.find((r) => r.id === 'run-theirs')).toEqual(
          before.runs.find((r) => r.id === 'run-theirs'),
        );
        expect(after.steps).toEqual(before.steps);
        expect(receipt.jobRunsRedacted).toBe(1);
      });

      it('spares a copy classified `none`, as the outbox spares the original', async () => {
        const erased = dataSubjectId.parse(ulid());
        const s = await seeded([{ id: 'run-none', payload: envelopeFor(erased, 'nothing about anybody', 'none') }], []);
        const receipt = await host.admin.shredSubject(staff, t, s, erased);
        expect(receipt.jobRunsRedacted).toBe(0);
        expect((await rowsOf(s)).runs[0]!.payload).toContain('nothing about anybody');
      });

      it('stops a running run whose memo was redacted, so no pass is handed the tombstone', async () => {
        // A step's memo is returned to the handler WITHOUT running anything, so a
        // tombstoned memo on a live run would be replayed as the step's answer. The run is
        // settled `failed` in the same statement, and is no longer due.
        const erased = dataSubjectId.parse(ulid());
        const s = await seeded(
          [{ id: 'run-live', payload: { source: 'crm' }, status: 'running' }],
          [{ runId: 'run-live', step: 'fetch', result: envelopeFor(erased, 'Anna Ek') }],
        );

        const receipt = await host.admin.shredSubject(staff, t, s, erased);

        const run = (await rowsOf(s)).runs.find((r) => r.id === 'run-live')!;
        expect(run.status).toBe('failed');
        expect(run.last_error).toBe(CANCELLED_JOB_NOTE);
        expect(run.ended_at).not.toBeNull();
        // Only the columns that held a copy were replaced — the payload named nobody.
        expect(JSON.parse(run.payload!)).toEqual({ source: 'crm' });
        expect(receipt.jobRunsRedacted).toBe(1);
        expect((await runOf(s, 'run-live'))?.status).toBe('failed');
      });

      it('is idempotent — a second erasure finds only tombstones and changes nothing', async () => {
        const erased = dataSubjectId.parse(ulid());
        const s = await seeded(
          [{ id: 'run-a', payload: envelopeFor(erased, 'Anna Ek'), cursor: envelopeFor(erased, 'Anna Ek') }],
          [{ runId: 'run-a', step: 'fetch', result: envelopeFor(erased, 'Anna Ek') }],
        );
        expect((await host.admin.shredSubject(staff, t, s, erased)).jobRunsRedacted).toBe(1);
        const once = await rowsOf(s);
        expect((await host.admin.shredSubject(staff, t, s, erased)).jobRunsRedacted).toBe(0);
        expect(await rowsOf(s)).toEqual(once);
      });

      it('refuses the writeback of a pass the erasure overtook', async () => {
        // The erasure lands mid-pass (inside the handler, between two steps). What the
        // pass does afterwards — a second step, then a commit whose cursor carries the
        // copy — is a stale writeback onto a redacted run. Patching by id alone put the
        // cursor and `running` straight back; both writes are a CAS on `running` now.
        //
        // What this does NOT claim to stop is the pass's own work: it had the payload and
        // it keeps it until it returns. Only its writes onto the redacted rows are refused.
        const erased = dataSubjectId.parse(ulid());
        const s = await newScope();
        shredScope = s;
        const run = await host.startJobRun(t, s, {
          moduleId: JOBS_MODULE,
          job: 'outlived',
          payload: { subject: erased },
        });

        await host.runDueJobs(t, s);

        const after = (await rowsOf(s)).runs.find((r) => r.id === run.id)!;
        expect(after.status).toBe('failed');
        expect(after.last_error).toBe(CANCELLED_JOB_NOTE);
        expect(after.cursor).toBeNull();
        expect(JSON.stringify(await rowsOf(s))).not.toContain('Anna Ek');
        // Terminal, so nothing drives it again.
        expect((await host.runDueJobs(t, s)).attempted).toBe(0);
      });

      it('refuses the stale STEP write of a pass the erasure overtook, and its failure patch', async () => {
        // The failing twin of the test above. A failed pass does not drop its ledger, so a
        // step recorded after the erasure would stay — a fresh memo carrying the person on
        // a run the erasure just emptied — and the failure patch would put `running` and a
        // provider's sentence back. Both are refused by the same CAS on `running`.
        const erased = dataSubjectId.parse(ulid());
        const s = await newScope();
        shredScope = s;
        const run = await host.startJobRun(t, s, {
          moduleId: JOBS_MODULE,
          job: 'outlived',
          payload: { subject: erased, fail: true },
        });

        await host.runDueJobs(t, s);

        const { runs, steps } = await rowsOf(s);
        expect(JSON.stringify({ runs, steps })).not.toContain('Anna Ek');
        // The only step row is the one the erasure tombstoned; `after` was never written.
        expect(steps.map((r) => r.step)).toEqual(['fetch']);
        const after = runs.find((r) => r.id === run.id)!;
        expect(after.status).toBe('failed');
        expect(after.last_error).toBe(CANCELLED_JOB_NOTE);
      });

      it('does NOT reach output that names the subject without a classified envelope', async () => {
        // THE DOCUMENTED LIMIT, pinned so nobody reads the tests above as covering it
        // (kernel-design.md §13.1 limit 8). The subject's id and name sit here as plain
        // text: nothing in the row says whose it is, and a substring match on the id
        // would erase on coincidence and still miss the name. Closing this wants a
        // declared subject on the run — the open half of #1632 — not a wider heuristic.
        // If this test starts failing because the rows WERE redacted, that is the design
        // changing: update §13.1 with it, don't just flip the assertion.
        const erased = dataSubjectId.parse(ulid());
        const s = await seeded(
          [
            {
              id: 'run-plain',
              payload: { contact: erased },
              cursor: { contact: erased, name: 'Anna Ek' },
              lastError: `HTTP 422: contact ${erased} (Anna Ek) has no postal address`,
            },
          ],
          [{ runId: 'run-plain', step: 'fetch', result: { contact: erased, name: 'Anna Ek' } }],
        );
        const before = await rowsOf(s);

        const receipt = await host.admin.shredSubject(staff, t, s, erased);

        expect(receipt.jobRunsRedacted).toBe(0);
        expect(await rowsOf(s)).toEqual(before);
      });
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
