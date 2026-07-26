import { useEffect, useState } from 'react';
import { Button, Card, EmptyState, Select, Tag } from '../components';
import { ApiError } from '../lib/api';
import type { Api, RecentLogEvent, ServiceMetricsRow } from '../lib/api';

/**
 * The staff fleet view (design/observability.md §5, view 1): per-service invocation
 * metrics and recent logs, proxied over the control plane's provider-neutral
 * observability seam (Cloudflare analytics is the current backend). Tier-3 numbers —
 * sampled, approximate, never money (master-plan §5.3) — which is why everything here
 * is a rate or a latency, and nothing is presented as an exact count.
 */

const RANGES = [
  { value: '1', label: 'Last hour' },
  { value: '24', label: 'Last 24 hours' },
  { value: '72', label: 'Last 3 days' },
];

const fmt = (n: number) => n.toLocaleString('en-US');
/** Cloudflare reports CPU time in microseconds; people read milliseconds. */
const ms = (us: number) => (us >= 100_000 ? `${Math.round(us / 1000)} ms` : `${(us / 1000).toFixed(1)} ms`);
const pct = (part: number, whole: number) => (whole === 0 ? '—' : `${((part / whole) * 100).toFixed(2)}%`);

export interface ObservabilityProps {
  api: Api;
}

export function Observability({ api }: ObservabilityProps) {
  const [hours, setHours] = useState('24');
  const [rows, setRows] = useState<ServiceMetricsRow[]>([]);
  const [state, setState] = useState<'loading' | 'ready' | 'unconfigured' | 'error'>('loading');
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<string>();
  const [logs, setLogs] = useState<RecentLogEvent[]>([]);
  const [logState, setLogState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [logError, setLogError] = useState('');
  const [errorsOnly, setErrorsOnly] = useState(false);

  useEffect(() => {
    let live = true;
    setState('loading');
    void (async () => {
      try {
        const metrics = await api.serviceMetrics(Number(hours));
        if (!live) return;
        setRows(metrics);
        setState('ready');
      } catch (e) {
        if (!live) return;
        if (e instanceof ApiError && e.status === 501) setState('unconfigured');
        else {
          setError(e instanceof Error ? e.message : String(e));
          setState('error');
        }
      }
    })();
    return () => {
      live = false;
    };
  }, [api, hours]);

  useEffect(() => {
    if (!selected) return;
    let live = true;
    setLogState('loading');
    void (async () => {
      try {
        // Logs are capped to the last 24h even on the 3-day metrics range — Workers
        // Logs retention is short and a narrower window keeps the query cheap.
        const events = await api.recentLogs({
          service: selected,
          hours: Math.min(Number(hours), 24),
          limit: 100,
          level: errorsOnly ? 'error' : undefined,
        });
        if (!live) return;
        setLogs(events);
        setLogState('ready');
      } catch (e) {
        if (!live) return;
        setLogError(e instanceof Error ? e.message : String(e));
        setLogState('error');
      }
    })();
    return () => {
      live = false;
    };
  }, [api, selected, hours, errorsOnly]);

  const totals = rows.reduce(
    (acc, r) => ({ requests: acc.requests + r.requests, errors: acc.errors + r.errors }),
    { requests: 0, errors: 0 },
  );

  const th: React.CSSProperties = {
    textAlign: 'left',
    padding: '0 16px',
    height: 36,
    fontSize: 11,
    fontWeight: 500,
    letterSpacing: '0.06em',
    textTransform: 'uppercase',
    color: 'var(--text-tertiary)',
    borderBottom: '1px solid var(--border-default)',
    background: 'var(--surface-inset)',
    whiteSpace: 'nowrap',
  };
  const td: React.CSSProperties = {
    padding: '0 16px',
    height: 40,
    borderBottom: '1px solid var(--border-subtle)',
    fontSize: 12.5,
  };
  const num: React.CSSProperties = { ...td, textAlign: 'right', fontFamily: 'var(--font-mono)' };
  const numTh: React.CSSProperties = { ...th, textAlign: 'right' };

  if (state === 'unconfigured') {
    return (
      <EmptyState
        title="Observability is not configured"
        description="The control plane has no observability backend, so there is nothing to proxy. For the Cloudflare backend, set CF_API_TOKEN / CF_ACCOUNT_ID — metrics need Account Analytics read, logs need Workers Observability read."
      />
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 22, lineHeight: '29px', fontWeight: 600, letterSpacing: '-0.02em', color: 'var(--text-primary)' }}>
            Observability
          </h1>
          <p style={{ margin: '4px 0 0', fontSize: 13, color: 'var(--text-tertiary)', maxWidth: 640 }}>
            Per-service invocations across the whole fleet — platform workers and pushed verticals alike.
            Sampled and approximate by design; row click shows recent logs.
          </p>
        </div>
        <div style={{ flex: 1 }} />
        <Select options={RANGES} value={hours} onChange={(e) => setHours(e.target.value)} style={{ width: 160 }} />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 16 }}>
        {[
          { label: 'Requests', value: state === 'ready' ? fmt(totals.requests) : '…' },
          { label: 'Errors', value: state === 'ready' ? fmt(totals.errors) : '…' },
          { label: 'Error rate', value: state === 'ready' ? pct(totals.errors, totals.requests) : '…' },
          { label: 'Active services', value: state === 'ready' ? String(rows.length) : '…' },
        ].map((t) => (
          <Card key={t.label} padding={16}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <span style={{ fontSize: 11, fontWeight: 500, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--text-tertiary)' }}>
                {t.label}
              </span>
              <span style={{ fontSize: 26, fontWeight: 600, letterSpacing: '-0.02em', color: 'var(--text-primary)', fontFamily: 'var(--font-mono)' }}>
                {t.value}
              </span>
            </div>
          </Card>
        ))}
      </div>

      {state === 'error' && (
        <Card padding={16}>
          <span style={{ fontSize: 13, color: 'var(--status-danger-fg)' }}>Metrics query failed: {error}</span>
        </Card>
      )}

      <Card padding={0} footer="Invocation analytics grouped by service. CPU times are per-request quantiles.">
        <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: 'var(--font-sans)', fontSize: 14 }}>
          <thead>
            <tr>
              <th style={th}>Service</th>
              <th style={numTh}>Requests</th>
              <th style={numTh}>Errors</th>
              <th style={numTh}>Error rate</th>
              <th style={numTh}>CPU P50</th>
              <th style={numTh}>CPU P99</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr
                key={r.service}
                onClick={() => setSelected(selected === r.service ? undefined : r.service)}
                style={{ cursor: 'pointer', background: selected === r.service ? 'var(--surface-hover)' : 'transparent' }}
              >
                <td style={{ ...td, fontFamily: 'var(--font-mono)', color: 'var(--text-primary)' }}>
                  {r.service}
                  {r.namespace && (
                    <Tag mono style={{ marginLeft: 8 }}>
                      {r.namespace}
                    </Tag>
                  )}
                </td>
                <td style={num}>{fmt(r.requests)}</td>
                <td style={{ ...num, color: r.errors > 0 ? 'var(--status-danger-fg)' : undefined }}>{fmt(r.errors)}</td>
                <td style={num}>{pct(r.errors, r.requests)}</td>
                <td style={num}>{ms(r.cpuTimeP50)}</td>
                <td style={num}>{ms(r.cpuTimeP99)}</td>
              </tr>
            ))}
            {state === 'ready' && rows.length === 0 && (
              <tr>
                <td colSpan={6} style={{ ...td, color: 'var(--text-placeholder)', textAlign: 'center', height: 80 }}>
                  No invocations in this window.
                </td>
              </tr>
            )}
            {state === 'loading' && (
              <tr>
                <td colSpan={6} style={{ ...td, color: 'var(--text-placeholder)', textAlign: 'center', height: 80 }}>
                  Loading…
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </Card>

      {selected && (
        <Card
          padding={0}
          footer="Recent log events from the observability backend. Retention is days, not months — this is a debug surface, not history."
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 16px', borderBottom: '1px solid var(--border-default)' }}>
            <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', fontFamily: 'var(--font-mono)' }}>{selected}</span>
            <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>recent logs</span>
            <div style={{ flex: 1 }} />
            <Button variant="ghost" size="sm" onClick={() => setErrorsOnly(!errorsOnly)}>
              {errorsOnly ? 'Show all levels' : 'Errors only'}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setSelected(undefined)}>
              Close
            </Button>
          </div>
          {logState === 'error' ? (
            <div style={{ padding: 16, fontSize: 13, color: 'var(--status-danger-fg)' }}>Log query failed: {logError}</div>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: 'var(--font-sans)', fontSize: 14 }}>
              <thead>
                <tr>
                  <th style={{ ...th, width: 170 }}>Time</th>
                  <th style={{ ...th, width: 80 }}>Level</th>
                  <th style={th}>Message</th>
                  <th style={{ ...th, width: 110 }}>Outcome</th>
                </tr>
              </thead>
              <tbody>
                {logs.map((l, i) => (
                  <tr key={i}>
                    <td style={{ ...td, fontFamily: 'var(--font-mono)', color: 'var(--text-tertiary)', whiteSpace: 'nowrap' }}>
                      {l.timestamp ? new Date(l.timestamp).toISOString().slice(0, 19).replace('T', ' ') : '—'}
                    </td>
                    <td style={{ ...td, fontFamily: 'var(--font-mono)', color: l.level === 'error' ? 'var(--status-danger-fg)' : 'var(--text-tertiary)' }}>
                      {l.level ?? '—'}
                    </td>
                    <td style={{ ...td, fontFamily: 'var(--font-mono)', fontSize: 12, wordBreak: 'break-all' }}>
                      {l.message ?? <span style={{ color: 'var(--text-placeholder)' }}>(no message)</span>}
                    </td>
                    <td style={{ ...td, fontFamily: 'var(--font-mono)', color: 'var(--text-tertiary)' }}>{l.outcome ?? '—'}</td>
                  </tr>
                ))}
                {logState === 'ready' && logs.length === 0 && (
                  <tr>
                    <td colSpan={4} style={{ ...td, color: 'var(--text-placeholder)', textAlign: 'center', height: 60 }}>
                      No log events in this window.
                    </td>
                  </tr>
                )}
                {logState === 'loading' && (
                  <tr>
                    <td colSpan={4} style={{ ...td, color: 'var(--text-placeholder)', textAlign: 'center', height: 60 }}>
                      Loading…
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          )}
        </Card>
      )}
    </div>
  );
}
