import type {
  ObservabilityReader,
  ObservedEgressRow,
  RecentLogEvent,
  TenantMetricsRow,
} from './observability.js';

/**
 * Caps on the tenant-log correlation walk (`queryTenantLogs`).
 *
 * Phase two is one query per invocation, so an uncapped walk turns a busy tenant's log
 * page into hundreds of backend queries. These bound it: at most this many invocations
 * are expanded, and at most this many lines are taken from each. The consequence is
 * under-reporting on a very busy window — a tenant sees a recent slice rather than every
 * line — which is the right direction to fail, since the alternative is a page that times
 * out and shows nothing.
 */
const MAX_CORRELATED_INVOCATIONS = 40;
const MAX_LINES_PER_INVOCATION = 20;

/**
 * One backend event → the seam's neutral `RecentLogEvent`.
 *
 * Shared by the service-grain and tenant-grain readers so a field learned in one is not
 * missing from the other: they query different filters over the same dataset, and the
 * projection is the part that has nothing to do with which filter asked.
 */
function projectEvent(e: Record<string, unknown>): RecentLogEvent {
  const str = (v: unknown) => (typeof v === 'string' ? v : null);
  const num = (v: unknown) => (typeof v === 'number' ? v : null);
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
}

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

/**
 * The same dataset with a TIME dimension (#1236). Cloudflare exposes fixed bucket
 * dimensions rather than an arbitrary interval, so the width is chosen from the
 * window and reported back on every row — a renderer must never infer spacing
 * from the gaps between the rows it happens to receive, because an empty bucket
 * is omitted, not zero-filled (the caller zero-fills; see `bucketMinutes`).
 */
/**
 * The row ceiling Cloudflare's GraphQL will answer in one page. A bucketed read is
 * scripts × buckets, so this is a real edge and not a theoretical one — and hitting it
 * is the WORST failure the series has, because `orderBy` is ascending: the rows that get
 * cut are the newest ones, and the caller's zero-fill then draws the missing tail as an
 * outage. So the read batches to stay under it, and refuses outright if a batch still
 * saturates — `available: false` is a true answer, a fabricated outage is not.
 */
const SERIES_ROW_LIMIT = 5000;

function seriesQuery(dimension: 'datetimeFifteenMinutes' | 'datetimeHour'): string {
  return `
  query ScriptMetricsSeries($accountTag: String!, $datetimeGeq: Time!, $datetimeLeq: Time!, $scripts: [String!]) {
    viewer {
      accounts(filter: { accountTag: $accountTag }) {
        workersInvocationsAdaptive(
          limit: ${SERIES_ROW_LIMIT}
          filter: { datetime_geq: $datetimeGeq, datetime_leq: $datetimeLeq, scriptName_in: $scripts }
          orderBy: [${dimension}_ASC]
        ) {
          sum { requests errors }
          dimensions { scriptName dispatchNamespaceName ${dimension} }
        }
      }
    }
  }
`;
}

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

    async serviceMetricsSeries({ hours, services }) {
      // Fixed-width buckets, chosen so a window is legible rather than dense: a
      // few hours wants quarter-hours, a day or three wants hours.
      const bucketMinutes = hours <= 6 ? 15 : 60;
      const dimension = bucketMinutes === 15 ? 'datetimeFifteenMinutes' : 'datetimeHour';
      const to = new Date();
      const from = new Date(to.getTime() - hours * 3_600_000);

      // A script answers at most one row per bucket in the window, so the window's
      // bucket count is the per-script row ceiling — which turns the page limit into
      // a batch size. `null` is "every script": the GraphQL filter omits an unset
      // list, and the fleet view legitimately wants all of them, which is also the
      // one case that cannot be batched and so leans on the saturation check below.
      const bucketsInWindow = Math.ceil((hours * 60) / bucketMinutes) + 1;
      // STRICTLY under the ceiling, not up to it: at `SERIES_ROW_LIMIT / buckets` a batch
      // whose every script filled every bucket returns exactly the limit, which the
      // saturation check below cannot tell from a truncated page — so a complete series
      // would be refused as unavailable. One row of headroom removes the ambiguity.
      const perBatch = Math.max(1, Math.floor((SERIES_ROW_LIMIT - 1) / bucketsInWindow));
      const wanted = services && services.length > 0 ? services : null;
      const batches: Array<string[] | null> = [];
      if (wanted === null) batches.push(null);
      else for (let i = 0; i < wanted.length; i += perBatch) batches.push(wanted.slice(i, i + perBatch));

      const pages = await Promise.all(
        batches.map(async (scripts) => {
          const res = await authed(GRAPHQL_URL, {
            query: seriesQuery(dimension),
            variables: {
              accountTag: opts.accountId,
              datetimeGeq: from.toISOString(),
              datetimeLeq: to.toISOString(),
              scripts,
            },
          });
          const json = (await res.json()) as {
            data?: {
              viewer?: {
                accounts?: Array<{
                  workersInvocationsAdaptive?: Array<{
                    sum?: { requests?: number; errors?: number };
                    dimensions?: Record<string, string | undefined>;
                  }>;
                }>;
              };
            };
            errors?: Array<{ message?: string }>;
          };
          if (!res.ok || json.errors?.length) {
            const message = json.errors?.map((e) => e.message).join('; ') || `HTTP ${res.status}`;
            throw new Error(`Cloudflare analytics series query failed: ${message}`);
          }
          const rows = json.data?.viewer?.accounts?.[0]?.workersInvocationsAdaptive ?? [];
          // At the ceiling the answer is a PREFIX, and the newest buckets are the ones
          // missing — a silent truncation the caller would zero-fill into an outage.
          // Refusing hands it `available: false`, which is the honest answer.
          if (rows.length >= SERIES_ROW_LIMIT) {
            throw new Error(
              `Cloudflare analytics series query saturated at ${SERIES_ROW_LIMIT} rows: the answer would be a partial prefix, not a series`,
            );
          }
          return rows;
        }),
      );

      const groups = pages.flat();
      return groups.flatMap((g) => {
        const start = g.dimensions?.[dimension];
        // A row with no bucket instant cannot be placed on an axis — dropping it
        // beats plotting it at an invented time.
        if (start === undefined) return [];
        return [
          {
            service: g.dimensions?.scriptName ?? '(unknown)',
            namespace: g.dimensions?.dispatchNamespaceName || null,
            // Cloudflare answers these without a zone designator; the axis is UTC.
            start: start.endsWith('Z') ? start : `${start}Z`,
            bucketMinutes,
            requests: g.sum?.requests ?? 0,
            errors: g.sum?.errors ?? 0,
          },
        ];
      });
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

    async tenantMetrics(input) {
      return queryTenantMetrics(input);
    },

    async tenantLogs(input) {
      return queryTenantLogs(input);
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

  /**
   * One Analytics Engine SQL read — the tenant grain (§4.2).
   *
   * ## Why this is a different API from everything else in this file
   *
   * Cloudflare records invocations per SCRIPT, and a script serves every tenant that
   * installed the vertical, so no amount of filtering on the GraphQL dataset can produce
   * a per-tenant number. The tenant dimension exists only because the router writes it:
   * one datapoint per dispatched request into the `substrat_router` dataset, `index1` =
   * the tenant. That dataset is read with SQL, not GraphQL — hence a third endpoint.
   *
   * ## Counts are sampling-weighted, and `count()` would be a silent lie
   *
   * Analytics Engine head-samples under load and reports the weight of each surviving
   * row in `_sample_interval`. A row that stood for 40 requests arrives once with
   * `_sample_interval = 40`. So `sum(_sample_interval)` is the request count and
   * `count()` is the number of rows that survived sampling — which at low volume are
   * equal, and at exactly the volume anyone cares about are not. The failure is silent
   * and in the flattering direction: a busy tenant reads quiet.
   *
   * The same reasoning governs the quantiles: `quantileWeighted(q)(value, weight)`, not
   * `quantile(q)(value)`, or the surviving rows are each counted once regardless of how
   * many requests they stand for.
   */
  async function queryTenantMetrics(input: {
    tenantId: string;
    scopeId?: string;
    vertical?: string;
    hours: number;
  }): Promise<TenantMetricsRow[]> {
    // The tenant is bound, never interpolated: this is SQL built in a string, and the
    // value arrives from a session. Ids are opaque ULIDs, so the escape is a whitelist
    // rather than a quote-doubling dance — anything that is not ULID-shaped is not an
    // id and has no business reaching the query.
    const literal = (v: string) => {
      if (!/^[A-Za-z0-9_\-./]{1,128}$/.test(v)) {
        throw new Error('observability: refusing a dimension value with unexpected characters');
      }
      return `'${v}'`;
    };
    const where = [
      `index1 = ${literal(input.tenantId)}`,
      `timestamp > now() - INTERVAL '${Math.max(1, Math.floor(input.hours))}' HOUR`,
    ];
    if (input.scopeId) where.push(`blob2 = ${literal(input.scopeId)}`);
    if (input.vertical) where.push(`blob1 = ${literal(input.vertical)}`);

    // Blob/double positions are the router's published shape (`apps/router/src/worker.ts`
    // `record`): index1 tenant; blob1 vertical, blob2 scope, blob3 surface, blob4 status
    // class; double1 duration ms, double2 status. That shape only ever grows, never
    // reorders — which is what lets these ordinals be written down here at all.
    const sql = `
      SELECT
        blob2 AS scopeId,
        blob1 AS vertical,
        blob3 AS surface,
        sum(_sample_interval) AS requests,
        sum(if(blob4 = '5xx', _sample_interval, 0)) AS errors,
        quantileWeighted(0.5)(double1, _sample_interval) AS durationP50,
        quantileWeighted(0.95)(double1, _sample_interval) AS durationP95
      FROM substrat_router
      WHERE ${where.join(' AND ')}
      GROUP BY scopeId, vertical, surface
      ORDER BY requests DESC
      LIMIT 200
      FORMAT JSON`;

    const res = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${opts.accountId}/analytics_engine/sql`,
      { method: 'POST', headers: { authorization: `Bearer ${opts.apiToken}` }, body: sql },
    );
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`Cloudflare Analytics Engine query failed: HTTP ${res.status} ${text.slice(0, 200)}`);
    }
    const json = JSON.parse(text) as { data?: Array<Record<string, unknown>> };
    // AE returns aggregate sums as STRINGS (they are 64-bit), quantiles as numbers.
    const num = (v: unknown) => (typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : 0);
    const str = (v: unknown) => (typeof v === 'string' && v !== '' ? v : null);
    return (json.data ?? []).map((r) => ({
      scopeId: String(r['scopeId'] ?? ''),
      vertical: str(r['vertical']),
      surface: str(r['surface']),
      requests: num(r['requests']),
      errors: num(r['errors']),
      durationP50: num(r['durationP50']),
      durationP95: num(r['durationP95']),
    }));
  }

  /**
   * One tenant's log events, in two phases (§4.3).
   *
   * ## Why two phases and not one filter
   *
   * The stamped invocation line carries `tenantId`, so phase one finds it with a single
   * equality filter — Workers Logs indexes a `JSON.stringify`ed `console.log` as
   * queryable TOP-LEVEL fields, so the key is `tenantId`, not `$metadata.tenantId` nor
   * `source.tenantId`. (Verified against the live API. A filter on a key that does not
   * exist returns `success: true` with zero events, so the wrong spelling here is
   * indistinguishable from a tenant with no traffic — the same silent-empty trap the
   * `otel` dataset sets for `observedEgress` below.)
   *
   * But a vertical's OWN output — the exception, the `console.log` inside a handler —
   * carries no tenant at all. Those lines are reachable only by correlation: every line
   * emitted during one invocation shares `$metadata.requestId`. So phase two takes the
   * request ids phase one found and fetches everything sharing them.
   *
   * The router's own lines are deliberately EXCLUDED. They carry the right tenant and
   * would pass the filter, but they are the router's access log for every vertical that
   * tenant runs, and mixing them into one app's log view answers a question nobody asked
   * while burying the app's own output.
   */
  async function queryTenantLogs(input: {
    tenantId: string;
    scopeId?: string;
    vertical?: string;
    level?: string;
    search?: string;
    hours: number;
    limit: number;
  }): Promise<RecentLogEvent[]> {
    const base = [
      { key: 'tenantId', operation: 'eq', type: 'string', value: input.tenantId },
      { key: 'substrat', operation: 'eq', type: 'string', value: 'invocation' },
    ];
    if (input.scopeId) base.push({ key: 'scopeId', operation: 'eq', type: 'string', value: input.scopeId });
    if (input.vertical) base.push({ key: 'vertical', operation: 'eq', type: 'string', value: input.vertical });

    // Phase one: the stamped lines. Over-fetched relative to `limit`, because each one
    // may pull siblings in phase two and the cap belongs on the merged answer.
    const stamped = await queryRaw(base, input.hours, Math.min(input.limit * 2, 200));
    if (stamped.length === 0) return [];

    // Phase two: everything sharing those invocations. One query per request id — the
    // telemetry API's filters are single-valued equality, the same constraint
    // `recentLogs` batches around — so this is capped rather than unbounded.
    const requestIds = [
      ...new Set(
        stamped
          .map((e) => idOf(e))
          .filter((id): id is string => typeof id === 'string' && id !== ''),
      ),
    ].slice(0, MAX_CORRELATED_INVOCATIONS);
    const sibling = await Promise.all(
      requestIds.map((id) =>
        queryRaw(
          [{ key: '$metadata.requestId', operation: 'eq', type: 'string', value: id }],
          input.hours,
          MAX_LINES_PER_INVOCATION,
        ),
      ),
    );

    // Merge, de-duplicate, drop the router's own access log, then apply the caller's
    // level/search filters HERE rather than in phase one — a filter pushed into phase one
    // would have hidden the stamped line whose request id is the only way to reach the
    // line the caller is actually looking for.
    const byId = new Map<string, Record<string, unknown>>();
    for (const e of [...stamped, ...sibling.flat()]) {
      const source = (e['source'] ?? {}) as Record<string, unknown>;
      if (source['router'] === 'request') continue;
      const metadata = (e['$metadata'] ?? {}) as Record<string, unknown>;
      const id = typeof metadata['id'] === 'string' ? metadata['id'] : JSON.stringify(e);
      byId.set(id, e);
    }
    const level = input.level?.toLowerCase();
    const search = input.search;
    return [...byId.values()]
      .map((e) => projectEvent(e))
      .filter((e) => (level ? e.level?.toLowerCase() === level : true))
      .filter((e) => (search ? (e.message ?? '').includes(search) : true))
      .sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0))
      .slice(0, input.limit);
  }

  /** `$metadata.requestId`, the key every line of one invocation shares. */
  function idOf(e: Record<string, unknown>): string | null {
    const metadata = (e['$metadata'] ?? {}) as Record<string, unknown>;
    const workers = (e['$workers'] ?? {}) as Record<string, unknown>;
    const from = metadata['requestId'] ?? workers['requestId'];
    return typeof from === 'string' ? from : null;
  }

  /** A telemetry `events` query returning the raw events, filters passed through. */
  async function queryRaw(
    filters: Array<{ key: string; operation: string; type: string; value: string }>,
    hours: number,
    limit: number,
  ): Promise<Array<Record<string, unknown>>> {
    const to = Date.now();
    const res = await authed(
      `https://api.cloudflare.com/client/v4/accounts/${opts.accountId}/workers/observability/telemetry/query`,
      {
        queryId: 'substrat-tenant-logs',
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
    const outer = json.result?.events;
    return (Array.isArray(outer) ? outer : (outer?.events ?? [])) as Array<Record<string, unknown>>;
  }

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
    return events.map((e) => projectEvent(e));
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
