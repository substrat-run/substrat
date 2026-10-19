import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { defineRoutes, errorCodeOf, toProblem, z, type RouteImpl } from '@substrat-run/contracts';
import { issuePathsOf, mountRoutes, RouteOutputMismatch } from '../src/index.js';

/**
 * `mountRoutes` (#2170): a declared route set whose handlers are host code. What it owes
 * every route is what `mountOperations` owes every operation — the path and its order, the
 * query coercion, the input parse — plus the OUTPUT parse, since a hand-written handler has
 * no kernel seam between it and the wire.
 */
const routes = defineRoutes({
  'acme/list-things': {
    summary: 'Things, filtered',
    input: z.object({ limit: z.number().int().optional(), done: z.boolean().optional() }),
    output: z.object({ limit: z.number().nullable(), done: z.boolean().nullable() }),
    http: { method: 'GET', path: '/things' },
  },
  'acme/get-thing': {
    summary: 'One thing',
    input: z.object({ id: z.string() }),
    output: z.object({ id: z.string() }),
    http: { method: 'GET', path: '/things/{id}' },
  },
  'acme/mine': {
    summary: 'A static path beside a parameter one',
    output: z.object({ mine: z.literal(true) }),
    http: { method: 'GET', path: '/things/mine' },
  },
  'acme/create-thing': {
    summary: 'Make a thing',
    input: z.object({ name: z.string().min(1) }),
    output: z.object({ name: z.string() }),
    http: { method: 'POST', path: '/things' },
    status: 201,
  },
  'acme/broken': {
    summary: 'Answers outside its declaration',
    output: z.object({ ok: z.boolean() }),
    http: { method: 'GET', path: '/broken' },
  },
});

interface Ctx {
  readonly team: string;
}

function appWith(seen: unknown[] = []) {
  const handlers = {
    'acme/list-things': (_ctx, input) => ({ limit: input.limit ?? null, done: input.done ?? null }),
    'acme/get-thing': (ctx, input) => {
      seen.push([ctx.team, input]);
      return { id: input.id };
    },
    'acme/mine': () => ({ mine: true as const }),
    'acme/create-thing': (_ctx, input) => ({ name: input.name, extra: 'stripped' }),
    // The declared output is `{ ok: boolean }`, so the compiler refuses this handler; the cast
    // gets it past that to exercise the runtime half — a map assembled where types are lost.
    'acme/broken': (() => ({ ok: 'yes' })) as unknown as () => { ok: boolean },
  } satisfies RouteImpl<typeof routes, Ctx>;
  const app = new Hono();
  const mounted = mountRoutes(app, routes, {
    basePath: '/api/teams/:teamId',
    context: async (c): Promise<Ctx> => {
      if (!c.req.header('authorization')) throw new HTTPException(401, { message: 'unauthorized' });
      return { team: c.req.param('teamId') as string };
    },
  })(handlers);
  app.onError((err, c) => c.json({ error: err.message }, err instanceof HTTPException ? err.status : 500));
  const req = (path: string, init: RequestInit = {}) =>
    app.request(path, { ...init, headers: { authorization: 'x', 'content-type': 'application/json', ...(init.headers ?? {}) } });
  return { app, mounted, req };
}

describe('mountRoutes (#2170)', () => {
  it('mounts every route under the base path, a static segment ahead of its parameter sibling', async () => {
    const { mounted, req } = appWith();
    const paths = mounted.map((m) => `${m.method} ${m.path}`);
    expect(paths).toHaveLength(5);
    expect(paths.indexOf('GET /api/teams/:teamId/things/mine')).toBeLessThan(paths.indexOf('GET /api/teams/:teamId/things/:id'));
    expect(await (await req('/api/teams/t1/things/mine')).json()).toEqual({ mine: true });
  });

  it('hands the context the base parameter, and the handler only its declared input', async () => {
    const seen: unknown[] = [];
    const res = await appWith(seen).req('/api/teams/t1/things/abc');
    expect(res.status).toBe(200);
    expect(seen).toEqual([['t1', { id: 'abc' }]]);
  });

  it('types a query string by the declared shape', async () => {
    const res = await appWith().req('/api/teams/t1/things?limit=5&done=false');
    expect(await res.json()).toEqual({ limit: 5, done: false });
  });

  it('resolves the context first: no session is the context’s 401, not a 400 about the input', async () => {
    const { app } = appWith();
    const res = await app.request('/api/teams/t1/things?limit=nope');
    expect(res.status).toBe(401);
  });

  it('refuses an input the declaration does not accept with a 400', async () => {
    const { req } = appWith();
    expect((await req('/api/teams/t1/things?limit=nope')).status).toBe(400);
    expect((await req('/api/teams/t1/things', { method: 'POST', body: JSON.stringify({ name: '' }) })).status).toBe(400);
    expect((await req('/api/teams/t1/things', { method: 'POST', body: '{not json' })).status).toBe(400);
  });

  it('answers with the declared status and exactly the declared output', async () => {
    const res = await appWith().req('/api/teams/t1/things', { method: 'POST', body: JSON.stringify({ name: 'a' }) });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ name: 'a' });
  });

  it('a handler answering outside its declaration is a server error naming the route', async () => {
    const res = await appWith().req('/api/teams/t1/broken');
    expect(res.status).toBe(500);
    expect(((await res.json()) as { error: string }).error).toContain("'acme/broken' answered outside its declared output");
  });

  it('#2401: that throw is `internal`, so the taxonomy answers 500 with no detail, and the route and issue paths ride on it for the log', async () => {
    const thrown: unknown[] = [];
    const { app, req } = appWith();
    app.onError((err, c) => {
      thrown.push(err);
      const problem = toProblem(err, c.req.path);
      return c.json(problem, problem.status as 500);
    });
    const res = await req('/api/teams/t1/broken');
    expect(res.status).toBe(500);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ status: 500, title: 'Internal error', code: 'internal' });
    expect(body).not.toHaveProperty('detail');
    // Neither the schema's wording nor the value the handler answered reaches the caller.
    expect(JSON.stringify(body)).not.toMatch(/acme\/broken|expected|boolean|yes/);
    expect(thrown).toHaveLength(1);
    expect(errorCodeOf(thrown[0])).toBe('internal');
    expect(thrown[0]).toBeInstanceOf(RouteOutputMismatch);
    expect(thrown[0]).toMatchObject({ route: 'acme/broken', issuePaths: ['ok'] });
  });

  it('#2401: the issue paths are distinct fields, an index written `[]`, at most ten, and carry no value', () => {
    // One field broken in every row of a list is one path, so a second broken field is not crowded out.
    const everyRow = Array.from({ length: 30 }, (_, i) => ({ path: ['entries', i, 'at'] }));
    const err = new RouteOutputMismatch('acme/list', [...everyRow, { path: ['entries', 29, 'id'] }, { path: [0, 'tags', 3] }, { path: ['total'] }]);
    expect(err.issuePaths).toEqual(['entries[].at', 'entries[].id', '[].tags[]', 'total']);
    const fields = Array.from({ length: 12 }, (_, i) => ({ path: ['entries', 0, `f${i}`] }));
    expect(issuePathsOf(fields)).toEqual(Array.from({ length: 10 }, (_, i) => `entries[].f${i}`));
    expect(err.code).toBe('internal');
    expect(err.message).toBe("mountRoutes: 'acme/list' answered outside its declared output");
  });

  it('refuses at mount a declared route with no handler', () => {
    expect(() =>
      mountRoutes(new Hono(), routes, { basePath: '/api', context: async () => ({}) })({} as never),
    ).toThrow(/is declared but has no handler/);
  });
});
