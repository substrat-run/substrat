/**
 * How the emitted document describes a CALL (#830).
 *
 * The builder used to emit `requestBody` for every operation that declared an
 * input, whatever the verb. On a `GET` that describes a call nobody can make —
 * `mountOperations` never reads a body there — and it left the fields that DO
 * work undocumented: a paged read showed `limit`/`cursor` twice (once as
 * parameters, once inside the body) while `q`, `status` and the rest appeared
 * only as body properties. A client generated from that document could not
 * discover the filters, and the one calling convention that works never appeared.
 *
 * These hold the document to the router's own rule — `takesBody = POST | PUT |
 * PATCH` — because a document derived from the same model as the router and
 * disagreeing with it is worse than no document.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { buildOpenApiDocument } from '../src/openapi.js';

const doc = buildOpenApiDocument({ title: 'Test', version: '1.0.0' }, {
  // The shape #830 was filed from: a paged list whose filters are input fields.
  'customer/list': {
    summary: 'List customers',
    input: z.object({
      limit: z.number().int().optional(),
      cursor: z.string().optional(),
      q: z.string().optional(),
      status: z.enum(['active', 'archived']).optional(),
    }),
    output: z.object({ id: z.string() }),
    paged: { sortKey: 'id' },
    http: { method: 'GET', path: '/customers' },
  },
  // A search route (#827): no path parameters, not paged — so before this fix
  // NOTHING at all appeared in `parameters`.
  'customer/search': {
    summary: 'Find customers',
    input: z.object({ q: z.string().min(2), limit: z.number().int().optional() }),
    output: z.object({ id: z.string() }),
    http: { method: 'GET', path: '/customers/search' },
  },
  'customer/get': {
    summary: 'One customer',
    input: z.object({ customerId: z.string() }),
    output: z.object({ id: z.string() }),
    http: { method: 'GET', path: '/customers/{customerId}' },
  },
  'customer/archive': {
    summary: 'Archive',
    input: z.object({ customerId: z.string(), reason: z.string().optional() }),
    http: { method: 'DELETE', path: '/customers/{customerId}' },
  },
  'customer/create': {
    summary: 'Register a customer',
    input: z.object({ name: z.string() }),
    http: { method: 'POST', path: '/customers' },
  },
  // A literal the ROUTE supplies (`mountOperations` pins it and overrides the caller).
  'customer/pinned': {
    summary: 'Pinned',
    input: z.object({ entityType: z.literal('customer'), entityId: z.string() }),
    http: { method: 'GET', path: '/pinned' },
  },
  // No `http`: the platform's own invoke convention, which IS a POST with a body.
  'customer/invoke-only': {
    summary: 'Invoke convention',
    input: z.object({ anything: z.string() }),
  },
} as never) as Record<string, any>;

const op = (url: string, verb: string) => doc.paths[url][verb];
const paramNames = (url: string, verb: string): string[] =>
  ((op(url, verb).parameters ?? []) as { name: string }[]).map((p) => p.name);
const param = (url: string, verb: string, name: string) =>
  ((op(url, verb).parameters ?? []) as Record<string, any>[]).find((p) => p['name'] === name);

describe('a read documents its query string', () => {
  it('emits every declared input field as a query parameter', () => {
    expect(paramNames('/api/customers', 'get')).toEqual(
      expect.arrayContaining(['q', 'status', 'limit', 'cursor', 'order']),
    );
  });

  it('carries no requestBody — the mount never reads one on a GET', () => {
    expect(op('/api/customers', 'get').requestBody).toBeUndefined();
    expect(op('/api/customers/search', 'get').requestBody).toBeUndefined();
  });

  /** The wart #823 acknowledged: `limit`/`cursor` are declared AND added here. */
  it('names each parameter exactly once', () => {
    const names = paramNames('/api/customers', 'get');
    expect(new Set(names).size).toBe(names.length);
  });

  it('keeps the paged trio the platform writes, not the operation restatement', () => {
    // The platform's own `limit` carries the documented bounds; the operation's
    // bare `z.number()` would have overwritten them with nothing.
    expect(param('/api/customers', 'get', 'limit')?.['schema']).toMatchObject({ maximum: 200 });
    expect(param('/api/customers', 'get', 'cursor')?.['description']).toContain('nextCursor');
  });

  it('carries each field schema, so a client can generate a typed call', () => {
    expect(param('/api/customers', 'get', 'status')?.['schema']).toMatchObject({
      enum: ['active', 'archived'],
    });
  });

  it('marks a required field required, and an optional one not', () => {
    expect(param('/api/customers/search', 'get', 'q')?.['required']).toBe(true);
    expect(param('/api/customers/search', 'get', 'limit')?.['required']).toBe(false);
  });

  it('documents a search route at all — it has no path params and is not paged', () => {
    expect(paramNames('/api/customers/search', 'get')).toEqual(['q', 'limit']);
  });

  it('does not restate a path parameter as a query parameter', () => {
    const names = paramNames('/api/customers/{customerId}', 'get');
    expect(names.filter((n) => n === 'customerId')).toHaveLength(1);
    expect(param('/api/customers/{customerId}', 'get', 'customerId')?.['in']).toBe('path');
  });

  it('treats DELETE as a read-shaped call, the way the mount does', () => {
    expect(op('/api/customers/{customerId}', 'delete').requestBody).toBeUndefined();
    expect(param('/api/customers/{customerId}', 'delete', 'reason')?.['in']).toBe('query');
  });

  /**
   * A single-valued literal is the model's statement, not the caller's choice —
   * the route pins it and overrides whatever arrived, so documenting it as a
   * parameter invites a client to send a value that cannot matter.
   */
  it('omits a field the route pins', () => {
    expect(paramNames('/api/pinned', 'get')).toEqual(['entityId']);
  });
});

describe('a write is untouched', () => {
  it('still documents its body, and adds no query parameters', () => {
    const post = op('/api/customers', 'post');
    expect(Object.keys(post.requestBody.content['application/json'].schema.properties)).toEqual([
      'name',
    ]);
    expect(post.parameters).toBeUndefined();
  });

  it('keeps the invoke convention a POST with a body', () => {
    const invoke = op('/api/op/customer/invoke-only', 'post');
    expect(invoke.requestBody).toBeDefined();
  });
});

describe('determinism', () => {
  it('stays byte-identical across builds, so api-diff can gate it', () => {
    const again = buildOpenApiDocument({ title: 'Test', version: '1.0.0' }, {
      'customer/list': {
        summary: 'List customers',
        input: z.object({
          limit: z.number().int().optional(),
          cursor: z.string().optional(),
          q: z.string().optional(),
          status: z.enum(['active', 'archived']).optional(),
        }),
        output: z.object({ id: z.string() }),
        paged: { sortKey: 'id' },
        http: { method: 'GET', path: '/customers' },
      },
    } as never);
    expect(JSON.stringify(again)).toBe(
      JSON.stringify(
        buildOpenApiDocument({ title: 'Test', version: '1.0.0' }, {
          'customer/list': {
            summary: 'List customers',
            input: z.object({
              limit: z.number().int().optional(),
              cursor: z.string().optional(),
              q: z.string().optional(),
              status: z.enum(['active', 'archived']).optional(),
            }),
            output: z.object({ id: z.string() }),
            paged: { sortKey: 'id' },
            http: { method: 'GET', path: '/customers' },
          },
        } as never),
      ),
    );
  });
});
