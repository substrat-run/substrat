import {
  ENTITY_HOLDER_UNBOUND,
  ENTITY_SHAPE_MARKER_RELATION,
  entityObjectRef,
  permissionKey,
  type BoundedUnbind,
  type DomainEventInput,
  type EntityHolderUnboundPayload,
  type EntityRef,
  type PermissionKey,
  type PrincipalId,
} from '@substrat-run/contracts';
import { BIND_HOLDER_RELATION, BIND_KEY_RELATION, BIND_PERMISSION_RELATION, grantEntityShapeIn } from './entity-grant-shape.js';
import { GRANTEE_KEY_RELATION } from './entity-grant.js';
import type { ScopedSql } from './scope-host.js';
import { assertSqlIdentifier } from './sql-identifier.js';
import type { SwitchSql } from './system-switch.js';

/**
 * A BINDING shape (#1686): a record names its own person in a declared column, and the person
 * it names holds the record's declared shape there. What makes a customer invite a binding
 * rather than a delegation: the link names WHICH record, the reviewed registry says WHAT the
 * person bound to it holds, and the minter vouches for the record with an ordinary key.
 *
 * Three writes, each one statement set shared by both adapters:
 * - {@link bindAtExchange}: inside a `become` exchange's transaction, after its use is taken —
 *   the column set to the claimant, and the shape granted (marker and keys). A refusal throws
 *   nothing and writes nothing; the caller answers the one refusal and rolls back the use.
 * - {@link unbindEntityHolderIn}: the column cleared, and the marker and every key of the shape,
 *   current and retired, tombstoned for the person it named (K-21).
 * - {@link captureBoundOf} / {@link releaseBound}: the erasure's half — every record bound to the
 *   erased subject, or that IS the erased subject, captured before any module erasure runs, and
 *   released after the hooks whether or not the row survived them.
 *
 * Read from the scope's record of its reconciled registry (`shape-bind-*` tuples), never from the
 * vertical's code: a scope not yet reconciled with a binding declaration binds nothing.
 */
export interface EntityBinding {
  entityType: string;
  table: string;
  idColumn: string;
  principalColumn: string;
  /** Who holds this on a record may bind its person with a link, and unbind them. */
  permission: PermissionKey;
  /** The shape's current keys — what a claim gives. */
  keys: string[];
  /** Every key of the shape, current and retired — what an unbind takes back. */
  every: string[];
}

const PRINCIPAL = 'principal:';

/** The scope's recorded binding for `entityType`, or null when its reconciled registry declares none. */
export function entityBindingOf(sql: ScopedSql, entityType: string): EntityBinding | null {
  const rows = sql.query<{ relation: string; object: string }>(
    `SELECT relation, object FROM _substrat_tuples WHERE subject = ? AND relation IN (?, ?, ?, ?)`,
    [`shape:${entityType}`, BIND_HOLDER_RELATION, BIND_PERMISSION_RELATION, BIND_KEY_RELATION, GRANTEE_KEY_RELATION],
  );
  const of = (relation: string) => rows.filter((r) => r.relation === relation).map((r) => r.object);
  const holder = of(BIND_HOLDER_RELATION);
  const permission = of(BIND_PERMISSION_RELATION);
  if (holder.length !== 1 || permission.length !== 1) return null;
  const parts = holder[0]!.split('.');
  if (parts.length !== 3) return null;
  const [table, idColumn, principalColumn] = parts.map((n) =>
    assertSqlIdentifier('entityBinding', 'an identifier', n, `the recorded binding of '${entityType}'`),
  ) as [string, string, string];
  const key = (object: string) => object.slice('granted:'.length);
  return {
    entityType,
    table,
    idColumn,
    principalColumn,
    permission: permissionKey.parse(permission[0]),
    keys: of(BIND_KEY_RELATION).map(key).sort(),
    every: of(GRANTEE_KEY_RELATION).map(key).sort(),
  };
}

/** Every binding the scope's reconciled registry records. */
function entityBindingsOf(sql: ScopedSql): EntityBinding[] {
  return sql
    .query<{ subject: string }>(
      `SELECT subject FROM _substrat_tuples WHERE subject >= 'shape:' AND subject < 'shape;' AND relation = ?`,
      [BIND_HOLDER_RELATION],
    )
    .map((r) => entityBindingOf(sql, r.subject.slice('shape:'.length)))
    .filter((b): b is EntityBinding => b !== null);
}

const tableExists = (sql: ScopedSql, table: string): boolean =>
  sql.query(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`, [table]).length > 0;

/** The record as the binding sees it: whether it exists, and whom its column names. */
function boundRecord(sql: ScopedSql, b: EntityBinding, entityId: string): { exists: boolean; principal: string | null } {
  if (!tableExists(sql, b.table)) return { exists: false, principal: null };
  const row = sql.query<{ principal: string | null }>(
    `SELECT "${b.principalColumn}" AS principal FROM "${b.table}" WHERE "${b.idColumn}" = ?`,
    [entityId],
  )[0];
  return row ? { exists: true, principal: row.principal } : { exists: false, principal: null };
}

/** Why a bind on `entity` is refused, as a mint answers it — or the binding, when it may go ahead. */
export type BindJudgement =
  | { ok: true; binding: EntityBinding }
  | { ok: false; refused: 'bind-not-declared' | 'bind-record-missing' | 'bind-record-bound' }
  | { ok: false; missing: PermissionKey };

/**
 * May `entity` be bound by a link its minter vouches for, now? The scope's recorded binding for
 * the type, the record present, its column naming nobody, and the minter holding the binding's
 * permission on it (`allowed`, the checker's `check` for the minter). The same judgement at mint
 * and at the exchange, so a link whose minter has since lost the key, or left, is refused.
 */
export async function judgeBind(
  sql: ScopedSql,
  allowed: (permission: PermissionKey, entity: EntityRef) => Promise<boolean>,
  entity: EntityRef,
): Promise<BindJudgement> {
  entityObjectRef(entity, 'bind');
  const binding = entityBindingOf(sql, entity.entityType);
  if (!binding) return { ok: false, refused: 'bind-not-declared' };
  const record = boundRecord(sql, binding, entity.entityId);
  if (!record.exists) return { ok: false, refused: 'bind-record-missing' };
  if (record.principal !== null) return { ok: false, refused: 'bind-record-bound' };
  if (!(await allowed(binding.permission, entity))) return { ok: false, missing: binding.permission };
  return { ok: true, binding };
}

/** A `ScopedSql` as the shape grant's statement runner. */
const switchOf = (sql: ScopedSql): SwitchSql => ({
  all: (statement, ...params) => sql.query(statement, params),
  run: (statement, ...params) => {
    sql.exec(statement, params);
  },
});

/**
 * The claim's write, inside the exchange's transaction once its use is taken: the record's column
 * set to `principal` — only while it still names nobody — and the shape's current keys given with
 * its marker. The judgement is made again here, in the same transaction, so nothing moves between
 * it and the write. Null, having written nothing, when it refuses; the caller then throws away
 * the use with everything else.
 */
export async function bindAtExchange(
  sql: ScopedSql,
  allowed: (permission: PermissionKey, entity: EntityRef) => Promise<boolean>,
  entity: EntityRef,
  principal: PrincipalId,
): Promise<{ binding: EntityBinding } | null> {
  const judged = await judgeBind(sql, allowed, entity);
  if (!judged.ok) return null;
  const { binding } = judged;
  const set = sql.exec(
    `UPDATE "${binding.table}" SET "${binding.principalColumn}" = ? WHERE "${binding.idColumn}" = ? AND "${binding.principalColumn}" IS NULL`,
    [principal, entity.entityId],
  );
  if (set.changes !== 1) return null;
  grantEntityShapeIn(switchOf(sql), principal, entity, binding.keys);
  return { binding };
}

/**
 * Tombstone what `principal` holds on `entity` through the binding: the shape's marker and every
 * key of the shape, current and retired. The keys it took, sorted. One tuple is one authority: a
 * key of a binding shape is refused to every grant but the shape's, so whatever row holds it there
 * came from the shape.
 */
function retireBoundShape(sql: ScopedSql, binding: EntityBinding, principal: string, entity: EntityRef, now: string): string[] {
  const object = entityObjectRef(entity, 'unbind');
  const subject = `${PRINCIPAL}${principal}`;
  sql.exec(
    `UPDATE _substrat_tuples SET revoked_at = ? WHERE subject = ? AND object = ? AND relation = '${ENTITY_SHAPE_MARKER_RELATION}' AND revoked_at IS NULL`,
    [now, subject, object],
  );
  return sql
    .query<{ key: string }>(
      `UPDATE _substrat_tuples SET revoked_at = ?
        WHERE subject = ? AND object = ? AND revoked_at IS NULL
          AND relation IN (SELECT 'granted:' || value FROM json_each(?))
        RETURNING substr(relation, 9) AS key`,
      [now, subject, object, JSON.stringify(binding.every)],
    )
    .map((r) => r.key)
    .sort();
}

/**
 * Unbind `entity`'s person: its column cleared and the shape they held there through it taken
 * back. Null when the record does not exist or names nobody — nothing to do, nothing written.
 */
export function unbindEntityHolderIn(
  sql: ScopedSql,
  binding: EntityBinding,
  entity: EntityRef,
  now: string,
): { principal: PrincipalId; removed: string[] } | null {
  const record = boundRecord(sql, binding, entity.entityId);
  if (!record.exists || record.principal === null) return null;
  sql.exec(
    `UPDATE "${binding.table}" SET "${binding.principalColumn}" = NULL WHERE "${binding.idColumn}" = ? AND "${binding.principalColumn}" = ?`,
    [entity.entityId, record.principal],
  );
  return { principal: record.principal as PrincipalId, removed: retireBoundShape(sql, binding, record.principal, entity, now) };
}

/** The pseudo-operation an unbind's spine event names, on `capabilities.mint-become`'s pattern. */
export const ENTITY_UNBIND_OPERATION = 'entities.unbind';

/**
 * A principal's unbind of `entity` (#1686) — the lever beside a binding invite, run by a host in one
 * scope task and transaction. Bounded here: the caller must hold the binding's key on the record
 * (`allowed`, the checker's `check` for the caller). Writes the unbind and its
 * `entity.holder-unbound` event through `emit`, whose actor the host stamps as the caller; a
 * refusal, or a record naming nobody, writes nothing.
 */
export async function unbindEntityHolderBounded(
  deps: {
    sql: ScopedSql;
    now: string;
    allowed: (permission: PermissionKey, entity: EntityRef) => Promise<boolean>;
    emit: (event: DomainEventInput) => void;
  },
  entity: EntityRef,
): Promise<BoundedUnbind> {
  entityObjectRef(entity, 'unbind');
  const binding = entityBindingOf(deps.sql, entity.entityType);
  if (!binding) return { ok: false, refused: 'bind-not-declared' };
  if (!(await deps.allowed(binding.permission, entity))) {
    return { ok: false, coverage: { covered: false, missing: [binding.permission] } };
  }
  const unbound = unbindEntityHolderIn(deps.sql, binding, entity, deps.now);
  if (!unbound) return { ok: true, unbound: null };
  const payload: EntityHolderUnboundPayload = {
    entity,
    principal: unbound.principal,
    removed: unbound.removed.map((k) => permissionKey.parse(k)),
  };
  deps.emit({ type: ENTITY_HOLDER_UNBOUND, schemaVersion: 1, entity, piiClass: 'none', payload });
  return { ok: true, unbound: unbound.principal };
}

/** One record an erasure found bound — captured before anything is erased. */
export interface CapturedBinding {
  binding: EntityBinding;
  entityId: string;
  principal: string;
}

/**
 * Every bound record the erasure of `subjectId` reaches: those whose column names the subject
 * (the person erased) and the record that IS the subject (the record erased). Read BEFORE any
 * declared blank, delete or hook runs, so a record a module's erasure deletes is still released.
 */
export function captureBoundOf(sql: ScopedSql, subjectId: string): CapturedBinding[] {
  return entityBindingsOf(sql).flatMap((binding) =>
    tableExists(sql, binding.table)
      ? sql
          .query<{ id: string; principal: string }>(
            `SELECT "${binding.idColumn}" AS id, "${binding.principalColumn}" AS principal FROM "${binding.table}"
              WHERE ("${binding.idColumn}" = ? OR "${binding.principalColumn}" = ?) AND "${binding.principalColumn}" IS NOT NULL`,
            [subjectId, subjectId],
          )
          .map((r) => ({ binding, entityId: String(r.id), principal: r.principal }))
      : [],
  );
}

/**
 * The erasure's unbind, after the module hooks: each captured record's shape taken back from the
 * person it named, and its column cleared where the row survived and still names them. No event:
 * an event naming the erased subject would be a new copy of what is being erased.
 */
export function releaseBound(sql: ScopedSql, captured: readonly CapturedBinding[], now: string): void {
  for (const { binding, entityId, principal } of captured) {
    const entity = { entityType: binding.entityType, entityId };
    if (tableExists(sql, binding.table)) {
      sql.exec(
        `UPDATE "${binding.table}" SET "${binding.principalColumn}" = NULL WHERE "${binding.idColumn}" = ? AND "${binding.principalColumn}" = ?`,
        [entityId, principal],
      );
    }
    retireBoundShape(sql, binding, principal, entity, now);
  }
}
