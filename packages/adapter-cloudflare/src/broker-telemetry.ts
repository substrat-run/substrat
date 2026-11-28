/**
 * #3474 on the Durable Object: the kernel's broker telemetry (`BrokerTelemetry`, `reportHandoff`)
 * written into an Analytics Engine dataset, bound as `SUBSTRAT_BROKER_TELEMETRY` on the app's script
 * — the same script that binds the broker, so the scope's handoff and the broker's own steps land
 * together. Unbound, nothing is written: the broker and the scopes run unobserved.
 *
 * `writeDataPoint` is buffered by the runtime and never awaited; a throw drops the point.
 */
import { BROKER_TELEMETRY_BINDING, brokerDataPoint, type BrokerMessage, type BrokerTelemetrySink, type HandOffAnswer } from '@substrat-run/kernel';
import type { AnalyticsEngineDatasetLike } from './connector-calls.js';

/** The dataset an env binds for broker telemetry, or null. Read structurally: the env is the app's. */
export function brokerTelemetryDataset(env: unknown): AnalyticsEngineDatasetLike | null {
  const ds = (env as Record<string, unknown> | null | undefined)?.[BROKER_TELEMETRY_BINDING];
  return ds && typeof (ds as AnalyticsEngineDatasetLike).writeDataPoint === 'function'
    ? (ds as AnalyticsEngineDatasetLike)
    : null;
}

/** A sink writing every point and state report into `dataset`, in `BROKER_DATA_POINT_LAYOUT`. */
export function analyticsBrokerSink(dataset: AnalyticsEngineDatasetLike): BrokerTelemetrySink {
  return {
    point: (p) => dataset.writeDataPoint(brokerDataPoint(p)),
    state: (s) => dataset.writeDataPoint(brokerDataPoint(s)),
  };
}

/** The broker object's (tenant, app) from its name, `brokerName(tenantId, app)`. */
export function brokerIdsOf(name: string | undefined): { tenantId: string; app: string } {
  const at = name?.indexOf('/') ?? -1;
  return at > 0 ? { tenantId: name!.slice(0, at), app: name!.slice(at + 1) } : { tenantId: name ?? '', app: '' };
}

/** A round's outcome: every message acknowledged, or some (the rest go again). */
export function handoffOutcome(sent: readonly BrokerMessage[], answer: HandOffAnswer): 'acked' | 'partial' {
  const acked = new Set(answer.acked);
  return sent.every((m) => acked.has(m.id)) ? 'acked' : 'partial';
}
