import type { PlatformActorId, ScopeId, TenantId } from '@substrat-run/contracts';
import type { HostAdmin } from '@substrat-run/kernel';
import { ControlPlaneError } from '@substrat-run/control-plane-client';
import { abandonCopy, transferStep, type TransferState, type TransferredScope, type VerticalClient } from './vertical-client.js';

/**
 * A scope copy run in the background (#2450, step 2).
 *
 * A copy that takes many pages outlasts the request that started it, so the request reads the
 * first page and stages it (`beginTransfer`), records the move in the copy ledger as it always
 * did, and hands the rest to a job. The job moves the remaining pages a step at a time
 * (`advanceCopyJob`), renewing the move's lease at every step, so the ledger keeps naming a live
 * move and nothing a sweep or reap does can race it. Once every page is staged the job is `done`,
 * and the next call to the route that started it commits the staged dump and finishes exactly as
 * the synchronous path does. The job owns no authority of its own: it moves bytes between two
 * scripts the route already resolved, under a lease the route recorded.
 *
 * The job's state is this record, as JSON: where it runs (a Durable Object in production, a map in
 * a test) stores it and calls `advanceCopyJob` until it is no longer `copying`.
 */
export interface CopyJobSpec {
  /**
   * `copyJobId(kind, scopeId)`: one job of each kind per preview at a time. A newer push's copy
   * supersedes an older one's, which the route cancels; the version is in `versionId`.
   */
  id: string;
  /** A preview's first copy from its source (`fork`), or a re-push moving it on (`carry`). */
  kind: 'fork' | 'carry';
  tenantId: TenantId;
  /** The vertical the preview is of: what a fault of the copy is recorded under. */
  vertical: string;
  /** The scope the move is ledgered under: the preview. */
  scopeId: ScopeId;
  versionId: string;
  /** `versionOrderOf` the version: what a push for another version is compared against. */
  versionOrder: string;
  moveId: string;
  /** The deployments the copy reads and writes, resolved again at every step. */
  sourceRef: string;
  destRef: string;
  /** Who started it; the lease is renewed as them. */
  actor: PlatformActorId;
  leaseMs: number;
  /** What the route read when it recorded the move, for its restore fence and bind (#1722). */
  erasureEpoch: number;
  restoredStamp: string;
  /** A carry's: the preview's binding and pin when the copy began. Its restore is refused if either moved. */
  expected?: { versionId: string | null; servingRef: string | null };
  /** Epoch ms. Past `deadline` the job fails, and stops renewing a lease erasure and reap wait on. */
  startedAt: number;
  deadline: number;
}

export type CopyJobStatus = 'copying' | 'done' | 'failed' | 'cancelled';

export interface CopyJobRecord {
  spec: CopyJobSpec;
  status: CopyJobStatus;
  /**
   * While `copying`: the copy to resume. Kept once the job fails or is cancelled, for the stage it
   * names, which whoever settles the job discards (`settleJobMove`).
   */
  state?: TransferState;
  /** Once `done`: what moved, staged at the destination under `dump.stageId`. */
  done?: TransferredScope;
  /** Once `failed`: what the route answers, as the synchronous path would have. */
  error?: { status: number; message: string };
  /** Once `done`: until when (epoch ms) the call that claimed it holds it, to finish it (`CopyJobs.claim`). */
  claimedUntil?: number;
  /** Progress, for the 202 the route answers while copying. */
  pages: number;
  rows: number;
  attempt: number;
  /** Consecutive transient faults; the job backs off between them and fails past `COPY_JOB_MAX_FAULTS`. */
  faults: number;
  /** How long the host should wait before the next step, ms. */
  nextDelayMs: number;
  updatedAt: number;
}

/**
 * Where jobs live. Production: a Durable Object per job. Tests: a map. Every call but `claim` is
 * idempotent, and each is atomic for its job.
 */
export interface CopyJobs {
  /** Start `spec` from `state`, or answer the job already started under `spec.id`. */
  start(spec: CopyJobSpec, state: TransferState): Promise<CopyJobRecord>;
  get(id: string): Promise<CopyJobRecord | null>;
  /**
   * Take a `done` job to finish it: answered, held for `holdMs`, to one caller at a time, and null to
   * any other (a job held, not done, or gone). Only the holder finishes the job or gives it up, so two
   * calls that read the same done job never both load it, nor does the slower one undo the faster.
   */
  claim(id: string, holdMs: number): Promise<CopyJobRecord | null>;
  /**
   * Stop a job that is copying, or done and not held: no later step or claim acts on it. A step
   * running now is stopped and waited for first, so the record answered names every stage the job
   * left; it stays for the caller to discard. A job another call holds (`claim`) is answered as it is.
   */
  cancel(id: string): Promise<CopyJobRecord | null>;
  /** Drop a job the route has finished with, after stopping a step running now and waiting for it. */
  forget(id: string): Promise<void>;
  /**
   * Mark `order` (`versionOrderOf`) as the newest create of the preview `key` names (`copyTagId`),
   * held for `holdMs` from now, unless a later one's mark is still held. Answers the mark held after
   * the call: one later than `order` means its caller was superseded. Atomic per `key`; a mark is
   * gone once its hold runs out, so an older version is then taken like any other.
   */
  markNewest(key: string, order: string, holdMs: number): Promise<string>;
}

/** Whether a call holds `job` to finish it, at `now` (epoch ms): see `CopyJobs.claim`. */
export const copyJobHeld = (job: CopyJobRecord, now: number): boolean =>
  job.status === 'done' && (job.claimedUntil ?? 0) > now;

/**
 * Whether `job` can still move or land its push's data, at `now` (epoch ms): copying, with its
 * steps still running; or done and still finishable, held by the call finishing it or inside the
 * lease its last step renewed. A failed or cancelled job cannot, nor can one left done past that
 * lease: its claim would find the lease gone.
 *
 * A copying job's steps have stopped once its last recorded step is more than a lease old (each
 * step records itself, and it and the wait before the next stay inside a quarter of the lease, so
 * its lease has lapsed too), or once it is past its deadline by more than a lease (a step fails it there).
 */
export const copyJobLive = (job: CopyJobRecord, now: number): boolean => {
  const { leaseMs, deadline } = job.spec;
  if (job.status === 'copying') return now <= deadline + leaseMs && now <= job.updatedAt + leaseMs;
  return job.status === 'done' && (copyJobHeld(job, now) || now < job.updatedAt + leaseMs);
};

/** What a job that ran past its deadline fails with. */
const deadlineFailure = (spec: CopyJobSpec): { status: number; message: string } => ({
  status: 504,
  message: `the copy of scope ${spec.scopeId} ran past its ${Math.round((spec.deadline - spec.startedAt) / 60_000)} min limit; nothing was moved`,
});

/**
 * `job` as read at `now` (epoch ms). One still copying whose steps have stopped (`copyJobLive`: its
 * next alarm was never stored, say) is read as failed, by its deadline when it is past it and as
 * stalled otherwise, so the route settles and answers it rather than wait on it for good. Any other
 * job is read as it is.
 */
export const copyJobAt = (job: CopyJobRecord, now: number): CopyJobRecord => {
  if (job.status !== 'copying' || copyJobLive(job, now)) return job;
  const error = now > job.spec.deadline
    ? deadlineFailure(job.spec)
    : {
      status: 504,
      message: `the copy of scope ${job.spec.scopeId} made no progress for ${Math.round((now - job.updatedAt) / 60_000)} min, ` +
        `so its steps had stopped; nothing was moved`,
    };
  return { ...job, status: 'failed', error, nextDelayMs: 0 };
};

/** What a step needs: the two deployments, and the ledger to renew the lease in. */
export interface CopyJobDeps {
  clientForRef(ref: string): Promise<VerticalClient | undefined>;
  admin: Pick<HostAdmin, 'renewScopeScriptCopy'>;
  /** Default `Date.now`. */
  now?: () => number;
}

/** How long one step moves pages before it yields, ms. Inside a Durable Object alarm's budget. */
export const COPY_JOB_STEP_MS = 20_000;
/** How long a job may run before it fails, ms: erasure and reap of the scope wait while it holds its lease. */
export const COPY_JOB_MAX_MS = 6 * 3_600_000;
/** Consecutive transient faults a job rides out (backing off) before it fails. */
export const COPY_JOB_MAX_FAULTS = 6;
const backoffMs = (faults: number): number => Math.min(60_000, 1_000 * 2 ** faults);
/**
 * The most of a move's lease that one step may spend moving pages, and that a retry may wait: a
 * quarter each. A renewal is followed by at most one of each before the next renewal, so the lease
 * keeps half of itself spare for a page that overruns the step and for the alarm's own lateness, and
 * a sweep never finds it run out between two steps. At the default lease (30 min) neither bites.
 */
const leaseShareMs = (leaseMs: number): number => Math.floor(leaseMs / 4);

/**
 * How long a job's host waits after a step that threw outright before the next, ms: 30 s, and like
 * every other retry inside a quarter of the move's lease (`leaseShareMs`).
 */
export const copyJobThrewRetryMs = (job: CopyJobRecord): number => Math.min(30_000, leaseShareMs(job.spec.leaseMs));

export const copyJobId = (kind: CopyJobSpec['kind'], scopeId: string): string => `${kind}:${scopeId}`;

/**
 * A version's place in push order (#2450), as text that sorts in that order: when the registry
 * recorded it, then its id. The time is the registry's own, so the order holds whatever id a
 * publisher chose (a push mints a ULID, in that same order; a publish may name any id).
 */
export const versionOrderOf = (version: { id: string; createdAt: string }): string =>
  `${new Date(version.createdAt).toISOString()} ${version.id}`;

/** The version id a `versionOrderOf` place names. */
export const versionIdOfOrder = (order: string): string => order.slice(order.indexOf(' ') + 1);

/**
 * Where a preview's newest-create mark is kept (`CopyJobs.markNewest`): under its tag, which outlives
 * any one row of it (a newer push reaps the row it replaces), and never under a job's id.
 */
export const copyTagId = (tenantId: string, previewSlug: string): string => `tag:${tenantId}:${previewSlug}`;

/** A job's first record, around the state `beginTransfer` left. */
export function newCopyJob(spec: CopyJobSpec, state: TransferState, now: number = Date.now()): CopyJobRecord {
  return { spec, status: 'copying', state, pages: state.pages, rows: state.rows, attempt: state.attempt, faults: 0, nextDelayMs: 0, updatedAt: now };
}

/**
 * One step of a job: renew the move's lease, then move pages for up to `stepMs`. A job that is not
 * `copying` is answered as it is. A refusal fails it; a transient fault (a 5xx, an unreachable
 * deployment) is retried at the next step, backing off, and fails it only after
 * `COPY_JOB_MAX_FAULTS` in a row. Both the step and the wait before a retry stay inside a quarter of
 * the move's lease (`leaseShareMs`), so the lease cannot run out before the next step renews it.
 */
export async function advanceCopyJob(
  deps: CopyJobDeps,
  job: CopyJobRecord,
  opts: {
    stepMs?: number;
    /**
     * A cancel or forget is waiting on this step (`CopyJobStep.stopped`): it moves no further page
     * and opens no new stage, and answers where it got to, for that caller to settle.
     */
    stopped?: () => boolean;
  } = {},
): Promise<CopyJobRecord> {
  if (job.status !== 'copying' || !job.state) return job;
  const stopped = opts.stopped ?? (() => false);
  if (stopped()) return job;
  const now = deps.now ?? Date.now;
  const { spec } = job;
  const staged = job.state;
  /**
   * A failed job's stage is never loaded, so it goes here, best-effort: a job nobody calls again
   * (its caller gave up) would otherwise leave it until the scope is wiped there. The record keeps
   * naming it (`state`), so the route's settle (`settleJobMove`) can discard it too. A capture the
   * copy holds at the source is ended beside it, the same way.
   */
  const failed = async (status: number, message: string): Promise<CopyJobRecord> => {
    const dest = await deps.clientForRef(spec.destRef).catch(() => undefined);
    const source = staged.capture ? await deps.clientForRef(spec.sourceRef).catch(() => undefined) : undefined;
    await abandonCopy({ source, dest }, staged);
    return { ...job, status: 'failed', error: { status, message }, nextDelayMs: 0, updatedAt: now() };
  };
  if (now() > spec.deadline) {
    const { status, message } = deadlineFailure(spec);
    return failed(status, message);
  }
  try {
    // First: a move whose lease cannot be renewed can no longer be confirmed, so it must stop.
    const lease = await deps.admin.renewScopeScriptCopy(spec.actor, spec.tenantId, spec.scopeId, spec.moveId, { leaseMs: spec.leaseMs });
    if (!lease) {
      return failed(409, `the copy of scope ${spec.scopeId} was settled while it ran (cancelled, refreshed, swept or reaped); nothing was moved`);
    }
    const [source, dest] = await Promise.all([deps.clientForRef(spec.sourceRef), deps.clientForRef(spec.destRef)]);
    if (!source || !dest) {
      throw new ControlPlaneError(502, `the copy of scope ${spec.scopeId} could not reach '${!source ? spec.sourceRef : spec.destRef}'`);
    }
    const until = now() + Math.min(opts.stepMs ?? COPY_JOB_STEP_MS, leaseShareMs(spec.leaseMs));
    // `alwaysStage`: a copy torn mid-way starts again, and one that now fits a page must still be
    // staged. The job's record holds where the data is, never the data (a page is up to 4 MiB, more
    // than a Durable Object stores in one value).
    const progress = await transferStep({ source, dest }, job.state, {
      until: () => now() >= until || stopped(), stopped, alwaysStage: true,
    });
    if ('done' in progress) {
      if (Array.isArray(progress.done.dump)) {
        // Only an end that stopped paging part way answers a whole dump; there is nowhere to keep it.
        return failed(502, `the copy of scope ${spec.scopeId} could no longer be staged at '${spec.destRef}'; nothing was moved`);
      }
      return { ...job, status: 'done', state: undefined, done: progress.done, faults: 0, nextDelayMs: 0, updatedAt: now() };
    }
    const { state } = progress;
    return { ...job, state, pages: state.pages, rows: state.rows, attempt: state.attempt, faults: 0, nextDelayMs: 0, updatedAt: now() };
  } catch (e) {
    const status = e instanceof ControlPlaneError ? e.status : 500;
    const message = e instanceof Error ? e.message : String(e);
    const transient = status === 0 || (status >= 500 && status !== 501);
    if (!transient) return failed(status, message);
    const faults = job.faults + 1;
    if (faults >= COPY_JOB_MAX_FAULTS) return failed(status, `${message} (after ${faults} attempts)`);
    return { ...job, faults, nextDelayMs: Math.min(backoffMs(faults), leaseShareMs(spec.leaseMs)), updatedAt: now() };
  }
}

/**
 * `CopyJobs` in memory, for a host with no Durable Objects (tests, a local control plane). Jobs move
 * only when `pump` is called, so a test decides exactly when each step runs.
 */
export function memoryCopyJobs(deps: CopyJobDeps, opts: { stepMs?: number } = {}): CopyJobs & {
  pump(id?: string): Promise<void>;
  jobs: Map<string, CopyJobRecord>;
} {
  const jobs = new Map<string, CopyJobRecord>();
  const marks = new Map<string, { order: string; until: number }>();
  const now = deps.now ?? Date.now;
  /** The step `pump` runs now, per job: a cancel or forget stops it and waits for it, as the Durable Object's do. */
  const running = new Map<string, { stopped: boolean; over: Promise<void> }>();
  const whileStopped = async <T>(id: string, act: () => T): Promise<T> => {
    for (let step = running.get(id); step; step = running.get(id)) {
      step.stopped = true;
      await step.over;
    }
    return act();
  };
  return {
    jobs,
    async start(spec, state) {
      const held = jobs.get(spec.id);
      if (held) return held;
      const job = newCopyJob(spec, state, now());
      jobs.set(spec.id, job);
      return job;
    },
    async get(id) {
      return jobs.get(id) ?? null;
    },
    async claim(id, holdMs) {
      const job = jobs.get(id);
      if (job?.status !== 'done' || copyJobHeld(job, now())) return null;
      const claimed: CopyJobRecord = { ...job, claimedUntil: now() + holdMs };
      jobs.set(id, claimed);
      return claimed;
    },
    cancel(id) {
      return whileStopped(id, () => {
        const job = jobs.get(id);
        if (!job) return null;
        if (job.status !== 'copying' && (job.status !== 'done' || copyJobHeld(job, now()))) return job;
        // `state` stays, as in the Durable Object: it names the stage the caller discards next.
        const cancelled: CopyJobRecord = { ...job, status: 'cancelled', nextDelayMs: 0, updatedAt: now() };
        jobs.set(id, cancelled);
        return cancelled;
      });
    },
    forget(id) {
      return whileStopped(id, () => {
        jobs.delete(id);
      });
    },
    async markNewest(key, order, holdMs) {
      const held = marks.get(key);
      if (held && held.order > order && held.until > now()) return held.order;
      marks.set(key, { order, until: now() + holdMs });
      return order;
    },
    /** Run one step of `id` (or of every job copying), as an alarm would. */
    async pump(id) {
      for (const [key, job] of [...jobs]) {
        if (id !== undefined && key !== id) continue;
        let ended!: () => void;
        const step = { stopped: false, over: new Promise<void>((resolve) => { ended = resolve; }) };
        running.set(key, step);
        try {
          const next = await advanceCopyJob(deps, job, { ...opts, stopped: () => step.stopped });
          // Should the record have changed under the step regardless, its answer is dropped, as in
          // the Durable Object: every start and cancel stores a record of its own.
          if (jobs.get(key) === job) jobs.set(key, next);
        } finally {
          if (running.get(key) === step) running.delete(key);
          ended();
        }
      }
    },
  };
}
