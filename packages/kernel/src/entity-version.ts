import { ENTITY_STATE_MOVE_TYPES, ifMatchAdmits, substratError, type EntityRef } from '@substrat-run/contracts';

/**
 * An entity's version — the ULID of the last event about it (#901), a kernel state move
 * excepted (#2191).
 *
 * ## There is no version column, and there should not be one
 *
 * This began as a `_version INTEGER` on every entity table, bumped by a trigger
 * the DDL emitter would ship per table. That design works, and it was rejected
 * for two reasons that are not about cost.
 *
 * It would have put a platform guarantee into per-vertical DDL. The only way to
 * make a column unforgettable is a trigger, and a trigger is SQLite — replicated
 * into every table, re-derived for every vertical authored afterwards, and
 * unavailable to any adapter that is not SQLite. The scope-host contract is not
 * a SQL contract; `query`/`exec` are how *these* adapters happen to serve it.
 *
 * And the version already existed. `_substrat_outbox` has recorded `entity_type`
 * and `entity_id` against a monotonic ULID `id` since it was written, on every
 * event, for every module. Nothing needed to be added to a row.
 *
 * ## Why the ULID is a sound version
 *
 * - **Monotonic and exactly comparable.** `ulid()` uses the spec's monotonic
 *   factory, and its header names that load-bearing precisely because this table
 *   orders by id: two events in one millisecond still sort in creation order.
 * - **Never pruned.** The outbox DRAINS, it does not expire (K-24's split) —
 *   `drained_at` marks a shipped row and nothing deletes it.
 * - **Survives erasure.** A shred nulls `payload` and keeps the row, so an
 *   erased entity can still refuse a stale write. A version that vanished with
 *   the data would fail open at exactly the wrong moment.
 * - **Unforgeable.** Module code cannot write `_substrat_*` (rule 3). A column
 *   would have had to earn that property with a trigger clever enough to reset a
 *   forged value; the spine has it by construction.
 *
 * ## What it is sensitive to
 *
 * Every event about the entity moves the version but four: the kernel's state moves
 * (`ENTITY_STATE_MOVE_TYPES` — archive, unarchive, trash, restore, #2191). The version exists
 * to refuse a write over content the caller has not seen, and a move changes no content — it
 * sets a `_substrat_*_at` column no read hands a client. Counting it refused, with a 412
 * "changed since you read it", the next guarded write of a client that had only moved the row.
 * A trashed row is refused (`not_found`) to every operation whose declared check names it except one that
 * declares `trashed: 'admits'` or `'purges'` — a restore, a delete for good, the purge — and a
 * guarded one of those still compares its tag. An ARCHIVED row is refused to none, so a write
 * made with a tag read before the archive is admitted and lands on the archived row, which stays
 * archived. Nothing it read was overwritten.
 *
 * Every other event still counts, including one that changed nothing the caller read — a grant
 * top-up, say. A precondition built on this is therefore conservative: it can refuse a write
 * that would in fact have been safe, and it cannot admit one that would not. That is the correct
 * direction to fail, and it is a real difference from a per-row counter — documented here rather
 * than discovered by someone debugging a 412 they think is spurious.
 *
 * The converse is the one hole worth naming: a mutation that emits no event does
 * not move the version. "Every mutation emits a fat event" is a rule that review
 * enforces and `boundary-lint` does not, so the answer is not here — it is that
 * a declared `concurrency` must be compile-checked against the operation's
 * declared `emits` (#129), which is strictly more than a trigger would have
 * given: a trigger guarantees the column moved, never that the operation
 * announced what it did.
 */

/** The opaque version token. A ULID, but callers compare it — they do not read it. */
export type EntityVersion = string;

/**
 * The one SELECT behind every read of an entity's version.
 *
 * Both adapters call this rather than writing the query twice, for the same
 * reason `platformRequestHistoryQuery` exists: two surfaces answering one
 * question from one table must not drift on what the answer means.
 *
 * The newest event about the entity that is not a state move. `ORDER BY id DESC
 * LIMIT 1`, not `MAX(id)`: with the type predicate SQLite cannot answer `MAX`
 * from the index's end and would aggregate over every event about the entity,
 * where this walks `OUTBOX_ENTITY_INDEX` backwards and stops at the first row
 * that is not a move. An entity with no such event returns no row, which
 * `entityVersionOf` reads as null — "never touched" and "touched" are told apart
 * on the value alone.
 */
export function entityVersionQuery(ref: EntityRef): {
  sql: string;
  params: string[];
} {
  return {
    sql:
      'SELECT id AS version FROM _substrat_outbox WHERE entity_type = ? AND entity_id = ? ' +
      `AND type NOT IN (${ENTITY_STATE_MOVE_TYPES.map(() => '?').join(', ')}) ORDER BY id DESC LIMIT 1`,
    params: [ref.entityType, ref.entityId, ...ENTITY_STATE_MOVE_TYPES],
  };
}

/**
 * The index that makes the query a seek instead of a scan.
 *
 * Column order matters and is not arbitrary: the two equality predicates come
 * first, and `id` last so SQLite answers the newest id by walking the matched
 * range backwards from its end rather than aggregating over it. Emitted into both adapters'
 * spine DDL — kernel-owned, so no vertical carries a migration for it.
 *
 * The outbox had no index at all before this. Every other spine table with a
 * filtered read has one (`_substrat_access_log_actor`, `_substrat_admin_log_scope`,
 * and the rest); the outbox was only ever read by drain order, which is its
 * primary key.
 */
export const OUTBOX_ENTITY_INDEX =
  'CREATE INDEX IF NOT EXISTS _substrat_outbox_entity ON _substrat_outbox (entity_type, entity_id, id);';

/** The row `entityVersionQuery` returns — none when the entity has no event that counts. */
export interface EntityVersionRow {
  readonly version: string | null;
}

/** Normalise the single row into the contract's answer. */
export function entityVersionOf(rows: readonly EntityVersionRow[]): EntityVersion | null {
  return rows[0]?.version ?? null;
}

/**
 * Refuse a write whose caller is holding a stale version (#129).
 *
 * Both adapters call this rather than comparing twice, for the reason
 * `entityVersionQuery` exists one screen up: two surfaces answering one question
 * must not drift on what the answer means. Here the answer decides whether a
 * write lands, so drifting would mean one host silently admitting what the other
 * refuses.
 *
 * ## This must be called INSIDE the operation's transaction
 *
 * A precondition read outside the write's transaction is a time-of-check /
 * time-of-use bug wearing a safety mechanism's clothes: the version is read, a
 * concurrent writer commits, and then the guarded write commits over it having
 * "passed". Serialising the read with the write is the entire guarantee, so this
 * takes a version the CALLER has already read under `BEGIN`, and cannot do the
 * read itself without inviting the mistake.
 *
 * ## The refusal deliberately carries no version
 *
 * See `PROBLEM_EXTENSIONS.precondition_failed`. Handing the current tag back
 * turns the obvious client fix into a blind retry that overwrites the change
 * which caused the refusal.
 */
export function assertIfMatch(ref: EntityRef, ifMatch: string, version: EntityVersion | null): void {
  if (ifMatchAdmits(ifMatch, version)) return;
  throw substratError(
    'precondition_failed',
    version === null
      ? `${ref.entityType} ${ref.entityId} has no recorded version — it may never have existed, ` +
        'or the write you are holding a tag for was rolled back'
      : `${ref.entityType} ${ref.entityId} changed since you read it`,
    { entity: ref },
  );
}
