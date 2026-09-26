import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { moduleManifest, type ScopeDump, platformActorId, principalId, scopeId, tenantId } from '@substrat-run/contracts';
import { DO_SQL_LIMITS, ulid, UNSAFE_allowAllChecker } from '@substrat-run/kernel';
import type { ModuleRegistration, OperationHandler } from '@substrat-run/kernel';
import { SqliteScopeHost } from '../src/index.js';

/**
 * #1811: a Durable Object's SQLite holds at most `DO_SQL_LIMITS.columns` columns in a table and
 * in a result set; node's allows 2000. Each case is a refusal with its twin at exactly the limit,
 * so a guard that refused everything fails as surely as one that refused nothing.
 */
const { columns } = DO_SQL_LIMITS;
const cols = (from: number, to: number): string =>
  Array.from({ length: to - from }, (_, i) => `c${from + i}`).join(', ');

const manifest = moduleManifest.parse({
  id: '@test/wide',
  version: '1.0.0',
  kernelContract: '^0.0.1',
  permissions: [{ key: 'wide:use', description: 'wide' }],
  events: { emits: [], consumes: [] },
  migrations: { journalDir: './migrations', compatibleFrom: '1.0.0' },
  attachmentTargets: [],
  entitlementKey: 'wide',
});
const read: OperationHandler<{ sql: string }, unknown> = (ctx, input) => ctx.sql.query(input.sql);
const run: OperationHandler<{ sql: string }, unknown> = (ctx, input) => ctx.sql.exec(input.sql);
const modWith = (migrations: { version: string; sql: string }[]): ModuleRegistration => ({
  manifest,
  migrations,
  operations: {
    'wide/read': read as OperationHandler<never, unknown>,
    'wide/exec': run as OperationHandler<never, unknown>,
  },
});

describe('the column cap of a Durable Object, on node (#1811)', () => {
  let dir: string;
  let host: SqliteScopeHost;
  const staff = platformActorId.parse(ulid());
  const alice = principalId.parse(ulid());
  const t = tenantId.parse(ulid());

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'substrat-colcap-'));
    host = new SqliteScopeHost({ dir, checker: UNSAFE_allowAllChecker });
    await host.admin.createTenant(staff, { id: t, slug: `t-${t.toLowerCase()}`, name: 'T' });
    await host.admin.grantEntitlement(staff, t, 'wide');
  });
  afterEach(async () => {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  });

  /** Provision a scope of the module; resolves with the stub, rejects if a migration is refused. */
  let s: ReturnType<typeof scopeId.parse>;
  const provision = async (migrations: { version: string; sql: string }[]) => {
    host.registerModule(modWith(migrations));
    s = scopeId.parse(ulid());
    await host.provisionScope(staff, { tenantId: t, scopeId: s, jurisdiction: 'eu' });
    await host.admin.activateScope(staff, t, s);
    return { stub: await host.getScope(alice, t, s) };
  };

  describe('a migration', () => {
    it(`creates a table of exactly ${columns} columns`, async () => {
      await expect(provision([{ version: '0001', sql: `CREATE TABLE wide_t (${cols(0, columns)})` }])).resolves.toBeDefined();
    });

    it(`refuses a table of ${columns + 1} columns, as the DO would, and the scope fails closed`, async () => {
      await expect(provision([{ version: '0001', sql: `CREATE TABLE wide_t (${cols(0, columns + 1)})` }])).rejects.toThrow(
        /migration failed for @test\/wide@0001 — scope fails closed: too many columns on wide_t: SQLITE_ERROR/,
      );
    });

    it('rolls the refused migration back: the table is absent and no journal row was written', async () => {
      await expect(provision([{ version: '0001', sql: `CREATE TABLE wide_t (${cols(0, columns + 1)})` }])).rejects.toThrow();
      // The scope fails closed, so read its file directly.
      const db = new Database(join(dir, `${t}__${s}.sqlite`), { readonly: true });
      try {
        expect(db.prepare(`SELECT name FROM sqlite_master WHERE name = 'wide_t'`).all()).toEqual([]);
        expect(db.prepare(`SELECT version FROM _substrat_migrations WHERE module_id = '@test/wide'`).all()).toEqual([]);
      } finally {
        db.close();
      }
    });

    it(`ALTER TABLE … ADD COLUMN up to ${columns} columns runs`, async () => {
      await expect(
        provision([
          { version: '0001', sql: `CREATE TABLE wide_t (${cols(0, columns - 1)})` },
          { version: '0002', sql: 'ALTER TABLE wide_t ADD COLUMN one_more' },
        ]),
      ).resolves.toBeDefined();
    });

    it(`ALTER TABLE … ADD COLUMN across ${columns} is refused, and 0001 stays applied`, async () => {
      await expect(
        provision([
          { version: '0001', sql: `CREATE TABLE wide_t (${cols(0, columns)})` },
          { version: '0002', sql: 'ALTER TABLE wide_t ADD COLUMN one_too_many' },
        ]),
      ).rejects.toThrow(/@test\/wide@0002 — scope fails closed: too many columns on wide_t: SQLITE_ERROR/);
      expect((await host.admin.getScopeRecord(staff, t, s))?.migrationFailure?.version).toBe('@test/wide@0002');
    });

    // The DO counts a generated column and a virtual table's hidden columns (measured on
    // workerd), and `PRAGMA table_info` shows neither.
    const generated = (plain: number, gen: number): string =>
      `CREATE TABLE wide_g (${cols(0, plain)}, ${Array.from({ length: gen }, (_, i) => `g${i} GENERATED ALWAYS AS (c0) VIRTUAL`).join(', ')})`;
    it(`counts generated columns: ${columns - 5} plain + 5 generated runs`, async () => {
      await expect(provision([{ version: '0001', sql: generated(columns - 5, 5) }])).resolves.toBeDefined();
    });
    it(`counts generated columns: ${columns - 5} plain + 6 generated is refused`, async () => {
      await expect(provision([{ version: '0001', sql: generated(columns - 5, 6) }])).rejects.toThrow(
        /too many columns on wide_g/,
      );
    });
    // fts5 carries two hidden columns (the table's name and rank) on top of the ones declared.
    const fts = (n: number): string => `CREATE VIRTUAL TABLE wide_f USING fts5(${cols(0, n)})`;
    it(`counts an fts5 table's hidden columns: ${columns - 2} declared (+2 hidden) runs`, async () => {
      await expect(provision([{ version: '0001', sql: fts(columns - 2) }])).resolves.toBeDefined();
    });
    it(`counts an fts5 table's hidden columns: ${columns - 1} declared (+2 hidden) is refused`, async () => {
      await expect(provision([{ version: '0001', sql: fts(columns - 1) }])).rejects.toThrow(
        /too many columns on wide_f/,
      );
    });

    it('judges the schema after the migration, not its text: a rebuild that narrows the table passes', async () => {
      await expect(
        provision([
          { version: '0001', sql: `CREATE TABLE wide_t (${cols(0, columns)})` },
          { version: '0002', sql: 'CREATE TABLE wide_u (id); INSERT INTO wide_u VALUES (1); DROP TABLE wide_t' },
        ]),
      ).resolves.toBeDefined();
    });
  });

  describe('DDL a module runs itself, outside a migration', () => {
    const tableExists = async (stub: { invoke: (op: string, i: unknown) => Promise<unknown> }, name: string) =>
      ((await stub.invoke('wide/read', { sql: `SELECT name FROM sqlite_master WHERE name = '${name}'` })) as unknown[]).length === 1;
    const seed = [{ version: '0001', sql: `CREATE TABLE wide_t (${cols(0, columns)}); CREATE TABLE wide_n (${cols(0, columns - 1)})` }];

    it(`a CREATE TABLE of ${columns} columns runs`, async () => {
      const { stub } = await provision(seed);
      await stub.invoke('wide/exec', { sql: `CREATE TABLE wide_rt (${cols(0, columns)})` });
      expect(await tableExists(stub, 'wide_rt')).toBe(true);
    });

    it(`a CREATE TABLE of ${columns + 1} columns is refused and rolled back`, async () => {
      const { stub } = await provision(seed);
      await expect(stub.invoke('wide/exec', { sql: `CREATE TABLE wide_rt (${cols(0, columns + 1)})` })).rejects.toThrow(
        /too many columns on wide_rt/,
      );
      expect(await tableExists(stub, 'wide_rt')).toBe(false);
    });

    it(`an ADD COLUMN to ${columns} columns runs`, async () => {
      const { stub } = await provision(seed);
      await stub.invoke('wide/exec', { sql: 'ALTER TABLE wide_n ADD COLUMN one_more' });
      expect((await stub.invoke('wide/read', { sql: 'SELECT one_more FROM wide_n' })) as unknown[]).toEqual([]);
    });

    it(`an ADD COLUMN across ${columns} is refused and rolled back`, async () => {
      const { stub } = await provision(seed);
      await expect(stub.invoke('wide/exec', { sql: 'ALTER TABLE wide_t ADD COLUMN one_too_many' })).rejects.toThrow(
        /too many columns on wide_t/,
      );
      await expect(stub.invoke('wide/read', { sql: 'SELECT one_too_many FROM wide_t' })).rejects.toThrow(/no such column/);
    });

    it('a write to a table already at the limit is unaffected', async () => {
      const { stub } = await provision(seed);
      await expect(stub.invoke('wide/exec', { sql: 'INSERT INTO wide_t (c0) VALUES (1)' })).resolves.toEqual({ changes: 1 });
    });
  });

  describe('a result set', () => {
    // Two tables of 60 columns: neither is wide, and `SELECT *` over the join is 120 wide.
    const two = [
      { version: '0001', sql: `CREATE TABLE wide_a (${cols(0, 60)}); CREATE TABLE wide_b (${cols(100, 160)})` },
    ];

    it('refuses a SELECT * over a join of two mid-width tables', async () => {
      const { stub } = await provision(two);
      await expect(stub.invoke('wide/read', { sql: 'SELECT * FROM wide_a, wide_b' })).rejects.toThrow(
        /^too many columns in result set: SQLITE_ERROR$/,
      );
    });

    it(`runs the same join projected to exactly ${columns} columns`, async () => {
      const { stub } = await provision(two);
      const of = (alias: string, from: number, to: number): string =>
        cols(from, to).split(', ').map((c) => `${alias}.${c}`).join(', ');
      const sel = `${of('a', 0, 60)}, ${of('b', 100, 140)}`;
      await expect(stub.invoke('wide/read', { sql: `SELECT ${sel} FROM wide_a a, wide_b b` })).resolves.toEqual([]);
    });
  });

  describe('a dump', () => {
    // Node CAN hold a wide table (SQLite's own cap is 2000), so a node restore of one stays
    // accepted: only the move onto a Durable Object cannot work, and that side refuses it.
    it(`loads a table of ${columns + 1} columns into a node scope`, async () => {
      await provision([{ version: '0001', sql: 'CREATE TABLE wide_t (id)' }]);
      const dump = await host.admin.exportScope(staff, t, s);
      const names = Array.from({ length: columns + 1 }, (_, i) => `c${i}`);
      const wide: ScopeDump = {
        ...dump,
        tables: [
          ...dump.tables.filter((x) => x.name !== 'wide_t'),
          { name: 'wide_t', ddl: `CREATE TABLE wide_t (${names.join(', ')})`, columns: names, rows: [] },
        ],
      };
      await expect(host.restoreScope(staff, t, s, wide)).resolves.toBeUndefined();
    });
  });
});
