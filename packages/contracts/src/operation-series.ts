/**
 * Business volumes on a clock (#1750): how many times each declared lifecycle move was
 * made per time bucket, counted from the outbox with no new write path.
 *
 * A lifecycle (#844) names the operation behind every edge, and the outbox records the
 * operation that emitted each event (#1243), so "how many conversations were closed in
 * this half hour" is a count of the calls that ran `close` on a conversation. What makes
 * that count exact rather than approximate is WHICH operations are counted, and that is
 * decided from the model, never from a hand-picked list: `lifecycleMovesOf` keeps only an
 * operation whose every appearance in the declaration is an edge into the same state.
 * Wherever else it is called, `assertTransition` refuses it and the call rolls back, so
 * each of its calls that left an event on the entity IS that move, and a GROUP BY can count
 * it. That holds while the code agrees with its model, the same caveat the replay's
 * inferred moves carry; the process map is where a disagreement shows. An operation the declaration also merely
 * allows somewhere (`ticket0/ingest-message` is allowed in `open` and an edge out of
 * `resolved`) is a move or not depending on the state the entity was in; only a replay
 * can tell, which is `readLifecycleFlow`'s job and not this read's.
 *
 * The read itself knows nothing of lifecycles: the caller passes `(entityType, operation)`
 * pairs, exactly as the process map's read is handed its declaration, because a scope has
 * no model of its own to consult.
 */
import { z } from 'zod';
import type { EmittedLifecycle } from './lifecycle.js';

/** Longest window one read covers. Pulse asks for at most 72 hours plus a day to compare. */
export const OPERATION_SERIES_MAX_SPAN_MS = 7 * 86_400_000;
/** Most buckets one read answers per pair. */
export const OPERATION_SERIES_MAX_BUCKETS = 400;
/** Most `(entityType, operation)` pairs one read counts. */
export const OPERATION_SERIES_MAX_MOVES = 64;

/** An instant `Date.parse` reads, to the whole second — bucket edges are computed in seconds. */
const instant = z
  .string()
  .min(1)
  .max(64)
  .refine((v) => !Number.isNaN(Date.parse(v)), { message: 'not an ISO 8601 instant' });

export const operationSeriesInput = z
  .object({
    moves: z
      .array(z.object({ entityType: z.string().min(1).max(128), operation: z.string().min(1).max(256) }))
      .min(1)
      .max(OPERATION_SERIES_MAX_MOVES),
    /**
     * The window, half-open. `since` is also where the buckets are anchored: bucket `k` is
     * `[since + k·bucketMinutes, since + (k+1)·bucketMinutes)`, so a caller that wants
     * whole days counted can line them up with any instant it likes.
     */
    since: instant.refine((v) => Date.parse(v) % 1000 === 0, { message: 'since must be a whole second' }),
    until: instant,
    bucketMinutes: z.number().int().positive().max(1440),
  })
  .refine((i) => Date.parse(i.until) > Date.parse(i.since), { message: 'until must be after since' })
  .refine((i) => Date.parse(i.until) - Date.parse(i.since) <= OPERATION_SERIES_MAX_SPAN_MS, {
    message: 'window is longer than 7 days',
  })
  .refine(
    (i) => (Date.parse(i.until) - Date.parse(i.since)) / (i.bucketMinutes * 60_000) <= OPERATION_SERIES_MAX_BUCKETS,
    { message: `window holds more than ${OPERATION_SERIES_MAX_BUCKETS} buckets` },
  );
export type OperationSeriesInput = z.infer<typeof operationSeriesInput>;

export const operationSeriesResult = z.object({
  since: z.string(),
  until: z.string(),
  bucketMinutes: z.number().int().positive(),
  /** One entry per pair asked for, in the order asked, including pairs nothing matched. */
  series: z.array(
    z.object({
      entityType: z.string(),
      operation: z.string(),
      /**
       * Calls that made the move inside the window: distinct `(entity, invocation)` pairs,
       * so a call that emitted three events about one record is one move. A row from
       * before invocation ids were stamped counts on its own.
       */
      total: z.number().int().nonnegative(),
      /** Only the buckets that saw a move, oldest first. A missing bucket is a zero. */
      buckets: z.array(z.object({ start: z.string(), count: z.number().int().positive() })),
    }),
  ),
});
export type OperationSeriesResult = z.infer<typeof operationSeriesResult>;

/**
 * One state a lifecycle can be counted into: the entity, the state, and the operations
 * whose every call on that entity is a move into it.
 */
export interface LifecycleMove {
  entityType: string;
  state: string;
  terminal: boolean;
  /** Every counted edge into this state leaves the initial state — what "opened" means. */
  fromInitial: boolean;
  operations: string[];
}

/**
 * The moves a declared lifecycle lets a GROUP BY count exactly (see the header).
 *
 * An operation qualifies when every appearance of it in the declaration is an `on` edge
 * into one and the same state, from a different state, and it is in no `allow` list.
 * States no qualifying operation reaches are left out rather than listed at zero: zero
 * would claim a count this read cannot make.
 */
export function lifecycleMovesOf(lifecycles: Record<string, EmittedLifecycle> | undefined): LifecycleMove[] {
  const out: LifecycleMove[] = [];
  for (const [entityType, lc] of Object.entries(lifecycles ?? {})) {
    const target = new Map<string, string | null>();
    const sources = new Map<string, Set<string>>();
    const disqualify = (op: string) => target.set(op, null);
    for (const [from, state] of Object.entries(lc.states)) {
      for (const op of state.allow ?? []) disqualify(op);
      for (const [op, to] of Object.entries(state.on ?? {})) {
        const seen = target.get(op);
        if (seen === null) continue;
        if (to === from || (seen !== undefined && seen !== to)) {
          disqualify(op);
          continue;
        }
        target.set(op, to);
        sources.set(op, (sources.get(op) ?? new Set()).add(from));
      }
    }
    const byState = new Map<string, string[]>();
    for (const [op, to] of target) {
      if (to === null || to === undefined) continue;
      byState.set(to, [...(byState.get(to) ?? []), op]);
    }
    for (const [state, operations] of [...byState.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      out.push({
        entityType,
        state,
        terminal: lc.states[state]?.terminal === true,
        fromInitial: operations.every((op) => [...(sources.get(op) ?? [])].every((s) => s === lc.initial)),
        operations: operations.sort(),
      });
    }
  }
  return out;
}

/** What a read's K-24 row counts as returned: the moves it reported, over every pair. */
export const operationSeriesCount = (r: OperationSeriesResult): number => r.series.reduce((n, s) => n + s.total, 0);
