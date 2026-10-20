import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { platformActorId, scopeId, tenantId } from '@substrat-run/contracts';
import { ulid } from '@substrat-run/kernel';
import { copyJobId, type CopyJobRecord, type CopyJobs, type CopyJobSpec } from '@substrat-run/control-plane-api';
import { durableCopyJobs } from '../src/copy-jobs.js';

type TransferState = Parameters<CopyJobs['start']>[1];

/**
 * #2450 through the production wiring: `durableCopyJobs` over `ScopeCopyJobDO`, as `wrangler.jsonc`
 * binds it (`COPY_JOBS`), with the step `advance` the deployed control plane runs. The job engine
 * and the object's own rules are held in control-plane-api and adapter-cloudflare; this holds that
 * the two are joined as those suites assume.
 */
const ns = (env as unknown as { COPY_JOBS: DurableObjectNamespace }).COPY_JOBS;
const jobs = durableCopyJobs(ns);

const scope = () => scopeId.parse(ulid());
const specOf = (id: string, sid: string): CopyJobSpec => ({
  id,
  kind: 'fork',
  tenantId: tenantId.parse(ulid()),
  scopeId: scopeId.parse(sid),
  versionId: ulid(),
  versionOrder: `${new Date().toISOString()} v`,
  moveId: ulid(),
  sourceRef: 'version-source',
  destRef: 'version-dest',
  actor: platformActorId.parse(ulid()),
  leaseMs: 30 * 60_000,
  erasureEpoch: 0,
  restoredStamp: ulid(),
  startedAt: Date.now(),
  deadline: Date.now() + 3_600_000,
});
const stateOf = (sid: string): TransferState => ({
  from: scopeId.parse(ulid()), into: scopeId.parse(sid), stamp: false, stageId: ulid(), seq: 0, cursor: '1',
  revision: 'r1', loadStamp: null, attempt: 1, pages: 1, rows: 1, meta: [],
});
const until = async (id: string, ok: (j: CopyJobRecord | null) => boolean): Promise<CopyJobRecord | null> => {
  for (let i = 0; i < 200; i++) {
    const job = await jobs.get(id);
    if (ok(job)) return job;
    await new Promise((r) => setTimeout(r, 10));
  }
  return jobs.get(id);
};

describe('the preview copy jobs through ScopeCopyJobDO (#2450)', () => {
  it('a done job goes to one claim at a time, a cancel leaves a held one, and a forget drops it', async () => {
    const sid = scope();
    const id = copyJobId('fork', sid);
    const spec = specOf(id, sid);
    // A job as its last step leaves it: done, its pages staged at the destination.
    const done: CopyJobRecord = {
      spec, status: 'done', done: { dump: { stageId: ulid() }, loadStamp: null, revision: 'r1', meta: [] },
      pages: 3, rows: 30, attempt: 1, faults: 0, nextDelayMs: 0, updatedAt: Date.now(),
    };
    await runInDurableObject(ns.get(ns.idFromName(id)), async (_o, state) => {
      await state.storage.put('job', done);
    });
    const claims = await Promise.all([1, 2, 3].map(() => jobs.claim(id, 60_000)));
    expect(claims.filter((c) => c !== null)).toEqual([expect.objectContaining({ status: 'done', claimedUntil: expect.any(Number) })]);
    expect(await jobs.cancel(id)).toMatchObject({ status: 'done' });
    await jobs.forget(id);
    expect(await jobs.get(id)).toBeNull();
  });

  it('a started job steps through the deployed advance: with no dispatch namespace here it fails, still naming its stage', async () => {
    const sid = scope();
    const id = copyJobId('fork', sid);
    const state = stateOf(sid);
    expect(await jobs.start(specOf(id, sid), state)).toMatchObject({ status: 'copying' });
    const failed = await until(id, (j) => j?.status !== 'copying');
    expect(failed).toMatchObject({ status: 'failed', error: { status: 501 }, state: { stageId: state.stageId } });
    // Not done, so nothing to claim; failed, so a cancel answers it as it is.
    expect(await jobs.claim(id, 60_000)).toBeNull();
    expect(await jobs.cancel(id)).toMatchObject({ status: 'failed' });
    await jobs.forget(id);
    expect(await jobs.get(id)).toBeNull();
  });
});
