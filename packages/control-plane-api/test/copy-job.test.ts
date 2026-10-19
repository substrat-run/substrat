import { describe, expect, it } from 'vitest';
import { platformActorId, scopeId, tenantId, type ScopeDumpPage, type ScopeDumpTable } from '@substrat-run/contracts';
import { ulid } from '@substrat-run/kernel';
import { ControlPlaneError } from '@substrat-run/control-plane-client';
import {
  COPY_JOB_MAX_FAULTS,
  advanceCopyJob,
  copyJobId,
  memoryCopyJobs,
  newCopyJob,
  type CopyJobDeps,
  type CopyJobSpec,
} from '../src/copy-job.js';
import { beginTransfer, type TransferState, type VerticalClient } from '../src/vertical-client.js';

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
  const source = {
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
    discardStagedScope: async () => undefined,
  } as unknown as VerticalClient;
  return { source, dest, staged };
}

function harness(opts: { renew?: () => boolean; pageFails?: (n: number) => Error | null; clock?: { now: number } } = {}) {
  const { source, dest, staged } = deployments(opts);
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
    id: copyJobId('fork', preview, 'v2'),
    kind: 'fork',
    tenantId: t,
    scopeId: preview,
    versionId: 'v2',
    moveId: 'move-1',
    sourceRef: 'src',
    destRef: 'dst',
    actor,
    leaseMs: 60_000,
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
  return { deps, spec, begin, staged, renewals, clock };
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
    expect((await jobs.cancel(spec.id))?.status).toBe('cancelled');
    await jobs.pump(spec.id);
    expect((await jobs.get(spec.id))?.status).toBe('cancelled');
    await jobs.forget(spec.id);
    expect(await jobs.get(spec.id)).toBeNull();
  });
});
