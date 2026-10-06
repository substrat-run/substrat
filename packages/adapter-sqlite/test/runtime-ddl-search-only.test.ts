/**
 * Runtime DDL on a scope that derives a search index and NOTHING with archive/trash state
 * (#2090, Codex r2 on #2091). The after-DDL repair used to be installed only when some entity
 * declared a state, so on such a scope a module could rebuild its searchable table through
 * `ctx.sql` and strip the triggers that keep the index in step — leaving rewritten or erased text
 * searchable. The contract suite cannot reach this: every scope there carries the kit's stateful
 * modules too, so its hook is always installed.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { moduleManifest, platformActorId, principalId, scopeId, tenantId } from '@substrat-run/contracts';
import { ulid, UNSAFE_allowAllChecker, type ModuleRegistration, type OperationHandler } from '@substrat-run/kernel';
import { SqliteScopeHost } from '../src/index.js';

type Handler = OperationHandler<never, unknown>;

const searchOnly: ModuleRegistration = {
  manifest: moduleManifest.parse({
    id: '@test/search-only',
    version: '1.0.0',
    kernelContract: '^0.0.1',
    permissions: [{ key: 'so:use', description: 'use it' }],
    events: { emits: [], consumes: [] },
    migrations: { journalDir: './migrations', compatibleFrom: '1.0.0' },
    attachmentTargets: [],
    entitlementKey: 'search-only',
    searchables: [{ entityType: 'sodoc', fields: ['title'], table: 'so_docs', idColumn: 'id' }],
  }),
  migrations: [{ version: '0001-init', sql: 'CREATE TABLE so_docs (id TEXT PRIMARY KEY, title TEXT NOT NULL);' }],
  operations: {
    'so/add': (async (ctx, input) => {
      const i = input as { id: string; title: string };
      ctx.sql.exec('INSERT INTO so_docs (id, title) VALUES (?, ?)', [i.id, i.title]);
      return null;
    }) as Handler,
    'so/retitle': (async (ctx, input) => {
      const i = input as { id: string; title: string };
      ctx.sql.exec('UPDATE so_docs SET title = ? WHERE id = ?', [i.title, i.id]);
      return null;
    }) as Handler,
    'so/search': (async (ctx, input) => ctx.search('sodoc', (input as { term: string }).term).map((h) => h.id)) as Handler,
    'so/ddl': (async (ctx, input) => {
      for (const statement of (input as { statements: string[] }).statements) ctx.sql.exec(statement);
      return null;
    }) as Handler,
  },
};

describe('runtime DDL on a scope with a search index and no archive/trash state (#2090)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'substrat-search-only-'));
  const host = new SqliteScopeHost({ dir, checker: UNSAFE_allowAllChecker });
  afterAll(async () => {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('puts the search triggers back before the operation commits, so rewritten text leaves search', async () => {
    host.registerModule(searchOnly);
    const staff = platformActorId.parse(ulid());
    const t = tenantId.parse(ulid());
    const s = scopeId.parse(ulid());
    await host.admin.createTenant(staff, { id: t, slug: `so-${ulid().toLowerCase()}`, name: 'Search only' });
    await host.admin.grantEntitlement(staff, t, 'search-only');
    await host.provisionScope(staff, { tenantId: t, scopeId: s, vertical: 'search-only' });
    await host.admin.activateScope(staff, t, s);
    const stub = await host.getScope(principalId.parse(ulid()), t, s);
    const said = ulid();
    await stub.invoke('so/add', { id: said, title: 'alpha secret' });

    await stub.invoke('so/ddl', {
      statements: [
        'CREATE TABLE so_docs_new AS SELECT * FROM so_docs ORDER BY id DESC',
        'DROP TABLE so_docs',
        'ALTER TABLE so_docs_new RENAME TO so_docs',
      ],
    });
    await stub.invoke('so/retitle', { id: said, title: 'gamma redacted' });
    expect(await stub.invoke('so/search', { term: 'secret' })).toEqual([]);
    expect(await stub.invoke('so/search', { term: 'gamma' })).toEqual([said]);
  });
});
