import { afterEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { REQUEST_ID_HEADER, problemForStatus } from '@substrat-run/contracts';
import { requestIdOf } from '@substrat-run/vertical-host';
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
      error: 'Error: the plane is down',
    });
    // The query string (a consent code, a state token) never reaches the log.
    expect(String(logged[0]![0])).not.toContain('secret-consent-code');
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
