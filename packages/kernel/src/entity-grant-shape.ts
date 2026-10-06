import {
  ENTITY_GRANTS_TOPPED_UP,
  ENTITY_SHAPE_MARKER_RELATION,
  domainEvent,
  entityGrantsToppedUpPayload,
  entityObjectRef,
  eventId,
  moduleId,
  type DomainEvent,
  type EntityRef,
  type PrincipalId,
} from '@substrat-run/contracts';
import { explicitTupleSql } from './entity-grant.js';
import type { SwitchSql } from './system-switch.js';

/**
 * A declared entity-grant SHAPE, reconciled (#2071).
 *
 * A vertical declares the keys a person is given on their own record (`ENTITY_GRANTS`:
 * meridian's `EMPLOYEE_SELF` on `employee`, todo's owner grant on `owner`). They used to be
 * minted key by key, once, when the person arrived, so a key added to the shape by a later
 * release reached only the people who arrived after it, while `PERMISSIONS.md` said everyone
 * held it.
 *
 * Three pieces, each one statement shared by both adapters:
 *
 * - {@link shapeGrantSql}: the grant. The shape's keys plus a MARKER tuple
 *   (`ENTITY_SHAPE_MARKER_RELATION`) on the same entity. The marker is what makes a person a
 *   holder of the shape, which no set of keys can: someone `ctx.grant`ed one of those keys
 *   holds part of the shape and must never be topped up to all of it.
 * - {@link topUpEntityGrantShapes}: one bounded pass of the reconcile. Each live marker whose
 *   entity lacks a key of the CURRENT shape gets that key. A key with any row at all is
 *   skipped, and that includes a tombstone (K-21): a key someone took back from that person
 *   stays taken back. Top-up only. A key dropped from the shape is left where it is, because
 *   silently revoking authority on a deploy is the riskier mistake.
 * - The backfill, inside the same pass, once per (scope, entity type): a person holding a row
 *   for EVERY key of the current shape on an entity of its type is given the marker. That is
 *   how people granted before markers existed become holders. It asks for the full shape, so
 *   the release that adopts markers must not also grow the shape, or nobody qualifies. A
 *   record tuple (`shape:<type>`, `shape-backfilled`, `scope:<id>`) makes it run once, so a
 *   person later `ctx.grant`ed the whole shape by hand is not made a holder by it.
 *
 * Only a shape a person is GIVEN on their own record is reconciled. A sharing shape, which
 * people reach through `ctx.grant` (todo's `list`), must never be passed: its backfill would
 * mark every full sharee as a holder.
 */

/** Holders topped up per pass — one transaction each, so a large scope never holds one long. */
export const SHAPE_TOP_UP_BATCH = 500;

/** The backfill's run-once record: `(shape:<type>, backfilled, scope:<id>)`. */
const BACKFILLED_RELATION = 'shape-backfilled';

/** The writer of the top-up events: the kernel, as no module or person acted. */
const KERNEL_ACTOR = { system: moduleId.parse('@substrat-run/kernel') };

const PRINCIPAL = 'principal:';

/** One declared shape: the keys a holder is given on an entity of `entityType`. */
export interface EntityGrantShapeInput {
  entityType: string;
  permissions: readonly string[];
}

/** One (person, entity) a pass topped up, and the keys it added. */
export interface ShapeTopUp {
  principal: PrincipalId;
  entity: EntityRef;
  added: string[];
}

type Stmt = { sql: string; params: (string | number | null)[] };

const keysOf = (permissions: readonly string[]): string[] => [...new Set(permissions)].sort();

/**
 * The shape's grant to one person on one entity: the marker and every key, each an explicit
 * write, so a re-grant brings back what a revoke tombstoned — as `ctx.grant` and
 * `HostAdmin.grant` do. `entityObjectRef` refuses a ref the walk could not read back (#1856).
 */
export function shapeGrantSql(principal: PrincipalId, entity: EntityRef, permissions: readonly string[]): Stmt[] {
  const object = entityObjectRef(entity, 'grantEntityShape');
  const subject = `${PRINCIPAL}${principal}`;
  return [
    explicitTupleSql(subject, ENTITY_SHAPE_MARKER_RELATION, object),
    ...keysOf(permissions).map((p) => explicitTupleSql(subject, `granted:${p}`, object)),
  ];
}

/**
 * One pass of the reconcile over one scope: the backfill for any shape not yet backfilled
 * here, then at most `limit` holders topped up across all `shapes`. Returns what it added;
 * fewer than `limit` means the scope is done. Run it inside ONE transaction, and emit
 * {@link shapeTopUpEvent} for each result in the same one. Re-running a finished scope
 * writes nothing.
 */
export function topUpEntityGrantShapes(
  db: SwitchSql,
  input: { scopeId: string; shapes: readonly EntityGrantShapeInput[]; now: string; limit?: number },
): ShapeTopUp[] {
  let budget = input.limit ?? SHAPE_TOP_UP_BATCH;
  const out: ShapeTopUp[] = [];
  for (const shape of input.shapes) {
    const keys = keysOf(shape.permissions);
    if (keys.length === 0) continue;
    const prefix = `${shape.entityType}:`;
    const json = JSON.stringify(keys);
    backfillOnce(db, input.scopeId, shape.entityType, prefix, json, keys.length);
    if (budget === 0) break;
    const holders = db.all(
      `SELECT m.subject, m.object FROM _substrat_tuples m
        WHERE m.relation = ? AND m.revoked_at IS NULL AND (m.expires_at IS NULL OR m.expires_at > ?)
          AND substr(m.subject, 1, ${PRINCIPAL.length}) = '${PRINCIPAL}'
          AND substr(m.object, 1, ?) = ?
          AND EXISTS (SELECT 1 FROM json_each(?) k
                       WHERE NOT EXISTS (SELECT 1 FROM _substrat_tuples t
                                          WHERE t.subject = m.subject AND t.object = m.object
                                            AND t.relation = 'granted:' || k.value))
        ORDER BY m.subject, m.object
        LIMIT ?`,
      ENTITY_SHAPE_MARKER_RELATION,
      input.now,
      prefix.length,
      prefix,
      json,
      budget,
    ) as { subject: string; object: string }[];
    for (const h of holders) {
      const missing = db.all(
        `SELECT k.value AS key FROM json_each(?) k
          WHERE NOT EXISTS (SELECT 1 FROM _substrat_tuples t
                             WHERE t.subject = ? AND t.object = ? AND t.relation = 'granted:' || k.value)
          ORDER BY k.value`,
        json,
        h.subject,
        h.object,
      ) as { key: string }[];
      for (const { key } of missing) {
        db.run(
          `INSERT OR IGNORE INTO _substrat_tuples (subject, relation, object) VALUES (?, ?, ?)`,
          h.subject,
          `granted:${key}`,
          h.object,
        );
      }
      out.push({
        principal: h.subject.slice(PRINCIPAL.length) as PrincipalId,
        entity: { entityType: shape.entityType, entityId: h.object.slice(prefix.length) },
        added: missing.map((m) => m.key),
      });
    }
    budget -= holders.length;
  }
  return out;
}

/** The backfill, recorded so it runs once per (scope, entity type) — see the module comment. */
function backfillOnce(db: SwitchSql, scopeId: string, entityType: string, prefix: string, json: string, size: number): void {
  const record = [`shape:${entityType}`, BACKFILLED_RELATION, `scope:${scopeId}`] as const;
  const done = db.all(
    'SELECT 1 FROM _substrat_tuples WHERE subject = ? AND relation = ? AND object = ?',
    ...record,
  );
  if (done.length > 0) return;
  // Every row counts, a tombstone included: a person whose one key was revoked was still
  // given the shape, and the revoke stays a revoke because the top-up skips its row.
  db.run(
    `INSERT OR IGNORE INTO _substrat_tuples (subject, relation, object)
     SELECT subject, ?, object FROM _substrat_tuples
      WHERE substr(subject, 1, ${PRINCIPAL.length}) = '${PRINCIPAL}'
        AND substr(object, 1, ?) = ?
        AND relation IN (SELECT 'granted:' || value FROM json_each(?))
      GROUP BY subject, object
     HAVING count(*) = ?`,
    ENTITY_SHAPE_MARKER_RELATION,
    prefix.length,
    prefix,
    json,
    size,
  );
  db.run('INSERT OR IGNORE INTO _substrat_tuples (subject, relation, object) VALUES (?, ?, ?)', ...record);
}

/** The kernel's event for one top-up — the audit record, on the entity's own history. */
export function shapeTopUpEvent(
  at: { tenantId: string; scopeId: string; occurredAt: string; id: string },
  topUp: ShapeTopUp,
): DomainEvent {
  return domainEvent.parse({
    id: eventId.parse(at.id),
    type: ENTITY_GRANTS_TOPPED_UP,
    schemaVersion: 1,
    occurredAt: at.occurredAt,
    tenantId: at.tenantId,
    scopeId: at.scopeId,
    actor: KERNEL_ACTOR,
    entity: topUp.entity,
    piiClass: 'none',
    payload: entityGrantsToppedUpPayload.parse(topUp),
  });
}

/**
 * The outbox write for an event the kernel records OUTSIDE an operation — a reconcile has no
 * operation, no caller and no checks passed, so `authorization`, `impersonation`, `operation`
 * and `caused_by` are null, which is what each of them says about such an event. `version`
 * is the deploy that wrote it.
 */
export function kernelOutboxInsertSql(e: DomainEvent, version: string | null): Stmt {
  return {
    sql: `INSERT INTO _substrat_outbox
            (id, type, schema_version, occurred_at, tenant_id, scope_id, actor,
             entity_type, entity_id, pii_class, subject_id, authorization,
             impersonation, operation, version, caused_by, invocation_id, payload)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, NULL, NULL, ?)`,
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
      version,
      JSON.stringify(e.payload),
    ],
  };
}
