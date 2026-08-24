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
import { z, LIST_PAGE_DEFAULT, LIST_PAGE_MAX, substratError, toProblem } from '@substrat-run/contracts';
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

/**
 * A paged read, and a stub that answers with a real `Page` (#829).
 *
 * Separate harness because the shared one echoes `{ ok: true }` — the projection
 * only fires on something page-shaped, which is itself part of the contract.
 */
function pagedHarness(result: unknown, ops?: Record<string, object>) {
  const app = new Hono();
  mountOperations(
    app,
    ops ?? {
      'todo/list-items': {
        input: z.object({ listId: z.string(), limit: z.number().optional(), cursor: z.string().optional() }),
        paged: { sortKey: 'id', total: true },
        http: { method: 'GET', path: '/lists/{listId}/items' },
      },
    },
    async () =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ({ invoke: async () => result }) as any,
  );
  return app;
}

describe('a paged read on the wire (#829)', () => {
  const page = { entries: [{ id: 'a' }, { id: 'b' }], nextCursor: 'b', total: 42 };

  it('answers with the entries, not an envelope — so adopting paging breaks no client', async () => {
    const res = await pagedHarness(page).request('/api/lists/L1/items?limit=2');
    await expect(res.json()).resolves.toEqual([{ id: 'a' }, { id: 'b' }]);
  });

  it('carries the next page as an RFC 8288 Link the client can follow verbatim', async () => {
    const res = await pagedHarness(page).request('http://api.test/api/lists/L1/items?limit=2');
    const link = res.headers.get('Link');
    expect(link).toBe('<http://api.test/api/lists/L1/items?limit=2&cursor=b>; rel="next"');
  });

  it("keeps the request's own filters in the next link, so a walk stays filtered", async () => {
    const ops = {
      'todo/list-items': {
        input: z.object({ listId: z.string(), q: z.string().optional() }),
        paged: { sortKey: 'id' },
        http: { method: 'GET', path: '/lists/{listId}/items' },
      },
    };
    const res = await pagedHarness(page, ops).request('http://api.test/api/lists/L1/items?q=milk');
    expect(res.headers.get('Link')).toContain('q=milk');
    expect(res.headers.get('Link')).toContain('cursor=b');
  });

  it('replaces the cursor rather than appending a second one', async () => {
    const res = await pagedHarness(page).request('http://api.test/api/lists/L1/items?cursor=OLD');
    const link = res.headers.get('Link') ?? '';
    expect(link).toContain('cursor=b');
    expect(link).not.toContain('OLD');
  });

  it('omits the Link when the walk is over, so a client stops', async () => {
    const res = await pagedHarness({ entries: [{ id: 'a' }], nextCursor: null }).request(
      '/api/lists/L1/items',
    );
    expect(res.headers.get('Link')).toBeNull();
    await expect(res.json()).resolves.toEqual([{ id: 'a' }]);
  });

  it('carries the opt-in total as a count', async () => {
    const res = await pagedHarness(page).request('/api/lists/L1/items');
    expect(res.headers.get('X-Total-Count')).toBe('42');
  });

  it('omits the total when the operation did not ask for one', async () => {
    const res = await pagedHarness({ entries: [], nextCursor: null }).request('/api/lists/L1/items');
    expect(res.headers.get('X-Total-Count')).toBeNull();
  });

  /**
   * A declaration whose handler has not adopted `pageOf` yet must reach the client
   * unchanged — projecting blindly would answer a body of `undefined`.
   */
  it('leaves a result that is not page-shaped alone', async () => {
    const res = await pagedHarness({ ok: true }).request('/api/lists/L1/items');
    await expect(res.json()).resolves.toEqual({ ok: true });
    expect(res.headers.get('Link')).toBeNull();
  });

  it('does not touch an operation that declares no paging', async () => {
    const ops = {
      'todo/my-lists': { http: { method: 'GET', path: '/lists' } },
    };
    const res = await pagedHarness(page, ops).request('/api/lists');
    await expect(res.json()).resolves.toEqual(page);
  });

  /** Two mounts cannot both decide the body; the vertical's own statement wins. */
  it('yields the whole Page to a vertical that supplies `respond`', async () => {
    const app = new Hono();
    let seen: unknown;
    mountOperations(
      app,
      {
        'todo/list-items': {
          input: z.object({ listId: z.string() }),
          paged: { sortKey: 'id' },
          http: { method: 'GET', path: '/lists/{listId}/items' },
        },
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      async () => ({ invoke: async () => page }) as any,
      {
        respond: (c, result) => {
          seen = result;
          return c.json({ ok: true, result });
        },
      },
    );
    const res = await app.request('/api/lists/L1/items');
    expect(seen).toEqual(page);
    expect(res.headers.get('Link')).toBeNull();
  });
});

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

  /**
   * The platform supplies the page, rather than each handler defaulting its own
   * (#811). This test asserted the opposite until then — "the handler applies its
   * own default" — which is precisely how a list read came to be unbounded: the
   * default and the `LIST_PAGE_MAX` ceiling were true of the operations whose
   * author remembered them, and of no others.
   *
   * `cursor` and `order` stay absent rather than becoming explicit `undefined`
   * keys: those have no platform default to supply, and an explicit undefined
   * would defeat a `??` on the other side.
   */
  it('supplies the default page when the caller sends none', async () => {
    const { app, calls } = harness(pagedOps);
    await app.request('/api/lists/L1/items');
    expect(calls[0]?.input).toEqual({ listId: 'L1', limit: LIST_PAGE_DEFAULT });
  });

  /**
   * REFUSED, not silently capped. A caller asking for 100 000 rows and quietly
   * receiving 200 has no way to tell a capped page from the end of the walk, so
   * it would read the first page and conclude it had everything. The refusal is
   * `listPageQuery`'s `.max(LIST_PAGE_MAX)`, and it never reaches the handler.
   *
   * (`listLimitOf`, which the in-process path uses, CLAMPS instead — a test or a
   * seed has no 400 to receive. The two differ deliberately, and this is the pair
   * of tests that says so.)
   */
  it('refuses a limit above the ceiling rather than silently capping it', async () => {
    const { app, calls } = harness(pagedOps);
    const res = await app.request('/api/lists/L1/items?limit=100000');
    expect(res.status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  /**
   * The declared sort reaches the handler under its own name, so a kernel-composed
   * read can hand it straight to `ctx.page` — and an undeclared one is refused
   * THERE, naming the columns that do exist, rather than being silently ignored
   * here. A silently-ignored sort is a caller believing their list is ordered.
   */
  it('passes a declared sort through as `sort`', async () => {
    const { app, calls } = harness(pagedOps);
    await app.request('/api/lists/L1/items?sort=created_at');
    expect((calls[0]?.input as { sort: string }).sort).toBe('created_at');
  });
});

/**
 * A guarded operation, and a stub that records what preconditions it was handed
 * and answers with whatever version the case wants (#129).
 *
 * Separate harness because the shared one takes two arguments and drops the
 * third — which is the very thing under test here.
 */
function guardedHarness(version: string | null, ops?: Record<string, object>) {
  const seen: { ifMatch?: string; sink: boolean }[] = [];
  const app = new Hono();
  mountOperations(
    app,
    ops ?? {
      'acme/read-thing': {
        input: z.object({ thingId: z.string() }),
        concurrency: { over: 'thing', idFrom: 'thingId' },
        http: { method: 'GET', path: '/things/{thingId}' },
      },
      'acme/update-thing': {
        input: z.object({ thingId: z.string(), name: z.string().optional() }),
        concurrency: { over: 'thing', idFrom: 'thingId' },
        http: { method: 'PATCH', path: '/things/{thingId}' },
      },
      'acme/unguarded': {
        input: z.object({ thingId: z.string() }),
        http: { method: 'PATCH', path: '/other/{thingId}' },
      },
    },
    async () =>
      ({
        invoke: async (
          _name: string,
          _input: unknown,
          options?: { ifMatch?: string; onEntityVersion?: (v: string | null) => void },
        ) => {
          seen.push({
            ...(options?.ifMatch === undefined ? {} : { ifMatch: options.ifMatch }),
            sink: typeof options?.onEntityVersion === 'function',
          });
          options?.onEntityVersion?.(version);
          return { ok: true };
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      }) as any,
  );
  return { app, seen };
}

describe('a concurrency-checked operation on the wire (#129)', () => {
  it('answers a guarded read with an ETag, quoted', async () => {
    const { app } = guardedHarness('01J8Z000000000000000000000');
    const res = await app.request('/api/things/t1');
    // Quoted per RFC 9110 §8.8.3 — a bare token is malformed, and the kind of
    // thing that works against a dev server and is stripped by a proxy.
    expect(res.headers.get('ETag')).toBe('"01J8Z000000000000000000000"');
  });

  it('sets no ETag when the entity has no version yet', async () => {
    const { app } = guardedHarness(null);
    const res = await app.request('/api/things/t1');
    // Not `ETag: ""`. An empty validator is one a client could echo back at a
    // write that must refuse it.
    expect(res.headers.get('ETag')).toBeNull();
  });

  it('sets no ETag on an operation that declares no concurrency', async () => {
    const { app, seen } = guardedHarness('01J8Z000000000000000000000');
    const res = await app.request('/api/other/t1', { method: 'PATCH', body: '{}' });
    expect(res.headers.get('ETag')).toBeNull();
    // And no sink was passed at all — an operation that opted out must not make
    // the host read a version on every invocation.
    expect(seen.at(-1)?.sink).toBe(false);
  });

  it('forwards If-Match on an unsafe method', async () => {
    const { app, seen } = guardedHarness('01J8Z000000000000000000001');
    await app.request('/api/things/t1', {
      method: 'PATCH',
      headers: { 'If-Match': '"01J8Z000000000000000000000"' },
      body: '{}',
    });
    expect(seen.at(-1)?.ifMatch).toBe('"01J8Z000000000000000000000"');
  });

  it('does NOT forward If-Match on a GET', async () => {
    const { app, seen } = guardedHarness('01J8Z000000000000000000000');
    await app.request('/api/things/t1', { headers: { 'If-Match': '"whatever"' } });
    // On a GET the header means a conditional READ in HTTP. Forwarding it would
    // have the host refuse a read for being stale — a 412 where the caller asked
    // for a body.
    expect(seen.at(-1)?.ifMatch).toBeUndefined();
  });

  it('answers a stale write with 412', async () => {
    const app = new Hono();
    mountOperations(
      app,
      {
        'acme/update-thing': {
          input: z.object({ thingId: z.string() }),
          concurrency: { over: 'thing', idFrom: 'thingId' },
          http: { method: 'PATCH', path: '/things/{thingId}' },
        },
      },
      async () =>
        ({
          invoke: async () => {
            throw substratError('precondition_failed', 'thing t1 changed since you read it', {
              entity: { entityType: 'thing', entityId: 't1' },
            });
          },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        }) as any,
    );
    // The vertical owns the BODY and the mount owns the STATUS — the same split
    // every other mapped failure goes through, which is why landing this needed no
    // new branch here. `classifyError` reads the code off the taxonomy, where the
    // 412 slot was reserved for exactly this.
    app.onError((err, c) =>
      err instanceof HTTPException ? c.json({ error: err.message }, err.status) : c.json({}, 500),
    );
    const res = await app.request('/api/things/t1', { method: 'PATCH', body: '{}' });
    expect(res.status).toBe(412);
    expect(await res.json()).toEqual({ error: 'thing t1 changed since you read it' });
  });

  it('carries the refused entity, and no version, in the problem body', async () => {
    const problem = toProblem(
      substratError('precondition_failed', 'thing t1 changed since you read it', {
        entity: { entityType: 'thing', entityId: 't1' },
      }),
    );
    expect(problem.status).toBe(412);
    expect(problem.code).toBe('precondition_failed');
    expect(problem.entity).toEqual({ entityType: 'thing', entityId: 't1' });
    // The current tag is deliberately absent: handing it back turns the obvious
    // client fix into a blind retry that overwrites whatever caused the refusal.
    expect(JSON.stringify(problem)).not.toMatch(/version|etag/i);
  });
});
