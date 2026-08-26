import {
  DEFAULT_DENIAL_LIMIT,
  denialFilter,
  type Actor,
  type DenialBucket,
  type DenialFilter,
  type ImpersonationStamp,
  type PermissionDenial,
  type PermissionKey,
  type ScopeId,
  type TenantId,
} from '@substrat-run/contracts';

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
  'id, actor, permission, tenant_id, scope_id, operation, impersonation, at, drained_at';

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

/** Turn a stored row into the contract shape. */
export function mapDenialRow(row: DenialRow): PermissionDenial {
  return {
    id: row.id,
    actor: JSON.parse(row.actor) as Actor,
    permission: row.permission as PermissionKey,
    tenantId: row.tenant_id as TenantId,
    scopeId: (row.scope_id ?? null) as ScopeId | null,
    operation: row.operation ?? null,
    impersonation:
      row.impersonation == null ? null : (JSON.parse(row.impersonation) as ImpersonationStamp),
    at: row.at,
    drainedAt: row.drained_at ?? null,
  };
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
 * K-35's rate-buckets: one row per (actor, permission), busiest first.
 *
 * Busiest-first rather than newest-first on purpose — this view exists BECAUSE the
 * volume is attacker-influenceable, and ordering by recency would let whoever wrote
 * the last hundred rows push everyone else off the page, which is the exact failure
 * the bucketing is there to prevent. Ties break on `MAX(id)` so the order is total.
 */
export function denialSummaryQuery(filter?: DenialFilter): {
  sql: string;
  params: (string | number)[];
} {
  const f = denialFilter.parse(filter ?? {});
  const w = where(f);
  return {
    sql:
      `SELECT actor, permission, COUNT(*) AS count,` +
      ` COUNT(DISTINCT operation) AS operations,` +
      ` MIN(at) AS first_at, MAX(at) AS last_at, MAX(id) AS last_id` +
      ` FROM _substrat_denials${w.clause}` +
      ` GROUP BY actor, permission ORDER BY count DESC, last_id DESC LIMIT ?`,
    params: [...w.params, f.limit ?? DEFAULT_DENIAL_LIMIT],
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

export function mapDenialBucketRow(row: DenialBucketRow): DenialBucket {
  return {
    actor: JSON.parse(row.actor) as Actor,
    permission: row.permission as PermissionKey,
    count: Number(row.count),
    operations: Number(row.operations),
    firstAt: row.first_at,
    lastAt: row.last_at,
  };
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
