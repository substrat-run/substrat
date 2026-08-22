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
  /** The shape of the invocation (`fetch`, `rpc`, `scheduled`, `alarm`, …), backend-worded. */
  eventType: string | null;
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

export interface ObservabilityReader {
  /** Per-service invocation metrics for the trailing window (fleet + builder views). */
  serviceMetrics(input: { hours: number }): Promise<ServiceMetricsRow[]>;
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
}
