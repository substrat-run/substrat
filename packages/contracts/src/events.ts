import { z } from 'zod';
import {
  dataSubjectId,
  eventId,
  instant,
  moduleId,
  permissionKey,
  platformActorId,
  principalId,
  scopeId,
  tenantId,
} from './ids.js';

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

/**
 * WHO is really acting, when a session acts as somebody else (K-42, #868).
 *
 * A support engineer looking at what a named user sees, or a tenant admin
 * reproducing a member's screen. Deliberately NOT a synthetic principal and not a
 * fourth `actor` member, for the reason `connectorActor` is its own member: the
 * record has to be able to say *both* — Nadia, acting as Anna — and an actor
 * union can only ever say one. So the `actor` stays the impersonated principal,
 * which is whose authority the operation ran under, and this names the person
 * behind it.
 *
 * A platform staff actor is the object form (`{ staff: '01J…' }`) and a principal
 * is the bare id, the same encoding `systemActor` uses and for the same reason:
 * `PlatformActorId` is branded distinctly from `PrincipalId` (K-20) because a
 * staff member is not a person in any tenant, and a JSON column that collapsed
 * the two would lose exactly the distinction the audit needs.
 */
export const impersonator = z.union([z.object({ staff: platformActorId }), principalId]);
export type Impersonator = z.infer<typeof impersonator>;

/** How long a bound session may last, and the ceiling on one a caller asks for. */
export const IMPERSONATION_MAX_MINUTES = 60;
/** Bounded so the spine cannot be used as free-text storage. */
export const IMPERSONATION_REASON_MAX = 200;

/**
 * An impersonated session, as every record it produces carries it.
 *
 * `reason` is REQUIRED and not a comment, the same discipline as the conformance
 * kit's `alsoGrant.because`: an impersonation with no stated reason is the one
 * nobody can review afterwards, and "there was a ticket" is not recoverable from
 * a row that does not hold it.
 *
 * `expiresAt` is stamped by the host at mint rather than taken on trust
 * (`impersonationRequest` is the input form), so a session is a session and not a
 * standing key. K-33's rewind is time-boxed and audited; the precedent decided
 * this one.
 */
export const impersonation = z.object({
  by: impersonator,
  reason: z.string().min(1).max(IMPERSONATION_REASON_MAX),
  /** ISO 8601. The host refuses an invoke at or after it. */
  expiresAt: instant,
});
export type Impersonation = z.infer<typeof impersonation>;

/**
 * What a caller asks for. `expiresAt` is optional — omitted, the host stamps
 * `now + IMPERSONATION_MAX_MINUTES`; supplied, it is still capped by it, because
 * a bound a caller chooses for itself is not a bound.
 */
export const impersonationRequest = impersonation.extend({ expiresAt: instant.optional() });
export type ImpersonationRequest = z.infer<typeof impersonationRequest>;

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

// The full envelope as it enters the spine.
export const domainEvent = z
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
    // K-42: WHO was really acting, when this ran under an impersonated session.
    // Stamped kernel-side like `actor`; absent means nobody was acting as anybody,
    // which is the overwhelmingly common case and not an unrecorded one.
    impersonation: impersonation.optional(),
    payload: z.unknown(),
  })
  .superRefine(piiInvariant);
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
  /**
   * Present when `actor` is somebody being ACTED AS (K-42). A strip that renders
   * the actor alone would say *Anna changed this* about a change support made on
   * Anna's behalf — true about the authority and false about the person, which is
   * exactly the laundering the actor union refuses for connectors.
   */
  impersonation: impersonation.optional(),
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
  piiClass,
  subjectId: dataSubjectId.nullable(),
});
export type HistoryEntry = z.infer<typeof historyEntry>;
