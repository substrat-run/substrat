import { domainEvent, type DomainEvent, type DrainedEvent } from '@substrat-run/contracts';
import { issueOf, NOT_JSON } from './row-decode.js';

/**
 * Decoding a stored `_substrat_outbox` row into the envelope work is done with (#1636).
 *
 * The READ side of the outbox is tolerant (`readHistory` and the walks, via `rowDecoder`):
 * a row that does not decode comes back beside its neighbours, saying why. This is the
 * other side — the rows that are EXECUTED. A consumer's handler, an executor's handler and
 * the Tier-2 drain each act on the event, and a half-decoded event is not one any of them
 * may act on: a consumer built from stand-ins would record effects nobody asked for, and a
 * lake row built from them would be exact history that is not. So this decode is strict and
 * throws, and what changed is WHERE the throw lands. It used to sit above each loop's
 * per-event containment, so one bad row halted every event behind it on every pass:
 *
 * - consumer delivery never delivered anything of that type after it;
 * - executor dispatch failed the executor's whole pending list;
 * - the Tier-2 drain stalled for the scope, because a row that never ships is never
 *   stamped, so the next pass read it first again.
 *
 * Each caller now contains it per event — a dead letter for a delivery, a skip for the
 * drain — and the event behind it moves.
 *
 * One decoder, where there were two copies of the same `domainEvent.parse` in the two
 * adapters: both now decode through here, so a row cannot deliver on one and dead-letter
 * on the other.
 */

/** The `_substrat_outbox` columns the envelope is built from, as either adapter hands them back. */
export interface OutboxEnvelopeRow {
  id: string;
  type: string;
  schema_version: number;
  occurred_at: string;
  tenant_id: string;
  scope_id: string;
  actor: string;
  entity_type: string;
  entity_id: string;
  pii_class: string;
  subject_id: string | null;
  authorization: string | null;
  impersonation: string | null;
  operation: string | null;
  payload: string | null;
}

/** …plus the columns the Tier-2 drain lifts beside the envelope (#1242, #1237). */
export interface OutboxDrainRow extends OutboxEnvelopeRow {
  version?: string | null;
  caused_by?: string | null;
  invocation_id?: string | null;
}

/** Envelope field → the column a message should name. */
const COLUMN_OF: Record<string, string> = {
  schemaVersion: 'schema_version',
  occurredAt: 'occurred_at',
  tenantId: 'tenant_id',
  scopeId: 'scope_id',
  piiClass: 'pii_class',
  subjectId: 'subject_id',
};

/**
 * The stored row → the `DomainEvent` a consumer or executor is handed, or a throw naming
 * EVERY column that did not decode.
 *
 * A row that decodes is decoded exactly as it always was — the same candidate object into
 * the same `domainEvent.parse` — so nothing that delivered before reads differently now. The
 * throw's message never quotes the stored text (see `rowDecoder`): it is written into a dead
 * letter, which is stored beside the event and survives an erasure of its payload.
 */
export function domainEventOf(row: OutboxEnvelopeRow): DomainEvent {
  const failed: string[] = [];
  const named = new Set<string>();
  const json = (column: string, stored: string): unknown => {
    try {
      return JSON.parse(stored);
    } catch {
      failed.push(`${column}: ${NOT_JSON}`);
      named.add(column);
      return undefined;
    }
  };
  const candidate = {
    id: row.id,
    type: row.type,
    schemaVersion: row.schema_version,
    occurredAt: row.occurred_at,
    tenantId: row.tenant_id,
    scopeId: row.scope_id,
    actor: json('actor', row.actor),
    entity: { entityType: row.entity_type, entityId: row.entity_id },
    piiClass: row.pii_class,
    ...(row.subject_id ? { subjectId: row.subject_id } : {}),
    ...(row.authorization ? { authorization: json('authorization', row.authorization) } : {}),
    // K-42: the stamp survives the read, so a consumer's event and an executor's
    // are the same fact the stored row is. Absent rather than null when nobody
    // was impersonating, because `DomainEvent.impersonation` is optional — the
    // shape module code never sees is also the shape it cannot branch on.
    ...(row.impersonation ? { impersonation: json('impersonation', row.impersonation) } : {}),
    // #1231: absent rather than null, the same shape rule as the stamp above.
    ...(row.operation ? { operation: row.operation } : {}),
    payload: row.payload === null ? undefined : json('payload', row.payload),
  };
  const parsed = domainEvent.safeParse(candidate);
  if (parsed.success && failed.length === 0) return parsed.data;
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const head = String(issue.path[0] ?? '');
      const column =
        head === 'entity' ? (issue.path[1] === 'entityId' ? 'entity_id' : 'entity_type') : (COLUMN_OF[head] ?? head);
      // A JSON column that did not parse is already named; its `Required` issue here says
      // nothing new.
      if (named.has(column)) continue;
      named.add(column);
      failed.push(issueOf(column, { issues: [{ ...issue, path: issue.path.slice(head === 'entity' ? 2 : 1) }] }));
    }
  }
  throw new Error(`event row ${JSON.stringify(row.id)} cannot be decoded — ${failed.join('; ')}`);
}

/**
 * The stored row → the `DrainedEvent` the Tier-2 drain ships, or a throw (`domainEventOf`'s).
 *
 * The lifted columns are the ones the envelope does not carry — `domainEvent.parse` strips
 * anything it does not declare — read exactly as both adapters read them before this was
 * shared: the column as stored, or null.
 */
export function drainedEventOf(row: OutboxDrainRow): DrainedEvent {
  return {
    ...domainEventOf(row),
    operation: row.operation ?? null,
    version: row.version ?? null,
    // #1237 — lifted like the two above, and for the same reason: the column
    // exists on the outbox but not on the envelope `domainEventOf` returns.
    causedBy: (row.caused_by ?? null) as DrainedEvent['causedBy'],
    // …and the invocation, for the same reason again: a lake that kept cause and
    // dropped the call could say what set an event off and never which request did
    // it, which is the grouping a trace is built on.
    invocationId: row.invocation_id ?? null,
  };
}

/**
 * What a Tier-2 read passed over (#1636): rows that would not decode, so were neither
 * returned nor — since nothing ships them — ever stamped.
 *
 * `eventIds` is capped at {@link UNDRAINED_SKIPPED_IDS}; `count` is exact. Ids only, never
 * a reason: this travels to the control plane's sweep report and its log, and a decode
 * message is one step from the stored text it describes.
 */
export interface UndrainedSkipped {
  count: number;
  eventIds: string[];
}

/**
 * `readUndrainedEvents`' answer: the events, oldest first — an ARRAY, because every caller
 * already reads one — with what the read skipped riding beside them as an optional
 * property. Absent when every row it read decoded, so a clean read is the array it always
 * was.
 *
 * A property on an array does not survive `JSON.stringify` or an RPC hop, so each hop that
 * carries this says so explicitly (the DO's `undrainedEventsRead`, the vertical's
 * `/internal/undrained-events?withSkipped=1`); it is only ever attached in-process.
 */
export type UndrainedEvents = DrainedEvent[] & { skipped?: UndrainedSkipped };

/** The same answer, as a plain object — the shape that crosses an RPC or HTTP hop. */
export interface UndrainedRead {
  events: DrainedEvent[];
  skipped?: UndrainedSkipped;
}

/** How many rows past `limit` one read may look through, as a multiple of `limit`. */
export const UNDRAINED_SCAN_FACTOR = 10;
/** How many skipped ids a read names; the count past it stays exact. */
export const UNDRAINED_SKIPPED_IDS = 50;

/**
 * The Tier-2 drain's read over one scope's outbox (#1334), CONTAINED per row (#1636) — the
 * one implementation both adapters run, so they cannot disagree about what is skipped.
 *
 * `page(offset, count)` is the adapter's
 * `SELECT * … WHERE drained_at IS NULL ORDER BY id LIMIT count OFFSET offset`. Offset
 * rather than an id cursor on purpose: the rows being stepped over are exactly the ones
 * whose `id` may be the column that is broken.
 *
 * A row that does not decode is SKIPPED: not returned, so no sink ever receives an event
 * built from stand-ins — the lake is append-only, and a wrong row there cannot be taken
 * back — and not stamped, so `drained_at` stays an exact record of what left. The read
 * keeps going past it, so the healthy rows behind it still ship. The cost is stated rather
 * than hidden: a skipped row never reaches the lake, and every pass reads it again. It
 * stays visible in Tier 1, where `readHistory` returns it with a `decodeError`.
 *
 * Bounded: at most `limit × UNDRAINED_SCAN_FACTOR` rows are looked at. A scope whose next
 * that-many undrained rows ALL fail to decode ships nothing, pass after pass — at that
 * point the spine is broken wholesale, which is a restore to repair rather than a row to
 * step over, and the skipped count in the sweep report is what says so.
 */
export function readUndrainedOutbox(
  page: (offset: number, count: number) => OutboxDrainRow[],
  limit: number,
): UndrainedRead {
  const events: DrainedEvent[] = [];
  const eventIds: string[] = [];
  let count = 0;
  let scanned = 0;
  const ceiling = limit * UNDRAINED_SCAN_FACTOR;
  while (events.length < limit && scanned < ceiling) {
    const want = Math.min(limit, ceiling - scanned);
    const rows = page(scanned, want);
    for (const row of rows) {
      if (events.length === limit) break;
      scanned += 1;
      let event: DrainedEvent;
      try {
        event = drainedEventOf(row);
      } catch {
        // `drainedEventOf` is a pure decode of text already in hand — nothing in it can
        // fail transiently, so a throw here is a fact about the row, not about this pass.
        count += 1;
        if (eventIds.length < UNDRAINED_SKIPPED_IDS) eventIds.push(String(row.id));
        continue;
      }
      events.push(event);
    }
    if (rows.length < want) break;
  }
  return count > 0 ? { events, skipped: { count, eventIds } } : { events };
}

/** An `UndrainedRead` → the in-process array shape, the skip attached only when there is one. */
export function undrainedEventsOf(read: UndrainedRead): UndrainedEvents {
  const events: UndrainedEvents = [...read.events];
  if (read.skipped) events.skipped = read.skipped;
  return events;
}
