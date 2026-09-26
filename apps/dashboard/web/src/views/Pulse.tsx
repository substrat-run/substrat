import { useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { Badge, Button, Tabs } from '@substrat-run/ui';
import {
  api,
  ApiError,
  type AppHealthRow,
  type AppMetricsView,
  type AppOverlays,
  type AppRow,
  type OverlayMarker,
  type ReleaseMarker,
  type TeamTrafficSeries,
} from '../lib/api';
import { DEV_MOCK, MOCK_APP_METRICS, MOCK_APP_OVERLAYS, MOCK_FLEET_HEALTH, MOCK_TEAM_TRAFFIC } from '../lib/mock';
import { MOCK_PULSE_MARKERS } from '../lib/mock-pulse';
import { navigate, obsPath, teamPath } from '../lib/router';
import { dragWindow, type ObsQuery } from '../lib/observability-query';
import { VERDICTS, compact, duration, errorRate } from '../lib/fleet-rows';
import { applyOverlayPrefs, useOverlayPrefs } from '../lib/overlay-prefs';
import { axisLabels, clock } from '../lib/schedule-rows';
import {
  AXIS_LEFT,
  AXIS_RIGHT,
  PULSE_GRID,
  bucketSpans,
  deployPills,
  errorBarsPath,
  pulseAppRows,
  pulseStamp,
  sparkPaths,
  xOf,
  type PulseAppRow,
} from '../lib/pulse-rows';
import { Page } from '../components/layout';
import { OverlayChips } from '../components/OverlayChips';
import { AppFilter, PageHead } from '../components/ObsControls';
import { AppSchedules } from './AppSchedules';

/**
 * Pulse (#1767): every app on one clock. The design's one-clock card — each row a name,
 * three numbers and a sparkline, every section on one grid so the sparkline column is the
 * same stretch of time all the way down — replaces the old sub-view switch and the big
 * traffic chart.
 *
 * Narrowed to one app the card gains what only one app can say: its deploy strip (release
 * markers are per-app facts; the team series carries none, and drawing one app's across
 * every row would claim instants the others never had) and its Schedules and freshness.
 *
 * The design's Connectors and Business today sections are not drawn: nothing reads either
 * at the tenant grain yet (#1750), and a section of invented rows would be worse than none.
 */

/** The ranges the plane answers — capped at 72h, so the design's 7 and 30 days are 3 days here. */
const RANGES = [
  { value: '1', label: '1h', words: 'last hour' },
  { value: '24', label: '24h', words: 'last 24 hours' },
  { value: '72', label: '3 days', words: 'last 3 days' },
] as const;

/** What the card's own read produces. The overlays are a second read that must not gate it. */
interface ChartRead {
  series: TeamTrafficSeries;
  markers: ReleaseMarker[];
}

/** Five minutes either side of an instant — the window a marker opens Logs with. */
function around(at: string): { from: string; to: string } {
  const t = Date.parse(at);
  return { from: new Date(t - 5 * 60_000).toISOString(), to: new Date(t + 5 * 60_000).toISOString() };
}

export function Pulse({
  apps,
  scopeId,
  hours,
  window,
  requestWindow,
  cursor,
  nonce,
  timeError,
  onNav,
  onRange,
  onPreset,
  onApp,
  onRefresh,
  onMarker,
}: {
  apps: AppRow[];
  scopeId: string | null;
  hours: number;
  /** The card's clock — the page's range, or the custom window a drag or a link set. */
  window: { from: string; to: string };
  /** Sent only for an explicit window; a preset keeps the hours-only request its cache is keyed on. */
  requestWindow: { since: string; until: string } | undefined;
  cursor: { from: string; to: string } | null;
  nonce: number;
  timeError: string;
  onNav: (q: ObsQuery) => void;
  onRange: (w: { from: string; to: string }) => void;
  onPreset: (hours: number | null) => void;
  onApp: (scopeId: string | null) => void;
  onRefresh: () => void;
  onMarker: (m: OverlayMarker) => void;
}) {
  const oneApp = scopeId !== null;
  const app = scopeId ? apps.find((a) => a.app_scope_id === scopeId) : undefined;
  const [series, setSeries] = useState<TeamTrafficSeries | null>(null);
  const [markers, setMarkers] = useState<ReleaseMarker[]>([]);
  const [overlays, setOverlays] = useState<AppOverlays | undefined>(undefined);
  const [overlayError, setOverlayError] = useState(false);
  const [chartError, setChartError] = useState(false);
  const [health, setHealth] = useState<AppHealthRow[] | null | undefined>(undefined);
  const [metrics, setMetrics] = useState<AppMetricsView | null | undefined>(undefined);
  const prefs = useOverlayPrefs();

  useEffect(() => {
    let live = true;
    // Cleared before the refetch: a card drawn for one app under a heading that now names
    // another is the misreading the whole page exists to prevent.
    setSeries(null);
    setMarkers([]);
    setOverlays(undefined);
    setChartError(false);
    setOverlayError(false);
    if (DEV_MOCK) {
      setSeries(scopeId ? { ...MOCK_TEAM_TRAFFIC, series: MOCK_TEAM_TRAFFIC.series.filter((s) => s.scopeId === scopeId) } : MOCK_TEAM_TRAFFIC);
      if (scopeId) {
        setMarkers(MOCK_PULSE_MARKERS);
        setOverlays(MOCK_APP_OVERLAYS);
      }
      return;
    }
    // One app is the per-app route's question, and it answers the release markers with the
    // series — the team route cannot, because it plots several verticals at once.
    const read: Promise<ChartRead> = scopeId
      ? api.appTraffic(scopeId, hours, requestWindow).then((t) => ({
          series: { window: t.window, series: [{ scopeId, buckets: t.buckets }], bucketMinutes: t.bucketMinutes, available: t.available },
          markers: t.markers,
        }))
      : api.teamTraffic({ hours, ...requestWindow }).then((s) => ({ series: s, markers: [] }));
    // The overlays ride a second route, started beside the first and never awaited with
    // it: the card draws the moment the series lands, and a slow overlay source must not
    // hold it. A failure costs the glyphs and nothing else.
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
        // A 501 and a worker predating the route say the same thing: nothing can be drawn.
        // Neither is an empty series, which would read as silence.
        setChartError(!(e instanceof ApiError && e.status === 501));
        setSeries({ series: [], bucketMinutes: 60, available: false });
      });
    return () => {
      live = false;
    };
  }, [scopeId, hours, nonce, requestWindow?.since, requestWindow?.until]);

  useEffect(() => {
    let live = true;
    setHealth(undefined);
    setMetrics(undefined);
    if (DEV_MOCK) {
      setHealth(MOCK_FLEET_HEALTH);
      setMetrics(MOCK_APP_METRICS);
      return;
    }
    // Two reads, and neither gates the other: a missing verdict still leaves the traffic,
    // and missing traffic still leaves the verdicts.
    api.fleetHealth().then((r) => live && setHealth(r.rows)).catch(() => live && setHealth(null));
    api.appMetrics(hours).then((m) => live && setMetrics(m)).catch(() => live && setMetrics(null));
    return () => {
      live = false;
    };
  }, [hours, nonce]);

  const rows = useMemo(() => {
    const all = pulseAppRows({ apps, health: health ?? null, metrics: metrics ?? null, series, custom: cursor !== null });
    return scopeId ? all.filter((r) => r.scopeId === scopeId) : all;
  }, [apps, health, metrics, series, cursor, scopeId]);
  const shown = applyOverlayPrefs(prefs, markers, overlays);
  const pills = oneApp ? deployPills(shown.markers.filter((m) => m.kind === 'went-live'), window) : [];
  const pushes = oneApp ? shown.markers.filter((m) => m.kind === 'pushed') : [];
  const loading = health === undefined || metrics === undefined;
  const stamp = pulseStamp(window.to);
  const range = RANGES.find((r) => Number(r.value) === hours);
  const bins = series?.bucketMinutes ? (series.bucketMinutes < 60 ? `${series.bucketMinutes} min` : `${series.bucketMinutes / 60} h`) : null;

  // Drag-to-zoom on the sparkline column: any row's sparkline is a handle on the card's
  // one clock. A drag shorter than a click leaves the row's own link to work.
  const drag = useRef<{ x0: number; width: number; left: number } | null>(null);
  const dragged = useRef(false);
  const [brush, setBrush] = useState<[number, number] | null>(null);
  const handle = {
    onPointerDown: (e: ReactPointerEvent<HTMLElement>) => {
      if (e.button !== 0) return;
      const r = e.currentTarget.getBoundingClientRect();
      drag.current = { x0: e.clientX - r.left, width: r.width, left: r.left };
      dragged.current = false;
      e.currentTarget.setPointerCapture?.(e.pointerId);
    },
    onPointerMove: (e: ReactPointerEvent<HTMLElement>) => {
      const d = drag.current;
      if (!d) return;
      const x = e.clientX - d.left;
      if (Math.abs(x - d.x0) >= 5) setBrush([Math.max(0, Math.min(d.x0, x)) / d.width, Math.min(d.width, Math.max(d.x0, x)) / d.width]);
    },
    onPointerUp: (e: ReactPointerEvent<HTMLElement>) => {
      const d = drag.current;
      drag.current = null;
      setBrush(null);
      if (!d) return;
      const w = dragWindow(d.x0, e.clientX - d.left, d.width, { since: window.from, until: window.to });
      if (w) {
        dragged.current = true;
        onRange(w);
      }
    },
    onPointerCancel: () => {
      drag.current = null;
      setBrush(null);
    },
    onKeyDown: (e: React.KeyboardEvent) => {
      if (e.key === 'Escape' && drag.current) {
        drag.current = null;
        setBrush(null);
      }
    },
  };
  const openRow = (r: PulseAppRow) => {
    if (dragged.current) {
      dragged.current = false;
      return;
    }
    // All apps: a row narrows the page to its app. Already narrowed: it opens the app.
    if (oneApp) navigate(`/apps/${r.scopeId}/overview`);
    else onNav({ app: r.scopeId });
  };

  return (
    <Page>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 12, flexWrap: 'wrap' }}>
        <PageHead
          title="Pulse"
          sub={
            <>
              {stamp.day} · <span style={{ fontFamily: 'var(--font-mono)' }}>{stamp.time}</span> UTC ·{' '}
              {cursor ? (
                <span style={{ fontFamily: 'var(--font-mono)' }}>
                  {clock(cursor.from)}–{clock(cursor.to)}
                </span>
              ) : (
                (range?.words ?? `last ${hours} hours`)
              )}{' '}
              · {app ? app.name : 'All apps'}
            </>
          }
        />
        <AppFilter apps={apps} value={scopeId} onChange={onApp} />
        {cursor && (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, height: 28, padding: '0 4px 0 10px', fontSize: 12.5, color: 'var(--text-secondary)', background: 'var(--surface-inset)', border: '1px solid var(--border-subtle)', borderRadius: 8 }}>
            Custom interval
            <button
              type="button"
              aria-label="Clear custom time interval"
              title="Back to the whole range"
              onClick={() => onPreset(null)}
              style={{ appearance: 'none', border: 0, background: 'transparent', color: 'var(--text-tertiary)', cursor: 'pointer', fontSize: 14, lineHeight: 1, padding: '0 6px' }}
            >
              ×
            </button>
          </span>
        )}
        <div role="group" aria-label="Time range">
          <Tabs tabs={RANGES.map((r) => ({ value: r.value, label: r.label }))} value={cursor ? '' : String(hours)} onChange={(v) => onPreset(Number(v))} style={{ borderBottom: 'none' }} />
        </div>
        <Button variant="ghost" size="sm" onClick={onRefresh}>
          Refresh
        </Button>
      </div>
      {timeError && <p role="alert" style={{ margin: 0, fontSize: 12.5, color: 'var(--status-danger-fg)' }}>{timeError}</p>}

      {oneApp && (
        <div style={{ marginBottom: -8 }}>
          <OverlayChips label="On every chart" />
        </div>
      )}

      <div data-pulse-card style={{ position: 'relative', border: '1px solid var(--border-default)', borderRadius: 12, background: 'var(--surface-card)', boxShadow: 'var(--shadow-sm)', overflow: 'hidden' }}>
        {oneApp && (
          <DeployStrip
            pills={pills}
            pushes={pushes}
            window={window}
            overlayMarkers={shown.overlays?.markers ?? []}
            onRelease={(m) => onNav({ ...(scopeId ? { app: scopeId } : {}), view: 'logs', ...around(m.at) })}
            onMarker={onMarker}
          />
        )}
        <SectionHead
          cells={['Apps', 'Requests', 'Errors', 'p95', bins ? `Requests · errors, ${bins} bins` : 'Requests · errors', 'Status']}
          first={!oneApp}
        />
        {apps.length === 0 ? (
          <Note>No apps yet — traffic appears here once one is serving.</Note>
        ) : (
          rows.map((r) => (
            <AppLine
              key={r.scopeId}
              row={r}
              loading={loading}
              series={series}
              window={window}
              stale={oneApp ? (shown.overlays?.spans ?? []) : []}
              handle={handle}
              onOpen={() => openRow(r)}
              href={teamPath(oneApp ? `/apps/${r.scopeId}/overview` : obsPath({ app: r.scopeId }))}
            />
          ))
        )}
        {series && !series.available && (
          <Note>
            {chartError
              ? 'Traffic over time is unavailable right now.'
              : 'Traffic over time is not available on this plane — no sparkline is drawn rather than one that would read as silence.'}
          </Note>
        )}
        {scopeId && (
          <AppSchedules
            key={`${scopeId}:${nonce}`}
            embedded
            scopeId={scopeId}
            window={window}
            focused={cursor !== null}
            {...(app ? { appName: app.name } : {})}
            onOpen={(next) => onNav({ app: scopeId, ...next })}
          />
        )}
        <AxisRow window={window} schedules={oneApp} />
        <Lines oneApp={oneApp} pills={pills} pushes={pushes} window={window} migrations={(shown.overlays?.markers ?? []).filter((m) => m.kind === 'migration')} brush={brush} />
      </div>

      {oneApp && !!overlays?.incompleteSources?.length && <Footnote>Partial change history: {overlays.incompleteSources.join(', ')}. Older records may be omitted.</Footnote>}
      {oneApp && overlayError && <Footnote>Change overlays are unavailable. Traffic is still shown.</Footnote>}
      {oneApp && !!overlays?.unavailableSources?.length && <Footnote>Unavailable change sources: {overlays.unavailableSources.join(', ')}.</Footnote>}
      {metrics === null && <Footnote>Per-app requests, errors and p95 could not be read.</Footnote>}
      {metrics && !metrics.available && <Footnote>Per-app requests, errors and p95 are not measured on this platform.</Footnote>}
      <Footnote>
        Traffic to your installations — approximate, sampled at high volume. Drag across a sparkline to narrow the window.
        {!oneApp && ' Narrow to one app for its deploys and schedules on the same clock.'}
      </Footnote>
    </Page>
  );
}

const caps: CSSProperties = { fontSize: 11, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--text-tertiary)' };
const num: CSSProperties = { textAlign: 'right', paddingRight: 16, fontFamily: 'var(--font-mono)', fontSize: 13 };

function SectionHead({ cells, first }: { cells: string[]; first?: boolean }) {
  return (
    <div role="row" style={{ display: 'grid', gridTemplateColumns: PULSE_GRID, alignItems: 'center', padding: '0 16px', height: 32, ...(first ? {} : { borderTop: '1px solid var(--border-subtle)' }), ...caps }}>
      <span role="columnheader">{cells[0]}</span>
      <span role="columnheader" style={{ textAlign: 'right', paddingRight: 16 }}>{cells[1]}</span>
      <span role="columnheader" style={{ textAlign: 'right', paddingRight: 16 }}>{cells[2]}</span>
      <span role="columnheader" style={{ textAlign: 'right', paddingRight: 16 }}>{cells[3]}</span>
      <span role="columnheader">{cells[4]}</span>
      <span role="columnheader" style={{ textAlign: 'right' }}>{cells[5]}</span>
    </div>
  );
}

type Handle = {
  onPointerDown: (e: ReactPointerEvent<HTMLElement>) => void;
  onPointerMove: (e: ReactPointerEvent<HTMLElement>) => void;
  onPointerUp: (e: ReactPointerEvent<HTMLElement>) => void;
  onPointerCancel: () => void;
  onKeyDown: (e: React.KeyboardEvent) => void;
};

/** One app on the clock: its numbers, its sparkline, its verdict. */
function AppLine({
  row,
  loading,
  series,
  window,
  stale,
  handle,
  onOpen,
  href,
}: {
  row: PulseAppRow;
  loading: boolean;
  series: TeamTrafficSeries | null;
  window: { from: string; to: string };
  stale: AppOverlays['spans'];
  handle: Handle;
  onOpen: () => void;
  href: string;
}) {
  const [hover, setHover] = useState(false);
  const v = VERDICTS[row.verdict];
  const rate = row.requests !== null && row.errors !== null ? errorRate(row.errors, row.requests) : null;
  const hot = row.requests !== null && row.errors !== null && row.requests > 0 && row.errors / row.requests >= 0.01;
  const dash = (title: string | null) => <span title={title ?? undefined} style={{ color: 'var(--text-placeholder)' }}>{loading ? '…' : '—'}</span>;
  const spark = useMemo(() => {
    if (!row.buckets || !series) return null;
    // A bucket wholly outside the window (an edge the read rounded out to) has no place on it.
    const all = bucketSpans(row.buckets, series.bucketMinutes, window);
    const keep = row.buckets.flatMap((b, i) => (all[i]![1] > all[i]![0] ? [{ b, span: all[i]! }] : []));
    const spans = keep.map((k) => k.span);
    const buckets = keep.map((k) => k.b);
    if (buckets.length === 0) return null;
    const req = buckets.map((b) => b.requests);
    const top = Math.max(...req) * 1.1;
    // Errors on the requests' own scale: one failed request among hundreds is a sliver,
    // not a bar as tall as the busiest hour. The path keeps a 2px floor so it is still seen.
    return { paths: sparkPaths(req, spans, top), bars: errorBarsPath(buckets.map((b) => b.errors), spans, top) };
  }, [row.buckets, series, window.from, window.to]);
  return (
    <a
      role="row"
      href={href}
      title={row.why}
      // A link drags natively, which would swallow the sparkline's own drag-to-zoom.
      draggable={false}
      onDragStart={(e) => e.preventDefault()}
      onClick={(e) => {
        e.preventDefault();
        onOpen();
      }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{ display: 'grid', gridTemplateColumns: PULSE_GRID, alignItems: 'center', padding: '0 16px', height: 48, borderTop: '1px solid var(--border-subtle)', color: 'var(--text-primary)', textDecoration: 'none', cursor: 'pointer', background: hover ? 'var(--surface-hover)' : undefined }}
    >
      <span role="cell" style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        <span style={{ fontSize: 13.5, fontWeight: 500, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{row.name}</span>
        <span title={row.scopeId} style={{ fontSize: 11.5, color: 'var(--text-tertiary)', fontFamily: 'var(--font-mono)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {row.vertical}
        </span>
      </span>
      <span role="cell" style={num}>{row.requests === null ? dash(row.unread) : compact(row.requests)}</span>
      <span role="cell" style={{ ...num, color: hot ? 'var(--status-danger-fg)' : 'var(--text-primary)' }}>{rate ?? dash(row.unread)}</span>
      <span role="cell" style={{ ...num, color: 'var(--text-secondary)' }}>{row.p95 === null ? dash(row.p95Why ?? row.unread) : duration(row.p95)}</span>
      <span
        role="cell"
        data-pulse-axis
        {...handle}
        style={{ position: 'relative', display: 'block', height: 32, touchAction: 'none' }}
      >
        {stale.map((s) => {
          const a = Math.max(0, xOf(s.from, window) ?? (Date.parse(s.from) < Date.parse(window.from) ? 0 : 1));
          const b = Math.min(1, xOf(s.to, window) ?? (Date.parse(s.to) > Date.parse(window.to) ? 1 : 0));
          return b > a ? (
            <span
              key={`${s.from}:${s.label}`}
              title={`${s.label} stale`}
              style={{ position: 'absolute', top: 0, bottom: 0, left: `${(a * 100).toFixed(2)}%`, width: `${((b - a) * 100).toFixed(2)}%`, background: 'repeating-linear-gradient(135deg, color-mix(in srgb, var(--status-warning-fg) 22%, transparent) 0 4px, transparent 4px 8px)' }}
            />
          ) : null;
        })}
        {spark?.paths && (
          <svg viewBox="0 0 480 32" preserveAspectRatio="none" aria-hidden style={{ position: 'absolute', inset: 0, width: '100%', height: 32, display: 'block' }}>
            <path d={spark.paths.area} fill="color-mix(in srgb, var(--text-secondary) 12%, transparent)" stroke="none" />
            <path d={spark.paths.line} fill="none" stroke="var(--text-secondary)" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
            {spark.bars && <path d={spark.bars} fill="var(--status-danger-fg)" stroke="none" />}
          </svg>
        )}
      </span>
      <span role="cell" style={{ display: 'flex', justifyContent: 'flex-end' }}>
        {loading ? <span style={{ color: 'var(--text-placeholder)' }}>…</span> : <Badge status={v.status}>{v.label}</Badge>}
      </span>
    </a>
  );
}

/**
 * The deploy strip over one app's card: a pill per release that went live, two rows so
 * neighbours do not collide, and a rail of the other facts — pushes (○), migrations (■),
 * failed runs (×) and recorded failures (!) — each a way into what explains it.
 */
function DeployStrip({
  pills,
  pushes,
  window,
  overlayMarkers,
  onRelease,
  onMarker,
}: {
  pills: ReturnType<typeof deployPills>;
  pushes: ReleaseMarker[];
  window: { from: string; to: string };
  overlayMarkers: OverlayMarker[];
  onRelease: (m: ReleaseMarker) => void;
  onMarker: (m: OverlayMarker) => void;
}) {
  const rail: Array<{ key: string; x: number; glyph: string; color: string; title: string; go: () => void }> = [
    ...pushes.flatMap((m) => {
      const x = xOf(m.at, window);
      return x === null ? [] : [{ key: `p:${m.versionId}`, x, glyph: '○', color: 'var(--text-secondary)', title: `${m.version} pushed · ${clock(m.at)} UTC`, go: () => onRelease(m) }];
    }),
    ...overlayMarkers.flatMap((m, i) => {
      const x = xOf(m.at, window);
      if (x === null) return [];
      const [glyph, color] = m.kind === 'migration' ? ['■', 'var(--text-secondary)'] : m.kind === 'run-failed' ? ['×', 'var(--status-danger-fg)'] : ['!', 'var(--status-danger-fg)'];
      return [{ key: `o:${i}`, x, glyph, color, title: `${m.label}${m.detail ? ` · ${m.detail}` : ''} · ${clock(m.at)} UTC`, go: () => onMarker(m) }];
    }),
  ];
  return (
    <div style={{ display: 'grid', gridTemplateColumns: PULSE_GRID, padding: '0 16px', height: 62, borderBottom: '1px solid var(--border-default)', background: 'var(--surface-inset)' }}>
      <span style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
        <span style={caps}>Timeline</span>
        <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>
          {pills.length === 0 ? 'No release went live' : `${pills.length} ${pills.length === 1 ? 'release' : 'releases'} went live`}
        </span>
      </span>
      <span />
      <span />
      <span />
      <span style={{ position: 'relative' }} aria-label="Releases and changes" role="group">
        {pills.map((p, i) => {
          const newest = i === pills.length - 1;
          return (
            <button
              key={p.marker.versionId + p.marker.at}
              type="button"
              title={`${p.marker.version} went live · ${clock(p.marker.at)} UTC — logs around it`}
              onClick={() => onRelease(p.marker)}
              style={{
                position: 'absolute',
                left: `${(p.x * 100).toFixed(2)}%`,
                top: p.row ? 27 : 8,
                transform: p.anchorLeft ? 'translateX(-100%)' : 'translateX(-50%)',
                marginLeft: p.anchorLeft ? 1 : 0,
                whiteSpace: 'nowrap',
                fontFamily: 'var(--font-mono)',
                fontSize: 11,
                lineHeight: '16px',
                padding: '0 5px',
                borderRadius: 4,
                border: `1px solid ${newest ? 'var(--border-strong)' : 'var(--border-default)'}`,
                background: 'var(--surface-card)',
                color: newest ? 'var(--text-primary)' : 'var(--text-secondary)',
                cursor: 'pointer',
              }}
            >
              {p.marker.version}
            </button>
          );
        })}
        {rail.map((r) => (
          <button
            key={r.key}
            type="button"
            title={r.title}
            aria-label={r.title}
            onClick={r.go}
            style={{ appearance: 'none', border: 0, background: 'none', padding: 0, position: 'absolute', left: `${(r.x * 100).toFixed(2)}%`, top: 45, transform: 'translateX(-50%)', fontFamily: 'var(--font-mono)', fontSize: 10.5, lineHeight: '14px', color: r.color, cursor: 'pointer' }}
          >
            {r.glyph}
          </button>
        ))}
      </span>
      <span />
    </div>
  );
}

/**
 * The vertical lines across the card, on the sparkline column: solid where a release
 * went live, dashed where one was pushed, dotted for a migration — and the drag brush.
 * Pointer-transparent, so the rows under them stay clickable.
 */
function Lines({
  oneApp,
  pills,
  pushes,
  window,
  migrations,
  brush,
}: {
  oneApp: boolean;
  pills: ReturnType<typeof deployPills>;
  pushes: ReleaseMarker[];
  window: { from: string; to: string };
  migrations: OverlayMarker[];
  brush: [number, number] | null;
}) {
  const line = (x: number, style: string, color = 'var(--border-strong)', extra: CSSProperties = {}): CSSProperties => ({
    position: 'absolute',
    top: 0,
    bottom: 0,
    left: `${(x * 100).toFixed(2)}%`,
    borderLeft: `1px ${style} ${color}`,
    ...extra,
  });
  return (
    <div aria-hidden style={{ position: 'absolute', top: oneApp ? 40 : 0, bottom: 28, left: AXIS_LEFT, right: AXIS_RIGHT, pointerEvents: 'none' }}>
      {pills.map((p) => (
        <span key={`l:${p.marker.versionId}:${p.marker.at}`} data-deploy-line="went-live" style={line(p.x, 'solid')} />
      ))}
      {pushes.map((m) => {
        const x = xOf(m.at, window);
        return x === null ? null : <span key={`d:${m.versionId}:${m.at}`} data-deploy-line="pushed" style={line(x, 'dashed')} />;
      })}
      {migrations.map((m, i) => {
        const x = xOf(m.at, window);
        return x === null ? null : <span key={`m:${i}`} style={line(x, 'dotted', 'var(--text-tertiary)', { opacity: 0.6 })} />;
      })}
      {brush && (
        <span
          data-pulse-brush
          style={{ position: 'absolute', top: 0, bottom: 0, left: `${(brush[0] * 100).toFixed(2)}%`, width: `${((brush[1] - brush[0]) * 100).toFixed(2)}%`, background: 'color-mix(in srgb, var(--brand-400) 14%, transparent)', borderLeft: '1px solid var(--brand-400)', borderRight: '1px solid var(--brand-400)' }}
        />
      )}
    </div>
  );
}

/** The card's time axis: the legend, then the ticks under the sparkline column. */
function AxisRow({ window, schedules }: { window: { from: string; to: string }; schedules: boolean }) {
  const swatch = (style: CSSProperties, label: string) => (
    <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
      <span style={style} />
      {label}
    </span>
  );
  return (
    <div style={{ display: 'grid', gridTemplateColumns: PULSE_GRID, padding: '0 16px', height: 28, borderTop: '1px solid var(--border-default)' }}>
      <span style={{ fontSize: 11.5, color: 'var(--text-tertiary)', display: 'flex', alignItems: 'center', gap: 10 }}>
        {swatch({ width: 10, height: 2, background: 'var(--text-secondary)' }, 'runtime')}
        {schedules && swatch({ width: 2, height: 10, background: 'var(--text-tertiary)' }, 'run')}
        {schedules && swatch({ width: 2, height: 12, background: 'var(--status-danger-fg)' }, 'failed')}
        <span>UTC</span>
      </span>
      <span />
      <span />
      <span />
      <span style={{ position: 'relative' }}>
        {axisLabels(window).map((t) => (
          <span
            key={t.left}
            style={{
              position: 'absolute',
              left: `${(t.left * 100).toFixed(2)}%`,
              top: 6,
              transform: t.left === 0 ? 'none' : t.left === 1 ? 'translateX(-100%)' : 'translateX(-50%)',
              fontFamily: 'var(--font-mono)',
              fontSize: 10.5,
              color: 'var(--text-tertiary)',
              whiteSpace: 'nowrap',
            }}
          >
            {t.label}
          </span>
        ))}
      </span>
      <span />
    </div>
  );
}

function Note({ children }: { children: ReactNode }) {
  return <div style={{ padding: '10px 16px', borderTop: '1px solid var(--border-subtle)', fontSize: 12.5, color: 'var(--text-tertiary)' }}>{children}</div>;
}

function Footnote({ children }: { children: ReactNode }) {
  return <p style={{ margin: '-8px 0 0', fontSize: 12, color: 'var(--text-tertiary)' }}>{children}</p>;
}
