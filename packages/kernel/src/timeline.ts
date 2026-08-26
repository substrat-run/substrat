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
} from '@substrat-run/contracts';
import type { ScopedSql } from './scope-host.js';

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
const HISTORY_COLUMNS = `${TIMELINE_COLUMNS}, payload, authorization, impersonation, pii_class, subject_id`;

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
