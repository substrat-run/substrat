import { z } from 'zod';
import { actor } from './events.js';
import { permissionKey, scopeId, tenantId } from './ids.js';

/**
 * The read side of the K-35 denial log — a scope-local record of every ENFORCED
 * permission refusal (`assertAllowed`), written on the deny path as a fresh
 * autocommit AFTER the rollback it is evidence of.
 *
 * This is the *other* kind of evidence from a conformance receipt. A receipt says
 * "we attempted the attack in CI at commit X"; these rows say "on your data, in
 * production, here is every refusal, by whom, against which key". K-35 made the
 * case for the row itself: a denial is the one event where an actor's intent and
 * the permission model visibly disagree.
 *
 * Two properties of the log shape everything below, and both come straight from
 * K-35's own reasoning about why denials are NOT admin-log entries:
 *
 * 1. **The volume is attacker-influenceable.** A probing client mints unlimited
 *    rows, so a newest-first page of raw rows is the wrong default view — 200 rows
 *    from one prober hide everyone else. That is why `denialSummary` exists beside
 *    the row list, and why K-35 called rate-bucketing sanctionable up front.
 * 2. **The window is a storage bound, not a retention policy.** Rows `drain` rather
 *    than expire (K-24's split). Until a Tier-2 sink exists, what is here is simply
 *    what has not been pruned — so the summary reports the window's own floor
 *    (`windowOldestAt`) rather than letting a caller read absence as "never happened".
 */

/** How many denial rows an unbounded read returns — a screenful, newest-first. */
export const DEFAULT_DENIAL_LIMIT = 50;
/** The hard ceiling on one page of denial rows, and on one page of buckets. */
export const DENIAL_LIMIT_MAX = 200;

/**
 * One recorded refusal. `scopeId` is null for a tenant-node check (one that named no
 * scope); `operation` is null when the denial unwound something that was not an
 * operation invocation. `drainedAt` marks a row already shipped to a Tier-2 sink and
 * therefore eligible to be pruned — bookkeeping, not a judgement about the denial.
 */
export const permissionDenial = z.object({
  /** ULID — chronological, so it is also the sort key. */
  id: z.string().min(1),
  /** WHO was refused: a principal, a `{ system }` module, or a `{ connection }`. */
  actor,
  /** The key `assertAllowed` checked and refused. */
  permission: permissionKey,
  tenantId,
  scopeId: scopeId.nullable(),
  /** The operation the denial rolled back, e.g. `workorder/complete`. */
  operation: z.string().nullable(),
  /** ISO 8601. */
  at: z.string().min(1),
  drainedAt: z.string().nullable(),
});
export type PermissionDenial = z.infer<typeof permissionDenial>;

/**
 * What narrows a denial read. Every field is an exact match except the `since`/`until`
 * bounds on `at` (inclusive lower, exclusive upper) — enough to answer "who probed
 * this key", "what did this actor try", and "what happened during the incident window"
 * without a SQL console.
 *
 * `actor` takes the LOGICAL actor — a bare principal ULID, or the object form for a
 * system/connection actor (`{"system":"invoicing"}`). The writer persists
 * `JSON.stringify(actor)`, so a principal is stored with its quotes; normalizing to that
 * encoding is the reader's job (`storedActor` in the kernel's query builder), not every
 * caller's.
 */
export const denialFilter = z.object({
  actor: z.string().min(1).optional(),
  permission: z.string().min(1).optional(),
  operation: z.string().min(1).optional(),
  /** ISO 8601, inclusive. */
  since: z.string().min(1).optional(),
  /** ISO 8601, exclusive. */
  until: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(DENIAL_LIMIT_MAX).optional(),
});
export type DenialFilter = z.infer<typeof denialFilter>;

/**
 * One (actor, permission) bucket — K-35's "first occurrence + count per actor/key/
 * window", which is the shape that survives a flood. `operations` is the number of
 * DISTINCT operations the actor was refused this key on, and it is the discriminator
 * worth the extra aggregate: one operation refused four hundred times is a broken
 * screen or a misconfigured role, while the same count spread across a dozen
 * operations is someone walking the surface.
 */
export const denialBucket = z.object({
  actor,
  permission: permissionKey,
  count: z.number().int().positive(),
  operations: z.number().int().nonnegative(),
  /** ISO 8601 — the first occurrence still in the window (see `windowOldestAt`). */
  firstAt: z.string().min(1),
  lastAt: z.string().min(1),
});
export type DenialBucket = z.infer<typeof denialBucket>;

/**
 * The bucketed view of a scope's denial log, plus the facts that keep it honest.
 *
 * `total` counts every row matching the filter, so a caller can tell a capped bucket
 * list from a complete one. `windowOldestAt` is deliberately computed WITHOUT the
 * filter: it is a statement about the log, not about the query — the earliest moment
 * this scope can still speak to. An empty result older than it means "no denials";
 * an empty result at it means "we no longer hold that far back".
 */
export const denialSummary = z.object({
  buckets: z.array(denialBucket),
  /** Rows matching the filter. Bucket counts sum to this when `buckets` is uncapped. */
  total: z.number().int().nonnegative(),
  /** Distinct actors among the matching rows. */
  actors: z.number().int().nonnegative(),
  /**
   * The oldest row STILL HELD, filter ignored — the window's floor, null when the log
   * is empty. The window is a storage bound and not a retention policy (K-35): what is
   * absent before this instant was not necessarily never recorded.
   */
  windowOldestAt: z.string().nullable(),
  /** The newest row held, filter ignored. */
  windowNewestAt: z.string().nullable(),
  /** Rows already shipped to a Tier-2 sink, filter ignored — prunable, not pruned. */
  drained: z.number().int().nonnegative(),
});
export type DenialSummary = z.infer<typeof denialSummary>;
