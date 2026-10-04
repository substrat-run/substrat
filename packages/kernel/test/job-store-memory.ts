import {
  JOB_LEASE_EXPIRED_NOTE,
  type JobDueKey,
  type JobRunPatch,
  type JobRunRow,
  type JobRunStore,
  type JobStepRow,
} from '../src/job-run.js';

/**
 * An in-memory `JobRunStore` holding the same lines the adapters' SQL holds: the due read, the
 * claim's compare-and-set (#2034), and every write conditional on `running` and on the lease.
 * Hooks let a test stop a drive at a precise point: `afterSnapshot` runs once a snapshot is taken
 * (and may be async, to hold two drives there together); `duplicate` repeats a key in it;
 * `afterClaim` holds a won claim's answer back.
 */
export function memoryJobStore(
  rows: JobRunRow[],
  opts: {
    afterSnapshot?: (rows: Map<string, JobRunRow>) => unknown;
    duplicate?: string;
    /** Every claim attempt, won or not, in order. */
    claims?: { id: string; owner: string; won: boolean }[];
    /** Runs after a won claim is written, before its answer reaches the drive: a slow answer. */
    afterClaim?: (id: string) => unknown;
    /** Runs before an entry statement executes: an entry delayed in transit (#2042 r3). */
    beforeEnter?: (id: string) => unknown;
    /** Runs after an entry statement executed, before its answer reaches the drive. */
    afterEnter?: (id: string, entered: boolean) => unknown;
    /** The store's own clock, read as an entry runs. Default: the latest time a drive handed it. */
    clock?: () => string;
  } = {},
) {
  const table = new Map<string, JobRunRow>(
    rows.map((r) => [r.id, { ...r, lease_owner: r.lease_owner ?? null, lease_entered_at: r.lease_entered_at ?? null }]),
  );
  const steps = new Map<string, JobStepRow>();
  /** The latest `now` a drive passed in: the default clock an entry is judged by. */
  let lastSeen = new Date(0).toISOString();
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
      lease_entered_at: null,
    });
    return true;
  };
  const renew = (id: string, owner: string, until: string): boolean => {
    const r = table.get(id);
    if (!holds(r, owner)) return false;
    table.set(id, { ...r, next_attempt_at: until });
    return true;
  };
  const store: JobRunStore = {
    startOrJoin: async (_key, row) => row,
    dueKeys: async (now, max) => {
      const keys: JobDueKey[] = [...table.values()]
        .filter((r) => r.status === 'running' && (r.next_attempt_at === null || r.next_attempt_at <= now))
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
    claim: async (id, owner, now, until) => {
      lastSeen = now;
      const r = table.get(id);
      const won = !!r && r.status === 'running' && (r.next_attempt_at === null || r.next_attempt_at <= now);
      opts.claims?.push({ id, owner, won });
      if (!won) return null;
      // Charged only when the lease taken over had entered its pass (#2042 r2).
      const takeover = (r.lease_entered_at ?? null) !== null;
      const claimed: JobRunRow = {
        ...r,
        lease_owner: owner,
        lease_entered_at: null,
        next_attempt_at: until,
        updated_at: now,
        attempts: r.attempts + (takeover ? 1 : 0),
        last_error: takeover ? JOB_LEASE_EXPIRED_NOTE : r.last_error,
      };
      table.set(id, claimed);
      await opts.afterClaim?.(id);
      return { run: { ...claimed }, takeover };
    },
    enter: async (id, owner, marginMs) => {
      await opts.beforeEnter?.(id);
      const now = opts.clock?.() ?? lastSeen;
      const enterBy = new Date(Date.parse(now) + marginMs).toISOString();
      const r = table.get(id);
      const entered = holds(r, owner) && r.next_attempt_at !== null && r.next_attempt_at > enterBy;
      if (entered) table.set(id, { ...r, lease_entered_at: now });
      await opts.afterEnter?.(id, entered);
      return entered;
    },
    list: async () => [...table.values()],
    patch: async (id, p, owner) => apply(id, p, owner),
    commitPass: async (id, p, owner) => {
      if (!apply(id, p, owner)) return false;
      for (const key of [...steps.keys()]) if (key.startsWith(`${id}/`)) steps.delete(key);
      return true;
    },
    beginStep: async (runId, name, owner, until) =>
      renew(runId, owner, until) ? { held: true, row: steps.get(`${runId}/${name}`) ?? null } : { held: false, row: null },
    recordStep: async (runId, name, result, attempts, lastError, _at, owner, until) => {
      if (!renew(runId, owner, until)) return false;
      steps.set(`${runId}/${name}`, { step: name, result, attempts, last_error: lastError });
      return true;
    },
  };
  return { store, table, steps };
}
