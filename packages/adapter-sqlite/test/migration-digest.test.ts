/**
 * The journal's SQL digest across a redeploy (#2066) — a new host over the same directory, as
 * `migration-failure.test.ts` and `entity-state-upgrade.test.ts` use it. The contract suite
 * holds both adapters to the rule through a restored dump; this is the issue's own story on
 * the pure host, plus the upgrade of a scope file built before the column existed.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { journalFenceDropMod, journalWriteMod, spineDropMod, spineShadowMod } from '@substrat-run/contract-tests';
import { moduleManifest, platformActorId, principalId, scopeId, tenantId } from '@substrat-run/contracts';
import { migrationDigest, ulid, UNSAFE_allowAllChecker, type ModuleRegistration, type OperationHandler, type SqlMigration } from '@substrat-run/kernel';
import { SqliteScopeHost } from '../src/index.js';

const MODULE = '@test/digest';

const modWith = (migrations: SqlMigration[]): ModuleRegistration => ({
  manifest: moduleManifest.parse({
    id: MODULE,
    version: '1.0.0',
    kernelContract: '^0.0.1',
    permissions: [{ key: 'digest:use', description: 'use it' }],
    events: { emits: [], consumes: [] },
    migrations: { journalDir: './migrations', compatibleFrom: '1.0.0' },
    attachmentTargets: [],
    entitlementKey: 'digest',
  }),
  migrations,
  operations: {
    'digest/add': (async (ctx) => {
      ctx.sql.exec('INSERT INTO digest_notes (id) VALUES (?)', [ulid()]);
      return null;
    }) as OperationHandler<never, unknown>,
  },
});

const INIT = { version: '0001-init', sql: 'CREATE TABLE digest_notes (id TEXT PRIMARY KEY);' };
/** Two branches each appended the next number to the journal — #2065 and #2063's shape. */
const BRANCH_A = { version: '0002-next', sql: 'ALTER TABLE digest_notes ADD COLUMN folder TEXT;' };
const BRANCH_B = { version: '0002-next', sql: 'ALTER TABLE digest_notes ADD COLUMN uses INTEGER;' };

describe('the migration journal digest across a redeploy (#2066)', () => {
  const dirs: string[] = [];
  const staff = platformActorId.parse(ulid());
  const who = principalId.parse(ulid());
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  /** A scope provisioned and migrated by a host running `migrations`; the host is closed after. */
  const scopeRanWith = async (migrations: SqlMigration[]) => {
    const dir = mkdtempSync(join(tmpdir(), 'substrat-digest-'));
    dirs.push(dir);
    const t = tenantId.parse(ulid());
    const s = scopeId.parse(ulid());
    const v1 = new SqliteScopeHost({ dir, checker: UNSAFE_allowAllChecker });
    v1.registerModule(modWith(migrations));
    await v1.admin.createTenant(staff, { id: t, slug: `digest-${ulid().toLowerCase()}`, name: 'Digest' });
    await v1.admin.grantEntitlement(staff, t, 'digest');
    await v1.provisionScope(staff, { tenantId: t, scopeId: s, vertical: 'digest' });
    await v1.admin.activateScope(staff, t, s);
    await (await v1.getScope(who, t, s)).invoke('digest/add', {});
    await v1.close();
    return { dir, t, s, file: join(dir, `${t}__${s}.sqlite`) };
  };
  const redeploy = (dir: string, migrations: SqlMigration[]) => {
    const host = new SqliteScopeHost({ dir, checker: UNSAFE_allowAllChecker });
    host.registerModule(modWith(migrations));
    return host;
  };
  const journalOf = (file: string) => {
    const db = new Database(file, { readonly: true });
    try {
      return db.prepare('SELECT version, sql_digest FROM _substrat_migrations WHERE module_id = ? ORDER BY version').all(MODULE);
    } finally {
      db.close();
    }
  };

  it("fails closed when main's 0002 meets a scope that ran a branch's 0002, naming both digests", async () => {
    const { dir, t, s, file } = await scopeRanWith([INIT, BRANCH_A]);
    const ran = await migrationDigest(BRANCH_A.sql);
    const registered = await migrationDigest(BRANCH_B.sql);
    const main = redeploy(dir, [INIT, BRANCH_B]);
    try {
      // The wake refuses, before any operation is reached.
      await expect(main.getScope(who, t, s)).rejects.toThrow(
        `migration failed for ${MODULE}@0002-next — scope fails closed: this scope applied different SQL under this version (applied sha256 ${ran}, registered sha256 ${registered})`,
      );
      // The directory records it the way it records a migration that threw.
      const record = await main.admin.getScopeRecord(staff, t, s);
      expect(record?.migrationFailure?.version).toBe(`${MODULE}@0002-next`);
      expect(record?.migrationFailure?.error).toContain(ran);
      // Nothing ran on top: the branch's column is the only one, and main's never arrived.
      expect(journalOf(file)).toEqual([
        { version: '0001-init', sql_digest: await migrationDigest(INIT.sql) },
        { version: '0002-next', sql_digest: ran },
      ]);
    } finally {
      await main.close();
    }
  });

  it('the positive twin: the same SQL redeployed serves, and a new version lands beside it', async () => {
    const { dir, t, s, file } = await scopeRanWith([INIT, BRANCH_A]);
    const third = { version: '0003-more', sql: 'ALTER TABLE digest_notes ADD COLUMN more TEXT;' };
    const same = redeploy(dir, [INIT, BRANCH_A, third]);
    try {
      await (await same.getScope(who, t, s)).invoke('digest/add', {});
      expect(journalOf(file)).toEqual([
        { version: '0001-init', sql_digest: await migrationDigest(INIT.sql) },
        { version: '0002-next', sql_digest: await migrationDigest(BRANCH_A.sql) },
        { version: '0003-more', sql_digest: await migrationDigest(third.sql) },
      ]);
    } finally {
      await same.close();
    }
  });

  it('a scope file from before the column gains it on wake; its rows are marked legacy, not backfilled, and accepted', async () => {
    const { dir, t, s, file } = await scopeRanWith([INIT, BRANCH_A]);
    // The journal as every scope had it before #2066: no fence, no column.
    const db = new Database(file);
    db.exec('DROP TRIGGER _substrat_migrations_digest_required');
    db.exec('DROP TRIGGER _substrat_migrations_digest_kept');
    db.exec('ALTER TABLE _substrat_migrations DROP COLUMN sql_digest');
    db.close();
    // Even under SQL the legacy row cannot vouch for: the mark is accepted, never compared.
    const third = { version: '0003-more', sql: 'ALTER TABLE digest_notes ADD COLUMN more TEXT;' };
    const next = redeploy(dir, [INIT, BRANCH_B, third]);
    try {
      await (await next.getScope(who, t, s)).invoke('digest/add', {});
      expect(journalOf(file)).toEqual([
        { version: '0001-init', sql_digest: 'legacy' },
        { version: '0002-next', sql_digest: 'legacy' },
        { version: '0003-more', sql_digest: await migrationDigest(third.sql) },
      ]);
    } finally {
      await next.close();
    }
  });

  it("refuses an older writer's journal row once the column exists, and its scope recovers under the new code", async () => {
    const { dir, t, s, file } = await scopeRanWith([INIT]);
    // An instance still on the previous release, over the same file: its INSERT omits the column.
    const OLD_INSERT =
      'INSERT INTO _substrat_migrations (module_id, version, applied_at, duration_ms, rows_changed) VALUES (?, ?, ?, ?, ?)';
    const db = new Database(file);
    try {
      expect(() => db.prepare(OLD_INSERT).run(MODULE, BRANCH_A.version, 'x', 0, 0)).toThrow(
        'a migration journal row must carry its sql_digest (#2066)',
      );
      // The twin: the same row WITH its digest is what the fence lets through.
      db.prepare(`${OLD_INSERT.replace('rows_changed)', 'rows_changed, sql_digest)').replace('?)', '?, ?)')}`).run(
        MODULE, '9999-probe', 'x', 0, 0, 'f'.repeat(64),
      );
      db.prepare('DELETE FROM _substrat_migrations WHERE version = ?').run('9999-probe');
      // Nor can a row's digest be cleared afterwards.
      expect(() => db.prepare('UPDATE _substrat_migrations SET sql_digest = NULL').run()).toThrow(
        'a migration journal row must carry its sql_digest (#2066)',
      );
    } finally {
      db.close();
    }
    // The old writer's migration rolled back, so the new code applies it — with its digest.
    const next = redeploy(dir, [INIT, BRANCH_A]);
    try {
      await (await next.getScope(who, t, s)).invoke('digest/add', {});
      expect(journalOf(file)).toEqual([
        { version: '0001-init', sql_digest: await migrationDigest(INIT.sql) },
        { version: '0002-next', sql_digest: await migrationDigest(BRANCH_A.sql) },
      ]);
    } finally {
      await next.close();
    }
  });

  it('a second opener that adds a spine column first does not fail the wake (#2066 review)', async () => {
    const { dir, t, s, file } = await scopeRanWith([INIT]);
    const db = new Database(file);
    db.exec('DROP TRIGGER _substrat_migrations_digest_required');
    db.exec('DROP TRIGGER _substrat_migrations_digest_kept');
    db.exec('ALTER TABLE _substrat_migrations DROP COLUMN sql_digest');
    db.close();
    // The race, made deterministic: this opener's PRAGMA saw no column, and another opener's
    // ALTER landed before its own. The column is there when the ALTER runs.
    const host = redeploy(dir, [INIT]);
    try {
      const raced = new Database(file);
      raced.exec('ALTER TABLE _substrat_migrations ADD COLUMN sql_digest TEXT');
      const stale = new Proxy(raced, {
        get(target, key) {
          if (key === 'prepare') {
            return (q: string) => (q.startsWith('PRAGMA table_info') ? { all: () => [] } : target.prepare(q));
          }
          const v = Reflect.get(target, key) as unknown;
          return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
        },
      });
      const ensureColumn = (host as unknown as {
        ensureColumn(db: unknown, table: string, column: string, ddl: string): boolean;
      }).ensureColumn.bind(host);
      expect(ensureColumn(stale, '_substrat_migrations', 'sql_digest', 'sql_digest TEXT')).toBe(false);
      // Any other ALTER failure still throws.
      expect(() => ensureColumn(stale, '_substrat_no_such_table', 'x', 'x TEXT')).toThrow(/no such table/);
      raced.close();
      // And the wake over the raced file serves.
      await (await host.getScope(who, t, s)).invoke('digest/add', {});
    } finally {
      await host.close();
    }
  });

  for (const [what, mod, version] of [
    ['drops the digest fence', journalFenceDropMod, '@test/journal-fence-drop@0001-init'],
    ['writes the journal', journalWriteMod, '@test/journal-write@0001-init'],
    ['shadows a spine table with a TEMP one', spineShadowMod, '@test/spine-shadow@0001-init'],
    ['drops a spine table', spineDropMod, '@test/spine-drop@0001-init'],
  ] as const) {
    it(`refuses a migration that ${what}, before any of it runs`, async () => {
      const dir = mkdtempSync(join(tmpdir(), 'substrat-digest-'));
      dirs.push(dir);
      const t = tenantId.parse(ulid());
      const s = scopeId.parse(ulid());
      const host = new SqliteScopeHost({ dir, checker: UNSAFE_allowAllChecker });
      try {
        host.registerModule(mod);
        await host.admin.createTenant(staff, { id: t, slug: `j-${ulid().toLowerCase()}`, name: 'J' });
        await host.admin.grantEntitlement(staff, t, 'notes');
        await expect(host.provisionScope(staff, { tenantId: t, scopeId: s, jurisdiction: 'eu' })).rejects.toThrow(
          new RegExp(`migration failed for ${version} — scope fails closed: migration ${version} cannot (name the migration journal|write the platform spine)`),
        );
      } finally {
        await host.close();
      }
      const db = new Database(join(dir, `${t}__${s}.sqlite`), { readonly: true });
      try {
        const objects = (db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'trigger')").all() as { name: string }[]).map(
          (r) => r.name,
        );
        expect(objects).not.toContain('jt');
        expect(objects).toEqual(expect.arrayContaining(['_substrat_outbox', '_substrat_tuples']));
        expect(objects).toEqual(expect.arrayContaining(['_substrat_migrations_digest_required', '_substrat_migrations_digest_kept']));
      } finally {
        db.close();
      }
    });
  }
});
