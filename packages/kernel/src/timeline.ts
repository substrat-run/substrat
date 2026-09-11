import {
  listLimitOf,
  pageOf,
  type Actor,
  type DataSubjectId,
  type EntityRef,
  type EventAuthorization,
  type EventId,
  type HistoryEntry,
  type ImpersonationStamp,
  type Instant,
  type ListPage,
  type Page,
  type PiiClass,
  type TimelineEntry,
  type EventFacetInput,
  type EventFacetResult,
} from '@substrat-run/contracts';
import type { ScopedSql, SqlValue } from './scope-host.js';

/**
 * Reading an entity's history out of the spine (#800).
 *
 * `_substrat_outbox` is the kernel's table and a timeline read of it is a
 * SANCTIONED projection — rule 3 bans writes to `_substrat_*`, not reads, because
 * "show me the history of this thing" has no other honest source. What was
 * missing is a supported SHAPE for it, and five demos wrote the query by hand in
 * its absence. They did not agree, and the disagreements were not cosmetic:
 *
 * | Demo | Order | Cursor |
 * |---|---|---|
 * | callout, handlebar | `rowid` | `rowid` |
 * | meridian, rally | `occurred_at, rowid` | `occurred_at` |
 * | manyfold | `rowid` | *(unpaged)* |
 *
 * **Meridian's and rally's paging drops events.** The cursor is `occurred_at`
 * and the walk is `occurred_at > ?`, so every row sharing the last row's
 * timestamp is skipped — and sharing it is the NORM, not a rare tie: `ctx.now()`
 * is stable for the whole invocation (#812), so every event one operation emits
 * carries the identical instant. A page boundary landing inside an operation's
 * events silently loses the rest of them, and no test would catch it.
 *
 * So the walk here is `ORDER BY id`, and the cursor is `id`:
 *
 * - **`id` IS the entity's version at that point** (#901). The same token
 *   `ctx.versionOf` returns and `If-Match` compares (#129/#906), so listing the
 *   history, naming a version, and refusing a stale write stop being three
 *   vocabularies.
 * - **Creation order, exactly.** `ulid()` uses the spec's monotonic factory, so
 *   two ids minted in one millisecond still sort in the order they were made.
 *   That property is what `entityVersionQuery` already relies on; a timeline
 *   ordering by `rowid` was the odd one out.
 * - **The index already exists.** `OUTBOX_ENTITY_INDEX` is
 *   `(entity_type, entity_id, id)`, built for `entityVersionQuery`, and it makes
 *   this a seek with no new DDL. A `rowid` cursor cannot use it.
 * - **`rowid` does not survive a restore. `id` does.**
 *
 * ## These do NOT check a permission, deliberately
 *
 * Every caller does its own `assertAllowed(await ctx.check(read, entity))` first,
 * and that stays the caller's job: a helper that gated itself would become a
 * second, invisible policy surface, and one that gated itself on nothing would be
 * an unchecked read path into every event in the scope. Neither is better than
 * the one line at the call site.
 *
 * ```ts
 * assertAllowed(await ctx.check(WO.read, entity));
 * return readTimeline(ctx, entity, input);
 * ```
 *
 * ## Read-only by construction
 *
 * Both build a `SELECT` and nothing else. `boundary-lint`'s ban on writing
 * `_substrat_*` is untouched and must stay that way — this is a way to read the
 * spine, never a way to forge it.
 */

/** What the reads need from a context: the scope's SQL, and only its query half. */
export interface TimelineReader {
  readonly sql: Pick<ScopedSql, 'query'>;
}

/** The envelope columns, in the order `mapTimelineRow` expects. */
const TIMELINE_COLUMNS = 'id, type, occurred_at, actor';
/** …plus what a history VIEW needs. See `historyEntry` for why two are nullable. */
const HISTORY_COLUMNS = `${TIMELINE_COLUMNS}, payload, authorization, impersonation, pii_class, subject_id, operation, version, caused_by`;

interface TimelineRow {
  id: string;
  type: string;
  occurred_at: string;
  actor: string;
}

interface HistoryRow extends TimelineRow {
  payload: string | null;
  authorization: string | null;
  impersonation: string | null;
  pii_class: string;
  subject_id: string | null;
  operation: string | null;
  version: string | null;
  caused_by: string | null;
}

/**
 * The one SELECT behind both reads, for the reason `entityVersionQuery` is one
 * function: two surfaces answering the same question from one table must not
 * drift on what the answer means.
 *
 * The cursor is EXCLUSIVE and compares against `id` — strictly after it walking
 * `asc`, strictly before it walking `desc`. `desc` exists because a history strip
 * is usually rendered newest-first; `asc` stays the default, which is the order
 * all five demos already returned.
 */
function timelineQuery(
  columns: string,
  entity: EntityRef,
  page: ListPage | undefined,
  limit: number,
): { sql: string; params: (string | number)[] } {
  const desc = page?.order === 'desc';
  const cursor = page?.cursor;
  return {
    sql:
      `SELECT ${columns} FROM _substrat_outbox WHERE entity_type = ? AND entity_id = ?` +
      (cursor === undefined ? '' : desc ? ' AND id < ?' : ' AND id > ?') +
      ` ORDER BY id ${desc ? 'DESC' : 'ASC'} LIMIT ?`,
    params:
      cursor === undefined
        ? [entity.entityType, entity.entityId, limit]
        : [entity.entityType, entity.entityId, cursor, limit],
  };
}

/**
 * Decode the stored actor.
 *
 * Both adapters write `JSON.stringify(actor)` over a union whose first member is
 * a bare `PrincipalId` STRING, so a principal is stored as `"01J…"` — quotes
 * included — while a system or connector actor is stored as an object. That is the trap this whole helper exists to close: the
 * column reads as usable and is not, and a caller resolving a name against the
 * raw text misses every time.
 *
 * Cast rather than re-parsed, the way `mapDenialRow` treats the same encoding:
 * the kernel is the only writer of this column, so a Zod pass per row would buy
 * nothing but cost the walk.
 */
function actorOf(stored: string): Actor {
  return JSON.parse(stored) as Actor;
}

function mapTimelineRow(row: TimelineRow): TimelineEntry {
  return {
    id: row.id as EventId,
    type: row.type,
    occurredAt: row.occurred_at as Instant,
    actor: actorOf(row.actor),
  };
}

function mapHistoryRow(row: HistoryRow): HistoryEntry {
  return {
    ...mapTimelineRow(row),
    // Null is a FACT here, twice over, and the two are different facts: a null
    // payload is an erasure (§5.3 kept the envelope and destroyed what was
    // said), a null authorization is a row written before K-34 recorded it.
    payload: row.payload === null ? null : (JSON.parse(row.payload) as unknown),
    authorization:
      row.authorization === null ? null : (JSON.parse(row.authorization) as EventAuthorization[]),
    // K-42, and its null is a THIRD kind of fact: nobody was impersonating. The
    // ordinary case, not an absence of recording — the kernel stamps this on
    // every event raised under a session and on no other.
    impersonation:
      row.impersonation === null ? null : (JSON.parse(row.impersonation) as ImpersonationStamp),
    piiClass: row.pii_class as PiiClass,
    subjectId: row.subject_id as DataSubjectId | null,
    // #1231, and the one null that is honestly TWO facts at once: a consumer
    // emit ran on behalf of no operation, and a pre-column row is unrecorded.
    // historyEntry's doc owns that ambiguity; this mapper just carries it.
    operation: row.operation,
    // #1242: from the column, never the envelope — historyEntry's doc owns why.
    version: row.version,
    // #1237: the event this one reacted to. Null means nothing was being
    // delivered, or the row predates the column — historyEntry's doc owns the
    // distinction, and the pair (operation null + this set) is what finally
    // identifies a consumer emit, which neither field could do alone.
    causedBy: row.caused_by as EventId | null,
  };
}

/**
 * An entity's timeline — WHAT happened to it, WHEN, and BY WHOM.
 *
 * The envelope only: no payload, so there is no disclosure decision to make and
 * nothing an erasure can leave behind. `readHistory` is the same walk with what a
 * history VIEW needs.
 *
 * Paged like an HTTP list read rather than like a kernel read — an unset `limit`
 * is `LIST_PAGE_DEFAULT`, not unbounded — because the caller is an app walking a
 * screen, and an entity that has been touched ten thousand times must not answer
 * with ten thousand rows because nobody said a number.
 */
export function readTimeline(
  ctx: TimelineReader,
  entity: EntityRef,
  page?: ListPage,
): Page<TimelineEntry> {
  const limit = listLimitOf(page?.limit);
  const { sql, params } = timelineQuery(TIMELINE_COLUMNS, entity, page, limit);
  const rows = ctx.sql.query<TimelineRow>(sql, params);
  return pageOf(rows.map(mapTimelineRow), limit, (entry) => entry.id);
}

/**
 * An entity's history — the timeline, plus what was said and under what
 * authority.
 *
 * Three fields beyond the envelope, each answering something a history strip
 * needs and a timeline cannot:
 *
 * - **`payload`** — the fat event, i.e. the NEW values. Field-level "X → Y" is
 *   reconstructed by diffing consecutive payloads; nothing stores a before-state.
 *   **Null after a shred** — a supported result, not an error (see `historyEntry`).
 * - **`authorization`** (K-34) — the checks the emitting operation passed, and
 *   which grant allowed each. Not just who changed it but under what authority,
 *   which most systems cannot answer at all and this one gets for free.
 * - **`piiClass` / `subjectId`** — so the caller can decide what is safe to
 *   render before it renders it.
 * - **`causedBy`** (#1237) — the event this one was emitted in reaction to, which
 *   is what makes a backwards walk possible: `authorization` says under what
 *   authority and `operation` says under what invocation, but neither says
 *   BECAUSE OF WHAT, and a consumer emit has no operation at all.
 *
 * Same permission posture as `readTimeline`: the caller checks, this does not.
 * The payload makes that more load-bearing here, not less — this is the read that
 * can disclose what an event said.
 */
export function readHistory(
  ctx: TimelineReader,
  entity: EntityRef,
  page?: ListPage,
): Page<HistoryEntry> {
  const limit = listLimitOf(page?.limit);
  const { sql, params } = timelineQuery(HISTORY_COLUMNS, entity, page, limit);
  const rows = ctx.sql.query<HistoryRow>(sql, params);
  return pageOf(rows.map(mapHistoryRow), limit, (entry) => entry.id);
}

/**
 * Facet a scope's own outbox (#1239 stage 1): narrow by type and window, group by
 * one envelope column or one payload field, count.
 *
 * The sanctioned read, for the same reason `readHistory` is: the spine has rules a
 * hand-rolled `SELECT` does not know, and this one is load-bearing —
 *
 * **an erased payload is not a missing value.** A shred keeps the row and drops
 * the content (§5.3), so `json_extract(payload, '$.x')` over a shredded event
 * yields NULL exactly as it does for an event that never carried `x`. Grouped
 * naively, redacted history disappears into a "no value" bucket and the reader
 * sees a clean distribution with no hint that part of it was erased. So erased
 * rows are counted in their own total and kept out of the buckets entirely.
 *
 * A bare `payload IS NULL` is NOT that predicate, which is the subtlety here.
 * `DomainEvent.payload` is `unknown`, so `payload: undefined` is a legal thing to
 * emit, and `emit` stores it as the same SQL NULL a shred writes — so the naive
 * predicate calls every payload-less event erased. The shred only ever nulls rows whose
 * `pii_class` is not `'none'` (it needs a data subject to key the erasure, which
 * `piiInvariant` guarantees such a row has), so that is the condition carried
 * here: it admits every erased row and excludes the ordinary payload-less one.
 * What it cannot separate is an event that declares PII and then carries nothing
 * — indistinguishable from a shredded row in this schema, and counted as erased,
 * which is the safe direction to be wrong in: over-reporting redaction tells a
 * reader to go and look, under-reporting it does not. The exact answer wants a
 * persisted erasure state on the spine and a migration for existing scopes; the
 * reader cannot invent one.
 *
 * The group-by is a fixed shape, never interpolated SQL: an envelope grouping
 * selects a known column, and a payload grouping binds `'$.<field>'` as a
 * parameter, with the field's own pattern enforced by `eventFacetGroupBy`.
 */
export function facetEvents(ctx: TimelineReader, input: EventFacetInput): EventFacetResult {
  const limit = Math.min(Math.max(input.limit ?? 50, 1), 200);
  const where: string[] = [];
  const params: SqlValue[] = [];
  if (input.type !== undefined) {
    where.push('type = ?');
    params.push(input.type);
  }
  if (input.since !== undefined) {
    where.push('occurred_at >= ?');
    params.push(input.since);
  }
  if (input.until !== undefined) {
    where.push('occurred_at < ?');
    params.push(input.until);
  }
  const filter = where.length > 0 ? ` WHERE ${where.join(' AND ')}` : '';

  const total =
    ctx.sql.query<{ n: number }>(`SELECT COUNT(*) AS n FROM _substrat_outbox${filter}`, params)[0]?.n ?? 0;

  // An envelope column cannot be erased, so the erased count is structurally zero
  // and every matching row is groupable.
  if (input.groupBy.kind !== 'payload') {
    const column = ENVELOPE_COLUMN[input.groupBy.kind];
    const rows = ctx.sql.query<{ value: string | null; n: number; last: string | null }>(
      `SELECT ${column} AS value, COUNT(*) AS n, MAX(occurred_at) AS last FROM _substrat_outbox${filter}
        GROUP BY ${column} ORDER BY n DESC, value LIMIT ?`,
      [...params, limit + 1],
    );
    return {
      buckets: rows.slice(0, limit).map((r) => ({ value: r.value, count: r.n, lastSeen: r.last })),
      erased: 0,
      total,
      truncated: rows.length > limit,
    };
  }

  // Erased rows are counted, then excluded — the whole point of this branch. See the
  // docstring for why the predicate carries `pii_class` rather than testing the payload
  // alone: an omitted payload is stored as the same NULL a shred writes.
  const ERASED = `payload IS NULL AND pii_class != 'none'`;
  const erasedFilter = filter === '' ? ` WHERE ${ERASED}` : `${filter} AND ${ERASED}`;
  const erased =
    ctx.sql.query<{ n: number }>(`SELECT COUNT(*) AS n FROM _substrat_outbox${erasedFilter}`, params)[0]?.n ?? 0;

  const liveFilter = filter === '' ? ` WHERE NOT (${ERASED})` : `${filter} AND NOT (${ERASED})`;
  // CAST to TEXT so the grouping and the value the caller reads are the SAME
  // representation. SQLite keeps `json_extract`'s storage classes apart — a JSON `1`
  // comes back INTEGER, a JSON `"1"` TEXT, and they land in separate groups — while
  // the bucket contract is `string | null`, so stringifying afterwards would collapse
  // the two groups into two buckets with the same `value` and split counts. Casting in
  // SQL makes the group key the rendered value, so one bucket per rendered value is a
  // property of the query rather than a hope about the data.
  const rows = ctx.sql.query<{ value: string | null; n: number; last: string | null }>(
    `SELECT CAST(json_extract(payload, ?) AS TEXT) AS value, COUNT(*) AS n, MAX(occurred_at) AS last
      FROM _substrat_outbox${liveFilter}
      GROUP BY value ORDER BY n DESC, value LIMIT ?`,
    [`$.${input.groupBy.field}`, ...params, limit + 1],
  );
  // Over LIVE rows only, like the count beside it: an erased row is excluded from the
  // bucket entirely, so this is "when this value was last seen in an event that still
  // carries its payload" — the erased total above is where the rest is accounted for.
  return {
    buckets: rows.slice(0, limit).map((r) => ({ value: r.value, count: r.n, lastSeen: r.last })),
    erased,
    total,
    truncated: rows.length > limit,
  };
}

/** The envelope columns a facet may group by — a fixed map, never a caller's string. */
const ENVELOPE_COLUMN: Record<string, string> = {
  type: 'type',
  actor: 'actor',
  operation: 'operation',
  version: 'version',
  entityType: 'entity_type',
  piiClass: 'pii_class',
};
