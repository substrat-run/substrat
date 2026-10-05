/**
 * Business volumes on a clock (#1750): calls per `(entityType, operation)` per time bucket,
 * counted over a scope's outbox. Which pairs are worth counting is the caller's, derived
 * from the model by the dashboard's `lifecycleMovesOf` (see `@substrat-run/contracts`'s
 * `operation-series.ts` for why those counts are exact).
 *
 * ## Bounded, and index-backed with no new index
 *
 * The window is capped at seven days and the answer at `OPERATION_SERIES_MAX_BUCKETS` per
 * pair, and it is ONE aggregate statement: no row leaves SQLite, so there is no per-row
 * work on this side of it. The rows it scans are a CLOSED range of the primary key, so the
 * work is the window's rows whatever lies after it — a window years ago visits only its own.
 * An event id is minted from the instant the operation ran (#956) by a mint whose floor only
 * rises, so an id never carries a time BEFORE its own `occurred_at`: every event at or after
 * `since` has an id at or above `ulidFloor(since)`. The key range ends at
 * `ulidFloor(until + OPERATION_SERIES_ID_SLACK_MS)`, a fixed sliver past the window.
 * `occurred_at` stays the exact filter on both ends; the key range only bounds the scan.
 *
 * The slack is for ids that run AHEAD of their instants. `createUlid` (ulid.ts) holds a
 * clock that is at or behind its floor at `lastTime` — and bumps a millisecond on the
 * (astronomically rare) random overflow — and `seedFrom` raises that floor to the outbox's
 * `MAX(id)` when a writer wakes. So an event in the window's last moments can carry an id
 * past `until`, by as much as the clock stepped back. The mint itself sets no bound on
 * that; the wall clock does: the Durable Object host reads the platform's NTP-disciplined
 * clock, whose corrections are sub-second. `OPERATION_SERIES_ID_SLACK_MS` covers that with
 * two orders of margin, at the cost of scanning one more minute of rows. `occurred_at`
 * stays the exact filter, so the slack admits rows to the scan, never to the count.
 *
 * Past the slack, stated: a step back larger than a minute (a pure host's injected clock
 * rewound by hand, a floor seeded from an id planted in the future) leaves an id beyond
 * the range, and that event is not counted by a window ending before its id.
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

/**
 * How far past `until` the key range reaches, for an id held at the mint's floor while its
 * instant was inside the window (see the header for where the size comes from).
 */
export const OPERATION_SERIES_ID_SLACK_MS = 60_000;

/** Joins a pair into one key — a control character no entity or operation name carries. */
const SEP = '\u001f';

/**
 * The read's one statement and its parameters — exported so each adapter's suite can ask
 * its own SQLite for the plan of exactly what runs, not a copy of it.
 */
export function operationSeriesQuery(input: OperationSeriesInput): { sql: string; params: Array<string | number> } {
  const sinceMs = Date.parse(input.since);
  const untilMs = Date.parse(input.until);
  const keys = [...new Set(input.moves.map((m) => `${m.entityType}${SEP}${m.operation}`))];
  // A distinct (entity, call) is one move: a call that emitted three events about one
  // record moved it once. A row from before invocation ids falls back to its own id.
  return {
    sql: `SELECT entity_type, operation,
            (CAST(strftime('%s', occurred_at) AS INTEGER) - CAST(? AS INTEGER)) / CAST(? AS INTEGER) AS b,
            COUNT(DISTINCT entity_id || char(31) || COALESCE(invocation_id, id)) AS n
       FROM _substrat_outbox
      WHERE id >= ? AND id < ? AND occurred_at >= ? AND occurred_at < ?
        AND entity_type || char(31) || operation IN (SELECT value FROM json_each(?))
      GROUP BY entity_type, operation, b
      ORDER BY b`,
    params: [
      sinceMs / 1000,
      input.bucketMinutes * 60,
      ulidFloor(sinceMs),
      // `until` is at most the end of 9999 (the input schema's bound), so a minute past it is
      // far inside what a ULID encodes: `ulidFloor` cannot throw here.
      ulidFloor(untilMs + OPERATION_SERIES_ID_SLACK_MS),
      new Date(sinceMs).toISOString(),
      new Date(untilMs).toISOString(),
      JSON.stringify(keys),
    ],
  };
}

export function readOperationSeries(ctx: TimelineReader, input: OperationSeriesInput): OperationSeriesResult {
  const sinceMs = Date.parse(input.since);
  const step = input.bucketMinutes * 60;
  const q = operationSeriesQuery(input);
  const rows = ctx.sql.query<{ entity_type: string; operation: string; b: number; n: number }>(q.sql, q.params);
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
