import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ADMIN_LOG_INDEX_DDL, SETTLE_OUTCOME_SQL, auditedOperationsSql, settleOutcomeParamsOf, webCryptoSecretBox } from '@substrat-run/kernel';
import { SqliteScopeHost } from '../src/index.js';

/**
 * #1573: the two directory tables the host rebuilds in place — `_substrat_identities`
 * (K-22, rekeyed) and `_substrat_admin_log` (K-23, `tenant_id` made nullable) — are
 * create-copy-drop-rename, and the rebuild is ONE transaction.
 *
 * Why that matters is the state between DROP and RENAME. Left in autocommit, a stop there
 * leaves the copied rows in `<table>_new` and no `<table>` at all; the next open runs the
 * bootstrap first, its `CREATE TABLE IF NOT EXISTS` puts an EMPTY table of the new shape
 * back, and detection — which reads the stored DDL — concludes the migration is done.
 * The rows stay orphaned for good and nothing errors.
 *
 * The interruption here is a REAL one, not a stubbed `exec`: a stub that throws before
 * running anything leaves nothing half-done, so it would pass with the transaction
 * removed. SQLite refuses `ALTER TABLE … RENAME` while any view names a table that is no
 * longer there ("error in view …: no such table") — and a rebuild has just dropped it. So
 * a view over the table lets DROP land and makes RENAME fail, on the actual engine, at the
 * actual statement. Whether DROP's effect is still there afterwards is exactly the
 * property under test.
 */
interface Case {
  table: string;
  /** The pre-migration DDL the directory was created with. */
  legacyDdl: string;
  /** The stored-DDL fragment that says "still the old shape". */
  legacyMarker: string;
  insert: string;
  rows: unknown[][];
  /** Reads the rows back in a stable order, in columns both shapes share. */
  select: string;
  expected: Record<string, unknown>[];
}

const CASES: Case[] = [
  {
    table: '_substrat_identities',
    legacyDdl: `CREATE TABLE _substrat_identities (
      provider     TEXT NOT NULL,
      external_id  TEXT NOT NULL,
      principal_id TEXT NOT NULL,
      tenant_id    TEXT NOT NULL,
      scope_id     TEXT,
      created_at   TEXT NOT NULL,
      PRIMARY KEY (provider, external_id)
    )`,
    legacyMarker: 'PRIMARY KEY (provider, external_id)',
    insert:
      'INSERT INTO _substrat_identities (provider, external_id, principal_id, tenant_id, scope_id, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    rows: [
      ['oidc:acme', 'user-1', 'principal-1', 'tenant-a', null, '2026-09-01T00:00:00.000Z'],
      ['oidc:acme', 'user-2', 'principal-2', 'tenant-a', 'scope-1', '2026-09-02T00:00:00.000Z'],
    ],
    select: 'SELECT provider, external_id, principal_id, tenant_id, scope_id, created_at FROM _substrat_identities ORDER BY external_id',
    expected: [
      {
        provider: 'oidc:acme',
        external_id: 'user-1',
        principal_id: 'principal-1',
        tenant_id: 'tenant-a',
        scope_id: null,
        created_at: '2026-09-01T00:00:00.000Z',
      },
      {
        provider: 'oidc:acme',
        external_id: 'user-2',
        principal_id: 'principal-2',
        tenant_id: 'tenant-a',
        scope_id: 'scope-1',
        created_at: '2026-09-02T00:00:00.000Z',
      },
    ],
  },
  {
    table: '_substrat_admin_log',
    legacyDdl: `CREATE TABLE _substrat_admin_log (
      id TEXT PRIMARY KEY,
      actor TEXT NOT NULL,
      action TEXT NOT NULL,
      tenant_id TEXT NOT NULL,
      scope_id TEXT,
      vertical TEXT,
      before TEXT,
      after TEXT,
      at TEXT NOT NULL
    )`,
    legacyMarker: 'tenant_id TEXT NOT NULL',
    insert:
      'INSERT INTO _substrat_admin_log (id, actor, action, tenant_id, scope_id, vertical, before, after, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    rows: [
      ['log-1', 'staff-1', 'tenant.created', 'tenant-a', null, null, null, '{"slug":"a"}', '2026-09-01T00:00:00.000Z'],
      ['log-2', 'staff-1', 'scope.activated', 'tenant-a', 'scope-1', 'v', '{"s":"p"}', '{"s":"a"}', '2026-09-02T00:00:00.000Z'],
    ],
    select: 'SELECT id, actor, action, tenant_id, scope_id, vertical, before, after, at FROM _substrat_admin_log ORDER BY id',
    expected: [
      {
        id: 'log-1',
        actor: 'staff-1',
        action: 'tenant.created',
        tenant_id: 'tenant-a',
        scope_id: null,
        vertical: null,
        before: null,
        after: '{"slug":"a"}',
        at: '2026-09-01T00:00:00.000Z',
      },
      {
        id: 'log-2',
        actor: 'staff-1',
        action: 'scope.activated',
        tenant_id: 'tenant-a',
        scope_id: 'scope-1',
        vertical: 'v',
        before: '{"s":"p"}',
        after: '{"s":"a"}',
        at: '2026-09-02T00:00:00.000Z',
      },
    ],
  },
];

describe.each(CASES)('#1573: the $table rebuild is atomic', (c) => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'substrat-directory-rebuild-'));
    file = join(dir, '_directory.sqlite');
    // A directory in the OLD shape, with rows in it — hand-built, since only here can a
    // test reach into the store and put the old table back.
    const db = new Database(file);
    db.exec(c.legacyDdl);
    const insert = db.prepare(c.insert);
    for (const row of c.rows) insert.run(...row);
    db.close();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** Reads the directory file on its own connection, closing it before it returns. */
  const inspect = <T>(read: (db: Database.Database) => T): T => {
    const db = new Database(file, { readonly: true });
    try {
      return read(db);
    } finally {
      db.close();
    }
  };
  const storedSql = () =>
    inspect(
      (db) =>
        (
          db
            .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
            .get(c.table) as { sql: string } | undefined
        )?.sql,
    );
  const scratchTables = () =>
    inspect((db) =>
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE '%\\_new' ESCAPE '\\'").all(),
    );

  it('migrates every row, and is a no-op on the open after', async () => {
    // The positive twin. Without it a change that simply refused to rebuild would pass
    // the interruption test below by leaving the table alone.
    for (let open = 1; open <= 2; open += 1) {
      await new SqliteScopeHost({ dir }).close();
      expect(inspect((db) => db.prepare(c.select).all())).toEqual(c.expected);
      expect(storedSql()).not.toContain(c.legacyMarker);
      expect(scratchTables()).toEqual([]);
    }
  });

  it('an interruption between DROP and RENAME leaves the table and its rows exactly as they were', () => {
    // The fault: a view over the table, so RENAME dies AFTER DROP has run.
    const setup = new Database(file);
    setup.exec(`CREATE VIEW rebuild_probe AS SELECT * FROM ${c.table}`);
    setup.close();

    expect(() => new SqliteScopeHost({ dir })).toThrow(/error in view rebuild_probe/);

    // Rolled back, not merely "a table exists": the OLD shape, every row, and no scratch
    // table holding a copy. In autocommit this is the state where `${c.table}` is gone
    // and its rows sit in `${c.table}_new`.
    expect(storedSql() ?? `${c.table} is gone`).toContain(c.legacyMarker);
    expect(inspect((db) => db.prepare(c.select).all())).toEqual(c.expected);
    expect(scratchTables()).toEqual([]);
  });

  it('and the next open, once the interruption is cleared, still migrates every row', async () => {
    // What the silent failure is: not the crash, but the open AFTER it, which in
    // autocommit finds an empty new-shape table and reports the migration done.
    const setup = new Database(file);
    setup.exec(`CREATE VIEW rebuild_probe AS SELECT * FROM ${c.table}`);
    setup.close();
    expect(() => new SqliteScopeHost({ dir })).toThrow(/error in view/);

    const clear = new Database(file);
    clear.exec('DROP VIEW rebuild_probe');
    clear.close();

    await new SqliteScopeHost({ dir }).close();
    expect(inspect((db) => db.prepare(c.select).all())).toEqual(c.expected);
    expect(storedSql()).not.toContain(c.legacyMarker);
    expect(scratchTables()).toEqual([]);
  });

  it('absorbs a leftover scratch table rather than dying on it, and does not resume from it', async () => {
    // The state that can still arrive from BELOW the transaction (a torn copy of the
    // file, a backup taken mid-rebuild). Without the leading DROP the rebuild dies on
    // `table …_new already exists`, on every open, for good.
    const stale = new Database(file);
    stale.exec(`CREATE TABLE ${c.table}_new (marker TEXT)`);
    stale.exec(`INSERT INTO ${c.table}_new VALUES ('stale')`);
    stale.close();

    await new SqliteScopeHost({ dir }).close();
    expect(inspect((db) => db.prepare(c.select).all())).toEqual(c.expected);
    expect(scratchTables()).toEqual([]);
  });
});

describe('#1722 directory additions on an existing SQLite store', () => {
  // A scope row from before the additive migration holds a NULL epoch. Every compare-and-set
  // reads it as 0, in its WHERE and in its SET, or the first bind or erasure after the
  // migration is refused forever (or advances NULL + 1 = NULL and fences nothing).
  it('runs a conditional bind and an erasure finalization over a pre-migration NULL epoch', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'substrat-null-epoch-'));
    const staff = '01JZ00000000000000000000ST' as never;
    const tenant = '01JZ0000000000000000000TEN' as never;
    const scope = '01JZ0000000000000000000SCP' as never;
    const [v1, v2] = ['01JZ00000000000000000000V1', '01JZ00000000000000000000V2'];
    const secretBox = webCryptoSecretBox('k', new Uint8Array(32).fill(7));
    try {
      const seed = new SqliteScopeHost({ dir, secretBox });
      await seed.admin.createTenant(staff, { id: tenant, slug: 'null-epoch', name: 'Null epoch' });
      await seed.admin.registerVertical(staff, { slug: 'null-epoch', name: 'Null epoch', source: 'cli', ownerTenant: tenant });
      for (const [index, id] of [v1, v2].entries()) {
        await seed.admin.publishVersion(staff, { id, verticalSlug: 'null-epoch', version: `1.0.${index}`,
          manifestDigest: 'm', permissionDigest: 'p', migrationDigest: 'g', deploymentRef: null });
      }
      await seed.provisionScope(staff, { tenantId: tenant, scopeId: scope, vertical: 'null-epoch' });
      await seed.admin.activateScope(staff, tenant, scope);
      await seed.admin.bindScopeVersion(staff, tenant, scope, v1);
      const [sealed] = await seed.admin.sealSubjectPayloads(staff, tenant, scope, [{ subjectId: 'subject', plaintext: 'private' }]);
      await seed.close();
      const file = join(dir, '_directory.sqlite');
      const before = new Database(file);
      before.exec(`DROP TABLE scope_script_copies;
        ALTER TABLE scopes DROP COLUMN erasure_epoch;
        ALTER TABLE scopes DROP COLUMN reap_claimed_at;`);
      before.close();
      const epochOf = () => {
        const db = new Database(file, { readonly: true });
        try {
          return (db.prepare('SELECT erasure_epoch FROM scopes WHERE scope_id = ?').get(scope) as { erasure_epoch: number | null }).erasure_epoch;
        } finally {
          db.close();
        }
      };
      const host = new SqliteScopeHost({ dir, secretBox });
      try {
        expect(epochOf()).toBeNull();
        expect(await host.admin.scopeErasureEpoch(staff, tenant, scope)).toBe(0);
        await expect(host.admin.bindScopeVersion(staff, tenant, scope, v2, { expectedVersionId: v1, expectedErasureEpoch: 1 }))
          .rejects.toThrow(/erasure changed/);
        await host.admin.bindScopeVersion(staff, tenant, scope, v2, { expectedVersionId: v1, expectedErasureEpoch: 0 });
        await host.admin.setScopeServingRef(staff, tenant, scope, null, { expectedErasureEpoch: 0 });
        expect(epochOf()).toBeNull(); // a bind compares the epoch; only an erasure moves it
        const redacted = [{ events: 0, intents: 0, jobRuns: 0, idempotencyResults: 0, intentIds: [],
          vertical: { verticalRows: [], hookRows: [], unreachedEntities: [] } }];
        expect((await host.admin.finalizeSubjectShred(staff, tenant, scope, 'subject', redacted,
          { versionId: v2, servingRef: null, epoch: 0, copyCount: 0 })).keyDestroyed).toBe(true);
        expect(epochOf()).toBe(1);
        expect(await host.admin.openSubjectPayloads(staff, tenant, scope, [{ subjectId: 'subject', sealed: sealed! }])).toEqual([null]);
        // The carry that read epoch 0 before that erasure can no longer bind.
        await expect(host.admin.bindScopeVersion(staff, tenant, scope, v1, { expectedVersionId: v2, expectedErasureEpoch: 0 }))
          .rejects.toThrow(/erasure changed/);
        await expect(host.admin.setScopeServingRef(staff, tenant, scope, 'elsewhere', { expectedErasureEpoch: 0 }))
          .rejects.toThrow(/erasure or reap changed/);
      } finally {
        await host.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('adds an empty copy ledger and nullable zero epoch without changing scope routing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'substrat-copy-ledger-'));
    try {
      await new SqliteScopeHost({ dir }).close();
      const file = join(dir, '_directory.sqlite');
      const before = new Database(file);
      before.exec(`DROP TABLE scope_script_copies;
        ALTER TABLE scopes DROP COLUMN erasure_epoch;
        ALTER TABLE scopes DROP COLUMN reap_claimed_at;
        INSERT INTO scopes (scope_id, tenant_id, vertical, vertical_version_id, serving_ref, created_at)
        VALUES ('old-scope', 'old-tenant', 'old-vertical', 'old-version', 'old-script', '2026-01-01T00:00:00.000Z')`);
      before.close();
      await new SqliteScopeHost({ dir }).close();
      const after = new Database(file, { readonly: true });
      try {
        expect(after.prepare('SELECT vertical_version_id, serving_ref, erasure_epoch, reap_claimed_at FROM scopes WHERE scope_id = ?')
          .get('old-scope')).toEqual({ vertical_version_id: 'old-version', serving_ref: 'old-script', erasure_epoch: null, reap_claimed_at: null });
        expect(after.prepare('SELECT * FROM scope_script_copies').all()).toEqual([]);
      } finally {
        after.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('#1573: the admin log accepts a tenant-less row once rebuilt', () => {
  it('is the point of the rebuild — `tenant_id` no longer NOT NULL', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'substrat-directory-rebuild-null-'));
    try {
      const db = new Database(join(dir, '_directory.sqlite'));
      db.exec(CASES[1]!.legacyDdl);
      db.close();

      await new SqliteScopeHost({ dir }).close();

      const after = new Database(join(dir, '_directory.sqlite'));
      try {
        after
          .prepare(
            `INSERT INTO _substrat_admin_log (id, actor, action, tenant_id, at) VALUES ('platform-1', 'staff-1', 'platform.thing', NULL, '2026-09-03T00:00:00.000Z')`,
          )
          .run();
        expect(
          after.prepare("SELECT tenant_id FROM _substrat_admin_log WHERE id = 'platform-1'").get(),
        ).toEqual({ tenant_id: null });
      } finally {
        after.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('#2064: the admin-log rebuild keeps every index the kernel lists', () => {
  const names = ADMIN_LOG_INDEX_DDL.map((ddl) => /CREATE INDEX IF NOT EXISTS (\S+)/.exec(ddl)![1]!);

  it('a legacy directory comes out of the rebuild with every admin-log index, and the operation reads use theirs', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'substrat-directory-rebuild-index-'));
    try {
      const db = new Database(join(dir, '_directory.sqlite'));
      db.exec(CASES[1]!.legacyDdl);
      db.close();

      await new SqliteScopeHost({ dir }).close();

      const after = new Database(join(dir, '_directory.sqlite'), { readonly: true });
      try {
        // The rebuild ran: the stored table no longer says NOT NULL.
        expect((after.prepare("SELECT sql FROM sqlite_master WHERE name = '_substrat_admin_log'").get() as { sql: string }).sql)
          .not.toContain(CASES[1]!.legacyMarker);
        const present = (after.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = '_substrat_admin_log'").all() as { name: string }[])
          .map((r) => r.name);
        expect(present).toEqual(expect.arrayContaining(names));
        const plan = (sql: string, params: unknown[]) =>
          (after.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as { detail: string }[]).map((r) => r.detail).join(' | ');
        expect(plan(auditedOperationsSql(2), ['a', 'b'])).toMatch(/USING INDEX _substrat_admin_log_operation/);
        expect(plan(SETTLE_OUTCOME_SQL, settleOutcomeParamsOf({ action: 'transferOwner', operationId: 'a', tenantId: 't', scopeId: 's' }))).toMatch(/USING INDEX _substrat_admin_log_operation/);
      } finally {
        after.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
