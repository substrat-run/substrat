import { assertKernelAuthoredType, moduleId, type Actor, type DomainEvent } from '@substrat-run/contracts';

/** The actor on every event the kernel writes itself, outside any caller's operation. */
export const KERNEL_ACTOR: Actor = { system: moduleId.parse('@substrat-run/kernel') };

/**
 * The outbox write for an event the kernel records OUTSIDE an operation. A reconcile has no
 * operation, no caller and no delivery, so `operation`, `caused_by` and `invocation_id` are null,
 * which is what each says about such an event; the envelope's own fields are written as given.
 * `version` is the deploy that wrote it.
 */
export function kernelOutboxInsertSql(e: DomainEvent, version: string | null): { sql: string; params: (string | number | null)[] } {
  assertKernelAuthoredType(e.type);
  return {
    sql: `INSERT INTO _substrat_outbox
            (id, type, schema_version, occurred_at, tenant_id, scope_id, actor,
             entity_type, entity_id, pii_class, subject_id, authorization,
             impersonation, operation, version, caused_by, invocation_id, payload)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL, NULL, ?)`,
    params: [
      e.id,
      e.type,
      e.schemaVersion,
      e.occurredAt,
      e.tenantId,
      e.scopeId,
      JSON.stringify(e.actor),
      e.entity.entityType,
      e.entity.entityId,
      e.piiClass,
      e.subjectId ?? null,
      e.authorization ? JSON.stringify(e.authorization) : null,
      e.impersonation ? JSON.stringify(e.impersonation) : null,
      version,
      JSON.stringify(e.payload),
    ],
  };
}
