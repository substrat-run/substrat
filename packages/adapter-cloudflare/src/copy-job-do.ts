import { DurableObject } from 'cloudflare:workers';

/**
 * What `defineCopyJobDO` needs of a job record (#2450): the rest of it is the caller's, and is
 * stored as given. `nextDelayMs` is how long to wait before the next step while it is `copying`.
 */
export interface CopyJobDoRecord {
  status: 'copying' | 'done' | 'failed' | 'cancelled';
  nextDelayMs: number;
  updatedAt: number;
}

/** The RPC surface a `defineCopyJobDO` class exposes over its stub. Every call is idempotent. */
export interface CopyJobDo<R extends CopyJobDoRecord> {
  /** Store `record` and run it, or answer the record already started here. */
  start(record: R): Promise<R>;
  get(): Promise<R | null>;
  /** Stop a job that is copying; a step running now writes nothing after this. */
  cancel(): Promise<R | null>;
  /** Drop the record and its alarm. */
  forget(): Promise<void>;
}

export interface CopyJobDoConfig<Env, R extends CopyJobDoRecord> {
  /**
   * One step. CODE-TIME, closed over like `defineKickCoalescerDO`'s `run`: a Durable Object cannot
   * receive a closure over RPC. It is where the authority lives (the deployment resolves each end
   * and the ledger here); this object decides only WHEN a step runs, and keeps the record.
   */
  advance(env: Env, record: R): Promise<R>;
  /** How long a finished record is kept for the route to read, ms. Default 24 h. */
  retainMs?: number;
  /** A step that threw rather than answering a record. Never rethrown; the step is retried. */
  onError?(err: unknown, env: Env): void;
}

/** How long a step that threw waits before the next one, ms. */
const THREW_RETRY_MS = 30_000;
const KEY = 'job';
/**
 * Which `start` the stored record came from: a token each start writes beside it, and that goes
 * with it on `forget`. A step compares it after its I/O, so a step of a job that was forgotten and
 * started again under the same id writes nothing over the new one.
 */
const RUN = 'run';

/**
 * `defineCopyJobDO` — one Durable Object per background scope copy (#2450, step 2).
 *
 * A preview's copy that outlasts the request that started it is stored here, and moved one step
 * per alarm: the step renews the move's lease and moves pages for a bounded time, then this object
 * schedules the next. A finished job (done, failed or cancelled) is kept for `retainMs`, for the
 * route's next call to read and settle, and then deleted.
 *
 * Alarms are one at a time per object, so two steps never run together. A `cancel` or `forget`
 * can arrive while a step's I/O is in flight, and so can a `start` after that `forget`: the step's
 * answer is then dropped, and so is its retry, so a cancelled job stays cancelled, a forgotten one
 * stays gone, and a job started again keeps its own record and its own alarm.
 */
export function defineCopyJobDO<Env, R extends CopyJobDoRecord>(
  config: CopyJobDoConfig<Env, R>,
): new (ctx: DurableObjectState, env: Env) => DurableObject<Env> & CopyJobDo<R> {
  const retainMs = config.retainMs ?? 24 * 3_600_000;
  return class CopyJobDO extends DurableObject<Env> {
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

    async cancel(): Promise<R | null> {
      const held = await this.ctx.storage.get<R>(KEY);
      if (!held) return null;
      if (held.status !== 'copying') return held;
      const cancelled = { ...held, status: 'cancelled', nextDelayMs: 0, updatedAt: Date.now() } as R;
      await this.ctx.storage.put(KEY, cancelled);
      await this.ctx.storage.setAlarm(Date.now() + retainMs);
      return cancelled;
    }

    async forget(): Promise<void> {
      await this.ctx.storage.deleteAlarm();
      await this.ctx.storage.deleteAll();
    }

    /** Whether the job this step read is still the one stored, and still copying. */
    private async stillRunning(run: string | undefined): Promise<boolean> {
      const now = await this.ctx.storage.get([KEY, RUN]);
      return (now.get(KEY) as R | undefined)?.status === 'copying' && now.get(RUN) === run;
    }

    async alarm(): Promise<void> {
      const stored = await this.ctx.storage.get([KEY, RUN]);
      const held = stored.get(KEY) as R | undefined;
      const run = stored.get(RUN) as string | undefined;
      if (!held) return;
      if (held.status !== 'copying') {
        // Kept for the route to read; gone once it has had its retention.
        if (Date.now() - held.updatedAt >= retainMs) await this.ctx.storage.deleteAll();
        else await this.ctx.storage.setAlarm(held.updatedAt + retainMs);
        return;
      }
      let next: R;
      try {
        next = await config.advance(this.env, held);
      } catch (err) {
        config.onError?.(err, this.env);
        // Not over a cancel's retention alarm, nor over the alarm a job started since has set.
        if (await this.stillRunning(run)) await this.ctx.storage.setAlarm(Date.now() + THREW_RETRY_MS);
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
