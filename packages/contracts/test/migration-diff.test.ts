import { describe, expect, it } from 'vitest';
import {
  deployManifest,
  migrationsOnTop,
  DECLARED_MIGRATIONS_SQL_BYTES_MAX,
  MIGRATION_READ_MAX,
  MIGRATION_READ_SQL_BYTES_MAX,
} from '../src/index.js';

const m = (version: string, sql = `-- ${version}`) => ({ moduleId: 'helpdesk', version, sql });

describe('migrationsOnTop (#1677)', () => {
  it('lists what the base lacks, in the incoming order, and keys on module AND version', () => {
    const other = { moduleId: 'other', version: '0001', sql: 'x' };
    const diff = migrationsOnTop([m('0001'), other, m('0002')], [m('0001')]);
    expect(diff.added).toEqual([other, m('0002')]);
    expect(diff).toMatchObject({ baseline: 'version', changed: [], total: 2, truncated: false });
  });

  it('adds nothing when the base is the same set', () => {
    expect(migrationsOnTop([m('0001')], [m('0001')])).toMatchObject({ added: [], changed: [], total: 0 });
  });

  it('bounds the count, and says so', () => {
    const many = Array.from({ length: MIGRATION_READ_MAX + 5 }, (_, i) => m(String(i).padStart(4, '0')));
    const diff = migrationsOnTop(many, []);
    expect(diff.added).toHaveLength(MIGRATION_READ_MAX);
    expect(diff).toMatchObject({ total: MIGRATION_READ_MAX + 5, truncated: true });
  });

  it('bounds the SQL bytes, keeping each id with `sql: null` past the budget', () => {
    const half = 'x'.repeat(MIGRATION_READ_SQL_BYTES_MAX / 2 + 1);
    const diff = migrationsOnTop([m('0001', half), m('0002', half), m('0003', 'small')], []);
    expect(diff.added.map((e) => [e.version, e.sql === null])).toEqual([
      ['0001', false],
      ['0002', true],
      ['0003', false],
    ]);
    expect(diff.truncated).toBe(true);
  });

  it('spends the budget on an edited shipped migration before the added ones', () => {
    const big = 'x'.repeat(MIGRATION_READ_SQL_BYTES_MAX);
    const diff = migrationsOnTop([m('0001', big), m('0002', 'new')], [m('0001', 'old')]);
    expect(diff.changed[0]?.sql).toBe(big);
    expect(diff.added[0]).toEqual({ moduleId: 'helpdesk', version: '0002', sql: null });
  });
});

describe('deployManifest.migrations', () => {
  const base = {
    version: '1.0.0',
    entry: 'index.js',
    compatibilityDate: '2026-07-01',
    registry: { permissions: [], roles: [], entityGrants: [] },
    digests: { manifest: 'm', permission: 'p', migration: 'g' },
  };

  it('is optional, and absence stays absence (not `[]`)', () => {
    expect(deployManifest.parse(base).migrations).toBeUndefined();
    expect(deployManifest.parse({ ...base, migrations: [] }).migrations).toEqual([]);
  });

  it('refuses more SQL than the cap at the trust boundary', () => {
    const sql = 'x'.repeat(DECLARED_MIGRATIONS_SQL_BYTES_MAX);
    expect(deployManifest.safeParse({ ...base, migrations: [m('1', sql)] }).success).toBe(true);
    expect(deployManifest.safeParse({ ...base, migrations: [m('1', sql), m('2', 'y')] }).success).toBe(false);
  });
});
