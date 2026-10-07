/**
 * Contract suite for `ctx.page` — the kernel-composed paged read (#811, K-18).
 *
 * What it pins: **a declaration is enough.** A module says which columns are
 * sortable and filterable and gets a correct keyset walk in every scope, on every
 * adapter, over indexes it never wrote — with the count matching the filter and
 * the cursor never skipping or repeating a row.
 *
 * The assertions are behavioural rather than structural, and that is the point
 * here more than anywhere: the failure this feature exists to prevent — a walk
 * that drops rows tied on a non-unique sort column — produces SQL that reads
 * perfectly. A string comparison against the emitted `WHERE` would have called
 * the broken version a pass, which is the lesson the FK that shipped behind
 * passing string assertions already taught once.
 *
 * So `status` in the fixture is deliberately non-unique, and the walks below run
 * at page sizes that force ties to straddle a page boundary.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  errorCodeOf,
  permissionKey,
  PAGE_CURSOR_RESTART,
  pageVisible,
  platformActorId,
  principalId,
  scopeId,
  tenantId,
  type CountedPage,
  type Page,
  type PrincipalId,
} from '@substrat-run/contracts';
import { ulid, type ScopeHost, type ScopeStub } from '@substrat-run/kernel';
import type { ScopeHostFixture } from './scope-host-suite.js';
import { listMod } from './modules.js';

const PERM_USE = permissionKey.parse('list:use');
/** A ULID that sorts just after the fixture's `01B` — a legacy cursor's id must be a ULID. */
const AFTER_01B = '01BX5ZZKBKACTAV9WEVGEMMVRZ';

type Row = Record<string, unknown>;

export function listContractSuite(
  adapterName: string,
  makeFixture: () => Promise<ScopeHostFixture>,
): void {
  describe(`paged reads (ctx.page): ${adapterName}`, () => {
    let fixture: ScopeHostFixture;
    let host: ScopeHost;
    let stub: ScopeStub;
    const t1 = tenantId.parse(ulid());
    const alice: PrincipalId = principalId.parse(ulid());
    const staff = platformActorId.parse(ulid());

    const page = (params: Record<string, unknown>) =>
      stub.invoke<Page<Row> | CountedPage<Row>>('list/page', params);

    /** Walk the whole list one page at a time, following the cursor as a client would. */
    const walkAll = async (
      params: Record<string, unknown>,
      limit: number,
      operation = 'list/page',
    ): Promise<string[]> => {
      const seen: string[] = [];
      let cursor: string | undefined;
      for (let guard = 0; guard < 50; guard++) {
        const got = await stub.invoke<Page<Row>>(operation, { ...params, limit, cursor });
        seen.push(...got.entries.map((r) => String(r['id'])));
        if (got.nextCursor === null) return seen;
        cursor = got.nextCursor;
      }
      throw new Error('walk did not terminate — the cursor is not advancing');
    };

    beforeAll(async () => {
      fixture = await makeFixture();
      host = fixture.host;
      host.registerModule(listMod);
      await host.admin.createTenant(staff, { id: t1, slug: 'list-tenant', name: 'List Tenant' });
      await host.admin.grantEntitlement(staff, t1, 'list');
      await host.admin.defineRole(staff, t1, {
        key: 'list-admin',
        permissions: [PERM_USE],
        source: 'vertical',
      });
      await host.admin.assignRole(staff, {
        principalId: alice,
        roleKey: 'list-admin',
        node: { tenantId: t1, scopeId: null },
      });
      const source = scopeId.parse(ulid());
      await host.provisionScope(staff, { tenantId: t1, scopeId: source, vertical: 'list-vertical' });
      await host.admin.activateScope(staff, t1, source);
      stub = await host.getScope(alice, t1, source);

      // Six rows, four `open`. Ids ascend with numbers so a walk by id and a walk
      // by number agree — which makes a DISAGREEMENT in the status walk meaningful.
      const rows = [
        { id: '01A', number: '1001', status: 'open', kind: 'repair' },
        { id: '01B', number: '1002', status: 'open', kind: 'repair', hold: 'held' },
        { id: '01C', number: '1003', status: 'open', kind: 'service' },
        { id: '01D', number: '1004', status: 'closed', kind: 'repair' },
        { id: '01E', number: '1005', status: 'open', kind: 'service' },
        { id: '01F', number: '1006', status: 'closed', kind: 'service', hold: 'held' },
      ];
      for (const r of rows) await stub.invoke('list/add', r);
    });

    afterAll(async () => {
      await fixture.cleanup();
    });

    it("returns each row's own cursor when asked, each resuming right after its row (#2073)", async () => {
      // On the tied `status` walk, and on a counted page: `pageVisible` hands on the cursor of
      // the row a page stops at, which may be any row, not only the last. Plain data, so it is
      // read here across the same boundary a host-side walk reads it across.
      for (const params of [{ sort: 'status' }, { sort: 'number', total: true }]) {
        const all = (await page({ ...params, limit: 50 })).entries.map((r) => String(r['id']));
        const got = await page({ ...params, limit: 4, rowCursors: true });
        expect(got.rowCursors, JSON.stringify(params)).toHaveLength(4);
        expect(got.rowCursors![3]).toBe(got.nextCursor);
        for (const [i, cursor] of got.rowCursors!.entries()) {
          const rest = await page({ ...params, limit: 50, cursor });
          expect(rest.entries.map((r) => String(r['id'])), `${JSON.stringify(params)} after row ${i}`).toEqual(all.slice(i + 1));
        }
        // Not asked, not there: an ordinary page is unchanged.
        expect('rowCursors' in (await page({ ...params, limit: 4 }))).toBe(false);
      }
    });

    it('defaults to the first declared sort, ascending', async () => {
      const got = await page({ limit: 50 });
      expect(got.entries.map((r) => r['number'])).toEqual([
        '1001',
        '1002',
        '1003',
        '1004',
        '1005',
        '1006',
      ]);
    });

    it('ends the walk with a null cursor on a short page', async () => {
      const got = await page({ limit: 50 });
      expect(got.nextCursor).toBeNull();
    });

    it('hands back a cursor when the page comes back full', async () => {
      const got = await page({ limit: 2 });
      expect(got.entries).toHaveLength(2);
      expect(got.nextCursor).not.toBeNull();
    });

    /**
     * The case the tie-break exists for. `status` has four `open` rows, so a walk
     * in pages of two puts a tie across every boundary; a keyset over the column
     * alone would emit `status > 'open'` and lose the rest of its own ties.
     */
    it('walks a NON-UNIQUE sort column without skipping or repeating a row', async () => {
      const seen = await walkAll({ sort: 'status' }, 2);
      expect(seen).toHaveLength(6);
      expect(new Set(seen).size).toBe(6);
    });

    it('walks a non-unique column identically at every page size', async () => {
      const byOne = await walkAll({ sort: 'status' }, 1);
      const byFour = await walkAll({ sort: 'status' }, 4);
      const whole = await walkAll({ sort: 'status' }, 50);
      expect(byOne).toEqual(whole);
      expect(byFour).toEqual(whole);
    });

    it('walks descending without skipping or repeating a row', async () => {
      const seen = await walkAll({ sort: 'status', order: 'desc' }, 2);
      expect(seen).toHaveLength(6);
      expect(new Set(seen).size).toBe(6);
      expect(seen).toEqual([...(await walkAll({ sort: 'status' }, 50))].reverse());
    });

    /**
     * #2001. A cursor replayed in a walk that did not mint it is refused, with the reason
     * that tells a client to read the first page again — never answered with a page.
     */
    const expectRestart = async (call: Promise<unknown>): Promise<void> => {
      const err: unknown = await call.then(() => undefined, (e: unknown) => e);
      expect(errorCodeOf(err), 'the replay was answered with a page').toBe('validation_failed');
      expect(err).toMatchObject({
        message: expect.stringMatching(/restart paging/),
        extensions: { reason: PAGE_CURSOR_RESTART },
      });
    };

    it('serves a declared desc when the caller names no order, and walks it to the end', async () => {
      const first = await stub.invoke<Page<Row>>('list/newest', { limit: 2 });
      expect(first.entries.map((r) => r['number'])).toEqual(['1006', '1005']);
      expect(await walkAll({}, 2, 'list/newest')).toEqual(['01F', '01E', '01D', '01C', '01B', '01A']);
    });

    it('lets an explicit order override the declared one', async () => {
      const got = await stub.invoke<Page<Row>>('list/newest', { limit: 50, order: 'asc' });
      expect(got.entries.map((r) => r['number'])).toEqual(['1001', '1002', '1003', '1004', '1005', '1006']);
    });

    it('hands back an opaque cursor that survives a query string untouched', async () => {
      const { nextCursor } = await page({ limit: 2 });
      expect(nextCursor).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(encodeURIComponent(nextCursor!)).toBe(nextCursor);
    });

    it('refuses a desc cursor replayed under asc, rather than re-serving rows already read', async () => {
      const first = await page({ limit: 2, order: 'desc' });
      await expectRestart(page({ limit: 2, order: 'asc', cursor: first.nextCursor }));
      // …and the declared-desc read's cursor, replayed with an explicit asc, likewise.
      const newest = await stub.invoke<Page<Row>>('list/newest', { limit: 2 });
      await expectRestart(stub.invoke('list/newest', { limit: 2, order: 'asc', cursor: newest.nextCursor }));
    });

    it('refuses a cursor replayed under another sort', async () => {
      const first = await page({ limit: 2, sort: 'number' });
      await expectRestart(page({ limit: 2, sort: 'status', cursor: first.nextCursor }));
    });

    /**
     * A bare position is a cursor minted before #2001, when every walk that took no order
     * was ascending by the first declared sort. Exactly there it continues, so a walk in
     * flight across the deploy keeps going; anywhere else it would replay silently, so it
     * is refused — above all under a declared `desc` default it was never minted in.
     */
    // The fixture's ids are short, and a legacy cursor is recognised only with a ULID id —
    // this one sorts just after `01B`, so the walk resumes where `01B`'s cursor would have.
    const LEGACY = `1002|${AFTER_01B}`;

    it('continues a pre-#2001 cursor in the ascending default walk it came from', async () => {
      const got = await page({ limit: 2, cursor: LEGACY });
      expect(got.entries.map((r) => r['id'])).toEqual(['01C', '01D']);
    });

    it('refuses a pre-#2001 cursor anywhere but that default walk', async () => {
      await expectRestart(stub.invoke('list/newest', { limit: 2, cursor: LEGACY }));
      await expectRestart(page({ limit: 2, order: 'desc', cursor: LEGACY }));
      await expectRestart(page({ limit: 2, sort: 'status', cursor: `open|${AFTER_01B}` }));
      // Not the exact old shape — an id that is no ULID — so not a position at all.
      await expectRestart(page({ limit: 2, cursor: '1002|01B' }));
    });

    it('filters by a declared column, and the filter survives the whole walk', async () => {
      const seen = await walkAll({ filters: { status: 'open' } }, 2);
      expect(seen).toEqual(['01A', '01B', '01C', '01E']);
    });

    it('applies two filters together', async () => {
      const got = await page({ limit: 50, filters: { status: 'open', kind: 'service' } });
      expect(got.entries.map((r) => r['id'])).toEqual(['01C', '01E']);
    });

    /**
     * A SET of permitted values, which is the narrowing a single `=` cannot state.
     * The case it exists for is an inbox that hides one terminal state by default:
     * "every status but `closed`" is four equalities, and four requests cannot be
     * paged as one list.
     */
    /**
     * `null` is the rows holding no value (#1088). It used to compose `hold = NULL`,
     * which is never true, so the read answered an empty page that looked like "none
     * match" while four rows did. The count follows the same `WHERE`, and the value
     * filter beside it still means its own rows only.
     */
    it('filters on null as IS NULL, through the whole walk and the count', async () => {
      const seen = await walkAll({ filters: { hold: null } }, 1);
      expect(seen).toEqual(['01A', '01C', '01D', '01E']);
      const counted = (await page({ limit: 1, filters: { hold: null }, total: true })) as CountedPage<Row>;
      expect(counted.total).toBe(4);
      const held = await walkAll({ filters: { hold: 'held' } }, 1);
      expect(held).toEqual(['01B', '01F']);
      const both = await walkAll({ filters: { hold: null, status: 'open' } }, 1);
      expect(both).toEqual(['01A', '01C', '01E']);
    });

    it('filters on a SET of values, and the set survives the whole walk', async () => {
      const seen = await walkAll({ filters: { status: ['open', 'closed'] } }, 2);
      expect(seen).toEqual(['01A', '01B', '01C', '01D', '01E', '01F']);
      const narrowed = await walkAll({ filters: { status: ['closed'] } }, 2);
      expect(narrowed).toEqual(['01D', '01F']);
    });

    it('composes a set filter with a scalar one, and counts the same set', async () => {
      const got = (await page({
        limit: 50,
        filters: { status: ['open', 'closed'], kind: 'service' },
        total: true,
      })) as CountedPage<Row>;
      expect(got.entries.map((r) => r['id'])).toEqual(['01C', '01E', '01F']);
      expect(got.total).toBe(3);
    });

    /**
     * #1741. A set filter bound one `?` per member, and the walk adds the cursor and the page
     * size to the same statement — so a caller-supplied set of 100 members was a statement
     * with 104 parameters, over the 100 a Durable Object allows, on a page that node ran
     * happily. Members that match nothing are the point: the set is wide, the answer is not.
     */
    it('filters on a set far wider than a statement may bind, through the whole walk', async () => {
      const wide = [...Array.from({ length: 300 }, (_, i) => `none-${i}`), 'closed'];
      const seen = await walkAll({ filters: { status: wide } }, 1);
      expect(seen).toEqual(['01D', '01F']);
      const counted = (await page({ limit: 1, filters: { status: wide }, total: true })) as CountedPage<Row>;
      expect(counted.total).toBe(2);
    });

    /**
     * A caller that narrowed to nothing asked for nothing. Dropping an empty clause
     * would hand back the WHOLE table instead — the widest possible answer to the
     * narrowest possible question, and a permission-shaped bug wherever the set is
     * computed from what the reader may see.
     */
    it('matches NO rows on an empty set, rather than every row', async () => {
      const got = (await page({ limit: 50, filters: { status: [] }, total: true })) as CountedPage<Row>;
      expect(got.entries).toEqual([]);
      expect(got.total).toBe(0);
    });

    it('refuses a set filter on a column the declaration does not offer', async () => {
      await expect(page({ limit: 2, filters: { number: ['1001'] } })).rejects.toThrow(
        /not a declared filter/,
      );
    });

    it('ignores an undefined filter rather than matching NULL', async () => {
      const got = await page({ limit: 50, filters: { status: undefined } });
      expect(got.entries).toHaveLength(6);
    });

    it('counts the FILTERED set, not the table', async () => {
      const got = (await page({ limit: 2, filters: { status: 'open' }, total: true })) as CountedPage<Row>;
      expect(got.total).toBe(4);
      expect(got.entries).toHaveLength(2);
    });

    /**
     * A total describes the set the filter selects, and a cursor selects a PAGE of
     * it. Narrowing the count by the cursor would make `1–20 of 340` count down as
     * the user walks, which is the kind of wrong nobody notices until a customer does.
     */
    it('does not narrow the total as the walk advances', async () => {
      const first = (await page({ limit: 2, filters: { status: 'open' }, total: true })) as CountedPage<Row>;
      const second = (await page({
        limit: 2,
        filters: { status: 'open' },
        total: true,
        cursor: first.nextCursor,
      })) as CountedPage<Row>;
      expect(second.total).toBe(4);
    });

    it('omits the total unless it was asked for', async () => {
      const got = await page({ limit: 2 });
      expect('total' in got).toBe(false);
    });

    it('refuses a sort the declaration does not offer', async () => {
      await expect(page({ limit: 2, sort: 'kind' })).rejects.toThrow(/not a declared sort/);
    });

    it('refuses a filter the declaration does not offer', async () => {
      await expect(page({ limit: 2, filters: { number: '1001' } })).rejects.toThrow(
        /not a declared filter/,
      );
    });

    it('refuses an entity type no module declared listable', async () => {
      await expect(
        stub.invoke('list/page-of', { entityType: 'nothing', limit: 2 }),
      ).rejects.toThrow(/declares no paged list/);
    });

    it('sees a row written in the same transaction', async () => {
      const got = (await stub.invoke('list/add-then-page', {
        id: '01Z',
        number: '1099',
        status: 'open',
        kind: 'repair',
      })) as Page<Row>;
      expect(got.entries.map((r) => r['id'])).toContain('01Z');
    });

    /**
     * Sort values a cursor has to carry intact (#2018 review): a pipe, dots and the
     * readable tag syntax an earlier draft used, unicode, and nothing at all. Walked one
     * row a page in both directions, so every one of them is a cursor at some point.
     * Last in the suite, because these rows join the table every walk above reads.
     */
    describe('hostile sort values', () => {
      const HOSTILE = ['', 'a.b.c', 'asc.number.a', 'desc.number.b', 'x|y', 'é😀'];
      const ids = HOSTILE.map(() => ulid());
      const hostile = { kind: 'hostile' };

      beforeAll(async () => {
        for (const [i, number] of HOSTILE.entries()) {
          await stub.invoke('list/add', { id: ids[i], number, status: 'open', kind: 'hostile' });
        }
      });

      it('walk one row a page, in both directions, without skipping or repeating', async () => {
        expect(await walkAll({ filters: hostile }, 1)).toEqual(ids);
        expect(await walkAll({ filters: hostile, order: 'desc' }, 1)).toEqual([...ids].reverse());
      });

      it('continue a pre-#2001 cursor with its whole value, tag syntax and pipes included', async () => {
        const after = async (cursor: string) =>
          (await page({ limit: 1, filters: hostile, cursor })).entries.map((r) => r['id']);
        expect(await after(`asc.number.a|${ids[2]}`)).toEqual([ids[3]]);
        expect(await after(`desc.number.b|${ids[3]}`)).toEqual([ids[4]]);
        expect(await after(`x|y|${ids[4]}`)).toEqual([ids[5]]);
        await expectRestart(page({ limit: 1, filters: hostile, order: 'desc', cursor: `desc.number.b|${ids[3]}` }));
      });
    });

    it('pageVisible across the RPC: a row written between calls is neither leaked nor skipped (#2073)', async () => {
      // The walk runs HERE, host-side, and every batch is a separate invoke into the scope —
      // the boundary across which a cursor read back with a second query could answer for
      // a row inserted in between. Visible rows are `v…`; everything else is refused.
      const kind = 'k2073';
      const add = (id: string, number: string) => stub.invoke('list/add', { id, number, status: 'open', kind });
      for (let n = 1; n <= 10; n++) await add(n === 3 ? 'v1' : n === 8 ? 'v2' : `h${n}`, String(5000 + n * 10));
      const idOf = (cursor: string) => {
        const b64 = cursor.replace(/-/g, '+').replace(/_/g, '/');
        const json = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0))));
        return String((json as { id?: string; value: string }).id ?? (json as { value: string }).value);
      };
      const params = { sort: 'number', filters: { kind } };
      let writes = 0;
      const fetch = async (p: { limit: number; cursor?: string; rowCursors: true }) => {
        const got = await page({ ...params, ...p });
        // After the first batch: a refused row before v1 and before v2, and a visible one between.
        if (writes++ === 0) {
          await add('h-before-v1', '5025');
          await add('v3', '5050');
          await add('h-before-v2', '5075');
        }
        return got;
      };
      const seen: string[] = [];
      let cursor: string | undefined;
      for (let guard = 0; guard < 20; guard++) {
        const got = await pageVisible(fetch, { limit: 1, cursor }, (r: Row) => String(r['id']).startsWith('v'));
        expect('rowCursors' in got).toBe(false);
        seen.push(...got.entries.map((r) => String(r['id'])));
        if (got.nextCursor === null) break;
        expect(idOf(got.nextCursor)).toBe(seen.at(-1)); // the visible row's own position
        cursor = got.nextCursor;
      }
      expect(seen).toEqual(['v1', 'v3', 'v2']);
    });

    it('resumes a sealed empty page past more than the scan budget, on this adapter (#2074)', async () => {
      for (const first of [0, 500, 1000, 1500, 2000]) {
        await stub.invoke('list/add-hidden-batch', { first, count: first === 2000 ? 5 : 500 });
      }
      await stub.invoke('list/add', { id: 'v2074', number: '002005', status: 'open', kind: 'k2074' });
      await stub.invoke('list/add', { id: 'v2074full', number: '003000', status: 'open', kind: 'k2074full' });
      const query = { limit: 1, sort: 'number', filters: { kind: 'k2074' } };
      const fullQuery = { limit: 1, sort: 'number', filters: { kind: 'k2074full' } };
      const session = await host.admin.beginImpersonation(staff, {
        tenantId: t1, scopeId: stub.scopeId, principal: alice,
        reason: 'verify sparse read-only paging', mode: 'read-only',
      });
      const readOnly = await host.getImpersonatedScope(session.id, t1, stub.scopeId);
      const plain = await readOnly.invoke<Page<Row>>('list/page-visible', fullQuery);
      expect(plain.entries.map((r) => r['id'])).toEqual(['v2074full']);
      expect(plain.nextCursor).not.toMatch(/^sc1\./);
      expect(await readOnly.invoke<Page<Row>>('list/page-visible', query))
        .toEqual({ entries: [], nextCursor: null });
      const first = await stub.invoke<Page<Row>>('list/page-visible', query);
      expect(first.entries).toEqual([]);
      expect(first.nextCursor).toMatch(/^sc1\./);
      expect(first.nextCursor).not.toContain('h001999');
      expect((await readOnly.invoke<Page<Row>>('list/page-visible', fullQuery)).nextCursor).toMatch(/^sc1\./);
      const other = await host.getScope(principalId.parse(ulid()), t1, stub.scopeId);
      await expectRestart(other.invoke('list/page-visible', { ...query, cursor: first.nextCursor }));
      await expectRestart(stub.invoke('list/page-visible', {
        ...query, filters: { kind: 'repair' }, cursor: first.nextCursor,
      }));
      const second = await stub.invoke<Page<Row>>('list/page-visible', { ...query, cursor: first.nextCursor });
      expect(second.entries.map((r) => r['id'])).toEqual(['v2074']);
      expect(second.nextCursor).toMatch(/^sc1\./);
    });
  });
}
