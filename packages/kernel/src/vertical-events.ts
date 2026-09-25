/**
 * Cross-vertical event delivery (#1705): the half both adapters share.
 *
 * A vertical exports an event type by declaring it (`events.exports`), and another vertical of
 * the same tenant imports it by declaring `events.consumes: [{ from, … }]`. Nothing is written
 * when an exported event commits. The producer's outbox is retained and is already the durable
 * record, so an export is a READ over it, and a consumer's progress is a watermark the consumer
 * keeps. Each platform sweep pass then:
 *
 *   1. asks the consumer scope for its watermark on this producer (`IMPORT_CURSORS_SQL`);
 *   2. reads the producer's outbox after it, in the producer's own scope, through its own
 *      running `exports` (`exportReadQuery` + `planExportBatch`);
 *   3. hands the batch to the consumer, which journals each event and runs its handlers,
 *      then moves the watermark in the same store (`IMPORT_CURSOR_ADVANCE_SQL`).
 *
 * The tables here are the consumer's half of that, and they hold NO payload. The event's only
 * copy stays in the producer's outbox, where a subject erasure already reaches. An imported
 * payload would be one more resting copy for the erasure to find, and #1600 and #1632 were
 * each about a copy it had missed. What the consumer keeps is the envelope. That is enough to
 * dedupe, to show a dead letter, and to resolve a `caused_by` that points across the edge.
 *
 * Shared from here for `CAPABILITY_DDL`'s reason: the self-host builds these tables and
 * production builds them, and one definition is what keeps the two identical.
 * `lint:spine-ddl` holds each adapter to including it.
 */

import {
  EXPORT_HOP_CAP,
  substratError,
  type ConsumedEventRef,
  type ImportCursorMove,
  type ImportCursorMoved,
  type ScopeId,
  type TenantId,
  type VerticalResolution,
  type EventExport,
  type ModuleManifest,
  type ExportedBatch,
  type ExportedEvent,
  type WantedEvent,
  type WithheldEvent,
} from '@substrat-run/contracts';
import { domainEventOf, type OutboxEnvelopeRow } from './outbox-event.js';
import type { ImportHandler } from './scope-host.js';
import { ulidCeiling } from './ulid.js';
import type { SwitchSql } from './system-switch.js';

export const VERTICAL_EVENTS_DDL = `
  -- #1705: every event this scope has received from another vertical. The envelope only, and
  -- never the payload. The producer's outbox keeps the one copy, where erasure already reaches.
  CREATE TABLE IF NOT EXISTS _substrat_imports (
    -- The PRODUCER's event id. A ULID the producer's host minted, so it is unique across
    -- every source this scope imports from, and it is the dedupe key: a batch delivered
    -- twice finds its events here and its handlers' journal rows in _substrat_deliveries.
    event_id TEXT PRIMARY KEY,
    source_scope_id TEXT NOT NULL,
    source_vertical TEXT NOT NULL,
    type TEXT NOT NULL,
    schema_version INTEGER NOT NULL,
    occurred_at TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    -- How many vertical boundaries this event's cause chain has crossed, this one included.
    -- An export read in THIS scope counts from here when one of its own events was caused by
    -- an import, which is how a loop between two verticals is stopped.
    hops INTEGER NOT NULL,
    -- NULL: released, and handed to this scope's handlers. Otherwise the producer's reason
    -- for NOT releasing it ('pii', 'version', 'cascade', 'undecodable'). Such a row was
    -- named but never carried.
    withheld TEXT,
    imported_at TEXT NOT NULL
  );
  -- #1705: how far this scope has read each producer. Written in the same store as the
  -- handlers' writes, so a restore of this scope rewinds the watermark with the data and the
  -- producer re-delivers what the restore undid. A watermark the platform held instead would
  -- skip it.
  CREATE TABLE IF NOT EXISTS _substrat_import_cursors (
    source_scope_id TEXT PRIMARY KEY,
    source_vertical TEXT NOT NULL,
    -- The id of the last producer row the reads walked (released or withheld). NULL is not
    -- stored: a producer with no row here has never been read, which the absence says.
    cursor TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  -- #1705: the export read, on the PRODUCER side. It asks for a few types after a watermark,
  -- in id order. Without this index SQLite walks the primary key from the watermark forward and
  -- steps over every row of every other type. A consumer that is caught up would then pay, on
  -- every pass, for all the unexported activity since the last exported event. With it, the read
  -- seeks each type's range and costs what it returns.
  CREATE INDEX IF NOT EXISTS _substrat_outbox_type_id ON _substrat_outbox (type, id);
  -- #1705 PR 3: what a REPLAY moved out of the live journal. A replay re-delivers events this
  -- scope already took, and the live tables are also the dedupe (a row in _substrat_deliveries
  -- means "do not run this handler again"). So the rows for the replayed range leave them. They
  -- are moved here rather than dropped, because they are the record that a handler ran on an
  -- event, when, and what it reported: evidence the spine keeps. One row per moved row, the
  -- whole row as JSON under the replay that moved it. Nothing reads this to deliver.
  -- ERASURE: today no erasure path touches imported copies, because only piiClass 'none' crosses
  -- and the delivery-error rewrite (#1632) reaches only this scope's OWN outbox events. If a
  -- consumer-side erasure of imported copies is ever added, it must reach \`row\` here too (a
  -- moved delivery row's \`error\` is a handler's own sentence), or the history keeps what the
  -- live tables gave up. Follow-up: #1757.
  CREATE TABLE IF NOT EXISTS _substrat_import_replays (
    -- The act (a ULID). The admin log's row for the replay carries the same id.
    replay_id TEXT NOT NULL,
    replayed_at TEXT NOT NULL,
    source_scope_id TEXT NOT NULL,
    -- 'journal': a _substrat_imports row. 'delivery': a _substrat_deliveries row.
    kind TEXT NOT NULL,
    event_id TEXT NOT NULL,
    -- The handler's module on a 'delivery' row, and '' on a 'journal' row.
    consumer_module TEXT NOT NULL,
    row TEXT NOT NULL,
    PRIMARY KEY (replay_id, kind, event_id, consumer_module)
  );
`;

/**
 * The producer-side read: rows of the given types after the watermark, oldest first.
 *
 * `types` is already the intersection of what the consumer wants and what this scope exports.
 * The caller computes it from its own registered manifests, never from the request alone, so
 * nothing here can widen what leaves.
 */
export function exportReadQuery(
  types: readonly string[],
  after: string | null,
  limit: number,
): { sql: string; params: unknown[] } {
  if (types.length === 0) throw new Error('exportReadQuery: no types to read');
  const placeholders = types.map(() => '?').join(', ');
  return {
    sql:
      `SELECT * FROM _substrat_outbox WHERE type IN (${placeholders})` +
      (after === null ? '' : ' AND id > ?') +
      ' ORDER BY id LIMIT ?',
    params: [...types, ...(after === null ? [] : [after]), limit],
  };
}

/**
 * How many vertical boundaries the cause chain of an outbox row with this `caused_by` has
 * already crossed. The answer is the `hops` of the NEAREST import in its chain, or no row when
 * the chain never crossed one.
 *
 * Walks `caused_by` backwards through this scope's outbox. The chain ends at an import, which
 * is in `_substrat_imports` and not in the outbox, or at an event nothing caused. Bounded at 64
 * steps: a chain that long inside ONE scope has already been cut many times by the per-call
 * cascade cap. Past the bound, the row counts as having crossed nothing. That under-counts, and
 * it is stated rather than hidden. It can only let a loop run for more passes than the cap
 * intends. It cannot release an event that should not cross.
 */
export const EXPORT_HOPS_SQL = `
  WITH RECURSIVE chain(id, depth) AS (
    SELECT ?, 0
    UNION ALL
    SELECT o.caused_by, c.depth + 1
      FROM chain c JOIN _substrat_outbox o ON o.id = c.id
     WHERE o.caused_by IS NOT NULL AND c.depth < 64
  )
  SELECT i.hops AS hops FROM chain c JOIN _substrat_imports i ON i.event_id = c.id
   ORDER BY c.depth LIMIT 1
`;

/** A stored outbox row, as the export read sees it: the envelope, plus the cause column. */
export type ExportRow = OutboxEnvelopeRow & { caused_by?: string | null };

/**
 * The producer-side decision, over rows already read: what is released, what is withheld and
 * why, and the watermark the consumer should hold afterwards.
 *
 * Pure, so both adapters make the same decision about the same rows. Authority is NOT decided
 * here. The adapter checks the consumer's principal before it reads anything, and a missing
 * key pauses the edge without walking a row. Every reason this function withholds for is
 * fixed at write time (the classification, the version, the cause chain, the stored text),
 * so stepping the watermark past a withheld row can never lose an event that a later pass
 * would have released.
 */
export function planExportBatch(input: {
  rows: readonly ExportRow[];
  /** What the consumer declares it takes, by type. */
  wanted: ReadonlyMap<string, number>;
  /** How many boundaries a row's cause chain already crossed (0 = none). */
  hopsBefore: (row: ExportRow) => number;
  after: string | null;
  limit: number;
  hopCap?: number;
}): Pick<ExportedBatch, 'events' | 'withheld' | 'next' | 'more'> {
  const cap = input.hopCap ?? EXPORT_HOP_CAP;
  const events: ExportedEvent[] = [];
  const withheld: WithheldEvent[] = [];
  const withhold = (row: ExportRow, reason: WithheldEvent['reason']): void => {
    withheld.push({
      id: row.id as WithheldEvent['id'],
      type: row.type,
      schemaVersion: row.schema_version,
      occurredAt: row.occurred_at,
      entity: { entityType: row.entity_type, entityId: row.entity_id },
      reason,
    });
  };
  for (const row of input.rows) {
    // Classification first: a classified row is withheld whatever else is true of it. The
    // other reasons would also withhold it, but the one a reader is told must be the one
    // that answers "why did this not cross".
    if (row.pii_class !== 'none') {
      withhold(row, 'pii');
      continue;
    }
    if (input.wanted.get(row.type) !== row.schema_version) {
      withhold(row, 'version');
      continue;
    }
    const hops = input.hopsBefore(row) + 1;
    if (hops > cap) {
      withhold(row, 'cascade');
      continue;
    }
    let decoded;
    try {
      decoded = domainEventOf(row);
    } catch {
      // The reason and nothing else. The decode's own message names columns, and it
      // must not travel: it is written into the consumer's dead letter, in another
      // vertical's scope.
      withhold(row, 'undecodable');
      continue;
    }
    events.push({
      id: decoded.id,
      type: decoded.type,
      schemaVersion: decoded.schemaVersion,
      occurredAt: decoded.occurredAt,
      entity: decoded.entity,
      payload: decoded.payload,
      hops,
    });
  }
  const last = input.rows[input.rows.length - 1];
  return {
    events,
    withheld,
    next: (last?.id ?? input.after) as ExportedBatch['next'],
    more: input.rows.length === input.limit,
  };
}

/**
 * The read plan for one request: which types to read, which keys the consumer must hold for
 * them, and what it asked for that this scope does not export.
 *
 * `exports` is THIS scope's running declaration, the union over its registered modules. A
 * wanted type absent from it is reported and never read. That is the producer's own code
 * deciding what leaves, whatever the platform asked for.
 */
export function exportReadPlan(
  exports: ReadonlyMap<string, EventExport>,
  wants: readonly WantedEvent[],
): { types: string[]; keys: string[]; wanted: Map<string, number>; unexported: WantedEvent[] } {
  const types: string[] = [];
  const keys = new Set<string>();
  const wanted = new Map<string, number>();
  const unexported: WantedEvent[] = [];
  for (const w of wants) {
    const e = exports.get(w.type);
    if (!e) {
      unexported.push(w);
      continue;
    }
    if (!wanted.has(w.type)) types.push(w.type);
    wanted.set(w.type, w.schemaVersion);
    keys.add(e.readPermission);
  }
  return { types: types.sort(), keys: [...keys].sort(), wanted, unexported };
}

/** Every (type → export) the given manifests declare. The caller's registration refuses conflicts. */
export function exportsOf(
  manifests: readonly { events: { exports?: readonly EventExport[] } }[],
): Map<string, EventExport> {
  const out = new Map<string, EventExport>();
  for (const m of manifests) for (const e of m.events.exports ?? []) if (!out.has(e.type)) out.set(e.type, e);
  return out;
}

/**
 * The outbox's insertion mark (#1705 PR 2): the kick's "before", taken ahead of an invoke.
 *
 * `rowid`, not the event id. A ULID minted in the same millisecond as the newest row can sort
 * BELOW it, so "ids above the newest id" can miss an event this invoke wrote. SQLite assigns a
 * new row `max(rowid) + 1` while the newest row is still there. No code path deletes outbox rows
 * inside an invoke: the only removals are a restore and a wipe, and they replace the whole table
 * outside any invocation. So every row the invoke and its consumers add sits above the mark. If
 * that ever stopped being true, the effect is bounded: an exported event would miss its kick and
 * wait for the sweep, and no event would be lost or sent twice.
 */
export const OUTBOX_MARK_SQL = 'SELECT COALESCE(MAX(rowid), 0) AS mark FROM _substrat_outbox';

/**
 * How many rows of the exported `types` were added after `mark` (#1705 PR 2). This is the
 * count `ScopeStubOptions.onExportedEvents` reports. A seek on the rowid, so it walks only
 * what the invoke added. Callers skip it entirely when the deployment exports nothing.
 */
export function exportedSinceQuery(types: readonly string[], mark: number): { sql: string; params: unknown[] } {
  if (types.length === 0) throw new Error('exportedSinceQuery: no types to count');
  return {
    sql: `SELECT COUNT(*) AS n FROM _substrat_outbox WHERE rowid > ? AND type IN (${types.map(() => '?').join(', ')})`,
    params: [mark, ...types],
  };
}

/** The consumer's watermark per producer, oldest source first. */
export const IMPORT_CURSORS_SQL =
  'SELECT source_scope_id, source_vertical, cursor, updated_at FROM _substrat_import_cursors ORDER BY source_scope_id';

/** One producer's watermark, for the compare-and-set a batch is applied under. */
export const IMPORT_CURSOR_OF_SQL = 'SELECT cursor FROM _substrat_import_cursors WHERE source_scope_id = ?';

/**
 * Move one producer's watermark. Params: (source_scope_id, source_vertical, cursor, updated_at).
 *
 * Only ever forward. ULIDs sort by time, and a batch's `next` is the last id its read walked,
 * so a smaller value can only come from a pass that read less than one already applied. The
 * batch's own compare-and-set normally refuses that pass before it gets here, and this is the
 * second line.
 */
export const IMPORT_CURSOR_ADVANCE_SQL = `
  INSERT INTO _substrat_import_cursors (source_scope_id, source_vertical, cursor, updated_at)
  VALUES (?, ?, ?, ?)
  ON CONFLICT (source_scope_id) DO UPDATE SET
    source_vertical = excluded.source_vertical,
    cursor = excluded.cursor,
    updated_at = excluded.updated_at
  WHERE excluded.cursor > _substrat_import_cursors.cursor
`;

/**
 * Journal one received (or withheld) event's envelope. Params in column order. Ignored on a
 * repeat: the first journaling is the fact, and a redelivered batch must not move
 * `imported_at` forward or rewrite what was withheld and why.
 */
export const IMPORT_RECORD_SQL = `
  INSERT OR IGNORE INTO _substrat_imports
    (event_id, source_scope_id, source_vertical, type, schema_version, occurred_at,
     entity_type, entity_id, hops, withheld, imported_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

// -- the replay lever (#1705 PR 3) -----------------------------------------------------------

/**
 * The producer end of the edge a lever moves, resolved by the sweep's own rule (#1705 PR 3).
 *
 * Both ends must be their tenant's one primary instance, exactly as `sweepEdge` requires. A
 * watermark on any other pair is one no pass reads, so a move there would report success and
 * change nothing. `resolve` is the directory's `resolveVerticalInstance`, and it takes the
 * CONSUMER's tenant, so a producer in another tenant is not found rather than moved.
 */
export async function importCursorSourceOf(
  resolve: (tenantId: TenantId, vertical: string) => Promise<VerticalResolution>,
  consumer: { tenantId: TenantId; scopeId: ScopeId; vertical: string | null },
  from: string,
): Promise<{ vertical: string; scopeId: ScopeId }> {
  if (consumer.vertical === null) {
    throw substratError('precondition_failed', `scope ${consumer.scopeId} runs no vertical, so it imports nothing`);
  }
  if (from === consumer.vertical) {
    throw substratError('precondition_failed', `'${from}' is this scope's own vertical — an edge names ANOTHER vertical`);
  }
  const [self, producer] = await Promise.all([resolve(consumer.tenantId, consumer.vertical), resolve(consumer.tenantId, from)]);
  if (self.outcome !== 'resolved' || self.instance.scopeId !== consumer.scopeId) {
    throw substratError(
      'precondition_failed',
      `scope ${consumer.scopeId} is not its tenant's one primary instance of '${consumer.vertical}' — ` +
        `a fork, a preview or a second install is no end of an edge`,
    );
  }
  if (producer.outcome !== 'resolved') {
    throw substratError(
      producer.outcome === 'not-installed' ? 'not_found' : 'precondition_failed',
      producer.outcome === 'not-installed'
        ? `'${from}' is not installed in this tenant`
        : `this tenant has more than one primary instance of '${from}' — the edge waits until one is chosen`,
    );
  }
  return { vertical: from, scopeId: producer.instance.scopeId };
}

/**
 * Copy the replayed range's delivery rows into `_substrat_import_replays`. Params: replay id,
 * replayed at, source scope, after ('' = the whole history).
 *
 * The rows are the import handlers' own. An imported event is never in this scope's outbox,
 * so no in-scope consumer ever journals one, and joining through `_substrat_imports` on the
 * source names exactly this edge's rows.
 */
const ARCHIVE_DELIVERIES_SQL = `
  INSERT INTO _substrat_import_replays
    (replay_id, replayed_at, source_scope_id, kind, event_id, consumer_module, row)
  SELECT ?, ?, i.source_scope_id, 'delivery', d.event_id, d.consumer_module,
         json_object('delivered_at', d.delivered_at, 'error', d.error, 'attempts', d.attempts,
                     'next_attempt_at', d.next_attempt_at, 'invocation_id', d.invocation_id)
    FROM _substrat_deliveries d
    JOIN _substrat_imports i ON i.event_id = d.event_id
   WHERE i.source_scope_id = ? AND i.event_id > ?
`;

/**
 * What one replay moved aside, by kind: a seek on the table's key prefix over the rows just
 * written. Counted from the rows rather than from a write's change count, because a Durable
 * Object's `rowsWritten` counts index writes too, and the two adapters would then disagree.
 */
const REPLAY_ARCHIVED_SQL = 'SELECT kind, COUNT(*) AS n FROM _substrat_import_replays WHERE replay_id = ? GROUP BY kind';

/** Copy the replayed range's journal rows. Params as `ARCHIVE_DELIVERIES_SQL`. */
const ARCHIVE_JOURNAL_SQL = `
  INSERT INTO _substrat_import_replays
    (replay_id, replayed_at, source_scope_id, kind, event_id, consumer_module, row)
  SELECT ?, ?, source_scope_id, 'journal', event_id, '',
         json_object('source_vertical', source_vertical, 'type', type, 'schema_version', schema_version,
                     'occurred_at', occurred_at, 'entity_type', entity_type, 'entity_id', entity_id,
                     'hops', hops, 'withheld', withheld, 'imported_at', imported_at)
    FROM _substrat_imports
   WHERE source_scope_id = ? AND event_id > ?
`;

/** Then clear them from the live tables. Deliveries first: their predicate reads the journal. */
const CLEAR_DELIVERIES_SQL = `
  DELETE FROM _substrat_deliveries
   WHERE event_id IN (SELECT event_id FROM _substrat_imports WHERE source_scope_id = ? AND event_id > ?)
`;
const CLEAR_JOURNAL_SQL = 'DELETE FROM _substrat_imports WHERE source_scope_id = ? AND event_id > ?';

/**
 * Set a watermark to any value, backwards included. `IMPORT_CURSOR_ADVANCE_SQL` can only move
 * it forward, and that is the delivery path's guard. The lever is the one writer allowed past it.
 */
const CURSOR_SET_SQL = `
  INSERT INTO _substrat_import_cursors (source_scope_id, source_vertical, cursor, updated_at)
  VALUES (?, ?, ?, ?)
  ON CONFLICT (source_scope_id) DO UPDATE SET
    source_vertical = excluded.source_vertical,
    cursor = excluded.cursor,
    updated_at = excluded.updated_at
`;
/** "Never read": the absence of a row, which is how a new edge already reads. */
const CURSOR_CLEAR_SQL = 'DELETE FROM _substrat_import_cursors WHERE source_scope_id = ?';

/**
 * Move one edge's watermark (#1705 PR 3). The adapter supplies the store (as the switches'
 * `SwitchSql`), the transaction, the queue, the clock and the act's id. Run on the scope's own
 * queue, so a pass delivering on the same edge can never interleave with the move. Everything the move decides is decided here, once, for
 * both adapters.
 *
 * Why a bare rewind is not a replay. Three guards stand between an event and a second run of
 * its handler, and a replay must pass each one on purpose:
 *
 *   1. `IMPORT_CURSOR_ADVANCE_SQL` moves the watermark forward only. The lever sets it here.
 *   2. `_substrat_deliveries` holds a row per (event, module) that ran, and the delivery path
 *      skips any pair it finds. Rewound but not cleared, every replayed event would come back
 *      as a `duplicate` and nothing would run.
 *   3. `_substrat_imports` is `INSERT OR IGNORE`. Left in place, an event first withheld for its
 *      version would stay recorded as withheld after the consumer's upgrade released it.
 *
 * So a replay moves the range's rows in (2) and (3) into `_substrat_import_replays` under
 * `replayId`, then clears them, then sets the watermark. The evidence stays, and the live tables
 * take the events again. Two things are true between the move and the redelivery, and are
 * stated rather than hidden: a cause walk through a moved event's id ends at `missing`, and an
 * export read in this scope counts fewer hops for a chain through it. Both heal when the next
 * pass redelivers. The undercount only loosens the loop bound (the hop cap bounds loops, and
 * authorizes nothing), so a loop may run a round longer; no event crosses that exports, grants
 * and the PII rule would not already release.
 *
 * Refused, with the reason a person reads:
 * - a replay whose `after` is AHEAD of the watermark (that is a skip), or a skip whose `through`
 *   is BEHIND it (that is a replay). The acknowledgement names one direction, and it must be
 *   the direction that moves;
 * - a skip past now, which would pass over events not yet written while the edge read as
 *   caught up;
 * - a replay on an edge that has delivered nothing yet: there is nothing to run again.
 */
export function moveImportCursor(
  sql: SwitchSql,
  input: {
    move: ImportCursorMove;
    source: { vertical: string; scopeId: string };
    replayId: string;
    /** Epoch ms: the rows' time, and "now" for a skip, as the watermark's ceiling. */
    now: number;
    /**
     * What the code running this scope imports (`CrossVerticalRegistry.consumes()`). A move names
     * an edge only if the consumer declares it. Otherwise a skip would plant a watermark for an
     * edge that does not exist yet, and the backfill of a later version that adds the import would
     * silently start from it.
     */
    imports: readonly { from: string }[];
  },
): ImportCursorMoved {
  const { move, source } = input;
  if (!input.imports.some((i) => i.from === source.vertical)) {
    throw substratError(
      'precondition_failed',
      `this scope's code imports nothing from '${source.vertical}' — there is no edge to move; ` +
        `a watermark set now would decide where a later import's backfill starts`,
    );
  }
  const at = new Date(input.now).toISOString();
  const previous = (sql.all(IMPORT_CURSOR_OF_SQL, source.scopeId)[0]?.cursor as string | undefined) ?? null;
  const moved = (cursor: string | null, archived: { journal: number; deliveries: number }): ImportCursorMoved => ({
    replayId: input.replayId,
    mode: move.mode,
    source: source as ImportCursorMoved['source'],
    previous: previous as ImportCursorMoved['previous'],
    cursor: cursor as ImportCursorMoved['cursor'],
    archived,
  });
  if (move.mode === 'skip') {
    const ceiling = ulidCeiling(input.now);
    // "Now" is every millisecond BEFORE this one. An event minted in the skip's own millisecond may
    // commit just after it, and a watermark at this millisecond's ceiling would pass over it
    // silently. On the boundary the edge delivers rather than drops: at least once, never lost.
    const through = move.through === 'now' ? ulidCeiling(input.now - 1) : move.through;
    // Not into the future: a watermark past now would pass over every event yet to be written,
    // silently, and the edge would then read as caught up. "Now" is as far as a skip reaches.
    if (through > ceiling) {
      throw substratError(
        'precondition_failed',
        `a skip reaches at most now, and ${through} is in the future — it would pass over events not yet written`,
      );
    }
    if (previous !== null && through < previous) {
      throw substratError(
        'precondition_failed',
        `a skip moves the watermark forward, and ${through} is behind it (${previous}) — ` +
          `to deliver events again, replay (mode 'replay')`,
      );
    }
    sql.run(CURSOR_SET_SQL, source.scopeId, source.vertical, through, at);
    return moved(through, { journal: 0, deliveries: 0 });
  }
  if (previous === null) {
    throw substratError(
      'precondition_failed',
      `this scope has taken nothing from '${source.vertical}' yet — there is nothing to replay; ` +
        `the next pass delivers the whole exported history`,
    );
  }
  if (move.after !== null && move.after > previous) {
    throw substratError(
      'precondition_failed',
      `a replay moves the watermark back, and ${move.after} is ahead of it (${previous}) — ` +
        `to pass over events, skip (mode 'skip')`,
    );
  }
  const floor = move.after ?? '';
  sql.run(ARCHIVE_DELIVERIES_SQL, input.replayId, at, source.scopeId, floor);
  sql.run(ARCHIVE_JOURNAL_SQL, input.replayId, at, source.scopeId, floor);
  const counts = new Map(sql.all(REPLAY_ARCHIVED_SQL, input.replayId).map((r) => [r.kind as string, Number(r.n)]));
  sql.run(CLEAR_DELIVERIES_SQL, source.scopeId, floor);
  sql.run(CLEAR_JOURNAL_SQL, source.scopeId, floor);
  if (move.after === null) sql.run(CURSOR_CLEAR_SQL, source.scopeId);
  else sql.run(CURSOR_SET_SQL, source.scopeId, source.vertical, move.after, at);
  return moved(move.after, { journal: counts.get('journal') ?? 0, deliveries: counts.get('delivery') ?? 0 });
}

/** The note a withheld event's dead letter carries at the consumer. Names the reason, never the content. */
export function withheldNote(reason: WithheldEvent['reason'], vertical: string): string {
  const why: Record<WithheldEvent['reason'], string> = {
    pii: 'it is classified as carrying personal data, and only piiClass none crosses a vertical boundary',
    version: 'its schemaVersion is not the one this module declares, so a parse here would reject it (K-39)',
    cascade: `its cause chain has already crossed ${EXPORT_HOP_CAP} vertical boundaries`,
    undecodable: 'the stored row does not decode (#1636)',
  };
  return `withheld by '${vertical}' (#1705): ${why[reason]} — nothing was delivered`;
}

/** One registered import handler: which module, from which vertical, for which (type, version). */
export interface RegisteredImport {
  moduleId: string;
  from: string;
  type: string;
  schemaVersion: number;
  handler: ImportHandler;
}

/**
 * A host's cross-vertical declarations (#1705), accumulated module by module. It is held by
 * every place that registers modules (the pure host, the Cloudflare coordinator and the
 * scope DO), so the three refuse the same wiring with the same words.
 *
 * What it refuses, and why each would otherwise be silent:
 * - **An import handler for a (source, type) the manifest does not declare `from` it.** It
 *   would run for events nobody reviewed the module receiving, because the declaration is
 *   what the permission diff shows.
 * - **A declared import with no handler.** The edge would be read, the events journaled and
 *   the watermark moved, and nothing would ever run: a delivery that reports success and
 *   does nothing. (A LOCAL consume without a handler stays allowed, as it always was.)
 * - **Two modules importing one (source, type) at different versions**, or **exporting one
 *   type under different versions or keys**. The edge asks for one version and gates on one
 *   key, and which module won would depend on registration order.
 */
export class CrossVerticalRegistry {
  private readonly exportsByType = new Map<string, EventExport & { declaredBy: string }>();
  private readonly importVersion = new Map<string, { schemaVersion: number; declaredBy: string }>();
  private readonly registered: RegisteredImport[] = [];
  /** `exportTypes()`, kept current by `register`: an invoke reads it, and must not rebuild a map to. */
  private exportTypeList: string[] = [];

  register(
    manifest: Pick<ModuleManifest, 'id' | 'events'>,
    handlers: Record<string, Record<string, ImportHandler>> | undefined,
  ): void {
    const declared = new Map<string, ConsumedEventRef>();
    for (const c of manifest.events.consumes) if (c.from !== undefined) declared.set(`${c.from}\u0000${c.type}`, c);
    const imports: RegisteredImport[] = [];
    for (const [from, byType] of Object.entries(handlers ?? {})) {
      for (const [type, handler] of Object.entries(byType)) {
        const decl = declared.get(`${from}\u0000${type}`);
        if (!decl) {
          throw new Error(
            `${manifest.id} registers an import handler for '${type}' from '${from}', which its manifest does not ` +
              `declare — add { from: '${from}', type: '${type}', schemaVersion } to events.consumes`,
          );
        }
        imports.push({ moduleId: manifest.id, from, type, schemaVersion: decl.schemaVersion, handler });
      }
    }
    for (const [key, decl] of declared) {
      if (!imports.some((i) => `${i.from}\u0000${i.type}` === key)) {
        throw new Error(
          `${manifest.id} declares it consumes '${decl.type}' from '${decl.from}' but registers no handler for it ` +
            `under \`imports['${decl.from}']\` — the edge would deliver into nothing`,
        );
      }
      const prior = this.importVersion.get(key);
      if (prior && prior.schemaVersion !== decl.schemaVersion) {
        throw new Error(
          `'${decl.type}' from '${decl.from}' is imported at schemaVersion ${prior.schemaVersion} by ${prior.declaredBy} ` +
            `and ${decl.schemaVersion} by ${manifest.id} — one edge asks for one version`,
        );
      }
    }
    for (const e of manifest.events.exports ?? []) {
      const prior = this.exportsByType.get(e.type);
      if (prior && (prior.schemaVersion !== e.schemaVersion || prior.readPermission !== e.readPermission)) {
        throw new Error(
          `'${e.type}' is exported as v${prior.schemaVersion} under '${prior.readPermission}' by ${prior.declaredBy} ` +
            `and as v${e.schemaVersion} under '${e.readPermission}' by ${manifest.id} — one export, one version, one key`,
        );
      }
    }
    // Validated whole before anything is kept, so a refused module leaves no half of itself.
    for (const e of manifest.events.exports ?? []) {
      if (!this.exportsByType.has(e.type)) this.exportsByType.set(e.type, { ...e, declaredBy: manifest.id });
    }
    this.exportTypeList = [...this.exportsByType.keys()];
    for (const [key, decl] of declared) {
      if (!this.importVersion.has(key)) this.importVersion.set(key, { schemaVersion: decl.schemaVersion, declaredBy: manifest.id });
    }
    this.registered.push(...imports);
  }

  /** type → export, over every registered module: what this deployment releases. */
  exports(): Map<string, EventExport> {
    return new Map([...this.exportsByType].map(([t, { declaredBy: _, ...e }]) => [t, e]));
  }

  /** The exported type names (#1705 PR 2), for the per-invoke kick count. Empty: exports nothing. */
  exportTypes(): readonly string[] {
    return this.exportTypeList;
  }

  /** What this deployment imports, one row per (source, type), sorted. */
  consumes(): { from: string; type: string; schemaVersion: number }[] {
    return [...this.importVersion.entries()]
      .map(([key, v]) => {
        const [from, type] = key.split('\u0000') as [string, string];
        return { from, type, schemaVersion: v.schemaVersion };
      })
      .sort((a, b) => a.from.localeCompare(b.from) || a.type.localeCompare(b.type));
  }

  /** The handlers for one (source, type), in registration order. */
  handlersFor(from: string, type: string): RegisteredImport[] {
    return this.registered.filter((i) => i.from === from && i.type === type);
  }

  /** Every module that imports anything from `from`: who a withheld event's dead letter is filed under. */
  modulesImporting(from: string, type: string): string[] {
    return [...new Set(this.handlersFor(from, type).map((i) => i.moduleId))];
  }
}
