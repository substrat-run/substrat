/**
 * Refused transitions, recorded (#1745).
 *
 * An illegal move is refused inside the operation by `assertTransition`, which throws a
 * `conflict`. The operation's transaction rolls back with it, so nothing about the attempt
 * survives — the denial log holds permission refusals only, and the outbox only what
 * committed. That made "someone tried to reopen a closed conversation twelve times" a fact
 * nobody could see: not on the process map, not in a finding.
 *
 * Recorded the way a denial is (K-35): on the failure path, AFTER the rollback, as a write
 * of its own, so the attempt survives the transaction that refused it. Kernel-owned and
 * shared by both adapters, so the table cannot differ between self-host and production
 * (`lint:spine-ddl` resolves this fragment and compares the effective schema).
 *
 * Only a refusal that FAILED the operation is recorded. One a vertical caught inside
 * `ctx.atomic` and recovered from is the vertical's business — its operation committed.
 */
import { refusedTransitionOf, type RefusedTransition } from '@substrat-run/contracts';
import { ulid } from './ulid.js';

export const REFUSALS_DDL = `
  CREATE TABLE IF NOT EXISTS _substrat_refusals (
    id TEXT PRIMARY KEY,
    -- 'transition' today; a guard refusal (K-38) is the next kind, recorded the same way.
    kind TEXT NOT NULL,
    tenant_id TEXT NOT NULL,
    scope_id TEXT,
    -- The record the move was refused on. NULL when the caller of assertTransition did
    -- not name it: the attempt is still recorded, and cannot be counted against an entity.
    entity_type TEXT,
    entity_id TEXT,
    from_state TEXT NOT NULL,
    -- Where the operation leads where it IS legal; NULL when that is not one state.
    attempted_state TEXT,
    -- The lifecycle's operation (what the edge is keyed by) and the invoke() string the
    -- call ran as; the same today for every caller, kept apart because they need not be.
    operation TEXT NOT NULL,
    invoked_operation TEXT,
    actor TEXT NOT NULL,
    impersonation TEXT,
    invocation_id TEXT,
    at TEXT NOT NULL,
    drained_at TEXT
  );
  -- The process map's read: one entity type's refusals in a window.
  CREATE INDEX IF NOT EXISTS _substrat_refusals_entity_at ON _substrat_refusals (entity_type, at);
`;

export interface RefusalRow {
  tenantId: string;
  scopeId: string | null;
  refused: RefusedTransition;
  invokedOperation: string | null;
  /** The actor, as the outbox stores one: JSON. */
  actor: string;
  impersonation: string | null;
  invocationId: string | null;
  at: string;
}

/** The one INSERT both adapters run, so the rows they write cannot differ. */
export function refusalInsert(row: RefusalRow): { sql: string; params: (string | null)[] } {
  return {
    sql: `INSERT INTO _substrat_refusals
            (id, kind, tenant_id, scope_id, entity_type, entity_id, from_state, attempted_state,
             operation, invoked_operation, actor, impersonation, invocation_id, at)
          VALUES (?, 'transition', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    params: [
      ulid(),
      row.tenantId,
      row.scopeId,
      row.refused.entityType,
      row.refused.entityId,
      row.refused.from,
      row.refused.attempted,
      row.refused.operation,
      row.invokedOperation,
      row.actor,
      row.impersonation,
      row.invocationId,
      row.at,
    ],
  };
}

/** The refused transition an operation failed with, or null — what the adapters branch on. */
export { refusedTransitionOf };
