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
function harness() {
  const calls: { name: string; input: unknown }[] = [];
  const app = new Hono();
  const mounted = mountOperations(app, operations, async () => {
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
      'POST /api/lists',
      'DELETE /api/lists/:listId',
      'GET /api/lists/:listId/items',
      'GET /api/lists',
      'POST /api/workorders/:entityId/notes',
      'PATCH /api/lists/:listId',
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
