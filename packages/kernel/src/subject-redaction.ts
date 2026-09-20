/**
 * The intent journal's half of a subject erasure (#1600).
 *
 * `shredSubject` holds K-37's Tier-1 line — *the payload goes, the envelope stays* —
 * and for a year that line reached exactly one table, `_substrat_outbox`. It is not the
 * only place the spine keeps an event's payload. A CP-less host cannot run a connector
 * (no directory, no credentials, no sanctioned egress), so each connector delivery
 * becomes a `connector:<provider>` platform intent whose payload is the WHOLE
 * `DomainEvent` — fat by design, because "the platform's handler needs everything the
 * in-process handler would have been handed" (`connectorDispatchPayload`). That copy
 * lands in `_substrat_platform_requests`, which nothing ever deletes: the retention is
 * deliberate, `listPlatformRequestHistory` exists precisely so a settled row stays
 * readable. So a name the redaction did not reach there survived in the live scope
 * database, and in every export, backup and PITR window taken from it afterwards.
 *
 * **The rule this module implements is narrow on purpose:** an intent that carries a
 * COPY OF AN EVENT is redacted exactly when the erasure redacts that event. Not "any
 * payload mentioning the subject" — the outbox spares a `piiClass: 'none'` event even
 * when it names the subject, and a copy judged more harshly than its original is an
 * incoherent rule, not a stricter one. So the predicate below is the outbox's own
 * predicate (`subject_id = ? AND pii_class != 'none'`) applied to whatever spine
 * envelope the payload embeds, at whatever depth. `subjectId` and `piiClass` occur
 * together only on `domainEventShape`, which is what makes the walk kind-agnostic
 * rather than a guess about `connector:*`.
 *
 * What it therefore does NOT reach is an intent kind that carries a subject's PII
 * WITHOUT carrying the classified event — an intent payload has no `piiClass` of its
 * own, so the kernel has nothing to read. No kind does that today (kernel-design.md
 * §13.1 limit 7 says so and names the walk), and a kind that started to would be
 * inventing an unclassified PII store inside the spine.
 *
 * This is a kernel module rather than two copies of the same SQL for
 * `platformRequestHistoryQuery`'s reason, sharpened: three surfaces answer one question
 * from this table, and a privacy guarantee that holds on one adapter is not a guarantee.
 */

/**
 * The one key a redacted intent payload carries, and nothing else in the system does.
 *
 * Underscore-prefixed on the `_substrat_*` habit: the marker is the platform's, not a
 * field some vertical's payload could plausibly own.
 */
export const REDACTED_INTENT_MARKER = '_substratRedacted';

/**
 * What replaces a redacted intent's payload.
 *
 * The column is `payload TEXT NOT NULL` on both adapters, so the outbox's
 * `SET payload = NULL` cannot transfer and *what a redacted intent looks like* is a
 * shape to choose rather than a null to write. Three things decide this one:
 *
 * - **Obviously redacted, never plausible data.** A reader who has the row in front of
 *   them must not have to know the kind's schema to see that the content is gone.
 * - **It fails every handler's parse.** Each drain handler opens with
 *   `<kind>Payload.parse(request.payload)`, and no kind's schema admits an object whose
 *   only key is this marker. So a drain that reaches the row after the redaction settles
 *   loudly instead of executing a tombstone as if it were an instruction. What this does
 *   NOT close, and should not be read as closing, is the drain that had already READ the
 *   payload when the erasure landed: it delivers what it read, and its `settle` can write
 *   a provider's reply back onto the row. That window is the one the outbox redaction has
 *   too — a consumer mid-dispatch holds the payload it was handed — and closing it wants a
 *   lock across the drain hop rather than a shape here.
 * - **It keeps the pseudonymous key, exactly as the outbox row does.** The redacted
 *   outbox row still carries `subject_id`; §5.3's "pseudonymous keys and transaction
 *   facts remain" is the same sentence here. A row that is blank for no stated reason
 *   reads as corruption; this one says what happened to it and when.
 */
export function redactedIntentPayload(subjectId: string, at: string): string {
  return JSON.stringify({
    [REDACTED_INTENT_MARKER]: { reason: 'subject-erasure', subjectId, at },
  });
}

/**
 * The note a redaction leaves on an intent that had already settled.
 *
 * `last_error` is overwritten rather than kept, and that is deliberate: it is free text
 * a third party wrote about the delivery of this person's data — the surface #618 built
 * precisely so a provider's own sentence ("…requires valid personal number field") is
 * readable — so it is content about the subject, not envelope. An erasure that emptied
 * `payload` and left a provider quoting the name two columns over would be the same bug
 * this fixes, one column to the right.
 */
export const REDACTED_INTENT_NOTE =
  'redacted by subject erasure (#37) — what this intent said is gone; that it happened, and when, is not';

/**
 * The note a redaction leaves on an intent that was still `pending`.
 *
 * A pending row is redacted like any other AND settled `failed` in the same statement,
 * because the two halves of the alternative are both wrong: leaving it pending-and-intact
 * keeps the name (the defect), and leaving it pending-and-redacted hands the drain a
 * tombstone to execute. `failed` is the truthful terminal state — the delivery did not
 * happen and now cannot — and the executor delivery behind it was already journaled as
 * routed, so nothing re-routes the event to replace this row.
 */
export const CANCELLED_INTENT_NOTE =
  'cancelled by subject erasure (#37) — the payload was redacted before the drain reached it, so this intent never ran';

/** The row shape the redaction reads to decide. */
export interface PlatformRequestRedactionCandidate {
  id: string;
  payload: string;
}

/**
 * What one spine redaction moved, per table.
 *
 * Two numbers rather than one sum, because the receipt reports them apart: how much was
 * said about a person and how many copies of it were queued for a third party are
 * different facts, and a DSAR answer that folded them together could not say either.
 *
 * It lives here rather than in an adapter because it is what the Durable-Object adapter
 * hands back across its RPC, and the coordinator that reads it deliberately does not
 * import the DO module (it would pull the whole scope class into a worker that only
 * coordinates).
 */
export interface SubjectRedactionCounts {
  events: number;
  intents: number;
}

/**
 * The candidate read: every intent whose stored payload TEXT contains the subject id.
 *
 * A prefilter, not the decision — `intentPayloadCarriesSubject` decides. `instr` rather
 * than `LIKE` because it is a literal substring search with no wildcard to escape, and
 * the needle is the subject id as `JSON.stringify` would have written it into the
 * payload (identical to the raw id for a `dataSubjectId`, which is a ULID and so has
 * nothing to escape — spelled out anyway, since the host contract types the parameter
 * `string`).
 *
 * Unindexed, and that is affordable: this runs once per staff-triggered erasure over one
 * scope's journal, where the alternative is parsing every row's JSON in the host.
 */
export function platformRequestRedactionQuery(subjectId: string): {
  sql: string;
  params: string[];
} {
  return {
    sql: 'SELECT id, payload FROM _substrat_platform_requests WHERE instr(payload, ?) > 0',
    // Strip the quotes JSON.stringify adds and keep the escaped body — the exact run of
    // characters the serialized payload holds.
    params: [JSON.stringify(subjectId).slice(1, -1)],
  };
}

/**
 * The write. One statement per redacted row, so the payload, the note and the pending
 * row's settlement are one atomic change rather than three that can half-land.
 *
 * Every SET expression is evaluated against the ORIGINAL row in SQLite, so both `CASE
 * WHEN status = 'pending'` arms read the status as it was before this statement touched
 * it — which is what lets one statement both re-word the note and change the status it
 * branched on. `settled_at` is COALESCEd so a row that already settled keeps the instant
 * it settled at; only a cancelled pending row is stamped now.
 *
 * Params, in order: payload, cancelled-note, redacted-note, at, id.
 */
export const PLATFORM_REQUEST_REDACTION_SQL = `UPDATE _substrat_platform_requests
     SET payload = ?,
         last_error = CASE WHEN status = 'pending' THEN ? ELSE ? END,
         settled_at = COALESCE(settled_at, ?),
         status = CASE WHEN status = 'pending' THEN 'failed' ELSE status END
   WHERE id = ?`;

/** The bound parameters for `PLATFORM_REQUEST_REDACTION_SQL`, in its declared order. */
export function platformRequestRedactionParams(
  id: string,
  subjectId: string,
  at: string,
): [string, string, string, string, string] {
  return [redactedIntentPayload(subjectId, at), CANCELLED_INTENT_NOTE, REDACTED_INTENT_NOTE, at, id];
}

/**
 * Does this stored payload carry a copy of an event the erasure redacts?
 *
 * The outbox's predicate, walked over the payload's structure: an object carrying BOTH
 * `subjectId` equal to this subject AND a `piiClass` other than `'none'` IS a spine
 * envelope — those two field names occur together nowhere else — so wherever the spine
 * has copied one into an intent, the copy inherits the original's redaction.
 *
 * Returns false for an already-redacted payload (the marker short-circuits, so a re-run
 * after a crash converges rather than re-stamping) and false for a payload that is not
 * JSON at all, which nothing in the kernel can write but which a stricter answer would
 * have to invent a meaning for.
 */
export function intentPayloadCarriesSubject(payloadText: string, subjectId: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payloadText);
  } catch {
    return false;
  }
  return carriesSubject(parsed, subjectId);
}

function carriesSubject(node: unknown, subjectId: string): boolean {
  if (Array.isArray(node)) return node.some((child) => carriesSubject(child, subjectId));
  if (node === null || typeof node !== 'object') return false;
  const obj = node as Record<string, unknown>;
  // Already a tombstone. Belt and braces — the marker object carries no `piiClass`, so
  // the test below would decline it anyway — but idempotency here should be a stated
  // property rather than a lucky consequence of the shape chosen above.
  if (obj[REDACTED_INTENT_MARKER] !== undefined) return false;
  if (
    obj['subjectId'] === subjectId &&
    typeof obj['piiClass'] === 'string' &&
    obj['piiClass'] !== 'none'
  ) {
    return true;
  }
  return Object.values(obj).some((child) => carriesSubject(child, subjectId));
}
