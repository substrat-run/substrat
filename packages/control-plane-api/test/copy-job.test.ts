import { describe, expect, it, vi } from 'vitest';
import { platformActorId, scopeId, tenantId, type ScopeDumpPage, type ScopeDumpTable } from '@substrat-run/contracts';
import { SCOPE_COPY_LEASE_MS, ulid } from '@substrat-run/kernel';
import { ControlPlaneError } from '@substrat-run/control-plane-client';
import {
  COPY_JOB_MAX_FAULTS,
  advanceCopyJob,
  copyJobAt,
  copyJobId,
  copyJobLive,
  copyJobThrewRetryMs,
  memoryCopyJobs,
  newCopyJob,
  versionOrderOf,
  type CopyJobDeps,
  type CopyJobSpec,
} from '../src/copy-job.js';
import { PAGE_CALL_DEADLINE_MS, VerticalClient, beginTransfer, transferStep, type TransferState } from '../src/vertical-client.js';

/**
 * #2450 step 2: a copy that outlasts its request runs as a job. Each step renews the move's lease
 * first, moves pages for a bounded time, and records where it stopped; a refusal fails it, a
 * transient fault is retried with backoff, and a lease that cannot be renewed stops it.
 */
const t = tenantId.parse(ulid());
const preview = scopeId.parse(ulid());
const prod = scopeId.parse(ulid());
const actor = platformActorId.parse(ulid());

const rowsOf = (id: string): ScopeDumpTable => ({ name: 't_rows', ddl: 'CREATE TABLE t_rows (id TEXT)', columns: ['id'], rows: [[id]] });
const PAGES = [[rowsOf('a')], [rowsOf('b')], [rowsOf('c')], [rowsOf('d')], [rowsOf('e')]];

/** Two deployments: a source answering `PAGES`, a destination recording what it staged. */
function deployments(opts: { pageFails?: (n: number) => Error | null } = {}) {
  const staged: { stageId: string; seq: number }[] = [];
  const discarded: string[] = [];
  const ended: string[] = [];
  const source = {
    endScopeCapture: async (_s: string, copyId: string) => void ended.push(copyId),
    exportScope: async () => PAGES.flat(),
    exportScopeStamped: async () => ({ tables: PAGES.flat(), loadStamp: null, revision: null }),
    exportScopePage: async (_s: string, cursor: string | null): Promise<ScopeDumpPage> => {
      const n = cursor === null ? 0 : Number(cursor);
      const fault = opts.pageFails?.(n);
      if (fault) throw fault;
      return { tables: PAGES[n]!, next: n + 1 < PAGES.length ? String(n + 1) : null, loadStamp: null, revision: 'r1' };
    },
  } as unknown as VerticalClient;
  const dest = {
    stageScopePage: async (_s: string, stageId: string, seq: number) => {
      staged.push({ stageId, seq });
      return { staged: true };
    },
    discardStagedScope: async (_s: string, stageId: string) => {
      discarded.push(stageId);
    },
  } as unknown as VerticalClient;
  return { source, dest, staged, discarded, ended };
}

function harness(opts: { renew?: () => boolean; pageFails?: (n: number) => Error | null; clock?: { now: number } } = {}) {
  const { source, dest, staged, discarded, ended } = deployments(opts);
  const renewals: string[] = [];
  const clock = opts.clock ?? { now: Date.parse('2026-10-20T10:00:00.000Z') };
  const deps: CopyJobDeps = {
    clientForRef: async (ref) => (ref === 'src' ? source : ref === 'dst' ? dest : undefined),
    admin: {
      renewScopeScriptCopy: async (_a, _t, _s, moveId) => {
        renewals.push(moveId);
        return (opts.renew?.() ?? true) ? { renewedAt: clock.now, leaseUntil: new Date(clock.now + 60_000).toISOString() } : null;
      },
    },
    now: () => clock.now,
  };
  const spec = (over: Partial<CopyJobSpec> = {}): CopyJobSpec => ({
    id: copyJobId('fork', preview),
    kind: 'fork',
    tenantId: t,
    vertical: 'acme/app',
    scopeId: preview,
    versionId: 'v2',
    versionOrder: '2026-10-20T10:00:00.000Z v2',
    moveId: 'move-1',
    sourceRef: 'src',
    destRef: 'dst',
    actor,
    // The production lease, which bounds neither a step nor a retry here.
    leaseMs: SCOPE_COPY_LEASE_MS,
    erasureEpoch: 0,
    restoredStamp: 'stamp-1',
    startedAt: clock.now,
    deadline: clock.now + 3_600_000,
    ...over,
  });
  const begin = async (): Promise<TransferState> => {
    const begun = await beginTransfer({ source, dest }, { from: prod, to: preview }, { stamp: false, alwaysStage: true });
    return (begun as { state: TransferState }).state;
  };
  return { deps, spec, begin, staged, discarded, ended, renewals, clock };
}

describe('advanceCopyJob (#2450)', () => {
  it('renews the lease, then moves pages until its budget is spent, and resumes where it stopped', async () => {
    const h = harness();
    // Each page takes 10 s on this clock, so a 25 s step moves three.
    const slow = { ...h.deps, clientForRef: async (ref: string) => {
      const client = await h.deps.clientForRef(ref);
      if (ref !== 'src' || !client) return client;
      return { ...client, exportScopePage: async (...args: Parameters<VerticalClient['exportScopePage']>) => {
        h.clock.now += 10_000;
        return client.exportScopePage(...args);
      } } as unknown as VerticalClient;
    } };
    let job = newCopyJob(h.spec(), await h.begin(), h.clock.now);
    job = await advanceCopyJob(slow, job, { stepMs: 25_000 });
    expect(job).toMatchObject({ status: 'copying', pages: 4, faults: 0 });
    expect(h.renewals).toEqual(['move-1']);
    job = await advanceCopyJob(slow, JSON.parse(JSON.stringify(job)), { stepMs: 25_000 });
    expect(job.status).toBe('done');
    expect(job.done?.dump).toEqual({ stageId: h.staged[0]!.stageId });
    expect(h.staged.map((s) => s.seq)).toEqual([0, 1, 2, 3, 4]);
    expect(h.renewals).toEqual(['move-1', 'move-1']);
    // A finished job is answered as it is: no renewal, no page.
    expect(await advanceCopyJob(slow, job)).toBe(job);
    expect(h.renewals).toHaveLength(2);
  });

  it('a lease that cannot be renewed stops the job before it moves anything', async () => {
    const h = harness({ renew: () => false });
    const job = await advanceCopyJob(h.deps, newCopyJob(h.spec(), await h.begin(), h.clock.now));
    expect(job).toMatchObject({ status: 'failed', error: { status: 409 } });
    expect(job.error!.message).toMatch(/settled while it ran/);
    expect(h.staged).toHaveLength(1); // only the page the route staged
  });

  it('past its deadline the job fails, and stops renewing', async () => {
    const h = harness();
    const job = newCopyJob(h.spec({ deadline: h.clock.now - 1 }), await h.begin(), h.clock.now);
    const out = await advanceCopyJob(h.deps, job);
    expect(out).toMatchObject({ status: 'failed', error: { status: 504 } });
    expect(h.renewals).toEqual([]);
  });

  it('a transient fault backs off and resumes; one in a row too many fails the job', async () => {
    let faulty = 2;
    const h = harness({ pageFails: (n) => (n === 2 && faulty-- > 0 ? new ControlPlaneError(502, 'blip') : null) });
    let job = newCopyJob(h.spec(), await h.begin(), h.clock.now);
    job = await advanceCopyJob(h.deps, job);
    expect(job).toMatchObject({ status: 'copying', faults: 1, nextDelayMs: 2_000 });
    job = await advanceCopyJob(h.deps, job);
    expect(job).toMatchObject({ status: 'copying', faults: 2, nextDelayMs: 4_000 });
    job = await advanceCopyJob(h.deps, job);
    expect(job).toMatchObject({ status: 'done', faults: 0 });

    const always = harness({ pageFails: (n) => (n === 2 ? new ControlPlaneError(503, 'down') : null) });
    let stuck = newCopyJob(always.spec(), await always.begin(), always.clock.now);
    for (let i = 0; i < COPY_JOB_MAX_FAULTS; i++) stuck = await advanceCopyJob(always.deps, stuck);
    expect(stuck).toMatchObject({ status: 'failed', error: { status: 503 } });
    expect(stuck.error!.message).toMatch(new RegExp(`after ${COPY_JOB_MAX_FAULTS} attempts`));
  });

  it('at the default 30 min lease a step runs its whole 20 s and a retry waits its whole backoff, as before', async () => {
    // Each page takes 10 s on this clock, and a fault would back off 32 s.
    const h = harness();
    const slow = (fail: boolean) => ({ ...h.deps, clientForRef: async (ref: string) => {
      const client = await h.deps.clientForRef(ref);
      if (ref !== 'src' || !client) return client;
      return { ...client, exportScopePage: async (...args: Parameters<VerticalClient['exportScopePage']>) => {
        h.clock.now += 10_000;
        if (fail) throw new ControlPlaneError(503, 'down');
        return client.exportScopePage(...args);
      } } as unknown as VerticalClient;
    } });
    expect(h.spec().leaseMs).toBe(SCOPE_COPY_LEASE_MS);
    const state = await h.begin();
    // No step budget given: COPY_JOB_STEP_MS, two 10 s pages after the one the route staged.
    expect(await advanceCopyJob(slow(false), newCopyJob(h.spec(), state, h.clock.now))).toMatchObject({ status: 'copying', pages: 3 });
    const faulty = { ...newCopyJob(h.spec(), state, h.clock.now), faults: 4 };
    expect(await advanceCopyJob(slow(true), faulty)).toMatchObject({ status: 'copying', faults: 5, nextDelayMs: 32_000 });
  });

  it('a short lease bounds both a step and the wait before a retry to a quarter of it', async () => {
    // An 8 s lease: each page takes 1 s on this clock, and a fault would back off 16 s.
    const pageMs = (h: ReturnType<typeof harness>, fail?: (n: number) => boolean) => ({ ...h.deps, clientForRef: async (ref: string) => {
      const client = await h.deps.clientForRef(ref);
      if (ref !== 'src' || !client) return client;
      return { ...client, exportScopePage: async (...args: Parameters<VerticalClient['exportScopePage']>) => {
        h.clock.now += 1_000;
        if (fail?.(Number(args[1] ?? 0))) throw new ControlPlaneError(503, 'down');
        return client.exportScopePage(...args);
      } } as unknown as VerticalClient;
    } });
    const h = harness();
    const step = await advanceCopyJob(pageMs(h), newCopyJob(h.spec({ leaseMs: 8_000 }), await h.begin(), h.clock.now));
    // Two seconds of pages, not the 20 s step: two pages after the one the route staged.
    expect(step).toMatchObject({ status: 'copying', pages: 3 });

    const f = harness();
    const faulty = { ...newCopyJob(f.spec({ leaseMs: 8_000 }), await f.begin(), f.clock.now), faults: 3 };
    expect(await advanceCopyJob(pageMs(f, () => true), faulty)).toMatchObject({ status: 'copying', faults: 4, nextDelayMs: 2_000 });
    // The same fault under the production lease waits its whole backoff.
    const g = harness();
    const unbound = { ...newCopyJob(g.spec(), await g.begin(), g.clock.now), faults: 3 };
    expect(await advanceCopyJob(pageMs(g, () => true), unbound)).toMatchObject({ faults: 4, nextDelayMs: 16_000 });
    // And the wait its host takes after a step that threw outright: the same quarter, 30 s at most.
    expect(copyJobThrewRetryMs(faulty)).toBe(2_000);
    expect(copyJobThrewRetryMs(unbound)).toBe(30_000);
  });

  it('a copy torn part way that now fits one page is staged again, never held in the record', async () => {
    const h = harness();
    // Two pages, until the second reads a source written since the first; then it is one page.
    const tornSource = () => {
      let torn = false;
      return {
        exportScopePage: async (_s: string, cursor: string | null): Promise<ScopeDumpPage> => {
          if (cursor === null) {
            return torn
              ? { tables: [rowsOf('only')], next: null, loadStamp: null, revision: 'r2' }
              : { tables: [rowsOf('a')], next: '1', loadStamp: null, revision: 'r1' };
          }
          torn = true;
          return { tables: [rowsOf('b')], next: null, loadStamp: null, revision: 'r2' };
        },
      } as unknown as VerticalClient;
    };
    const staged: { stageId: string; seq: number }[] = [];
    const dest = {
      stageScopePage: async (_s: string, stageId: string, seq: number) => {
        staged.push({ stageId, seq });
        return { staged: true };
      },
      discardStagedScope: async () => undefined,
    } as unknown as VerticalClient;
    const begin = async (source: VerticalClient) =>
      ((await beginTransfer({ source, dest }, { from: prod, to: preview }, { stamp: false, alwaysStage: true })) as { state: TransferState }).state;

    const source = tornSource();
    const deps = { ...h.deps, clientForRef: async (ref: string) => (ref === 'src' ? source : ref === 'dst' ? dest : undefined) };
    const job = await advanceCopyJob(deps, newCopyJob(h.spec(), await begin(source), h.clock.now));
    expect(job.status).toBe('done');
    // The restarted copy opened a stage of its own, and the record names it.
    expect(staged.map((s) => s.seq)).toEqual([0, 0]);
    expect(staged[1]!.stageId).not.toBe(staged[0]!.stageId);
    expect(job.done?.dump).toEqual({ stageId: staged[1]!.stageId });

    // The in-request copy, torn the same way, may still move it whole: it holds the page itself.
    const again = tornSource();
    const inRequest = await transferStep({ source: again, dest }, await begin(again));
    expect(inRequest).toMatchObject({ done: { dump: [rowsOf('only')] } });

    // A source rolled back to a deployment that cannot page answers the restarted copy whole: a job
    // has nowhere to keep that, so it fails rather than storing it.
    let torn = false;
    const rolledBack = {
      exportScopePage: async (_s: string, cursor: string | null) => {
        if (cursor === null) return torn ? 'predates' : { tables: [rowsOf('a')], next: '1', loadStamp: null, revision: 'r1' };
        torn = true;
        return { tables: [rowsOf('b')], next: null, loadStamp: null, revision: 'r2' };
      },
      exportScope: async () => [rowsOf('whole')],
    } as unknown as VerticalClient;
    const stuck = await advanceCopyJob(
      { ...h.deps, clientForRef: async (ref: string) => (ref === 'src' ? rolledBack : ref === 'dst' ? dest : undefined) },
      newCopyJob(h.spec(), await begin(rolledBack), h.clock.now),
    );
    expect(stuck).toMatchObject({ status: 'failed', error: { status: 502 } });
    expect(stuck.done).toBeUndefined();
  });

  it('a job that fails discards the stage it opened, and its record still names it; a fault it rides out keeps it', async () => {
    // Refused at its fourth page.
    const refused = harness({ pageFails: (n) => (n === 3 ? new ControlPlaneError(412, 'the source moved') : null) });
    const job = await advanceCopyJob(refused.deps, newCopyJob(refused.spec(), await refused.begin(), refused.clock.now));
    expect(job).toMatchObject({ status: 'failed', error: { status: 412 } });
    const stageId = refused.staged[0]!.stageId;
    expect(job.state?.stageId).toBe(stageId);
    expect(refused.discarded).toEqual([stageId]);

    // Past its deadline, and with its lease gone: the same.
    const late = harness();
    const overdue = await advanceCopyJob(late.deps, newCopyJob(late.spec({ deadline: late.clock.now - 1 }), await late.begin(), late.clock.now));
    expect(overdue).toMatchObject({ status: 'failed', state: { stageId: late.staged[0]!.stageId } });
    expect(late.discarded).toEqual([late.staged[0]!.stageId]);
    const lost = harness({ renew: () => false });
    expect(await advanceCopyJob(lost.deps, newCopyJob(lost.spec(), await lost.begin(), lost.clock.now))).toMatchObject({ status: 'failed' });
    expect(lost.discarded).toEqual([lost.staged[0]!.stageId]);

    // A transient fault: the next step resumes into the same stage, so it stays.
    const blip = harness({ pageFails: (n) => (n === 2 ? new ControlPlaneError(503, 'down') : null) });
    const riding = await advanceCopyJob(blip.deps, newCopyJob(blip.spec(), await blip.begin(), blip.clock.now));
    expect(riding).toMatchObject({ status: 'copying', faults: 1, state: { stageId: blip.staged[0]!.stageId } });
    expect(blip.discarded).toEqual([]);
  });

  it('a job that fails holding a capture ends it at the source, beside its stage (#2450 step 3)', async () => {
    const h = harness();
    const state = { ...(await h.begin()), capture: true as const, batch: 0 };
    const job = await advanceCopyJob(h.deps, newCopyJob(h.spec({ deadline: h.clock.now - 1 }), state, h.clock.now));
    expect(job).toMatchObject({ status: 'failed' });
    expect({ discarded: h.discarded, ended: h.ended }).toEqual({ discarded: [state.stageId], ended: [state.stageId] });
  });

  it('a catch-up spans steps: a step whose budget is spent after a batch leaves the next one to the next step', async () => {
    const h = harness();
    // Two captured pages, then a batch that is not final and one that is; each batch takes 1 s.
    const asked: number[] = [];
    const source = {
      endScopeCapture: async () => undefined,
      exportScopePage: async (_s: string, cursor: string | null, o: { capture?: string } = {}): Promise<ScopeDumpPage> => {
        const n = cursor === null ? 0 : 1;
        return { tables: PAGES[n]!, next: n === 0 ? '1' : null, loadStamp: null, revision: `r${n}`, ...(o.capture ? { captured: true as const } : {}) };
      },
      exportScopeChanges: async (_s: string, _c: string, seq: number) => {
        asked.push(seq);
        h.clock.now += 1_000;
        return { tables: [{ ...rowsOf(`x${seq}`), rowids: [9], deleted: [] }], final: seq === 1, revision: seq === 1 ? 'final' : 'r9' };
      },
    } as unknown as VerticalClient;
    const dest = { ...(await h.deps.clientForRef('dst'))!, stageScopeChanges: async () => ({ staged: true }) } as unknown as VerticalClient;
    const deps = { ...h.deps, clientForRef: async (ref: string) => (ref === 'src' ? source : ref === 'dst' ? dest : undefined) };
    const begun = (await beginTransfer({ source, dest }, { from: prod, to: preview }, { stamp: false, alwaysStage: true })) as { state: TransferState };
    const first = await advanceCopyJob(deps, newCopyJob(h.spec(), begun.state, h.clock.now), { stepMs: 500 });
    expect(first).toMatchObject({ status: 'copying', state: { cursor: null, capture: true, batch: 1 } });
    expect(asked).toEqual([0]);
    const second = await advanceCopyJob(deps, first, { stepMs: 500 });
    expect(second).toMatchObject({ status: 'done', done: { revision: 'final' } });
    expect(asked).toEqual([0, 1]);
  });

  it('a stopped step moves no further page, and a copy it tears opens no new stage', async () => {
    // Stopped before it starts: nothing at all, not even the renewal.
    const idle = harness();
    const untouched = newCopyJob(idle.spec(), await idle.begin(), idle.clock.now);
    expect(await advanceCopyJob(idle.deps, untouched, { stopped: () => true })).toBe(untouched);
    expect(idle.renewals).toEqual([]);

    // Stopped while it pages: the page in flight is staged, and the step answers there.
    let stop = false;
    const paging = harness({ pageFails: (n) => ((stop ||= n === 2), null) });
    const part = await advanceCopyJob(paging.deps, newCopyJob(paging.spec(), await paging.begin(), paging.clock.now), { stopped: () => stop });
    expect(part).toMatchObject({ status: 'copying', pages: 3 });
    expect(paging.staged.map((s) => s.seq)).toEqual([0, 1, 2]);
    // Its twin, not stopped, moves every page in the same step.
    const whole = harness();
    expect(await advanceCopyJob(whole.deps, newCopyJob(whole.spec(), await whole.begin(), whole.clock.now), { stopped: () => false }))
      .toMatchObject({ status: 'done' });

    // A torn read after the stop: the stage is discarded, and no other is opened.
    let torn = false;
    const staged: { stageId: string; seq: number }[] = [];
    const discarded: string[] = [];
    const source = {
      exportScopePage: async (_s: string, cursor: string | null): Promise<ScopeDumpPage> => {
        if (cursor !== null) torn = true;
        return { tables: [rowsOf('a')], next: torn ? null : '1', loadStamp: null, revision: torn ? 'r2' : 'r1' };
      },
    } as unknown as VerticalClient;
    const dest = {
      stageScopePage: async (_s: string, stageId: string, seq: number) => (staged.push({ stageId, seq }), { staged: true }),
      discardStagedScope: async (_s: string, stageId: string) => void discarded.push(stageId),
    } as unknown as VerticalClient;
    const begun = (await beginTransfer({ source, dest }, { from: prod, to: preview }, { stamp: false, alwaysStage: true })) as { state: TransferState };
    const deps = { ...paging.deps, clientForRef: async (ref: string) => (ref === 'src' ? source : ref === 'dst' ? dest : undefined) };
    const stopped = await advanceCopyJob(deps, newCopyJob(paging.spec(), begun.state, paging.clock.now), { stopped: () => torn });
    expect(stopped).toMatchObject({ status: 'copying', state: { stageId: begun.state.stageId } });
    expect(discarded).toEqual([begun.state.stageId]);
    expect(staged.map((s) => s.seq)).toEqual([0]);
  });

  it('a page call that stalls ends the step at its deadline, as a transient fault', async () => {
    // What a cancel or forget waits for: the step in flight. A stalled read must not hold it longer.
    const h = harness();
    const state = await h.begin();
    vi.useFakeTimers();
    try {
      let aborted = false;
      const stalled = new VerticalClient({
        fetch: ((_url: string, init: RequestInit) =>
          new Promise((_, reject) => {
            init.signal?.addEventListener('abort', () => {
              aborted = true;
              reject(new DOMException('aborted', 'AbortError'));
            });
          })) as unknown as typeof fetch,
        platformSecret: 'secret',
      });
      const deps = { ...h.deps, clientForRef: async (ref: string) => (ref === 'src' ? stalled : h.deps.clientForRef(ref)) };
      const stepping = advanceCopyJob(deps, newCopyJob(h.spec(), state, h.clock.now));
      await vi.advanceTimersByTimeAsync(PAGE_CALL_DEADLINE_MS);
      expect(await stepping).toMatchObject({ status: 'copying', faults: 1, state: { stageId: state.stageId } });
      expect(aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a refusal fails the job at once, with the status the route will answer', async () => {
    const h = harness({ pageFails: (n) => (n === 1 ? new ControlPlaneError(409, 'took writes') : null) });
    const job = await advanceCopyJob(h.deps, newCopyJob(h.spec(), await h.begin(), h.clock.now));
    expect(job).toMatchObject({ status: 'failed', error: { status: 409, message: 'took writes' } });
  });

  it('an unreachable deployment is a transient fault', async () => {
    const h = harness();
    const job = await advanceCopyJob(h.deps, newCopyJob(h.spec({ destRef: 'gone' }), await h.begin(), h.clock.now));
    expect(job).toMatchObject({ status: 'copying', faults: 1 });
  });
});

describe('copyJobLive (#2450)', () => {
  it('a job is live while it can still land its data: copying in time, or done and still finishable', async () => {
    const h = harness();
    const state = await h.begin();
    const now = h.clock.now;
    const copying = newCopyJob(h.spec({ deadline: now + 1_000 }), state, now);
    const lease = copying.spec.leaseMs;
    expect(copyJobLive(copying, now)).toBe(true);
    // Its last step more than a lease ago: its steps have stopped, whatever its deadline.
    const far = newCopyJob(h.spec({ deadline: now + 10 * lease }), state, now);
    expect(copyJobLive(far, now + lease)).toBe(true);
    expect(copyJobLive(far, now + lease + 1)).toBe(false);
    // Stepping still, but past its deadline by less than a lease, a step still fails it; by more, its steps are gone.
    const stepping = { ...copying, updatedAt: now + 1_000 + lease };
    expect(copyJobLive(stepping, now + 1_000 + lease)).toBe(true);
    expect(copyJobLive(stepping, now + 1_000 + lease + 1)).toBe(false);
    const done = { ...copying, status: 'done' as const, updatedAt: now };
    expect(copyJobLive(done, now + lease - 1)).toBe(true);
    expect(copyJobLive(done, now + lease)).toBe(false);
    // Held by the call finishing it, it is live past that lease too.
    expect(copyJobLive({ ...done, claimedUntil: now + 2 * lease }, now + lease + 1)).toBe(true);
    for (const status of ['failed', 'cancelled'] as const) expect(copyJobLive({ ...copying, status }, now)).toBe(false);
  });

  it('copyJobAt reads a job whose steps stopped as failed, by its deadline or as stalled, and any other as it is', async () => {
    const h = harness();
    const created = newCopyJob(h.spec({ startedAt: h.clock.now, deadline: h.clock.now + 60_000 }), await h.begin(), h.clock.now);
    const lease = created.spec.leaseMs;
    // Its last step recorded at its deadline's lease: read as it is there, failed by the deadline past it.
    const job = { ...created, updatedAt: h.clock.now + 60_000 + lease };
    expect(copyJobAt(job, h.clock.now + 60_000 + lease)).toBe(job);
    expect(copyJobAt(job, h.clock.now + 60_000 + lease + 1)).toMatchObject({
      status: 'failed',
      error: { status: 504, message: expect.stringMatching(/ran past its 1 min limit; nothing was moved/) },
      state: { stageId: job.state!.stageId },
    });
    // Short of its deadline, with no step recorded for more than a lease: stalled.
    const idle = newCopyJob(h.spec({ startedAt: h.clock.now, deadline: h.clock.now + 10 * lease }), await h.begin(), h.clock.now);
    expect(copyJobAt(idle, h.clock.now + lease)).toBe(idle);
    expect(copyJobAt(idle, h.clock.now + lease + 1)).toMatchObject({
      status: 'failed',
      error: { status: 504, message: expect.stringMatching(/made no progress for 30 min, so its steps had stopped; nothing was moved/) },
    });
    // The same sentence a step fails it with at the deadline.
    expect((await advanceCopyJob(h.deps, { ...job, spec: { ...job.spec, deadline: h.clock.now - 1, startedAt: h.clock.now - 60_001 } })).error?.message)
      .toMatch(/ran past its 1 min limit; nothing was moved/);
    const done = { ...job, status: 'done' as const };
    expect(copyJobAt(done, h.clock.now + 10 * lease)).toBe(done);
  });
});

describe('versionOrderOf (#2450)', () => {
  it('orders versions by when the registry recorded them, whatever their ids', () => {
    // A publisher may name any id: this one sorts after every ULID, and was recorded first.
    const named = { id: 'zz-named-by-its-publisher', createdAt: '2026-10-20T10:00:00.000Z' };
    const pushed = { id: ulid(), createdAt: '2026-10-20T10:00:01.000Z' };
    expect(named.id > pushed.id).toBe(true);
    expect(versionOrderOf(named) < versionOrderOf(pushed)).toBe(true);
    // At the same instant, the ids decide.
    const same = '2026-10-20T10:00:00.000Z';
    expect(versionOrderOf({ id: 'a', createdAt: same }) < versionOrderOf({ id: 'b', createdAt: same })).toBe(true);
    // One instant written two ways is one place.
    expect(versionOrderOf({ id: 'a', createdAt: '2026-10-20T10:00:00Z' })).toBe(versionOrderOf({ id: 'a', createdAt: same }));
  });
});

describe('memoryCopyJobs (#2450)', () => {
  it('starts once per id, pumps to done, and a cancel stops it for good', async () => {
    const h = harness();
    const jobs = memoryCopyJobs(h.deps, { stepMs: 0 });
    const spec = h.spec();
    const state = await h.begin();
    const started = await jobs.start(spec, state);
    expect(await jobs.start(spec, state)).toBe(started);
    await jobs.pump(spec.id);
    expect((await jobs.get(spec.id))?.status).toBe('copying');
    // Cancelled, it keeps naming its stage, as the Durable Object's record does, for the settle.
    expect(await jobs.cancel(spec.id)).toMatchObject({ status: 'cancelled', state: { stageId: state.stageId } });
    await jobs.pump(spec.id);
    expect((await jobs.get(spec.id))?.status).toBe('cancelled');
    await jobs.forget(spec.id);
    expect(await jobs.get(spec.id)).toBeNull();
  });

  it('a cancel stops the step in flight and waits for it, as the Durable Object does: its answer lands, then the job is cancelled', async () => {
    let cancelling: Promise<unknown> | null = null;
    let jobs: ReturnType<typeof memoryCopyJobs> | undefined;
    // The cancel lands while the step renews its lease, before it pages.
    const h = harness({ renew: () => ((cancelling ??= jobs!.cancel(copyJobId('fork', preview))), true) });
    jobs = memoryCopyJobs(h.deps, { stepMs: 60_000 });
    const spec = h.spec();
    const state = await h.begin();
    await jobs.start(spec, state);
    await jobs.pump(spec.id);
    // The step stopped after one page (unstopped, this budget moves every page), and that answer
    // is what the cancel then cancelled.
    expect(await cancelling).toMatchObject({ status: 'cancelled', pages: 2, state: { stageId: state.stageId } });
    expect(h.staged.map((s) => s.seq)).toEqual([0, 1]);
  });

  it("keeps a key's newest mark while it is held, and takes an older one once it is not", async () => {
    const h = harness();
    const jobs = memoryCopyJobs(h.deps);
    expect(await jobs.markNewest('tag:a', 'b', 1_000)).toBe('b');
    expect(await jobs.markNewest('tag:a', 'a', 1_000)).toBe('b');
    // Another key is its own.
    expect(await jobs.markNewest('tag:other', 'a', 1_000)).toBe('a');
    h.clock.now += 1_001;
    expect(await jobs.markNewest('tag:a', 'a', 1_000)).toBe('a');
    expect(await jobs.markNewest('tag:a', 'b', 1_000)).toBe('b');
  });

  it('a done job goes to one claim at a time, until its hold runs out', async () => {
    const h = harness();
    const jobs = memoryCopyJobs(h.deps, { stepMs: 60_000 });
    const spec = h.spec();
    await jobs.start(spec, await h.begin());
    // Not done yet: nothing to finish.
    expect(await jobs.claim(spec.id, 1_000)).toBeNull();
    await jobs.pump(spec.id);
    expect((await jobs.get(spec.id))?.status).toBe('done');
    const claims = await Promise.all([1, 2, 3].map(() => jobs.claim(spec.id, 1_000)));
    expect(claims.filter((c) => c !== null)).toEqual([expect.objectContaining({ status: 'done', claimedUntil: h.clock.now + 1_000 })]);
    // A cancel leaves a held job to its holder.
    expect(await jobs.cancel(spec.id)).toMatchObject({ status: 'done' });
    h.clock.now += 1_001;
    // A holder that died: once its hold has run out, the next call claims the job.
    expect(await jobs.claim(spec.id, 1_000)).toMatchObject({ status: 'done' });
  });

  it('a cancel takes a done job no call holds, and then no call can claim it', async () => {
    const h = harness();
    const jobs = memoryCopyJobs(h.deps, { stepMs: 60_000 });
    const spec = h.spec();
    await jobs.start(spec, await h.begin());
    await jobs.pump(spec.id);
    expect(await jobs.cancel(spec.id)).toMatchObject({ status: 'cancelled', done: { dump: expect.anything() } });
    expect(await jobs.claim(spec.id, 1_000)).toBeNull();
  });

  it('a forget and a new start that land during a step wait for it: the newer job is what is left, as it started', async () => {
    // While a step renews its lease, the route settles the job (forget) and a newer push starts its own.
    let during: (() => Promise<void>) | null = null;
    let landed: Promise<void> | null = null;
    const h = harness({ renew: () => (during ? ((landed = during()), true) : true) });
    const jobs = memoryCopyJobs(h.deps, { stepMs: 0 });
    const state = await h.begin();
    const old = h.spec();
    await jobs.start(old, state);
    // Without interference, the step's answer is stored: one more page moved.
    await jobs.pump(old.id);
    expect(await jobs.get(old.id)).toMatchObject({ spec: { moveId: 'move-1' }, pages: 2 });

    const newer = h.spec({ moveId: 'move-2', versionId: 'v3' });
    during = async () => {
      during = null;
      await jobs.forget(old.id);
      await jobs.start(newer, state);
    };
    await jobs.pump(old.id);
    await landed;
    // The forget waited for the old step (move-1) to answer, so nothing of it outlives the newer job.
    expect(await jobs.get(old.id)).toMatchObject({ spec: { moveId: 'move-2', versionId: 'v3' }, pages: 1 });
  });
});
