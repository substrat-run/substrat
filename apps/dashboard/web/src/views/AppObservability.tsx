import { useEffect, useMemo, useState } from 'react';
import { Button, Input, Select } from '@substrat-run/ui';
import { api, ApiError, type AppRow, type ObservabilityLogEvent, type ObservabilityRow } from '../lib/api';
import { DEV_MOCK, MOCK_OBSERVABILITY, MOCK_OBSERVABILITY_LOGS } from '../lib/mock';
import { GridTable, Row } from '../components/layout';
import { card, MonoTag } from '../components/ui';

const fmtCpu = (us: number) => (us >= 100_000 ? `${Math.round(us / 1000)} ms` : `${(us / 1000).toFixed(1)} ms`);

/** Query windows offered — capped at 72h because that's the plane's cap; the backend's
 *  own retention (7 days on Workers Logs today) bounds it anyway. */
const RANGES = [
  { label: 'Last hour', hours: 1 },
  { label: 'Last 24 hours', hours: 24 },
  { label: 'Last 3 days', hours: 72 },
] as const;
const LEVELS = ['All levels', 'error', 'warn', 'info', 'log', 'debug'];

/**
 * The per-app Observability tab (design/observability.md §5, view 2; issue #471):
 * traffic per deployed version of THIS app's vertical, and the versions' recent logs
 * with level / text filters. Everything here is a pure consumer of the worker's
 * owner-narrowed routes — "filtered by app" is the `vertical` param resolved against
 * the ownership map server-side, never a choice this client is trusted with, and an
 * unowned vertical reads exactly like one with no traffic. Tier-3 numbers: sampled,
 * approximate, never money.
 */
export function AppObservability({ app }: { app: AppRow }) {
  const [hours, setHours] = useState<(typeof RANGES)[number]['hours']>(24);
  const [rows, setRows] = useState<ObservabilityRow[] | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'absent' | 'error'>('loading');
  // `false` only when the per-app deployments read says the vertical is someone
  // else's — that's what turns the empty state from "no traffic" into "not yours".
  const [owned, setOwned] = useState<boolean | null>(null);

  const [service, setService] = useState<string | null>(null);
  const [level, setLevel] = useState(LEVELS[0]);
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState('');
  const [logs, setLogs] = useState<ObservabilityLogEvent[] | null>(null);
  const [logsFailed, setLogsFailed] = useState(false);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (DEV_MOCK) {
      setOwned(true);
      return;
    }
    let live = true;
    api
      .appDeployments(app.app_scope_id)
      .then((d) => live && setOwned(d.owned !== false))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [app.app_scope_id]);

  useEffect(() => {
    let live = true;
    setState('loading');
    void (async () => {
      try {
        const r = DEV_MOCK ? MOCK_OBSERVABILITY : await api.observabilityMetrics(hours, app.vertical_slug);
        if (!live) return;
        setRows(r);
        setState('ready');
      } catch (e) {
        if (!live) return;
        setState(e instanceof ApiError && e.status === 501 ? 'absent' : 'error');
      }
    })();
    return () => {
      live = false;
    };
  }, [app.vertical_slug, hours, nonce]);

  // Default the logs panel to the busiest version (rows arrive traffic-sorted); keep a
  // stale selection only while it still exists in the new window.
  useEffect(() => {
    if (!rows) return;
    setService((s) => (s && rows.some((r) => r.service === s) ? s : (rows[0]?.service ?? null)));
  }, [rows]);

  useEffect(() => {
    if (!service) {
      setLogs(null);
      return;
    }
    let live = true;
    setLogs(null);
    setLogsFailed(false);
    void (async () => {
      try {
        const events = DEV_MOCK
          ? MOCK_OBSERVABILITY_LOGS.filter(
              (l) =>
                l.service === service &&
                (level === LEVELS[0] || l.level === level) &&
                (!search || (l.message ?? '').includes(search)),
            )
          : await api.observabilityLogs({
              service,
              level: level === LEVELS[0] ? undefined : level,
              search: search || undefined,
              hours,
              limit: 100,
            });
        if (live) setLogs(events);
      } catch {
        if (live) setLogsFailed(true);
      }
    })();
    return () => {
      live = false;
    };
  }, [service, level, search, hours, nonce]);

  const versionOf = useMemo(() => new Map((rows ?? []).map((r) => [r.service, r.version])), [rows]);
  const range = RANGES.find((r) => r.hours === hours) ?? RANGES[1];

  if (state === 'absent') {
    return (
      <div style={{ padding: '24px 0', color: 'var(--text-tertiary)', fontSize: 13 }}>
        Observability is not configured on this platform.
      </div>
    );
  }

  if (owned === false) {
    return (
      <div style={{ padding: '24px 0', color: 'var(--text-tertiary)', fontSize: 13 }}>
        Observability covers the verticals your team builds. This app runs{' '}
        <span style={{ fontFamily: 'var(--font-mono)' }}>{app.vertical_slug}</span>, which is published by another team —
        its logs and metrics stay with its builder.
      </div>
    );
  }

  return (
    <div style={{ display: 'grid', gap: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>
          Per deployed version of <span style={{ fontFamily: 'var(--font-mono)' }}>{app.vertical_slug}</span> — sampled,
          approximate
        </span>
        <div style={{ flex: 1 }} />
        <Select
          aria-label="Time range"
          options={RANGES.map((r) => r.label)}
          value={range.label}
          onChange={(e) => setHours(RANGES.find((r) => r.label === e.target.value)?.hours ?? 24)}
          style={{ width: 150 }}
        />
        <Button variant="ghost" size="sm" onClick={() => setNonce((n) => n + 1)}>
          Refresh
        </Button>
      </div>

      {state === 'error' ? (
        <div style={{ padding: '12px 0', color: 'var(--text-tertiary)', fontSize: 13 }}>
          Traffic data is unavailable right now.
        </div>
      ) : state === 'loading' && rows === null ? (
        <div style={{ padding: '12px 0', color: 'var(--text-tertiary)', fontSize: 13 }}>Loading…</div>
      ) : rows && rows.length === 0 ? (
        <div style={{ padding: '12px 0', color: 'var(--text-tertiary)', fontSize: 13 }}>
          No traffic recorded yet — it appears here once a deployed version serves requests.
        </div>
      ) : (
        <GridTable
          columns="0.9fr 1fr 0.8fr 0.9fr 0.9fr 0.9fr"
          header={['Version', 'Requests', 'Errors', 'Error rate', 'CPU P50', 'CPU P99']}
        >
          {(rows ?? []).map((r, i) => (
            <Row
              key={r.service}
              columns="0.9fr 1fr 0.8fr 0.9fr 0.9fr 0.9fr"
              last={i === (rows?.length ?? 0) - 1}
              onClick={() => setService(r.service)}
            >
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                <MonoTag>{r.version}</MonoTag>
                {r.service === service && <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>logs below</span>}
              </span>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12.5 }}>{r.requests.toLocaleString('en-US')}</span>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12.5, color: r.errors > 0 ? 'var(--status-danger-fg)' : undefined }}>
                {r.errors.toLocaleString('en-US')}
              </span>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12.5 }}>
                {r.requests === 0 ? '—' : `${((r.errors / r.requests) * 100).toFixed(2)}%`}
              </span>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12.5 }}>{fmtCpu(r.cpuTimeP50)}</span>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12.5 }}>{fmtCpu(r.cpuTimeP99)}</span>
            </Row>
          ))}
        </GridTable>
      )}

      {service && (
        <div style={{ ...card, padding: 0, overflow: 'hidden' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', borderBottom: '1px solid var(--border-subtle)', flexWrap: 'wrap' }}>
            <span style={{ fontSize: 13, fontWeight: 600 }}>Logs</span>
            {(rows?.length ?? 0) > 1 && (
              <Select
                aria-label="Version"
                options={(rows ?? []).map((r) => r.version)}
                value={versionOf.get(service) ?? ''}
                onChange={(e) => setService(rows?.find((r) => r.version === e.target.value)?.service ?? service)}
                style={{ width: 110, fontFamily: 'var(--font-mono)', fontSize: 12 }}
              />
            )}
            {(rows?.length ?? 0) <= 1 && <MonoTag>{versionOf.get(service) ?? '—'}</MonoTag>}
            <Select
              aria-label="Level"
              options={LEVELS}
              value={level}
              onChange={(e) => setLevel(e.target.value)}
              style={{ width: 110 }}
            />
            <form
              onSubmit={(e) => {
                e.preventDefault();
                setSearch(query.trim());
              }}
              style={{ display: 'flex', gap: 8, flex: 1, minWidth: 220 }}
            >
              <Input
                aria-label="Search messages"
                placeholder="Filter messages…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                style={{ flex: 1 }}
              />
              {/* No explicit type: the native default inside a form is `submit`. */}
              <Button variant="ghost" size="sm">
                Search
              </Button>
            </form>
            <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>{range.label.toLowerCase()}, newest 100</span>
          </div>
          {logsFailed ? (
            <div style={{ padding: 14, fontSize: 13, color: 'var(--text-tertiary)' }}>Logs are unavailable right now.</div>
          ) : logs === null ? (
            <div style={{ padding: 14, fontSize: 13, color: 'var(--text-tertiary)' }}>Loading…</div>
          ) : logs.length === 0 ? (
            <div style={{ padding: 14, fontSize: 13, color: 'var(--text-tertiary)' }}>
              No log events match in this window.
            </div>
          ) : (
            <div style={{ maxHeight: 420, overflowY: 'auto' }}>
              {logs.map((l, i) => (
                <div
                  key={i}
                  style={{ display: 'flex', gap: 12, padding: '8px 14px', borderBottom: i === logs.length - 1 ? 'none' : '1px solid var(--border-subtle)', fontFamily: 'var(--font-mono)', fontSize: 12 }}
                >
                  <span style={{ color: 'var(--text-tertiary)', whiteSpace: 'nowrap' }}>
                    {l.timestamp ? new Date(l.timestamp).toISOString().slice(5, 19).replace('T', ' ') : '—'}
                  </span>
                  <span style={{ width: 44, color: l.level === 'error' ? 'var(--status-danger-fg)' : 'var(--text-tertiary)' }}>
                    {l.level ?? '—'}
                  </span>
                  <span style={{ flex: 1, wordBreak: 'break-all', color: 'var(--text-primary)' }}>{l.message ?? '(no message)'}</span>
                  {l.outcome && l.outcome !== 'ok' && (
                    <span style={{ color: 'var(--status-danger-fg)', whiteSpace: 'nowrap' }}>{l.outcome}</span>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
