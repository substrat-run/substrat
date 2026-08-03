import { describe, expect, it } from 'vitest';
import type { ConnectorResponse, FetchLike } from '@substrat-run/kernel';
import { createD1TenantStores, tenantStoreDatabaseName } from '../src/d1.js';

/**
 * The D1 REST client behind live per-tenant stores (#301 PR-2), driven against a scripted
 * fetch — the same injectable-fetch testing seam the custom-hostname provisioner uses.
 * What matters here is the CONVERGENCE behavior (a name collision resolves to the existing
 * database, exactly, not by substring) and the honest error edges; the ledger/idempotency
 * logic above it lives in tenant-store.test.ts against the real ControlPlaneDO.
 */
describe('createD1TenantStores', () => {
  const reply = (status: number, body: unknown): ConnectorResponse => ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
    json: async () => body,
    arrayBuffer: async () => new ArrayBuffer(0),
  });

  const scripted = (handlers: ((url: string, init?: { method?: string; body?: string | Uint8Array }) => ConnectorResponse | undefined)[]) => {
    const calls: { url: string; method: string; body?: string }[] = [];
    const fetchImpl: FetchLike = async (url, init) => {
      calls.push({ url, method: init?.method ?? 'GET', body: typeof init?.body === 'string' ? init.body : undefined });
      for (const h of handlers) {
        const res = h(url, init);
        if (res) return res;
      }
      throw new Error(`unscripted fetch: ${init?.method ?? 'GET'} ${url}`);
    };
    return { fetchImpl, calls };
  };

  const opts = { accountId: 'acct-1', apiToken: 'tok' };

  it('creates a database and returns the platform-minted id', async () => {
    const { fetchImpl, calls } = scripted([
      (url, init) =>
        init?.method === 'POST' && url.endsWith('/d1/database')
          ? reply(200, { success: true, result: { uuid: 'db-uuid-1', name: 'tstore-x' } })
          : undefined,
    ]);
    const d1 = createD1TenantStores({ ...opts, fetch: fetchImpl });
    await expect(d1.create('tstore-x')).resolves.toBe('db-uuid-1');
    expect(calls[0]?.url).toBe('https://api.cloudflare.com/client/v4/accounts/acct-1/d1/database');
    expect(JSON.parse(calls[0]!.body!)).toEqual({ name: 'tstore-x' });
  });

  it('resolves a name collision to the EXISTING database — the crashed-retry path converges', async () => {
    const { fetchImpl } = scripted([
      (url, init) =>
        init?.method === 'POST' && url.endsWith('/d1/database')
          ? reply(400, { success: false, errors: [{ message: 'a database with that name already exists' }] })
          : undefined,
      (url, init) =>
        (init?.method ?? 'GET') === 'GET' && url.includes('?name=')
          ? reply(200, {
              success: true,
              // The upstream name filter matches substrings — the exact-match guard must
              // skip the near-miss and pick the true one.
              result: [
                { uuid: 'db-near-miss', name: 'tstore-x-audit' },
                { uuid: 'db-exact', name: 'tstore-x' },
              ],
            })
          : undefined,
    ]);
    const d1 = createD1TenantStores({ ...opts, fetch: fetchImpl });
    await expect(d1.create('tstore-x')).resolves.toBe('db-exact');
  });

  it('fails a create honestly when the collision cannot be resolved to an existing database', async () => {
    const { fetchImpl } = scripted([
      (url, init) =>
        init?.method === 'POST' && url.endsWith('/d1/database')
          ? reply(500, { success: false, errors: [{ message: 'internal error' }] })
          : undefined,
      (url) => (url.includes('?name=') ? reply(200, { success: true, result: [] }) : undefined),
    ]);
    const d1 = createD1TenantStores({ ...opts, fetch: fetchImpl });
    await expect(d1.create('tstore-x')).rejects.toThrow(/D1 create failed \(500\)/);
  });

  it('runs a statement over the HTTP query path, mapping results and changes', async () => {
    const { fetchImpl, calls } = scripted([
      (url, init) =>
        init?.method === 'POST' && url.endsWith('/db-uuid-1/query')
          ? reply(200, {
              success: true,
              result: [{ success: true, results: [{ email: 'a@x.se' }], meta: { changes: 1 } }],
            })
          : undefined,
    ]);
    const d1 = createD1TenantStores({ ...opts, fetch: fetchImpl });
    const out = await d1.query('db-uuid-1', 'SELECT email FROM users WHERE id = ?', ['u1']);
    expect(out).toEqual({ results: [{ email: 'a@x.se' }], changes: 1 });
    expect(JSON.parse(calls[0]!.body!)).toEqual({ sql: 'SELECT email FROM users WHERE id = ?', params: ['u1'] });
  });

  it('refuses blob/bigint params on the HTTP path rather than corrupting them in JSON', async () => {
    const d1 = createD1TenantStores({ ...opts, fetch: scripted([]).fetchImpl });
    await expect(d1.query('db', 'INSERT INTO t VALUES (?)', [new Uint8Array([1])])).rejects.toThrow(
      /unsupported parameter type/,
    );
    await expect(d1.query('db', 'INSERT INTO t VALUES (?)', [1n])).rejects.toThrow(/unsupported parameter type/);
  });

  it('treats deleting an already-gone database as done (idempotent remove)', async () => {
    const { fetchImpl } = scripted([
      (_url, init) => (init?.method === 'DELETE' ? reply(404, { success: false, errors: [] }) : undefined),
    ]);
    const d1 = createD1TenantStores({ ...opts, fetch: fetchImpl });
    await expect(d1.remove('db-gone')).resolves.toBeUndefined();
  });
});

describe('tenantStoreDatabaseName', () => {
  it('is deterministic and D1-name-safe (lowercase, sanitized)', async () => {
    const a = await tenantStoreDatabaseName('01J8XKA0000000000000000000', 'acme/authhero', 'AUTH_DB');
    const b = await tenantStoreDatabaseName('01J8XKA0000000000000000000', 'acme/authhero', 'AUTH_DB');
    expect(a).toBe(b);
    expect(a).toMatch(/^[a-z0-9-]+$/);
    expect(a).toContain('tstore-');
  });

  it('caps an over-long name with a stable hash tail, staying deterministic and distinct', async () => {
    const vertical = 'some-tenant-with-a-very-long-slug/an-equally-long-vertical-name';
    const a = await tenantStoreDatabaseName('01J8XKA0000000000000000000', vertical, 'AUTH_DB');
    const b = await tenantStoreDatabaseName('01J8XKA0000000000000000000', vertical, 'AUTH_DB');
    const other = await tenantStoreDatabaseName('01J8XKA0000000000000000000', vertical, 'AUDIT_DB');
    expect(a).toBe(b);
    expect(a.length).toBeLessThanOrEqual(63);
    expect(a).not.toBe(other);
  });
});
