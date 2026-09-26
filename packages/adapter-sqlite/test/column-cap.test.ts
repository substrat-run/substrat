import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
const modWith = (migrations: { version: string; sql: string }[]): ModuleRegistration => ({
  manifest,
  migrations,
  operations: { 'wide/read': read as OperationHandler<never, unknown> },
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

    it('rolls the refused migration back: no table, no journal row', async () => {
      const sql = `CREATE TABLE wide_t (${cols(0, columns + 1)})`;
      await expect(provision([{ version: '0001', sql }])).rejects.toThrow();
      expect((await host.admin.getScopeRecord(staff, t, s))?.schemaVersion).toBe('0');
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

    it('judges the schema after the migration, not its text: a rebuild that narrows the table passes', async () => {
      await expect(
        provision([
          { version: '0001', sql: `CREATE TABLE wide_t (${cols(0, columns)})` },
          { version: '0002', sql: 'CREATE TABLE wide_u (id); INSERT INTO wide_u VALUES (1); DROP TABLE wide_t' },
        ]),
      ).resolves.toBeDefined();
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
      const sel = `${cols(0, 60).split(', ').map((c) => `a.${c}`).join(', ')}, ${cols(100, 140).split(', ').map((c) => `b.${c}`).join(', ')}`;
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
