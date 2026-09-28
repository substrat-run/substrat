import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  connectionId,
  permissionKey,
  platformActorId,
  principalId,
  scopeId,
  tenantId,
  type PrincipalId,
  type ScopeDump,
  type ScopeId,
} from '@substrat-run/contracts';
import { ulid, type ScopeHost } from '@substrat-run/kernel';
import type { ScopeHostFixture } from './scope-host-suite.js';
import { permMod } from './modules.js';

const PERM_READ = permissionKey.parse('perm:read');

/**
 * #1869: which tuples a restore, fork or snapshot re-points at the scope it lands in.
 *
 * A scope-level grant is stored as `scope:<scopeId>`, naming the scope a dump was captured
 * from, so a copy landing elsewhere must move it. An entity-narrowed grant is stored as
 * `<entityType>:<entityId>` and must not move. The rewrite used to select with
 * `LIKE 'scope:%'`, which ignores ASCII case, so an entity grant typed `Scope` or `SCOPE`
 * became a grant on the whole destination scope. The write verbs refuse such a type since
 * #1856, so the rows are planted through the dump itself, the way a pre-#1856 scope holds
 * them.
 *
 * Each case asserts the stored rows (byte for byte, every column) AND the checker's answer,
 * with its twin: the genuine scope-level grant still resolves at the destination.
 *
 * The fixture must use the adapter's DEFAULT checker, as `permissionContractSuite` does.
 */
export function scopeRepointContractSuite(adapterName: string, makeFixture: () => Promise<ScopeHostFixture>): void {
  describe(`scope grant re-point on restore, fork and snapshot (#1869): ${adapterName}`, () => {
    let fixture: ScopeHostFixture;
    let host: ScopeHost;
    const staff = platformActorId.parse(ulid());
    const t = tenantId.parse(ulid());
    const source = scopeId.parse(ulid());
    // gina holds a genuine role on the source scope; the others hold entity-narrowed reads
    // whose entity type is a kernel namespace, spelled three ways.
    const gina = principalId.parse(ulid());
    const hana = principalId.parse(ulid()); // Scope:<source>
    const ivan = principalId.parse(ulid()); // SCOPE:<source>
    const jack = principalId.parse(ulid()); // scope:e-1
    // Two more shapes spine SQL matched with LIKE (#1869 (c)): a role relation spelled
    // `Role:`, and a connection subject spelled `Connection:`, beside the genuine one.
    const kate = principalId.parse(ulid()); // Role:reader on the scope
    const realConnection = connectionId.parse(ulid());
    const casedConnection = connectionId.parse(ulid());
    const casedRelation = connectionId.parse(ulid()); // `Granted:` rather than `granted:`
    let planted: ScopeDump;

    const tuplesOf = (dump: ScopeDump) => {
      const table = dump.tables.find((tb) => tb.name === '_substrat_tuples');
      expect(table).toBeDefined();
      return table!;
    };
    /** Every tuple `dump` holds for `who`, as whole rows keyed by column — the byte-for-byte view. */
    const rowsIn = (dump: ScopeDump, who: PrincipalId): Record<string, unknown>[] => {
      const table = tuplesOf(dump);
      return table.rows
        .map((r) => Object.fromEntries(table.columns.map((c, i) => [c, r[i]])))
        .filter((r) => r.subject === `principal:${who}`);
    };
    const rowsFor = async (scope: ScopeId, who: PrincipalId) => rowsIn(await host.admin.exportScope(staff, t, scope), who);
    const allowed = async (who: PrincipalId, scope: ScopeId): Promise<boolean> => {
      const stub = await host.getScope(who, t, scope);
      const out = await stub.invoke<{ allowed: boolean }>('perm/probe', { permission: PERM_READ });
      return out.allowed;
    };
    const blank = async (): Promise<ScopeId> => {
      const id = scopeId.parse(ulid());
      await host.provisionScope(staff, { tenantId: t, scopeId: id, vertical: 'repoint-vertical' });
      await host.admin.activateScope(staff, t, id);
      return id;
    };
    /** The planted grants, read back from `scope`, must equal what the dump carried. */
    const expectEntityGrantsKept = async (scope: ScopeId) => {
      for (const who of [hana, ivan, jack]) {
        const want = rowsIn(planted, who);
        expect(want).toHaveLength(1);
        expect(await rowsFor(scope, who)).toEqual(want);
        // …and none of them reads the scope node: the grant stayed on its entity.
        expect(await allowed(who, scope)).toBe(false);
      }
    };
    /** `planted` with its tuples rows (and optionally the table's DDL) rewritten. */
    const variant = (rows: (rows: unknown[][]) => unknown[][], ddl?: (ddl: string) => string): ScopeDump => ({
      ...planted,
      tables: planted.tables.map((tb) =>
        tb.name === '_substrat_tuples' ? { ...tb, rows: rows(tb.rows), ddl: ddl ? ddl(tb.ddl) : tb.ddl } : tb,
      ),
    });
    const tuplesAt = async (scope: ScopeId) => tuplesOf(await host.admin.exportScope(staff, t, scope)).rows;
    const expectGenuineGrantMoved = async (scope: ScopeId) => {
      const rows = await rowsFor(scope, gina);
      expect(rows.map((r) => r.object)).toEqual([`scope:${scope}`]);
      expect(await allowed(gina, scope)).toBe(true);
    };

    beforeAll(async () => {
      fixture = await makeFixture();
      host = fixture.host;
      host.registerModule(permMod);
      await host.admin.createTenant(staff, { id: t, slug: `repoint-${t.toLowerCase()}`, name: 'Repoint Co' });
      await host.admin.grantEntitlement(staff, t, 'perm');
      await host.admin.defineRole(staff, t, { key: 'reader', permissions: [PERM_READ], source: 'vertical' });
      await host.provisionScope(staff, { tenantId: t, scopeId: source, vertical: 'repoint-vertical' });
      await host.admin.activateScope(staff, t, source);
      await host.admin.assignRole(staff, { principalId: gina, roleKey: 'reader', node: { tenantId: t, scopeId: source } });

      // The source's own dump, with three pre-#1856 rows added to its tuples. Every column the
      // table has is written, so the byte-for-byte comparison covers them all.
      const dump = await host.admin.exportScope(staff, t, source);
      const table = tuplesOf(dump);
      const row = (subject: string, object: string, relation = `granted:${PERM_READ}`) =>
        table.columns.map((c) => (c === 'subject' ? subject : c === 'relation' ? relation : c === 'object' ? object : null));
      planted = {
        ...dump,
        tables: dump.tables.map((tb) =>
          tb === table
            ? {
                ...tb,
                rows: [
                  ...tb.rows,
                  row(`principal:${hana}`, `Scope:${source}`),
                  row(`principal:${ivan}`, `SCOPE:${source}`),
                  row(`principal:${jack}`, 'scope:e-1'),
                  row(`principal:${kate}`, `scope:${source}`, 'Role:reader'),
                  row(`connection:${realConnection}`, `scope:${source}`),
                  row(`Connection:${casedConnection}`, `scope:${source}`),
                  row(`connection:${casedRelation}`, `scope:${source}`, `Granted:${PERM_READ}`),
                ],
              }
            : tb,
        ),
      };
      // The genuine grant is in the dump, naming the source.
      expect(rowsIn(planted, gina).map((r) => r.object)).toEqual([`scope:${source}`]);
    }, 60_000);

    afterAll(async () => {
      await fixture?.cleanup();
    });

    it('a restore into another scope moves the source grant and nothing typed Scope, SCOPE or scope', async () => {
      const dest = await blank();
      await host.restoreScope(staff, t, dest, planted);
      await expectGenuineGrantMoved(dest);
      await expectEntityGrantsKept(dest);
    });

    it('a relation spelled Role: expands no role, and a subject spelled Connection: is no connection grant', async () => {
      const dest = await blank();
      await host.restoreScope(staff, t, dest, planted);
      // Both rows sit on the scope node, so both moved with it…
      expect((await rowsFor(dest, kate)).map((r) => [r.relation, r.object])).toEqual([['Role:reader', `scope:${dest}`]]);
      // …and the walk still reads `Role:` as no role at all. Twin: gina's `role:reader` does.
      expect(await allowed(kate, dest)).toBe(false);
      expect(await allowed(gina, dest)).toBe(true);
      // The read-back reports what the checker enforces: the genuine connection, not the cased one.
      const reported = (await host.connectionGrantsInScope(t, dest)).map((g) => g.connectionId);
      expect(reported).toContain(realConnection);
      expect(reported).not.toContain(casedConnection);
      expect(reported).not.toContain(casedRelation);
    });

    it('a dump declaring the object column COLLATE NOCASE does not make the match fold case again', async () => {
      const nocase = variant(
        (rows) => rows,
        (ddl) => {
          const out = ddl.replace(/\bobject TEXT NOT NULL\b/, 'object TEXT NOT NULL COLLATE NOCASE');
          expect(out).not.toBe(ddl);
          return out;
        },
      );
      const dest = await blank();
      await host.restoreScope(staff, t, dest, nocase);
      await expectGenuineGrantMoved(dest);
      await expectEntityGrantsKept(dest);
    });

    it('a restored dump holding grants on a third scope is refused, and the target keeps what it held', async () => {
      const third = scopeId.parse(ulid());
      const lena = principalId.parse(ulid()); // holds a role on the third scope
      const stray = tuplesOf(planted).columns.map((c) =>
        c === 'subject' ? `principal:${lena}` : c === 'relation' ? 'role:reader' : c === 'object' ? `scope:${third}` : null,
      );
      const mixed = variant((rows) => [...rows, stray]);
      const dest = await blank();
      const before = await tuplesAt(dest);
      await expect(host.restoreScope(staff, t, dest, mixed)).rejects.toThrow(
        new RegExp(`restore refused: the dump holds grants on 1 scope\\(s\\) other than its source .*scope:${third}`),
      );
      expect(await tuplesAt(dest)).toEqual(before);
      // A fork of the same dump is a platform copy: the third-scope row authorized nothing in the
      // source, so it is not refused and stays exactly as it was, while the source grant moves.
      const fork = scopeId.parse(ulid());
      await host.importScope(staff, { tenantId: t, scopeId: fork, vertical: 'repoint-vertical' }, mixed);
      await expectGenuineGrantMoved(fork);
      const strayRow = Object.fromEntries(tuplesOf(planted).columns.map((c, i) => [c, stray[i]]));
      expect(await rowsFor(fork, lena)).toEqual([strayRow]);
      // The twin is every other case here: a dump whose `scope:` rows are its source's, or an
      // entity id that is not a scope id (`scope:e-1`), re-points without complaint.
    });

    it('a fork of a dump holding no grant on its source moves nothing: the platform vouches, so no fallback', async () => {
      // A platform-exported dump (a fork, snapshot, preview, carry) whose source holds no
      // scope-level grant. The fallback would read `scope:e-1` as a node grant and move it.
      const object = tuplesOf(planted).columns.indexOf('object');
      const bare = variant((rows) => rows.filter((r) => r[object] !== `scope:${source}`));
      expect(rowsIn(bare, gina)).toEqual([]);
      expect(rowsIn(bare, jack)).toHaveLength(1);
      const fork = scopeId.parse(ulid());
      await host.importScope(staff, { tenantId: t, scopeId: fork, vertical: 'repoint-vertical' }, bare);
      await expectEntityGrantsKept(fork);
      // Twin, the same dump restored by a caller: its provenance names no row, so it falls back.
      const dest = await blank();
      await host.restoreScope(staff, t, dest, bare);
      expect((await rowsFor(dest, jack)).map((r) => r.object)).toEqual([`scope:${dest}`]);
    });

    it('a fork (importScope) does the same', async () => {
      const fork = scopeId.parse(ulid());
      await host.importScope(staff, { tenantId: t, scopeId: fork, vertical: 'repoint-vertical' }, planted);
      await expectGenuineGrantMoved(fork);
      await expectEntityGrantsKept(fork);
    });

    it('a scope restored from its own backup moves nothing, and a snapshot of it moves only the scope grant', async () => {
      await host.restoreScope(staff, t, source, planted);
      await expectGenuineGrantMoved(source);
      await expectEntityGrantsKept(source);

      const snap = await host.snapshotScope(staff, t, source);
      await expectGenuineGrantMoved(snap);
      await expectEntityGrantsKept(snap);
    });

    it('a separate source hint re-points exactly, while the dump itself names the destination (an upload)', async () => {
      const dest = await blank();
      await host.restoreScope(staff, t, dest, { ...planted, scopeId: dest }, { sourceScopeId: source });
      await expectGenuineGrantMoved(dest);
      await expectEntityGrantsKept(dest);
    });

    it("the fallback: provenance that names no row in the dump moves every exact 'scope:' prefix, never Scope or SCOPE", async () => {
      // `substrat scope restore` stamps a local world with the TARGET's id, so the dump's
      // stated source (`dest`) describes none of its rows (they name `source`). The exact rule
      // would move nothing and strand gina's grant; the fallback moves what is spelled exactly
      // `scope:`, which is the old rule without LIKE's case folding.
      const dest = await blank();
      await host.restoreScope(staff, t, dest, { ...planted, scopeId: dest });
      await expectGenuineGrantMoved(dest);
      for (const who of [hana, ivan]) {
        expect((await rowsFor(dest, who)).map((r) => r.object)).toEqual([
          `${who === hana ? 'Scope' : 'SCOPE'}:${source}`,
        ]);
        expect(await allowed(who, dest)).toBe(false);
      }
      // The documented limit: without a source the dump holds, an entity typed exactly
      // `scope` cannot be told from a node grant, and moves with it.
      expect((await rowsFor(dest, jack)).map((r) => r.object)).toEqual([`scope:${dest}`]);
    });
  });
}
