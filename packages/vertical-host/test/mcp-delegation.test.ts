/**
 * Delegated calls at the MCP endpoint (#1824): another app acting for a user, within a
 * scope of this vertical's permission keys.
 *
 * The scope is a CEILING held before the operation runs, and the operation's own check is
 * the floor beside it, so a call succeeds only when the tool's leading key is delegated AND
 * the user holds it. Each rule has a refused case and an admitted twin, and the two
 * fail-closed paths — a host that admits a delegated token without handing the delegation
 * over, and a verifier too old to know `act` — are driven both with a fake resolver and
 * through the real bearer verifier from `@substrat-run/vertical-auth`.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { Hono, type Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { TrieRouter } from 'hono/router/trie-router';
import { z, mcpResourceOf } from '@substrat-run/contracts';
import { PermissionDenied } from '@substrat-run/kernel';
import { oidcAuthProvider } from '@substrat-run/vertical-auth/oidc';
import type { AuthProvider } from '@substrat-run/vertical-auth/provider';
import { INVOCATION_RECORD_KEY, type InvocationRecord } from '../src/invocation-log.js';
import { mountOperations } from '../src/operations-routes.js';
import { MCP_DELEGATION_KEY, mcpChannelOf, mcpToolsOf, mountMcp, setMcpDelegation, type McpDelegation } from '../src/mcp.js';
import { routeAnsweringAt, servedPathOf } from '../src/mcp-guard.js';

const ISSUER = 'https://team-auth.test';
const A = 'https://desk-a.example';
const RESOURCE = mcpResourceOf(A);
const ACTOR = 'helpdesk';

const operations = {
  'desk/list-tickets': { summary: 'Tickets', permission: 'tickets:read', http: { method: 'GET', path: '/tickets' } },
  'desk/get-ticket': {
    summary: 'One ticket',
    permission: { key: 'tickets:read', entity: 'ticket', idFrom: 'ticketId' },
    input: z.object({ ticketId: z.string() }),
    http: { method: 'GET', path: '/tickets/{ticketId}' },
  },
  'desk/close-ticket': {
    summary: 'Close a ticket',
    permission: 'tickets:write',
    input: z.object({ ticketId: z.string() }),
    http: { method: 'POST', path: '/tickets/{ticketId}/close' },
  },
  'desk/refund': { summary: 'Refund an order', permission: 'orders:refund', http: { method: 'POST', path: '/refunds' } },
  'desk/my-orders': {
    summary: 'Orders you placed',
    narrows: { reason: 'a customer sees their own orders', checks: ['orders:read'] },
    http: { method: 'GET', path: '/orders' },
  },
} as const;

/** The leading key each operation checks first — what the fake stub's `ctx.check` asks. */
const KEY_OF: Record<string, string> = {
  'desk/list-tickets': 'tickets:read',
  'desk/get-ticket': 'tickets:read',
  'desk/close-ticket': 'tickets:write',
  'desk/refund': 'orders:refund',
  'desk/my-orders': 'orders:read',
};

const b64url = (value: unknown) =>
  btoa(typeof value === 'string' ? value : JSON.stringify(value)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const b64urlBytes = (bytes: Uint8Array) => b64url(String.fromCharCode(...bytes));

/** A JWS-shaped token for the fake resolvers: the signature is junk, and nothing reads it. */
const unsigned = (claims: Record<string, unknown>) =>
  `${b64url({ alg: 'ES256', typ: 'JWT' })}.${b64url({ iss: ISSUER, sub: 'user-1', ...claims })}.c2ln`;

/** The stage-B claims (`demos/auth-server/src/token-exchange.ts`) for desk A's endpoint. */
const delegatedClaims = (scope: string): Record<string, unknown> => ({
  aud: RESOURCE,
  azp: ACTOR,
  client_id: ACTOR,
  scope,
  act: { iss: ISSUER, sub: ACTOR },
});

/**
 * A mounted desk. `resolve` is the vertical's own `resolveStub` half: it gets the context
 * and decides what to hand over. The stub plays the operation's leading `ctx.check` against
 * `holds`, the keys the user actually has, and counts what reached it.
 */
function desk(opts: { resolve?: (c: Context) => void | Promise<void>; holds?: readonly string[]; record?: InvocationRecord } = {}) {
  const invoked: string[] = [];
  const holds = new Set(opts.holds ?? Object.values(KEY_OF));
  const app = new Hono();
  if (opts.record) {
    const record = opts.record;
    app.use('*', async (c, next) => {
      (c as unknown as { set: (k: string, v: unknown) => void }).set(INVOCATION_RECORD_KEY, record);
      await next();
    });
  }
  mountOperations(app, operations, async (c) => {
    await opts.resolve?.(c);
    return {
      invoke: async (name: string) => {
        invoked.push(name);
        const key = KEY_OF[name]!;
        if (!holds.has(key)) throw new PermissionDenied(`permission denied: ${key}`);
        return { ok: name };
      },
    } as never;
  });
  return { app, invoked };
}

/** The tools whose input is a `ticketId`. */
const TAKES_TICKET = new Set(['desk_get-ticket', 'desk_close-ticket']);

/** One `tools/call` (or several, as a batch) at desk A's endpoint. */
async function callTools(app: Hono, names: string | string[], authorization?: string) {
  const list = Array.isArray(names) ? names : [names];
  const messages = list.map((name, i) => ({
    jsonrpc: '2.0',
    id: i + 1,
    method: 'tools/call',
    params: { name, arguments: TAKES_TICKET.has(name) ? { ticketId: 't1' } : {} },
  }));
  const res = await app.request(`${A}/api/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(authorization ? { authorization } : {}) },
    body: JSON.stringify(Array.isArray(names) ? messages : messages[0]),
  });
  const body = res.status === 200 ? ((await res.json()) as any) : null;
  const replies: any[] = body === null ? [] : Array.isArray(body) ? body : [body];
  return {
    status: res.status,
    errors: replies.map((r) => (r.result?.isError ? (r.result.content[0].text as string) : null)),
  };
}

const handOver = (delegation: McpDelegation) => (c: Context) => setMcpDelegation(c, delegation);

describe('each tool is held to the leading key it declares', () => {
  it('reads a scope key, an entity-narrowed key, and nothing for a per-row walk', () => {
    const byOp = new Map(mcpToolsOf(operations).map((t) => [t.operation, t.permission]));
    expect(byOp.get('desk/list-tickets')).toBe('tickets:read');
    expect(byOp.get('desk/get-ticket')).toBe('tickets:read');
    expect(byOp.get('desk/my-orders')).toBeUndefined();
  });
});

describe('a delegated call is held to the delegated scope before the operation runs', () => {
  const bearer = `Bearer ${unsigned(delegatedClaims('tickets:read'))}`;
  const delegation = { actor: ACTOR, scope: ['tickets:read'] };

  it('runs a tool whose key is delegated — a scope key and an entity-narrowed one', async () => {
    const { app, invoked } = desk({ resolve: handOver(delegation) });
    expect((await callTools(app, ['desk_list-tickets', 'desk_get-ticket'], bearer)).errors).toEqual([null, null]);
    expect(invoked).toEqual(['desk/list-tickets', 'desk/get-ticket']);
  });

  it('refuses a tool whose key is not delegated, in-band, without invoking it', async () => {
    const { app, invoked } = desk({ resolve: handOver(delegation) });
    const { status, errors } = await callTools(app, 'desk_close-ticket', bearer);
    expect(status).toBe(200);
    expect(errors[0]).toMatch(/needs tickets:write, which is outside the delegated scope/);
    expect(invoked).toEqual([]);
    // Twin: the user acting directly reaches it.
    const direct = desk();
    expect((await callTools(direct.app, 'desk_close-ticket')).errors).toEqual([null]);
  });

  it('refuses a per-row walk, which no single key describes — and runs it for the user directly', async () => {
    const { app, invoked } = desk({ resolve: handOver({ actor: ACTOR, scope: ['tickets:read', 'orders:read'] }) });
    expect((await callTools(app, 'desk_my-orders', bearer)).errors[0]).toMatch(/declares no single permission/);
    expect(invoked).toEqual([]);
    const direct = desk();
    expect((await callTools(direct.app, 'desk_my-orders')).errors).toEqual([null]);
  });

  it('is a ceiling, not a grant: a delegated key the user does not hold is still refused by the operation', async () => {
    const wide = { actor: ACTOR, scope: ['tickets:read', 'orders:refund'] };
    const { app, invoked } = desk({ resolve: handOver(wide), holds: ['tickets:read'] });
    expect((await callTools(app, 'desk_refund', bearer)).errors[0]).toMatch(/permission denied: orders:refund/);
    // It reached the operation, whose own check is the one that said no.
    expect(invoked).toEqual(['desk/refund']);
    // Twin: the user who holds it gets the call through.
    const holder = desk({ resolve: handOver(wide), holds: ['tickets:read', 'orders:refund'] });
    expect((await callTools(holder.app, 'desk_refund', bearer)).errors).toEqual([null]);
  });

  it('judges every call of a batch on its own', async () => {
    const { app, invoked } = desk({ resolve: handOver(delegation) });
    const { errors } = await callTools(app, ['desk_close-ticket', 'desk_list-tickets', 'desk_refund'], bearer);
    expect(errors.map((e) => e !== null)).toEqual([true, false, true]);
    expect(invoked).toEqual(['desk/list-tickets']);
  });

  it('reaches nothing with an empty scope, or one handed over malformed', async () => {
    const empty = desk({ resolve: handOver({ actor: ACTOR, scope: [] }) });
    expect((await callTools(empty.app, 'desk_list-tickets', bearer)).errors[0]).toMatch(/outside the delegated scope/);
    const garbled = desk({
      resolve: (c) => (c as unknown as { set: (k: string, v: unknown) => void }).set(MCP_DELEGATION_KEY, { scope: 'tickets:read' }),
    });
    expect((await callTools(garbled.app, 'desk_list-tickets', bearer)).errors[0]).toMatch(/outside the delegated scope/);
    expect(empty.invoked).toEqual([]);
    expect(garbled.invoked).toEqual([]);
  });

  it('records the refusal as the denial it is', async () => {
    const record: InvocationRecord = {};
    const { app } = desk({ resolve: handOver(delegation), record });
    await callTools(app, 'desk_close-ticket', bearer);
    expect(record).toMatchObject({ operation: 'desk/close-ticket', problemCode: 'permission_denied' });
  });

  it('leaves the handshake and the tool list alone', async () => {
    const { app } = desk({ resolve: handOver(delegation) });
    const res = await app.request(`${A}/api/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: bearer },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(((await res.json()) as any).result.tools).toHaveLength(5);
  });
});

/**
 * The verifier admits a delegated token on a request to the MCP path, so nothing but the MCP
 * mount may answer there: a route that did would run with the user's grants and no ceiling.
 */
describe('nothing but the MCP endpoint answers at its path', () => {
  const stub = async () => ({ invoke: async () => ({ ok: true }) }) as never;
  const at = (path: string, method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' = 'PUT') => ({
    'desk/odd': { summary: 'Odd', permission: 'tickets:read', http: { method, path } },
  });

  it('refuses to mount an operation whose route answers at the MCP path, by any method', () => {
    for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const) {
      expect(() => mountOperations(new Hono(), at('/mcp', method), stub)).toThrow(/'desk\/odd' is bound to .* \/mcp, which answers at the MCP endpoint/);
    }
    expect(() => mountOperations(new Hono(), at('/{slug}', 'POST'), stub)).toThrow(/answers at the MCP endpoint/);
  });

  it('mounts an operation beside the path, and one at it when the endpoint is off — the twins', () => {
    for (const path of ['/mcps', '/mcp/{id}', '/tickets/{id}', '/a/{b}']) {
      expect(() => mountOperations(new Hono(), at(path), stub)).not.toThrow();
    }
    expect(() => mountOperations(new Hono(), at('/mcp'), stub, { mcp: false })).not.toThrow();
  });

  it('judges the path the endpoint is actually mounted at', () => {
    expect(() => mountOperations(new Hono(), at('/agents'), stub, { mcp: { path: '/api/agents' } })).toThrow(/\/api\/agents/);
    expect(() => mountOperations(new Hono(), at('/mcp'), stub, { mcp: { path: '/api/agents' } })).not.toThrow();
  });

  /**
   * The oracle is Hono itself: each shape is first registered on a bare app and asked for
   * `/api/mcp`. The mount must refuse exactly the shapes in this table that Hono would
   * dispatch there.
   */
  it.each([
    ['a literal', 'PUT', '/api/mcp'],
    ['a parameter', 'POST', '/api/:slug'],
    ['a parameter with a hyphen in its name', 'POST', '/api/:ticket-id'],
    ['a parameter with a dot in its name', 'PATCH', '/api/:ticket.id'],
    ['a regex parameter', 'PATCH', '/api/:slug{[a-z]+}'],
    ['a regex parameter spanning a slash', 'POST', '/:p{api/mcp}'],
    ['a regex with nested braces and a star', 'DELETE', '/api/:p{m{1}cp.*}'],
    ['an optional parameter', 'DELETE', '/api/:x?'],
    ['two parameters', 'GET', '/:a/:b'],
    ['a non-standard method', 'PROPFIND', '/api/mcp'],
    ['a regex that does not match', 'POST', '/api/:x{[0-9]+}'],
    ['a deeper path', 'POST', '/api/mcp/:x'],
    ['a longer segment', 'POST', '/api/mcps'],
    ['a trailing wildcard', 'POST', '/api/mcp/*'],
    ['a wildcard segment', 'POST', '/*/mcp'],
    ['a wildcard under the base', 'POST', '/api/*'],
    ['a GET fallback', 'GET', '*'],
    ['a wildcard elsewhere', 'POST', '/other/*'],
    ['a wildcard a segment deeper', 'POST', '/api/*/mcp'],
  ])('judges %s the way Hono dispatches it', async (_name, method, pattern) => {
    let dispatched = false;
    const bare = new Hono();
    bare.on(method, pattern, (c) => ((dispatched = true), c.text('mine')));
    await bare.request(`${A}/api/mcp`, { method });

    const app = new Hono();
    app.on(method, pattern, (c) => c.text('mine'));
    const mount = () => mountOperations(app, operations, stub);
    if (dispatched) expect(mount).toThrow(/is registered before the MCP endpoint/);
    else expect(mount).not.toThrow();
  });

  it('dispatches every refused shape in the table above (the oracle is not vacuous)', async () => {
    let hits = 0;
    for (const [method, pattern] of [
      ['POST', '/api/:ticket-id'],
      ['POST', '/:p{api/mcp}'],
      ['DELETE', '/api/:p{m{1}cp.*}'],
      ['PROPFIND', '/api/mcp'],
    ] as const) {
      const bare = new Hono();
      bare.on(method, pattern, (c) => (hits++, c.text('mine')));
      await bare.request(`${A}/api/mcp`, { method });
    }
    expect(hits).toBe(4);
  });

  it('refuses a second mountOperations on the same base: the first endpoint already answers there', () => {
    const app = new Hono();
    mountOperations(app, operations, stub);
    expect(() => mountOperations(app, operations, stub)).toThrow(/is registered before the MCP endpoint/);
    // Twin: a second mount under another base has an endpoint of its own.
    expect(() => mountOperations(app, operations, stub, { basePath: '/v2' })).not.toThrow();
  });

  it('refuses a * segment that every Hono router dispatches to the MCP path, and not one that misses it', async () => {
    const reaches = async (pattern: string) => {
      const hits: boolean[] = [];
      for (const app of [new Hono(), new Hono({ router: new TrieRouter() })]) {
        let hit = false;
        app.post(pattern, (c) => ((hit = true), c.text('mine')));
        await app.request(`${A}/api/mcp`, { method: 'POST' });
        hits.push(hit);
      }
      return hits;
    };
    for (const pattern of ['*', '/*', '/api/*', '/api/mcp/*', '/*/mcp', '/*/*']) {
      expect(await reaches(pattern), pattern).toEqual([true, true]);
      const app = new Hono();
      app.post(pattern, (c) => c.text('mine'));
      expect(() => mountOperations(app, operations, stub), pattern).toThrow(/is registered before the MCP endpoint/);
    }
    for (const pattern of ['/other/*', '/api/*/mcp', '/api/m/*', '/api/mcp/*/x', '/v1/*']) {
      expect(await reaches(pattern), pattern).toEqual([false, false]);
      const app = new Hono();
      app.post(pattern, (c) => c.text('mine'));
      expect(() => mountOperations(app, operations, stub), pattern).not.toThrow();
    }
  });

  it('does not judge use, all, mount or OPTIONS', async () => {
    const app = new Hono();
    let seen = 0;
    app.use('/api/mcp', async (_c, next) => {
      seen++;
      await next();
    });
    app.use('*', async (_c, next) => next());
    app.options('/api/mcp', () => new Response(null, { status: 204 }));
    app.mount('/legacy', () => new Response('legacy'));
    expect(() => mountOperations(app, operations, stub)).not.toThrow();
    // Not judged means not refused at mount — an `app.all` there would answer in the endpoint's
    // place, which the docs state; it still gets no channel, so no delegated token.
    const withAll = new Hono();
    withAll.all('/api/mcp', () => new Response('mine'));
    expect(() => mountOperations(withAll, operations, stub)).not.toThrow();
    const res = await app.request(`${A}/api/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
    });
    expect(res.status).toBe(200);
    expect(seen).toBe(1);
  });

  it('answers every method but OPTIONS itself, so a route registered after it never runs there', async () => {
    const app = new Hono();
    mountOperations(app, operations, stub);
    let ran = 0;
    const handler = () => {
      ran++;
      return new Response('mine');
    };
    app.put('/api/mcp', handler);
    app.patch('/api/:slug', handler);
    app.delete('/api/mcp', handler);
    app.get('/api/mcp', handler);
    app.on(['PROPFIND', 'QUERY', 'REPORT'], '/api/mcp', handler);
    app.options('/api/mcp', () => new Response(null, { status: 204 }));
    for (const method of ['PUT', 'PATCH', 'DELETE', 'GET', 'HEAD', 'PROPFIND', 'QUERY', 'REPORT']) {
      const res = await app.request(`${A}/api/mcp`, { method });
      expect([method, res.status, res.headers.get('allow')]).toEqual([method, 405, 'POST']);
    }
    expect(ran).toBe(0);
    // Twin: OPTIONS passes on, to whatever answers a preflight.
    expect((await app.request(`${A}/api/mcp`, { method: 'OPTIONS' })).status).toBe(204);
  });

  it('judges an operation the way it judges a hand-written route', () => {
    expect(routeAnsweringAt([{ method: 'POST', path: '/api/:x' }], '/api/mcp')).toEqual({ method: 'POST', path: '/api/:x' });
    expect(routeAnsweringAt([{ method: 'ALL', path: '/api/mcp' }], '/api/mcp')).toBeUndefined();
    expect(routeAnsweringAt([{ method: 'OPTIONS', path: '/api/mcp' }], '/api/mcp')).toBeUndefined();
    // A `*` segment is judged as TrieRouter reads it: one that reaches the path, and one that does not.
    expect(routeAnsweringAt([{ method: 'GET', path: '/api/*' }], '/api/mcp')).toEqual({ method: 'GET', path: '/api/*' });
    expect(routeAnsweringAt([{ method: 'GET', path: '/other/*' }], '/api/mcp')).toBeUndefined();
    // A `*` inside a segment is judged as TrieRouter reads it.
    for (const path of ['/api/mc*', '/api/mcp*', '/api/m*', '/a*', '/ap*']) {
      expect(routeAnsweringAt([{ method: 'POST', path }], '/api/mcp'), path).toEqual({ method: 'POST', path });
    }
    expect(routeAnsweringAt([{ method: 'POST', path: '/api/x*' }], '/api/mcp')).toBeUndefined();
    // A `*` inside a parameter's regex is the regex's, not a catch-all: it is judged the same way.
    expect(routeAnsweringAt([{ method: 'POST', path: '/api/:p{m.*}' }], '/api/mcp')).toEqual({ method: 'POST', path: '/api/:p{m.*}' });
    expect(routeAnsweringAt([{ method: 'POST', path: '/api/:p{x.*}' }], '/api/mcp')).toBeUndefined();
  });

  it('refuses a * inside a segment that both Hono routers dispatch to the MCP path', async () => {
    for (const pattern of ['/api/mc*', '/api/mcp*', '/api/m*', '/a*', '/ap*']) {
      // The oracle: the default router and TrieRouter both answer a request there with this route.
      for (const app of [new Hono(), new Hono({ router: new TrieRouter() })]) {
        let hit = false;
        app.post(pattern, (c) => ((hit = true), c.text('mine')));
        await app.request(`${A}/api/mcp`, { method: 'POST' });
        expect(hit, pattern).toBe(true);
      }
      const app = new Hono();
      app.post(pattern, (c) => c.text('mine'));
      expect(() => mountOperations(app, operations, stub), pattern).toThrow(/is registered before the MCP endpoint/);
    }
  });

  it('judges the path the endpoint answers at under a Hono basePath(), not the unprefixed one', async () => {
    // A root route at the unprefixed path is not in the way of an endpoint at /v1/api/mcp…
    const root = new Hono();
    root.post('/api/mcp', (c) => c.text('root'));
    expect(() => mountOperations(root.basePath('/v1'), operations, stub)).not.toThrow();
    const res = await root.request(`${A}/v1/api/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
    });
    expect([res.status, await res.json()]).toEqual([200, { jsonrpc: '2.0', id: 1, result: {} }]);
    // …and an earlier route on the basePath app that answers there refuses the mount.
    const v1 = new Hono().basePath('/v1');
    v1.post('/api/:x', (c) => c.text('mine'));
    expect(() => mountOperations(v1, operations, stub)).toThrow(
      'mountOperations: POST /v1/api/:x is registered before the MCP endpoint and would answer at /v1/api/mcp',
    );
  });

  it('registers nothing when it refuses the mount, on a plain app and under a basePath()', () => {
    for (const app of [new Hono(), new Hono().basePath('/v1')]) {
      app.post('/api/:x', (c) => c.text('mine'));
      const before = app.routes.length;
      expect(() => mountOperations(app, operations, stub)).toThrow(/^mountOperations: POST .*\/api\/:x is registered before the MCP endpoint/);
      expect(() => mountMcp(app, operations, stub)).toThrow(/^mountMcp: POST .*\/api\/:x is registered before the MCP endpoint/);
      expect(app.routes.length).toBe(before);
    }
  });

  it('registers nothing when one of its own operations is at the MCP path, though another sorts before it', () => {
    const ops = {
      'desk/first': { summary: 'First', permission: 'tickets:read', http: { method: 'GET', path: '/aaa' } },
      'desk/odd': { summary: 'Odd', permission: 'tickets:read', http: { method: 'POST', path: '/mcp' } },
    };
    for (const app of [new Hono(), new Hono().basePath('/v1')]) {
      expect(() => mountOperations(app, ops, stub)).toThrow(/^mountOperations: 'desk\/odd' is bound to POST \/mcp/);
      expect(app.routes).toEqual([]);
    }
    // The same holds for an operation no registered module provides.
    const app = new Hono();
    expect(() => mountOperations(app, ops, stub, { mcp: false, knownOperations: ['desk/odd'] })).toThrow(/'desk\/first' .* no registered module provides it/);
    expect(app.routes).toEqual([]);
  });

  it('reads a basePath() prefix exactly as Hono applies it when it registers a route', () => {
    for (const app of [new Hono(), new Hono().basePath('/v1'), new Hono().basePath('/v1').basePath('/v2/'), new Hono().basePath('/')]) {
      const served = servedPathOf(app, '/api/mcp');
      app.post('/api/mcp', (c) => c.text('mine'));
      expect(served).toBe(app.routes.at(-1)!.path);
    }
  });

  it('does not refuse a mid-segment * that only the default router dispatches there, nor see routes app.route() mounts it under', async () => {
    const dispatches = async (app: Hono, pattern: string) => {
      let hit = false;
      app.post(pattern, (c) => ((hit = true), c.text('mine')));
      await app.request(`${A}/api/mcp`, { method: 'POST' });
      return hit;
    };
    for (const pattern of ['/api/*cp', '/ap*/mcp']) {
      // The default router dispatches it to the endpoint's path; TrieRouter does not.
      expect([await dispatches(new Hono(), pattern), await dispatches(new Hono({ router: new TrieRouter() }), pattern)], pattern).toEqual([true, false]);
      const app = new Hono();
      app.post(pattern, (c) => c.text('mine'));
      expect(() => mountOperations(app, operations, stub), pattern).not.toThrow();
    }
    // A prefix added later: the routes of the app it is mounted into are not seen.
    const sub = new Hono();
    mountOperations(sub, operations, stub);
    const parent = new Hono();
    parent.post('/v2/api/:x', (c) => c.text('mine'));
    expect(() => parent.route('/v2', sub)).not.toThrow();
  });
});

/**
 * The channel a delegated token is admitted through exists only inside the MCP mount's own
 * `resolveStub` call. Everything else — a REST route, a hand-written route, a middleware
 * reading after `next()`, anything a request carries — sees `null`.
 */
describe('the MCP channel', () => {
  const ping = (app: Hono, url: string, headers: Record<string, string> = {}) =>
    app.request(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
    });

  it("is the endpoint's resource inside its resolveStub, and null in an operation route's", async () => {
    const seen: (string | null)[] = [];
    const app = new Hono();
    mountOperations(app, operations, async (c) => {
      seen.push(mcpChannelOf(c)?.resource ?? null);
      return { invoke: async () => ({ ok: true }) } as never;
    });
    await ping(app, `${A}/api/mcp`);
    await app.request(`${A}/api/tickets`);
    expect(seen).toEqual([RESOURCE, null]);
  });

  it('names a pinned resource when the endpoint publishes one', async () => {
    let seen: string | null | undefined;
    const app = new Hono();
    const pinned = 'https://desk-a.example/agents/mcp';
    mountOperations(
      app,
      operations,
      async (c) => {
        seen = mcpChannelOf(c)?.resource ?? null;
        return { invoke: async () => ({ ok: true }) } as never;
      },
      { mcp: { protectedResource: { authorizationServers: [ISSUER], resource: pinned } } },
    );
    await ping(app, `${A}/api/mcp`, { authorization: `Bearer ${unsigned({ aud: pinned })}` });
    expect(seen).toBe(pinned);
  });

  it('is gone once resolveStub returns: a middleware around the endpoint reads null after next()', async () => {
    const app = new Hono();
    let after: unknown = 'unread';
    app.use('*', async (c, next) => {
      await next();
      after = mcpChannelOf(c);
    });
    mountOperations(app, operations, async () => ({ invoke: async () => ({ ok: true }) }) as never);
    await ping(app, `${A}/api/mcp`);
    expect(after).toBeNull();
  });

  it('is gone even when resolveStub throws', async () => {
    const app = new Hono();
    let after: unknown = 'unread';
    app.use('*', async (c, next) => {
      await next();
      after = mcpChannelOf(c);
    });
    mountOperations(app, operations, async () => {
      throw new HTTPException(401, { message: 'nobody' });
    });
    expect((await ping(app, `${A}/api/mcp`)).status).toBe(401);
    expect(after).toBeNull();
  });

  it('cannot be set by a request: a header, query or cookie of the same name reaches nothing', async () => {
    const forged = JSON.stringify({ resource: 'https://forged.example/api/mcp' });
    const app = new Hono();
    const seen: (string | null)[] = [];
    app.get('/api/elsewhere', (c) => c.json(mcpChannelOf(c)));
    mountOperations(app, operations, async (c) => {
      seen.push(mcpChannelOf(c)?.resource ?? null);
      return { invoke: async () => ({ ok: true }) } as never;
    });
    const carrying = {
      substratMcpChannel: forged,
      'x-substrat-mcp-channel': forged,
      cookie: `substratMcpChannel=${encodeURIComponent(forged)}`,
    };
    const query = `?substratMcpChannel=${encodeURIComponent(forged)}`;
    expect(await (await app.request(`${A}/api/elsewhere${query}`, { headers: carrying })).json()).toBeNull();
    await app.request(`${A}/api/tickets${query}`, { headers: carrying });
    await ping(app, `${A}/api/mcp${query}`, carrying);
    expect(seen).toEqual([null, RESOURCE]);
  });
});

describe('an operation route refuses a delegated bearer', () => {
  const bearer = `Bearer ${unsigned(delegatedClaims('tickets:read tickets:write'))}`;

  it('answers 401 before resolving the caller, whatever the resolver would admit', async () => {
    let resolved = 0;
    const { app, invoked } = desk({ resolve: () => void resolved++ });
    expect((await app.request(`${A}/api/tickets`, { headers: { authorization: bearer } })).status).toBe(401);
    expect((await app.request(`${A}/api/tickets/t1/close`, { method: 'POST', headers: { authorization: bearer } })).status).toBe(401);
    expect(resolved).toBe(0);
    expect(invoked).toEqual([]);
    // Twins: the same routes serve a bearer without `act`, and no bearer at all.
    expect((await app.request(`${A}/api/tickets`, { headers: { authorization: `Bearer ${unsigned({ aud: 'desk-a' })}` } })).status).toBe(200);
    expect((await app.request(`${A}/api/tickets`)).status).toBe(200);
    expect(invoked).toEqual(['desk/list-tickets', 'desk/list-tickets']);
  });

  it('refuses it at an operation on the MCP path when the derived endpoint is off', async () => {
    const app = new Hono();
    let invoked = 0;
    mountOperations(
      app,
      { 'desk/odd': { summary: 'Odd', permission: 'tickets:read', http: { method: 'POST', path: '/mcp' } } },
      async () => ({ invoke: async () => ((invoked++, { ok: true })) }) as never,
      { mcp: false },
    );
    expect((await app.request(`${A}/api/mcp`, { method: 'POST', headers: { authorization: bearer } })).status).toBe(401);
    expect(invoked).toBe(0);
  });
});

describe('a delegated bearer with no delegation handed over fails closed', () => {
  const bearer = `Bearer ${unsigned(delegatedClaims('tickets:read tickets:write'))}`;

  it('refuses every call when the host admits the token and forgets the hand-off', async () => {
    const { app, invoked } = desk();
    const { errors } = await callTools(app, ['desk_list-tickets', 'desk_close-ticket'], bearer);
    expect(errors.every((e) => /delegated calls are not accepted/.test(e ?? ''))).toBe(true);
    expect(invoked).toEqual([]);
  });

  it('refuses every call when a cookie session answered and a delegated bearer rode along', async () => {
    // The resolver took the cookie: a user, with nothing to hand over. The bearer still says `act`.
    const { app, invoked } = desk({ resolve: () => undefined });
    expect((await callTools(app, 'desk_list-tickets', bearer)).errors[0]).toMatch(/not accepted/);
    expect(invoked).toEqual([]);
  });

  it('applies no ceiling to a bearer without act, or one it cannot read — the twins', async () => {
    const { app, invoked } = desk();
    expect((await callTools(app, 'desk_close-ticket', `Bearer ${unsigned({ aud: RESOURCE, azp: 'mcp-client' })}`)).errors).toEqual([null]);
    expect((await callTools(app, 'desk_close-ticket')).errors).toEqual([null]);
    expect(invoked).toEqual(['desk/close-ticket', 'desk/close-ticket']);
  });
});

/**
 * The same paths through the REAL verifier. A token signed with Web Crypto (ES256), checked
 * by `oidcAuthProvider` with that key injected — the provider a vertical gets from
 * `selectAuthProvider` on a team issuer, built here directly.
 */
describe('end to end through the bearer verifier', () => {
  let privateKey: CryptoKey;
  let publicKey: CryptoKey;

  beforeAll(async () => {
    const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify'])) as CryptoKeyPair;
    privateKey = pair.privateKey;
    publicKey = pair.publicKey;
  });

  async function signed(claims: Record<string, unknown>): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    const input = `${b64url({ alg: 'ES256', typ: 'JWT' })}.${b64url({ iss: ISSUER, sub: 'user-1', iat: now, exp: now + 300, ...claims })}`;
    const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, privateKey, new TextEncoder().encode(input));
    return `${input}.${b64urlBytes(new Uint8Array(sig))}`;
  }

  const provider = (delegation?: { actors: string[] }): AuthProvider =>
    oidcAuthProvider({
      issuer: ISSUER,
      clientId: 'desk-a',
      resourceOf: (origin) => mcpResourceOf(origin),
      keys: async () => publicKey,
      ...(delegation ? { delegation } : {}),
    });

  /**
   * A vertical's `resolveStub` on the upgraded pattern: resolve with the request URL and the
   * MCP channel, 401 nobody, hand the delegation over. `handOff: false` is the same host
   * forgetting the last line; `channel: false` is one on a vertical-host with no channel to pass.
   */
  const upgradedResolve =
    (auth: AuthProvider, opts: { handOff?: boolean; channel?: boolean } = {}) =>
    async (c: Context) => {
      const subject = await auth.resolve(
        c.req.raw.headers,
        c.req.url,
        opts.channel === false ? undefined : { delegated: mcpChannelOf(c) },
      );
      if (!subject) throw new HTTPException(401, { message: 'unauthorized' });
      if (opts.handOff !== false) setMcpDelegation(c, subject.delegation);
    };
  const upgradedDesk = (auth: AuthProvider, handOff = true) => desk({ resolve: upgradedResolve(auth, { handOff }) });

  it('an opted-in, wired host: the delegated scope holds, and the user is who acts', async () => {
    const t = `Bearer ${await signed(delegatedClaims('tickets:read'))}`;
    const { app, invoked } = upgradedDesk(provider({ actors: [ACTOR] }));
    const { errors } = await callTools(app, ['desk_list-tickets', 'desk_close-ticket'], t);
    expect(errors[0]).toBeNull();
    expect(errors[1]).toMatch(/outside the delegated scope/);
    expect(invoked).toEqual(['desk/list-tickets']);
  });

  it('an opted-in host that forgets the hand-off has every delegated call refused', async () => {
    const t = `Bearer ${await signed(delegatedClaims('tickets:read'))}`;
    const { app, invoked } = upgradedDesk(provider({ actors: [ACTOR] }), false);
    expect((await callTools(app, 'desk_list-tickets', t)).errors[0]).toMatch(/not accepted/);
    expect(invoked).toEqual([]);
  });

  it('a host that has not opted in answers a delegated token with a 401: nobody', async () => {
    const t = `Bearer ${await signed(delegatedClaims('tickets:read'))}`;
    const { app, invoked } = upgradedDesk(provider());
    expect((await callTools(app, 'desk_list-tickets', t)).status).toBe(401);
    expect(invoked).toEqual([]);
  });

  it('a vertical-host with no channel to hand over (a newer vertical-auth on an older host) admits no delegated token', async () => {
    const t = `Bearer ${await signed(delegatedClaims('tickets:read'))}`;
    const { app, invoked } = desk({ resolve: upgradedResolve(provider({ actors: [ACTOR] }), { channel: false }) });
    expect((await callTools(app, 'desk_list-tickets', t)).status).toBe(401);
    expect(invoked).toEqual([]);
  });

  it('a verifier too old to know act, taking the token as the user, is caught by the mount', async () => {
    // What every vertical-auth before #1824 did with this token: rule 1 admits it, and the
    // subject carries no delegation — so there is nothing to hand over.
    const old = desk({ resolve: () => undefined });
    const t = `Bearer ${await signed(delegatedClaims('tickets:read'))}`;
    expect((await callTools(old.app, 'desk_list-tickets', t)).errors[0]).toMatch(/not accepted/);
    expect(old.invoked).toEqual([]);
  });

  it('an opted-in host refuses the delegated token on a REST route, and serves an ordinary one there', async () => {
    const { app, invoked } = upgradedDesk(provider({ actors: [ACTOR] }));
    const rest = (authorization: string) => app.request(`${A}/api/tickets`, { headers: { authorization } });
    expect((await rest(`Bearer ${await signed(delegatedClaims('tickets:read'))}`)).status).toBe(401);
    expect(invoked).toEqual([]);
    expect((await rest(`Bearer ${await signed({ aud: 'desk-a' })}`)).status).toBe(200);
    expect(invoked).toEqual(['desk/list-tickets']);
  });

  it('an operation at the MCP path, with the endpoint off, refuses a token the verifier admits there', async () => {
    const auth = provider({ actors: [ACTOR] });
    const t = `Bearer ${await signed(delegatedClaims('tickets:read'))}`;
    // Handed the channel for this resource, the verifier would admit it: the route is what has none.
    const at = new Headers({ authorization: t });
    expect((await auth.resolve(at, `${A}/api/mcp`, { delegated: { resource: RESOURCE } }))?.delegation?.actor).toBe(ACTOR);
    const app = new Hono();
    let invoked = 0;
    mountOperations(
      app,
      { 'desk/odd': { summary: 'Odd', permission: 'tickets:write', http: { method: 'PUT', path: '/mcp' } } },
      async (c) => {
        const subject = await auth.resolve(c.req.raw.headers, c.req.url, { delegated: mcpChannelOf(c) });
        if (!subject) throw new HTTPException(401, { message: 'unauthorized' });
        return { invoke: async () => ((invoked++, { ok: true })) } as never;
      },
      { mcp: false },
    );
    expect((await app.request(`${A}/api/mcp`, { method: 'PUT', headers: { authorization: t } })).status).toBe(401);
    expect(invoked).toBe(0);
  });

  /**
   * The channel follows the endpoint, wherever it is mounted, and nothing else has one. Each
   * setup below moves the endpoint off `/api/mcp` (or turns it off) and puts a hand-written
   * route that resolves the caller the upgraded way at `/api/mcp`: it gets no channel, so the
   * verifier admits no delegated subject there.
   */
  it.each([
    ['basePath /v1', { basePath: '/v1' }, `${A}/v1/mcp`],
    ['mcp.path /api/agent', { mcp: { path: '/api/agent' } }, `${A}/api/agent`],
    ['mcp off', { mcp: false as const }, undefined],
  ])('%s: the endpoint admits through its own resource, and a route at /api/mcp admits nothing', async (_name, options, endpoint) => {
    const auth = provider({ actors: [ACTOR] });
    const app = new Hono();
    let invoked = 0;
    app.put('/api/mcp', async (c) => {
      const subject = await auth.resolve(c.req.raw.headers, c.req.url, { delegated: mcpChannelOf(c) });
      return subject ? c.json({ as: subject.sub }) : c.json({ error: 'unauthorized' }, 401);
    });
    mountOperations(
      app,
      operations,
      async (c) => {
        await upgradedResolve(auth)(c);
        return { invoke: async (name: string) => ((invoked++, { ok: name })) } as never;
      },
      options,
    );
    const atDefault = `Bearer ${await signed(delegatedClaims('tickets:read'))}`;
    expect((await app.request(`${A}/api/mcp`, { method: 'PUT', headers: { authorization: atDefault } })).status).toBe(401);
    if (endpoint) {
      const forEndpoint = `Bearer ${await signed({ ...delegatedClaims('tickets:read'), aud: endpoint })}`;
      const res = await app.request(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: forEndpoint },
        body: JSON.stringify([
          { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'desk_list-tickets', arguments: {} } },
          { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'desk_close-ticket', arguments: { ticketId: 't1' } } },
        ]),
      });
      const [listed, closed] = (await res.json()) as any[];
      expect(listed.result.isError).toBeUndefined();
      expect(closed.result.isError).toBe(true);
      expect(invoked).toBe(1);
    }
  });

  it("an ordinary user's MCP token is unchanged: no ceiling, every tool the user holds", async () => {
    const { app, invoked } = upgradedDesk(provider({ actors: [ACTOR] }));
    const t = `Bearer ${await signed({ aud: [RESOURCE, `${ISSUER}/oauth2/userinfo`], azp: 'mcp-client' })}`;
    expect((await callTools(app, ['desk_close-ticket', 'desk_my-orders'], t)).errors).toEqual([null, null]);
    expect(invoked).toEqual(['desk/close-ticket', 'desk/my-orders']);
  });
});
