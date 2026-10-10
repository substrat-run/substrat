import {
  ENTITY_HOLDER_BOUND,
  ENTITY_HOLDER_UNBOUND,
  ENTITY_SHAPE_MARKER_RELATION,
  entityObjectRef,
  permissionKey,
  substratError,
  type BoundedUnbind,
  type CapabilityId,
  type Coverage,
  type DomainEventInput,
  type EntityHolderBoundPayload,
  type EntityHolderUnboundPayload,
  type EntityRef,
  type PermissionKey,
  type PrincipalId,
} from '@substrat-run/contracts';
import { BIND_HOLDER_RELATION, BIND_KEY_RELATION, BIND_PERMISSION_RELATION, grantEntityShapeIn } from './entity-grant-shape.js';
import { SHAPE_PROTECTED_KEY_RELATION } from './entity-grant.js';
import type { ScopedSql } from './scope-host.js';
import { assertSqlIdentifier, tableExists } from './sql-identifier.js';
import { switchSqlOf } from './system-switch.js';

/**
 * A BINDING shape (#1686): a record names its own person in a declared column, and the person
 * it names holds the record's declared shape there. What makes a customer invite a binding
 * rather than a delegation: the link names WHICH record, the reviewed registry says WHAT the
 * person bound to it holds, and the minter vouches for the record with an ordinary key.
 *
 * Three writes, each one statement set shared by both adapters:
 * - {@link bindIn}: inside a `become` exchange's transaction, once {@link judgeBind} said yes and
 *   the use is taken — the column set to the claimant, the shape granted (marker and keys), and
 *   `entity.holder-bound` emitted.
 * - {@link unbindEntityHolderBounded}: the column cleared, and the marker and every key of the
 *   shape, current and retired, tombstoned for the person it named (K-21).
 * - {@link captureBoundOf} / {@link releaseBound}: the erasure's half — every record bound to the
 *   erased subject, or that IS the erased subject, captured before any module erasure runs, and
 *   released after the hooks whether or not the row survived them.
 *
 * Read from the scope's record of its reconciled registry (`shape-bind-*` tuples), never from the
 * vertical's code: a scope not yet reconciled with a binding declaration binds nothing.
 */
interface EntityBinding {
  entityType: string;
  table: string;
  idColumn: string;
  principalColumn: string;
  /** Who holds this on a record may bind its person with a link, and unbind them. */
  permission: PermissionKey;
  /** The shape's current keys — what a claim gives. */
  keys: PermissionKey[];
  /** Every key of the shape, current and retired — what an unbind takes back. */
  every: PermissionKey[];
}

const PRINCIPAL = 'principal:';
const GRANTED = 'granted:';
const BINDING_RELATIONS = [BIND_HOLDER_RELATION, BIND_PERMISSION_RELATION, BIND_KEY_RELATION, SHAPE_PROTECTED_KEY_RELATION] as const;

/** One shape's recorded facts as a binding, or null when they do not make one. */
function bindingFrom(entityType: string, rows: readonly { relation: string; object: string }[]): EntityBinding | null {
  const of = (relation: string) => rows.filter((r) => r.relation === relation).map((r) => r.object);
  const holder = of(BIND_HOLDER_RELATION);
  const permission = of(BIND_PERMISSION_RELATION);
  if (holder.length !== 1 || permission.length !== 1) return null;
  const parts = holder[0]!.split('.');
  if (parts.length !== 3) return null;
  const [table, idColumn, principalColumn] = parts.map((n) =>
    assertSqlIdentifier('entityBinding', 'an identifier', n, `the recorded binding of '${entityType}'`),
  ) as [string, string, string];
  const keys = (relation: string) => of(relation).map((o) => permissionKey.parse(o.slice(GRANTED.length))).sort();
  return {
    entityType,
    table,
    idColumn,
    principalColumn,
    permission: permissionKey.parse(permission[0]),
    keys: keys(BIND_KEY_RELATION),
    every: keys(SHAPE_PROTECTED_KEY_RELATION),
  };
}

/** The scope's recorded binding for `entityType`, or null when its reconciled registry declares none. */
function entityBindingOf(sql: ScopedSql, entityType: string): EntityBinding | null {
  return bindingFrom(
    entityType,
    sql.query<{ relation: string; object: string }>(
      `SELECT relation, object FROM _substrat_tuples WHERE subject = ? AND relation IN (?, ?, ?, ?)`,
      [`shape:${entityType}`, ...BINDING_RELATIONS],
    ),
  );
}

/** Every binding the scope's reconciled registry records, in one read. */
function entityBindingsOf(sql: ScopedSql): EntityBinding[] {
  const bySubject = new Map<string, { relation: string; object: string }[]>();
  for (const row of sql.query<{ subject: string; relation: string; object: string }>(
    `SELECT subject, relation, object FROM _substrat_tuples
      WHERE subject >= 'shape:' AND subject < 'shape;' AND relation IN (?, ?, ?, ?)`,
    [...BINDING_RELATIONS],
  )) {
    bySubject.set(row.subject, [...(bySubject.get(row.subject) ?? []), row]);
  }
  return [...bySubject].flatMap(([subject, rows]) => bindingFrom(subject.slice('shape:'.length), rows) ?? []);
}

/** The record as the binding sees it: whether it exists, and whom its column names. */
function boundRecord(sql: ScopedSql, b: EntityBinding, entityId: string): { exists: boolean; principal: string | null } {
  if (!tableExists(switchSqlOf(sql), b.table)) return { exists: false, principal: null };
  const row = sql.query<{ principal: string | null }>(
    `SELECT "${b.principalColumn}" AS principal FROM "${b.table}" WHERE "${b.idColumn}" = ?`,
    [entityId],
  )[0];
  return row ? { exists: true, principal: row.principal } : { exists: false, principal: null };
}

/** The bind key's refusal, in the shape every bounded verb answers a missing key with. */
const lacking = (permission: PermissionKey): { ok: false; coverage: Extract<Coverage, { covered: false }> } => ({
  ok: false,
  coverage: { covered: false, missing: [permission] },
});

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
): Promise<
  | { ok: true; binding: EntityBinding }
  | { ok: false; refused: 'bind-not-declared' | 'bind-record-missing' | 'bind-record-bound' }
  | ReturnType<typeof lacking>
> {
  entityObjectRef(entity, 'bind');
  const binding = entityBindingOf(sql, entity.entityType);
  if (!binding) return { ok: false, refused: 'bind-not-declared' };
  const record = boundRecord(sql, binding, entity.entityId);
  if (!record.exists) return { ok: false, refused: 'bind-record-missing' };
  if (record.principal !== null) return { ok: false, refused: 'bind-record-bound' };
  if (!(await allowed(binding.permission, entity))) return lacking(binding.permission);
  return { ok: true, binding };
}

/**
 * The claim's write, inside the exchange's transaction once {@link judgeBind} has said yes there
 * and the use is taken: the record's column set to `principal` — only while it still names nobody —
 * the shape's current keys given with its marker, and `entity.holder-bound` emitted with the
 * capability as actor. Nothing can have moved since the judgement inside one transaction, so a
 * column that no longer reads empty is a fault: thrown, so the use rolls back with it.
 */
export function bindIn(
  sql: ScopedSql,
  binding: EntityBinding,
  entity: EntityRef,
  principal: PrincipalId,
  link: { capabilityId: CapabilityId; mintedBy: PrincipalId },
  emit: (event: DomainEventInput) => void,
): void {
  const set = sql.exec(
    `UPDATE "${binding.table}" SET "${binding.principalColumn}" = ? WHERE "${binding.idColumn}" = ? AND "${binding.principalColumn}" IS NULL`,
    [principal, entity.entityId],
  );
  if (set.changes !== 1) {
    throw substratError('internal', `capability ${link.capabilityId}: its bind on ${entity.entityType} was refused after it was judged`);
  }
  grantEntityShapeIn(switchSqlOf(sql), principal, entity, binding.keys);
  const payload: EntityHolderBoundPayload = { entity, principal, ...link, granted: binding.keys };
  emit({ type: ENTITY_HOLDER_BOUND, schemaVersion: 1, entity, piiClass: 'none', payload });
}

/**
 * Release `principal` from `entity`: the column cleared where the row is there and still names
 * them, and the shape's marker and every key, current and retired, tombstoned — one statement, so
 * one tuple is one authority: a key of a binding shape is refused to every grant but the shape's,
 * so whatever row holds it there came from the shape. The keys it took, sorted.
 */
function release(sql: ScopedSql, binding: EntityBinding, entityId: string, principal: string, now: string): PermissionKey[] {
  if (tableExists(switchSqlOf(sql), binding.table)) {
    sql.exec(
      `UPDATE "${binding.table}" SET "${binding.principalColumn}" = NULL WHERE "${binding.idColumn}" = ? AND "${binding.principalColumn}" = ?`,
      [entityId, principal],
    );
  }
  return sql
    .query<{ relation: string }>(
      `UPDATE _substrat_tuples SET revoked_at = ?
        WHERE subject = ? AND object = ? AND revoked_at IS NULL AND relation IN (SELECT value FROM json_each(?))
        RETURNING relation`,
      [
        now,
        `${PRINCIPAL}${principal}`,
        entityObjectRef({ entityType: binding.entityType, entityId }, 'unbind'),
        JSON.stringify([ENTITY_SHAPE_MARKER_RELATION, ...binding.every.map((k) => `${GRANTED}${k}`)]),
      ],
    )
    .flatMap((r) => (r.relation === ENTITY_SHAPE_MARKER_RELATION ? [] : [permissionKey.parse(r.relation.slice(GRANTED.length))]))
    .sort();
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
  if (!(await deps.allowed(binding.permission, entity))) return lacking(binding.permission);
  const record = boundRecord(deps.sql, binding, entity.entityId);
  if (!record.exists || record.principal === null) return { ok: true, unbound: null };
  const principal = record.principal as PrincipalId;
  const payload: EntityHolderUnboundPayload = {
    entity,
    principal,
    removed: release(deps.sql, binding, entity.entityId, principal, deps.now),
  };
  deps.emit({ type: ENTITY_HOLDER_UNBOUND, schemaVersion: 1, entity, piiClass: 'none', payload });
  return { ok: true, unbound: principal };
}

/**
 * Every bound record the erasure of `subjectId` reaches: those whose column names the subject
 * (the person erased) and the record that IS the subject (the record erased). Read BEFORE any
 * declared blank, delete or hook runs, so a record a module's erasure deletes is still released.
 * A scope whose registry binds nothing pays the one read of its shape records.
 */
export function captureBoundOf(sql: ScopedSql, subjectId: string): { binding: EntityBinding; entityId: string; principal: string }[] {
  return entityBindingsOf(sql).flatMap((binding) =>
    tableExists(switchSqlOf(sql), binding.table)
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
export function releaseBound(sql: ScopedSql, captured: ReturnType<typeof captureBoundOf>, now: string): void {
  for (const { binding, entityId, principal } of captured) release(sql, binding, entityId, principal, now);
}
