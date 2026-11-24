/**
 * Contract suite for subject access (GDPR Art. 15, D-74): `HostAdmin.readSubject` reads exactly
 * what `shredSubject` erases, on every adapter.
 *
 * The property is parity, and it is what turns "everything erasure reaches, access reads" from a
 * claim into a gate (`docs/rfc/subject-access.md` §3.1). For a subject never erased, the read is
 * walked to its end and the subject is then shredded on the same scope:
 *
 * - the events with `piiClass != 'none'` and a payload equal `eventsRedacted`;
 * - per declared `blank` entity, the rows holding a value in an erasable field equal its
 *   `verticalRows` line, and per `delete` entity every row read does;
 * - `unreachedEntities` is the same list on both.
 *
 * The read being walked BEFORE the shred is also what proves it wrote nothing: a read that blanked
 * or redacted anything would leave the shred counting less than the read found.
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
  type SubjectEvent,
  type SubjectReadPage,
  type SubjectRecords,
  type SubjectShredReceipt,
} from '@substrat-run/contracts';
import { ulid, type ScopeHost, type ScopeStub } from '@substrat-run/kernel';
import type { ScopeHostFixture } from './scope-host-suite.js';
import { erasureMod, erasureModManifest, erasureOtherMod } from './erasure-module.js';

type Row = Record<string, unknown>;

/** Every page of one subject's read, folded: events in order, each entity's rows concatenated. */
interface Walked {
  pages: number;
  events: SubjectEvent[];
  records: Map<string, SubjectRecords>;
  first: SubjectReadPage;
}

export function subjectAccessContractSuite(adapterName: string, makeFixture: () => Promise<ScopeHostFixture>): void {
  describe(`subject access reads what erasure reaches (D-74): ${adapterName}`, () => {
    let fixture: ScopeHostFixture;
    let host: ScopeHost;
    let stub: ScopeStub;
    const t1 = tenantId.parse(ulid());
    const s1 = scopeId.parse(ulid());
    const staff = platformActorId.parse(ulid());
    const alice = principalId.parse(ulid());
    const who: DataSubjectId = dataSubjectId.parse(ulid());
    const other: DataSubjectId = dataSubjectId.parse(ulid());
    let before: Walked;
    let after: Walked;
    let receipt: SubjectShredReceipt;

    const put = (sql: string, params: (string | null)[] = []) => stub.invoke('erasure/put', { sql, params });
    const emit = (subject: string, secret: string, piiClass?: 'none') =>
      stub.invoke('erasure/emit', { subject, secret, ...(piiClass ? { piiClass } : {}) });

    const walk = async (subject: string, limit?: number): Promise<Walked> => {
      const records = new Map<string, SubjectRecords>();
      const events: SubjectEvent[] = [];
      let first: SubjectReadPage | undefined;
      let cursor: string | undefined;
      let pages = 0;
      do {
        const page = await host.admin.readSubject(staff, t1, s1, subject, {
          ...(cursor ? { cursor } : {}),
          ...(limit ? { limit } : {}),
        });
        first ??= page;
        pages += 1;
        events.push(...page.events);
        for (const r of page.records) {
          const held = records.get(r.entityType);
          if (held) held.rows.push(...r.rows);
          else records.set(r.entityType, { ...r, rows: [...r.rows] });
        }
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
      return { pages, events, records, first: first! };
    };

    beforeAll(async () => {
      fixture = await makeFixture();
      host = fixture.host;
      host.registerModule(erasureMod);
      host.registerModule(erasureOtherMod);
      await host.admin.createTenant(staff, { id: t1, slug: `access-${t1.toLowerCase()}`, name: 'Access' });
      await host.admin.grantEntitlement(staff, t1, 'erasure');
      await host.provisionScope(staff, { tenantId: t1, scopeId: s1, vertical: 'erasure-vertical' });
      await host.admin.activateScope(staff, t1, s1);
      stub = await host.getScope(alice, t1, s1);

      // The subject's whole footprint, beside someone else's that must never be read for them.
      const note = ulid();
      await put('INSERT INTO er_people (id, email, name) VALUES (?, ?, ?)', [who, 'p@example.test', 'Pat Person']);
      await put('INSERT INTO er_people (id, email, name) VALUES (?, ?, ?)', [other, 'o@example.test', 'Other Person']);
      await put('INSERT INTO er_notes (id, author, editor, title, body) VALUES (?, ?, NULL, ?, ?)', [note, who, 'mine', 'they wrote']);
      await put('INSERT INTO er_notes (id, author, editor, title, body) VALUES (?, ?, ?, ?, ?)', [ulid(), other, who, 'edited', 'edited by them']);
      await put('INSERT INTO er_notes (id, author, editor, title, body) VALUES (?, ?, NULL, ?, ?)', [ulid(), other, 'theirs', 'someone else wrote']);
      // Already blank, so a blank erasure has nothing left to do there: read, and not counted.
      await put('INSERT INTO er_notes (id, author, editor, title, body) VALUES (?, ?, NULL, NULL, ?)', [ulid(), who, '']);
      await put('INSERT INTO er_signups (id, kind, email) VALUES (?, ?, ?)', [who, 'news', `${who}@example.test`]);
      await put('INSERT INTO er_signups (id, kind, email) VALUES (?, ?, ?)', [other, 'news', `${other}@example.test`]);
      await put('INSERT INTO er_ratings (note_id, comment) VALUES (?, ?)', [note, 'great service']);
      await emit(who, 'first secret');
      await emit(who, 'second secret');
      await emit(who, 'nothing personal', 'none');
      await emit(other, 'their secret');

      before = await walk(who);
      receipt = await host.admin.shredSubject(staff, t1, s1, who);
      after = await walk(who);
    });

    afterAll(async () => {
      await fixture.cleanup();
    });

    it('reads, before an erasure, exactly what the erasure then erases', () => {
      const classified = before.events.filter((e) => e.piiClass !== 'none' && !e.erased);
      expect(classified.length).toBeGreaterThan(0);
      expect(classified).toHaveLength(receipt.eventsRedacted);

      const declared = erasureModManifest.erasure!.entities.filter((e) => e.mode === 'blank' || e.mode === 'delete');
      for (const entity of declared) {
        const rows = before.records.get(entity.entityType)?.rows ?? [];
        const holding =
          entity.mode === 'delete'
            ? rows
            : rows.filter((row: Row) => entity.fields.some((f) => row[f.name] !== f.blank));
        const line = receipt.verticalRows.find((r) => r.entityType === entity.entityType);
        expect({ entity: entity.entityType, rows: holding.length }).toEqual({ entity: entity.entityType, rows: line?.rows });
      }
      expect(receipt.verticalRows.reduce((n, r) => n + r.rows, 0)).toBeGreaterThan(0);
      expect(before.first.unreachedEntities).toEqual(receipt.unreachedEntities);
    });

    it('returns every event keyed to the subject, a none-class one and an erased one as their envelopes', () => {
      expect(after.events.map((e) => e.id)).toEqual(before.events.map((e) => e.id));
      expect(after.events.map((e) => [e.piiClass, e.erased, e.payload === null])).toEqual([
        ['pseudonymous', true, true],
        ['pseudonymous', true, true],
        ['none', false, false],
      ]);
      expect(after.events.every((e) => e.subjectId === who && e.entity.entityType === 'erperson')).toBe(true);
    });

    it("reads only the subject's rows, whole, and names what it cannot read", () => {
      const notes = before.records.get('ernote')!;
      expect(notes).toMatchObject({ module: erasureModManifest.id, mode: 'blank', subjects: ['author', 'editor'], erasable: ['body', 'title'] });
      expect(notes.rows).toHaveLength(3);
      expect(notes.rows.every((r: Row) => r.author === who || r.editor === who)).toBe(true);
      // After the erasure the blanked rows are still the subject's; the deleted ones are gone, and the
      // entity is still listed, with no rows, because it was looked at.
      expect(after.records.get('ernote')!.rows.map((r: Row) => r.title)).toEqual([null, null, null]);
      expect(after.records.get('ersignup')!.rows).toEqual([]);
      expect(after.first.hookEntities).toEqual([{ module: erasureModManifest.id, entityType: 'errating' }]);
    });

    it('pages one item at a time to the same answer, and refuses a cursor it never issued', async () => {
      const paged = await walk(who, 1);
      const items = after.events.length + [...after.records.values()].reduce((n, r) => n + r.rows.length, 0);
      expect(paged.pages).toBeGreaterThanOrEqual(items);
      expect(paged.events.map((e) => e.id)).toEqual(after.events.map((e) => e.id));
      expect([...paged.records.values()].map((r) => [r.entityType, r.rows])).toEqual(
        [...after.records.values()].map((r) => [r.entityType, r.rows]),
      );
      const refused = await host.admin.readSubject(staff, t1, s1, who, { cursor: 'x:1' }).catch((e: unknown) => e);
      expect(errorCodeOf(refused)).toBe('validation_failed');
    });

    it('pages rows by key, so a row written or deleted between pages repeats or skips no other (#3303)', async () => {
      // Its own subject, so the writes here change nothing another test reads.
      const mover = dataSubjectId.parse(ulid());
      const base = ulid();
      const note = (suffix: string) =>
        put('INSERT INTO er_notes (id, author, editor, title, body) VALUES (?, ?, NULL, ?, ?)', [`${base}-${suffix}`, mover, suffix, 'x']);
      for (const suffix of ['b', 'c', 'd']) await note(suffix);

      const first = await host.admin.readSubject(staff, t1, s1, mover, { limit: 1 });
      const read = first.records.flatMap((r) => r.rows.map((row: Row) => row.title));
      expect(read).toEqual(['b']);
      expect(first.records.find((r) => r.entityType === 'ernote')?.paging).toBe('key');
      // Between pages: the row already read goes, and one lands on each side of the cursor. Offset
      // paging would now skip 'c' and read 'a', which is written behind where it resumes.
      await put('DELETE FROM er_notes WHERE id = ?', [`${base}-b`]);
      await note('a');
      await note('e');

      let cursor = first.nextCursor;
      while (cursor) {
        const page = await host.admin.readSubject(staff, t1, s1, mover, { cursor, limit: 1 });
        read.push(...page.records.filter((r) => r.entityType === 'ernote').flatMap((r) => r.rows.map((row: Row) => row.title)));
        cursor = page.nextCursor;
      }
      expect(read).toEqual(['b', 'c', 'd', 'e']);
    });

    it('refuses a reaped scope rather than reading back nothing held', async () => {
      const gone = scopeId.parse(ulid());
      await host.provisionScope(staff, { tenantId: t1, scopeId: gone, vertical: 'erasure-vertical' });
      await host.admin.activateScope(staff, t1, gone);
      await host.admin.archiveScope(staff, t1, gone);
      await host.admin.reapScope(staff, t1, gone, { force: true });
      const refused = await host.admin.readSubject(staff, t1, gone, who).catch((e: unknown) => e);
      expect(errorCodeOf(refused)).toBe('conflict');
    });
  });
}
