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
  /** The event as the backend returned it — the fields above are a best-effort
   *  projection, and the raw event is what makes a projection miss debuggable. */
  raw: unknown;
}

export interface ObservabilityReader {
  /** Per-service invocation metrics for the trailing window (fleet + builder views). */
  serviceMetrics(input: { hours: number }): Promise<ServiceMetricsRow[]>;
  /**
   * Recent log events, optionally narrowed to one service and/or level.
   * `search` is a case-sensitive substring match on the event message — a contract
   * capability, so each backend maps it to its own query language (never a
   * provider-shaped filter passed through the seam).
   */
  recentLogs(input: {
    service?: string;
    level?: string;
    search?: string;
    hours: number;
    limit: number;
  }): Promise<RecentLogEvent[]>;
}
