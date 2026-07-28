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
    payload: z.unknown(),
  })
  .superRefine(piiInvariant);
export type DomainEvent = z.infer<typeof domainEvent>;
