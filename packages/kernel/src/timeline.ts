import {
  deadLetter,
  eventDelivery,
  historyEntry,
  listLimitOf,
  pageOf,
  timelineEntry,
  type EntityRef,
  type EventId,
  type ScopeId,
  type HistoryEntry,
  type CauseChain,
  type EffectsTree,
  type EffectsTerminal,
  type InvocationEvents,
  type DeadLetter,
  type EventEffects,
  type EventDelivery,
  type DeliveryState,
  type ModuleId,
  type Instant,
  type ListPage,
  type Page,
  type TimelineEntry,
  type EventFacetInput,
  type EventFacetResult,
} from '@substrat-run/contracts';
import { rowDecoder, UNDECODED_ACTOR, type RowDecoder } from './row-decode.js';
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
const HISTORY_COLUMNS = `${TIMELINE_COLUMNS}, payload, authorization, impersonation, pii_class, subject_id, operation, version, caused_by, invocation_id`;

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
  invocation_id: string | null;
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
 * The envelope fields, decoded — the part a timeline and a history entry share.
 *
 * `actor` is the reason this layer exists at all (#800). Both adapters write
 * `JSON.stringify(actor)` over a union whose first member is a bare `PrincipalId`
 * STRING, so a principal is stored as `"01J…"` — quotes included — while a system or
 * connector actor is stored as an object. The column reads as usable and is not, and a
 * caller resolving a name against the raw text misses every time.
 *
 * Decoded against the contract rather than cast (#1636): a cast of text that would not
 * parse threw out of the whole page, and a cast of text that parsed into something that
 * is not an actor handed the caller a value typed as one. See `rowDecoder` for what
 * comes back instead, and why a required scalar still throws.
 */
function envelopeOf(d: RowDecoder, row: TimelineRow): Omit<TimelineEntry, 'decodeError'> {
  const shape = timelineEntry.shape;
  return {
    id: d.required<EventId>('id', shape.id, row.id),
    type: d.required<string>('type', shape.type, row.type),
    occurredAt: d.required<Instant>('occurred_at', shape.occurredAt, row.occurred_at),
    actor: d.json('actor', shape.actor, row.actor, UNDECODED_ACTOR),
  };
}

function mapTimelineRow(row: TimelineRow): TimelineEntry {
  const d = rowDecoder(`outbox row ${JSON.stringify(row.id)}`, 'TimelineEntry');
  return d.finish(envelopeOf(d, row));
}

/**
 * A history row, decoded — and which of its columns did not decode, for the one caller
 * whose logic reads a column rather than rendering it (`walkEventCause`, where an
 * undecodable cause must not read as a null one).
 */
function decodeHistoryRow(row: HistoryRow): { entry: HistoryEntry; failed: ReadonlySet<string> } {
  const shape = historyEntry.shape;
  const d = rowDecoder(`outbox row ${JSON.stringify(row.id)}`, 'HistoryEntry');
  const entry = d.finish<HistoryEntry>({
    ...envelopeOf(d, row),
    // Null is a FACT here, twice over, and the two are different facts: a null
    // payload is an erasure (§5.3 kept the envelope and destroyed what was
    // said), a null authorization is a row written before K-34 recorded it. A
    // column that did not DECODE also reads null — and `decodeError` names it,
    // which is the only thing that keeps an unreadable payload from reading as an
    // erased one (#1636).
    payload: d.json('payload', shape.payload, row.payload, null),
    authorization: d.json('authorization', shape.authorization, row.authorization, null),
    // K-42, and its null is a THIRD kind of fact: nobody was impersonating. The
    // ordinary case, not an absence of recording — the kernel stamps this on
    // every event raised under a session and on no other.
    impersonation: d.json('impersonation', shape.impersonation, row.impersonation, null),
    piiClass: d.required('pii_class', shape.piiClass, row.pii_class),
    subjectId: d.nullable('subject_id', shape.subjectId, row.subject_id ?? null),
    // #1231, and the one null that is honestly TWO facts at once: a consumer
    // emit ran on behalf of no operation, and a pre-column row is unrecorded.
    // historyEntry's doc owns that ambiguity; this mapper just carries it.
    operation: d.nullable('operation', shape.operation, row.operation ?? null),
    // #1242: from the column, never the envelope — historyEntry's doc owns why.
    version: d.nullable('version', shape.version, row.version ?? null),
    // #1237: the event this one reacted to. Null means nothing was being
    // delivered, or the row predates the column — historyEntry's doc owns the
    // distinction, and the pair (operation null + this set) is what finally
    // identifies a consumer emit, which neither field could do alone.
    causedBy: d.nullable('caused_by', shape.causedBy, row.caused_by ?? null),
    // #1237: which CALL this event belongs to — what groups an invocation's events,
    // and joins them to the log line that knows its duration.
    invocationId: d.nullable('invocation_id', shape.invocationId, row.invocation_id ?? null),
  });
  return { entry, failed: d.failed };
}

function mapHistoryRow(row: HistoryRow): HistoryEntry {
  return decodeHistoryRow(row).entry;
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
 * Walk one event's causal chain backwards (#1237) — "this invoice exists; what
 * started that?"
 *
 * The sanctioned read, for the reason `readHistory` is: the walk's whole value is in
 * telling five endings apart, and a hand-rolled loop over `caused_by` distinguishes
 * none of them.
 *
 * **A null cause is two different endings, and the pair with `operation` decides
 * which.** An event with an operation and no cause is a COMPLETE chain: an operation
 * emitted it directly, and there is nothing above it. An event with neither is a
 * TRUNCATED one: something emitted it — a consumer, which records no operation — back
 * when the cause was not being recorded (pre-#1237). Reading the second as the first
 * presents a fragment as the whole story, which is the single thing this view must
 * never do; a reader would conclude a consumer started a chain it merely continued.
 *
 * Bounded, and terminating even on input the spine should not be able to produce.
 * `maxDepth` caps the walk and reports `depth` rather than trimming silently, and a
 * revisited id ends it as `cycle`: ids are monotonic and a cause is always older, so
 * a cycle is impossible — but "impossible" is not a reason for a read on the audit
 * spine to be able to hang, and it is a reason to report it as the integrity failure
 * it is rather than as a long chain. `depth` promises more above; a cycle has none.
 */
export function walkEventCause(
  ctx: TimelineReader,
  eventId: EventId,
  maxDepth = 25,
): CauseChain {
  const depth = Math.min(Math.max(Math.floor(maxDepth) || 1, 1), 100);
  const chain: HistoryEntry[] = [];
  const seen = new Set<string>();
  let next: string | null = eventId;

  while (next !== null) {
    if (seen.has(next)) {
      // Unreachable by construction; see the docstring. Its own terminal, because
      // every other one is a claim this is not: not a clean ending, and not a cap
      // with more chain above it to ask for.
      return { chain, terminal: 'cycle' };
    }
    seen.add(next);
    const rows = ctx.sql.query<HistoryRow>(
      `SELECT ${HISTORY_COLUMNS} FROM _substrat_outbox WHERE id = ? LIMIT 1`,
      [next],
    );
    const row = rows[0];
    if (row === undefined) {
      // #1705: not in the outbox, but RECEIVED: the cause is another vertical's exported
      // event. The trail leaves this scope rather than breaking, so the walk says where it
      // went and does not raise the integrity alarm that 'missing' is.
      const imported = ctx.sql.query<{ source_vertical: string; source_scope_id: string }>(
        'SELECT source_vertical, source_scope_id FROM _substrat_imports WHERE event_id = ? LIMIT 1',
        [next],
      )[0];
      if (imported !== undefined) {
        return {
          chain,
          terminal: 'imported',
          imported: {
            eventId: next as EventId,
            vertical: imported.source_vertical,
            scopeId: imported.source_scope_id as ScopeId,
          },
        };
      }
      // The FIRST id missing means the caller named an event this scope does not
      // hold; a later one means the spine lost a row it should still have. Both are
      // 'missing' — the view says the trail cannot be followed further, and does not
      // pass either off as a complete chain.
      return { chain, terminal: 'missing' };
    }
    const { entry, failed } = decodeHistoryRow(row);
    chain.push(entry);
    // #1636: a cause that did not DECODE is not a null cause. Read as one, a row with an
    // operation would end the walk as 'operation' — a complete chain — when the trail
    // above it was simply unreadable. The same goes for an unreadable operation beside a
    // null cause, which is exactly the column that decides between the two endings.
    // Either way the honest ending is the one that says the trail cannot be followed.
    if (failed.has('caused_by') || (entry.causedBy === null && failed.has('operation'))) {
      return { chain, terminal: 'missing' };
    }
    if (entry.causedBy === null) {
      // THE distinction. An operation emitted this: the chain is whole. Neither an
      // operation nor a cause: something emitted it before causes were recorded, and
      // the walk has run out of trail rather than reached the beginning.
      return { chain, terminal: entry.operation === null ? 'unrecorded' : 'operation' };
    }
    if (chain.length >= depth) return { chain, terminal: 'depth' };
    next = entry.causedBy;
  }
  // Only reachable if the loop condition is changed to admit a null start.
  return { chain, terminal: 'missing' };
}

interface DeliveryRow {
  consumer_module: string;
  delivered_at: string;
  error: string | null;
  attempts: number;
  next_attempt_at: string | null;
  /** #1525: the call the LAST attempt ran in. NULL = none was carried. */
  invocation_id: string | null;
}

/**
 * Resolve one delivery row's state.
 *
 * The subtlety the column forces: `delivered_at` is NOT NULL and predates retry state,
 * so it means "delivered at" on a terminal row and "last attempted at" on a pending
 * one. Printing it under one label would date a delivery that has not happened.
 *
 * `next_attempt_at IS NOT NULL` is the pending marker (#100); consumers leave it at
 * its default and keep the older semantics, where a row means "do not deliver again".
 * So: pending → retrying, else an error → dead, else delivered.
 */
function deliveryOf(row: DeliveryRow): EventDelivery {
  const shape = eventDelivery.shape;
  const d = rowDecoder(
    `delivery row ${JSON.stringify(row.consumer_module)}`,
    'valid EventDelivery',
  );
  // From the STORED columns, and `!= null` rather than a truthiness test: an empty `error`
  // is a delivery that gave up with no message, not one that did not give up (#1643).
  const state: DeliveryState =
    row.next_attempt_at != null ? 'retrying' : row.error != null ? 'dead' : 'delivered';
  return d.finish<EventDelivery>({
    consumer: d.required('consumer_module', shape.consumer, row.consumer_module),
    state,
    at: d.required('delivered_at', shape.at, row.delivered_at),
    error: d.nullable('error', shape.error, row.error ?? null),
    // The one this fix is for (#1643): `attempts` was cast, so a stored `-1`, `1.5` or `'many'`
    // (INTEGER affinity keeps text it cannot convert) reached a caller typed as a
    // non-negative integer. A required scalar with no honest empty value, so it throws.
    attempts: d.required('attempts', shape.attempts, row.attempts),
    // #1525: which CALL made the attempt `at` dates — the join the event's own
    // invocation cannot make, because a retry runs in a later call or in none.
    // `?? null` rather than a bare read, for the row a legacy store hands back
    // with the column absent.
    invocationId: d.nullable('invocation_id', shape.invocationId, row.invocation_id ?? null),
  });
}

/**
 * Walk forward from one event: what it set off (#1237).
 *
 * The mirror of `walkEventCause`, and the honest answer to "expand this invocation".
 * It is assembled from what the spine already recorded — which consumers the event
 * reached, and which events they emitted in turn (`caused_by`, #1437) — rather than
 * from spans, because nothing in the platform emits a span for an operation, a
 * permission check or an engine call. So this is a tree of recorded steps with real
 * timestamps, NOT a timing waterfall, and it does not pretend to be one.
 *
 * Sanctioned for the same reason the backwards walk is: the two readings of
 * `delivered_at` and the ambiguity of an empty delivery list are both traps a
 * hand-rolled join falls into, and both are resolved here once.
 */
export function walkEventEffects(
  ctx: TimelineReader,
  eventId: EventId,
  maxNodes = 50,
): EffectsTree {
  const cap = Math.min(Math.max(Math.floor(maxNodes) || 1, 1), 500);
  const seen = new Set<string>();
  let terminal: EffectsTerminal = 'complete';
  let count = 0;

  /**
   * `terminal` is one flag shared by every recursive `build`, so what wins when two
   * things go wrong is a rule, not an accident of order. An integrity failure (`cycle`,
   * `missing`) always outranks `depth`: the cap is a budget the reader can raise, while
   * a cycle or a vanished row is a fact about the spine that no larger limit repairs —
   * and a walk that hit both must not report only the one it can be talked out of.
   * Between the two integrity failures, the first found stands.
   */
  const markTerminal = (status: EffectsTerminal) => {
    if (status === 'cycle' || status === 'missing') {
      if (terminal !== 'cycle' && terminal !== 'missing') terminal = status;
    } else if (terminal === 'complete') {
      terminal = status;
    }
  };

  const readEvent = (id: string): HistoryEntry | undefined => {
    const rows = ctx.sql.query<HistoryRow>(
      `SELECT ${HISTORY_COLUMNS} FROM _substrat_outbox WHERE id = ? LIMIT 1`,
      [id],
    );
    const row = rows[0];
    return row === undefined ? undefined : mapHistoryRow(row);
  };

  const build = (entry: HistoryEntry): EventEffects => {
    count += 1;
    const deliveries = ctx.sql
      .query<DeliveryRow>(
        `SELECT consumer_module, delivered_at, error, attempts, next_attempt_at, invocation_id
           FROM _substrat_deliveries WHERE event_id = ? ORDER BY consumer_module`,
        [entry.id],
      )
      .map(deliveryOf);

    const effects: EventEffects[] = [];
    // Only descend while there is budget. The cap is on NODES rather than depth: a
    // wide fan-out exhausts a reader's screen exactly as a deep one does, and a tree
    // cut without saying so reads as a complete one.
    if (count < cap) {
      const children = ctx.sql.query<{ id: string }>(
        'SELECT id FROM _substrat_outbox WHERE caused_by = ? ORDER BY id',
        [entry.id],
      );
      for (const child of children) {
        if (count >= cap) {
          markTerminal('depth');
          break;
        }
        if (seen.has(child.id)) {
          // A cause is always older than what it caused, so this cannot happen on a
          // sound spine. Named as the integrity failure it is rather than as `depth`,
          // which would invite the reader to retry with a bigger limit.
          markTerminal('cycle');
          continue;
        }
        seen.add(child.id);
        const row = readEvent(child.id);
        // The id came from this very table, so its absence is a race with nothing —
        // reported rather than skipped, for the same reason the backwards walk does.
        if (row === undefined) {
          markTerminal('missing');
          continue;
        }
        effects.push(build(row));
      }
    } else {
      markTerminal('depth');
    }

    return { event: entry, deliveries, effects };
  };

  seen.add(eventId);
  const root = readEvent(eventId);
  if (root === undefined) return { root: null, terminal: 'missing', count: 0 };
  const tree = build(root);
  return { root: tree, terminal, count };
}

/**
 * Everything ONE call did (#1237), oldest first.
 *
 * The third of the three reads, and the one neither walk can reach. `walkEventCause`
 * goes backwards along a chain and `walkEventEffects` goes forwards down a tree — both
 * follow CAUSE, so both miss a sibling. An operation that emits `order.placed` and
 * `stock.reserved` independently has two events with no causal edge between them, and
 * from either one the other is invisible. They are still the same call, and that is what
 * a reader means by "what did this request do".
 *
 * Ordered by id, which is ULID and therefore chronological — the same ordering the
 * timeline and the drain use, so an invocation's events read in the order they happened
 * without a second sort key.
 *
 * Bounded like every other read here. `truncated` says the call did more than is shown,
 * which is a different statement from the call having done this much.
 */
export function readInvocation(
  ctx: TimelineReader,
  invocationId: string,
  limit = 200,
): InvocationEvents {
  const capped = Math.min(Math.max(Math.floor(limit) || 1, 1), 500);
  const rows = ctx.sql.query<HistoryRow>(
    `SELECT ${HISTORY_COLUMNS} FROM _substrat_outbox WHERE invocation_id = ? ORDER BY id LIMIT ?`,
    [invocationId, capped + 1],
  );
  return { events: rows.slice(0, capped).map(mapHistoryRow), truncated: rows.length > capped };
}

/** What joins the two halves of a dead-letter cursor. The first half is a ULID, so it never holds one. */
const DEAD_LETTER_CURSOR_SEPARATOR = '|';

interface DeadLetterRow {
  event_id: string;
  consumer_module: string;
  delivered_at: string;
  error: string;
  attempts: number;
  type: string;
  occurred_at: string;
  entity_type: string;
  entity_id: string;
  /** The EVENT's call — `o.invocation_id`, which is what emitted it. */
  invocation_id: string | null;
  /** #1525: the DELIVERY's call — `d.invocation_id`, the attempt that gave up. */
  attempt_invocation_id: string | null;
}

/**
 * One dead-letter row, decoded against the published `deadLetter` schema (#1643).
 *
 * The four casts this replaces (`eventId`, `occurredAt`, `consumer`, `at`) plus the
 * unchecked `attempts` typed the row as a `DeadLetter` without asking it. Now every field
 * is parsed by its own contract field, on `rowDecoder`'s rules: the two invocation ids are
 * nullable columns and read `null` beside a `decodeError`; every other column is a required
 * scalar with no honest empty value, so a row that breaks one throws, naming them — rather
 * than being returned typed as valid. The cursor is built from the decoded values, so a
 * page can never hand out a cursor its own schema would refuse.
 */
function deadLetterOf(r: DeadLetterRow): DeadLetter {
  const shape = deadLetter.shape;
  const d = rowDecoder(
    `dead-letter row ${JSON.stringify(r.event_id)}/${JSON.stringify(r.consumer_module)}`,
    'DeadLetter',
  );
  return d.finish<DeadLetter>({
    eventId: d.required('event_id', shape.eventId, r.event_id),
    eventType: d.required('type', shape.eventType, r.type),
    occurredAt: d.required('occurred_at', shape.occurredAt, r.occurred_at),
    entity: d.required('entity_type/entity_id', shape.entity, {
      entityType: r.entity_type,
      entityId: r.entity_id,
    }),
    invocationId: d.nullable('invocation_id', shape.invocationId, r.invocation_id ?? null),
    // #1525: the call the LAST attempt ran in, which for these rows is the one that
    // gave up. Usually not the event's: an executor's first attempt runs in the emitting
    // call's tail and every retry after it in a drain, so a delivery that exhausted its
    // attempts most often names a later call or none at all.
    attemptInvocationId: d.nullable(
      'attempt_invocation_id',
      shape.attemptInvocationId,
      r.attempt_invocation_id ?? null,
    ),
    consumer: d.required('consumer_module', shape.consumer, r.consumer_module),
    at: d.required('delivered_at', shape.at, r.delivered_at),
    error: d.required('error', shape.error, r.error),
    attempts: d.required('attempts', shape.attempts, r.attempts),
  });
}

/**
 * Every delivery in the scope that gave up (#1525), newest event first.
 *
 * The question the two walks cannot answer, because they reach a delivery only through
 * its event: "which deliveries in this app gave up?" is the first question in most
 * incidents, and it names no record to start from.
 *
 * **Dead is `error IS NOT NULL AND next_attempt_at IS NULL`, and both halves matter.**
 * A retrying row carries an error too; dropping the second half would list a delivery
 * that is still going to run as one that will not. It is `deliveryOf`'s predicate,
 * spelled in SQL, and the two must not drift.
 *
 * Keyset-paged on `(event_id, consumer_module)` — the delivery table's own primary key,
 * walked backwards — because one event can give up on several consumers, and a cursor on
 * the event alone would skip the rest of them at a page boundary. `event_id` is a ULID,
 * so newest-first is by when the event happened, not when the delivery gave up: an
 * executor that exhausts its retries an hour later still files under its event.
 *
 * Same permission posture as every read here: the caller checks, this does not.
 */
export function readDeadLetters(ctx: TimelineReader, page?: Pick<ListPage, 'limit' | 'cursor'>): Page<DeadLetter> {
  const limit = listLimitOf(page?.limit);
  const cursor = page?.cursor;
  let after = '';
  const params: SqlValue[] = [];
  if (cursor !== undefined) {
    const at = cursor.indexOf(DEAD_LETTER_CURSOR_SEPARATOR);
    // A cursor with no separator names an event and no consumer: strictly before that
    // event, which is the nearest honest reading rather than an error.
    const event = at < 0 ? cursor : cursor.slice(0, at);
    const consumer = at < 0 ? '' : cursor.slice(at + 1);
    after = ' AND (d.event_id < ? OR (d.event_id = ? AND d.consumer_module < ?))';
    params.push(event, event, consumer);
  }
  params.push(limit);
  // #1705: a delivery's event is in this scope's outbox, OR it was received from another
  // vertical and its envelope is in `_substrat_imports`. An import that gave up, or one the
  // producer withheld, is a dead letter this scope's operator must see, so the read takes
  // both. Two LEFT JOINs rather than a UNION: each seeks its table's key, where a UNION ALL
  // subquery in a join could be materialized over the whole outbox. An imported event
  // carries no invocation of this scope, so that column reads null.
  const rows = ctx.sql.query<DeadLetterRow>(
    `SELECT d.event_id, d.consumer_module, d.delivered_at, d.error, d.attempts,
            d.invocation_id AS attempt_invocation_id,
            COALESCE(o.type, i.type) AS type,
            COALESCE(o.occurred_at, i.occurred_at) AS occurred_at,
            COALESCE(o.entity_type, i.entity_type) AS entity_type,
            COALESCE(o.entity_id, i.entity_id) AS entity_id,
            o.invocation_id
       FROM _substrat_deliveries d
       LEFT JOIN _substrat_outbox o ON o.id = d.event_id
       LEFT JOIN _substrat_imports i ON i.event_id = d.event_id
      WHERE d.error IS NOT NULL AND d.next_attempt_at IS NULL
        AND (o.id IS NOT NULL OR i.event_id IS NOT NULL)${after}
      ORDER BY d.event_id DESC, d.consumer_module DESC
      LIMIT ?`,
    params,
  );
  const entries = rows.map(deadLetterOf);
  return pageOf(entries, limit, (e) => `${e.eventId}${DEAD_LETTER_CURSOR_SEPARATOR}${e.consumer}`);
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
  // #1237: which CALL the events came from. The dimension #1231's vocabulary was
  // missing, because until the invocation id existed there was nothing to group on.
  invocation: 'invocation_id',
};
