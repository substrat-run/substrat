import type { EntityRef } from '@substrat-run/contracts';

/**
 * An entity's version — the ULID of the last event about it (#901).
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
 * ANY event about the entity moves the version, including one that changed
 * nothing the caller read. A precondition built on this is therefore
 * conservative: it can refuse a write that would in fact have been safe, and it
 * cannot admit one that would not. That is the correct direction to fail, and it
 * is a real difference from a per-row counter — documented here rather than
 * discovered by someone debugging a 412 they think is spurious.
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
 * `MAX(id)` with no `GROUP BY` always returns exactly one row — the value is
 * NULL when the entity has no events. So absence is a null column, never a
 * missing row, and the caller distinguishes "never touched" from "touched" on
 * the value alone.
 */
export function entityVersionQuery(ref: EntityRef): {
  sql: string;
  params: [string, string];
} {
  return {
    sql: 'SELECT MAX(id) AS version FROM _substrat_outbox WHERE entity_type = ? AND entity_id = ?',
    params: [ref.entityType, ref.entityId],
  };
}

/**
 * The index that makes the query a seek instead of a scan.
 *
 * Column order matters and is not arbitrary: the two equality predicates come
 * first, and `id` last so SQLite answers `MAX(id)` by walking to the end of the
 * matched range rather than aggregating over it. Emitted into both adapters'
 * spine DDL — kernel-owned, so no vertical carries a migration for it.
 *
 * The outbox had no index at all before this. Every other spine table with a
 * filtered read has one (`_substrat_access_log_actor`, `_substrat_admin_log_scope`,
 * and the rest); the outbox was only ever read by drain order, which is its
 * primary key.
 */
export const OUTBOX_ENTITY_INDEX =
  'CREATE INDEX IF NOT EXISTS _substrat_outbox_entity ON _substrat_outbox (entity_type, entity_id, id);';

/** The row `entityVersionQuery` returns — one row, `version` null when there are no events. */
export interface EntityVersionRow {
  readonly version: string | null;
}

/** Normalise the single row into the contract's answer. */
export function entityVersionOf(rows: readonly EntityVersionRow[]): EntityVersion | null {
  return rows[0]?.version ?? null;
}
