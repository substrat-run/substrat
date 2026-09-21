import {
  DEFAULT_DENIAL_LIMIT,
  denialBucket,
  denialFilter,
  permissionDenial,
  type DenialActorSummary,
  type DenialBucket,
  type DenialFilter,
  type DenialGroupBy,
  type DenialOperationBucket,
  type DenialOperationSummary,
  type PermissionDenial,
} from '@substrat-run/contracts';
import { rowDecoder, UNDECODED_ACTOR, UNDECODED_PERMISSION } from './row-decode.js';

/**
 * The SELECTs behind every read of a scope's denial log (#867, K-35's stated tail).
 *
 * Four surfaces answer questions from `_substrat_denials` — the pure adapter's
 * `HostAdmin`, the Durable Object's RPC, the vertical's `/internal/denials` seam and
 * the control-plane route above them — and they must not drift on what "newest"
 * means, what a bucket groups by, or which rows a window bound includes. Ids are
 * ULIDs, so `ORDER BY id DESC` IS newest-first with no second index.
 *
 * Filters are re-parsed here rather than trusted: this builds SQL and every field can
 * arrive from an HTTP query string. Values are bound, never interpolated.
 */

/** Every column of `_substrat_denials`, in the order `mapDenialRow` expects. */
export const DENIAL_COLUMNS =
  'id, actor, permission, tenant_id, scope_id, operation, impersonation, invocation_id, at, drained_at';

/** The raw row shape, as either adapter hands it back. */
export interface DenialRow {
  id: string;
  actor: string;
  permission: string;
  tenant_id: string;
  scope_id: string | null;
  operation: string | null;
  /** K-42: the staff actor + session, as JSON, when the refusal was under one. */
  impersonation: string | null;
  /** #1525: the invocation the refusal happened during. NULL = none was carried. */
  invocation_id: string | null;
  at: string;
  drained_at: string | null;
}

/**
 * The stored spelling of an actor. The writer persists `JSON.stringify(actor)`, so a
 * principal is stored WITH its quotes (`"01J…"`) while a system or connection actor is
 * stored as an object (`{"system":"invoicing"}`). A caller filtering by actor holds the
 * logical form, not that encoding, so normalize rather than making every call site know:
 * text that already parses as JSON is passed through, anything else is a bare id and is
 * stringified. Round-trips exactly what `recordDenial` wrote in both adapters.
 */
export function storedActor(input: string): string {
  try {
    JSON.parse(input);
    return input;
  } catch {
    return JSON.stringify(input);
  }
}

/**
 * Turn a stored row into the contract shape — TOLERANTLY, and saying so (#1636).
 *
 * Every read of this log is a LIST, and the decode used to `JSON.parse` while mapping: one
 * row whose `actor` or `impersonation` would not parse threw for the page, which for the
 * only witness to a refused check is the worst read to lose. Each field is now decoded
 * against its own contract field and whatever did not decode is named in `decodeError`,
 * on `rowDecoder`'s rules — an undecodable actor reads as {@link UNDECODED_ACTOR}, and a
 * row whose id, tenant or time does not decode still throws, naming them.
 *
 * `permission` is the exception to that last rule, deliberately. A malformed key is not
 * only a dump's doing: nothing validates a checked key at runtime, so a module that casts
 * one is refused and the refusal is recorded with it — and this log is where someone comes
 * to find out why. Throwing would hide the evidence along with the list. So it reads as
 * {@link UNDECODED_PERMISSION}, and `decodeError` quotes the stored key verbatim.
 */
export function mapDenialRow(row: DenialRow): PermissionDenial {
  const shape = permissionDenial.shape;
  const d = rowDecoder(`denial row ${JSON.stringify(row.id)}`, 'PermissionDenial');
  return d.finish<PermissionDenial>({
    id: d.required<string>('id', shape.id, row.id),
    actor: d.json('actor', shape.actor, row.actor, UNDECODED_ACTOR),
    permission: d.marked('permission', shape.permission, row.permission, UNDECODED_PERMISSION),
    tenantId: d.required('tenant_id', shape.tenantId, row.tenant_id),
    scopeId: d.nullable('scope_id', shape.scopeId, row.scope_id ?? null),
    operation: d.nullable('operation', shape.operation, row.operation ?? null),
    impersonation: d.json('impersonation', shape.impersonation, row.impersonation ?? null, null),
    // #1525: which CALL was refused, not merely which operation — the join that lets
    // "same call" reach a request's refusals. `?? null` rather than a bare read, for
    // the row a legacy store hands back with the column absent.
    invocationId: d.nullable('invocation_id', shape.invocationId, row.invocation_id ?? null),
    at: d.required<string>('at', shape.at, row.at),
    drainedAt: d.nullable('drained_at', shape.drainedAt, row.drained_at ?? null),
  });
}

/** The WHERE fragment shared by the row read and the summary. */
function where(f: DenialFilter): { clause: string; params: (string | number)[] } {
  const parts: string[] = [];
  const params: (string | number)[] = [];
  if (f.actor !== undefined) {
    parts.push('actor = ?');
    params.push(storedActor(f.actor));
  }
  if (f.permission !== undefined) {
    parts.push('permission = ?');
    params.push(f.permission);
  }
  if (f.operation !== undefined) {
    parts.push('operation = ?');
    params.push(f.operation);
  }
  // `at` is ISO 8601 text, which sorts lexicographically — the comparison is the
  // ordering, no date parsing on either adapter. Inclusive lower, exclusive upper, so
  // adjacent windows tile without double-counting a row on the boundary.
  if (f.since !== undefined) {
    parts.push('at >= ?');
    params.push(f.since);
  }
  if (f.until !== undefined) {
    parts.push('at < ?');
    params.push(f.until);
  }
  return { clause: parts.length ? ` WHERE ${parts.join(' AND ')}` : '', params };
}

/** A bounded page of raw denial rows, newest first. */
export function denialListQuery(filter?: DenialFilter): { sql: string; params: (string | number)[] } {
  const f = denialFilter.parse(filter ?? {});
  const w = where(f);
  return {
    sql: `SELECT ${DENIAL_COLUMNS} FROM _substrat_denials${w.clause} ORDER BY id DESC LIMIT ?`,
    params: [...w.params, f.limit ?? DEFAULT_DENIAL_LIMIT],
  };
}

/**
 * K-35's rate-buckets: one row per (actor, permission), busiest first — or, with
 * `groupBy: 'operation'` (#1456), one row per operation, ordered the same way.
 *
 * Busiest-first rather than newest-first on purpose — this view exists BECAUSE the
 * volume is attacker-influenceable, and ordering by recency would let whoever wrote
 * the last hundred rows push everyone else off the page, which is the exact failure
 * the bucketing is there to prevent. Ties break on `MAX(id)` so the order is total.
 *
 * The grouping is returned beside the SQL so the adapter maps the rows it gets back
 * with the matching mapper (`mapDenialSummaryBuckets`) rather than re-deriving which
 * query it ran from the filter.
 */
export function denialSummaryQuery(filter?: DenialFilter): {
  sql: string;
  params: (string | number)[];
  groupBy: DenialGroupBy;
} {
  const f = denialFilter.parse(filter ?? {});
  const w = where(f);
  const groupBy = f.groupBy ?? 'actor-permission';
  const select =
    groupBy === 'operation'
      ? // A NULL operation groups with the other NULLs in SQLite, so the refusals that
        // unwound no operation invocation come back as one null-keyed bucket — still
        // counted, still summing to `total`, rather than silently dropped.
        `SELECT operation, COUNT(*) AS count,` +
        ` MIN(at) AS first_at, MAX(at) AS last_at, MAX(id) AS last_id` +
        ` FROM _substrat_denials${w.clause}` +
        ` GROUP BY operation`
      : `SELECT actor, permission, COUNT(*) AS count,` +
        ` COUNT(DISTINCT operation) AS operations,` +
        ` MIN(at) AS first_at, MAX(at) AS last_at, MAX(id) AS last_id` +
        ` FROM _substrat_denials${w.clause}` +
        ` GROUP BY actor, permission`;
  return {
    sql: `${select} ORDER BY count DESC, last_id DESC LIMIT ?`,
    params: [...w.params, f.limit ?? DEFAULT_DENIAL_LIMIT],
    groupBy,
  };
}

export interface DenialBucketRow {
  actor: string;
  permission: string;
  count: number;
  operations: number;
  first_at: string;
  last_at: string;
}

/**
 * One (actor, permission) bucket, tolerantly (#1636). The buckets are `GROUP BY actor`, so a
 * stored actor that would not parse is its own bucket — and used to throw the whole summary,
 * the read a console opens first. It reads as {@link UNDECODED_ACTOR} now, still counted,
 * with `decodeError` saying why. A malformed permission key is its own bucket too, and reads
 * as {@link UNDECODED_PERMISSION} with the stored key quoted — `mapDenialRow` says why.
 */
export function mapDenialBucketRow(row: DenialBucketRow): DenialBucket {
  const shape = denialBucket.shape;
  const d = rowDecoder(`denial bucket for ${JSON.stringify(row.permission)}`, 'DenialBucket');
  return d.finish<DenialBucket>({
    actor: d.json('actor', shape.actor, row.actor, UNDECODED_ACTOR),
    permission: d.marked('permission', shape.permission, row.permission, UNDECODED_PERMISSION),
    count: d.required<number>('count', shape.count, Number(row.count)),
    operations: d.required<number>('operations', shape.operations, Number(row.operations)),
    firstAt: d.required<string>('first_at', shape.firstAt, row.first_at),
    lastAt: d.required<string>('last_at', shape.lastAt, row.last_at),
  });
}

export interface DenialOperationBucketRow {
  operation: string | null;
  count: number;
  first_at: string;
  last_at: string;
}

export function mapDenialOperationBucketRow(row: DenialOperationBucketRow): DenialOperationBucket {
  return {
    operation: row.operation ?? null,
    count: Number(row.count),
    firstAt: row.first_at,
    lastAt: row.last_at,
  };
}

/** The half of a `DenialSummary` the grouped query answers; the facts are the other half. */
export type DenialSummaryBuckets =
  | Pick<DenialActorSummary, 'groupBy' | 'buckets'>
  | Pick<DenialOperationSummary, 'groupBy' | 'buckets'>;

/**
 * Map the rows `denialSummaryQuery` came back with, under the grouping it reported —
 * and carry that grouping onto the answer, so a caller who asked one question can see
 * which one was answered. Both adapters spread this into the summary they return.
 */
export function mapDenialSummaryBuckets(groupBy: DenialGroupBy, rows: unknown[]): DenialSummaryBuckets {
  return groupBy === 'operation'
    ? { groupBy, buckets: (rows as DenialOperationBucketRow[]).map(mapDenialOperationBucketRow) }
    : { groupBy, buckets: (rows as DenialBucketRow[]).map(mapDenialBucketRow) };
}

/** Totals for the FILTERED set — what the capped bucket list is a page of. */
export function denialTotalsQuery(filter?: DenialFilter): {
  sql: string;
  params: (string | number)[];
} {
  const f = denialFilter.parse(filter ?? {});
  const w = where(f);
  return {
    sql: `SELECT COUNT(*) AS total, COUNT(DISTINCT actor) AS actors FROM _substrat_denials${w.clause}`,
    params: w.params,
  };
}

/**
 * Facts about the WINDOW, filter ignored — deliberately.
 *
 * These describe the log, not the query. A caller reading an empty filtered result
 * needs to know whether the log reaches back past the interval it asked about, because
 * rows here drain rather than expire (K-24's split) and until a Tier-2 sink exists the
 * window simply IS the retention. Reporting the floor is what stops absence being read
 * as "this never happened" — K-35 calls that a stated limitation, so the surface states it.
 */
export const DENIAL_WINDOW_QUERY =
  'SELECT MIN(at) AS oldest_at, MAX(at) AS newest_at,' +
  ' SUM(CASE WHEN drained_at IS NOT NULL THEN 1 ELSE 0 END) AS drained' +
  ' FROM _substrat_denials';

export interface DenialWindowRow {
  oldest_at: string | null;
  newest_at: string | null;
  drained: number | null;
}
