/**
 * Business volumes on a clock (#1750): calls per `(entityType, operation)` per time bucket,
 * counted over a scope's outbox. Which pairs are worth counting is the caller's, derived
 * from the model by `lifecycleMovesOf` (see `@substrat-run/contracts`'s
 * `operation-series.ts` for why those counts are exact).
 *
 * ## Bounded, and index-backed with no new index
 *
 * The window is capped at seven days and the answer at `OPERATION_SERIES_MAX_BUCKETS` per
 * pair, and it is ONE aggregate statement: no row leaves SQLite, so there is no per-row
 * work on this side of it. The rows it scans are a range of the primary key. An event id is
 * minted from the instant the operation ran (#956) by a mint whose floor only rises, so an
 * id never carries a time BEFORE its own `occurred_at` — every event at or after `since`
 * has an id at or above `ulidFloor(since)`, and the seek starts there. The upper end is
 * judged on `occurred_at` alone, because a clock that stepped back is held at the floor
 * and its ids can run ahead of their instants.
 *
 * The bucket arithmetic casts its parameters: a driver may bind a JS number as REAL, and
 * then the division would place an event at its own instant instead of its bucket's start.
 *
 * The pairs go in as ONE bound JSON array, matched with `json_each`, rather than a
 * placeholder each: 64 pairs as two `IN` lists is 128 parameters, past the Durable
 * Object's 100.
 *
 * Same permission posture as every read in `timeline.ts`: the caller checks, this does not.
 */
import type { OperationSeriesInput, OperationSeriesResult } from '@substrat-run/contracts';
import type { TimelineReader } from './timeline.js';
import { ulidFloor } from './ulid.js';

/** Joins a pair into one key — a control character no entity or operation name carries. */
const SEP = '\u001f';

export function readOperationSeries(ctx: TimelineReader, input: OperationSeriesInput): OperationSeriesResult {
  const sinceMs = Date.parse(input.since);
  const untilMs = Date.parse(input.until);
  const step = input.bucketMinutes * 60;
  const keys = [...new Set(input.moves.map((m) => `${m.entityType}${SEP}${m.operation}`))];
  // A distinct (entity, call) is one move: a call that emitted three events about one
  // record moved it once. A row from before invocation ids falls back to its own id.
  const rows = ctx.sql.query<{ entity_type: string; operation: string; b: number; n: number }>(
    `SELECT entity_type, operation,
            (CAST(strftime('%s', occurred_at) AS INTEGER) - CAST(? AS INTEGER)) / CAST(? AS INTEGER) AS b,
            COUNT(DISTINCT entity_id || char(31) || COALESCE(invocation_id, id)) AS n
       FROM _substrat_outbox
      WHERE id >= ? AND occurred_at >= ? AND occurred_at < ?
        AND entity_type || char(31) || operation IN (SELECT value FROM json_each(?))
      GROUP BY entity_type, operation, b
      ORDER BY b`,
    [sinceMs / 1000, step, ulidFloor(sinceMs), new Date(sinceMs).toISOString(), new Date(untilMs).toISOString(), JSON.stringify(keys)],
  );
  const counted = new Map<string, Array<{ start: string; count: number }>>();
  for (const r of rows) {
    const key = `${r.entity_type}${SEP}${r.operation}`;
    const list = counted.get(key) ?? [];
    list.push({ start: new Date(sinceMs + r.b * step * 1000).toISOString(), count: r.n });
    counted.set(key, list);
  }
  return {
    since: input.since,
    until: input.until,
    bucketMinutes: input.bucketMinutes,
    series: input.moves.map((m) => {
      const buckets = counted.get(`${m.entityType}${SEP}${m.operation}`) ?? [];
      return { entityType: m.entityType, operation: m.operation, total: buckets.reduce((n, b) => n + b.count, 0), buckets };
    }),
  };
}
