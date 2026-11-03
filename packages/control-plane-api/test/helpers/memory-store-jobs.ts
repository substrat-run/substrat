import { advanceStoreJob, newStoreJob, type StoreJobDeps, type StoreJobRecord, type StoreJobs } from '../../src/store-jobs.js';

/** `StoreJobs` in memory. Jobs move only when `pump` is called, so a test decides when each step runs. */
export function memoryStoreJobs(deps: StoreJobDeps, opts: { stepMs?: number; stepPages?: number } = {}): StoreJobs & {
  pump(id: string): Promise<StoreJobRecord | null>;
  jobs: Map<string, StoreJobRecord>;
} {
  const jobs = new Map<string, StoreJobRecord>();
  const now = deps.now ?? Date.now;
  return {
    jobs,
    async start(spec, state) {
      const held = jobs.get(spec.id);
      if (held) return held;
      const job = newStoreJob(spec, state, now());
      jobs.set(spec.id, job);
      return job;
    },
    async get(id) {
      return jobs.get(id) ?? null;
    },
    async claim(id, holdMs) {
      const job = jobs.get(id);
      if (job?.status !== 'done' || (job.claimedUntil ?? 0) > now()) return null;
      const claimed = { ...job, claimedUntil: now() + holdMs };
      jobs.set(id, claimed);
      return claimed;
    },
    async cancel(id) {
      const job = jobs.get(id);
      if (!job) return null;
      if (job.status !== 'copying' && (job.status !== 'done' || (job.claimedUntil ?? 0) > now())) return job;
      const cancelled: StoreJobRecord = { ...job, status: 'cancelled', nextDelayMs: 0, updatedAt: now() };
      jobs.set(id, cancelled);
      return cancelled;
    },
    async forget(id) {
      jobs.delete(id);
    },
    async pump(id) {
      const job = jobs.get(id);
      if (!job) return null;
      const next = await advanceStoreJob(deps, job, opts);
      if (jobs.get(id) === job) jobs.set(id, next);
      return jobs.get(id) ?? null;
    },
  };
}
