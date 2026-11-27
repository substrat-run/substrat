import { STORE_STAGE_MAX_AGE_MS, type PlatformActorId, type ScopeBackup } from '@substrat-run/contracts';
import { ulid } from '@substrat-run/kernel';
import { ControlPlaneError } from '@substrat-run/control-plane-client';
import type { ScopeBackupStore, ScopeBackupWritten, ScopeDumpHeader, StoredScopeBackup } from './backups.js';
import type { PlatformScopeStores } from './platform-scope-stores.js';
import { COPY_JOB_MAX_FAULTS, COPY_JOB_MAX_MS, COPY_JOB_STEP_MS, type CopyJobStatus } from './copy-job.js';
import { discardMoves, movesOf, stepStoreMoves, type MovedStore, type StoreMovePlan, type StorePlanEnds } from './store-move.js';
import { backupEnds, restoreEnds, snapshotEnds, type StorePlace, type StoreSource } from './store-move-ends.js';

/**
 * A store move that outlasts the request that started it (D-69, #2854).
 *
 * One request moves at most `STORE_REQUEST_BUDGET` of a scope's stores. A backup or a restore of a
 * backup that needs more hands the move to a job where the route has one: the request answers 202,
 * and the job moves the rest a step at a time, holding one page, as a preview's copy job does
 * (`advanceCopyJob`). The job runs in the same Durable Object class (`ScopeCopyJobDO`), as a record
 * of its own shape (`isStoreMoveJob`).
 *
 * - **A backup's job finishes the backup.** It writes the store pages under the backup's key and, once
 *   every store is written, commits the manifest, so a backup no caller asks about again still lands.
 *   The scope's own pages were written by the request before it handed off; their stage is named in
 *   the spec, and the writer's account of what it wrote (`ScopeBackupWritten`) rides the record.
 * - **A restore's job only stages.** The scope's load, the commits and the erasure replay need the
 *   route (its host, its deployment, its audit), so a done restore job is finished by the next call to
 *   the restore route that names the same backup, which claims it (`StoreMoveJobs.claim`) so two calls
 *   never both finish it. A stage the driver holds is dropped once unused for `STORE_STAGE_MAX_AGE_MS`,
 *   so a done job left unclaimed past `storeRestoreFinishableUntil` is refused and run again.
 *
 * The job owns no authority of its own: store calls are signed for the platform audience as the
 * route's are, and it reads and writes only the place and the backup its spec names. A refusal fails
 * it and discards every move it made; a transient fault starts the current store's chain again after a
 * backoff, and fails it after `COPY_JOB_MAX_FAULTS` in a row.
 */
export interface StoreMoveJobSpec {
  /** `storeMoveJobId(kind, tenantId, scopeId)`: one job of each kind per scope at a time. */
  id: string;
  kind: 'store-backup' | 'store-restore';
  /** Where the stores are: the scope backed up, or the scope restored into. */
  place: StorePlace;
  actor: PlatformActorId;
  /** Epoch ms. Past `deadline` the job fails. */
  startedAt: number;
  deadline: number;
  /** A backup's: the manifest to commit, and the scope's own stage the request wrote. */
  backup?: {
    vertical: string | null;
    header: ScopeDumpHeader;
    scopeStage: { stageId: string; entries: number; tables: number };
  };
  /** A restore's: the backup read, by the scope it was taken of and its capture time. */
  restore?: { sourceScopeId: string; capturedAt: string };
}

export interface StoreMoveJobRecord {
  spec: StoreMoveJobSpec;
  status: CopyJobStatus;
  /** While copying: the move to go on with. Kept once failed, for the moves it names. */
  plan?: StoreMovePlan;
  /** A backup's: what its writer has written so far, handed to the next step's writer. */
  written?: ScopeBackupWritten;
  /** Once done: a restore's stores staged at the destination; a backup's, written under its key. */
  moved?: MovedStore[];
  /** Once a backup's job is done: the backup committed. */
  backup?: ScopeBackup;
  error?: { status: number; message: string };
  claimedUntil?: number;
  /** Pages written so far, for the 202. */
  pages: number;
  faults: number;
  nextDelayMs: number;
  updatedAt: number;
}

export const storeMoveJobId = (kind: StoreMoveJobSpec['kind'], tenantId: string, scopeId: string): string =>
  `${kind}:${tenantId}:${scopeId}`;

/** Whether a record in the copy-job object is a store move's (its kind) rather than a preview copy's. */
export const isStoreMoveJob = (record: { spec: { kind: string } }): record is StoreMoveJobRecord =>
  record.spec.kind === 'store-backup' || record.spec.kind === 'store-restore';

/** How long a step of a store job may go without one before the route reads it as stopped, ms. */
export const STORE_MOVE_JOB_STALL_MS = 10 * 60_000;
/**
 * How long a done restore job stays finishable, ms: the driver drops a stage unused for
 * `STORE_STAGE_MAX_AGE_MS`, and the finishing call needs time to load the scope before it commits.
 */
export const STORE_RESTORE_FINISH_MARGIN_MS = 30 * 60_000;
export const storeRestoreFinishableUntil = (job: StoreMoveJobRecord): number =>
  job.updatedAt + STORE_STAGE_MAX_AGE_MS - STORE_RESTORE_FINISH_MARGIN_MS;

/**
 * Where store jobs live. Production: the copy-job Durable Object, one per job id. Tests: a map.
 * Every call but `claim` is idempotent, and each is atomic for its job.
 */
export interface StoreMoveJobs {
  /** Start `record`, or answer the job already started under its id. */
  start(record: StoreMoveJobRecord): Promise<StoreMoveJobRecord>;
  get(id: string): Promise<StoreMoveJobRecord | null>;
  /** Take a done job to finish it, held for `holdMs`, to one caller at a time; null to any other. */
  claim(id: string, holdMs: number): Promise<StoreMoveJobRecord | null>;
  /** Drop a job the route has finished with, after a step running now ends. */
  forget(id: string): Promise<void>;
}

/** A job's first record, around the plan the request handed off. */
export function newStoreMoveJob(
  spec: Omit<StoreMoveJobSpec, 'startedAt' | 'deadline'>,
  plan: StoreMovePlan,
  opts: { written?: ScopeBackupWritten; now?: number } = {},
): StoreMoveJobRecord {
  const now = opts.now ?? Date.now();
  return {
    spec: { ...spec, startedAt: now, deadline: now + COPY_JOB_MAX_MS },
    status: 'copying',
    plan,
    ...(opts.written ? { written: opts.written } : {}),
    pages: plan.pages,
    faults: 0,
    nextDelayMs: 0,
    updatedAt: now,
  };
}

/**
 * `job` as read at `now`. One still copying whose steps have stopped (no step for
 * `STORE_MOVE_JOB_STALL_MS`, or past its deadline by as much) is read as failed, so the route answers
 * it rather than wait on it for good.
 */
export const storeMoveJobAt = (job: StoreMoveJobRecord, now: number): StoreMoveJobRecord => {
  if (job.status !== 'copying') return job;
  const pastDeadline = now > job.spec.deadline + STORE_MOVE_JOB_STALL_MS;
  if (!pastDeadline && now <= job.updatedAt + STORE_MOVE_JOB_STALL_MS + job.nextDelayMs) return job;
  const message = pastDeadline
    ? `the store move of scope ${job.spec.place.scopeId} ran past its ${Math.round((job.spec.deadline - job.spec.startedAt) / 60_000)} min limit; nothing was changed`
    : `the store move of scope ${job.spec.place.scopeId} made no progress for ${Math.round((now - job.updatedAt) / 60_000)} min, so its steps had stopped; nothing was changed`;
  return { ...job, status: 'failed', error: { status: 504, message }, nextDelayMs: 0 };
};

/** What a step needs: the stores, and the backups it writes or reads. */
export interface StoreMoveJobDeps {
  stores: PlatformScopeStores;
  backups?: ScopeBackupStore;
  /** Default `Date.now`. */
  now?: () => number;
}

const faultBackoffMs = (faults: number): number => Math.min(60_000, 1_000 * 2 ** faults);

/** A backup's store pages as a restore reads them. */
export const backupStoreSources = (held: StoredScopeBackup): Map<string, StoreSource> =>
  new Map(held.storeEntries.map((entry) => [
    entry.binding,
    { pages: entry.entries, revision: entry.revision, page: (seq: number) => held.storePage(entry, seq) },
  ]));

/**
 * One step of a store job: move pages for up to `stepMs`, then answer where it got to. A chain that
 * restarts yields its backoff to the host as `nextDelayMs` rather than sleeping. A job that is not
 * copying is answered as it is.
 */
export async function advanceStoreMoveJob(
  deps: StoreMoveJobDeps,
  job: StoreMoveJobRecord,
  opts: { stepMs?: number; stopped?: () => boolean } = {},
): Promise<StoreMoveJobRecord> {
  if (job.status !== 'copying' || !job.plan) return job;
  const now = deps.now ?? Date.now;
  const { spec } = job;
  const stopped = opts.stopped ?? (() => false);
  if (stopped()) return job;
  const backups = deps.backups;
  const writer = spec.backup && backups?.begin({ vertical: spec.backup.vertical, header: spec.backup.header, written: job.written ?? {} });
  let endsOf: StorePlanEnds | undefined;
  /**
   * Where a move is given up: a backup's entries, or a stage at the restored scope's stores. A discard
   * reads nothing, so a restore's needs no backup open (a snapshot's ends at one place are exactly that).
   */
  const discardEnds: StorePlanEnds = writer
    ? backupEnds(deps.stores, spec.place, writer)
    : snapshotEnds(deps.stores, spec.place, spec.place);
  /** Every move the job made goes, best effort: and a backup's own scope stage with it. */
  const failed = async (plan: StoreMovePlan, status: number, message: string): Promise<StoreMoveJobRecord> => {
    await discardMoves(discardEnds, movesOf(plan));
    if (writer && spec.backup) await writer.discard(spec.backup.scopeStage.stageId).catch(() => undefined);
    return { ...job, plan, status: 'failed', error: { status, message }, nextDelayMs: 0, updatedAt: now() };
  };
  if (!backups) return { ...job, status: 'failed', error: { status: 501, message: 'no backup target configured' }, nextDelayMs: 0, updatedAt: now() };
  if (now() > spec.deadline) {
    return failed(job.plan, 504, `the store move of scope ${spec.place.scopeId} ran past its ${Math.round((spec.deadline - spec.startedAt) / 60_000)} min limit; nothing was changed`);
  }
  let plan = job.plan;
  try {
    if (writer) {
      endsOf = backupEnds(deps.stores, spec.place, writer);
    } else if (spec.restore) {
      const held = await backups.get({ tenantId: spec.place.tenantId, scopeId: spec.restore.sourceScopeId, capturedAt: spec.restore.capturedAt });
      if (!held) throw new ControlPlaneError(404, `no backup for scope ${spec.restore.sourceScopeId} at ${spec.restore.capturedAt}`);
      const sources = backupStoreSources(held);
      endsOf = restoreEnds(deps.stores, spec.place, (binding) => {
        const source = sources.get(binding);
        if (!source) throw new ControlPlaneError(409, `backup ${spec.restore!.capturedAt} holds no pages for scope store '${binding}'`);
        return source;
      });
    } else {
      throw new ControlPlaneError(500, `store job ${spec.id} names neither a backup nor a restore`);
    }
    const until = now() + (opts.stepMs ?? COPY_JOB_STEP_MS);
    const step = await stepStoreMoves(endsOf, plan, {
      // A wait is the host's to make (`nextDelayMs`), never a sleep inside the step.
      yieldAt: (_, waitMs) => waitMs > 0 || now() >= until || stopped(),
      sleep: async () => undefined,
      track: (at) => { plan = at; },
    });
    const written = writer?.written();
    if ('plan' in step) {
      return {
        ...job, plan: step.plan, ...(written ? { written } : {}), pages: step.plan.pages,
        faults: 0, nextDelayMs: step.waitMs, updatedAt: now(),
      };
    }
    const done = { ...job, plan: undefined, moved: step.moved, pages: plan.pages, faults: 0, nextDelayMs: 0 };
    if (writer && spec.backup) {
      const { scopeStage } = spec.backup;
      const backup = await writer.commit({
        ...scopeStage,
        storeEntries: step.moved.map((s) => ({ binding: s.binding, driver: s.driver, stageId: s.moveId, entries: s.pages, revision: s.revision })),
      });
      return { ...done, status: 'done', backup, written: undefined, updatedAt: now() };
    }
    return { ...done, status: 'done', updatedAt: now() };
  } catch (e) {
    const status = e instanceof ControlPlaneError ? e.status : 500;
    const message = e instanceof Error ? e.message : String(e);
    const transient = status === 0 || (status >= 500 && status !== 501);
    if (!transient) return failed(plan, status, message);
    const faults = job.faults + 1;
    if (faults >= COPY_JOB_MAX_FAULTS) return failed(plan, status, `${message} (after ${faults} attempts)`);
    // Whether the call that faulted landed is not known, and a stage takes each page once, so the
    // store it was on starts again under a new id; the stores already moved stay moved.
    const restarted = { ...plan, chain: { ...plan.chain, moveId: ulid(), seq: 0, cursor: null, revision: null, tableNames: [] } };
    if (plan.at < plan.stores.length) {
      await discardEnds(plan.stores[plan.at]!).discard(plan.chain.moveId).catch(() => undefined);
    }
    const written = writer?.written();
    return {
      ...job, plan: restarted, ...(written ? { written } : {}), pages: restarted.pages,
      faults, nextDelayMs: faultBackoffMs(faults), updatedAt: now(),
    };
  }
}

/**
 * `StoreMoveJobs` in memory, for a host with no Durable Objects (tests, a local control plane). Jobs
 * move only when `pump` is called, so a test decides exactly when each step runs.
 */
export function memoryStoreMoveJobs(deps: StoreMoveJobDeps, opts: { stepMs?: number } = {}): StoreMoveJobs & {
  pump(id?: string): Promise<void>;
  jobs: Map<string, StoreMoveJobRecord>;
} {
  const jobs = new Map<string, StoreMoveJobRecord>();
  const now = deps.now ?? Date.now;
  return {
    jobs,
    async start(record) {
      const held = jobs.get(record.spec.id);
      if (held) return held;
      jobs.set(record.spec.id, record);
      return record;
    },
    async get(id) {
      return jobs.get(id) ?? null;
    },
    async claim(id, holdMs) {
      const job = jobs.get(id);
      if (job?.status !== 'done' || (job.claimedUntil ?? 0) > now()) return null;
      const claimed: StoreMoveJobRecord = { ...job, claimedUntil: now() + holdMs };
      jobs.set(id, claimed);
      return claimed;
    },
    async forget(id) {
      jobs.delete(id);
    },
    async pump(id) {
      for (const [key, job] of [...jobs]) {
        if (id !== undefined && key !== id) continue;
        const next = await advanceStoreMoveJob(deps, job, opts);
        if (jobs.get(key) === job) jobs.set(key, next);
      }
    },
  };
}
