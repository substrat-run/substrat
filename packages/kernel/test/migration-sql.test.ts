import { describe, expect, it } from 'vitest';
import { assertJournalDumpCoherent, assertMigrationSql, migrationDigest } from '../src/index.js';

/**
 * What a migration may run (#2066 r3). The full spine write guard holds every authored migration,
 * except four shipped, reviewed texts — and only those exact texts: an edit of one gets the guard.
 * Kernel-derived DDL creates spine-prefixed objects by design and is not held to it.
 */
describe('assertMigrationSql', () => {
  const REVIEWED = "UPDATE _substrat_tuples SET revoked_at = 'x'";
  it('refuses an authored spine write, and a TEMP object shadowing a spine table', async () => {
    for (const sql of ['UPDATE _substrat_tuples SET revoked_at = 1', 'CREATE TEMP TABLE _substrat_tuples (s TEXT)', 'DROP TABLE _substrat_outbox']) {
      expect(() => assertMigrationSql(sql, { key: '@x/m@0001', digest: 'd', authored: true })).toThrow(
        'migration @x/m@0001 cannot write the platform spine',
      );
    }
  });
  it('lets the same statement through for derived DDL, but never one naming the journal', () => {
    expect(() => assertMigrationSql('CREATE INDEX _substrat_list_x ON notes (id)', { key: '@x/m@list/n', digest: 'd', authored: false })).not.toThrow();
    expect(() => assertMigrationSql('DROP TRIGGER _substrat_migrations_digest_required', { key: '@x/m@list/n', digest: 'd', authored: false })).toThrow(
      'cannot name the migration journal',
    );
  });
  it("a reviewed ticket0 repair passes only as its exact shipped text", async () => {
    // The allowance is keyed by module, version AND digest: the right key with other text is refused.
    const step = { key: '@substrat-run/demo-ticket0@0020', digest: await migrationDigest(REVIEWED), authored: true };
    expect(() => assertMigrationSql(REVIEWED, step)).toThrow('cannot write the platform spine');
    const shipped = { ...step, digest: 'd29122b68f3cc5d07a70fb87874085e0e6805e2e19612984160488c59789d75c' };
    expect(() => assertMigrationSql(REVIEWED, shipped)).not.toThrow();
  });
});

describe('assertJournalDumpCoherent', () => {
  const ddl = (withDigest: boolean) =>
    `CREATE TABLE _substrat_migrations (module_id TEXT, version TEXT${withDigest ? ', sql_digest TEXT' : ''})`;
  it('accepts a journal whose DDL and columns agree, either way', () => {
    expect(() => assertJournalDumpCoherent([{ name: '_substrat_migrations', ddl: ddl(false), columns: ['module_id', 'version'] }])).not.toThrow();
    expect(() =>
      assertJournalDumpCoherent([{ name: '_substrat_migrations', ddl: ddl(true), columns: ['module_id', 'version', 'sql_digest'] }]),
    ).not.toThrow();
  });
  it('refuses one whose DDL and columns disagree, in both directions', () => {
    expect(() => assertJournalDumpCoherent([{ name: '_substrat_migrations', ddl: ddl(true), columns: ['module_id', 'version'] }])).toThrow(
      'declares sql_digest in its DDL but carries no such column',
    );
    expect(() =>
      assertJournalDumpCoherent([{ name: '_Substrat_Migrations', ddl: ddl(false), columns: ['module_id', 'version', 'SQL_DIGEST'] }]),
    ).toThrow('carries sql_digest but its DDL does not declare it');
  });
});
