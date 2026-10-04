/**
 * Request rate limiting for a host with no router in front (#130).
 *
 * On the hosted path the router counts every request before it reaches a vertical, and a
 * vertical mounts nothing. A node host — self-host, a dev server, a container — has no
 * router, so this is the same choke point moved onto its own Hono app: the keys, the
 * headers and the 429 are `@substrat-run/contracts`' `rate-limit.ts`, so the two paths
 * cannot disagree about what a refusal looks like.
 *
 * Opt-in, and never mounted on a Cloudflare vertical: an isolate's memory is not a counter,
 * and the router already counted the request.
 *
 * ```ts
 * app.use('*', rateLimit({ nodeOf: () => ({ tenantId, scopeId }), clientIp: (c) => … }));
 * ```
 */
import type { Context, MiddlewareHandler } from 'hono';
import {
  checkRateLimits,
  DEFAULT_RATE_LIMITS,
  memoryRateLimiter,
  RATE_LIMIT_BUCKETS,
  RATE_LIMIT_POLICY_HEADER,
  rateLimitedRefusal,
  rateLimitKeys,
  rateLimitPolicyHeader,
  type RateLimitBucket,
  type RateLimitCheck,
  type RateLimiter,
  type RateLimitPolicy,
} from '@substrat-run/contracts';

export interface RateLimitOptions {
  /**
   * The tenant and scope a request is for — the prefix of every key, which is what keeps one
   * tenant from spending another's budget. A single-install host answers a constant.
   */
  nodeOf: (c: Context) => { tenantId: string; scopeId: string } | Promise<{ tenantId: string; scopeId: string }>;
  /**
   * The client address, for the address budget and for a request with no credential. Only
   * the host knows which proxy header it can trust, so nothing is read by default; absent,
   * every anonymous caller shares one budget.
   */
  clientIp?: (c: Context) => string | null | undefined;
  /** Budgets per bucket. Defaults to `DEFAULT_RATE_LIMITS`. */
  limits?: Partial<Record<RateLimitBucket, RateLimitPolicy>>;
  /**
   * The counters. Defaults to one `memoryRateLimiter` per bucket — exact for this process,
   * and only for it: several replicas want a shared counter here.
   */
  limiters?: Partial<Record<RateLimitBucket, RateLimiter>>;
}

/**
 * Count each request against its budgets before any route runs. Refuses with a 429
 * `application/problem+json` (`rate_limited`) and `Retry-After`; fails OPEN with a log line
 * when a counter throws, for the reason the contracts module gives.
 */
export function rateLimit(options: RateLimitOptions): MiddlewareHandler {
  const policies = { ...DEFAULT_RATE_LIMITS, ...options.limits };
  const limiters = Object.fromEntries(
    RATE_LIMIT_BUCKETS.map((bucket) => [bucket, options.limiters?.[bucket] ?? memoryRateLimiter(policies[bucket])]),
  ) as Record<RateLimitBucket, RateLimiter>;
  const policyHeader = rateLimitPolicyHeader(policies);

  return async (c, next) => {
    const { tenantId, scopeId } = await options.nodeOf(c);
    const keys = await rateLimitKeys({ tenantId, scopeId, headers: c.req.raw.headers, clientIp: options.clientIp?.(c) });
    const checks: RateLimitCheck[] = RATE_LIMIT_BUCKETS.map((bucket) => ({
      bucket,
      policy: policies[bucket],
      limiter: limiters[bucket],
      key: keys[bucket],
    }));
    const verdict = await checkRateLimits(checks);
    if (verdict.failures.length > 0) {
      console.error(
        JSON.stringify({
          host: 'rate-limit-unavailable',
          reason: 'the rate limiter threw; the request was let through',
          tenantId,
          scopeId,
          buckets: verdict.failures.map((f) => f.bucket),
          error: verdict.failures.map((f) => (f.error instanceof Error ? f.error.message : String(f.error))),
        }),
      );
    }
    if (verdict.outcome === 'limited') {
      const refusal = rateLimitedRefusal(verdict.refused, policies, c.req.path);
      return c.body(JSON.stringify(refusal.body), refusal.status, refusal.headers);
    }
    await next();
    // Rebuilt rather than set in place: a handler may answer with a response whose headers
    // are immutable (one it fetched). An upgrade carries a socket a rebuild would drop.
    if (c.res.status === 101) return;
    c.res = new Response(c.res.body, c.res);
    c.res.headers.set(RATE_LIMIT_POLICY_HEADER, policyHeader);
  };
}
