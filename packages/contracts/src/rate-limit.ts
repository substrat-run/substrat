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
 * the same problem. This file is that grammar and nothing else: which counter remembers a
 * key is the caller's ({@link RateLimiter}), so the router binds Cloudflare's native
 * rate-limit binding and a node host binds `memoryRateLimiter`, and the two cannot disagree
 * about what a key or a 429 looks like.
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
export const RATE_LIMIT_EXPOSED_HEADERS = [RETRY_AFTER_HEADER, RATE_LIMIT_POLICY_HEADER, RATE_LIMIT_HEADER] as const;

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
export function parseRateLimits(raw: unknown): Record<RateLimitBucket, RateLimitPolicy> | undefined {
  const value = typeof raw === 'string' ? safeJson(raw) : raw;
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

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

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
}

/**
 * The key per bucket for one request. Async because a credential is hashed (Web Crypto)
 * before it goes anywhere.
 */
export async function rateLimitKeys(subject: RateLimitSubject): Promise<Record<RateLimitBucket, string>> {
  const prefix = `${subject.tenantId}:${subject.scopeId}`;
  const address = subject.clientIp ? `ip:${subject.clientIp}` : 'anon';
  const credential = await credentialOf(subject.headers);
  return {
    credential: `${prefix}:credential:${credential ?? address}`,
    ip: `${prefix}:ip:${address}`,
  };
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

/** One bucket to count a request in: its budget, its counter, and the request's key. */
export interface RateLimitCheck {
  readonly bucket: RateLimitBucket;
  readonly policy: RateLimitPolicy;
  readonly limiter: RateLimiter;
  readonly key: string;
}

export type RateLimitVerdict =
  | { readonly outcome: 'allowed'; readonly failures: readonly RateLimitFailure[] }
  | { readonly outcome: 'limited'; readonly refused: RateLimitCheck; readonly failures: readonly RateLimitFailure[] };

/** A counter that could not answer — counted as a pass (fail open), and reported for a log line. */
export interface RateLimitFailure {
  readonly bucket: RateLimitBucket;
  readonly error: unknown;
}

/**
 * Count a request in every bucket. All of them are counted, even once one refuses, so a
 * caller that is over one budget still spends the others: the counts stay true to the
 * traffic rather than to the order the buckets were asked in. The verdict names the first
 * bucket (in `checks` order) that refused.
 */
export async function checkRateLimits(checks: readonly RateLimitCheck[]): Promise<RateLimitVerdict> {
  const results = await Promise.all(
    checks.map(async (check) => {
      try {
        return { check, success: (await check.limiter.limit({ key: check.key })).success };
      } catch (error) {
        return { check, success: true, error };
      }
    }),
  );
  const failures = results.flatMap((r) => ('error' in r ? [{ bucket: r.check.bucket, error: r.error }] : []));
  const refused = results.find((r) => !r.success)?.check;
  return refused ? { outcome: 'limited', refused, failures } : { outcome: 'allowed', failures };
}

/** `"credential";q=1200;w=60, "ip";q=6000;w=60` — every policy a response was judged against. */
export function rateLimitPolicyHeader(policies: Partial<Record<RateLimitBucket, RateLimitPolicy>>): string {
  return RATE_LIMIT_BUCKETS.flatMap((bucket) => {
    const p = policies[bucket];
    return p ? [`"${bucket}";q=${p.limit};w=${p.period}`] : [];
  }).join(', ');
}

/** A 429, as the parts a host's own `Response` is built from. */
export interface RateLimitedRefusal {
  readonly status: 429;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Problem;
}

/**
 * The refusal: 429 `application/problem+json` with code `rate_limited`, and the headers a
 * client backs off by. Parts rather than a `Response`, as the rest of this package hands
 * out data: each host builds its own.
 *
 * `Retry-After` is the bucket's whole period. A counter that cannot say where in its window
 * a key sits (Cloudflare's binding cannot) makes the period the only bound that is never
 * too short, and a retry that is too early is just another 429.
 */
export function rateLimitedRefusal(
  refused: { bucket: RateLimitBucket; policy: RateLimitPolicy },
  policies: Partial<Record<RateLimitBucket, RateLimitPolicy>>,
  instance?: string,
): RateLimitedRefusal {
  const retryAfter = refused.policy.period;
  const body = toProblem(
    substratError(
      'rate_limited',
      `Too many requests for this ${refused.bucket === 'ip' ? 'client address' : 'credential'}: ` +
        `at most ${refused.policy.limit} every ${refused.policy.period} seconds. Retry after ${retryAfter} seconds.`,
      { retryAfter },
    ),
    instance,
  );
  return {
    status: 429,
    headers: {
      'content-type': PROBLEM_CONTENT_TYPE,
      [RETRY_AFTER_HEADER]: String(retryAfter),
      [RATE_LIMIT_POLICY_HEADER]: rateLimitPolicyHeader(policies),
      [RATE_LIMIT_HEADER]: `"${refused.bucket}";r=0;t=${retryAfter}`,
    },
    body,
  };
}

/**
 * A fixed-window counter in this process's memory — the {@link RateLimiter} for a node host
 * with no router in front.
 *
 * Exact for ONE process. Several replicas behind a balancer each count their own share, so
 * the effective budget is the limit times the replica count; a deployment like that wants a
 * shared counter behind the same interface. Expired windows are swept as keys are touched,
 * so memory is bounded by the keys seen in one period.
 */
export function memoryRateLimiter(policy: RateLimitPolicy, now: () => number = Date.now): RateLimiter {
  const windows = new Map<string, { start: number; count: number }>();
  const periodMs = policy.period * 1000;
  let lastSweep = now();
  return {
    async limit({ key }) {
      const t = now();
      if (t - lastSweep >= periodMs) {
        for (const [k, w] of windows) if (t - w.start >= periodMs) windows.delete(k);
        lastSweep = t;
      }
      let w = windows.get(key);
      if (!w || t - w.start >= periodMs) {
        w = { start: t, count: 0 };
        windows.set(key, w);
      }
      w.count += 1;
      return { success: w.count <= policy.limit };
    },
  };
}
