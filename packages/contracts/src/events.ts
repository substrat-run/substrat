import { z } from 'zod';
import {
  dataSubjectId,
  eventId,
  instant,
  moduleId,
  permissionKey,
  principalId,
  scopeId,
  tenantId,
} from './ids.js';
import { impersonationStamp } from './impersonation.js';

// Opaque ref — the kernel owns no entities (D-1); attachment contracts bind here.
export const entityRef = z.object({
  entityType: z.string().min(1),
  entityId: z.string().min(1),
});
export type EntityRef = z.infer<typeof entityRef>;

// Drives crypto-shredding (§5.3 of the plan). Required at the type level:
// an event that COULD carry PII cannot be declared without classification.
export const piiClass = z.enum(['none', 'pseudonymous', 'direct']);
export type PiiClass = z.infer<typeof piiClass>;

// 'workorder.completed' — module-namespaced
export const eventType = z.string().regex(/^[a-z0-9-]+\.[a-z0-9-]+$/);

export const systemActor = z.object({ system: moduleId });
/**
 * A CONNECTOR acted — an external provider's callback, effected through a
 * connection (#97).
 *
 * A third member rather than a synthetic principal, for the reason
 * `PlatformActorId` is branded separately from `PrincipalId`: a connector that
 * reads as a person in the audit trail is worse than one that cannot act at
 * all. The spine has to be able to say "Scrive did this" without naming a human
 * who did not.
 */
export const connectorActor = z.object({ connection: z.string().min(1) });
export const actor = z.union([principalId, systemActor, connectorActor]);
export type Actor = z.infer<typeof actor>;

/**
 * What authorized a mutation (K-34). Each entry is a permission the emitting operation
 * checked-and-passed; `grant` — present only when the allow resolved through a
 * `granted:<perm>` tuple (an entity or node capability grant) rather than a role bundle —
 * is that granting tuple's `object`, which names WHICH grant (e.g. `workorder:01J…`,
 * `scope:01J…`). Absent `grant` ⇒ authorized by a role.
 *
 * Kernel-stamped: module code can neither supply it (it is not on `DomainEventInput`) nor
 * suppress it. The full proof chain is deliberately NOT persisted — `explain` re-derives
 * chains on demand; what re-derivation cannot recover, once tuples have since changed, is
 * which permission and grant were consulted at write time. That pointer is what is kept.
 */
export const eventAuthorization = z.object({
  permission: permissionKey,
  grant: z
    .string()
    .regex(/^[a-z0-9_-]+:[^\s]+$/)
    .optional(),
});
export type EventAuthorization = z.infer<typeof eventAuthorization>;

const piiInvariant = (
  val: { piiClass: PiiClass; subjectId?: unknown },
  ctx: z.RefinementCtx,
): void => {
  if (val.piiClass !== 'none' && val.subjectId === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['subjectId'],
      message: `subjectId is required when piiClass is '${val.piiClass}' — crypto-shredding must be able to key the erasure`,
    });
  }
};

// What module code passes to emit(). Everything identifying the origin is
// deliberately absent — the kernel stamps it (§6.1 of the design doc).
export const domainEventInput = z
  .object({
    type: eventType,
    schemaVersion: z.number().int().positive(),
    entity: entityRef,
    piiClass,
    subjectId: dataSubjectId.optional(),
    payload: z.unknown(),
  })
  .superRefine(piiInvariant);
export type DomainEventInput = z.infer<typeof domainEventInput>;

/**
 * The envelope's SHAPE, unrefined — the one place its fields are written down.
 *
 * `domainEvent` below is this plus the PII rule, and `drainedEvent` is this with
 * two columns swapped in plus the SAME rule. Keeping the shape separate is what
 * lets the second exist: the two schemas disagree about `operation` (optional in
 * the envelope, nullable on the way out of the spine), so neither can be built
 * from the other by extension, and intersecting them would demand a value satisfy
 * both — which `null` cannot.
 */
const domainEventShape = z
  .object({
    id: eventId, // ULID; idempotency key downstream (consumers are required-idempotent)
    type: eventType,
    schemaVersion: z.number().int().positive(),
    occurredAt: instant, // stamped by kernel
    tenantId, // stamped by kernel — a vertical cannot mislabel an event's origin
    scopeId, // stamped by kernel
    actor, // stamped by kernel from the stub's ambient context
    entity: entityRef,
    piiClass,
    subjectId: dataSubjectId.optional(),
    // K-34: the checks the emitting operation passed — stamped kernel-side, absent on
    // events written before the field existed (honestly unrecorded, not empty).
    authorization: z.array(eventAuthorization).optional(),
    // K-42: the staff actor and session this ran under, when it ran under one.
    // `actor` above stays the IMPERSONATED principal — the permission model
    // answered about them and the domain fact is theirs; this says who was
    // holding the keyboard. Stamped kernel-side on K-34's pattern: absent from
    // `DomainEventInput`, so module code can neither claim a session nor drop one.
    // Absent (not empty) on every ordinary event, which is the honest reading.
    impersonation: impersonationStamp.optional(),
    // The signals `operation` dimension (#1231): the operation this event was
    // emitted from — the exact `invoke()` string (`ticket0/answer`,
    // `attachments.upload`), which for a scheduled emit is the schedule's own
    // operation. Stamped kernel-side on the same pattern as the two above, so
    // module code can neither forge nor suppress it. Absent on a CONSUMER-emitted
    // event — a consumer runs on behalf of no operation, and inventing a
    // pseudo-name here would make "which operations emit this" answer with
    // things that are not operations — and absent on rows that predate the field.
    operation: z.string().min(1).optional(),
    payload: z.unknown(),
  });

// The full envelope as it enters the spine.
export const domainEvent = domainEventShape.superRefine(piiInvariant);
export type DomainEvent = z.infer<typeof domainEvent>;

/**
 * One entry of an entity's TIMELINE — the envelope of an event about it, and
 * nothing that was said (#800).
 *
 * Five demos hand-wrote the `SELECT` behind this and all five published a
 * different shape for it, which is the small half of the problem. The large half
 * is that two of the four fields are not what a reader of `_substrat_outbox`
 * assumes:
 *
 * - **`actor` is the union, not an id.** The writer persists
 *   `JSON.stringify(actor)`, so a principal is stored WITH its quotes and a
 *   system or connector actor is stored as an object. `SELECT actor` returns a
 *   string that looks usable and is not — an agent building a timeline hit this
 *   as a real bug and had to read the adapter to find it. Here the column is
 *   decoded once, so a caller resolving a name gets the union the spine actually
 *   recorded rather than a string to trim quotes off.
 * - **`id` is the entity's VERSION at this point** (#901), not just a row key.
 *   The same token `versionOf` returns and `If-Match` compares, so "list the
 *   history", "restore to this version" and "refuse my stale write" speak one
 *   vocabulary. It is therefore the cursor: `ORDER BY id` is creation order
 *   because `ulid()` is monotonic, and `OUTBOX_ENTITY_INDEX` makes the walk a
 *   seek.
 */
export const timelineEntry = z.object({
  id: eventId,
  type: eventType,
  occurredAt: instant,
  actor,
});
export type TimelineEntry = z.infer<typeof timelineEntry>;

/**
 * A timeline entry plus what a history VIEW needs — the second layer of #800.
 *
 * `timelineEntry` answers *Anna touched this at 14:02*. A history strip has to
 * answer *Anna changed Status from Lead to Customer*, and the outbox already
 * holds the rest of that. Two of these fields have a nullable that is a fact
 * rather than a gap:
 *
 * - **`payload` is null after an erasure.** A shred nulls the payload and keeps
 *   the row (§5.3: "pseudonymous keys and transaction facts remain"), so a
 *   history correctly degrades to "someone changed this, then". A renderer must
 *   expect the null; it is a supported result, not an error.
 * - **`authorization` is null when UNRECORDED** — a row written before K-34
 *   added the column — which is a different fact from an empty list (checked
 *   nothing). Keeping them distinct is the whole reason the column is nullable
 *   in the DDL.
 *
 * Field-level "X → Y" is reconstructed by diffing consecutive payloads: nothing
 * stores a before-state. For the few fields a history strip actually shows
 * (status, owner, value), emitting the previous value explicitly in the fat
 * payload is more honest than making every reader diff — a per-vertical call.
 */
export const historyEntry = timelineEntry.extend({
  payload: z.unknown(),
  authorization: z.array(eventAuthorization).nullable(),
  /**
   * The staff actor behind this entry (K-42), or null — which here means
   * "nobody was impersonating", the ordinary case, rather than "unrecorded".
   * A history strip that cannot show this shows a customer's own name against a
   * change their support engineer made.
   */
  impersonation: impersonationStamp.nullable(),
  piiClass,
  subjectId: dataSubjectId.nullable(),
  /**
   * The operation this entry was emitted from (#1231), or null. This null
   * honestly carries BOTH meanings the two fields above keep distinct: a
   * consumer-emitted event ran on behalf of no operation (a fact, like
   * `impersonation`'s null), and a row written before the column is unrecorded
   * (like `authorization`'s null). The spine cannot tell them apart after the
   * fact, and a renderer should say "—" rather than guess which it was.
   */
  operation: z.string().nullable(),
  /**
   * The version-registry id the emitting code ran as (#1242), or null — an
   * undeployed host (dev/sqlite with no configured id), a script deployed before
   * the SUBSTRAT_VERSION_ID binding, or a pre-column row; all honestly "no
   * version identity was present". Surfaced from the COLUMN only: the envelope
   * deliberately never carries it (#1250 — script configuration, not event data),
   * so this read is the one sanctioned way to join an event to its push.
   */
  version: z.string().nullable(),
  /**
   * The event this one was emitted in REACTION to (#1237), or null.
   *
   * The spine records what authority an operation held (`authorization`) and what
   * invocation it ran under (`operation`). Neither is cause: a consumer emits with
   * no operation at all, so the step from "this invoice exists" back to "because
   * that timesheet closed" was simply not written down, and a backwards walk had
   * to stop at the first consumer hop. This is that step.
   *
   * Stamped by the host whenever an emit happens while a delivery is in flight —
   * a module consumer or a connector/platform executor handling an event — which
   * is the only time a cause exists to record. Null therefore carries three
   * meanings the reader must not collapse: nothing was being delivered (an
   * operation emitted this directly, the ordinary case), or the row predates the
   * column. Where `operation` is also null and this is set, the pair is decisive:
   * the event came from a consumer, which neither field could establish alone.
   */
  causedBy: eventId.nullable(),
});
export type HistoryEntry = z.infer<typeof historyEntry>;

/**
 * Why a causal walk stopped (#1237). The whole value of the view is in telling these
 * apart, so it is a named reason rather than the absence of a next step.
 */
export const causeTerminal = z.enum([
  /**
   * The chain is complete: an operation emitted the first event directly, and the
   * walk can name the invocation and the actor that began everything downstream.
   */
  'operation',
  /**
   * The trail runs out. The first event carries neither a cause nor an operation,
   * which means something emitted it — a consumer — before the cause was recorded
   * (pre-#1237). NOT the same as `operation`, and rendering it as one would present
   * a truncated chain as a whole story, which is the one thing this view must not do.
   */
  'unrecorded',
  /** The cap was reached. More chain exists above; ask for it with a higher limit. */
  'depth',
  /**
   * A cause named an event this scope's outbox does not hold. Should not happen —
   * the spine is append-only and never pruned — so it is reported rather than
   * smoothed over: silently stopping here would look exactly like a complete chain.
   */
  'missing',
  /**
   * The walk met an event it had already passed. Impossible on a sound spine — ids
   * are monotonic and a cause is always older — so this is an integrity failure,
   * not a long chain: reporting it as `depth` would invite the reader to "ask for
   * more", and there is no more to ask for.
   */
  'cycle',
]);
export type CauseTerminal = z.infer<typeof causeTerminal>;

/**
 * One event's causal chain, newest first (#1237) — the walk backwards this whole
 * feature exists for: "this invoice exists; what started that?"
 *
 * `chain[0]` is the event asked about and each entry caused the one before it, so the
 * last entry is as far back as the spine can say. `terminal` says WHY it is the last,
 * and a reader must not treat the five reasons alike.
 */
export const causeChain = z.object({
  chain: z.array(historyEntry),
  terminal: causeTerminal,
});
export type CauseChain = z.infer<typeof causeChain>;

/**
 * One event as it leaves the scope for Tier 2 (#1334) — the exact-history lake
 * the master plan commits to (§5.3: "domain events → Pipelines → Iceberg on R2").
 *
 * Everything the envelope holds, because the lake is where reporting,
 * reconciliation and audit are answered and a field dropped here cannot be
 * recovered later. In particular it carries:
 *
 * - **`subjectId`**, the pseudonymous erasure key. A shred erases Tier 1's
 *   payload; the lake copy has to be reachable too, and this is the column that
 *   makes "delete every row for this subject" expressible there. Shipping
 *   payloads without it would put personal data somewhere an erasure cannot
 *   follow — so the key travels with them, always.
 * - **`authorization`, `impersonation`, `operation`, `version`** — the K-34 chain,
 *   the K-42 stamp and the signals dimensions, whose nulls stay facts on the way
 *   out exactly as `historyEntry` documents them.
 */
// Built from the SHAPE, not from `domainEvent` — and deliberately not as an
// intersection of the two. `operation` is `.optional()` on the envelope and
// nullable here, and an intersection requires a value to satisfy BOTH sides: the
// one thing this schema exists to carry, a drained row whose `operation` is null,
// is exactly what such a schema would reject. Re-applying `piiInvariant` keeps the
// PII rule the envelope's own — a `direct` class must still name a subject.
export const drainedEvent = domainEventShape
  .extend({
    /**
     * The `invoke()` string this event was emitted from (#1231), or null — two
     * facts the spine cannot separate afterwards: a consumer emitted it (no
     * operation ran), or the row predates the column.
     *
     * `.min(1)` because the envelope's own `operation` carries it: the drain
     * WIDENS absent to null, and widening that far would also admit `''`, which
     * is neither a fact nor an operation — just a row nothing can be grouped by.
     */
    operation: z.string().min(1).nullable(),
    /**
     * The version the emitting code was deployed as (#1242), or null. Read from
     * the outbox COLUMN, never the envelope — #1250 kept it off `domainEvent` on
     * purpose (script configuration, not event data), so a drain is one of the
     * few sanctioned joins from an event to its push. `.min(1)` for the reason
     * `operation` carries it: "no version identity was present" is spelled null,
     * and an empty string is a third spelling of it that nothing should have to
     * handle.
     */
    version: z.string().min(1).nullable(),
  })
  .superRefine(piiInvariant);
export type DrainedEvent = z.infer<typeof drainedEvent>;
