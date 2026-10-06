import {
  ENTITY_GRANTS_TOPPED_UP,
  ENTITY_SHAPE_MARKER_RELATION,
  domainEvent,
  entityGrantsToppedUpPayload,
  entityObjectRef,
  eventId,
  moduleId,
  type DomainEvent,
  type EntityGrantShape,
  type EntityRef,
  type PrincipalId,
} from '@substrat-run/contracts';
import { substratError } from '@substrat-run/contracts';
import { explicitTupleSql } from './entity-grant.js';
import { liveTupleSql } from './permission-eval.js';
import { assertSqlIdentifier } from './sql-identifier.js';
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
 * - {@link grantEntityShapeIn}: the grant. The shape's keys plus a MARKER tuple
 *   (`ENTITY_SHAPE_MARKER_RELATION`) on the same entity. The marker is what makes a person a
 *   holder of the shape, which no set of keys can: someone `ctx.grant`ed one of those keys
 *   holds part of the shape and must never be topped up to all of it.
 * - {@link topUpEntityGrantShapes}: one bounded pass of the reconcile, writing each top-up's
 *   `entity.grants-topped-up` event beside it. Each live marker whose
 *   entity lacks a key of the CURRENT shape gets that key. A key with any row at all is
 *   skipped, and that includes a tombstone (K-21): a key someone took back from that person
 *   stays taken back. Top-up only. A key dropped from the shape is left where it is, because
 *   silently revoking authority on a deploy is the riskier mistake.
 * - The backfill, inside the same budget, until it is done once per (scope, entity type): how
 *   people granted before markers existed become holders. It reads PROVENANCE, never key sets.
 *   The shape's declared `holder` says whose record each entity is (`'self'`: the entity id is
 *   the principal; a table column naming the principal), and a person is marked only on their
 *   own record, and only when they hold a row there (live or tombstoned) for some key of the
 *   shape — evidence they were given it. Someone `ctx.grant`ed even the whole shape on another
 *   person's record is never marked. A shape with no `holder` gets no backfill. Each batch marks
 *   at most what the pass's budget allows; the markers are the progress, since a marked pair is
 *   no longer a candidate, and a record tuple (`shape:<type>`, `shape-backfilled`, `scope:<id>`)
 *   ends it once a batch comes back short.
 *
 * Only a shape declared `bootstrap: true` is reconciled: one a person is GIVEN on their own
 * record. A sharing shape, which people reach through `ctx.grant` (todo's `list`), is skipped
 * whole, backfill included, so a vertical passes its whole `ENTITY_GRANTS` and a sharee is never
 * marked a holder.
 */

/** Holders topped up per pass — one transaction each, so a large scope never holds one long. */
export const SHAPE_TOP_UP_BATCH = 500;
/** The largest batch a caller may ask for: past this a pass is the long transaction it exists to avoid. */
export const SHAPE_TOP_UP_BATCH_MAX = 5000;

/** `batch`, or `validation_failed`: a pass size is a positive integer no larger than the max. */
export function shapeTopUpBatch(batch: number = SHAPE_TOP_UP_BATCH): number {
  if (!Number.isInteger(batch) || batch < 1 || batch > SHAPE_TOP_UP_BATCH_MAX) {
    throw substratError(
      'validation_failed',
      `reconcileEntityGrantShapes: batch must be an integer from 1 to ${SHAPE_TOP_UP_BATCH_MAX}, not ${batch}`,
      { errors: [{ path: 'batch', message: `an integer from 1 to ${SHAPE_TOP_UP_BATCH_MAX}` }] },
    );
  }
  return batch;
}

/** The backfill's run-once record: `(shape:<type>, backfilled, scope:<id>)`. */
const BACKFILLED_RELATION = 'shape-backfilled';

/** The writer of the top-up events: the kernel, as no module or person acted. */
const KERNEL_ACTOR = { system: moduleId.parse('@substrat-run/kernel') };

const PRINCIPAL = 'principal:';

/** One (person, entity) a pass topped up, and the keys it added. */
interface ShapeTopUp {
  principal: PrincipalId;
  entity: EntityRef;
  added: string[];
}

const keysOf = (permissions: readonly string[]): string[] => [...new Set(permissions)].sort();

/**
 * The shape's grant to one person on one entity: the marker and every key, each an explicit
 * write, so a re-grant brings back what a revoke tombstoned — as `ctx.grant` does.
 * `entityObjectRef` refuses a ref the walk could not read back (#1856). Run it in ONE
 * transaction, so the marker and its keys land together or not at all.
 */
export function grantEntityShapeIn(db: SwitchSql, principal: PrincipalId, entity: EntityRef, permissions: readonly string[]): void {
  const object = entityObjectRef(entity, 'grantEntityShape');
  const subject = `${PRINCIPAL}${principal}`;
  for (const st of [
    explicitTupleSql(subject, ENTITY_SHAPE_MARKER_RELATION, object),
    ...keysOf(permissions).map((p) => explicitTupleSql(subject, `granted:${p}`, object)),
  ]) {
    db.run(st.sql, ...st.params);
  }
}

/** Where a pass runs and how its events are stamped — the facts only the adapter holds. */
export interface ShapePass {
  tenantId: string;
  scopeId: string;
  shapes: readonly EntityGrantShape[];
  /** The pass's one instant: marker liveness and every event's `occurredAt`. */
  now: string;
  /** Rows of work at most: a backfill mark or a holder topped up each count one. */
  limit: number;
  /** The adapter's monotonic event-id mint, given the instant in ms. */
  mintEventId: (ms: number) => string;
  /** The deploy writing the events, for the outbox `version` column. */
  version: string | null;
}

/**
 * One pass of the reconcile over one scope, at most `limit` rows of work: backfill marks for any
 * shape whose backfill is not done here, then holders topped up, each with its
 * `entity.grants-topped-up` event. `done` is false when the budget ran out, and the caller runs
 * another pass. Run it inside ONE transaction, so the keys and their events commit together.
 * Re-running a finished scope writes nothing.
 */
export function topUpEntityGrantShapes(db: SwitchSql, pass: ShapePass): { toppedUp: number; done: boolean } {
  // Here as well as at each entry point: a pass with no budget never reports done, so a caller
  // looping until it does would never stop.
  let budget = shapeTopUpBatch(pass.limit);
  let toppedUp = 0;
  for (const shape of pass.shapes) {
    // A sharing shape is never reconciled — not topped up and not backfilled (see `bootstrap`).
    if (!shape.bootstrap) continue;
    const keys = keysOf(shape.permissions);
    if (keys.length === 0) continue;
    const prefix = `${shape.entityType}:`;
    const json = JSON.stringify(keys);
    budget -= backfill(db, pass.scopeId, shape, prefix, json, budget);
    if (budget === 0) return { toppedUp, done: false };
    const holders = db.all(
      `SELECT m.subject, m.object FROM _substrat_tuples m
        WHERE m.relation = ? AND ${liveTupleSql('m')}
          AND substr(m.subject, 1, ${PRINCIPAL.length}) = '${PRINCIPAL}'
          AND substr(m.object, 1, ?) = ?
          AND EXISTS (SELECT 1 FROM json_each(?) k
                       WHERE NOT EXISTS (SELECT 1 FROM _substrat_tuples t
                                          WHERE t.subject = m.subject AND t.object = m.object
                                            AND t.relation = 'granted:' || k.value))
        ORDER BY m.subject, m.object
        LIMIT ?`,
      ENTITY_SHAPE_MARKER_RELATION,
      pass.now,
      prefix.length,
      prefix,
      json,
      budget,
    ) as { subject: string; object: string }[];
    for (const h of holders) {
      const added = (
        db.all(
          `SELECT k.value AS key FROM json_each(?) k
            WHERE NOT EXISTS (SELECT 1 FROM _substrat_tuples t
                               WHERE t.subject = ? AND t.object = ? AND t.relation = 'granted:' || k.value)
            ORDER BY k.value`,
          json,
          h.subject,
          h.object,
        ) as { key: string }[]
      ).map((m) => m.key);
      for (const key of added) {
        db.run(
          `INSERT OR IGNORE INTO _substrat_tuples (subject, relation, object) VALUES (?, ?, ?)`,
          h.subject,
          `granted:${key}`,
          h.object,
        );
      }
      const st = outboxInsertSql(
        shapeTopUpEvent(pass, {
          principal: h.subject.slice(PRINCIPAL.length) as PrincipalId,
          entity: { entityType: shape.entityType, entityId: h.object.slice(prefix.length) },
          added,
        }),
        pass.version,
      );
      db.run(st.sql, ...st.params);
    }
    budget -= holders.length;
    toppedUp += holders.length;
    if (budget === 0) return { toppedUp, done: false };
  }
  return { toppedUp, done: true };
}

/**
 * One bounded batch of the backfill for one shape — at most `budget` marks — and the run-once
 * record when the batch comes back short. Returns how many it marked. See the module comment:
 * provenance only, from the shape's declared `holder`.
 */
function backfill(db: SwitchSql, scopeId: string, shape: EntityGrantShape, prefix: string, json: string, budget: number): number {
  if (!shape.holder || budget === 0) return 0;
  const record = [`shape:${shape.entityType}`, BACKFILLED_RELATION, `scope:${scopeId}`] as const;
  if (db.all('SELECT 1 FROM _substrat_tuples WHERE subject = ? AND relation = ? AND object = ?', ...record).length > 0) {
    return 0;
  }
  // Not yet a holder in any state: a tombstoned marker is a revoke of the holding, kept.
  const unmarked = (subject: string, object: string) =>
    `NOT EXISTS (SELECT 1 FROM _substrat_tuples m WHERE m.subject = ${subject} AND m.relation = '${ENTITY_SHAPE_MARKER_RELATION}' AND m.object = ${object})`;
  const heldThere = (subject: string, object: string) =>
    `EXISTS (SELECT 1 FROM _substrat_tuples g WHERE g.subject = ${subject} AND g.object = ${object}
               AND g.relation IN (SELECT 'granted:' || value FROM json_each(?)))`;
  let candidates: { subject: string; object: string }[];
  if (shape.holder === 'self') {
    // The entity id IS the principal: `owner:<p>` belongs to `principal:<p>` and nobody else.
    candidates = db.all(
      `SELECT DISTINCT t.subject, t.object FROM _substrat_tuples t
        WHERE substr(t.object, 1, ?) = ?
          AND t.subject = '${PRINCIPAL}' || substr(t.object, ?)
          AND t.relation IN (SELECT 'granted:' || value FROM json_each(?))
          AND ${unmarked('t.subject', 't.object')}
        ORDER BY t.subject, t.object
        LIMIT ?`,
      prefix.length,
      prefix,
      prefix.length + 1,
      json,
      budget,
    ) as { subject: string; object: string }[];
  } else {
    const { table, idColumn, principalColumn } = shape.holder;
    const where = `entityGrants holder of '${shape.entityType}'`;
    for (const [kind, name] of [['a table', table], ['a column', idColumn], ['a column', principalColumn]] as const) {
      assertSqlIdentifier('reconcileEntityGrantShapes', kind, name, where);
    }
    // The vertical's table may not exist yet on this scope (a module not migrated): nothing to
    // mark, and the backfill stays open for the next reconcile rather than being recorded done.
    if (db.all(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`, table).length === 0) return 0;
    const subject = `'${PRINCIPAL}' || e."${principalColumn}"`;
    const object = `? || e."${idColumn}"`;
    candidates = db.all(
      `SELECT ${subject} AS subject, ${object} AS object FROM "${table}" e
        WHERE e."${principalColumn}" IS NOT NULL
          AND ${heldThere(subject, object)}
          AND ${unmarked(subject, object)}
        ORDER BY 1, 2
        LIMIT ?`,
      prefix,
      prefix,
      json,
      prefix,
      budget,
    ) as { subject: string; object: string }[];
  }
  for (const c of candidates) {
    db.run('INSERT OR IGNORE INTO _substrat_tuples (subject, relation, object) VALUES (?, ?, ?)', c.subject, ENTITY_SHAPE_MARKER_RELATION, c.object);
  }
  if (candidates.length < budget) {
    db.run('INSERT OR IGNORE INTO _substrat_tuples (subject, relation, object) VALUES (?, ?, ?)', ...record);
  }
  return candidates.length;
}

/** The kernel's event for one top-up — the audit record, on the entity's own history. */
function shapeTopUpEvent(pass: ShapePass, topUp: ShapeTopUp): DomainEvent {
  return domainEvent.parse({
    id: eventId.parse(pass.mintEventId(Date.parse(pass.now))),
    type: ENTITY_GRANTS_TOPPED_UP,
    schemaVersion: 1,
    occurredAt: pass.now,
    tenantId: pass.tenantId,
    scopeId: pass.scopeId,
    actor: KERNEL_ACTOR,
    entity: topUp.entity,
    piiClass: 'none',
    payload: entityGrantsToppedUpPayload.parse(topUp),
  });
}

/**
 * The outbox write for an event the kernel records OUTSIDE an operation. A reconcile has no
 * operation, no caller and no delivery, so `operation`, `caused_by` and `invocation_id` are null,
 * which is what each says about such an event; the envelope's own fields are written as given.
 * `version` is the deploy that wrote it.
 */
function outboxInsertSql(e: DomainEvent, version: string | null): { sql: string; params: (string | number | null)[] } {
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
