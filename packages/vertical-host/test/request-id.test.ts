/**
 * #2192: the request id handed to the caller. Every response a stamped request gets carries
 * `x-substrat-request-id`; every problem body the platform renders carries the same value as
 * `requestId`; and it is the `invocationId` the invocation log line names and the scope was
 * handed — one id, not a second one minted beside it.
 */
import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { REQUEST_ID_HEADER, problem, toProblem, z } from '@substrat-run/contracts';
import { PermissionDenied } from '@substrat-run/kernel';
import { invocationLog, requestIdOf, withInvocationLog, type InvocationLogLine } from '../src/invocation-log.js';
import { mountOperations } from '../src/operations-routes.js';
import { mountPlatformSurface, problemResponse, type VerticalScopeHost } from '../src/index.js';
import { ENV, routed } from './routed.js';

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

function capture() {
  const lines: InvocationLogLine[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => {
    const [first] = args;
    if (typeof first === 'string' && first.includes('"substrat":"invocation"')) {
      lines.push(JSON.parse(first));
      return;
    }
    original(...(args as []));
  };
  return { lines, restore: () => void (console.log = original) };
}

type Env = typeof ENV & { PLATFORM_SECRET: string };

/**
 * A vertical as deployed: its operations, the platform surface's envelope, and routes of its
 * own — one answering with a `Response` it built, one throwing past the operations, and one
 * handing back a response whose headers are immutable.
 */
function vertical(options: { middleware: boolean }) {
  const seen: (string | undefined)[] = [];
  const fromHono: (string | undefined)[] = [];
  const app = new Hono<{ Bindings: Env }>();
  if (options.middleware) app.use('*', invocationLog<Env>({ routerSecret: (env) => env.ROUTER_SECRET }));
  app.use('*', async (c, next) => {
    fromHono.push(requestIdOf(c));
    await next();
  });
  mountOperations(
    app,
    {
      'acme/ok': { input: z.object({}), http: { method: 'POST', path: '/ok' } },
      'acme/denied': { input: z.object({}), http: { method: 'POST', path: '/denied' } },
      'acme/fault': { input: z.object({}), http: { method: 'POST', path: '/fault' } },
      'acme/domain': { input: z.object({}), http: { method: 'POST', path: '/domain' } },
    },
    async () =>
      ({
        invoke: async (name: string, _input: unknown, invokeOptions?: { invocationId?: string }) => {
          seen.push(invokeOptions?.invocationId);
          if (name === 'acme/denied') throw new PermissionDenied('permission denied: acme.widget.edit');
          if (name === 'acme/fault') throw new Error('internal error; reference = 1234');
          if (name === 'acme/domain') throw new Error('the widget is out of stock');
          return { ok: true };
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      }) as any,
  );
  app.get('/custom', () => new Response('hello'));
  app.get('/crash', () => {
    throw new HTTPException(500, { message: 'the vertical broke' });
  });
  app.get('/passthrough', () => Response.redirect('https://elsewhere.example/', 302));
  mountPlatformSurface(app, {
    platformSecret: (env) => env.PLATFORM_SECRET,
    hostFor: () => ({}) as unknown as VerticalScopeHost,
    roles: [],
    ownerRoleKey: 'admin',
  });
  return { app, seen, fromHono };
}

const env: Env = { ...ENV, PLATFORM_SECRET: 'platform-sekret' };

function request(path: string, method: 'GET' | 'POST', headers: Record<string, string> = routed): Request {
  return new Request(`https://acme.example${path}`, {
    method,
    headers: { ...headers, ...(method === 'POST' ? { 'content-type': 'application/json' } : {}) },
    ...(method === 'POST' ? { body: '{}' } : {}),
  });
}

const CASES = [
  { path: '/api/ok', method: 'POST', status: 200, operation: true, problem: false },
  { path: '/api/denied', method: 'POST', status: 403, operation: true, problem: true },
  { path: '/api/fault', method: 'POST', status: 502, operation: true, problem: true },
  { path: '/api/domain', method: 'POST', status: 400, operation: true, problem: true },
  { path: '/custom', method: 'GET', status: 200, operation: false, problem: false },
  { path: '/crash', method: 'GET', status: 500, operation: false, problem: true },
  { path: '/passthrough', method: 'GET', status: 302, operation: false, problem: false },
  { path: '/nowhere', method: 'GET', status: 404, operation: false, problem: false },
] as const;

describe.each([
  { layer: 'the platform’s entry (#1893)', middleware: false },
  { layer: 'the invocationLog middleware', middleware: true },
])('the request id, stamped by $layer', ({ middleware }) => {
  it.each(CASES)('$method $path ($status): header, body, line, scope and Hono context agree', async (c) => {
    const { app, seen, fromHono } = vertical({ middleware });
    const fetcher = middleware ? { fetch: app.fetch } : withInvocationLog<Env>(app as never, { routerSecret: (e) => e.ROUTER_SECRET });
    const { lines, restore } = capture();
    let res: Response;
    try {
      res = (await fetcher.fetch!(request(c.path, c.method), env, {})) as Response;
    } finally {
      restore();
    }
    expect(res.status).toBe(c.status);
    const id = res.headers.get(REQUEST_ID_HEADER);
    expect(id).toMatch(ULID);
    // The line the dashboard's request view opens is this request's, under this id.
    expect(lines).toHaveLength(1);
    expect(lines[0]!.invocationId).toBe(id);
    expect(fromHono).toEqual([id]);
    expect(seen).toEqual(c.operation ? [id] : []);
    if (c.problem) {
      const body = problem.parse(await res.json());
      expect(body.requestId).toBe(id);
    }
  });
});

describe('the request id on a request nothing stamped', () => {
  it('leaves every response as it was: no header, no requestId member', async () => {
    const { app, fromHono } = vertical({ middleware: false });
    const denied = await app.request('/api/denied', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }, env);
    expect(denied.status).toBe(403);
    expect(denied.headers.get(REQUEST_ID_HEADER)).toBeNull();
    // Exactly what the producer renders for the same throw, as it did before #2192.
    expect(await denied.json()).toEqual(toProblem(new PermissionDenied('permission denied: acme.widget.edit'), '/api/denied'));
    const ok = await app.request('/custom', {}, env);
    expect(ok.headers.get(REQUEST_ID_HEADER)).toBeNull();
    expect(fromHono).toEqual([undefined, undefined]);
  });
});

describe('problemResponse, for a vertical that renders its own onError (#2192)', () => {
  it('carries the id when the request was stamped, and nothing when it was not', async () => {
    const app = new Hono();
    app.use('/stamped/*', async (c, next) => {
      (c as unknown as { set: (k: string, v: unknown) => void }).set('substratInvocationId', '01JZ0000000000000000REQ001');
      await next();
    });
    app.get('/stamped/x', () => {
      throw new PermissionDenied('permission denied: acme.widget.edit');
    });
    app.get('/bare/x', () => {
      throw new PermissionDenied('permission denied: acme.widget.edit');
    });
    app.onError((err, c) => problemResponse(c, err));
    expect(((await (await app.request('/stamped/x')).json()) as { requestId?: string }).requestId).toBe('01JZ0000000000000000REQ001');
    expect(await (await app.request('/bare/x')).json()).not.toHaveProperty('requestId');
  });
});
