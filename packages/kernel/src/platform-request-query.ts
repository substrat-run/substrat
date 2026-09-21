import {
  DEFAULT_PLATFORM_REQUEST_HISTORY_LIMIT,
  platformRequest,
  platformRequestFilter,
  type Actor,
  type PlatformRequest,
  type PlatformRequestFilter,
} from '@substrat-run/contracts';
import { rowDecoder, UNDECODED_ACTOR } from './row-decode.js';

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
 * The same marker every tolerant spine read uses (#1636), so it is one value, not four.
 */
export const UNDECODED_REQUESTER: Actor = UNDECODED_ACTOR;

/**
 * A stored row → the `PlatformRequest` contract shape — TOLERANTLY, and saying so (#1588).
 *
 * Every read of the journal returns a LIST, and this decode used to be strict: one row whose
 * JSON would not parse threw out of the map and took every other intent on the scope with it.
 * That disabled the drain's own queue, and `listPlatformRequestHistory` too — the read that
 * exists so a settled intent's failure is legible afterwards (#618), switched off by the row
 * that failed. Each field is now decoded against its own contract field, and whatever did not
 * decode is named, by column, in `decodeError`, with the field EMPTY in its place:
 *
 * - a JSON column comes back `null`, or {@link UNDECODED_REQUESTER} for the one that cannot be
 *   null. Never the raw text: a raw `payload` would read as a string payload that was never
 *   sent, which is a guess dressed as a fact.
 * - a nullable scalar (`last_error`, `settled_at`) comes back `null`.
 *
 * **Every value this returns satisfies the contract.** A field is only ever replaced by a value
 * its own schema accepts, so the type is not asserting something the published schema would
 * refuse — a consumer switching on `status` or passing `id` on as a branded id can trust both.
 * The price is the REQUIRED scalars (`id`, `kind`, `status`, `attempts`, `requested_at`): they
 * have no empty value, so a row that breaks one of them cannot be a `PlatformRequest` without
 * lying, and it throws, naming every column it broke — the strict decode this replaced, kept
 * for exactly the part it cannot honestly be relaxed for. JSON is what a foreign dump actually
 * gets wrong; representing a row whose identity itself is corrupt needs a variant beside
 * `PlatformRequest` on every read, which is a contract change of its own.
 *
 * A row the kernel wrote decodes whole and carries no `decodeError` at all, so a healthy list
 * is exactly what it was. This is the READ's half of #1587's rule — strict where work happens,
 * tolerant where evidence is read; the work half is the drain, which refuses any row carrying
 * `decodeError` rather than run a handler on it.
 *
 * Reachable without a forge: `importDump` replays a dump's rows verbatim, so a dump from
 * another world, or one edited by hand, is enough. The field-by-field mechanics are
 * `rowDecoder`'s, shared with the history and denial reads (#1636).
 */
export function platformRequestOf(row: PlatformRequestRawRow): PlatformRequest {
  const shape = platformRequest.shape;
  const d = rowDecoder(`platform request row ${JSON.stringify(row.id)}`, 'PlatformRequest');
  return d.finish<PlatformRequest>({
    id: d.required<PlatformRequest['id']>('id', shape.id, row.id),
    kind: d.required<string>('kind', shape.kind, row.kind),
    payload: d.json<unknown>('payload', shape.payload, row.payload, null),
    requestedBy: d.json<Actor>('requested_by', shape.requestedBy, row.requested_by, UNDECODED_REQUESTER),
    impersonation: d.json<PlatformRequest['impersonation']>('impersonation', shape.impersonation, row.impersonation, null),
    status: d.required<PlatformRequest['status']>('status', shape.status, row.status),
    attempts: d.required<number>('attempts', shape.attempts, row.attempts),
    lastError: d.nullable<string>('last_error', shape.lastError, row.last_error),
    failure: d.json<PlatformRequest['failure']>('last_failure', shape.failure, row.last_failure, null),
    result: d.json<unknown>('result', shape.result, row.result, null),
    requestedAt: d.required<PlatformRequest['requestedAt']>('requested_at', shape.requestedAt, row.requested_at),
    settledAt: d.nullable<PlatformRequest['requestedAt']>('settled_at', shape.settledAt, row.settled_at),
  });
}
