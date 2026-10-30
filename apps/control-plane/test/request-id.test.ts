import { SELF } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { DEV_ACTOR_HEADER } from '@substrat-run/control-plane-api';
import { REQUEST_ID_HEADER } from '@substrat-run/contracts';
import { ulid } from '@substrat-run/kernel';
import { controlPlaneRequestId } from '../src/request-id.js';

/** #113, #2192: a request id on every `/api` answer, and in a problem document's body. */
const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
// A caller's own claim, which must never come back.
const CLAIMED = '01ARZ3NDEKTSV4RRFFQ69G5FAV';

describe('the control-plane request id', () => {
  afterEach(() => vi.restoreAllMocks());

  it("a refusal's problem body carries the minted id, equal to the header", async () => {
    // One refusal from the worker's own route, one from the control-plane API router.
    for (const path of ['/api/members', `/api/tenants/${ulid()}`]) {
      const res = await SELF.fetch(`https://cp.test${path}`, { headers: { [REQUEST_ID_HEADER]: CLAIMED } });
      const text = await res.text();
      const body = JSON.parse(text) as Record<string, unknown>;
      const id = res.headers.get(REQUEST_ID_HEADER);
      expect(res.status, path).toBeGreaterThanOrEqual(400);
      expect(id, path).toMatch(ULID);
      expect(id, path).not.toBe(CLAIMED);
      expect(body.requestId, path).toBe(id);
      expect(body.detail, path).toBeTypeOf('string');
      // A length the old body had would truncate the stamped one.
      const length = res.headers.get('content-length');
      if (length !== null) expect(Number(length), path).toBe(new TextEncoder().encode(text).length);
    }
  });

  it('a success carries the header, and its body is left as the route wrote it', async () => {
    const res = await SELF.fetch('https://cp.test/api/auth/session', { headers: { [DEV_ACTOR_HEADER]: ulid() } });
    expect(res.status).toBe(200);
    expect(res.headers.get(REQUEST_ID_HEADER)).toMatch(ULID);
    expect(await res.json()).toEqual({ user: null });
  });

  it('a 5xx logs one fixed-vocabulary line: the route pattern, never the path, query or message', async () => {
    const logged: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => void logged.push(String(args[0])));
    const app = new Hono();
    app.use('/api/*', controlPlaneRequestId());
    app.get('/api/tenants/:tenantId', () => {
      throw new Error('upstream said token=abc');
    });
    app.onError(() => new Response('{}', { status: 500, headers: { 'content-type': 'application/json' } }));
    const tenant = ulid();
    const res = await app.request(`/api/tenants/${tenant}?code=secret-consent-code`);
    expect(logged).toHaveLength(1);
    expect(JSON.parse(logged[0]!)).toEqual({
      event: 'control-plane.request-failed',
      requestId: res.headers.get(REQUEST_ID_HEADER),
      method: 'GET',
      route: '/api/tenants/:tenantId',
      status: 500,
      errorName: 'Error',
    });
    expect(logged[0]).not.toMatch(new RegExp(`token=abc|secret-consent-code|${tenant}`));
  });
});
