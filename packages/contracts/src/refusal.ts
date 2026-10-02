import { z } from 'zod';
import { actor } from './events.js';
import { impersonationStamp } from './impersonation.js';
import { scopeId, tenantId } from './ids.js';
import { lifecycleActorKind } from './lifecycle-flow.js';

/**
 * The read side of the refusal log (#1745) — a scope-local record of every lifecycle move
 * `assertTransition` refused and the operation failed with, written on the failure path as
 * a write of its own AFTER the rollback it is evidence of.
 *
 * The denial log's sibling, and read the same way (`permissionDenial` / `denialFilter`):
 * a denial is the permission model disagreeing with an actor, a refusal is the lifecycle
 * disagreeing with one. `lifecycleFlow` already counts these per (from, attempted) for the
 * process map; this is the row read beneath that count — WHICH record, WHO, in WHICH call —
 * so a red stub reaches the requests that drew it.
 *
 * The same two properties hold as for denials: the volume is actor-influenceable (a client
 * retrying an illegal move mints a row per attempt), and the window is a storage bound,
 * not a retention promise — rows drain rather than expire.
 */

/** How many refusal rows an unbounded read returns — a screenful, newest-first. */
export const DEFAULT_REFUSAL_LIMIT = 50;
/** The hard ceiling on one page of refusal rows. */
export const REFUSAL_LIMIT_MAX = 200;

/**
 * One recorded refusal.
 *
 * `kind` is `'transition'` for every row today; a K-38 guard refusal is the next kind,
 * recorded in the same table. It is read as text rather than a closed enum so a reader
 * built now does not reject the row a later kernel writes.
 */
export const refusalRecord = z.object({
  /** ULID — chronological, so it is also the sort key. */
  id: z.string().min(1),
  kind: z.string().min(1),
  /**
   * The problem code the operation failed with — `invalid_transition` for a transition
   * refusal, which is the `reason` on the 409 the caller received. Null for a kind this
   * reader does not know the code of.
   */
  reason: z.string().nullable(),
  /** WHO attempted the move: a principal, a `{ system }` module, a `{ connection }`, … */
  actor,
  /** The actor's kind, read off its stored shape — what the process map counts by. */
  actorKind: lifecycleActorKind,
  tenantId,
  scopeId: scopeId.nullable(),
  /** The record the move was refused on. Null when the caller of `assertTransition` did not name it. */
  entityType: z.string().nullable(),
  entityId: z.string().nullable(),
  /** The state the record was in. */
  fromState: z.string(),
  /** Where the operation leads where it IS legal; null when that is not one state. */
  attemptedState: z.string().nullable(),
  /** The lifecycle's operation — what the edge is keyed by. */
  operation: z.string(),
  /** The `invoke()` string the call ran as. The same as `operation` for every caller today. */
  invokedOperation: z.string().nullable(),
  /** The staff actor and session behind the attempt (K-42), or null for the ordinary case. */
  impersonation: impersonationStamp.nullable(),
  /** The invocation the refusal happened during — the join to the rest of its request. */
  invocationId: z.string().nullable(),
  /** ISO 8601. */
  at: z.string().min(1),
  drainedAt: z.string().nullable(),
  /**
   * Why this row could not be read whole — ABSENT on every row the kernel wrote. Same rule
   * as `permissionDenial.decodeError` (#1636): an undecodable actor or impersonation reads
   * as its empty value beside this, rather than taking the page down.
   */
  decodeError: z.string().min(1).optional(),
});
export type RefusalRecord = z.infer<typeof refusalRecord>;

/**
 * What narrows a refusal read. Every field is an exact match except the `since`/`until`
 * bounds on `at` (inclusive lower, exclusive upper) — the denial filter's convention, so
 * adjacent windows tile.
 *
 * `actor` takes the LOGICAL actor, as `denialFilter.actor` does: a bare principal ULID or
 * the object form for any other kind. The stored encoding is the reader's problem.
 */
export const refusalFilter = z.object({
  entityType: z.string().min(1).optional(),
  entityId: z.string().min(1).optional(),
  actor: z.string().min(1).optional(),
  operation: z.string().min(1).optional(),
  invocationId: z.string().min(1).optional(),
  /** ISO 8601, inclusive. */
  since: z.string().min(1).optional(),
  /** ISO 8601, exclusive. */
  until: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(REFUSAL_LIMIT_MAX).optional(),
});
export type RefusalFilter = z.infer<typeof refusalFilter>;
