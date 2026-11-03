import { ENTITY_STATE_MOVE_TYPES, PAGE_CURSOR_RESTART, SubstratError } from '@substrat-run/contracts';
import { emittedHere } from './scope-copy.js';
import type { SwitchSql } from './system-switch.js';

/**
 * Outbox retention (#1334): the outbox is a transport buffer, and the lake is where history
 * lives once it has left. A drained row is kept this long after its stamp and is then
 * eligible to go. It is also the window a lake table rebuild (`redrainEvents`) can reach back
 * through, and the window `readHistory`, `readTimeline` and the scope walks cover.
 */
export const OUTBOX_RETENTION_DAYS = 90;

/** Rows pruned per scope per sweep pass. A backlog goes over several ticks, oldest stamp first. */
export const OUTBOX_PRUNE_BATCH = 500;

/**
 * The highest event id a prune ever removed (#1334), one row. A scope walk resumed from a
 * watermark below it may have lost rows to the prune, so it refuses (`WatermarkPruned`) rather
 * than answering with a silent hole. Kernel-owned and shared by both adapters' `KERNEL_DDL`,
 * like `_substrat_copy_origin`, so the two cannot part company. Travels in a scope's dump with
 * the outbox it describes.
 */
export const OUTBOX_PRUNED_DDL = `
  CREATE TABLE IF NOT EXISTS _substrat_outbox_pruned (
    -- Always 1: one floor per scope. No CHECK, because lint:spine-ddl compares none.
    id INTEGER PRIMARY KEY,
    through TEXT NOT NULL
  );
`;

/** The pruned-through floor, or none: what `assertWatermarkHeld` compares a watermark against. */
export const OUTBOX_PRUNED_THROUGH_SQL = 'SELECT through FROM _substrat_outbox_pruned WHERE id = 1';

/** One local subscriber to an event type: a module consumer (its module id) or an executor (`executor:<id>`). */
export interface OutboxSubscriber {
  deliveryId: string;
  eventType: string;
}

export interface OutboxPruneInput {
  /** Rows stamped drained strictly before this instant may go. */
  drainedBefore: string;
  limit: number;
  /** Every local subscriber this scope's code registers. A type with one not yet delivered keeps its rows. */
  subscribers: readonly OutboxSubscriber[];
  /** The types this deployment exports to other verticals (#1705). Kept whole: their readers' cursors live elsewhere. */
  exportTypes: readonly string[];
}

/**
 * Delete up to `limit` drained outbox rows that nothing here still needs (#1334), with their
 * delivery journal rows, and raise the pruned-through floor. Returns how many events went.
 * The caller runs it in one transaction on the scope's own writer.
 *
 * A row goes only when ALL of these hold:
 * - it was emitted here and stamped drained before `drainedBefore`, so the lake holds it and
 *   a rebuild could still have reached it;
 * - every local subscriber to its type has a terminal SUCCESS delivery for it. A pending retry
 *   or a dead letter keeps the row, since a replay reads it;
 * - its type is not exported to another vertical;
 * - a newer row about the same entity exists that is not a kernel state move. So the row an
 *   entity's version (`entityVersionOf`, the If-Match ETag) reads is never removed, and an
 *   entity never reads as untouched because its history aged out.
 *
 * Ids and subscribers travel as JSON arrays, on `exportReadQuery`'s reasoning (#1776): a DO
 * binds at most 100 parameters. The batch is chosen once and the deletes name its ids, so the
 * count is exactly what left.
 */
export function pruneDrainedOutbox(sql: SwitchSql, input: OutboxPruneInput): number {
  const ids = sql
    .all(
      `SELECT o.id AS id FROM _substrat_outbox o
        WHERE o.drained_at IS NOT NULL AND o.drained_at < ? AND ${emittedHere('o.')}
          AND o.type NOT IN (SELECT value FROM json_each(?))
          AND NOT EXISTS (
            SELECT 1 FROM json_each(?) s
             WHERE json_extract(s.value, '$.eventType') = o.type
               AND NOT EXISTS (
                 SELECT 1 FROM _substrat_deliveries d
                  WHERE d.event_id = o.id AND d.consumer_module = json_extract(s.value, '$.deliveryId')
                    AND d.next_attempt_at IS NULL AND d.error IS NULL))
          AND EXISTS (
            SELECT 1 FROM _substrat_outbox n
             WHERE n.entity_type = o.entity_type AND n.entity_id = o.entity_id AND n.id > o.id
               AND n.type NOT IN (SELECT value FROM json_each(?)))
        ORDER BY o.drained_at, o.id LIMIT ?`,
      input.drainedBefore,
      JSON.stringify(input.exportTypes),
      JSON.stringify(input.subscribers),
      JSON.stringify(ENTITY_STATE_MOVE_TYPES),
      input.limit,
    )
    .map((r) => r.id as string);
  if (ids.length === 0) return 0;
  const batch = JSON.stringify(ids);
  sql.run('DELETE FROM _substrat_deliveries WHERE event_id IN (SELECT value FROM json_each(?))', batch);
  sql.run('DELETE FROM _substrat_outbox WHERE id IN (SELECT value FROM json_each(?))', batch);
  const highest = ids.reduce((a, b) => (b > a ? b : a));
  sql.run(
    `INSERT INTO _substrat_outbox_pruned (id, through) VALUES (1, ?)
       ON CONFLICT (id) DO UPDATE SET through = MAX(through, excluded.through)`,
    highest,
  );
  return ids.length;
}

/**
 * A scope walk resumed from a watermark the prune may have reached below (#1334). The rows
 * after it are not all here any more, so the walk refuses instead of answering with a gap.
 * The mirror resyncs: read from the start (no cursor), which returns what the scope still
 * holds, and older history from the lake.
 */
export class WatermarkPruned extends SubstratError {
  constructor(watermark: string, prunedThrough: string) {
    super(
      'validation_failed',
      `watermark ${watermark} is below this scope's pruned history (through ${prunedThrough}); resync from the start`,
      { reason: PAGE_CURSOR_RESTART },
    );
  }
}
