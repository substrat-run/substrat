import type { CloudflareUsageDay } from '@substrat-run/contracts';

/**
 * One closed UTC day of Workers observability volume (#3358): the log lines and spans each script
 * wrote, and their stored size, for the daily cost rollup to attribute.
 *
 * Cloudflare bills observability per GB for the whole account (from 2026-12-01: ingestion measured
 * as the uncompressed event with the attributes it adds), never per tenant, so the volume has to be
 * measured here before it can be charged to anyone. Two `calculations` reads of the telemetry query:
 *
 * - **Logs**, dataset `cloudflare-workers`, grouped by script, `tenantId` and `scopeId`: the stamped
 *   request line a vertical writes carries both (observability.md §4.3), so an installation's lines
 *   are counted apart from the other tenants' on the same script. A line naming neither is grouped
 *   under no tenant.
 * - **Spans**, dataset `otel` (where #858 found them), grouped by script alone: a span carries no
 *   tenant.
 *
 * Each group answers a `count` and a `sum` of `$metadata.eventSize` ("size of the stored telemetry
 * event in bytes"). Both are weighted by the sample interval, as the API weights them. A group
 * whose size came back absent keeps its count and a null `bytes`, so an unmeasured size is never
 * recorded as zero bytes.
 *
 * An answer holding as many groups as it may is split in two by time and each half read, since the
 * figures are sums and halves add; a timed-out answer is split the same way. A span of
 * `MIN_SPLIT_MS` that is still full cannot be read whole, and the day is answered without
 * observability (`saturated`), never with a part of it. Any other failure, and a timeout at that
 * span, throws, so the cost day is read again later; once the day leaves the telemetry's retention
 * it is read without observability and the rest of its rows land.
 */
export const OBSERVABILITY_GROUP_LIMIT = 2000;
/** The shortest span a full answer is split down to before the day is called saturated. */
export const OBSERVABILITY_MIN_SPLIT_MS = 3_600_000;

type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;
type Row = NonNullable<CloudflareUsageDay['observability']>[number];

interface Point {
  value?: number;
  count?: number;
  groups?: Array<{ key?: string; value?: unknown }>;
}

const SERVICE = '$metadata.service';
const TIMED_OUT = new Set([408, 504, 524]);
const SIZE = '$metadata.eventSize';

/** A group value as the text it names, or null for an absent or empty one. */
const text = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : typeof v === 'number' ? String(v) : null);
const figure = (p: Point | undefined): number | null =>
  p === undefined ? null : typeof p.value === 'number' && Number.isFinite(p.value) ? p.value : typeof p.count === 'number' ? p.count : null;

export function createObservabilityVolumeReader(opts: {
  accountId: string;
  apiToken: string;
  fetch?: FetchFn;
  /** Groups per answer; a test splits with fewer. */
  groupLimit?: number;
}): (day: string) => Promise<{ rows: Row[] } | { saturated: true }> {
  const send: FetchFn = opts.fetch ?? ((input, init) => fetch(input, init));
  const limit = opts.groupLimit ?? OBSERVABILITY_GROUP_LIMIT;
  const url = `https://api.cloudflare.com/client/v4/accounts/${opts.accountId}/workers/observability/telemetry/query`;

  /** One read: per group key, the count and the summed size. `full` when the answer may be cut. */
  const once = async (dataset: string, keys: string[], from: number, to: number) => {
    const res = await send(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${opts.apiToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        queryId: 'substrat-observability-volume',
        view: 'calculations',
        timeframe: { from, to },
        chartType: 'aggregate',
        parameters: {
          datasets: [dataset],
          filters: [],
          calculations: [
            { operator: 'count', alias: 'events' },
            { operator: 'sum', key: SIZE, keyType: 'number', alias: 'bytes' },
          ],
          groupBys: keys.map((value) => ({ type: 'string', value })),
          limit,
        },
      }),
    });
    const body = await res.text();
    // A timed-out aggregate is a span too wide to answer in time (#1877), so it splits like a full one.
    if (TIMED_OUT.has(res.status)) return { groups: new Map<string, { events: number; bytes: number | null }>(), full: true, timedOut: true };
    if (!res.ok) throw new Error(`Cloudflare telemetry query failed: HTTP ${res.status} ${body.slice(0, 200)}`);
    const json = JSON.parse(body) as {
      success?: boolean;
      errors?: Array<{ message?: string }>;
      result?: { calculations?: Array<{ alias?: string; aggregates?: Point[] }> };
    };
    if (json.success === false) {
      throw new Error(`Cloudflare telemetry query refused the read: ${json.errors?.map((e) => e.message).join('; ') || 'unknown error'}`);
    }
    const calcs = json.result?.calculations ?? [];
    // The answer names each calculation by its alias; one that matched nothing is omitted.
    const byAlias = (alias: string) => calcs.find((c) => c.alias === alias)?.aggregates ?? [];
    const keyOf = (p: Point) => JSON.stringify(keys.map((k) => text(p.groups?.find((g) => g.key === k)?.value)));
    const sizes = new Map(byAlias('bytes').map((p) => [keyOf(p), p] as const));
    const groups = new Map<string, { events: number; bytes: number | null }>();
    for (const p of byAlias('events')) {
      const events = figure(p) ?? 0;
      if (events === 0) continue;
      groups.set(keyOf(p), { events, bytes: figure(sizes.get(keyOf(p))) });
    }
    return { groups, full: byAlias('events').length >= limit, timedOut: false };
  };

  /** Every group over [from, to), split by time while an answer is full; null when it stays full. */
  const whole = async (dataset: string, keys: string[], from: number, to: number): Promise<Map<string, { events: number; bytes: number | null }> | null> => {
    const read = await once(dataset, keys, from, to);
    if (!read.full) return read.groups;
    if (to - from <= OBSERVABILITY_MIN_SPLIT_MS) {
      // Still timing out at the narrowest span is a failure to retry; still full is a fact of the day.
      if (read.timedOut) throw new Error(`Cloudflare telemetry query timed out on a ${OBSERVABILITY_MIN_SPLIT_MS / 60_000}-minute span`);
      return null;
    }
    const mid = from + Math.floor((to - from) / 2);
    const [a, b] = await Promise.all([whole(dataset, keys, from, mid), whole(dataset, keys, mid, to)]);
    if (a === null || b === null) return null;
    for (const [key, g] of b) {
      const prior = a.get(key);
      a.set(key, prior ? { events: prior.events + g.events, bytes: prior.bytes === null || g.bytes === null ? null : prior.bytes + g.bytes } : g);
    }
    return a;
  };

  return async (day) => {
    const from = Date.parse(`${day}T00:00:00.000Z`);
    if (!Number.isFinite(from)) throw new Error(`not a UTC day: ${day}`);
    const to = from + 86_400_000;
    const [logs, spans] = await Promise.all([
      whole('cloudflare-workers', [SERVICE, 'tenantId', 'scopeId'], from, to),
      whole('otel', [SERVICE], from, to),
    ]);
    if (logs === null || spans === null) return { saturated: true };
    const rows: Row[] = [];
    for (const [key, g] of logs) {
      const [script, tenantId, scopeId] = JSON.parse(key) as [string | null, string | null, string | null];
      if (script !== null) rows.push({ signal: 'logs', script, tenantId, scopeId, events: g.events, bytes: g.bytes });
    }
    for (const [key, g] of spans) {
      const [script] = JSON.parse(key) as [string | null];
      if (script !== null) rows.push({ signal: 'spans', script, tenantId: null, scopeId: null, events: g.events, bytes: g.bytes });
    }
    return { rows };
  };
}
