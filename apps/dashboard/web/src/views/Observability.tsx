import { readObsQuery, queryWindow, type ObsQuery } from '../lib/observability-query';
import { ObservabilityTime } from '../components/ObservabilityTime';
import { InspectableTraffic } from '../components/InspectableTraffic';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Button, Select } from '@substrat-run/ui';
import {
  api,
  ApiError,
  type AppOverlays,
  type AppRow,
  type OverlayMarker,
  type ReleaseMarker,
  type TeamTrafficSeries,
} from '../lib/api';
import { DEV_MOCK, MOCK_APP_OVERLAYS, MOCK_TEAM_TRAFFIC, MOCK_TRAFFIC } from '../lib/mock';
import { navigate } from '../lib/router';
import { Page, GridTable, Row } from '../components/layout';
import { card, MonoTag } from '../components/ui';
import { AppSchedules } from './AppSchedules';
import { FleetHealth } from './Apps';
import { Flow } from './Flow';
import { EventExplorer, TenantLogs, TenantTrafficTable } from './ObservabilityPanels';
import { SECTION_VIEWS, defaultView, sectionLabel, sectionOf, type ObsSection } from '../lib/obs-sections';

/** One shared, URL-owned query window for traffic, logs, event facets and changes.
 * Registry changes are contextual facts; snapshot panels explicitly state their coverage.
 */

/** Query windows offered — capped at 72h because that is the plane's cap. */
const RANGES = [
  { label: '1h', hours: 1 },
  { label: '24h', hours: 24 },
  { label: '3d', hours: 72 },
] as const;

/** The sub-views, and which mode each can answer in. */
const VIEWS = [
  { key: 'traffic', label: 'Traffic', modes: 'both' },
  { key: 'health', label: 'Health', modes: 'all-apps' },
  { key: 'logs', label: 'Logs', modes: 'one-app' },
  { key: 'events', label: 'Events', modes: 'one-app' },
  { key: 'schedules', label: 'Schedules', modes: 'one-app' },
  { key: 'flow', label: 'Flow', modes: 'one-app' },
] as const;

type ViewKey = (typeof VIEWS)[number]['key'];

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

/** What the chart's own read produces — the series and its release markers. The overlays
 *  are deliberately not here: they are a second read that must not gate this one. */
interface ChartRead {
  series: TeamTrafficSeries;
  markers: ReleaseMarker[];
}

/** Whether a sub-view can answer in the mode the app filter selected. */
function available(view: (typeof VIEWS)[number], oneApp: boolean): boolean {
  return view.modes === 'both' || view.modes === (oneApp ? 'one-app' : 'all-apps');
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
  const [undo, setUndo] = useState<ObsQuery[]>([]);
  const [timeError, setTimeError] = useState('');
  useEffect(() => { setUndo([]); }, [scopeId]);
  const applyWindow = (w: { from: string; to: string }) => {
    try { queryWindow({ ...q, ...w }); setTimeError(''); setUndo((u) => [...u, q]); navigateQuery({ ...q, ...w }); }
    catch (e) { setTimeError((e as Error).message); }
  };
  // One nonce for the whole page: Refresh re-asks every question on it, which the old tab
  // could not do — its button refreshed the one card it sat in.
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
  const [overlayError, setOverlayError] = useState(false);
  const [series, setSeries] = useState<TeamTrafficSeries | null>(null);
  const [markers, setMarkers] = useState<ReleaseMarker[]>([]);
  // Undefined, never null: the overlays' absence is not a state the chart reports, only
  // one it survives — the traffic is drawn either way.
  const [overlays, setOverlays] = useState<AppOverlays | undefined>(undefined);
  const [chartError, setChartError] = useState(false);

  const app = scopeId ? apps.find((a) => a.app_scope_id === scopeId) : undefined;
  const oneApp = scopeId !== null;
  // Which menu child is open (#1767) — derived from the sub-view, never stored beside it.
  const section: ObsSection = sectionOf(view);
  // A Pulse sub-view the current mode cannot answer falls back to Traffic rather than
  // rendering blank: `?view=schedules` with the filter back on All apps is a stale link,
  // not an error. Logs and Processes do NOT fall back: every one of their sub-views is
  // per app, so falling back would leave the reader on Pulse with the menu saying Logs.
  // They ask for an app instead (`needsApp`).
  const active: ViewKey = useMemo(() => {
    const wanted = VIEWS.find((v) => v.key === (view ?? defaultView(section)));
    if (wanted && (available(wanted, oneApp) || section !== 'pulse')) return wanted.key;
    return 'traffic';
  }, [view, oneApp, section]);
  const needsApp = !available(VIEWS.find((v) => v.key === active)!, oneApp);

  useEffect(() => {
    let live = true;
    // Cleared before the refetch: a chart drawn for one app under a heading that now
    // names another is the misreading the whole page exists to prevent.
    setSeries(null);
    setMarkers([]);
    setOverlays(undefined);
    setChartError(false);
    setOverlayError(false);
    if (resolved.error) return;
    if (DEV_MOCK) {
      setSeries(
        scopeId
          ? { ...MOCK_TEAM_TRAFFIC, series: MOCK_TEAM_TRAFFIC.series.filter((s) => s.scopeId === scopeId) }
          : MOCK_TEAM_TRAFFIC,
      );
      if (scopeId) {
        setMarkers(MOCK_TRAFFIC.markers);
        setOverlays(MOCK_APP_OVERLAYS);
      }
      return;
    }
    // One app is the per-app route's question, and it answers the release markers with
    // the series — the team route cannot, because it plots several verticals at once.
    const read: Promise<ChartRead> = scopeId
      ? api.appTraffic(scopeId, hours, requestWindow).then((traffic) => ({
          // Adapted to the team shape here rather than branching every reader below —
          // the rows and totals under the chart are written against one series type.
          series: { window: traffic.window, series: [{ scopeId, buckets: traffic.buckets }], bucketMinutes: traffic.bucketMinutes, available: traffic.available },
          markers: traffic.markers,
        }))
      : api.teamTraffic({ hours, ...requestWindow }).then((s) => ({ series: s, markers: [] }));
    // The overlays ride a SECOND route, started beside the first and never awaited with
    // it: the chart draws the moment the series lands, and the glyphs arrive when they
    // arrive. Joining the two would let a slow overlay source hold the chart at
    // "Loading…" with the traffic already in hand — the coupling the sibling route
    // exists to remove. A failure costs the glyphs and nothing else.
    if (scopeId) {
      api
        .appOverlays(scopeId, hours, requestWindow)
        .then((o) => live && setOverlays(o))
        .catch(() => live && setOverlayError(true));
    }
    read
      .then((r) => {
        if (!live) return;
        setSeries(r.series);
        setMarkers(r.markers);
      })
      .catch((e) => {
        if (!live) return;
        // A 501 and a worker predating the route say the same thing to a reader: the
        // chart cannot be drawn. Neither is an empty chart, which would read as silence.
        setChartError(!(e instanceof ApiError && e.status === 501));
        setSeries({ series: [], bucketMinutes: 60, available: false });
      });
    return () => {
      live = false;
    };
  }, [scopeId, hours, nonce, requestWindow?.since, requestWindow?.until, resolved.error]);

  const appName = (id: string): string => apps.find((a) => a.app_scope_id === id)?.name ?? id.slice(-8);

  /** Window totals per app, summed from the series already on screen — no second read. */
  const totals = useMemo(
    () =>
      (series?.series ?? [])
        .map((s) => ({
          scopeId: s.scopeId,
          name: appName(s.scopeId),
          requests: s.buckets.reduce((n, b) => n + b.requests, 0),
          errors: s.buckets.reduce((n, b) => n + b.errors, 0),
        }))
        // Worst error rate first: the page's job is to put what is wrong at the top. An
        // app with no traffic has no rate to compare, so it sorts below one that has.
        .sort((a, b) => (b.requests === 0 ? -1 : a.requests === 0 ? 1 : b.errors / b.requests - a.errors / a.requests)),
    [series, apps],
  );
  const thisApp = scopeId ? totals.find((t) => t.scopeId === scopeId) : undefined;

  /** Where the × on the chip, and a range change that outran the cursor, land: the page
   *  as it is, minus the window. */
  const withoutCursor = (): void =>
    onNav({ ...(scopeId ? { app: scopeId } : {}), view: active, from: undefined, to: undefined });

  /**
   * A marker opens the sub-view that EXPLAINS it — the run row for a failed schedule, the
   * log for a recorded failure, the Deployments tab's schema history for a migration —
   * and, since step 3c, on the marker's own MINUTES rather than its app's whole window.
   * A recorded failure inside a three-day range is one line among thousands otherwise,
   * and "here is the panel, now go find it" is not a walk from an aggregate to evidence.
   *
   * A failed run lands on Schedules with the window, and the panel answers it: the
   * schedule whose run fell inside those minutes is hoisted, the run is named on its
   * line and ringed in its strip — the run row #1447 asks the click to reach. A migration
   * leaves for the Deployments tab, which is a different page with a different axis — no
   * cursor travels there.
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

  return (
    <Page>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <h1 style={{ margin: 0, fontSize: 22, lineHeight: '29px', fontWeight: 600, letterSpacing: '-0.02em', color: 'var(--text-primary)' }}>{sectionLabel(section)}</h1>
          <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
            {SUBTITLE[section](app?.name)}
          </div>
        </div>
        <div style={{ flex: 1 }} />
        <Select
          ariaLabel="App"
          options={[{ value: '', label: 'All apps' }, ...apps.map((a) => ({ value: a.app_scope_id, label: a.name }))]}
          value={scopeId ?? ''}
          // Preserve the investigation's absolute interval when narrowing/widening app grain.
          // Only a sub-view unavailable in the destination mode falls back to Traffic.
          onChange={(e) => {
            const next = e.target.value;
            const wanted = VIEWS.find((v) => v.key === active);
            onNav({
              ...(next ? { app: next } : {}),
              invocationId: undefined,
              ...(wanted && (available(wanted, next !== '') || section !== 'pulse') ? { view: active } : {}),
            });
          }}
          style={{ width: 200 }}
        />
        <Segmented
          label="Time range"
          options={RANGES.map((r) => ({ key: String(r.hours), label: r.label }))}
          value={cursor ? '' : String(hours)}
          onPick={(k) => {
            const next = Number(k) as (typeof RANGES)[number]['hours'];
            navigateQuery({ ...q, hours: String(next), from: undefined, to: undefined });
          }}
        />
        {cursor && (
          <span
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6, height: 28, padding: '0 4px 0 10px', fontSize: 12.5, color: 'var(--text-secondary)', background: 'var(--surface-inset)', border: '1px solid var(--border-subtle)', borderRadius: 8 }}
          >
            Custom interval
            <button
              type="button"
              aria-label="Clear custom time interval"
              title="Back to the whole range"
              onClick={withoutCursor}
              style={{ appearance: 'none', border: 0, background: 'transparent', color: 'var(--text-tertiary)', cursor: 'pointer', fontSize: 14, lineHeight: 1, padding: '0 6px' }}
            >
              ×
            </button>
          </span>
        )}
        <Button variant="ghost" size="sm" onClick={() => setNonce((n) => n + 1)}>
          Refresh
        </Button>
      </div>

      <ObservabilityTime window={window} onApply={applyWindow} canUndo={undo.length > 0}
        onUndo={() => { const previous = undo.at(-1); if (previous) { navigateQuery({ ...q, from: previous.from, to: previous.to, hours: previous.hours }); setUndo((u) => u.slice(0, -1)); } }}
        onReset={() => { setTimeError(''); setUndo([]); navigateQuery({ ...q, hours: '24', from: undefined, to: undefined }); }} />
      {(timeError || resolved.error) && <p role="alert">{timeError || resolved.error}</p>}
      <div style={{ ...card, padding: 16, display: 'grid', gap: 10 }}>
        <Chart
          series={series}
          window={window}
          onRange={applyWindow}
          error={chartError}
          oneApp={oneApp}
          nameOf={appName}
          markers={markers}
          {...(overlays ? { overlays } : {})}
          onMarker={onMarker}
          // A bar already IS a span of time, so the window it opens is its own — no
          // padding, because the reader picked that bucket rather than an instant inside
          // it. From Traffic it lands on Logs: that panel is the same aggregate this
          // chart draws, so a click that left the reader on it would shade the chart and
          // change nothing below it. Any other sub-view is one the reader chose, and the
          // window narrows it where it can.
          onBucket={(start, minutes) => {
            if (!scopeId) return;
            const view = active === 'traffic' ? 'logs' : active;
            onNav({
              app: scopeId,
              view,
              from: start,
              to: new Date(Date.parse(start) + minutes * 60_000).toISOString(),
            });
          }}
        />
        {!!overlays?.incompleteSources?.length && <p role="status">Partial change history: {overlays.incompleteSources.join(', ')}. Older records may be omitted.</p>}
        {overlayError && <p role="status">Change overlays are unavailable. Traffic is still shown.</p>}
        {!!overlays?.unavailableSources?.length && <p role="status">Unavailable change sources: {overlays.unavailableSources.join(', ')}.</p>}
        <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>
          Traffic to your installations — approximate, sampled at high volume.
        </span>
      </div>

      {/* Hidden while the page asks for an app: every entry would be disabled, and a row of
          dead buttons above "Pick an app" says the same thing twice. */}
      {SECTION_VIEWS[section].length > 1 && !needsApp && (
      <Segmented
        label="Sub-view"
        options={VIEWS.filter((v) => SECTION_VIEWS[section].includes(v.key)).map((v) => ({
          key: v.key,
          label: v.label,
          ...(available(v, oneApp) ? {} : { disabled: true, title: 'Pick an app' }),
        }))}
        value={active}
        // Disabled entries stay VISIBLE rather than disappearing: a control bar that
        // changes length with the filter reads as a page that lost something.
        //
        // The cursor comes along. "What was happening at 09:13" is one question asked of
        // several panels, and dropping the window on the way from Logs to Events would
        // answer the second one about three days instead — silently, since the count
        // would simply be larger.
        onPick={(k) => onNav({ ...(scopeId ? { app: scopeId } : {}), view: k, ...(cursor ?? {}) })}
      />
      )}

      {needsApp && <PickApp section={section} apps={apps} onPick={(s) => onNav({ app: s, view: active, ...(cursor ?? {}) })} />}

      {/* Not drawn under an unavailable chart: `deriveTeamSeries` zero-fills every line
          whether or not the plane answered, so these rows would put "0 requests" beside
          each app directly beneath a chart that just said nothing was measured. */}
      {active === 'traffic' && !oneApp && series?.available !== false && (
        <AppTrafficRows rows={totals} loading={series === null} onOpen={(s) => onNav({ app: s })} />
      )}
      {/* A Health row promises its sweep record, which lives on the Schedules sub-view —
          landing on the default Traffic panel would hide the very reason the row exists. */}
      {active === 'health' && <FleetHealth key={nonce} onOpen={(s) => onNav({ app: s, view: 'schedules' })} />}
      {scopeId && active === 'traffic' && <TenantTrafficTable scopeId={scopeId} hours={hours} nonce={nonce} window={requestWindow} />}
      {scopeId && active === 'logs' && (
        <TenantLogs
          scopeId={scopeId}
          filters={q}
          onFilters={(filters) => navigateQuery({ ...q, ...filters })}
          hours={hours}
          nonce={nonce}
          // Straight off the chart above, so the log panel can tell "no traffic" from
          // "traffic whose lines are not attributed yet" without a second read.
          {...(series?.available && thisApp ? { hadTraffic: thisApp.requests > 0 } : {})}
          window={panelWindow}
        />
      )}
      {/* Event filters stay mounted on refresh; snapshot panels refresh by remount. */}
      {scopeId && active === 'events' && (
        <EventExplorer
          key={scopeId}
          nonce={nonce}
          query={q}
          onQuery={(filters) => navigateQuery({ ...q, ...filters })}
          scopeId={scopeId}
          hours={hours}
          {...(focusEventType ? { focusEventType } : {})}
          window={panelWindow}
        />
      )}
      {scopeId && active === 'schedules' && (
        <AppSchedules key={`${scopeId}:${nonce}`} scopeId={scopeId} window={panelWindow} />
      )}
      {!needsApp && (active === 'flow' || active === 'schedules' || active === 'health') && <p style={{ fontSize: 12 }}>This view is a current snapshot. Schedule highlights cover only the returned recent runs; it is not a complete historical query.</p>}
      {app && active === 'flow' && <Flow key={`${app.app_scope_id}:${nonce}`} app={app} />}
    </Page>
  );
}

/**
 * The chart, or the reason there isn't one. An unavailable plane says so in the chart's
 * place; zero traffic draws a flat zero line, because that IS information and an absent
 * chart is not.
 */
function Chart({
  window, onRange,
  series,
  error,
  oneApp,
  nameOf,
  markers,
  overlays,
  onMarker,
  onBucket,
  cursor,
}: {
  window: { since: string; until: string };
  onRange: (w: { from: string; to: string }) => void;
  series: TeamTrafficSeries | null;
  error: boolean;
  oneApp: boolean;
  nameOf: (scopeId: string) => string;
  markers: ReleaseMarker[];
  overlays?: AppOverlays;
  onMarker: (marker: OverlayMarker) => void;
  onBucket: (start: string, bucketMinutes: number) => void;
  cursor?: { from: string; to: string };
}) {
  if (series === null) {
    return <div style={{ height: 96, display: 'flex', alignItems: 'center', fontSize: 12.5, color: 'var(--text-tertiary)' }}>Loading…</div>;
  }
  if (error) {
    return <div style={{ height: 96, display: 'flex', alignItems: 'center', fontSize: 12.5, color: 'var(--text-tertiary)' }}>Traffic over time is unavailable right now.</div>;
  }
  if (!series.available) {
    return (
      <div style={{ height: 96, display: 'flex', alignItems: 'center', fontSize: 12.5, color: 'var(--text-tertiary)' }}>
        Traffic over time is not available on this plane — no chart is drawn rather than one that would read as silence.
      </div>
    );
  }
  const axis = series.series[0]?.buckets ?? [];
  if (axis.length === 0) {
    return <div style={{ height: 96, display: 'flex', alignItems: 'center', fontSize: 12.5, color: 'var(--text-tertiary)' }}>No apps to chart yet.</div>;
  }
  // One app: the bar chart, errors inside their bucket, as the release chart draws it —
  // now with the declared facts on it (#1447 step 3b). The deploy lines come from the
  // per-app route, so they are this installation's OWN release history rather than a
  // fact borrowed from another grain.
  if (oneApp) {
    return (
      <InspectableTraffic
        window={window}
        onRange={onRange}
        buckets={axis}
        markers={markers}
        bucketMinutes={series.bucketMinutes}
        {...(overlays ? { overlays } : {})}
        onMarker={onMarker}
        onBucket={onBucket}
        {...(cursor ? { cursor } : {})}
      />
    );
  }
  // All apps: one line each. The legend names them; the rows under the chart are the
  // same list made reachable, and each of those narrows the page to its app. No markers
  // and no overlays here — every one of them is a fact about ONE scope, and drawn across
  // several lines it would claim an instant most of them never had. No cursor either,
  // for the same reason, and no bar to click: this mode draws lines.
  return (
    <InspectableTraffic
        window={window}
        onRange={onRange}
      buckets={axis}
      markers={[]}
      bucketMinutes={series.bucketMinutes}
      height={140}
      lines={series.series.map((s) => ({ label: nameOf(s.scopeId), buckets: s.buckets }))}
    />
  );
}

/** One row per app over the window — totals summed from the chart's own series. */
function AppTrafficRows({
  rows,
  loading,
  onOpen,
}: {
  rows: Array<{ scopeId: string; name: string; requests: number; errors: number }>;
  loading: boolean;
  onOpen: (scopeId: string) => void;
}) {
  if (loading) return <div style={{ fontSize: 12.5, color: 'var(--text-tertiary)' }}>Loading…</div>;
  if (rows.length === 0) {
    return <div style={{ fontSize: 12.5, color: 'var(--text-tertiary)' }}>No apps yet — traffic appears here once one is serving.</div>;
  }
  return (
    <GridTable columns="1.6fr 1fr 0.8fr 0.9fr" header={['App', 'Requests', 'Errors', 'Error rate']}>
      {rows.map((r, i) => (
        <Row key={r.scopeId} columns="1.6fr 1fr 0.8fr 0.9fr" last={i === rows.length - 1} onClick={() => onOpen(r.scopeId)}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontWeight: 550 }}>
            {r.name}
            <MonoTag color="var(--text-tertiary)">{r.scopeId.slice(-8)}</MonoTag>
          </span>
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12.5 }}>{r.requests.toLocaleString('en-US')}</span>
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12.5, color: r.errors > 0 ? 'var(--status-danger-fg)' : undefined }}>
            {r.errors.toLocaleString('en-US')}
          </span>
          {/* An app that served nothing has no error RATE — an em dash, never a
              confident 0.00% about a window in which nothing was measured. */}
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12.5 }}>
            {r.requests === 0 ? '—' : `${((r.errors / r.requests) * 100).toFixed(2)}%`}
          </span>
        </Row>
      ))}
    </GridTable>
  );
}

/**
 * A segmented control. Hand-rolled rather than the shared `Tabs`, which has no disabled
 * state — and a sub-view the current mode cannot answer must stay on screen saying why,
 * not vanish.
 */
function Segmented({
  label,
  options,
  value,
  onPick,
}: {
  label: string;
  options: Array<{ key: string; label: string; disabled?: boolean; title?: string }>;
  value: string;
  onPick: (key: string) => void;
}) {
  return (
    <div role="group" aria-label={label} style={{ display: 'inline-flex', gap: 2, padding: 2, background: 'var(--surface-inset)', border: '1px solid var(--border-subtle)', borderRadius: 8, alignSelf: 'flex-start' }}>
      {options.map((o) => {
        const on = o.key === value;
        return (
          <button
            key={o.key}
            type="button"
            // `aria-disabled`, not `disabled`: a natively disabled button drops out of
            // the tab order, and with it the one place the "why" (`title`) is exposed —
            // so a keyboard or screen-reader user would meet a control that is simply
            // gone. This stays focusable, is announced as unavailable, and activation is
            // guarded instead.
            aria-disabled={o.disabled ?? false}
            {...(o.title ? { title: o.title, 'aria-description': o.title } : {})}
            aria-pressed={on}
            onClick={() => {
              if (!o.disabled) onPick(o.key);
            }}
            style={{
              appearance: 'none',
              border: 0,
              borderRadius: 6,
              padding: '0 12px',
              height: 28,
              fontFamily: 'var(--font-sans)',
              fontSize: 13,
              fontWeight: on ? 550 : 400,
              cursor: o.disabled ? 'not-allowed' : 'pointer',
              background: on ? 'var(--surface-card)' : 'transparent',
              boxShadow: on ? 'var(--shadow-xs)' : 'none',
              color: o.disabled ? 'var(--text-tertiary)' : on ? 'var(--text-primary)' : 'var(--text-secondary)',
              opacity: o.disabled ? 0.55 : 1,
            }}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/** The page subtitle per menu child: what it answers, for the app filter's current grain. */
const SUBTITLE: Record<ObsSection, (app?: string) => ReactNode> = {
  pulse: (app) =>
    app ? <>Traffic, health and schedules for <strong style={{ fontWeight: 550 }}>{app}</strong>, on one time axis.</> : 'Every app on this team, on one time axis.',
  processes: (app) =>
    app ? <>How <strong style={{ fontWeight: 550 }}>{app}</strong> is wired: triggers, events, consumers and connections.</> : 'How each app is wired: triggers, events, consumers and connections.',
  logs: (app) =>
    app ? <>Log lines and emitted events for <strong style={{ fontWeight: 550 }}>{app}</strong>.</> : 'Log lines and emitted events, one app at a time.',
};

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
