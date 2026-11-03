import {
  storeDriverDumpPageBytes,
  type PlatformActorId,
  type ScopeBackupObject,
  type ScopeId,
  type ScopeStoreBackup,
  type TenantId,
} from '@substrat-run/contracts';
import type { HostAdmin } from '@substrat-run/kernel';
import { ControlPlaneError } from '@substrat-run/control-plane-client';
import type { ScopeBackup, ScopeBackupStore } from './backups.js';
import type { CopyJobStatus } from './copy-job.js';
import type { PlatformScopeStores } from './platform-scope-stores.js';
import { backupEnds, discardStages, restoreEnds, writeBackupIndex, type BackupPlace } from './store-move-ends.js';
import { advanceStorePlan, countingWrites, movesOf, STORE_REQUEST_BUDGET, type MovedStore, type StoreMovePlan } from './store-move.js';

/**
 * How long one step moves pages before it yields, ms, as a copy job's. A job has `STORE_JOB_MAX_MS`, so
 * reaching `STORE_BACKUP_MAX_PAGES` takes about 0.93 pages a second, faults and waits included.
 */
export const STORE_JOB_STEP_MS = 20_000;
/** The most pages one step moves: an alarm has the same 1000 subrequests a request has. */
export const STORE_JOB_STEP_PAGES = STORE_REQUEST_BUDGET.pages;
/** How long a job may run before it fails, ms: within what a stage holds (`STORE_STAGE_MAX_AGE_MS`). */
export const STORE_JOB_MAX_MS = 6 * 3_600_000;
/** Consecutive transient faults a job rides out before it fails. */
export const STORE_JOB_MAX_FAULTS = 6;
/** Past this with no step recorded, a job's steps have stopped: a step and its longest wait fit well inside. */
export const STORE_JOB_STALL_MS = 10 * 60_000;
/** How long a call that claimed a done restore holds it, to load and commit, ms. */
export const STORE_JOB_CLAIM_MS = 5 * 60_000;

export type StoreJobKind = 'store-backup' | 'store-restore';

export interface StoreJobSpec {
  /** `storeJobId(kind, scopeId)`: one of each kind per scope at a time. */
  id: string;
  kind: StoreJobKind;
  tenantId: TenantId;
  scopeId: ScopeId;
  vertical: string;
  /** The backup being written or read. `scopeId` is the scope it lands in or was taken of. */
  capturedAt: string;
  /** A backup's: the scope's own tables, already written beside the pages. */
  scopeObject?: ScopeBackupObject & { tables: number };
  /** A restore's: the scope whose backup it reads, when not `scopeId`, which is where it lands. */
  sourceScopeId?: ScopeId;
  /** A restore's: the page size per driver it cuts at, fixed so a resumed step cuts the same pages. */
  pageBytes?: Record<string, number>;
  actor: PlatformActorId;
  startedAt: number;
  deadline: number;
}

/** What a route answers (202) while a job runs: ask about a backup again by naming `capturedAt`. */
export interface StoreJobProgress {
  copying: true;
  capturedAt: string;
  pages: number;
  rows: number;
  attempt: number;
}

export interface StoreJobRecord {
  spec: StoreJobSpec;
  status: CopyJobStatus;
  /** While copying, and kept once failed: where the move is. Cursors and counts, never a row. */
  state?: StoreMovePlan;
  /** Once done: a backup's metadata, or the stages a restore's finishing call commits. */
  done?: { backup?: ScopeBackup; moved: MovedStore[] };
  error?: { status: number; message: string };
  claimedUntil?: number;
  pages: number;
  rows: number;
  attempt: number;
  faults: number;
  nextDelayMs: number;
  updatedAt: number;
}

export const storeJobId = (kind: StoreJobKind, scopeId: string): string => `${kind}:${scopeId}`;

/** Whether a job record is one of these, in the Durable Object that also runs preview copies. */
export const isStoreJob = (job: { spec: { kind: string } }): job is StoreJobRecord =>
  job.spec.kind === 'store-backup' || job.spec.kind === 'store-restore';

/** Where store jobs live: the copy jobs' Durable Object in production, a map in a test. */
export interface StoreJobs {
  /** Start `spec` from `state`, or answer the job already started under `spec.id`. */
  start(spec: StoreJobSpec, state: StoreMovePlan): Promise<StoreJobRecord>;
  get(id: string): Promise<StoreJobRecord | null>;
  /** Take a done job to finish it, held for `holdMs`, for one caller at a time. */
  claim(id: string, holdMs: number): Promise<StoreJobRecord | null>;
  /**
   * Stop a job, after waiting for a step running now, so the record answered names all it left. A
   * job that is done and held is answered as it is.
   */
  cancel(id: string): Promise<StoreJobRecord | null>;
  forget(id: string): Promise<void>;
}

export interface StoreJobDeps {
  stores: PlatformScopeStores;
  backups: ScopeBackupStore | undefined;
  admin: Pick<HostAdmin, 'getScopeRecord'>;
  now?: () => number;
}

export function newStoreJob(spec: StoreJobSpec, state: StoreMovePlan, now: number = Date.now()): StoreJobRecord {
  return { spec, status: 'copying', state, pages: state.pages, rows: state.move.rows, attempt: state.move.attempt, faults: 0, nextDelayMs: 0, updatedAt: now };
}

/** The page size per driver a restore job fixes in its spec. */
export const restorePageBytes = (stores: readonly { driver: string }[]): Record<string, number> =>
  Object.fromEntries(stores.map(({ driver }) => [driver, storeDriverDumpPageBytes(driver)]));

/** `job` as read at `now`: one still copying whose steps have stopped reads as failed, so a caller settles it. */
export function storeJobAt(job: StoreJobRecord, now: number): StoreJobRecord {
  if (job.status !== 'copying' || now <= job.updatedAt + STORE_JOB_STALL_MS) return job;
  return {
    ...job, status: 'failed', nextDelayMs: 0,
    error: { status: 504, message: `the job for scope ${job.spec.scopeId} made no progress for ${Math.round((now - job.updatedAt) / 60_000)} min, so its steps had stopped; nothing was changed` },
  };
}

const faultBackoffMs = (faults: number): number => Math.min(60_000, 1_000 * 2 ** faults);

/**
 * One step of a store job: move pages for up to `stepMs`, then answer the record to store. A backup's
 * last step writes the index, so a backup lands whether or not anyone is still asking; a restore's
 * stops at everything staged, for the route's next call to load and commit, as a copy job does. A
 * refusal fails it, leaving nothing: a backup's objects are deleted, a restore's stages discarded. A
 * transient fault waits and asks again, up to `STORE_JOB_MAX_FAULTS` in a row. A record older than
 * what was written is safe to run: a page object is written again in place, and a restore's stage
 * says it holds the page. What a step moved past its stored record is given up when it faults, since
 * no record will name it again. A scope reaped meanwhile stops the job, right up to the index, so no copy
 * of its data lands after the reap's wipe.
 *
 * `deps` may be how to build them: a binding that cannot be built is a fault like any other, counted
 * and past the deadline fatal, not a step that throws and is retried for good.
 */
export async function advanceStoreJob(
  deps: StoreJobDeps | (() => StoreJobDeps),
  job: StoreJobRecord,
  opts: { stepMs?: number; stepPages?: number; stopped?: () => boolean } = {},
): Promise<StoreJobRecord> {
  if (job.status !== 'copying' || !job.state) return job;
  const stopped = opts.stopped ?? (() => false);
  if (stopped()) return job;
  const { spec } = job;
  let built: StoreJobDeps | undefined;
  let unbuilt: unknown;
  try {
    built = typeof deps === 'function' ? deps() : deps;
  } catch (e) {
    unbuilt = e;
  }
  const now = built?.now ?? Date.now;
  const place: BackupPlace = { tenantId: spec.tenantId, scopeId: spec.scopeId, vertical: spec.vertical, capturedAt: spec.capturedAt };
  const source = { tenantId: spec.tenantId, scopeId: spec.sourceScopeId ?? spec.scopeId, capturedAt: spec.capturedAt };
  const plan = job.state;
  /** The plan as the step last left it: past `plan`, which is what stays stored after a fault. */
  let last = plan;
  const failed = async (status: number, message: string): Promise<StoreJobRecord> => {
    const moves = [...movesOf(plan), ...movesOf(last)];
    if (spec.kind === 'store-backup') {
      await built?.backups?.deleteAttempt({ ...place, scopeKey: spec.scopeObject?.key, moveIds: [...new Set(moves.map((m) => m.moveId))] }).catch(() => undefined);
    } else if (built) {
      await discardStages(built.stores, place, moves);
    }
    return { ...job, status: 'failed', error: { status, message }, nextDelayMs: 0, updatedAt: now() };
  };
  const faulted = async (status: number, message: string): Promise<StoreJobRecord> => {
    const faults = job.faults + 1;
    if (faults >= STORE_JOB_MAX_FAULTS) return failed(status, `${message} (after ${faults} attempts)`);
    const recorded = new Set(movesOf(plan).map((m) => m.moveId));
    const unrecorded = movesOf(last).filter((m) => !recorded.has(m.moveId));
    if (spec.kind === 'store-backup') {
      for (const { moveId } of unrecorded) await built?.backups?.deleteMove({ ...place, moveId }).catch(() => undefined);
    } else if (built) {
      await discardStages(built.stores, place, unrecorded);
    }
    return { ...job, faults, nextDelayMs: faultBackoffMs(faults), updatedAt: now() };
  };
  if (now() > spec.deadline) {
    return failed(504, `the job for scope ${spec.scopeId} ran past its ${Math.round((spec.deadline - spec.startedAt) / 60_000)} min limit; nothing was changed`);
  }
  if (!built) return faulted(500, unbuilt instanceof Error ? unbuilt.message : String(unbuilt));
  const { backups, stores, admin } = built;
  if (!backups) return failed(501, 'no backup target configured');
  const reaped = async (): Promise<boolean> => {
    const scope = await admin.getScopeRecord(spec.actor, spec.tenantId, spec.scopeId);
    return !scope || scope.status === 'reaped';
  };
  const reapedAnswer = `scope ${spec.scopeId} was reaped while the job ran; nothing was kept`;
  try {
    if (await reaped()) return await failed(409, reapedAnswer);
    let held: readonly ScopeStoreBackup[] = [];
    if (spec.kind === 'store-restore') {
      const index = await backups.getIndex(source);
      if (!index) return await failed(422, `the backup of ${spec.capturedAt} is no longer held; nothing was changed`);
      held = index.stores;
    }
    const endsOf = spec.kind === 'store-backup'
      ? backupEnds({ stores, backups }, place)
      : restoreEnds({ stores, backups }, source, place, held, (driver) => spec.pageBytes?.[driver] ?? storeDriverDumpPageBytes(driver));
    const until = now() + (opts.stepMs ?? STORE_JOB_STEP_MS);
    const stepPages = opts.stepPages ?? STORE_JOB_STEP_PAGES;
    let moved = 0;
    const progress = await advanceStorePlan(
      (store) => countingWrites(endsOf(store), (pages) => { moved += pages; }),
      plan,
      { until: () => moved >= stepPages || now() >= until || stopped(), stopped, track: (now_) => { last = now_; } },
    );
    if ('state' in progress) {
      const { state, delayMs } = progress;
      return {
        ...job, state, pages: state.pages, rows: state.move.rows, attempt: state.move.attempt,
        faults: 0, nextDelayMs: delayMs, updatedAt: now(),
      };
    }
    if (spec.kind === 'store-backup') {
      if (!spec.scopeObject) return await failed(500, 'a backup job names no scope object');
      // The pages took time. A reap in that time wiped the store, and this copy must not land after it.
      if (await reaped()) return await failed(409, reapedAnswer);
      const backup = await writeBackupIndex(backups, place, spec.scopeObject, progress.done);
      return { ...job, status: 'done', state: undefined, done: { backup, moved: progress.done }, faults: 0, nextDelayMs: 0, updatedAt: now() };
    }
    return { ...job, status: 'done', state: undefined, done: { moved: progress.done }, faults: 0, nextDelayMs: 0, updatedAt: now() };
  } catch (e) {
    const status = e instanceof ControlPlaneError ? e.status : 500;
    const message = e instanceof Error ? e.message : String(e);
    const transient = status === 0 || (status >= 500 && status !== 501);
    return transient ? await faulted(status, message) : await failed(status, message);
  }
}
