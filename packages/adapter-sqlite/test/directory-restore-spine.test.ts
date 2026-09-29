import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { platformActorId, tenantId, type DirectoryDump, type PrincipalId, type ScopeDumpTable } from '@substrat-run/contracts';
import { ulid } from '@substrat-run/kernel';
import { SqliteScopeHost } from '../src/index.js';
import { createTupleChecker } from '../src/checker.js';

/**
 * #1898 on the pure adapter: a directory restore builds the directory's `_substrat_*` tables
 * from this code's schema, never from the dump's DDL, and takes only the dump's rows, by column
 * name — the rules #1883 set for a scope. The directory holds `_substrat_tenant_tuples` and
 * `_substrat_roles`, which the permission checker reads, so a dump that declared their columns
 * COLLATE NOCASE decided how tenant-level grants matched.
 *
 * Every assertion reads the directory file itself, through its own connection, so an export's
 * access-log row never enters a comparison.
 */
describe('directory restore builds the spine from its own schema (#1898)', () => {
  let dir: string | undefined;
  let host: SqliteScopeHost | undefined;
  afterEach(async () => {
    await host?.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = host = undefined;
  });

  const staff = platformActorId.parse('01JZ00000000000000000000ST');
  const tenant = tenantId.parse(ulid());
  const T = (n: string) => `tenant:${n}`;

  const open = async (): Promise<SqliteScopeHost> => {
    dir = mkdtempSync(join(tmpdir(), 'directory-restore-spine-'));
    host = new SqliteScopeHost({ dir });
    await host.admin.createTenant(staff, { id: tenant, slug: 'acme', name: 'Acme' });
    return host;
  };

  /** The directory as its file holds it: every table's DDL and rows, in name order. */
  const snapshot = (): { name: string; ddl: string; columns: string[]; rows: unknown[][] }[] => {
    const db = new Database(join(dir!, '_directory.sqlite'), { readonly: true });
    try {
      const defs = db
        .prepare(`SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT GLOB 'sqlite_*' AND sql IS NOT NULL ORDER BY name`)
        .all() as { name: string; sql: string }[];
      return defs.map(({ name, sql }) => {
        const stmt = db.prepare(`SELECT * FROM "${name}"`).raw(true);
        return { name, ddl: sql, rows: stmt.all() as unknown[][], columns: stmt.columns().map((c) => c.name) };
      });
    } finally {
      db.close();
    }
  };
  const ddlOf = (name: string) => snapshot().find((t) => t.name === name)?.ddl;

  const withTable = (dump: DirectoryDump, name: string, edit: (t: ScopeDumpTable) => ScopeDumpTable): DirectoryDump => ({
    ...dump,
    tables: dump.tables.map((t) => (t.name === name ? edit(t) : t)),
  });
  const nocase = (ddl: string, ...columns: string[]) =>
    columns.reduce((d, c) => d.replace(new RegExp(`\\b${c} TEXT NOT NULL`), `${c} TEXT NOT NULL COLLATE NOCASE`), ddl);
  const row = (t: ScopeDumpTable, values: Record<string, unknown>) => t.columns.map((c) => values[c] ?? null);
  /** The two admin-log rows an applied switch-OFF writes (#1674's backfill reads them). */
  const switchedOff = (t: ScopeDumpTable, scope: string) => {
    const operationId = `op-${ulid()}`;
    const entry = (phase: string, extra: object) =>
      row(t, {
        id: ulid(), actor: 'staff', action: 'revokeFromSystem', tenant_id: tenant, scope_id: scope,
        after: JSON.stringify({ operationId, moduleId: '@test/sched', phase, ...extra }), at: '2026-09-01T00:00:00.000Z',
      });
    return [entry('intent', { reason: 'why' }), entry('applied', {})];
  };

  it('a NOCASE _substrat_tenant_tuples and _substrat_roles restore into BINARY tables, and the tenant-level check compares exactly', async () => {
    const h = await open();
    const built = { tuples: ddlOf('_substrat_tenant_tuples'), roles: ddlOf('_substrat_roles') };
    let dump = await h.admin.exportDirectory(staff);
    dump = withTable(dump, '_substrat_tenant_tuples', (t) => {
      const ddl = nocase(t.ddl, 'subject', 'relation', 'object');
      expect(ddl.match(/COLLATE NOCASE/g)).toHaveLength(3);
      return {
        ...t,
        ddl,
        rows: [
          ...t.rows,
          row(t, { tenant_id: tenant, subject: 'principal:Alice', relation: 'granted:notes/read', object: T(tenant) }),
          // Two rows a NOCASE key would have merged into one: both must land.
          row(t, { tenant_id: tenant, subject: 'principal:Bob', relation: 'granted:notes/read', object: T(tenant) }),
          row(t, { tenant_id: tenant, subject: 'principal:bob', relation: 'granted:notes/read', object: T(tenant) }),
        ],
      };
    });
    dump = withTable(dump, '_substrat_roles', (t) => ({
      ...t,
      ddl: nocase(t.ddl, 'role_key'),
      rows: [
        ...t.rows,
        row(t, { tenant_id: tenant, role_key: 'Editor', permissions: '["notes/write"]', source: 'custom' }),
        row(t, { tenant_id: tenant, role_key: 'editor', permissions: '["notes/read"]', source: 'custom' }),
      ],
    }));

    await h.admin.restoreDirectory(staff, dump);

    expect(ddlOf('_substrat_tenant_tuples')).toBe(built.tuples);
    expect(ddlOf('_substrat_roles')).toBe(built.roles);
    const db = new Database(join(dir!, '_directory.sqlite'), { readonly: true });
    try {
      expect(
        db.prepare(`SELECT subject FROM _substrat_tenant_tuples WHERE tenant_id = ? AND subject LIKE 'principal:%' ORDER BY subject`).pluck().all(tenant),
      ).toEqual(['principal:Alice', 'principal:Bob', 'principal:bob']);
      expect(db.prepare(`SELECT permissions FROM _substrat_roles WHERE tenant_id = ? AND role_key = 'editor'`).pluck().all(tenant)).toEqual([
        '["notes/read"]',
      ]);
      // The checker the host builds, over the restored directory.
      const checker = createTupleChecker({ directory: db, scopeDb: () => undefined, getRole: () => undefined });
      const check = (id: string) =>
        checker.check({ kind: 'principal', id: id as PrincipalId }, 'notes/read' as never, { tenantId: tenant } as never);
      expect((await check('Alice')).allowed).toBe(true);
      expect((await check('alice')).allowed).toBe(false);
      expect((await check('ALICE')).allowed).toBe(false);
    } finally {
      db.close();
    }
  });

  it('twin: a vertical-shaped (non-spine) table keeps the dump’s own DDL, NOCASE and all', async () => {
    const h = await open();
    const dump = await h.admin.exportDirectory(staff);
    const probe = { name: 'directory_probe', ddl: 'CREATE TABLE directory_probe (k TEXT COLLATE NOCASE PRIMARY KEY)', columns: ['k'], rows: [['A']] };
    await h.admin.restoreDirectory(staff, { ...dump, tables: [...dump.tables, probe] });
    expect(ddlOf('directory_probe')).toBe(probe.ddl);
  });

  it('export → restore → export round-trips: every table’s DDL and rows, plus the restore’s own audit row', async () => {
    const h = await open();
    const before = snapshot();
    await h.admin.restoreDirectory(staff, await h.admin.exportDirectory(staff));
    const after = snapshot();
    expect(after.map((t) => [t.name, t.ddl, t.columns])).toEqual(before.map((t) => [t.name, t.ddl, t.columns]));
    for (const t of after) {
      const was = before.find((b) => b.name === t.name)!;
      if (t.name === '_substrat_admin_log') {
        const action = t.columns.indexOf('action');
        expect(t.rows.slice(0, was.rows.length)).toEqual(was.rows);
        expect(t.rows.slice(was.rows.length).map((r) => r[action])).toEqual(['restoreDirectory']);
      } else {
        expect(t.rows).toEqual(was.rows);
      }
    }
  });

  it('a spine column this code does not know is kept bare and lowercased, with its values', async () => {
    const h = await open();
    const dump = withTable(await h.admin.exportDirectory(staff), '_substrat_tenant_tuples', (t) => ({
      ...t,
      ddl: t.ddl.replace(/\)\s*$/, ', Future_Note TEXT NOT NULL COLLATE NOCASE DEFAULT \'x\')'),
      columns: [...t.columns, 'Future_Note'],
      rows: [row({ ...t, columns: [...t.columns, 'Future_Note'] }, {
        tenant_id: tenant, subject: 'principal:Carol', relation: 'member', object: 'org:o1', Future_Note: 'kept',
      })],
    }));
    await h.admin.restoreDirectory(staff, dump);
    const t = snapshot().find((x) => x.name === '_substrat_tenant_tuples')!;
    expect(t.columns.at(-1)).toBe('future_note');
    // Bare: no type, collation, constraint or default reached the kernel's table.
    expect(t.ddl).toMatch(/ "future_note"[,\n)]/);
    expect(t.ddl).not.toMatch(/NOCASE|Future_Note|DEFAULT/);
    expect(t.rows.map((r) => r.at(-1))).toEqual(['kept']);
  });

  it('an older dump still restores: a tenant-tuples table from before revoked_at, and a directory from before the switch record (#1674 backfill)', async () => {
    const h = await open();
    let dump = await h.admin.exportDirectory(staff);
    dump = withTable(dump, '_substrat_tenant_tuples', (t) => {
      const columns = t.columns.filter((c) => c !== 'revoked_at');
      return {
        ...t,
        // As K-21 found it: no tombstone column.
        ddl:
          'CREATE TABLE _substrat_tenant_tuples (tenant_id TEXT NOT NULL, subject TEXT NOT NULL, relation TEXT NOT NULL, ' +
          'object TEXT NOT NULL, expires_at TEXT, PRIMARY KEY (tenant_id, subject, relation, object))',
        columns,
        rows: [[tenant, 'principal:Dan', 'member', 'org:o1', null]],
      };
    });
    expect(dump.tables.find((t) => t.name === '_substrat_tenant_tuples')!.ddl).not.toMatch(/revoked_at/);
    // Before #1674: no record table, and an applied OFF in the admin log.
    dump = { ...dump, tables: dump.tables.filter((t) => t.name !== '_substrat_system_switches') };
    dump = withTable(dump, '_substrat_admin_log', (t) => ({
      ...t,
      rows: [
        ...t.rows,
        ...switchedOff(t, 's-1'),
      ],
    }));
    await h.admin.restoreDirectory(staff, dump);
    const tuples = snapshot().find((t) => t.name === '_substrat_tenant_tuples')!;
    expect(tuples.columns).toContain('revoked_at');
    expect(tuples.rows).toEqual([[tenant, 'principal:Dan', 'member', 'org:o1', null, null]]);
    const switches = snapshot().find((t) => t.name === '_substrat_system_switches')!;
    const at = (c: string) => switches.columns.indexOf(c);
    expect(switches.rows.map((r) => [r[at('scope_id')], r[at('position')], r[at('reason')]])).toEqual([['s-1', 'off', 'why']]);
  });

  it('twin: a dump that carries the switch record keeps its rows and is not backfilled over', async () => {
    const h = await open();
    const dump = await h.admin.exportDirectory(staff);
    const withHistory = withTable(dump, '_substrat_admin_log', (t) => ({
      ...t,
      rows: [
        ...t.rows,
        ...switchedOff(t, 's-2'),
      ],
    }));
    expect(withHistory.tables.some((t) => t.name === '_substrat_system_switches')).toBe(true);
    await h.admin.restoreDirectory(staff, withHistory);
    expect(snapshot().find((t) => t.name === '_substrat_system_switches')!.rows).toEqual([]);
  });

  describe('refused, and the directory is left exactly as it was', () => {
    const refusals: [string, (dump: DirectoryDump) => DirectoryDump, RegExp][] = [
      [
        'a spine table this code does not build',
        (d) => ({ ...d, tables: [...d.tables, { name: '_Substrat_Smuggled', ddl: 'CREATE TABLE _Substrat_Smuggled (id TEXT)', columns: ['id'], rows: [['1']] }] }),
        /does not build: _Substrat_Smuggled/,
      ],
      [
        // A directory has no search index, so its namespace is a spine table this code does not
        // build; a scope restore skips it instead, since there the index is rebuilt.
        'a table in the search index’s namespace',
        (d) => ({ ...d, tables: [...d.tables, { name: '_SUBSTRAT_SEARCH_evil', ddl: 'CREATE TABLE _SUBSTRAT_SEARCH_evil (t TEXT REFERENCES _substrat_tenant_tuples(subject))', columns: ['t'], rows: [] }] }),
        /does not build: _SUBSTRAT_SEARCH_evil/,
      ],
      ...(['rowid', 'OID', '_rowid_'] as const).map((alias): [string, (dump: DirectoryDump) => DirectoryDump, RegExp] => [
        `a spine column named ${alias}`,
        (d) =>
          withTable(d, '_substrat_admin_log', (t) => ({
            ...t,
            ddl: t.ddl.replace(/\)\s*$/, `, ${alias} INTEGER)`),
            columns: [...t.columns, alias],
            rows: t.rows.map((r) => [...r, 7]),
          })),
        new RegExp(`named for SQLite's rowid: ${alias}`),
      ]),
      [
        'a directory table declaring a foreign key to the spine',
        (d) => ({
          ...d,
          tables: [...d.tables, { name: 'directory_probe', ddl: 'CREATE TABLE directory_probe (t TEXT REFERENCES _Substrat_Tenant_Tuples(subject))', columns: ['t'], rows: [] }],
        }),
        /foreign key to the platform spine/,
      ],
    ];
    for (const [what, craft, message] of refusals) {
      it(what, async () => {
        const h = await open();
        await h.admin.createTenant(staff, { id: tenantId.parse(ulid()), slug: 'kept', name: 'Kept' });
        const dump = craft(await h.admin.exportDirectory(staff));
        // Diverge past the copy, so a restore that went through would be visible.
        await h.admin.createTenant(staff, { id: tenantId.parse(ulid()), slug: 'after-copy', name: 'After' });
        const before = snapshot();
        await expect(h.admin.restoreDirectory(staff, dump)).rejects.toThrow(message);
        expect(snapshot()).toEqual(before);
      });
    }

    it('twin: a directory table referencing another directory table restores', async () => {
      const h = await open();
      const dump = await h.admin.exportDirectory(staff);
      const probe = { name: 'directory_probe', ddl: 'CREATE TABLE directory_probe (t TEXT REFERENCES tenants(tenant_id))', columns: ['t'], rows: [[tenant]] };
      await h.admin.restoreDirectory(staff, { ...dump, tables: [...dump.tables, probe] });
      expect(snapshot().find((t) => t.name === 'directory_probe')!.rows).toEqual([[tenant]]);
    });
  });
});
