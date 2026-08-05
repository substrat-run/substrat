import type { ObservabilityReader } from './observability.js';

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

    async recentLogs({ service, level, search, hours, limit }) {
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
          eventType: str(workers['eventType']),
          entrypoint: str(workers['entrypoint']),
          requestId: str(metadata['requestId']) ?? str(workers['requestId']),
          cpuTimeMs: num(workers['cpuTimeMs']),
          wallTimeMs: num(workers['wallTimeMs']),
          raw: e,
        };
      });
    },
  };
}
