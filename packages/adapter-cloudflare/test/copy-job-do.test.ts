import { env, runDurableObjectAlarm } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { CopyJobDo } from '../src/copy-job-do.js';
import type { TestCopyJob } from './worker.js';

/**
 * #2450 step 2 on workerd: the object a background copy runs in. It stores the job, runs one step
 * per alarm until the job is no longer copying, keeps a finished job for the route to read, and
 * lets a cancel or forget that lands during a step win over that step's answer. The alarms fire by
 * themselves, as in production, so each case waits for what it asserts.
 */
type Stub = DurableObjectStub & CopyJobDo<TestCopyJob>;
const stubOf = (ns: DurableObjectNamespace, name: string) => ns.get(ns.idFromName(name)) as unknown as Stub;
const job = (over: Partial<TestCopyJob> = {}): TestCopyJob =>
  ({ status: 'copying', nextDelayMs: 0, updatedAt: Date.now(), steps: 0, target: 3, ...over });
const until = async (stub: Stub, ok: (j: TestCopyJob | null) => boolean): Promise<TestCopyJob | null> => {
  for (let i = 0; i < 200; i++) {
    const held = await stub.get();
    if (ok(held)) return held;
    await new Promise((r) => setTimeout(r, 10));
  }
  return stub.get();
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('defineCopyJobDO (#2450 step 2)', () => {
  it('starts once, steps by alarm until done, and keeps the finished job', async () => {
    const stub = stubOf(env.COPY_JOB_TEST, `run-${crypto.randomUUID()}`);
    const started = await stub.start(job());
    expect(await stub.start(job({ target: 99 }))).toMatchObject({ target: 3 });
    expect(started.status).toBe('copying');
    expect(await until(stub, (j) => j?.status === 'done')).toMatchObject({ status: 'done', steps: 3 });
    await sleep(30);
    // Kept for its 60 s retention: still there to read.
    expect(await stub.get()).toMatchObject({ status: 'done', steps: 3 });
  });

  it('a step that throws is retried later, and the job is not lost', async () => {
    const stub = stubOf(env.COPY_JOB_TEST, `throw-${crypto.randomUUID()}`);
    await stub.start(job({ target: 1, throwUntil: Date.now() + 50 }));
    await sleep(30);
    expect(await stub.get()).toMatchObject({ status: 'copying', steps: 0 });
    await sleep(40);
    // The retry is scheduled 30 s out; run it now.
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(await until(stub, (j) => j?.status === 'done')).toMatchObject({ status: 'done', steps: 1 });
  });

  it('a cancel that lands during a step wins over that step, and no later step runs', async () => {
    const stub = stubOf(env.COPY_JOB_TEST, `cancel-${crypto.randomUUID()}`);
    await stub.start(job({ holdMs: 80 }));
    await sleep(20);
    expect((await stub.cancel())?.status).toBe('cancelled');
    await sleep(150);
    expect(await stub.get()).toMatchObject({ status: 'cancelled', steps: 0 });
    // A cancel of a job no longer copying changes nothing.
    expect(await stub.cancel()).toMatchObject({ status: 'cancelled', steps: 0 });
  });

  it('forget drops the job and its alarm; a step in flight writes nothing back', async () => {
    const stub = stubOf(env.COPY_JOB_TEST, `forget-${crypto.randomUUID()}`);
    await stub.start(job({ holdMs: 80 }));
    await sleep(20);
    await stub.forget();
    await sleep(150);
    expect(await stub.get()).toBeNull();
    expect(await runDurableObjectAlarm(stub)).toBe(false);
  });

  it('a finished job is deleted once its retention has passed', async () => {
    const stub = stubOf(env.COPY_JOB_SHORT, `retain-${crypto.randomUUID()}`);
    await stub.start(job({ target: 1 }));
    expect(await until(stub, (j) => j?.status === 'done')).toMatchObject({ status: 'done' });
    expect(await until(stub, (j) => j === null)).toBeNull();
  });
});
