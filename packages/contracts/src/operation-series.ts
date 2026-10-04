/**
 * Business volumes on a clock (#1750): how many times each declared lifecycle move was
 * made per time bucket, counted from the outbox with no new write path.
 *
 * A lifecycle (#844) names the operation behind every edge, and the outbox records the
 * operation that emitted each event (#1243), so "how many conversations were closed in
 * this half hour" is a count of the calls that ran `close` on a conversation. What makes
 * that count exact rather than approximate is WHICH operations are counted, and that is
 * decided from the model, never from a hand-picked list: the dashboard's `lifecycleMovesOf` keeps only an
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
import { windowInstant } from './lifecycle-flow.js';

/** Longest window one read covers. Pulse asks for at most 72 hours plus a day to compare. */
export const OPERATION_SERIES_MAX_SPAN_MS = 7 * 86_400_000;
/** Most buckets one read answers per pair. */
export const OPERATION_SERIES_MAX_BUCKETS = 400;
/** Most `(entityType, operation)` pairs one read counts. */
export const OPERATION_SERIES_MAX_MOVES = 64;

/**
 * An instant the read's primary-key seek can encode: a ULID carries 48 bits of epoch
 * milliseconds, so the window must sit between the epoch and 10889 AD. Refused here, with
 * a validation error, rather than as a `RangeError` from `ulidFloor` inside the read.
 */
const MAX_ULID_TIME = 2 ** 48 - 1;
const seekable = windowInstant.refine(
  (v) => Date.parse(v) >= 0 && Date.parse(v) <= MAX_ULID_TIME,
  { message: 'instant is outside what an event id can encode (the epoch to 10889 AD)' },
);

/**
 * The input's fields, unrefined, so a route that adds its own (the vertical's `scopeId`) can
 * `.extend` it and apply `operationSeriesWindow` after, as `operationSeriesInput` does.
 */
export const operationSeriesShape = z.object({
    moves: z
      .array(z.object({ entityType: z.string().min(1).max(128), operation: z.string().min(1).max(256) }))
      .min(1)
      .max(OPERATION_SERIES_MAX_MOVES),
    /**
     * The window, half-open. `since` is also where the buckets are anchored: bucket `k` is
     * `[since + k·bucketMinutes, since + (k+1)·bucketMinutes)`, so a caller that wants
     * whole days counted can line them up with any instant it likes.
     */
    // Bucket edges are computed in whole seconds, so the anchor is one.
    since: seekable.refine((v) => Date.parse(v) % 1000 === 0, { message: 'since must be a whole second' }),
    until: seekable,
    bucketMinutes: z.number().int().positive().max(1440),
});

/** The window's own rules: ordered, at most seven days, at most the bucket cap. */
export function operationSeriesWindow(i: { since: string; until: string; bucketMinutes: number }, ctx: z.RefinementCtx): void {
  const span = Date.parse(i.until) - Date.parse(i.since);
  if (span <= 0) ctx.addIssue({ code: 'custom', message: 'until must be after since' });
  else if (span > OPERATION_SERIES_MAX_SPAN_MS) ctx.addIssue({ code: 'custom', message: 'window is longer than 7 days' });
  else if (span / (i.bucketMinutes * 60_000) > OPERATION_SERIES_MAX_BUCKETS) {
    ctx.addIssue({ code: 'custom', message: `window holds more than ${OPERATION_SERIES_MAX_BUCKETS} buckets` });
  }
}

export const operationSeriesInput = operationSeriesShape.superRefine(operationSeriesWindow);
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

/** What a read's K-24 row counts as returned: the moves it reported, over every pair. */
export const operationSeriesCount = (r: OperationSeriesResult): number => r.series.reduce((n, s) => n + s.total, 0);
