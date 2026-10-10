/**
 * Contract suite for the handlers the platform derives from a declaration (#1773).
 *
 * What it pins: **a derived handler owes what a hand-written one owes**, on each adapter's SQL.
 * The declared check comes first, so a caller without the key learns `permission_denied` and nothing about
 * whether the row exists. A missing row is `not_found`. A PATCH writes only the fields sent, and
 * `null` clears. The host's 412 holds in front of it. Every write emits one event whose payload
 * is the declared fields of the row as written. A page is scoped to its parent and walks whole.
 *
 * The DEFAULT tuple checker, so a denial is a real one: `dave` holds no key at all, and every
 * refusal has its positive twin from `alice`, who holds both.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  errorCodeOf,
  etagOf,
  permissionKey,
  platformActorId,
  principalId,
  scopeId,
  tenantId,
  type CountedPage,
  type HistoryEntry,
  type PrincipalId,
} from '@substrat-run/contracts';
import { ulid, type ScopeHost, type ScopeStub } from '@substrat-run/kernel';
import type { ScopeHostFixture } from './scope-host-suite.js';
import { derivedMod } from './derived-module.js';

const KEYS = ['dnote:read', 'dnote:write'].map((k) => permissionKey.parse(k));
type Note = { id: string; folder_id: string; title: string; body: string | null; rank: number };

export function derivedHandlersContractSuite(adapterName: string, makeFixture: () => Promise<ScopeHostFixture>): void {
  describe(`derived handlers (#1773): ${adapterName}`, () => {
    let fixture: ScopeHostFixture;
    let host: ScopeHost;
    const t = tenantId.parse(ulid());
    const s = scopeId.parse(ulid());
    const staff = platformActorId.parse(ulid());
    const alice: PrincipalId = principalId.parse(ulid());
    const dave: PrincipalId = principalId.parse(ulid());
    let as: ScopeStub;
    let asDave: ScopeStub;
    /** Every version the host reported, newest last — what an HTTP mount would set as `ETag`. */
    let tags: (string | null)[] = [];
    const sink = { onEntityVersion: (version: string | null) => tags.push(version) };

    const codeOf = (call: Promise<unknown>): Promise<string | undefined> =>
      call.then(
        () => 'answered',
        (e: unknown) => errorCodeOf(e),
      );
    const messageOf = (call: Promise<unknown>): Promise<string> =>
      call.then(
        () => 'answered',
        (e: unknown) => (e as Error).message,
      );
    const addNote = async (folderId: string, title: string, rank: number, body: string | null = 'b'): Promise<Note> => {
      const id = ulid();
      await as.invoke('derived/add-note', { id, folderId, title, body, rank });
      return { id, folder_id: folderId, title, body, rank };
    };
    const history = async (noteId: string): Promise<HistoryEntry[]> =>
      (await as.invoke<{ entries: HistoryEntry[] }>('derived/history', { noteId })).entries;
    const get = (who: ScopeStub, noteId: string) => who.invoke<Note>('derived/get-note', { noteId });

    beforeAll(async () => {
      fixture = await makeFixture();
      host = fixture.host;
      host.registerModule(derivedMod);
      await host.admin.createTenant(staff, { id: t, slug: 'derived-tenant', name: 'Derived Tenant' });
      await host.admin.grantEntitlement(staff, t, 'derived');
      await host.admin.defineRole(staff, t, { key: 'derived-admin', permissions: KEYS, source: 'vertical' });
      await host.admin.assignRole(staff, { principalId: alice, roleKey: 'derived-admin', node: { tenantId: t, scopeId: null } });
      await host.provisionScope(staff, { tenantId: t, scopeId: s, vertical: 'derived-vertical' });
      await host.admin.activateScope(staff, t, s);
      as = await host.getScope(alice, t, s);
      asDave = await host.getScope(dave, t, s);
      await as.invoke('derived/add-folder', { id: 'fa', name: 'A' });
      await as.invoke('derived/add-folder', { id: 'fb', name: 'B' });
    });

    afterAll(async () => {
      await fixture.cleanup();
    });

    describe('get', () => {
      it('answers the row, every declared column of it', async () => {
        const n = await addNote('fa', 'one', 1, null);
        expect(await get(as, n.id)).toEqual(n);
      });

      it('answers not_found for a missing row, in the words a hand-written read uses', async () => {
        expect(await codeOf(get(as, 'missing'))).toBe('not_found');
        expect(await messageOf(get(as, 'missing'))).toContain('dnote not found: missing');
      });

      it('checks first: a caller without the key is denied, whether or not the row exists', async () => {
        const n = await addNote('fa', 'two', 2);
        expect(await codeOf(get(asDave, n.id))).toBe('permission_denied');
        expect(await codeOf(get(asDave, 'missing'))).toBe('permission_denied');
      });
    });

    describe('update', () => {
      const update = (who: ScopeStub, input: Record<string, unknown>, ifMatch?: string) =>
        who.invoke<Note>('derived/update-note', input, { ...sink, ...(ifMatch === undefined ? {} : { ifMatch }) });

      it('writes only the fields sent, and answers with the row as written', async () => {
        const n = await addNote('fa', 'before', 3, 'kept');
        const after = await update(as, { noteId: n.id, title: 'after' });
        expect(after).toEqual({ ...n, title: 'after' });
        expect(await get(as, n.id)).toEqual({ ...n, title: 'after' });
      });

      it('clears a nullable column on an explicit null, and leaves the rest alone', async () => {
        const n = await addNote('fa', 'clear', 4, 'goes');
        expect(await update(as, { noteId: n.id, body: null, rank: 40 })).toEqual({ ...n, body: null, rank: 40 });
      });

      it('emits one event, its payload the declared fields of the row as written', async () => {
        const n = await addNote('fa', 'evt', 5);
        await update(as, { noteId: n.id, title: 'evt2' });
        const events = (await history(n.id)).filter((e) => e.type === 'dnote.updated');
        expect(events).toHaveLength(1);
        expect(events[0]?.payload).toEqual({ id: n.id, title: 'evt2', body: 'b', rank: 5 });
      });

      it('writes nothing and emits nothing when no field is sent', async () => {
        const n = await addNote('fa', 'idle', 6);
        const before = (await history(n.id)).length;
        expect(await update(as, { noteId: n.id })).toEqual(n);
        expect(await history(n.id)).toHaveLength(before);
      });

      it('is refused with precondition_failed on a stale tag, and leaves the row as it was', async () => {
        const n = await addNote('fa', 'race', 7);
        tags = [];
        await update(as, { noteId: n.id, title: 'first' });
        const stale = tags.at(-1);
        expect(typeof stale).toBe('string');
        await update(as, { noteId: n.id, title: 'second' }, etagOf(stale as string));
        expect(await codeOf(update(as, { noteId: n.id, title: 'lost' }, etagOf(stale as string)))).toBe('precondition_failed');
        expect((await get(as, n.id)).title).toBe('second');
      });

      it('answers not_found for a missing row, and denied first to a caller without the key', async () => {
        expect(await codeOf(update(as, { noteId: 'missing', title: 'x' }))).toBe('not_found');
        const n = await addNote('fa', 'guarded', 8);
        expect(await codeOf(update(asDave, { noteId: n.id, title: 'x' }))).toBe('permission_denied');
        expect(await codeOf(update(asDave, { noteId: 'missing', title: 'x' }))).toBe('permission_denied');
        expect((await get(as, n.id)).title).toBe('guarded');
      });
    });

    describe('delete', () => {
      const del = (who: ScopeStub, noteId: string) => who.invoke('derived/delete-note', { noteId });

      it('removes the row, answers { id, deleted }, and emits about it', async () => {
        const n = await addNote('fa', 'bye', 9);
        expect(await del(as, n.id)).toEqual({ id: n.id, deleted: true });
        expect(await codeOf(get(as, n.id))).toBe('not_found');
        const events = (await history(n.id)).filter((e) => e.type === 'dnote.deleted');
        expect(events).toHaveLength(1);
        expect(events[0]?.payload).toEqual({ id: n.id });
      });

      it('answers not_found for a missing row, and denied first to a caller without the key', async () => {
        expect(await codeOf(del(as, 'missing'))).toBe('not_found');
        const n = await addNote('fa', 'stays', 10);
        expect(await codeOf(del(asDave, n.id))).toBe('permission_denied');
        expect(await codeOf(del(asDave, 'missing'))).toBe('permission_denied');
        expect(await get(as, n.id)).toEqual(n);
      });
    });

    describe('list', () => {
      let inB: Note[];

      beforeAll(async () => {
        // Folder B alone, ranks out of insertion order, two titles shared — so the walk's order,
        // its parent scope and its filter are each visible.
        inB = [];
        for (const [title, rank] of [['x', 30], ['y', 10], ['x', 20], ['z', 50], ['y', 40]] as const) {
          inB.push(await addNote('fb', title, rank));
        }
      });

      const walk = async (input: Record<string, unknown>, limit: number): Promise<Note[]> => {
        const seen: Note[] = [];
        let cursor: string | undefined;
        for (let guard = 0; guard < 20; guard++) {
          const page = await as.invoke<CountedPage<Note>>('derived/list-notes', { ...input, limit, cursor });
          seen.push(...page.entries);
          if (page.nextCursor === null) return seen;
          cursor = page.nextCursor;
        }
        throw new Error('walk did not terminate — the cursor is not advancing');
      };
      const byRank = (rows: Note[]) => [...rows].sort((a, b) => a.rank - b.rank);

      it("walks the parent's rows whole, in the declared order, across pages", async () => {
        expect(await walk({ folderId: 'fb' }, 2)).toEqual(byRank(inB));
      });

      it('counts the scoped set when the declaration asks for a total', async () => {
        const page = await as.invoke<CountedPage<Note>>('derived/list-notes', { folderId: 'fb', limit: 2 });
        expect(page.total).toBe(inB.length);
      });

      it('applies a declared filter beside the parent, and none when it is absent', async () => {
        expect(await walk({ folderId: 'fb', title: 'x' }, 1)).toEqual(byRank(inB.filter((n) => n.title === 'x')));
        expect(await walk({ folderId: 'fb' }, 50)).toHaveLength(inB.length);
      });

      it('is permission_denied to a caller without the key', async () => {
        expect(await codeOf(asDave.invoke('derived/list-notes', { folderId: 'fb' }))).toBe('permission_denied');
      });
    });
  });
}
