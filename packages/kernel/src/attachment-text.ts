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
 *    `extractAttachmentText`, write the outcome. Each adapter supplies the handler itself
 *    for this key, so no deployment has to register it.
 * 3. **Search** is `ScopeAttachments.search`, gated hit by hit (below).
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
 * Every candidate is checked against its target's `readPermission` on its owning entity,
 * as the caller, BEFORE the limit is applied. So a match the caller cannot open neither
 * appears nor uses up a slot: the page a caller gets is the page they would get if that
 * attachment did not exist. Three choices follow from that, each because the alternative
 * would leak.
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
 * One residual, stated rather than hidden: a search examines at most
 * `ATTACHMENT_SEARCH_SCAN_MAX` matches, newest first. A caller who can read none of the
 * newest that-many matches gets fewer hits than exist further down, which tells them
 * that many newer matches exist that they cannot open. Bounded, and the price of a
 * search whose cost does not grow with what other people uploaded.
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
import type { AttachmentRecord, EntityRef, ModuleId } from '@substrat-run/contracts';
import type { JobHandler, JobRunKey } from './job-run.js';
import { attachmentSha256, type ScopedSql, type SqlValue } from './scope-host.js';
import {
  DEFAULT_EXTRACTION_BOUNDS,
  extractAttachmentText,
  extractorFor,
  type ExtractionBounds,
  type ExtractionOutcome,
} from './attachment-extract.js';

/** The job's module: the kernel itself, which owns the index. Parses as a `ModuleId`. */
export const ATTACHMENT_TEXT_MODULE = '@substrat-run/kernel' as ModuleId;

/** The job's name. With the module, the key every adapter supplies a handler for. */
export const ATTACHMENT_TEXT_JOB = 'attachment-text';

/** Is this run one of the kernel's extraction runs? */
export function isAttachmentTextRun(run: { module_id: string; job: string }): boolean {
  return run.module_id === ATTACHMENT_TEXT_MODULE && run.job === ATTACHMENT_TEXT_JOB;
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
    AFTER INSERT ON _substrat_search__attachment_text BEGIN
    INSERT INTO _substrat_search__attachments(rowid, body) VALUES (new.rid, new.body);
  END;
  CREATE TRIGGER IF NOT EXISTS _substrat_search__attachment_text_ad
    AFTER DELETE ON _substrat_search__attachment_text BEGIN
    INSERT INTO _substrat_search__attachments(_substrat_search__attachments, rowid, body)
      VALUES ('delete', old.rid, old.body);
  END;
  CREATE TRIGGER IF NOT EXISTS _substrat_search__attachment_text_au
    AFTER UPDATE ON _substrat_search__attachment_text BEGIN
    INSERT INTO _substrat_search__attachments(_substrat_search__attachments, rowid, body)
      VALUES ('delete', old.rid, old.body);
    INSERT INTO _substrat_search__attachments(rowid, body) VALUES (new.rid, new.body);
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

/**
 * A synchronous SQL handle, the same two-way shape `RedactionSql` has: a read returns its
 * rows, a write returns nothing. Both adapters' drivers are synchronous (better-sqlite3,
 * a Durable Object's `SqlStorage`), so the writes below run inside whatever transaction the
 * caller already holds — the upload's, or a restore's.
 */
export type AttachmentTextSql = (sql: string, params: readonly SqlValue[]) => Record<string, unknown>[];

const RUN_PAYLOAD_KEY = 'attachmentId';

/**
 * Queue one attachment's extraction: a `pending` row and a coalesced run, both written
 * through `sql` inside the caller's transaction.
 *
 * The run is inserted only when no LIVE run exists for the attachment — the driver's own
 * coalescing rule (`startJobRun`), as one statement, so a re-queue joins an extraction in
 * flight rather than racing it. An existing text row is left as it is: re-extracting an
 * indexed attachment keeps its current text searchable until the new outcome replaces it.
 */
export function enqueueAttachmentText(sql: AttachmentTextSql, attachmentId: string, runId: string, at: string): void {
  sql(
    `INSERT INTO _substrat_search__attachment_text (attachment_id, status, updated_at)
       VALUES (?, 'pending', ?)
       ON CONFLICT (attachment_id) DO NOTHING`,
    [attachmentId, at],
  );
  sql(
    `INSERT INTO _substrat_job_runs
       (id, module_id, job, instance, payload, subject_id, status, cursor, counters, attempts,
        last_error, started_at, updated_at, next_attempt_at, ended_at)
     SELECT ?, ?, ?, ?, ?, NULL, 'running', NULL, '{}', 0, NULL, ?, ?, NULL, NULL
      WHERE NOT EXISTS (
        SELECT 1 FROM _substrat_job_runs
         WHERE module_id = ? AND job = ? AND instance = ? AND status = 'running'
      )`,
    [
      runId,
      ATTACHMENT_TEXT_MODULE,
      ATTACHMENT_TEXT_JOB,
      attachmentId,
      JSON.stringify({ [RUN_PAYLOAD_KEY]: attachmentId }),
      at,
      at,
      ATTACHMENT_TEXT_MODULE,
      ATTACHMENT_TEXT_JOB,
      attachmentId,
    ],
  );
}

/** The coalescing key of one attachment's extraction run. */
export function attachmentTextRunKey(attachmentId: string): JobRunKey {
  return { moduleId: ATTACHMENT_TEXT_MODULE, job: ATTACHMENT_TEXT_JOB, instance: attachmentId };
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
 * because an upsert on a present row is an UPDATE, whose trigger deletes the old terms
 * before it inserts the new ones.
 */
export function recordAttachmentText(
  sql: AttachmentTextSql,
  attachmentId: string,
  outcome: ExtractionOutcome,
  at: string,
): boolean {
  const exists = sql('SELECT 1 AS present FROM _substrat_attachments WHERE id = ?', [attachmentId]).length > 0;
  if (!exists) return false;
  const indexed = outcome.status === 'indexed' ? outcome : null;
  sql(
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
  return true;
}

declare const TextEncoder: new () => { encode(input: string): Uint8Array };
const encoder = new TextEncoder();
const utf8Length = (s: string): number => encoder.encode(s).length;

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
  sql: AttachmentTextSql,
  mintId: () => string,
  at: string,
): { removed: number; queued: number } {
  const orphans = sql(
    `SELECT attachment_id FROM _substrat_search__attachment_text
      WHERE attachment_id NOT IN (SELECT id FROM _substrat_attachments)`,
    [],
  );
  for (const row of orphans) {
    sql('DELETE FROM _substrat_search__attachment_text WHERE attachment_id = ?', [row.attachment_id as string]);
  }
  const missing = sql(
    `SELECT id FROM _substrat_attachments
      WHERE id NOT IN (SELECT attachment_id FROM _substrat_search__attachment_text)
      ORDER BY id`,
    [],
  );
  for (const row of missing) enqueueAttachmentText(sql, row.id as string, mintId(), at);
  return { removed: orphans.length, queued: missing.length };
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
 * Candidate matches one search examines, at most. See the header's residual: past this
 * many, newest first, nothing is looked at.
 */
export const ATTACHMENT_SEARCH_SCAN_MAX = 1_000;

/** One candidate, before the gate: the attachment and the entity that owns it. */
export interface AttachmentSearchCandidate {
  readonly id: string;
  readonly entity_type: string;
  readonly entity_id: string;
}

/**
 * The candidate read: matching attachments, NEWEST FIRST, ids and owning entity only.
 *
 * Joined to `_substrat_attachments`, so a text row whose attachment is gone can never be
 * a candidate even before the trigger has removed it. The FTS table is not aliased: its
 * own name is the hidden column `MATCH` reads (`searchQuery` says why).
 */
export function attachmentSearchQuery(match: string): { sql: string; params: [string, number] } {
  return {
    sql:
      `SELECT a.id AS id, a.entity_type AS entity_type, a.entity_id AS entity_id
         FROM _substrat_search__attachments
         JOIN _substrat_search__attachment_text t ON t.rid = _substrat_search__attachments.rowid
         JOIN _substrat_attachments a ON a.id = t.attachment_id
        WHERE _substrat_search__attachments MATCH ?
        ORDER BY a.id DESC LIMIT ?`,
    params: [match, ATTACHMENT_SEARCH_SCAN_MAX],
  };
}

/**
 * The gate, applied before the limit: the ids, in candidate order, of the first `limit`
 * candidates `canRead` admits.
 *
 * One decision per owning ENTITY, cached for the call — ten attachments on one contract
 * cost one check. A check that throws reads as a refusal: an evaluator failure must
 * never become a disclosure. Refusals are not recorded as denials, for the reason a live
 * fan-out records none: nobody asked for these rows by name.
 */
export async function readableAttachmentIds(
  candidates: readonly AttachmentSearchCandidate[],
  canRead: (entity: EntityRef) => Promise<boolean>,
  limit: number,
): Promise<string[]> {
  const decided = new Map<string, boolean>();
  const out: string[] = [];
  for (const c of candidates) {
    if (out.length >= limit) break;
    const key = `${c.entity_type}\u0000${c.entity_id}`;
    let allowed = decided.get(key);
    if (allowed === undefined) {
      try {
        allowed = await canRead({ entityType: c.entity_type, entityId: c.entity_id });
      } catch {
        allowed = false;
      }
      decided.set(key, allowed);
    }
    if (allowed) out.push(c.id);
  }
  return out;
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
 * Everything decidable without the bytes is decided first — a type no extractor reads, a
 * recorded size over the bound — so those files are never fetched. Bytes that are gone, or
 * that no longer match the recorded hash, are recorded `failed`: retrying cannot bring
 * them back. Only a throw from the store is retried, by the driver's backoff.
 *
 * No `step()`: the pass is one idempotent unit (read, extract, upsert), so a replay after
 * a crash simply does it again, and a step memo would only park the extracted text in
 * `_substrat_job_steps`, which a dump carries.
 */
export function attachmentTextJob(
  source: AttachmentTextSource,
  bounds: ExtractionBounds = DEFAULT_EXTRACTION_BOUNDS,
): JobHandler {
  return async (pass) => {
    const attachmentId = attachmentIdOf(pass.payload);
    const record = await source.record(attachmentId);
    if (!record) {
      pass.count('gone');
      return { done: true };
    }
    let outcome: ExtractionOutcome;
    const chosen = extractorFor(record.contentType, record.filename);
    if ('unsupported' in chosen) {
      outcome = { status: 'unsupported', detail: chosen.unsupported };
    } else if (record.size > bounds.maxInputBytes) {
      outcome = {
        status: 'failed',
        extractor: chosen.extractor,
        detail: `the file is ${record.size} bytes, over the ${bounds.maxInputBytes}-byte extraction bound`,
      };
    } else {
      const body = await source.bytes(record);
      if (body === null) {
        outcome = { status: 'failed', extractor: chosen.extractor, detail: 'the bytes are missing from the blob store' };
      } else if ((await attachmentSha256(body)) !== record.sha256) {
        outcome = {
          status: 'failed',
          extractor: chosen.extractor,
          detail: 'the bytes do not match the recorded sha256',
        };
      } else {
        outcome = await extractAttachmentText(
          { contentType: record.contentType, filename: record.filename, body },
          bounds,
        );
      }
    }
    const kept = await source.write(attachmentId, outcome);
    pass.count(kept ? outcome.status : 'gone');
    return { done: true };
  };
}
