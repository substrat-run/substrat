import { describe, expect, it } from 'vitest';
import { createCfDoNamespaceReader, namespacesForScript, type DoNamespaceRecord } from '../src/do-namespaces.js';

/**
 * Resolving a script's Durable Object namespaces to the ids the dashboard addresses. Two
 * properties matter: the walk is bounded and cached (this runs on every scope-detail open,
 * against an account-wide listing), and the ORDER puts the scope class first, because the
 * console links the head of the list and a scope's data is in exactly one of them.
 */

const page = (rows: Partial<DoNamespaceRecord & { class: string; use_sqlite: boolean }>[]) =>
  new Response(JSON.stringify({ success: true, result: rows }), { status: 200 });

describe('createCfDoNamespaceReader', () => {
  it('walks pages until a short one, and maps Cloudflare’s shape', async () => {
    const seen: string[] = [];
    const full = Array.from({ length: 100 }, (_, i) => ({
      id: `id-${i}`,
      class: 'Filler',
      script: 'other',
    }));
    const reader = createCfDoNamespaceReader({
      accountId: 'acct',
      apiToken: 'token',
      fetchImpl: (async (url: string, init?: RequestInit) => {
        seen.push(String(url));
        expect((init?.headers as Record<string, string>).authorization).toBe('Bearer token');
        // `page=1&`, not `page=1` — `per_page=100` contains the latter.
        return String(url).includes('page=1&')
          ? page(full)
          : page([{ id: 'ns-1', class: 'ScopeDO', script: 'crm-serving', name: 'crm SCOPE', use_sqlite: true }]);
      }) as unknown as typeof fetch,
    });

    const rows = await reader.list();
    expect(seen).toHaveLength(2); // the second page was short — stop, don't probe a third
    expect(rows).toHaveLength(101);
    expect(rows.at(-1)).toEqual({
      id: 'ns-1',
      className: 'ScopeDO',
      script: 'crm-serving',
      name: 'crm SCOPE',
      useSqlite: true,
    });
  });

  it('caches within the TTL and shares one in-flight walk', async () => {
    let calls = 0;
    const reader = createCfDoNamespaceReader({
      accountId: 'acct',
      apiToken: 'token',
      fetchImpl: (async () => {
        calls++;
        return page([{ id: 'ns-1', class: 'ScopeDO', script: 'crm-serving' }]);
      }) as unknown as typeof fetch,
    });

    // Concurrent opens must not each start a walk.
    await Promise.all([reader.list(), reader.list(), reader.list()]);
    expect(calls).toBe(1);
    await reader.list();
    expect(calls).toBe(1);
  });

  it('stops at the page cap rather than walking an account unboundedly', async () => {
    let calls = 0;
    const reader = createCfDoNamespaceReader({
      accountId: 'acct',
      apiToken: 'token',
      maxPages: 3,
      fetchImpl: (async () => {
        calls++;
        // Always a FULL page: without the cap this would never terminate.
        return page(Array.from({ length: 100 }, (_, i) => ({ id: `id-${calls}-${i}`, class: 'X' })));
      }) as unknown as typeof fetch,
    });
    expect(await reader.list()).toHaveLength(300);
    expect(calls).toBe(3);
  });

  it('throws on a refused read instead of reporting an empty account', async () => {
    // An expired or under-scoped token must not read as "this script defines no
    // namespaces" — the console shows the fallback link on a failure, not a wrong answer.
    const reader = createCfDoNamespaceReader({
      accountId: 'acct',
      apiToken: 'token',
      fetchImpl: (async () => new Response('nope', { status: 403 })) as unknown as typeof fetch,
    });
    await expect(reader.list()).rejects.toThrow(/403/);

    const refused = createCfDoNamespaceReader({
      accountId: 'acct',
      apiToken: 'token',
      fetchImpl: (async () =>
        new Response(JSON.stringify({ success: false, errors: [{ message: 'bad token' }] }), {
          status: 200,
        })) as unknown as typeof fetch,
    });
    await expect(refused.list()).rejects.toThrow(/bad token/);
  });
});

describe('namespacesForScript', () => {
  const rows: DoNamespaceRecord[] = [
    { id: 'a', className: 'IdentityDO', script: 'crm-serving', name: null, useSqlite: true },
    { id: 'b', className: 'ScopeDO', script: 'crm-serving', name: null, useSqlite: true },
    { id: 'c', className: 'SweeperDO', script: 'crm-serving', name: null, useSqlite: false },
    { id: 'd', className: 'ScopeDO', script: 'other-script', name: null, useSqlite: true },
  ];

  it('narrows to the script and puts the scope class first', () => {
    // The console links the head: a scope's rows are in the scope class, never in the
    // identity or sweeper namespace that happens to share the script.
    expect(namespacesForScript(rows, 'crm-serving').map((r) => r.id)).toEqual(['b', 'a', 'c']);
  });

  it('still returns the other classes — a vertical that named its class differently is one click away', () => {
    const odd: DoNamespaceRecord[] = [
      { id: 'x', className: 'Workspace', script: 's', name: null, useSqlite: true },
      { id: 'y', className: 'TenantScopeStore', script: 's', name: null, useSqlite: true },
    ];
    // 'TenantScopeStore' merely CONTAINS scope, so it ranks above an unrelated class but
    // below an exact `ScopeDO` — and nothing is dropped.
    expect(namespacesForScript(odd, 's').map((r) => r.id)).toEqual(['y', 'x']);
  });

  it('answers empty for a script that defines none', () => {
    expect(namespacesForScript(rows, 'no-such-script')).toEqual([]);
  });
});
