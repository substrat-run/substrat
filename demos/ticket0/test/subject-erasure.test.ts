import { afterAll, describe, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { ticket0Manifest } from '../src/manifest.js';
import { buildHost, MODULES } from '../src/seed.js';
import { checkTicket0SubjectErasure, type ErasureSql } from './subject-erasure-case.js';

describe('ticket0 subject erasure on SQLite', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ticket0-erasure-'));
  const host = buildHost(dir);
  let previous: SqliteScopeHost | undefined;
  const raw: ErasureSql = async (tenant, scope, sql, params = []) => {
    const db = new Database(join(dir, `${tenant}__${scope}.sqlite`));
    try {
      const statement = db.prepare(sql);
      if (statement.reader) return statement.all(...params) as Record<string, unknown>[];
      statement.run(...params);
      return [];
    } finally {
      db.close();
    }
  };

  afterAll(async () => {
    await previous?.close();
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('erases only the customer and staff rows that belong to each subject', async () => {
    await checkTicket0SubjectErasure({
      sql: raw,
      prepare: async (tenant, scope, actor) => {
        // The stored rows predate erasure adoption, though the schema is unchanged.
        previous = new SqliteScopeHost({ dir });
        for (const module of MODULES) previous.registerModule(module.manifest.id === ticket0Manifest.id
          ? { ...module, manifest: { ...module.manifest, erasure: undefined }, onSubjectErased: undefined }
          : module);
        await previous.admin.createTenant(actor, { id: tenant, slug: `erasure-${tenant.toLowerCase()}`, name: 'Erasure' });
        await previous.admin.grantEntitlement(actor, tenant, 'ticket0');
        await previous.provisionScope(actor, { tenantId: tenant, scopeId: scope, vertical: 'ticket0' });
      },
      upgrade: async (tenant, scope, actor) => {
        await previous?.close();
        previous = undefined;
        await host.provisionScope(actor, { tenantId: tenant, scopeId: scope, vertical: 'ticket0' });
        await host.admin.activateScope(actor, tenant, scope);
      },
      erase: async (tenant, scope, actor, subject) => host.admin.shredSubject(actor, tenant, scope, subject),
    });
  }, 60_000);
});
