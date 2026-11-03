import { ENTITY_STATE_MOVE_TYPES, PAGE_CURSOR_RESTART, SubstratError, instant, substratError, z } from '@substrat-run/contracts';
import { emittedHere } from './scope-copy.js';
import type { SwitchSql } from './system-switch.js';
import { EXPORT_HOPS_SQL } from './vertical-events.js';

/**
 * Outbox retention (#1334): the outbox is a transport buffer, and the lake is where history
 * lives once it has left. A drained row is kept this long after its stamp and is then
 * eligible to go. It is also the window a lake table rebuild (`redrainEvents`) can reach back
 * through, and the window `readHistory`, `readTimeline`, the scope walks and every view over
 * the outbox (facets, lifecycle flow, operation series, freshness) cover.
 */
export const OUTBOX_RETENTION_DAYS = 90;

/** Rows deleted per pass at most. */
export const OUTBOX_PRUNE_BATCH = 500;

/**
 * Index entries one pass examines at most, from where the last pass stopped. Bounds a pass's
 * cost whatever the scope's lifetime history: rows that never qualify (an entity's only event,
 * a dead letter, an exported type) are stepped past once per lap, not rescanned every pass.
 */
export const OUTBOX_PRUNE_SCAN = 2000;

/**
 * The prune's state (#1334), one row. `through` is the highest event id a prune ever removed:
 * a scope walk resumed below it may have lost rows, so it refuses (`WatermarkPruned`) rather
 * than answering with a silent hole. `scan_at`/`scan_id` are the `(drained_at, id)` position a
 * lap stopped at when it hit a cap; NULL between laps. Kernel-owned and shared by both adapters'
 * `KERNEL_DDL`, like `_substrat_copy_origin`, so the two cannot part company. Travels in a
 * scope's dump with the outbox it describes.
 */
export const OUTBOX_PRUNED_DDL = `
  CREATE TABLE IF NOT EXISTS _substrat_outbox_pruned (
    -- Always 1: one row per scope. No CHECK, because lint:spine-ddl compares none.
    id INTEGER PRIMARY KEY,
    through TEXT NOT NULL,
    scan_at TEXT,
    scan_id TEXT
  );
`;

/** The pruned-through floor, or none: what a scope walk compares its cursor against. */
export const OUTBOX_PRUNED_THROUGH_SQL = 'SELECT through FROM _substrat_outbox_pruned WHERE id = 1';

/** One local subscriber to an event type: a module consumer (its module id) or an executor (`executor:<id>`). */
export interface OutboxSubscriber {
  deliveryId: string;
  eventType: string;
}

/** The subscribers a host's registrations make: each module's consumers, then each executor. */
export function outboxSubscribersOf(
  modules: Iterable<{ id: string; consumers: readonly { eventType: string }[] }>,
  executors: Iterable<[string, { eventType: string }]>,
): OutboxSubscriber[] {
  return [
    ...[...modules].flatMap((mod) => mod.consumers.map((c) => ({ deliveryId: mod.id, eventType: c.eventType }))),
    ...[...executors].map(([id, e]) => ({ deliveryId: `executor:${id}`, eventType: e.eventType })),
  ];
}

/**
 * Whether this is the scope's hour to start a prune lap: one UTC hour a day, spread across the
 * fleet by the scope id. A lap that finishes inside that hour lets the next pass start another,
 * so a small scope runs up to about four laps a day at a 15-minute sweep. A lap that stopped at a
 * cap continues on every pass regardless, so a backlog drains at the sweep's cadence and only a
 * scope that is caught up waits for its hour.
 */
export function outboxPruneDue(scopeId: string, nowMs: number): boolean {
  let h = 2166136261;
  for (let i = 0; i < scopeId.length; i++) h = Math.imul(h ^ scopeId.charCodeAt(i), 16777619);
  return (h >>> 0) % 24 === new Date(nowMs).getUTCHours();
}

/** `HostAdmin.pruneDrainedEvents`' input, as both adapters and the vertical-host route parse it. */
export const pruneDrainedEventsInput = z.object({
  drainedBefore: instant,
  limit: z.number().int().min(1).max(1000),
  /** Start a new lap when none is in progress (`outboxPruneDue`). Omitted: start one now. */
  due: z.boolean().optional(),
});
export type PruneDrainedEventsInput = z.input<typeof pruneDrainedEventsInput>;

/**
 * Parse the verb's input and refuse a horizon in the future: it would prune rows the
 * retention window still covers. Host code, so `now` is the real clock.
 */
export function pruneInputOf(raw: unknown, now: string): z.infer<typeof pruneDrainedEventsInput> {
  const input = pruneDrainedEventsInput.parse(raw);
  if (Date.parse(input.drainedBefore) > Date.parse(now)) {
    throw substratError('validation_failed', `drainedBefore ${input.drainedBefore} is in the future`, {
      errors: [{ path: 'drainedBefore', message: 'must not be in the future' }],
    });
  }
  return input;
}

export interface OutboxPruneInput {
  /** Rows stamped drained strictly before this instant may go. */
  drainedBefore: string;
  /** Rows deleted at most (`OUTBOX_PRUNE_BATCH`). */
  limit: number;
  /** Index entries examined at most. Default `OUTBOX_PRUNE_SCAN`. */
  scanLimit?: number;
  /** Start a new lap when none is in progress. A lap already in progress always continues. */
  due: boolean;
  /** Every local subscriber this scope's code registers. A type with one not yet delivered keeps its rows. */
  subscribers: readonly OutboxSubscriber[];
  /** The types this deployment exports to other verticals (#1705). Kept whole: their readers' cursors live elsewhere. */
  exportTypes: readonly string[];
}

/**
 * One prune pass (#1334): examine up to `scanLimit` drained rows from where the last pass
 * stopped, delete up to `limit` of them that nothing here still needs, with their delivery
 * journal rows, and raise the floor. Returns how many events went. The caller runs it in one
 * transaction on the scope's own writer.
 *
 * A row goes only when ALL of these hold:
 * - it was emitted here and stamped drained before `drainedBefore`, so the lake holds it and
 *   a rebuild could still have reached it;
 * - every local subscriber to its type has a terminal SUCCESS delivery for it. A pending retry,
 *   a dead letter or an executor's refusal keeps the row, since a replay reads it;
 * - its type is not exported to another vertical;
 * - a newer row about the same entity exists that is not a kernel state move, so the row an
 *   entity's version (`entityVersionOf`, the If-Match ETag) reads is never removed;
 * - a newer row of the same type exists, so "when did this type last happen" (freshness) is
 *   never answered by a prune;
 * - its own cause chain does not reach an imported event (#1705): an export's hop count walks
 *   `caused_by` back to the nearest import, and a missing link there would reset it.
 *
 * A pass that hits either cap stores its position, and the next pass continues from there
 * whatever `due` says: a backlog drains at the sweep's cadence. A pass that reaches the end of
 * the window clears the position, and the next lap waits for `due`.
 */
export function pruneDrainedOutbox(sql: SwitchSql, input: OutboxPruneInput): number {
  const state = sql.all('SELECT scan_at, scan_id FROM _substrat_outbox_pruned WHERE id = 1')[0] as
    | { scan_at: string | null; scan_id: string | null }
    | undefined;
  const at = state?.scan_at ?? null;
  if (at === null && !input.due) return 0;
  const scanLimit = input.scanLimit ?? OUTBOX_PRUNE_SCAN;
  const scanned = sql.all(
    `SELECT id, drained_at FROM _substrat_outbox
      WHERE drained_at IS NOT NULL AND drained_at < ? AND (drained_at, id) > (?, ?)
      ORDER BY drained_at, id LIMIT ?`,
    input.drainedBefore,
    at ?? '',
    state?.scan_id ?? '',
    scanLimit,
  ) as { id: string; drained_at: string }[];
  const judged = sql
    .all(
      `SELECT o.id AS id FROM json_each(?) s JOIN _substrat_outbox o ON o.id = s.value
        WHERE ${emittedHere('o.')}
          AND o.type NOT IN (SELECT value FROM json_each(?))
          AND NOT EXISTS (
            SELECT 1 FROM json_each(?) sub
             WHERE json_extract(sub.value, '$.eventType') = o.type
               AND NOT EXISTS (
                 SELECT 1 FROM _substrat_deliveries d
                  WHERE d.event_id = o.id AND d.consumer_module = json_extract(sub.value, '$.deliveryId')
                    AND d.next_attempt_at IS NULL AND d.error IS NULL))
          AND EXISTS (
            SELECT 1 FROM _substrat_outbox n
             WHERE n.entity_type = o.entity_type AND n.entity_id = o.entity_id AND n.id > o.id
               AND n.type NOT IN (SELECT value FROM json_each(?)))
          AND EXISTS (SELECT 1 FROM _substrat_outbox t WHERE t.type = o.type AND t.id > o.id)
        ORDER BY s.key LIMIT ?`,
      JSON.stringify(scanned.map((r) => r.id)),
      JSON.stringify(input.exportTypes),
      JSON.stringify(input.subscribers),
      JSON.stringify(ENTITY_STATE_MOVE_TYPES),
      input.limit,
    )
    .map((r) => r.id as string);
  // #1705: an export's hop count walks `caused_by` back to the nearest import. A row whose own
  // chain reaches one is a link some exported row may still need, so it stays; a row whose
  // chain reaches none cannot change any count, since the walk past it would find none either.
  // Primary-key steps only, and only in a scope that has imported anything.
  const imports = sql.all('SELECT 1 FROM _substrat_imports LIMIT 1').length > 0;
  const ids = imports ? judged.filter((id) => sql.all(EXPORT_HOPS_SQL, id).length === 0) : judged;
  // Where the next pass starts: after the last row this one deleted when the delete cap stopped
  // it (the rows behind that were not judged), after the last row it examined when the scan cap
  // did, and nowhere (a new lap, when due) when it reached the end of the window.
  const stopAt =
    judged.length === input.limit
      ? scanned.find((r) => r.id === judged[judged.length - 1])!
      : scanned.length === scanLimit
        ? scanned[scanned.length - 1]!
        : null;
  if (ids.length > 0) {
    const batch = JSON.stringify(ids);
    sql.run('DELETE FROM _substrat_deliveries WHERE event_id IN (SELECT value FROM json_each(?))', batch);
    sql.run('DELETE FROM _substrat_outbox WHERE id IN (SELECT value FROM json_each(?))', batch);
  }
  const highest = ids.reduce((a, b) => (b > a ? b : a), '');
  sql.run(
    `INSERT INTO _substrat_outbox_pruned (id, through, scan_at, scan_id) VALUES (1, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET through = MAX(through, excluded.through),
         scan_at = excluded.scan_at, scan_id = excluded.scan_id`,
    highest,
    stopAt?.drained_at ?? null,
    stopAt?.id ?? null,
  );
  return ids.length;
}

/**
 * A scope walk resumed from a position the prune may have reached below (#1334): a bare
 * watermark under the floor, or a continuation minted before a later prune moved it. The rows
 * after it are not all here any more, so the walk refuses instead of answering with a gap. The
 * mirror resyncs: read from the start (no cursor), which returns what the scope still holds,
 * and older history from the lake.
 */
export class WatermarkPruned extends SubstratError {
  constructor(cursor: string, prunedThrough: string) {
    super(
      'validation_failed',
      `cursor ${cursor} is below this scope's pruned history (through ${prunedThrough}); resync from the start`,
      { reason: PAGE_CURSOR_RESTART },
    );
  }
}

/**
 * The continuation a scope walk hands out below the floor: the id and the floor it was minted
 * under. Above the floor a cursor is the bare id, as it always was.
 */
const CONTINUATION = '~';

/**
 * Resolve an ascending scope walk's cursor against the floor: the id to walk after, or a
 * `WatermarkPruned`. A bare id below the floor is a stale watermark; a continuation is honoured
 * only while the floor it names is still the floor.
 */
export function walkCursorPastFloor(cursor: string, floor: string | undefined): string {
  const at = cursor.indexOf(CONTINUATION);
  if (at === -1) {
    if (floor !== undefined && cursor < floor) throw new WatermarkPruned(cursor, floor);
    return cursor;
  }
  const id = cursor.slice(0, at);
  if (cursor.slice(at + 1) !== (floor ?? '')) throw new WatermarkPruned(id, floor ?? '');
  return id;
}

/** The `nextCursor` an ascending scope walk hands out: a continuation below the floor, the bare id above it. */
export function walkCursorAt(id: string | null, floor: string | undefined): string | null {
  return id !== null && floor !== undefined && id < floor ? `${id}${CONTINUATION}${floor}` : id;
}
