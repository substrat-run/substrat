import { describe, expect, it } from 'vitest';
import type { DomainEvent } from '@substrat-run/contracts';
import type { ConnectorContext, ScopeHost } from '@substrat-run/kernel';
import {
  BOLAGSVERKET_LOOKUP_REQUESTED,
  bindBolagsverketScope,
  bolagsverketConnector,
  declareBolagsverketConnector,
  listBolagsverketBindings,
  unbindBolagsverketScope,
  type BolagsverketBinding,
} from '../src/dispatch.js';
import { ACTIVE, API_BASE, CREDENTIAL, TOKEN_URL, fakeFetch, type Reply } from './fixture.js';

const TENANT = '01J00000000000000000000000';
const SCOPE = '01J00000000000000000000001';
const CONN = 'conn-1';
const NOW = Date.UTC(2026, 10, 18, 9, 0, 0);
const SUBJECT = { entityType: 'customer', entityId: 'cust-1' };

const BINDING: BolagsverketBinding = {
  scopeId: SCOPE,
  tenantId: TENANT,
  vertical: 'todo',
  operation: 'crm/record-organisation-lookup',
  permission: 'crm:organisation-lookup:record',
  boundAt: new Date(NOW).toISOString(),
};

function world(api: Reply[], opts: { token?: Reply; binding?: BolagsverketBinding | null } = {}) {
  const fake = fakeFetch(api, opts.token);
  const landed: { connectionId: string; scopeId: string; operation: string; input: unknown }[] = [];
  const ctx = {
    tenantId: TENANT,
    scopeId: SCOPE,
    vertical: 'todo',
    admin: {
      getConnectorState: async (id: string, key: string) =>
        id === CONN && key === `bolagsverket:binding:${SCOPE}` ? (opts.binding === undefined ? BINDING : opts.binding) : undefined,
    },
    connection: async (provider: string) => {
      expect(provider).toBe('bolagsverket');
      return { id: CONN, secret: CREDENTIAL, fetch: fake.fetch };
    },
  } as unknown as ConnectorContext;
  const handler = bolagsverketConnector({
    tokenUrl: TOKEN_URL,
    apiBase: API_BASE,
    environment: 'test',
    now: () => NOW,
    scope: async (connectionId, scopeId) => ({
      invoke: async (operation, input) => {
        landed.push({ connectionId, scopeId, operation, input });
        return {};
      },
    }),
  });
  const run = (organisationNumber: string) =>
    handler(ctx, {
      id: 'evt-1',
      type: BOLAGSVERKET_LOOKUP_REQUESTED,
      tenantId: TENANT,
      scopeId: SCOPE,
      payload: { requestId: 'req-1', organisationNumber, subject: SUBJECT },
    } as unknown as DomainEvent);
  return { fake, landed, run };
}

const base = { requestId: 'req-1', subject: SUBJECT, connectionId: CONN, checkedAt: new Date(NOW).toISOString() };

describe('bolagsverketConnector', () => {
  it.each([
    ['a registered organisation as found', { status: 200, body: ACTIVE }, 'found', { exists: true, orgnr: '5560000001', name: 'Exempelbolaget Ö AB', status: 'active' }],
    ['a number the register does not know as not found', { status: 404, body: { message: 'Not found' } }, 'not_found', { exists: false, orgnr: '5560000001' }],
  ])('lands %s, through the bound operation, as the connection', async (_, reply, outcome, result) => {
    const { landed, run } = world([reply]);
    await run('556000-0001');
    expect(landed).toEqual([
      {
        connectionId: CONN,
        scopeId: SCOPE,
        operation: BINDING.operation,
        input: { ...base, outcome, reason: null, result: expect.objectContaining(result) },
      },
    ]);
  });

  it('lands a personnummer as invalid without sending anything, and does not echo it', async () => {
    const { fake, landed, run } = world([]);
    await run('811218-9876');
    expect(fake.calls).toEqual([]);
    expect(landed.map((l) => l.input)).toEqual([{ ...base, outcome: 'invalid', result: null, reason: 'personnummer' }]);
    expect(JSON.stringify(landed)).not.toContain('811218');
  });

  it('lands a refused client as refused, then fails with the provider status so the drain stops retrying', async () => {
    const { landed, run } = world([], { token: { status: 401, body: { error: 'invalid_client' } } });
    await expect(run('5560000001')).rejects.toMatchObject({ code: 'refused', status: 401 });
    expect(landed.map((l) => l.input)).toEqual([{ ...base, outcome: 'refused', result: null, reason: expect.any(String) }]);
  });

  it('lands nothing on a rate limit and throws at once, leaving the back-off to the drain', async () => {
    const { landed, run } = world([{ status: 429, body: '', headers: { 'Retry-After': '30' } }]);
    await expect(run('5560000001')).rejects.toMatchObject({ code: 'rate_limited' });
    expect(landed).toEqual([]);
  });

  it('throws before calling the provider when the scope has no landing bound', async () => {
    const { fake, landed, run } = world([], { binding: null });
    await expect(run('5560000001')).rejects.toThrow(/no Bolagsverket landing is bound/);
    expect(fake.calls).toEqual([]);
    expect(landed).toEqual([]);
  });
});

describe('bindings', () => {
  it('refuses a connection without the landing key, and binds, lists and unbinds one that holds it', async () => {
    const state = new Map<string, unknown>();
    let grants: { connectionId: string; permission: string }[] = [];
    const host = {
      connectionGrantsInScope: async () => grants,
      admin: {
        putConnectorState: async (_id: string, key: string, value: unknown) => void state.set(key, value),
        listConnectorState: async (_id: string, prefix: string) =>
          [...state].filter(([k]) => k.startsWith(prefix)).map(([key, value]) => ({ key, value })),
      },
    } as unknown as ScopeHost;
    const target = {
      connectionId: CONN as never,
      tenantId: TENANT,
      scopeId: SCOPE,
      vertical: 'todo',
      operation: BINDING.operation,
      permission: BINDING.permission,
      now: () => NOW,
    };

    await expect(bindBolagsverketScope(host, target)).rejects.toThrow(/does not hold 'crm:organisation-lookup:record'/);
    expect(state.size).toBe(0);

    grants = [{ connectionId: CONN, permission: BINDING.permission }];
    await bindBolagsverketScope(host, target);
    expect(await listBolagsverketBindings(host, CONN as never)).toEqual([BINDING]);

    await unbindBolagsverketScope(host, CONN as never, SCOPE);
    expect(await listBolagsverketBindings(host, CONN as never)).toEqual([]);
  });
});

describe('declareBolagsverketConnector', () => {
  it('routes the request event to the bolagsverket provider, and refuses to run it locally', async () => {
    const registered: { id: string; eventType: string; handler: () => Promise<void>; provider?: string }[] = [];
    declareBolagsverketConnector({
      registerConnector: (id, eventType, handler, options) =>
        void registered.push({ id, eventType, handler: handler as () => Promise<void>, provider: options?.provider }),
    });
    expect(registered).toMatchObject([{ eventType: BOLAGSVERKET_LOOKUP_REQUESTED, provider: 'bolagsverket' }]);
    await expect(registered[0]!.handler()).rejects.toThrow(/routing only/);
  });
});
