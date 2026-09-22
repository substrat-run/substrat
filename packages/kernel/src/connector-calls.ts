/**
 * One data point per connector call (#1691) — the trend behind the connection-health
 * line.
 *
 * The health line (`recordConnectionUse`, connections.md §3.7) is last-write-wins: it
 * answers "what happened last" and nothing about "is this provider getting worse". This
 * is the other half: every time either host settles that line it also hands a
 * {@link ConnectorCallRecord} to a {@link ConnectorCallRecorder}, which on the hosted
 * platform is an Analytics Engine dataset and on self-host is, by default, nothing.
 *
 * ## Why the record cannot carry a secret
 *
 * The shape is closed, not filtered. Every field is either an identifier the host read
 * off the connection row (provider, tenant, vertical — never the caller's input), a member
 * of the closed {@link CONNECTOR_CALL_ERROR_TYPES} enum, or a number. There is no field a
 * URL, a header, a request body, a credential or an error message could land in, because
 * the classifier ({@link connectorCallErrorType}) reads only a status code and an error's
 * `name`, and emits an enum member. A free-text "error class" would have been the one
 * door a provider's error body — which routinely echoes the request — walks through. For
 * the same reason there is deliberately no `server.address` and no `url.*`: a URL is
 * where a provider puts an access token.
 *
 * ## The names are OpenTelemetry's
 *
 * The record is keyed by OpenTelemetry semantic-convention names (checked against
 * `@opentelemetry/semantic-conventions` 1.43.0, where all three standard names below are
 * STABLE), with a `substrat.*` namespace for the fields OTel has no name for. So this
 * Analytics Engine row, a future custom span, and a future self-host OTel metric share one
 * vocabulary, and an OTLP exporter maps the record 1:1 — including the duration's unit,
 * which is SECONDS, OTel's unit for `http.client.request.duration`.
 *
 * ## Why it cannot fail or slow the call
 *
 * `record` returns `void` and the hosts never await it. The Analytics Engine recorder
 * wraps its write and counts what it swallows ({@link CountingConnectorCallRecorder}),
 * and the hosts wrap the call itself too, so a recorder someone else wrote cannot break a
 * dispatch by throwing either.
 */

/**
 * The `error.type` values this instrumentation reports — closed, as OTel asks ("low
 * cardinality … instrumentations SHOULD document the list of errors they report").
 * Grow-only like the ordinals below: a stored point keeps the string it was written with,
 * so a member is never renamed or reused. A SUCCESS has no `error.type` at all (OTel:
 * "SHOULD NOT set `error.type`" on success), which the data point writes as `''`.
 *
 * - `4xx` / `5xx` — the provider answered with that class. A 4xx is usually us (a revoked
 *   grant, a malformed call); a 5xx is usually them. The exact code is
 *   `http.response.status_code`, OTel's domain-specific attribute beside it.
 * - `other_status` — a non-ok status outside 4xx/5xx (an unfollowed 3xx, say).
 * - `timeout` — the call was aborted by the host's timeout (OTel's own example value).
 * - `network` — the call threw before any status arrived.
 * - `_OTHER` — OTel's fallback value: an error recorded without either of the facts above
 *   (a caller that only knew "it failed"). Counted as an error; never guessed into a
 *   better class.
 */
export const CONNECTOR_CALL_ERROR_TYPES = ['4xx', '5xx', 'other_status', 'timeout', 'network', '_OTHER'] as const;
export type ConnectorCallErrorType = (typeof CONNECTOR_CALL_ERROR_TYPES)[number];

/**
 * What a connector call's settlement may say about itself, beyond ok/error: how long it
 * took and what status it met. Optional on `recordConnectionUse` so a caller that knows
 * neither still records the health line exactly as before.
 */
export interface ConnectionUseTiming {
  /** Wall time of the outbound call, milliseconds. */
  durationMs?: number;
  /** The provider's HTTP status, when one arrived. */
  status?: number;
  /** The call was aborted by the host's timeout rather than failing on its own. */
  timedOut?: boolean;
}

export type ConnectionUseOutcome =
  | ({ ok: true } & ConnectionUseTiming)
  | ({ ok: false; error: string } & ConnectionUseTiming);

/**
 * One call, as the recorder receives it — keyed by OpenTelemetry names (see the module
 * header). Every field is closed or read off the connection row.
 */
export interface ConnectorCallRecord {
  /** The tenant's id (a ULID), off the connection row. */
  'substrat.tenant.id': string;
  /** The vertical's SLUG (e.g. `callout`) — the connection row's namespace, not an id. */
  'substrat.vertical': string;
  /** The provider slug the connection is for (`scrive`, `fortnox`, …). */
  'substrat.connection.provider': string;
  /** OTel `error.type`: absent on success, else one of {@link CONNECTOR_CALL_ERROR_TYPES}. */
  'error.type'?: ConnectorCallErrorType;
  /** OTel `http.response.status_code`: absent when no status arrived. */
  'http.response.status_code'?: number;
  /**
   * OTel `http.client.request.duration`, in SECONDS (OTel's unit for it). Absent when the
   * caller did not time the call — the data point writes that as `-1`.
   */
  'http.client.request.duration'?: number;
}

export interface ConnectorCallRecorder {
  /** Fire-and-forget. The hosts never await it, and swallow a throw. */
  record(call: ConnectorCallRecord): void;
}

/** The self-host default: the shape exists, nothing is written. */
export const noopConnectorCallRecorder: ConnectorCallRecorder = { record() {} };

/**
 * Classify a settled call. Reads a status and a boolean — never the error text, which is
 * the point: the class is derived from facts that cannot carry a payload.
 */
export function connectorCallErrorType(outcome: ConnectionUseOutcome): ConnectorCallErrorType | undefined {
  if (outcome.ok) return undefined;
  const status = outcome.status;
  if (typeof status === 'number' && Number.isFinite(status)) {
    if (status >= 500 && status < 600) return '5xx';
    if (status >= 400 && status < 500) return '4xx';
    return 'other_status';
  }
  if (outcome.timedOut === true) return 'timeout';
  if (outcome.timedOut === false) return 'network';
  return '_OTHER';
}

/**
 * The settlement a connection's `fetch` wrapper hands `recordConnectionUse` — the error
 * strings are exactly the ones the health line always carried, plus the timing facts the
 * recorder classifies from. One spelling, so the five wrappers (both hosts, three
 * connectors) cannot disagree about what a timeout is.
 */
export function settleConnectionUse(
  provider: string,
  durationMs: number,
  settled: { response: { ok: boolean; status: number } } | { error: unknown },
): ConnectionUseOutcome {
  if ('response' in settled) {
    const { ok, status } = settled.response;
    return ok
      ? { ok: true, durationMs, status }
      : { ok: false, error: `HTTP ${status} from ${provider}`, durationMs, status };
  }
  const err = settled.error;
  const name = err instanceof Error ? err.name : '';
  return {
    ok: false,
    error: err instanceof Error ? err.message : String(err),
    durationMs,
    // `AbortSignal.timeout` rejects with a `TimeoutError` DOMException; some runtimes
    // surface the abort as `AbortError`. Both mean the host's clock ran out.
    timedOut: name === 'TimeoutError' || name === 'AbortError',
  };
}

/** Build the record from the row's identity and the settlement. */
export function connectorCallRecord(
  row: { tenantId: string; vertical: string; provider: string },
  outcome: ConnectionUseOutcome,
): ConnectorCallRecord {
  const timed =
    typeof outcome.durationMs === 'number' && Number.isFinite(outcome.durationMs) && outcome.durationMs >= 0;
  const status = typeof outcome.status === 'number' && Number.isFinite(outcome.status) ? outcome.status : undefined;
  const errorType = connectorCallErrorType(outcome);
  return {
    'substrat.tenant.id': row.tenantId,
    'substrat.vertical': row.vertical,
    'substrat.connection.provider': row.provider,
    ...(errorType ? { 'error.type': errorType } : {}),
    ...(status !== undefined ? { 'http.response.status_code': status } : {}),
    // The settlement is timed in ms (where `Date.now()` is); OTel's unit is seconds.
    ...(timed ? { 'http.client.request.duration': outcome.durationMs! / 1000 } : {}),
  };
}

/** Hand a record to a recorder without letting it throw into the caller. */
export function recordConnectorCall(recorder: ConnectorCallRecorder, call: ConnectorCallRecord): void {
  try {
    const r = recorder.record(call) as unknown;
    // A recorder that returned a promise anyway is not awaited — but its rejection must
    // not surface as an unhandled one either.
    if (r && typeof (r as { catch?: unknown }).catch === 'function') {
      (r as Promise<unknown>).catch(() => {});
    }
  } catch {
    // Telemetry never fails a connector call.
  }
}

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

/** A recorder that also says how many writes it swallowed. */
export interface CountingConnectorCallRecorder extends ConnectorCallRecorder {
  /** Writes that threw and were dropped, since this recorder was built. */
  readonly dropped: number;
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
