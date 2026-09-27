import { useEffect, useRef, useState, type PointerEvent } from 'react';
import { api, ApiError, type RequestFacets, type RequestRecord, type RequestVolume } from '../lib/api';
import { DEV_MOCK } from '../lib/mock';
import { mockRequestFacets, mockRequestVolume, mockRequests } from '../lib/mock-requests';
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
  resultLabel,
  selected,
  toggleFacet,
  whereOf,
  type RequestFacetKey,
} from '../lib/requests';
import { lineTime } from '../components/LogList';

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
 * The histogram and the facets live in this mode rather than above the stream, as the
 * design draws them, because only requests carry the business fields yet: a log line
 * cannot be narrowed by operation until module log lines inherit them (`ctx.log`, #1746
 * step 4). Drawing them over the Lines mode would offer filters the lines do not obey.
 */

/** How many buckets the histogram asks for — the design's 90. Zooming keeps the count. */
const BUCKETS = 90;
/** How many requests the list shows. */
const LIST_LIMIT = 100;
const HIST_HEIGHT = 110;

type Loaded<T> = T | null | { error: string };
const isError = (v: unknown): v is { error: string } => typeof v === 'object' && v !== null && 'error' in v;

/** Why a read failed, in the page's words: 501 is "not on this platform", never an outage. */
function failure(e: unknown): { error: string } {
  if (e instanceof ApiError && e.status === 501) return { error: 'Request counts are not available on this platform yet.' };
  if (e instanceof ApiError) return { error: `Requests could not be read (${e.status}): ${e.message}` };
  return { error: 'Requests could not be read right now.' };
}

export function RequestsMode({
  scopeId,
  q,
  hours,
  cursor,
  window,
  nonce,
  onFilters,
  onRange,
  onOpenCall,
}: {
  scopeId: string;
  q: ObsQuery;
  hours: number;
  /** The page's custom window, when there is one. The reads use it in place of `hours`. */
  cursor: { from: string; to: string } | null;
  /** The window the page is showing — the cursor's, or the range's own bounds. */
  window: { from: string; to: string };
  nonce: number;
  onFilters: (patch: Partial<ObsQuery>) => void;
  /** A brushed range — the page's new window. */
  onRange: (w: { from: string; to: string }) => void;
  /** Open one request's own log lines. */
  onOpenCall: (invocationId: string) => void;
}) {
  const [volume, setVolume] = useState<Loaded<RequestVolume>>(null);
  const [facets, setFacets] = useState<Loaded<RequestFacets>>(null);
  const [rows, setRows] = useState<Loaded<RequestRecord[]>>(null);
  const where = whereOf(q);
  const whereKey = JSON.stringify(where);
  const span = { from: Date.parse(window.from), to: Date.parse(window.to) };

  useEffect(() => {
    let live = true;
    setVolume(null);
    setFacets(null);
    setRows(null);
    const readWindow = cursor ? { since: cursor.from, until: cursor.to } : { hours };
    const settle = <T,>(set: (v: Loaded<T>) => void, read: () => Promise<T>) =>
      read().then(
        (v) => live && set(v),
        (e: unknown) => live && set(failure(e)),
      );
    if (DEV_MOCK) {
      setVolume(mockRequestVolume(where, span, BUCKETS));
      setFacets(mockRequestFacets(where, span));
      setRows(mockRequests(where, span, LIST_LIMIT));
    } else {
      void settle(setVolume, () => api.appRequestVolume(scopeId, requestReadQuery(q, readWindow, { buckets: BUCKETS })));
      void settle(setFacets, () => api.appRequestFacets(scopeId, requestReadQuery(q, readWindow)));
      void settle(setRows, () => api.appRequests(scopeId, requestReadQuery(q, readWindow, { limit: LIST_LIMIT })));
    }
    return () => {
      live = false;
    };
    // `whereKey` stands for `where`/`q`'s facet keys; the window is its two instants.
  }, [scopeId, whereKey, hours, cursor?.from, cursor?.to, window.from, window.to, nonce]);

  const levelSel = selected(q, 'level');
  return (
    <div>
      <Histogram
        volume={volume}
        span={span}
        window={window}
        levels={levelSel}
        onLevel={(level) => onFilters(toggleFacet(q, 'level', level))}
        onRange={onRange}
      />
      <div style={{ display: 'grid', gridTemplateColumns: '232px minmax(0,1fr)', borderTop: '1px solid var(--border-subtle)' }}>
        <FacetSidebar facets={facets} q={q} onToggle={(key, value) => onFilters(toggleFacet(q, key, value))} />
        <RequestList rows={rows} total={isError(facets) || facets === null ? null : facets.total} onOpenCall={onOpenCall} />
      </div>
    </div>
  );
}

const LEVELS = ['unrecorded', 'info', 'warn', 'error'] as const;

/**
 * The level histogram: one stacked bar per bucket, drawn at its own instant on the
 * window's time axis. Dragging across it narrows the page's window (the reads re-bucket at
 * the same count, so the bars get finer); hovering names a bucket's counts. A level in the
 * legend toggles that level's filter.
 */
function Histogram({
  volume,
  span,
  window,
  levels,
  onLevel,
  onRange,
}: {
  volume: Loaded<RequestVolume>;
  span: { from: number; to: number };
  window: { from: string; to: string };
  levels: string[];
  onLevel: (level: string) => void;
  onRange: (w: { from: string; to: string }) => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; left: number; width: number; pointer: number } | null>(null);
  const [selection, setSelection] = useState<{ a: number; b: number } | null>(null);
  const [hover, setHover] = useState<number | null>(null);
  const quiet = { padding: '14px 16px', fontSize: 13, color: 'var(--text-tertiary)' } as const;

  if (volume === null) return <div style={quiet}>Counting requests…</div>;
  if (isError(volume)) return <div style={quiet}>{volume.error}</div>;

  const totals = { info: 0, warn: 0, error: 0, unrecorded: 0 };
  for (const b of volume.buckets) for (const l of LEVELS) totals[l] += b[l];
  const all = totals.info + totals.warn + totals.error + totals.unrecorded;
  const peak = Math.max(1, ...volume.buckets.map((b) => b.info + b.warn + b.error + b.unrecorded));
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
  const summary = `${all.toLocaleString('en-US')} requests: ${totals.error} errors, ${totals.warn} warnings, ${totals.info} info${totals.unrecorded ? `, ${totals.unrecorded} with no level recorded` : ''}.`;
  return (
    <div style={{ padding: '12px 16px 10px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap', marginBottom: 8, fontSize: 12.5 }}>
        <span style={{ color: 'var(--text-primary)', fontWeight: 600 }}>
          <span style={{ fontFamily: 'var(--font-mono)' }}>{all.toLocaleString('en-US')}</span> requests
        </span>
        <span style={{ color: 'var(--text-tertiary)' }}>
          {bucketWidthLabel(volume.bucketMs)} buckets · drag to zoom
          {volume.estimated && ' · estimated from a sample'}
        </span>
        <span style={{ flex: 1 }} />
        {LEVELS.map((l) =>
          l === 'unrecorded' && totals.unrecorded === 0 ? null : (
            <button
              key={l}
              type="button"
              // "Not recorded" cannot be a filter: it is the absence of the field.
              disabled={l === 'unrecorded'}
              aria-pressed={l === 'unrecorded' ? undefined : levels.includes(l)}
              title={l === 'unrecorded' ? 'Requests served by a version deployed before per-request levels were recorded' : `Show only ${l} requests`}
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
              {LEVELS.map((l) => {
                const h = (b[l] / peak) * 100;
                const seg = h > 0 ? <span key={l} style={{ position: 'absolute', left: 0, right: 0, bottom: `${bottom}%`, height: `${h}%`, background: LEVEL_COLORS[l], borderRadius: 1 }} /> : null;
                bottom += h;
                return seg;
              })}
            </div>
          );
        })}
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
      <div aria-live="polite" style={{ minHeight: 18, marginTop: 6, fontSize: 12, color: 'var(--text-tertiary)', display: 'flex', gap: 10 }}>
        <span style={{ fontFamily: 'var(--font-mono)' }}>{axisLabel(span.from, width)}</span>
        <span style={{ flex: 1, textAlign: 'center' }}>
          {hovered && (
            <>
              <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-primary)' }}>
                {lineTime(Date.parse(hovered.start)).slice(0, 8)}–{lineTime(Date.parse(hovered.start) + volume.bucketMs).slice(0, 8)} UTC
              </span>{' '}
              · {hovered.error} errors · {hovered.warn} warnings · {hovered.info} info
              {hovered.unrecorded > 0 && ` · ${hovered.unrecorded} not recorded`}
            </>
          )}
        </span>
        <span style={{ fontFamily: 'var(--font-mono)' }}>{axisLabel(span.to, width)} UTC</span>
      </div>
    </div>
  );
}

/**
 * The facet sidebar. Each facet's counts are what ticking one of its values would give,
 * because the plane counts a facet with every OTHER filter applied. A ticked value that
 * fell out of the top ten is still listed, so it can be unticked where it was ticked.
 */
function FacetSidebar({
  facets,
  q,
  onToggle,
}: {
  facets: Loaded<RequestFacets>;
  q: ObsQuery;
  onToggle: (key: RequestFacetKey, value: string) => void;
}) {
  const quiet = { fontSize: 12.5, color: 'var(--text-tertiary)' } as const;
  return (
    <div role="group" aria-label="Request filters" style={{ padding: '12px 14px', borderRight: '1px solid var(--border-subtle)', display: 'grid', gap: 14, alignContent: 'start' }}>
      {facets === null ? (
        <span style={quiet}>Counting…</span>
      ) : isError(facets) ? (
        <span style={quiet}>{facets.error}</span>
      ) : (
        REQUEST_FACETS.map((f) => {
          const listed = facets.facets[f.key] ?? [];
          const ticked = selected(q, f.key);
          const extra = ticked.filter((v) => !listed.some((x) => String(x.value) === v)).map((v) => ({ value: v, count: null as number | null }));
          const rows = [...listed.map((x) => ({ value: String(x.value), count: x.count as number | null })), ...extra];
          if (rows.length === 0) return null;
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
                    onClick={() => onToggle(f.key, r.value)}
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

const ROW_GRID = '96px minmax(0,1.4fr) 110px minmax(0,1fr) 150px 56px';

/**
 * The requests, newest first. A row opens that request's own log lines — the Lines mode
 * narrowed to its invocation — which is the one detail view that exists today; the
 * design's slide-over waterfall waits on spans (#1237).
 */
function RequestList({
  rows,
  total,
  onOpenCall,
}: {
  rows: Loaded<RequestRecord[]>;
  total: number | null;
  onOpenCall: (invocationId: string) => void;
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
        <span style={{ textAlign: 'right' }} title="Events the request emitted">Events</span>
      </div>
      {rows.map((r, i) => {
        const result = resultLabel(r);
        const tone = result.tone === 'error' ? 'var(--status-danger-fg)' : result.tone === 'warn' ? 'var(--status-warning-fg)' : 'var(--text-secondary)';
        const slow = (r.durationMs ?? 0) > 800;
        const label = r.operation ?? (r.method && r.path ? `${r.method} ${r.path}` : '—');
        return (
          <button
            key={r.invocationId ?? `row-${i}`}
            type="button"
            disabled={!r.invocationId}
            onClick={() => r.invocationId && onOpenCall(r.invocationId)}
            title={r.invocationId ? 'Open this request’s log lines' : 'This request carries no invocation id'}
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
        requests in this window · a row opens its log lines
      </div>
    </div>
  );
}
