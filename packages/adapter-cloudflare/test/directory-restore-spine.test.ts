import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import type { PrincipalId, ScopeDumpTable } from '@substrat-run/contracts';
import { ulid } from '@substrat-run/kernel';
import { createDoTupleChecker, type ControlPlaneReader } from '../src/checker.js';
import { warmControlPlane } from './do-warmup.js';

/**
 * #1898 on workerd, where the hosted directory lives: `ControlPlaneDO.importDump` builds the
 * directory's `_substrat_*` tables from its own DDL, never the dump's, and takes only the
 * dump's rows, by column name — the rules #1883 set for a scope. The directory holds
 * `_substrat_tenant_tuples` and `_substrat_roles`, which every hosted tenant-level check reads
 * (`createDoTupleChecker` over this DO), so a dump that declared their columns COLLATE NOCASE
 * decided how tenant-level grants and roles matched.
 *
 * Every case runs on a directory DO of its own (a fresh name), and asserts only on that one,
 * so nothing another file writes into the shared control plane reaches a comparison.
 */
interface Directory extends Pick<ControlPlaneReader, 'tenantTuples' | 'getRole'> {
  exportDump(): Promise<ScopeDumpTable[]>;
  importDump(tables: ScopeDumpTable[]): Promise<void>;
  revokeTenantTuple(tenantId: string, subject: string, relation: string, object: string, at: string): Promise<boolean>;
  listEntitlements(tenantId: string): Promise<never[]>;
}
const directory = (): Directory =>
  env.CONTROL_PLANE.get(env.CONTROL_PLANE.idFromName(`restore-spine-${ulid()}`)) as unknown as Directory;

const tenant = 'tenant-a';
const T = `tenant:${tenant}`;
const withTable = (tables: ScopeDumpTable[], name: string, edit: (t: ScopeDumpTable) => ScopeDumpTable) =>
  tables.map((t) => (t.name === name ? edit(t) : t));
const row = (t: ScopeDumpTable, values: Record<string, unknown>) => t.columns.map((c) => values[c] ?? null);
const nocase = (ddl: string, ...columns: string[]) =>
  columns.reduce((d, c) => d.replace(new RegExp(`\\b${c} TEXT NOT NULL`), `${c} TEXT NOT NULL COLLATE NOCASE`), ddl);
const ddlOf = (tables: ScopeDumpTable[], name: string) => tables.find((t) => t.name === name)?.ddl;

beforeAll(() => warmControlPlane(env.CONTROL_PLANE));

describe('ControlPlaneDO.importDump builds the spine from its own DDL (#1898)', () => {
  it('a NOCASE _substrat_tenant_tuples and _substrat_roles restore into BINARY tables, and the tenant-level checker compares exactly', async () => {
    const dir = directory();
    const fresh = await dir.exportDump();
    let tables = withTable(fresh, '_substrat_tenant_tuples', (t) => {
      const ddl = nocase(t.ddl, 'subject', 'relation', 'object');
      expect(ddl.match(/COLLATE NOCASE/g)).toHaveLength(3);
      return {
        ...t,
        ddl,
        rows: [
          row(t, { tenant_id: tenant, subject: 'principal:Alice', relation: 'granted:notes/read', object: T }),
          row(t, { tenant_id: tenant, subject: 'principal:Bob', relation: 'role:editor', object: T }),
          row(t, { tenant_id: tenant, subject: 'principal:Carol', relation: 'role:Editor', object: T }),
          // Two rows a NOCASE key would have merged: both must land.
          row(t, { tenant_id: tenant, subject: 'principal:Dan', relation: 'member', object: 'org:o1' }),
          row(t, { tenant_id: tenant, subject: 'principal:dan', relation: 'member', object: 'org:o1' }),
        ],
      };
    });
    tables = withTable(tables, '_substrat_roles', (t) => ({
      ...t,
      ddl: nocase(t.ddl, 'role_key'),
      rows: [row(t, { tenant_id: tenant, role_key: 'Editor', permissions: '["notes/write"]', source: 'custom' })],
    }));

    await dir.importDump(tables);

    const restored = await dir.exportDump();
    expect(ddlOf(restored, '_substrat_tenant_tuples')).toBe(ddlOf(fresh, '_substrat_tenant_tuples'));
    expect(ddlOf(restored, '_substrat_roles')).toBe(ddlOf(fresh, '_substrat_roles'));
    expect(restored.find((t) => t.name === '_substrat_tenant_tuples')!.rows).toHaveLength(5);

    // The directory's own exact reads.
    expect(await dir.tenantTuples(tenant, 'principal:alice', 'granted:')).toEqual([]);
    expect(await dir.tenantTuples(tenant, 'principal:Alice', 'granted:')).toHaveLength(1);
    expect(await dir.getRole(tenant, 'editor')).toBeUndefined();
    expect((await dir.getRole(tenant, 'Editor'))?.permissions).toEqual(['notes/write']);
    // A revoke of the case variant touches nothing.
    expect(await dir.revokeTenantTuple(tenant, 'principal:alice', 'granted:notes/read', T, '2026-09-29T00:00:00.000Z')).toBe(false);

    // The hosted checker, reading this directory over RPC. A tenant-level node has no scope, so
    // the scope store is never read; one that throws proves it.
    const noScopeStore = { exec: () => { throw new Error('a tenant-level check read the scope store'); } } as unknown as SqlStorage;
    const checker = createDoTupleChecker({ scopeSql: noScopeStore, controlPlane: dir as unknown as ControlPlaneReader });
    const allowed = async (id: string, permission: string) =>
      (await checker.check({ kind: 'principal', id: id as PrincipalId }, permission as never, { tenantId: tenant } as never)).allowed;
    const decisions = {
      alice: await allowed('Alice', 'notes/read'),
      aliceFolded: await allowed('alice', 'notes/read'),
      bobThroughEditor: await allowed('Bob', 'notes/write'),
      carolThroughEditor: await allowed('Carol', 'notes/write'),
    };
    expect(decisions).toEqual({ alice: true, aliceFolded: false, bobThroughEditor: false, carolThroughEditor: true });
  });

  it('export → restore → export is identical', async () => {
    const dir = directory();
    const seeded = withTable(await dir.exportDump(), '_substrat_tenant_tuples', (t) => ({
      ...t,
      rows: [row(t, { tenant_id: tenant, subject: 'principal:Eve', relation: 'member', object: 'org:o1', expires_at: '2099-01-01T00:00:00.000Z' })],
    }));
    await dir.importDump(seeded);
    const before = await dir.exportDump();
    await dir.importDump(before);
    expect(await dir.exportDump()).toEqual(before);
  });

  it('a spine column this code does not know is kept bare and lowercased, with its values', async () => {
    const dir = directory();
    const tables = withTable(await dir.exportDump(), '_substrat_tenant_tuples', (t) => {
      const columns = [...t.columns, 'Future_Note'];
      return {
        ...t,
        ddl: t.ddl.replace(/\)\s*$/, ", Future_Note TEXT NOT NULL COLLATE NOCASE DEFAULT 'x')"),
        columns,
        rows: [row({ ...t, columns }, { tenant_id: tenant, subject: 'principal:Fay', relation: 'member', object: 'org:o1', Future_Note: 'kept' })],
      };
    });
    await dir.importDump(tables);
    const t = (await dir.exportDump()).find((x) => x.name === '_substrat_tenant_tuples')!;
    expect(t.columns.at(-1)).toBe('future_note');
    expect(t.ddl).toMatch(/ "future_note"[,\n)]/);
    expect(t.ddl).not.toMatch(/NOCASE|Future_Note|DEFAULT/);
    expect(t.rows.map((r) => r.at(-1))).toEqual(['kept']);
  });

  it('an older dump still restores: a tenant-tuples table from before revoked_at takes the default', async () => {
    const dir = directory();
    const tables = withTable(await dir.exportDump(), '_substrat_tenant_tuples', (t) => ({
      ...t,
      // As K-21 found it: no tombstone column.
      ddl:
        'CREATE TABLE _substrat_tenant_tuples (tenant_id TEXT NOT NULL, subject TEXT NOT NULL, relation TEXT NOT NULL, ' +
        'object TEXT NOT NULL, expires_at TEXT, PRIMARY KEY (tenant_id, subject, relation, object))',
      columns: t.columns.filter((c) => c !== 'revoked_at'),
      rows: [[tenant, 'principal:Gus', 'member', 'org:o1', null]],
    }));
    expect(ddlOf(tables, '_substrat_tenant_tuples')).not.toMatch(/revoked_at/);
    await dir.importDump(tables);
    const t = (await dir.exportDump()).find((x) => x.name === '_substrat_tenant_tuples')!;
    expect(t.columns).toContain('revoked_at');
    expect(t.rows).toEqual([[tenant, 'principal:Gus', 'member', 'org:o1', null, null]]);
  });

  describe('refused, and the directory is left exactly as it was', () => {
    const refusals: [string, (tables: ScopeDumpTable[]) => ScopeDumpTable[], RegExp][] = [
      [
        'a spine table this code does not build',
        (tables) => [...tables, { name: '_Substrat_Smuggled', ddl: 'CREATE TABLE _Substrat_Smuggled (id TEXT)', columns: ['id'], rows: [['1']] }],
        /does not build: _Substrat_Smuggled/,
      ],
      [
        // A directory has no search index, so its namespace is a spine table this code does not
        // build; a scope restore skips it instead, since there the index is rebuilt.
        'a table in the search index’s namespace',
        (tables) => [
          ...tables,
          { name: '_SUBSTRAT_SEARCH_evil', ddl: 'CREATE TABLE _SUBSTRAT_SEARCH_evil (t TEXT REFERENCES _substrat_tenant_tuples(subject))', columns: ['t'], rows: [] },
        ],
        /does not build: _SUBSTRAT_SEARCH_evil/,
      ],
      ...(['rowid', 'OID', '_rowid_'] as const).map((alias): [string, (tables: ScopeDumpTable[]) => ScopeDumpTable[], RegExp] => [
        `a spine column named ${alias}`,
        (tables) =>
          withTable(tables, '_substrat_tenant_tuples', (t) => ({
            ...t,
            ddl: t.ddl.replace(/\)\s*$/, `, ${alias} INTEGER)`),
            columns: [...t.columns, alias],
            rows: t.rows.map((r) => [...r, 7]),
          })),
        new RegExp(`named for SQLite's rowid: ${alias}`),
      ]),
      [
        'a directory table declaring a foreign key to the spine',
        (tables) => [
          ...tables,
          { name: 'directory_probe', ddl: 'CREATE TABLE directory_probe (t TEXT REFERENCES "_Substrat_Roles"(role_key))', columns: ['t'], rows: [] },
        ],
        /foreign key to the platform spine/,
      ],
    ];
    for (const [what, craft, message] of refusals) {
      it(what, async () => {
        const dir = directory();
        const held = withTable(await dir.exportDump(), '_substrat_tenant_tuples', (t) => ({
          ...t,
          rows: [row(t, { tenant_id: tenant, subject: 'principal:Hal', relation: 'member', object: 'org:o1' })],
        }));
        await dir.importDump(held);
        const before = await dir.exportDump();
        // The crafted dump differs from what is held, so a restore that went through would show.
        const crafted = craft(
          withTable(before, '_substrat_tenant_tuples', (t) => ({ ...t, rows: t.rows.map((r) => r.map((v) => (v === 'principal:Hal' ? 'principal:Ivy' : v))) })),
        );
        await expect(dir.importDump(crafted)).rejects.toThrow(message);
        expect(await dir.exportDump()).toEqual(before);
      });
    }

    // Since #1912 a directory table this code does not build is refused whatever it references
    // (`directory-restore-tables.test.ts`), so the twin is a registry the directory does build.
    it('twin: a directory table whose DDL references another directory table restores', async () => {
      const dir = directory();
      const dump = await dir.exportDump();
      expect(ddlOf(dump, 'tenants')).toMatch(/REFERENCES tenants\(tenant_id\)/);
      await dir.importDump(dump);
      expect(ddlOf(await dir.exportDump(), 'tenants')).toBe(ddlOf(dump, 'tenants'));
    });
  });
});
