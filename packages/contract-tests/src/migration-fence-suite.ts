/**
 * Contract suite for the data-loss fence (#115): an authored migration that would lose rows a
 * scope holds is refused, on every adapter, and the scope fails closed with its data where it was;
 * the same migration declaring the loss applies; and on a scope that holds nothing, both apply.
 *
 * A scope that holds data when the drop arrives is made the way the migration-comments suite makes
 * one: its own dump, edited back to before the drop (the table, two rows, a journal without
 * `0002`), restored in place. The next pass then runs `0002` against those rows. The fixtures are
 * `fenceUndeclaredMod` and `fenceDeclaredMod`, which every scope in the kit carries.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { platformActorId, principalId, scopeId, tenantId, type ScopeDump } from '@substrat-run/contracts';
import { ulid, type ScopeHost } from '@substrat-run/kernel';
import type { ScopeHostFixture } from './scope-host-suite.js';
import {
  FENCE_DECLARED,
  FENCE_UNDECLARED,
  FENCE_REUSED_RIGHT,
  FENCE_REUSED_WRONG,
  FENCE_WIDE,
  FENCE_WIDE_COLUMNS,
  fenceDeclaredMod,
  fenceUndeclaredMod,
  fenceWideDdl,
  fenceReusedRightMod,
  fenceReusedWrongMod,
  fenceWideMod,
} from './migration-fence.js';

type Fixture =
  | typeof FENCE_DECLARED
  | typeof FENCE_UNDECLARED
  | typeof FENCE_WIDE
  | typeof FENCE_REUSED_RIGHT
  | typeof FENCE_REUSED_WRONG;

export function migrationFenceContractSuite(adapterName: string, makeFixture: () => Promise<ScopeHostFixture>): void {
  describe(`the migration data-loss fence (#115): ${adapterName}`, () => {
    let fixture: ScopeHostFixture;
    let host: ScopeHost;
    const t = tenantId.parse(ulid());
    const staff = platformActorId.parse(ulid());
    const anyone = principalId.parse(ulid());

    beforeAll(async () => {
      fixture = await makeFixture();
      host = fixture.host;
      host.registerModule(fenceUndeclaredMod);
      host.registerModule(fenceDeclaredMod);
      host.registerModule(fenceWideMod);
      host.registerModule(fenceReusedRightMod);
      host.registerModule(fenceReusedWrongMod);
      await host.admin.createTenant(staff, { id: t, slug: `fence-${t.toLowerCase()}`, name: 'Fence' });
      await host.admin.grantEntitlement(staff, t, FENCE_UNDECLARED.key);
      await host.admin.grantEntitlement(staff, t, FENCE_DECLARED.key);
      await host.admin.grantEntitlement(staff, t, FENCE_WIDE.key);
      await host.admin.grantEntitlement(staff, t, FENCE_REUSED_RIGHT.key);
      await host.admin.grantEntitlement(staff, t, FENCE_REUSED_WRONG.key);
    });
    afterAll(async () => {
      await fixture?.cleanup();
    });

    const provision = async () => {
      const s = scopeId.parse(ulid());
      await host.provisionScope(staff, { tenantId: t, scopeId: s, vertical: 'fence' });
      await host.admin.activateScope(staff, t, s);
      return s;
    };
    const tables = async (s: ReturnType<typeof scopeId.parse>, m: Fixture) =>
      (await host.getScope(anyone, t, s)).invoke<string[]>(`${m.key}/tables`, undefined);
    const wideTables = (s: ReturnType<typeof scopeId.parse>) => tables(s, FENCE_WIDE);
    const journalOf = (dump: ScopeDump, m: Fixture) => {
      const table = dump.tables.find((x) => x.name === '_substrat_migrations')!;
      const [mod, version] = [table.columns.indexOf('module_id'), table.columns.indexOf('version')];
      return table.rows.filter((r) => r[mod] === m.id).map((r) => String(r[version]));
    };
    /** The scope's own dump, edited back to before `m`'s drop: its table, holding two rows. */
    const beforeTheDrop = async (s: ReturnType<typeof scopeId.parse>, m: Fixture): Promise<ScopeDump> => {
      const dump = await host.admin.exportScope(staff, t, s);
      expect(dump.tables.some((x) => x.name === m.table)).toBe(false);
      const tables = dump.tables.map((x) => {
        if (x.name !== '_substrat_migrations') return x;
        const [mod, version] = [x.columns.indexOf('module_id'), x.columns.indexOf('version')];
        return { ...x, rows: x.rows.filter((r) => !(r[mod] === m.id && r[version] === '0002-drop')) };
      });
      tables.push({
        name: m.table,
        ddl: `CREATE TABLE ${m.table} (id TEXT PRIMARY KEY, body TEXT NOT NULL)`,
        columns: ['id', 'body'],
        rows: [
          ['n1', 'first'],
          ['n2', 'second'],
        ],
      } as (typeof tables)[number]);
      return { ...dump, tables };
    };

    it('on a scope whose table holds nothing, both drops apply', async () => {
      const s = await provision();
      expect(await tables(s, FENCE_UNDECLARED)).toEqual([]);
      expect(await tables(s, FENCE_DECLARED)).toEqual([]);
      const dump = await host.admin.exportScope(staff, t, s);
      expect(journalOf(dump, FENCE_UNDECLARED)).toEqual(['0001-create', '0002-drop']);
      expect(journalOf(dump, FENCE_DECLARED)).toEqual(['0001-create', '0002-drop']);
    });

    it('an undeclared drop of a table holding rows is refused: the scope fails closed and keeps the rows', async () => {
      const s = await provision();
      await host.restoreScope(staff, t, s, await beforeTheDrop(s, FENCE_UNDECLARED));
      const refused = new RegExp(
        `migration failed for ${FENCE_UNDECLARED.id}@0002-drop — scope fails closed: .*` +
          `would lose data this scope holds.*table ${FENCE_UNDECLARED.table} held 2 row\\(s\\) and is gone.*` +
          `discards: \\{ '${FENCE_UNDECLARED.table}': '<why this data may go>' \\}`,
      );
      await expect(tables(s, FENCE_UNDECLARED)).rejects.toThrow(refused);
      // The sweep's door reports it as the structured failure any failed migration leaves.
      const outcome = await host.migrateScope(t, s);
      expect(outcome).toEqual({ status: 'failed', failure: { version: `${FENCE_UNDECLARED.id}@0002-drop`, error: expect.any(String) } });
      // Nothing of it ran: the rows are there, and the journal does not record the drop.
      const after = await host.admin.exportScope(staff, t, s);
      expect(after.tables.find((x) => x.name === FENCE_UNDECLARED.table)?.rows).toEqual([
        ['n1', 'first'],
        ['n2', 'second'],
      ]);
      expect(journalOf(after, FENCE_UNDECLARED)).toEqual(['0001-create']);
    });

    it('the same drop, declared with `discards`, applies to a table holding rows', async () => {
      const s = await provision();
      await host.restoreScope(staff, t, s, await beforeTheDrop(s, FENCE_DECLARED));
      expect(await tables(s, FENCE_DECLARED)).toEqual([]);
      const after = await host.admin.exportScope(staff, t, s);
      expect(after.tables.some((x) => x.name === FENCE_DECLARED.table)).toBe(false);
      expect(journalOf(after, FENCE_DECLARED)).toEqual(['0001-create', '0002-drop']);
    });

    it('measures a populated 100-column table inside the DO result limit: a lossless migration applies, a loss past the first scan is refused', async () => {
      const s = await provision();
      const dump = await host.admin.exportScope(staff, t, s);
      const tables = dump.tables
        .filter((x) => x.name !== FENCE_WIDE.table)
        .map((x) => {
          if (x.name !== '_substrat_migrations') return x;
          const [mod, version] = [x.columns.indexOf('module_id'), x.columns.indexOf('version')];
          return { ...x, rows: x.rows.filter((r) => !(r[mod] === FENCE_WIDE.id && r[version] !== '0001-create')) };
        });
      tables.push({
        name: FENCE_WIDE.table,
        ddl: fenceWideDdl,
        columns: FENCE_WIDE_COLUMNS,
        rows: [FENCE_WIDE_COLUMNS.map((c) => `${c}-value`)],
      } as (typeof tables)[number]);
      await host.restoreScope(staff, t, s, { ...dump, tables });
      const last = `c${FENCE_WIDE.columns - 1}`;
      await expect(wideTables(s)).rejects.toThrow(
        new RegExp(`migration failed for ${FENCE_WIDE.id}@0003-drop-last — scope fails closed: .*column ${FENCE_WIDE.table}\\.${last} held 1 value\\(s\\) and is gone`),
      );
      const after = await host.admin.exportScope(staff, t, s);
      // 0002 ran (its measuring did not trip the DO's result limit); 0003 did not.
      expect(journalOf(after, FENCE_WIDE)).toEqual(['0001-create', '0002-touch']);
      expect(after.tables.find((x) => x.name === FENCE_WIDE.table)?.columns).toContain(last);
    });

    /**
     * The scope's own dump, back before `m`'s `0002`: its `_a` (two rows) and `_b` (one row), in
     * the catalogue order `bFirst` says, and no `_c`.
     */
    const beforeTheReplace = async (s: ReturnType<typeof scopeId.parse>, m: typeof FENCE_REUSED_RIGHT | typeof FENCE_REUSED_WRONG, bFirst: boolean) => {
      const dump = await host.admin.exportScope(staff, t, s);
      const table = (suffix: string, rows: string[][]) =>
        ({ name: `${m.prefix}_${suffix}`, ddl: `CREATE TABLE ${m.prefix}_${suffix} (id TEXT, x TEXT)`, columns: ['id', 'x'], rows }) as (typeof dump.tables)[number];
      const a = table('a', [
        ['1', 'p'],
        ['2', 'q'],
      ]);
      const b = table('b', [['x', 'r']]);
      const tables = dump.tables
        .filter((x) => x.name !== m.table)
        .map((x) => {
          if (x.name !== '_substrat_migrations') return x;
          const [mod, version] = [x.columns.indexOf('module_id'), x.columns.indexOf('version')];
          return { ...x, rows: x.rows.filter((r) => !(r[mod] === m.id && r[version] === '0002-replace')) };
        });
      return { ...dump, tables: [...tables, ...(bFirst ? [b, a] : [a, b])] };
    };

    describe.each([true, false])('a dropped name reused by a rename, then renamed again (b created first: %s) (#115 r2)', (bFirst) => {
      it("declared as the dropped table's loss, it applies, and the renamed table's rows are in its new name", async () => {
        const s = await provision();
        await host.restoreScope(staff, t, s, await beforeTheReplace(s, FENCE_REUSED_RIGHT, bFirst));
        expect(await tables(s, FENCE_REUSED_RIGHT)).toEqual([FENCE_REUSED_RIGHT.table]);
        const after = await host.admin.exportScope(staff, t, s);
        expect(after.tables.find((x) => x.name === FENCE_REUSED_RIGHT.table)?.rows.map((r) => r[0]).sort()).toEqual(['1', '2']);
        expect(journalOf(after, FENCE_REUSED_RIGHT)).toEqual(['0001-create', '0002-replace']);
      });

      it('declared as the renamed table instead, it is refused, naming the table whose rows are gone', async () => {
        const s = await provision();
        await host.restoreScope(staff, t, s, await beforeTheReplace(s, FENCE_REUSED_WRONG, bFirst));
        await expect(tables(s, FENCE_REUSED_WRONG)).rejects.toThrow(
          new RegExp(`migration failed for ${FENCE_REUSED_WRONG.id}@0002-replace — scope fails closed: .*table ${FENCE_REUSED_WRONG.prefix}_b held 1 row\\(s\\) and is gone`),
        );
        expect(journalOf(await host.admin.exportScope(staff, t, s), FENCE_REUSED_WRONG)).toEqual(['0001-create']);
      });
    });
  });
}
