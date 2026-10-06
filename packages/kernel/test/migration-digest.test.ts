import { describe, expect, it } from 'vitest';
import { moduleManifest } from '@substrat-run/contracts';
import { migrationDigest, migrationSteps, type SqlMigration } from '../src/index.js';

/**
 * `migrationSteps` (#2066) reads the registration as it is when called. Its digest cache is
 * keyed on the SQL text, so a registration object changed (or rebuilt) with other SQL under the
 * same version is planned with that SQL and its digest — never the first one it was asked about.
 */
describe('migrationSteps', () => {
  const manifest = moduleManifest.parse({
    id: 'notes',
    version: '1.0.0',
    kernelContract: '^0.0.1',
    permissions: [{ key: 'notes:use', description: 'use it' }],
    events: { emits: [], consumes: [] },
    migrations: { journalDir: './migrations', compatibleFrom: '1.0.0' },
    attachmentTargets: [],
    entitlementKey: 'notes',
    lists: [{ entityType: 'note', sortable: ['id'], table: 'notes', idColumn: 'id' }],
  });

  it('plans a changed registration object with its new SQL and digest, derived steps unaffected', async () => {
    const first: SqlMigration = { version: '0001-init', sql: 'CREATE TABLE notes (id TEXT PRIMARY KEY);' };
    const registration: { manifest: typeof manifest; migrations: SqlMigration[] } = { manifest, migrations: [first] };
    const before = await migrationSteps(registration);
    expect(before[0]).toEqual({ migration: first, digest: await migrationDigest(first.sql), authored: true });

    const second: SqlMigration = { version: '0001-init', sql: 'CREATE TABLE notes (id TEXT PRIMARY KEY, body TEXT);' };
    registration.migrations = [second];
    const after = await migrationSteps(registration);
    expect(after[0]).toEqual({ migration: second, digest: await migrationDigest(second.sql), authored: true });
    expect(after[0]!.digest).not.toBe(before[0]!.digest);
    // The kernel's list index: same declaration, same step, and not held to its digest.
    expect(after.slice(1)).toEqual(before.slice(1));
    expect(after.slice(1).map((s) => s.authored)).toEqual([false]);
  });
});
