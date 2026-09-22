/**
 * The observability read seam (design/observability.md §4.1) — what the console's
 * fleet view and (later, owner-narrowed) the dashboard's builder view consume.
 *
 * This file is the CONTRACT, deliberately free of provider vocabulary: a "service"
 * is a deployed unit of code (a Cloudflare worker script today, a container
 * tomorrow), a "namespace" is whatever pool the platform runs pushed verticals in
 * (a WfP dispatch namespace today). The same posture as `DeployVerticalFn` in
 * `deploy.ts`: the seam lives here, each provider's implementation lives in its own
 * module (`cf-observability.ts` for Cloudflare), and the host injects one — so an
 * APM/OTel backend can slot in behind the identical routes later
 * (master-plan §5.7, §6 "Convention + adapter") without touching this package's
 * consumers. Absent ⇒ the observability routes 501, the platform's standard shape
 * for an unconfigured capability.
 */

/** One service's invocation aggregates over the queried window. */
export interface ServiceMetricsRow {
  service: string;
  /** The pushed-vertical pool the service runs in, or null for platform services. */
  namespace: string | null;
  requests: number;
  errors: number;
  subrequests: number;
  /** Per-request CPU time quantiles, microseconds. */
  cpuTimeP50: number;
  cpuTimeP99: number;
}

/**
 * One service's invocations inside ONE time bucket (#1236). The aggregate row
 * above answers "how did this version behave"; this answers "when" — which is
 * what a push marker needs an axis to be drawn on. `start` is the bucket's
 * opening instant (ISO), `bucketMinutes` its width, so a renderer never has to
 * infer spacing from the gaps between rows it was given.
 */
export interface ServiceMetricsBucket {
  service: string;
  namespace: string | null;
  start: string;
  bucketMinutes: number;
  requests: number;
  errors: number;
}

export interface RecentLogEvent {
  /** Unix ms, when the event was recorded. */
  timestamp: number | null;
  level: string | null;
  message: string | null;
  service: string | null;
  /** How the invocation ended (e.g. `ok`, `exception`), provider-worded. */
  outcome: string | null;
  /** What set the invocation off — an operation/route/RPC name (e.g. `default.importDump`).
   *  Neutral vocabulary: each backend maps its own trigger concept onto this string. */
  trigger: string | null;
  /** The shape of the invocation (`fetch`, `rpc`, `scheduled`, `alarm`, …), backend-worded.
   *  Named for what it is: the signals vocabulary (#1231) reserves `eventType` for a DOMAIN
   *  event's type, and this field is the one thing in the system that must never be read as one. */
  invocation: string | null;
  /** The handler that ran (a class/entrypoint name), when the backend distinguishes one. */
  entrypoint: string | null;
  /** Correlates events from the same invocation — the key to grouping a request's lines. */
  requestId: string | null;
  /** CPU / wall time for the invocation, milliseconds (Tier-3: sampled, approximate). */
  cpuTimeMs: number | null;
  wallTimeMs: number | null;
  /** The event as the backend returned it — the fields above are a best-effort
   *  projection, and the raw event is what makes a projection miss debuggable. */
  raw: unknown;
}

/**
 * One destination a service was OBSERVED reaching (#859, D-46).
 *
 * The counterpart to a version's DECLARED `substrat.outbound`: the declaration says
 * what a vertical may call, this says what it did call. Deliberately a hostname and an
 * origin rather than a full request log — the question being answered is "does the
 * declared surface match reality", not "what did this vertical send", which is #860's
 * question and needs a durable record rather than sampled telemetry.
 */
export interface ObservedEgressRow {
  /** The deployed unit that made the call (a version's deployment ref today). */
  service: string;
  /** The destination hostname, lowercased — what a declaration is compared against. */
  host: string;
  /**
   * Where in the service the call came from. The distinction is the whole point of
   * this report: `worker` egress is already policed by the egress seam (D-46), while
   * `durable-object` egress is NOT intercepted and is visible here and nowhere else.
   * `unknown` when the backend did not say — never silently folded into either.
   */
  origin: 'worker' | 'durable-object' | 'unknown';
  /** How many calls were seen in the window. Tier-3 (master-plan §5.3): sampled. */
  calls: number;
  /** Unix ms of the most recent observed call, when the backend reports one. */
  lastSeen: number | null;
  /** One full URL, verbatim, so a human can recognise the call. Never parsed for policy. */
  sampleUrl: string | null;
}

/**
 * An egress report over a trailing window.
 *
 * A report, not a bare array, because **an incomplete answer must say so**. Telemetry
 * here is head-sampled and row-capped, so an absent host is not evidence a vertical
 * never called it — and a UI that renders "no undeclared hosts" off a truncated read
 * is claiming a clean bill of health it does not have.
 */
export interface ObservedEgressReport {
  rows: ObservedEgressRow[];
  /**
   * The backend returned as many rows as it was allowed to, so the host set is a FLOOR
   * and not the whole picture. Whoever displays this must say so (#859).
   */
  truncated: boolean;
  /**
   * The head sampling rate the backend believes is in effect (0–1), or null when it
   * cannot say. `null` and `1` are different claims and must not be collapsed: one is
   * "every call was seen", the other is "unknown coverage".
   */
  samplingRate: number | null;
  /** The trailing window actually queried, in hours. */
  hours: number;
}

/**
 * One tenant's traffic through ONE of their installed apps, over the queried window.
 *
 * The counterpart to `ServiceMetricsRow`, and the distinction is the whole reason this
 * exists. A service row is keyed on the deployed unit — a script — which serves every
 * tenant that installed the vertical, so handing one to an installer leaks the others'
 * volume (§3, "Forbidden — it leaks"). This row is keyed on `(tenant, scope)`: the
 * installation, not the code. Two tenants running the same vertical are two rows here
 * and one indistinguishable row there.
 *
 * Tier-3 (master-plan §5.3): sampled, approximate, ops-only — never money, and never
 * shown to a customer as an authoritative count.
 */
export interface TenantMetricsRow {
  /** The app scope these requests were routed to — the installation's identity. */
  scopeId: string;
  /** The vertical serving them, as the registry slugs it. */
  vertical: string | null;
  /** Which declared surface answered (`app`, `api`, …) — a K-26 dimension. */
  surface: string | null;
  requests: number;
  errors: number;
  /**
   * Requests answered 2xx or 3xx / 4xx, weighted the same way `requests` is (#1693) —
   * the traffic chart's green and yellow segments. `errors` above is already the 5xx
   * count and stays exactly as it was; these are additive so a caller reading only
   * `requests`/`errors` is unaffected. Optional because the backend that answers
   * `requests` may not (yet) carry the status-class dimension `blob4` records.
   */
  class2xx?: number;
  class3xx?: number;
  class4xx?: number;
  /** Router-observed duration quantiles, milliseconds. */
  durationP50: number;
  durationP95: number;
}

/**
 * One tenant's traffic through ONE of their installed apps inside ONE time bucket
 * (#1447) — the tenant-grain twin of `ServiceMetricsBucket`, for the same reason
 * `TenantMetricsRow` twins `ServiceMetricsRow`: a script-grain series serves every
 * installer at once, so a chart drawn from it for one of them plots the others' volume.
 *
 * Keyed on the scope alone, not `(scope, surface)`: the series exists to be drawn, and
 * a chart wants one line per app. The per-surface split stays on the aggregate row.
 * `start` and `bucketMinutes` mean what they mean on `ServiceMetricsBucket` — an empty
 * bucket is omitted, never zero-filled here; the caller fills, knowing the width.
 *
 * Unlike the script-grain bucket it carries latency, because #1447's chart plots it and
 * the aggregate row's whole-window quantiles cannot be turned back into a timeline. The
 * same two quantiles as `TenantMetricsRow`, so the chart and the table beneath it name
 * the same number; sampling-weighted for the same reason its counts are.
 */
export interface TenantMetricsBucket {
  scopeId: string;
  /** The bucket's opening instant, ISO, UTC. */
  start: string;
  bucketMinutes: number;
  requests: number;
  errors: number;
  /** Same additive status-class split as `TenantMetricsRow` (#1693), per bucket. */
  class2xx?: number;
  class3xx?: number;
  class4xx?: number;
  /** Weighted median request duration inside the bucket, ms. */
  durationP50: number;
  /** Weighted 95th percentile, ms. */
  durationP95: number;
}

/**
 * How many scopes one `tenantMetricsSeries` ask may name. The answer is scopes × buckets
 * against the reader's row ceiling, so the route refuses a longer list; a caller with
 * more apps than this batches its ask and merges the pages (the dashboard does).
 */
export const TENANT_SERIES_SCOPE_CAP = 50;

/**
 * Connector calls to ONE provider inside ONE time bucket (#1691) — the trend behind the
 * connection-health line, fleet-wide. Read from the connector-call dataset the control
 * plane writes (kernel `connector-calls.ts`), never the router's.
 *
 * Counts are sampling-weighted exactly as the tenant grain's are (`sum(_sample_interval)`,
 * never `count()`), and split by outcome so a chart can colour them: `ok` green,
 * `class4xx` yellow (usually us — a revoked grant, a malformed call), and everything else
 * red — `class5xx`, `timeouts`, and `failed` (a throw before any status, an unclassed
 * error, or a non-4xx/5xx status). `errors` is `calls − ok`, so the three segments sum to
 * `calls`. An empty bucket is omitted, never zero-filled; the caller fills.
 */
export interface ConnectorCallsBucket {
  provider: string;
  /** The bucket's opening instant, ISO, UTC. */
  start: string;
  bucketMinutes: number;
  calls: number;
  errors: number;
  ok: number;
  class4xx: number;
  class5xx: number;
  timeouts: number;
  failed: number;
  /** Weighted quantiles over the TIMED calls only (an untimed call writes `-1`), ms. */
  durationP50: number;
  durationP95: number;
}

export interface ObservabilityReader {
  /** Per-service invocation metrics for the trailing window (fleet + builder views). */
  serviceMetrics(input: { hours: number }): Promise<ServiceMetricsRow[]>;

  /**
   * ONE tenant's traffic, grouped by the app scope it reached (view 4, §4.2).
   *
   * OPTIONAL for the same honest reason `observedEgress` and `serviceMetricsSeries` are:
   * a backend can answer everything else here and still have no tenant dimension at all,
   * because the tenant is the one fact a runtime cannot record by itself — somebody has
   * to have stamped it at dispatch time. Absent ⇒ the route 501s, the platform's shape
   * for an unconfigured capability, never an empty array, which a caller would render as
   * "your app served nothing" — a claim this seam must not make by accident.
   *
   * `tenantId` is not a filter a caller may widen: it IS the narrowing, applied by the
   * implementation against the backend, and there is deliberately no "all tenants"
   * spelling. `scopeId` and `vertical` narrow further WITHIN that tenant. The type is
   * what keeps a fleet-wide read from being one forgotten parameter away.
   */
  tenantMetrics?(input: {
    tenantId: string;
    scopeId?: string;
    vertical?: string;
    hours: number;
  }): Promise<TenantMetricsRow[]>;

  /**
   * The same tenant traffic, bucketed over time (#1447) — what a team-level chart plots,
   * one series per installed app.
   *
   * Same optionality, and the same non-widenable `tenantId`, as `tenantMetrics`: a
   * backend with a tenant dimension may still have no time axis on it, and absent must
   * 501 rather than answer an empty series, which a chart renders as "quiet" — the exact
   * misreading a status band exists to prevent.
   *
   * `scopeIds` is a LIST so that "all my apps" is one read rather than one per app; it
   * narrows WITHIN the tenant, so a foreign scope id yields no rows rather than somebody
   * else's. An empty list narrows to nothing — the caller names the apps it will plot,
   * which is also what keeps the answer bounded (scopes × buckets). The backend picks the
   * bucket width from the window and reports it on every row.
   */
  tenantMetricsSeries?(input: { tenantId: string; scopeIds: string[]; hours: number }): Promise<TenantMetricsBucket[]>;

  /**
   * Connector calls per provider, bucketed over time (#1691) — a STAFF read, fleet-wide
   * by design: it is the operator's "is this provider getting worse" question, and the
   * route that exposes it refuses every tenant and builder credential.
   *
   * Optional for the reason the tenant grain is: the backend has to have been told which
   * dataset the control plane writes, and absent must 501, never answer an empty series
   * a chart draws as "no calls". `provider` narrows; absent means every provider.
   */
  connectorCallsSeries?(input: { hours: number; provider?: string }): Promise<ConnectorCallsBucket[]>;

  /**
   * ONE tenant's recent log events — the lines their own installations produced (§4.3).
   *
   * Same optionality, and the same non-widenable `tenantId`, as `tenantMetrics`.
   *
   * The answer includes lines a vertical's own code wrote, which carry no tenant of their
   * own: those are reached by correlation, out from the stamped invocation line to
   * everything sharing its invocation. An implementation that cannot correlate returns
   * only the stamped lines rather than guessing — under-reporting is survivable here and
   * misattribution is not, since a line shown to the wrong tenant is precisely the leak
   * the grain decision exists to prevent.
   *
   * `since`/`until` are ISO instants and they travel together, because a window is two
   * instants and `hours` alone can only name one of them: it always ends at now, so it
   * can say "the last three hours" and never "the three minutes around the failure the
   * chart just drew". That instant is in the past, which is the one window `hours` cannot
   * express — hence the pair. `until` defaults to now and `since` to `until − hours`, so
   * a caller that passes neither gets exactly the trailing window it always did; both
   * given, `hours` is ignored rather than intersected, since two spellings of the same
   * bound cannot both be honoured and the explicit one is the one the caller meant.
   */
  tenantLogs?(input: {
    tenantId: string;
    scopeId?: string;
    vertical?: string;
    level?: string;
    search?: string;
    /**
     * One call's lines (#1525): the id the stamped line carries. It NARROWS — it is one
     * more equality beside `tenantId`, so an id that belongs to another tenant matches
     * nothing here rather than that tenant's lines. Absent means every call, as before.
     */
    invocationId?: string;
    hours: number;
    since?: string;
    until?: string;
    limit: number;
  }): Promise<RecentLogEvent[]>;

  /**
   * Recent log events, optionally narrowed to a set of services and/or a level.
   * `services` is a set because a caller's unit of interest is rarely one deployed
   * unit — the builder view's "all versions" is every service a vertical serves from,
   * and asking for them together is what makes one merged stream possible. Absent or
   * empty means "no service narrowing" (the fleet view); several means the backend
   * returns their events merged newest-first, capped at `limit` overall.
   * `search` is a case-sensitive substring match on the event message — a contract
   * capability, so each backend maps it to its own query language (never a
   * provider-shaped filter passed through the seam).
   */
  recentLogs(input: {
    services?: string[];
    level?: string;
    search?: string;
    hours: number;
    limit: number;
  }): Promise<RecentLogEvent[]>;

  /**
   * Destinations the given services were OBSERVED reaching (#859, D-46).
   *
   * OPTIONAL, and absent for a good reason rather than a lazy one: a backend can be
   * perfectly able to answer `serviceMetrics` and `recentLogs` and still have no span
   * data at all. Absent ⇒ the route 501s, the platform's shape for an unconfigured
   * capability — never an empty report, which would read as "nothing reached anywhere".
   */
  observedEgress?(input: {
    services: string[];
    hours: number;
    limit: number;
  }): Promise<ObservedEgressReport>;

  /**
   * The same invocations, bucketed over time (#1236) — the series a chart plots
   * and a deploy marker is drawn onto.
   *
   * OPTIONAL for the same honest reason as `observedEgress`: a backend can serve
   * window aggregates and have no time dimension at all, and absent must 501
   * rather than answer an empty series, which a chart would render as "quiet"
   * — the exact misreading the release views exist to prevent.
   *
   * `services` narrows server-side and is what keeps the answer bounded: a
   * fleet-wide bucketed read is scripts × buckets, so a caller asks for the
   * handful it will actually plot. The backend picks the bucket width from the
   * window and reports it on every row.
   */
  serviceMetricsSeries?(input: { hours: number; services?: string[] }): Promise<ServiceMetricsBucket[]>;
}
