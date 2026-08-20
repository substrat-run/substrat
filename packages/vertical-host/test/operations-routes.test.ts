/**
 * Does the derived route table behave like the hand-written one?
 *
 * Driven through a real Hono app with `app.request`, because a table nothing
 * drives proves nothing — the fleet's hand-written routes have exactly that
 * problem today.
 */
import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from '@substrat-run/contracts';
import { PermissionDenied } from '@substrat-run/kernel';
import { mountOperations } from '../src/operations-routes.js';

const operations = {
  'todo/create-list': {
    input: {},
    http: { method: 'POST', path: '/lists' },
  },
  'todo/my-lists': {
    http: { method: 'GET', path: '/lists' },
  },
  'todo/rename-list': {
    input: {},
    http: { method: 'PATCH', path: '/lists/{listId}' },
  },
  // A full-replacement update: PUT carries a body exactly as POST/PATCH do
  // (#777 — 25 live routes in a production vertical are declared this way).
  'todo/replace-list': {
    input: {},
    http: { method: 'PUT', path: '/lists/{listId}' },
  },
  'todo/delete-list': {
    input: {},
    http: { method: 'DELETE', path: '/lists/{listId}' },
  },
  'todo/list-items': {
    input: {},
    http: { method: 'GET', path: '/lists/{listId}/items' },
  },
  'todo/no-http': { input: {} },
  // The shape that used to need a hand-written route: an input field the model
  // pins to one value, supplied by the endpoint rather than the caller.
  'todo/pinned': {
    input: z.object({ entityType: z.literal('workorder'), entityId: z.string(), note: z.string() }),
    http: { method: 'POST', path: '/workorders/{entityId}/notes' },
  },
} as const;

/** Records what the stub was asked to invoke, and echoes it back. */
function harness(ops: Readonly<Record<string, object>> = operations) {
  const calls: { name: string; input: unknown }[] = [];
  const app = new Hono();
  const mounted = mountOperations(app, ops, async () => {
    return {
      invoke: async (name: string, input: unknown) => {
        calls.push({ name, input });
        return { ok: true };
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
  });
  return { app, calls, mounted };
}

describe('mountOperations', () => {
  it('mounts one route per operation that declares http, and no others', () => {
    const { mounted } = harness();
    expect(mounted.map((m) => `${m.method} ${m.path}`)).toEqual([
      'GET /api/lists',
      'POST /api/lists',
      'DELETE /api/lists/:listId',
      'PATCH /api/lists/:listId',
      'PUT /api/lists/:listId',
      'GET /api/lists/:listId/items',
      'POST /api/workorders/:entityId/notes',
    ]);
  });

  it('routes to the operation the declaration names', async () => {
    const { app, calls } = harness();
    await app.request('/api/lists', { method: 'POST', body: JSON.stringify({ name: 'Groceries' }) });
    expect(calls[0]?.name).toBe('todo/create-list');
    expect(calls[0]?.input).toEqual({ name: 'Groceries' });
  });

  it('merges path parameters into the input', async () => {
    const { app, calls } = harness();
    await app.request('/api/lists/L1', { method: 'PATCH', body: JSON.stringify({ name: 'Renamed' }) });
    expect(calls[0]?.input).toEqual({ listId: 'L1', name: 'Renamed' });
  });

  it('merges body and path parameters on a PUT', async () => {
    const { app, calls } = harness();
    await app.request('/api/lists/L1', { method: 'PUT', body: JSON.stringify({ name: 'Replaced' }) });
    expect(calls[0]).toEqual({ name: 'todo/replace-list', input: { listId: 'L1', name: 'Replaced' } });
  });

  it('carries path parameters on reads too', async () => {
    const { app, calls } = harness();
    await app.request('/api/lists/L1/items');
    expect(calls[0]).toEqual({ name: 'todo/list-items', input: { listId: 'L1' } });
  });

  it('invokes with NO argument when the operation declares no input and takes no path var', async () => {
    const { app, calls } = harness();
    await app.request('/api/lists');
    // Not `{}` — a handler typed for `undefined` does not accept an empty object.
    expect(calls[0]).toEqual({ name: 'todo/my-lists', input: undefined });
  });

  it('an operation with no http declaration is not reachable', async () => {
    const { app } = harness();
    expect((await app.request('/api/no-http')).status).toBe(404);
  });

  it('tolerates an empty body on a POST', async () => {
    const { app, calls } = harness();
    await app.request('/api/lists', { method: 'POST' });
    expect(calls[0]?.input).toEqual({});
  });
});

describe('fields the model pins to one value', () => {
  it('supplies them without the caller sending them', async () => {
    const { app, calls } = harness();
    await app.request('/api/workorders/W1/notes', {
      method: 'POST',
      body: JSON.stringify({ note: 'looked at it' }),
    });
    expect(calls[0]?.input).toEqual({
      entityType: 'workorder',
      entityId: 'W1',
      note: 'looked at it',
    });
  });

  it('a caller cannot talk the route out of one', async () => {
    // A literal in the model is the model's statement, not a default — this is
    // the difference between deriving the route and merely defaulting it.
    const { app, calls } = harness();
    await app.request('/api/workorders/W1/notes', {
      method: 'POST',
      body: JSON.stringify({ entityType: 'invoice', note: 'nice try' }),
    });
    expect((calls[0]?.input as { entityType: string }).entityType).toBe('workorder');
  });
});

/**
 * Hono dispatches in registration order, so a parameter route registered first
 * swallows its static sibling. Alphabetical OPERATION order decided that by a
 * name unrelated to routing (#785): both pairs below sort param-first.
 */
describe('a static segment and its parameter sibling', () => {
  const overlapping = {
    'user/get': { input: {}, http: { method: 'GET', path: '/users/{id}' } },
    'user/invites': { http: { method: 'GET', path: '/users/invites' } },
    'support/get': { input: {}, http: { method: 'GET', path: '/support/issues/{id}' } },
    'support/list-mine': { http: { method: 'GET', path: '/support/issues/mine' } },
  } as const;

  it('registers the static path first', () => {
    const { mounted } = harness(overlapping);
    expect(mounted.map((m) => m.path)).toEqual([
      '/api/support/issues/mine',
      '/api/support/issues/:id',
      '/api/users/invites',
      '/api/users/:id',
    ]);
  });

  it('dispatches the static URL to the static operation', async () => {
    const { app, calls } = harness(overlapping);
    await app.request('/api/users/invites');
    await app.request('/api/support/issues/mine');
    expect(calls.map((c) => c.name)).toEqual(['user/invites', 'support/list-mine']);
  });

  it('still dispatches every other URL to the parameter operation', async () => {
    const { app, calls } = harness(overlapping);
    await app.request('/api/users/U1');
    expect(calls[0]).toEqual({ name: 'user/get', input: { id: 'U1' } });
  });
});

/**
 * Ordering resolves a static path against its parameter sibling. Two paths that
 * dispatch IDENTICALLY have no such reading — one of them is simply dead, which
 * is the silence #785 is about. That one fails at mount instead.
 */
describe('two declarations that dispatch identically', () => {
  it('refuses to mount, naming both operations', () => {
    expect(() =>
      harness({
        'user/by-id': { input: {}, http: { method: 'GET', path: '/users/{id}' } },
        'user/by-slug': { input: {}, http: { method: 'GET', path: '/users/{slug}' } },
      }),
    ).toThrow(/'user\/by-id' and 'user\/by-slug' both declare GET \/users\/\{\}/);
  });

  it('does not object to the same path under different methods', () => {
    const { mounted } = harness({
      'list/read': { http: { method: 'GET', path: '/lists' } },
      'list/create': { input: {}, http: { method: 'POST', path: '/lists' } },
    });
    expect(mounted).toHaveLength(2);
  });

  it('does not object to a static path beside its parameter sibling', () => {
    const { mounted } = harness({
      'user/get': { input: {}, http: { method: 'GET', path: '/users/{id}' } },
      'user/invites': { http: { method: 'GET', path: '/users/invites' } },
    });
    expect(mounted).toHaveLength(2);
  });
});

/**
 * A URL carries no types. The mount reads the DECLARED shape rather than
 * guessing from the text, so a search term that looks like a number stays a
 * string (#785).
 */
describe('query values against the declared input', () => {
  const reads = {
    'todo/search': {
      input: z.object({
        limit: z.number().int().optional(),
        q: z.string().optional(),
        archived: z.boolean().optional(),
        cursor: z.string().default(''),
      }),
      http: { method: 'GET', path: '/search' },
    },
    'todo/page': {
      input: z.object({ page: z.number() }),
      http: { method: 'GET', path: '/pages/{page}' },
    },
  } as const;

  it('types a declared number field', async () => {
    const { app, calls } = harness(reads);
    await app.request('/api/search?limit=100');
    expect(calls[0]?.input).toEqual({ limit: 100 });
  });

  it('leaves a declared string field alone even when it reads as a number', async () => {
    const { app, calls } = harness(reads);
    await app.request('/api/search?q=123');
    expect(calls[0]?.input).toEqual({ q: '123' });
  });

  it('types a declared boolean field', async () => {
    const { app, calls } = harness(reads);
    await app.request('/api/search?archived=true&q=hej');
    expect(calls[0]?.input).toEqual({ archived: true, q: 'hej' });
  });

  it('looks through optional and default wrappers', async () => {
    const { app, calls } = harness(reads);
    await app.request('/api/search?cursor=abc&limit=5');
    expect(calls[0]?.input).toEqual({ cursor: 'abc', limit: 5 });
  });

  it('passes a value the declared type cannot accept through unchanged', async () => {
    // So the error the caller reads names what they actually sent, rather than
    // "received nan" — the coercion is a convenience, not a second validator.
    const { app, calls } = harness(reads);
    await app.request('/api/search?limit=lots');
    expect(calls[0]?.input).toEqual({ limit: 'lots' });
  });

  it('types a path parameter the same way', async () => {
    const { app, calls } = harness(reads);
    await app.request('/api/pages/3');
    expect(calls[0]?.input).toEqual({ page: 3 });
  });

  it('leaves an undeclared query parameter as the string it arrived as', async () => {
    const { app, calls } = harness(reads);
    await app.request('/api/search?unknown=7');
    expect(calls[0]?.input).toEqual({ unknown: '7' });
  });
});

/**
 * What a failure answers (#791).
 *
 * Driven through `app.request` with a stub that throws, because the defect was
 * never visible in the mount's own return value: every one of these came back
 * `500 Internal Server Error`, and a client reading `ok` off the reply could not
 * tell a refusal from a crash.
 */
describe('a failing operation', () => {
  /** A stub whose invoke throws, on an app that maps nothing itself. */
  function failing(err: unknown, options?: Parameters<typeof mountOperations>[3]) {
    const app = new Hono();
    mountOperations(
      app,
      operations,
      async () =>
        ({
          invoke: async () => {
            throw err;
          },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        }) as any,
      options,
    );
    return app;
  }

  it('answers a refused permission with 403, not 500', async () => {
    const res = await failing(new PermissionDenied('permission denied: todo.list.read')).request(
      '/api/lists/L1/items',
    );
    expect(res.status).toBe(403);
  });

  it('recognises a denial that crossed a boundary and lost its class', async () => {
    // A `ScopeStub` call may be a Durable Object RPC: the error arrives re-created
    // from its wire form, so `instanceof` is false and only the name survives.
    const wire = Object.assign(new Error('permission denied: todo.list.read'), {
      name: 'PermissionDenied',
    });
    expect((await failing(wire).request('/api/lists/L1/items')).status).toBe(403);
  });

  it('answers an input that failed to parse with 400', async () => {
    const parsed = z.object({ name: z.string() }).safeParse({ name: 7 });
    expect(parsed.success).toBe(false);
    const res = await failing(parsed.success ? new Error('unreachable') : parsed.error).request(
      '/api/lists',
      { method: 'POST', body: '{}' },
    );
    expect(res.status).toBe(400);
  });

  it('answers a body that is not JSON with 400', async () => {
    const app = failing(new Error('never reached'));
    const res = await app.request('/api/lists', { method: 'POST', body: 'not json' });
    expect(res.status).toBe(400);
  });

  it('keeps the status an HTTPException already decided — resolveStub refusing an anonymous call', async () => {
    const app = new Hono();
    mountOperations(app, operations, async () => {
      throw new HTTPException(401, { message: 'no session' });
    });
    expect((await app.request('/api/lists/L1/items')).status).toBe(401);
  });

  it('answers a runtime fault with 502 — the platform failed, not the caller', async () => {
    const res = await failing(new Error('internal error; reference = 9f3c')).request('/api/lists/L1/items');
    expect(res.status).toBe(502);
  });

  it('re-throws an error it has no opinion about, so the app still maps its own', async () => {
    const app = failing(new Error('this list is not yours to keep'));
    app.onError((err, c) => c.json({ ours: true, error: (err as Error).message }, 418));
    const res = await app.request('/api/lists/L1/items');
    expect(res.status).toBe(418);
    expect(await res.json()).toEqual({ ours: true, error: 'this list is not yours to keep' });
  });

  it('leaves the BODY to an app that owns an envelope', async () => {
    // The mount decides the status; a re-thrown HTTPException still reaches
    // `app.onError`, which is where a vertical's envelope lives.
    const app = failing(new PermissionDenied('permission denied: todo.list.read'));
    app.onError((err, c) =>
      c.json({ ok: false, error: (err as Error).message }, err instanceof HTTPException ? err.status : 500),
    );
    const res = await app.request('/api/lists/L1/items');
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ ok: false, error: 'permission denied: todo.list.read' });
  });

  it('hands the error to `onError` when the vertical supplies one', async () => {
    const seen: unknown[] = [];
    const app = failing(new PermissionDenied('nope'), {
      onError: (c, err, operation) => {
        seen.push(operation);
        return c.json({ ok: false, error: (err as Error).message }, 403);
      },
    });
    const res = await app.request('/api/lists/L1/items');
    expect(await res.json()).toEqual({ ok: false, error: 'nope' });
    expect(seen).toEqual(['todo/list-items']);
  });

  it('falls through to the default when `onError` returns undefined', async () => {
    const app = failing(new PermissionDenied('nope'), { onError: () => undefined });
    expect((await app.request('/api/lists/L1/items')).status).toBe(403);
  });
});

describe('the success shape', () => {
  it('is the raw result unless the vertical says otherwise', async () => {
    const { app } = harness();
    expect(await (await app.request('/api/lists/L1/items')).json()).toEqual({ ok: true });
  });

  it('is the vertical envelope when `respond` is given, for every route', async () => {
    const app = new Hono();
    const seen: string[] = [];
    mountOperations(
      app,
      operations,
      async () =>
        ({
          invoke: async () => ({ items: [], effect: 'not the caller’s to read' }),
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        }) as any,
      {
        respond: (c, result, operation) => {
          seen.push(operation);
          const { effect: _dropped, ...rest } = result as Record<string, unknown>;
          return c.json({ ok: true, result: rest });
        },
      },
    );
    const res = await app.request('/api/lists/L1/items');
    expect(await res.json()).toEqual({ ok: true, result: { items: [] } });
    expect(seen).toEqual(['todo/list-items']);
  });
});

/**
 * The paged read, driven over HTTP (#811).
 *
 * The scenario suites invoke operations directly, so they never exercise the one step
 * that can silently not work: `?limit=2` arrives as the STRING `'2'`, and a handler
 * declaring `z.number()` would reject it — or worse, a `LIMIT '2'` would reach SQLite.
 * The coercion that prevents that is derived from the declared input, so this drives
 * the query string through a real Hono app and looks at what the handler was handed.
 */
describe('a paged operation over HTTP', () => {
  const pagedOps = {
    'todo/list-items': {
      input: z.object({
        listId: z.string(),
        limit: z.number().int().positive().max(200).optional(),
        cursor: z.string().optional(),
      }),
      paged: { sortKey: 'id' },
      http: { method: 'GET', path: '/lists/{listId}/items' },
    },
  } as const;

  it('coerces limit to a number and passes the cursor through', async () => {
    const { app, calls } = harness(pagedOps);
    await app.request('/api/lists/L1/items?limit=2&cursor=01JABC');

    expect(calls[0]?.name).toBe('todo/list-items');
    expect(calls[0]?.input).toEqual({ listId: 'L1', limit: 2, cursor: '01JABC' });
    // Not the string '2' — the whole point of the coercion, and what a bare
    // `Number.isInteger` check downstream would have caught only in production.
    expect(typeof (calls[0]?.input as { limit: unknown }).limit).toBe('number');
  });

  it('omits the page params entirely when the caller sends none', async () => {
    const { app, calls } = harness(pagedOps);
    await app.request('/api/lists/L1/items');
    // Absent, not `undefined` keys — the handler applies its own default, and an
    // explicit undefined would defeat a `??` on the other side.
    expect(calls[0]?.input).toEqual({ listId: 'L1' });
  });
});
