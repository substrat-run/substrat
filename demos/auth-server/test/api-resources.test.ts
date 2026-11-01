import { describe, it, expect, beforeAll } from 'vitest';
import Database from 'better-sqlite3';
import { scopeId } from '@substrat-run/contracts';
import { ulid } from '@substrat-run/kernel';
import { SCHEMA_STATEMENTS } from '../db/ddl.generated.js';
import { createAdminApi } from '../src/admin-api.js';
import type { SessionSubject } from '../src/do-contract.js';
import type { SqlExec } from '../src/introspect.js';
import { syncPlatformResources } from '../src/resources.js';

/**
 * The console's APIs screen reads `GET /resources`: every `oauth_resource` row, with the
 * platform's rows (the marker `resources.ts` writes) told apart from an operator's.
 */

const APP = scopeId.parse(ulid());
const PLATFORM_ID = 'https://desk.example/api/mcp';
const OPERATOR_ID = 'https://billing.example/api';

let sql: SqlExec;

function sqlExecOf(database: Database.Database): SqlExec {
  return {
    exec(query: string, ...bindings: unknown[]) {
      const stmt = database.prepare(query);
      if (!stmt.reader) {
        stmt.run(...(bindings as []));
        return { columnNames: [], toArray: () => [], raw: () => [][Symbol.iterator]() };
      }
      const objects = stmt.all(...(bindings as [])) as Record<string, unknown>[];
      return {
        columnNames: stmt.columns().map((c) => c.name),
        toArray: () => objects,
        raw: () => (stmt.raw(true).all(...(bindings as [])) as unknown[][]).values(),
      };
    },
  };
}

function get(role: string): Promise<Response> {
  const session = async (): Promise<SessionSubject> => ({ sub: 'u', email: 'u@acme.example', name: 'U', role });
  const api = createAdminApi({
    sql,
    session,
    effectiveCfg: () => ({}),
    auth: () => ({}) as never,
    offeredProviders: () => [],
    transaction: (fn) => fn(),
  });
  return Promise.resolve(api.request('/resources'));
}

beforeAll(() => {
  const db = new Database(':memory:');
  for (const stmt of SCHEMA_STATEMENTS) db.exec(stmt);
  sql = sqlExecOf(db);
  syncPlatformResources(sql, { appScopeId: APP, identifiers: [PLATFORM_ID] }, 1);
  db.prepare(
    `INSERT INTO oauth_resource (id, identifier, name, allowed_scopes, created_at, updated_at)
     VALUES ('r1', ?, 'Billing API', '["read:invoices","write:invoices"]', 1, 1)`,
  ).run(OPERATOR_ID);
});

describe('GET /resources', () => {
  it('lists every row, platform rows marked with the vertical they were registered for', async () => {
    const res = await get('admin');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      resources: [
        { identifier: OPERATOR_ID, name: 'Billing API', source: 'issuer', scopeId: null, scopes: ['read:invoices', 'write:invoices'] },
        // The sync stores the identifier as the NOT NULL name; that placeholder is not a name.
        { identifier: PLATFORM_ID, name: null, source: 'platform', scopeId: APP, scopes: [] },
      ],
    });
  });

  it('is refused to a signed-in non-administrator', async () => {
    expect((await get('user')).status).toBe(403);
  });
});
