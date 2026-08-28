import {
  DEFAULT_PLATFORM_REQUEST_HISTORY_LIMIT,
  platformRequestFilter,
  type PlatformRequestFilter,
} from '@substrat-run/contracts';

/**
 * The one SELECT behind every read of a scope's intent journal (#618).
 *
 * Three surfaces answer the same question from the same table — `ctx.platformRequests` inside an
 * operation, the host's `listPlatformRequestHistory` for the control plane, and the Durable
 * Object's RPC underneath it — and they must not drift on which columns come back or what
 * "newest" means. Ids are ULIDs, so `ORDER BY id DESC` IS newest-first without a second index.
 *
 * The filter is re-parsed here rather than trusted: this builds SQL, and `kind` arrives from an
 * HTTP query string on one of those paths. Values are bound, never interpolated.
 */

/** Every column of `_substrat_platform_requests`, in the order the row mappers expect. */
export const PLATFORM_REQUEST_COLUMNS =
  'id, kind, payload, requested_by, impersonation, status, attempts, last_error, last_failure, result, requested_at, settled_at';

export function platformRequestHistoryQuery(filter?: PlatformRequestFilter): {
  sql: string;
  params: (string | number)[];
} {
  const f = platformRequestFilter.parse(filter ?? {});
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (f.kind !== undefined) {
    where.push('kind = ?');
    params.push(f.kind);
  }
  if (f.status !== undefined) {
    where.push('status = ?');
    params.push(f.status);
  }
  params.push(f.limit ?? DEFAULT_PLATFORM_REQUEST_HISTORY_LIMIT);
  return {
    sql:
      `SELECT ${PLATFORM_REQUEST_COLUMNS} FROM _substrat_platform_requests` +
      (where.length ? ` WHERE ${where.join(' AND ')}` : '') +
      ' ORDER BY id DESC LIMIT ?',
    params,
  };
}
