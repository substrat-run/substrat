/**
 * The hosted connector-call recorder: one Analytics Engine point per call (#1691).
 *
 * Here rather than in the kernel since #1978. The kernel keeps the neutral half — the
 * record, the `ConnectorCallRecorder` interface and the no-op self-host default — and this
 * is the one place a record becomes a data point in the hosted platform's dataset.
 */
import type { ConnectorCallRecord, CountingConnectorCallRecorder } from '@substrat-run/kernel';

/** The one method of an Analytics Engine binding this needs — structural, no workers types. */
export interface AnalyticsEngineDatasetLike {
  writeDataPoint(point: { indexes?: string[]; blobs?: string[]; doubles?: number[] }): void;
}

/**
 * Where each OTel-named field lands in an Analytics Engine data point. **A published
 * shape** — the read in `packages/control-plane-api/src/cf-observability.ts` indexes into
 * it by ordinal, beside the router's — so it only ever GROWS: a new field takes the next
 * ordinal, and no position is ever reordered, renamed or reused. `absent` is what the
 * position holds when the record has no value for it.
 *
 * Its own dataset, never the router's: the router's `blob1` is a vertical and its `blob4`
 * a status class, and a point of this shape written there would be counted as requests by
 * every tenant-traffic read.
 */
export const CONNECTOR_CALL_DATA_POINT_LAYOUT = {
  indexes: [{ ordinal: 'index1', name: 'substrat.tenant.id', unit: null, absent: null }],
  blobs: [
    { ordinal: 'blob1', name: 'substrat.connection.provider', unit: null, absent: null },
    { ordinal: 'blob2', name: 'substrat.vertical', unit: null, absent: null },
    { ordinal: 'blob3', name: 'error.type', unit: null, absent: '' },
  ],
  doubles: [
    { ordinal: 'double1', name: 'http.client.request.duration', unit: 's', absent: -1 },
    { ordinal: 'double2', name: 'http.response.status_code', unit: null, absent: 0 },
  ],
} as const;

/** The data point a record becomes — built from {@link CONNECTOR_CALL_DATA_POINT_LAYOUT}. */
export function connectorCallDataPoint(call: ConnectorCallRecord): {
  indexes: string[];
  blobs: string[];
  doubles: number[];
} {
  const L = CONNECTOR_CALL_DATA_POINT_LAYOUT;
  return {
    indexes: L.indexes.map((f) => call[f.name]),
    blobs: L.blobs.map((f) => call[f.name] ?? f.absent ?? ''),
    doubles: L.doubles.map((f) => call[f.name] ?? f.absent),
  };
}

/**
 * The hosted recorder: one Analytics Engine point per call. A throwing write is
 * swallowed and counted, never rethrown — Analytics Engine being unavailable is not a
 * reason for a Fortnox export to fail.
 */
export function analyticsEngineConnectorCallRecorder(
  dataset: AnalyticsEngineDatasetLike,
  opts: {
    /** Told the running count after each dropped write. Its own throw is swallowed too. */
    onDrop?: (dropped: number) => void;
  } = {},
): CountingConnectorCallRecorder {
  let dropped = 0;
  return {
    get dropped() {
      return dropped;
    },
    record(call) {
      try {
        dataset.writeDataPoint(connectorCallDataPoint(call));
      } catch {
        dropped += 1;
        try {
          opts.onDrop?.(dropped);
        } catch {
          // A reporting hook cannot fail the call either.
        }
      }
    },
  };
}
