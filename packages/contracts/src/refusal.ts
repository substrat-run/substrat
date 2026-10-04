import { z } from 'zod';
import { actor } from './events.js';
import { impersonationStamp } from './impersonation.js';
import { scopeId, tenantId } from './ids.js';
import { lifecycleActorKind } from './lifecycle-flow.js';
import { OBJECT_NAMESPACE, isKernelNamespace } from './object-ref.js';

/**
 * The read side of the refusal log (#1745) — a scope-local record of every lifecycle move
 * `assertTransition` refused, and every manifest-declared guard (K-38) that refused the
 * operation it stands before, where the operation failed with it. Written on the failure
 * path as a write of its own AFTER the rollback it is evidence of.
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

/** What a refusal row stores for a reason outside the `problemReason` grammar. */
export const UNRECOGNIZED_REFUSAL_REASON = 'unrecognized';

/** How many refusal rows an unbounded read returns — a screenful, newest-first. */
export const DEFAULT_REFUSAL_LIMIT = 50;
/** The hard ceiling on one page of refusal rows. */
export const REFUSAL_LIMIT_MAX = 200;

/**
 * One recorded refusal.
 *
 * `kind` is `'transition'` for a move the lifecycle refused and `'guard'` for an operation a
 * manifest-declared guard refused (K-38). It is read as text rather than a closed enum so a
 * reader built now does not reject a kind a later kernel writes.
 */
export const refusalRecord = z.object({
  /** ULID — chronological, so it is also the sort key. */
  id: z.string().min(1),
  kind: z.string().min(1),
  /**
   * The problem code the operation failed with — the `reason` on the 409 the caller received:
   * `invalid_transition` for a transition refusal, the predicate's own (`protocol_required`)
   * for a guard. Null when the refusal carried none and the kind implies none, and
   * `UNRECOGNIZED_REFUSAL_REASON` when it carried one outside the `problemReason` grammar —
   * kept as a code, never as whatever text the thrower put there.
   */
  reason: z.string().nullable(),
  /** The guard's named predicate (`protocol/all-signed`) on a `'guard'` row; null otherwise. */
  guard: z.string().nullable(),
  /** WHO attempted the move: a principal, a `{ system }` module, a `{ connection }`, … */
  actor,
  /** The actor's kind, read off its stored shape — what the process map counts by. */
  actorKind: lifecycleActorKind,
  tenantId,
  scopeId: scopeId.nullable(),
  /**
   * The record the refusal was about. Null when the refusing code did not name it — the
   * caller of `assertTransition`, or a guard predicate that did not `nameRefusedRecord`.
   * The type is `UNDECLARED_ENTITY_TYPE` when what it was handed is not spelled as one
   * (`refusalEntityType`).
   */
  entityType: z.string().nullable(),
  entityId: z.string().nullable(),
  /**
   * The state the record was in. Null on a `'guard'` row: a guard stands before an operation,
   * and the kernel that ran it does not know the state of the record behind it.
   */
  fromState: z.string().nullable(),
  /** Where the operation leads where it IS legal; null when that is not one state, and on a guard. */
  attemptedState: z.string().nullable(),
  /** The lifecycle's operation — what the edge is keyed by — or the operation the guard stands before. */
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
  /** `'transition'` or `'guard'`; every kind when absent. */
  kind: z.string().min(1).optional(),
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

/**
 * Name the record a refusal is about, on the error that carries it (#1745).
 *
 * For a guard predicate (K-38): the kernel records a guard's refusal, but only the predicate
 * knows which record it judged — its config says where the id is, and the kernel does not
 * read a predicate's config. A predicate that names it lets the process map count the
 * refusal against that record; one that does not is still recorded, with the record unknown.
 *
 * Carried under a registered symbol for the reason `RefusedTransition` is: the record's id
 * is the scope's to keep, never part of the problem document the caller is handed. Returns
 * the error, so a throw site reads `throw nameRefusedRecord(conflict(…), ref)`.
 */
export function nameRefusedRecord<E>(err: E, ref: { entityType: string; entityId: string }): E {
  if (err !== null && typeof err === 'object') {
    (err as Record<symbol, unknown>)[REFUSED_RECORD] = { entityType: ref.entityType, entityId: ref.entityId };
  }
  return err;
}

const REFUSED_RECORD = Symbol.for('substrat.refused-record');

/** The record `nameRefusedRecord` put on an error, or null. */
export function refusedRecordOf(err: unknown): { entityType: string; entityId: string } | null {
  if (err === null || typeof err !== 'object') return null;
  const r = (err as Record<symbol, unknown>)[REFUSED_RECORD];
  return r !== null && typeof r === 'object' ? (r as { entityType: string; entityId: string }) : null;
}

/** What a refusal row stores as its entity type when the one it was handed is not one. */
export const UNDECLARED_ENTITY_TYPE = 'undeclared';
/** The longest entity type a refusal row keeps. */
export const REFUSAL_ENTITY_TYPE_MAX = 64;

/**
 * The entity type a refusal row keeps (#1745): the one it was handed when that is spelled as
 * an entity type — the tuple namespace grammar (`OBJECT_NAMESPACE`, which `ctx.link` and every
 * entity-narrowed grant are held to), not a kernel namespace, at most
 * `REFUSAL_ENTITY_TYPE_MAX` — and `UNDECLARED_ENTITY_TYPE` otherwise. Null stays null: the
 * record was not named.
 *
 * Needed because the type reaches a row from code that is handed request data — a guard
 * predicate naming its record with `nameRefusedRecord` — and the ref takes any string. The
 * grammar refuses an address, a sentence, anything with a space; it cannot tell a bare word
 * from a type, which no runtime registry of a scope's entity types exists to do.
 */
export function refusalEntityType(entityType: string | null): string | null {
  if (entityType === null) return null;
  return entityType.length <= REFUSAL_ENTITY_TYPE_MAX &&
    OBJECT_NAMESPACE.test(entityType) &&
    !isKernelNamespace(entityType)
    ? entityType
    : UNDECLARED_ENTITY_TYPE;
}
