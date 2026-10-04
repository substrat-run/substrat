import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isSessionCookie, PROBLEM_CONTENT_TYPE, type RateLimiter } from '@substrat-run/contracts';
import { CAPABILITY_COOKIE, memoryRateLimiter, rateLimit, type RateLimitOptions } from '../src/index.js';

/**
 * #130 on a host with no router: the same keys, headers and refusal as the router's, from a
 * middleware a node host mounts first. The counters here are the real `memoryRateLimiter`.
 */

const T1 = '01JZ0000000000000000000001';
const T2 = '01JZ0000000000000000000003';
const S = '01JZ0000000000000000000002';

function app(over: Partial<RateLimitOptions> = {}) {
  let handled = 0;
  const a = new Hono();
  a.use(
    '*',
    rateLimit({
      // The tenant rides a test header here; a real host answers from its own install.
      nodeOf: (c) => ({ tenantId: c.req.header('x-test-tenant') ?? T1, scopeId: S }),
      clientIp: (c) => c.req.header('x-test-ip') ?? '203.0.113.7',
      limits: { credential: { limit: 2, period: 60 }, ip: { limit: 100, period: 60 } },
      ...over,
    }),
  );
  a.get('/api/things', (c) => {
    handled += 1;
    return c.text('ok');
  });
  return { request: (headers: Record<string, string> = {}) => a.request('/api/things', { headers }), handled: () => handled };
}

afterEach(() => vi.restoreAllMocks());

describe('vertical-host rateLimit (#130)', () => {
  it('passes a request under the limit, naming the policies', async () => {
    const { request, handled } = app();
    const res = await request({ authorization: 'Bearer a' });
    expect(res.status).toBe(200);
    expect(handled()).toBe(1);
    expect(res.headers.get('RateLimit-Policy')).toBe('"credential";q=2;w=60, "ip";q=100;w=60');
  });

  it('refuses over the limit with a 429 problem and Retry-After, before any route runs', async () => {
    const { request, handled } = app();
    await request({ authorization: 'Bearer a' });
    await request({ authorization: 'Bearer a' });
    const res = await request({ authorization: 'Bearer a' });
    expect(res.status).toBe(429);
    expect(res.headers.get('content-type')).toBe(PROBLEM_CONTENT_TYPE);
    expect(res.headers.get('Retry-After')).toBe('60');
    expect(await res.json()).toMatchObject({ code: 'rate_limited', status: 429, retryAfter: 60, instance: '/api/things' });
    expect(handled()).toBe(2);
  });

  it('gives two tokens independent budgets', async () => {
    const { request } = app();
    for (let i = 0; i < 2; i++) await request({ authorization: 'Bearer a' });
    expect((await request({ authorization: 'Bearer a' })).status).toBe(429);
    expect((await request({ authorization: 'Bearer b' })).status).toBe(200);
  });

  it('gives two tenants independent budgets on one host', async () => {
    const { request } = app();
    for (let i = 0; i < 2; i++) await request({ authorization: 'Bearer a', 'x-test-tenant': T1 });
    expect((await request({ authorization: 'Bearer a', 'x-test-tenant': T1 })).status).toBe(429);
    expect((await request({ authorization: 'Bearer a', 'x-test-tenant': T2 })).status).toBe(200);
  });

  it('gives two session cookies from one address independent budgets', async () => {
    const { request } = app();
    for (let i = 0; i < 2; i++) await request({ cookie: 'sb_session=alice' });
    expect((await request({ cookie: 'sb_session=alice' })).status).toBe(429);
    expect((await request({ cookie: 'sb_session=bob' })).status).toBe(200);
  });

  it('fails OPEN when a counter throws, with a line naming the bucket', async () => {
    const errors: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((line: string) => void errors.push(line));
    const down: RateLimiter = { limit: async () => { throw new Error('store unreachable'); } };
    const { request, handled } = app({ limiters: { credential: down } });
    expect((await request({ authorization: 'Bearer a' })).status).toBe(200);
    expect(handled()).toBe(1);
    expect(JSON.parse(errors[0]!)).toMatchObject({ host: 'rate-limit-unavailable', tenantId: T1, buckets: ['credential'] });
  });
});

describe('memoryRateLimiter', () => {
  it('opens a fresh window once the period has passed', async () => {
    let t = 0;
    const limiter = memoryRateLimiter({ limit: 1, period: 10 }, () => t);
    expect((await limiter.limit({ key: 'k' })).success).toBe(true);
    expect((await limiter.limit({ key: 'k' })).success).toBe(false);
    t = 9_999;
    expect((await limiter.limit({ key: 'k' })).success).toBe(false);
    t = 10_000;
    expect((await limiter.limit({ key: 'k' })).success).toBe(true);
  });
});

describe('the session cookies a credential is read from', () => {
  // Test against the producer: the capability cookie is named here, and since #1686 it is a
  // prefix with one cookie per link.
  it('include every capability session cookie', () => {
    expect(isSessionCookie(CAPABILITY_COOKIE)).toBe(true);
    expect(isSessionCookie(`${CAPABILITY_COOKIE}_01JZ0000000000000000000009`)).toBe(true);
    expect(isSessionCookie('theme')).toBe(false);
  });
});
