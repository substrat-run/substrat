import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { errorCodeOf, type AttachmentRecord, type Decision, type PermissionKey } from '@substrat-run/contracts';
import {
  ATTACHMENT_SEARCH_OWNER_MAX,
  ATTACHMENT_SEARCH_TOO_MANY_OWNERS,
  ATTACHMENT_TEXT_BACKFILL_JOB,
  ATTACHMENT_TEXT_DDL,
  ATTACHMENT_TEXT_JOB,
  ATTACHMENT_TEXT_MODULE,
  assertJobRegistrable,
  attachmentTextBackfillJob,
  attachmentTextJob,
  enqueueAttachmentText,
  queueAttachmentTextBackfill,
  startAttachmentTextBackfill,
  readAttachmentText,
  reconcileAttachmentText,
  recordAttachmentText,
  searchAttachments,
  type AttachmentSearchGate,
  type AttachmentTextSource,
} from '../src/attachment-text.js';
import {
  DEFAULT_ATTACHMENT_TEXT_BOUNDS,
  assertAttachmentExtractors,
  assertAttachmentTextBounds,
  chooseAttachmentExtractor,
  inputBoundRefusal,
  resolveAttachmentTextBounds,
  runAttachmentExtractor,
  truncateUtf8,
  type AttachmentExtractor,
  type AttachmentExtractorResult,
  type AttachmentTextBounds,
  type ExtractionOutcome,
  type ExtractionSignal,
  type ExtractionTimers,
} from '../src/attachment-extractor.js';
import { JOB_RUN_DDL, type JobPassContext } from '../src/job-run.js';
import { attachmentSha256, type ScopedSql, type SqlValue } from '../src/scope-host.js';
import { SearchTermTooShort, searchMatchExpression } from '../src/search-index.js';

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

/**
 * A stand-in for the host-side text extractor (K-43): the kernel parses no format, so its own
 * tests hand it one, as a host does. The real ones are `@substrat-run/attachment-extractors`.
 */
const plainText: AttachmentExtractor = {
  name: 'text',
  accepts: (contentType) => contentType.startsWith('text/'),
  extract: async ({ body }) => ({ text: new TextDecoder().decode(body) }),
};
// -- the SQL, against a real SQLite ----------------------------------------------------

const ATTACHMENTS_DDL = `CREATE TABLE _substrat_attachments (
  id TEXT PRIMARY KEY, entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, filename TEXT NOT NULL,
  content_type TEXT NOT NULL, size INTEGER NOT NULL, sha256 TEXT NOT NULL, visibility TEXT NOT NULL,
  created_by TEXT NOT NULL, created_at TEXT NOT NULL)`;

function scope() {
  const db = new DatabaseSync(':memory:');
  db.exec(ATTACHMENTS_DDL);
  db.exec(JOB_RUN_DDL);
  db.exec(ATTACHMENT_TEXT_DDL);
  // The kernel's spine handle shape, over node SQLite — what `spineSql` is over better-sqlite3.
  const sql: ScopedSql = {
    query: <T>(q: string, params: readonly SqlValue[] = []) => db.prepare(q).all(...(params as never[])) as T[],
    exec: (q: string, params: readonly SqlValue[] = []) => ({
      changes: Number(db.prepare(q).run(...(params as never[])).changes),
    }),
  };
  const attach = (id: string, entityId = 'e1') =>
    db
      .prepare(`INSERT INTO _substrat_attachments VALUES (?, 'item', ?, 'f.txt', 'text/plain', 1, ?, 'internal', 'p', ?)`)
      .run(id, entityId, '0'.repeat(64), '2026-10-01T00:00:00.000Z');
  const one = (q: string, ...params: (string | number)[]) =>
    db.prepare(q).get(...params) as Record<string, unknown> | undefined;
  const count = (q: string, ...params: (string | number)[]) => Number(one(q, ...params)!.n);
  const matches = (word: string) =>
    count(
      'SELECT count(*) AS n FROM _substrat_search__attachments WHERE _substrat_search__attachments MATCH ?',
      searchMatchExpression(word, 'prefix'),
    );
  const ctx = { sql };
  return { db, sql, attach, one, count, matches, ctx };
}

const indexed = (text: string): ExtractionOutcome => ({ status: 'indexed', extractor: 'text', text, truncated: false });

describe('the text rows and their index', () => {
  it('queues a pending row and ONE live run; a second queue joins it and leaves the row alone', () => {
    const s = scope();
    s.attach('A1');
    enqueueAttachmentText(s.sql, 'A1', 'R1', '2026-10-01T00:00:00.000Z');
    recordAttachmentText(s.sql, 'A1', indexed('kept text'), '2026-10-01T00:00:01.000Z');
    enqueueAttachmentText(s.sql, 'A1', 'R2', '2026-10-01T00:00:02.000Z');
    expect(s.count("SELECT count(*) AS n FROM _substrat_job_runs WHERE instance = 'A1'")).toBe(1);
    expect(s.one("SELECT id, module_id, job, payload, status FROM _substrat_job_runs")).toEqual({
      id: 'R1',
      module_id: ATTACHMENT_TEXT_MODULE,
      job: ATTACHMENT_TEXT_JOB,
      payload: '{"attachmentId":"A1"}',
      status: 'running',
    });
    // The twin: once that run has finished, a re-queue starts a new one.
    s.db.prepare("UPDATE _substrat_job_runs SET status = 'done'").run();
    enqueueAttachmentText(s.sql, 'A1', 'R3', '2026-10-01T00:00:03.000Z');
    expect(s.count("SELECT count(*) AS n FROM _substrat_job_runs WHERE status = 'running'")).toBe(1);
    expect(s.one('SELECT status, body FROM _substrat_search__attachment_text')).toEqual({ status: 'indexed', body: 'kept text' });
  });

  it('writing the same outcome twice leaves one row and one match', () => {
    const s = scope();
    s.attach('A1');
    enqueueAttachmentText(s.sql, 'A1', 'R1', 't');
    expect(recordAttachmentText(s.sql, 'A1', indexed('the platypus clause'), 't1')).toBe(true);
    expect(recordAttachmentText(s.sql, 'A1', indexed('the platypus clause'), 't2')).toBe(true);
    expect(s.count('SELECT count(*) AS n FROM _substrat_search__attachment_text')).toBe(1);
    expect(s.matches('platypus')).toBe(1);
    // A changed outcome replaces the old terms rather than adding to them.
    recordAttachmentText(s.sql, 'A1', indexed('the wombat clause'), 't3');
    expect([s.matches('platypus'), s.matches('wombat')]).toEqual([0, 1]);
    expect(s.one('SELECT body_bytes, truncated, updated_at FROM _substrat_search__attachment_text')).toEqual({
      body_bytes: 17,
      truncated: 0,
      updated_at: 't3',
    });
  });

  it('a write for an attachment removed meanwhile is refused and writes nothing — the twin lands', () => {
    const s = scope();
    s.attach('A1');
    enqueueAttachmentText(s.sql, 'A1', 'R1', 't');
    s.db.prepare("DELETE FROM _substrat_attachments WHERE id = 'A1'").run();
    expect(recordAttachmentText(s.sql, 'A1', indexed('the tapir memo'), 't1')).toBe(false);
    expect(s.count('SELECT count(*) AS n FROM _substrat_search__attachment_text')).toBe(0);
    expect(s.matches('tapir')).toBe(0);
    s.attach('A2');
    expect(recordAttachmentText(s.sql, 'A2', indexed('the tapir memo'), 't1')).toBe(true);
    expect(s.matches('tapir')).toBe(1);
  });

  it('deleting the attachment row removes its text row and its index entries, by trigger', () => {
    const s = scope();
    s.attach('A1');
    s.attach('A2');
    recordAttachmentText(s.sql, 'A1', indexed('axolotl one'), 't');
    recordAttachmentText(s.sql, 'A2', indexed('axolotl two'), 't');
    s.db.prepare("DELETE FROM _substrat_attachments WHERE id = 'A1'").run();
    expect(s.count("SELECT count(*) AS n FROM _substrat_search__attachment_text WHERE attachment_id = 'A1'")).toBe(0);
    expect(s.matches('axolotl')).toBe(1);
    expect(s.matches('one')).toBe(0);
  });

  it('reconcile drops orphaned text and queues every attachment without any', () => {
    const s = scope();
    s.attach('A1');
    s.attach('A2');
    recordAttachmentText(s.sql, 'A1', indexed('okapi kept'), 't');
    // A row whose attachment a restore rewound away: written straight past the guard.
    s.db.prepare(`INSERT INTO _substrat_search__attachment_text (attachment_id, status, body, updated_at)
                  VALUES ('GONE', 'indexed', 'okapi orphan', 't')`).run();
    let n = 0;
    expect(reconcileAttachmentText(s.sql, () => `R${(n += 1)}`, 't')).toEqual({ removed: 1, queued: 1 });
    expect(s.matches('orphan')).toBe(0);
    expect(s.matches('kept')).toBe(1);
    expect(s.one("SELECT status FROM _substrat_search__attachment_text WHERE attachment_id = 'A2'")).toEqual({ status: 'pending' });
    expect(s.count("SELECT count(*) AS n FROM _substrat_job_runs WHERE instance = 'A2'")).toBe(1);
    // Idempotent: nothing left to do.
    expect(reconcileAttachmentText(s.sql, () => 'R-again', 't')).toEqual({ removed: 0, queued: 0 });
  });

  it('readAttachmentText: null when nothing was recorded, a stalled pending as failed, the rest as written', () => {
    const s = scope();
    expect(readAttachmentText(s.ctx, 'NOPE')).toBeNull();
    s.attach('A1');
    enqueueAttachmentText(s.sql, 'A1', 'R1', 't0');
    expect(readAttachmentText(s.ctx, 'A1')).toMatchObject({ status: 'pending', detail: null });
    s.db.prepare("UPDATE _substrat_job_runs SET status = 'failed', last_error = 'blob store unreachable'").run();
    expect(readAttachmentText(s.ctx, 'A1')).toMatchObject({
      status: 'failed',
      detail: 'extraction run failed: blob store unreachable',
    });
    recordAttachmentText(s.sql, 'A1', { status: 'indexed', extractor: 'docx', text: 'é', truncated: true }, 't1');
    expect(readAttachmentText(s.ctx, 'A1')).toEqual({
      attachmentId: 'A1',
      status: 'indexed',
      extractor: 'docx',
      bytes: 2,
      truncated: true,
      detail: null,
      updatedAt: 't1',
    });
    recordAttachmentText(s.sql, 'A1', { status: 'unsupported', detail: 'no extractor' }, 't2');
    expect(readAttachmentText(s.ctx, 'A1')).toMatchObject({ status: 'unsupported', extractor: null, bytes: null, detail: 'no extractor' });
  });

});

describe('the backfill: attachments that predate extraction, queued once, in bounded batches', () => {
  const runs = (s: ReturnType<typeof scope>, job: string) =>
    s.count('SELECT count(*) AS n FROM _substrat_job_runs WHERE module_id = ? AND job = ?', ATTACHMENT_TEXT_MODULE, job);

  it('marks a scope once it holds attachments, and never again — whatever its run became', () => {
    const s = scope();
    // An empty scope has nothing to walk, and is not marked: the next drive asks again.
    expect(startAttachmentTextBackfill(s.sql, 'B0', 't')).toBe(false);
    expect(runs(s, ATTACHMENT_TEXT_BACKFILL_JOB)).toBe(0);
    s.attach('A1');
    expect(startAttachmentTextBackfill(s.sql, 'B1', 't')).toBe(true);
    expect(s.one('SELECT id, instance, payload, status FROM _substrat_job_runs')).toEqual({
      id: 'B1',
      instance: 'scope',
      payload: '{}',
      status: 'running',
    });
    // The run row is the marker: running, done or failed, a second start writes nothing.
    for (const status of ['running', 'done', 'failed']) {
      s.db.prepare('UPDATE _substrat_job_runs SET status = ?').run(status);
      expect(startAttachmentTextBackfill(s.sql, `B-${status}`, 't'), status).toBe(false);
    }
    expect(runs(s, ATTACHMENT_TEXT_BACKFILL_JOB)).toBe(1);
  });

  it('queues only the attachments with no text row, a batch at a time, by id, and replays to nothing', () => {
    const s = scope();
    const ids = Array.from({ length: 450 }, (_, i) => `A${String(i).padStart(4, '0')}`);
    for (const id of ids) s.attach(id);
    // Every tenth one already has text — an upload since extraction existed.
    for (const id of ids.filter((_, i) => i % 10 === 0)) recordAttachmentText(s.sql, id, indexed('kept'), 't');
    let n = 0;
    const mint = () => `R${(n += 1)}`;
    const batches = [];
    let after: string | null = null;
    for (;;) {
      const batch = queueAttachmentTextBackfill(s.sql, after, mint, 't', 200);
      batches.push(batch);
      after = batch.last;
      if (batch.done) break;
    }
    expect(batches.map((b) => [b.scanned, b.queued, b.done])).toEqual([
      [200, 180, false],
      [200, 180, false],
      [50, 45, true],
    ]);
    expect(batches.map((b) => b.last)).toEqual([ids[199], ids[399], ids[449]]);
    // Each queued attachment: a pending row and one run. The ones with text are untouched.
    expect(s.count("SELECT count(*) AS n FROM _substrat_search__attachment_text WHERE status = 'pending'")).toBe(405);
    expect(s.count("SELECT count(*) AS n FROM _substrat_search__attachment_text WHERE status = 'indexed'")).toBe(45);
    expect(runs(s, ATTACHMENT_TEXT_JOB)).toBe(405);
    // A batch replayed after a crash (its cursor never committed) queues nothing twice.
    expect(queueAttachmentTextBackfill(s.sql, null, mint, 't', 200)).toMatchObject({ scanned: 200, queued: 0 });
    expect(runs(s, ATTACHMENT_TEXT_JOB)).toBe(405);
  });

  it('the job: one batch per pass, the cursor handed forward, done at the end', async () => {
    const seen: (string | null)[] = [];
    const handler = attachmentTextBackfillJob({
      queueBatch: async (after) => {
        seen.push(after);
        return after === null
          ? { scanned: 200, queued: 7, last: 'A199', done: false }
          : { scanned: 3, queued: 0, last: 'A202', done: true };
      },
    });
    const counters: Record<string, number> = {};
    const pass = (cursor: unknown) =>
      ({ cursor, count: (k: string, by = 1) => (counters[k] = (counters[k] ?? 0) + by) }) as unknown as JobPassContext;
    expect(await handler(pass(null))).toEqual({ cursor: 'A199', done: false });
    expect(await handler(pass('A199'))).toEqual({ cursor: 'A202', done: true });
    expect(seen).toEqual([null, 'A199']);
    expect(counters).toEqual({ scanned: 203, queued: 7 });
  });
});

describe('searchAttachments: authorize first, then match over readable owners', () => {
  /**
   * A gate over one target type, `item`, whose answers the test decides: `wide` at the scope,
   * `readable` per owning entity ('throw' for an evaluator failure). `asked` records each
   * check in order — `<scope>` or the entity id — which is what shows the work done.
   */
  const gate = (opts: { wide?: boolean | 'throw'; readable?: (entityId: string) => boolean | 'throw' }) => {
    const asked: string[] = [];
    const answer = (a: boolean | 'throw' | undefined): Decision => {
      if (a === 'throw') throw new Error('evaluator down');
      return (a ? { allowed: true, proof: [] } : { allowed: false }) as unknown as Decision;
    };
    const g: AttachmentSearchGate = {
      targets: new Map([['item', { read: 'p:read' as PermissionKey }]]),
      check: async (_permission, entity) => {
        asked.push(entity ? entity.entityId : '<scope>');
        return answer(entity ? opts.readable?.(entity.entityId) : opts.wide);
      },
    };
    return { g, asked };
  };
  const indexAll = (s: ReturnType<typeof scope>, rows: [id: string, entityId: string, text: string][]) => {
    for (const [id, entityId, text] of rows) {
      s.attach(id, entityId);
      recordAttachmentText(s.sql, id, indexed(text), 't');
    }
  };
  const ids = (records: { id: string }[]) => records.map((r) => r.id);

  it('a caller who reads the type at the scope is wide: one check, every match newest first', async () => {
    const s = scope();
    indexAll(s, [['A1', 'e1', 'quokka one'], ['A3', 'e3', 'quokka three'], ['A2', 'e2', 'quokka two']]);
    // A text row with no attachment row is never a hit, wide or not.
    s.db.prepare(`INSERT INTO _substrat_search__attachment_text (attachment_id, status, body, updated_at)
                  VALUES ('A9', 'indexed', 'quokka orphan', 't')`).run();
    const { g, asked } = gate({ wide: true });
    expect(ids(await searchAttachments(s.sql, g, 'quokka', 20))).toEqual(['A3', 'A2', 'A1']);
    expect(ids(await searchAttachments(s.sql, g, 'quokka', 2))).toEqual(['A3', 'A2']);
    expect(asked).toEqual(['<scope>', '<scope>']);
    // Records, parsed: what `open` would hand back.
    expect((await searchAttachments(s.sql, g, 'three', 20))[0]).toMatchObject({
      id: 'A3',
      entity: { entityType: 'item', entityId: 'e3' },
      createdAt: '2026-10-01T00:00:00.000Z',
    });
  });

  it('a narrowed caller: the limit runs over readable rows, however many newer denied matches there are', async () => {
    const s = scope();
    const rows: [string, string, string][] = [['A0000', 'e-ok', 'quokka readable']];
    for (let i = 1; i <= 1200; i += 1) rows.push([`A${String(i).padStart(4, '0')}`, 'e-no', 'quokka hidden']);
    indexAll(s, rows);
    const { g, asked } = gate({ wide: false, readable: (e) => e === 'e-ok' });
    expect(ids(await searchAttachments(s.sql, g, 'quokka', 1))).toEqual(['A0000']);
    // The work is one check per OWNER, in owner order — not per match, and not in match order.
    expect(asked).toEqual(['<scope>', 'e-no', 'e-ok']);
    // The control: the same caller in a scope without the hidden matches gets the same page.
    const control = scope();
    indexAll(control, [['A0000', 'e-ok', 'quokka readable']]);
    expect(ids(await searchAttachments(control.sql, gate({ readable: (e) => e === 'e-ok' }).g, 'quokka', 1))).toEqual([
      'A0000',
    ]);
  });

  it('refuses past the owner cap — the same answer for every term — and never for a wide caller', async () => {
    const s = scope();
    const rows: [string, string, string][] = [];
    for (let i = 0; i <= ATTACHMENT_SEARCH_OWNER_MAX; i += 1) {
      rows.push([`A${String(i).padStart(5, '0')}`, `e${i}`, i === 0 ? 'quokka the only match' : 'filler words']);
    }
    indexAll(s, rows);
    const refusalOf = async (term: string) => {
      const err = await searchAttachments(s.sql, gate({ readable: () => true }).g, term, 20).then(
        () => undefined,
        (e: unknown) => e,
      );
      return { code: errorCodeOf(err), reason: (err as { extensions?: { reason?: string } }).extensions?.reason };
    };
    const refused = { code: 'forbidden', reason: ATTACHMENT_SEARCH_TOO_MANY_OWNERS };
    expect(await refusalOf('quokka')).toEqual(refused); // a term with a match
    expect(await refusalOf('nothingmatchesthis')).toEqual(refused); // and one without
    expect(ids(await searchAttachments(s.sql, gate({ wide: true }).g, 'quokka', 20))).toEqual(['A00000']);
  });

  it('counts only owners WITH text toward the cap — the twin of the refusal, at the cap', async () => {
    const s = scope();
    const rows: [string, string, string][] = [];
    for (let i = 0; i < ATTACHMENT_SEARCH_OWNER_MAX; i += 1) rows.push([`A${String(i).padStart(5, '0')}`, `e${i}`, 'quokka']);
    indexAll(s, rows);
    // Past the cap in attachment rows, but these owners have no text: not counted.
    for (let i = 0; i < 10; i += 1) s.attach(`B${i}`, `no-text-${i}`);
    const { g } = gate({ readable: (e) => e === 'e7' });
    expect(ids(await searchAttachments(s.sql, g, 'quokka', 20))).toEqual(['A00007']);
  });

  it('reads a check that throws as a refusal — at the scope not wide, at an owner not readable', async () => {
    const s = scope();
    indexAll(s, [['A1', 'boom', 'quokka a'], ['A2', 'fine', 'quokka b']]);
    const { g } = gate({ wide: 'throw', readable: (e) => (e === 'boom' ? 'throw' : true) });
    expect(ids(await searchAttachments(s.sql, g, 'quokka', 20))).toEqual(['A2']);
  });

  it('judges the term before any check, and answers nothing readable with no match at all', async () => {
    const s = scope();
    indexAll(s, [['A1', 'e1', 'quokka']]);
    const short = gate({ wide: true });
    await expect(searchAttachments(s.sql, short.g, 'q', 20)).rejects.toBeInstanceOf(SearchTermTooShort);
    expect(short.asked).toEqual([]);
    expect(await searchAttachments(s.sql, gate({ readable: () => false }).g, 'quokka', 20)).toEqual([]);
  });
});

describe('assertJobRegistrable', () => {
  it("refuses any job under the kernel's own module id, and nothing else", () => {
    expect(() => assertJobRegistrable(ATTACHMENT_TEXT_MODULE, ATTACHMENT_TEXT_JOB)).toThrow(/reserved/);
    expect(() => assertJobRegistrable(ATTACHMENT_TEXT_MODULE, 'some-later-kernel-job')).toThrow(/reserved/);
    expect(() => assertJobRegistrable('@acme/vertical', ATTACHMENT_TEXT_JOB)).not.toThrow();
  });
});

// -- the job -------------------------------------------------------------------------

describe('attachmentTextJob', () => {
  const recordOf = async (over: Partial<AttachmentRecord>, body = enc('the kinkajou note')): Promise<AttachmentRecord> => ({
    id: 'A1',
    entity: { entityType: 'item', entityId: 'e1' },
    filename: 'n.txt',
    contentType: 'text/plain',
    size: body.length,
    sha256: await attachmentSha256(body),
    visibility: 'internal',
    createdBy: 'p',
    createdAt: '2026-10-01T00:00:00.000Z' as AttachmentRecord['createdAt'],
    ...over,
  });
  const run = async (
    source: Partial<AttachmentTextSource>,
    payload: unknown = { attachmentId: 'A1' },
    bounds?: AttachmentTextBounds,
    extractors: readonly AttachmentExtractor[] = [plainText],
  ) => {
    const written: ExtractionOutcome[] = [];
    let fetched = 0;
    const counters: Record<string, number> = {};
    const pass = {
      run: { id: 'R1', moduleId: ATTACHMENT_TEXT_MODULE, job: ATTACHMENT_TEXT_JOB, instance: 'A1' },
      payload,
      cursor: null,
      counters,
      count: (name: string, by = 1) => {
        counters[name] = (counters[name] ?? 0) + by;
      },
      step: () => {
        throw new Error('the extraction job takes no steps');
      },
      scope: () => {
        throw new Error('the extraction job opens no scope');
      },
    } as unknown as JobPassContext;
    const handler = attachmentTextJob(
      {
        record: source.record ?? (async () => recordOf({})),
        bytes: async (r) => {
          fetched += 1;
          return (source.bytes ?? (async () => enc('the kinkajou note')))(r);
        },
        write: async (id, outcome) => {
          written.push(outcome);
          return source.write ? source.write(id, outcome) : true;
        },
      },
      extractors,
      bounds,
    );
    const result = await handler(pass);
    return { result, written, fetched, counters };
  };

  it('extracts, writes, and finishes in one pass', async () => {
    const r = await run({});
    expect(r.result).toEqual({ done: true });
    expect(r.written).toEqual([{ status: 'indexed', extractor: 'text', text: 'the kinkajou note', truncated: false }]);
    expect(r.counters).toEqual({ indexed: 1 });
  });

  it('never fetches the bytes of a type no extractor reads — and says so', async () => {
    const pdf = await run({ record: async () => recordOf({ contentType: 'application/pdf' }) });
    expect([pdf.fetched, pdf.written]).toEqual([
      0,
      [{ status: 'unsupported', detail: "no extractor for content type 'application/pdf'" }],
    ]);
    // A host wired with NO extractors records every type that way: valid, and legible.
    const bare = await run({}, undefined, undefined, []);
    expect([bare.fetched, bare.written]).toEqual([0, [{ status: 'unsupported', detail: "no extractor for content type 'text/plain'" }]]);
  });

  it('judges the input bound on the RECORDED size, before a byte is fetched — the smaller of the two bounds', async () => {
    const big = await run({ record: async () => recordOf({ size: 10_000 }) }, undefined, { ...DEFAULT_ATTACHMENT_TEXT_BOUNDS, maxInputBytes: 100 });
    expect([big.fetched, big.written[0]]).toEqual([
      0,
      { status: 'failed', extractor: 'text', detail: 'the file is 10000 bytes, over the 100-byte input bound' },
    ]);
    // The extractor's own, lower, declaration narrows it further.
    const strict = { ...plainText, maxInputBytes: 5 };
    const declared = await run({}, undefined, undefined, [strict]);
    expect([declared.fetched, declared.written[0]]).toEqual([
      0,
      { status: 'failed', extractor: 'text', detail: "the file is 17 bytes, over the extractor's 5-byte input bound" },
    ]);
  });

  it("keeps the kernel's ceiling when an extractor's declaration is NaN — the bypass is closed", async () => {
    // Built WITHOUT the host's check, as a list that slipped past it would be.
    const nan = { ...plainText, maxInputBytes: Number.NaN };
    const r = await run({}, undefined, { ...DEFAULT_ATTACHMENT_TEXT_BOUNDS, maxInputBytes: 5 }, [nan]);
    expect([r.fetched, r.written[0]]).toEqual([
      0,
      { status: 'failed', extractor: 'text', detail: 'the file is 17 bytes, over the 5-byte input bound' },
    ]);
  });

  it('refuses to build a job over bounds that are not positive integers', () => {
    expect(() =>
      attachmentTextJob({ record: async () => null, bytes: async () => null, write: async () => true }, [], {
        ...DEFAULT_ATTACHMENT_TEXT_BOUNDS,
        maxInputBytes: Number.NaN,
      }),
    ).toThrow(/positive integer/);
  });

  it('records bytes that are gone, or not the recorded ones, as failed — retrying cannot fix either', async () => {
    expect((await run({ bytes: async () => null })).written[0]).toMatchObject({ status: 'failed', detail: /missing/ });
    expect((await run({ bytes: async () => enc('different bytes!!') })).written[0]).toMatchObject({
      status: 'failed',
      detail: /sha256/,
    });
  });

  it('lets a store that throws fail the pass, so the driver retries it', async () => {
    await expect(run({ bytes: async () => Promise.reject(new Error('R2 unavailable')) })).rejects.toThrow('R2 unavailable');
  });

  it('a removed attachment finishes the run as gone — before reading, or at the write', async () => {
    const before = await run({ record: async () => null });
    expect([before.written, before.counters, before.fetched]).toEqual([[], { gone: 1 }, 0]);
    const during = await run({ write: async () => false });
    expect(during.counters).toEqual({ gone: 1 });
  });

  it('refuses a payload that names no attachment', async () => {
    await expect(run({}, { other: 1 })).rejects.toThrow(/attachmentId/);
  });
});

// -- the extractor seam: what the kernel enforces after an extractor returns ----------------

describe('runAttachmentExtractor: an extractor answers for nothing the scope depends on', () => {
  const input = { body: enc('irrelevant'), contentType: 'text/plain', filename: 'f.txt' };
  const answering = (extract: AttachmentExtractor['extract']): AttachmentExtractor => ({
    name: 'rogue',
    accepts: () => true,
    extract,
  });
  const bounds = { ...DEFAULT_ATTACHMENT_TEXT_BOUNDS, maxTextBytes: 100, timeoutMs: 50 };

  it('cuts oversized output at the cap and records it truncated — the extractor told only as a hint', async () => {
    let hint = 0;
    const out = await runAttachmentExtractor(
      answering(async ({ maxTextBytes }) => {
        hint = maxTextBytes;
        return { text: 'é'.repeat(10_000) };
      }),
      input,
      bounds,
    );
    expect(hint).toBe(100);
    expect(out).toMatchObject({ status: 'indexed', extractor: 'rogue', truncated: true });
    expect(enc((out as { text: string }).text).length).toBe(100);
  });

  it('normalizes what comes back, and records whitespace-only text as empty', async () => {
    expect(await runAttachmentExtractor(answering(async () => ({ text: 'a\u0000\r\n\r\n\r\n\r\nb\t\t c' })), input, bounds)).toEqual({
      status: 'indexed',
      extractor: 'rogue',
      text: 'a\n\nb c',
      truncated: false,
    });
    expect(await runAttachmentExtractor(answering(async () => ({ text: ' \n\t ' })), input, bounds)).toEqual({
      status: 'empty',
      extractor: 'rogue',
    });
  });

  it('records a throw as failed — never its message, which is the parser\'s text and may quote the file', async () => {
    const thrown = await runAttachmentExtractor(
      answering(async () => {
        throw new RangeError('could not parse near SECRET CONTRACT TEXT');
      }),
      input,
      bounds,
    );
    expect(thrown).toEqual({ status: 'failed', extractor: 'rogue', detail: "extractor 'rogue' threw (RangeError)" });
    // A synchronous throw, and a thrown non-Error, are the same outcome.
    const sync = answering((() => {
      throw 'a bare string';
    }) as unknown as AttachmentExtractor['extract']);
    expect(await runAttachmentExtractor(sync, input, bounds)).toEqual({
      status: 'failed',
      extractor: 'rogue',
      detail: "extractor 'rogue' threw (a value)",
    });
  });

  const timedOut = { status: 'failed', extractor: 'rogue', detail: "extractor 'rogue' did not answer within 50 ms" };

  it('records an extractor that does not answer within the budget as failed, and aborts its signal', async () => {
    let seen: ExtractionSignal | undefined;
    const hung = await runAttachmentExtractor(
      answering(({ signal }) => {
        seen = signal;
        return new Promise(() => {});
      }),
      input,
      bounds,
    );
    expect(hung).toEqual(timedOut);
    expect(seen?.aborted).toBe(true);
  });

  /**
   * Timers on a clock only the test moves (#2085). A synchronous extractor "runs for" `ms` by
   * calling `elapse(ms)`: the clock moves and nothing fires, as on a thread that never yields.
   * A timer fires once the clock has reached it, earliest due first, one per real turn of the
   * loop — so what the budget decides is a function of the clock, never of how loaded the
   * machine is. Nothing fires that the clock has not reached, so a timer nobody elapses past
   * simply never runs.
   */
  const virtualTimers = () => {
    let now = 0;
    let seq = 0;
    const pending = new Map<number, { at: number; fn: () => void }>();
    const pump = () =>
      setImmediate(() => {
        const due = [...pending].filter(([, t]) => t.at <= now).sort(([a, x], [b, y]) => x.at - y.at || a - b)[0];
        if (!due) return;
        pending.delete(due[0]);
        due[1].fn();
        pump();
      });
    const timers: ExtractionTimers = {
      setTimeout: (fn, ms) => {
        pending.set(++seq, { at: now + ms, fn });
        pump();
        return seq;
      },
      clearTimeout: (handle) => void pending.delete(handle as number),
    };
    return { timers, elapse: (ms: number) => void (now += ms) };
  };

  it('discards the late answer of a SYNCHRONOUS extractor that ran past the budget — never indexed', async () => {
    const synchronous = (ms: number, then: () => AttachmentExtractorResult) => {
      const clock = virtualTimers();
      const extractor = answering((() => {
        clock.elapse(ms); // a parser that never yields, for `ms` of the budget's clock
        return then();
      }) as unknown as AttachmentExtractor['extract']);
      return runAttachmentExtractor(extractor, input, bounds, clock.timers);
    };
    expect(await synchronous(120, () => ({ text: 'arrived after the deadline' }))).toEqual(timedOut);
    // The same for one that throws late: the deadline decides, not the throw.
    await expect(
      synchronous(120, () => {
        throw new Error('late');
      }),
    ).resolves.toEqual(timedOut);
    // The twin: a synchronous extractor inside the budget is indexed — and the edge either side.
    expect(await synchronous(5, () => ({ text: 'in time' }))).toMatchObject({ status: 'indexed', text: 'in time' });
    expect(await synchronous(49, () => ({ text: 'in time' }))).toMatchObject({ status: 'indexed', text: 'in time' });
    expect(await synchronous(50, () => ({ text: 'at the deadline' }))).toEqual(timedOut);
  });

  it('ignores what an aborted async extractor answers later — a resolution or a rejection', async () => {
    let resolved = false;
    const slow = answering(
      () =>
        new Promise((resolve) =>
          setTimeout(() => {
            resolved = true;
            resolve({ text: 'too late' });
          }, 200),
        ),
    );
    expect(await runAttachmentExtractor(slow, input, bounds)).toEqual(timedOut);
    // Answered at the deadline, not after the late answer: timers run in order of when they
    // are due, so the 50 ms deadline always precedes the 200 ms answer, however loaded the
    // machine — an ordering, where an elapsed-time bound would be a race.
    expect(resolved).toBe(false);
    // A later rejection is swallowed, not an unhandled rejection that fails the suite.
    const rejectsLate = answering(() => new Promise((_, reject) => setTimeout(() => reject(new Error('late')), 100)));
    expect(await runAttachmentExtractor(rejectsLate, input, bounds)).toEqual(timedOut);
    await new Promise((r) => setTimeout(r, 250));
    expect(resolved).toBe(true);
  });

  it('lets a COOPERATIVE extractor see the abort and stop', async () => {
    let turns = 0;
    let stoppedBy: string | undefined;
    const cooperative = answering(async ({ signal }) => {
      while (!signal.aborted) {
        turns += 1;
        await new Promise((r) => setTimeout(r, 0));
      }
      stoppedBy = 'the signal';
      return { failed: 'aborted' };
    });
    expect(await runAttachmentExtractor(cooperative, input, bounds)).toEqual(timedOut);
    await new Promise((r) => setTimeout(r, 10));
    expect([stoppedBy, turns > 0]).toEqual(['the signal', true]);
  });

  it('records a result of the wrong shape as failed — and a claimed failure, cut short', async () => {
    for (const wrong of [undefined, null, 7, 'text', {}, { text: 5 }, { text: 'x', truncated: 'yes' }, { failed: 'x', text: 'y' }]) {
      expect(await runAttachmentExtractor(answering(async () => wrong as never), input, bounds), JSON.stringify(wrong)).toEqual({
        status: 'failed',
        extractor: 'rogue',
        detail: "extractor 'rogue' returned an unreadable result",
      });
    }
    const long = await runAttachmentExtractor(answering(async () => ({ failed: 'x'.repeat(5000) })), input, bounds);
    expect(long).toMatchObject({ status: 'failed', extractor: 'rogue' });
    expect((long as { detail: string }).detail).toHaveLength(500);
  });

  it('keeps an extractor\'s own early stop on the record', async () => {
    expect(await runAttachmentExtractor(answering(async () => ({ text: 'short', truncated: true })), input, bounds)).toEqual({
      status: 'indexed',
      extractor: 'rogue',
      text: 'short',
      truncated: true,
    });
  });

  it('chooses the first extractor that accepts, reads an `accepts` that throws as a no, and refuses a bad list', () => {
    const named = (name: string, accepts: () => boolean): AttachmentExtractor => ({ name, accepts, extract: async () => ({ text: '' }) });
    const boom = named('boom', () => {
      throw new Error('nope');
    });
    expect(chooseAttachmentExtractor([boom, named('second', () => true)], 'text/plain', 'f')?.name).toBe('second');
    expect(chooseAttachmentExtractor([boom], 'text/plain', 'f')).toBeUndefined();
    expect(() => assertAttachmentExtractors([named('a', () => true), named('a', () => true)])).toThrow(/twice/);
    expect(() => assertAttachmentExtractors([named('Not A Name', () => true)])).toThrow(/identifier/);
    expect(() => assertAttachmentExtractors([named('text', () => true), named('docx', () => true)])).not.toThrow();
  });

  it('refuses, when the host is built, a declaration it could not honour', () => {
    const base = { name: 'x', accepts: () => true, extract: async () => ({ text: '' }) };
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, 0, -1, 1.5, '8' as unknown as number]) {
      expect(() => assertAttachmentExtractors([{ ...base, maxInputBytes: bad }]), String(bad)).toThrow(/positive integer/);
    }
    expect(() => assertAttachmentExtractors([{ ...base, accepts: undefined as never }])).toThrow(/accepts\(\) and extract\(\)/);
    expect(() => assertAttachmentExtractors([{ ...base, extract: 'no' as never }])).toThrow(/accepts\(\) and extract\(\)/);
    expect(() => assertAttachmentExtractors([{ ...base, name: 7 as never }])).toThrow(/identifier/);
    // The twins: a valid bound, and none at all.
    expect(() => assertAttachmentExtractors([{ ...base, maxInputBytes: 1024 }, { ...base, name: 'y' }])).not.toThrow();
  });

  it("holds the kernel's ceiling on its own — an invalid declaration that got past the check widens nothing", () => {
    const kernel = { maxInputBytes: 5 };
    for (const declared of [Number.NaN, Number.POSITIVE_INFINITY, -1, 0, '100' as unknown as number, undefined]) {
      expect(inputBoundRefusal(12, { maxInputBytes: declared }, kernel), String(declared)).toBe(
        'the file is 12 bytes, over the 5-byte input bound',
      );
      expect(inputBoundRefusal(4, { maxInputBytes: declared }, kernel), String(declared)).toBeNull();
    }
    // A valid declaration narrows; it never widens.
    expect(inputBoundRefusal(4, { maxInputBytes: 3 }, kernel)).toBe("the file is 4 bytes, over the extractor's 3-byte input bound");
    expect(inputBoundRefusal(12, { maxInputBytes: 100 }, kernel)).toBe('the file is 12 bytes, over the 5-byte input bound');
  });

  it('refuses bounds that are not positive integers', () => {
    for (const key of ['maxInputBytes', 'maxTextBytes', 'timeoutMs'] as const) {
      for (const bad of [Number.NaN, 0, -1, Number.POSITIVE_INFINITY]) {
        expect(() => assertAttachmentTextBounds({ ...DEFAULT_ATTACHMENT_TEXT_BOUNDS, [key]: bad })).toThrow(/positive integer/);
      }
    }
    expect(() => assertAttachmentTextBounds(DEFAULT_ATTACHMENT_TEXT_BOUNDS)).not.toThrow();
  });

  it("resolves a host's bounds over the defaults — tighter only, and each a positive integer", () => {
    expect(resolveAttachmentTextBounds()).toEqual(DEFAULT_ATTACHMENT_TEXT_BOUNDS);
    expect(resolveAttachmentTextBounds({ timeoutMs: 5_000 })).toEqual({ ...DEFAULT_ATTACHMENT_TEXT_BOUNDS, timeoutMs: 5_000 });
    // A key forwarded as undefined is a key left out, never a bound of nothing.
    expect(resolveAttachmentTextBounds({ timeoutMs: undefined, maxTextBytes: 64 })).toEqual({ ...DEFAULT_ATTACHMENT_TEXT_BOUNDS, maxTextBytes: 64 });
    for (const key of ['maxInputBytes', 'maxTextBytes', 'timeoutMs'] as const) {
      // At the default is allowed; one past it is a bound no adapter can keep.
      expect(resolveAttachmentTextBounds({ [key]: DEFAULT_ATTACHMENT_TEXT_BOUNDS[key] })[key]).toBe(DEFAULT_ATTACHMENT_TEXT_BOUNDS[key]);
      expect(() => resolveAttachmentTextBounds({ [key]: DEFAULT_ATTACHMENT_TEXT_BOUNDS[key] + 1 })).toThrow(/only tighten/);
      for (const bad of [Number.NaN, 0, -1, 1.5]) {
        expect(() => resolveAttachmentTextBounds({ [key]: bad })).toThrow(/positive integer/);
      }
    }
  });

  it('truncateUtf8 never splits a character', () => {
    expect(truncateUtf8('aé', 2)).toEqual({ text: 'a', truncated: true });
    expect(truncateUtf8('aé', 3)).toEqual({ text: 'aé', truncated: false });
    expect(truncateUtf8('a😀', 4)).toEqual({ text: 'a', truncated: true });
    expect(truncateUtf8('a😀', 5)).toEqual({ text: 'a😀', truncated: false });
  });
});
