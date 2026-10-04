import { describe, expect, it } from 'vitest';
import type { ScopeStub } from '../src/scope-host.js';
import {
  JOB_ADMISSION_BACKOFF_BASE_MS,
  JOB_ADMISSION_BACKOFF_MAX_MS,
  JOB_ADMISSION_MISS_MAX,
  JOB_DEFER_MS,
  JOB_LEASE_TOO_SHORT_NOTE,
  JOB_LEASE_ENTRY_MARGIN,
  JOB_LEASE_EXPIRED_NOTE,
  JOB_LEASE_MIN_MS,
  JOB_LEASE_MS,
  admissionBackoffMs,
  assertLeaseMs,
  runDueJobRuns,
  type JobHandler,
  type JobRunRow,
  type JobRunStore,
} from '../src/job-run.js';
import { memoryJobStore } from './job-store-memory.js';

/**
 * #2034: a due run is CLAIMED before its handler runs. Two drives that both picked one run
 * invoke its handler once; a lease that expired is taken over and counted; a live one is not
 * stolen; a holder that lost its lease writes nothing, and stops at its next step boundary.
 *
 * The clock is the test's, so "the lease expired" is a clock move rather than a sleep.
 */
const T0 = Date.parse('2026-10-04T12:00:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();

function rowOf(id: string, over: Partial<JobRunRow> = {}): JobRunRow {
  return {
    id,
    module_id: '@test/jobs',
    job: 'job',
    instance: id,
    payload: '{}',
    subject_id: null,
    status: 'running',
    cursor: null,
    counters: '{}',
    attempts: 0,
    last_error: null,
    started_at: iso(T0 - 60_000),
    updated_at: iso(T0 - 60_000),
    next_attempt_at: null,
    ended_at: null,
    lease_owner: null,
    ...over,
  };
}

/** A promise and the function that settles it. */
function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  return { opened, open };
}

function driver(store: JobRunStore, clock: { ms: number }, handler: JobHandler, extra: { leaseMs?: number; maxPasses?: number; maxAttempts?: number } = {}) {
  return () =>
    runDueJobRuns({
      store,
      handlerFor: () => ({
        handler,
        retry: { maxAttempts: extra.maxAttempts ?? 3, baseDelayMs: 1_000 },
        leaseMs: extra.leaseMs,
      }),
      now: () => iso(clock.ms),
      // The drive's own monotonic clock: the test's, in ms. The store's is separate (#2042 r4).
      monotonic: () => clock.ms,
      openScope: async () => ({}) as ScopeStub,
      maxPasses: extra.maxPasses,
    });
}

describe('#2034: a due run is claimed before its handler runs', () => {
  it('two drives that both picked one due run invoke its handler exactly once', async () => {
    // Both drives take their snapshot BEFORE either claims: the race the re-read lost.
    let arrived = 0;
    const both = gate();
    const { store, table } = memoryJobStore([rowOf('A')], {
      afterSnapshot: async () => {
        arrived += 1;
        if (arrived === 2) both.open();
        await both.opened;
      },
    });
    const clock = { ms: T0 };
    let invoked = 0;
    const drive = driver(store, clock, async () => {
      invoked += 1;
      return { done: true };
    });
    const [a, b] = await Promise.all([drive(), drive()]);
    expect(invoked).toBe(1);
    expect(a.attempted + b.attempted).toBe(1);
    expect(a.completed + b.completed).toBe(1);
    expect(table.get('A')).toMatchObject({ status: 'done', lease_owner: null });
  });

  it('twin: one drive alone runs the run once', async () => {
    const { store, table } = memoryJobStore([rowOf('A')]);
    let invoked = 0;
    const report = await driver(store, { ms: T0 }, () => {
      invoked += 1;
      return { done: true };
    })();
    expect(invoked).toBe(1);
    expect(report).toMatchObject({ attempted: 1, completed: 1, superseded: 0 });
    expect(table.get('A')).toMatchObject({ status: 'done', lease_owner: null, next_attempt_at: null });
  });

  it('a live lease is not stolen: a drive during the pass does nothing, and the holder finishes', async () => {
    const { store, table } = memoryJobStore([rowOf('A')]);
    const clock = { ms: T0 };
    const held = gate();
    const inside = gate();
    let invoked = 0;
    const drive = driver(store, clock, async () => {
      invoked += 1;
      inside.open();
      await held.opened;
      return { done: true };
    });
    const holder = drive();
    await inside.opened;
    // The lease runs to T0 + JOB_LEASE_MS; just short of it, the run is still the holder's.
    expect(table.get('A')).toMatchObject({ next_attempt_at: iso(T0 + JOB_LEASE_MS) });
    clock.ms = T0 + JOB_LEASE_MS - 1;
    expect(await drive()).toMatchObject({ attempted: 0 });
    held.open();
    expect(await holder).toMatchObject({ attempted: 1, completed: 1 });
    expect(invoked).toBe(1);
  });

  /** A lease whose drive BEGAN its pass and then died: nobody holds it, and its expiry passed. */
  const silent = (over: Partial<JobRunRow> = {}) =>
    rowOf('A', { lease_owner: 'dead', lease_began_at: iso(T0 - JOB_LEASE_MS), next_attempt_at: iso(T0 - 1), ...over });

  it('an expired lease is recovered: the run runs once more, and the silent pass counts as an attempt', async () => {
    const { store, table } = memoryJobStore([silent()]);
    let invoked = 0;
    const report = await driver(store, { ms: T0 }, () => {
      invoked += 1;
      throw new Error('upstream said no');
    })();
    expect(invoked).toBe(1);
    expect(report).toMatchObject({ attempted: 1, retrying: 1 });
    // One for the pass that died, one for this one.
    expect(table.get('A')).toMatchObject({ status: 'running', attempts: 2, last_error: 'upstream said no', lease_owner: null });
  });

  it('twin: an expired lease whose claim never BEGAN its pass is taken over for free (#2042 r2)', async () => {
    const { store, table } = memoryJobStore([silent({ lease_began_at: null })]);
    await driver(store, { ms: T0 }, () => {
      throw new Error('upstream said no');
    })();
    expect(table.get('A')).toMatchObject({ attempts: 1, last_error: 'upstream said no' });
  });

  it('twin: an unleased due run claimed for the first time counts no extra attempt', async () => {
    const { store, table } = memoryJobStore([rowOf('A')]);
    await driver(store, { ms: T0 }, () => {
      throw new Error('upstream said no');
    })();
    expect(table.get('A')).toMatchObject({ attempts: 1 });
  });

  it('a pass that keeps dying exhausts the job policy at a takeover, without invoking again', async () => {
    // maxAttempts 3: two attempts already, and the third pass never reported.
    const { store, table } = memoryJobStore([silent({ attempts: 2 })]);
    let invoked = 0;
    const report = await driver(store, { ms: T0 }, () => {
      invoked += 1;
      return { done: true };
    })();
    expect(invoked).toBe(0);
    expect(report).toMatchObject({ attempted: 1, failed: 1, errors: [{ runId: 'A', error: JOB_LEASE_EXPIRED_NOTE }] });
    expect(table.get('A')).toMatchObject({ status: 'failed', attempts: 3, last_error: JOB_LEASE_EXPIRED_NOTE, lease_owner: null });
  });

  it("a stale holder's outcome is refused once its run was taken over, and the new holder's stands", async () => {
    const { store, table } = memoryJobStore([rowOf('A')]);
    const clock = { ms: T0 };
    const held = gate();
    const inside = gate();
    let calls = 0;
    const drive = driver(store, clock, async () => {
      calls += 1;
      if (calls === 1) {
        inside.open();
        await held.opened;
        return { cursor: 'stale', done: false };
      }
      return { cursor: 'fresh', done: true };
    });
    const stale = drive();
    await inside.opened;
    clock.ms = T0 + JOB_LEASE_MS; // its lease is over, and it has not reported
    expect(await drive()).toMatchObject({ attempted: 1, completed: 1 });
    held.open();
    expect(await stale).toMatchObject({ attempted: 1, superseded: 1, advanced: 0, completed: 0 });
    expect(table.get('A')).toMatchObject({ status: 'done', cursor: JSON.stringify('fresh'), lease_owner: null });
  });

  it("a stale holder's FAILURE is refused too, and does not reopen the run", async () => {
    const { store, table } = memoryJobStore([rowOf('A')]);
    const clock = { ms: T0 };
    const held = gate();
    const inside = gate();
    let calls = 0;
    const drive = driver(store, clock, async () => {
      calls += 1;
      if (calls === 1) {
        inside.open();
        await held.opened;
        throw new Error('late failure');
      }
      return { done: true };
    });
    const stale = drive();
    await inside.opened;
    clock.ms = T0 + JOB_LEASE_MS;
    await drive();
    held.open();
    expect(await stale).toMatchObject({ superseded: 1, retrying: 0 });
    expect(table.get('A')).toMatchObject({ status: 'done', last_error: null });
  });

  it('a pass that renews at each step is not taken over, however long it runs in all', async () => {
    const { store, table } = memoryJobStore([rowOf('A')]);
    const clock = { ms: T0 };
    const leaseMs = 1_000;
    const rival = driver(store, clock, () => ({ done: true }), { leaseMs });
    let bodies = 0;
    const rivals: number[] = [];
    const report = await driver(
      store,
      clock,
      async (pass) => {
        for (let i = 0; i < 5; i += 1) {
          await pass.step(`s${i}`, async () => {
            bodies += 1;
            clock.ms += 700; // each step is shorter than the lease; all five are not
            rivals.push((await rival()).attempted);
          });
        }
        return { done: true };
      },
      { leaseMs },
    )();
    expect(clock.ms - T0).toBeGreaterThan(leaseMs);
    expect(rivals).toEqual([0, 0, 0, 0, 0]);
    expect(bodies).toBe(5);
    expect(report).toMatchObject({ completed: 1, superseded: 0 });
    expect(table.get('A')).toMatchObject({ status: 'done' });
  });

  it('a holder that lost its lease stops at its next step: that step body never runs', async () => {
    const { store, table, steps } = memoryJobStore([rowOf('A')]);
    const clock = { ms: T0 };
    const held = gate();
    const inside = gate();
    const ran: string[] = [];
    let calls = 0;
    const drive = driver(store, clock, async (pass) => {
      const who = (calls += 1) === 1 ? 'stale' : 'fresh';
      await pass.step('one', () => void ran.push(`${who}:one`));
      if (who === 'stale') {
        inside.open();
        await held.opened;
      }
      await pass.step('two', () => void ran.push(`${who}:two`));
      return { done: true };
    });
    const stale = drive();
    await inside.opened;
    clock.ms = T0 + JOB_LEASE_MS; // expired between its steps
    expect(await drive()).toMatchObject({ completed: 1 });
    held.open();
    expect(await stale).toMatchObject({ superseded: 1 });
    // The new holder replayed `one` from the stale pass's memo and ran `two`; the stale pass
    // ran `one` only.
    expect(ran).toEqual(['stale:one', 'fresh:two']);
    expect(table.get('A')).toMatchObject({ status: 'done' });
    expect(steps.size).toBe(0);
  });

  describe('BEGIN is the commitment point (#2042 review r1–r4)', () => {
    /** A drive on `clock`, invoking `handler`, on `maxAttempts` (default 3). */
    const on = (store: JobRunStore, clock: { ms: number }, handler: JobHandler, maxAttempts?: number) =>
      driver(store, clock, handler, { maxAttempts });

    it('a claim whose reply came back late does not begin: a rival that took the run over runs it once, free', async () => {
      const clock = { ms: T0 };
      let invoked = 0;
      const handler = () => ((invoked += 1), { done: true });
      let rival: Promise<unknown> | null = null;
      const { store, table } = memoryJobStore([rowOf('A')], {
        clock: () => iso(clock.ms),
        afterClaim: async () => {
          if (rival) return; // the rival's own claim replies at once
          clock.ms += JOB_LEASE_MS; // the first claim's lease ran out on the way back
          rival = on(store, clock, handler, 1)();
          await rival;
        },
      });
      expect(await on(store, clock, handler, 1)()).toMatchObject({ attempted: 0, superseded: 1, completed: 0 });
      expect(await rival).toMatchObject({ attempted: 1, completed: 1, failed: 0 });
      expect(invoked).toBe(1);
      // Its claim never began, so the takeover cost nothing — even on `maxAttempts: 1`.
      expect(table.get('A')).toMatchObject({ status: 'done', attempts: 0, last_error: null, lease_owner: null });
    });

    it('a claim whose reply left less than the margin is a miss: released after its backoff, nothing charged', async () => {
      const clock = { ms: T0 };
      let invoked = 0;
      let slow = true;
      const { store, table } = memoryJobStore([rowOf('A', { attempts: 1, last_error: 'earlier' })], {
        clock: () => iso(clock.ms),
        afterClaim: () => {
          if (slow) clock.ms += JOB_LEASE_MS * (1 - JOB_LEASE_ENTRY_MARGIN);
          slow = false;
        },
      });
      const drive = on(store, clock, () => ((invoked += 1), { done: true }), 2);
      expect(await drive()).toMatchObject({ attempted: 0, superseded: 1 });
      expect(invoked).toBe(0);
      expect(table.get('A')).toMatchObject({
        status: 'running',
        attempts: 1,
        last_error: 'earlier',
        admission_misses: 1,
        lease_owner: null,
        lease_began_at: null,
        next_attempt_at: iso(clock.ms + JOB_ADMISSION_BACKOFF_BASE_MS),
      });
      clock.ms += JOB_ADMISSION_BACKOFF_BASE_MS;
      expect(await drive()).toMatchObject({ attempted: 1, completed: 1 });
      expect(invoked).toBe(1);
      expect(table.get('A')).toMatchObject({ status: 'done', admission_misses: null });
    });

    it('twin: a reply with just over the margin left begins the pass', async () => {
      const clock = { ms: T0 };
      let invoked = 0;
      const { store } = memoryJobStore([rowOf('A')], {
        clock: () => iso(clock.ms),
        afterClaim: () => (clock.ms += JOB_LEASE_MS * (1 - JOB_LEASE_ENTRY_MARGIN) - 1),
      });
      expect(await on(store, clock, () => ((invoked += 1), { done: true }))()).toMatchObject({ attempted: 1, completed: 1, superseded: 0 });
      expect(invoked).toBe(1);
    });

    it('a BEGIN delayed in transit past the lease is refused by the store\'s clock; a rival runs the run once', async () => {
      const clock = { ms: T0 };
      let invoked = 0;
      const handler = () => ((invoked += 1), { done: true });
      let rival: Promise<unknown> | null = null;
      const answers: boolean[] = [];
      const { store, table } = memoryJobStore([rowOf('A')], {
        clock: () => iso(clock.ms),
        beforeBegin: async () => {
          if (rival) return;
          clock.ms += JOB_LEASE_MS; // BEGIN reaches the store after the lease is over
          rival = on(store, clock, handler, 1)();
          await rival;
        },
        afterBegin: (_id, began) => void answers.push(began),
      });
      expect(await on(store, clock, handler, 1)()).toMatchObject({ attempted: 0, superseded: 1 });
      // The rival's BEGIN, inside the first one's delay, then the first one's: refused.
      expect(answers).toEqual([true, false]);
      expect(await rival).toMatchObject({ attempted: 1, completed: 1, failed: 0 });
      expect(invoked).toBe(1);
      expect(table.get('A')).toMatchObject({ status: 'done', attempts: 0 });
    });

    it("Codex r4 race 1, maxAttempts 1: BEGIN wrote, its reply came back after a rival's takeover — the run is never failed without an invocation", async () => {
      const clock = { ms: T0 };
      let invoked = 0;
      const handler = () => ((invoked += 1), { done: true });
      let rival: Promise<unknown> | null = null;
      const { store, table } = memoryJobStore([rowOf('A')], {
        clock: () => iso(clock.ms),
        afterBegin: async (_id, began) => {
          if (rival || !began) return;
          clock.ms += JOB_LEASE_MS; // BEGIN wrote; its reply is held past the lease
          rival = on(store, clock, handler, 1)();
          await rival;
        },
      });
      const late = await on(store, clock, handler, 1)();
      // BEGIN wrote, so its drive ran the handler: that is the commitment.
      expect(invoked).toBe(1);
      expect(late).toMatchObject({ attempted: 1, superseded: 1 });
      // The rival's takeover charged that begun pass, and on `maxAttempts: 1` ended the run — after
      // an invocation, which is what the charge counts.
      expect(await rival).toMatchObject({ attempted: 1, failed: 1, completed: 0 });
      expect(table.get('A')).toMatchObject({ status: 'failed', attempts: 1, last_error: JOB_LEASE_EXPIRED_NOTE });
    });

    it('Codex r4 race 2, nine misses before: a BEGIN whose reply is slow still runs, clears the count, and never fails the run', async () => {
      const clock = { ms: T0 };
      let invoked = 0;
      const { store, table } = memoryJobStore([rowOf('A', { admission_misses: JOB_ADMISSION_MISS_MAX - 1 })], {
        clock: () => iso(clock.ms),
        afterBegin: (_id, began) => {
          expect(began).toBe(true);
          clock.ms += JOB_LEASE_MS * (1 - JOB_LEASE_ENTRY_MARGIN); // slow, but inside the lease
        },
      });
      expect(await on(store, clock, () => ((invoked += 1), { done: true }), 1)()).toMatchObject({ attempted: 1, completed: 1, failed: 0 });
      expect(invoked).toBe(1);
      expect(table.get('A')).toMatchObject({ status: 'done', admission_misses: null, attempts: 0 });
    });

    it('nine misses before, and a tenth late claim: only a CONSECUTIVE tenth miss fails the run, with no invocation', async () => {
      const clock = { ms: T0 };
      let invoked = 0;
      const { store, table } = memoryJobStore([rowOf('A', { admission_misses: JOB_ADMISSION_MISS_MAX - 1 })], {
        clock: () => iso(clock.ms),
        afterClaim: () => (clock.ms += JOB_LEASE_MS * (1 - JOB_LEASE_ENTRY_MARGIN)),
      });
      expect(await on(store, clock, () => ((invoked += 1), { done: true }), 1)()).toMatchObject({ failed: 1 });
      expect(invoked).toBe(0);
      expect(table.get('A')).toMatchObject({ status: 'failed', attempts: 0, last_error: expect.stringContaining(JOB_LEASE_TOO_SHORT_NOTE) });
    });

    it('a crash between BEGIN and the handler is charged: on maxAttempts 1 the takeover ends the run', async () => {
      const clock = { ms: T0 };
      const { store, table } = memoryJobStore([rowOf('A')], { clock: () => iso(clock.ms) });
      // A drive claims and begins, then dies before invoking anything.
      expect(await store.claim('A', 'crashed', JOB_LEASE_MS)).not.toBeNull();
      expect(await store.begin('A', 'crashed', JOB_LEASE_MS * JOB_LEASE_ENTRY_MARGIN)).toBe(true);
      clock.ms += JOB_LEASE_MS;
      let invoked = 0;
      expect(await on(store, clock, () => ((invoked += 1), { done: true }), 1)()).toMatchObject({
        attempted: 1,
        failed: 1,
        errors: [{ runId: 'A', error: JOB_LEASE_EXPIRED_NOTE }],
      });
      expect(invoked).toBe(0);
      expect(table.get('A')).toMatchObject({ status: 'failed', attempts: 1 });
    });

    it('the ONLY double run: a BEGIN reply held past the lease — pinned as the documented at-least-once', async () => {
      const clock = { ms: T0 };
      const ran: string[] = [];
      let rival: Promise<unknown> | null = null;
      const { store, table } = memoryJobStore([rowOf('A')], {
        clock: () => iso(clock.ms),
        afterBegin: async (_id, began) => {
          if (rival || !began) return;
          clock.ms += JOB_LEASE_MS;
          rival = on(store, clock, () => (ran.push('rival'), { done: true }))();
          await rival;
        },
      });
      expect(await on(store, clock, () => (ran.push('late'), { done: true }))()).toMatchObject({ attempted: 1, superseded: 1 });
      expect(await rival).toMatchObject({ attempted: 1, completed: 1 });
      // Both ran: the rival, then the drive whose BEGIN wrote. The rival's takeover charged the begun
      // pass, and its own commit then reset the count; the late drive's commit was refused.
      expect(ran).toEqual(['rival', 'late']);
      expect(table.get('A')).toMatchObject({ status: 'done', attempts: 0, lease_owner: null });
    });

    for (const skew of [100, -100]) {
      it(`a ${skew > 0 ? '+' : ''}${skew} ms skew between the store's clock and the drive's, on a ${JOB_LEASE_MIN_MS} ms lease: no false refusal, no false failure, exactly once`, async () => {
        const clock = { ms: T0 };
        let invoked = 0;
        const held = gate();
        const inside = gate();
        const { store, table } = memoryJobStore([rowOf('A')], { clock: () => iso(clock.ms + skew) });
        const drive = driver(
          store,
          clock,
          async () => {
            invoked += 1;
            inside.open();
            await held.opened;
            return { done: true };
          },
          { leaseMs: JOB_LEASE_MIN_MS, maxAttempts: 1 },
        );
        const holder = drive();
        await inside.opened;
        expect(table.get('A')).toMatchObject({ admission_misses: null, lease_began_at: iso(clock.ms + skew) });
        // A rival while the holder works finds nothing to take, whatever the skew.
        expect(await drive()).toMatchObject({ attempted: 0, superseded: 0, failed: 0 });
        held.open();
        expect(await holder).toMatchObject({ attempted: 1, completed: 1, superseded: 0, failed: 0 });
        expect(invoked).toBe(1);
        expect(table.get('A')).toMatchObject({ status: 'done', attempts: 0, admission_misses: null });
      });
    }
  });

  describe('repeated admission misses back off, and end the run (#2042 review r3)', () => {
    /** A store whose every claim answer comes back with less than the margin of its lease left. */
    const alwaysLate = (clock: { ms: number }, lateFor = () => true) =>
      memoryJobStore([rowOf('A')], {
        clock: () => iso(clock.ms),
        afterClaim: () => {
          if (lateFor()) clock.ms += JOB_LEASE_MS * (1 - JOB_LEASE_ENTRY_MARGIN);
        },
      });

    it('each miss waits longer, no handler runs and no attempt is charged; at the limit the run fails, lease too short', async () => {
      const clock = { ms: T0 };
      let invoked = 0;
      const { store, table } = alwaysLate(clock);
      const drive = driver(store, clock, () => ((invoked += 1), { done: true }), { maxAttempts: 1 });
      const waits: number[] = [];
      for (let miss = 1; miss < JOB_ADMISSION_MISS_MAX; miss += 1) {
        const report = await drive();
        expect(report).toMatchObject({ attempted: 0, superseded: 1, failed: 0 });
        expect(report.warnings).toEqual([{ runId: 'A', warning: expect.stringMatching(`admission miss ${miss} of ${JOB_ADMISSION_MISS_MAX}`) }]);
        const row = table.get('A')!;
        expect(row).toMatchObject({ status: 'running', attempts: 0, admission_misses: miss, lease_owner: null });
        waits.push(Date.parse(row.next_attempt_at!) - clock.ms);
        clock.ms = Date.parse(row.next_attempt_at!);
      }
      // Exponential, capped.
      expect(waits).toEqual(waits.map((_, i) => Math.min(JOB_ADMISSION_BACKOFF_MAX_MS, JOB_ADMISSION_BACKOFF_BASE_MS * 2 ** i)));
      expect(admissionBackoffMs(JOB_ADMISSION_MISS_MAX + 20)).toBe(JOB_ADMISSION_BACKOFF_MAX_MS);
      const last = await drive();
      expect(last).toMatchObject({ attempted: 0, failed: 1, superseded: 0 });
      expect(last.errors).toEqual([{ runId: 'A', error: expect.stringContaining(JOB_LEASE_TOO_SHORT_NOTE) }]);
      expect(table.get('A')).toMatchObject({
        status: 'failed',
        attempts: 0,
        admission_misses: JOB_ADMISSION_MISS_MAX,
        last_error: expect.stringMatching(new RegExp(`^${JOB_LEASE_TOO_SHORT_NOTE}: .*leaseMs ${JOB_LEASE_MS}`)),
      });
      expect(invoked).toBe(0);
      // Terminal: not claimed again.
      clock.ms += JOB_ADMISSION_BACKOFF_MAX_MS;
      expect(await drive()).toMatchObject({ attempted: 0, superseded: 0, failed: 0 });
    });

    it('the reset is BEGIN itself: a pass that began and then died leaves the count at zero', async () => {
      const clock = { ms: T0 };
      const held = gate();
      const inside = gate();
      let late = false;
      const { store, table } = memoryJobStore([rowOf('A', { admission_misses: 5 })], {
        clock: () => iso(clock.ms),
        afterClaim: () => {
          if (late) clock.ms += JOB_LEASE_MS * (1 - JOB_LEASE_ENTRY_MARGIN);
        },
      });
      const dying = driver(store, clock, async () => {
        inside.open();
        await held.opened; // it never reports
        return { done: true };
      })();
      await inside.opened;
      expect(table.get('A')).toMatchObject({ admission_misses: null });
      clock.ms += JOB_LEASE_MS;
      late = true;
      // The takeover's own claim comes back late: a FIRST miss, not the sixth.
      expect(await driver(store, clock, () => ({ done: true }))()).toMatchObject({ superseded: 1 });
      expect(table.get('A')).toMatchObject({ admission_misses: 1, attempts: 1 });
      held.open();
      await dying;
    });

    it('twin: a BEGIN resets the count, so misses must be consecutive to end the run', async () => {
      const clock = { ms: T0 };
      let claims = 0;
      // Late on every claim but the one after the seventh: the run advances there.
      const { store, table } = alwaysLate(clock, () => (claims += 1) !== 8);
      let passes = 0;
      const drive = driver(store, clock, () => ((passes += 1), { cursor: passes }), { maxAttempts: 1 });
      for (let i = 0; i < 7; i += 1) {
        await drive();
        clock.ms = Date.parse(table.get('A')!.next_attempt_at!);
      }
      expect(table.get('A')).toMatchObject({ admission_misses: 7 });
      expect(await drive()).toMatchObject({ attempted: 1, advanced: 1 });
      expect(table.get('A')).toMatchObject({ status: 'running', admission_misses: null, next_attempt_at: null });
      // Seven more misses would have ended a run that kept its count; this one is still going.
      for (let i = 0; i < 7; i += 1) {
        expect(await drive()).toMatchObject({ superseded: 1, failed: 0 });
        clock.ms = Date.parse(table.get('A')!.next_attempt_at!);
      }
      expect(table.get('A')).toMatchObject({ status: 'running', admission_misses: 7 });
      expect(passes).toBe(1);
    });
  });

  it('a lease shorter than JOB_LEASE_MIN_MS is refused at registration', () => {
    expect(() => assertLeaseMs(JOB_LEASE_MIN_MS - 1)).toThrow(/at least/);
    expect(() => assertLeaseMs(1.5)).toThrow(/at least/);
    expect(() => assertLeaseMs(JOB_LEASE_MIN_MS)).not.toThrow();
    expect(() => assertLeaseMs(undefined)).not.toThrow();
  });

  it('every claim mints its own owner, including a second pass in the same drive', async () => {
    const claims: { id: string; owner: string; won: boolean }[] = [];
    const { store } = memoryJobStore([rowOf('A')], { claims });
    let passes = 0;
    await driver(store, { ms: T0 }, () => ({ cursor: (passes += 1), done: passes === 3 }), { maxPasses: 3 })();
    expect(passes).toBe(3);
    expect(claims.filter((c) => c.won)).toHaveLength(3);
    expect(new Set(claims.map((c) => c.owner)).size).toBe(3);
  });

  describe("the pass outcome writes the run's real next attempt, never the lease's expiry", () => {
    const lease = 24 * 60 * 60_000; // a day, so a leaked expiry cannot pass for anything else

    it('a retry is due on its backoff', async () => {
      const { store, table } = memoryJobStore([rowOf('A')]);
      await driver(store, { ms: T0 }, () => {
        throw new Error('no');
      }, { leaseMs: lease })();
      const at = Date.parse(table.get('A')!.next_attempt_at!);
      // baseDelayMs 1 000, ±20% jitter.
      expect(at).toBeGreaterThanOrEqual(T0 + 800);
      expect(at).toBeLessThanOrEqual(T0 + 1_200);
    });

    it('an advanced pass is due at once', async () => {
      const { store, table } = memoryJobStore([rowOf('A')]);
      await driver(store, { ms: T0 }, () => ({ cursor: 1 }), { leaseMs: lease })();
      expect(table.get('A')).toMatchObject({ status: 'running', next_attempt_at: null, lease_owner: null });
    });

    it('a finished run carries none', async () => {
      const { store, table } = memoryJobStore([rowOf('A')]);
      await driver(store, { ms: T0 }, () => ({ done: true }), { leaseMs: lease })();
      expect(table.get('A')).toMatchObject({ status: 'done', next_attempt_at: null });
    });

    it('a deferred pass waits JOB_DEFER_MS', async () => {
      const { store, table } = memoryJobStore([rowOf('A')]);
      const refusal = new Error('wait');
      await runDueJobRuns({
        store,
        handlerFor: () => ({
          handler: async (pass) => {
            await pass.scope();
            return { done: true };
          },
          leaseMs: lease,
        }),
        now: () => iso(T0),
        openScope: async () => {
          throw refusal;
        },
        deferral: (err) => err === refusal,
      });
      expect(table.get('A')).toMatchObject({ status: 'running', next_attempt_at: iso(T0 + JOB_DEFER_MS), lease_owner: null });
    });
  });
});
