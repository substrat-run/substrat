/**
 * The one door between an operation and an external caller (#2073, `src/wire.ts`).
 *
 * `rowCursors` is each row's own cursor, an internal channel for a `pageVisible` walk. It must
 * never reach an external caller — a handler that filtered its entries after the read would
 * leave them naming the rows it dropped — and an external caller must never be able to ask for
 * it. This enumerates every transport that carries an operation's input in and its result out,
 * and holds each one to both, with the page at the top of the result and nested inside it.
 * A transport added later belongs in `TRANSPORTS`.
 */
import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { z, PLATFORM_SECRET_HEADER } from '@substrat-run/contracts';
import { mountOperations } from '../src/operations-routes.js';
import { mountPlatformSurface, type VerticalScopeHost } from '../src/index.js';

const TENANT = '01JZ0000000000000000TEN001';
const SCOPE = '01JZ0000000000000000SCP001';
const CALLER_SCOPE = '01JZ0000000000000000SCP002';
const CONN = '01JZ0000000000000000CNN001';
const SECRET = 'sekret';
const ENV = { PLATFORM_SECRET: SECRET };

/** A page whose handler dropped a row from `entries` but not from `rowCursors`. */
const leaky = () => ({ entries: [{ id: 'a' }], nextCursor: 'a', rowCursors: ['a', 'HIDDEN'] });
/** A page that is a class instance, not a plain object. */
class PageInstance {
  entries = [{ id: 'a' }];
  nextCursor = 'a';
  rowCursors = ['a', 'HIDDEN'];
}
/** A class envelope with a page in a field. */
class Envelope {
  constructor(readonly page: unknown) {}
}
const SHAPES: Record<string, () => unknown> = {
  'a page': () => leaky(),
  'a page nested in the result': () => ({ summary: { lists: leaky() }, pages: [leaky()] }),
  'a page nested in an entry': () => ({ entries: [{ id: 'a', children: leaky() }], nextCursor: null }),
  // Codex r4 on #2078: shapes an object-graph walk got wrong — what reaches the wire is the oracle.
  'one page referenced twice': () => {
    const page = leaky();
    return { first: page, again: page };
  },
  'an array of the same page': () => {
    const page = leaky();
    return [page, page, page];
  },
  'a class envelope holding a page': () => new Envelope(leaky()),
  'a page that is a class instance': () => new PageInstance(),
  'a toJSON that returns a page': () => ({ toJSON: () => ({ nested: leaky() }) }),
};

interface Transport {
  name: string;
  /** Send `input` the way this transport's caller does, answered with `result`; what came back, and what the operation was given. */
  call(input: Record<string, unknown>, result: unknown): Promise<{ text: string; received: unknown }>;
}

const operations = {
  'w/paged': {
    summary: 'A paged read',
    input: z.object({ q: z.string().optional() }),
    paged: { sortKey: 'id' },
    http: { method: 'GET', path: '/paged' },
  },
  'w/whole': {
    summary: 'A read answered whole',
    input: z.object({ q: z.string().optional() }),
    http: { method: 'POST', path: '/whole' },
  },
} as const;

/** The HTTP mount (which also serves MCP), over a stub that records its input. */
function mounted(result: unknown) {
  const got: { input?: unknown } = {};
  const app = new Hono();
  mountOperations(
    app,
    operations,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async () => ({ invoke: async (_: string, input: unknown) => ((got.input = input), result) }) as any,
  );
  return { app, got };
}

/** The platform surface (peer and connector doors), over a host that records its input. */
function surface(result: unknown) {
  const got: { input?: unknown } = {};
  const host = {
    verticalInvokeLocal: async (...args: unknown[]) => ((got.input = args[4]), result),
    connectorInvokeLocal: async (...args: unknown[]) => ((got.input = args[4]), result),
  } as unknown as VerticalScopeHost;
  const app = new Hono<{ Bindings: typeof ENV }>();
  mountPlatformSurface(app, {
    platformSecret: (env) => env.PLATFORM_SECRET,
    hostFor: () => host,
    roles: [],
    ownerRoleKey: 'admin',
  });
  const post = (path: string, body: unknown) =>
    app.request(
      path,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', [PLATFORM_SECRET_HEADER]: SECRET },
        body: JSON.stringify(body),
      },
      ENV,
    );
  return { post, got };
}

const TRANSPORTS: Transport[] = [
  {
    name: 'HTTP, paged',
    async call(input, result) {
      const { app, got } = mounted(result);
      const res = await app.request(`/api/paged?${new URLSearchParams(input as Record<string, string>)}`);
      return { text: await res.text(), received: got.input };
    },
  },
  {
    name: 'HTTP, answered whole',
    async call(input, result) {
      const { app, got } = mounted(result);
      const res = await app.request('/api/whole', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input),
      });
      return { text: await res.text(), received: got.input };
    },
  },
  {
    name: 'MCP',
    async call(input, result) {
      const { app, got } = mounted(result);
      const res = await app.request('/api/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'w_whole', arguments: input } }),
      });
      return { text: await res.text(), received: got.input };
    },
  },
  {
    name: 'a peer vertical (/internal/vertical-invoke)',
    async call(input, result) {
      const { post, got } = surface(result);
      const res = await post('/internal/vertical-invoke', {
        caller: { vertical: 'peer-caller', scope: CALLER_SCOPE },
        tenantId: TENANT,
        scopeId: SCOPE,
        operation: 'w/whole',
        input,
      });
      return { text: await res.text(), received: got.input };
    },
  },
  {
    name: 'a connector (/internal/connector-invoke)',
    async call(input, result) {
      const { post, got } = surface(result);
      const res = await post('/internal/connector-invoke', {
        connectionId: CONN,
        tenantId: TENANT,
        scopeId: SCOPE,
        operation: 'w/whole',
        input,
      });
      return { text: await res.text(), received: got.input };
    },
  },
];

describe('every external transport goes through the one door (#2073)', () => {
  for (const transport of TRANSPORTS) {
    for (const [shape, result] of Object.entries(SHAPES)) {
      it(`${transport.name}: ${shape} leaves without rowCursors`, async () => {
        const { text } = await transport.call({ q: 'x' }, result());
        expect(text).toContain('"a"'); // the answer did arrive
        expect(text).not.toContain('rowCursors');
        expect(text).not.toContain('HIDDEN');
      });
    }

    it(`${transport.name}: a rowCursors that is not a page's arrives untouched`, async () => {
      const { text } = await transport.call({ q: 'x' }, { id: 'a', rowCursors: ['kept'], data: { rowCursors: { any: 'thing' } } });
      expect(text).toContain('"rowCursors":["kept"]');
      expect(text).toContain('"rowCursors":{"any":"thing"}');
    });

    it(`${transport.name}: a caller cannot ask for rowCursors — the operation never sees the flag`, async () => {
      const { received } = await transport.call({ q: 'x', rowCursors: 'true' }, leaky());
      expect(received).toMatchObject({ q: 'x' });
      expect(received).not.toHaveProperty('rowCursors');
    });
  }
});
