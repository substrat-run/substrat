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
    /** A tuples row in `planted`'s column order: the cells given, NULL in every other column. */
    const tupleRow = (cells: Record<string, unknown>): unknown[] =>
      tuplesOf(planted).columns.map((c) => cells[c] ?? null);
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

    /**
     * #1882: a moved row can meet a row the dump already holds for the destination, since
     * (subject, relation, object) is the key. It was `UPDATE OR REPLACE`, so the moved row
     * always won, tombstone and expiry included. The rule: the higher rank is kept, live above
     * revoked above expired (a tombstone is evidence, an expiry is not), and on a tie the
     * destination row stays. A row both revoked and expired ranks as revoked. Every cell
     * of source state × destination state, with the twins that have no collision at all, on
     * each path that re-points: a caller's restore (exact), a fork (exact, platform-vouched)
     * and a caller's restore whose provenance names no row (the fallback).
     */
    describe('which row survives a re-point collision (#1882)', () => {
      type State = 'live' | 'revoked' | 'expired' | 'revokedExpired';
      const STATES: State[] = ['live', 'revoked', 'expired', 'revokedExpired'];
      const RANK: Record<State, number> = { live: 2, revoked: 1, revokedExpired: 1, expired: 0 };
      // Distinct timestamps per side, so the byte-for-byte read-back says WHICH row survived.
      // The destination's live row carries an expiry the source's does not: keeping it is
      // what "never widen an expiry" means.
      type Cells = { expires_at: string | null; revoked_at: string | null };
      const src: Record<State, Cells> = {
        live: { expires_at: null, revoked_at: null },
        revoked: { expires_at: null, revoked_at: '2020-01-01T00:00:00.000Z' },
        expired: { expires_at: '2000-01-01T00:00:00.000Z', revoked_at: null },
        revokedExpired: { expires_at: '2000-06-01T00:00:00.000Z', revoked_at: '2020-06-01T00:00:00.000Z' },
      };
      const dst: Record<State, Cells> = {
        live: { expires_at: '2999-01-01T00:00:00.000Z', revoked_at: null },
        revoked: { expires_at: null, revoked_at: '2021-06-01T00:00:00.000Z' },
        expired: { expires_at: '2001-01-01T00:00:00.000Z', revoked_at: null },
        revokedExpired: { expires_at: '2001-06-01T00:00:00.000Z', revoked_at: '2021-09-01T00:00:00.000Z' },
      };
      interface Case {
        who: PrincipalId;
        /** What the dump holds for `who`, and on which object. */
        rows: { object: 'source' | 'dest'; state: Cells }[];
        /** The one row `who` holds after the load, on the destination. */
        kept: Cells;
      }
      const cases: Case[] = [];
      for (const s of STATES) {
        for (const d of STATES) {
          const moved = RANK[s] > RANK[d];
          cases.push({
            who: principalId.parse(ulid()),
            rows: [
              { object: 'source', state: src[s] },
              { object: 'dest', state: dst[d] },
            ],
            kept: moved ? src[s] : dst[d],
          });
        }
        // Twins with no collision: a source row moves as it is, a destination row stays as it is.
        cases.push({ who: principalId.parse(ulid()), rows: [{ object: 'source', state: src[s] }], kept: src[s] });
        cases.push({ who: principalId.parse(ulid()), rows: [{ object: 'dest', state: dst[s] }], kept: dst[s] });
      }
      // Two live rows: the destination row is kept with the EARLIER expiry, whichever side had it,
      // so a restore never widens a grant's life. No expiry is the latest of all.
      const earlier = { expires_at: '2990-01-01T00:00:00.000Z', revoked_at: null };
      const later = { expires_at: '2999-01-01T00:00:00.000Z', revoked_at: null };
      const never = { expires_at: null, revoked_at: null };
      for (const [a, b, kept] of [
        [earlier, later, earlier],
        [later, earlier, earlier],
        [never, later, later],
        [later, never, later],
        [never, never, never],
      ] as [Cells, Cells, Cells][]) {
        cases.push({
          who: principalId.parse(ulid()),
          rows: [
            { object: 'source', state: a },
            { object: 'dest', state: b },
          ],
          kept,
        });
      }
      const live = (c: Cells) => c.revoked_at === null && (c.expires_at === null || c.expires_at > '2026');

      /** `planted` plus every case's rows, the destination's naming `dest`. */
      const collisions = (dest: ScopeId): ScopeDump => {
        const extra = cases.flatMap((c) =>
          c.rows.map(({ object, state }) =>
            tupleRow({
              subject: `principal:${c.who}`,
              relation: 'role:reader',
              object: `scope:${object === 'source' ? source : dest}`,
              ...state,
            }),
          ),
        );
        return variant((rows) => [...rows, ...extra]);
      };
      /** Every case holds exactly its kept row, byte for byte, and the checker agrees. */
      const expectCasesSettled = async (dest: ScopeId) => {
        const columns = tuplesOf(planted).columns;
        for (const c of cases) {
          const want = tupleRow({ subject: `principal:${c.who}`, relation: 'role:reader', object: `scope:${dest}`, ...c.kept });
          expect(await rowsFor(dest, c.who)).toEqual([Object.fromEntries(columns.map((col, i) => [col, want[i]]))]);
          expect(await allowed(c.who, dest)).toBe(live(c.kept));
        }
      };
      const expectSettled = async (dest: ScopeId) => {
        await expectCasesSettled(dest);
        // The rest of the dump re-pointed as before.
        await expectGenuineGrantMoved(dest);
        await expectEntityGrantsKept(dest);
      };

      it('a restore (exact): live beats dead, otherwise the destination row stays', async () => {
        const dest = await blank();
        await host.restoreScope(staff, t, dest, collisions(dest));
        await expectSettled(dest);
      });

      it('a fork (exact, platform-vouched) settles the same way', async () => {
        const fork = scopeId.parse(ulid());
        await host.importScope(staff, { tenantId: t, scopeId: fork, vertical: 'repoint-vertical' }, collisions(fork));
        await expectSettled(fork);
      });

      it('the fallback settles the same way, and two moved rows for one key keep the live one', async () => {
        const dest = await blank();
        // Two other scopes' rows for one key, the live one on the higher object, so the
        // object order alone would have picked the other.
        const [a, b] = [scopeId.parse(ulid()), scopeId.parse(ulid())].sort();
        const mia = principalId.parse(ulid());
        const row = (object: string, revoked_at: string | null) =>
          tupleRow({ subject: `principal:${mia}`, relation: 'role:reader', object, revoked_at });
        const dump = collisions(dest);
        const withBoth = {
          ...dump,
          // Provenance that names no row in the dump, so the re-point falls back.
          scopeId: scopeId.parse(ulid()),
          tables: dump.tables.map((tb) =>
            tb.name === '_substrat_tuples'
              ? { ...tb, rows: [...tb.rows, row(`scope:${a}`, '2020-01-01T00:00:00.000Z'), row(`scope:${b}`, null)] }
              : tb,
          ),
        };
        await host.restoreScope(staff, t, dest, withBoth);
        await expectCasesSettled(dest);
        expect((await rowsFor(dest, mia)).map((r) => [r.object, r.revoked_at])).toEqual([[`scope:${dest}`, null]]);
        expect(await allowed(mia, dest)).toBe(true);
      });

      it('the fallback settles two moved rows and a destination row together: rank, then the lower object', async () => {
        const dest = await blank();
        const [a, b] = [scopeId.parse(ulid()), scopeId.parse(ulid())].sort();
        type Row = { object: string; expires_at?: string | null; revoked_at?: string | null };
        const on = (object: 'a' | 'b' | 'dest') => `scope:${object === 'a' ? a : object === 'b' ? b : dest}`;
        const trio: { rows: Row[]; kept: Cells }[] = [
          // Same rank, both dead: the lower object's row is the one kept.
          {
            rows: [
              { object: on('a'), revoked_at: '2020-01-01T00:00:00.000Z' },
              { object: on('b'), revoked_at: '2021-01-01T00:00:00.000Z' },
            ],
            kept: { expires_at: null, revoked_at: '2020-01-01T00:00:00.000Z' },
          },
          // Same rank, both live: one row is kept, with the earlier expiry.
          {
            rows: [
              { object: on('a'), expires_at: '2999-01-01T00:00:00.000Z' },
              { object: on('b'), expires_at: '2990-01-01T00:00:00.000Z' },
            ],
            kept: { expires_at: '2990-01-01T00:00:00.000Z', revoked_at: null },
          },
          // A live moved row beats an expired moved row and a revoked destination row.
          {
            rows: [
              { object: on('a'), expires_at: '2000-01-01T00:00:00.000Z' },
              { object: on('b') },
              { object: on('dest'), revoked_at: '2021-01-01T00:00:00.000Z' },
            ],
            kept: { expires_at: null, revoked_at: null },
          },
          // The live destination row is kept, with the earlier expiry a live moved row carried.
          {
            rows: [
              { object: on('a'), expires_at: '2990-01-01T00:00:00.000Z' },
              { object: on('b'), revoked_at: '2020-01-01T00:00:00.000Z' },
              { object: on('dest'), expires_at: '2999-01-01T00:00:00.000Z' },
            ],
            kept: { expires_at: '2990-01-01T00:00:00.000Z', revoked_at: null },
          },
          // All three expired: a tie, so the destination row stays.
          {
            rows: [
              { object: on('a'), expires_at: '2000-01-01T00:00:00.000Z' },
              { object: on('b'), expires_at: '2001-01-01T00:00:00.000Z' },
              { object: on('dest'), expires_at: '2002-01-01T00:00:00.000Z' },
            ],
            kept: { expires_at: '2002-01-01T00:00:00.000Z', revoked_at: null },
          },
        ];
        const who = trio.map(() => principalId.parse(ulid()));
        const extra = trio.flatMap((c, i) =>
          c.rows.map((r) => tupleRow({ subject: `principal:${who[i]}`, relation: 'role:reader', ...r })),
        );
        // Provenance that names no row in the dump, so the re-point falls back and moves both.
        await host.restoreScope(staff, t, dest, { ...variant((rows) => [...rows, ...extra]), scopeId: scopeId.parse(ulid()) });
        const columns = tuplesOf(planted).columns;
        for (const [i, c] of trio.entries()) {
          const want = tupleRow({ subject: `principal:${who[i]}`, relation: 'role:reader', object: `scope:${dest}`, ...c.kept });
          expect(await rowsFor(dest, who[i]!)).toEqual([Object.fromEntries(columns.map((col, j) => [col, want[j]]))]);
          expect(await allowed(who[i]!, dest)).toBe(live(c.kept));
        }
      });
    });

    /**
     * #1883: a restore builds every `_substrat_*` table from the kernel's DDL and takes only
     * the dump's rows, by column name. It used to replay the dump's DDL for the spine too, so
     * a dump could decide the collation of the column the checker compares on.
     */
    describe('the spine is built from the kernel, never from the dump (#1883)', () => {
      const tina = principalId.parse(ulid()); // granted on aiTurn:x only
      const uma = principalId.parse(ulid()); // granted on aiTurn:y and, separately, on aiturn:y
      const onEntity = async (who: PrincipalId, scope: ScopeId, entityType: string, entityId: string) => {
        const stub = await host.getScope(who, t, scope);
        const out = await stub.invoke<{ allowed: boolean }>('perm/probe', {
          permission: PERM_READ,
          entity: { entityType, entityId },
        });
        return out.allowed;
      };
      const entityRow = (who: PrincipalId, object: string) =>
        tupleRow({ subject: `principal:${who}`, relation: `granted:${PERM_READ}`, object });
      /** Every table, whole: what a refused load must leave exactly as it was. */
      const everything = async (scope: ScopeId) => (await host.admin.exportScope(staff, t, scope)).tables;

      /** `planted` plus `extra` tuples, its DDL declaring subject, relation and object COLLATE NOCASE. */
      const nocase = (extra: unknown[][]) =>
        variant(
          (rows) => [...rows, ...extra],
          (ddl) => {
            const out = ddl
              .replace(/\bsubject TEXT NOT NULL\b/, 'subject TEXT NOT NULL COLLATE NOCASE')
              .replace(/\brelation TEXT NOT NULL\b/, 'relation TEXT NOT NULL COLLATE NOCASE')
              .replace(/\bobject TEXT NOT NULL\b/, 'object TEXT NOT NULL COLLATE NOCASE');
            expect(out.match(/COLLATE NOCASE/g)).toHaveLength(3);
            return out;
          },
        );

      it('a dump declaring the tuples columns COLLATE NOCASE restores into a case-sensitive table: aiTurn:x is not aiturn:x', async () => {
        const dest = await blank();
        await host.restoreScope(staff, t, dest, nocase([entityRow(tina, 'aiTurn:x')]));
        // The checker compares case-sensitively: the grant is on aiTurn:x and nothing else.
        expect(await onEntity(tina, dest, 'aiTurn', 'x')).toBe(true);
        expect(await onEntity(tina, dest, 'aiturn', 'x')).toBe(false);
        // Because the table is the kernel's, exactly as a scope that was never restored holds it.
        const restored = tuplesOf(await host.admin.exportScope(staff, t, dest));
        expect(restored.ddl).toBe(tuplesOf(planted).ddl);
        expect(restored.ddl).not.toMatch(/NOCASE/i);
        // The re-point still did its job over the same rows.
        await expectGenuineGrantMoved(dest);
        await expectEntityGrantsKept(dest);
      });

      it('the same dump under a spelling of the name in other case cannot bring its DDL either', async () => {
        // SQLite matches table names without regard to case, so `_Substrat_tuples` IS the tuples
        // table. Read as a vertical table, its NOCASE DDL would be replayed and KERNEL_DDL's
        // `IF NOT EXISTS` would then skip the kernel's own.
        const dump = nocase([entityRow(tina, 'aiTurn:x')]);
        const renamed = {
          ...dump,
          tables: dump.tables.map((tb) =>
            tb.name === '_substrat_tuples'
              ? { ...tb, name: '_Substrat_tuples', ddl: tb.ddl.replace(/^CREATE TABLE _substrat_tuples\b/, 'CREATE TABLE _Substrat_tuples') }
              : tb,
          ),
        };
        expect(renamed.tables.find((tb) => tb.name === '_Substrat_tuples')?.ddl).toMatch(/^CREATE TABLE _Substrat_tuples .*NOCASE/s);
        const dest = await blank();
        await host.restoreScope(staff, t, dest, renamed);
        expect(await onEntity(tina, dest, 'aiTurn', 'x')).toBe(true);
        expect(await onEntity(tina, dest, 'aiturn', 'x')).toBe(false);
        const restored = tuplesOf(await host.admin.exportScope(staff, t, dest));
        expect(restored.ddl).toBe(tuplesOf(planted).ddl);
      });

      it('a search-index name in other case is skipped like the index itself, never replayed as a table', async () => {
        // The derived search index is rebuilt, never loaded, and is recognised the way SQLite
        // resolves a name. `_SUBSTRAT_SEARCH_evil` is that index's namespace, not a vertical's.
        const evil = { name: '_SUBSTRAT_SEARCH_evil', ddl: 'CREATE TABLE _SUBSTRAT_SEARCH_evil (id TEXT)', columns: ['id'], rows: [['x']] };
        const dest = await blank();
        await host.restoreScope(staff, t, dest, { ...planted, tables: [...planted.tables, evil] });
        const names = (await everything(dest)).map((tb) => tb.name.toLowerCase());
        expect(names).not.toContain('_substrat_search_evil');
        // Twin: the rest of the dump landed.
        await expectGenuineGrantMoved(dest);
      });

      it('two grants whose objects differ only in case stay two rows through that restore', async () => {
        const dest = await blank();
        // Under the dump's NOCASE these are one key, and the load would fail on the second.
        await host.restoreScope(staff, t, dest, nocase([entityRow(uma, 'aiTurn:y'), entityRow(uma, 'aiturn:y')]));
        expect((await rowsFor(dest, uma)).map((r) => r.object).sort()).toEqual(['aiTurn:y', 'aiturn:y']);
        expect(await onEntity(uma, dest, 'aiTurn', 'y')).toBe(true);
        expect(await onEntity(uma, dest, 'aiturn', 'y')).toBe(true);
      });

      it("twin: a vertical's table keeps the dump's DDL, collation included", async () => {
        const note = {
          name: 'repoint_notes',
          ddl: 'CREATE TABLE repoint_notes (id TEXT PRIMARY KEY, body TEXT COLLATE NOCASE)',
          columns: ['id', 'body'],
          rows: [['n1', 'Hello']],
        };
        const dest = await blank();
        await host.restoreScope(staff, t, dest, { ...planted, tables: [...planted.tables, note] });
        const back = (await everything(dest)).find((tb) => tb.name === 'repoint_notes');
        expect(back).toEqual(note);
      });

      it('a spine column the kernel does not know is refused, and the target keeps every table it held', async () => {
        const dest = await blank();
        const before = await everything(dest);
        const smuggled = variant(
          (rows) => rows.map((r) => [...r, 'x']),
          (ddl) => ddl.replace(/\bobject TEXT NOT NULL\b/, 'object TEXT NOT NULL, smuggled TEXT'),
        );
        const withColumn = {
          ...smuggled,
          tables: smuggled.tables.map((tb) =>
            tb.name === '_substrat_tuples' ? { ...tb, columns: [...tb.columns, 'smuggled'] } : tb,
          ),
        };
        await expect(host.restoreScope(staff, t, dest, withColumn)).rejects.toThrow(
          /restore refused: the dump's _substrat_tuples has column\(s\) this host's kernel does not know: smuggled/,
        );
        expect(await everything(dest)).toEqual(before);
      });

      it('spine tables the kernel does not build are refused, all named, and the target keeps every table it held', async () => {
        const dest = await blank();
        const before = await everything(dest);
        const extra = (name: string, rows: unknown[][]) => ({ name, ddl: `CREATE TABLE ${name} (id TEXT)`, columns: ['id'], rows });
        await expect(
          host.restoreScope(staff, t, dest, {
            ...planted,
            // One empty and one with a row: a table is refused for existing, not for its rows.
            tables: [...planted.tables, extra('_substrat_smuggled', []), extra('_substrat_zz_newer', [['r1']])],
          }),
        ).rejects.toThrow(
          /restore refused: the dump carries spine table\(s\) this host's kernel does not build: _substrat_smuggled, _substrat_zz_newer\. It was exported by a different kind of host .* or by a newer kernel/,
        );
        expect(await everything(dest)).toEqual(before);
      });

      it('a spine column the dump lacks takes the default: a tuples table from before revoked_at restores', async () => {
        const table = tuplesOf(planted);
        const at = table.columns.indexOf('revoked_at');
        expect(at).toBeGreaterThanOrEqual(0);
        const legacy = {
          ...planted,
          tables: planted.tables.map((tb) =>
            tb === table
              ? {
                  ...tb,
                  // A stored DDL may keep the column's comment (node) or not (a DO).
                  ddl: tb.ddl.replace(/,\s*(?:--[^\n]*\n\s*)*revoked_at TEXT/, ''),
                  columns: tb.columns.filter((c) => c !== 'revoked_at'),
                  rows: tb.rows.map((r) => r.filter((_, i) => i !== at)),
                }
              : tb,
          ),
        };
        expect(tuplesOf(legacy).ddl).not.toMatch(/revoked_at/);
        const dest = await blank();
        await host.restoreScope(staff, t, dest, legacy);
        const rows = await rowsFor(dest, gina);
        expect(rows.map((r) => [r.object, r.revoked_at])).toEqual([[`scope:${dest}`, null]]);
        expect(await allowed(gina, dest)).toBe(true);
      });

      it('a pre-#1288 schedule-state table under a name in other case still restores, with kind derived', async () => {
        const legacy = {
          name: '_Substrat_schedule_state',
          ddl: 'CREATE TABLE _Substrat_schedule_state (schedule_op TEXT PRIMARY KEY, last_run_at TEXT, last_status TEXT)',
          columns: ['schedule_op', 'last_run_at', 'last_status'],
          rows: [
            ['freshness:repoint.done', '2026-09-01T00:00:00.000Z', 'failed'],
            ['repoint/tick', '2026-09-01T00:00:00.000Z', 'ok'],
          ],
        };
        const dest = await blank();
        await host.restoreScope(staff, t, dest, {
          ...planted,
          tables: [...planted.tables.filter((tb) => tb.name !== '_substrat_schedule_state'), legacy],
        });
        const state = (await everything(dest)).find((tb) => tb.name === '_substrat_schedule_state');
        expect(state).toBeDefined();
        const read = state!.rows.map((r) => Object.fromEntries(state!.columns.map((c, i) => [c, r[i]])));
        expect(read.map((r) => [r.kind, r.schedule_op, r.last_status, r.invocation_id])).toEqual([
          ['freshness', 'freshness:repoint.done', 'failed', null],
          ['schedule', 'repoint/tick', 'ok', null],
        ]);
      });

      it('export, restore, export: the second export is the first, byte for byte', async () => {
        const scope = await blank();
        await host.admin.assignRole(staff, { principalId: gina, roleKey: 'reader', node: { tenantId: t, scopeId: scope } });
        const first = await host.admin.exportScope(staff, t, scope);
        await host.restoreScope(staff, t, scope, first);
        const second = await host.admin.exportScope(staff, t, scope);
        expect(second.tables).toEqual(first.tables);
      });
    });
  });
}
