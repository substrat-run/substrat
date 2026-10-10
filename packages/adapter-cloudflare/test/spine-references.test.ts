import { env, runInDurableObject } from 'cloudflare:test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { namesSpineTable, platformActorId, scopeId, tenantId, type ScopeDumpTable } from '@substrat-run/contracts';
import { ulid, UNSAFE_allowAllChecker } from '@substrat-run/kernel';
import { CloudflareScopeHost } from '../src/host.js';
import { warmControlPlane } from './do-warmup.js';

/**
 * #1898 on workerd: nothing a vertical brings may make a spine table the parent of its rows.
 * With foreign keys enforced, the kernel's own writes to that table (a revoke, a restore's
 * re-point, an outbox prune) would then fail on the vertical's rows. A ScopeDO restore's
 * replayed DDL is refused by `assertReplayableDump`; a migration, which runs on the DO's own
 * handle rather than `ctx.sql`, by `assertNoSpineReference`.
 *
 * Each case uses a scope of its own and asserts only on it.
 */
beforeAll(() => warmControlPlane(env.CONTROL_PLANE));

interface RawScope {
  exportDump(): Promise<ScopeDumpTable[]>;
  importDump(tables: ScopeDumpTable[]): Promise<unknown>;
}
const rawScope = (): RawScope => env.PC_V1_SCOPE.get(env.PC_V1_SCOPE.idFromName(`spine-refs-${ulid()}`)) as unknown as RawScope;
const own: ScopeDumpTable[] = [
  { name: 'lists', ddl: 'CREATE TABLE lists (id TEXT PRIMARY KEY)', columns: ['id'], rows: [['l1']] },
  { name: 'notes', ddl: 'CREATE TABLE notes (t TEXT REFERENCES lists(id))', columns: ['t'], rows: [['l1']] },
];
const vertical = (tables: ScopeDumpTable[]) => tables.filter((t) => !namesSpineTable(t.name));

describe("a ScopeDO restore's replayed DDL naming the spine in REFERENCES (#1898)", () => {
  for (const ddl of [
    'CREATE TABLE notes (t TEXT REFERENCES _substrat_tuples(subject))',
    'CREATE TABLE notes (t TEXT REFERENCES -- parent\n "_SUBSTRAT_OUTBOX"(id))',
  ]) {
    it(`is refused, and the scope keeps every table and row: ${JSON.stringify(ddl)}`, async () => {
      const scope = rawScope();
      await scope.importDump(own);
      const before = await scope.exportDump();
      const crafted = before.map((t) => (t.name === 'notes' ? { ...t, ddl, rows: [['x']] } : t));
      await expect(() => scope.importDump(crafted)).rejects.toThrow(/foreign key to the platform spine/);
      expect(await scope.exportDump()).toEqual(before);
    });
  }

  it('twin: a foreign key to the vertical’s own table restores', async () => {
    const scope = rawScope();
    await scope.importDump(own);
    expect(vertical(await scope.exportDump())).toEqual(own);
  });
});

describe('a migration naming the spine in REFERENCES, on DO SQLite (#1898)', () => {
  const staff = platformActorId.parse(ulid());
  const hosts: CloudflareScopeHost[] = [];
  afterAll(async () => {
    for (const h of hosts) await h.close();
  });

  const provision = async (ns: DurableObjectNamespace) => {
    const host = new CloudflareScopeHost({ scope: ns, controlPlane: env.CONTROL_PLANE, checker: UNSAFE_allowAllChecker });
    hosts.push(host);
    const t = tenantId.parse(ulid());
    const s = scopeId.parse(ulid());
    await host.admin.createTenant(staff, { id: t, slug: `t-${t.toLowerCase()}`, name: 'T' });
    await host.admin.grantEntitlement(staff, t, 'notes');
    const tables = () =>
      runInDurableObject(ns.get(ns.idFromName(s)), async (_i, state) =>
        state.storage.sql.exec(`SELECT name FROM sqlite_master WHERE type = 'table'`).toArray().map((r) => r.name as string),
      );
    return { host, t, s, tables, provisioned: host.provisionScope(staff, { tenantId: t, scopeId: s, jurisdiction: 'eu' }) };
  };

  it('is refused, and the scope fails closed with none of that migration applied', async () => {
    const { host, t, s, tables, provisioned } = await provision(env.SPINE_PARENT_SCOPE);
    await expect(provisioned).rejects.toThrow(/migration @test\/spine-parent@0001-init cannot declare a foreign key to the platform spine/);
    expect((await host.admin.getScopeRecord(staff, t, s))?.migrationFailure?.version).toBe('@test/spine-parent@0001-init');
    const names = await tables();
    expect(names).not.toContain('lists');
    expect(names).not.toContain('notes');
  });

  it('twin: a foreign key to the module’s own table applies', async () => {
    const { tables, provisioned } = await provision(env.OWN_PARENT_SCOPE);
    await provisioned;
    expect(await tables()).toEqual(expect.arrayContaining(['lists', 'notes']));
  });
});
