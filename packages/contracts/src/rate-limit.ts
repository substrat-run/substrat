/**
 * Request rate limiting on the request path (#130).
 *
 * A tenant must be protected from another tenant, and from its own AI-built frontend with
 * a polling bug. The limit is enforced where a request first meets the platform: the router
 * on the hosted path, `@substrat-run/vertical-host`'s `rateLimit()` middleware on a node
 * host with no router in front. Never in a scope host and never in the kernel: a limiter in
 * a scope DO serialises behind that scope's write queue, and cannot see one token's
 * traffic across scopes.
 *
 * ## Why the policy lives here
 *
 * Both of those choke points derive the same keys, speak the same headers and refuse with
 * the same problem — through one call, {@link evaluateRateLimits}. This file is that grammar
 * and nothing else: which counter remembers a key is the caller's ({@link RateLimiter}), so
 * the router binds Cloudflare's native rate-limit binding and a node host binds
 * vertical-host's `memoryRateLimiter`, and the two cannot disagree about what a key or a 429
 * looks like.
 *
 * ## The keys
 *
 * Every key begins `<tenant>:<scope>:<bucket>:`, so one tenant's traffic can never spend
 * another tenant's budget. That is a property of the key, not of a configuration.
 *
 * - **credential**: one budget per caller. A bearer token when the request carries one, else
 *   the session cookie a signed-in browser carries, else the client address. A credential is
 *   only ever represented by a truncated SHA-256 digest: the raw token or cookie is never
 *   part of a key, so it reaches no counter and no log line.
 * - **ip**: one budget per client address, set well above the credential budget. The router
 *   cannot verify a bearer, so without it a caller minting a fresh fake token per request
 *   would get a fresh credential budget per request too.
 *
 * ## The fail mode
 *
 * Open. A limiter that throws lets the request through, and the caller logs it. The limiter
 * protects capacity; it is not an authorization boundary — every request still meets the
 * vertical's authentication and permission checks — and failing closed would turn an outage
 * of the counter into an outage of every tenant behind it.
 */
import { substratError, toProblem, PROBLEM_CONTENT_TYPE, type Problem } from './errors.js';

/** RFC 9110 §10.2.3: seconds a client should wait before trying again. */
export const RETRY_AFTER_HEADER = 'Retry-After';
/** The policies a response was judged against (draft-ietf-httpapi-ratelimit-headers). */
export const RATE_LIMIT_POLICY_HEADER = 'RateLimit-Policy';
/** The state of the policy that refused (same draft): nothing remaining, and when it resets. */
export const RATE_LIMIT_HEADER = 'RateLimit';

/**
 * Exposed to a cross-origin browser client — the same trap `IDEMPOTENCY_EXPOSED_HEADERS`
 * documents. An unexposed `Retry-After` is the one that matters: a frontend that cannot
 * read it cannot back off by it.
 */
export const RATE_LIMIT_EXPOSED_HEADERS = [RETRY_AFTER_HEADER, RATE_LIMIT_HEADER, RATE_LIMIT_POLICY_HEADER] as const;

/**
 * The counter seam. Exactly the shape of Cloudflare's rate-limit binding, so the binding IS
 * a `RateLimiter` and needs no wrapper. `success: false` means the key is over its limit.
 */
export interface RateLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

/** The two buckets every request is counted in. */
export const RATE_LIMIT_BUCKETS = ['credential', 'ip'] as const;
export type RateLimitBucket = (typeof RATE_LIMIT_BUCKETS)[number];

/** One bucket's budget: `limit` requests per `period` seconds. */
export interface RateLimitPolicy {
  readonly limit: number;
  readonly period: number;
}

/**
 * The defaults: conservative, so a normal client never meets them. 1200 a minute per
 * credential is twenty requests a second sustained; the address budget is five times that,
 * so an office behind one NAT, every person on their own session, stays well clear of it.
 * A deployment sets its own (the router's `wrangler.jsonc`, a node host's options).
 */
export const DEFAULT_RATE_LIMITS: Readonly<Record<RateLimitBucket, RateLimitPolicy>> = {
  credential: { limit: 1200, period: 60 },
  ip: { limit: 6000, period: 60 },
};

/**
 * Read a deployment's configured limits, or `undefined` when they are not a complete,
 * well-formed set. Strict on purpose: a typo in a limit must be loud (the caller logs and
 * fails open), never a silently different budget.
 */
export function parseRateLimits(value: unknown): Record<RateLimitBucket, RateLimitPolicy> | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const out = {} as Record<RateLimitBucket, RateLimitPolicy>;
  for (const bucket of RATE_LIMIT_BUCKETS) {
    const policy = (value as Record<string, unknown>)[bucket] as Partial<RateLimitPolicy> | undefined;
    if (!isPositiveInt(policy?.limit) || !isPositiveInt(policy?.period)) return undefined;
    out[bucket] = { limit: policy.limit, period: policy.period };
  }
  return out;
}

const isPositiveInt = (n: unknown): n is number => Number.isInteger(n) && (n as number) > 0;

/**
 * The cookies that ARE a signed-in browser's credential: the platform session (oidc-rp's
 * `sb_session`), a capability session (`sb_capability`, one cookie per link since #1686), and
 * Better Auth's session token on an instance using that provider. Any other cookie — a
 * preference, an analytics id — says nothing about who is calling and is ignored.
 */
export function isSessionCookie(name: string): boolean {
  return (
    name === 'sb_session' ||
    name.startsWith('sb_capability') ||
    name === 'better-auth.session_token' ||
    name === '__Secure-better-auth.session_token'
  );
}

/** What a request offers to be counted by. Header values are read, never kept. */
export interface RateLimitSubject {
  readonly tenantId: string;
  readonly scopeId: string;
  readonly headers: Headers;
  /** The client address, when the host knows one. Absent ⇒ one shared anonymous budget. */
  readonly clientIp?: string | null | undefined;
  /** The request method. An `OPTIONS` preflight is never counted (see {@link evaluateRateLimits}). */
  readonly method?: string;
}

/**
 * The key one request is counted under in one bucket. Async because a credential is hashed
 * (Web Crypto) before it goes anywhere — and only when the credential bucket is counted.
 */
export async function rateLimitKey(bucket: RateLimitBucket, subject: RateLimitSubject): Promise<string> {
  const address = subject.clientIp ? `ip:${subject.clientIp}` : 'anon';
  const caller = bucket === 'credential' ? ((await credentialOf(subject.headers)) ?? address) : address;
  return `${subject.tenantId}:${subject.scopeId}:${bucket}:${caller}`;
}

/**
 * The caller's credential as a digest: `b:` for a bearer, `s:` for a session cookie set.
 * Every session cookie the request carries is hashed together, sorted, so a browser holding
 * a stale host-only `sb_session` beside its domain one is still one caller.
 */
async function credentialOf(headers: Headers): Promise<string | undefined> {
  const authorization = headers.get('authorization');
  if (authorization) return `b:${await digest(authorization)}`;
  const session = sessionCookiesOf(headers.get('cookie'));
  if (session.length > 0) return `s:${await digest(session.join('\n'))}`;
  return undefined;
}

function sessionCookiesOf(header: string | null): string[] {
  if (!header) return [];
  const out: string[] = [];
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const name = part.slice(0, eq).trim();
    if (isSessionCookie(name)) out.push(`${name}=${part.slice(eq + 1).trim()}`);
  }
  return out.sort();
}

/** 128 bits of SHA-256, hex: unguessable, and short enough to be a counter key. */
async function digest(text: string): Promise<string> {
  const bytes = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
  let hex = '';
  for (const b of bytes.subarray(0, 16)) hex += b.toString(16).padStart(2, '0');
  return hex;
}

/** A 429, as the parts a host's own `Response` is built from. */
export interface RateLimitedRefusal {
  readonly status: 429;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Problem;
}

/** What one request's count decided, for the host to answer and log. */
export interface RateLimitEvaluation {
  /** The 429 to answer instead of serving the request, when a bucket refused it. */
  readonly refusal?: RateLimitedRefusal;
  /** `RateLimit-Policy` for the response the request goes on to get; null when nothing counted it. */
  readonly policyHeader: string | null;
  /**
   * Set when a counter threw and the request was let through anyway (fail open): the fields of
   * the host's `rate-limit-unavailable` log line. Never a key — even a digest has no business
   * in a log line.
   */
  readonly unavailable?: { readonly reason: string; readonly buckets: RateLimitBucket[]; readonly error: string[] };
}

/**
 * Count one request in every bucket that has a counter — the whole decision both hosts make.
 *
 * Every bucket is counted, even once one refuses, so a caller over one budget still spends
 * the others: the counts stay true to the traffic rather than to the order the buckets were
 * asked in. The refusal names the first bucket (in `RATE_LIMIT_BUCKETS` order) that refused.
 */
export async function evaluateRateLimits(input: {
  readonly subject: RateLimitSubject;
  readonly policies: Readonly<Record<RateLimitBucket, RateLimitPolicy>>;
  readonly limiters: Readonly<Partial<Record<RateLimitBucket, RateLimiter>>>;
  /** The request path, for the problem's `instance`. */
  readonly instance?: string;
}): Promise<RateLimitEvaluation> {
  // A CORS preflight is never counted, so never refused: a refused preflight is opaque to the
  // page whatever headers it carries, so the page could not read the 429 its real request
  // would have met. It reaches the vertical's own preflight handler instead.
  if (input.subject.method === 'OPTIONS') return { policyHeader: null };
  const buckets = RATE_LIMIT_BUCKETS.filter((bucket) => input.limiters[bucket]);
  if (buckets.length === 0) return { policyHeader: null };
  const results = await Promise.all(
    buckets.map(async (bucket) => {
      try {
        const key = await rateLimitKey(bucket, input.subject);
        return { bucket, success: (await input.limiters[bucket]!.limit({ key })).success };
      } catch (error) {
        return { bucket, success: true, error: error instanceof Error ? error.message : String(error) };
      }
    }),
  );
  const policyHeader = buckets
    .map((bucket) => `"${bucket}";q=${input.policies[bucket].limit};w=${input.policies[bucket].period}`)
    .join(', ');
  const failed = results.filter((r) => r.error !== undefined);
  const unavailable =
    failed.length > 0
      ? {
          reason: 'the rate limiter threw; the request was let through',
          buckets: failed.map((r) => r.bucket),
          error: failed.map((r) => r.error!),
        }
      : undefined;
  const refused = results.find((r) => !r.success)?.bucket;
  return {
    policyHeader,
    ...(unavailable ? { unavailable } : {}),
    ...(refused
      ? {
          refusal: refusalFor(refused, input.policies[refused], policyHeader, {
            instance: input.instance,
            origin: input.subject.headers.get('origin'),
          }),
        }
      : {}),
  };
}

/**
 * The refusal: 429 `application/problem+json` with code `rate_limited`, and the headers a
 * client backs off by. Parts rather than a `Response`, as the rest of this package hands out
 * data: each host builds its own.
 *
 * `Retry-After` is the bucket's whole period. A counter that cannot say where in its window
 * a key sits (Cloudflare's binding cannot) makes the period the only bound that is never
 * too short, and a retry that is too early is just another 429.
 */
function refusalFor(
  bucket: RateLimitBucket,
  policy: RateLimitPolicy,
  policyHeader: string,
  { instance, origin }: { instance: string | undefined; origin: string | null },
): RateLimitedRefusal {
  const retryAfter = policy.period;
  const body = toProblem(
    substratError(
      'rate_limited',
      `Too many requests for this ${bucket === 'ip' ? 'client address' : 'credential'}: ` +
        `at most ${policy.limit} every ${policy.period} seconds. Retry after ${retryAfter} seconds.`,
      { retryAfter },
    ),
    instance,
  );
  return {
    status: 429,
    headers: {
      'content-type': PROBLEM_CONTENT_TYPE,
      [RETRY_AFTER_HEADER]: String(retryAfter),
      [RATE_LIMIT_POLICY_HEADER]: policyHeader,
      [RATE_LIMIT_HEADER]: `"${bucket}";r=0;t=${retryAfter}`,
      ...(origin ? refusalCors(origin) : {}),
    },
    body,
  };
}

/**
 * CORS for the refusal, and only for it.
 *
 * A refusal is answered before the vertical runs, so the vertical's own CORS policy never
 * sees it. Without these headers a cross-origin page reads a network error rather than a
 * 429, and cannot back off by `Retry-After` — the polling loop this exists to stop keeps
 * polling. The route names no origin allowlist to follow, so the refusal reflects whichever
 * origin asked, credentials included.
 *
 * That is safe for THIS response and would not be for any other: the body and headers are
 * the requester's own rate state — the budget that refused and when to retry — and no vertical
 * data, which is why the policy is built here and never applied to a response the vertical
 * gave.
 */
function refusalCors(origin: string): Record<string, string> {
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-credentials': 'true',
    'access-control-expose-headers': RATE_LIMIT_EXPOSED_HEADERS.join(', '),
    vary: 'Origin',
  };
}
