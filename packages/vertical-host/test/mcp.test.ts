/**
 * Does the derived MCP surface behave like a server a real client can drive?
 *
 * Driven through a real Hono app with `app.request` and real JSON-RPC envelopes, for
 * the reason the route-table suite gives: a derivation nothing drives proves nothing.
 * The assertions that matter are the ones a hand-rolled protocol gets wrong — the
 * authentication/authorization split, the page trio an MCP call has no query string
 * for, and a pinned field a caller must not be able to edit.
 */
import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z, LIST_PAGE_DEFAULT, LIST_PAGE_MAX } from '@substrat-run/contracts';
import { PermissionDenied } from '@substrat-run/kernel';
import { mountOperations } from '../src/operations-routes.js';
import { mcpToolsOf, mcpToolName, MCP_PROTOCOL_VERSIONS } from '../src/mcp.js';

const operations = {
  'todo/my-lists': { summary: 'Every list you can see', http: { method: 'GET', path: '/lists' } },
  'todo/create-list': {
    summary: 'Start a list',
    input: z.object({ title: z.string() }),
    http: { method: 'POST', path: '/lists' },
  },
  'todo/delete-list': {
    summary: 'Throw a list away',
    input: z.object({ listId: z.string() }),
    http: { method: 'DELETE', path: '/lists/{listId}' },
  },
  'todo/list-items': {
    summary: 'The items on a list',
    input: z.object({ listId: z.string() }),
    paged: { sortKey: 'id', total: true },
    http: { method: 'GET', path: '/lists/{listId}/items' },
  },
  'todo/pinned': {
    summary: 'Note against a workorder',
    input: z.object({ entityType: z.literal('workorder'), entityId: z.string(), note: z.string() }),
    http: { method: 'POST', path: '/workorders/{entityId}/notes' },
  },
  /** No `http` — a composed engine's in-scope operation. Never a route, never a tool. */
  'todo/in-scope-only': { summary: 'Composed by call', input: z.object({ x: z.string() }) },
  /** Reachable over HTTP because a connector posts to it; noise in a tool list. */
  'todo/record-answer': {
    summary: 'Record what the model said',
    mcp: false,
    input: z.object({ turnId: z.string() }),
    http: { method: 'POST', path: '/turns' },
  },
  'todo/described': {
    summary: 'Search',
    mcp: { description: 'Search the knowledge base. Use before answering any question.' },
    input: z.object({ q: z.string() }),
    http: { method: 'GET', path: '/search' },
  },
} as const;

/** A mounted app plus what the stub was asked to invoke. */
function harness(opts: { invoke?: (name: string, input: unknown) => unknown; resolve?: () => void } = {}) {
  const calls: { name: string; input: unknown }[] = [];
  const app = new Hono();
  mountOperations(app, operations, async () => {
    opts.resolve?.();
    return {
      invoke: async (name: string, input: unknown) => {
        calls.push({ name, input });
        return opts.invoke ? opts.invoke(name, input) : { ok: true };
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
  });
  return { app, calls };
}

/** One JSON-RPC round trip against the mounted endpoint. */
async function rpc(app: Hono, method: string, params?: unknown, id: number | string | null = 1) {
  const res = await app.request('/api/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) }),
  });
  return { status: res.status, body: res.status === 202 ? null : ((await res.json()) as any) };
}

describe('the tool list is derived, not declared', () => {
  it('renders one tool per operation that declares http', () => {
    const names = mcpToolsOf(operations).map((t) => t.operation);
    expect(names).toContain('todo/create-list');
    // No `http` ⇒ no route ⇒ no tool. The same boundary the route table draws.
    expect(names).not.toContain('todo/in-scope-only');
  });

  it('honours `mcp: false` as never-a-tool-for-anyone', () => {
    const names = mcpToolsOf(operations).map((t) => t.operation);
    expect(names).not.toContain('todo/record-answer');
  });

  it('makes an operation name client-safe, and refuses a collision', () => {
    // Only the separator moves — a hyphen is already client-safe and stays.
    expect(mcpToolName('ticket0/get-desk')).toBe('ticket0_get-desk');
    expect(() =>
      mcpToolsOf({
        'a/b': { http: { method: 'GET', path: '/one' } },
        'a.b': { http: { method: 'GET', path: '/two' } },
      }),
    ).toThrow(/both render as the tool name/);
  });

  it('prefers a vertical’s own description over the API-document summary', () => {
    const tools = mcpToolsOf(operations);
    expect(tools.find((t) => t.operation === 'todo/described')?.description).toMatch(/knowledge base/);
    // Absent one, the sentence the operation already carries.
    expect(tools.find((t) => t.operation === 'todo/create-list')?.description).toBe('Start a list');
  });

  it('hints at what a tool does to the world, from the method alone', () => {
    const tools = mcpToolsOf(operations);
    expect(tools.find((t) => t.operation === 'todo/my-lists')?.annotations.readOnlyHint).toBe(true);
    expect(tools.find((t) => t.operation === 'todo/delete-list')?.annotations.destructiveHint).toBe(true);
    expect(tools.find((t) => t.operation === 'todo/create-list')?.annotations.readOnlyHint).toBe(false);
  });

  /**
   * The failure this prevents is silent: an agent pulls one page, sees no way to ask
   * for another, and reports the first 20 rows as the whole table.
   */
  it('spells the page trio into a paged read’s schema', () => {
    const tool = mcpToolsOf(operations).find((t) => t.operation === 'todo/list-items');
    const props = tool?.inputSchema['properties'] as Record<string, unknown>;
    expect(Object.keys(props)).toEqual(expect.arrayContaining(['listId', 'limit', 'cursor', 'order', 'sort']));
  });

  /** Stated, not merely enforced: the ceiling REFUSES, so an unstated bound is found by erroring. */
  it('states the page bounds an agent would otherwise discover by failing', () => {
    const tool = mcpToolsOf(operations).find((t) => t.operation === 'todo/list-items');
    const limit = (tool?.inputSchema['properties'] as Record<string, Record<string, unknown>>)['limit'];
    expect(limit).toMatchObject({ maximum: LIST_PAGE_MAX, default: LIST_PAGE_DEFAULT, minimum: 1 });
  });
});

describe('the handshake', () => {
  it('answers initialize with the revision it will actually speak', async () => {
    const { app } = harness();
    const { body } = await rpc(app, 'initialize', { protocolVersion: '2025-03-26' });
    expect(body.result.protocolVersion).toBe('2025-03-26');
    expect(body.result.capabilities.tools).toBeDefined();
  });

  it('falls back to its own latest rather than echoing a revision it does not speak', async () => {
    const { app } = harness();
    const { body } = await rpc(app, 'initialize', { protocolVersion: '1999-01-01' });
    expect(body.result.protocolVersion).toBe(MCP_PROTOCOL_VERSIONS[0]);
  });

  it('names itself after the module its operations share', async () => {
    const { app } = harness();
    const { body } = await rpc(app, 'initialize', {});
    expect(body.result.serverInfo.name).toBe('todo');
  });

  it('answers a notification with 202 and no body', async () => {
    const { app } = harness();
    const res = await app.request('/api/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    });
    expect(res.status).toBe(202);
  });

  it('opens no event stream, and says so', async () => {
    const { app } = harness();
    const res = await app.request('/api/mcp');
    expect(res.status).toBe(405);
  });
});

describe('calling a tool', () => {
  it('dispatches to the operation the tool was derived from', async () => {
    const { app, calls } = harness();
    const { body } = await rpc(app, 'tools/call', {
      name: 'todo_create-list',
      arguments: { title: 'Groceries' },
    });
    expect(calls).toEqual([{ name: 'todo/create-list', input: { title: 'Groceries' } }]);
    expect(body.result.isError).toBeUndefined();
    expect(body.result.structuredContent).toEqual({ ok: true });
  });

  it('carries the result as text too, for a client that reads no structured output', async () => {
    const { app } = harness({ invoke: () => ({ id: 'l1' }) });
    const { body } = await rpc(app, 'tools/call', { name: 'todo_create-list', arguments: { title: 'x' } });
    expect(JSON.parse(body.result.content[0].text)).toEqual({ id: 'l1' });
  });

  it('wraps a non-object result, which structuredContent may not be', async () => {
    const { app } = harness({ invoke: () => [1, 2] });
    const { body } = await rpc(app, 'tools/call', { name: 'todo_my-lists', arguments: {} });
    expect(body.result.structuredContent).toEqual({ result: [1, 2] });
  });

  it('invokes with no argument at all when the operation declares no input', async () => {
    const { app, calls } = harness();
    await rpc(app, 'tools/call', { name: 'todo_my-lists', arguments: {} });
    // `z.object({})` cannot say "no body": a handler typed for `undefined` rejects `{}`.
    expect(calls[0]?.input).toBeUndefined();
  });

  /**
   * The HTTP mount discards a query string for a no-input operation, so this has to
   * discard hallucinated arguments — otherwise one operation sees a different input
   * depending on which transport reached it.
   */
  it('discards arguments a model invented for a no-input tool', async () => {
    const { app, calls } = harness();
    await rpc(app, 'tools/call', { name: 'todo_my-lists', arguments: { mine: true } });
    expect(calls[0]?.input).toBeUndefined();
  });

  it('will not let a caller talk the model out of a pinned field', async () => {
    const { app, calls } = harness();
    await rpc(app, 'tools/call', {
      name: 'todo_pinned',
      arguments: { entityType: 'invoice', entityId: 'e1', note: 'hi' },
    });
    expect((calls[0]?.input as Record<string, unknown>)['entityType']).toBe('workorder');
  });

  it('applies the platform’s page default, as the HTTP mount does', async () => {
    const { app, calls } = harness();
    await rpc(app, 'tools/call', { name: 'todo_list-items', arguments: { listId: 'l1' } });
    expect((calls[0]?.input as Record<string, unknown>)['limit']).toBe(LIST_PAGE_DEFAULT);
  });

  /**
   * REFUSED, not silently capped — the same answer `?limit=100000` gets over HTTP,
   * because it is the same `listPageQuery` deciding. An agent that asked for 100 000
   * rows and quietly received 200 could not tell a capped page from the end of the
   * walk, and would report the first page as the whole table.
   */
  it('refuses a limit above the ceiling, as the HTTP mount does', async () => {
    const { app, calls } = harness();
    const { body } = await rpc(app, 'tools/call', {
      name: 'todo_list-items',
      arguments: { listId: 'l1', limit: LIST_PAGE_MAX + 1 },
    });
    expect(body.result.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it('refuses a tool it does not have', async () => {
    const { app } = harness();
    const { body } = await rpc(app, 'tools/call', { name: 'todo_nonesuch', arguments: {} });
    expect(body.error.code).toBe(-32602);
  });

  it('will not dispatch to an operation excluded from the surface', async () => {
    const { app, calls } = harness();
    const { body } = await rpc(app, 'tools/call', { name: 'todo_record-answer', arguments: { turnId: 't' } });
    expect(body.error.code).toBe(-32602);
    expect(calls).toEqual([]);
  });
});

/**
 * The split this surface exists to get right. Authentication is the transport's
 * business — a 401 is what makes a client start its authorization flow. Authorization
 * is the agent's — a refusal it can read is a refusal it can work around, where a
 * transport error looks like the session itself is broken.
 */
describe('authentication is transport-level, authorization is in-band', () => {
  it('lets an anonymous call fail as a 401, not as a tool error', async () => {
    const app = new Hono();
    mountOperations(app, operations, async () => {
      throw new HTTPException(401, { message: 'anonymous' });
    });
    const res = await app.request('/api/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'todo_my-lists' } }),
    });
    expect(res.status).toBe(401);
  });

  it('hands a refused permission back as a tool error the agent can read', async () => {
    const { app } = harness({
      invoke: () => {
        throw new PermissionDenied('list:read');
      },
    });
    const { status, body } = await rpc(app, 'tools/call', { name: 'todo_my-lists', arguments: {} });
    expect(status).toBe(200);
    expect(body.result.isError).toBe(true);
    expect(body.error).toBeUndefined();
  });

  it('hands a failed input parse back the same way', async () => {
    const { app } = harness({
      invoke: () => {
        throw new z.ZodError([]);
      },
    });
    const { body } = await rpc(app, 'tools/call', { name: 'todo_create-list', arguments: {} });
    expect(body.result.isError).toBe(true);
  });

  it('requires a principal before it will list tools', async () => {
    let resolved = 0;
    const { app } = harness({ resolve: () => void resolved++ });
    await rpc(app, 'tools/list', {});
    expect(resolved).toBe(1);
  });

  /**
   * The whole endpoint, not two of its verbs. Authenticating only the scope-touching
   * methods would let a client shake hands anonymously and meet the 401 on its SECOND
   * request — a false start before discovery, where the first message should carry it.
   */
  it('authenticates the handshake too, so the first message is the one that 401s', async () => {
    const app = new Hono();
    mountOperations(app, operations, async () => {
      throw new HTTPException(401, { message: 'anonymous' });
    });
    const res = await app.request('/api/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    });
    expect(res.status).toBe(401);
  });
});

describe('the endpoint itself', () => {
  it('is mounted without being asked for', async () => {
    const { app } = harness();
    const { body } = await rpc(app, 'tools/list', {});
    expect(body.result.tools.length).toBeGreaterThan(0);
  });

  it('can be turned off', async () => {
    const app = new Hono();
    mountOperations(app, operations, async () => ({}) as never, { mcp: false });
    const res = await app.request('/api/mcp', { method: 'POST', body: '{}' });
    expect(res.status).toBe(404);
  });

  it('rejects a body that is not JSON with a parse error', async () => {
    const { app } = harness();
    const res = await app.request('/api/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not json',
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error.code).toBe(-32700);
  });

  it('refuses a pinned protocol revision it does not speak', async () => {
    const { app, calls } = harness();
    const res = await app.request('/api/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'MCP-Protocol-Version': '1999-01-01' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'todo_my-lists' } }),
    });
    expect(res.status).toBe(400);
    // Refused BEFORE dispatch — answering under a contract we never agreed to is worse
    // than refusing, because we would be guessing at its framing.
    expect(calls).toEqual([]);
  });

  it('accepts a request that pins no revision at all', async () => {
    const { app } = harness();
    const res = await app.request('/api/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
    });
    expect(res.status).toBe(200);
  });

  it('refuses a method it does not implement', async () => {
    const { app } = harness();
    const { body } = await rpc(app, 'resources/list', {});
    expect(body.error.code).toBe(-32601);
  });
});

/**
 * The other half of MCP authorization: a client that gets a 401 has to be able to find
 * out WHERE to authenticate. Without this the 401 is a dead end and a token has to be
 * configured by hand.
 */
describe('protected-resource metadata (RFC 9728)', () => {
  /** A mount whose `resolveStub` always refuses, so every call is the 401 path. */
  function unauthenticated(mcp?: Record<string, unknown>) {
    const app = new Hono();
    mountOperations(
      app,
      operations,
      async () => {
        throw new HTTPException(401, { message: 'anonymous' });
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { ...(mcp ? { mcp: mcp as any } : {}) },
    );
    return app;
  }

  const post = (app: Hono) =>
    app.request('/api/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });

  it('serves the document at the path-inserted well-known URL', async () => {
    const app = unauthenticated({ protectedResource: { authorizationServers: ['https://issuer.example'] } });
    const res = await app.request('/.well-known/oauth-protected-resource/api/mcp');
    expect(res.status).toBe(200);
    const doc = (await res.json()) as Record<string, unknown>;
    expect(doc['authorization_servers']).toEqual(['https://issuer.example']);
    expect(doc['bearer_methods_supported']).toEqual(['header']);
    expect(String(doc['resource'])).toMatch(/\/api\/mcp$/);
  });

  it('serves the root form too, for a client that predates path insertion', async () => {
    const app = unauthenticated({ protectedResource: { authorizationServers: ['https://issuer.example'] } });
    expect((await app.request('/.well-known/oauth-protected-resource')).status).toBe(200);
  });

  it('resolves the issuer per request, because a hosted install has its own', async () => {
    const seen: string[] = [];
    const app = unauthenticated({
      protectedResource: {
        authorizationServers: (c: { req: { url: string } }) => {
          seen.push(new URL(c.req.url).host);
          return [`https://issuer.example/${new URL(c.req.url).host}`];
        },
      },
    });
    const res = await app.request('https://desk-a.example/.well-known/oauth-protected-resource/api/mcp');
    const doc = (await res.json()) as Record<string, unknown>;
    expect(doc['authorization_servers']).toEqual(['https://issuer.example/desk-a.example']);
    expect(seen).toEqual(['desk-a.example']);
  });

  /**
   * An empty list is a fact about an unconfigured install, not an error. Publishing
   * `authorization_servers: []` would claim the resource has no issuer, which sends a
   * client somewhere different from "nobody has configured this yet".
   */
  it('omits the field rather than publishing an empty issuer list', async () => {
    const app = unauthenticated({ protectedResource: { authorizationServers: [] } });
    const doc = (await (await app.request('/.well-known/oauth-protected-resource/api/mcp')).json()) as Record<string, unknown>;
    expect(doc['authorization_servers']).toBeUndefined();
    expect(doc['resource']).toBeDefined();
  });

  it('points a 401 at the document it actually serves', async () => {
    const app = unauthenticated({ protectedResource: { authorizationServers: ['https://issuer.example'] } });
    const res = await post(app);
    expect(res.status).toBe(401);
    expect(res.headers.get('WWW-Authenticate')).toBe(
      'Bearer resource_metadata="http://localhost/.well-known/oauth-protected-resource/api/mcp"',
    );
  });

  /**
   * A challenge naming a document nobody serves is worse than one naming nothing: the
   * client spends a round trip on a 404 and learns less than the bare scheme told it.
   */
  it('challenges with the bare scheme when no metadata is configured', async () => {
    const res = await post(unauthenticated());
    expect(res.status).toBe(401);
    expect(res.headers.get('WWW-Authenticate')).toBe('Bearer');
  });

  it('keeps the vertical’s own error envelope on the challenged 401', async () => {
    const res = await post(unauthenticated({ protectedResource: { authorizationServers: ['https://i.example'] } }));
    expect(res.headers.get('content-type')).toMatch(/problem\+json/);
  });

  it('serves no well-known document when metadata is not configured', async () => {
    expect((await unauthenticated().request('/.well-known/oauth-protected-resource/api/mcp')).status).toBe(404);
  });
});

/**
 * The production bug (#1182 shipped, then found by probing prod): a 401 that carried no
 * `WWW-Authenticate` and an empty `detail`, while every test here passed.
 *
 * A pushed vertical is a BUNDLE and can hold two copies of `hono/http-exception`. Any
 * branch keyed on `err instanceof HTTPException` then takes the wrong door for a genuine
 * exception. These cases raise a FOREIGN exception — the same shape, a different class —
 * which is what the second copy produces, and is the condition a single-Hono test can
 * never reach on its own.
 */
describe('a 401 raised by a foreign HTTPException still challenges', () => {
  /** Structurally an HTTPException; deliberately not the one this package imported. */
  class ForeignHttpException extends Error {
    constructor(
      readonly status: number,
      readonly res?: Response,
    ) {
      super('unauthorized');
    }
  }

  const app = (prepared?: Response) => {
    const a = new Hono();
    mountOperations(a, operations, async () => {
      throw new ForeignHttpException(401, prepared);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }, { mcp: { protectedResource: { authorizationServers: ['https://issuer.example'] } } } as any);
    return a;
  };

  const post = (a: Hono) =>
    a.request('/api/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    });

  it('answers 401 rather than treating it as a tool error', async () => {
    expect((await post(app())).status).toBe(401);
  });

  it('carries the challenge — the half that was missing in production', async () => {
    const res = await post(app());
    expect(res.headers.get('WWW-Authenticate')).toMatch(/^Bearer resource_metadata="/);
  });

  it('keeps the vertical’s problem envelope, with a real detail', async () => {
    const res = await post(app());
    expect(res.headers.get('content-type')).toMatch(/problem\+json/);
    // The empty `detail` was the tell in production: the document had been rebuilt from
    // a message-less exception instead of taken from the response the route prepared.
    expect(((await res.json()) as { detail?: string }).detail).toBeTruthy();
  });

  // The inverse of the bug above, and just as easy to ship: rebuilding the document
  // unconditionally would throw away a response the route had already prepared. A
  // vertical that answers 401 with its own challenge — its own realm, its own
  // parameters — means the one it wrote, and this mount is not entitled to overwrite it.
  it('hands back a prepared response untouched, challenge and all', async () => {
    const res = await post(
      app(
        new Response(JSON.stringify({ title: 'Unauthorized', detail: 'token expired' }), {
          status: 401,
          headers: {
            'content-type': 'application/problem+json',
            'WWW-Authenticate': 'Bearer realm="theirs", error="invalid_token"',
          },
        }),
      ),
    );
    expect(res.status).toBe(401);
    expect(res.headers.get('WWW-Authenticate')).toBe('Bearer realm="theirs", error="invalid_token"');
    expect(((await res.json()) as { detail?: string }).detail).toBe('token expired');
  });

  it('adds the challenge to a prepared response that named none, keeping its body', async () => {
    const res = await post(
      app(
        new Response(JSON.stringify({ title: 'Unauthorized', detail: 'sign in first' }), {
          status: 401,
          headers: { 'content-type': 'application/problem+json' },
        }),
      ),
    );
    expect(res.status).toBe(401);
    expect(res.headers.get('WWW-Authenticate')).toMatch(/^Bearer resource_metadata="/);
    expect(((await res.json()) as { detail?: string }).detail).toBe('sign in first');
  });
});
