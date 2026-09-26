import { useEffect, useState } from 'react';
import { api, ApiError, type ObservabilityLogEvent } from '../lib/api';
import { callLogsWindow, CALL_LOGS_MARGIN_MINUTES } from '../lib/history';
import { shortId } from '../lib/format';
import { LogList } from '../components/LogList';
import { DEV_MOCK } from '../lib/mock';
import { mockCallLogs } from '../lib/mock-timeline';

/**
 * The log lines of the call behind one event (#1525) — the other half of `InvocationStrip`.
 *
 * That strip says what the call RECORDED (its events); this says what it WROTE: the
 * stamped request line with its status and duration, and whatever the vertical's own code
 * logged while serving it. Both are keyed by the same id, which is how a reader moves from
 * "this event happened" to "and here is the exception that came with it".
 *
 * The read is the app's ordinary tenant-logs read, narrowed by `invocationId` — so it can
 * only return lines this team's app wrote, never another team's, whatever id is given.
 * It is bracketed around the event's instant (`callLogsWindow`) rather than the page's
 * range, because an event can be days old and a 24-hour default would report "no lines"
 * for a call whose lines were simply outside it.
 */
export function InvocationLogsStrip({
  scopeId,
  invocationId,
  occurredAt,
  anchorNoun = 'event',
}: {
  scopeId: string;
  invocationId: string;
  /** The instant the event was recorded — the anchor the read's window is built around. */
  occurredAt: string;
  /** What `occurredAt` is the instant of, as a noun phrase in the copy — "event" unless the caller anchors on something else (a delivery attempt). */
  anchorNoun?: string;
}) {
  const [logs, setLogs] = useState<ObservabilityLogEvent[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setLogs(null);
    setErr(null);
    const window = callLogsWindow(occurredAt);
    if (window === null) {
      setErr(`This ${anchorNoun} carries no usable time, so its log lines cannot be looked up.`);
      return;
    }
    if (DEV_MOCK) {
      setLogs(mockCallLogs(invocationId));
      return;
    }
    api
      .appTenantLogs(scopeId, { invocationId, since: window.since, until: window.until, limit: 100 })
      .then((r) => live && setLogs(r))
      .catch((e) => {
        if (!live) return;
        // The plane's own words for a refusal are safe to show and say why; a 501 is the
        // one status with a fixed meaning (no log backend on this platform).
        setErr(
          e instanceof ApiError
            ? e.status === 501
              ? 'Log streaming is not configured on this platform.'
              : `Logs are unavailable (${e.status}): ${e.message}`
            : 'Logs are unavailable right now.',
        );
      });
    return () => {
      live = false;
    };
  }, [scopeId, invocationId, occurredAt, anchorNoun]);

  if (err) return <div style={{ fontSize: 12, color: 'var(--status-danger-fg)' }}>{err}</div>;
  if (!logs) return <div style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>Reading the call’s log lines…</div>;

  return (
    <div style={{ display: 'grid', gap: 6, paddingLeft: 10, borderLeft: '2px solid var(--border-default)' }}>
      <div style={{ fontSize: 11.5, color: 'var(--text-tertiary)', fontFamily: 'var(--font-mono)' }} title={invocationId}>
        log lines of call {shortId(invocationId)}
      </div>
      {logs.length === 0 ? (
        <div style={{ fontSize: 12, color: 'var(--status-warning-fg)' }}>
          No log lines found for this call within {CALL_LOGS_MARGIN_MINUTES} minutes of the {anchorNoun}. They may be
          older than the platform keeps logs, or the version that served the call predates per-request logging.
        </div>
      ) : (
        <div style={{ border: '1px solid var(--border-subtle)', borderRadius: 6, overflow: 'hidden' }}>
          <LogList events={logs} maxHeight={260} compact />
        </div>
      )}
    </div>
  );
}
