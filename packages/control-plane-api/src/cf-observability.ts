import type {
  ObservabilityReader,
  ObservedEgressRow,
  RecentLogEvent,
  TenantMetricsBucket,
  ConnectorCallsBucket,
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
 * A 501 is an honest refusal, not a failure: the route exists to say "this version does
 * not declare that capability" (an undeclared owner-seat or configure hook, #1345). The
 * failure record already keeps it out (`recordOpsFailure`); the log view agrees with it.
 */
const CAPABILITY_ABSENT = 501;

/** The event is a stamped invocation line whose request FAILED. */
function isFailedInvocation(e: RecentLogEvent): boolean {
  const source = ((e.raw as Record<string, unknown>)?.['source'] ?? {}) as Record<string, unknown>;
  if (source['substrat'] !== 'invocation') return false;
  const status = source['status'];
  return (
    source['threw'] === true ||
    (typeof status === 'number' && status >= 500 && status !== CAPABILITY_ABSENT)
  );
}

/**
 * The event is a stamped invocation line belonging to the tenant (and the narrowing) that
 * was asked about — the proof an account-wide error line may be shown to this caller.
 *
 * Read off the RAW event rather than a projected one, because it runs on phase two's
 * output before anything else touches it, and the fields it reads are the ones the
 * stamped line publishes (`invocation-log.ts`). A missing or mismatched tenant is a
 * refusal, never a shrug: this predicate is the whole isolation boundary for correlated
 * lines, which carry no tenant of their own.
 */
function ownsInvocation(
  e: Record<string, unknown>,
  input: { tenantId: string; scopeId?: string; vertical?: string },
): boolean {
  const source = (e['source'] ?? {}) as Record<string, unknown>;
  if (source['substrat'] !== 'invocation') return false;
  if (source['tenantId'] !== input.tenantId) return false;
  if (input.scopeId && source['scopeId'] !== input.scopeId) return false;
  if (input.vertical && source['vertical'] !== input.vertical) return false;
  return true;
}

/**
 * Give a stamped invocation line a human message.
 *
 * Cloudflare populates `$metadata.message` for a STRING log and leaves it unset for a pure
 * JSON one, so every stamped line arrives with `message: null` and would render as a blank
 * row — which is most of the default view, since one is written per request. The fields to
 * say it with are all already on the line, so this composes them on read rather than the
 * vertical logging a redundant string: a read-side fix reaches versions that are already
 * deployed, where changing what is logged would not.
 *
 * Everything else passes through untouched — a vertical's own output already has a message,
 * and it is theirs to word.
 */
function describeInvocation(e: RecentLogEvent): RecentLogEvent {
  const source = ((e.raw as Record<string, unknown>)?.['source'] ?? {}) as Record<string, unknown>;
  if (source['substrat'] !== 'invocation') return e;
  const method = typeof source['method'] === 'string' ? source['method'] : '?';
  const path = typeof source['path'] === 'string' ? source['path'] : '?';
  const status = typeof source['status'] === 'number' ? source['status'] : null;
  const ms = typeof source['durationMs'] === 'number' ? source['durationMs'] : null;
  const outcome =
    source['threw'] === true
      ? 'threw'
      : status === CAPABILITY_ABSENT
        ? // Labelled rather than hidden: the line is still the evidence that something
          // asked, and it reads as the answer it is instead of a red error row.
          `${status} capability absent`
        : (status ?? '—');
  return {
    ...e,
    message: `${method} ${path} → ${outcome}${ms === null ? '' : ` (${ms} ms)`}`,
    // Surfaced as the level it reads as, so the list's own colouring is honest about
    // which rows are failures without the caller having to filter for them.
    level: e.level ?? (isFailedInvocation(e) ? 'error' : 'info'),
  };
}

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
  /**
   * The Analytics Engine dataset the ROUTER writes its per-request datapoints into —
   * the only place the tenant dimension exists (§4.2), and therefore the only source
   * `tenantMetrics` can read.
   *
   * Stated by the caller and defaulted NOWHERE, for the reason `DISPATCH_NAMESPACE`
   * is (#962): the environments write to different datasets (`substrat_router` in
   * production, `substrat_router_test` on TEST — `apps/router/wrangler.jsonc`), a
   * code default is inherited silently by whichever environment forgets to override
   * it, and the failure is a TEST control plane answering questions about production
   * traffic. There is no error to notice: the query succeeds and the numbers are
   * somebody else's.
   *
   * Absent ⇒ `tenantMetrics` is not exposed at all, so the route answers 501 — the
   * platform's shape for an unconfigured capability — rather than a wrong number or
   * an empty array that reads as "your app served nothing".
   */
  routerDataset?: string;
  /**
   * #1691: the Analytics Engine dataset the control plane's connector-call recorder
   * writes (`substrat_connector_calls` in production, `substrat_connector_calls_test` on
   * TEST — `apps/control-plane/wrangler.jsonc`). Stated by the caller and defaulted
   * nowhere, for `routerDataset`'s reason. Absent ⇒ `connectorCallsSeries` is not exposed
   * and the route 501s.
   */
  connectorCallsDataset?: string;
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

    // Present only when the caller named the router's dataset: with no dataset there is
    // no honest answer, and the route's 501 says so. See `routerDataset`. The bucketed
    // twin rides the same switch — it reads the same dataset, so it is exactly as
    // available as the aggregate and never more.
    ...(opts.routerDataset
      ? {
          tenantMetrics: (input: Parameters<NonNullable<ObservabilityReader['tenantMetrics']>>[0]) =>
            queryTenantMetrics(opts.routerDataset!, input),
          tenantMetricsSeries: (input: Parameters<NonNullable<ObservabilityReader['tenantMetricsSeries']>>[0]) =>
            queryTenantMetricsSeries(opts.routerDataset!, input),
        }
      : {}),

    // #1691: the same switch for the connector-call dataset — present only when named.
    ...(opts.connectorCallsDataset
      ? {
          connectorCallsSeries: (
            input: Parameters<NonNullable<ObservabilityReader['connectorCallsSeries']>>[0],
          ) => queryConnectorCallsSeries(opts.connectorCallsDataset!, input),
        }
      : {}),

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
   * one datapoint per dispatched request into the router's dataset (`substrat_router` in
   * production, `substrat_router_test` on TEST — hence `routerDataset`, named by the
   * caller), `index1` = the tenant. That dataset is read with SQL, not GraphQL — hence a
   * third endpoint.
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
  async function queryTenantMetrics(
    dataset: string,
    input: {
      tenantId: string;
      scopeId?: string;
      vertical?: string;
      hours: number;
    },
  ): Promise<TenantMetricsRow[]> {
    const where = [
      `index1 = ${aeLiteral(input.tenantId)}`,
      `timestamp > now() - INTERVAL '${Math.max(1, Math.floor(input.hours))}' HOUR`,
    ];
    if (input.scopeId) where.push(`blob2 = ${aeLiteral(input.scopeId)}`);
    if (input.vertical) where.push(`blob1 = ${aeLiteral(input.vertical)}`);

    // Blob/double positions are the router's published shape (`apps/router/src/worker.ts`
    // `record`): index1 tenant; blob1 vertical, blob2 scope, blob3 surface, blob4 status
    // class; double1 duration ms, double2 status. That shape only ever grows, never
    // reorders — which is what lets these ordinals be written down here at all. The
    // connector-call dataset's ordinals are published beside these, on
    // `queryConnectorCallsSeries` below (#1691) — a different dataset, never this one.
    const sql = `
      SELECT
        blob2 AS scopeId,
        blob1 AS vertical,
        blob3 AS surface,
        sum(_sample_interval) AS requests,
        sum(if(blob4 = '5xx', _sample_interval, 0)) AS errors,
        sum(if(blob4 = '2xx', _sample_interval, 0)) AS class2xx,
        sum(if(blob4 = '3xx', _sample_interval, 0)) AS class3xx,
        sum(if(blob4 = '4xx', _sample_interval, 0)) AS class4xx,
        quantileWeighted(0.5)(double1, _sample_interval) AS durationP50,
        quantileWeighted(0.95)(double1, _sample_interval) AS durationP95
      FROM ${aeDataset(dataset)}
      WHERE ${where.join(' AND ')}
      GROUP BY scopeId, vertical, surface
      ORDER BY requests DESC
      LIMIT 200
      FORMAT JSON`;

    const rows = await analyticsEngineSql(sql);
    const str = (v: unknown) => (typeof v === 'string' && v !== '' ? v : null);
    return rows.map((r) => ({
      scopeId: String(r['scopeId'] ?? ''),
      vertical: str(r['vertical']),
      surface: str(r['surface']),
      requests: aeNum(r['requests']),
      errors: aeNum(r['errors']),
      class2xx: aeNum(r['class2xx']),
      class3xx: aeNum(r['class3xx']),
      class4xx: aeNum(r['class4xx']),
      durationP50: aeNum(r['durationP50']),
      durationP95: aeNum(r['durationP95']),
    }));
  }

  /**
   * The tenant grain, bucketed over time (#1447) — `tenantMetrics` with a time axis.
   *
   * Same dataset, same sampling weights, same forced tenant predicate, and the same two
   * weighted quantiles as the aggregate above — per bucket here, because the chart plots
   * latency and a whole-window quantile cannot be unrolled into one — and NOT the GraphQL series `serviceMetricsSeries` reads: that dataset is keyed
   * on the script, and no filter on it can produce a per-tenant number (see
   * `queryTenantMetrics`). The time axis comes from `toStartOfInterval`, at the same two
   * widths the script-grain series uses so the two charts read alike.
   *
   * Bounded the way the script-grain series is: a scope answers at most one row per
   * bucket, so scopes × buckets is the ceiling, and a page that reaches `LIMIT` is a
   * PREFIX (ascending order) missing its newest buckets — which a zero-filling caller
   * would draw as an outage. Refusing is the honest answer to that, and the route's
   * bound on the scope list is what keeps a legitimate ask well under it.
   */
  async function queryTenantMetricsSeries(
    dataset: string,
    input: { tenantId: string; scopeIds: string[]; hours: number },
  ): Promise<TenantMetricsBucket[]> {
    // An empty list narrows to nothing, and says so without a query: an unfiltered read
    // would be "every scope of this tenant", which is a widening the caller did not ask
    // for and the contract does not offer.
    if (input.scopeIds.length === 0) return [];
    const hours = Math.max(1, Math.floor(input.hours));
    const bucketMinutes = hours <= 6 ? 15 : 60;
    const scopes = input.scopeIds.map((s) => aeLiteral(s)).join(', ');
    const sql = `
      SELECT
        blob2 AS scopeId,
        toStartOfInterval(timestamp, INTERVAL '${bucketMinutes}' MINUTE) AS start,
        sum(_sample_interval) AS requests,
        sum(if(blob4 = '5xx', _sample_interval, 0)) AS errors,
        sum(if(blob4 = '2xx', _sample_interval, 0)) AS class2xx,
        sum(if(blob4 = '3xx', _sample_interval, 0)) AS class3xx,
        sum(if(blob4 = '4xx', _sample_interval, 0)) AS class4xx,
        quantileWeighted(0.5)(double1, _sample_interval) AS durationP50,
        quantileWeighted(0.95)(double1, _sample_interval) AS durationP95
      FROM ${aeDataset(dataset)}
      WHERE index1 = ${aeLiteral(input.tenantId)}
        AND timestamp > now() - INTERVAL '${hours}' HOUR
        AND blob2 IN (${scopes})
      GROUP BY scopeId, start
      ORDER BY start ASC
      LIMIT ${SERIES_ROW_LIMIT}
      FORMAT JSON`;

    const rows = await analyticsEngineSql(sql);
    if (rows.length >= SERIES_ROW_LIMIT) {
      throw new Error(
        `Cloudflare Analytics Engine series query saturated at ${SERIES_ROW_LIMIT} rows: the answer would be a partial prefix, not a series`,
      );
    }
    return rows.flatMap((r) => {
      const start = aeInstant(r['start']);
      // A row with no bucket instant cannot be placed on an axis — dropping it beats
      // plotting it at an invented time.
      if (start === null) return [];
      return [
        {
          scopeId: String(r['scopeId'] ?? ''),
          start,
          bucketMinutes,
          requests: aeNum(r['requests']),
          errors: aeNum(r['errors']),
          class2xx: aeNum(r['class2xx']),
          class3xx: aeNum(r['class3xx']),
          class4xx: aeNum(r['class4xx']),
          durationP50: aeNum(r['durationP50']),
          durationP95: aeNum(r['durationP95']),
        },
      ];
    });
  }

  /**
   * Connector calls per provider, bucketed (#1691) — the connector-call dataset, read
   * with the tenant grain's shape: sampling-weighted sums, weighted quantiles, the same
   * two bucket widths, and the same refusal when a page saturates.
   *
   * ## The connector-call dataset's published ordinals
   *
   * Written by the kernel's `connectorCallDataPoint` from `CONNECTOR_CALL_DATA_POINT_LAYOUT`
   * (`packages/kernel/src/connector-calls.ts`), through the control plane's
   * `CONNECTOR_ANALYTICS` binding — its OWN dataset, never the router's, because the two
   * shapes' ordinals mean different things. Each position carries an OpenTelemetry
   * semantic-convention name (checked against `@opentelemetry/semantic-conventions` 1.43.0,
   * where `error.type`, `http.response.status_code` and `http.client.request.duration` are
   * all stable), so an OTLP exporter maps them 1:1, units included:
   *
   *   ordinal  OTel name                      unit  absent
   *   index1   substrat.tenant.id             —     —
   *   blob1    substrat.connection.provider   —     —
   *   blob2    substrat.vertical (the slug)   —     —
   *   blob3    error.type (closed enum)       —     ''  (success sets no error.type)
   *   double1  http.client.request.duration   s     -1  (the call was not timed)
   *   double2  http.response.status_code      —     0   (no status arrived)
   *
   * Like the router's, that shape only ever GROWS — a new field takes the next ordinal and
   * no ordinal is ever reordered, renamed or reused — and so does the `error.type` enum:
   * a stored point keeps the string it was written with. Nothing in it can carry a
   * credential, URL or payload: every blob is a row identifier or an enum member, and there
   * is deliberately no `server.address` or `url.*`.
   *
   * The JSON this read answers keeps its own readable field names (`calls`, `ok`,
   * `class4xx`, `durationP50` in MILLISECONDS…) rather than the OTel names: it is a chart's
   * API, not a telemetry record. The mapping: `ok` = blob3 `''`; `class4xx`/`class5xx`/
   * `timeouts` = blob3 `4xx`/`5xx`/`timeout`; `failed` = everything else that is an error;
   * `durationP50`/`P95` = the weighted quantiles of double1 × 1000.
   *
   * The quantiles weigh an untimed call (`double1 = -1`) at zero, so a caller that did not
   * time its call cannot drag the latency line down to nothing — while every COUNT still
   * includes it.
   */
  async function queryConnectorCallsSeries(
    dataset: string,
    input: { hours: number; provider?: string },
  ): Promise<ConnectorCallsBucket[]> {
    const hours = Math.max(1, Math.floor(input.hours));
    const bucketMinutes = hours <= 6 ? 15 : 60;
    const where = [`timestamp > now() - INTERVAL '${hours}' HOUR`];
    if (input.provider) where.push(`blob1 = ${aeLiteral(input.provider)}`);
    const timedWeight = `if(double1 >= 0, _sample_interval, 0)`;
    const sql = `
      SELECT
        blob1 AS provider,
        toStartOfInterval(timestamp, INTERVAL '${bucketMinutes}' MINUTE) AS start,
        sum(_sample_interval) AS calls,
        sum(if(blob3 = '', _sample_interval, 0)) AS ok,
        sum(if(blob3 = '4xx', _sample_interval, 0)) AS class4xx,
        sum(if(blob3 = '5xx', _sample_interval, 0)) AS class5xx,
        sum(if(blob3 = 'timeout', _sample_interval, 0)) AS timeouts,
        quantileWeighted(0.5)(double1, ${timedWeight}) AS durationP50,
        quantileWeighted(0.95)(double1, ${timedWeight}) AS durationP95
      FROM ${aeDataset(dataset)}
      WHERE ${where.join(' AND ')}
      GROUP BY provider, start
      ORDER BY start ASC
      LIMIT ${SERIES_ROW_LIMIT}
      FORMAT JSON`;

    const rows = await analyticsEngineSql(sql);
    if (rows.length >= SERIES_ROW_LIMIT) {
      throw new Error(
        `Cloudflare Analytics Engine series query saturated at ${SERIES_ROW_LIMIT} rows: the answer would be a partial prefix, not a series`,
      );
    }
    return rows.flatMap((r) => {
      const start = aeInstant(r['start']);
      if (start === null) return [];
      const calls = aeNum(r['calls']);
      const ok = aeNum(r['ok']);
      const class4xx = aeNum(r['class4xx']);
      const class5xx = aeNum(r['class5xx']);
      const timeouts = aeNum(r['timeouts']);
      const p50 = aeNum(r['durationP50']);
      const p95 = aeNum(r['durationP95']);
      return [
        {
          provider: String(r['provider'] ?? ''),
          start,
          bucketMinutes,
          calls,
          errors: Math.max(0, calls - ok),
          ok,
          class4xx,
          class5xx,
          timeouts,
          // Everything that is neither ok nor one of the named classes — a throw before
          // any status, an unclassed error, a non-4xx/5xx status. Derived, so the three
          // chart segments always sum to `calls`.
          failed: Math.max(0, calls - ok - class4xx - class5xx - timeouts),
          // double1 is seconds (OTel's unit); the chart's API speaks ms. A bucket with no
          // timed call has no latency — NaN would poison a chart's scale.
          durationP50: Number.isFinite(p50) && p50 >= 0 ? p50 * 1000 : 0,
          durationP95: Number.isFinite(p95) && p95 >= 0 ? p95 * 1000 : 0,
        },
      ];
    });
  }

  /** One Analytics Engine SQL read, returning the rows as the API shaped them. */
  async function analyticsEngineSql(sql: string): Promise<Array<Record<string, unknown>>> {
    const res = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${opts.accountId}/analytics_engine/sql`,
      { method: 'POST', headers: { authorization: `Bearer ${opts.apiToken}` }, body: sql },
    );
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`Cloudflare Analytics Engine query failed: HTTP ${res.status} ${text.slice(0, 200)}`);
    }
    const json = JSON.parse(text) as { data?: Array<Record<string, unknown>> };
    return json.data ?? [];
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
    invocationId?: string;
    hours: number;
    since?: string;
    until?: string;
    limit: number;
  }): Promise<RecentLogEvent[]> {
    // ONE timeframe, computed once and handed to every query below — the phases are not
    // independent reads. Phase two expands an invocation the earlier phases found, and a
    // phase that recomputed `Date.now()` for itself would search a window shifted by the
    // time the previous one took: a sibling line near the edge would fall outside and the
    // page would show half an invocation. The cursor makes that sharper still — a
    // five-minute window has edges a whole request can straddle.
    const to = input.until ? Date.parse(input.until) : Date.now();
    const timeframe = {
      from: input.since ? Date.parse(input.since) : to - input.hours * 3_600_000,
      to,
    };
    const base = [
      { key: 'tenantId', operation: 'eq', type: 'string', value: input.tenantId },
      { key: 'substrat', operation: 'eq', type: 'string', value: 'invocation' },
    ];
    if (input.scopeId) base.push({ key: 'scopeId', operation: 'eq', type: 'string', value: input.scopeId });
    if (input.vertical) base.push({ key: 'vertical', operation: 'eq', type: 'string', value: input.vertical });
    // One call (#1525). The stamped line carries the id as a top-level `invocationId`
    // (`InvocationLogLine`), so it is one more equality ANDed onto the tenant's own
    // filter — never a replacement for it. That is the whole tenant boundary: an id that
    // belongs to another tenant meets `tenantId = ours` and matches no line, and phase
    // two then has no request id to expand, so nothing of theirs can be reached.
    // `!== undefined`: this reader is a seam of its own, and an empty id that got past the
    // route must narrow to nothing, not quietly read as "no filter".
    if (input.invocationId !== undefined) {
      base.push({ key: 'invocationId', operation: 'eq', type: 'string', value: input.invocationId });
    }

    // Phase one. For every read but `error` this is one query: the tenant's stamped
    // lines, newest first.
    //
    // A level filter cannot do that job. Stamped lines are pure JSON, so Cloudflare
    // leaves `$metadata.level` unset on them and a level filter drops every one — which
    // means an error could only ever arrive as a SIBLING, and siblings exist only for the
    // invocations phase two expanded. Asking for errors over 24h would search the 40 most
    // recent invocations and answer "none" if the error was the 41st: an empty page that
    // reads as "nothing is wrong" and means "I did not look".
    //
    // So an error read selects the invocations to expand itself. It takes four queries,
    // because "an error" arrives in three shapes and no single filter spans them:
    //
    //   1. a FAILED response — the stamped line carries `status >= 500`, less 501, which
    //      is a declared-absent capability rather than a failure (`isFailedInvocation`).
    //      It is asked for as `= 500` plus `>= 502` rather than filtered afterwards, so a
    //      page-render trickle of 501s cannot fill phase one and spend phase two's budget
    //      on invocations the level filter below would only throw away;
    //   2. an ESCAPE — the error got past `onError` itself, so the line carries
    //      `threw: true` and `status: null`, which no comparison on `status` can match.
    //      These are the rarest lines and the most interesting ones on the page;
    //   3. a `console.error` the vertical wrote during a request that SUCCEEDED — a line
    //      with no tenant on it, on an invocation the tenant filter has no reason to
    //      select, since its stamped line says 200.
    //
    // (1) and (2) are tenant-filtered, so their invocations are trusted on sight. (3)
    // cannot be: an error-level query has no tenant to filter on and is searched
    // account-wide, so each of its invocations is admitted only once phase two shows a
    // stamped line for THIS tenant on it — `ownsInvocation` below. Narrowing to (1)
    // alone, which is what this did first, silently dropped every crash that escaped the
    // envelope and every error logged by a request that went on to answer 200.
    //
    // A read of ONE call is never an error read in this sense, whatever its level: the
    // tenant-filtered query already names the invocation, so there is nothing to select
    // and nothing to search account-wide for. Taking the account-wide `console.error`
    // branch would admit OTHER invocations of this tenant through `ownsInvocation`, which
    // judges the tenant and not the call — a filter for one call answering with several.
    // The level narrows at the merge below instead.
    const isErrorRead = input.level?.toLowerCase() === 'error' && input.invocationId === undefined;
    // Over-fetched relative to `limit`, because each invocation may pull siblings in
    // phase two and the cap belongs on the merged answer.
    const phaseOneLimit = Math.min(input.limit * 2, 200);
    const [stamped, errorLines] = isErrorRead
      ? await Promise.all([
          Promise.all([
            queryRaw(
              [...base, { key: 'status', operation: 'eq', type: 'number', value: 500 }],
              timeframe,
              phaseOneLimit,
            ),
            queryRaw(
              [...base, { key: 'status', operation: 'gte', type: 'number', value: CAPABILITY_ABSENT + 1 }],
              timeframe,
              phaseOneLimit,
            ),
            queryRaw(
              [...base, { key: 'threw', operation: 'eq', type: 'boolean', value: true }],
              timeframe,
              phaseOneLimit,
            ),
            // Newest first across the pages, not page order: the correlation cap is spent
            // in this order, and a busy `= 500` page must not crowd out a newer 502 or
            // escape just because its query was listed first.
          ]).then((pages) => pages.flat().sort((a, b) => rawTime(b) - rawTime(a))),
          queryRaw(
            [{ key: '$metadata.level', operation: 'eq', type: 'string', value: 'error' }],
            timeframe,
            phaseOneLimit,
          ),
        ])
      : [await queryRaw(base, timeframe, phaseOneLimit), []];

    const trusted = invocationIds(stamped);
    const trustedIds = new Set(trusted);
    const candidates = invocationIds(errorLines).filter((id) => !trustedIds.has(id));
    if (trusted.length === 0 && candidates.length === 0) return [];

    // Phase two: everything sharing those invocations. One query per request id — the
    // telemetry API's filters are single-valued equality, the same constraint
    // `recentLogs` batches around — so this is capped rather than unbounded. The cap is a
    // budget, and the trusted ids spend it first: this tenant's own failures must not be
    // crowded out of the page by a noisy neighbour's error lines.
    const requestIds = [...trusted, ...candidates].slice(0, MAX_CORRELATED_INVOCATIONS);
    //
    // The per-invocation line cap is there because a page spans up to 40 invocations and
    // the budget must be shared out. A read of ONE call has no one to share with: capping
    // it at 20 while the caller asked for 100 hides the diagnostic line of a chatty
    // request — the very line the view was opened to find — so it gets the caller's own
    // `limit` (the route bounds that at 200).
    const linesPerInvocation =
      input.invocationId !== undefined ? Math.min(input.limit, 200) : MAX_LINES_PER_INVOCATION;
    const sibling = await Promise.all(
      requestIds.map(async (id) => {
        const events = await queryRaw(
          [{ key: '$metadata.requestId', operation: 'eq', type: 'string', value: id }],
          timeframe,
          linesPerInvocation,
        );
        // An account-wide candidate earns its place only by producing this tenant's
        // stamped line. No stamped line, or somebody else's, and the whole invocation is
        // dropped — a line shown to the wrong tenant is exactly the leak the tenant grain
        // exists to prevent, so the conservative direction is the only allowed one.
        if (!trustedIds.has(id) && !events.some((e) => ownsInvocation(e, input))) return [];
        return events;
      }),
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
      .map((e) => describeInvocation(e))
      // A plain comparison is enough only because `describeInvocation` ran first: a stamped
      // line has no level of its own (Cloudflare sets `$metadata.level` for a string log
      // and leaves it unset for a pure JSON one), so without that step every one of them
      // would be dropped here — and for `error` that would be actively wrong, since a
      // failing invocation that wrote no console.error of its own is exactly the row being
      // looked for, and phase one selected it BECAUSE it failed.
      .filter((e) => (level ? e.level?.toLowerCase() === level : true))
      .filter((e) => (search ? (e.message ?? '').includes(search) : true))
      .sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0))
      .slice(0, input.limit);
  }

  /** The de-duplicated, order-preserving request ids of a page of events. */
  function invocationIds(events: Array<Record<string, unknown>>): string[] {
    return [
      ...new Set(
        events.map((e) => idOf(e)).filter((id): id is string => typeof id === 'string' && id !== ''),
      ),
    ];
  }

  /** A raw event's `timestamp`, or 0 when it carries none (sorted last). */
  function rawTime(e: Record<string, unknown>): number {
    return typeof e['timestamp'] === 'number' ? e['timestamp'] : 0;
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
    // `value` is `string | number | boolean`: every filter was an equality on an id until
    // the error read needed `status = 500` / `status >= 502` (the numeric comparisons) and
    // `threw = true` (the one boolean).
    filters: Array<{ key: string; operation: string; type: string; value: string | number | boolean }>,
    // The window, already decided by the caller — every phase of one tenant-log read
    // searches the same one, so this takes the instants rather than a duration it would
    // have to re-anchor to a `Date.now()` of its own.
    timeframe: { from: number; to: number },
    limit: number,
  ): Promise<Array<Record<string, unknown>>> {
    const res = await authed(
      `https://api.cloudflare.com/client/v4/accounts/${opts.accountId}/workers/observability/telemetry/query`,
      {
        queryId: 'substrat-tenant-logs',
        view: 'events',
        timeframe,
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

/**
 * The router dataset's name, checked before it is spliced into SQL. It is an IDENTIFIER,
 * not a bound value — it cannot be quoted into place, so the only defence is refusing
 * anything that is not a bare name. Checked per query rather than at construction so a
 * mistyped var costs the tenant routes a 500 instead of taking every other observability
 * read down with it.
 */
function aeDataset(dataset: string): string {
  if (!/^[A-Za-z0-9_]{1,64}$/.test(dataset)) {
    // Shared by the router's dataset and the connector-call dataset (#1691), so it names
    // neither setting — the value it refused says which one is wrong.
    throw new Error(
      `observability: refusing an Analytics Engine dataset name that is not a bare identifier: ${JSON.stringify(dataset)}`,
    );
  }
  return dataset;
}

/**
 * A dimension value quoted for Analytics Engine SQL. The SQL is built in a string and the
 * value arrives from a session, so this is a whitelist rather than a quote-doubling dance:
 * ids are opaque ULIDs and slugs, and anything that is not shaped like one is not an id
 * and has no business reaching the query.
 */
function aeLiteral(v: string): string {
  if (!/^[A-Za-z0-9_\-./]{1,128}$/.test(v)) {
    throw new Error('observability: refusing a dimension value with unexpected characters');
  }
  return `'${v}'`;
}

/** AE returns aggregate sums as STRINGS (they are 64-bit), quantiles as numbers. */
function aeNum(v: unknown): number {
  return typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : 0;
}

/**
 * An Analytics Engine DateTime (`2026-09-08 11:00:00`, no zone designator, UTC) as the
 * ISO instant the seam promises. Null when the value is not a timestamp at all.
 */
function aeInstant(v: unknown): string | null {
  if (typeof v !== 'string' || v === '') return null;
  const iso = v.includes('T') ? v : v.replace(' ', 'T');
  return /(Z|[+-]\d{2}:\d{2})$/.test(iso) ? iso : `${iso}Z`;
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
