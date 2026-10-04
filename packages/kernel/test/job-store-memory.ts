import {
  JOB_LEASE_EXPIRED_NOTE,
  admissionMissOutcome,
  type JobDueKey,
  type JobRunPatch,
  type JobRunRow,
  type JobRunStore,
  type JobStepRow,
} from '../src/job-run.js';

/**
 * An in-memory `JobRunStore` holding the same lines the adapters' SQL holds: the due read, the
 * claim's compare-and-set (#2034), BEGIN, the admission miss, and every write conditional on
 * `running` and on the lease. Every lease time is the STORE's clock as the operation runs (#2042
 * r4) — `clock`, which a test may set apart from the drive's to model a skew.
 *
 * Hooks stop a drive at a precise point: `afterSnapshot` runs once a snapshot is taken (and may be
 * async, to hold two drives there together); `duplicate` repeats a key in it; `afterClaim` holds a
 * won claim's reply back; `beforeBegin` holds BEGIN before it runs, `afterBegin` its reply after.
 */
export function memoryJobStore(
  rows: JobRunRow[],
  opts: {
    afterSnapshot?: (rows: Map<string, JobRunRow>) => unknown;
    duplicate?: string;
    /** Every claim attempt, won or not, in order. */
    claims?: { id: string; owner: string; won: boolean }[];
    /** Runs after a won claim is written, before its reply reaches the drive: a slow reply. */
    afterClaim?: (id: string) => unknown;
    /** Runs before BEGIN executes: a BEGIN delayed in transit. */
    beforeBegin?: (id: string) => unknown;
    /** Runs after BEGIN executed, before its reply reaches the drive. */
    afterBegin?: (id: string, began: boolean) => unknown;
    /** The store's own clock. Default: the latest `now` a drive's snapshot passed in. */
    clock?: () => string;
  } = {},
) {
  const table = new Map<string, JobRunRow>(
    rows.map((r) => [
      r.id,
      { ...r, lease_owner: r.lease_owner ?? null, lease_began_at: r.lease_began_at ?? null, admission_misses: r.admission_misses ?? null },
    ]),
  );
  const steps = new Map<string, JobStepRow>();
  let lastSeen = new Date(0).toISOString();
  const now = () => opts.clock?.() ?? lastSeen;
  const plus = (at: string, ms: number) => new Date(Date.parse(at) + ms).toISOString();
  const holds = (r: JobRunRow | undefined, owner: string): r is JobRunRow =>
    !!r && r.status === 'running' && (r.lease_owner ?? null) === owner;
  const apply = (id: string, p: JobRunPatch, owner: string): boolean => {
    const r = table.get(id);
    if (!holds(r, owner)) return false;
    table.set(id, {
      ...r,
      status: p.status,
      cursor: p.cursor,
      counters: p.counters,
      attempts: p.attempts,
      last_error: p.lastError,
      updated_at: p.updatedAt,
      next_attempt_at: p.nextAttemptAt,
      ended_at: p.endedAt,
      lease_owner: null,
      lease_began_at: null,
    });
    return true;
  };
  const renew = (id: string, owner: string, leaseMs: number): boolean => {
    const r = table.get(id);
    if (!holds(r, owner)) return false;
    table.set(id, { ...r, next_attempt_at: plus(now(), leaseMs) });
    return true;
  };
  const store: JobRunStore = {
    startOrJoin: async (_key, row) => row,
    dueKeys: async (at, max) => {
      lastSeen = at;
      const keys: JobDueKey[] = [...table.values()]
        .filter((r) => r.status === 'running' && (r.next_attempt_at === null || r.next_attempt_at <= at))
        .sort((a, b) => (a.next_attempt_at ?? a.started_at).localeCompare(b.next_attempt_at ?? b.started_at) || a.id.localeCompare(b.id))
        .slice(0, max)
        .map((r) => ({ id: r.id, module_id: r.module_id, job: r.job }));
      if (opts.duplicate) {
        const again = keys.find((k) => k.id === opts.duplicate);
        if (again) keys.push(again);
      }
      await opts.afterSnapshot?.(table);
      return keys;
    },
    claim: async (id, owner, leaseMs) => {
      const at = now();
      const r = table.get(id);
      const won = !!r && r.status === 'running' && (r.next_attempt_at === null || r.next_attempt_at <= at);
      opts.claims?.push({ id, owner, won });
      if (!won) return null;
      // Charged only when the lease taken over had BEGUN its pass (#2042 r2, r4).
      const takeover = (r.lease_began_at ?? null) !== null;
      const claimed: JobRunRow = {
        ...r,
        lease_owner: owner,
        lease_began_at: null,
        next_attempt_at: plus(at, leaseMs),
        updated_at: at,
        attempts: r.attempts + (takeover ? 1 : 0),
        last_error: takeover ? JOB_LEASE_EXPIRED_NOTE : r.last_error,
      };
      table.set(id, claimed);
      await opts.afterClaim?.(id);
      return { run: { ...claimed }, takeover };
    },
    begin: async (id, owner, marginMs) => {
      await opts.beforeBegin?.(id);
      const at = now();
      const r = table.get(id);
      const began = holds(r, owner) && r.next_attempt_at !== null && r.next_attempt_at > plus(at, marginMs);
      if (began) table.set(id, { ...r, lease_began_at: at, admission_misses: null });
      await opts.afterBegin?.(id, began);
      return began;
    },
    miss: async (id, owner, note) => {
      const r = table.get(id);
      if (!holds(r, owner) || (r.lease_began_at ?? null) !== null) return null;
      const at = now();
      const misses = (r.admission_misses ?? 0) + 1;
      const o = admissionMissOutcome(misses, at, note);
      table.set(id, {
        ...r,
        admission_misses: misses,
        updated_at: at,
        lease_owner: null,
        lease_began_at: null,
        status: o.status,
        next_attempt_at: o.nextAttemptAt,
        ended_at: o.endedAt,
        last_error: o.lastError ?? r.last_error,
      });
      return { misses, failed: o.status === 'failed' };
    },
    list: async () => [...table.values()],
    patch: async (id, p, owner) => apply(id, p, owner),
    commitPass: async (id, p, owner) => {
      if (!apply(id, p, owner)) return false;
      for (const key of [...steps.keys()]) if (key.startsWith(`${id}/`)) steps.delete(key);
      return true;
    },
    beginStep: async (runId, name, owner, leaseMs) =>
      renew(runId, owner, leaseMs) ? { held: true, row: steps.get(`${runId}/${name}`) ?? null } : { held: false, row: null },
    recordStep: async (runId, name, result, attempts, lastError, _at, owner, leaseMs) => {
      if (!renew(runId, owner, leaseMs)) return false;
      steps.set(`${runId}/${name}`, { step: name, result, attempts, last_error: lastError });
      return true;
    },
  };
  return { store, table, steps };
}
