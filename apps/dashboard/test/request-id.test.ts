import { afterEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { REQUEST_ID_HEADER, SubstratError, problemForStatus } from '@substrat-run/contracts';
import { ControlPlaneError } from '@substrat-run/control-plane-client';
import { RouteOutputMismatch, requestIdOf } from '@substrat-run/vertical-host';
import { dashboardRequestId, withRequestIdOf } from '../src/request-id.js';

/**
 * #2192: the dashboard worker's own answers carry a request id — the middleware alone, on a
 * small app shaped like the worker's (the middleware first, an `onError` that renders a
 * problem). `request-id-route.test.ts` drives the worker itself.
 */

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

function appUnderTest() {
  const app = new Hono();
  app.use('*', dashboardRequestId());
  app.get('/ok', (c) => c.json({ ok: true, seen: requestIdOf(c) }));
  app.get('/refused', (c) => c.json({ error: 'no' }, 403));
  app.get('/throws-400', () => {
    throw new HTTPException(400, { message: 'bad input' });
  });
  app.get('/throws-500', () => {
    throw new Error('the plane is down');
  });
  // A detail the dashboard does not author, carrying what must never reach a log line.
  const leaky = 'upstream said Authorization: Bearer eyJhbGciOi.secret-jwt and token=abc\r\nforged line';
  const planeFailure = () =>
    new ControlPlaneError(503, leaky, undefined, { body: JSON.stringify({ status: 503, code: 'unavailable', detail: leaky }) });
  app.get('/throws-plane', () => {
    throw planeFailure();
  });
  // The same failure rethrown the way a handler may, its message copied onto the wrapper.
  app.get('/throws-wrapped', () => {
    const plane = planeFailure();
    throw new HTTPException(502, { message: plane.message, cause: plane });
  });
  app.get('/throws-named', () => {
    const e = new Error('nothing');
    e.name = 'Bearer abc token=abc';
    throw e;
  });
  app.get('/throws-substrat', () => {
    throw new SubstratError('not_found', 'nothing here');
  });
  app.get('/throws-mismatch', () => {
    throw new RouteOutputMismatch('GET /things', [{ path: ['id'] }]);
  });
  app.get('/throws-fake-substrat', () => {
    const e = new Error('nothing');
    e.name = 'Substrat.not_a_code\nforged';
    throw e;
  });
  // An upgrade. Node's `Response` refuses a 101, so the status is set on a real response the
  // way workerd's would read; a copy of it (what `c.header` makes of an answered response)
  // would throw here, as it would drop the socket there.
  app.get('/upgrade', () => {
    const res = new Response(null, { status: 200, headers: { 'x-upgrade': 'yes' } });
    Object.defineProperty(res, 'status', { value: 101 });
    return res;
  });
  // `Response.redirect`'s headers are immutable, as a response handed straight back from a
  // `fetch` has.
  app.get('/passthrough', () => Response.redirect('https://example.com/elsewhere', 302));
  app.onError((err, c) => {
    const status = err instanceof HTTPException ? err.status : 500;
    return c.json(withRequestIdOf(problemForStatus(status, err.message), c), status);
  });
  return app;
}

describe('the dashboard request id (#2192)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('a success carries a minted ULID, the same one requestIdOf reads in the handler', async () => {
    const res = await appUnderTest().request('/ok');
    const id = res.headers.get(REQUEST_ID_HEADER);
    expect(res.status).toBe(200);
    expect(id).toMatch(ULID);
    expect(((await res.json()) as { seen: string }).seen).toBe(id);
  });

  it("a 4xx a route answered itself carries it, and the body is the route's own", async () => {
    const res = await appUnderTest().request('/refused');
    expect(res.status).toBe(403);
    expect(res.headers.get(REQUEST_ID_HEADER)).toMatch(ULID);
    expect(await res.json()).toEqual({ error: 'no' });
  });

  it('a thrown 4xx is rendered with the id in the problem body, equal to the header', async () => {
    const res = await appUnderTest().request('/throws-400');
    const body = (await res.json()) as { status: number; detail: string; requestId: string };
    expect(res.status).toBe(400);
    expect(body.requestId).toMatch(ULID);
    expect(body.requestId).toBe(res.headers.get(REQUEST_ID_HEADER));
    expect(body.detail).toBe('bad input');
  });

  it('a 5xx carries the id in header and body, and logs one line with that same id', async () => {
    const logged: unknown[][] = [];
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => void logged.push(args));
    const res = await appUnderTest().request('/throws-500?code=secret-consent-code');
    const id = res.headers.get(REQUEST_ID_HEADER);
    const body = (await res.json()) as Record<string, unknown>;
    expect(res.status).toBe(500);
    expect(id).toMatch(ULID);
    expect(body.requestId).toBe(id);
    // No stack in what the caller reads.
    expect(JSON.stringify(body)).not.toMatch(/\bat\s.+:\d+:\d+/);
    expect(body).not.toHaveProperty('stack');

    expect(logged).toHaveLength(1);
    const line = JSON.parse(String(logged[0]![0])) as Record<string, unknown>;
    expect(line).toEqual({
      event: 'dashboard.request-failed',
      requestId: id,
      method: 'GET',
      path: '/throws-500',
      status: 500,
      errorName: 'Error',
    });
    // A message is never logged: not even our own.
    expect(String(logged[0]![0])).not.toContain('the plane is down');
    // The query string (a consent code, a state token) never reaches the log.
    expect(String(logged[0]![0])).not.toContain('secret-consent-code');
  });

  it("the plane's failure is logged by name, code and status, never by its detail", async () => {
    const logged: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => void logged.push(String(args[0])));
    for (const [path, status, errorName] of [
      ['/throws-plane', 500, 'ControlPlaneError'],
      ['/throws-wrapped', 502, 'Error'],
    ] as const) {
      logged.length = 0;
      const res = await appUnderTest().request(path);
      expect(res.status).toBe(status);
      expect(logged).toHaveLength(1);
      expect(logged[0]).not.toMatch(/bearer|eyJhbGciOi|secret-jwt|token=abc|forged line/i);
      expect(JSON.parse(logged[0]!)).toEqual({
        event: 'dashboard.request-failed',
        requestId: res.headers.get(REQUEST_ID_HEADER),
        method: 'GET',
        path,
        status,
        errorName,
        errorCode: 'unavailable',
        upstreamStatus: 503,
      });
    }
  });

  it("a name something assigned is not code's, so it is logged as Error", async () => {
    const logged: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => void logged.push(String(args[0])));
    await appUnderTest().request('/throws-named');
    expect(logged).toHaveLength(1);
    expect(logged[0]).not.toMatch(/bearer|token=abc/i);
    expect((JSON.parse(logged[0]!) as { errorName: string }).errorName).toBe('Error');
  });

  it('a SubstratError and a RouteOutputMismatch are logged by their real name', async () => {
    const logged: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => void logged.push(String(args[0])));
    for (const [path, errorName] of [
      ['/throws-substrat', 'Substrat.not_found'],
      ['/throws-mismatch', 'Substrat.internal'],
    ] as const) {
      logged.length = 0;
      await appUnderTest().request(path);
      expect(logged).toHaveLength(1);
      expect((JSON.parse(logged[0]!) as { errorName: string }).errorName).toBe(errorName);
    }
  });

  it('a Substrat. name with a code outside the catalog falls back to Error', async () => {
    const logged: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => void logged.push(String(args[0])));
    await appUnderTest().request('/throws-fake-substrat');
    expect(logged).toHaveLength(1);
    expect(logged[0]).not.toContain('forged');
    expect((JSON.parse(logged[0]!) as { errorName: string }).errorName).toBe('Error');
  });

  it('an upgrade (101) is handed back untouched: not copied, so no header', async () => {
    const res = await appUnderTest().request('/upgrade');
    expect(res.status).toBe(101);
    expect(res.headers.get('x-upgrade')).toBe('yes');
    expect(res.headers.get(REQUEST_ID_HEADER)).toBeNull();
  });

  it('a success or a 4xx logs nothing', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const app = appUnderTest();
    await app.request('/ok');
    await app.request('/refused');
    await app.request('/throws-400');
    expect(spy).not.toHaveBeenCalled();
  });

  it('two requests get two ids', async () => {
    const app = appUnderTest();
    const a = (await app.request('/ok')).headers.get(REQUEST_ID_HEADER);
    const b = (await app.request('/ok')).headers.get(REQUEST_ID_HEADER);
    expect(a).toMatch(ULID);
    expect(b).toMatch(ULID);
    expect(a).not.toBe(b);
  });

  it('an id the caller sends is neither trusted nor echoed: the dashboard mints its own', async () => {
    const claimed = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
    const res = await appUnderTest().request('/throws-400', { headers: { [REQUEST_ID_HEADER]: claimed } });
    const body = (await res.json()) as { requestId: string };
    const id = res.headers.get(REQUEST_ID_HEADER);
    expect(id).toMatch(ULID);
    expect(id).not.toBe(claimed);
    expect(body.requestId).toBe(id);
    // And a non-ULID claim does not reach the response at all.
    const junk = await appUnderTest().request('/ok', { headers: { [REQUEST_ID_HEADER]: '<script>' } });
    expect(junk.headers.get(REQUEST_ID_HEADER)).toMatch(ULID);
  });

  it('a response with immutable headers is copied to carry the id', async () => {
    const res = await appUnderTest().request('/passthrough');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('https://example.com/elsewhere');
    expect(res.headers.get(REQUEST_ID_HEADER)).toMatch(ULID);
  });

  it('withRequestIdOf leaves a body unchanged on a request nothing stamped', async () => {
    const app = new Hono();
    app.get('/', (c) => c.json(withRequestIdOf({ error: 'x' }, c)));
    const res = await app.request('/');
    expect(await res.json()).toEqual({ error: 'x' });
    expect(res.headers.get(REQUEST_ID_HEADER)).toBeNull();
  });
});
