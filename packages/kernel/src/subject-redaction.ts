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
 * own, so the kernel has nothing to read. One shipped kind can: a `sweep-runs` entry's
 * `error` is a scheduled operation's throw, and that text gets its own walk on the subject's
 * id (`redactSubjectSweepRunIntents`, at the end of this file). Any other kind is limit 7 in
 * kernel-design.md §13.1, and a kind that started carrying a person directly would be
 * inventing an unclassified PII store inside the spine.
 *
 * This is a kernel module rather than two copies of the same SQL for
 * `platformRequestHistoryQuery`'s reason, sharpened: three surfaces answer one question
 * from this table, and a privacy guarantee that holds on one adapter is not a guarantee.
 */

import { SWEEP_RUNS_KIND } from '@substrat-run/contracts';
import type { ModuleErasureCounts } from './module-erasure.js';

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
const REDACTED_INTENT_NOTE =
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
const CANCELLED_INTENT_NOTE =
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
  /**
   * Recorded idempotent responses (#1632) that named the subject and now hold the tombstone.
   * Not on the receipt — a cached reply is not another copy of an event — but answered, so a
   * coordinator can tell a host that looked from one that never did.
   */
  idempotencyResults: number;
  /**
   * Every intent in the journal holding this subject's tombstone after the pass, whether this
   * pass or an earlier one wrote it. The directory half needs them (`redactSubjectDirectoryText`):
   * a drain failure about one of these intents quotes its `last_error`. All of them rather than
   * the new ones, so an erasure that crashed between the two halves converges on its re-run.
   */
  intentIds: string[];
  /**
   * The module half (#2068): what the declared erasures and the `onSubjectErased` hooks did
   * to the scope's own tables, in the same transaction as everything above. Its PRESENCE is
   * what a coordinator reads to tell a host that reached the module tables from one built
   * before they could be — the absent field is refused before the key, like the others.
   */
  vertical: ModuleErasureCounts;
}

/**
 * What an older ScopeDO answers. One from after #1600 and before #1632 has no job-run count,
 * because that host never looked at the job tables; one from before the free-text half has
 * the count but no `idempotencyResults` or `intentIds`. The coordinator refuses both rather
 * than reading an absence as zero (see `redactSubject`'s callers).
 */
export type LegacySubjectRedactionCounts = Omit<
  SubjectRedactionCounts,
  'jobRuns' | 'idempotencyResults' | 'intentIds' | 'vertical'
> & { jobRuns?: number };

/**
 * The needle every walk in this file searches a stored text for: the subject id with the
 * quotes JSON.stringify adds stripped, keeping the escaped body — the exact run of characters
 * a serialized payload holds.
 */
function subjectNeedle(subjectId: string): string {
  return JSON.stringify(subjectId).slice(1, -1);
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
    params: [subjectNeedle(subjectId)],
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
export function isRedactedPayload(parsed: unknown): boolean {
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
  'stopped by subject erasure (#37) — this run held an erased subject\'s data, so it cannot resume from it';

/**
 * How the job-run half talks to a scope database — one shape both adapters can satisfy
 * in a line (`db.prepare(sql)` / `this.sql.exec(sql, …)`), so the reads, the predicate
 * and the writes below are ONE implementation rather than two ports of it.
 */
export type RedactionSql = (sql: string, params: readonly (string | number | null)[]) => unknown[];

/**
 * The job-run half of an erasure (#1632), shared by both adapters.
 *
 * A declared `subject_id` identifies the whole run: all payload, cursor, step output,
 * and error text is redacted, even when it contains no classified event envelope.
 * Legacy and unclassified runs retain #1600's embedded-envelope predicate. Free text
 * without either link remains unreachable; matching a name or id substring is not a
 * reliable declaration of whose data a run handles.
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
  const needle = subjectNeedle(subjectId);
  const tombstone = redactedIntentPayload(subjectId, at);
  const runs = new Set<string>();

  const hits = new Map<string, { payload: boolean; cursor: boolean }>();
  const declared = sql(
    'SELECT id, payload, cursor, status, last_error FROM _substrat_job_runs WHERE subject_id = ?',
    [subjectId],
  ) as { id: string; payload: string; cursor: string | null; status: string; last_error: string | null }[];
  for (const r of declared) {
    // Older envelope-only erasure may have tombstoned just the payload. Verify every
    // owned field before calling this complete; a terminal note is not a receipt.
    if (r.status !== 'running' && isRedactedPayloadText(r.payload, subjectId) &&
        (r.cursor === null || isRedactedPayloadText(r.cursor, subjectId)) &&
        (r.last_error === CANCELLED_JOB_NOTE || r.last_error === REDACTED_JOB_NOTE)) {
      const memos = sql('SELECT result, last_error FROM _substrat_job_steps WHERE run_id = ?', [r.id]) as
        { result: string | null; last_error: string | null }[];
      if (memos.every((memo) =>
        (memo.result === null || isRedactedPayloadText(memo.result, subjectId)) &&
        (memo.last_error === null || memo.last_error === REDACTED_JOB_NOTE))) continue;
    }
    sql(`UPDATE _substrat_job_steps
           SET result = CASE WHEN result IS NULL THEN NULL ELSE ? END,
               last_error = CASE WHEN last_error IS NULL THEN NULL ELSE ? END
         WHERE run_id = ?`, [tombstone, REDACTED_JOB_NOTE, r.id]);
    hits.set(r.id, { payload: true, cursor: r.cursor !== null });
    runs.add(r.id);
  }

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
  for (const r of candidates) {
    const payload = intentPayloadCarriesSubject(r.payload, subjectId);
    const cursor = r.cursor !== null && intentPayloadCarriesSubject(r.cursor, subjectId);
    if ((payload || cursor) && !hits.has(r.id)) hits.set(r.id, { payload, cursor });
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

/** Recognise a previous complete payload tombstone without relying on its timestamp. */
function isRedactedPayloadText(text: string, subjectId: string): boolean {
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    return isRedactedPayload(parsed) &&
      (parsed[REDACTED_INTENT_MARKER] as Record<string, unknown>)['subjectId'] === subjectId;
  } catch { return false; }
}

/**
 * One matched step: its result becomes the tombstone, its error the note.
 *
 * Params: tombstone, note, run_id, step.
 */
const JOB_STEP_REDACTION_SQL = `UPDATE _substrat_job_steps
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
const JOB_RUN_REDACTION_SQL = `UPDATE _substrat_job_runs
     SET payload = CASE WHEN ? = 1 THEN ? ELSE payload END,
         cursor = CASE WHEN ? = 1 THEN ? ELSE cursor END,
         last_error = CASE WHEN status = 'running' THEN ? ELSE ? END,
         next_attempt_at = CASE WHEN status = 'running' THEN NULL ELSE next_attempt_at END,
         ended_at = COALESCE(ended_at, ?),
         updated_at = ?,
         status = CASE WHEN status = 'running' THEN 'failed' ELSE status END
   WHERE id = ?`;

// -- the spine's free-text copies (#1632) ---------------------------------------------

/**
 * The note a redaction leaves where a failure's text named the subject: an ops-failure
 * message, an issue's exemplar, a sweep record's error, or that error still queued inside a
 * `sweep-runs` intent. One note for all four, because the drain lands the last into the third
 * and a reader should meet the same sentence wherever the redaction found the text.
 */
export const REDACTED_FAILURE_NOTE =
  'redacted by subject erasure (#37) — what this failure said is gone; that it happened, and when, is not';

/**
 * The idempotency ledger's half (#1632): a recorded response that names the subject.
 *
 * `result` is an operation's return value, kept for a day so a retry is answered without
 * running again — and an operation that returns a person's record returns their id with it.
 * Nothing else in the row says whose response it is, so the link is the direct one: the
 * subject's id appears in the stored JSON. A `DataSubjectId` is a ULID, so the match does not
 * happen by coincidence. A response that names the person but not their id is not reached.
 *
 * The result becomes the intent tombstone; every other column stays, so the key is still
 * recorded and a retry is still not executed twice. `replayFor` refuses a tombstoned result
 * instead of replaying it. Idempotent: a row already holding this subject's tombstone is
 * skipped. Returns how many rows it rewrote.
 */
export function redactSubjectIdempotency(sql: RedactionSql, subjectId: string, at: string): number {
  const rows = sql(
    'SELECT subject, key, result FROM _substrat_idempotency WHERE instr(result, ?) > 0',
    [subjectNeedle(subjectId)],
  ) as { subject: string; key: string; result: string }[];
  const tombstone = redactedIntentPayload(subjectId, at);
  let redacted = 0;
  for (const row of rows) {
    if (isRedactedPayloadText(row.result, subjectId)) continue;
    sql('UPDATE _substrat_idempotency SET result = ? WHERE subject = ? AND key = ?', [
      tombstone,
      row.subject,
      row.key,
    ]);
    redacted += 1;
  }
  return redacted;
}

/**
 * Every intent in the journal that holds this subject's tombstone — the ids the directory
 * half links its drain-failure rows through. Read after the intent redaction, so it covers
 * this pass's tombstones and every earlier pass's.
 */
export function redactedIntentIds(sql: RedactionSql, subjectId: string): string[] {
  const q = platformRequestRedactionQuery(subjectId);
  const rows = sql(q.sql, q.params) as PlatformRequestRedactionCandidate[];
  return rows.filter((r) => isRedactedPayloadText(r.payload, subjectId)).map((r) => r.id);
}

/**
 * The scope's free-text half (#1632), shared by both adapters so the order is one fact: a
 * recorded idempotent response and a queued `sweep-runs` entry's error that name the subject,
 * and THEN the intents holding its tombstone — read after every other intent write, so the ids
 * cover this pass's tombstones and every earlier one's.
 */
export function redactSubjectScopeText(
  sql: RedactionSql,
  subjectId: string,
  at: string,
): Pick<SubjectRedactionCounts, 'idempotencyResults' | 'intentIds'> {
  const idempotencyResults = redactSubjectIdempotency(sql, subjectId, at);
  redactSubjectSweepRunIntents(sql, subjectId);
  return { idempotencyResults, intentIds: redactedIntentIds(sql, subjectId) };
}

/**
 * A `sweep-runs` intent's queued error text (#1632).
 *
 * A CP-less pass reports its schedule outcomes as one `sweep-runs` intent; the drain lands
 * each entry in the directory's `_substrat_sweep_runs`, and the intent itself is kept like
 * every other. So an entry's `error` — a scheduled operation's throw — is held twice, and the
 * directory half alone would leave this copy. Only `entries[].error` is rewritten, and only
 * where it names the subject's id: the payload keeps its shape and every other field, so a
 * pending intent still drains (the note is a valid `error`) and lands the note instead of the
 * text. Idempotent: the note does not name the subject.
 */
export function redactSubjectSweepRunIntents(sql: RedactionSql, subjectId: string): void {
  const rows = sql(
    'SELECT id, payload FROM _substrat_platform_requests WHERE kind = ? AND instr(payload, ?) > 0',
    [SWEEP_RUNS_KIND, subjectNeedle(subjectId)],
  ) as { id: string; payload: string }[];
  for (const row of rows) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.payload);
    } catch {
      continue;
    }
    if (typeof parsed !== 'object' || parsed === null) continue;
    const entries = (parsed as { entries?: unknown }).entries;
    if (!Array.isArray(entries)) continue;
    let changed = false;
    const rewritten = entries.map((entry: unknown) => {
      if (typeof entry !== 'object' || entry === null) return entry;
      const error = (entry as { error?: unknown }).error;
      if (typeof error !== 'string' || !error.includes(subjectId)) return entry;
      changed = true;
      return { ...entry, error: REDACTED_FAILURE_NOTE };
    });
    if (!changed) continue;
    sql('UPDATE _substrat_platform_requests SET payload = ? WHERE id = ?', [
      JSON.stringify({ ...parsed, entries: rewritten }),
      row.id,
    ]);
  }
}

const PLATFORM_INTENT_FAILURE_PREFIX = 'platform intent ';

/**
 * How the drain words an ops failure about one intent. The reader below parses the same
 * prefix, so the directory walk and the writer cannot drift about the link between them.
 */
export function platformIntentFailureMessage(intentId: string, text: string): string {
  return `${PLATFORM_INTENT_FAILURE_PREFIX}${intentId} ${text}`;
}

/** The intent an ops-failure message is about, or null — `platformIntentFailureMessage` read back. */
export function intentIdOfFailureMessage(message: string): string | null {
  if (!message.startsWith(PLATFORM_INTENT_FAILURE_PREFIX)) return null;
  const rest = message.slice(PLATFORM_INTENT_FAILURE_PREFIX.length);
  const end = rest.indexOf(' ');
  return end > 0 ? rest.slice(0, end) : null;
}

/** What the directory half is handed: the erased scope's tenant, and the scope half's intent ids. */
export interface SubjectTextTarget {
  tenantId: string;
  scopeId: string;
  subjectId: string;
  intentIds: string[];
}

/**
 * Whose failure an issue exemplar was copied from, as the issue upsert records it beside
 * `last_tenant_id`: a tenant's, or the platform's own (a failure with no tenant). NULL is never
 * written. It is reserved for an issue from before the columns that no retained row attributes,
 * so "the platform's" and "nobody knows" stay different facts.
 *
 * A kind column rather than a sentinel in `last_tenant_id`, so that column stays what its name
 * says — a tenant id or nothing — for any reader or join, and a later owner kind is a new value
 * here instead of a second magic string.
 */
export type IssueExemplarOwner = 'tenant' | 'platform';

/** The owner kind both adapters' issue upserts write, from the failure's tenant. */
export function issueExemplarOwner(tenantId: string | null): IssueExemplarOwner {
  return tenantId === null ? 'platform' : 'tenant';
}

/**
 * #1632: the one-time backfill of an issue's exemplar owner, run as the columns are added to
 * a directory that predates them. A row is attributed only when the retained ops-failure rows
 * carrying its exemplar (same fingerprint, same text) all have one origin: a single tenant, or
 * only the platform. When they name none, or more than one origin, the row stays unknown
 * (NULL), and erasure skips it. Rows whose evidence already expired stay unknown too, so the
 * gap fails closed.
 */
export const ISSUE_EXEMPLAR_OWNER_BACKFILL_SQL = `UPDATE _substrat_issues
     SET last_tenant_id = (SELECT MIN(o.tenant_id) FROM _substrat_ops_failures o
                            WHERE o.fingerprint = _substrat_issues.fingerprint
                              AND o.message = _substrat_issues.last_message),
         last_owner_kind = CASE WHEN (SELECT MIN(o.tenant_id) FROM _substrat_ops_failures o
                                       WHERE o.fingerprint = _substrat_issues.fingerprint
                                         AND o.message = _substrat_issues.last_message) IS NULL
                                THEN 'platform' ELSE 'tenant' END
   WHERE last_owner_kind IS NULL
     AND (SELECT COUNT(DISTINCT COALESCE(o.tenant_id, '')) FROM _substrat_ops_failures o
           WHERE o.fingerprint = _substrat_issues.fingerprint
             AND o.message = _substrat_issues.last_message) = 1`;

/**
 * The directory's half (#1632): three tables of failure text the control plane keeps.
 *
 * - `_substrat_ops_failures.message` — the drain's record of an intent it gave up on, or
 *   settled `failed`, quotes that intent's `last_error`. When the intent is one the erasure
 *   tombstoned (`intentIds`, in this tenant and scope), the message is a copy of text the
 *   scope half already redacted, and goes with it. A row in this tenant, or the platform's
 *   own row with no tenant, that names the subject's id goes too.
 * - `_substrat_issues.last_message` — the newest exemplar of an ops-failure group. Its
 *   writer records whose failure it copied (`last_owner_kind`, `last_tenant_id`, in the same
 *   statement), and erasure reads that rather than the ops-failure rows, which issues outlive.
 *   A tenant's exemplar is rewritten only for that tenant, by the same two links; the
 *   platform's own on a direct id match, as its ops-failure row is. An exemplar of unknown
 *   owner (a legacy row nothing attributed) is skipped: the matched text can come from
 *   anyone's request, so an unattributed row is never read as this tenant's.
 * - `_substrat_sweep_runs.error` — a scheduled operation's throw, matched on the subject's
 *   id in this tenant's rows or the platform's own. There is no link to an event here.
 *
 * Rows for another tenant are never touched. Free text that names the person but not their
 * id, on a row with no intent link, is not reached. Idempotent: the note names neither an
 * intent nor the subject.
 */
export function redactSubjectDirectoryText(sql: RedactionSql, target: SubjectTextTarget): void {
  const needle = subjectNeedle(target.subjectId);
  sql(
    `UPDATE _substrat_ops_failures SET message = ?
      WHERE instr(message, ?) > 0 AND (tenant_id IS NULL OR tenant_id = ?)`,
    [REDACTED_FAILURE_NOTE, needle, target.tenantId],
  );
  sql(
    `UPDATE _substrat_issues SET last_message = ?
      WHERE instr(last_message, ?) > 0
        AND ((last_owner_kind = 'tenant' AND last_tenant_id = ?) OR last_owner_kind = 'platform')`,
    [REDACTED_FAILURE_NOTE, needle, target.tenantId],
  );
  sql(
    `UPDATE _substrat_sweep_runs SET error = ?
      WHERE instr(error, ?) > 0 AND (tenant_id IS NULL OR tenant_id = ?)`,
    [REDACTED_FAILURE_NOTE, needle, target.tenantId],
  );
  if (target.intentIds.length === 0) return;
  const intents = new Set(target.intentIds);
  // Rows whose text the drain wrote about one of those intents — read back by the grammar it
  // wrote them in, so the SQL only narrows to the prefix and the id decides.
  const redactLinked = (table: string, key: string, text: string, where: string, params: string[]) => {
    const rows = sql(
      `SELECT ${key} AS key, ${text} AS text FROM ${table} WHERE ${where}instr(${text}, ?) = 1`,
      [...params, PLATFORM_INTENT_FAILURE_PREFIX],
    ) as { key: string; text: string }[];
    for (const row of rows) {
      const id = intentIdOfFailureMessage(row.text);
      if (id !== null && intents.has(id)) {
        sql(`UPDATE ${table} SET ${text} = ? WHERE ${key} = ?`, [REDACTED_FAILURE_NOTE, row.key]);
      }
    }
  };
  redactLinked('_substrat_ops_failures', 'id', 'message', 'tenant_id = ? AND scope_id = ? AND ', [
    target.tenantId,
    target.scopeId,
  ]);
  redactLinked('_substrat_issues', 'fingerprint', 'last_message', "last_owner_kind = 'tenant' AND last_tenant_id = ? AND ", [
    target.tenantId,
  ]);
}
