import { substratError, type ModuleId } from '@substrat-run/contracts';
import { backoffAt, resolveRetryPolicy, type ExecutorRetryPolicy, type ScopeStub } from './scope-host.js';

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
 * ## One driver per scope at a time — a stated bound, not a mechanism
 *
 * Coalescing stops duplicate RUNS. It does not stop two concurrent callers of
 * `runDueJobs` from picking the same run out of the due read and advancing it at the
 * same time: there is no lease, and a lease is not smuggled in here. The topology the
 * driver is built for has one tick per scope — `runPlatformSweep` enumerates scopes
 * and does one call each, a scope DO's alarm fires for its own scope — so the bound
 * is satisfied by construction rather than defended against.
 *
 * What the overlap would cost, if a deployment did drive one scope twice at once: the
 * step ledger absorbs most of it (a step already committed returns its memo to both),
 * so the exposure is a step neither pass has finished yet, which both would run. That
 * is the same at-least-once residue an executor already has and which handlers already
 * have to absorb — but it is NOT what "only one walk per source at a time" promises,
 * so it is written down rather than implied. Adding a lease is a real design with a
 * real expiry question behind it (a leaked lease is a run nothing will ever touch
 * again), and it wants a consumer's numbers before it gets one.
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
    -- (or terminal), which is why the due read tests IS NULL as well as <= now.
    next_attempt_at TEXT,
    -- When the run reached 'done' or 'failed'. NULL while it is still running.
    ended_at TEXT
  );
  -- The drive's read: WHERE status = 'running' AND (next_attempt_at IS NULL OR <= ?)
  -- ORDER BY id. Leading with status makes the live runs a seekable range over a
  -- table that RETAINS every finished run, so the cost tracks how much is in flight
  -- rather than how much the scope has ever imported.
  CREATE INDEX IF NOT EXISTS _substrat_job_runs_due ON _substrat_job_runs (status, next_attempt_at, id);
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
  /** What the last COMMITTED pass handed forward; null before the first commit. */
  cursor: unknown;
  counters: Record<string, number>;
  /** Consecutive failed passes; 0 after any commit. */
  attempts: number;
  lastError: string | null;
  startedAt: string;
  updatedAt: string;
  nextAttemptAt: string | null;
  endedAt: string | null;
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
  /** Per-run failures, the same shape `ScheduleRunReport.errors` has: what failed and why. */
  errors: { runId: string; error: string }[];
}

/** The `_substrat_job_runs` row, as both adapters' SQL returns it. */
export interface JobRunRow {
  readonly id: string;
  readonly module_id: string;
  readonly job: string;
  readonly instance: string;
  readonly payload: string;
  readonly status: string;
  readonly cursor: string | null;
  readonly counters: string;
  readonly attempts: number;
  readonly last_error: string | null;
  readonly started_at: string;
  readonly updated_at: string;
  readonly next_attempt_at: string | null;
  readonly ended_at: string | null;
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
  /** One run by id, whatever its status. */
  get(id: string): Promise<JobRunRow | null>;
  /**
   * `running` runs whose `next_attempt_at` has passed (or is NULL), oldest first,
   * starting strictly after `afterId` when one is given.
   *
   * The cursor exists for starvation, not for paging convenience: the driver skips
   * runs whose job this host does not register, and without a cursor those rows sit
   * at the head of every batch forever, so a scope holding `limit` of them never
   * drives anything newer. See `runDueJobRuns`.
   */
  due(now: string, limit: number, afterId?: string): Promise<JobRunRow[]>;
  list(filter: JobRunFilter): Promise<JobRunRow[]>;
  patch(id: string, patch: JobRunPatch): Promise<void>;
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
   */
  commitPass(id: string, patch: JobRunPatch): Promise<void>;
  step(runId: string, name: string): Promise<JobStepRow | null>;
  recordStep(
    runId: string,
    name: string,
    result: string | null,
    attempts: number,
    lastError: string | null,
    at: string,
  ): Promise<void>;
}

/** `conflict` reason: two `step()` calls under one name in one pass. */
export const JOB_STEP_REUSED = 'job_step_reused';

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
    cursor,
    counters,
    attempts: row.attempts,
    lastError: row.last_error,
    startedAt: row.started_at,
    updatedAt: row.updated_at,
    nextAttemptAt: row.next_attempt_at,
    endedAt: row.ended_at,
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
    status: 'running',
    cursor: null,
    counters: '{}',
    attempts: 0,
    last_error: null,
    started_at: at,
    updated_at: at,
    next_attempt_at: null,
    ended_at: null,
  };
  // The row is built unconditionally — an id is minted and a start time stamped even
  // when this call turns out to be a join. That is the price of doing the decision in
  // one store operation, and it is cheap: a ULID nobody kept costs nothing, whereas a
  // "look first so we do not waste an id" round trip is the race this exists to close.
  return store.startOrJoin(key, row);
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

/** What one pass did, as the drive loop reads it. */
export interface JobPassOutcome {
  status: 'advanced' | 'completed' | 'retrying' | 'failed';
  /** The error left on the record. Present exactly on `retrying` and `failed`. */
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
  run: JobRunRow;
  handler: JobHandler;
  /** The job's own retry policy — a step may narrow it, none may widen past its own. */
  retry?: ExecutorRetryPolicy;
  now: () => string;
  /** Opens the system door for this run's module. Called at most once per pass. */
  openScope: () => Promise<ScopeStub>;
}): Promise<JobPassOutcome> {
  const { store, run, handler, now, openScope } = options;
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
      scope: () => (scope ??= openScope()),
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
        const prior = await store.step(run.id, name);
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
          const cause = message(err);
          await store.recordStep(run.id, name, null, attempts, cause, now());
          throw new JobStepFailure(name, attempts, policy, cause);
        }
        // `undefined` becomes the JSON text 'null', not SQL NULL: a step done purely
        // for its effect must still read as completed on the next pass.
        const stored = JSON.stringify(value) ?? 'null';
        await store.recordStep(run.id, name, stored, attempts, null, now());
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
    await store.commitPass(run.id, {
      status: done ? 'done' : 'running',
      cursor: keepsCursor ? run.cursor : JSON.stringify(result.cursor),
      counters: JSON.stringify(counters),
      attempts: 0,
      lastError: null,
      updatedAt: at,
      nextAttemptAt: null,
      endedAt: done ? at : null,
    });
    return { status: done ? 'completed' : 'advanced' };
  } catch (err) {
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
    await store.patch(run.id, {
      status: exhausted ? 'failed' : 'running',
      cursor: run.cursor,
      counters: run.counters,
      attempts,
      lastError: error,
      updatedAt: at,
      nextAttemptAt: exhausted ? null : backoffAt(against, policy, new Date(at)),
      endedAt: exhausted ? at : null,
    });
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
 * indication why. So the read pages past them, bounded by `JOB_DRIVE_SCAN_MAX` rows
 * examined so one scope full of orphans cannot turn a tick into a table scan.
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
  handlerFor: (run: JobRunRow) => { handler: JobHandler; retry?: ExecutorRetryPolicy } | undefined;
  now: () => string;
  openScope: (run: JobRunRow) => Promise<ScopeStub>;
  maxPasses?: number;
  limit?: number;
}): Promise<JobDriveReport> {
  const report: JobDriveReport = {
    attempted: 0,
    advanced: 0,
    completed: 0,
    retrying: 0,
    failed: 0,
    errors: [],
  };
  const maxPasses = Math.max(1, options.maxPasses ?? 1);
  const want = options.limit ?? JOB_DRIVE_LIMIT;

  // Page the due read until `want` RUNNABLE runs have been gathered, or the scope
  // runs out, or the scan cap is hit. A run whose job this host does not register —
  // another deployment's, or one whose registration was removed — is stepped over
  // and NOT failed: failing it would destroy a resumable run because the wrong
  // process happened to look at it.
  const runnable: JobRunRow[] = [];
  let scanned = 0;
  let afterId: string | undefined;
  while (runnable.length < want && scanned < JOB_DRIVE_SCAN_MAX) {
    const batch = await options.store.due(options.now(), want, afterId);
    if (batch.length === 0) break;
    scanned += batch.length;
    for (const row of batch) {
      if (options.handlerFor(row) && runnable.length < want) runnable.push(row);
    }
    afterId = batch[batch.length - 1]!.id;
    // A short batch is the end of the due set; another round trip would read nothing.
    if (batch.length < want) break;
  }

  for (const row of runnable) {
    const registered = options.handlerFor(row)!;
    report.attempted += 1;
    let run = row;
    for (let pass = 0; pass < maxPasses; pass += 1) {
      const outcome = await runJobPass({
        store: options.store,
        run,
        handler: registered.handler,
        retry: registered.retry,
        now: options.now,
        openScope: () => options.openScope(run),
      });
      if (outcome.status === 'completed') {
        report.completed += 1;
        break;
      }
      if (outcome.status === 'failed') {
        report.failed += 1;
        report.errors.push({ runId: run.id, error: outcome.error! });
        break;
      }
      if (outcome.status === 'retrying') {
        report.retrying += 1;
        report.errors.push({ runId: run.id, error: outcome.error! });
        break;
      }
      report.advanced += 1;
      // A second pass in this call resumes from what the first one COMMITTED, read
      // back rather than reconstructed: the cursor is the handler's value and the
      // store is the only thing that knows it survived the write.
      if (pass + 1 >= maxPasses) break;
      const fresh = await options.store.get(run.id);
      if (!fresh || fresh.status !== 'running') break;
      run = fresh;
    }
  }
  return report;
}
