/**
 * Contract suite for attachment content search (#1575): an upload's text extracted by a
 * job, indexed in the scope, and searchable through `ScopeAttachments.search`.
 *
 * What it pins, in one sentence: **an attachment is found by a phrase from its body
 * exactly when the caller could `open` it, and a match the caller cannot open changes
 * nothing about what the caller sees.**
 *
 * 1. **Every supported type, from its real producer.** Each fixture is uploaded, the
 *    extraction job runs through `runDueJobs`, and its recorded state is read through
 *    `readAttachmentText` on the adapter's own `ctx.sql`. An indexed file is found by a
 *    phrase from its body; an unsupported, empty or damaged one says so, and is never
 *    "indexed, no match". The upload of a damaged file still succeeds.
 * 2. **The gate.** A match on an entity the caller cannot read is absent, takes no slot
 *    under a limit, and leaves the page identical to a scope where that file does not
 *    exist; every hit opens. Twin: the editor sees both.
 * 3. **Idempotence.** Extracting again leaves one row and one match.
 * 4. **Removal.** A removed attachment's text and index entries go with it, including
 *    when the removal lands before its extraction runs.
 * 5. **Bounds.** Text past the per-attachment cap is cut and recorded `truncated`, and
 *    the capped row — near the size a Durable Object row is refused at — writes and is
 *    found.
 * 6. **Dumps.** A dump carries no extracted text. An in-place restore keeps the text of
 *    the attachments it keeps and drops the rest; a fork, whose bytes stay under the
 *    source scope's key, records each attachment as failed rather than leaving it pending.
 * 7. **A host's own bounds.** A host tightens the input ceiling, the time budget and the
 *    text cap; a file over the ceiling is never handed to an extractor, an extractor past
 *    the budget is recorded failed and its late answer is never indexed, and a bound that
 *    loosens a default is refused when the host is built.
 * 8. **The backfill.** Attachments that predate extraction — no text row, no run — are
 *    queued by a one-shot kernel job on the drive, a bounded batch per pass, and the scope
 *    is never walked again.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  errorCodeOf,
  moduleId,
  permissionKey,
  platformActorId,
  principalId,
  scopeId as scopeIdSchema,
  tenantId,
  type AttachmentRecord,
  type TenantId,
  type EntityRef,
  type PrincipalId,
  type ScopeId,
} from '@substrat-run/contracts';
import {
  ATTACHMENT_SEARCH_OWNER_MAX,
  ATTACHMENT_SEARCH_TOO_MANY_OWNERS,
  ATTACHMENT_TEXT_BACKFILL_BATCH,
  ATTACHMENT_TEXT_BACKFILL_JOB,
  ATTACHMENT_TEXT_JOB,
  ATTACHMENT_TEXT_MODULE,
  DEFAULT_ATTACHMENT_TEXT_BOUNDS,
  SearchTermTooShort,
  isSearchIndexTable,
  ulid,
  type AttachmentExtractor,
  type AttachmentTextBounds,
  type AttachmentTextState,
  type ScopeHost,
} from '@substrat-run/kernel';
import type { ScopeHostFixture } from './scope-host-suite.js';
import { permMod } from './modules.js';
import { ATTACHMENT_TEXT_FIXTURES } from './attachment-text-fixtures.js';

const PERM_READ = permissionKey.parse('perm:read');
const PERM_USE = permissionKey.parse('perm:use');
const item = (id: string): EntityRef => ({ entityType: 'item', entityId: id });
const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);
/** For a test that uploads and extracts thousands of files: the setup, not the search, takes the time. */
const SETUP_HEAVY_MS = 120_000;


/** What a fixture builds its host with. Omitted extractors are the host's real ones. */
export interface AttachmentTextHostOptions {
  readonly attachmentExtractors?: readonly AttachmentExtractor[];
  readonly attachmentTextBounds?: Partial<AttachmentTextBounds>;
}

export interface AttachmentTextHostFixture extends ScopeHostFixture {
  /**
   * Put a scope back where it stood before extraction existed: no text rows and no
   * extraction runs. The backfill's own run — its marker — is left alone. Written straight
   * to the store, since no host surface may write the spine.
   */
  forgetAttachmentText(tenantId: TenantId, scopeId: ScopeId): Promise<void>;
}

export function attachmentTextContractSuite(
  adapterName: string,
  makeFixture: (options?: AttachmentTextHostOptions) => Promise<AttachmentTextHostFixture>,
): void {
  describe(`attachment text search (#1575): ${adapterName}`, () => {
    let fixture: AttachmentTextHostFixture;
    let host: ScopeHost;
    const t = tenantId.parse(ulid());
    const staff = platformActorId.parse(ulid());
    const editor: PrincipalId = principalId.parse(ulid()); // perm:read + perm:use, tenant-wide
    const bob: PrincipalId = principalId.parse(ulid()); // no role: entity-narrowed grants only

    /** A tenant with the suite's module, a blob store and its roles. */
    const prepare = async (h: ScopeHost, tn: TenantId): Promise<void> => {
      h.registerModule(permMod);
      await h.admin.createTenant(staff, { id: tn, slug: `att-text-${tn.toLowerCase()}`, name: 'Attachment text' });
      await h.admin.grantEntitlement(staff, tn, 'perm');
      await h.provisionBlobStore(staff, { tenantId: tn, vertical: 'docs', binding: 'ATTACHMENTS' });
      await h.admin.defineRole(staff, tn, { key: 'editor', permissions: [PERM_READ, PERM_USE], source: 'vertical' });
      await h.admin.assignRole(staff, { principalId: editor, roleKey: 'editor', node: { tenantId: tn, scopeId: null } });
      // A role at the tenant that holds a DIFFERENT key on the target: never "wide" for reading.
      await h.admin.defineRole(staff, tn, { key: 'user', permissions: [PERM_USE], source: 'vertical' });
    };

    beforeAll(async () => {
      fixture = await makeFixture();
      host = fixture.host;
      await prepare(host, t);
    });

    afterAll(async () => {
      await fixture.cleanup();
    });

    /** The per-scope verbs, as the editor, on one host and tenant. */
    const verbs = (hostOf: () => ScopeHost, tn: TenantId) => ({
      /** A scope per test: `runDueJobs` drives a whole scope, so tests must not share one. */
      newScope: async (): Promise<ScopeId> => {
        const s = scopeIdSchema.parse(ulid());
        await hostOf().provisionScope(staff, { tenantId: tn, scopeId: s, vertical: 'docs' });
        await hostOf().admin.activateScope(staff, tn, s);
        return s;
      },
      upload: async (s: ScopeId, entity: EntityRef, filename: string, contentType: string, body: Uint8Array) =>
        (await hostOf().attachments(editor, tn, s)).upload({ entity, filename, contentType, visibility: 'internal', body }),
      /** Drive the scope's due runs until none are left. */
      extract: async (s: ScopeId): Promise<void> => {
        for (let i = 0; i < 100; i += 1) {
          if ((await hostOf().runDueJobs(tn, s, { limit: 500 })).attempted === 0) return;
        }
        throw new Error('extraction runs did not settle');
      },
      stateOf: async (s: ScopeId, id: string): Promise<AttachmentTextState | null> =>
        (await hostOf().getScope(editor, tn, s)).invoke<AttachmentTextState | null>('perm/attachment-text', { id }),
      search: async (s: ScopeId, who: PrincipalId, term: string, limit?: number): Promise<AttachmentRecord[]> =>
        (await hostOf().attachments(who, tn, s)).search(term, limit === undefined ? undefined : { limit }),
    });
    const { newScope, upload, extract, stateOf, search } = verbs(() => host, t);
    const grant = async (s: ScopeId, who: PrincipalId, entity: EntityRef) =>
      (await host.getScope(editor, t, s)).invoke('perm/share', { principal: who, permission: 'perm:read', entity });
    /** Rows the console read sees — the index itself, not the search surface over it. */
    const count = async (s: ScopeId, sql: string): Promise<number> =>
      Number((await host.admin.queryScope(staff, t, s, { sql })).rows[0]![0]);
    const indexMatches = (s: ScopeId, word: string) =>
      count(s, `SELECT count(*) FROM _substrat_search__attachments WHERE _substrat_search__attachments MATCH '"${word}"'`);
    const textRows = (s: ScopeId, id: string) =>
      count(s, `SELECT count(*) FROM _substrat_search__attachment_text WHERE attachment_id = '${id}'`);

    describe('every supported type, from its real producer', () => {
      let s: ScopeId;
      const uploaded = new Map<string, AttachmentRecord>();

      beforeAll(async () => {
        s = await newScope();
        for (const f of ATTACHMENT_TEXT_FIXTURES) {
          // A damaged file's upload succeeds like any other: extraction is off the upload.
          uploaded.set(f.name, await upload(s, item('fixtures'), f.filename, f.contentType, f.body));
        }
      });

      it('records each upload as pending until its job runs', async () => {
        for (const f of ATTACHMENT_TEXT_FIXTURES) {
          expect((await stateOf(s, uploaded.get(f.name)!.id))?.status).toBe('pending');
        }
      });

      it.each(ATTACHMENT_TEXT_FIXTURES.map((f) => [f.name, f] as const))(
        '%s: recorded with the outcome its type earns',
        async (_name, f) => {
          await extract(s);
          const state = await stateOf(s, uploaded.get(f.name)!.id);
          expect(state).toMatchObject({ status: f.status, extractor: f.extractor });
          if (f.status === 'indexed') {
            expect(state!.bytes).toBeGreaterThan(0);
            expect(state!.detail).toBeNull();
          } else {
            // Never "indexed, no match": no text, and when there is a reason, it is said.
            expect(state!.bytes).toBeNull();
            if (f.status !== 'empty') expect(state!.detail).toEqual(expect.any(String));
          }
        },
      );

      it('finds every indexed file by a phrase from its body — the first phrase finds it alone', async () => {
        await extract(s);
        for (const f of ATTACHMENT_TEXT_FIXTURES.filter((x) => x.finds)) {
          const id = uploaded.get(f.name)!.id;
          const [unique, ...rest] = f.finds!;
          expect((await search(s, editor, unique!)).map((r) => r.id), `${f.name}: ${unique}`).toEqual([id]);
          for (const phrase of rest) {
            expect((await search(s, editor, phrase)).map((r) => r.id), `${f.name}: ${phrase}`).toContain(id);
          }
        }
      });

      it('does not index what a file carries but nobody reads — a script body', async () => {
        await extract(s);
        for (const f of ATTACHMENT_TEXT_FIXTURES.filter((x) => x.hides)) {
          expect(await search(s, editor, f.hides!)).toEqual([]);
        }
      });

      it('hands back the record `open` would, and refuses a term too short to match', async () => {
        await extract(s);
        const [hit] = await search(s, editor, 'zephyr');
        expect(hit).toEqual(uploaded.get('plain text'));
        await expect(search(s, editor, 'z')).rejects.toBeInstanceOf(SearchTermTooShort);
      });
    });

    describe('the gate: a match the caller cannot open changes nothing they see', () => {
      it('is absent, takes no slot under a limit, and every hit opens — the editor, the twin, sees both', async () => {
        const s = await newScope();
        await grant(s, bob, item('allowed'));
        const allowed = await upload(s, item('allowed'), 'a.txt', 'text/plain', bytes('indexation memo for the allowed item'));
        // NEWER than `allowed`, so in newest-first order it is the first candidate: if it took
        // a slot before the gate, a limit of one would hand bob nothing.
        const denied = await upload(s, item('denied'), 'd.txt', 'text/plain', bytes('indexation memo for the denied item'));
        await extract(s);

        expect((await search(s, bob, 'indexation')).map((r) => r.id)).toEqual([allowed.id]);
        expect((await search(s, bob, 'indexation', 1)).map((r) => r.id)).toEqual([allowed.id]);
        expect((await search(s, editor, 'indexation')).map((r) => r.id)).toEqual([denied.id, allowed.id]);
        expect((await search(s, editor, 'indexation', 1)).map((r) => r.id)).toEqual([denied.id]);

        // What search hands bob, bob can open; what it withholds, bob cannot.
        const files = await host.attachments(bob, t, s);
        expect((await files.open(allowed.id))?.record.id).toBe(allowed.id);
        // By message: on the DO host a principal's refusal crosses RPC as its message alone.
        await expect(files.open(denied.id)).rejects.toThrow(/permission denied/i);
      });

      it('gives bob the same page, at every limit, as a scope where the denied file does not exist', async () => {
        const withDenied = await newScope();
        const without = await newScope();
        for (const s of [withDenied, without]) {
          await grant(s, bob, item('allowed'));
          await upload(s, item('allowed'), 'one.txt', 'text/plain', bytes('quarterly indexation review one'));
          if (s === withDenied) {
            await upload(s, item('denied'), 'secret.txt', 'text/plain', bytes('quarterly indexation review secret'));
          }
          await upload(s, item('allowed'), 'two.txt', 'text/plain', bytes('quarterly indexation review two'));
          if (s === withDenied) {
            await upload(s, item('denied'), 'secret2.txt', 'text/plain', bytes('quarterly indexation secret again'));
          }
          await extract(s);
        }
        const page = async (s: ScopeId, term: string, limit?: number) =>
          (await search(s, bob, term, limit)).map((r) => r.filename);
        for (const term of ['indexation', 'quarterly review', 'indexation secret']) {
          for (const limit of [1, 2, 3, undefined]) {
            expect(await page(withDenied, term, limit), `${term} / ${limit}`).toEqual(await page(without, term, limit));
          }
        }
        expect(await page(withDenied, 'secret')).toEqual([]);
      });

      it('leaves the one readable older match on page one past a thousand newer hidden ones — as in the control scope', async () => {
        const s = await newScope();
        const control = await newScope();
        for (const scope of [s, control]) {
          await grant(scope, bob, item('allowed'));
          await upload(scope, item('allowed'), 'old.txt', 'text/plain', bytes('the margay ledger, readable'));
        }
        // Every one of these is NEWER than old.txt. A scan bound applied before the gate would
        // have spent itself on them and handed bob nothing.
        for (let i = 0; i < 1001; i += 1) {
          await upload(s, item('denied'), `hidden-${i}.txt`, 'text/plain', bytes(`the margay ledger, hidden ${i}`));
        }
        await extract(s);
        await extract(control);
        for (const limit of [1, 20]) {
          const page = (await search(s, bob, 'margay', limit)).map((r) => r.filename);
          expect(page).toEqual(['old.txt']);
          expect(page).toEqual((await search(control, bob, 'margay', limit)).map((r) => r.filename));
        }
        // The twin: the editor reads every owner, so the newest hidden ones fill its page.
        const editors = await search(s, editor, 'margay', 20);
        expect(editors).toHaveLength(20);
        expect(editors.map((r) => r.filename)).not.toContain('old.txt');
      }, SETUP_HEAVY_MS);

      it('is not "wide" for a node-level grant on a different key, nor for an entity grant alone', async () => {
        const s = await newScope();
        const dave = principalId.parse(ulid()); // `user` at the tenant (perm:use only) + perm:read on one item
        await host.admin.assignRole(staff, { principalId: dave, roleKey: 'user', node: { tenantId: t, scopeId: null } });
        await grant(s, dave, item('mine'));
        await grant(s, bob, item('mine'));
        const mine = await upload(s, item('mine'), 'mine.txt', 'text/plain', bytes('the caracal file, mine'));
        await upload(s, item('other'), 'other.txt', 'text/plain', bytes('the caracal file, other'));
        await extract(s);
        expect((await search(s, dave, 'caracal')).map((r) => r.id)).toEqual([mine.id]);
        expect((await search(s, bob, 'caracal')).map((r) => r.id)).toEqual([mine.id]);
        // The twin: a node-level grant on the READ key is wide.
        expect(await search(s, editor, 'caracal')).toHaveLength(2);
      });

      it('refuses a narrowed caller past the owner cap — the same for a term with matches and one without', async () => {
        const s = await newScope();
        await grant(s, bob, item('o0'));
        for (let i = 0; i <= ATTACHMENT_SEARCH_OWNER_MAX; i += 1) {
          await upload(s, item(`o${i}`), `o${i}.txt`, 'text/plain', bytes(i === 0 ? 'the jerboa note' : 'filler only'));
        }
        await extract(s);
        const refusalOf = async (term: string) => {
          const err = await search(s, bob, term).then(
            () => undefined,
            (e: unknown) => e,
          );
          return { code: errorCodeOf(err), reason: (err as { extensions?: { reason?: string } })?.extensions?.reason };
        };
        const refused = { code: 'forbidden', reason: ATTACHMENT_SEARCH_TOO_MANY_OWNERS };
        expect(await refusalOf('jerboa')).toEqual(refused); // one match, readable by bob
        expect(await refusalOf('nothingmatchesthis')).toEqual(refused); // no match at all
        // The twin: a caller who reads the type at the scope is never refused.
        expect((await search(s, editor, 'jerboa')).map((r) => r.filename)).toEqual(['o0.txt']);
      }, SETUP_HEAVY_MS);

      it('records no denial for a hit it withheld — nobody asked for that row', async () => {
        const s = await newScope();
        await upload(s, item('denied'), 'd.txt', 'text/plain', bytes('a withheld wombat'));
        await extract(s);
        expect(await search(s, bob, 'wombat')).toEqual([]);
        const denials = await (await host.getScope(editor, t, s)).invoke<{ operation: string | null }[]>('perm/read-denials');
        expect(denials.filter((d) => d.operation === 'attachments.search')).toEqual([]);
      });
    });

    describe('the kernel job is the host’s own', () => {
      it('refuses a registration under the kernel’s module id — any job name — and accepts the same name elsewhere', () => {
        const handler = () => ({ done: true });
        expect(() => host.registerJob(ATTACHMENT_TEXT_MODULE, ATTACHMENT_TEXT_JOB, handler)).toThrow(/reserved/);
        expect(() => host.registerJob(ATTACHMENT_TEXT_MODULE, 'a-later-kernel-job', handler)).toThrow(/reserved/);
        // The twin: a module of its own may name a job `attachment-text`; only the module id is reserved.
        expect(() => host.registerJob(moduleId.parse('@test/att-text-twin'), ATTACHMENT_TEXT_JOB, handler)).not.toThrow();
      });
    });

    describe('idempotence, removal and bounds', () => {
      it('extracting again leaves one text row and one index match', async () => {
        const s = await newScope();
        const rec = await upload(s, item('i'), 'r.txt', 'text/plain', bytes('the platypus clause'));
        await extract(s);
        for (let i = 0; i < 2; i += 1) {
          await host.startJobRun(t, s, {
            moduleId: ATTACHMENT_TEXT_MODULE,
            job: ATTACHMENT_TEXT_JOB,
            instance: rec.id,
            payload: { attachmentId: rec.id },
          });
          await extract(s);
        }
        expect(await textRows(s, rec.id)).toBe(1);
        expect(await indexMatches(s, 'platypus')).toBe(1);
        expect((await search(s, editor, 'platypus')).map((r) => r.id)).toEqual([rec.id]);
        expect((await stateOf(s, rec.id))?.status).toBe('indexed');
      });

      it('a removed attachment takes its text and its index entries with it', async () => {
        const s = await newScope();
        const gone = await upload(s, item('i'), 'gone.txt', 'text/plain', bytes('the axolotl appendix'));
        const kept = await upload(s, item('i'), 'kept.txt', 'text/plain', bytes('the axolotl summary'));
        await extract(s);
        expect(await indexMatches(s, 'axolotl')).toBe(2);
        await (await host.attachments(editor, t, s)).remove(gone.id);
        expect(await textRows(s, gone.id)).toBe(0);
        expect(await indexMatches(s, 'axolotl')).toBe(1);
        expect((await search(s, editor, 'axolotl')).map((r) => r.id)).toEqual([kept.id]);
        expect(await stateOf(s, gone.id)).toBeNull();
      });

      it('a removal that lands before the extraction runs is not undone by it', async () => {
        const s = await newScope();
        const rec = await upload(s, item('i'), 'early.txt', 'text/plain', bytes('the tapir memo'));
        await (await host.attachments(editor, t, s)).remove(rec.id);
        await extract(s);
        expect(await textRows(s, rec.id)).toBe(0);
        expect(await indexMatches(s, 'tapir')).toBe(0);
        const [run] = await host.jobRuns(t, s, { moduleId: ATTACHMENT_TEXT_MODULE, instance: rec.id });
        expect(run).toMatchObject({ status: 'done', counters: { gone: 1 } });
      });

      it('cuts text at the per-attachment cap, says so, and still writes and finds the capped row', async () => {
        const s = await newScope();
        const cap = DEFAULT_ATTACHMENT_TEXT_BOUNDS.maxTextBytes;
        // A head phrase, then three-byte characters well past the cap — so the cut lands on a
        // multi-byte boundary — and a tail phrase that falls beyond it.
        const body = `kinkajou opening ${'€'.repeat(Math.ceil(cap / 3) + 1000)} capybara ending`;
        const rec = await upload(s, item('i'), 'big.txt', 'text/plain', bytes(body));
        await extract(s);
        const state = await stateOf(s, rec.id);
        expect(state).toMatchObject({ status: 'indexed', truncated: true });
        expect(state!.bytes).toBeLessThanOrEqual(cap);
        expect(state!.bytes).toBeGreaterThan(cap - 3);
        expect((await search(s, editor, 'kinkajou')).map((r) => r.id)).toEqual([rec.id]);
        expect(await search(s, editor, 'capybara')).toEqual([]);
      });
    });

    describe('dumps carry no text; a load re-derives it where the bytes are', () => {
      it('an export carries the attachment row and not one word of its extracted text', async () => {
        const s = await newScope();
        await upload(s, item('i'), 'x.txt', 'text/plain', bytes('the dugong file'));
        await extract(s);
        expect(await search(s, editor, 'dugong')).toHaveLength(1);
        const dump = await host.admin.exportScope(staff, t, s);
        expect(dump.tables.some((tb) => tb.name === '_substrat_attachments')).toBe(true);
        // Judged on the rows, not on table names: a renamed text table must still fail this.
        expect(JSON.stringify(dump.tables.map((tb) => tb.rows))).not.toContain('dugong');
        expect(dump.tables.some((tb) => isSearchIndexTable(tb.name))).toBe(false);
      });

      it('an in-place restore keeps the text of what it keeps and drops the rest', async () => {
        const s = await newScope();
        const before = await upload(s, item('i'), 'before.txt', 'text/plain', bytes('the okapi before'));
        await extract(s);
        const dump = await host.admin.exportScope(staff, t, s);
        const after = await upload(s, item('i'), 'after.txt', 'text/plain', bytes('the okapi after'));
        await extract(s);
        expect(await indexMatches(s, 'okapi')).toBe(2);

        await host.restoreScope(staff, t, s, dump);
        // The rewound-away attachment's text is gone at once; the kept one's is still indexed,
        // with no extraction needed.
        expect(await textRows(s, after.id)).toBe(0);
        expect(await indexMatches(s, 'okapi')).toBe(1);
        expect((await stateOf(s, before.id))?.status).toBe('indexed');
        expect((await search(s, editor, 'okapi')).map((r) => r.id)).toEqual([before.id]);
      });

      it('a fork re-queues every attachment, and says where the bytes are not', async () => {
        const s = await newScope();
        const rec = await upload(s, item('i'), 'src.txt', 'text/plain', bytes('the margay source'));
        await extract(s);
        const fork = scopeIdSchema.parse(ulid());
        await host.importScope(staff, { tenantId: t, scopeId: fork, vertical: 'docs' }, await host.admin.exportScope(staff, t, s));
        // Queued by the load, not left without a state.
        expect((await stateOf(fork, rec.id))?.status).toBe('pending');
        await extract(fork);
        // The fork's objects would live under its own key; the bytes stayed under the source's.
        expect(await stateOf(fork, rec.id)).toMatchObject({
          status: 'failed',
          detail: expect.stringContaining('missing'),
        });
        expect(await search(fork, editor, 'margay')).toEqual([]);
        // The source is untouched.
        expect((await search(s, editor, 'margay')).map((r) => r.id)).toEqual([rec.id]);
      });
    });

    describe("a host's own bounds: tighter than the defaults, and held", () => {
      /** The bounded host's budget, and how long its late extractor takes to answer anyway. */
      const BUDGET_MS = 200;
      const LATE_MS = 1_000;
      const bounds = { maxInputBytes: 1024, maxTextBytes: 64, timeoutMs: BUDGET_MS };
      /** Filenames the spy was handed bytes for: a file it never sees was never fetched for it. */
      const handed: string[] = [];
      const extractors: AttachmentExtractor[] = [
        {
          name: 'spy',
          accepts: (contentType) => contentType === 'application/x-spy',
          extract: async ({ body, filename }) => {
            handed.push(filename);
            return { text: new TextDecoder().decode(body) };
          },
        },
        {
          // Ignores its signal and answers well past the budget.
          name: 'late',
          accepts: (contentType) => contentType === 'application/x-late',
          extract: () => new Promise((resolve) => setTimeout(() => resolve({ text: 'quokka late answer' }), LATE_MS)),
        },
        {
          name: 'prompt',
          accepts: (contentType) => contentType === 'application/x-prompt',
          extract: async () => ({ text: 'quokka prompt answer' }),
        },
      ];
      let bounded: AttachmentTextHostFixture;
      const bt = tenantId.parse(ulid());
      const b = verbs(() => bounded.host, bt);

      beforeAll(async () => {
        bounded = await makeFixture({ attachmentExtractors: extractors, attachmentTextBounds: bounds });
        await prepare(bounded.host, bt);
      });

      afterAll(async () => {
        await bounded.cleanup();
      });

      it('never hands an extractor a file over the input ceiling, says why, and extracts the one at it', async () => {
        const s = await b.newScope();
        handed.length = 0;
        const over = await b.upload(s, item('i'), 'over.spy', 'application/x-spy', bytes(`quoll ${'x'.repeat(1019)}`));
        const at = await b.upload(s, item('i'), 'at.spy', 'application/x-spy', bytes(`numbat ${'x'.repeat(1017)}`));
        expect([over.size, at.size]).toEqual([1025, 1024]);
        await b.extract(s);
        expect(await b.stateOf(s, over.id)).toMatchObject({
          status: 'failed',
          extractor: 'spy',
          detail: 'the file is 1025 bytes, over the 1024-byte input bound',
        });
        expect((await b.stateOf(s, at.id))?.status).toBe('indexed');
        expect(handed).toEqual(['at.spy']);
        expect(await b.search(s, editor, 'quoll')).toEqual([]);
        expect((await b.search(s, editor, 'numbat')).map((r) => r.id)).toEqual([at.id]);
        // The upload itself is whole: a bound on extraction is never a bound on the file.
        expect((await (await bounded.host.attachments(editor, bt, s)).open(over.id))?.body.length).toBe(1025);
      });

      it('records an extractor past the time budget as failed, and never indexes its late answer', async () => {
        const s = await b.newScope();
        const late = await b.upload(s, item('i'), 'late.bin', 'application/x-late', bytes('bytes'));
        const prompt = await b.upload(s, item('i'), 'prompt.bin', 'application/x-prompt', bytes('bytes'));
        await b.extract(s);
        expect(await b.stateOf(s, late.id)).toMatchObject({
          status: 'failed',
          extractor: 'late',
          detail: `extractor 'late' did not answer within ${BUDGET_MS} ms`,
        });
        expect((await b.stateOf(s, prompt.id))?.status).toBe('indexed');
        // Past the moment the late answer lands, and another drive: still never indexed.
        await new Promise((resolve) => setTimeout(resolve, LATE_MS + 300));
        await b.extract(s);
        expect((await b.search(s, editor, 'quokka')).map((r) => r.id)).toEqual([prompt.id]);
        expect(await b.search(s, editor, 'late')).toEqual([]);
        expect((await b.stateOf(s, late.id))?.status).toBe('failed');
      });

      it("cuts text at the host's cap, not the default's", async () => {
        const s = await b.newScope();
        const rec = await b.upload(s, item('i'), 'cap.spy', 'application/x-spy', bytes(`kinkajou ${'word '.repeat(50)}capybara`));
        await b.extract(s);
        const state = await b.stateOf(s, rec.id);
        expect(state).toMatchObject({ status: 'indexed', truncated: true });
        expect(state!.bytes).toBeLessThanOrEqual(64);
        expect((await b.search(s, editor, 'kinkajou')).map((r) => r.id)).toEqual([rec.id]);
        expect(await b.search(s, editor, 'capybara')).toEqual([]);
      });

      it('refuses, when the host is built, a bound that loosens a default or is not a positive integer', async () => {
        await expect(makeFixture({ attachmentTextBounds: { timeoutMs: DEFAULT_ATTACHMENT_TEXT_BOUNDS.timeoutMs + 1 } })).rejects.toThrow(
          /only tighten/,
        );
        await expect(makeFixture({ attachmentTextBounds: { maxTextBytes: 0 } })).rejects.toThrow(/positive integer/);
      });
    });

    describe('the backfill: attachments from before extraction, queued once, a batch per pass', () => {
      const backfillRuns = (s: ScopeId) =>
        host.jobRuns(t, s, { moduleId: ATTACHMENT_TEXT_MODULE, job: ATTACHMENT_TEXT_BACKFILL_JOB });
      const allTextRows = (s: ScopeId) => count(s, 'SELECT count(*) FROM _substrat_search__attachment_text');

      it('walks a backlog in bounded batches on the drive, makes it searchable, and never walks the scope again', async () => {
        const s = await newScope();
        const n = ATTACHMENT_TEXT_BACKFILL_BATCH * 2 + 50;
        const ids: string[] = [];
        for (let i = 0; i < n; i += 1) {
          const body = i === 0 ? 'the solenodon backlog' : `backlog filler ${i}`;
          ids.push((await upload(s, item(`b${i % 7}`), `old-${i}.txt`, 'text/plain', bytes(body))).id);
        }
        const solenodon = ids[0]!;
        ids.sort();
        await fixture.forgetAttachmentText(t, s);
        expect(await allTextRows(s)).toBe(0);
        expect(await stateOf(s, solenodon)).toBeNull();

        // Each drive is one pass: one batch queued, the cursor at its last id.
        const expected = [
          [ATTACHMENT_TEXT_BACKFILL_BATCH, 'running'],
          [ATTACHMENT_TEXT_BACKFILL_BATCH * 2, 'running'],
          [n, 'done'],
        ] as const;
        for (const [queued, status] of expected) {
          await host.runDueJobs(t, s);
          const [run, ...more] = await backfillRuns(s);
          expect(more).toEqual([]);
          expect(run).toMatchObject({ status, cursor: ids[queued - 1], counters: { scanned: queued, queued } });
          expect(await allTextRows(s)).toBe(queued);
        }

        await extract(s);
        expect((await stateOf(s, solenodon))?.status).toBe('indexed');
        expect((await search(s, editor, 'solenodon')).map((r) => r.id)).toEqual([solenodon]);

        // The run is the marker: with the text gone again, no drive starts a second walk.
        await fixture.forgetAttachmentText(t, s);
        await extract(s);
        expect(await backfillRuns(s)).toHaveLength(1);
        expect(await allTextRows(s)).toBe(0);
      }, SETUP_HEAVY_MS);

      it('marks no scope that holds no attachment — and one that later gets one, once', async () => {
        const s = await newScope();
        await extract(s);
        expect(await backfillRuns(s)).toEqual([]);
        const rec = await upload(s, item('i'), 'new.txt', 'text/plain', bytes('the hutia memo'));
        await extract(s);
        // Walked once, and found the upload's own row there already: nothing queued twice.
        expect(await backfillRuns(s)).toMatchObject([{ status: 'done', counters: { scanned: 1, queued: 0 } }]);
        expect((await search(s, editor, 'hutia')).map((r) => r.id)).toEqual([rec.id]);
      });
    });
  });
}
