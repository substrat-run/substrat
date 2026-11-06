import { useEffect, useState } from 'react';
import { Button, Card, EmptyState, Select, Table, Tag } from '../components';
import { ApiError } from '../lib/api';
import type { Api, ServiceMetricsRow } from '../lib/api';
import { LOGS_IDLE, LOGS_INCOMPLETE_NOTICE, loadLogs, logsLoading, logsPanelOf, type LogsView } from '../lib/logs-view';

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


/**
 * Said above the logs table when the plane marked the page it answered as possibly incomplete
 * (`x-substrat-logs-incomplete`, #2520): the read stopped before it could vouch for the whole
 * window, so a short page is not "nothing more". `logsPanelOf` decides when it shows.
 */
export function LogsIncompleteNotice() {
  return (
    <div
      role="status"
      style={{ padding: '10px 16px', fontSize: 12.5, background: 'var(--status-warning-bg)', color: 'var(--status-warning-fg)' }}
    >
      {LOGS_INCOMPLETE_NOTICE}
    </div>
  );
}

/**
 * The recent-logs card's body: everything under its header, a pure function of the view (props
 * only, no effects), so a render test drives every branch. What shows is `logsPanelOf`'s call.
 */
export function LogsCard({ view }: { view: LogsView }) {
  const panel = logsPanelOf(view);
  return (
    <>
      {panel.notice && <LogsIncompleteNotice />}
      {panel.failure !== null ? (
        <div style={{ padding: 16, fontSize: 13, color: 'var(--status-danger-fg)' }}>{panel.failure}</div>
      ) : (
        <>
          <Table
            label="Recent logs"
            rows={view.events}
            emptyText={panel.emptyRow ?? ''}
            columns={[
              {
                header: 'Time',
                width: 170,
                mono: true,
                muted: true,
                render: (l) => (l.timestamp ? new Date(l.timestamp).toISOString().slice(0, 19).replace('T', ' ') : '—'),
              },
              {
                header: 'Level',
                width: 80,
                mono: true,
                render: (l) => <span style={{ color: l.level === 'error' ? 'var(--status-danger-fg)' : 'var(--text-tertiary)' }}>{l.level ?? '—'}</span>,
              },
              {
                header: 'Message',
                mono: true,
                render: (l) => (
                  <span style={{ wordBreak: 'break-all', whiteSpace: 'normal' }}>{l.message ?? <span style={{ color: 'var(--text-placeholder)' }}>(no message)</span>}</span>
                ),
              },
              { header: 'Outcome', width: 110, mono: true, muted: true, render: (l) => l.outcome ?? '—' },
            ]}
          />
          {panel.loading && <div style={{ padding: 16, fontSize: 13, textAlign: 'center', color: 'var(--text-placeholder)' }}>Loading…</div>}
        </>
      )}
    </>
  );
}

export interface ObservabilityProps {
  api: Api;
}

export function Observability({ api }: ObservabilityProps) {
  const [hours, setHours] = useState('24');
  const [rows, setRows] = useState<ServiceMetricsRow[]>([]);
  const [state, setState] = useState<'loading' | 'ready' | 'unconfigured' | 'error'>('loading');
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<string>();
  const [logView, setLogView] = useState(LOGS_IDLE);
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
    setLogView(logsLoading);
    void (async () => {
      // Logs are capped to the last 24h even on the 3-day metrics range — Workers
      // Logs retention is short and a narrower window keeps the query cheap.
      const next = await loadLogs(api, {
        service: selected,
        hours: Math.min(Number(hours), 24),
        limit: 100,
        level: errorsOnly ? 'error' : undefined,
      });
      if (live) setLogView(next);
    })();
    return () => {
      live = false;
    };
  }, [api, selected, hours, errorsOnly]);

  const totals = rows.reduce(
    (acc, r) => ({ requests: acc.requests + r.requests, errors: acc.errors + r.errors }),
    { requests: 0, errors: 0 },
  );


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
        <Table
          label="Services"
          rows={rows}
          rowKey={(r) => r.service}
          expanded={selected}
          onRowClick={(r) => setSelected(selected === r.service ? undefined : r.service)}
          emptyText={state === 'loading' ? 'Loading…' : state === 'ready' ? 'No invocations in this window.' : ''}
          columns={[
            {
              header: 'Service',
              mono: true,
              render: (r) => (
                <>
                  {r.service}
                  {r.namespace && (
                    <Tag mono style={{ marginLeft: 8 }}>
                      {r.namespace}
                    </Tag>
                  )}
                </>
              ),
            },
            { header: 'Requests', align: 'right', mono: true, render: (r) => fmt(r.requests) },
            {
              header: 'Errors',
              align: 'right',
              mono: true,
              render: (r) => <span style={{ color: r.errors > 0 ? 'var(--status-danger-fg)' : undefined }}>{fmt(r.errors)}</span>,
            },
            { header: 'Error rate', align: 'right', mono: true, render: (r) => pct(r.errors, r.requests) },
            { header: 'CPU P50', align: 'right', mono: true, render: (r) => ms(r.cpuTimeP50) },
            { header: 'CPU P99', align: 'right', mono: true, render: (r) => ms(r.cpuTimeP99) },
          ]}
        />
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
          <LogsCard view={logView} />
        </Card>
      )}
    </div>
  );
}
