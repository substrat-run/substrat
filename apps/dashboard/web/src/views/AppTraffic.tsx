import { useEffect, useRef, useState, type PointerEvent, type ReactNode } from 'react';
import { Button } from '@substrat-run/ui';
import { api, ApiError, type AppOverlays, type TenantMetricsRow, type TrafficSeries } from '../lib/api';
import { DEV_MOCK } from '../lib/mock';
import { mockAppOverlays, mockAppTraffic, mockSurfaceMetrics } from '../lib/mock-app-traffic';
import { navigate, obsPath, teamPath } from '../lib/router';
import { dragWindow } from '../lib/observability-query';
import { applyOverlayPrefs, useOverlayPrefs } from '../lib/overlay-prefs';
import {
  bucketAt,
  bucketBox,
  bucketLabel,
  bucketWindow,
  classTotals,
  clockOf,
  fmtCount,
  rangeLabel,
  resolveClockRange,
  seriesWindow,
  surfaceRows,
  type TimeWindow,
} from '../lib/app-traffic';
import { TrafficChart } from '../components/TrafficChart';
import { OverlayChips } from '../components/OverlayChips';
import { card } from '../components/ui';

const PLOT_HEIGHT = 130;

/**
 * App › Overview's "Traffic by status" card and the per-surface table under it (#1767).
 * It replaced the Overview's 24-hour sparkline: the same read (`appTraffic`), now drawn
 * as the status-class bars with the shared overlay vocabulary, and zoomable in place.
 *
 * A zoom is a new READ, not a crop: the narrower window goes back to the plane with exact
 * bounds, and the plane answers it in finer buckets where it has them (15 minutes for a
 * window of six hours or less, hourly beyond — that is the whole ladder; nothing finer
 * is invented here). The zoom history is this card's own state rather than the URL's:
 * the app page's address names the app and tab, and a zoom is a glance, while the walk
 * to evidence — "Open logs for this window" — is a real link that carries the window.
 */
export function AppTraffic({
  scopeId,
  surfaces,
}: {
  scopeId: string;
  surfaces: Array<{ surface: string | null; label: string | null; hostname: string }>;
}) {
  const [stack, setStack] = useState<TimeWindow[]>([]);
  const asked = stack[stack.length - 1];
  const [series, setSeries] = useState<TrafficSeries | 'error' | undefined>(undefined);
  const [overlays, setOverlays] = useState<AppOverlays | undefined>(undefined);
  const [overlayError, setOverlayError] = useState(false);
  const [metrics, setMetrics] = useState<TenantMetricsRow[] | 'absent' | 'error' | undefined>(undefined);
  const [nonce, setNonce] = useState(0);
  const [pinned, setPinned] = useState<number | null>(null);
  const [hover, setHover] = useState<number | null>(null);
  const [selection, setSelection] = useState<{ a: number; b: number } | null>(null);
  const [fromText, setFromText] = useState<string | null>(null);
  const [toText, setToText] = useState<string | null>(null);
  const [rangeError, setRangeError] = useState('');
  const plotBox = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; left: number; width: number; pointer: number } | null>(null);
  const suppressClick = useRef(false);

  // A new app starts from its own day, never from the zoom the previous one was left at.
  useEffect(() => setStack([]), [scopeId]);

  useEffect(() => {
    let live = true;
    // Cleared before the read: one app's bars under another's heading, or a day's bars
    // under a zoomed label, is the misreading this card exists to prevent.
    setSeries(undefined);
    setOverlays(undefined);
    setOverlayError(false);
    setMetrics(undefined);
    setPinned(null);
    setHover(null);
    setFromText(null);
    setToText(null);
    if (DEV_MOCK) {
      const s = mockAppTraffic(asked);
      setSeries(s);
      setOverlays(mockAppOverlays(s));
      setMetrics(mockSurfaceMetrics(s));
      return;
    }
    api
      .appTraffic(scopeId, 24, asked)
      .then((t) => live && setSeries(t))
      // A 501 (or a worker predating the route) says the plane cannot bucket — which is
      // what `available: false` means. Anything else is a read that failed, and must not
      // be presented as a capability the plane lacks.
      .catch((e) =>
        live &&
        setSeries(
          e instanceof ApiError && (e.status === 501 || e.status === 404)
            ? { buckets: [], markers: [], bucketMinutes: 60, available: false }
            : 'error',
        ),
      );
    // A sibling read that never gates the chart: failing costs the glyphs, nothing else.
    api
      .appOverlays(scopeId, 24, asked)
      .then((o) => live && setOverlays(o))
      // Said, not swallowed: a chart with no deploy line reads as "nothing shipped".
      .catch(() => live && setOverlayError(true));
    api
      .appTenantMetrics(scopeId, 24, asked)
      .then((r) => live && setMetrics(r))
      .catch((e) => live && setMetrics(e instanceof ApiError && e.status === 501 ? 'absent' : 'error'));
    return () => {
      live = false;
    };
  }, [scopeId, asked?.since, asked?.until, nonce]);

  const prefs = useOverlayPrefs();
  const ready = series !== undefined && series !== 'error' && series.available && series.buckets.length > 0 ? series : null;
  const window = ready ? seriesWindow(ready) : null;
  const shown = ready ? applyOverlayPrefs(prefs, ready.markers, overlays) : null;
  const totals = ready ? classTotals(ready.buckets) : null;
  const pinBucket = ready && pinned !== null ? ready.buckets[pinned] : undefined;

  const zoom = (w: TimeWindow) => {
    setRangeError('');
    setStack((s) => [...s, w]);
  };
  const logsFor = (w: { from: string; to: string }) => obsPath({ app: scopeId, view: 'logs', from: w.from, to: w.to });
  const openLogs = (w: { from: string; to: string }) => navigate(logsFor(w));
  const whole = window ? { from: window.since, to: window.until } : null;

  const plotRect = () => plotBox.current?.querySelector('[data-traffic-plot]')?.getBoundingClientRect();
  // Only the plot takes gestures: a press on a rail glyph is that glyph's click, and
  // capturing it here would turn it into a pinned bar.
  const inPlot = (target: EventTarget | null) => target instanceof Element && target.closest('[data-traffic-plot]') !== null;
  const onDown = (e: PointerEvent<HTMLDivElement>) => {
    if (!ready || e.button !== 0 || !inPlot(e.target)) return;
    const r = plotRect();
    if (!r || r.width <= 0) return;
    suppressClick.current = false;
    // No focus on press: a pointer-focused bar draws the browser's focus ring stretched
    // across the scaled plot. Keyboard focus, which needs the ring, is unaffected.
    e.preventDefault();
    drag.current = { x: e.clientX - r.left, left: r.left, width: r.width, pointer: e.pointerId };
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };
  const onMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!ready || !window) return;
    const d = drag.current;
    if (d) {
      const x = Math.max(0, Math.min(d.width, e.clientX - d.left));
      if (Math.abs(x - d.x) >= 5) suppressClick.current = true;
      setSelection({ a: d.x / d.width, b: x / d.width });
      return;
    }
    const r = plotRect();
    if (!r || r.width <= 0 || !inPlot(e.target)) {
      setHover(null);
      return;
    }
    const i = bucketAt(ready.buckets, ready.bucketMinutes, window, (e.clientX - r.left) / r.width);
    setHover(i < 0 ? null : i);
  };
  const endDrag = () => {
    drag.current = null;
    setSelection(null);
  };
  const onUp = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.pointer !== e.pointerId || !ready || !window) return;
    endDrag();
    const picked = dragWindow(d.x, e.clientX - d.left, d.width, window);
    if (picked) {
      suppressClick.current = true;
      zoom({ since: picked.from, until: picked.to });
      return;
    }
    // Pointer capture retargets the click to this wrapper, so the bar is found here.
    const i = bucketAt(ready.buckets, ready.bucketMinutes, window, d.x / d.width);
    if (i >= 0) setPinned(i);
  };

  const applyRange = () => {
    if (!window) return;
    const r = resolveClockRange(fromText ?? clockOf(window.since), toText ?? clockOf(window.until));
    if ('error' in r) setRangeError(r.error);
    else zoom({ since: r.from, until: r.to });
  };

  const mono = { fontFamily: 'var(--font-mono)' } as const;
  const inputStyle = {
    width: 52,
    height: 26,
    padding: '0 6px',
    border: '1px solid var(--border-default)',
    borderRadius: 6,
    background: 'var(--surface-card)',
    color: 'var(--text-primary)',
    fontFamily: 'var(--font-mono)',
    fontSize: 12,
    outline: 'none',
  } as const;
  const legend = [
    { label: '2xx/3xx ok', color: 'var(--text-tertiary)', n: totals?.ok ?? null },
    { label: '4xx refused', color: 'var(--status-warning-fg)', n: totals?.refused ?? null },
    { label: '5xx failed', color: 'var(--status-danger-fg)', n: totals?.failed ?? null },
  ];

  return (
    <>
      <div style={{ ...card, padding: '12px 16px 10px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap', marginBottom: 8 }}>
          <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' }}>Traffic by status</span>
          <span style={{ fontSize: 12.5, color: 'var(--text-tertiary)' }}>
            {ready && window ? (stack.length ? rangeLabel(window, ready.bucketMinutes) : `Last 24 hours · ${bucketLabel(ready.bucketMinutes)}`) : ''}
          </span>
          {stack.length > 0 && (
            <a
              href="#"
              onClick={(e) => {
                e.preventDefault();
                setStack((s) => s.slice(0, -1));
              }}
              style={{ fontSize: 12.5, color: 'var(--text-brand)' }}
            >
              Undo zoom
            </a>
          )}
          <span style={{ flex: 1 }} />
          {legend.map((l) => (
            <span key={l.label} style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 12.5, color: 'var(--text-secondary)' }}>
              <span aria-hidden style={{ width: 8, height: 8, borderRadius: 2, background: l.color }} />
              {l.label}{' '}
              {whole && l.n !== null ? (
                <a
                  href={teamPath(logsFor(whole))}
                  onClick={(e) => {
                    e.preventDefault();
                    openLogs(whole);
                  }}
                  style={{ ...mono, color: 'var(--text-primary)' }}
                >
                  {fmtCount(l.n)}
                </a>
              ) : (
                <span style={{ ...mono, color: 'var(--text-tertiary)' }} title="Not measured for this window">—</span>
              )}
            </span>
          ))}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              applyRange();
            }}
            style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--text-tertiary)' }}
          >
            <input aria-label="From (UTC, HH:MM)" value={fromText ?? (window ? clockOf(window.since) : '')} onChange={(e) => setFromText(e.target.value)} style={inputStyle} />
            <span aria-hidden>→</span>
            <input aria-label="To (UTC, HH:MM)" value={toText ?? (window ? clockOf(window.until) : '')} onChange={(e) => setToText(e.target.value)} style={inputStyle} />
            <Button variant="secondary" size="sm" disabled={!window}>
              Apply
            </Button>
          </form>
        </div>
        {rangeError && (
          <div role="alert" style={{ fontSize: 12, color: 'var(--status-danger-fg)', marginBottom: 6 }}>
            {rangeError}
          </div>
        )}
        <div style={{ marginBottom: 6 }}>
          <OverlayChips />
        </div>
        {series === undefined ? (
          <Placeholder>Loading traffic…</Placeholder>
        ) : series === 'error' ? (
          <Placeholder danger>
            Traffic could not be read just now.{' '}
            <a
              href="#"
              onClick={(e) => {
                e.preventDefault();
                setNonce((n) => n + 1);
              }}
              style={{ color: 'var(--text-brand)' }}
            >
              Try again
            </a>
          </Placeholder>
        ) : !ready || !window || !shown ? (
          // Words rather than a flat line: a line would read as an app nobody used.
          <Placeholder>Traffic over time is not available on this plane.</Placeholder>
        ) : (
          <div
            ref={plotBox}
            onPointerDown={onDown}
            onPointerMove={onMove}
            onPointerUp={onUp}
            onPointerCancel={endDrag}
            onPointerLeave={() => {
              if (!drag.current) setHover(null);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                endDrag();
                setPinned(null);
              }
            }}
            style={{ cursor: 'crosshair', userSelect: 'none' }}
          >
            <TrafficChart
              variant="card"
              height={PLOT_HEIGHT}
              buckets={ready.buckets}
              bucketMinutes={ready.bucketMinutes}
              plotWindow={window}
              markers={shown.markers}
              {...(shown.overlays ? { overlays: shown.overlays } : {})}
              // A glyph opens the view that explains it, on its own minutes — the same
              // walk the Observability chart takes, so the two charts agree.
              onMarker={(m) => {
                if (m.kind === 'migration') {
                  navigate(`/apps/${scopeId}/deployments`);
                  return;
                }
                const t = Date.parse(m.at);
                navigate(obsPath({ app: scopeId, view: m.kind === 'run-failed' ? 'schedules' : 'logs', from: new Date(t - 5 * 60_000).toISOString(), to: new Date(Math.min(t + 5 * 60_000, Math.floor(Date.now() / 1000) * 1000)).toISOString() }));
              }}
              // Keyboard (and an uncaptured click) pins a bar; a drag that just ended does not.
              onBucket={(start) => {
                if (!suppressClick.current) setPinned(ready.buckets.findIndex((b) => b.start === start));
              }}
              plotOverlay={
                <>
                  {selection && (
                    <span
                      aria-hidden
                      style={{
                        position: 'absolute',
                        top: 0,
                        bottom: 0,
                        left: `${Math.min(selection.a, selection.b) * 100}%`,
                        width: `${Math.abs(selection.b - selection.a) * 100}%`,
                        background: 'color-mix(in srgb, var(--brand-400) 16%, transparent)',
                        borderLeft: '1px solid var(--brand-400)',
                        borderRight: '1px solid var(--brand-400)',
                        pointerEvents: 'none',
                      }}
                    />
                  )}
                  {pinBucket && (
                    <span
                      aria-hidden
                      style={{
                        position: 'absolute',
                        top: 0,
                        bottom: 0,
                        ...bucketBox(pinBucket, ready.bucketMinutes, window),
                        boxSizing: 'border-box',
                        border: '1.5px solid var(--brand-400)',
                        borderRadius: 2,
                        pointerEvents: 'none',
                      }}
                    />
                  )}
                  {hover !== null && !selection && ready.buckets[hover] && (
                    <span
                      aria-hidden
                      style={{
                        position: 'absolute',
                        top: 0,
                        bottom: 0,
                        ...bucketBox(ready.buckets[hover]!, ready.bucketMinutes, window),
                        background: 'color-mix(in srgb, var(--text-primary) 8%, transparent)',
                        pointerEvents: 'none',
                      }}
                    />
                  )}
                </>
              }
            />
          </div>
        )}
        {/* The overlays' own state, in Pulse's words: an absent line must never read as
            an absent deploy, migration or failure. */}
        {ready && (overlayError || !!overlays?.incompleteSources?.length || !!overlays?.unavailableSources?.length) && (
          <div style={{ display: 'grid', gap: 2, marginTop: 6, fontSize: 12, color: 'var(--text-tertiary)' }}>
            {!!overlays?.incompleteSources?.length && <p role="status" style={{ margin: 0 }}>Partial change history: {overlays.incompleteSources.join(', ')}. Older records may be omitted.</p>}
            {overlayError && <p role="status" style={{ margin: 0 }}>Change overlays are unavailable. Traffic is still shown.</p>}
            {!!overlays?.unavailableSources?.length && <p role="status" style={{ margin: 0 }}>Unavailable change sources: {overlays.unavailableSources.join(', ')}.</p>}
          </div>
        )}
        <div
          aria-live="polite"
          style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 8, minHeight: 32, paddingTop: 8, borderTop: '1px solid var(--border-subtle)', fontSize: 12.5, flexWrap: 'wrap' }}
        >
          {pinBucket && ready && window ? (
            (() => {
              const w = bucketWindow(pinBucket, ready.bucketMinutes, window);
              return (
                <>
                  <span style={{ ...mono, color: 'var(--text-primary)' }}>
                    {clockOf(w.from)}–{clockOf(w.to)} UTC
                  </span>
                  <span style={{ color: 'var(--text-secondary)' }}>
                    <span style={mono}>{pinBucket.requests.toLocaleString('en-US')}</span> requests ·{' '}
                    <span style={{ ...mono, color: 'var(--status-warning-fg)' }}>{fmtCount(pinBucket.yellow ?? null)}</span> refused 4xx ·{' '}
                    <span style={{ ...mono, color: 'var(--status-danger-fg)' }}>{pinBucket.errors.toLocaleString('en-US')}</span> failed 5xx
                  </span>
                  <span style={{ flex: 1 }} />
                  <a
                    href="#"
                    onClick={(e) => {
                      e.preventDefault();
                      setPinned(null);
                    }}
                    style={{ fontSize: 12, color: 'var(--text-tertiary)' }}
                  >
                    Unpin
                  </a>
                  <Button variant="primary" size="sm" onClick={() => openLogs(w)}>
                    Open logs for this window
                  </Button>
                </>
              );
            })()
          ) : (
            <>
              <span style={{ color: 'var(--text-tertiary)' }}>Drag to zoom · click a bar to pin it and open that window&rsquo;s logs</span>
              <span style={{ flex: 1 }} />
              <a
                href={teamPath(obsPath({ app: scopeId }))}
                onClick={(e) => {
                  e.preventDefault();
                  navigate(obsPath({ app: scopeId }));
                }}
                style={{ color: 'var(--text-brand)', fontSize: 12.5 }}
              >
                Open in Observability →
              </a>
            </>
          )}
        </div>
      </div>
      <SurfaceTable metrics={metrics} surfaces={surfaces} {...(whole ? { onOpen: () => openLogs(whole), href: teamPath(logsFor(whole)) } : {})} />
    </>
  );
}

function Placeholder({ children, danger }: { children: ReactNode; danger?: boolean }) {
  return (
    <div style={{ height: PLOT_HEIGHT + 44, display: 'flex', alignItems: 'center', fontSize: 12.5, color: danger ? 'var(--status-danger-fg)' : 'var(--text-tertiary)' }}>
      {children}
    </div>
  );
}

const COLUMNS = 'minmax(0,1fr) 110px 90px 90px 80px 80px';

/**
 * Requests, errors and latency by the surface that answered, over the chart's window.
 * A row opens the logs for that window: the log read has no surface filter, so the row
 * narrows by time and app and says no more than that.
 */
function SurfaceTable({
  metrics,
  surfaces,
  onOpen,
  href,
}: {
  metrics: TenantMetricsRow[] | 'absent' | 'error' | undefined;
  surfaces: Array<{ surface: string | null; label: string | null; hostname: string }>;
  onOpen?: () => void;
  href?: string;
}) {
  // A plane that cannot answer by surface says nothing here rather than an empty table.
  if (metrics === 'absent') return null;
  const num = { textAlign: 'right', fontFamily: 'var(--font-mono)', fontSize: 12.5 } as const;
  return (
    <div style={{ ...card, overflow: 'hidden', padding: 0 }}>
      <div
        style={{ display: 'grid', gridTemplateColumns: COLUMNS, gap: '0 12px', alignItems: 'center', height: 36, padding: '0 16px', fontSize: 11, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--text-tertiary)', borderBottom: '1px solid var(--border-default)' }}
      >
        <span>Surface</span>
        <span style={{ textAlign: 'right' }}>Requests</span>
        <span style={{ textAlign: 'right' }}>Errors</span>
        <span style={{ textAlign: 'right' }}>Error rate</span>
        <span style={{ textAlign: 'right' }}>p50</span>
        <span style={{ textAlign: 'right' }}>p95</span>
      </div>
      {metrics === undefined ? (
        <div style={{ padding: '12px 16px', fontSize: 12.5, color: 'var(--text-tertiary)' }}>Loading…</div>
      ) : metrics === 'error' ? (
        <div style={{ padding: '12px 16px', fontSize: 12.5, color: 'var(--text-tertiary)' }}>Traffic by surface is unavailable right now.</div>
      ) : metrics.length === 0 ? (
        <div style={{ padding: '12px 16px', fontSize: 12.5, color: 'var(--text-tertiary)' }}>No traffic recorded in this window.</div>
      ) : (
        surfaceRows(metrics, surfaces).map((r) => (
          <a
            key={r.key}
            href={href ?? '#'}
            onClick={(e) => {
              e.preventDefault();
              onOpen?.();
            }}
            style={{ display: 'grid', gridTemplateColumns: COLUMNS, gap: '0 12px', alignItems: 'center', minHeight: 40, padding: '0 16px', borderBottom: '1px solid var(--border-subtle)', color: 'var(--text-primary)', textDecoration: 'none' }}
          >
            <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
              <span style={{ fontSize: 13, fontWeight: 500 }}>{r.name}</span>
              {r.sub && <span style={{ fontSize: 11.5, color: 'var(--text-tertiary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.sub}</span>}
            </span>
            <span style={num}>{r.requests}</span>
            <span style={num}>{r.errors}</span>
            <span style={{ ...num, color: r.rateHigh ? 'var(--status-danger-fg)' : 'var(--text-primary)' }}>{r.rate}</span>
            <span style={{ ...num, color: 'var(--text-secondary)' }}>{r.p50}</span>
            <span style={{ ...num, color: r.p95Slow ? 'var(--status-warning-fg)' : 'var(--text-secondary)' }}>{r.p95}</span>
          </a>
        ))
      )}
    </div>
  );
}
