import { DurableObject } from 'cloudflare:workers';

/**
 * What `defineCopyJobDO` needs of a job record (#2450): the rest of it is the caller's, and is
 * stored as given. `nextDelayMs` is how long to wait before the next step while it is `copying`.
 */
export interface CopyJobDoRecord {
  status: 'copying' | 'done' | 'failed' | 'cancelled';
  nextDelayMs: number;
  updatedAt: number;
  /** Once `done`: until when (epoch ms) the caller that claimed it holds it (`claim`). Set here. */
  claimedUntil?: number;
}

/**
 * The RPC surface a `defineCopyJobDO` class exposes over its stub. Every call but `claim` is
 * idempotent. Each is one call into this object, so each is atomic for its job.
 */
export interface CopyJobDo<R extends CopyJobDoRecord> {
  /** Store `record` and run it, or answer the record already started here. */
  start(record: R): Promise<R>;
  get(): Promise<R | null>;
  /**
   * Take a `done` job to finish it: answered, held for `holdMs`, to one caller at a time, and null to
   * any other (a job held, not done, or gone).
   */
  claim(holdMs: number): Promise<R | null>;
  /**
   * Stop a job that is copying, or done and not held: no later step or claim acts on it. A step
   * running now is stopped first, and waited for, so the record answered is the last one any step
   * wrote and nothing a step does follows the answer. A job a caller holds is answered as it is.
   */
  cancel(): Promise<R | null>;
  /** Drop the record and its alarm, after stopping a step running now and waiting for it. */
  forget(): Promise<void>;
  /**
   * Keep `order` as the newest mark here for `holdMs` from now, unless a later one is still held
   * (orders compare as text), and answer the mark held after the call. Gone once its hold runs out.
   * An object that keeps marks runs no job: the caller names them apart.
   */
  markNewest(order: string, holdMs: number): Promise<string>;
}

const claimedNow = (record: CopyJobDoRecord): boolean =>
  record.status === 'done' && (record.claimedUntil ?? 0) > Date.now();

/** What a running step can ask the object it runs in (#2450). */
export interface CopyJobStep {
  /**
   * True once a cancel or forget is waiting on this step. The step stops at its next boundary (a
   * page staged) and starts nothing new (no new stage for a torn copy), and answers where it got to.
   */
  stopped(): boolean;
}

export interface CopyJobDoConfig<Env, R extends CopyJobDoRecord> {
  /**
   * One step. CODE-TIME, closed over like `defineKickCoalescerDO`'s `run`: a Durable Object cannot
   * receive a closure over RPC. It is where the authority lives (the deployment resolves each end
   * and the ledger here); this object decides only WHEN a step runs, and keeps the record.
   */
  advance(env: Env, record: R, step: CopyJobStep): Promise<R>;
  /** How long a finished record is kept for the route to read, ms. Default 24 h. */
  retainMs?: number;
  /** A step that threw rather than answering a record. Never rethrown; the step is retried. */
  onError?(err: unknown, env: Env): void;
  /** How long a step that threw waits before the next one, ms. Default 30 s. */
  threwRetryMs?(record: R): number;
}

/** How long a step that threw waits before the next one, ms, unless the config says otherwise. */
const THREW_RETRY_MS = 30_000;
const KEY = 'job';
/**
 * Which `start` the stored record came from: a token each start writes beside it, and that goes
 * with it on `forget`. A step compares it after its I/O, so a step of a job that was forgotten and
 * started again under the same id writes nothing over the new one.
 */
const RUN = 'run';
/** `markNewest`'s mark, and until when (epoch ms) it holds. */
const MARK = 'mark';
type Mark = { order: string; until: number };

/**
 * `defineCopyJobDO` — one Durable Object per background scope copy (#2450, step 2).
 *
 * A preview's copy that outlasts the request that started it is stored here, and moved one step
 * per alarm: the step renews the move's lease and moves pages for a bounded time, then this object
 * schedules the next. A finished job (done, failed or cancelled) is kept for `retainMs`, for the
 * route's next call to read and settle, and then deleted. A done job goes to one call at a time
 * (`claim`), so two calls that read it never both finish it.
 *
 * Alarms are one at a time per object, so two steps never run together. A `cancel` or `forget`
 * that arrives while a step's I/O is in flight stops that step (`CopyJobStep.stopped`) and waits for
 * it to end, so whoever acts on the answer next (settling the move, discarding its stage, reaping
 * the scope) acts after the last thing the step did, never before it. Should a step's answer still
 * meet a record that changed under it (a forget, or a forget and a new `start`), its answer and its
 * retry are dropped, by the run token: a cancelled job stays cancelled, a forgotten one stays gone,
 * and a job started again keeps its own record and its own alarm.
 *
 * An object of the same class under another name keeps a mark instead (`markNewest`): the newest of
 * the orders it was given while each was held, which the route uses to tell which of two pushes to
 * one preview is the newer, in the moments no job record says so.
 */
export function defineCopyJobDO<Env, R extends CopyJobDoRecord>(
  config: CopyJobDoConfig<Env, R>,
): new (ctx: DurableObjectState, env: Env) => DurableObject<Env> & CopyJobDo<R> {
  const retainMs = config.retainMs ?? 24 * 3_600_000;
  return class CopyJobDO extends DurableObject<Env> {
    /** The step running now: a cancel or forget stops it and waits for `over`. */
    private step: { stopped: boolean; over: Promise<void> } | null = null;
    /** Cancels and forgets in progress: a step that starts meanwhile is stopped from its outset. */
    private stopping = 0;

    /** Run `act` once no step is running, and with none starting until it is done. */
    private async whileStopped<T>(act: () => Promise<T>): Promise<T> {
      this.stopping++;
      try {
        for (let step = this.step; step; step = this.step) {
          step.stopped = true;
          await step.over;
        }
        return await act();
      } finally {
        this.stopping--;
      }
    }

    async start(record: R): Promise<R> {
      const held = await this.ctx.storage.get<R>(KEY);
      if (held) return held;
      await this.ctx.storage.put({ [KEY]: record, [RUN]: crypto.randomUUID() });
      await this.ctx.storage.setAlarm(Date.now());
      return record;
    }

    async get(): Promise<R | null> {
      return (await this.ctx.storage.get<R>(KEY)) ?? null;
    }

    async claim(holdMs: number): Promise<R | null> {
      const held = await this.ctx.storage.get<R>(KEY);
      if (held?.status !== 'done' || claimedNow(held)) return null;
      const claimed = { ...held, claimedUntil: Date.now() + holdMs } as R;
      await this.ctx.storage.put(KEY, claimed);
      return claimed;
    }

    cancel(): Promise<R | null> {
      return this.whileStopped(async () => {
        const held = await this.ctx.storage.get<R>(KEY);
        if (!held) return null;
        if (held.status !== 'copying' && (held.status !== 'done' || claimedNow(held))) return held;
        const cancelled = { ...held, status: 'cancelled', nextDelayMs: 0, updatedAt: Date.now() } as R;
        await this.ctx.storage.put(KEY, cancelled);
        await this.ctx.storage.setAlarm(Date.now() + retainMs);
        return cancelled;
      });
    }

    forget(): Promise<void> {
      return this.whileStopped(async () => {
        await this.ctx.storage.deleteAlarm();
        await this.ctx.storage.deleteAll();
      });
    }

    async markNewest(order: string, holdMs: number): Promise<string> {
      const now = Date.now();
      const held = await this.ctx.storage.get<Mark>(MARK);
      if (held && held.order > order && held.until > now) return held.order;
      const mark: Mark = { order, until: now + holdMs };
      await this.ctx.storage.put(MARK, mark);
      // Its alarm drops it once held; never over a job's alarm, should a caller ever share an object.
      if (!(await this.ctx.storage.get(KEY))) await this.ctx.storage.setAlarm(mark.until);
      return order;
    }

    /** Whether the job this step read is still the one stored, and still copying. */
    private async stillRunning(run: string | undefined): Promise<boolean> {
      const now = await this.ctx.storage.get([KEY, RUN]);
      return (now.get(KEY) as R | undefined)?.status === 'copying' && now.get(RUN) === run;
    }

    async alarm(): Promise<void> {
      // Registered before the first await, so a cancel or forget arriving at any point finds it.
      let ended!: () => void;
      const step = { stopped: this.stopping > 0, over: new Promise<void>((resolve) => { ended = resolve; }) };
      this.step = step;
      try {
        await this.runStep(step);
      } finally {
        if (this.step === step) this.step = null;
        ended();
      }
    }

    private async runStep(step: { stopped: boolean }): Promise<void> {
      const stored = await this.ctx.storage.get([KEY, RUN, MARK]);
      const held = stored.get(KEY) as R | undefined;
      const run = stored.get(RUN) as string | undefined;
      if (!held) {
        // An object that keeps a mark: gone once it has had its hold.
        const mark = stored.get(MARK) as Mark | undefined;
        if (mark && mark.until <= Date.now()) await this.ctx.storage.delete(MARK);
        else if (mark) await this.ctx.storage.setAlarm(mark.until);
        return;
      }
      if (held.status !== 'copying') {
        // Kept for the route to read; gone once it has had its retention.
        if (Date.now() - held.updatedAt >= retainMs) await this.ctx.storage.deleteAll();
        else await this.ctx.storage.setAlarm(held.updatedAt + retainMs);
        return;
      }
      // A cancel or forget is waiting: it acts on the record as it is.
      if (step.stopped) return;
      let next: R;
      try {
        next = await config.advance(this.env, held, { stopped: () => step.stopped });
      } catch (err) {
        config.onError?.(err, this.env);
        // Not over a cancel's retention alarm, nor over the alarm a job started since has set.
        if (await this.stillRunning(run)) await this.ctx.storage.setAlarm(Date.now() + (config.threwRetryMs?.(held) ?? THREW_RETRY_MS));
        return;
      }
      // A cancel, a forget, or a forget and a new start, that landed while the step ran wins: its
      // answer is dropped.
      if (!(await this.stillRunning(run))) return;
      await this.ctx.storage.put(KEY, next);
      await this.ctx.storage.setAlarm(
        next.status === 'copying' ? Date.now() + Math.max(0, next.nextDelayMs) : Date.now() + retainMs,
      );
    }
  };
}
