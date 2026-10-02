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
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  permissionKey,
  platformActorId,
  principalId,
  scopeId as scopeIdSchema,
  tenantId,
  type AttachmentRecord,
  type EntityRef,
  type PrincipalId,
  type ScopeId,
} from '@substrat-run/contracts';
import {
  ATTACHMENT_TEXT_JOB,
  ATTACHMENT_TEXT_MODULE,
  DEFAULT_EXTRACTION_BOUNDS,
  SearchTermTooShort,
  isSearchIndexTable,
  ulid,
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


export function attachmentTextContractSuite(
  adapterName: string,
  makeFixture: () => Promise<ScopeHostFixture>,
): void {
  describe(`attachment text search (#1575): ${adapterName}`, () => {
    let fixture: ScopeHostFixture;
    let host: ScopeHost;
    const t = tenantId.parse(ulid());
    const staff = platformActorId.parse(ulid());
    const editor: PrincipalId = principalId.parse(ulid()); // perm:read + perm:use, tenant-wide
    const bob: PrincipalId = principalId.parse(ulid()); // no role: entity-narrowed grants only

    beforeAll(async () => {
      fixture = await makeFixture();
      host = fixture.host;
      host.registerModule(permMod);
      await host.admin.createTenant(staff, { id: t, slug: `att-text-${t.toLowerCase()}`, name: 'Attachment text' });
      await host.admin.grantEntitlement(staff, t, 'perm');
      await host.provisionBlobStore(staff, { tenantId: t, vertical: 'docs', binding: 'ATTACHMENTS' });
      await host.admin.defineRole(staff, t, { key: 'editor', permissions: [PERM_READ, PERM_USE], source: 'vertical' });
      await host.admin.assignRole(staff, { principalId: editor, roleKey: 'editor', node: { tenantId: t, scopeId: null } });
    });

    afterAll(async () => {
      await fixture.cleanup();
    });

    /** A scope per test: `runDueJobs` drives a whole scope, so tests must not share one. */
    const newScope = async (): Promise<ScopeId> => {
      const s = scopeIdSchema.parse(ulid());
      await host.provisionScope(staff, { tenantId: t, scopeId: s, vertical: 'docs' });
      await host.admin.activateScope(staff, t, s);
      return s;
    };
    const upload = async (s: ScopeId, entity: EntityRef, filename: string, contentType: string, body: Uint8Array) =>
      (await host.attachments(editor, t, s)).upload({ entity, filename, contentType, visibility: 'internal', body });
    /** Drive the scope's due runs until none are left. */
    const extract = async (s: ScopeId): Promise<void> => {
      for (let i = 0; i < 10; i += 1) {
        if ((await host.runDueJobs(t, s, { limit: 100 })).attempted === 0) return;
      }
      throw new Error('extraction runs did not settle');
    };
    const stateOf = async (s: ScopeId, id: string): Promise<AttachmentTextState | null> =>
      (await host.getScope(editor, t, s)).invoke<AttachmentTextState | null>('perm/attachment-text', { id });
    const search = async (s: ScopeId, who: PrincipalId, term: string, limit?: number): Promise<AttachmentRecord[]> =>
      (await host.attachments(who, t, s)).search(term, limit === undefined ? undefined : { limit });
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

      it('records no denial for a hit it withheld — nobody asked for that row', async () => {
        const s = await newScope();
        await upload(s, item('denied'), 'd.txt', 'text/plain', bytes('a withheld wombat'));
        await extract(s);
        expect(await search(s, bob, 'wombat')).toEqual([]);
        const denials = await (await host.getScope(editor, t, s)).invoke<{ operation: string | null }[]>('perm/read-denials');
        expect(denials.filter((d) => d.operation === 'attachments.search')).toEqual([]);
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
        const cap = DEFAULT_EXTRACTION_BOUNDS.maxTextBytes;
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
      it('an export holds no attachment text table, nor its index', async () => {
        const s = await newScope();
        await upload(s, item('i'), 'x.txt', 'text/plain', bytes('the dugong file'));
        await extract(s);
        const dump = await host.admin.exportScope(staff, t, s);
        expect(dump.tables.some((tb) => tb.name === '_substrat_attachments')).toBe(true);
        expect(dump.tables.filter((tb) => tb.name.startsWith('_substrat_search__'))).toEqual([]);
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
  });
}
