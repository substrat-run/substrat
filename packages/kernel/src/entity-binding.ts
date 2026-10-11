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
  /**
   * Who holds this on a record may bind its person with a link, and unbind them — null once a
   * version dropped `bind` and kept the shape: nobody may, and an erasure still releases.
   */
  permission: PermissionKey | null;
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
  if (holder.length !== 1 || permission.length > 1) return null;
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
    permission: permission[0] === undefined ? null : permissionKey.parse(permission[0]),
    keys: keys(BIND_KEY_RELATION),
    every: keys(SHAPE_PROTECTED_KEY_RELATION),
  };
}

/**
 * The scope's recorded binding for `entityType` that still declares its bind key — what a mint, a
 * claim and an unbind need — or null when its reconciled registry binds nothing there.
 */
function entityBindingOf(sql: ScopedSql, entityType: string): (EntityBinding & { permission: PermissionKey }) | null {
  const binding = bindingFrom(
    entityType,
    sql.query<{ relation: string; object: string }>(
      `SELECT relation, object FROM _substrat_tuples WHERE subject = ? AND relation IN (?, ?, ?, ?)`,
      [`shape:${entityType}`, ...BINDING_RELATIONS],
    ),
  );
  return binding?.permission ? { ...binding, permission: binding.permission } : null;
}

/** Every binding the scope's reconciled registry records, bind key or not — what an erasure releases — in one read. */
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

/**
 * The record as the binding sees it: whether any row carries its id, and whom the first row that
 * names someone names. Every row is read: the id column should be unique, and when it is not, a
 * record any of whose rows names someone is bound — the claim then writes exactly one row or
 * none, never a second person beside the first.
 */
function boundRecord(sql: ScopedSql, b: EntityBinding, entityId: string): { exists: boolean; principal: string | null } {
  if (!tableExists(switchSqlOf(sql), b.table)) return { exists: false, principal: null };
  const rows = sql.query<{ principal: string | null }>(
    `SELECT "${b.principalColumn}" AS principal FROM "${b.table}" WHERE "${b.idColumn}" = ?`,
    [entityId],
  );
  return { exists: rows.length > 0, principal: rows.find((r) => r.principal !== null)?.principal ?? null };
}

/** Does anyone hold a live shape marker on `object`? */
const heldBySomeone = (sql: ScopedSql, object: string): boolean =>
  sql.query(
    `SELECT 1 FROM _substrat_tuples WHERE object = ? AND relation = '${ENTITY_SHAPE_MARKER_RELATION}' AND revoked_at IS NULL
        AND subject >= '${PRINCIPAL}' AND subject < 'principal;' LIMIT 1`,
    [object],
  ).length > 0;

/** The bind key's refusal, in the shape every bounded verb answers a missing key with. */
const lacking = (permission: PermissionKey): { ok: false; coverage: Extract<Coverage, { covered: false }> } => ({
  ok: false,
  coverage: { covered: false, missing: [permission] },
});

/**
 * May `entity` be bound by a link its minter vouches for, now? The scope's recorded binding for
 * the type, the record present, its column naming nobody, nobody holding its shape there on the
 * spine (`bind-record-held`: unbind them first), and the minter holding the binding's
 * permission on it (`allowed`, the checker's `check` for the minter). The same judgement at mint
 * and at the exchange, so a link whose minter has since lost the key, or left, is refused.
 */
export async function judgeBind(
  sql: ScopedSql,
  allowed: (permission: PermissionKey, entity: EntityRef) => Promise<boolean>,
  entity: EntityRef,
): Promise<
  | { ok: true; binding: EntityBinding }
  | { ok: false; refused: 'bind-not-declared' | 'bind-record-missing' | 'bind-record-bound' | 'bind-record-held' }
  | ReturnType<typeof lacking>
> {
  entityObjectRef(entity, 'bind');
  const binding = entityBindingOf(sql, entity.entityType);
  if (!binding) return { ok: false, refused: 'bind-not-declared' };
  const record = boundRecord(sql, binding, entity.entityId);
  if (!record.exists) return { ok: false, refused: 'bind-record-missing' };
  if (record.principal !== null) return { ok: false, refused: 'bind-record-bound' };
  // The spine as well as the column: someone already holding the record's shape there — given it
  // before the column was written, or left by a holder column a later version moved — is a holder
  // a new link would bind a second person beside. Unbind them first.
  if (heldBySomeone(sql, entityObjectRef(entity, 'bind'))) return { ok: false, refused: 'bind-record-held' };
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
  // Counted by RETURNING, never by `changes`: on a Durable Object that is `rowsWritten`, which
  // counts index entries too, so an index on the principal column reads one row as two. Exactly one
  // row: an id two rows carry is no one record, and the claim refuses it rather than bind both.
  const set = sql.query(
    `UPDATE "${binding.table}" SET "${binding.principalColumn}" = ? WHERE "${binding.idColumn}" = ? AND "${binding.principalColumn}" IS NULL RETURNING 1 AS one`,
    [principal, entity.entityId],
  );
  if (set.length !== 1) {
    throw substratError('internal', `capability ${link.capabilityId}: its bind on ${entity.entityType} was refused after it was judged`);
  }
  grantEntityShapeIn(switchSqlOf(sql), principal, entity, binding.keys);
  const payload: EntityHolderBoundPayload = { entity, principal, ...link, granted: binding.keys };
  emit({ type: ENTITY_HOLDER_BOUND, schemaVersion: 1, entity, piiClass: 'none', payload });
}

/**
 * Release the record's shape holders from the SPINE: every principal holding a live marker on
 * `object` (or only `only`), and with each marker everything that principal holds on the record —
 * every `granted:` tuple there, whatever the shape's keys are now. A binding shape's marker and keys
 * come only from its own grant (the keys are refused to every other grant), so the marker is the
 * person's holding of the record, and what they hold on it goes with it: a key the shape has since
 * dropped without retiring it included. Judged by the spine, never the column, so a column module
 * code rewrote cannot strand the person a link bound. One tombstone statement per holder (K-21).
 */
function releaseHolders(sql: ScopedSql, object: string, now: string, only?: string): { principal: PrincipalId; removed: PermissionKey[] }[] {
  const holders = sql.query<{ subject: string }>(
    `SELECT subject FROM _substrat_tuples
      WHERE object = ? AND relation = '${ENTITY_SHAPE_MARKER_RELATION}' AND revoked_at IS NULL
        AND subject >= '${PRINCIPAL}' AND subject < 'principal;'${only === undefined ? '' : ' AND subject = ?'}`,
    only === undefined ? [object] : [object, `${PRINCIPAL}${only}`],
  );
  return holders.map(({ subject }) => ({
    principal: subject.slice(PRINCIPAL.length) as PrincipalId,
    removed: sql
      .query<{ relation: string }>(
        `UPDATE _substrat_tuples SET revoked_at = ?
          WHERE subject = ? AND object = ? AND revoked_at IS NULL
            AND (relation = '${ENTITY_SHAPE_MARKER_RELATION}' OR (relation >= '${GRANTED}' AND relation < 'granted;'))
          RETURNING relation`,
        [now, subject, object],
      )
      .flatMap((r) => (r.relation === ENTITY_SHAPE_MARKER_RELATION ? [] : [permissionKey.parse(r.relation.slice(GRANTED.length))]))
      .sort(),
  }));
}

/** Clear the record's column — every row carrying its id, or only where it still names `principal`. */
function clearColumn(sql: ScopedSql, binding: EntityBinding, entityId: string, principal?: string): void {
  if (!tableExists(switchSqlOf(sql), binding.table)) return;
  sql.exec(
    `UPDATE "${binding.table}" SET "${binding.principalColumn}" = NULL WHERE "${binding.idColumn}" = ? AND ${
      principal === undefined ? `"${binding.principalColumn}" IS NOT NULL` : `"${binding.principalColumn}" = ?`
    }`,
    principal === undefined ? [entityId] : [entityId, principal],
  );
}

/** The pseudo-operation an unbind's spine event names, on `capabilities.mint-become`'s pattern. */
export const ENTITY_UNBIND_OPERATION = 'entities.unbind';

/**
 * A principal's unbind of `entity` (#1686) — the lever beside a binding invite, run by a host in one
 * scope task and transaction. Bounded here: the caller must hold the binding's key on the record
 * (`allowed`, the checker's `check` for the caller). Clears the record's column (every row with
 * its id) and releases every holder of the shape on it from the spine — whoever a link bound,
 * whatever the column says now, and a holder given the shape before the column was written —
 * with one `entity.holder-unbound` event each through `emit`, whose actor the host stamps as the
 * caller. `unbound` names everyone released; a refusal writes nothing.
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
  const object = entityObjectRef(entity, 'unbind');
  const binding = entityBindingOf(deps.sql, entity.entityType);
  if (!binding) return { ok: false, refused: 'bind-not-declared' };
  if (!(await deps.allowed(binding.permission, entity))) return lacking(binding.permission);
  clearColumn(deps.sql, binding, entity.entityId);
  const released = releaseHolders(deps.sql, object, deps.now);
  for (const { principal, removed } of released) {
    const payload: EntityHolderUnboundPayload = { entity, principal, removed };
    deps.emit({ type: ENTITY_HOLDER_UNBOUND, schemaVersion: 1, entity, piiClass: 'none', payload });
  }
  return { ok: true, unbound: released.map((r) => r.principal) };
}

/** What an erasure releases, read before any of it runs. */
export interface ErasureBindings {
  /** Shape holders to release: on a record that IS the subject (any holder), or the subject's own markers. */
  holders: { object: string; only?: string }[];
  /** Rows whose column names someone the erasure reaches, to clear where they survive. */
  columns: { binding: EntityBinding; entityId: string; principal: string }[];
}

/**
 * Every binding the erasure of `subjectId` reaches, by the spine and by the column: on each type the
 * scope binds, the record that IS the subject (every holder on it) and every record the subject
 * holds the shape on (their own marker), plus the rows whose column names the subject or that are
 * the subject. Read BEFORE any declared blank, delete or hook runs, so a row a module's erasure
 * deletes is still known. A scope that binds nothing pays the one read of its shape records.
 */
export function captureBoundOf(sql: ScopedSql, subjectId: string): ErasureBindings {
  const out: ErasureBindings = { holders: [], columns: [] };
  for (const binding of entityBindingsOf(sql)) {
    const prefix = `${binding.entityType}:`;
    out.holders.push({ object: `${prefix}${subjectId}` });
    for (const { object } of sql.query<{ object: string }>(
      `SELECT object FROM _substrat_tuples
        WHERE subject = ? AND relation = '${ENTITY_SHAPE_MARKER_RELATION}' AND revoked_at IS NULL AND object >= ? AND object < ?`,
      [`${PRINCIPAL}${subjectId}`, prefix, `${binding.entityType};`],
    )) {
      out.holders.push({ object, only: subjectId });
    }
    if (!tableExists(switchSqlOf(sql), binding.table)) continue;
    for (const r of sql.query<{ id: string; principal: string }>(
      `SELECT "${binding.idColumn}" AS id, "${binding.principalColumn}" AS principal FROM "${binding.table}"
        WHERE ("${binding.idColumn}" = ? OR "${binding.principalColumn}" = ?) AND "${binding.principalColumn}" IS NOT NULL`,
      [subjectId, subjectId],
    )) {
      out.columns.push({ binding, entityId: String(r.id), principal: r.principal });
    }
  }
  return out;
}

/**
 * The erasure's unbind, after the module hooks: each captured column cleared where the row survived
 * and still names that person, and each captured holder released from the spine whether or not
 * its row survived. No event: an event naming the erased subject would be a new copy of what is
 * being erased.
 */
export function releaseBound(sql: ScopedSql, captured: ErasureBindings, now: string): void {
  for (const { binding, entityId, principal } of captured.columns) clearColumn(sql, binding, entityId, principal);
  for (const { object, only } of captured.holders) releaseHolders(sql, object, now, only);
}
