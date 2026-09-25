import { readObsQuery, queryWindow, type ObsQuery } from '../lib/observability-query';
import { useEffect, useMemo, useState } from 'react';
import { Button, Select } from '@substrat-run/ui';
import { api, type AppMetricsView, type AppRow, type OverlayMarker } from '../lib/api';
import { DEV_MOCK, MOCK_APP_METRICS } from '../lib/mock';
import { navigate } from '../lib/router';
import { Page } from '../components/layout';
import { card } from '../components/ui';
import { AppFilter, PageHead } from '../components/ObsControls';
import { LogQueryBar } from '../components/LogQueryBar';
import { Flow } from './Flow';
import { Pulse } from './Pulse';
import { EventExplorer, TenantLogs } from './ObservabilityPanels';
import { LogStream } from '../components/LogStream';
import { sectionOf, type ObsSection } from '../lib/obs-sections';

/**
 * The team Observability page — its three menu children (#1767), each with its own layout.
 * What they share is the URL-owned query (app, range or window, filters) and the one
 * Refresh nonce; each draws its own header over it. Pulse is every app on one clock,
 * Processes one app's wiring, Logs one app's lines and events.
 */

/** The Logs range select — the plane's presets, capped at 72h. */
const RANGE_OPTIONS = [
  { value: '1', label: 'Last hour' },
  { value: '24', label: 'Last 24 hours' },
  { value: '72', label: 'Last 3 days' },
];

/**
 * How wide "what was happening when this fired" is — five minutes either side of the
 * instant. A whole request's life fits inside that with room to spare, and the log read's
 * limit of 100 lines still means something over it; a wider window turns the cursor back
 * into the range control it exists to be different from.
 */
const CURSOR_PAD_MS = 5 * 60_000;

/** The window a cursor covers, as the two ISO instants every seam below it speaks in. */
function windowAround(at: string, padMs = CURSOR_PAD_MS): { from: string; to: string } {
  const t = Date.parse(at);
  return { from: new Date(t - padMs).toISOString(), to: new Date(t + padMs).toISOString() };
}

export function Observability({
  apps,
  query,
  scopeId,
  view,
  focusEventType,
  cursor,
  onNav: navigateQuery,
}: {
  apps: AppRow[];
  query: string;
  /** The app the page is narrowed to, or null for all of them. */
  scopeId: string | null;
  view: string | null;
  focusEventType: string | null;
  /** The instant the page is looking at, as a window — or null for the whole range. */
  cursor: { from: string; to: string } | null;
  onNav: (q: ObsQuery) => void;
}) {
  const q = readObsQuery(query);
  const hours = Number(q.hours ?? 24);
  const onNav = (next: ObsQuery) => navigateQuery({ from: q.from, to: q.to, hours: q.hours, type: q.type, level: q.level, search: q.search, invocationId: q.invocationId, groupBy: q.groupBy, field: q.field, ...next });
  const [timeError, setTimeError] = useState('');
  const applyWindow = (w: { from: string; to: string }) => {
    try { queryWindow({ ...q, ...w }); setTimeError(''); navigateQuery({ ...q, ...w }); }
    catch (e) { setTimeError((e as Error).message); }
  };
  /** A range preset, or null for "back to the range the window was cut from". */
  const preset = (h: number | null) => {
    setTimeError('');
    navigateQuery({ ...q, ...(h === null ? {} : { hours: String(h) }), from: undefined, to: undefined });
  };
  // One nonce for the whole page: Refresh re-asks every question on it.
  const [nonce, setNonce] = useState(0);
  const resolved = useMemo(() => {
    try { return { window: queryWindow(q), error: '' }; }
    catch (e) { return { window: queryWindow({}), error: (e as Error).message }; }
  }, [q.hours, q.from, q.to, nonce]);
  const window = resolved.window;
  // Relative presets retain the hours-only cache and work with older readers.
  // Explicit selections always send exact bounds, including partial edge buckets.
  const requestWindow = q.from && q.to ? window : undefined;
  const panelWindow = { from: window.since, to: window.until };

  const app = scopeId ? apps.find((a) => a.app_scope_id === scopeId) : undefined;
  // Which menu child is open (#1767) — derived from the sub-view, never stored beside it.
  const section: ObsSection = sectionOf(view);
  const logMode = view === 'events' ? 'events' : 'logs';
  // The app filter narrows or widens the grain and keeps everything else — the window,
  // and the sub-view, which every child can now open in either mode (Logs and Processes
  // ask for an app rather than falling back). A stale invocation filter is dropped: it
  // names one app's call.
  const pickApp = (next: string | null) => onNav({ ...(next ? { app: next } : {}), invocationId: undefined, ...(view ? { view } : {}) });

  /**
   * A marker opens the sub-view that EXPLAINS it — the run row for a failed schedule, the
   * log for a recorded failure, the Deployments tab's schema history for a migration —
   * on the marker's own minutes rather than its app's whole window. A failed run lands on
   * Pulse's Schedules section with the window, which hoists the schedule whose run fell
   * inside it and names the run on its line.
   */
  const onMarker = (m: OverlayMarker): void => {
    if (!scopeId) return;
    if (m.kind === 'migration') {
      navigate(`/apps/${scopeId}/deployments`);
      return;
    }
    onNav({ app: scopeId, view: m.kind === 'run-failed' ? 'schedules' : 'logs', ...windowAround(m.at) });
  };

  if (resolved.error) return <Page><p role="alert">{resolved.error}</p><button onClick={() => navigateQuery({ ...q, hours: '24', from: undefined, to: undefined })}>Reset time</button></Page>;

  const refresh = (
    <Button variant="ghost" size="sm" onClick={() => setNonce((n) => n + 1)}>
      Refresh
    </Button>
  );

  if (section === 'pulse') {
    return (
      <Pulse
        apps={apps}
        scopeId={scopeId}
        hours={hours}
        window={panelWindow}
        requestWindow={requestWindow}
        cursor={cursor}
        nonce={nonce}
        timeError={timeError}
        onNav={onNav}
        onRange={applyWindow}
        onPreset={preset}
        onApp={pickApp}
        onRefresh={() => setNonce((n) => n + 1)}
        onMarker={onMarker}
      />
    );
  }

  if (section === 'processes') {
    // A current snapshot of the wiring: no time controls, because nothing on it is a range.
    return (
      <Page>
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 12, flexWrap: 'wrap' }}>
          <PageHead
            title="Processes"
            sub={app ? <>How <strong style={{ fontWeight: 550 }}>{app.name}</strong> is wired: triggers, events, consumers and connections.</> : 'How each app is wired: triggers, events, consumers and connections.'}
          />
          <AppFilter apps={apps} value={scopeId} onChange={pickApp} />
          {refresh}
        </div>
        {app ? <Flow key={`${app.app_scope_id}:${nonce}`} app={app} /> : <PickApp section={section} apps={apps} onPick={(s) => onNav({ app: s, view: 'flow' })} />}
      </Page>
    );
  }

  return (
    <Page>
      {/* The design gives Logs no visible heading — the query bar is the top of the page —
          but the page still needs one for anything that navigates by headings. */}
      <h1 style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap', margin: 0 }}>Logs</h1>
      <LogQueryBar
        query={q}
        mode={logMode}
        cursor={cursor}
        onQuery={(next) => navigateQuery({ ...next, ...(scopeId ? { app: scopeId } : {}), ...(view ? { view } : {}) })}
      >
        <AppFilter apps={apps} value={scopeId} onChange={pickApp} />
        <Select
          ariaLabel="Time range"
          size="sm"
          // A custom window is not one of the presets; it shows as the `time` chip, and
          // the select says so rather than claiming a range the read is not using.
          options={[...(cursor ? [{ value: '', label: 'Custom window', disabled: true }] : []), ...RANGE_OPTIONS]}
          value={cursor ? '' : String(hours)}
          onChange={(e) => preset(Number(e.target.value))}
          style={{ width: 150 }}
        />
        {/* No "Live" toggle: nothing streams yet, so the stream is re-read on demand. */}
        {refresh}
      </LogQueryBar>
      {timeError && <p role="alert" style={{ margin: 0, fontSize: 12.5, color: 'var(--status-danger-fg)' }}>{timeError}</p>}
      {scopeId ? (
        // One card, two modes. A tab switch is a sub-view switch — same URL key, and the
        // cursor comes along: "what was happening at 09:13" is one question asked of both.
        <LogStream mode={logMode} onMode={(k) => onNav({ app: scopeId, view: k, ...(cursor ?? {}) })}>
          {logMode === 'logs' && (
            <LinesMode scopeId={scopeId} q={q} hours={hours} nonce={nonce} cursor={cursor} window={panelWindow} onFilters={(filters) => navigateQuery({ ...q, ...filters })} />
          )}
          {/* Event filters stay mounted on refresh; snapshot panels refresh by remount. */}
          {logMode === 'events' && (
            <EventExplorer
              key={scopeId}
              embedded
              nonce={nonce}
              query={q}
              onQuery={(filters) => navigateQuery({ ...q, ...filters })}
              scopeId={scopeId}
              hours={hours}
              {...(focusEventType ? { focusEventType } : {})}
              window={panelWindow}
            />
          )}
        </LogStream>
      ) : (
        <PickApp section={section} apps={apps} onPick={(s) => onNav({ app: s, view: logMode, ...(cursor ?? {}) })} />
      )}
    </Page>
  );
}

/**
 * The Lines mode, with the one fact its empty state needs from outside: whether the app
 * served anything over the range. That came off the old page's traffic chart; with the
 * chart gone from Logs it is the per-app metrics read instead — and only without a
 * cursor, since under one the panel withholds the hint anyway.
 */
function LinesMode({
  scopeId,
  q,
  hours,
  nonce,
  cursor,
  window,
  onFilters,
}: {
  scopeId: string;
  q: ObsQuery;
  hours: number;
  nonce: number;
  cursor: { from: string; to: string } | null;
  window: { from: string; to: string };
  onFilters: (filters: Partial<ObsQuery>) => void;
}) {
  const [metrics, setMetrics] = useState<AppMetricsView | null>(null);
  useEffect(() => {
    let live = true;
    setMetrics(null);
    if (cursor) return;
    if (DEV_MOCK) {
      setMetrics(MOCK_APP_METRICS);
      return;
    }
    api.appMetrics(hours).then((m) => live && setMetrics(m)).catch(() => {});
    return () => {
      live = false;
    };
  }, [hours, nonce, cursor === null]);
  const requests = metrics?.available ? metrics.rows.find((r) => r.scopeId === scopeId)?.requests : undefined;
  return (
    <TenantLogs
      embedded
      scopeId={scopeId}
      filters={q}
      onFilters={onFilters}
      hours={hours}
      nonce={nonce}
      {...(typeof requests === 'number' ? { hadTraffic: requests > 0 } : {})}
      window={window}
    />
  );
}

/**
 * Logs and Processes answer per app. With the filter on All apps they say so and list
 * the apps to pick, rather than falling back to Pulse — the menu would then name a page
 * the reader is not on.
 */
function PickApp({ section, apps, onPick }: { section: ObsSection; apps: AppRow[]; onPick: (scopeId: string) => void }) {
  return (
    <div style={{ ...card, padding: 16, display: 'grid', gap: 10 }}>
      <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' }}>Pick an app</div>
      <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
        {section === 'logs' ? 'Logs and events are read one app at a time.' : 'The flow map is drawn one app at a time.'}
      </div>
      {apps.length === 0 ? (
        <div style={{ fontSize: 13, color: 'var(--text-tertiary)' }}>This team has no apps yet.</div>
      ) : (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          {apps.map((a) => (
            <Button key={a.app_scope_id} variant="secondary" size="sm" onClick={() => onPick(a.app_scope_id)}>
              {a.name}
            </Button>
          ))}
        </div>
      )}
    </div>
  );
}
