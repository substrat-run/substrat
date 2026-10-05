/**
 * Attachment content search (#1575): the text an attachment's bytes carry, extracted off
 * the upload by a job and indexed in the scope, keyed by attachment id.
 *
 * `ctx.search` answers over an entity's declared columns. An attachment had nothing but
 * its filename there, because nothing ever read its bytes. This is the reading, and the
 * place the result lands. It is kernel-owned for the reasons the entity index is (see
 * `search-index.ts`): no module may write `_substrat_attachments`'s neighbourhood, a
 * kernel-maintained index cannot be desynchronised by a writer that forgets it, and the
 * permission gate is already the kernel's.
 *
 * ## The flow
 *
 * 1. **Upload** writes the attachment row, a `pending` text row and a job run
 *    (`ATTACHMENT_TEXT_MODULE` / `ATTACHMENT_TEXT_JOB`, instance = the attachment id), all
 *    in the upload's own transaction. Nothing is extracted on the upload path, so an
 *    extraction failure cannot fail an upload: the bytes and the record have landed
 *    whatever happens next.
 * 2. **The job driver** (`runDueJobs`, which the scope sweeper calls when a deployment
 *    opts into `runJobs`) runs `attachmentTextJob`: read the record, read the bytes, run
 *    the host's extractor for its type (K-43), write the outcome. Each adapter supplies
 *    the handler itself for this key, so no deployment has to register it.
 * 3. **Search** is `ScopeAttachments.search`, authorized before it matches (below).
 *
 * ## Reading the bytes needs no grant, and that is deliberate
 *
 * Extraction is a derivation the kernel owns, like the entity index's triggers reading a
 * module's rows. Reading through `getSystemAttachments` instead would need
 * `system:<module>` to hold every target's read key, and a CP-less vertical has no way to
 * seat that grant short of declaring a schedule it does not have. The gate that decides
 * what a PERSON learns is at search time, and it is the same check `list` and `open` make.
 *
 * ## The search gate, and what it refuses to leak
 *
 * A search AUTHORIZES FIRST, from the scope and the caller alone, and only then matches
 * (`searchAttachments`). The owners the caller may read — the check `open` makes, the
 * target's `readPermission` on the owning entity — are decided before the term is looked
 * at, and handed to the query, so `ORDER BY … LIMIT` runs over readable rows only. A match
 * the caller cannot open neither appears nor takes a slot, however many there are: the
 * page a caller gets is the page they would get if those attachments did not exist. And
 * because nothing is examined and then dropped, there is no scan bound whose cutoff — or
 * whose running time — depends on hidden rows. Three more choices follow from the same
 * rule, each because the alternative would leak.
 *
 * - **No count and no "more" marker.** Either would count matches the caller cannot see.
 * - **No score, and newest-first order instead of relevance.** FTS5's `bm25` weighs a term
 *   by how many documents in the WHOLE index contain it, including the ones the caller
 *   cannot open. Exposing the score, or ordering a multi-term result by it, would let a
 *   caller infer how often a term occurs in attachments they may not read. Ordering by
 *   attachment id (a ULID, so upload time) depends only on rows the caller can see.
 * - **No snippet.** A snippet is text from the attachment, and producing one for a denied
 *   row would be the leak itself.
 *
 * The bound that remains is on authorization, not on matches: a caller without scope-level
 * read on a target type has its owners checked one by one, at most
 * `ATTACHMENT_SEARCH_OWNER_MAX` of them, and past that the search is refused with a stable
 * reason (`ATTACHMENT_SEARCH_TOO_MANY_OWNERS`). Whether it refuses depends on the scope's
 * owner count and the caller's rights — the same answer for every term. What still scales
 * with every match is the FTS index's own read of its posting lists, which is the same work
 * whoever asks.
 *
 * ## Where the text lives, and where it does not go
 *
 * Both tables carry the `_substrat_search_` prefix, which is what keeps them out of every
 * scope dump (`isSearchIndexTable`). That is the point, not a convenience: a dump carries
 * an attachment's METADATA row and never its bytes, so the text extracted from those bytes
 * stays where the bytes are. A restore or a preview carry that brings an attachment row
 * back re-queues its extraction (`reconcileAttachmentText`), which re-reads the bytes if
 * they are still there — the same scope — and records a legible failure where they are
 * not, as in a fork into a new scope. The lake streams the outbox only, so the text never
 * reaches it either.
 *
 * Erasure: `shredSubject` does not reach attachments — they carry no subject and their
 * bytes are not sealed per subject — so there is no shred path for the text to outlive.
 * What does make bytes unreadable is deleting the attachment row (`remove`, or any other
 * delete), and a trigger on `_substrat_attachments` removes the text row with it, which
 * takes its index entries out through the index's own triggers.
 */
import {
  attachmentRecord,
  substratError,
  utf8Length,
  type AttachmentRecord,
  type Decision,
  type EntityRef,
  type ModuleId,
  type PermissionKey,
} from '@substrat-run/contracts';
import type { JobHandler } from './job-run.js';
import { attachmentSha256, type ScopedSql } from './scope-host.js';
import { searchLimit, searchMatchExpression } from './search-index.js';
import {
  DEFAULT_ATTACHMENT_TEXT_BOUNDS,
  assertAttachmentTextBounds,
  chooseAttachmentExtractor,
  inputBoundRefusal,
  mediaTypeOf,
  runAttachmentExtractor,
  type AttachmentExtractor,
  type AttachmentTextBounds,
  type ExtractionOutcome,
} from './attachment-extractor.js';

/** The job's module: the kernel itself, which owns the index. Parses as a `ModuleId`. */
export const ATTACHMENT_TEXT_MODULE = '@substrat-run/kernel' as ModuleId;

/** The job's name. With the module, the key every adapter supplies a handler for. */
export const ATTACHMENT_TEXT_JOB = 'attachment-text';

/** Is this run one of the kernel's extraction runs? */
export function isAttachmentTextRun(run: { module_id: string; job: string }): boolean {
  return run.module_id === ATTACHMENT_TEXT_MODULE && run.job === ATTACHMENT_TEXT_JOB;
}

/** The backfill's job name: queues extraction for attachments that predate it. */
export const ATTACHMENT_TEXT_BACKFILL_JOB = 'attachment-text-backfill';

/** The kernel's own jobs, each bound by the adapter to the scope it is driving. */
export interface KernelJobHandlers {
  readonly [ATTACHMENT_TEXT_JOB]: JobHandler;
  readonly [ATTACHMENT_TEXT_BACKFILL_JOB]: JobHandler;
}

/**
 * The kernel's handler for a run, or undefined for a run that is not the kernel's — which the
 * adapter's own registry answers. The one place a kernel job is dispatched, so a new one is
 * a kernel change and an entry in each adapter's handler map, never a branch in its drive.
 */
export function kernelJobFor(
  run: { module_id: string; job: string },
  handlers: KernelJobHandlers,
): { handler: JobHandler } | undefined {
  if (run.module_id !== ATTACHMENT_TEXT_MODULE || !Object.hasOwn(handlers, run.job)) return undefined;
  return { handler: handlers[run.job as keyof KernelJobHandlers] };
}

/** Attachments one backfill pass looks at — the bound on what a pass writes, too. */
export const ATTACHMENT_TEXT_BACKFILL_BATCH = 200;

/**
 * Refuse a job registered under the kernel's own module id — every adapter's `registerJob`
 * calls this first.
 *
 * The kernel's jobs are each host's own: it supplies their handlers at dispatch, bound to
 * the scope it is driving, and dispatch looks there before the registry. A handler
 * registered under the kernel's id would therefore never run, and say nothing — the one
 * outcome a registration must not have. The whole id is reserved, not only today's job
 * name, so a later kernel job cannot be shadowed by a registration that predates it.
 */
export function assertJobRegistrable(moduleId: string, name: string): void {
  if (moduleId === ATTACHMENT_TEXT_MODULE) {
    throw new Error(
      `job '${moduleId}/${name}' is reserved: '${ATTACHMENT_TEXT_MODULE}' jobs are the host's own, ` +
        'so a handler registered under that module id would never run',
    );
  }
}

/**
 * The text rows and their index, as both adapters build them.
 *
 * Shared for the reason `JOB_RUN_DDL` is: `lint:spine-ddl` compares what each adapter's
 * `KERNEL_DDL` executes, and one definition keeps the two the same shape.
 *
 * **The double underscore is a reservation.** A module's derived index is named
 * `_substrat_search_<slug(module)>_<slug(entity)>`, and `slug` can never produce a leading
 * underscore, so no module's index can ever collide with these two names.
 *
 * **External content.** The index stores terms and points at the text row's `rid`; the
 * text is stored once, in the row. The three triggers keep the index in step with the
 * row however it is written, and the fourth removes the row when its attachment goes.
 * Interpolated into each adapter's `KERNEL_DDL` after `_substrat_attachments`, which the
 * fourth trigger names.
 *
 * **Only a body reaches the index.** Most rows never carry one — every upload starts
 * `pending`, and an image or a PDF stays bodiless — so the index triggers are guarded on
 * it: a NULL body would index no term and still cost the index's own bookkeeping writes,
 * inside the upload's transaction. An update that leaves the body as it was (a replayed
 * extraction) re-tokenizes nothing.
 */
export const ATTACHMENT_TEXT_DDL = `
  CREATE TABLE IF NOT EXISTS _substrat_search__attachment_text (
    -- The rowid alias the index points at. Never exposed: the attachment id is the key.
    rid INTEGER PRIMARY KEY,
    attachment_id TEXT NOT NULL UNIQUE,
    -- 'pending' | 'indexed' | 'empty' | 'unsupported' | 'failed'. Only 'indexed' has a body.
    status TEXT NOT NULL,
    -- Which extractor ran ('text', 'html', 'docx', 'xlsx', 'pptx'). NULL while pending,
    -- and for a type no extractor reads.
    extractor TEXT,
    -- The extracted text, normalized and capped. NULL unless indexed.
    body TEXT,
    -- UTF-8 bytes of body. NULL unless indexed.
    body_bytes INTEGER,
    -- 1 when body was cut at the per-attachment bound.
    truncated INTEGER NOT NULL DEFAULT 0,
    -- Why there is no body: the unsupported type, the damaged file, the bound exceeded.
    -- Never quotes the file.
    detail TEXT,
    updated_at TEXT NOT NULL
  );
  CREATE VIRTUAL TABLE IF NOT EXISTS _substrat_search__attachments USING fts5(
    body, content='_substrat_search__attachment_text', content_rowid='rid', tokenize='unicode61'
  );
  CREATE TRIGGER IF NOT EXISTS _substrat_search__attachment_text_ai
    AFTER INSERT ON _substrat_search__attachment_text WHEN new.body IS NOT NULL BEGIN
    INSERT INTO _substrat_search__attachments(rowid, body) VALUES (new.rid, new.body);
  END;
  CREATE TRIGGER IF NOT EXISTS _substrat_search__attachment_text_ad
    AFTER DELETE ON _substrat_search__attachment_text WHEN old.body IS NOT NULL BEGIN
    INSERT INTO _substrat_search__attachments(_substrat_search__attachments, rowid, body)
      VALUES ('delete', old.rid, old.body);
  END;
  CREATE TRIGGER IF NOT EXISTS _substrat_search__attachment_text_au
    AFTER UPDATE ON _substrat_search__attachment_text WHEN old.body IS NOT new.body BEGIN
    INSERT INTO _substrat_search__attachments(_substrat_search__attachments, rowid, body)
      SELECT 'delete', old.rid, old.body WHERE old.body IS NOT NULL;
    INSERT INTO _substrat_search__attachments(rowid, body)
      SELECT new.rid, new.body WHERE new.body IS NOT NULL;
  END;
  CREATE TRIGGER IF NOT EXISTS _substrat_attachments_text_ad
    AFTER DELETE ON _substrat_attachments BEGIN
    DELETE FROM _substrat_search__attachment_text WHERE attachment_id = old.id;
  END;
`;

/** Where an attachment's text is. */
export type AttachmentTextStatus = 'pending' | 'indexed' | 'empty' | 'unsupported' | 'failed';

/** An attachment's extraction state, as `readAttachmentText` reports it. */
export interface AttachmentTextState {
  attachmentId: string;
  status: AttachmentTextStatus;
  extractor: string | null;
  /** UTF-8 bytes indexed; null unless `indexed`. */
  bytes: number | null;
  truncated: boolean;
  /** Why there is no text — or, for a `failed` derived from the run, the run's last error. */
  detail: string | null;
  updatedAt: string;
}

/*
 * The writes below take the kernel's own UNGUARDED spine handle (`spineSql` on the pure
 * adapter, `doSpineSql` on the DO). Both drivers are synchronous, so each write runs inside
 * whatever transaction the caller already holds — the upload's, or a restore's.
 */

const RUN_PAYLOAD_KEY = 'attachmentId';

/**
 * Start one of the kernel's runs unless a LIVE one exists for its key — the driver's own
 * coalescing rule (`startJobRun`), as one statement, so a re-queue joins a run in flight
 * rather than racing it.
 */
function startKernelRun(
  sql: ScopedSql,
  job: string,
  instance: string,
  payload: Record<string, string>,
  runId: string,
  at: string,
): void {
  sql.exec(
    `INSERT INTO _substrat_job_runs
       (id, module_id, job, instance, payload, subject_id, status, cursor, counters, attempts,
        last_error, started_at, updated_at, next_attempt_at, ended_at)
     SELECT ?, ?, ?, ?, ?, NULL, 'running', NULL, '{}', 0, NULL, ?, ?, NULL, NULL
      WHERE NOT EXISTS (
        SELECT 1 FROM _substrat_job_runs
         WHERE module_id = ? AND job = ? AND instance = ? AND status = 'running'
      )`,
    [runId, ATTACHMENT_TEXT_MODULE, job, instance, JSON.stringify(payload), at, at, ATTACHMENT_TEXT_MODULE, job, instance],
  );
}

/** Start one attachment's extraction run, coalesced with a live one. */
function startAttachmentTextRun(sql: ScopedSql, attachmentId: string, runId: string, at: string): void {
  startKernelRun(sql, ATTACHMENT_TEXT_JOB, attachmentId, { [RUN_PAYLOAD_KEY]: attachmentId }, runId, at);
}

/**
 * Queue one attachment's extraction: a `pending` row and a coalesced run, inside the
 * caller's transaction. An existing text row is left as it is: re-extracting an indexed
 * attachment keeps its current text searchable until the new outcome replaces it.
 */
export function enqueueAttachmentText(sql: ScopedSql, attachmentId: string, runId: string, at: string): void {
  sql.exec(
    `INSERT INTO _substrat_search__attachment_text (attachment_id, status, updated_at)
       VALUES (?, 'pending', ?)
       ON CONFLICT (attachment_id) DO NOTHING`,
    [attachmentId, at],
  );
  startAttachmentTextRun(sql, attachmentId, runId, at);
}

/**
 * Write one extraction outcome — only while the attachment still exists.
 *
 * A run reads the bytes outside any lock, so the attachment can be removed while it
 * extracts. The remove's trigger has already taken the text row away; an unguarded upsert
 * would put the text of a deleted attachment straight back. So the existence check and
 * the write are one statement, and the return says which happened.
 *
 * Idempotent: the same outcome written twice leaves one row and one set of index entries,
 * because an upsert on a present row is an UPDATE, whose trigger replaces the old terms
 * with the new ones (and touches nothing when the body did not change).
 */
export function recordAttachmentText(
  sql: ScopedSql,
  attachmentId: string,
  outcome: ExtractionOutcome,
  at: string,
): boolean {
  const indexed = outcome.status === 'indexed' ? outcome : null;
  const { changes } = sql.exec(
    `INSERT INTO _substrat_search__attachment_text
       (attachment_id, status, extractor, body, body_bytes, truncated, detail, updated_at)
     SELECT ?, ?, ?, ?, ?, ?, ?, ?
      WHERE EXISTS (SELECT 1 FROM _substrat_attachments WHERE id = ?)
     ON CONFLICT (attachment_id) DO UPDATE SET
       status = excluded.status, extractor = excluded.extractor, body = excluded.body,
       body_bytes = excluded.body_bytes, truncated = excluded.truncated,
       detail = excluded.detail, updated_at = excluded.updated_at`,
    [
      attachmentId,
      outcome.status,
      'extractor' in outcome ? outcome.extractor : null,
      indexed?.text ?? null,
      indexed ? utf8Length(indexed.text) : null,
      indexed?.truncated ? 1 : 0,
      'detail' in outcome ? outcome.detail : null,
      at,
      attachmentId,
    ],
  );
  return changes > 0;
}

/**
 * After a restore or a fork: drop text whose attachment the load did not bring back, and
 * queue extraction for every attachment that has no text row.
 *
 * The text tables are not in a dump, so a load leaves them as they were: an in-place
 * restore keeps the text of attachments that exist on both sides (an attachment id names
 * one write-once object, so that text is still the text of those bytes), and holds rows
 * for attachments the restore rewound away, which must go. A fork starts with none.
 * Every attachment row without text is queued; its run re-reads the bytes, and where they
 * are not reachable — a fork, whose objects stay under the source scope's key — the
 * outcome is a `failed` row that says so.
 */
export function reconcileAttachmentText(
  sql: ScopedSql,
  mintId: () => string,
  at: string,
): { removed: number; queued: number } {
  const removed = sql.query(
    `DELETE FROM _substrat_search__attachment_text
      WHERE attachment_id NOT IN (SELECT id FROM _substrat_attachments)
     RETURNING attachment_id`,
  ).length;
  const queued = sql.query<{ attachment_id: string }>(
    `INSERT INTO _substrat_search__attachment_text (attachment_id, status, updated_at)
     SELECT id, 'pending', ? FROM _substrat_attachments
      WHERE id NOT IN (SELECT attachment_id FROM _substrat_search__attachment_text)
     RETURNING attachment_id`,
    [at],
  );
  // One run each: a run id is a ULID, which SQL cannot mint.
  for (const { attachment_id } of queued) startAttachmentTextRun(sql, attachment_id, mintId(), at);
  return { removed, queued: queued.length };
}

/**
 * Start the scope's backfill (#1575) — once in its life, and only once it holds attachments.
 *
 * An attachment uploaded before extraction existed has no text row, so nothing ever queued
 * it and nothing would: it stayed unsearchable, and `readAttachmentText` answered null for
 * it forever. The backfill finds those. It is a kernel job like extraction, so the work rides
 * the job driver, off every request: this function only writes the run, and the driver's
 * passes walk the attachments `ATTACHMENT_TEXT_BACKFILL_BATCH` at a time.
 *
 * **The run row is the marker.** Runs are retained, so a scope whose backfill ever started
 * never starts another — done, failed or still running. Every upload since extraction
 * existed writes its own text row, and a restore or a fork reconciles its own
 * (`reconcileAttachmentText`), so one walk is all a scope ever needs. A scope with no
 * attachments yet is not marked: an empty scope has nothing to walk, and the first upload
 * after it is marked costs one walk over rows that all have text.
 *
 * Read before it writes, so the drive that calls it on every pass writes nothing once the
 * scope is marked: two index probes. Returns whether it started the run.
 */
export function startAttachmentTextBackfill(sql: ScopedSql, runId: string, at: string): boolean {
  const [row] = sql.query<{ has: number; marked: number }>(
    `SELECT EXISTS (SELECT 1 FROM _substrat_attachments) AS has,
            EXISTS (SELECT 1 FROM _substrat_job_runs WHERE module_id = ? AND job = ?) AS marked`,
    [ATTACHMENT_TEXT_MODULE, ATTACHMENT_TEXT_BACKFILL_JOB],
  );
  if (!row || Number(row.has) !== 1 || Number(row.marked) === 1) return false;
  startKernelRun(sql, ATTACHMENT_TEXT_BACKFILL_JOB, 'scope', {}, runId, at);
  return true;
}

/** What one backfill batch did. `last` is the cursor the next batch resumes after. */
export interface AttachmentTextBackfillBatch {
  readonly scanned: number;
  readonly queued: number;
  readonly last: string | null;
  /** True when the batch reached the end of the attachments. */
  readonly done: boolean;
}

/**
 * One backfill batch, inside the caller's transaction: the next `batch` attachments after
 * `after`, by id, and an extraction queued for each that has no text row. Bounded by what it
 * LOOKS AT, not by what it queues, so a pass over attachments that all have text costs the
 * same as one that queues every row. Idempotent: a batch replayed after a crash finds the
 * rows it queued and queues nothing twice.
 */
export function queueAttachmentTextBackfill(
  sql: ScopedSql,
  after: string | null,
  mintId: () => string,
  at: string,
  batch: number = ATTACHMENT_TEXT_BACKFILL_BATCH,
): AttachmentTextBackfillBatch {
  const rows = sql.query<{ id: string; missing: number }>(
    `SELECT a.id, t.attachment_id IS NULL AS missing
       FROM _substrat_attachments a
       LEFT JOIN _substrat_search__attachment_text t ON t.attachment_id = a.id
      WHERE a.id > ?
      ORDER BY a.id
      LIMIT ?`,
    [after ?? '', batch],
  );
  let queued = 0;
  for (const { id, missing } of rows) {
    if (Number(missing) !== 1) continue;
    enqueueAttachmentText(sql, id, mintId(), at);
    queued += 1;
  }
  return { scanned: rows.length, queued, last: rows.at(-1)?.id ?? after, done: rows.length < batch };
}

/**
 * The backfill job: one batch per pass, the cursor the last attachment id it looked at. The
 * batch commits on its own and the cursor with the pass, so a pass that dies between the two
 * replays a batch that queues nothing twice (`queueAttachmentTextBackfill`).
 */
export function attachmentTextBackfillJob(source: {
  queueBatch(after: string | null): Promise<AttachmentTextBackfillBatch>;
}): JobHandler {
  return async (pass) => {
    const after = typeof pass.cursor === 'string' ? pass.cursor : null;
    const { scanned, queued, last, done } = await source.queueBatch(after);
    pass.count('scanned', scanned);
    pass.count('queued', queued);
    return { cursor: last, done };
  };
}

/**
 * An attachment's extraction state, or null when none was ever recorded — an attachment
 * uploaded before extraction existed, or one a fork carried without its text.
 *
 * Reads the spine through `ctx.sql`, which module code may (it may never write it). Like
 * `readTimeline`, it checks no permission: the caller does, first, as it would before
 * `open`.
 *
 * A `pending` row whose latest run has FAILED is reported as `failed`, with the run's
 * error. That run will not be retried, so "pending" would be a promise nobody keeps; the
 * row itself is left alone so a re-queue picks it up.
 */
export function readAttachmentText(
  ctx: { readonly sql: Pick<ScopedSql, 'query'> },
  attachmentId: string,
): AttachmentTextState | null {
  const rows = ctx.sql.query<{
    attachment_id: string;
    status: AttachmentTextStatus;
    extractor: string | null;
    body_bytes: number | null;
    truncated: number;
    detail: string | null;
    updated_at: string;
    run_status: string | null;
    run_error: string | null;
  }>(
    `SELECT t.attachment_id, t.status, t.extractor, t.body_bytes, t.truncated, t.detail, t.updated_at,
            r.status AS run_status, r.last_error AS run_error
       FROM _substrat_search__attachment_text t
       LEFT JOIN _substrat_job_runs r ON r.id = (
         SELECT id FROM _substrat_job_runs
          WHERE module_id = ? AND job = ? AND instance = t.attachment_id
          ORDER BY id DESC LIMIT 1
       )
      WHERE t.attachment_id = ?`,
    [ATTACHMENT_TEXT_MODULE, ATTACHMENT_TEXT_JOB, attachmentId],
  );
  const row = rows[0];
  if (!row) return null;
  const stalled = row.status === 'pending' && row.run_status === 'failed';
  return {
    attachmentId: row.attachment_id,
    status: stalled ? 'failed' : row.status,
    extractor: row.extractor,
    bytes: row.body_bytes === null ? null : Number(row.body_bytes),
    truncated: Number(row.truncated) === 1,
    detail: stalled ? `extraction run failed: ${row.run_error ?? 'unknown error'}` : row.detail,
    updatedAt: row.updated_at,
  };
}

// -- search -----------------------------------------------------------------------------

/**
 * The most owners a search will check one by one, for a caller without scope-level read
 * on their type. Past it the search is REFUSED (`ATTACHMENT_SEARCH_TOO_MANY_OWNERS`), never
 * truncated: a truncated owner set would drop readable hits silently, by an order the
 * caller cannot see.
 */
export const ATTACHMENT_SEARCH_OWNER_MAX = 2_000;

/** The `forbidden` reason a refused search carries — stable, so a UI can explain it. */
export const ATTACHMENT_SEARCH_TOO_MANY_OWNERS = 'attachment_search_too_many_owners';

/** The gate a search runs through: the declared targets, and `ctx.check` as the caller. */
export interface AttachmentSearchGate {
  /** The read key `open` checks, per declared target entity type. */
  readonly targets: ReadonlyMap<string, { readonly read: PermissionKey }>;
  /** `ctx.check`, as the surface's principal — with no entity, at the scope. */
  check(permission: PermissionKey, entity?: EntityRef): Promise<Decision>;
}

/** The term-independent half of a search: what the caller may read among owners with text. */
interface ReadableOwners {
  /** Entity types the caller reads at the scope level: every owner of them is readable. */
  readonly wideTypes: string[];
  /** The other owners the caller may read, as `[entityType, entityId]`. */
  readonly owners: [string, string][];
}

/** A check that cannot answer is a check that refuses: an evaluator failure is never a disclosure. */
const allows = async (decision: () => Promise<Decision>): Promise<boolean> => {
  try {
    return (await decision()).allowed;
  } catch {
    return false;
  }
};

/**
 * Authorize FIRST, from the scope and the caller alone — never from the term or its matches.
 *
 * 1. Each declared target type is checked once at the SCOPE: an allow there is an allow on
 *    every entity of the type (the evaluator grants at the node before it walks an entity,
 *    and the walk only adds), so the type is "wide" and costs nothing more. A caller with
 *    a role or a scope grant — staff, editors — stops here: one check per declared type.
 * 2. For every other type, the owners that HAVE indexed text are enumerated and checked one
 *    by one. Only a narrowed caller pays this (entity grants, a capability), and it is
 *    bounded by `ATTACHMENT_SEARCH_OWNER_MAX`.
 *
 * Neither step reads a match, so what this costs and whether it refuses depend on the
 * scope's owners and the caller's rights only: nothing about what the term would find.
 */
async function readableOwners(sql: Pick<ScopedSql, 'query'>, gate: AttachmentSearchGate): Promise<ReadableOwners> {
  const wideTypes: string[] = [];
  const narrowTypes: string[] = [];
  for (const [entityType, target] of gate.targets) {
    (await allows(() => gate.check(target.read)) ? wideTypes : narrowTypes).push(entityType);
  }
  if (narrowTypes.length === 0) return { wideTypes, owners: [] };
  const candidates = sql.query<{ entity_type: string; entity_id: string }>(ATTACHMENT_SEARCH_OWNERS_SQL, [
    JSON.stringify(narrowTypes),
    ATTACHMENT_SEARCH_OWNER_MAX + 1,
  ]);
  if (candidates.length > ATTACHMENT_SEARCH_OWNER_MAX) {
    throw substratError(
      'forbidden',
      `attachment search: this scope has more than ${ATTACHMENT_SEARCH_OWNER_MAX} owners with indexed ` +
        'files of a type the caller holds no scope-level read on, too many to authorize one by one',
      { reason: ATTACHMENT_SEARCH_TOO_MANY_OWNERS },
    );
  }
  const owners: [string, string][] = [];
  for (const { entity_type: entityType, entity_id: entityId } of candidates) {
    const read = gate.targets.get(entityType)!.read;
    if (await allows(() => gate.check(read, { entityType, entityId }))) owners.push([entityType, entityId]);
  }
  return { wideTypes, owners };
}

/**
 * The owners a narrowed caller is checked over: those of the given types that HAVE text,
 * one more than the cap so a refusal can tell "at the cap" from "past it". Walks the
 * `(entity_type, entity_id)` index on `_substrat_attachments`. Params: types (JSON array),
 * limit.
 */
export const ATTACHMENT_SEARCH_OWNERS_SQL = `SELECT DISTINCT a.entity_type, a.entity_id
   FROM _substrat_attachments a
   JOIN _substrat_search__attachment_text t ON t.attachment_id = a.id
  WHERE t.body IS NOT NULL AND a.entity_type IN (SELECT value FROM json_each(?))
  ORDER BY a.entity_type, a.entity_id
  LIMIT ?`;

/**
 * The match, restricted to readable owners BEFORE the order and the limit. A wide type is
 * one `IN` over the JSON array of types; a narrowed owner is a row-value `IN` over JSON
 * pairs, which SQLite answers from an ephemeral index on the subquery rather than per
 * pair — one bound JSON array, never a `?` per owner, since a Durable Object refuses the
 * 101st parameter. Params: match, wide types (JSON array), owners (JSON array of
 * `[entityType, entityId]`), limit.
 */
export const ATTACHMENT_SEARCH_SQL = `SELECT a.id, a.entity_type, a.entity_id, a.filename, a.content_type, a.size,
        a.sha256, a.visibility, a.created_by, a.created_at
   FROM _substrat_search__attachments
   JOIN _substrat_search__attachment_text t ON t.rid = _substrat_search__attachments.rowid
   JOIN _substrat_attachments a ON a.id = t.attachment_id
  WHERE _substrat_search__attachments MATCH ?
    AND (a.entity_type IN (SELECT value FROM json_each(?))
         OR (a.entity_type, a.entity_id) IN
            (SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]') FROM json_each(?)))
  ORDER BY a.id DESC
  LIMIT ?`;

/**
 * Search extracted text: attachments the caller may open, newest first, at most `limit`.
 *
 * The readable owners are decided first (`readableOwners`) and handed to the query, so the
 * `ORDER BY … LIMIT` runs over readable rows only: a match the caller cannot open neither
 * appears nor takes a slot, however many there are or how new. Nothing is examined and then
 * dropped, so there is no scan bound whose cutoff could depend on hidden rows.
 *
 * The term is judged before anything else, so a too-short term refuses at no cost. The FTS
 * table is not aliased: its own name is the hidden column `MATCH` reads (`searchQuery`).
 */
export async function searchAttachments(
  sql: Pick<ScopedSql, 'query'>,
  gate: AttachmentSearchGate,
  term: string,
  limit: number,
): Promise<AttachmentRecord[]> {
  const match = searchMatchExpression(term, 'prefix');
  const { wideTypes, owners } = await readableOwners(sql, gate);
  if (wideTypes.length === 0 && owners.length === 0) return [];
  return sql
    .query<AttachmentRowShape>(ATTACHMENT_SEARCH_SQL, [
      match,
      JSON.stringify(wideTypes),
      JSON.stringify(owners),
      searchLimit(limit),
    ])
    .map(attachmentRecordOfRow);
}

/** One `_substrat_attachments` row, as SELECTed. */
export interface AttachmentRowShape {
  readonly id: string;
  readonly entity_type: string;
  readonly entity_id: string;
  readonly filename: string;
  readonly content_type: string;
  readonly size: number;
  readonly sha256: string;
  readonly visibility: string;
  readonly created_by: string;
  readonly created_at: string;
}

/** The metadata fact an attachment row records — parsed, so a malformed row throws here. */
export function attachmentRecordOfRow(row: AttachmentRowShape): AttachmentRecord {
  return attachmentRecord.parse({
    id: row.id,
    entity: { entityType: row.entity_type, entityId: row.entity_id },
    filename: row.filename,
    contentType: row.content_type,
    size: Number(row.size),
    sha256: row.sha256,
    visibility: row.visibility,
    createdBy: row.created_by,
    createdAt: row.created_at,
  });
}

// -- the job -------------------------------------------------------------------------

/**
 * What the extraction job needs from its adapter: no permission gate on any of it, because
 * extraction is the kernel's own derivation (this file's header says why).
 */
export interface AttachmentTextSource {
  /** The record, or null when the attachment no longer exists. */
  record(attachmentId: string): Promise<AttachmentRecord | null>;
  /**
   * The bytes, or null when the blob store does not hold them. A THROW is a transient
   * failure (the store is unreachable) and the run retries; null is a fact about this
   * attachment and is recorded as such.
   */
  bytes(record: AttachmentRecord): Promise<Uint8Array | null>;
  /** Write an outcome; false when the attachment was removed meanwhile. */
  write(attachmentId: string, outcome: ExtractionOutcome): Promise<boolean>;
}

function attachmentIdOf(payload: unknown): string {
  const id = (payload as Record<string, unknown> | null)?.[RUN_PAYLOAD_KEY];
  if (typeof id !== 'string' || id.length === 0) {
    throw new Error('attachment-text run payload carries no attachmentId');
  }
  return id;
}

/**
 * The extraction job: one pass per attachment, done when its outcome is written.
 *
 * Everything decidable without the bytes is decided first — no extractor for the type, a
 * recorded size over the input bound — so those files are never fetched. Bytes that are
 * gone, or that no longer match the recorded hash, are recorded `failed`: retrying cannot
 * bring them back. Only a throw from the store is retried, by the driver's backoff; what
 * the EXTRACTOR does, it answers for in its outcome (`runAttachmentExtractor`).
 *
 * The extractors are the host's, handed in (K-43): the kernel parses no format itself.
 *
 * No `step()`: the pass is one idempotent unit (read, extract, upsert), so a replay after
 * a crash simply does it again, and a step memo would only park the extracted text in
 * `_substrat_job_steps`, which a dump carries.
 */
export function attachmentTextJob(
  source: AttachmentTextSource,
  extractors: readonly AttachmentExtractor[],
  bounds: AttachmentTextBounds = DEFAULT_ATTACHMENT_TEXT_BOUNDS,
): JobHandler {
  assertAttachmentTextBounds(bounds);
  const outcomeFor = async (record: AttachmentRecord): Promise<ExtractionOutcome> => {
    const extractor = chooseAttachmentExtractor(extractors, record.contentType, record.filename);
    if (!extractor) {
      return {
        status: 'unsupported',
        detail: `no extractor for content type '${mediaTypeOf(record.contentType) || 'unknown'}'`,
      };
    }
    const failed = (detail: string): ExtractionOutcome => ({ status: 'failed', extractor: extractor.name, detail });
    // The kernel's ceiling first and on its own, then the extractor's own bound if it is a valid
    // one: an invalid declaration (a `NaN` past the host's check) can disable neither.
    const refusal = inputBoundRefusal(record.size, extractor, bounds);
    if (refusal !== null) return failed(refusal);
    const body = await source.bytes(record);
    if (body === null) return failed('the bytes are missing from the blob store');
    if ((await attachmentSha256(body)) !== record.sha256) return failed('the bytes do not match the recorded sha256');
    return runAttachmentExtractor(extractor, { body, contentType: record.contentType, filename: record.filename }, bounds);
  };
  return async (pass) => {
    const attachmentId = attachmentIdOf(pass.payload);
    const record = await source.record(attachmentId);
    if (!record) {
      pass.count('gone');
      return { done: true };
    }
    const outcome = await outcomeFor(record);
    const kept = await source.write(attachmentId, outcome);
    pass.count(kept ? outcome.status : 'gone');
    return { done: true };
  };
}
