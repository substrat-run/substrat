import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { connectionId, platformActorId, scopeId, tenantId } from '@substrat-run/contracts';
import { ulid, webCryptoSecretBox } from '@substrat-run/kernel';
import { SqliteScopeHost } from '../src/index.js';

/**
 * #2732: the live-connection key gains the owner on a directory that ALREADY HAS the account-only
 * index and no `owner_scope_id` column, which is every directory in use. Staged by building one with
 * this code and putting the previous release's shape back: the column dropped, the index verbatim.
 */
const LEGACY_INDEX =
  "CREATE UNIQUE INDEX IF NOT EXISTS _substrat_connections_live_account ON _substrat_connections (tenant_id, vertical, provider, COALESCE(external_account_ref, '')) WHERE revoked_at IS NULL";

const staff = platformActorId.parse(ulid());
const t = tenantId.parse(ulid());
const secretBox = () => webCryptoSecretBox('k', new Uint8Array(32).fill(7));

describe('#2732: a directory carrying the account-only live-connection index', () => {
  let dir: string;
  let file: string;
  const legacy = connectionId.parse(ulid());

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'substrat-connections-live-owner-'));
    file = join(dir, '_directory.sqlite');
    await new SqliteScopeHost({ dir }).close();
    const db = new Database(file);
    db.exec('DROP INDEX _substrat_connections_live_account');
    db.exec('ALTER TABLE _substrat_connections DROP COLUMN owner_scope_id');
    db.exec(LEGACY_INDEX);
    db.prepare(
      `INSERT INTO _substrat_connections (id, tenant_id, vertical, provider, label, status, scopes, created_by, created_at)
       VALUES (?, ?, 'acme-crm', 'planima', 'planima', 'active', '[]', ?, '2026-01-01T00:00:00.000Z')`,
    ).run(legacy, t, staff);
    db.close();
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('re-keys the index on the owner, keeps the row tenant-owned and still a singleton, and admits a scope its own', async () => {
    const host = new SqliteScopeHost({ dir, secretBox: secretBox() });
    try {
      const index = new Database(file, { readonly: true });
      const sql = (index.prepare("SELECT sql FROM sqlite_master WHERE name = '_substrat_connections_live_account'").get() as { sql: string }).sql;
      index.close();
      expect(sql).toContain("COALESCE(owner_scope_id, '')");

      expect((await host.admin.listConnections(staff, { tenantId: t })).map((c) => [c.id, c.ownerScopeId])).toEqual([[legacy, null]]);
      const connect = (ownerScopeId?: string) =>
        host.admin.createConnection(staff, {
          id: connectionId.parse(ulid()), tenantId: t, vertical: 'acme-crm', provider: 'planima', label: 'planima',
          secret: { token: 'x' }, ...(ownerScopeId ? { ownerScopeId: scopeId.parse(ownerScopeId) } : {}),
        });
      await expect(connect()).rejects.toThrow(/already has a live 'planima' connection/);
      await connect(ulid());
      expect(await host.admin.listConnections(staff, { tenantId: t, ownerScopeId: null })).toHaveLength(1);
    } finally {
      await host.close();
    }
  });
});
