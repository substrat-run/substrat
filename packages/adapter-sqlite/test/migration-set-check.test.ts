/**
 * The integrity check at apply time (#2349), on the pure host: a migration pass with anything
 * pending applies nothing unless the migrations the host registers are the ones stored for the
 * version it runs — the set digest the hosted uploader injects as `SUBSTRAT_MIGRATIONS_DIGEST`,
 * handed in here as `migrationsDigest`. A new host over the same directory is a redeploy, as in
 * `migration-digest.test.ts`. The Durable-Object half is `adapter-cloudflare/test/migration-set-check.test.ts`.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { testOperations } from '@substrat-run/contract-tests';
import { moduleManifest, platformActorId, principalId, scopeId, tenantId } from '@substrat-run/contracts';
import {
  migrationDigest,
  migrationSetDigest,
  moduleMigrations,
  ulid,
  UNSAFE_allowAllChecker,
  type ModuleRegistration,
  type OperationHandler,
  type SqlMigration,
} from '@substrat-run/kernel';
import { migrationSetDigestComputations } from '@substrat-run/kernel/testing';
import { SqliteScopeHost } from '../src/index.js';

const MODULE = '@test/set-check';

const modWith = (migrations: SqlMigration[]): ModuleRegistration => ({
  manifest: moduleManifest.parse({
    id: MODULE,
    version: '1.0.0',
    kernelContract: '^0.0.1',
    permissions: [{ key: 'setcheck:use', description: 'use it' }],
    events: { emits: [], consumes: [] },
    migrations: { journalDir: './migrations', compatibleFrom: '1.0.0' },
    attachmentTargets: [],
    entitlementKey: 'setcheck',
  }),
  migrations,
  ...testOperations({
    'setcheck/add': (async (ctx) => {
      ctx.sql.exec('INSERT INTO set_notes (id) VALUES (?)', [ulid()]);
      return null;
    }) as OperationHandler<never, unknown>,
  }),
});

const INIT = { version: '0001-init', sql: 'CREATE TABLE set_notes (id TEXT PRIMARY KEY);' };
const NEXT = { version: '0002-next', sql: 'ALTER TABLE set_notes ADD COLUMN folder TEXT;' };
/** What the push declared under the same version, when the deployed build registers `NEXT`. */
const STORED_NEXT = { version: '0002-next', sql: 'ALTER TABLE set_notes ADD COLUMN uses INTEGER;' };

/** The digest the uploader injects for a version storing `migrations`: the kernel function it calls, over the push's flattened list. */
const storedDigest = (migrations: SqlMigration[]) =>
  migrationSetDigest(moduleMigrations(modWith(migrations)).map((m) => ({ moduleId: MODULE, version: m.version, sql: m.sql })));

describe('the migration set check at apply time (#2349)', () => {
  const dirs: string[] = [];
  const staff = platformActorId.parse(ulid());
  const who = principalId.parse(ulid());
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  const hostOver = (dir: string, migrations: SqlMigration[], migrationsDigest?: string) => {
    const host = new SqliteScopeHost({ dir, checker: UNSAFE_allowAllChecker, ...(migrationsDigest ? { migrationsDigest } : {}) });
    host.registerModule(modWith(migrations));
    return host;
  };
  /** A scope provisioned and migrated by a host running `migrations` under `digest`; the host is closed after. */
  const scopeRanWith = async (migrations: SqlMigration[], digest?: string) => {
    const dir = mkdtempSync(join(tmpdir(), 'substrat-set-check-'));
    dirs.push(dir);
    const t = tenantId.parse(ulid());
    const s = scopeId.parse(ulid());
    const v1 = hostOver(dir, migrations, digest);
    await v1.admin.createTenant(staff, { id: t, slug: `set-check-${ulid().toLowerCase()}`, name: 'Set check' });
    await v1.admin.grantEntitlement(staff, t, 'setcheck');
    await v1.provisionScope(staff, { tenantId: t, scopeId: s, vertical: 'set-check' });
    await v1.admin.activateScope(staff, t, s);
    await (await v1.getScope(who, t, s)).invoke('setcheck/add', {});
    await v1.close();
    return { dir, t, s, file: join(dir, `${t}__${s}.sqlite`) };
  };
  const journalOf = (file: string) => {
    const db = new Database(file, { readonly: true });
    try {
      return db.prepare('SELECT version, sql_digest FROM _substrat_migrations WHERE module_id = ? ORDER BY version').all(MODULE);
    } finally {
      db.close();
    }
  };
  const columnsOf = (file: string) => {
    const db = new Database(file, { readonly: true });
    try {
      return (db.prepare('PRAGMA table_info(set_notes)').all() as { name: string }[]).map((c) => c.name);
    } finally {
      db.close();
    }
  };

  it('applies when the registered migrations are the stored ones', async () => {
    const { dir, t, s, file } = await scopeRanWith([INIT], await storedDigest([INIT]));
    const next = hostOver(dir, [INIT, NEXT], await storedDigest([INIT, NEXT]));
    try {
      await (await next.getScope(who, t, s)).invoke('setcheck/add', {});
      expect(journalOf(file)).toEqual([
        { version: '0001-init', sql_digest: await migrationDigest(INIT.sql) },
        { version: '0002-next', sql_digest: await migrationDigest(NEXT.sql) },
      ]);
    } finally {
      await next.close();
    }
  });

  it('refuses, applying nothing, when the registered SQL differs from the stored migration', async () => {
    const { dir, t, s, file } = await scopeRanWith([INIT], await storedDigest([INIT]));
    const stored = await storedDigest([INIT, STORED_NEXT]);
    const registered = await storedDigest([INIT, NEXT]);
    const next = hostOver(dir, [INIT, NEXT], stored);
    try {
      await expect(next.getScope(who, t, s)).rejects.toThrow(
        `migration failed for ${MODULE}@0002-next — scope fails closed: the migrations this deployment registers are not ` +
          `the ones stored for the version it serves (registered set sha256 ${registered}, stored ${stored}); ` +
          `registered: ${MODULE}@0001-init, ${MODULE}@0002-next. Nothing was applied.`,
      );
      // The directory records it the way it records a migration that threw.
      const record = await next.admin.getScopeRecord(staff, t, s);
      expect(record?.migrationFailure?.version).toBe(`${MODULE}@0002-next`);
      expect(record?.migrationFailure?.error).toContain(stored);
      // Nothing ran: no journal row, no column.
      expect(journalOf(file)).toEqual([{ version: '0001-init', sql_digest: await migrationDigest(INIT.sql) }]);
      expect(columnsOf(file)).toEqual(['id']);
    } finally {
      await next.close();
    }
    // Pushing again from the deployed build stores its migrations, and the scope applies them.
    const fixed = hostOver(dir, [INIT, NEXT], registered);
    try {
      expect(await fixed.migrateScope(t, s)).toEqual({ status: 'migrated', schemaVersion: '2' });
      await (await fixed.getScope(who, t, s)).invoke('setcheck/add', {});
      expect(columnsOf(file)).toEqual(['id', 'folder']);
    } finally {
      await fixed.close();
    }
  });

  it('refuses a new scope too: a first provision applies nothing either', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'substrat-set-check-'));
    dirs.push(dir);
    const t = tenantId.parse(ulid());
    const s = scopeId.parse(ulid());
    const host = hostOver(dir, [INIT, NEXT], await storedDigest([INIT, STORED_NEXT]));
    try {
      await host.admin.createTenant(staff, { id: t, slug: `set-check-${ulid().toLowerCase()}`, name: 'Set check' });
      await host.admin.grantEntitlement(staff, t, 'setcheck');
      await expect(
        (async () => {
          await host.provisionScope(staff, { tenantId: t, scopeId: s, vertical: 'set-check' });
          await host.admin.activateScope(staff, t, s);
          await host.getScope(who, t, s);
        })(),
      ).rejects.toThrow(`migration failed for ${MODULE}@0001-init — scope fails closed: the migrations this deployment registers`);
      expect(journalOf(join(dir, `${t}__${s}.sqlite`))).toEqual([]);
    } finally {
      await host.close();
    }
  });

  it('compares nothing without a stored digest: an unheld version, or a host that was never handed one', async () => {
    const { dir, t, s, file } = await scopeRanWith([INIT]);
    const next = hostOver(dir, [INIT, NEXT]);
    try {
      await (await next.getScope(who, t, s)).invoke('setcheck/add', {});
      expect(journalOf(file)).toEqual([
        { version: '0001-init', sql_digest: await migrationDigest(INIT.sql) },
        { version: '0002-next', sql_digest: await migrationDigest(NEXT.sql) },
      ]);
    } finally {
      await next.close();
    }
  });

  it('a scope with nothing pending never computes the digest, and serves whatever the stored one says', async () => {
    const { dir, t, s } = await scopeRanWith([INIT, NEXT], await storedDigest([INIT, NEXT]));
    const same = hostOver(dir, [INIT, NEXT], await storedDigest([INIT, STORED_NEXT]));
    try {
      const before = migrationSetDigestComputations();
      await (await same.getScope(who, t, s)).invoke('setcheck/add', {});
      expect(migrationSetDigestComputations()).toBe(before);
    } finally {
      await same.close();
    }
  });
});
