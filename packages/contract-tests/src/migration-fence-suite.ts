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
import { FENCE_DECLARED, FENCE_UNDECLARED, fenceDeclaredMod, fenceUndeclaredMod } from './migration-fence.js';

type Fixture = typeof FENCE_DECLARED | typeof FENCE_UNDECLARED;

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
      await host.admin.createTenant(staff, { id: t, slug: `fence-${t.toLowerCase()}`, name: 'Fence' });
      await host.admin.grantEntitlement(staff, t, FENCE_UNDECLARED.key);
      await host.admin.grantEntitlement(staff, t, FENCE_DECLARED.key);
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
  });
}
