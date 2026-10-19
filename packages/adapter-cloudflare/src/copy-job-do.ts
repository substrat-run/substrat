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
 * `defineCopyJobDO` — one Durable Object per background scope copy (#2450, step 2).
 *
 * A preview's copy that outlasts the request that started it is stored here, and moved one step
 * per alarm: the step renews the move's lease and moves pages for a bounded time, then this object
 * schedules the next. A finished job (done, failed or cancelled) is kept for `retainMs`, for the
 * route's next call to read and settle, and then deleted.
 *
 * Alarms are one at a time per object, so two steps never run together. A `cancel` or `forget`
 * can arrive while a step's I/O is in flight; the step's answer is then dropped, so a cancelled job
 * stays cancelled and a forgotten one stays gone.
 */
export function defineCopyJobDO<Env, R extends CopyJobDoRecord>(
  config: CopyJobDoConfig<Env, R>,
): new (ctx: DurableObjectState, env: Env) => DurableObject<Env> & CopyJobDo<R> {
  const retainMs = config.retainMs ?? 24 * 3_600_000;
  return class CopyJobDO extends DurableObject<Env> {
    async start(record: R): Promise<R> {
      const held = await this.ctx.storage.get<R>(KEY);
      if (held) return held;
      await this.ctx.storage.put(KEY, record);
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

    async alarm(): Promise<void> {
      const held = await this.ctx.storage.get<R>(KEY);
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
        await this.ctx.storage.setAlarm(Date.now() + THREW_RETRY_MS);
        return;
      }
      // A cancel or forget that landed while the step ran wins: its answer is dropped.
      const now = await this.ctx.storage.get<R>(KEY);
      if (!now || now.status !== 'copying') return;
      await this.ctx.storage.put(KEY, next);
      await this.ctx.storage.setAlarm(
        next.status === 'copying' ? Date.now() + Math.max(0, next.nextDelayMs) : Date.now() + retainMs,
      );
    }
  };
}
