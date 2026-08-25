import {
  IDEMPOTENCY_REPLAY_UNAVAILABLE,
  IDEMPOTENCY_RESULT_LIMIT,
  IDEMPOTENCY_RETENTION_MS,
  IDEMPOTENCY_REUSED,
  isValidIdempotencyKey,
  subjectRef,
  substratError,
  type CheckSubject,
} from '@substrat-run/contracts';

/**
 * The spine half of request idempotency (#116) — what remembers a key, and what
 * a second request carrying it is answered with.
 *
 * `@substrat-run/contracts` owns the wire (the header names, what makes a key
 * well-formed, what makes two requests the same request); this owns the table
 * and the decisions read off it. Both adapters call these rather than writing
 * the SQL twice, for the reason `entityVersionQuery` gives one file over: two
 * surfaces answering one question must not drift on what the answer means. Here
 * the answer decides whether work happens at all.
 *
 * ## Recorded INSIDE the operation's transaction, which is the whole design
 *
 * The row is written in the same transaction as the work it describes, after the
 * handler and before `COMMIT`. Three properties fall out of that one placement,
 * and none of them needed a mechanism of its own:
 *
 * - **A failed request is retried, not replayed.** The operation threw, the
 *   transaction rolled back, and the row went with it. There is nothing to find,
 *   so the retry executes — which is correct, because nothing happened the first
 *   time. Recording failures would have meant deciding which of them are
 *   permanent, and that is a judgement no generic layer can make.
 * - **A replayed response describes work that actually committed.** The row and
 *   the rows it is about are the same transaction; there is no window in which
 *   one exists without the other.
 * - **The dedupe cannot be defeated by a concurrent retry.** Invokes serialise
 *   per scope in both adapters, so the second request takes its turn after the
 *   first has committed — no in-flight state, no "still processing" 409.
 *
 * ## What a replay is NOT
 *
 * It is not a fresh authorization. The recorded response is returned without
 * running the handler, and the permission check lives inside the handler — so a
 * caller whose access was revoked in the last 24 hours can still replay their own
 * response. This is bounded by the two things that make it defensible: the row is
 * keyed by the SUBJECT, so a caller can only ever reach responses they themselves
 * received, and the window is a day. It is stated here rather than discovered,
 * because the alternative — re-running the operation to re-check the permission —
 * is the duplicate execution this feature exists to prevent.
 */

/**
 * The dedupe table, kernel-owned so that no vertical carries a migration for it.
 *
 * Keyed `(subject, key)` rather than `(key)`, and that is a safety property, not
 * a namespacing convenience: a key is a string a client chose, two clients will
 * choose `1`, and a lookup that found the other one's row would replay a response
 * across a principal boundary. With the subject in the primary key that is not a
 * check that could be forgotten — it is a row that cannot be reached.
 *
 * `operation` is stored as well as hashed into `fingerprint`. The hash is what
 * decides a mismatch; the column is what makes the table readable when someone is
 * working out why a client is getting 409s.
 */
export const IDEMPOTENCY_DDL = `
  CREATE TABLE IF NOT EXISTS _substrat_idempotency (
    subject TEXT NOT NULL,
    key TEXT NOT NULL,
    operation TEXT NOT NULL,
    -- SHA-256 over (operation, parsed input). A second request under this key
    -- whose fingerprint differs is a REUSE, refused with 409 — never served the
    -- first request's response, which is a different request's answer.
    fingerprint TEXT NOT NULL,
    -- The operation's return value as JSON. NULL means one of two things, which
    -- \`oversized\` separates: the operation returned nothing, or the result was
    -- too large to record and a replay must be refused rather than re-executed.
    result TEXT,
    oversized INTEGER NOT NULL DEFAULT 0,
    -- #129's tag, replayed with the body so a retry hands the client the same
    -- ETag the original did. Without it a replayed response has no validator and
    -- the client's next conditional write has nothing to send.
    entity_version TEXT,
    recorded_at TEXT NOT NULL,
    PRIMARY KEY (subject, key)
  );
  CREATE INDEX IF NOT EXISTS _substrat_idempotency_recorded
    ON _substrat_idempotency (recorded_at);
`;

/** The stored row, as both adapters' SQL returns it. */
export interface IdempotencyRow {
  readonly operation: string;
  readonly fingerprint: string;
  readonly result: string | null;
  readonly oversized: number;
  readonly entity_version: string | null;
}

/** What a replay answers with: the recorded return value and the recorded tag. */
export interface IdempotentReplay {
  readonly result: unknown;
  readonly entityVersion: string | null;
}

/** The subject a key is scoped to, in the form the column stores. */
export function idempotencySubject(subject: CheckSubject): string {
  return subjectRef(subject);
}

/**
 * Refuse a malformed key at the door.
 *
 * `validation_failed` rather than `conflict`: nothing is in conflict, the caller
 * sent a header we cannot store. Refused rather than ignored, for the reason the
 * `If-Match` path gives — a caller who believes their retry is safe and whose
 * key was silently dropped is in exactly the position this feature exists to
 * prevent, arrived at through the feature itself.
 */
export function assertIdempotencyKey(key: string): void {
  if (isValidIdempotencyKey(key)) return;
  throw substratError(
    'validation_failed',
    'Idempotency-Key must be 1-255 visible ASCII characters with no spaces',
  );
}

/** The lookup a retry is answered from. */
export function idempotencyLookupQuery(
  subject: CheckSubject,
  key: string,
): { sql: string; params: [string, string] } {
  return {
    sql:
      'SELECT operation, fingerprint, result, oversized, entity_version ' +
      'FROM _substrat_idempotency WHERE subject = ? AND key = ?',
    params: [idempotencySubject(subject), key],
  };
}

/**
 * Decide what a second request under this key gets.
 *
 * Two refusals and one replay, both refusals `conflict` (409) with a reason slug
 * this feature owns:
 *
 * - **Reuse.** Same key, different request. The client's assertion that this is
 *   the request it sent before is false, and the one thing that must not happen
 *   is serving the earlier request's response to it.
 * - **Unavailable.** The original response was too large to record. Refused
 *   rather than re-executed, which is the fail-closed direction: an error the
 *   caller can act on, instead of the duplicate work the key was sent to avoid.
 */
export function replayFor(
  key: string,
  fingerprint: string,
  row: IdempotencyRow,
): IdempotentReplay {
  if (row.fingerprint !== fingerprint) {
    throw substratError(
      'conflict',
      `Idempotency-Key '${key}' was already used for a different request ` +
        `(${row.operation}). A key identifies one request; use a fresh one`,
      { reason: IDEMPOTENCY_REUSED },
    );
  }
  if (row.oversized !== 0) {
    throw substratError(
      'conflict',
      `the original response for Idempotency-Key '${key}' was too large to record, ` +
        'so this retry cannot be answered from it — the original request did complete, ' +
        'and re-running it would duplicate the work the key exists to prevent',
      { reason: IDEMPOTENCY_REPLAY_UNAVAILABLE },
    );
  }
  return {
    result: row.result === null ? undefined : JSON.parse(row.result),
    entityVersion: row.entity_version,
  };
}

/**
 * The row a completed operation leaves behind.
 *
 * Serialisation happens here rather than at each call site so the size decision
 * has one home: over `IDEMPOTENCY_RESULT_LIMIT` the body is dropped and the key
 * is recorded as oversized, which is what makes a later replay a refusal instead
 * of a silent re-execution.
 *
 * `undefined` and `null` results are both stored as a NULL body with
 * `oversized = 0`; a replay returns `undefined` for either. An operation whose
 * return value a caller distinguishes on that difference has a bigger problem
 * than this table.
 */
export function idempotencyRecordStatement(
  subject: CheckSubject,
  key: string,
  operation: string,
  fingerprint: string,
  result: unknown,
  entityVersion: string | null,
  at: string,
): { sql: string; params: [string, string, string, string, string | null, number, string | null, string] } {
  const serialised = result === undefined ? null : JSON.stringify(result) ?? null;
  const oversized = serialised !== null && serialised.length > IDEMPOTENCY_RESULT_LIMIT;
  return {
    sql:
      'INSERT INTO _substrat_idempotency ' +
      '(subject, key, operation, fingerprint, result, oversized, entity_version, recorded_at) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    params: [
      idempotencySubject(subject),
      key,
      operation,
      fingerprint,
      oversized ? null : serialised,
      oversized ? 1 : 0,
      entityVersion,
      at,
    ],
  };
}

/**
 * Age rows out, in the same transaction as the write that added one.
 *
 * Opportunistic rather than swept, deliberately. A sweeper would be a second
 * schedule, a second failure mode and a second thing to deploy, for a table whose
 * only writer is already here holding a transaction open. Bounded work: the
 * `recorded_at` index makes it a range delete, and it runs only on an invocation
 * that carried a key — so a fleet that never uses the feature never pays for it.
 *
 * The consequence worth stating: a scope that stops receiving keyed requests
 * keeps its last rows past the window. They are inert (nothing reads a row
 * without a key that matches it) and the next keyed request clears them.
 */
export function idempotencyPruneStatement(now: string): { sql: string; params: [string] } {
  const cutoff = new Date(Date.parse(now) - IDEMPOTENCY_RETENTION_MS).toISOString();
  return {
    sql: 'DELETE FROM _substrat_idempotency WHERE recorded_at < ?',
    params: [cutoff],
  };
}

/**
 * The refusal an operation that declared `idempotency: false` answers a key with.
 *
 * Not a `conflict` — nothing conflicts — and not silence, which is the failure
 * mode every branch of this feature is written to avoid. The operation opted out
 * because its response must not be recorded; a caller who sent a key and got a
 * 200 would believe a retry is safe when the second one will execute again.
 */
export function idempotencyOptedOutMessage(operation: string): string {
  return (
    `${operation} declares \`idempotency: false\` and cannot honour an Idempotency-Key — ` +
    'its response is not recorded, so a retry would execute it a second time'
  );
}
