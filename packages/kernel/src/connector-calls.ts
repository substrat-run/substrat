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
 * off the connection row (`provider`, `tenantId`, `vertical` — never the caller's input),
 * a member of the closed {@link CONNECTOR_CALL_OUTCOMES} enum, or a number. There is no
 * field a URL, a header, a request body, a credential or an error message could land in,
 * because the classifier ({@link connectorCallOutcome}) reads only a status code and an
 * error's `name`, and emits an enum member. A free-text "error class" would have been the
 * one door a provider's error body — which routinely echoes the request — walks through.
 *
 * ## Why it cannot fail or slow the call
 *
 * `record` returns `void` and the hosts never await it. The Analytics Engine recorder
 * wraps its write and counts what it swallows ({@link CountingConnectorCallRecorder}),
 * and the hosts wrap the call itself too, so a recorder someone else wrote cannot break a
 * dispatch by throwing either.
 */

/**
 * The outcome classes, closed. Grow-only like the ordinals below: a stored point keeps
 * the string it was written with, so a member is never renamed or reused.
 *
 * - `ok` — the provider answered 2xx.
 * - `http_4xx` / `http_5xx` — the provider answered with that class. A 4xx is usually
 *   us (a revoked grant, a malformed call); a 5xx is usually them.
 * - `http_other` — a non-ok status outside 4xx/5xx (an unfollowed 3xx, say).
 * - `timeout` — the call was aborted by the host's timeout.
 * - `network` — the call threw before any status arrived.
 * - `unknown` — an error recorded without either of the facts above (a caller that
 *   only knew "it failed"). Counted as an error; never guessed into a better class.
 */
export const CONNECTOR_CALL_OUTCOMES = [
  'ok',
  'http_4xx',
  'http_5xx',
  'http_other',
  'timeout',
  'network',
  'unknown',
] as const;
export type ConnectorCallOutcome = (typeof CONNECTOR_CALL_OUTCOMES)[number];

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

/** One call, as the recorder receives it. Every field is closed or read off the row. */
export interface ConnectorCallRecord {
  tenantId: string;
  vertical: string;
  provider: string;
  outcome: ConnectorCallOutcome;
  /** Milliseconds, or null when the caller did not time the call. */
  durationMs: number | null;
  /** The provider's HTTP status, or null when none arrived. */
  status: number | null;
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
export function connectorCallOutcome(outcome: ConnectionUseOutcome): ConnectorCallOutcome {
  if (outcome.ok) return 'ok';
  const status = outcome.status;
  if (typeof status === 'number' && Number.isFinite(status)) {
    if (status >= 500 && status < 600) return 'http_5xx';
    if (status >= 400 && status < 500) return 'http_4xx';
    return 'http_other';
  }
  if (outcome.timedOut === true) return 'timeout';
  if (outcome.timedOut === false) return 'network';
  return 'unknown';
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
  const durationMs =
    typeof outcome.durationMs === 'number' && Number.isFinite(outcome.durationMs) && outcome.durationMs >= 0
      ? outcome.durationMs
      : null;
  const status =
    typeof outcome.status === 'number' && Number.isFinite(outcome.status) ? outcome.status : null;
  return {
    tenantId: row.tenantId,
    vertical: row.vertical,
    provider: row.provider,
    outcome: connectorCallOutcome(outcome),
    durationMs,
    status,
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
 * The data point a record becomes. **A published shape** — the read in
 * `packages/control-plane-api/src/cf-observability.ts` indexes into it by ordinal, beside
 * the router's — so it only ever GROWS, never reorders:
 *
 * - `index1` tenantId
 * - `blob1` provider, `blob2` vertical, `blob3` outcome ({@link CONNECTOR_CALL_OUTCOMES})
 * - `double1` durationMs (`-1` when the call was not timed), `double2` HTTP status (`0`
 *   when none arrived)
 *
 * Its own dataset, never the router's: the router's `blob1` is a vertical and its
 * `blob4` a status class, and a point of this shape written there would be counted as
 * requests by every tenant-traffic read.
 */
export function connectorCallDataPoint(call: ConnectorCallRecord): {
  indexes: string[];
  blobs: string[];
  doubles: number[];
} {
  return {
    indexes: [call.tenantId],
    blobs: [call.provider, call.vertical, call.outcome],
    doubles: [call.durationMs ?? -1, call.status ?? 0],
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
