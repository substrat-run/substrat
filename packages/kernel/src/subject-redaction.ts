/**
 * The intent journal's half of a subject erasure (#1600) — and, by the same link, the
 * job-run tables' (#1632, at the end of this file).
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
 *   payload when the erasure landed: it DELIVERS what it read. That window is the one the
 *   outbox redaction has too — a consumer mid-dispatch holds the payload it was handed —
 *   and closing it wants a lock across the drain hop rather than a shape here. Its
 *   WRITEBACK is closed separately and is not part of that residue: `settlePlatformRequest`
 *   is a compare-and-set on `status = 'pending'` on both adapters, so a stale pass cannot
 *   undo the redaction or put a provider's reply — which can quote the person — back into
 *   `last_error`. The two halves were one sentence in the first cut of this file, which
 *   made an avoidable write look as unavoidable as the delivery.
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
 * Separate numbers rather than one sum, because the receipt reports them apart: how much
 * was said about a person, how many copies of it were queued for a third party, and how
 * many long-running jobs held one are different facts, and a DSAR answer that folded them
 * together could not say any of them.
 *
 * It lives here rather than in an adapter because it is what the Durable-Object adapter
 * hands back across its RPC, and the coordinator that reads it deliberately does not
 * import the DO module (it would pull the whole scope class into a worker that only
 * coordinates).
 */
export interface SubjectRedactionCounts {
  events: number;
  intents: number;
  /**
   * Job runs (#1632) whose record held a copy of a redacted event — in the run row, or in
   * a step of its ledger. Counted per RUN, once, however many of its columns and steps
   * were rewritten: "how many long-running jobs had this person's data" is the fact, and
   * a count of rewritten cells would read larger than anything a DSAR answer could say.
   */
  jobRuns: number;
}

/**
 * What a ScopeDO from after #1600 and before #1632 answers — the job-run count absent,
 * because that host never looked at the job tables. The coordinator refuses it rather than
 * reading the absence as zero (see `redactSubject`'s callers).
 */
export type LegacySubjectRedactionCounts = Omit<SubjectRedactionCounts, 'jobRuns'>;

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
 * **`result` and `last_failure` go too (#1632).** The first cut spared `result` as
 * envelope, reasoning from a routed dispatch whose result is `{ eventId }`. But `result` is
 * whatever the drain's handler returned, and a connector handler's return is the
 * provider's answer about delivering THIS person's data — `last_error`'s reason, in the
 * column beside it. So a result that exists becomes the same tombstone the payload does;
 * a NULL result stays NULL, because a tombstone there would claim an answer nobody gave.
 * `last_failure` carries no free text (`{origin, code, permission}`), and is nulled for a
 * different reason: it is the ATTRIBUTION of `last_error`, and once `last_error` is our
 * note, a kept `origin: 'provider'` would caption the platform's sentence as the
 * provider's words. NULL is the contract's "unrecorded", which is now the truth.
 *
 * Params, in order: payload, cancelled-note, redacted-note, result-tombstone, at, id.
 */
export const PLATFORM_REQUEST_REDACTION_SQL = `UPDATE _substrat_platform_requests
     SET payload = ?,
         last_error = CASE WHEN status = 'pending' THEN ? ELSE ? END,
         last_failure = NULL,
         result = CASE WHEN result IS NULL THEN NULL ELSE ? END,
         settled_at = COALESCE(settled_at, ?),
         status = CASE WHEN status = 'pending' THEN 'failed' ELSE status END
   WHERE id = ?`;

/** The bound parameters for `PLATFORM_REQUEST_REDACTION_SQL`, in its declared order. */
export function platformRequestRedactionParams(
  id: string,
  subjectId: string,
  at: string,
): [string, string, string, string, string, string] {
  const tombstone = redactedIntentPayload(subjectId, at);
  return [tombstone, CANCELLED_INTENT_NOTE, REDACTED_INTENT_NOTE, tombstone, at, id];
}

/**
 * Does this stored payload carry a copy of an event the erasure redacts?
 *
 * The outbox's predicate, walked over the payload's structure: an object carrying BOTH
 * `subjectId` equal to this subject AND a `piiClass` other than `'none'` IS a spine
 * envelope — those two field names occur together nowhere else — so wherever the spine
 * has copied one into an intent, the copy inherits the original's redaction.
 *
 * Returns false for a payload that IS already a tombstone (so a re-run after a crash
 * converges rather than re-stamping) and false for a payload that is not JSON at all,
 * which nothing in the kernel can write but which a stricter answer would have to invent
 * a meaning for.
 */
export function intentPayloadCarriesSubject(payloadText: string, subjectId: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payloadText);
  } catch {
    return false;
  }
  if (isRedactedPayload(parsed)) return false;
  return carriesSubject(parsed, subjectId);
}

/**
 * Is this payload one we already redacted?
 *
 * **Asked of the WHOLE payload, once, and never inside the walk (#1600 review).** The
 * first cut short-circuited the walk at any object carrying the marker key, which made
 * `{ _substratRedacted: false, event: <a real envelope> }` a payload the erasure stepped
 * straight past, PII and all — and the comment beside it claimed the check was redundant
 * belt-and-braces because a tombstone has no `piiClass`. That was true of the tombstone
 * and false of everything else wearing its key. An intent payload is `unknown` and module
 * code chooses it, so a marker that means "stop looking" must not be something a payload
 * can merely CONTAIN.
 *
 * The invariant asked instead is un-forgeable in the only way that matters: *a payload
 * that is nothing but a redaction tombstone is already redacted*. One top-level key, and
 * that key's value says why. Anything beside the marker is not this, gets walked, and is
 * judged on its own contents — which is exactly right, because something beside the
 * marker is something the erasure might need to reach. Inner fields beyond `reason` are
 * deliberately not pinned: a later tombstone that carries more would still be nothing but
 * a tombstone, and hard-coding its shape here is how idempotency would quietly regress.
 */
function isRedactedPayload(parsed: unknown): boolean {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return false;
  const keys = Object.keys(parsed);
  if (keys.length !== 1 || keys[0] !== REDACTED_INTENT_MARKER) return false;
  const marker = (parsed as Record<string, unknown>)[REDACTED_INTENT_MARKER];
  return (
    typeof marker === 'object' &&
    marker !== null &&
    !Array.isArray(marker) &&
    (marker as Record<string, unknown>)['reason'] === 'subject-erasure'
  );
}

function carriesSubject(node: unknown, subjectId: string): boolean {
  if (Array.isArray(node)) return node.some((child) => carriesSubject(child, subjectId));
  if (node === null || typeof node !== 'object') return false;
  const obj = node as Record<string, unknown>;
  if (
    obj['subjectId'] === subjectId &&
    typeof obj['piiClass'] === 'string' &&
    obj['piiClass'] !== 'none'
  ) {
    return true;
  }
  return Object.values(obj).some((child) => carriesSubject(child, subjectId));
}

// -- the delivery journal's error text (#1632) ---------------------------------------

/**
 * The note a redaction leaves on a delivery of a redacted event that had failed.
 *
 * `_substrat_deliveries.error` is a consumer's or executor's own sentence about handling
 * THIS event — a throw that quoted the payload it choked on reads exactly like the
 * provider's `last_error` on an intent. Unlike every other copy in this file it needs no
 * walk: the row is keyed by `event_id`, so the outbox's own predicate names it exactly.
 */
export const REDACTED_DELIVERY_NOTE =
  'redacted by subject erasure (#37) — what this delivery reported is gone; that it failed, and when, is not';

/**
 * One statement: every failed delivery of an event the erasure redacts. Only a NON-NULL
 * error is rewritten, because a non-null error is what MEANS dead-lettered or retrying
 * (`deliveryState`); writing the note onto a delivered row would turn it into a dead one.
 * Not counted on the receipt: it is text about an event `eventsRedacted` already counts,
 * not another copy of it. Idempotent — a note is not rewritten with itself.
 *
 * Params: note, note, subject id.
 */
export const DELIVERY_ERROR_REDACTION_SQL = `UPDATE _substrat_deliveries
     SET error = ?
   WHERE error IS NOT NULL AND error != ?
     AND event_id IN (SELECT id FROM _substrat_outbox WHERE subject_id = ? AND pii_class != 'none')`;

// -- the job-run tables (#1632) ------------------------------------------------------

/**
 * The note a redaction leaves on a job run, or on a step of its ledger, that had finished.
 *
 * Same reasoning as `REDACTED_INTENT_NOTE`: `last_error` is a sentence an external system
 * wrote about work done on this person's data, so it is content, not envelope.
 */
export const REDACTED_JOB_NOTE =
  'redacted by subject erasure (#37) — what this job run held about the subject is gone; that it ran, and when, is not';

/**
 * The note a redaction leaves on a job run that was still `running`.
 *
 * A running run is redacted AND settled `failed` in the same statement, for the pending
 * intent's reason and one of its own. A run resumes from its payload, its cursor and the
 * memo of its completed steps; once any of those is a tombstone, the next pass would be
 * handed the tombstone AS its input — a step's memo is returned to the handler without
 * running anything — and walk on from nonsense. `failed` is what the run now is.
 */
export const CANCELLED_JOB_NOTE =
  'stopped by subject erasure (#37) — this run held a copy of an erased subject\'s event, so it cannot resume from it';

/**
 * How the job-run half talks to a scope database — one shape both adapters can satisfy
 * in a line (`db.prepare(sql)` / `this.sql.exec(sql, …)`), so the reads, the predicate
 * and the writes below are ONE implementation rather than two ports of it.
 */
export type RedactionSql = (sql: string, params: readonly (string | number | null)[]) => unknown[];

/**
 * The job-run half of an erasure (#1632), shared by both adapters.
 *
 * **What decides membership is #1600's predicate, and nothing else.** A job run carries no
 * `subject_id`: its payload is "ids and configuration", its cursor is opaque, and a step's
 * result is whatever a HOST handler got back from an external system. The one link the
 * kernel can read reliably is the one the intent journal uses — a spine envelope embedded
 * at any depth, carrying this subject and a `piiClass` other than `none` — so a job-run
 * copy is redacted exactly when the erasure redacts the event it copies. The candidate
 * reads use `instr` over the text, as the intent read does; `intentPayloadCarriesSubject`
 * decides.
 *
 * **What it therefore does NOT reach** is external output naming the person with no
 * classified envelope around it — a step that returns a provider's contact record, a
 * `last_error` quoting a name. There is nothing in such a row that says whose it is, and a
 * substring match on the id would both erase on coincidence and miss the name itself.
 * kernel-design.md §13.1 limit 8 states it; a declared subject on the run is the open
 * design that would close it (#1632).
 *
 * Per column, for a matching run: `payload` and `cursor` become the tombstone where THEY
 * match (the payload is `NOT NULL`, the cursor may be `NULL` and stays so), `last_error`
 * becomes the note, and a `running` run is settled `failed`. For a matching step: `result`
 * becomes the tombstone, `last_error` the note — and its RUN is settled too, because the
 * memo would otherwise hand the tombstone to the next pass. Idempotent: a tombstone no
 * longer matches, so a second erasure finds nothing.
 *
 * Returns the number of distinct runs touched.
 */
export function redactSubjectJobRuns(sql: RedactionSql, subjectId: string, at: string): number {
  // The needle, spelled as `platformRequestRedactionQuery` spells it.
  const needle = JSON.stringify(subjectId).slice(1, -1);
  const tombstone = redactedIntentPayload(subjectId, at);
  const runs = new Set<string>();

  const steps = sql(
    'SELECT run_id, step, result FROM _substrat_job_steps WHERE instr(result, ?) > 0',
    [needle],
  ) as { run_id: string; step: string; result: string }[];
  for (const s of steps) {
    if (!intentPayloadCarriesSubject(s.result, subjectId)) continue;
    sql(JOB_STEP_REDACTION_SQL, [tombstone, REDACTED_JOB_NOTE, s.run_id, s.step]);
    runs.add(s.run_id);
  }

  const candidates = sql(
    `SELECT id, payload, cursor FROM _substrat_job_runs
      WHERE instr(payload, ?) > 0 OR instr(cursor, ?) > 0`,
    [needle, needle],
  ) as { id: string; payload: string; cursor: string | null }[];
  const hits = new Map<string, { payload: boolean; cursor: boolean }>();
  for (const r of candidates) {
    const payload = intentPayloadCarriesSubject(r.payload, subjectId);
    const cursor = r.cursor !== null && intentPayloadCarriesSubject(r.cursor, subjectId);
    if (payload || cursor) hits.set(r.id, { payload, cursor });
  }
  // A run reached only through a step is still rewritten: its note and its status are
  // what stop the tombstoned memo being replayed.
  for (const id of runs) if (!hits.has(id)) hits.set(id, { payload: false, cursor: false });

  for (const [id, hit] of hits) {
    sql(JOB_RUN_REDACTION_SQL, [
      hit.payload ? 1 : 0,
      tombstone,
      hit.cursor ? 1 : 0,
      tombstone,
      CANCELLED_JOB_NOTE,
      REDACTED_JOB_NOTE,
      at,
      at,
      id,
    ]);
    runs.add(id);
  }
  return runs.size;
}

/**
 * One matched step: its result becomes the tombstone, its error the note.
 *
 * Params: tombstone, note, run_id, step.
 */
export const JOB_STEP_REDACTION_SQL = `UPDATE _substrat_job_steps
     SET result = ?, last_error = ?
   WHERE run_id = ? AND step = ?`;

/**
 * One matched run. Every `CASE WHEN status = 'running'` reads the status as it was before
 * this statement — SQLite evaluates each SET against the original row — which is what
 * lets one statement pick the note and settle the status it branched on. `ended_at` is
 * COALESCEd so a run that had already ended keeps the instant it ended.
 *
 * Params: payload-hit (0/1), tombstone, cursor-hit (0/1), tombstone, cancelled-note,
 * redacted-note, at (ended_at), at (updated_at), id.
 */
export const JOB_RUN_REDACTION_SQL = `UPDATE _substrat_job_runs
     SET payload = CASE WHEN ? = 1 THEN ? ELSE payload END,
         cursor = CASE WHEN ? = 1 THEN ? ELSE cursor END,
         last_error = CASE WHEN status = 'running' THEN ? ELSE ? END,
         next_attempt_at = CASE WHEN status = 'running' THEN NULL ELSE next_attempt_at END,
         ended_at = COALESCE(ended_at, ?),
         updated_at = ?,
         status = CASE WHEN status = 'running' THEN 'failed' ELSE status END
   WHERE id = ?`;
