/**
 * The order a scope applies a module's migrations in is the kernel's `moduleMigrations` (#1677):
 * what `substrat push` carries for the promote dialog, so the dialog lists them in the order they
 * run. Read off the journal in insertion order, i.e. the order they were applied.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { moduleManifest, platformActorId, scopeId, tenantId } from '@substrat-run/contracts';
import { moduleMigrations, ulid, UNSAFE_allowAllChecker, webCryptoSecretBox, type ModuleRegistration } from '@substrat-run/kernel';
import { SqliteScopeHost } from '../src/index.js';

const MODULE = '@test/ordered';

const orderedMod: ModuleRegistration = {
  manifest: moduleManifest.parse({
    id: MODULE,
    version: '1.0.0',
    kernelContract: '^0.0.1',
    permissions: [{ key: 'ordered:use', description: 'use it' }],
    events: { emits: [], consumes: [] },
    migrations: { journalDir: './migrations', compatibleFrom: '1.0.0' },
    attachmentTargets: [],
    entitlementKey: 'ordered',
    searchables: [{ entityType: 'orderednote', fields: ['body'], table: 'ordered_notes', idColumn: 'id' }],
    lists: [{ entityType: 'orderednote', sortable: ['created_at', 'id'], filterable: ['kind'], table: 'ordered_notes', idColumn: 'id' }],
  }),
  migrations: [
    { version: '0001-init', sql: 'CREATE TABLE ordered_notes (id TEXT PRIMARY KEY, body TEXT NOT NULL, kind TEXT, created_at TEXT);' },
    { version: '0002-more', sql: 'ALTER TABLE ordered_notes ADD COLUMN extra TEXT;' },
  ],
};

describe('a scope applies a module’s migrations in moduleMigrations order (#1677)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'substrat-migration-order-'));
  const host = new SqliteScopeHost({
    dir,
    checker: UNSAFE_allowAllChecker,
    secretBox: webCryptoSecretBox('test-key', new Uint8Array(32).fill(7)),
  });
  host.registerModule(orderedMod);
  afterAll(async () => {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('authored, then the search index, then the list index — exactly the kernel’s list', async () => {
    const staff = platformActorId.parse(ulid());
    const t = tenantId.parse(ulid());
    const s = scopeId.parse(ulid());
    await host.admin.createTenant(staff, { id: t, slug: `order-${ulid().toLowerCase()}`, name: 'Order' });
    await host.provisionScope(staff, { tenantId: t, scopeId: s, vertical: 'ordered' });
    const applied = await host.admin.queryScope(staff, t, s, {
      sql: `SELECT version FROM _substrat_migrations WHERE module_id = '${MODULE}' ORDER BY rowid`,
    });
    const expected = moduleMigrations(orderedMod).map((m) => m.version);
    expect(expected.map((v) => v.split('/')[0])).toEqual(['0001-init', '0002-more', 'search', 'list']);
    expect(applied.rows.map((r) => r[0])).toEqual(expected);
  });
});
