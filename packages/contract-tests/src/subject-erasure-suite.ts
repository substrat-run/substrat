/**
 * Contract suite for subject erasure inside a module's own tables (#2068): the declared blank
 * and delete, the `onSubjectErased` hook and its reach, the search index, the receipt, and the
 * failure that must leave nothing erased and the key alive.
 *
 * Every adapter owes all of it. The property the whole suite circles is K-37's order, extended:
 * the module rows, the spine and the key go together or not at all, and only a completed
 * erasure is receipted. Each refusal here has its positive twin beside it, so a test cannot
 * pass by an erasure that refuses everything — or by one that reaches nothing.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  dataSubjectId,
  errorCodeOf,
  platformActorId,
  principalId,
  scopeId,
  tenantId,
  type DataSubjectId,
  type ScopeId,
  type SubjectShredReceipt,
  type TenantId,
} from '@substrat-run/contracts';
import { SECURE_DELETE_MIN_SQLITE, searchIndexPlans, ulid, type ScopeHost, type ScopeStub } from '@substrat-run/kernel';
import type { ScopeHostFixture } from './scope-host-suite.js';
import { erasureMod, erasureModManifest, erasureOtherMod } from './erasure-module.js';

/** Raw SQL on one scope's own database, past `ctx.sql` — reads the FTS shadow tables. */
export type RawScopeQuery = (tenant: TenantId, scope: ScopeId, sql: string, params?: readonly unknown[]) => Promise<unknown[]>;

type Row = Record<string, unknown>;

export function subjectErasureContractSuite(
  adapterName: string,
  makeFixture: () => Promise<ScopeHostFixture>,
  raw: RawScopeQuery,
): void {
  describe(`subject erasure in a module's own tables (#2068): ${adapterName}`, () => {
    let fixture: ScopeHostFixture;
    let host: ScopeHost;
    let stub: ScopeStub;
    const t1 = tenantId.parse(ulid());
    const s1 = scopeId.parse(ulid());
    /** A scope nothing in this suite writes to: the erasure there holds nothing for anyone. */
    const subjectErasureFreshScope = scopeId.parse(ulid());
    const staff = platformActorId.parse(ulid());
    const alice = principalId.parse(ulid());
    const indexTable = searchIndexPlans(erasureModManifest.id, erasureModManifest.searchables)[0]!.indexTable;

    const subject = (): DataSubjectId => dataSubjectId.parse(ulid());
    const put = (sql: string, params: (string | null)[] = []) => stub.invoke('erasure/put', { sql, params });
    const read = (sql: string, params: (string | null)[] = []) => stub.invoke<Row[]>('erasure/read', { sql, params });
    const one = async (sql: string, params: (string | null)[] = []) => (await read(sql, params))[0];
    const errOf = async (call: Promise<unknown>): Promise<unknown> =>
      call.then(
        () => {
          throw new Error('expected a refusal, got an answer');
        },
        (e: unknown) => e,
      );
    const rowsFor = (receipt: SubjectShredReceipt, entityType: string) =>
      receipt.verticalRows.find((r) => r.module === erasureModManifest.id && r.entityType === entityType)?.rows;

    /** One subject's whole footprint in the module, with a decoy that belongs to someone else. */
    const seed = async (who: DataSubjectId, word = `w${ulid().toLowerCase()}`) => {
      const other = subject();
      const note = ulid();
      const edited = ulid();
      const decoy = ulid();
      await put('INSERT INTO er_people (id, email, name) VALUES (?, ?, ?)', [who, 'p@example.test', 'Pat Person']);
      await put('INSERT INTO er_people (id, email, name) VALUES (?, ?, ?)', [other, 'o@example.test', 'Other Person']);
      await put('INSERT INTO er_notes (id, author, editor, title, body) VALUES (?, ?, NULL, ?, ?)', [note, who, 'mine', `${word} they wrote`]);
      await put('INSERT INTO er_notes (id, author, editor, title, body) VALUES (?, ?, ?, ?, ?)', [edited, other, who, 'edited', 'edited by them']);
      await put('INSERT INTO er_notes (id, author, editor, title, body) VALUES (?, ?, NULL, ?, ?)', [decoy, other, 'theirs', `${word} someone else wrote`]);
      await put('INSERT INTO er_signups (id, kind, email) VALUES (?, ?, ?)', [who, 'news', `${who}@example.test`]);
      await put('INSERT INTO er_signups (id, kind, email) VALUES (?, ?, ?)', [other, 'news', `${other}@example.test`]);
      await put('INSERT INTO er_ratings (note_id, comment) VALUES (?, ?)', [note, 'great service']);
      await put('INSERT INTO er_ratings (note_id, comment) VALUES (?, ?)', [decoy, 'kept']);
      return { other, note, edited, decoy, word };
    };

    beforeAll(async () => {
      fixture = await makeFixture();
      host = fixture.host;
      host.registerModule(erasureMod);
      host.registerModule(erasureOtherMod);
      await host.admin.createTenant(staff, { id: t1, slug: `erasure-${t1.toLowerCase()}`, name: 'Erasure' });
      await host.admin.grantEntitlement(staff, t1, 'erasure');
      await host.provisionScope(staff, { tenantId: t1, scopeId: s1, vertical: 'erasure-vertical' });
      await host.admin.activateScope(staff, t1, s1);
      await host.provisionScope(staff, { tenantId: t1, scopeId: subjectErasureFreshScope, vertical: 'erasure-vertical' });
      await host.admin.activateScope(staff, t1, subjectErasureFreshScope);
      stub = await host.getScope(alice, t1, s1);
    });

    afterAll(async () => {
      await fixture.cleanup();
    });

    it('blanks every declared erasable column on every row a subject column names, and only those', async () => {
      const who = subject();
      const { other, note, edited, decoy } = await seed(who);

      const receipt = await host.admin.shredSubject(staff, t1, s1, who);

      // NULL where the field admits it, '' where it does not — the row and its keys stay.
      expect(await one('SELECT email, name FROM er_people WHERE id = ?', [who])).toEqual({ email: null, name: '' });
      expect(await one('SELECT title, body, author FROM er_notes WHERE id = ?', [note])).toEqual({ title: null, body: '', author: who });
      // The SECOND subject column reaches too: a note they edited is theirs to erase.
      expect(await one('SELECT title, body FROM er_notes WHERE id = ?', [edited])).toEqual({ title: null, body: '' });
      // Someone else's rows are untouched — an erasure that over-reaches is its own bug.
      expect(await one('SELECT email, name FROM er_people WHERE id = ?', [other])).toEqual({ email: 'o@example.test', name: 'Other Person' });
      expect(await one('SELECT title FROM er_notes WHERE id = ?', [decoy])).toEqual({ title: 'theirs' });

      expect(rowsFor(receipt, 'erperson')).toBe(1);
      expect(rowsFor(receipt, 'ernote')).toBe(2);
    });

    it('deletes a delete-mode row outright, and keeps the next subject\'s', async () => {
      const who = subject();
      const { other } = await seed(who);
      const receipt = await host.admin.shredSubject(staff, t1, s1, who);
      expect(await read('SELECT id FROM er_signups WHERE id = ?', [who])).toEqual([]);
      expect(await read('SELECT id FROM er_signups WHERE id = ?', [other])).toHaveLength(1);
      expect(receipt.verticalRows.find((r) => r.entityType === 'ersignup')).toMatchObject({ mode: 'delete', rows: 1 });
    });

    it("runs the module's hook for the link a row does not hold, and reports what it changed", async () => {
      const who = subject();
      const { note, decoy } = await seed(who);
      const receipt = await host.admin.shredSubject(staff, t1, s1, who);
      expect(await one('SELECT comment FROM er_ratings WHERE note_id = ?', [note])).toEqual({ comment: null });
      expect(await one('SELECT comment FROM er_ratings WHERE note_id = ?', [decoy])).toEqual({ comment: 'kept' });
      expect(receipt.hookRows).toContainEqual({ module: erasureModManifest.id, rows: 1 });
    });

    it('names every erasable entity nothing reaches, on every receipt', async () => {
      const receipt = await host.admin.shredSubject(staff, t1, s1, subject());
      expect(receipt.unreachedEntities).toContainEqual({ module: erasureModManifest.id, entityType: 'erloose' });
      // A declared entity is reported reached even when it held nothing — the zero is the fact.
      expect(rowsFor(receipt, 'erperson')).toBe(0);
      expect(receipt.unreachedEntities.find((u) => u.entityType === 'erperson')).toBeUndefined();
    });

    it('is idempotent — a re-run changes nothing and counts zero everywhere', async () => {
      const who = subject();
      await seed(who);
      const first = await host.admin.shredSubject(staff, t1, s1, who);
      expect(rowsFor(first, 'ernote')).toBe(2);
      const again = await host.admin.shredSubject(staff, t1, s1, who);
      for (const line of again.verticalRows.filter((r) => r.module === erasureModManifest.id)) expect(line.rows).toBe(0);
      expect(again.hookRows).toContainEqual({ module: erasureModManifest.id, rows: 0 });
    });

    it('takes the erased words out of the search index AND out of its stored segments', async () => {
      const who = subject();
      const theirs = subject();
      // One word only the subject wrote, one only someone else did. Checked by the word's random
      // TAIL: FTS5 stores a term prefix-compressed against its neighbour, so its leading bytes
      // may be shared, but a run of random characters at its end is stored as written.
      const word = (): string => `q${crypto.randomUUID().replace(/-/g, '')}`;
      const solo = word();
      const kept = word();
      await put('INSERT INTO er_notes (id, author, editor, title, body) VALUES (?, ?, NULL, NULL, ?)', [ulid(), who, `${solo} private`]);
      await put('INSERT INTO er_notes (id, author, editor, title, body) VALUES (?, ?, NULL, NULL, ?)', [ulid(), theirs, `${kept} public`]);
      const hits = async (term: string) => (await stub.invoke<unknown[]>('erasure/search', { term })).length;
      const stored = async (term: string) =>
        (
          (await raw(t1, s1, `SELECT count(*) AS n FROM ${indexTable}_data WHERE instr(block, CAST(? AS BLOB)) > 0`, [
            term.slice(-12),
          ])) as { n: number }[]
        )[0]!.n;

      // The positive twin: before, the word is found and its bytes are in the segments — so the
      // scan below can see a term when there is one to see.
      expect(await hits(solo)).toBe(1);
      expect(await stored(solo)).toBeGreaterThan(0);

      await host.admin.shredSubject(staff, t1, s1, who);

      // Gone from the results AND from the stored segments: a plain FTS5 delete leaves the term
      // in the older segment until a merge, readable by anyone with the database file.
      expect(await hits(solo)).toBe(0);
      expect(await stored(solo)).toBe(0);
      // The index still works for everyone else.
      expect(await hits(kept)).toBe(1);
      expect(await stored(kept)).toBeGreaterThan(0);
    });

    it(`runs on SQLite ${SECURE_DELETE_MIN_SQLITE}+: the index it deleted from is at FTS5 format 5, and still reads`, async () => {
      // The proof of the floor on the runtime this adapter actually runs — a Durable Object will
      // not answer `sqlite_version()`, so the format the index is left at is the evidence: only
      // an FTS5 with secure-delete (3.42.0+) writes version 5, and the same runtime then reading
      // the index back is the reader that matters (a dump never carries the index).
      const who = subject();
      const kept = `q${crypto.randomUUID().replace(/-/g, '')}`;
      await seed(who);
      await put('INSERT INTO er_notes (id, author, editor, title, body) VALUES (?, ?, NULL, NULL, ?)', [ulid(), subject(), kept]);
      await host.admin.shredSubject(staff, t1, s1, who);
      const version = (await raw(t1, s1, `SELECT v FROM ${indexTable}_config WHERE k = 'version'`)) as { v: number }[];
      expect(version).toEqual([{ v: 5 }]);
      expect(await stub.invoke<unknown[]>('erasure/search', { term: kept })).toHaveLength(1);
      // Named where the runtime will say it, for the record in the test log.
      const named = await raw(t1, s1, 'SELECT sqlite_version() AS v').then(
        (rows) => (rows as { v: string }[])[0]!.v,
        () => 'not exposed',
      );
      console.info(`[#2068] ${adapterName}: SQLite ${named}, FTS5 index format ${version[0]!.v}`);
    });

    it('switches secure-delete on only for an index whose table it changes, and leaves it off', async () => {
      const configOf = async () =>
        (await raw(t1, s1, `SELECT v FROM ${indexTable}_config WHERE k = 'secure-delete'`)) as { v: number }[];
      // An erasure that holds nothing here never touches the index: the switch leaves a row in
      // the index's config that SQLite lets nobody remove, so a scope the erasure is not about
      // must read exactly as it did — a fork or restore rebuilds the index without that row.
      const fresh = subjectErasureFreshScope;
      await host.admin.shredSubject(staff, t1, fresh, subject());
      expect(await raw(t1, fresh, `SELECT k FROM ${indexTable}_config WHERE k = 'secure-delete'`)).toEqual([]);
      // One that changed a searchable row switched it on for the erasure, and off again after.
      const who = subject();
      await seed(who);
      await host.admin.shredSubject(staff, t1, s1, who);
      expect((await configOf()).map((c) => c.v)).toEqual([0]);
    });

    describe('a hook that fails', () => {
      /** A subject with a classified event, a sealed copy and module rows — everything an erasure reaches. */
      const armed = async (kind: string) => {
        const who = subject();
        await seed(who);
        await stub.invoke('erasure/emit', { subject: who, secret: 'said-about-them' });
        const [sealed] = await host.admin.sealSubjectPayloads(staff, t1, s1, [{ subjectId: who, plaintext: 'in the backup' }]);
        await put('INSERT INTO er_bombs (subject, kind) VALUES (?, ?)', [who, kind]);
        return { who, sealed: sealed! };
      };
      /** Nothing was erased: the module rows, the spine payload and the key all survive. */
      const intact = async (who: DataSubjectId, sealed: Awaited<ReturnType<typeof armed>>['sealed']) => {
        expect(await one('SELECT email FROM er_people WHERE id = ?', [who])).toEqual({ email: 'p@example.test' });
        expect(await read('SELECT id FROM er_signups WHERE id = ?', [who])).toHaveLength(1);
        const spine = (await raw(t1, s1, 'SELECT payload FROM _substrat_outbox WHERE subject_id = ?', [who])) as {
          payload: string | null;
        }[];
        expect(spine[0]?.payload).toContain('said-about-them');
        expect(await host.admin.openSubjectPayloads(staff, t1, s1, [{ subjectId: who, sealed }])).toEqual(['in the backup']);
      };

      it('refuses the whole erasure — module rows, spine and key all survive — and a re-run once fixed converges', async () => {
        const { who, sealed } = await armed('throw');
        await expect(host.admin.shredSubject(staff, t1, s1, who)).rejects.toThrow(/the hook failed half-way/);
        await intact(who, sealed);

        // The positive twin: with the fault removed, the same erasure completes and reaches all three.
        await put('DELETE FROM er_bombs WHERE subject = ?', [who]);
        const receipt = await host.admin.shredSubject(staff, t1, s1, who);
        expect(receipt.eventsRedacted).toBe(1);
        expect(rowsFor(receipt, 'erperson')).toBe(1);
        expect(await one('SELECT email FROM er_people WHERE id = ?', [who])).toEqual({ email: null });
        expect(await host.admin.openSubjectPayloads(staff, t1, s1, [{ subjectId: who, sealed }])).toEqual([null]);
      });

      for (const [kind, what] of [
        ['spine', 'a read of the spine'],
        ['foreign', "a read of another module's table"],
        ['pragma', 'a PRAGMA'],
        ['chained', "a write to another module's table chained after its own"],
      ] as const) {
        it(`refuses ${what} from inside the hook, before it runs, and erases nothing`, async () => {
          const { who, sealed } = await armed(kind);
          const err = await errOf(host.admin.shredSubject(staff, t1, s1, who));
          expect(errorCodeOf(err)).toBe('forbidden');
          expect(String((err as Error).message)).toMatch(/onSubjectErased/);
          await intact(who, sealed);
        });
      }

      it('refuses a hook that returns a promise — it must run inside the one transaction', async () => {
        const { who, sealed } = await armed('async');
        const err = await errOf(host.admin.shredSubject(staff, t1, s1, who));
        expect(errorCodeOf(err)).toBe('precondition_failed');
        await intact(who, sealed);
      });
    });
  });
}
