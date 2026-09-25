import { useEffect, useMemo, useState } from 'react';
import { Badge } from '@substrat-run/ui';
import { api, type AppHealthRow, type AppMetricsView, type AppRow } from '../lib/api';
import { DEV_MOCK, MOCK_APP_METRICS, MOCK_FLEET_HEALTH } from '../lib/mock';
import { VERDICTS, compact, duration, errorRate, fleetRows, type FleetRow, type FleetVerdict } from '../lib/fleet-rows';

/**
 * Fleet health as the Apps table (#1767, the redesign's round-2 placement of #1238):
 * one row per app, worst first, with the verdict, the sentence behind it, and traffic.
 * Chips above filter to one verdict and carry its count.
 *
 * `silent` stays as loud as `failing` here, as it was in the rollup this replaces: an
 * app nothing has checked is not an app that is fine.
 *
 * Also the Pulse page's Health sub-view — one table, two entrances.
 */
const COLS = '120px 200px minmax(0,1fr) 96px 80px 80px';

export function FleetHealth({
  apps,
  onOpen,
  onRetry,
}: {
  apps: AppRow[];
  /** Where a row lands — the app page, or on Pulse the app's schedules. */
  onOpen: (scopeId: string) => void;
  /** Present on the Apps page, where a failed install can be retried from its row. */
  onRetry?: (scopeId: string) => void;
}) {
  const [health, setHealth] = useState<AppHealthRow[] | null | undefined>(undefined);
  const [metrics, setMetrics] = useState<AppMetricsView | null | undefined>(undefined);
  const [filter, setFilter] = useState<FleetVerdict | null>(null);

  useEffect(() => {
    let live = true;
    if (DEV_MOCK) {
      setHealth(MOCK_FLEET_HEALTH);
      setMetrics(MOCK_APP_METRICS);
      return;
    }
    // Two reads, and neither gates the other: a missing verdict still leaves the
    // traffic, and missing traffic still leaves the verdicts.
    api.fleetHealth().then((r) => live && setHealth(r.rows)).catch(() => live && setHealth(null));
    api.appMetrics(24).then((m) => live && setMetrics(m)).catch(() => live && setMetrics(null));
    return () => {
      live = false;
    };
  }, []);

  const rows = useMemo(() => fleetRows({ apps, health: health ?? null, metrics: metrics ?? null }), [apps, health, metrics]);
  const counts = useMemo(() => {
    const c = new Map<FleetVerdict, number>();
    for (const r of rows) c.set(r.verdict, (c.get(r.verdict) ?? 0) + 1);
    return (Object.keys(VERDICTS) as FleetVerdict[]).filter((k) => c.has(k)).map((k) => ({ k, n: c.get(k)! }));
  }, [rows]);
  const shown = filter ? rows.filter((r) => r.verdict === filter) : rows;
  const loading = health === undefined || metrics === undefined;
  const trafficNote = metrics === null ? 'Traffic could not be read.' : metrics && !metrics.available ? 'Traffic is not measured on this platform.' : null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        {counts.map(({ k, n }) => (
          <VerdictChip key={k} verdict={k} n={n} on={filter === k} onClick={() => setFilter((f) => (f === k ? null : k))} />
        ))}
        <span style={{ flex: 1 }} />
        <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>
          worst first · verdicts from recorded failures, schedules and freshness rules · traffic over 24h
        </span>
      </div>
      <div role="table" aria-label="App health" aria-busy={loading} style={{ border: '1px solid var(--border-default)', borderRadius: 12, background: 'var(--surface-card)', boxShadow: 'var(--shadow-sm)', overflow: 'hidden' }}>
        <div role="row" style={{ display: 'grid', gridTemplateColumns: COLS, gap: '0 12px', alignItems: 'center', height: 36, padding: '0 16px', fontSize: 11, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--text-tertiary)', borderBottom: '1px solid var(--border-default)' }}>
          <span role="columnheader">Health</span>
          <span role="columnheader">App</span>
          <span role="columnheader">Why</span>
          <span role="columnheader" style={{ textAlign: 'right' }}>Requests</span>
          <span role="columnheader" style={{ textAlign: 'right' }}>Errors</span>
          <span role="columnheader" style={{ textAlign: 'right' }}>p95</span>
        </div>
        {shown.map((r, i) => (
          <FleetTableRow key={r.scopeId} row={r} last={i === shown.length - 1} loading={loading} onOpen={() => onOpen(r.scopeId)} {...(onRetry ? { onRetry: () => onRetry(r.scopeId) } : {})} />
        ))}
      </div>
      {trafficNote && <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>{trafficNote}</span>}
    </div>
  );
}

function VerdictChip({ verdict, n, on, onClick }: { verdict: FleetVerdict; n: number; on: boolean; onClick: () => void }) {
  const v = VERDICTS[verdict];
  const dot = v.status === 'neutral' ? 'var(--status-neutral-dot)' : `var(--status-${v.status}-fg)`;
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 6, height: 28, padding: '0 10px', borderRadius: 999, fontSize: 12.5, cursor: 'pointer',
        color: 'var(--text-primary)',
        border: `1px solid ${on ? 'var(--brand-400)' : hover ? 'var(--border-strong)' : 'var(--border-default)'}`,
        background: on ? 'var(--surface-brand-subtle)' : 'var(--surface-card)',
      }}
    >
      <span style={{ width: 7, height: 7, borderRadius: '50%', background: dot }} />
      {v.label} <span style={{ fontFamily: 'var(--font-mono)' }}>{n}</span>
    </button>
  );
}

function FleetTableRow({ row, last, loading, onOpen, onRetry }: { row: FleetRow; last: boolean; loading: boolean; onOpen: () => void; onRetry?: () => void }) {
  const [hover, setHover] = useState(false);
  const v = VERDICTS[row.verdict];
  const rate = row.requests !== null && row.errors !== null ? errorRate(row.errors, row.requests) : null;
  const hot = row.requests !== null && row.errors !== null && row.requests > 0 && row.errors / row.requests >= 0.01;
  const num = { textAlign: 'right' as const, fontFamily: 'var(--font-mono)', fontSize: 12.5 };
  const dash = <span style={{ color: 'var(--text-placeholder)' }}>{loading ? '…' : '—'}</span>;
  return (
    <div
      role="row"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => { if (e.key === 'Enter') onOpen(); }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: 'grid', gridTemplateColumns: COLS, gap: '0 12px', alignItems: 'center', minHeight: 48, padding: '6px 16px',
        borderBottom: last ? 'none' : '1px solid var(--border-subtle)', color: 'var(--text-primary)', cursor: 'pointer',
        background: hover ? 'var(--surface-hover)' : 'transparent',
      }}
    >
      <span role="cell"><Badge status={v.status}>{v.label}</Badge></span>
      <span role="cell" style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        <span style={{ fontSize: 13.5, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{row.name}</span>
        <span title={row.scopeId} style={{ fontFamily: 'var(--font-mono)', fontSize: 11.5, color: 'var(--text-tertiary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {row.vertical} · {row.scopeId.slice(-8)}
        </span>
      </span>
      <span role="cell" style={{ fontSize: 13, lineHeight: '19px', color: 'var(--text-secondary)', textWrap: 'pretty' } as React.CSSProperties}>
        {row.why}
        {row.verdict === 'install-failed' && onRetry && (
          <>
            {' '}
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); onRetry(); }}
              style={{ appearance: 'none', border: 0, background: 'none', padding: 0, font: 'inherit', color: 'var(--text-link)', textDecoration: 'underline', cursor: 'pointer' }}
            >
              Retry
            </button>
          </>
        )}
      </span>
      <span role="cell" style={num}>{row.requests === null ? dash : compact(row.requests)}</span>
      <span role="cell" style={{ ...num, color: hot ? 'var(--status-danger-fg)' : 'var(--text-secondary)' }}>{rate ?? dash}</span>
      <span role="cell" style={{ ...num, color: 'var(--text-secondary)' }}>{row.p95 === null ? dash : duration(row.p95)}</span>
    </div>
  );
}
