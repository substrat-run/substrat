import { dataSubjectId, substratError, type DataSubjectId, type ModuleId } from '@substrat-run/contracts';
import { assertRowLimit, backoffAt, resolveRetryPolicy, type ExecutorRetryPolicy, type ScopeStub } from './scope-host.js';
import { ulid } from './ulid.js';

/**
 * The fourth driver (#1577): long, resumable, coalesced work.
 *
 * Three drivers already move work off a request, and each is correct for what it
 * is. `registerExecutor` + `drainDue` retries ONE delivery, whole. A declared
 * schedule + `runDueSchedules` fires ONE operation inside a cadence window, which
 * must then finish. `runPlatformSweep` does a pass of per-unit maintenance and
 * reports it. None of them covers the shape this file names:
 *
 *   Walk 100 000 objects in an external system. It takes an hour. It must survive a
 *   worker eviction, a deploy and a transient upstream failure by CONTINUING WHERE IT
 *   STOPPED. Only one walk per source may run at a time, and asking for a second while
 *   one is in flight must join the first. When it ends the outcome has to be legible.
 *
 * ## The model, in four words: run, pass, step, cursor
 *
 * A **run** is the durable record — one `_substrat_job_runs` row, in the scope, with
 * its status, its resume cursor, a counter bag, its start/end and its last error. It
 * is what an operator reads afterwards, and it is the thing coalescing joins.
 *
 * A **pass** is one invocation of the job's handler. A pass does a BOUNDED chunk of
 * the walk and hands a cursor forward; the next pass resumes from it. That is the
 * whole of resume at the outer level, and it is why a 100 000-object walk is not a
 * single hour-long call anybody has to keep alive.
 *
 * A **step** is a named unit inside a pass. Its result is committed as it completes,
 * so a step that already succeeded is NOT re-run — not on a retry of the step after
 * it, and not after the process was killed mid-pass. That is resume at the inner
 * level, and it is what "no step before it repeated" means.
 *
 * A **cursor** is whatever the handler says the next pass should resume from — an id,
 * a page token, an offset. Opaque to the driver, stored as JSON, held to the payload
 * rule below because it has to survive the same trip.
 *
 * **The step ledger is per PASS, and that is deliberate.** When a pass commits, its
 * step rows are dropped: the next pass is new work, named by the new cursor, and a
 * ledger that accumulated across an hour-long walk would be the unbounded table this
 * design exists to avoid. The cursor carries progress BETWEEN passes; the ledger
 * carries it WITHIN one.
 *
 * ## The determinism rule, and the half of it that is mechanical
 *
 * Step names must be a pure function of the payload and prior results. If a name
 * varies between passes — a timestamp in it, a random suffix — the memo never hits,
 * every resume replays work that already happened, and resume is a lie told in a
 * green test. That rule cannot be fully checked from here; what CAN be checked is
 * the sharpest way to break it, and is: two `step()` calls under ONE name in ONE
 * pass are refused (`JOB_STEP_REUSED`), because the second would read the first's
 * memo and silently skip its own work.
 *
 * ## Coalescing is the DRIVER's, never a unique index
 *
 * One run in flight per `(module, job, instance)`. `startJobRun` looks for a live row
 * and RETURNS it rather than inserting a second. It is not a `UNIQUE` constraint, and
 * that is the point: a run whose process was killed is still `running`, and it must be
 * restartable — a uniqueness constraint would be "one row ever", which would refuse
 * the re-import that has to happen next year as loudly as it refuses the duplicate.
 * `_substrat_sweep_runs` is a RECEIPT and carries such a constraint; a cursor is not a
 * receipt, and the two must not be re-merged (#1571, #1572).
 *
 * ## One pass per run at a time — a lease (#2034)
 *
 * Coalescing stops duplicate RUNS. What stops two drives overlapping on one scope from
 * running the same run's handler together is the CLAIM: before a pass is invoked, one
 * compare-and-set (`JOB_RUN_CLAIM_SQL`) checks that the run is still `running` and due
 * and, in the same statement, writes a lease — a `lease_owner` minted for that one pass,
 * and `next_attempt_at` pushed out to the lease's expiry. Both adapters serialize a
 * scope's writes (the DO's input gate, the pure host's turn queue), so exactly one
 * claim can win; the loser's statement finds the run no longer due and changes nothing.
 * The lease's expiry IS `next_attempt_at`, deliberately: a leased run is simply not
 * due, so the due read, its index and its `JOB_RUN_DUE_AT` order need nothing new.
 *
 * **One clock: the store's** (#2042 r4). Every lease time — the claim's due test and
 * expiry, the BEGIN test, each renewal — is computed by the STORE as its statement runs
 * (the DO's clock, the pure host's injected one), never by the drive. The drive only
 * measures how long it has itself been waiting, on its own monotonic clock, from just
 * before it sent the claim: the time left on its lease is `leaseMs` minus that, which
 * counts the whole round trip and so can only err short. A skew between the drive's
 * clock and the store's cannot move a lease either way.
 *
 * ## The commitment point: BEGIN
 *
 * A claim does not yet run anything. The drive first checks its lease still has more
 * than `JOB_LEASE_ENTRY_MARGIN` of it left, then BEGINS the pass with a second
 * compare-and-set (`JOB_RUN_BEGIN_SQL`): it holds only while the claim still owns the
 * lease with more than the margin left by the store's clock, and it stamps
 * `lease_began_at`. **The drive invokes the handler if and only if BEGIN wrote — and it
 * does not second-guess BEGIN's reply.** BEGIN is the commitment: from that write on,
 * the pass counts as having begun, whether or not its handler gets far.
 *
 * Why no check after BEGIN, and why no further write could replace one: whatever the
 * drive does after an acknowledged write, the acknowledgement can arrive late. A check
 * on BEGIN's reply that declined to invoke would leave a durable stamp for a pass that
 * never ran — and a takeover would charge it, failing a `maxAttempts: 1` run with no
 * invocation at all. Recording "the handler really started" in another write only moves
 * the same race onto THAT write's reply. Some last write has to be the point the drive
 * acts on unconditionally; it is BEGIN.
 *
 * **What that leaves, by construction, is at-least-once:** if BEGIN's reply takes longer
 * than the lease it left — more than the margin, a quarter of the lease, minutes at the
 * default — the lease can expire before the handler starts, another drive can take the
 * run over, and both run until the stale pass reaches a step boundary or its outcome,
 * where it learns and stops. The same holds for a pass that spends longer than the lease
 * between two steps. Like a step body (see `JobPassContext.step`), that stretch is
 * at-least-once, and the job's `leaseMs` is what keeps it from happening.
 *
 * Everything the pass writes after BEGIN — a step's ledger row, the outcome patch, the
 * commit — is conditional on still holding the lease, so a holder that lost it changes
 * nothing. Each step boundary RENEWS the lease (by the store's clock), so a pass longer
 * than one lease is not taken over while it is still making progress.
 *
 * **A lease that expires without a patch is recovered.** The run is due again at the
 * expiry, and the next claim takes it over. A takeover charges an attempt if and only if
 * the lease had BEGUN (`lease_began_at`): that pass started and never reported — a crash
 * between BEGIN and the handler included, which nothing can tell from a crash inside it —
 * so `attempts` stays honest and a pass that keeps dying exhausts the job's policy and
 * ends `failed` rather than looping forever. A claim that never began ran nothing, and
 * costs nothing. The expiry has to outlast the longest stretch a pass spends between two
 * steps, which is the job's own number: `registerJob`'s `leaseMs`, default `JOB_LEASE_MS`.
 *
 * ## Admission misses
 *
 * A claim that does not BEGIN — its reply came back with too little of the lease left, or
 * BEGIN refused — is an ADMISSION MISS. No handler ran, so no attempt is charged; but the
 * run counts CONSECUTIVE misses (`admission_misses`, cleared only by BEGIN), and ONE
 * conditional store transaction (`JOB_RUN_MISS_SQL`) releases the lease, adds the miss to
 * the count it finds, and sets the run's backoff (`admissionBackoffMs`) or, at
 * `JOB_ADMISSION_MISS_MAX`, fails it with `JOB_LEASE_TOO_SHORT_NOTE`. The drive reports
 * and logs a warning naming the job, its `leaseMs` and the delay it saw. No outcome patch
 * ever writes the count, so no write built from an older snapshot can overwrite it.
 *
 * ## What this is NOT
 *
 * Not a workflow engine: no branching, no fan-out, no BPMN, no timers between steps.
 * A linear, resumable, coalesced sequence of steps with a cursor — the smallest thing
 * that makes an hour-long import survivable. A use case that needs branching is a
 * different issue and probably a different answer.
 */

/**
 * The run table and its step ledger, as both adapters build them.
 *
 * Shared rather than spelled twice for the reason `IDEMPOTENCY_DDL` and
 * `SCHEDULE_STATE_DDL` are: `lint:spine-ddl` compares what each adapter's
 * `KERNEL_DDL` executes, and one definition is what keeps the self-hosted store
 * and the hosted store the same shape rather than merely the same intention.
 * Spine — kernel-written, `_substrat_*`, never a module migration.
 */
export const JOB_RUN_DDL = `
  CREATE TABLE IF NOT EXISTS _substrat_job_runs (
    id TEXT PRIMARY KEY,
    -- The coalescing key: one LIVE run per (module_id, job, instance). Not a UNIQUE
    -- index, deliberately -- see this file's header. instance names WHAT is being
    -- walked (a source id, a mapping version); a job with one walk per scope uses
    -- the 'default' the input schema fills in.
    module_id TEXT NOT NULL,
    job TEXT NOT NULL,
    instance TEXT NOT NULL,
    -- What start() was handed, as JSON. Held to the queue-safety rule
    -- (assertQueueSafe): ids and configuration, never bytes, class instances or
    -- functions, because this value has to survive a queue message unchanged.
    payload TEXT NOT NULL,
    -- Declared subject for erasing external output without guessing from its text.
    subject_id TEXT,
    -- 'running' | 'done' | 'failed'. A killed run stays 'running' and is picked up
    -- again by the next drive -- which is exactly what makes it restartable.
    status TEXT NOT NULL,
    -- What the last COMMITTED pass handed forward, as JSON. NULL = no pass has
    -- committed yet, which is a fact ('start from the beginning'), not missing data.
    cursor TEXT,
    -- The run's counter bag (JSON object of numbers), merged on each commit. An
    -- uncommitted pass's counts are discarded with the rest of the pass.
    counters TEXT NOT NULL DEFAULT '{}',
    -- CONSECUTIVE failed passes. Reset to 0 whenever a pass commits, so this reads
    -- as "how stuck is it now", not "how much work has it done".
    attempts INTEGER NOT NULL DEFAULT 0,
    -- The error the last failed pass left. Retained after the run goes 'failed' --
    -- the record is the evidence, so it must still say why.
    last_error TEXT,
    started_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    -- When the next pass may run, on the executor's own backoff curve. NULL = now
    -- (or terminal), which is why the due read tests IS NULL as well as <= now. While
    -- a pass holds the run (lease_owner set) it is the lease's expiry (#2034).
    next_attempt_at TEXT,
    -- When the run reached 'done' or 'failed'. NULL while it is still running.
    ended_at TEXT,
    -- #2034: the pass holding the run, minted per claim; NULL = nobody. Every write a
    -- pass makes is conditional on it, and the pass's outcome clears it.
    lease_owner TEXT,
    -- #2034 (#2042 r2, r4): when the holder BEGAN its pass (JOB_RUN_BEGIN_SQL), the point
    -- after which its handler runs; NULL = it has not, and a claim that never began is
    -- taken over without costing an attempt.
    lease_began_at TEXT,
    -- #2042 r3: CONSECUTIVE claims that did not begin their pass (their answer came back
    -- with too little of the lease left). NULL = none; cleared by BEGIN, written only by
    -- JOB_RUN_MISS_SQL. Not attempts: no handler ran. At JOB_ADMISSION_MISS_MAX the run
    -- fails, its lease too short for where it runs.
    admission_misses INTEGER
  );
  -- The drive's read: WHERE status = 'running' AND (next_attempt_at IS NULL OR <= ?)
  -- ORDER BY id. Leading with status makes the live runs a seekable range over a
  -- table that RETAINS every finished run, so the cost tracks how much is in flight
  -- rather than how much the scope has ever imported.
  CREATE INDEX IF NOT EXISTS _substrat_job_runs_due ON _substrat_job_runs (status, next_attempt_at, id);
  -- #1834: the drive's ORDER -- by when each run became due (JOB_RUN_DUE_AT), then id -- so a run
  -- that waited (a deferral, a backoff) queues behind work that was due before it, instead of
  -- heading every drive by its age. The expression is spelled exactly as the query spells it.
  CREATE INDEX IF NOT EXISTS _substrat_job_runs_due_at ON _substrat_job_runs (status, COALESCE(next_attempt_at, started_at), id);
  -- Coalescing's read, and the operator read's filter.
  CREATE INDEX IF NOT EXISTS _substrat_job_runs_key ON _substrat_job_runs (module_id, job, instance, id);
  -- The step ledger of the pass currently in flight. Rows are written as each step
  -- COMPLETES and dropped when the pass COMMITS, so this holds one pass's worth of
  -- steps and never grows with the length of the walk.
  --
  -- A FAILED run keeps its last pass's rows, deliberately: they are the difference
  -- between "it got nowhere" and "it got three quarters of the way and then the
  -- provider went down", which the run row's single last_error cannot say. Still
  -- bounded -- one pass's worth per failed run -- because a restart is a NEW run
  -- with a new id and therefore its own ledger.
  CREATE TABLE IF NOT EXISTS _substrat_job_steps (
    run_id TEXT NOT NULL,
    step TEXT NOT NULL,
    -- The step's return value as JSON. NOT NULL is what MEANS completed: a step that
    -- threw leaves the row with a NULL result and a raised attempts count, so the
    -- next pass runs it again rather than reading a success that never happened. A
    -- step returning nothing stores the JSON text 'null', which is not SQL NULL.
    result TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    recorded_at TEXT NOT NULL,
    PRIMARY KEY (run_id, step)
  );
`;

/**
 * The write every pass outcome lands through, on both adapters — a compare-and-set on
 * `status = 'running'` (#1632) and on the pass's lease (#2034), which it releases.
 *
 * A pass runs for as long as its handler takes, outside any lock, so a subject erasure
 * can settle the run `failed` and tombstone its payload, cursor and step memos while the
 * pass is still working. Patching by `id` alone let that stale pass write its cursor —
 * which may carry the person — and `running` straight back over the redaction. Nothing
 * legitimate is refused: `runJobPass` only ever drives a run it read as `running`, and
 * nothing else in the kernel moves a run out of that state except the pass itself and
 * the erasure. Same shape, same reason, as `settlePlatformRequest`'s CAS on `pending`.
 *
 * The lease half: a pass whose lease another drive took over after it expired is no
 * longer the run's, and its outcome — written over the new holder's work — is refused.
 * `IS ?`, not `= ?`, so a caller passing NULL (a coordinator from before leases) still
 * patches the unleased rows it drives.
 *
 * It never writes `admission_misses` (#2042 r4): only BEGIN clears it and only
 * `JOB_RUN_MISS_SQL` adds to it.
 *
 * Params: status, cursor, counters, attempts, last_error, updated_at, next_attempt_at,
 * ended_at, id, lease_owner.
 */
export const JOB_RUN_PATCH_SQL = `UPDATE _substrat_job_runs
     SET status = ?, cursor = ?, counters = ?, attempts = ?, last_error = ?,
         updated_at = ?, next_attempt_at = ?, ended_at = ?,
         lease_owner = NULL, lease_began_at = NULL
   WHERE id = ? AND status = 'running' AND lease_owner IS ?`;

/**
 * #2034: the claim — the ONE statement that decides which drive runs a due run's pass.
 *
 * Succeeds (one row changed) only where the run is still `running` and due, so of two
 * drives that both picked it, one wins and the other changes nothing. The winner's
 * lease is written in the same statement: `lease_owner`, and `next_attempt_at` pushed
 * out to the lease's expiry, which is what takes the run out of the due read. Both the
 * due test and the expiry are the STORE's time as it runs (#2042 r4): the adapter binds
 * its own clock's now, never the drive's.
 *
 * A run due while it still carries a BEGUN lease (`lease_began_at`) is a pass that
 * started and never reported, and taking it over counts that pass as failed: `attempts`
 * + 1 and the note as `last_error`. A lease whose claim never began ran nothing and is
 * taken over for free. SQLite evaluates every `SET` against the row as it was, so the
 * `CASE`s read the previous lease.
 *
 * Returns the claimed row, as the claim left it (`RETURNING *`); no row = the claim lost.
 *
 * Params: lease_owner, next_attempt_at (store now + leaseMs), updated_at (store now),
 * last_error (the takeover note), id, store now.
 */
export const JOB_RUN_CLAIM_SQL = `UPDATE _substrat_job_runs
     SET lease_owner = ?, next_attempt_at = ?, updated_at = ?, lease_began_at = NULL,
         attempts = attempts + CASE WHEN lease_began_at IS NULL THEN 0 ELSE 1 END,
         last_error = CASE WHEN lease_began_at IS NULL THEN last_error ELSE ? END
   WHERE id = ? AND status = 'running' AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
   RETURNING *`;

/**
 * #2034 (#2042 r4): BEGIN a claimed pass — the commitment point (see the file header). A
 * compare-and-set in the store's clock: it stamps `lease_began_at` and clears
 * `admission_misses` only while `lease_owner` is still this claim's and the lease runs
 * past the store's now plus the margin. The drive invokes the handler if and only if this
 * wrote, and does not second-guess its reply.
 *
 * Params: lease_began_at (store now), id, lease_owner, store now + margin.
 */
export const JOB_RUN_BEGIN_SQL = `UPDATE _substrat_job_runs SET lease_began_at = ?, admission_misses = NULL
   WHERE id = ? AND status = 'running' AND lease_owner IS ? AND next_attempt_at > ?`;

/**
 * #2042 r3, r4: an ADMISSION MISS, first statement — release a claim that did not begin and add
 * one to the count it finds (`COALESCE(admission_misses, 0) + 1`), never writing a count read
 * earlier. Only while `owner` still holds the run and has not begun. Returns the new count.
 * Both adapters run it and `JOB_RUN_MISS_SETTLE_SQL` in ONE transaction.
 *
 * Params: updated_at (store now), id, lease_owner.
 */
export const JOB_RUN_MISS_SQL = `UPDATE _substrat_job_runs
     SET admission_misses = COALESCE(admission_misses, 0) + 1, updated_at = ?,
         lease_owner = NULL, lease_began_at = NULL
   WHERE id = ? AND status = 'running' AND lease_owner IS ? AND lease_began_at IS NULL
   RETURNING admission_misses`;

/**
 * #2042 r3, r4: an ADMISSION MISS, second statement, in the same transaction — the backoff or the
 * failure that the NEW count calls for (`admissionMissOutcome`). Conditional on that count still
 * being on the row, unleased.
 *
 * Params: status, next_attempt_at, ended_at, last_error (NULL keeps it), id, admission_misses.
 */
export const JOB_RUN_MISS_SETTLE_SQL = `UPDATE _substrat_job_runs
     SET status = ?, next_attempt_at = ?, ended_at = ?, last_error = COALESCE(?, last_error)
   WHERE id = ? AND status = 'running' AND lease_owner IS NULL AND admission_misses = ?`;

/**
 * #2042 r3: what a run's `misses`-th consecutive admission miss does to it, at the store's `now`:
 * a backoff (`admissionBackoffMs`), or at `JOB_ADMISSION_MISS_MAX` a failure carrying `note`.
 * The params of `JOB_RUN_MISS_SETTLE_SQL` before its id; shared so the adapters cannot differ.
 */
export function admissionMissOutcome(
  misses: number,
  now: string,
  note: string,
): { status: 'running' | 'failed'; nextAttemptAt: string | null; endedAt: string | null; lastError: string | null } {
  return misses >= JOB_ADMISSION_MISS_MAX
    ? { status: 'failed', nextAttemptAt: null, endedAt: now, lastError: `${JOB_LEASE_TOO_SHORT_NOTE}: ${note}` }
    : { status: 'running', nextAttemptAt: new Date(Date.parse(now) + admissionBackoffMs(misses)).toISOString(), endedAt: null, lastError: null };
}

/**
 * #2034: renew a pass's lease at a step boundary — only while the pass still holds it, to the
 * store's now plus the lease (#2042 r4: the store's clock, as everywhere a lease is timed).
 * One row changed = still held, and the lease now runs to the new expiry; none = the
 * pass lost the run (taken over, or settled by an erasure) and must stop.
 *
 * Params: next_attempt_at (the new expiry), id, lease_owner.
 */
export const JOB_RUN_RENEW_SQL = `UPDATE _substrat_job_runs SET next_attempt_at = ?
   WHERE id = ? AND status = 'running' AND lease_owner IS ?`;

/**
 * Record one step attempt — only while its run is still `running` (#1632) and the pass
 * still holds its lease (#2034). Both adapters run it after `JOB_RUN_RENEW_SQL`, in one
 * transaction, and only when the renewal held.
 *
 * The step half of `JOB_RUN_PATCH_SQL`'s CAS: a stale pass's step, finishing after an
 * erasure settled the run, would otherwise write a fresh result carrying the person
 * into the ledger the erasure just emptied. `INSERT … SELECT … WHERE` rather than
 * `VALUES` so the guard and the write are one statement; the `WHERE` also resolves
 * SQLite's parse ambiguity between a SELECT's trailing clause and `ON CONFLICT`.
 *
 * Params: run_id, step, result, attempts, last_error, recorded_at, run_id, lease_owner.
 */
export const JOB_STEP_RECORD_SQL = `INSERT INTO _substrat_job_steps (run_id, step, result, attempts, last_error, recorded_at)
     SELECT ?, ?, ?, ?, ?, ?
      WHERE EXISTS (SELECT 1 FROM _substrat_job_runs WHERE id = ? AND status = 'running' AND lease_owner IS ?)
   ON CONFLICT (run_id, step) DO UPDATE SET result = excluded.result,
                                            attempts = excluded.attempts,
                                            last_error = excluded.last_error,
                                            recorded_at = excluded.recorded_at`;

/** Where a run is. A killed run is `running` — that is what makes it resumable. */
export type JobRunStatus = 'running' | 'done' | 'failed';

/** The coalescing key: one LIVE run per triple. */
export interface JobRunKey {
  moduleId: ModuleId;
  /** The job's name, as `registerJob` declared it. */
  job: string;
  /** What is being walked — a source id, a mapping version. `'default'` when there is one. */
  instance: string;
}

/** The durable run record, as an operator reads it. */
export interface JobRun extends JobRunKey {
  id: string;
  status: JobRunStatus;
  /** What `startJobRun` was handed. */
  payload: unknown;
  /** Declared data subject; null on unclassified or legacy runs. */
  subject: DataSubjectId | null;
  /** What the last COMMITTED pass handed forward; null before the first commit. */
  cursor: unknown;
  counters: Record<string, number>;
  /** Consecutive failed passes; 0 after any commit. */
  attempts: number;
  lastError: string | null;
  startedAt: string;
  updatedAt: string;
  /** While `leaseOwner` is set, when that lease expires and the run is due again. */
  nextAttemptAt: string | null;
  endedAt: string | null;
  /** #2034: the pass holding the run right now, or null. Opaque; minted per claim. */
  leaseOwner: string | null;
  /**
   * #2042 r3: consecutive claims that did not begin their pass in time — 0 once one does. Not
   * attempts: no handler ran. A run that keeps missing fails with `JOB_LEASE_TOO_SHORT_NOTE`.
   */
  admissionMisses: number;
  /**
   * Why this row could not be read whole, or null — which is the ordinary case and
   * what every run written by this driver carries.
   *
   * Present because the read and the DRIVER want opposite things from a malformed
   * row, and both are right. A pass cannot run on a payload it cannot decode, so the
   * driver fails the run and records why. The READ exists so an operator can see
   * exactly that — and a read that threw on the one row being investigated would
   * take every other run on the scope with it, since this returns a list. So the
   * decode here is tolerant and SAYS SO: the undecodable columns come back empty
   * (`null` / `{}`) with the parse error named here, rather than a silent `null`
   * that reads as "no cursor".
   *
   * Reachable without any forge: `importDump` replays a dump's rows verbatim, so a
   * dump from another world or edited by hand is enough.
   */
  decodeError: string | null;
}

/** What `startJobRun` is handed. */
export interface StartJobRunInput {
  moduleId: ModuleId;
  job: string;
  /** Defaults to `'default'` — a job with one walk per scope needs no instance. */
  instance?: string;
  /** Ids and configuration. Refused at this boundary if it is anything else. */
  payload?: unknown;
  /** Subject whose data this run handles. Erasure redacts the entire run and its steps. */
  subject?: DataSubjectId;
}

/** The operator read's filter. Every field narrows; none is required. */
export interface JobRunFilter {
  moduleId?: ModuleId;
  job?: string;
  instance?: string;
  status?: JobRunStatus;
  /** Default `JOB_RUN_LIST_LIMIT`. */
  limit?: number;
}

/** Rows one `jobRuns` read returns by default. */
export const JOB_RUN_LIST_LIMIT = 50;

/** The most rows one `jobRuns` read will ever return, whatever the caller asks for. */
export const JOB_RUN_LIST_MAX = 500;

/**
 * The row budget for one operator read, normalised before it reaches SQL.
 *
 * `JobRunFilter.limit` comes from a caller and was bound straight to `LIMIT`, where
 * SQLite reads a NEGATIVE value as unbounded, refuses a fractional one outright, and
 * honours an oversized one. Since finished runs are retained, "unbounded" means the
 * scope's entire history in one response — a read whose cost grows with retention,
 * reachable by passing `-1`. Clamped here rather than in each adapter so the pure and
 * the hosted read cannot answer the same filter differently.
 */
export function jobRunListLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return JOB_RUN_LIST_LIMIT;
  return Math.min(JOB_RUN_LIST_MAX, Math.max(1, Math.floor(limit)));
}

/**
 * #2034: how long a pass's lease lasts by default — from its claim, and again from each
 * step boundary, which renews it. A job whose pass can spend longer than this between
 * two steps registers its own `leaseMs`; otherwise its run is taken over while still
 * working. Fifteen minutes is the longest a hosted alarm or cron invocation runs, so a
 * hosted pass that has gone longer without a step has been stopped anyway.
 */
export const JOB_LEASE_MS = 15 * 60_000;

/** #2034: the shortest `leaseMs` a job may register — below it, the BEGIN margin is noise. */
export const JOB_LEASE_MIN_MS = 100;

/**
 * #2034: the share of its lease a claim must still have left to BEGIN its pass — by the drive's own
 * count when the claim's reply arrives, and by the store's clock as BEGIN runs. Time spent between
 * the claim's write and its reply — a slow round trip, a paused isolate — is time another drive can
 * spend taking the run over once the lease has expired. It is also the bound on the at-least-once
 * window: a double run needs BEGIN's reply to take longer than this share of the lease.
 */
export const JOB_LEASE_ENTRY_MARGIN = 0.25;

/**
 * #2042 r3: consecutive admission misses after which a run fails rather than being claimed again.
 * A claim that does not begin in time costs no attempt, so without a bound a run whose lease is too
 * short for where it runs would be claimed, missed and released forever, with nothing reporting it.
 */
export const JOB_ADMISSION_MISS_MAX = 10;

/** #2042 r3: the wait after a first admission miss; it doubles per miss, up to `JOB_ADMISSION_BACKOFF_MAX_MS`. */
export const JOB_ADMISSION_BACKOFF_BASE_MS = 1_000;

/** #2042 r3: the longest wait between two admission attempts. */
export const JOB_ADMISSION_BACKOFF_MAX_MS = 5 * 60_000;

/** #2042 r3: how long a run waits after its `misses`-th consecutive admission miss. */
export function admissionBackoffMs(misses: number): number {
  return Math.min(JOB_ADMISSION_BACKOFF_MAX_MS, JOB_ADMISSION_BACKOFF_BASE_MS * 2 ** Math.max(0, misses - 1));
}

/** #2042 r3: the start of `last_error` on a run failed for missing its admission `JOB_ADMISSION_MISS_MAX` times. */
export const JOB_LEASE_TOO_SHORT_NOTE = 'lease too short for this environment';

/** #2034: `last_error` of a run whose expired lease a later claim took over. */
export const JOB_LEASE_EXPIRED_NOTE =
  'interrupted: the pass holding this run stopped reporting, and its lease expired';

/** #2034: a job's `leaseMs`, refused at registration unless it is an integer of at least `JOB_LEASE_MIN_MS`. */
export function assertLeaseMs(leaseMs: number | undefined): void {
  if (leaseMs === undefined) return;
  if (!Number.isSafeInteger(leaseMs) || leaseMs < JOB_LEASE_MIN_MS) {
    throw substratError(
      'validation_failed',
      `leaseMs must be an integer of at least ${JOB_LEASE_MIN_MS} milliseconds, got ${String(leaseMs)}`,
      { errors: [{ path: 'leaseMs', message: `must be an integer of at least ${JOB_LEASE_MIN_MS}` }] },
    );
  }
}

/** Runs one `runDueJobs` call picks up by default. */
export const JOB_DRIVE_LIMIT = 50;

/**
 * Rows one `runDueJobs` call will READ while looking for runnable ones.
 *
 * The drive skips runs whose job this host does not register, so "read `limit` rows"
 * and "find `limit` runs to drive" are different numbers, and a scope can hold an
 * arbitrary number of the unrunnable kind. This caps the difference: past it the call
 * drives what it found and returns, rather than scanning a scope's whole history on a
 * maintenance tick.
 */
export const JOB_DRIVE_SCAN_MAX = 500;

/** What a handler says at the end of a pass. */
export interface JobPassResult {
  /**
   * What the NEXT pass resumes from. Omitted keeps the cursor the last pass
   * committed — which is how a pass that only did steps, and moved nothing on,
   * says so. Held to the same queue-safety rule as the payload.
   */
  cursor?: unknown;
  /** True when the walk is finished: the run goes `done` and is never driven again. */
  done?: boolean;
}

/** What one pass of a job is given. */
export interface JobPassContext {
  /** This run's id and coalescing key. */
  readonly run: JobRunKey & { id: string };
  /** What `startJobRun` was handed, decoded. */
  readonly payload: unknown;
  /** What the last committed pass handed forward; `null` on the first pass. */
  readonly cursor: unknown;
  /** The counter bag as of the last commit. `count()` adds to the pass's copy. */
  readonly counters: Readonly<Record<string, number>>;
  /**
   * Run one NAMED step, at most once per run-pass.
   *
   * A step whose result is already committed returns it WITHOUT running `fn` —
   * that is the memo, and it is what survives both a retry of a later step and a
   * process kill mid-pass. A step that throws records its attempt and fails the
   * pass; the next pass replays the handler, skips every committed step above,
   * and runs this one again until its own `retry` is exhausted.
   *
   * `name` must be a pure function of the payload and prior results. Two calls
   * under one name in one pass are refused rather than silently memo-aliased.
   *
   * **AT-LEAST-ONCE. `fn` must be idempotent, and this is not a formality.** The
   * ledger row is written AFTER `fn` resolves, which is the only ordering that is
   * safe — claiming the step first would make it at-most-once and lose the effect on
   * any crash in between. The cost is the opposite window: a stop after `fn`'s effect
   * lands and before `recordStep` commits leaves no memo, so the next pass runs that
   * effect a second time. It is the same trade, made the same way and for the same
   * reason, as `recordExecutorDelivery` in the executor journal — whose docblock says
   * it plainly — and like an executor handler, a step body absorbs the residue.
   *
   * `value` is round-tripped through its stored JSON before being returned, so what a
   * handler sees is identical whether the step just ran or was replayed from the memo.
   */
  step<T>(name: string, fn: () => T | Promise<T>, retry?: ExecutorRetryPolicy): Promise<T>;
  /** Add to a counter. Committed with the pass; discarded if the pass fails. */
  count(name: string, by?: number): void;
  /**
   * The scope, through the SYSTEM door — the same `getSystemScope` a declared
   * schedule invokes through, so a job's writes are attributed `{ system: moduleId }`
   * and gated by an ordinary `ctx.check` against `system:<moduleId>` grants. Opened
   * on first call, then reused for the rest of the pass.
   */
  scope(): Promise<ScopeStub>;
}

/**
 * A job's body: one pass, given where the last one stopped.
 *
 * HOST code, never module code — a walk of an external system holds credentials and
 * makes network calls, which is exactly what module code may not do. It reaches the
 * scope the way a schedule does, through `pass.scope()`.
 */
export type JobHandler = (pass: JobPassContext) => JobPassResult | void | Promise<JobPassResult | void>;

/** A job as `registerJob` recorded it: its handler, its default step policy and its lease (#2034). */
export interface JobRegistration {
  readonly handler: JobHandler;
  readonly retry?: ExecutorRetryPolicy;
  /** Default `JOB_LEASE_MS`. */
  readonly leaseMs?: number;
}

/** What `runDueJobs` did in one call. */
export interface JobDriveReport {
  /** Runs this call picked up — due, and `running`. */
  attempted: number;
  /** Passes that COMMITTED with the run still going. With `maxPasses > 1`, more than one per run. */
  advanced: number;
  /** Runs that reported `done` this call. */
  completed: number;
  /** Passes that failed with retries left — the run stays `running`, due after its backoff. */
  retrying: number;
  /** Runs whose step exhausted its retries this call. Terminal: `failed`, with the error on the record. */
  failed: number;
  /**
   * #2034: passes whose outcome was refused because the run was no longer theirs — their
   * lease expired and another drive took the run over, or it was settled meanwhile (an
   * erasure) — and claims whose answer came back with too little of the lease left to start
   * a pass safely (`JOB_LEASE_ENTRY_MARGIN`), which ran nothing. Nothing the pass produced was
   * written; whoever holds the run reports it.
   */
  superseded: number;
  /**
   * Runs whose pass the host's system door told to wait (#1834): no attempt was counted and no error
   * recorded, as a switched-off schedule is `skipped` without its cadence moving. The run is due
   * again after `JOB_DEFER_MS`, so a run that keeps waiting never takes the turn of one behind it.
   */
  deferred: number;
  /** Per-run failures, the same shape `ScheduleRunReport.errors` has: what failed and why. */
  errors: { runId: string; error: string }[];
  /**
   * #2042 r3: what the drive saw but did not count as a failure — a claim that did not begin its
   * pass in time, with the job's lease and the delay observed. Also logged as a structured line.
   */
  warnings: { runId: string; warning: string }[];
}

/** The `_substrat_job_runs` row, as both adapters' SQL returns it. */
export interface JobRunRow {
  readonly id: string;
  readonly module_id: string;
  readonly job: string;
  readonly instance: string;
  readonly payload: string;
  /** Optional only for an older scope DO answering before the subject migration. */
  readonly subject_id?: string | null;
  readonly status: string;
  readonly cursor: string | null;
  readonly counters: string;
  readonly attempts: number;
  readonly last_error: string | null;
  readonly started_at: string;
  readonly updated_at: string;
  readonly next_attempt_at: string | null;
  readonly ended_at: string | null;
  /** #2034. Optional only for an older scope DO answering before the lease column. */
  readonly lease_owner?: string | null;
  /** #2034 (#2042 r2, r4): when the holder BEGAN its pass. Optional for the same reason. */
  readonly lease_began_at?: string | null;
  /** #2042 r3: consecutive claims that did not begin. Optional for the same reason. */
  readonly admission_misses?: number | null;
}

/**
 * #2034: a won claim — the run as the claim left it, and whether it took over an expired lease
 * whose pass had BEGUN (which the claim charged as a failed attempt).
 */
export interface JobRunClaim {
  readonly run: JobRunRow;
  readonly takeover: boolean;
}

/** #1834: what a drive's snapshot holds of one due run — enough to pick it, never to act on it. */
export interface JobDueKey {
  readonly id: string;
  readonly module_id: string;
  readonly job: string;
}

/** The `_substrat_job_steps` row, as both adapters' SQL returns it. */
export interface JobStepRow {
  readonly step: string;
  readonly result: string | null;
  readonly attempts: number;
  readonly last_error: string | null;
}

/** Everything a pass writes onto the run row, in one statement — never a partial update. */
export interface JobRunPatch {
  readonly status: JobRunStatus;
  readonly cursor: string | null;
  readonly counters: string;
  readonly attempts: number;
  readonly lastError: string | null;
  readonly updatedAt: string;
  readonly nextAttemptAt: string | null;
  readonly endedAt: string | null;
}

/**
 * The storage the driver runs against — the ONE thing each adapter supplies.
 *
 * D-14's two drivers are two implementations of this and nothing else: the pure
 * adapter's is direct SQL on the scope db, the hosted adapter's is RPC to the scope
 * DO. Every decision — what coalescing means, when a step is skipped, when a run
 * fails — lives in the functions below, so the two drivers cannot disagree about
 * any of it. What they may legitimately differ on is only how a row is read.
 *
 * **Each step commits on its own round trip**, and that is not an accident of the
 * port's shape. Batching a pass's steps into one write at the end would lose exactly
 * the work a mid-pass kill is supposed to keep.
 */
export interface JobRunStore {
  /**
   * The coalescing decision itself, as ONE operation: return the live (`running`)
   * run for `row`'s key if there is one, otherwise insert `row` and return it.
   *
   * **Atomic, and it has to be.** Split into a lookup and an insert — which is how
   * this was first written — two concurrent starts both see no live row and both
   * insert, and the schema deliberately carries no constraint that could reject the
   * second. The result is two runs walking one source: exactly what "a start against
   * a live key joins it" promises not to happen, defeated by the promise's own
   * mechanism. Nothing underneath made it safe: no unique index (by design), no
   * transaction, and neither the pure host's actor queue nor a single DO RPC wrapped
   * the pair.
   *
   * It is the port's job rather than the kernel's because atomicity is the one thing
   * only the adapter can supply — a transaction on the pure side, a single RPC on the
   * DO side, where the input gate makes one round trip indivisible.
   */
  startOrJoin(key: JobRunKey, row: JobRunRow): Promise<JobRunRow>;
  /**
   * #1834: ONE snapshot of the keys of up to `max` `running` runs whose `next_attempt_at` has passed
   * (or is NULL), in the order they became due (`JOB_RUN_DUE_AT`, then id), read in ONE query.
   *
   * Keys, not rows: the driver CLAIMS each one (`claim`) just before it runs it, so what it acts on
   * is the row as the claim left it, never the snapshot. And one read, not pages: a cursor across
   * separate reads met rows that a concurrent drive moved in between, and a drive then saw a run
   * twice, or never.
   */
  dueKeys(now: string, max: number): Promise<JobDueKey[]>;
  /**
   * #2034: claim run `id` for one pass — `JOB_RUN_CLAIM_SQL`, which returns the row as it left it —
   * or null when the run is no longer `running` and due (another drive holds it, or it moved).
   *
   * The due test and the expiry (`leaseMs` on) are the STORE's now as the statement runs (#2042
   * r4), never a time the drive computed. ONE operation, for the reason `startOrJoin` is one:
   * `takeover` is whether the row carried a BEGUN lease before the claim, which only a read in
   * the same transaction can say.
   */
  claim(id: string, owner: string, leaseMs: number): Promise<JobRunClaim | null>;
  /**
   * #2034 (#2042 r4): BEGIN `owner`'s claimed pass (`JOB_RUN_BEGIN_SQL`) — the commitment point.
   * True only while it still holds the lease and the lease runs more than `marginMs` past the
   * store's now as the statement runs. The drive invokes its handler if and only if this is true.
   */
  begin(id: string, owner: string, marginMs: number): Promise<boolean>;
  /**
   * #2042 r3, r4: an admission miss — `JOB_RUN_MISS_SQL` then `JOB_RUN_MISS_SETTLE_SQL` with
   * `admissionMissOutcome`, in ONE transaction, at the store's now. Null = `owner` no longer held
   * the run (or had begun): nothing was written. Otherwise the new consecutive count, and
   * whether it failed the run.
   */
  miss(id: string, owner: string, note: string): Promise<{ misses: number; failed: boolean } | null>;
  list(filter: JobRunFilter): Promise<JobRunRow[]>;
  /** A pass outcome, only while `owner` holds the run (`JOB_RUN_PATCH_SQL`). False = refused. */
  patch(id: string, patch: JobRunPatch, owner: string): Promise<boolean>;
  /**
   * A COMMITTED pass: write the run's new state and drop its step ledger together,
   * indivisibly.
   *
   * Two statements, one operation, for the reason `startOrJoin` is one: a stop
   * between them leaves the advanced cursor beside the finished pass's memo rows,
   * and the next pass — which is entitled to reuse a step name, since the
   * determinism rule binds names to the payload and prior results, NOT to the
   * cursor — reads that stale memo and skips work it never did. The first cut of
   * this file ordered the two calls carefully and explained in a comment why the
   * gap was harmless. The comment was wrong; only atomicity makes it true.
   *
   * Only while `owner` holds the run, and the ledger is dropped only when the patch applied: a
   * stale holder's commit would otherwise empty the ledger of the pass that took the run over.
   * False = refused, and nothing was written.
   */
  commitPass(id: string, patch: JobRunPatch, owner: string): Promise<boolean>;
  /**
   * #2034: a step boundary — renew `owner`'s lease to the store's now plus `leaseMs`
   * (`JOB_RUN_RENEW_SQL`) and read the step's ledger row, in one operation. `held: false` = the
   * pass lost the run; `row` is then null and the pass must stop.
   */
  beginStep(runId: string, name: string, owner: string, leaseMs: number): Promise<{ held: boolean; row: JobStepRow | null }>;
  /**
   * Record one step attempt, renewing `owner`'s lease to the store's now plus `leaseMs` in the
   * same transaction — both only while `owner` holds the run. False = the pass lost it, and
   * nothing was written.
   */
  recordStep(
    runId: string,
    name: string,
    result: string | null,
    attempts: number,
    lastError: string | null,
    at: string,
    owner: string,
    leaseMs: number,
  ): Promise<boolean>;
}

/** `conflict` reason: two `step()` calls under one name in one pass. */
export const JOB_STEP_REUSED = 'job_step_reused';

/**
 * #1834: the reason a host's system door gives a refusal that means "not now", never "no": the
 * module is held off on this scope until its switch is applied again, or the scope kept restarting
 * under the door. It is for a caller READING the refusal. It decides nothing: anyone can throw an
 * error with this reason, so the job driver never defers on it (`deferral` below is how a host
 * says which refusals are its own).
 */
export const SYSTEM_DOOR_WAIT = 'system_door_wait';

/**
 * #1834: when a run became due — its `next_attempt_at`, or when it started if it has none — and the
 * key the drive orders by. Ordering by id instead let an older run that keeps waiting (a deferral, a
 * backoff) head every drive the moment it was due again, and take the turn of a run that had been
 * due for longer. Spelled exactly as the `_substrat_job_runs_due_at` index spells it.
 */
export const JOB_RUN_DUE_AT = 'COALESCE(next_attempt_at, started_at)';

/**
 * #1834: a pass that a host's door told to wait, carrying the pass it belongs to. Kernel-private,
 * and checked against the CURRENT pass, so a handler that catches one and throws it again on a
 * later pass is an ordinary failure there, not a wait.
 */
class PassDeferred extends Error {
  constructor(
    readonly pass: object,
    readonly cause: unknown,
  ) {
    super(message(cause));
  }
}

/**
 * #1834: how long a deferred run waits before it is due again. Not an attempt: nothing counts and
 * there is no backoff. It only stops a waiting run from heading the due order on every drive, where
 * it would take the turn of a run behind it that could make progress.
 */
export const JOB_DEFER_MS = 60_000;

/** Runtime globals the kernel's lib does not declare, reached as `invocation-log.ts` reaches them. */
declare const console: { log(message: string): void };
declare const performance: { now(): number };

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** What a value is, for the refusal message: `a Uint8Array`, `a function`, `a Date`. */
function describe(value: unknown): string {
  const t = typeof value;
  if (t === 'function') return 'a function';
  if (t === 'symbol') return 'a symbol';
  if (t === 'bigint') return 'a bigint';
  if (t === 'undefined') return 'undefined';
  if (t === 'number') return `${String(value)}`;
  const name = (value as { constructor?: { name?: string } })?.constructor?.name;
  return name ? `a ${name}` : 'a non-plain object';
}

/**
 * Refuse anything that cannot survive a queue message, naming the path.
 *
 * What may be handed to a run, and handed forward by one, is **ids and
 * configuration**: JSON's own values, nothing else. Bytes, class instances and
 * functions are refused — and so, less obviously, are `undefined` in a nested
 * position, a non-finite number and a cycle, because JSON turns each of those into
 * something else without saying so. A payload silently reshaped on its way to
 * storage is the failure this rule exists to prevent: the run resumes against a
 * value that is not the one it was started with, and nothing anywhere reports it.
 *
 * `validation_failed` with the offending path in `errors`, exactly as an operation's
 * own input failure arrives, so a transport renders it with no special case.
 *
 * Held against the payload at `start` and against the cursor at every commit —
 * the two values that cross the boundary and land on the record. NOT held against a
 * step's result, deliberately: that value is the handler's own, round-tripped to
 * itself on resume, and the common shape of a step done for its effect is to return
 * nothing at all — which this would refuse.
 */
export function assertQueueSafe(value: unknown, root: string): void {
  const open = new Set<object>();
  const reject = (path: string, what: string): never => {
    throw substratError(
      'validation_failed',
      `${root} is not queue-safe: ${path} is ${what} — a run carries ids and configuration, ` +
        'never bytes, class instances or functions',
      { errors: [{ path, message: `${what} cannot survive a queue message unchanged` }] },
    );
  };
  const walk = (v: unknown, path: string): void => {
    if (v === null) return;
    const t = typeof v;
    if (t === 'string' || t === 'boolean') return;
    if (t === 'number') {
      if (Number.isFinite(v)) return;
      reject(path, `${describe(v)}, which JSON stores as null`);
    }
    if (t !== 'object') reject(path, describe(v));
    const obj = v as object;
    if (open.has(obj)) reject(path, 'a cycle back to a value already on this path');
    open.add(obj);
    if (Array.isArray(obj)) {
      // BY INDEX, not `forEach`, and a HOLE is refused. `forEach` skips a sparse
      // slot entirely, so `new Array(3)` walked cleanly and then stored as
      // `[null,null,null]` — a value that passed the queue-safety check and changed
      // on its way to storage, which is the one thing this function exists to stop.
      for (let i = 0; i < obj.length; i += 1) {
        if (!(i in obj)) reject(`${path}.${i}`, 'a hole in a sparse array, which JSON stores as null');
        walk(obj[i], `${path}.${i}`);
      }
    } else {
      const proto = Object.getPrototypeOf(obj) as unknown;
      if (proto !== Object.prototype && proto !== null) reject(path, describe(obj));
      for (const [k, item] of Object.entries(obj)) walk(item, `${path}.${k}`);
    }
    open.delete(obj);
  };
  walk(value, root);
}

/**
 * A row, decoded into the record an operator reads — TOLERANTLY, and saying so.
 *
 * The status, the attempts, the timestamps and the `last_error` are columns and
 * always readable; only `payload`, `cursor` and `counters` are JSON, and a row whose
 * JSON will not parse still has to be visible. It comes back with those three empty
 * and `decodeError` naming the parse failure — never a bare `null` cursor, which a
 * reader would take for "no pass has committed yet".
 *
 * This is deliberately NOT what the driver does with the same row: a pass cannot run
 * on a payload it cannot decode, so `runJobPass` treats the parse failure as a failed
 * pass and lets the run retry and then fail with the reason on its record. Strict
 * where work happens, tolerant where evidence is read.
 */
export function jobRunOf(row: JobRunRow): JobRun {
  let decodeError: string | null = null;
  const parse = <T>(text: string | null, fallback: T): T => {
    if (text === null) return fallback;
    try {
      return JSON.parse(text) as T;
    } catch (err) {
      decodeError ??= message(err);
      return fallback;
    }
  };
  // Every field is decoded before the error is read, so `decodeError` reports the
  // FIRST failure of the row rather than whichever one happened to short-circuit.
  const payload = parse<unknown>(row.payload, null);
  const cursor = parse<unknown>(row.cursor, null);
  const counters = parse<Record<string, number>>(row.counters, {});
  return {
    id: row.id,
    moduleId: row.module_id as ModuleId,
    job: row.job,
    instance: row.instance,
    status: row.status as JobRunStatus,
    payload,
    subject: (row.subject_id ?? null) as DataSubjectId | null,
    cursor,
    counters,
    attempts: row.attempts,
    lastError: row.last_error,
    startedAt: row.started_at,
    updatedAt: row.updated_at,
    nextAttemptAt: row.next_attempt_at,
    endedAt: row.ended_at,
    leaseOwner: row.lease_owner ?? null,
    admissionMisses: row.admission_misses ?? 0,
    decodeError,
  };
}

/**
 * Start a run, or JOIN the one already in flight (#1577's first acceptance).
 *
 * The payload is refused here, before a row exists, so a run is never recorded
 * carrying a value it cannot resume from.
 *
 * The join returns the LIVE run unchanged — its cursor, its counters, its start
 * time. A second caller therefore learns the id of the walk that is already
 * happening and can watch it, which is what "joins the first" has to mean for the
 * caller to be able to do anything with the answer.
 *
 * **The lookup and the insert are ONE store operation** (`startOrJoin`), not two.
 * As two, concurrent starts both find no live run and both insert — and there is no
 * unique index to catch the second, deliberately, because a crashed run must stay
 * restartable. The coalescing guarantee would then be false exactly when it is load
 * bearing: two callers asking at once, which is the case it exists for.
 */
export async function startJobRun(
  store: JobRunStore,
  input: StartJobRunInput,
  mintId: () => string,
  now: () => string,
): Promise<JobRunRow> {
  const subject = input.subject === undefined ? null : dataSubjectId.parse(input.subject);
  const payload = input.payload ?? null;
  assertQueueSafe(payload, 'payload');
  const key: JobRunKey = {
    moduleId: input.moduleId,
    job: input.job,
    instance: input.instance ?? 'default',
  };
  const at = now();
  const row: JobRunRow = {
    id: mintId(),
    module_id: key.moduleId,
    job: key.job,
    instance: key.instance,
    payload: JSON.stringify(payload),
    subject_id: subject,
    status: 'running',
    cursor: null,
    counters: '{}',
    attempts: 0,
    last_error: null,
    started_at: at,
    updated_at: at,
    next_attempt_at: null,
    ended_at: null,
    lease_owner: null,
  };
  // The row is built unconditionally — an id is minted and a start time stamped even
  // when this call turns out to be a join. That is the price of doing the decision in
  // one store operation, and it is cheap: a ULID nobody kept costs nothing, whereas a
  // "look first so we do not waste an id" round trip is the race this exists to close.
  const started = await store.startOrJoin(key, row);
  if ((started.subject_id ?? null) !== subject) {
    throw substratError('conflict', 'the live job run declares a different subject; use a separate instance', {
      reason: 'job_subject_mismatch',
    });
  }
  return started;
}

/** A step that threw, carrying what the driver needs to decide the run's fate. */
class JobStepFailure extends Error {
  constructor(
    readonly step: string,
    readonly stepAttempts: number,
    readonly policy: Required<ExecutorRetryPolicy>,
    readonly cause: string,
  ) {
    super(`step '${step}' failed: ${cause}`);
    this.name = 'JobStepFailure';
  }
}

/**
 * #2034: the pass no longer holds its run's lease, found at a step boundary. Kernel-private and
 * tied to its pass, like `PassDeferred`, so a handler that catches it cannot turn it into anything
 * that writes: the pass stops, and the outcome is `superseded`.
 */
class LeaseLost extends Error {
  constructor(readonly pass: object) {
    super('this pass no longer holds the run: its lease was taken over or the run was settled');
  }
}

/** The ISO instant `ms` after `at` — a lease's expiry, a deferral's end. */
const plusMs = (at: string, ms: number): string => new Date(Date.parse(at) + ms).toISOString();

/**
 * Write a pass's outcome onto its run, keeping what the last commit wrote (cursor, counters) and
 * stamping `ended_at` when the outcome is terminal. False = refused: `owner` no longer holds the run.
 */
function settle(
  store: JobRunStore,
  run: JobRunRow,
  owner: string,
  at: string,
  outcome: Pick<JobRunPatch, 'status' | 'attempts' | 'lastError' | 'nextAttemptAt'>,
): Promise<boolean> {
  return store.patch(
    run.id,
    {
      ...outcome,
      cursor: run.cursor,
      counters: run.counters,
      updatedAt: at,
      endedAt: outcome.status === 'running' ? null : at,
    },
    owner,
  );
}

/** What one pass did, as the drive loop reads it. */
export interface JobPassOutcome {
  status: 'advanced' | 'completed' | 'retrying' | 'failed' | 'deferred' | 'superseded';
  /**
   * The error left on the record. Present exactly on `retrying` and `failed`, and on `deferred`,
   * where it is the door's refusal and NOT on the record: a deferred pass records no error.
   */
  error?: string;
}

/**
 * Run ONE pass of one run, and write what happened.
 *
 * The whole of the contract is here, which is why both adapters call it rather than
 * porting it:
 *
 * - A committed pass writes the new cursor and counters, clears `attempts` and
 *   `last_error`, and DROPS the step ledger — a new pass is new work.
 * - A failed pass writes NOTHING the handler produced: the cursor and counters stay
 *   where the last commit left them, so a partially-walked chunk is never mistaken
 *   for a committed one. The step ledger SURVIVES, which is what stops the next pass
 *   repeating the steps that did succeed.
 * - A step at its `maxAttempts` fails the RUN: status `failed`, the step's error on
 *   the record, `ended_at` stamped. It is reported, never thrown — a driver that
 *   let one run's failure escape would take down every run behind it, which is the
 *   failure `runDueSchedules` already refuses for schedules.
 */
export async function runJobPass(options: {
  store: JobRunStore;
  /** The run as this pass's claim left it. */
  run: JobRunRow;
  /** #2034: the lease this pass's claim wrote. Every write below is conditional on it. */
  owner: string;
  /** #2034: how long each renewal at a step boundary extends the lease. Default `JOB_LEASE_MS`. */
  leaseMs?: number;
  handler: JobHandler;
  /** The job's own retry policy — a step may narrow it, none may widen past its own. */
  retry?: ExecutorRetryPolicy;
  now: () => string;
  /**
   * Opens the system door for this run's module. Called at most once per pass, with this pass's
   * token: a fresh object per pass, which the host ties its door's refusals to.
   */
  openScope: (pass: object) => Promise<ScopeStub>;
  /**
   * #1834: did the host's own system door, on THIS pass (`pass`, the token `openScope` was handed),
   * throw this value to say "not now"? The HOST answers, by the identity of what its door threw for
   * this pass, never by an error's shape: a step or an operation can throw any public shape, and a
   * pass that could defer itself would wait forever without spending a retry. The host consumes
   * the mark as it answers yes. Absent: nothing defers.
   */
  deferral?: (err: unknown, pass: object) => boolean;
}): Promise<JobPassOutcome> {
  const { store, run, owner, handler, now, openScope } = options;
  const leaseMs = options.leaseMs ?? JOB_LEASE_MS;
  // This pass's token, and nothing else's: the door's refusals are tied to it.
  const passToken = {};
  /** #2034: a write refused because the lease is gone stops the pass where it stands. */
  const held = (applied: boolean): void => {
    if (!applied) throw new LeaseLost(passToken);
  };
  /** Asked once per refusal, since the host consumes its mark; the answer then travels as `PassDeferred`. */
  const deferral = (err: unknown): PassDeferred | null => {
    if (err instanceof PassDeferred) return err.pass === passToken ? err : null;
    return options.deferral?.(err, passToken) === true ? new PassDeferred(passToken, err) : null;
  };
  const jobPolicy = resolveRetryPolicy(options.retry);
  const usedThisPass = new Set<string>();
  let scope: Promise<ScopeStub> | null = null;

  try {
    // DECODING THE ROW IS PART OF THE PASS, not a precondition of it.
    //
    // These three `JSON.parse`es sat above the `try` in the first cut of this file,
    // which made a single malformed row the one failure this driver could not
    // contain: the throw left `runJobPass`, left `runDueJobRuns` — which does not
    // wrap the call either — and came out of `runDueJobs` at whoever was holding the
    // tick, taking every due run BEHIND it with it. That is the exact outcome the
    // per-run isolation exists to refuse, arrived at through the driver itself.
    //
    // It is reachable without any forge: `importDump` replays a dump's rows verbatim
    // (preview-and-snapshots.md §3), so a restore from a foreign or hand-edited dump
    // is enough. Inside the try it is an ordinary failed pass — recorded on the run,
    // retried, then terminal with the parse error as its `last_error`, and the runs
    // beside it untouched.
    // The pass's own copy: the catch below writes `run.counters` back — the string
    // the last COMMIT wrote — so a failed pass's counts go with the rest of it.
    const counters = { ...(JSON.parse(run.counters) as Record<string, number>) };
    const pass: JobPassContext = {
      run: {
        id: run.id,
        moduleId: run.module_id as ModuleId,
        job: run.job,
        instance: run.instance,
      },
      payload: JSON.parse(run.payload) as unknown,
      cursor: run.cursor === null ? null : (JSON.parse(run.cursor) as unknown),
      counters,
      count: (name, by = 1) => {
        counters[name] = (counters[name] ?? 0) + by;
      },
      scope: () => (scope ??= openScope(passToken)),
      step: async <T>(name: string, fn: () => T | Promise<T>, retry?: ExecutorRetryPolicy): Promise<T> => {
        if (usedThisPass.has(name)) {
          // The determinism rule's mechanical half. The second call would read the
          // first's memo and skip its own work — silently, and only in production,
          // because the first pass of a fresh run runs both bodies before either is
          // committed. Refused where it is unambiguous rather than left to a comment.
          throw substratError(
            'conflict',
            `step '${name}' was already run in this pass — a step name identifies one unit of ` +
              'work, so a second call under it would return the first one\'s result instead of ' +
              'doing anything',
            { reason: JOB_STEP_REUSED },
          );
        }
        usedThisPass.add(name);
        const policy = resolveRetryPolicy(retry ?? options.retry);
        // #2034: a step boundary renews the lease, and a pass that lost it runs no further step.
        const begun = await store.beginStep(run.id, name, owner, leaseMs);
        held(begun.held);
        const prior = begun.row;
        // A NON-NULL result is what means completed: a step that threw left its row
        // with a null result and a raised count, and must run again.
        if (prior && prior.result !== null) return JSON.parse(prior.result) as T;
        const attempts = (prior?.attempts ?? 0) + 1;
        // A step whose RECORDED attempts already reached the policy is spent, and
        // calling `fn` again would be one more real request to somebody else's API
        // for a run that is going to fail anyway. Reachable: a stop after
        // `recordStep` wrote the final failed attempt but before the run patch below
        // marked the run terminal leaves exactly this row, and the next drive would
        // otherwise spend one extra attempt discovering what the row already says.
        if (prior && prior.attempts >= policy.maxAttempts) {
          throw new JobStepFailure(name, prior.attempts, policy, prior.last_error ?? 'exhausted');
        }
        let value: T;
        try {
          value = await fn();
        } catch (err) {
          // #1834: the door's "not now" is not this step's failure, so it is not one of its attempts.
          const wait = deferral(err);
          if (wait) throw wait;
          const cause = message(err);
          const at = now();
          held(await store.recordStep(run.id, name, null, attempts, cause, at, owner, leaseMs));
          throw new JobStepFailure(name, attempts, policy, cause);
        }
        // `undefined` becomes the JSON text 'null', not SQL NULL: a step done purely
        // for its effect must still read as completed on the next pass.
        const stored = JSON.stringify(value) ?? 'null';
        const at = now();
        held(await store.recordStep(run.id, name, stored, attempts, null, at, owner, leaseMs));
        // RETURNED THROUGH THE STORED FORM, not as the raw value. The resume path
        // returns `JSON.parse(row.result)`, so returning `value` here would hand the
        // handler a `Date` on the first pass and the string `"2026-01-01T…"` on the
        // replay — the same code taking a different branch depending on whether it
        // was interrupted, which is the determinism failure this driver is most
        // exposed to and the one least likely to be noticed in a test that never
        // resumes. Both paths now return the same shape.
        return JSON.parse(stored) as T;
      },
    };

    const result = (await handler(pass)) ?? {};
    const keepsCursor = !('cursor' in result);
    // NOT `result.cursor ?? null`. An explicitly supplied `cursor: undefined` is a
    // supplied cursor — `'cursor' in result` is true — and coalescing it to null
    // before the check meant it validated cleanly and RESET the walk to the
    // beginning. The difference between "keep going" and "start over" turned on a
    // `??`, silently, in the direction that repeats an hour of work. `assertQueueSafe`
    // already refuses `undefined`; it simply never saw it.
    if (!keepsCursor) assertQueueSafe(result.cursor, 'cursor');
    const at = now();
    const done = result.done === true;
    // ONE operation: the run's new state and the dropping of its step ledger commit
    // together or not at all.
    //
    // This was two calls, ordered patch-then-clear, with a comment explaining that a
    // stop in between was harmless because the next pass's step names "derive from
    // the new cursor" and would miss the stale rows. THAT WAS FALSE. The determinism
    // rule binds a step name to the payload and prior results, not to the cursor, so
    // a handler naming its steps `fetch-page` / `write-batch` — legal, and the
    // obvious way to write one — hits the finished pass's memo on the next pass and
    // skips work it never did. The gap was also wrong in the other direction: a
    // throw from the clear landed in the catch below, which wrote the OLD cursor
    // back and filed an already-committed pass as failed, so the record a human
    // reads to recover would have understated the run's own progress.
    const committed = await store.commitPass(
      run.id,
      {
        status: done ? 'done' : 'running',
        cursor: keepsCursor ? run.cursor : JSON.stringify(result.cursor),
        counters: JSON.stringify(counters),
        attempts: 0,
        lastError: null,
        updatedAt: at,
        // Cleared, never left at the lease's expiry: the lease ends with the pass (#2034).
        nextAttemptAt: null,
        endedAt: done ? at : null,
      },
      owner,
    );
    if (!committed) return { status: 'superseded' };
    return { status: done ? 'completed' : 'advanced' };
  } catch (err) {
    // #2034: this pass lost the run at a step boundary. Nothing to write: any write would be refused.
    if (err instanceof LeaseLost && err.pass === passToken) return { status: 'superseded' };
    // #1834: the host's system door said wait, so the call did not run. The run keeps what the last
    // commit wrote (its attempts and its last error included); only when it is next due moves.
    if (deferral(err)) {
      const at = now();
      const patched = await settle(store, run, owner, at, {
        status: 'running',
        attempts: run.attempts,
        lastError: run.last_error,
        nextAttemptAt: plusMs(at, JOB_DEFER_MS),
      });
      return patched ? { status: 'deferred', error: message(err) } : { status: 'superseded' };
    }
    const stepFailure = err instanceof JobStepFailure ? err : null;
    const policy = stepFailure?.policy ?? jobPolicy;
    // The RUN's attempts counts consecutive failed passes — what an operator reads as
    // "how stuck is it". The STEP's own count is what decides exhaustion and backoff,
    // because a step's policy is a fact about that step.
    const attempts = run.attempts + 1;
    const against = stepFailure?.stepAttempts ?? attempts;
    const exhausted = against >= policy.maxAttempts;
    const error = message(err);
    const at = now();
    const patched = await settle(store, run, owner, at, {
      status: exhausted ? 'failed' : 'running',
      attempts,
      lastError: error,
      // The backoff, never the lease's expiry the claim wrote: the lease ends with the pass (#2034).
      nextAttemptAt: exhausted ? null : backoffAt(against, policy, new Date(at)),
    });
    if (!patched) return { status: 'superseded' };
    return { status: exhausted ? 'failed' : 'retrying', error };
  }
}

/**
 * Advance every due run on one scope — the driver both adapters expose as
 * `runDueJobs`.
 *
 * Bounded on both axes, because a maintenance tick has a budget: `limit` runs per
 * call, `maxPasses` passes per run. A run that still has work left after its budget
 * is simply left `running` and due, and the next call takes it — the same "reported
 * rather than looped" shape the event drain's `incomplete` has. Default `maxPasses`
 * is 1, so a caller gets one predictable unit of work unless it asks for more.
 *
 * **`limit` counts RUNNABLE runs, not rows read**, and that distinction is a fix
 * rather than a nicety. Runs whose job this host does not register are skipped, and
 * when the budget was applied to the query instead, a scope holding `limit` such rows
 * at the head of the due order returned the same unrunnable batch on every call —
 * nothing newer was ever reached, and the report said `attempted: 0` forever with no
 * indication why. So the read looks past them, bounded by `JOB_DRIVE_SCAN_MAX` rows
 * examined so one scope full of orphans cannot turn a tick into a table scan.
 *
 * **Selection is ONE snapshot per drive** (#1834). The drive reads the keys of up to
 * `JOB_DRIVE_SCAN_MAX` due runs in a single query, picks up to `limit` runnable ones
 * (each id once), and CLAIMS each one just before it runs it (#2034), skipping one the
 * claim finds no longer `running` or no longer due. A cursor across several reads met rows
 * that another writer had moved in between, and ran one twice or skipped it. A run that
 * moves, or becomes due, after the snapshot is the NEXT drive's business, never this one's.
 *
 * The claim is a reservation, not a read: of two drives overlapping on one scope that both
 * picked a run, exactly one wins it, and only the winner invokes the handler (see the
 * file header). A second pass in the same drive (`maxPasses`) claims again, with a fresh
 * owner, so it holds a lease of its own rather than one the first pass released.
 *
 * The starvation was spotted while re-reading this file, judged unlikely and left
 * alone — and then found independently by a reviewer. The judgement may even have
 * been right; recording it only in the author's head was not, because a decision
 * nobody can see is indistinguishable from an oversight. Hence the fix and hence
 * this paragraph.
 */
export async function runDueJobRuns(options: {
  store: JobRunStore;
  /** job name → its handler and policy, as `registerJob` recorded them. */
  handlerFor: (run: Pick<JobRunRow, 'module_id' | 'job'>) => JobRegistration | undefined;
  now: () => string;
  openScope: (run: JobRunRow, pass: object) => Promise<ScopeStub>;
  /** #1834: the host's own system-door refusals on one pass, by identity (`runJobPass`). */
  deferral?: (err: unknown, pass: object) => boolean;
  maxPasses?: number;
  limit?: number;
  /**
   * #2042 r4: this drive's own monotonic clock, in milliseconds — what it measures its wait for the
   * store against. Never compared with the store's clock. Default `performance.now()`.
   */
  monotonic?: () => number;
}): Promise<JobDriveReport> {
  const report: JobDriveReport = {
    attempted: 0,
    advanced: 0,
    completed: 0,
    retrying: 0,
    failed: 0,
    superseded: 0,
    deferred: 0,
    errors: [],
    warnings: [],
  };
  const maxPasses = Math.max(1, options.maxPasses ?? 1);
  // Bound for the store's `LIMIT` (#1632): refused, not normalized, when it is not a positive integer.
  const want = options.limit === undefined ? JOB_DRIVE_LIMIT : assertRowLimit('limit', options.limit);

  // ONE snapshot of the due keys, then up to `want` RUNNABLE ones from it, each id once. A
  // run whose job this host does not register — another deployment's, or one whose
  // registration was removed — is stepped over and NOT failed: failing it would destroy
  // a resumable run because the wrong process happened to look at it.
  const picked: JobDueKey[] = [];
  const seen = new Set<string>();
  for (const key of await options.store.dueKeys(options.now(), JOB_DRIVE_SCAN_MAX)) {
    if (picked.length >= want) break;
    if (seen.has(key.id)) continue;
    seen.add(key.id);
    if (options.handlerFor(key)) picked.push(key);
  }

  /** Tally one pass's outcome; a deferral's error is the door's, and never on the record. */
  const count = (runId: string, outcome: JobPassOutcome): void => {
    report[outcome.status] += 1;
    if (outcome.error !== undefined && outcome.status !== 'deferred') report.errors.push({ runId, error: outcome.error });
  };
  const monotonic = options.monotonic ?? (() => performance.now());
  /**
   * #2034: take run `id` for one pass, or null — under an owner minted for this pass alone (#2042
   * r1). Claim it; a takeover of a BEGUN lease the job's policy has no attempt left for fails it
   * here without invoking; otherwise BEGIN, the commitment point (see the file header). A claim
   * whose reply left less than the margin of the lease by this drive's own monotonic count (from
   * just before it was sent, so the whole round trip is counted), or whose BEGIN the store
   * refused, is an admission miss: it releases the run through the store's miss transaction and
   * runs nothing.
   */
  const acquire = async (id: string, registered: JobRegistration) => {
    const leaseMs = registered.leaseMs ?? JOB_LEASE_MS;
    const owner = ulid();
    const sent = monotonic();
    const won = await options.store.claim(id, owner, leaseMs);
    if (!won) return null;
    // An expired lease taken over is a pass that began and never reported, so it was an attempt (the
    // claim counted it). Judged against the job's policy like any failure no step owns: a pass that
    // keeps dying ends the run here, rather than being retried at every expiry forever.
    if (won.takeover && won.run.attempts >= resolveRetryPolicy(registered.retry).maxAttempts) {
      report.attempted += 1;
      const settled = await settle(options.store, won.run, owner, options.now(), {
        status: 'failed',
        attempts: won.run.attempts,
        lastError: JOB_LEASE_EXPIRED_NOTE,
        nextAttemptAt: null,
      });
      count(id, settled ? { status: 'failed', error: JOB_LEASE_EXPIRED_NOTE } : { status: 'superseded' });
      return null;
    }
    const margin = leaseMs * JOB_LEASE_ENTRY_MARGIN;
    if (leaseMs - (monotonic() - sent) > margin && (await options.store.begin(id, owner, margin))) {
      // BEGIN wrote: the pass is committed, and runs — its reply is not second-guessed.
      return { ...won, owner, leaseMs };
    }
    // An admission miss (#2042 r3, r4): no handler ran, so no attempt is charged; the store counts
    // the miss and sets the backoff, or past JOB_ADMISSION_MISS_MAX fails the run.
    const observed = Math.round(monotonic() - sent);
    const describe = (misses: number) =>
      `job ${won.run.module_id}/${won.run.job}: claim not begun in time — leaseMs ${leaseMs}, margin ` +
      `${margin} ms, claim and begin took ${observed} ms (admission miss ${misses} of ${JOB_ADMISSION_MISS_MAX})`;
    // The note a failure records names the miss it is: the count the store is about to reach.
    const missed = await options.store.miss(id, owner, describe((won.run.admission_misses ?? 0) + 1));
    if (!missed) {
      report.superseded += 1; // it lost the run meanwhile: the holder now owns it, and its count
      return null;
    }
    const warning = describe(missed.misses);
    report.warnings.push({ runId: id, warning });
    console.log(JSON.stringify({
      substrat: 'job-admission-miss',
      runId: id,
      job: `${won.run.module_id}/${won.run.job}`,
      leaseMs,
      marginMs: margin,
      observedMs: observed,
      misses: missed.misses,
      max: JOB_ADMISSION_MISS_MAX,
    }));
    if (missed.failed) {
      report.failed += 1;
      report.errors.push({ runId: id, error: `${JOB_LEASE_TOO_SHORT_NOTE}: ${warning}` });
    } else {
      report.superseded += 1;
    }
    return null;
  };

  for (const key of picked) {
    const registered = options.handlerFor(key)!;
    // The run is this drive's only if it is still running and due NOW by the store's clock, and its
    // pass begins; then no other drive's until the lease ends. One that was finished, moved, or
    // claimed by another drive since the snapshot is skipped; it is the next drive's.
    let claimed = await acquire(key.id, registered);
    if (!claimed) continue;
    report.attempted += 1;
    for (let pass = 0; pass < maxPasses; pass += 1) {
      const run = claimed.run;
      const outcome = await runJobPass({
        store: options.store,
        run,
        owner: claimed.owner,
        leaseMs: claimed.leaseMs,
        handler: registered.handler,
        retry: registered.retry,
        now: options.now,
        openScope: (pass) => options.openScope(run, pass),
        deferral: options.deferral,
      });
      count(run.id, outcome);
      if (outcome.status !== 'advanced') break;
      // A second pass in this call resumes from what the first one COMMITTED, as its own claim
      // reads it back: the cursor is the handler's value and the store is the only thing that
      // knows it survived the write. Another drive may have claimed it in between; then it is theirs.
      if (pass + 1 >= maxPasses) break;
      const next = await acquire(run.id, registered);
      if (!next) break;
      claimed = next;
    }
  }
  return report;
}
