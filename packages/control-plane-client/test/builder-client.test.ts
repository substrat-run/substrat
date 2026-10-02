import { describe, expect, it } from 'vitest';
import { ControlPlaneBuilderClient, ControlPlaneError, walkPages } from '../src/index.js';

const BASE = 'https://cp.example/api';
const AUTH = { authorization: 'Bearer t', 'x-substrat-tenant': 'acme' };
const JSON_TYPE = { 'content-type': 'application/json' };

interface Seen {
  url: string;
  method: string | undefined;
  headers: Record<string, string>;
  body: unknown;
}

function spy(answer: () => Response = () => Response.json({})) {
  const seen: Seen[] = [];
  const fetch = (async (url: string, init: RequestInit = {}) => {
    seen.push({
      url,
      method: init.method,
      headers: init.headers as Record<string, string>,
      body: typeof init.body === 'string' ? init.body : init.body,
    });
    return answer();
  }) as unknown as typeof globalThis.fetch;
  return { seen, fetch };
}

const make = (fetch: typeof globalThis.fetch, contentType: string | null = null) =>
  new ControlPlaneBuilderClient({ baseUrl: BASE, actor: null, headers: AUTH, contentType, fetch });

const T = '01HZZZZZZZZZZZZZZZZZZZZZZT';
const S = '01HZZZZZZZZZZZZZZZZZZZZZZS';

/** Every method, the wire it must put out: [call, method, path, body | undefined]. */
const WIRE: Record<string, [(c: ControlPlaneBuilderClient) => Promise<unknown>, string | undefined, string, string | undefined]> = {
  whoami: [(c) => c.whoami(), undefined, '/auth/whoami', undefined],
  exchangeLoginCode: [(c) => c.exchangeLoginCode('c', 'v'), 'POST', '/auth/cli/token', '{"code":"c","verifier":"v"}'],
  listVerticals: [(c) => c.listVerticals({ limit: 200 }), undefined, '/verticals?limit=200', undefined],
  listVersions: [
    (c) => c.listVersions('acme/my app', { limit: 200, cursor: 'a b' }),
    undefined,
    '/verticals/acme%2Fmy%20app/versions?limit=200&cursor=a%20b',
    undefined,
  ],
  listChannels: [(c) => c.listChannels('v'), undefined, '/verticals/v/channels', undefined],
  getVersionRegistry: [(c) => c.getVersionRegistry('v', 'id/1'), undefined, '/verticals/v/versions/id%2F1/registry', undefined],
  getVersionMigrations: [
    (c) => c.getVersionMigrations('v', 'new', 'old base'),
    undefined,
    '/verticals/v/versions/new/migrations?base=old%20base',
    undefined,
  ],
  promoteChannel: [
    (c) => c.promoteChannel('v', 'prod', 'ver', { exportBreak: true }),
    'POST',
    '/verticals/v/channels/prod/promote',
    '{"versionId":"ver","acknowledge":{"exportBreak":true}}',
  ],
  setListing: [(c) => c.setListing('v', false), 'POST', '/verticals/v/listing', '{"listed":false}'],
  requestPublish: [(c) => c.requestPublish('v'), 'POST', '/verticals/v/publish-request', '{}'],
  adoptVerticalServing: [
    (c) => c.adoptVerticalServing('v', { acknowledge: { exportBreak: true } }),
    'POST',
    '/verticals/v/adopt-serving',
    '{"acknowledge":{"exportBreak":true}}',
  ],
  listScopes: [(c) => c.listScopes(T, { limit: 200 }), undefined, `/scopes?tenantId=${T}&limit=200`, undefined],
  listHostnames: [(c) => c.listHostnames(T, { limit: 200, cursor: 'x' }), undefined, `/hostnames?tenantId=${T}&limit=200&cursor=x`, undefined],
  bindHostname: [
    (c) => c.bindHostname({ hostname: 'a.example', tenantId: T, scopeId: S, surface: 'app', canonical: true }),
    'POST',
    '/hostnames',
    `{"hostname":"a.example","tenantId":"${T}","scopeId":"${S}","surface":"app","canonical":true}`,
  ],
  verifyHostname: [(c) => c.verifyHostname('a.example'), 'POST', '/hostnames/a.example/verify', undefined],
  unbindHostname: [(c) => c.unbindHostname('a.example'), 'DELETE', '/hostnames/a.example', undefined],
  getScope: [(c) => c.getScope(T, S), undefined, `/tenants/${T}/scopes/${S}`, undefined],
  getScopeHealth: [(c) => c.getScopeHealth(T, S), undefined, `/tenants/${T}/scopes/${S}/health`, undefined],
  exportScope: [(c) => c.exportScope(T, S, true), undefined, `/tenants/${T}/scopes/${S}/export?full=true`, undefined],
  restoreScope: [
    (c) => c.restoreScope(T, S, { tenantId: T, scopeId: S, capturedAt: 'now', tables: [] }),
    'POST',
    `/tenants/${T}/scopes/${S}/restore`,
    `{"tenantId":"${T}","scopeId":"${S}","capturedAt":"now","tables":[]}`,
  ],
  adoptServing: [(c) => c.adoptServing(T, S, {}), 'POST', `/tenants/${T}/scopes/${S}/adopt-serving`, '{}'],
  provisionScope: [(c) => c.provisionScope(T, S), 'POST', `/tenants/${T}/scopes/${S}/provision`, undefined],
  bindScopeVersion: [
    (c) => c.bindScopeVersion(T, S, { versionId: 'v', snapshot: true }),
    'POST',
    `/tenants/${T}/scopes/${S}/version`,
    '{"versionId":"v","snapshot":true}',
  ],
  rebindScopeVertical: [
    (c) => c.rebindScopeVertical(T, S, { vertical: 'x', ackMigrations: true }),
    'POST',
    `/tenants/${T}/scopes/${S}/rebind-vertical`,
    '{"vertical":"x","ackMigrations":true}',
  ],
};

describe('ControlPlaneBuilderClient — the wire', () => {
  it('the table covers every method on the class (a new route cannot slip in unpinned)', () => {
    const methods = Object.getOwnPropertyNames(ControlPlaneBuilderClient.prototype).filter(
      (n) => n !== 'constructor' && !['write', 'scopePath'].includes(n),
    );
    expect(Object.keys(WIRE).sort()).toEqual(methods.sort());
  });

  it.each(Object.entries(WIRE))('%s: verb, path, body, and the headers a bare client sends', async (_name, [call, method, path, body]) => {
    const { seen, fetch } = spy();
    await call(make(fetch)).catch(() => undefined);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe(`${BASE}${path}`);
    expect(seen[0]!.method).toBe(method);
    expect(seen[0]!.body).toBe(body);
    // A read sends the credential map and nothing else; a write adds the JSON content type.
    expect(seen[0]!.headers).toEqual(method === undefined ? AUTH : { ...AUTH, ...JSON_TYPE });
  });

  it('a client built to send the JSON type on everything sends the same writes, and types its reads', async () => {
    const reads = spy();
    await make(reads.fetch, 'application/json').listHostnames(T);
    expect(reads.seen[0]!.headers).toEqual({ ...AUTH, ...JSON_TYPE });
    const writes = spy();
    await make(writes.fetch, 'application/json').verifyHostname('a.example');
    expect(writes.seen[0]!.headers).toEqual({ ...AUTH, ...JSON_TYPE });
  });
});

describe('ControlPlaneBuilderClient — answers and refusals', () => {
  it('hands the parsed JSON back, typed', async () => {
    const { fetch } = spy(() => Response.json({ user: null, tenants: [] }));
    await expect(make(fetch).whoami()).resolves.toEqual({ user: null, tenants: [] });
  });

  it('a refusal is a ControlPlaneError carrying status and the raw body', async () => {
    const { fetch } = spy(() => new Response('{"error":"nope"}', { status: 403, statusText: 'Forbidden' }));
    const err = await make(fetch).listChannels('v').catch((e) => e);
    expect(err).toBeInstanceOf(ControlPlaneError);
    expect(err).toMatchObject({ status: 403, body: '{"error":"nope"}', statusText: 'Forbidden', malformed: false });
  });

  it('a 2xx that is an HTML page is malformed and names the URL it came from', async () => {
    const { fetch } = spy(() => new Response('<!doctype html>', { status: 200 }));
    const err = await make(fetch).whoami().catch((e) => e);
    expect(err).toMatchObject({ malformed: true, body: '<!doctype html>', url: `${BASE}/auth/whoami` });
  });

  it('adoptVerticalServing reads a non-JSON success as nothing reported — and a refusal still throws', async () => {
    const ok = spy(() => new Response('done', { status: 200 }));
    await expect(make(ok.fetch).adoptVerticalServing('v', {})).resolves.toBeNull();
    const refused = spy(() => Response.json({ error: 'x', adopted: ['a'] }, { status: 409 }));
    await expect(make(refused.fetch).adoptVerticalServing('v', {})).rejects.toMatchObject({ status: 409 });
  });

  it('a write whose answer is not read (restore, publish request) resolves on any 2xx', async () => {
    const { fetch } = spy(() => new Response(null, { status: 204 }));
    await expect(make(fetch).restoreScope(T, S, { tenantId: T, scopeId: S, capturedAt: 'n', tables: [] })).resolves.toBeUndefined();
    await expect(make(fetch).requestPublish('v')).resolves.toBeUndefined();
  });
});

describe('walkPages', () => {
  it('follows the cursor at the ceiling page size until it runs out, in order', async () => {
    const asked: Array<{ limit: number; cursor: string | null }> = [];
    const pages = [
      { entries: [1, 2], nextCursor: 'a' },
      { entries: [3], nextCursor: 'b' },
      { entries: [4], nextCursor: null },
    ];
    const all = await walkPages(async (page) => {
      asked.push(page);
      return pages.shift()!;
    });
    expect(all).toEqual([1, 2, 3, 4]);
    expect(asked).toEqual([
      { limit: 200, cursor: null },
      { limit: 200, cursor: 'a' },
      { limit: 200, cursor: 'b' },
    ]);
  });

  it('a single empty page is an empty list, and a failure propagates', async () => {
    await expect(walkPages(async () => ({ entries: [], nextCursor: null }))).resolves.toEqual([]);
    await expect(
      walkPages(async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
  });

  it('through the client: the first request carries limit only, the next adds the cursor', async () => {
    const seen: string[] = [];
    const answers = [Response.json({ entries: [{ id: 'a' }], nextCursor: 'c1' }), Response.json({ entries: [], nextCursor: null })];
    const fetch = (async (url: string) => {
      seen.push(url);
      return answers.shift()!;
    }) as unknown as typeof globalThis.fetch;
    const c = make(fetch);
    const all = await walkPages((p) => c.listHostnames(T, { limit: p.limit, cursor: p.cursor }));
    expect(all).toEqual([{ id: 'a' }]);
    expect(seen).toEqual([`${BASE}/hostnames?tenantId=${T}&limit=200`, `${BASE}/hostnames?tenantId=${T}&limit=200&cursor=c1`]);
  });
});
