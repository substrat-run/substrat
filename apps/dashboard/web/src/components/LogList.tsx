import { useState } from 'react';
import type { ObservabilityLogEvent } from '../lib/api';

const fmtTime = (t: number | null) => (t ? new Date(t).toISOString().slice(5, 19).replace('T', ' ') : '—');
const fmtMs = (ms: number) => (ms >= 100 ? `${Math.round(ms)} ms` : `${ms.toFixed(1)} ms`);

/**
 * Shared renderer for observability log events — the per-app tab and the per-vertical
 * panel both use it. The neutral seam (observability.ts) now carries more than
 * message/level (trigger, eventType, entrypoint, requestId, timing) plus the backend's
 * `raw` event: a row shows the salient fields inline and, when `raw` is present, expands
 * to the full JSON — the drill-down Cloudflare's own console gives, without pinning this
 * UI to any provider's field names.
 */
export function LogList({ events, maxHeight = 420 }: { events: ObservabilityLogEvent[]; maxHeight?: number }) {
  const [open, setOpen] = useState<ReadonlySet<number>>(() => new Set());
  const toggle = (i: number) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });

  return (
    <div style={{ maxHeight, overflowY: 'auto' }}>
      {events.map((l, i) => {
        const label = l.trigger ?? l.message ?? '(no message)';
        // Show the raw message alongside only when the trigger didn't already say it.
        const sub = l.trigger && l.message && l.message !== l.trigger ? l.message : null;
        const kind = [l.eventType, l.entrypoint].filter(Boolean).join(' · ');
        const hasRaw = l.raw !== undefined && l.raw !== null;
        const isOpen = open.has(i);
        const last = i === events.length - 1;
        return (
          <div key={i} style={{ borderBottom: last && !isOpen ? 'none' : '1px solid var(--border-subtle)' }}>
            <div
              onClick={hasRaw ? () => toggle(i) : undefined}
              style={{
                display: 'flex',
                gap: 12,
                alignItems: 'baseline',
                padding: '8px 14px',
                fontFamily: 'var(--font-mono)',
                fontSize: 12,
                cursor: hasRaw ? 'pointer' : 'default',
              }}
            >
              <span style={{ width: 10, color: 'var(--text-tertiary)', flexShrink: 0 }}>
                {hasRaw ? (isOpen ? '▾' : '▸') : ''}
              </span>
              <span style={{ color: 'var(--text-tertiary)', whiteSpace: 'nowrap', flexShrink: 0 }}>
                {fmtTime(l.timestamp)}
              </span>
              <span
                style={{
                  width: 40,
                  flexShrink: 0,
                  color: l.level === 'error' ? 'var(--status-danger-fg)' : 'var(--text-tertiary)',
                }}
              >
                {l.level ?? '—'}
              </span>
              <span style={{ flex: 1, minWidth: 0 }}>
                <span style={{ color: 'var(--text-primary)', wordBreak: 'break-all' }}>{label}</span>
                {sub && (
                  <span style={{ color: 'var(--text-secondary)', marginLeft: 8, wordBreak: 'break-all' }}>{sub}</span>
                )}
                {kind && <span style={{ color: 'var(--text-tertiary)', marginLeft: 8 }}>{kind}</span>}
              </span>
              {l.outcome && l.outcome !== 'ok' && (
                <span style={{ color: 'var(--status-danger-fg)', whiteSpace: 'nowrap', flexShrink: 0 }}>{l.outcome}</span>
              )}
              {l.cpuTimeMs !== null && (
                <span style={{ color: 'var(--text-tertiary)', whiteSpace: 'nowrap', flexShrink: 0 }} title="CPU time">
                  {fmtMs(l.cpuTimeMs)}
                </span>
              )}
              {l.requestId && (
                <span
                  style={{ color: 'var(--text-tertiary)', whiteSpace: 'nowrap', flexShrink: 0 }}
                  title="Request ID"
                >
                  {l.requestId}
                </span>
              )}
            </div>
            {isOpen && hasRaw && (
              <pre
                style={{
                  margin: 0,
                  padding: '4px 14px 12px 36px',
                  fontFamily: 'var(--font-mono)',
                  fontSize: 11.5,
                  lineHeight: 1.5,
                  color: 'var(--text-secondary)',
                  background: 'var(--surface-inset)',
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                }}
              >
                {JSON.stringify(l.raw, null, 2)}
              </pre>
            )}
          </div>
        );
      })}
    </div>
  );
}
