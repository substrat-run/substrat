/**
 * Contract suite for the handlers the platform derives from a declaration (#1773).
 *
 * What it pins: **a derived handler owes what a hand-written one owes**, on each adapter's SQL.
 * The declared check comes first, so a caller without the key learns `permission_denied` and nothing about
 * whether the row exists. A missing row is `not_found`. A PATCH writes only the fields sent, and
 * `null` clears. The host's 412 holds in front of it. Every write emits one event whose payload
 * is the declared fields of the row as written. A page is scoped to its parent and walks whole,
 * and a parent that does not exist is `not_found` (#2157). A create mints the id, fills the parent
 * link and links the row to it, stamps the time and the caller, and answers the row that already
 * holds its natural key without writing (#2157).
 *
 * The DEFAULT tuple checker, so a denial is a real one: `dave` holds no key at all, and every
 * refusal has its positive twin from `alice`, who holds both.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  defineEntities,
  defineOperations,
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
import { z } from 'zod';
import type { ScopeHostFixture } from './scope-host-suite.js';
import { derivedMod } from './derived-module.js';

const KEYS = ['dnote:read', 'dnote:write'].map((k) => permissionKey.parse(k));
type Note = { id: string; dfolder_id: string; title: string; body: string | null; rank: number };
type Tag = {
  id: string;
  dfolder_id: string;
  label: string;
  note: string | null;
  created_at: string;
  created_by: string;
};

export function derivedHandlersContractSuite(adapterName: string, makeFixture: () => Promise<ScopeHostFixture>): void {
  describe(`derived handlers (#1773): ${adapterName}`, () => {
    let fixture: ScopeHostFixture;
    let host: ScopeHost;
    const t = tenantId.parse(ulid());
    const s = scopeId.parse(ulid());
    const staff = platformActorId.parse(ulid());
    const alice: PrincipalId = principalId.parse(ulid());
    const dave: PrincipalId = principalId.parse(ulid());
    const carl: PrincipalId = principalId.parse(ulid());
    let as: ScopeStub;
    let asDave: ScopeStub;
    let asCarl: ScopeStub;
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
      return { id, dfolder_id: folderId, title, body, rank };
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
      await host.admin.assignRole(staff, { principalId: carl, roleKey: 'derived-admin', node: { tenantId: t, scopeId: null } });
      await host.provisionScope(staff, { tenantId: t, scopeId: s, vertical: 'derived-vertical' });
      await host.admin.activateScope(staff, t, s);
      as = await host.getScope(alice, t, s);
      asDave = await host.getScope(dave, t, s);
      asCarl = await host.getScope(carl, t, s);
      await as.invoke('derived/add-folder', { id: 'fa', name: 'A' });
      await as.invoke('derived/add-folder', { id: 'fb', name: 'B' });
      await as.invoke('derived/add-folder', { id: 'fc', name: 'C, empty' });
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
        expect(await walk({ dfolderId: 'fb' }, 2)).toEqual(byRank(inB));
      });

      it('counts the scoped set when the declaration asks for a total', async () => {
        const page = await as.invoke<CountedPage<Note>>('derived/list-notes', { dfolderId: 'fb', limit: 2 });
        expect(page.total).toBe(inB.length);
      });

      it('applies a declared filter beside the parent, and none when it is absent', async () => {
        expect(await walk({ dfolderId: 'fb', title: 'x' }, 1)).toEqual(byRank(inB.filter((n) => n.title === 'x')));
        expect(await walk({ dfolderId: 'fb' }, 50)).toHaveLength(inB.length);
      });

      it('is permission_denied to a caller without the key', async () => {
        expect(await codeOf(asDave.invoke('derived/list-notes', { dfolderId: 'fb' }))).toBe('permission_denied');
      });

      it('answers not_found for a parent that does not exist, and an empty page for one with no rows (#2157)', async () => {
        const list = (who: ScopeStub, dfolderId: string) => who.invoke<CountedPage<Note>>('derived/list-notes', { dfolderId });
        expect(await codeOf(list(as, 'nope'))).toBe('not_found');
        expect(await messageOf(list(as, 'nope'))).toContain('dfolder not found: nope');
        expect(await list(as, 'fc')).toMatchObject({ entries: [], nextCursor: null, total: 0 });
        // Checked first: a caller without the key learns nothing about whether the parent exists.
        expect(await codeOf(list(asDave, 'nope'))).toBe('permission_denied');
      });
    });

    describe('create (#2157)', () => {
      const create = (who: ScopeStub, input: Record<string, unknown>) => who.invoke<Tag>('derived/create-tag', input);
      const getTag = (who: ScopeStub, tagId: string) => who.invoke<Tag>('derived/get-tag', { tagId });
      const isoNow = (value: string) => !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value;
      /** Neither adapter's fixture moves its clock, so `ctx.now()` is the wall clock around the call. */
      const during = async <T>(call: () => Promise<T>): Promise<{ result: T; from: string; to: string }> => {
        const from = new Date().toISOString();
        const result = await call();
        return { result, from, to: new Date().toISOString() };
      };

      it('inserts the row: a minted id, the parent link, the input, NULL for what was left out, the stamps', async () => {
        const { result: tag, from, to } = await during(() => create(as, { dfolderId: 'fa', label: 'red' }));
        expect(tag.created_at >= from && tag.created_at <= to).toBe(true);
        expect(tag).toEqual({
          id: expect.any(String),
          dfolder_id: 'fa',
          label: 'red',
          note: null,
          created_at: expect.any(String),
          created_by: alice,
        });
        expect(isoNow(tag.created_at)).toBe(true);
        expect(tag.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
        expect(await getTag(as, tag.id)).toEqual(tag);
      });

      it('emits one event about the new row, its payload the declared fields as written', async () => {
        const tag = await create(as, { dfolderId: 'fa', label: 'green', note: 'n' });
        const events = (await history(tag.id)).filter((e) => e.type === 'dtag.created');
        expect(events).toHaveLength(1);
        expect(events[0]?.payload).toEqual({
          id: tag.id,
          dfolder_id: 'fa',
          label: 'green',
          created_at: tag.created_at,
          created_by: alice,
        });
      });

      it('answers the row already holding the natural key, unchanged, with no write and no event', async () => {
        const first = await create(as, { dfolderId: 'fa', label: 'blue', note: 'first' });
        const again = await create(asCarl, { dfolderId: 'fa', label: 'blue', note: 'second' });
        expect(again).toEqual(first);
        expect((await history(first.id)).filter((e) => e.type === 'dtag.created')).toHaveLength(1);
        // The key is the pair: the same label under another folder is another row.
        const elsewhere = await create(as, { dfolderId: 'fb', label: 'blue' });
        expect(elsewhere.id).not.toBe(first.id);
      });

      it('answers not_found for a parent that does not exist, and denied first to a caller without the key', async () => {
        expect(await codeOf(create(as, { dfolderId: 'nope', label: 'x' }))).toBe('not_found');
        expect(await messageOf(create(as, { dfolderId: 'nope', label: 'x' }))).toContain('dfolder not found: nope');
        expect(await codeOf(create(asDave, { dfolderId: 'nope', label: 'x' }))).toBe('permission_denied');
        expect(await codeOf(create(asDave, { dfolderId: 'fa', label: 'daves' }))).toBe('permission_denied');
        // Nothing was written by the refusals: the label is still free in that folder.
        expect((await create(as, { dfolderId: 'fa', label: 'daves' })).created_by).toBe(alice);
      });

      it('links the new row to its parent, so a grant on the folder reaches the tag', async () => {
        const reader: PrincipalId = principalId.parse(ulid());
        await host.admin.grant(staff, {
          principalId: reader,
          permission: permissionKey.parse('dnote:read'),
          node: { tenantId: t, scopeId: s },
          entity: { entityType: 'dfolder', entityId: 'fa' },
          grantedBy: alice,
        });
        const asReader = await host.getScope(reader, t, s);
        const inA = await create(as, { dfolderId: 'fa', label: 'linked' });
        const inB = await create(as, { dfolderId: 'fb', label: 'linked' });
        expect(await getTag(asReader, inA.id)).toEqual(inA);
        expect(await codeOf(getTag(asReader, inB.id))).toBe('permission_denied');
      });

      // The round-1 review's reproduction (#2162): a key without the folder let a caller holding
      // write on folder A replay folder B's row by guessing its label, and read it in full. Such a
      // declaration no longer loads; the fixture's key includes the link, and stays in its folder.
      it('a natural key without the parent link is refused at load, so a replay cannot cross parents', async () => {
        const crossing = defineEntities({
          folder: { table: 'x_folders', fields: z.object({ id: z.string() }) },
          item: {
            table: 'x_items',
            fields: z.object({ id: z.string(), folder_id: z.string(), label: z.string(), secret: z.string() }),
            parents: ['folder'],
            key: ['label'],
          },
        });
        const declare = () =>
          defineOperations(crossing, ['item:write'] as const)({
            'x/create-item': {
              summary: 'Add an item',
              derive: 'create',
              permission: { key: 'item:write', entity: 'folder', idFrom: 'folderId' },
              input: z.object({ folderId: z.string(), label: z.string(), secret: z.string() }),
              output: crossing.item.fields,
              http: { method: 'POST', path: '/folders/{folderId}/items' },
              emits: { entity: 'item', entityIdFrom: 'id', type: 'x.item-created', schemaVersion: 1, piiClass: 'none', payload: ['id'] },
            },
          });
        expect(declare).toThrow("its natural key does not include the link to 'folder' ('folder_id')");
        // The twin, on this adapter: the same label in another folder is that folder's own row.
        const inA = await create(as, { dfolderId: 'fa', label: 'payroll', note: 'salaries.xlsx' });
        const inB = await create(asCarl, { dfolderId: 'fb', label: 'payroll', note: 'guess' });
        expect(inB.id).not.toBe(inA.id);
        expect(inB).toMatchObject({ dfolder_id: 'fb', note: 'guess' });
      });

      it('creates scope-wide with no parent, and without a natural key every call is a new row', async () => {
        const one = await as.invoke<{ id: string; name: string }>('derived/create-label', { name: 'same' });
        const two = await as.invoke<{ id: string; name: string }>('derived/create-label', { name: 'same' });
        expect(one).toEqual({ id: expect.any(String), name: 'same' });
        expect(two.id).not.toBe(one.id);
        expect(await codeOf(asDave.invoke('derived/create-label', { name: 'x' }))).toBe('permission_denied');
      });

      it('a derived update by someone else leaves the create stamps as they were', async () => {
        const tag = await create(as, { dfolderId: 'fa', label: 'restamped' });
        const changed = await asCarl.invoke<Tag>('derived/update-tag', { tagId: tag.id, note: 'by carl' });
        expect(changed).toEqual({ ...tag, note: 'by carl' });
        const events = (await history(tag.id)).filter((e) => e.type === 'dtag.updated');
        expect(events[0]?.payload).toEqual({ id: tag.id, note: 'by carl', created_by: alice });
      });
    });

    // The check is on the entity the declaration names, not the scope: a principal holding the
    // key on ONE row (or one parent) reaches that row and no other. A check that dropped the
    // entity would deny the twins below, since an entity-narrowed grant is no node-level grant.
    describe('entity-narrowed grants', () => {
      const nina: PrincipalId = principalId.parse(ulid());
      const fran: PrincipalId = principalId.parse(ulid());
      let asNina: ScopeStub;
      let asFran: ScopeStub;
      let n1: Note;
      let n2: Note;
      const narrow = (principal: PrincipalId, key: string, entityType: string, entityId: string) =>
        host.admin.grant(staff, {
          principalId: principal,
          permission: permissionKey.parse(key),
          node: { tenantId: t, scopeId: s },
          entity: { entityType, entityId },
          grantedBy: alice,
        });
      const update = (who: ScopeStub, noteId: string, title: string) =>
        who.invoke<Note>('derived/update-note', { noteId, title });
      const del = (who: ScopeStub, noteId: string) => who.invoke('derived/delete-note', { noteId });
      const list = (who: ScopeStub, folderId: string) =>
        who.invoke<CountedPage<Note>>('derived/list-notes', { dfolderId: folderId, limit: 50 });

      beforeAll(async () => {
        n1 = await addNote('fa', 'mine', 61);
        n2 = await addNote('fa', 'theirs', 62);
        await narrow(nina, 'dnote:read', 'dnote', n1.id);
        await narrow(nina, 'dnote:write', 'dnote', n1.id);
        await narrow(fran, 'dnote:read', 'dfolder', 'fa');
        asNina = await host.getScope(nina, t, s);
        asFran = await host.getScope(fran, t, s);
      });

      it('get: the granted row answers, its sibling is denied', async () => {
        expect(await get(asNina, n1.id)).toEqual(n1);
        expect(await codeOf(get(asNina, n2.id))).toBe('permission_denied');
      });

      it('update: the granted row is written, its sibling is denied and left alone', async () => {
        expect((await update(asNina, n1.id, 'mine, edited')).title).toBe('mine, edited');
        expect(await codeOf(update(asNina, n2.id, 'not yours'))).toBe('permission_denied');
        expect(await get(as, n2.id)).toEqual(n2);
      });

      it('delete: the sibling is denied and stays, the granted row goes', async () => {
        expect(await codeOf(del(asNina, n2.id))).toBe('permission_denied');
        expect(await get(as, n2.id)).toEqual(n2);
        expect(await del(asNina, n1.id)).toEqual({ id: n1.id, deleted: true });
      });

      it('list: the granted folder pages, the other folder is denied', async () => {
        const page = await list(asFran, 'fa');
        expect(page.entries.map((n) => n.id)).toContain(n2.id);
        expect(page.entries.every((n) => n.dfolder_id === 'fa')).toBe(true);
        expect(await codeOf(list(asFran, 'fb'))).toBe('permission_denied');
      });
    });
  });
}
