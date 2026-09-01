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
  permissionKey,
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
    const walkAll = async (params: Record<string, unknown>, limit: number): Promise<string[]> => {
      const seen: string[] = [];
      let cursor: string | undefined;
      for (let guard = 0; guard < 50; guard++) {
        const got = await page({ ...params, limit, cursor });
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
        { id: '01B', number: '1002', status: 'open', kind: 'repair' },
        { id: '01C', number: '1003', status: 'open', kind: 'service' },
        { id: '01D', number: '1004', status: 'closed', kind: 'repair' },
        { id: '01E', number: '1005', status: 'open', kind: 'service' },
        { id: '01F', number: '1006', status: 'closed', kind: 'service' },
      ];
      for (const r of rows) await stub.invoke('list/add', r);
    });

    afterAll(async () => {
      await fixture.cleanup();
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
  });
}
