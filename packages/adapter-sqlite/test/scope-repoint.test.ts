import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { platformActorId, scopeId, tenantId } from '@substrat-run/contracts';
import { ulid, webCryptoSecretBox } from '@substrat-run/kernel';
import { scopeRepointContractSuite } from '@substrat-run/contract-tests';
import { SqliteScopeHost } from '../src/index.js';

// #1869, on the DEFAULT checker so the suite can assert decisions as well as rows.
scopeRepointContractSuite('adapter-sqlite', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'substrat-repoint-'));
  const host = new SqliteScopeHost({ dir, secretBox: webCryptoSecretBox('test-key', new Uint8Array(32).fill(7)) });
  return {
    host,
    cleanup: async () => {
      await host.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
});

/**
 * #1883: a dump a Durable Object exported, loaded into a node scope. The DO builds spine tables
 * (`_substrat_roles`, `_substrat_tenant_tuples`, …) that a node scope keeps in its directory,
 * so this kernel builds no such table in the scope and the rows would have nowhere to go. The
 * restore refuses, naming the table, rather than drop them. The DO's twin, which accepts the
 * same table, is in `adapter-cloudflare/test/scope-repoint.test.ts`.
 */
describe('a DO-shaped dump restored into a node scope (#1883)', () => {
  it('is refused, naming the spine table this host keeps elsewhere, and the scope keeps what it held', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'substrat-do-dump-'));
    const host = new SqliteScopeHost({ dir, secretBox: webCryptoSecretBox('test-key', new Uint8Array(32).fill(7)) });
    try {
      const staff = platformActorId.parse(ulid());
      const t = tenantId.parse(ulid());
      const s = scopeId.parse(ulid());
      await host.admin.createTenant(staff, { id: t, slug: `do-dump-${t.slice(-10).toLowerCase()}`, name: 'DO dump' });
      await host.provisionScope(staff, { tenantId: t, scopeId: s });
      const before = await host.admin.exportScope(staff, t, s);
      expect(before.tables.map((tb) => tb.name)).not.toContain('_substrat_roles');
      const roles = {
        name: '_substrat_roles',
        ddl:
          'CREATE TABLE _substrat_roles (tenant_id TEXT NOT NULL, role_key TEXT NOT NULL, permissions TEXT NOT NULL, ' +
          'source TEXT NOT NULL, revoked_at TEXT, PRIMARY KEY (tenant_id, role_key))',
        columns: ['tenant_id', 'role_key', 'permissions', 'source', 'revoked_at'],
        rows: [[t, 'reader', '["perm:read"]', 'vertical', null]],
      };
      await expect(host.restoreScope(staff, t, s, { ...before, tables: [...before.tables, roles] })).rejects.toThrow(
        /spine table\(s\) this host's kernel does not build: _substrat_roles\. It was exported by a different kind of host/,
      );
      expect((await host.admin.exportScope(staff, t, s)).tables).toEqual(before.tables);
      // Twin: the same dump without the DO's table restores.
      await expect(host.restoreScope(staff, t, s, before)).resolves.toBeUndefined();
    } finally {
      await host.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
