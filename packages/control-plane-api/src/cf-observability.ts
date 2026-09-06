import type { ObservabilityReader, ObservedEgressRow } from './observability.js';

/**
 * The Cloudflare implementation of the observability seam (`observability.ts`) —
 * GraphQL invocation analytics + the Workers Observability telemetry query API,
 * mapped into the seam's neutral vocabulary (service ← scriptName, namespace ←
 * dispatchNamespaceName). Pure web-standard `fetch`, like the WfP uploader in
 * `wfp.ts`: no Cloudflare SDK, no node built-ins, so it runs in a Worker or in
 * node unchanged. The credential stays platform-held (D-34); callers only ever see
 * the narrowed JSON the seam returns.
 */
export interface CfObservabilityOptions {
  accountId: string;
  /**
   * A Cloudflare API token with Account Analytics read (the GraphQL invocations
   * dataset) and Workers Observability read (the telemetry query API). Deliberately
   * the same env slot as the WfP token in practice — one platform credential whose
   * permissions grow with the platform's needs — but nothing here assumes that.
   */
  apiToken: string;
}

const GRAPHQL_URL = 'https://api.cloudflare.com/client/v4/graphql';

/**
 * The same dataset Cloudflare's own Workers "Metrics" tab reads —
 * `workersInvocationsAdaptive`, grouped by script (and dispatch namespace, so pushed
 * verticals are distinguishable from platform workers). Adaptive sampling makes the
 * numbers approximate at high volume; that is the Tier-3 contract (master-plan §5.3):
 * ops metrics, never money, never shown to customers as a count.
 */
const METRICS_QUERY = `
  query ScriptMetrics($accountTag: String!, $datetimeGeq: Time!, $datetimeLeq: Time!) {
    viewer {
      accounts(filter: { accountTag: $accountTag }) {
        workersInvocationsAdaptive(
          limit: 500
          filter: { datetime_geq: $datetimeGeq, datetime_leq: $datetimeLeq }
        ) {
          sum { requests errors subrequests }
          quantiles { cpuTimeP50 cpuTimeP99 }
          dimensions { scriptName dispatchNamespaceName }
        }
      }
    }
  }
`;

export function createCfObservabilityReader(opts: CfObservabilityOptions): ObservabilityReader {
  const authed = (url: string, body: unknown) =>
    fetch(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${opts.apiToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });

  return {
    async serviceMetrics({ hours }) {
      const to = new Date();
      const from = new Date(to.getTime() - hours * 3_600_000);
      const res = await authed(GRAPHQL_URL, {
        query: METRICS_QUERY,
        variables: {
          accountTag: opts.accountId,
          datetimeGeq: from.toISOString(),
          datetimeLeq: to.toISOString(),
        },
      });
      const json = (await res.json()) as {
        data?: {
          viewer?: {
            accounts?: Array<{
              workersInvocationsAdaptive?: Array<{
                sum?: { requests?: number; errors?: number; subrequests?: number };
                quantiles?: { cpuTimeP50?: number; cpuTimeP99?: number };
                dimensions?: { scriptName?: string; dispatchNamespaceName?: string };
              }>;
            }>;
          };
        };
        errors?: Array<{ message?: string }>;
      };
      if (!res.ok || json.errors?.length) {
        const message = json.errors?.map((e) => e.message).join('; ') || `HTTP ${res.status}`;
        throw new Error(`Cloudflare analytics query failed: ${message}`);
      }
      const groups = json.data?.viewer?.accounts?.[0]?.workersInvocationsAdaptive ?? [];
      return groups
        .map((g) => ({
          service: g.dimensions?.scriptName ?? '(unknown)',
          namespace: g.dimensions?.dispatchNamespaceName || null,
          requests: g.sum?.requests ?? 0,
          errors: g.sum?.errors ?? 0,
          subrequests: g.sum?.subrequests ?? 0,
          cpuTimeP50: g.quantiles?.cpuTimeP50 ?? 0,
          cpuTimeP99: g.quantiles?.cpuTimeP99 ?? 0,
        }))
        .sort((a, b) => b.requests - a.requests);
    },

    async recentLogs({ services, level, search, hours, limit }) {
      // One query per service, merged newest-first: the telemetry API's filters are
      // single-valued equality, and an OR across script names is not a filter this
      // API offers. The queries are independent, so they run concurrently and the
      // merge (not the backend) enforces the overall `limit`.
      if (services && services.length > 1) {
        const pages = await Promise.all(services.map((s) => queryEvents(s, level, search, hours, limit)));
        return pages
          .flat()
          .sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0))
          .slice(0, limit);
      }
      return queryEvents(services?.[0], level, search, hours, limit);
    },

    async observedEgress({ services, hours, limit }) {
      // One query per service, like recentLogs and for the same reason: the telemetry
      // API's filters are single-valued equality, and an OR across script names is not
      // a filter it offers.
      const pages = await Promise.all(services.map((s) => querySpans(s, hours, limit)));

      // Aggregate to (service, host, origin). A vertical calling one host from both a
      // worker and a DO is TWO rows on purpose — the enforcement story differs per
      // origin (D-46 polices one and not the other), so collapsing them would hide the
      // only distinction this report exists to draw.
      const byKey = new Map<string, ObservedEgressRow>();
      let truncated = false;
      for (const page of pages) {
        if (page.truncated) truncated = true;
        for (const span of page.spans) {
          if (!span.host) continue;
          const key = `${span.service}\u0000${span.host}\u0000${span.origin}`;
          const existing = byKey.get(key);
          if (existing) {
            existing.calls += 1;
            if ((span.timestamp ?? 0) > (existing.lastSeen ?? 0)) existing.lastSeen = span.timestamp;
            existing.sampleUrl ??= span.url;
          } else {
            byKey.set(key, {
              service: span.service,
              host: span.host,
              origin: span.origin,
              calls: 1,
              lastSeen: span.timestamp,
              sampleUrl: span.url,
            });
          }
        }
      }
      return {
        rows: [...byKey.values()].sort((a, b) => b.calls - a.calls || a.host.localeCompare(b.host)),
        truncated,
        // The rate is a per-script deploy-time setting the platform holds, not something
        // the query API reports back. Saying `null` (unknown coverage) is the honest
        // answer; claiming 1 would assert every call was seen.
        samplingRate: null,
        hours,
      };
    },
  };

  /** One telemetry query — narrowed to a single service, or to none (the fleet view). */
  async function queryEvents(
    service: string | undefined,
    level: string | undefined,
    search: string | undefined,
    hours: number,
    limit: number,
  ) {
    const to = Date.now();
    const filters: Array<{ key: string; operation: string; type: string; value: string }> = [];
    // `$metadata.service` is the script name in Workers Logs events — the field
    // Cloudflare's own query examples filter on.
    if (service) {
      filters.push({ key: '$metadata.service', operation: 'eq', type: 'string', value: service });
    }
    if (level) {
      filters.push({ key: '$metadata.level', operation: 'eq', type: 'string', value: level });
    }
    if (search) {
      filters.push({ key: '$metadata.message', operation: 'includes', type: 'string', value: search });
    }
    const res = await authed(
      `https://api.cloudflare.com/client/v4/accounts/${opts.accountId}/workers/observability/telemetry/query`,
      {
        queryId: 'substrat-recent-logs',
        view: 'events',
        timeframe: { from: to - hours * 3_600_000, to },
        parameters: { datasets: ['cloudflare-workers'], filters, limit },
        limit,
      },
    );
    const json = (await res.json()) as {
      success?: boolean;
      errors?: Array<{ message?: string }>;
      result?: { events?: { events?: unknown[] } | unknown[] };
    };
    if (!res.ok || json.success === false) {
      const message = json.errors?.map((e) => e.message).join('; ') || `HTTP ${res.status}`;
      throw new Error(`Cloudflare telemetry query failed: ${message}`);
    }
    // The events view has nested the list one level deeper across API revisions —
    // accept both rather than pinning to whichever shape was current at writing.
    const outer = json.result?.events;
    const events = (Array.isArray(outer) ? outer : (outer?.events ?? [])) as Array<
      Record<string, unknown>
    >;
    const str = (v: unknown) => (typeof v === 'string' ? v : null);
    const num = (v: unknown) => (typeof v === 'number' ? v : null);
    return events.map((e) => {
      const metadata = (e['$metadata'] ?? {}) as Record<string, unknown>;
      const workers = (e['$workers'] ?? {}) as Record<string, unknown>;
      return {
        timestamp: num(e['timestamp']),
        level: str(metadata['level']),
        message: str(metadata['message']),
        service: str(metadata['service']) ?? str(workers['scriptName']),
        outcome: str(workers['outcome']),
        // `$metadata.trigger` reads like `<entrypoint>.<method>` (e.g. `default.importDump`);
        // fall back to the `$workers.event` sub-shape (`rpcMethod`) when it is absent.
        trigger:
          str(metadata['trigger']) ??
          str((workers['event'] as Record<string, unknown> | undefined)?.['rpcMethod']),
        invocation: str(workers['eventType']),
        entrypoint: str(workers['entrypoint']),
        requestId: str(metadata['requestId']) ?? str(workers['requestId']),
        cpuTimeMs: num(workers['cpuTimeMs']),
        wallTimeMs: num(workers['wallTimeMs']),
        raw: e,
      };
    });
  }

  /**
   * Outbound `fetch` spans for one service (#859).
   *
   * ## The dataset is `otel`, and getting it wrong FAILS SILENTLY
   *
   * Spans do not live in `cloudflare-workers` — logs do. Passing the wrong dataset name
   * to the telemetry query returns an **empty result with `success: true`**, never an
   * error, so a wrong dataset is indistinguishable from a vertical that called nothing.
   * Verified on TEST under #858: `view: 'traces'` with `datasets: ['cloudflare-workers']`
   * returned 0 traces after reading 41M rows over seven days, while the same query with
   * the key omitted returned 38 that were there the whole time.
   *
   * `datasets` is therefore OMITTED rather than set — that is the form the probe actually
   * confirmed, and an unverified name here buys nothing and silently returns nothing.
   *
   * ## Why the filter is `spanName = 'fetch'` and not `durable_object_subrequest`
   *
   * `durable_object_subrequest` is a decoy: it fires for the worker→DO entry hop and for
   * DO→DO stub calls, and carries no `url` or `server` attributes at all. A probe path
   * that made zero outbound requests still produced two of them (#858). Egress is `fetch`
   * spans; the DO-vs-worker distinction comes from the span's own attributes, below.
   */
  async function querySpans(service: string, hours: number, limit: number) {
    const to = Date.now();
    const res = await authed(
      `https://api.cloudflare.com/client/v4/accounts/${opts.accountId}/workers/observability/telemetry/query`,
      {
        queryId: 'substrat-observed-egress',
        view: 'events',
        timeframe: { from: to - hours * 3_600_000, to },
        parameters: {
          filters: [
            { key: '$metadata.service', operation: 'eq', type: 'string', value: service },
            { key: '$metadata.spanName', operation: 'eq', type: 'string', value: 'fetch' },
          ],
          limit,
        },
        limit,
      },
    );
    const json = (await res.json()) as {
      success?: boolean;
      errors?: Array<{ message?: string }>;
      result?: { events?: { events?: unknown[] } | unknown[] };
    };
    if (!res.ok || json.success === false) {
      const message = json.errors?.map((e) => e.message).join('; ') || `HTTP ${res.status}`;
      throw new Error(`Cloudflare span query failed: ${message}`);
    }
    const outer = json.result?.events;
    const events = (Array.isArray(outer) ? outer : (outer?.events ?? [])) as Array<
      Record<string, unknown>
    >;
    const spans = events.map((e) => {
      const source = (e['source'] ?? {}) as Record<string, unknown>;
      const metadata = (e['$metadata'] ?? {}) as Record<string, unknown>;
      const cf = (source['cloudflare'] ?? {}) as Record<string, unknown>;
      const server = (source['server'] ?? {}) as Record<string, unknown>;
      const url = (source['url'] ?? {}) as Record<string, unknown>;
      const full = typeof url['full'] === 'string' ? (url['full'] as string) : null;
      // `server.address` is the destination host; fall back to parsing the URL rather
      // than dropping the row, since a host we cannot name is exactly the row an
      // undeclared-egress report must not lose.
      const address = typeof server['address'] === 'string' ? (server['address'] as string) : null;
      const host = (address || hostOf(full))?.toLowerCase() || null;
      return {
        service: (typeof metadata['service'] === 'string' ? metadata['service'] : null) ?? service,
        host,
        // A `durable_object` block on the span is the DO signal — the attribute the
        // outbound worker's blind spot is defined by. `entrypoint` alone is not enough:
        // a worker-context fetch can carry one too.
        origin: cf['durable_object']
          ? ('durable-object' as const)
          : cf['script_name']
            ? ('worker' as const)
            : ('unknown' as const),
        url: full,
        timestamp: typeof e['timestamp'] === 'number' ? (e['timestamp'] as number) : null,
      };
    });
    // Row-cap detection: a full page means there may be more. Reported rather than
    // swallowed — an egress report that silently drops hosts is worse than none (#859).
    return { spans, truncated: events.length >= limit };
  }
}

/** The hostname of a URL, or null when it does not parse — never throws into a report. */
function hostOf(full: string | null): string | null {
  if (!full) return null;
  try {
    return new URL(full).hostname;
  } catch {
    return null;
  }
}
