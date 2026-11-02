import { useEffect, useRef, useState, type FormEvent, type PointerEvent, type ReactNode } from 'react';
import { api, isApiError, type ReleaseMarker, type RequestFacets, type RequestRecord, type RequestVolume } from '../lib/api';
import { DEV_MOCK } from '../lib/mock';
import { mockRequestFacets, mockRequestVolume, mockRequests } from '../lib/mock-requests';
import { mockAppTraffic } from '../lib/mock-app-traffic';
import { card } from '../components/ui';
import { dragWindow, type ObsQuery } from '../lib/observability-query';
import {
  LEVEL_COLORS,
  REQUEST_FACETS,
  axisLabel,
  bucketWidthLabel,
  durationLabel,
  facetValueLabel,
  principalKindLabel,
  requestReadQuery,
  requestSearchOf,
  resultLabel,
  rowLabel,
  selected,
  selectedIn,
  toggleFacet,
  toggleIn,
  whereOf,
  type Facet,
} from '../lib/requests';
import { lineTime } from '../components/LogList';
import { parseRequestId, requestLookup } from '../lib/request-url';

/**
 * The Logs › Requests mode (#1746): one row per request, with the level histogram above
 * and the facet sidebar beside it. All three are read from the stamped invocation line —
 * the per-request record — over the WHOLE window, not the 40 × 20 sample the Lines mode
 * reads, so the counts are the window's own.
 *
 * They take one query: the page's window and the facet filters in the URL. Ticking a
 * facet value, dragging across the histogram and removing a chip are each one navigation,
 * and all three reads answer it, so the bars, the counts and the rows never describe
 * different sets.
 *
 * The page is laid out as the design draws Logs (#2762): the histogram in a card of its own
 * at the top, then the facet sidebar beside the stream card, one scroll for both. The
 * caller hands the stream card in as `frame`, so the mode tabs stay on the card.
 *
 * #2762: the Lines mode draws the same histogram and sidebar (`LinesCounts`) over its own
 * counts — request lines and `ctx.log` lines, by level, operation and who.
 */

/** How many buckets the histogram asks for — the design's 90. Zooming keeps the count. */
export const BUCKETS = 90;
/** How many requests the list shows. */
const LIST_LIMIT = 100;
const HIST_HEIGHT = 110;

export type Loaded<T> = T | null | { error: string };
export const isError = (v: unknown): v is { error: string } => typeof v === 'object' && v !== null && 'error' in v;

/** Why a read failed, in the page's words: 501 is "not on this platform", never an outage. */
function failure(e: unknown): { error: string } {
  // The plane counts the cubes, which cannot match free text: with a search set the chart and
  // the facet counts are unavailable by design, not empty (their list still answers).
  const reason = (e as { body?: { reason?: unknown } } | null)?.body?.reason;
  if (reason === 'search_not_counted') return { error: 'Counts are unavailable while a search is set. The list below shows the matching requests; clear the search to see the chart and counts.' };
  if (isApiError(e) && e.status === 501) return { error: 'Request counts are not available on this platform yet.' };
  if (isApiError(e)) return { error: `Requests could not be read (${e.status}): ${e.message}` };
  return { error: 'Requests could not be read right now.' };
}

export function RequestsMode({
  teamId,
  scopeId,
  q,
  window,
  nonce,
  onFilters,
  onRange,
  onOpenCall,
  zoomed = false,
  onResetZoom,
  live = false,
  frame = (body) => body,
  onCount,
}: {
  teamId: string;
  scopeId: string;
  q: ObsQuery;
  /**
   * The window the page is showing — the cursor's, or the range's own bounds — and the
   * window every read asks for, verbatim. Never `hours`: the plane would anchor that to its
   * own clock, and the histogram draws its bars against THIS window, so a last bucket
   * ending past `to` would be drawn as a bucket a drag to the right edge cannot reach.
   */
  window: { from: string; to: string };
  nonce: number;
  onFilters: (patch: Partial<ObsQuery>) => void;
  /** A brushed range — the page's new window. */
  onRange: (w: { from: string; to: string }) => void;
  /** Open one request's own log lines. */
  onOpenCall: (invocationId: string, atMs: number) => void;
  /** The window is a brushed one, not the range's — the histogram offers the way back. */
  zoomed?: boolean;
  onResetZoom?: () => void;
  /** Live re-reads every few seconds: the last answer stays up until the next one lands,
   *  rather than the page blanking to "Counting…" on every tick. */
  live?: boolean;
  /** The stream card around the list — the page's `LogStream`, so the mode tabs sit on it. */
  frame?: (body: ReactNode) => ReactNode;
  /** The matching requests' total once the facets read has answered, null while it has not:
   *  what the page's mode tab shows. Must be stable across renders. */
  onCount?: (total: number | null) => void;
}) {
  const [volume, setVolume] = useState<Loaded<RequestVolume>>(null);
  const [facets, setFacets] = useState<Loaded<RequestFacets>>(null);
  const [rows, setRows] = useState<Loaded<RequestRecord[]>>(null);
  const [goLives, setGoLives] = useState<ReleaseMarker[]>([]);
  // What the answers on screen are an answer TO, less the window's position: a Live tick
  // slides the window and keeps them up, while another app, filter or range length clears
  // them — an old app's rows must never sit under a new app's name.
  const asked = useRef<string | null>(null);
  const where = whereOf(q);
  const search = requestSearchOf(q);
  const whereKey = JSON.stringify([where, search]);
  const span = { from: Date.parse(window.from), to: Date.parse(window.to) };

  useEffect(() => {
    let current = true;
    const question = JSON.stringify([teamId, scopeId, whereKey, span.to - span.from]);
    const same = asked.current === question;
    asked.current = question;
    if (!live || !same) {
      setVolume(null);
      setFacets(null);
      setRows(null);
    }
    const readWindow = { since: window.from, until: window.to };
    const settle = <T,>(set: (v: Loaded<T>) => void, read: () => Promise<T>) =>
      read().then(
        (v) => current && set(v),
        (e: unknown) => current && set(failure(e)),
      );
    if (DEV_MOCK) {
      setVolume(mockRequestVolume(where, span, BUCKETS));
      setFacets(mockRequestFacets(where, span));
      setRows(mockRequests(where, span, LIST_LIMIT));
      setGoLives(mockAppTraffic(readWindow).markers.filter((m) => m.kind === 'went-live'));
    } else {
      void settle(setVolume, () => api.appRequestVolume(teamId, scopeId, requestReadQuery(q, readWindow, { buckets: BUCKETS })));
      void settle(setFacets, () => api.appRequestFacets(teamId, scopeId, requestReadQuery(q, readWindow)));
      void settle(setRows, () => api.appRequests(teamId, scopeId, requestReadQuery(q, readWindow, { limit: LIST_LIMIT })));
      // The deploy marks are decoration: a failed read costs the marks and nothing else.
      api.appGoLives(teamId, scopeId, readWindow).then(
        (m) => current && setGoLives(m),
        () => current && setGoLives([]),
      );
    }
    return () => {
      current = false;
    };
    // `whereKey` stands for `where`/`q`'s facet keys; the window is its two instants.
  }, [teamId, scopeId, whereKey, window.from, window.to, nonce]);

  const total = facets === null || isError(facets) ? null : facets.total;
  useEffect(() => onCount?.(total), [total, onCount]);

  const levelSel = selected(q, 'level');
  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <div style={{ ...card, boxShadow: 'var(--shadow-sm)' }}>
        <Histogram
          noun="requests"
          volume={volume}
          span={span}
          window={window}
          levels={levelSel}
          goLives={goLives}
          onLevel={(level) => onFilters(toggleFacet(q, 'level', level))}
          onRange={onRange}
          {...(zoomed && onResetZoom ? { onResetZoom } : {})}
        />
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '232px minmax(0,1fr)', gap: 16, alignItems: 'start' }}>
        <FacetSidebar label="Request filters" defs={REQUEST_FACETS} facets={facets} q={q} onToggle={(f, value) => onFilters(toggleIn(q, f, value))} />
        {frame(
          <>
            <FindRequest onOpenCall={onOpenCall} />
            <RequestList rows={rows} total={total} onOpenCall={onOpenCall} />
          </>,
        )}
      </div>
    </div>
  );
}

type Level = 'unrecorded' | 'debug' | 'info' | 'warn' | 'error';
/** A histogram bucket: a request has no `debug`, a line may (#2762). */
type LevelBucket = { start: string; debug?: number; info: number; warn: number; error: number; unrecorded: number };
type Volume = { bucketMs: number; buckets: LevelBucket[]; estimated: boolean };
/** What a histogram counts, and the levels its bars stack, bottom up. */
type Noun = 'requests' | 'lines';
const LEVELS: Record<Noun, readonly Level[]> = {
  requests: ['unrecorded', 'info', 'warn', 'error'],
  lines: ['unrecorded', 'debug', 'info', 'warn', 'error'],
};
const count = (b: LevelBucket, l: Level) => b[l] ?? 0;

/**
 * The level histogram: one stacked bar per bucket, drawn at its own instant on the
 * window's time axis. Dragging across it narrows the page's window (the reads re-bucket at
 * the same count, so the bars get finer) and offers "Reset zoom" back to the range; hovering
 * opens a popover with the bucket's counts. A level in the legend toggles that level's
 * filter. Each version that went live inside the window is a line with its version on it.
 * #2762: drawn over requests here and over lines in the Lines mode.
 */
export function Histogram({
  noun,
  volume,
  span,
  window,
  levels,
  goLives,
  onLevel,
  onRange,
  onResetZoom,
}: {
  noun: Noun;
  volume: Loaded<Volume>;
  span: { from: number; to: number };
  window: { from: string; to: string };
  levels: string[];
  goLives: ReleaseMarker[];
  onLevel: (level: string) => void;
  onRange: (w: { from: string; to: string }) => void;
  /** Present only while the window is a brushed one. */
  onResetZoom?: () => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; left: number; width: number; pointer: number } | null>(null);
  const [selection, setSelection] = useState<{ a: number; b: number } | null>(null);
  const [hover, setHover] = useState<number | null>(null);
  const quiet = { padding: '14px 16px', fontSize: 13, color: 'var(--text-tertiary)' } as const;

  if (volume === null) return <div style={quiet}>Counting {noun}…</div>;
  if (isError(volume)) return <div style={quiet}>{volume.error}</div>;

  const stack = LEVELS[noun];
  const totals = { debug: 0, info: 0, warn: 0, error: 0, unrecorded: 0 };
  for (const b of volume.buckets) for (const l of stack) totals[l] += count(b, l);
  const all = stack.reduce((n, l) => n + totals[l], 0);
  const peak = Math.max(1, ...volume.buckets.map((b) => stack.reduce((n, l) => n + count(b, l), 0)));
  const width = span.to - span.from;
  const at = (t: number) => ((t - span.from) / width) * 100;
  const barWidth = Math.max(0.15, (volume.bucketMs / width) * 100);

  const onDown = (e: PointerEvent<HTMLDivElement>) => {
    const r = box.current?.getBoundingClientRect();
    if (!r || r.width <= 0) return;
    e.preventDefault();
    drag.current = { x: e.clientX - r.left, left: r.left, width: r.width, pointer: e.pointerId };
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };
  const onMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    const r = box.current?.getBoundingClientRect();
    if (d) {
      const x = Math.max(0, Math.min(d.width, e.clientX - d.left));
      setSelection({ a: d.x / d.width, b: x / d.width });
      return;
    }
    if (!r || r.width <= 0) return;
    const t = span.from + ((e.clientX - r.left) / r.width) * width;
    const i = volume.buckets.findIndex((b) => {
      const s = Date.parse(b.start);
      return t >= s && t < s + volume.bucketMs;
    });
    setHover(i < 0 ? null : i);
  };
  const onUp = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.pointer !== e.pointerId) return;
    drag.current = null;
    setSelection(null);
    const picked = dragWindow(d.x, e.clientX - d.left, d.width, { since: window.from, until: window.to });
    if (picked) onRange(picked);
  };

  const hovered = hover === null ? null : volume.buckets[hover];
  const summary = `${all.toLocaleString('en-US')} ${noun}: ${totals.error} errors, ${totals.warn} warnings, ${totals.info} info${totals.debug ? `, ${totals.debug} debug` : ''}${totals.unrecorded ? `, ${totals.unrecorded} with no level recorded` : ''}.`;
  return (
    <div style={{ padding: '12px 16px 10px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap', marginBottom: 8, fontSize: 12.5 }}>
        <span style={{ color: 'var(--text-primary)', fontWeight: 600 }}>
          <span style={{ fontFamily: 'var(--font-mono)' }}>{all.toLocaleString('en-US')}</span> {noun}
        </span>
        <span style={{ color: 'var(--text-tertiary)' }}>
          {bucketWidthLabel(volume.bucketMs)} buckets · drag to zoom
          {volume.estimated && ' · estimated from a sample'}
        </span>
        {onResetZoom && (
          <button
            type="button"
            onClick={onResetZoom}
            style={{ border: 0, padding: '2px 4px', background: 'transparent', font: 'inherit', fontSize: 12.5, color: 'var(--text-link)', cursor: 'pointer' }}
          >
            Reset zoom
          </button>
        )}
        <span style={{ flex: 1 }} />
        {stack.map((l) =>
          l === 'unrecorded' && totals.unrecorded === 0 ? null : (
            <button
              key={l}
              type="button"
              // "Not recorded" cannot be a filter: it is the absence of the field.
              disabled={l === 'unrecorded'}
              aria-pressed={l === 'unrecorded' ? undefined : levels.includes(l)}
              title={l === 'unrecorded' ? `${noun === 'lines' ? 'Request lines' : 'Requests'} served by a version deployed before per-request levels were recorded` : `Show only ${l} ${noun}`}
              onClick={() => onLevel(l)}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 5,
                border: 0,
                padding: '2px 4px',
                borderRadius: 4,
                background: levels.includes(l) ? 'var(--surface-brand-subtle)' : 'transparent',
                color: 'var(--text-secondary)',
                font: 'inherit',
                cursor: l === 'unrecorded' ? 'default' : 'pointer',
              }}
            >
              <span aria-hidden style={{ width: 8, height: 8, borderRadius: 2, background: LEVEL_COLORS[l] }} />
              {l === 'unrecorded' ? 'not recorded' : l}
              <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-primary)' }}>{totals[l].toLocaleString('en-US')}</span>
            </button>
          ),
        )}
      </div>
      <div
        ref={box}
        role="img"
        aria-label={summary}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={() => {
          drag.current = null;
          setSelection(null);
        }}
        onPointerLeave={() => !drag.current && setHover(null)}
        style={{ position: 'relative', height: HIST_HEIGHT, cursor: 'crosshair', userSelect: 'none', borderBottom: '1px solid var(--border-subtle)' }}
      >
        <span style={{ position: 'absolute', top: 0, left: 0, fontSize: 10, fontFamily: 'var(--font-mono)', color: 'var(--text-tertiary)' }}>{peak}</span>
        {volume.buckets.map((b, i) => {
          const s = Date.parse(b.start);
          let bottom = 0;
          return (
            <div
              key={b.start}
              data-bucket
              style={{ position: 'absolute', bottom: 0, top: 0, left: `${at(s)}%`, width: `calc(${barWidth}% - 1px)`, pointerEvents: 'none', background: hover === i ? 'color-mix(in srgb, var(--text-primary) 6%, transparent)' : undefined }}
            >
              {stack.map((l) => {
                const h = (count(b, l) / peak) * 100;
                const seg = h > 0 ? <span key={l} style={{ position: 'absolute', left: 0, right: 0, bottom: `${bottom}%`, height: `${h}%`, background: LEVEL_COLORS[l], borderRadius: 1 }} /> : null;
                bottom += h;
                return seg;
              })}
            </div>
          );
        })}
        {goLives
          .filter((m) => {
            const t = Date.parse(m.at);
            return t >= span.from && t <= span.to;
          })
          .map((m) => {
            const x = at(Date.parse(m.at));
            return (
              <span
                key={`${m.versionId}:${m.at}`}
                data-deploy={m.version}
                title={`${m.version} went live · ${lineTime(Date.parse(m.at)).slice(0, 5)} UTC`}
                style={{ position: 'absolute', top: 0, bottom: 0, left: `${x}%`, borderLeft: '1px dashed var(--brand-400)', pointerEvents: 'none' }}
              >
                <span
                  style={{
                    position: 'absolute',
                    top: 0,
                    // The label sits on the side with room, so a late deploy stays readable.
                    ...(x > 70 ? { right: 4 } : { left: 4 }),
                    fontSize: 10,
                    fontFamily: 'var(--font-mono)',
                    color: 'var(--text-brand)',
                    whiteSpace: 'nowrap',
                    background: 'var(--surface-card)',
                    padding: '0 3px',
                    borderRadius: 3,
                  }}
                >
                  {m.version} · {lineTime(Date.parse(m.at)).slice(0, 5)}
                </span>
              </span>
            );
          })}
        {hovered && hover !== null && !selection && (
          <HoverPopover x={at(Date.parse(hovered.start) + volume.bucketMs / 2)} bucket={hovered} bucketMs={volume.bucketMs} stack={stack} />
        )}
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
      </div>
      <div style={{ minHeight: 18, marginTop: 6, fontSize: 12, color: 'var(--text-tertiary)', display: 'flex', gap: 10 }}>
        <span style={{ fontFamily: 'var(--font-mono)' }}>{axisLabel(span.from, width)}</span>
        <span style={{ flex: 1 }} />
        <span style={{ fontFamily: 'var(--font-mono)' }}>{axisLabel(span.to, width)} UTC</span>
      </div>
    </div>
  );
}

/**
 * The hovered bucket's counts, over the chart beside its bar. It flips to the bar's left
 * near the right edge, so it never runs off the card.
 */
function HoverPopover({ x, bucket, bucketMs, stack }: { x: number; bucket: LevelBucket; bucketMs: number; stack: readonly Level[] }) {
  const start = Date.parse(bucket.start);
  // Loudest first; "not recorded" only when there is any.
  const rows: [Level, number][] = [...stack]
    .reverse()
    .filter((l) => l !== 'unrecorded' || bucket.unrecorded > 0)
    .map((l) => [l, count(bucket, l)]);
  return (
    <div
      role="tooltip"
      aria-live="polite"
      data-popover
      style={{
        position: 'absolute',
        top: 4,
        ...(x > 70 ? { right: `calc(${100 - x}% + 8px)` } : { left: `calc(${x}% + 8px)` }),
        zIndex: 2,
        minWidth: 150,
        padding: '8px 10px',
        background: 'var(--surface-raised)',
        border: '1px solid var(--border-default)',
        borderRadius: 8,
        boxShadow: 'var(--shadow-popover)',
        fontSize: 12,
        color: 'var(--text-secondary)',
        pointerEvents: 'none',
        display: 'grid',
        gap: 3,
      }}
    >
      <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-primary)' }}>
        {lineTime(start).slice(0, 8)}–{lineTime(start + bucketMs).slice(0, 8)} UTC
      </span>
      {rows.map(([level, n]) => (
        <span key={level} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span aria-hidden style={{ width: 8, height: 8, borderRadius: 2, background: LEVEL_COLORS[level] }} />
          {level === 'unrecorded' ? 'not recorded' : level}
          <span style={{ flex: 1 }} />
          <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-primary)' }}>{n.toLocaleString('en-US')}</span>
        </span>
      ))}
    </div>
  );
}

/**
 * The facet sidebar. Each facet's counts are what ticking one of its values would give,
 * because the plane counts a facet with every OTHER filter applied. A ticked value that
 * fell out of the top ten is still listed, so it can be unticked where it was ticked.
 */
export function FacetSidebar({
  label,
  defs,
  facets,
  q,
  onToggle,
}: {
  label: string;
  defs: readonly Facet[];
  facets: Loaded<RequestFacets>;
  q: ObsQuery;
  onToggle: (f: Facet, value: string) => void;
}) {
  const quiet = { fontSize: 12.5, color: 'var(--text-tertiary)' } as const;
  return (
    <div role="group" aria-label={label} style={{ padding: '4px 2px', display: 'grid', gap: 14, alignContent: 'start' }}>
      {facets === null ? (
        <span style={quiet}>Counting…</span>
      ) : isError(facets) ? (
        <span style={quiet}>{facets.error}</span>
      ) : (
        defs.map((f) => {
          const listed = facets.facets[f.key] ?? [];
          const ticked = selectedIn(q, f);
          const extra = ticked.filter((v) => !listed.some((x) => String(x.value) === v)).map((v) => ({ value: v, count: null as number | null }));
          const rows = [...listed.map((x) => ({ value: String(x.value), count: x.count as number | null })), ...extra];
          if (rows.length === 0) {
            // A problem code is the facet a reader comes looking for, so its absence is said
            // rather than left as a missing heading: the requests in this window carried none.
            if (f.key !== 'problemCode') return null;
            return (
              <div key={f.key} style={{ display: 'grid', gap: 2 }}>
                <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--text-tertiary)', marginBottom: 2 }}>{f.label}</div>
                <span style={quiet}>None in this window</span>
              </div>
            );
          }
          return (
            <div key={f.key} style={{ display: 'grid', gap: 2 }}>
              <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--text-tertiary)', marginBottom: 2 }}>{f.label}</div>
              {rows.map((r) => {
                const on = ticked.includes(r.value);
                return (
                  <button
                    key={r.value}
                    type="button"
                    role="checkbox"
                    aria-checked={on}
                    onClick={() => onToggle(f, r.value)}
                    style={{ display: 'grid', gridTemplateColumns: '12px minmax(0,1fr) auto', alignItems: 'center', gap: 8, height: 26, border: 0, padding: 0, background: 'transparent', font: 'inherit', textAlign: 'left', cursor: 'pointer' }}
                  >
                    <span aria-hidden style={{ width: 12, height: 12, borderRadius: 3, boxSizing: 'border-box', border: `1px solid ${on ? 'var(--brand-500)' : 'var(--border-strong)'}`, background: on ? 'var(--brand-500)' : 'transparent' }} />
                    <span
                      style={{
                        fontSize: 12.5,
                        fontFamily: f.mono ? 'var(--font-mono)' : undefined,
                        color: f.key === 'problemCode' ? 'var(--status-danger-fg)' : 'var(--text-primary)',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                      title={r.value}
                    >
                      {facetValueLabel(f.key, r.value)}
                    </span>
                    <span style={{ fontSize: 11.5, fontFamily: 'var(--font-mono)', color: 'var(--text-tertiary)' }}>{r.count === null ? '—' : r.count.toLocaleString('en-US')}</span>
                  </button>
                );
              })}
            </div>
          );
        })
      )}
    </div>
  );
}

const ROW_GRID = '96px minmax(0,1.4fr) 110px minmax(0,1fr) 150px 48px 56px';

/** #2762: what the Lines column counts, said where a reader hovers. */
const LINES_TITLE = 'ctx.log lines under the request’s id, including the inline consumer tail; not console.log';

/**
 * The requests, newest first. A row opens the request slide-over (#1752 §7a): the request,
 * its lines and events on a time axis, what it set off and the move it made. The design's
 * span waterfall is the one part it cannot draw yet (#1237).
 */
function RequestList({
  rows,
  total,
  onOpenCall,
}: {
  rows: Loaded<RequestRecord[]>;
  total: number | null;
  onOpenCall: (invocationId: string, atMs: number) => void;
}) {
  const quiet = { padding: 16, fontSize: 13, color: 'var(--text-tertiary)' } as const;
  if (rows === null) return <div style={quiet}>Loading requests…</div>;
  if (isError(rows)) return <div style={quiet}>{rows.error}</div>;
  if (rows.length === 0) {
    return (
      <div style={quiet}>
        No requests match. Requests appear here once the app is served by a version deployed after per-request records began; an older version's requests are counted above but carry no operation to filter on.
      </div>
    );
  }
  const slowest = Math.max(1, ...rows.map((r) => r.durationMs ?? 0));
  const head = { fontSize: 11, fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--text-tertiary)' } as const;
  return (
    <div style={{ minWidth: 0 }}>
      <div style={{ display: 'grid', gridTemplateColumns: ROW_GRID, gap: 10, padding: '8px 16px', borderBottom: '1px solid var(--border-subtle)', ...head }}>
        <span>Time</span>
        <span>Operation</span>
        <span>Who</span>
        <span>Duration</span>
        <span>Result</span>
        <span style={{ textAlign: 'right' }} title={LINES_TITLE}>Lines</span>
        <span style={{ textAlign: 'right' }} title="Events the request emitted">Events</span>
      </div>
      {rows.map((r, i) => {
        const result = resultLabel(r);
        const tone = result.tone === 'error' ? 'var(--status-danger-fg)' : result.tone === 'warn' ? 'var(--status-warning-fg)' : 'var(--text-secondary)';
        const slow = (r.durationMs ?? 0) > 800;
        const label = rowLabel(r);
        return (
          <button
            key={r.invocationId ?? `row-${i}`}
            type="button"
            disabled={!r.invocationId}
            onClick={() => r.invocationId && onOpenCall(r.invocationId, r.timestamp ?? Date.now())}
            title={r.invocationId ? 'Open this request' : 'This request carries no invocation id'}
            style={{ display: 'grid', gridTemplateColumns: ROW_GRID, gap: 10, alignItems: 'center', width: '100%', height: 32, padding: '0 16px', border: 0, borderBottom: '1px solid var(--border-subtle)', background: 'transparent', font: 'inherit', fontSize: 12.5, textAlign: 'left', cursor: r.invocationId ? 'pointer' : 'default' }}
          >
            <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-secondary)' }}>{lineTime(r.timestamp).slice(0, 8)}</span>
            <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={label}>
              {label}
            </span>
            <span style={{ color: 'var(--text-secondary)' }}>{r.principalKind ? principalKindLabel(r.principalKind) : '—'}</span>
            <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span aria-hidden style={{ flex: 1, height: 4, borderRadius: 2, background: 'var(--surface-inset)', overflow: 'hidden' }}>
                <span style={{ display: 'block', height: '100%', width: `${((r.durationMs ?? 0) / slowest) * 100}%`, background: result.tone === 'error' ? 'var(--status-danger-fg)' : slow ? 'var(--status-warning-fg)' : 'var(--border-strong)' }} />
              </span>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11.5, color: 'var(--text-secondary)', minWidth: 44, textAlign: 'right' }}>{durationLabel(r.durationMs)}</span>
            </span>
            <span style={{ fontFamily: 'var(--font-mono)', color: tone, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{result.text}</span>
            <span style={{ fontFamily: 'var(--font-mono)', fontVariantNumeric: 'tabular-nums', color: 'var(--text-tertiary)', textAlign: 'right', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={r.logLines == null ? LINES_TITLE : `${r.logLines.toLocaleString('en-US')} — ${LINES_TITLE}`}>
              {r.logLines == null ? '—' : r.logLines >= 10_000 ? `${Math.floor(r.logLines / 1000)}k` : r.logLines}
            </span>
            <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-tertiary)', textAlign: 'right' }} title={r.eventTypes.join(', ') || undefined}>
              {r.eventCount === null ? '—' : r.eventCount}
            </span>
          </button>
        );
      })}
      <div style={{ padding: '10px 16px', fontSize: 12, color: 'var(--text-tertiary)' }}>
        Showing the latest <span style={{ fontFamily: 'var(--font-mono)' }}>{rows.length}</span>
        {total !== null && (
          <>
            {' '}
            of <span style={{ fontFamily: 'var(--font-mono)' }}>{total.toLocaleString('en-US')}</span>
          </>
        )}{' '}
        requests in this window · a row opens the request
      </div>
    </div>
  );
}

/**
 * Find one request by the id the caller was given (#2192): the `x-substrat-request-id` of a
 * response, or the `requestId` in an error body. Accepts it as pasted — any case, with
 * whitespace, after `req=`, or inside a dashboard link — and opens it in this app. The id
 * carries its own instant, so no window has to be guessed.
 */
function FindRequest({ onOpenCall }: { onOpenCall: (invocationId: string, atMs: number) => void }) {
  const [text, setText] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (text.trim() === '') return setProblem(null);
    const id = parseRequestId(text);
    const found = id ? requestLookup(id) : null;
    if (!id || !found) return setProblem('That is not a request id. A request id is 26 characters, as in the x-substrat-request-id header.');
    setProblem(null);
    onOpenCall(id, found.atMs);
  };
  return (
    <form onSubmit={submit} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 16px', flexWrap: 'wrap' }}>
      <input
        type="search"
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setProblem(null);
        }}
        placeholder="Find a request by id"
        aria-label="Find a request by id"
        spellCheck={false}
        style={{ width: 340, maxWidth: '100%', fontFamily: 'var(--font-mono)', fontSize: 13, padding: '6px 10px', border: '1px solid var(--border-default)', borderRadius: 6, background: 'var(--surface-card)', color: 'var(--text-primary)' }}
      />
      <button type="submit" style={{ fontSize: 13, padding: '6px 12px' }}>Open</button>
      {problem && <span role="alert" style={{ fontSize: 12.5, color: 'var(--status-danger-fg)' }}>{problem}</span>}
    </form>
  );
}
