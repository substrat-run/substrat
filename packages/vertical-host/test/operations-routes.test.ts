/**
 * Does the derived route table behave like the hand-written one?
 *
 * Driven through a real Hono app with `app.request`, because a table nothing
 * drives proves nothing — the fleet's hand-written routes have exactly that
 * problem today.
 */
import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { z } from '@substrat-run/contracts';
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
