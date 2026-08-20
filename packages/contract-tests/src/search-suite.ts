/**
 * Contract suite for `ctx.search` — the derived FTS index (#827).
 *
 * What it pins: **a declaration is enough.** A module says which entity and
 * which fields are searchable and gets a working index in every scope, on every
 * adapter, maintained by whoever writes the row — including a writer that has
 * never heard of the index.
 *
 * The assertions are deliberately behavioural rather than structural. An earlier
 * draft of the emitter produced SQL that read correctly and failed at prepare
 * time (`MATCH` takes the table's own name, so aliasing the FTS table breaks it),
 * which a string comparison would have called a pass — the same lesson as the FK
 * that shipped behind passing string assertions. So every case here provisions a
 * real scope, writes real rows, and asks a real question.
 *
 * It is also where the two hosts are held to the same answer. Durable Object
 * SQLite and better-sqlite3 both ship FTS5, but only one of them has a
 * `SqlStorageRegulator` deciding whether a trigger may run at all — a fact no
 * amount of local green would have surfaced.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  permissionKey,
  platformActorId,
  principalId,
  scopeId,
  tenantId,
  type PrincipalId,
} from '@substrat-run/contracts';
import { ulid, type ScopeHost, type ScopeStub } from '@substrat-run/kernel';
import type { ScopeHostFixture } from './scope-host-suite.js';
import { searchMod } from './modules.js';

const PERM_USE = permissionKey.parse('search:use');

interface Hit {
  entityType: string;
  id: string;
  rank: number;
}

export function searchContractSuite(
  adapterName: string,
  makeFixture: () => Promise<ScopeHostFixture>,
): void {
  describe(`search (ctx.search): ${adapterName}`, () => {
    let fixture: ScopeHostFixture;
    let host: ScopeHost;
    let stub: ScopeStub;
    let source: ReturnType<typeof scopeId.parse>;
    const t1 = tenantId.parse(ulid());
    const alice: PrincipalId = principalId.parse(ulid());
    const staff = platformActorId.parse(ulid());

    const find = (entityType: string, term: string, limit?: number) =>
      stub.invoke<Hit[]>('search/find', { entityType, term, limit });
    const ids = async (entityType: string, term: string, limit?: number) =>
      (await find(entityType, term, limit)).map((h) => h.id);

    beforeAll(async () => {
      fixture = await makeFixture();
      host = fixture.host;
      host.registerModule(searchMod);
      await host.admin.createTenant(staff, { id: t1, slug: 'search-tenant', name: 'Search Tenant' });
      await host.admin.grantEntitlement(staff, t1, 'search');
      await host.admin.defineRole(staff, t1, {
        key: 'search-admin',
        permissions: [PERM_USE],
        source: 'vertical',
      });
      await host.admin.assignRole(staff, {
        principalId: alice,
        roleKey: 'search-admin',
        node: { tenantId: t1, scopeId: null },
      });
      source = scopeId.parse(ulid());
      await host.provisionScope(staff, { tenantId: t1, scopeId: source, vertical: 'search-vertical' });
      await host.admin.activateScope(staff, t1, source);
      stub = await host.getScope(alice, t1, source);
      await stub.invoke('search/add', { id: 'c1', number: '1001', name: 'Andersson Fastigheter AB' });
      await stub.invoke('search/add', { id: 'c2', number: '1002', name: 'Bergqvist & Söner' });
      await stub.invoke('search/add', { id: 'c3', number: '1003', name: 'Cederlund Andersson VVS' });
    });

    afterAll(async () => {
      await fixture.cleanup();
    });

    // -- the headline case ---------------------------------------------------

    it('finds a row by a prefix of one word in a declared field', async () => {
      await expect(ids('searchcustomer', 'anders')).resolves.toEqual(
        expect.arrayContaining(['c1', 'c3']),
      );
    });

    it('finds by a second declared field — the number, not just the name', async () => {
      await expect(ids('searchcustomer', '1002')).resolves.toEqual(['c2']);
    });

    /**
     * The case that changed the emitter. Prefixing only the LAST term is the
     * obvious rule and it silently returns nothing here: `unicode61` indexes
     * whole words, so "fast" matches "Fastigheter" only as a prefix.
     */
    it('treats EVERY term as a prefix, so a half-typed first word still matches', async () => {
      await expect(ids('searchcustomer', 'anders fast')).resolves.toEqual(['c1']);
    });

    it('ranks by relevance, not by insertion order', async () => {
      const hits = await find('searchcustomer', 'andersson');
      expect(hits.map((h) => h.id).sort()).toEqual(['c1', 'c3']);
      // bm25 is negative and lower is better; the suite pins the ORDER it implies.
      expect(hits[0]!.rank).toBeLessThanOrEqual(hits[1]!.rank);
    });

    it('matches non-ASCII text as typed', async () => {
      await expect(ids('searchcustomer', 'söner')).resolves.toEqual(['c2']);
    });

    // -- what a person can type ----------------------------------------------

    /**
     * FTS5's query language has operators and a picker's input is a name. Someone
     * searching for `AND` must get rows or nothing — never a syntax error, and
     * never a match they did not ask for.
     */
    it('treats query syntax as literal text rather than as operators', async () => {
      await expect(find('searchcustomer', 'AND "x* OR')).resolves.toEqual([]);
      await expect(ids('searchcustomer', 'bergqvist OR anders')).resolves.toEqual([]);
    });

    it('refuses a term below the index floor instead of scanning the scope', async () => {
      await expect(find('searchcustomer', 'a')).rejects.toThrow(/shorter than 2/);
    });

    it('refuses an entity type no module declared searchable', async () => {
      await expect(find('nosuchentity', 'anders')).rejects.toThrow(/declares no searchable fields/);
    });

    // -- the index stays in step ---------------------------------------------

    it('sees a row written by a caller that knows nothing about the index', async () => {
      await stub.invoke('search/add', { id: 'c4', number: '1004', name: 'Dahlgren El' });
      await expect(ids('searchcustomer', 'dahlgren')).resolves.toEqual(['c4']);
    });

    it('drops the old text on update and carries the new', async () => {
      await stub.invoke('search/rename', { id: 'c4', name: 'Ekström El' });
      await expect(find('searchcustomer', 'dahlgren')).resolves.toEqual([]);
      await expect(ids('searchcustomer', 'ekström')).resolves.toEqual(['c4']);
    });

    it('forgets a deleted row', async () => {
      await stub.invoke('search/remove', { id: 'c4' });
      await expect(find('searchcustomer', 'ekström')).resolves.toEqual([]);
    });

    /**
     * The guarantee that decided triggers over indexing off the event spine. An
     * eventually-consistent index makes this case fail for a second or two — long
     * enough that the picker a user hits right after creating a customer is empty,
     * which is the bug report. Stripe documents exactly this caveat; we do not
     * have to inherit it.
     */
    it('is readable in the SAME transaction that wrote the row', async () => {
      const hits = await stub.invoke<Hit[]>('search/add-then-find', {
        id: 'c5',
        number: '1005',
        name: 'Forsberg Fastighetsservice',
        term: 'forsberg',
      });
      expect(hits.map((h) => h.id)).toEqual(['c5']);
    });

    // -- the declared tokenizer actually differs ------------------------------

    describe('tokenizer', () => {
      beforeAll(async () => {
        await stub.invoke('search/add-note', { id: 'n1', body: 'Nyckelskåpet vid entrén' });
      });

      it('substring matches INSIDE a word, which prefix does not', async () => {
        await expect(ids('searchnote', 'skåp')).resolves.toEqual(['n1']);
        // The same query shape against the prefix-tokenized entity finds nothing:
        // 'ndersson' is inside 'Andersson' but is not a prefix of any token.
        await expect(find('searchcustomer', 'ndersson')).resolves.toEqual([]);
      });

      it('applies the substring floor of three characters', async () => {
        await expect(find('searchnote', 'ny')).rejects.toThrow(/shorter than 3/);
      });
    });

    // -- a fork carries the rows, and rebuilds the index ----------------------

    /**
     * The index is derived data, and the dump treats it that way: excluded on
     * export (its shadow tables cannot be replayed — the DO host rejects the name,
     * and D1's own exporter refuses a database containing an fts5 table at all),
     * rebuilt on import from the rows that just landed.
     *
     * What this pins is the part a user would notice: a forked scope searches
     * immediately, with nobody re-indexing it by hand.
     */
    it('survives a fork — the copy searches without a manual re-index', async () => {
      const dump = await host.admin.exportScope(staff, t1, source);
      expect(dump.tables.some((t) => t.name.startsWith('_substrat_search_'))).toBe(false);
      // The rows themselves are in the dump; it is the index over them that is not.
      const customers = dump.tables.find((t) => t.name === 'search_customers');
      expect(customers?.rows.length).toBeGreaterThan(0);

      const copyId = scopeId.parse(ulid());
      await host.importScope(
        staff,
        { tenantId: t1, scopeId: copyId, vertical: 'search-vertical' },
        dump,
      );
      const copy = await host.getScope(alice, t1, copyId);
      const hits = await copy.invoke<Hit[]>('search/find', {
        entityType: 'searchcustomer',
        term: 'anders',
      });
      expect(hits.map((h) => h.id).sort()).toEqual(['c1', 'c3']);

      // And the triggers came back with it: the copy indexes its OWN later writes.
      await copy.invoke('search/add', { id: 'c9', number: '1009', name: 'Gustafsson Rör' });
      const later = await copy.invoke<Hit[]>('search/find', {
        entityType: 'searchcustomer',
        term: 'gustafsson',
      });
      expect(later.map((h) => h.id)).toEqual(['c9']);
    });

    // -- the cap is the pagination story --------------------------------------

    it('caps the result set rather than pretending to paginate a ranked read', async () => {
      await expect(ids('searchcustomer', 'anders', 1)).resolves.toHaveLength(1);
    });
  });
}
