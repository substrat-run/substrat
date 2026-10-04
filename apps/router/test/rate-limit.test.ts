import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { unstable_readConfig } from 'wrangler';
import { DEFAULT_RATE_LIMITS, parseRateLimits, PROBLEM_CONTENT_TYPE, type RateLimiter } from '@substrat-run/contracts';
import worker, { type Env } from '../src/worker.js';

/**
 * #130: the router counts every resolved request against two budgets before it dispatches.
 * The fake limiter is an exact counter with a settable limit — what the test owns is the
 * KEY each request is counted under, which is the whole of the isolation argument.
 */

const T1 = '01JZ0000000000000000000001';
const T2 = '01JZ0000000000000000000003';
const S1 = '01JZ0000000000000000000002';
const S2 = '01JZ0000000000000000000004';
const SECRET = 'shhh';

/** A counter over keys, failing a key's `limit + 1`th request — Cloudflare's binding, exactly. */
function counter(limit: number) {
  const counts = new Map<string, number>();
  const limiter: RateLimiter = {
    limit: async ({ key }) => {
      const n = (counts.get(key) ?? 0) + 1;
      counts.set(key, n);
      return { success: n <= limit };
    },
  };
  return { limiter, keys: () => [...counts.keys()] };
}

const route = (tenant: string, scope: string) => ({
  tenant_id: tenant,
  scope_id: scope,
  vertical_slug: 'fsm',
  surface: 'app',
  region: null,
  status: 'active',
});

function envWith(over: Partial<Env> = {}) {
  const dispatched: Request[] = [];
  const rows: Record<string, ReturnType<typeof route>> = {
    'acme.example.com': route(T1, S1),
    'other.example.com': route(T2, S2),
  };
  const env = {
    ROUTER_SECRET: SECRET,
    CONTROL_PLANE: { idFromName: () => 'id', get: () => ({ readRoute: async (h: string) => rows[h] }) },
    VERTICAL_FSM: {
      fetch: async (req: Request) => {
        dispatched.push(req);
        return new Response('ok');
      },
    },
    RATE_LIMITS: { credential: { limit: 2, period: 60 }, ip: { limit: 100, period: 10 } },
    ...over,
  } as unknown as Env;
  return { env, dispatched };
}

const call = (env: Env, host: string, headers: Record<string, string> = {}) =>
  worker.fetch(new Request(`https://${host}/api/repairs`, { headers: { 'cf-connecting-ip': '203.0.113.7', ...headers } }), env);

afterEach(() => vi.restoreAllMocks());

describe('router rate limiting (#130)', () => {
  it('lets a request under the limit through, saying which policies counted it', async () => {
    const { env, dispatched } = envWith({ RATE_LIMIT_CREDENTIAL: counter(2).limiter, RATE_LIMIT_IP: counter(100).limiter });
    const res = await call(env, 'acme.example.com', { authorization: 'Bearer a' });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ok');
    expect(dispatched).toHaveLength(1);
    expect(res.headers.get('RateLimit-Policy')).toBe('"credential";q=2;w=60, "ip";q=100;w=10');
  });

  it('refuses the request over the limit with a 429 problem, Retry-After, and no dispatch', async () => {
    const { env, dispatched } = envWith({ RATE_LIMIT_CREDENTIAL: counter(2).limiter });
    const headers = { authorization: 'Bearer a' };
    expect((await call(env, 'acme.example.com', headers)).status).toBe(200);
    expect((await call(env, 'acme.example.com', headers)).status).toBe(200);
    const res = await call(env, 'acme.example.com', headers);
    expect(res.status).toBe(429);
    expect(res.headers.get('content-type')).toBe(PROBLEM_CONTENT_TYPE);
    expect(res.headers.get('Retry-After')).toBe('60');
    expect(res.headers.get('RateLimit')).toBe('"credential";r=0;t=60');
    // Only the bucket that is bound is named: the address budget was never counted.
    expect(res.headers.get('RateLimit-Policy')).toBe('"credential";q=2;w=60');
    expect(await res.json()).toMatchObject({
      type: 'https://substrat.net/errors/rate-limited',
      status: 429,
      code: 'rate_limited',
      retryAfter: 60,
      instance: '/api/repairs',
    });
    expect(dispatched).toHaveLength(2);
  });

  it('records a refusal under the tenant, with its problem code', async () => {
    const points: { indexes: string[]; blobs: string[]; doubles: number[] }[] = [];
    const { env } = envWith({
      RATE_LIMIT_CREDENTIAL: counter(0).limiter,
      ANALYTICS: { writeDataPoint: (p: (typeof points)[number]) => points.push(p) } as unknown as AnalyticsEngineDataset,
    });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    expect((await call(env, 'acme.example.com')).status).toBe(429);
    expect(points).toHaveLength(1);
    expect(points[0]!.indexes).toEqual([T1]);
    expect(points[0]!.blobs[6]).toBe('rate_limited');
    expect(points[0]!.doubles[1]).toBe(429);
  });

  it('gives two tokens independent budgets', async () => {
    const { env } = envWith({ RATE_LIMIT_CREDENTIAL: counter(2).limiter });
    for (let i = 0; i < 2; i++) await call(env, 'acme.example.com', { authorization: 'Bearer a' });
    expect((await call(env, 'acme.example.com', { authorization: 'Bearer a' })).status).toBe(429);
    expect((await call(env, 'acme.example.com', { authorization: 'Bearer b' })).status).toBe(200);
  });

  it('gives two tenants independent budgets, even for the same token from the same address', async () => {
    const { env } = envWith({ RATE_LIMIT_CREDENTIAL: counter(2).limiter, RATE_LIMIT_IP: counter(2).limiter });
    const headers = { authorization: 'Bearer shared' };
    for (let i = 0; i < 2; i++) await call(env, 'acme.example.com', headers);
    expect((await call(env, 'acme.example.com', headers)).status).toBe(429);
    expect((await call(env, 'other.example.com', headers)).status).toBe(200);
  });

  it('gives two session cookies behind one address independent budgets', async () => {
    // An office behind one NAT: every signed-in browser is its own caller, not one shared
    // address budget.
    const { env } = envWith({ RATE_LIMIT_CREDENTIAL: counter(2).limiter });
    const alice = { cookie: 'theme=dark; sb_session=alice-session' };
    for (let i = 0; i < 2; i++) await call(env, 'acme.example.com', alice);
    expect((await call(env, 'acme.example.com', alice)).status).toBe(429);
    expect((await call(env, 'acme.example.com', { cookie: 'sb_session=bob-session; theme=dark' })).status).toBe(200);
  });

  it('counts a request with no credential by its address — and cookies that are not a session are not a credential', async () => {
    const { env } = envWith({ RATE_LIMIT_CREDENTIAL: counter(2).limiter });
    await call(env, 'acme.example.com', { cookie: 'theme=dark' });
    await call(env, 'acme.example.com', { cookie: 'theme=light' });
    expect((await call(env, 'acme.example.com')).status).toBe(429);
    expect((await call(env, 'acme.example.com', { 'cf-connecting-ip': '198.51.100.2' })).status).toBe(200);
  });

  it('bounds a caller minting a fresh token per request by the address budget', async () => {
    const { env } = envWith({ RATE_LIMIT_CREDENTIAL: counter(2).limiter, RATE_LIMIT_IP: counter(3).limiter });
    for (let i = 0; i < 3; i++) expect((await call(env, 'acme.example.com', { authorization: `Bearer fake-${i}` })).status).toBe(200);
    const res = await call(env, 'acme.example.com', { authorization: 'Bearer fake-3' });
    expect(res.status).toBe(429);
    expect(res.headers.get('RateLimit')).toBe('"ip";r=0;t=10');
  });

  it('never puts a raw token or cookie into a key or a log line', async () => {
    const credential = counter(1);
    const ip = counter(1);
    const logged: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line: string) => void logged.push(line));
    vi.spyOn(console, 'error').mockImplementation((line: string) => void logged.push(line));
    const { env } = envWith({ RATE_LIMIT_CREDENTIAL: credential.limiter, RATE_LIMIT_IP: ip.limiter });
    await call(env, 'acme.example.com', { authorization: 'Bearer SECRET-TOKEN' });
    await call(env, 'acme.example.com', { cookie: 'sb_session=SECRET-COOKIE' });
    await call(env, 'acme.example.com', { authorization: 'Bearer SECRET-TOKEN' });
    const seen = [...credential.keys(), ...ip.keys(), ...logged].join('\n');
    expect(seen).not.toContain('SECRET');
    expect(credential.keys().every((k) => k.startsWith(`${T1}:${S1}:credential:`))).toBe(true);
  });

  it('fails OPEN when the limiter throws: the request is dispatched, and a line says why', async () => {
    const errors: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((line: string) => void errors.push(line));
    const down: RateLimiter = { limit: async () => { throw new Error('rate limiter unreachable'); } };
    const { env, dispatched } = envWith({ RATE_LIMIT_CREDENTIAL: down, RATE_LIMIT_IP: counter(100).limiter });
    const res = await call(env, 'acme.example.com', { authorization: 'Bearer a' });
    expect(res.status).toBe(200);
    expect(dispatched).toHaveLength(1);
    const line = JSON.parse(errors.find((e) => e.includes('rate-limit-unavailable'))!);
    expect(line).toMatchObject({ router: 'rate-limit-unavailable', tenantId: T1, scopeId: S1, buckets: ['credential'] });
  });

  it('fails OPEN, loudly, when bindings are declared but their budgets are not readable', async () => {
    const errors: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((line: string) => void errors.push(line));
    const { env, dispatched } = envWith({ RATE_LIMIT_CREDENTIAL: counter(0).limiter, RATE_LIMITS: { credential: { limit: 'lots' } } });
    expect((await call(env, 'acme.example.com')).status).toBe(200);
    expect(dispatched).toHaveLength(1);
    expect(errors.some((e) => e.includes('rate-limit-unavailable'))).toBe(true);
  });

  it('lets a cross-origin, credentialed page READ its 429 and the headers it backs off by', async () => {
    // What a browser needs from a refusal the vertical never saw: the origin allowed with
    // credentials, and the rate-limit headers exposed. Without them the page sees a CORS
    // failure, not a delay, and keeps polling.
    const { env } = envWith({ RATE_LIMIT_CREDENTIAL: counter(0).limiter });
    const res = await call(env, 'acme.example.com', { origin: 'https://app.example.org', cookie: 'sb_session=alice' });
    expect(res.status).toBe(429);
    expect(res.headers.get('access-control-allow-origin')).toBe('https://app.example.org');
    expect(res.headers.get('access-control-allow-credentials')).toBe('true');
    expect(res.headers.get('access-control-expose-headers')).toBe('Retry-After, RateLimit, RateLimit-Policy');
    expect(res.headers.get('vary')).toBe('Origin');
    expect(res.headers.get('Retry-After')).toBe('60');
  });

  it('never counts or refuses a CORS preflight: it reaches the vertical', async () => {
    const credential = counter(0);
    const ip = counter(0);
    const { env, dispatched } = envWith({ RATE_LIMIT_CREDENTIAL: credential.limiter, RATE_LIMIT_IP: ip.limiter });
    const preflight = new Request('https://acme.example.com/api/repairs', {
      method: 'OPTIONS',
      headers: { origin: 'https://app.example.org', 'access-control-request-method': 'POST', 'cf-connecting-ip': '203.0.113.7' },
    });
    const res = await worker.fetch(preflight, env);
    expect(res.status).toBe(200);
    expect(dispatched).toHaveLength(1);
    expect([...credential.keys(), ...ip.keys()]).toEqual([]);
  });

  it('leaves a response the vertical gave to the vertical: no CORS from the router on a non-429', async () => {
    // The twin of the refusal policy. Reflecting any origin is safe only for a body holding
    // the requester's own rate state; on a vertical's response it would hand any site its data.
    const { env } = envWith({ RATE_LIMIT_CREDENTIAL: counter(5).limiter });
    const res = await call(env, 'acme.example.com', { origin: 'https://evil.example', cookie: 'sb_session=alice' });
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
    expect(res.headers.get('access-control-allow-credentials')).toBeNull();
  });

  it('counts nothing and says nothing when no limiter is bound', async () => {
    const { env } = envWith({ RATE_LIMITS: undefined });
    const res = await call(env, 'acme.example.com');
    expect(res.status).toBe(200);
    expect(res.headers.get('RateLimit-Policy')).toBeNull();
  });
});

/** The two fields of wrangler's resolved config this reads. */
interface Resolved {
  vars: Record<string, unknown>;
  ratelimits: { name: string; namespace_id: string; simple: { limit: number; period: number } }[];
}
const readConfig = (config: string, env?: string): Resolved => unstable_readConfig({ config, env }) as Resolved;

describe('the deployed rate-limit configuration (#130)', () => {
  const config = fileURLToPath(new URL('../wrangler.jsonc', import.meta.url).href);

  // A binding's limit is invisible at runtime, so the headers read `RATE_LIMITS`. Two copies
  // of one number drift silently unless something refuses the drift; this is that thing.
  it.each([undefined, 'test'])('says the same budgets twice, and only budgets the binding can hold (env %s)', (env) => {
    const read = readConfig(config, env);
    const declared = parseRateLimits(read.vars.RATE_LIMITS);
    expect(declared).toBeDefined();
    const bindings = Object.fromEntries(read.ratelimits.map((r) => [r.name, r.simple]));
    expect(bindings).toEqual({
      RATE_LIMIT_CREDENTIAL: declared!.credential,
      RATE_LIMIT_IP: declared!.ip,
    });
  });

  it('ships the conservative defaults, and keeps test counters apart from production', () => {
    const prod = readConfig(config);
    const test = readConfig(config, 'test');
    expect(parseRateLimits(prod.vars.RATE_LIMITS)).toEqual(DEFAULT_RATE_LIMITS);
    const prodNs = prod.ratelimits.map((r) => r.namespace_id);
    expect(test.ratelimits.some((r) => prodNs.includes(r.namespace_id))).toBe(false);
  });
});
