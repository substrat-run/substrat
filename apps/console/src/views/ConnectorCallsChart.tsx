import { useEffect, useState } from 'react';
import { Card, Select } from '../components';
import { ApiError, type Api } from '../lib/api';
import { bucketMinutesFor, connectorCallsSeries, type ConnectorCallsSeries } from '../lib/connector-calls';

const WINDOWS = [
  { value: '6', label: 'Last 6 hours' },
  { value: '24', label: 'Last 24 hours' },
  { value: '72', label: 'Last 3 days' },
  { value: '168', label: 'Last 7 days' },
];

const GREEN = 'var(--status-success-fg, #16a34a)';
const YELLOW = 'var(--status-warning-fg, #b45309)';
const RED = 'var(--status-danger-fg, #dc2626)';

const fmt = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

/**
 * Connector calls per provider over a window (#1691) — the trend the health table's
 * last-line cannot give. One small stacked-bar chart per provider on a shared time grid,
 * drawn the way the dashboard's traffic chart is (#1693): green (the provider answered)
 * at the base, yellow (4xx — usually us) above it, red (5xx, timeouts, calls that never
 * got a status) on top, so severity climbs toward the top of the bar. Each chart scales
 * to its own peak, because providers differ in volume by orders of magnitude and a shared
 * scale would flatten the quiet one whose error rate just spiked.
 *
 * A zero bucket still draws a baseline tick: the grid is zero-filled, and an empty hour
 * is the most interesting hour on a connector chart.
 */
export function ConnectorCallsChart({ api, provider }: { api: Api; provider?: string }) {
  const [hours, setHours] = useState(24);
  const [series, setSeries] = useState<ConnectorCallsSeries[]>();
  const [state, setState] = useState<'loading' | 'ready' | 'unconfigured' | 'error'>('loading');
  const [error, setError] = useState<string>();

  useEffect(() => {
    let live = true;
    setState('loading');
    void (async () => {
      try {
        const r = await api.connectorCalls({ hours, ...(provider ? { provider } : {}) });
        if (!live) return;
        setSeries(connectorCallsSeries(r.buckets, r.hours, Date.now()));
        setState('ready');
      } catch (e) {
        if (!live) return;
        // 501 is a fact about this control plane, not a failure: no dataset is named.
        if (e instanceof ApiError && e.status === 501) {
          setState('unconfigured');
          return;
        }
        setError((e as Error).message);
        setState('error');
      }
    })();
    return () => {
      live = false;
    };
  }, [api, hours, provider]);

  const width = bucketMinutesFor(hours);

  return (
    <Card
      padding={0}
      footer={`Every connector call the platform made, from Analytics Engine, in ${width}-minute buckets. Counts are sampling-weighted. Green: the provider answered. Yellow: a 4xx, usually a revoked grant or a malformed call. Red: a 5xx, a timeout, or a call that failed before any status arrived.`}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '12px 16px' }}>
        <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-primary)' }}>Calls over time</span>
        <Select
          options={WINDOWS}
          ariaLabel="Window"
          value={String(hours)}
          onChange={(e) => setHours(Number(e.target.value))}
          style={{ width: 150 }}
        />
      </div>
      <div style={{ display: 'grid', gap: 16, padding: '0 16px 16px' }}>
        {state === 'loading' && <Muted>Loading…</Muted>}
        {state === 'unconfigured' && (
          <Muted>Connector-call analytics are not configured on this control plane.</Muted>
        )}
        {state === 'error' && <span style={{ fontSize: 12.5, color: 'var(--status-danger-fg)' }}>{error}</span>}
        {state === 'ready' && series && series.length === 0 && <Muted>No connector calls in this window.</Muted>}
        {state === 'ready' && series?.map((s) => <ProviderChart key={s.provider} series={s} />)}
      </div>
    </Card>
  );
}

function Muted({ children }: { children: React.ReactNode }) {
  return <span style={{ fontSize: 12.5, color: 'var(--text-placeholder)' }}>{children}</span>;
}

/** One provider's stacked bars — exported for its test. */
export function ProviderChart({ series }: { series: ConnectorCallsSeries }) {
  const { cells, totals } = series;
  const W = cells.length;
  const H = 100;
  const peak = Math.max(1, ...cells.map((c) => c.calls));
  const errorRate = totals.calls > 0 ? (totals.red / totals.calls) * 100 : 0;
  return (
    <div style={{ display: 'grid', gap: 6 }}>
      <div style={{ display: 'flex', gap: 12, alignItems: 'baseline', flexWrap: 'wrap', fontSize: 12.5 }}>
        <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-primary)' }}>{series.provider}</span>
        <span style={{ color: 'var(--text-tertiary)' }}>
          {`${totals.calls.toLocaleString()} calls · ${errorRate.toFixed(errorRate > 0 && errorRate < 1 ? 1 : 0)}% red` +
            (series.peakP95 > 0 ? ` · worst p95 ${Math.round(series.peakP95)} ms` : '')}
        </span>
      </div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        style={{ width: '100%', height: 64, display: 'block' }}
        role="img"
        aria-label={`${series.provider}: ${totals.calls} calls over ${W} buckets — ${totals.green} answered, ${totals.yellow} 4xx, ${totals.red} failed`}
      >
        {cells.map((c, i) => {
          const label = `${fmt(c.start)} — ${c.calls.toLocaleString()} calls, ${c.green.toLocaleString()} ok, ${c.yellow.toLocaleString()} 4xx, ${c.red.toLocaleString()} failed`;
          if (c.calls === 0) {
            return (
              <rect key={c.start} x={i + 0.1} y={H - 0.6} width={0.8} height={0.6} fill="var(--text-tertiary, #6b7280)" opacity={0.4}>
                <title>{label}</title>
              </rect>
            );
          }
          let y = H;
          return (
            <g key={c.start}>
              {[
                { n: c.green, color: GREEN },
                { n: c.yellow, color: YELLOW },
                { n: c.red, color: RED },
              ].map((s) => {
                const h = (s.n / peak) * (H - 2);
                if (h <= 0) return null;
                y -= h;
                return <rect key={s.color} x={i + 0.1} y={y} width={0.8} height={h} fill={s.color} opacity={0.85} />;
              })}
              <title>{label}</title>
            </g>
          );
        })}
      </svg>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--text-tertiary)', fontFamily: 'var(--font-mono)' }}>
        <span>{fmt(cells[0]!.start)}</span>
        <span>{fmt(cells[W - 1]!.start)}</span>
      </div>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', fontSize: 11.5, color: 'var(--text-tertiary)' }}>
        {[
          { n: totals.green, color: GREEN, word: 'answered' },
          { n: totals.yellow, color: YELLOW, word: '4xx' },
          { n: totals.red, color: RED, word: '5xx / timeout / failed' },
        ].map((l) => (
          <span key={l.word} style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
            <span aria-hidden style={{ width: 8, height: 8, borderRadius: '50%', background: l.color, display: 'inline-block' }} />
            <span>
              {l.n.toLocaleString()} {l.word}
            </span>
          </span>
        ))}
      </div>
    </div>
  );
}
