import { useEffect, useMemo, useState } from 'react';
import { Button, Input, Select } from '@substrat-run/ui';
import { AppSchedules } from './AppSchedules';
import { type EventFacetResult, api, ApiError, type AppRow, type ObservabilityLogEvent, type ObservabilityRow, type TenantMetricsRow } from '../lib/api';
import { DEV_MOCK, MOCK_INSTALLED_APP_SCOPE, MOCK_OBSERVABILITY, MOCK_OBSERVABILITY_LOGS, MOCK_TENANT_METRICS } from '../lib/mock';
import { GridTable, Row } from '../components/layout';
import { card, MonoTag } from '../components/ui';
import { LogList } from '../components/LogList';

const fmtCpu = (us: number) => (us >= 100_000 ? `${Math.round(us / 1000)} ms` : `${(us / 1000).toFixed(1)} ms`);

/** Query windows offered — capped at 72h because that's the plane's cap; the backend's
 *  own retention (7 days on Workers Logs today) bounds it anyway. */
const RANGES = [
  { label: 'Last hour', hours: 1 },
  { label: 'Last 24 hours', hours: 24 },
  { label: 'Last 3 days', hours: 72 },
] as const;
const LEVELS = ['All levels', 'error', 'warn', 'info', 'log', 'debug'];
/** The plane refuses more services than this in one log query (one backend query each). */
const MAX_LOG_SERVICES = 20;

/**
 * The per-app Observability tab (design/observability.md §5, view 2; issue #471):
 * traffic per deployed version of THIS app's vertical, and the versions' recent logs
 * with level / text filters. Everything here is a pure consumer of the worker's
 * owner-narrowed routes — "filtered by app" is the `vertical` param resolved against
 * the ownership map server-side, never a choice this client is trusted with, and an
 * unowned vertical reads exactly like one with no traffic. Tier-3 numbers: sampled,
 * approximate, never money.
 */
function AppTelemetry({ app }: { app: AppRow }) {
  const [hours, setHours] = useState<(typeof RANGES)[number]['hours']>(24);
  const [rows, setRows] = useState<ObservabilityRow[] | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'absent' | 'error'>('loading');
  // `false` only when the per-app deployments read says the vertical is someone
  // else's — that's what turns the empty state from "no traffic" into "not yours".
  const [owned, setOwned] = useState<boolean | null>(null);

  // The single version filter above the list drives both what the traffic list shows and
  // whose logs open below — `'all'` shows every serving version and their logs merged.
  const [versionFilter, setVersionFilter] = useState<string>('all');
  const [level, setLevel] = useState(LEVELS[0]);
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState('');
  const [logs, setLogs] = useState<ObservabilityLogEvent[] | null>(null);
  const [logsError, setLogsError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (DEV_MOCK) {
      // Fixture-driven rather than a flat `true`: one mock scope runs another team's
      // vertical (`MOCK_INSTALLED_APP_SCOPE`), which is the only way the dev preview can
      // open the installed-app view below at all.
      setOwned(app.app_scope_id !== MOCK_INSTALLED_APP_SCOPE);
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

  // Drop a version filter that no longer exists once a new window's rows arrive (a version
  // may not have served in a shorter range) — fall back to showing all.
  useEffect(() => {
    if (!rows) return;
    setVersionFilter((v) => (v === 'all' || rows.some((r) => r.version === v) ? v : 'all'));
  }, [rows]);

  // Version is unique per row here (one vertical), so it maps 1:1 to a service id. The
  // filtered list and the log target both fall out of the single `versionFilter`.
  const serviceOf = useMemo(() => new Map((rows ?? []).map((r) => [r.version, r.service])), [rows]);
  const service = versionFilter === 'all' ? null : serviceOf.get(versionFilter) ?? null;
  const shownRows = useMemo(
    () => (versionFilter === 'all' ? (rows ?? []) : (rows ?? []).filter((r) => r.version === versionFilter)),
    [rows, versionFilter],
  );
  // Whose logs the panel shows: the one selected version, or — under "all versions" —
  // every version that served, merged into one stream by the worker. A version chip per
  // line is what keeps the merged view readable. Capped at the plane's per-query limit,
  // and rows arrive busiest-first, so the cut falls on the quietest versions — the header
  // says so rather than passing a silently-short stream off as everything.
  const services = useMemo(() => shownRows.slice(0, MAX_LOG_SERVICES).map((r) => r.service), [shownRows]);
  const versionOf = useMemo(() => Object.fromEntries(shownRows.map((r) => [r.service, r.version])), [shownRows]);
  // `services` is a fresh array each render — key the fetch on its contents, not identity.
  const servicesKey = services.join(',');

  useEffect(() => {
    if (!servicesKey) {
      setLogs(null);
      return;
    }
    let live = true;
    setLogs(null);
    setLogsError(null);
    void (async () => {
      try {
        const events = DEV_MOCK
          ? MOCK_OBSERVABILITY_LOGS.filter(
              (l) =>
                services.includes(l.service ?? '') &&
                (level === LEVELS[0] || l.level === level) &&
                (!search || (l.message ?? '').includes(search)),
            )
          : await api.observabilityLogs({
              services,
              level: level === LEVELS[0] ? undefined : level,
              search: search || undefined,
              hours,
              limit: 100,
            });
        if (live) setLogs(events);
      } catch (e) {
        if (!live) return;
        // Surface WHY, not a blanket "unavailable" — the plane's status is the whole
        // signal (501 = not configured, 5xx = an upstream/query failure worth reporting).
        // The plane returns sanitized bodies, so `e.message` is safe to show.
        setLogsError(
          e instanceof ApiError
            ? e.status === 501
              ? 'Log streaming is not configured on this platform.'
              : `Logs are unavailable (${e.status}): ${e.message}`
            : 'Logs are unavailable right now.',
        );
      }
    })();
    return () => {
      live = false;
    };
    // Keyed on `servicesKey`, not `services`: the array is rebuilt every render.
  }, [servicesKey, level, search, hours, nonce]);

  const range = RANGES.find((r) => r.hours === hours) ?? RANGES[1];

  if (state === 'absent') {
    return (
      <div style={{ padding: '24px 0', color: 'var(--text-tertiary)', fontSize: 13 }}>
        Observability is not configured on this platform.
      </div>
    );
  }

  // An app running somebody else's vertical gets the TENANT grain instead of this one.
  // Not a consolation prize: it is narrower and more accurate here, because it is keyed
  // on this installation rather than on a script shared with every other team that
  // installed the same vertical. What it cannot show is the per-version breakdown, since
  // versions are a fact about the code and the code is not this team's.
  if (owned === false) return <InstalledAppTelemetry app={app} />;

  return (
    <div style={{ display: 'grid', gap: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>
          Traffic for <span style={{ fontFamily: 'var(--font-mono)' }}>{app.vertical_slug}</span> — approximate, sampled at
          high volume
        </span>
        <div style={{ flex: 1 }} />
        <Select
          aria-label="Version"
          options={['All versions', ...(rows ?? []).map((r) => r.version)]}
          value={versionFilter === 'all' ? 'All versions' : versionFilter}
          onChange={(e) => setVersionFilter(e.target.value === 'All versions' ? 'all' : e.target.value)}
          style={{ width: 150, fontFamily: 'var(--font-mono)', fontSize: 12 }}
        />
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
          {shownRows.map((r, i) => (
            <Row
              key={r.service}
              columns="0.9fr 1fr 0.8fr 0.9fr 0.9fr 0.9fr"
              last={i === shownRows.length - 1}
              onClick={() => setVersionFilter(versionFilter === r.version ? 'all' : r.version)}
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

      {services.length > 0 && (
        <div style={{ ...card, padding: 0, overflow: 'hidden' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', borderBottom: '1px solid var(--border-subtle)', flexWrap: 'wrap' }}>
            <span style={{ fontSize: 13, fontWeight: 600 }}>Logs</span>
            <MonoTag>
              {versionFilter === 'all'
                ? `all versions (${services.length}${shownRows.length > services.length ? ` of ${shownRows.length}, busiest` : ''})`
                : versionFilter}
            </MonoTag>
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
          {logsError ? (
            <div style={{ padding: 14, fontSize: 13, color: 'var(--text-tertiary)' }}>{logsError}</div>
          ) : logs === null ? (
            <div style={{ padding: 14, fontSize: 13, color: 'var(--text-tertiary)' }}>Loading…</div>
          ) : logs.length === 0 ? (
            <div style={{ padding: 14, fontSize: 13, color: 'var(--text-tertiary)' }}>
              No log events match in this window.
            </div>
          ) : (
            <LogList events={logs} versionOf={versionFilter === 'all' ? versionOf : undefined} />
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Telemetry for an app running a vertical ANOTHER team publishes — the tenant grain
 * (observability.md §3 view 4).
 *
 * `AppTelemetry` above is the builder's view: it resolves the scripts this team pushed
 * and reads Cloudflare's per-script numbers. An installed vertical resolves to none of
 * those, which is why this tab used to end at a sentence explaining that the logs stayed
 * with the vertical's builder.
 *
 * They still do, and that is the point rather than the limitation. A script serves every
 * team that installed the vertical, so its numbers are the builder's to read and nobody
 * else's. What this shows instead is narrower and belongs entirely to the viewing team:
 * the requests the router dispatched to THIS app scope, and the log lines the vertical
 * wrote while serving them. Two teams running the same vertical see two different pages.
 *
 * What is deliberately absent is the per-version breakdown the builder view leads with.
 * A version is a fact about the code, and the code is not this team's — the Deployments
 * tab already says which version they run, which is the part that is theirs to know.
 */
function InstalledAppTelemetry({ app }: { app: AppRow }) {
  const [hours, setHours] = useState<(typeof RANGES)[number]['hours']>(24);
  const [rows, setRows] = useState<TenantMetricsRow[] | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'absent' | 'error'>('loading');
  const [level, setLevel] = useState(LEVELS[0]);
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState('');
  const [logs, setLogs] = useState<ObservabilityLogEvent[] | null>(null);
  const [logsError, setLogsError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let live = true;
    setState('loading');
    void (async () => {
      try {
        const r = DEV_MOCK ? MOCK_TENANT_METRICS : await api.appTenantMetrics(app.app_scope_id, hours);
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
  }, [app.app_scope_id, hours, nonce]);

  useEffect(() => {
    let live = true;
    setLogs(null);
    setLogsError(null);
    void (async () => {
      try {
        const events = DEV_MOCK
          ? MOCK_OBSERVABILITY_LOGS.filter(
              (l) => (level === LEVELS[0] || l.level === level) && (!search || (l.message ?? '').includes(search)),
            )
          : await api.appTenantLogs(app.app_scope_id, {
              level: level === LEVELS[0] ? undefined : level,
              search: search || undefined,
              hours,
              limit: 100,
            });
        if (live) setLogs(events);
      } catch (e) {
        if (!live) return;
        setLogsError(
          e instanceof ApiError
            ? e.status === 501
              ? 'Log streaming is not configured on this platform.'
              : `Logs are unavailable (${e.status}): ${e.message}`
            : 'Logs are unavailable right now.',
        );
      }
    })();
    return () => {
      live = false;
    };
  }, [app.app_scope_id, level, search, hours, nonce]);

  const range = RANGES.find((r) => r.hours === hours) ?? RANGES[1];
  const totals = (rows ?? []).reduce(
    (acc, r) => ({ requests: acc.requests + r.requests, errors: acc.errors + r.errors }),
    { requests: 0, errors: 0 },
  );

  if (state === 'absent') {
    return (
      <div style={{ padding: '24px 0', color: 'var(--text-tertiary)', fontSize: 13 }}>
        Observability is not configured on this platform.
      </div>
    );
  }

  return (
    <div style={{ display: 'grid', gap: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>
          Traffic to this app — approximate, sampled at high volume.{' '}
          <span style={{ fontFamily: 'var(--font-mono)' }}>{app.vertical_slug}</span> is published by another team, so
          this covers your installation only, not the vertical.
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
          No traffic recorded in this window.
        </div>
      ) : (
        <GridTable
          columns="0.8fr 1fr 0.8fr 0.9fr 0.9fr 0.9fr"
          header={['Surface', 'Requests', 'Errors', 'Error rate', 'P50', 'P95']}
        >
          {(rows ?? []).map((r, i) => (
            <Row key={`${r.scopeId}:${r.surface}`} columns="0.8fr 1fr 0.8fr 0.9fr 0.9fr 0.9fr" last={i === (rows ?? []).length - 1}>
              <MonoTag>{r.surface ?? '—'}</MonoTag>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12.5 }}>{r.requests.toLocaleString('en-US')}</span>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12.5, color: r.errors > 0 ? 'var(--status-danger-fg)' : undefined }}>
                {r.errors.toLocaleString('en-US')}
              </span>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12.5 }}>
                {r.requests === 0 ? '—' : `${((r.errors / r.requests) * 100).toFixed(2)}%`}
              </span>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12.5 }}>{Math.round(r.durationP50)} ms</span>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12.5 }}>{Math.round(r.durationP95)} ms</span>
            </Row>
          ))}
        </GridTable>
      )}

      <div style={{ ...card, padding: 0, overflow: 'hidden' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', borderBottom: '1px solid var(--border-subtle)', flexWrap: 'wrap' }}>
          <span style={{ fontSize: 13, fontWeight: 600 }}>Logs</span>
          <MonoTag>this app</MonoTag>
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
            <Button variant="ghost" size="sm">
              Search
            </Button>
          </form>
          <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>{range.label.toLowerCase()}, newest 100</span>
        </div>
        {logsError ? (
          <div style={{ padding: 14, fontSize: 13, color: 'var(--text-tertiary)' }}>{logsError}</div>
        ) : logs === null ? (
          <div style={{ padding: 14, fontSize: 13, color: 'var(--text-tertiary)' }}>Loading…</div>
        ) : logs.length === 0 ? (
          <div style={{ padding: 14, fontSize: 13, color: 'var(--text-tertiary)' }}>
            {/* Two very different reasons for an empty list, and conflating them sent the
                last reader looking in the wrong place. Traffic with no lines means the
                version serving this app predates the stamped invocation line, so there is
                nothing to correlate — a re-push fixes it. No traffic means no traffic. */}
            {totals.requests > 0
              ? 'No log events in this window. If this app’s version was deployed before per-request logging, its lines are not attributed to your team yet — a new deploy of the vertical starts that.'
              : 'No log events in this window.'}
          </div>
        ) : (
          <LogList events={logs} />
        )}
      </div>
    </div>
  );
}

/**
 * The Observability tab: schedule health first, then telemetry. Composed so the
 * schedules panel renders ABOVE the telemetry guards — schedule health is the
 * TENANT'S fact (the sweep record is tenant-stamped), so it renders even for an
 * app running another team's vertical and even where Workers Logs is absent;
 * the guards below only fence the metrics/logs half they were written for.
 *
 * The two release cards left for Deployments (#1447, `views/ReleaseCards.tsx`): the
 * update comparison calls itself, in its own header, the last question before pressing
 * Update, and a schema history is a deployment fact — both answer "what changed when we
 * shipped", not "how is this app behaving", so they belong beside the Update button.
 */

/**
 * The windows a facet may be taken over. `null` hours is "everything the scope still
 * holds" — an explicit option rather than the absence of a control, because a count with
 * no window is a different claim from a count over the last day and the reader has to be
 * the one who picks.
 */
const FACET_WINDOWS = [
  { label: 'Last hour', hours: 1 },
  { label: 'Last 24 hours', hours: 24 },
  { label: 'Last 7 days', hours: 24 * 7 },
  { label: 'All time', hours: null },
] as const;

/**
 * A window's two bounds, both derived from ONE instant — ISO 8601 text, the way the
 * spine stores time, never epoch ms.
 *
 * Closing the window at submit time is what makes the counts reproducible: an open
 * upper bound means a re-run of the same question answers about a slightly different
 * slice, and the difference shows up as a count that moved for no reason the reader
 * can see. "All time" is the one window with no bounds at all, which is a different
 * claim and says so.
 */
function facetWindow(label: string): Pick<AppliedFacet, 'since' | 'until' | 'windowLabel'> {
  const hours = FACET_WINDOWS.find((w) => w.label === label)?.hours ?? null;
  if (hours === null) return { windowLabel: label, since: undefined, until: undefined };
  const until = Date.now();
  return {
    windowLabel: label,
    since: new Date(until - hours * 3_600_000).toISOString(),
    until: new Date(until).toISOString(),
  };
}

/** The submitted query — what the counts on screen are an answer to. */
interface AppliedFacet {
  groupBy: string;
  field: string;
  type: string;
  since: string | undefined;
  until: string | undefined;
  /** The window as the reader chose it, carried so the header names the SUBMITTED
   *  window rather than whatever the select happens to show now. */
  windowLabel: string;
}

/**
 * The event explorer (#1239 stage 1): narrow this app's outbox, group it, count.
 *
 * A payload grouping is by a TOP-LEVEL field. Nested paths are a deliberate v1
 * omission (`eventFacetGroupBy`), not an oversight — one level answers "which
 * currency", and deeper paths want their own thought about arrays.
 * "Which operation emits most of this?", "which version were these under?" —
 * the questions nobody predicted, answered on what the spine already holds.
 *
 * Two things the UI is careful to say rather than imply:
 *
 * **An erased payload is not a missing value.** Grouping by a payload field over
 * a shredded event yields the same null a never-present key does, so the reader
 * counts them apart and this shows the erased count beside the buckets. Without
 * it a distribution over redacted history looks complete.
 *
 * **A truncated result says so.** Buckets are capped; a tail that exists and is
 * not shown must not read as a tail that does not exist.
 */
function EventExplorer({ app, focusEventType }: { app: AppRow; focusEventType?: string }) {
  const [groupBy, setGroupBy] = useState('type');
  const [field, setField] = useState('');
  // Seeded from the flow map's deep link when there is one. A type arriving this way is
  // ALREADY applied — the reader asked for it by following the link, so making them press
  // Group again would be asking the same question twice.
  const [type, setType] = useState(focusEventType ?? '');
  const [windowLabel, setWindowLabel] = useState<string>(FACET_WINDOWS[1]!.label);
  const [result, setResult] = useState<EventFacetResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  /**
   * The app serves no event reads at all — a 501 from its own deployment, which is a
   * fact about the app and not a failure of this query. Kept apart from `err` because
   * the two want opposite screens: an error invites a retry, and there is nothing here
   * to retry. Not every installed app is a kernel vertical (an auth server holds
   * accounts, not an outbox), and an app deployed before the explorer existed answers
   * the same way, so this states the absence rather than relaying the refusal.
   */
  const [absent, setAbsent] = useState(false);

  // The whole query is applied on submit rather than per keystroke: each one is a scope
  // read, and a half-typed field name is a query nobody asked for. `since` is resolved
  // HERE, at submit, so the window is the one the reader chose and not one that slides
  // out from under the answer on the next render.
  const [applied, setApplied] = useState<AppliedFacet>(() => ({
    groupBy: 'type',
    field: '',
    type: focusEventType ?? '',
    ...facetWindow(FACET_WINDOWS[1]!.label),
  }));
  const submit = () =>
    setApplied({
      groupBy,
      field: field.trim(),
      type: type.trim(),
      ...facetWindow(windowLabel),
    });

  // A second link followed while the panel is open changes the prop and nothing else —
  // without this the controls would update and the counts would stay the first type's.
  useEffect(() => {
    if (focusEventType === undefined) return;
    setType(focusEventType);
    setApplied((a) => (a.type === focusEventType ? a : { ...a, type: focusEventType, field: '' }));
  }, [focusEventType]);

  useEffect(() => {
    let live = true;
    setErr(null);
    setAbsent(false);
    // The previous answer is dropped before the new one is asked for. A facet can scan a
    // lot of history, so leaving it on screen labels one query's counts with another
    // query's controls for as long as the read takes — and those counts look exactly
    // like an answer.
    setResult(null);
    setLoading(true);
    api
      .appFacets(app.app_scope_id, {
        groupBy: applied.field ? undefined : applied.groupBy,
        field: applied.field || undefined,
        type: applied.type || undefined,
        since: applied.since,
        until: applied.until,
      })
      .then((r) => live && (setResult(r), setLoading(false)))
      .catch(
        (e) =>
          live &&
          (setLoading(false),
          e instanceof ApiError && e.status === 501
            ? setAbsent(true)
            : setErr(e instanceof Error ? e.message : String(e))),
      );
    return () => {
      live = false;
    };
  }, [app.app_scope_id, applied]);

  const widest = Math.max(1, ...(result?.buckets ?? []).map((b) => b.count));

  /**
   * The card stays and says what is missing, rather than hiding: a tab one row shorter
   * with nothing accounting for the gap reads as a page that failed to load. What it
   * does NOT do is keep the controls — a query nothing can answer is not a query, and
   * relaying the vertical's own refusal ("… does not implement GET /internal/facets")
   * described the transport where the reader needed the fact about their app.
   */
  if (absent) {
    return (
      <div style={{ ...card, padding: 14, display: 'grid', gap: 10 }}>
        <h3 style={{ margin: 0, fontSize: 15 }}>Events</h3>
        <p style={{ margin: 0, fontSize: 12.5, color: 'var(--text-tertiary)' }}>
          This app publishes no event stream, so there is nothing to group. An app that is
          not built on the kernel keeps no event spine &mdash; an auth server holds accounts,
          not an outbox &mdash; and an app last pushed before the explorer shipped answers the
          same way, which a newer push fixes.
        </p>
      </div>
    );
  }

  return (
    <div style={{ ...card, padding: 14, display: 'grid', gap: 10 }}>
      <div>
        <h3 style={{ margin: 0, fontSize: 15 }}>Events</h3>
        <p style={{ margin: '4px 0 0', fontSize: 12.5, color: 'var(--text-tertiary)' }}>
          Group this app&rsquo;s events by a dimension or a payload field, and count them.
        </p>
      </div>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <Select
          aria-label="Group by dimension"
          options={[
            { value: 'type', label: 'Event type' },
            { value: 'operation', label: 'Operation' },
            { value: 'actor', label: 'Actor' },
            { value: 'version', label: 'Version' },
            { value: 'entityType', label: 'Entity type' },
            { value: 'piiClass', label: 'PII class' },
          ]}
          value={groupBy}
          // Choosing a dimension CLEARS the payload field, because submit gives the field
          // precedence: leaving both set would group by the old field while the select
          // showed the new dimension, and the header would agree with the select.
          onChange={(e) => {
            setGroupBy(e.target.value);
            setField('');
          }}
          style={{ width: 150 }}
        />
        <Input
          mono
          aria-label="Group by payload field"
          value={field}
          onChange={(e) => setField(e.target.value)}
          placeholder="…or a top-level payload field"
          style={{ width: 190 }}
        />
        <Input
          mono
          aria-label="Narrow to one event type"
          value={type}
          onChange={(e) => setType(e.target.value)}
          placeholder="event type (optional)"
          style={{ width: 200 }}
        />
        <Select
          aria-label="Window"
          options={FACET_WINDOWS.map((w) => w.label)}
          value={windowLabel}
          onChange={(e) => setWindowLabel(e.target.value)}
          style={{ width: 150 }}
        />
        <Button size="sm" variant="ghost" onClick={submit}>
          Group
        </Button>
      </div>

      {err && <div style={{ fontSize: 12.5, color: 'var(--status-danger-fg)' }}>{err}</div>}

      {loading && !err && <div style={{ fontSize: 12.5, color: 'var(--text-tertiary)' }}>Grouping…</div>}

      {result && (
        <>
          <div style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>
            {result.total.toLocaleString()} event{result.total === 1 ? '' : 's'} matched
            {applied.since !== undefined && <span> in {applied.windowLabel.toLowerCase()}</span>}
            {result.erased > 0 && (
              <span style={{ color: 'var(--status-warning-fg)' }}>
                {' '}· {result.erased.toLocaleString()} with an erased payload, counted apart and not grouped
              </span>
            )}
            {result.truncated && <span> · showing the largest buckets only</span>}
          </div>
          {result.buckets.length === 0 ? (
            <div style={{ fontSize: 12.5, color: 'var(--text-tertiary)' }}>
              {/* Empty buckets over a non-empty match is a different answer from no match
                  at all, and saying "nothing matched" under a line reading "N events
                  matched" is how a reader concludes the page is broken. Events that
                  matched and produced no bucket are the erased ones — this is the whole
                  erased-vs-absent distinction, seen from the degenerate end. */}
              {result.total === 0
                ? 'No events matched this filter.'
                : result.erased === result.total
                  ? 'Every matching event had its payload erased, so there is nothing left to group by.'
                  : 'The matching events produced no groupable value.'}
            </div>
          ) : (
            <div style={{ display: 'grid', gap: 4 }}>
              {result.buckets.map((b) => (
                <div key={b.value ?? '\u0000null'} style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 12.5 }}>
                  <span style={{ fontFamily: 'var(--font-mono)', minWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: b.value === null ? 'var(--text-tertiary)' : 'var(--text-primary)' }}>
                    {/* "No value extracted", which is weaker than absent: SQLite returns
                        the same null for a missing key and for an explicit JSON null.
                        What it is NOT is erased — that count is above, and the two are
                        different answers. */}
                    {b.value ?? 'no value'}
                  </span>
                  <span style={{ flex: 1, height: 6, background: 'var(--surface-inset)', borderRadius: 3, overflow: 'hidden' }}>
                    <span style={{ display: 'block', width: `${(b.count / widest) * 100}%`, height: '100%', background: 'var(--brand-500)' }} />
                  </span>
                  <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-tertiary)', minWidth: 56, textAlign: 'right' }}>
                    {b.count.toLocaleString()}
                  </span>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

export function AppObservability({ app, focusEventType }: { app: AppRow; focusEventType?: string }) {
  return (
    <div style={{ display: 'grid', gap: 16 }}>
      <AppSchedules scopeId={app.app_scope_id} />
      <EventExplorer app={app} focusEventType={focusEventType} />
      <AppTelemetry app={app} />
    </div>
  );
}
