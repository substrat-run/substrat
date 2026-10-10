/**
 * Refused transitions and refusing guards, recorded (#1745).
 *
 * An illegal move is refused inside the operation by `assertTransition`, which throws a
 * `conflict`; a manifest-declared guard (K-38) refuses the operation it stands before the
 * same way, before the handler runs. The operation's transaction rolls back with either, so
 * nothing about the attempt survives — the denial log holds permission refusals only, and
 * the outbox only what committed. That made "someone tried to reopen a closed conversation
 * twelve times" a fact nobody could see: not on the process map, not in a finding.
 *
 * Recorded the way a denial is (K-35): on the failure path, AFTER the rollback, as a write
 * of its own, so the attempt survives the transaction that refused it. Kernel-owned and
 * shared by both adapters, so the table cannot differ between self-host and production
 * (`lint:spine-ddl` resolves this fragment and compares the effective schema).
 *
 * Only a refusal that FAILED the operation is recorded. One a vertical caught inside
 * `ctx.atomic` and recovered from is the vertical's business — its operation committed.
 *
 * **What a row holds, and what it never does.** Keys and vocabulary only: the record's type
 * (held to the entity-type grammar, `refusalEntityType`) and id, state names, operation and
 * predicate names, the problem code (held to the `problemReason` grammar), the actor's id
 * and the call's. Never the error's message, the operation's input, or a guard's config —
 * any of those can quote what a person typed. So a row has nothing for a subject erasure to rewrite
 * (master-plan §5.3: pseudonymous keys and transaction facts remain), which is the denial
 * log's position too, and it is kept the way the denial log is: `drained_at` marks a shipped
 * row, and rows drain rather than expire.
 */
import {
  errorCodeOf,
  INVALID_TRANSITION,
  problemReason,
  UNRECOGNIZED_REFUSAL_REASON,
  refusalEntityType,
  refusedRecordOf,
  refusedTransitionOf,
  type RefusedTransition,
} from '@substrat-run/contracts';
import { ulid } from './ulid.js';

/** The table alone — what `REFUSALS_REBUILD` creates under its scratch name. */
export const REFUSALS_TABLE_DDL = `
  CREATE TABLE IF NOT EXISTS _substrat_refusals (
    id TEXT PRIMARY KEY,
    -- 'transition' (assertTransition) or 'guard' (a manifest-declared guard, K-38).
    kind TEXT NOT NULL,
    tenant_id TEXT NOT NULL,
    scope_id TEXT,
    -- The record the refusal was about. NULL when the refusing code did not name it: the
    -- attempt is still recorded, and cannot be counted against an entity.
    entity_type TEXT,
    entity_id TEXT,
    -- The state the record was in. NULL on a guard row: a guard stands before an operation,
    -- and the kernel that ran it cannot know the state of the record behind it.
    from_state TEXT,
    -- Where the operation leads where it IS legal; NULL when that is not one state.
    attempted_state TEXT,
    -- The lifecycle's operation (what the edge is keyed by), or the one a guard stands
    -- before, and the invoke() string the call ran as.
    operation TEXT NOT NULL,
    invoked_operation TEXT,
    -- The guard's named predicate; NULL on a transition row.
    guard TEXT,
    -- The problem code the operation failed with (the 409's reason). NULL on a row written
    -- before the column, where the kind implies it.
    reason TEXT,
    actor TEXT NOT NULL,
    impersonation TEXT,
    invocation_id TEXT,
    at TEXT NOT NULL,
    drained_at TEXT
  );
`;

/** The process map's read: one entity type's refusals in a window. */
export const REFUSALS_INDEX = `
  CREATE INDEX IF NOT EXISTS _substrat_refusals_entity_at ON _substrat_refusals (entity_type, at);
`;

/**
 * The table and its index. The adapters interpolate the two literals above instead, which
 * is what `lint:spine-ddl` can resolve; this is for a caller that wants the whole thing.
 */
export const REFUSALS_DDL = REFUSALS_TABLE_DDL + REFUSALS_INDEX;

/**
 * `_substrat_refusals` rebuilt to the shape above on a store created before guard refusals:
 * `from_state` loses its NOT NULL and `guard` / `reason` join. Create-copy-drop-rename,
 * because SQLite cannot relax a constraint in place — `SCHEDULE_STATE_REBUILD`'s shape and
 * reasons (#1288), detected the same way (`refusalsAdmitGuards`, off `sqlite_master.sql`,
 * which DO SQLite serves and `PRAGMA` does not).
 *
 * The new table is `REFUSALS_TABLE_DDL` under a temporary name, so the rebuilt shape cannot drift
 * from the created one, and every row is copied verbatim: the two new columns are NULL on a
 * transition row written before them, which the reader takes as "implied by the kind". The
 * index is dropped with the old table and created again on the renamed one.
 *
 * **Run inside the adapter's transaction API**, as both callers do: un-wrapped, a stop
 * between the DROP and the RENAME leaves the next wake's `CREATE TABLE IF NOT EXISTS` an
 * empty table of the new shape, detection reads it as migrated, and the copied rows are
 * orphaned in the scratch table. The leading `DROP TABLE IF EXISTS` makes a re-run start
 * clean. A restore never reaches this: it builds the table from the current DDL and loads a
 * legacy dump's rows by column name.
 */
export const REFUSALS_REBUILD = `
  DROP TABLE IF EXISTS _substrat_refusals_new;
  ${REFUSALS_TABLE_DDL.replace('CREATE TABLE IF NOT EXISTS _substrat_refusals (', 'CREATE TABLE _substrat_refusals_new (')}
  INSERT INTO _substrat_refusals_new
    (id, kind, tenant_id, scope_id, entity_type, entity_id, from_state, attempted_state,
     operation, invoked_operation, actor, impersonation, invocation_id, at, drained_at)
    SELECT id, kind, tenant_id, scope_id, entity_type, entity_id, from_state, attempted_state,
           operation, invoked_operation, actor, impersonation, invocation_id, at, drained_at
      FROM _substrat_refusals;
  DROP TABLE _substrat_refusals;
  ALTER TABLE _substrat_refusals_new RENAME TO _substrat_refusals;
  ${REFUSALS_INDEX}
`;

/**
 * Whether a store's `_substrat_refusals` already admits a guard row, read off the `sql`
 * column of `sqlite_master`. `false` means `REFUSALS_REBUILD` is due.
 */
export function refusalsAdmitGuards(tableSql: string): boolean {
  // Line-anchored: the stored DDL keeps its comments, and a comment may say "guard".
  return /^\s*guard TEXT,?\s*$/m.test(tableSql);
}

/**
 * A guard refusal, as the kernel records it: which predicate refused which operation, with
 * which problem code, about which record. Stamped on the thrown error by the adapter that
 * ran the guard (`markGuardRefusal`), under a registered symbol for `RefusedTransition`'s
 * reason — none of it belongs in the problem document the caller is handed.
 */
export interface RefusedGuard {
  kind: 'guard';
  predicate: string;
  /** The operation the guard stands before. */
  operation: string;
  /** The problem's `reason` code (`keptReason`), or null when it carried none. */
  reason: string | null;
  entityType: string | null;
  entityId: string | null;
}

const REFUSED_GUARD = Symbol.for('substrat.refused-guard');

/**
 * Mark a guard predicate's throw as a refusal, when it is one — called by both adapters'
 * `runGuards` around each predicate, so the two cannot disagree about what counts.
 *
 * A refusal is a `conflict`: what a predicate throws to say "not yet" (`protocol_required`).
 * Anything else — a validation failure, a bug, a denied check (which the denial log has) —
 * is not a guard refusing, and is left unmarked. So is a throw that already carries a
 * refused transition: it is recorded once, as the transition it is.
 */
export function markGuardRefusal(err: unknown, predicate: string, operation: string): void {
  if (err === null || typeof err !== 'object' || refusedTransitionOf(err)) return;
  if (errorCodeOf(err) !== 'conflict') return;
  const record = refusedRecordOf(err);
  (err as Record<symbol, RefusedGuard>)[REFUSED_GUARD] = {
    kind: 'guard',
    predicate,
    operation,
    reason: keptReason((err as { extensions?: { reason?: unknown } }).extensions?.reason),
    entityType: record?.entityType ?? null,
    entityId: record?.entityId ?? null,
  };
}

/**
 * The reason a row keeps: the problem's code when it is one (`problemReason`), the fixed
 * `UNRECOGNIZED_REFUSAL_REASON` when it is anything else, null when there was none. The
 * wire accepts any non-empty string here, so a predicate could put request text in it.
 */
function keptReason(reason: unknown): string | null {
  if (reason === undefined || reason === null) return null;
  return problemReason.safeParse(reason).success ? (reason as string) : UNRECOGNIZED_REFUSAL_REASON;
}

/** The refusal an operation failed with — a transition, a guard, or null for anything else. */
export function refusalOf(err: unknown): RefusedTransition | RefusedGuard | null {
  const transition = refusedTransitionOf(err);
  if (transition) return transition;
  if (err === null || typeof err !== 'object') return null;
  const g = (err as Record<symbol, unknown>)[REFUSED_GUARD];
  return g !== null && typeof g === 'object' ? (g as RefusedGuard) : null;
}

export interface RefusalRow {
  tenantId: string;
  scopeId: string | null;
  /** What `refusalOf` returned. A `RefusedTransition` carries no `kind`: it is one. */
  refused: RefusedTransition | RefusedGuard;
  invokedOperation: string | null;
  /** The actor, as the outbox stores one: JSON. */
  actor: string;
  impersonation: string | null;
  invocationId: string | null;
  at: string;
}

/** The one INSERT both adapters run, so the rows they write cannot differ. */
export function refusalInsert(row: RefusalRow): { sql: string; params: (string | null)[] } {
  const r = row.refused;
  const guard = 'kind' in r && r.kind === 'guard' ? r : null;
  const transition = guard ? null : (r as RefusedTransition);
  return {
    sql: `INSERT INTO _substrat_refusals
            (id, kind, tenant_id, scope_id, entity_type, entity_id, from_state, attempted_state,
             operation, invoked_operation, guard, reason, actor, impersonation, invocation_id, at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    params: [
      ulid(),
      guard ? 'guard' : 'transition',
      row.tenantId,
      row.scopeId,
      // The type reaches here from code that may be handed request data; kept only when it
      // is spelled as one. The id stays: it is the record's key, the join every log shares.
      refusalEntityType(r.entityType),
      r.entityId,
      transition?.from ?? null,
      transition?.attempted ?? null,
      r.operation,
      row.invokedOperation,
      guard?.predicate ?? null,
      // Bounded here too, the one INSERT, so no caller of this function can keep raw text.
      guard ? keptReason(guard.reason) : INVALID_TRANSITION,
      row.actor,
      row.impersonation,
      row.invocationId,
      row.at,
    ],
  };
}
