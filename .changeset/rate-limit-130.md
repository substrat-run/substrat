---
'@substrat-run/contracts': minor
'@substrat-run/vertical-host': minor
---

Requests are rate limited per credential and per client address, within one app install (#130).

The router counts every request to a hosted vertical before dispatching it. Over a budget, the answer is a `429` `application/problem+json` with `code: "rate_limited"`, `retryAfter`, and the `Retry-After`, `RateLimit` and `RateLimit-Policy` headers. Every key begins with the install's tenant and scope, so one tenant's traffic never draws on another's budget. A credential is a bearer token, else a session cookie, else the client address, and it is only ever kept as a truncated SHA-256 digest. A limiter that fails lets the request through and logs a line.

- **contracts**: `rate-limit.ts`. It holds the `RateLimiter` seam (the shape of Cloudflare's rate-limit binding), `DEFAULT_RATE_LIMITS` (1200 a minute per credential, 6000 per address), `parseRateLimits`, `rateLimitKeys`, `isSessionCookie`, `checkRateLimits`, `rateLimitPolicyHeader`, `rateLimitedRefusal`, `memoryRateLimiter`, and the header names with `RATE_LIMIT_EXPOSED_HEADERS`. `rate_limited` joins `DOCUMENTED_ERROR_CODES`, so every operation in an emitted OpenAPI document now lists a `429` (`RateLimited`) together with its headers.
- **vertical-host**: `rateLimit({ nodeOf, clientIp, limits, limiters })`, the same check as Hono middleware for a node host with no router in front. It counts in memory, so its budgets hold within one process.
