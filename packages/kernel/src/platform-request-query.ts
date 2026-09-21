import {
  actor,
  DEFAULT_PLATFORM_REQUEST_HISTORY_LIMIT,
  platformRequest,
  platformRequestFilter,
  type Actor,
  type PlatformRequest,
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

/** A stored `_substrat_platform_requests` row — snake_case, the JSON columns still text. */
export interface PlatformRequestRawRow {
  id: string;
  kind: string;
  payload: string;
  requested_by: string;
  impersonation: string | null;
  status: string;
  attempts: number;
  last_error: string | null;
  last_failure: string | null;
  result: string | null;
  requested_at: string;
  settled_at: string | null;
}

/**
 * What `requestedBy` reads as when the stored actor did not decode. The field is required and
 * an actor has no empty value, so this is a marker that names itself rather than a plausible
 * requester: a guessed principal would be the one thing worse than admitting nobody can tell.
 */
export const UNDECODED_REQUESTER: Actor = actor.parse({ system: 'undecodable' });

type FieldParse<T> =
  | { success: true; data: T }
  | { success: false; error: { issues: ReadonlyArray<{ message: string; path: ReadonlyArray<PropertyKey> }> } };
interface Field<T> {
  safeParse(value: unknown): FieldParse<T>;
}

/**
 * A stored row → the `PlatformRequest` contract shape — TOLERANTLY, and saying so (#1588).
 *
 * Every read of the journal returns a LIST, and this decode used to be strict: one row whose
 * JSON would not parse threw out of the map and took every other intent on the scope with it.
 * That disabled the drain's own queue, and `listPlatformRequestHistory` too — the read that
 * exists so a settled intent's failure is legible afterwards (#618), switched off by the row
 * that failed. So no row throws here. Each field is decoded against its own contract field,
 * and whatever did not decode is named, by column, in `decodeError`:
 *
 * - a JSON column comes back EMPTY — `null`, or {@link UNDECODED_REQUESTER} for the one that
 *   cannot be null. Never the raw text: a raw `payload` would read as a string payload that
 *   was never sent, which is a guess dressed as a fact.
 * - a scalar column comes back AS STORED. It has no empty value that would not itself read
 *   as a fact (a null `settledAt` says "not settled"), and the id especially must survive,
 *   since it is the only handle anyone has on the row.
 *
 * A row the kernel wrote decodes whole and carries no `decodeError` at all, so a healthy list
 * is exactly what it was. This is the READ's half of #1587's rule — strict where work happens,
 * tolerant where evidence is read; the work half is the drain, which refuses any row carrying
 * `decodeError` rather than run a handler on it.
 *
 * Reachable without a forge: `importDump` replays a dump's rows verbatim, so a dump from
 * another world, or one edited by hand, is enough.
 */
export function platformRequestOf(row: PlatformRequestRawRow): PlatformRequest {
  const undecoded: string[] = [];
  const shape = platformRequest.shape;
  const refused = (column: string, error: Extract<FieldParse<unknown>, { success: false }>['error']) => {
    const issue = error.issues[0];
    const at = issue && issue.path.length ? `.${issue.path.map(String).join('.')}` : '';
    undecoded.push(`${column}${at}: ${issue?.message ?? 'does not match the contract'}`);
  };
  const scalar = <T>(column: string, field: Field<T>, stored: unknown): T => {
    const r = field.safeParse(stored);
    if (r.success) return r.data;
    refused(column, r.error);
    return stored as T;
  };
  const json = <T>(column: string, field: Field<T>, stored: string | null, empty: T): T => {
    let value: unknown = null;
    if (stored !== null) {
      try {
        value = JSON.parse(stored);
      } catch (err) {
        undecoded.push(`${column}: ${err instanceof Error ? err.message : String(err)}`);
        return empty;
      }
    }
    const r = field.safeParse(value);
    if (r.success) return r.data;
    refused(column, r.error);
    return empty;
  };
  // Every field is decoded before `undecoded` is read, so the error names every column that
  // failed, in column order — not whichever one happened to be reached first.
  const decoded: PlatformRequest = {
    id: scalar<PlatformRequest['id']>('id', shape.id, row.id),
    kind: scalar<string>('kind', shape.kind, row.kind),
    payload: json<unknown>('payload', shape.payload, row.payload, null),
    requestedBy: json<Actor>('requested_by', shape.requestedBy, row.requested_by, UNDECODED_REQUESTER),
    impersonation: json<PlatformRequest['impersonation']>('impersonation', shape.impersonation, row.impersonation, null),
    status: scalar<PlatformRequest['status']>('status', shape.status, row.status),
    attempts: scalar<number>('attempts', shape.attempts, row.attempts),
    lastError: scalar<string | null>('last_error', shape.lastError, row.last_error),
    failure: json<PlatformRequest['failure']>('last_failure', shape.failure, row.last_failure, null),
    result: json<unknown>('result', shape.result, row.result, null),
    requestedAt: scalar<PlatformRequest['requestedAt']>('requested_at', shape.requestedAt, row.requested_at),
    settledAt: scalar<PlatformRequest['settledAt']>('settled_at', shape.settledAt, row.settled_at),
  };
  return undecoded.length ? { ...decoded, decodeError: undecoded.join('; ') } : decoded;
}
