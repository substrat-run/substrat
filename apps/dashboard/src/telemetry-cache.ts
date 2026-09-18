/**
 * A short-lived cache in front of the telemetry reads — the ones that end in a query
 * against Cloudflare's analytics/observability APIs, which take a second or more each
 * and are what the Overview, Observability and per-app charts all open with.
 *
 * METRICS only, never logs. A chart that is a minute old reads the same; a log view is
 * where somebody looks to see what just happened, and handing them a stale page there
 * is answering a different question than the one they asked.
 *
 * Two properties this file holds, because both are easy to lose:
 *
 * 1. **The tenant is in the key, always first, and put there by this module** — a
 *    caller cannot build a key without naming whose data it is, so one tenant's series
 *    can never be served to another by a missed parameter.
 * 2. **The cache can only ever cost a hit.** A store that throws, refuses the write or
 *    returns something unparseable falls through to the live read; a read that throws
 *    caches nothing; and an empty answer (`null`/`undefined` — how several callers
 *    spell "the backend failed") is not remembered, so a blip is not pinned for a
 *    minute.
 *
 * The store is injected. In the worker it is the Cache API, which is local to one
 * Cloudflare data centre — so this is a per-colo hit rate, not a global one — and which
 * exists only for a Worker on a custom domain; anywhere else (tests, `wrangler dev`
 * without it) the store is null and every read is simply live.
 */

/** How long a telemetry answer is reused. Cloudflare's own metrics lag by about this much already. */
export const TELEMETRY_TTL_SECONDS = 60;

export interface TelemetryStore {
  match(key: string): Promise<Response | undefined>;
  put(key: string, response: Response): Promise<void>;
}

export type TelemetryCacheOutcome = 'hit' | 'miss' | 'bypass';

type Param = string | number | boolean | null | undefined | readonly string[];

/**
 * The cache key for one tenant's read. A URL, because that is what the Cache API keys
 * on — under `.invalid`, the TLD reserved never to resolve (RFC 2606), so no request
 * from outside can ever address an entry. Parameters are sorted, and a list parameter
 * is sorted too: `scopeId=a&scopeId=b` and its reverse are the same question.
 */
export function telemetryKey(tenantId: string, read: string, params: Record<string, Param>): string {
  const q = new URLSearchParams();
  for (const name of Object.keys(params).sort()) {
    const v = params[name];
    if (v === undefined || v === null) continue;
    q.set(name, Array.isArray(v) ? [...v].sort().join(',') : String(v));
  }
  return `https://telemetry-cache.invalid/${encodeURIComponent(tenantId)}/${encodeURIComponent(read)}?${q.toString()}`;
}

/**
 * `read()`, or its remembered answer. `defer` takes the write off the response path
 * (the worker hands it `waitUntil`); without one the write is awaited.
 */
export async function cachedTelemetry<T>(
  store: TelemetryStore | null,
  key: string,
  read: () => Promise<T>,
  opts: { defer?: (work: Promise<unknown>) => void; onOutcome?: (outcome: TelemetryCacheOutcome) => void } = {},
): Promise<T> {
  if (!store) {
    opts.onOutcome?.('bypass');
    return read();
  }
  try {
    const hit = await store.match(key);
    if (hit) {
      const value = (await hit.json()) as T;
      opts.onOutcome?.('hit');
      return value;
    }
  } catch {
    // An unreadable entry is a miss, not an error.
  }
  const value = await read();
  opts.onOutcome?.('miss');
  if (value !== null && value !== undefined) {
    const write = store
      .put(
        key,
        new Response(JSON.stringify(value), {
          headers: { 'content-type': 'application/json', 'cache-control': `max-age=${TELEMETRY_TTL_SECONDS}` },
        }),
      )
      .catch(() => {});
    if (opts.defer) opts.defer(write);
    else await write;
  }
  return value;
}
