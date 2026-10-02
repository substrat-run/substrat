import {
  DEFAULT_REFUSAL_LIMIT,
  INVALID_TRANSITION,
  refusalFilter,
  refusalRecord,
  type RefusalFilter,
  type RefusalRecord,
} from '@substrat-run/contracts';
import { storedActor } from './denial-query.js';
import { actorKindOf } from './lifecycle-flow.js';
import { rowDecoder, UNDECODED_ACTOR } from './row-decode.js';

/**
 * The SELECT behind every read of a scope's refusal log (#1745) — `denial-query.ts`'s
 * sibling, for the rows `refusalInsert` writes.
 *
 * Both adapters build their read from this one function so they cannot disagree on what
 * "newest" means or which rows a window bound includes. Ids are ULIDs, so `ORDER BY id
 * DESC` IS newest-first. The filter is re-parsed here rather than trusted, and every value
 * is bound, never interpolated.
 */

/** Every column of `_substrat_refusals`, in the order `mapRefusalRow` expects. */
export const REFUSAL_COLUMNS =
  'id, kind, tenant_id, scope_id, entity_type, entity_id, from_state, attempted_state, operation,' +
  ' invoked_operation, actor, impersonation, invocation_id, at, drained_at';

/** The raw row shape, as either adapter hands it back. */
export interface RefusalDbRow {
  id: string;
  kind: string;
  tenant_id: string;
  scope_id: string | null;
  entity_type: string | null;
  entity_id: string | null;
  from_state: string;
  attempted_state: string | null;
  operation: string;
  invoked_operation: string | null;
  actor: string;
  impersonation: string | null;
  invocation_id: string | null;
  at: string;
  drained_at: string | null;
}

/** The problem code each recorded kind was refused with — the 409's `reason`. */
const REASON_OF_KIND: Readonly<Record<string, string>> = { transition: INVALID_TRANSITION };

/**
 * Turn a stored row into the contract shape, tolerantly (#1636's rule for the denial log):
 * an actor or impersonation that will not parse reads as its empty value with
 * `decodeError` naming it, and only a row whose required scalars break throws.
 */
export function mapRefusalRow(row: RefusalDbRow): RefusalRecord {
  const shape = refusalRecord.shape;
  const d = rowDecoder(`refusal row ${JSON.stringify(row.id)}`, 'RefusalRecord');
  const kind = d.required<string>('kind', shape.kind, row.kind);
  return d.finish<RefusalRecord>({
    id: d.required<string>('id', shape.id, row.id),
    kind,
    reason: REASON_OF_KIND[kind] ?? null,
    actor: d.json('actor', shape.actor, row.actor, UNDECODED_ACTOR),
    actorKind: actorKindOf(row.actor),
    tenantId: d.required('tenant_id', shape.tenantId, row.tenant_id),
    scopeId: d.nullable('scope_id', shape.scopeId, row.scope_id ?? null),
    entityType: d.nullable('entity_type', shape.entityType, row.entity_type ?? null),
    entityId: d.nullable('entity_id', shape.entityId, row.entity_id ?? null),
    fromState: d.required<string>('from_state', shape.fromState, row.from_state),
    attemptedState: d.nullable('attempted_state', shape.attemptedState, row.attempted_state ?? null),
    operation: d.required<string>('operation', shape.operation, row.operation),
    invokedOperation: d.nullable('invoked_operation', shape.invokedOperation, row.invoked_operation ?? null),
    impersonation: d.json('impersonation', shape.impersonation, row.impersonation ?? null, null),
    invocationId: d.nullable('invocation_id', shape.invocationId, row.invocation_id ?? null),
    at: d.required<string>('at', shape.at, row.at),
    drainedAt: d.nullable('drained_at', shape.drainedAt, row.drained_at ?? null),
  });
}

/** A bounded page of raw refusal rows, newest first. */
export function refusalListQuery(filter?: RefusalFilter): { sql: string; params: (string | number)[] } {
  const f = refusalFilter.parse(filter ?? {});
  const parts: string[] = [];
  const params: (string | number)[] = [];
  const eq = (column: string, value: string | undefined): void => {
    if (value === undefined) return;
    parts.push(`${column} = ?`);
    params.push(value);
  };
  eq('entity_type', f.entityType);
  eq('entity_id', f.entityId);
  eq('actor', f.actor === undefined ? undefined : storedActor(f.actor));
  eq('operation', f.operation);
  eq('invocation_id', f.invocationId);
  // ISO 8601 text sorts lexicographically; inclusive lower, exclusive upper, as denials.
  if (f.since !== undefined) {
    parts.push('at >= ?');
    params.push(f.since);
  }
  if (f.until !== undefined) {
    parts.push('at < ?');
    params.push(f.until);
  }
  const clause = parts.length ? ` WHERE ${parts.join(' AND ')}` : '';
  return {
    sql: `SELECT ${REFUSAL_COLUMNS} FROM _substrat_refusals${clause} ORDER BY id DESC LIMIT ?`,
    params: [...params, f.limit ?? DEFAULT_REFUSAL_LIMIT],
  };
}
