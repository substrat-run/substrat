import type { KeyboardEvent } from 'react';
import type { AppOverlays, OverlayMarker, ReleaseMarker, TrafficBucket } from '../lib/api';

/**
 * The palette a multi-line chart cycles (#1447) — the three layer accents the dashboard
 * already draws itself in, then the brand and the tertiary text colour. No new tokens: a
 * chart that invented its own colours would be the one place in the product where a
 * colour means nothing.
 */
const LINE_COLORS = [
  'var(--layer-vertical)',
  'var(--layer-engine)',
  'var(--layer-kernel)',
  'var(--brand-500)',
  'var(--text-tertiary)',
];

/** How many lines the legend names before it stops and counts the rest. */
const LEGEND_CAP = 8;

/**
 * How each overlay kind draws and reads (#1447 step 3b). One table, so the glyph, the
 * legend swatch and the text alternative cannot drift apart — and so shape carries the
 * meaning as well as colour, which is what keeps the three distinguishable for a reader
 * who cannot separate them by hue.
 */
const OVERLAY_KINDS = {
  migration: { color: 'var(--text-tertiary)', filled: false, round: true, noun: 'migration' },
  'run-failed': { color: 'var(--status-warning-fg)', filled: true, round: false, noun: 'failed schedule run' },
  failure: { color: 'var(--status-danger-fg)', filled: true, round: true, noun: 'recorded failure' },
} as const;

/** How many glyphs one bucket stacks before the row counts the rest. */
const STACK_CAP = 3;
/**
 * The side of each glyph's hit target, in px — and therefore the glyph row's pitch. The
 * painted glyph is ~6px, which is a fine mark and a hopeless control: WCAG 2.5.8 wants
 * 24×24 CSS px for a pointer target, and two stacked glyphs 9px apart could not each
 * have one. So each glyph sits on an invisible 24×24 pad, and the rows are spaced by
 * the pad rather than the mark, which is what keeps one bucket's stack from overlapping
 * itself. Two ADJACENT buckets can still crowd on a dense window — a time axis puts the
 * glyph where the instant is, and that is the one presentation that cannot move — which
 * is why every glyph is also reachable by keyboard, and why each kind's sub-view lists
 * the same facts as rows.
 */
const HIT = 24;

/**
 * Traffic over time with the deploys drawn on it (#1236) — hand-rolled SVG
 * rather than a charting dependency: the shape is bars plus vertical rules, and
 * a library would be more bytes than the drawing.
 *
 * The reading rules this encodes, because a chart is where an honest record
 * most easily becomes a dishonest picture:
 *
 * - **Each bar stacks by HTTP status class** (#1693) when the bucket carries the
 *   split: green (2xx + 3xx) at the base, yellow (4xx — a client got a no, not
 *   necessarily an alarm) above it, red (5xx) on top. A bucket missing the split
 *   (an older plane, or the script-grain source that cannot carry it) falls back
 *   to a single bar with the red 5xx count drawn inside it, as before.
 * - **A zero bucket is a visible baseline tick**, never a gap — the series is
 *   already zero-filled worker-side, and skipping empties would let neighbours
 *   join and hide an outage as a narrower peak.
 * - **A marker with no traffic still draws.** Markers are registry facts; a push
 *   that produced nothing is the most interesting push on the chart.
 *
 * With `lines` it draws one requests polyline per app instead of the bars — the
 * team page's all-apps mode (#1447). Errors are deliberately not drawn there: ten
 * overlaid error areas are unreadable, and the row under the chart carries each
 * app's error rate as a number. Every line shares this axis, which is what makes
 * the comparison legitimate, so `buckets` still supplies the grid.
 *
 * With `overlays` it also draws the declared facts that explain the shape (#1447 step
 * 3b): a shaded span for a stale freshness window, a glyph per migration, failed
 * schedule run and recorded failure. Two rules keep them apart from the release
 * markers: the glyphs sit in a row at the BASELINE rather than crossing the plot — a
 * full-height rule means "the code changed here", and nothing else may borrow it — and
 * a glyph is clickable where a release marker is not, because each one has a sub-view
 * that explains it.
 *
 * With `onBucket` the time axis becomes a cursor (#1447 step 3c): a bar already IS a span
 * of time, so clicking one asks "what was happening then". Bars only — a line chart has
 * no bar to aim at, and several apps' lines share every x, so a click there would have to
 * pick a series on the reader's behalf. `cursor` draws the window a click produced, which
 * is what keeps the chart and the narrowed panels below it one screen rather than two.
 */
export function TrafficChart({
  buckets,
  plotWindow, onInspect,
  markers,
  bucketMinutes,
  height = 96,
  lines,
  overlays,
  onMarker,
  onBucket,
  cursor,
}: {
  buckets: TrafficBucket[];
  plotWindow?: { since: string; until: string };
  onInspect?: (index: number | null) => void;
  markers: ReleaseMarker[];
  /** The series' bucket width — the unit the x axis is drawn in. */
  bucketMinutes: number;
  height?: number;
  /** One line per app. Absent ⇒ the single-series bar chart, unchanged. Every line's
   *  buckets must share `buckets`' grid — the worker zero-fills them onto one. */
  lines?: Array<{ label: string; buckets: TrafficBucket[] }>;
  /** The declared facts drawn over the series. Absent ⇒ the chart is exactly as it was. */
  overlays?: AppOverlays;
  /** What a glyph opens. Absent ⇒ the glyphs are drawn but inert, and are not announced
   *  as buttons — a control that does nothing is worse than no control. */
  onMarker?: (marker: OverlayMarker) => void;
  /** What a bar opens, given its start and the width it covers. Absent ⇒ the bars are
   *  drawn exactly as before and are not announced as buttons, for the same reason. */
  onBucket?: (start: string, bucketMinutes: number) => void;
  /** The window the page is currently narrowed to, drawn over the plot. */
  cursor?: { from: string; to: string };
}) {
  if (buckets.length === 0) return null;

  // A viewBox in bucket units: the SVG scales to its container, so the chart is
  // responsive without measuring anything.
  const firstStart = Date.parse(buckets[0]!.start);
  const offset = plotWindow ? (Date.parse(plotWindow.since) - firstStart) / (bucketMinutes * 60_000) : 0;
  const W = plotWindow ? (Date.parse(plotWindow.until) - Date.parse(plotWindow.since)) / (bucketMinutes * 60_000) : buckets.length;
  const H = 100;
  const peak = Math.max(
    1,
    ...(lines ? lines.flatMap((l) => l.buckets.map((b) => b.requests)) : buckets.map((b) => b.requests)),
  );
  const first = Date.parse(buckets[0]!.start);
  // One bucket IS one x unit, so elapsed-over-width converts an instant straight
  // into the axis. Scaling by the span between the first and LAST bucket's starts
  // instead would be short by one bucket: the last bar occupies [W-1, W], so its
  // start would land on the right edge and anything later in that bucket — the
  // common case, since the newest bucket is the one still filling — would be drawn
  // outside the viewBox entirely.
  const widthMs = Math.max(1, bucketMinutes * 60_000);
  const xOf = (iso: string): number => Math.min(offset + W, Math.max(offset, (Date.parse(iso) - first) / widthMs));

  const fmt = (iso: string) =>
    new Date(iso).toISOString().replace('T', ' ').replace('.000Z', ' UTC');

  const shownLines = lines?.slice(0, LEGEND_CAP) ?? [];
  const hiddenLines = (lines?.length ?? 0) - shownLines.length;

  // The legend beneath a stacked bar chart (#1693): the same three counts the tooltip
  // gives per bucket, totalled over the window. Only drawn in bar mode (`lines` draws
  // no error/class series at all — see the module doc) and only when every bucket
  // carries the split, which `fillGrid` guarantees is all-or-nothing for one series.
  const classTotals = !lines && buckets.every((b) => b.green !== undefined && b.yellow !== undefined)
    ? buckets.reduce(
        (acc, b) => ({ green: acc.green + (b.green ?? 0), yellow: acc.yellow + (b.yellow ?? 0), red: acc.red + b.errors }),
        { green: 0, yellow: 0, red: 0 },
      )
    : null;

  const overlayMarkers = overlays?.markers ?? [];
  const overlaySpans = overlays?.spans ?? [];
  // Stacked per bucket so a burst reads as a burst: a dozen failures inside one hour
  // land on the same x, and drawn flat they would be one dot claiming one failure.
  const stacks = new Map<number, OverlayMarker[]>();
  for (const m of overlayMarkers) {
    const slot = Math.min(W - 1, Math.floor(xOf(m.at)));
    stacks.set(slot, [...(stacks.get(slot) ?? []), m]);
  }
  const stackRows = Math.max(0, ...[...stacks.values()].map((s) => Math.min(s.length, STACK_CAP)));
  const anyCounted = [...stacks.values()].some((s) => s.length > STACK_CAP);
  const counts = { migration: 0, 'run-failed': 0, failure: 0 };
  for (const m of overlayMarkers) counts[m.kind] += 1;
  const present = (Object.keys(OVERLAY_KINDS) as Array<keyof typeof OVERLAY_KINDS>).filter((k) => counts[k] > 0);
  const overlayWords = [
    ...present.map((k) => `${counts[k]} ${OVERLAY_KINDS[k].noun}${counts[k] === 1 ? '' : 's'}`),
    ...(overlaySpans.length > 0 ? [`${overlaySpans.length} stale window${overlaySpans.length === 1 ? '' : 's'}`] : []),
  ];
  // The text alternative carries the overlays too — a reader who cannot see the glyphs
  // must still learn that something happened in this window, not just how busy it was.
  const overlayAria = overlayWords.length > 0 ? `. Overlays: ${overlayWords.join(', ')}` : '';

  /** A marker's x as a percentage of the plot's width — the release markers' own mapping,
   *  rescaled because the glyph layer is drawn in px rather than bucket units. */
  const pctOf = (iso: string): string => `${((xOf(iso) - offset) / W) * 100}%`;

  return (
    <div style={{ display: 'grid', gap: 6 }}>
      <svg
        data-traffic-plot
        viewBox={`${offset} 0 ${W} ${H}`}
        preserveAspectRatio="none"
        style={{ width: '100%', height, display: 'block', overflow: 'hidden', touchAction: 'none', userSelect: 'none' }}
        role="group"
        aria-label={
          (lines
            ? `Requests over ${buckets.length} buckets, one line for each of ${lines.length} apps`
            : `Traffic over ${buckets.length} buckets with ${markers.length} deploy markers`) + overlayAria
        }
      >
        {/* Spans first, so the shading sits BEHIND the traffic: a stale freshness window
            is context for the bars, and drawn over them it would tint the data itself. */}
        {overlaySpans.map((s) => (
          <rect
            key={`${s.kind}:${s.from}:${s.label}`}
            x={xOf(s.from)}
            width={Math.max(xOf(s.to) - xOf(s.from), 0.05)}
            y={0}
            height={H}
            fill="var(--status-warning-fg, #b45309)"
            opacity={0.12}
          >
            <title>{`${s.label} stale ${fmt(s.from)}–${fmt(s.to)}`}</title>
          </rect>
        ))}
        {/* The cursor sits ABOVE the stale shading and BELOW the traffic: it is the
            reader's own selection, so it must win over the other context drawn behind the
            bars, and it must still not tint the data it is selecting. Same x mapping as
            the markers, so the highlight lands under the instant it names. A window
            narrower than a hair still gets a visible sliver — a five-minute cursor on a
            three-day axis is otherwise nothing at all. */}
        {cursor && (
          <rect
            x={xOf(cursor.from)}
            width={Math.max(xOf(cursor.to) - xOf(cursor.from), 0.08)}
            y={0}
            height={H}
            fill="var(--brand-500, #6366f1)"
            opacity={0.15}
          >
            <title>{`Showing ${fmt(cursor.from)}–${fmt(cursor.to)}`}</title>
          </rect>
        )}
        {lines
          ? lines.map((line, i) => (
              // Plotted at the bucket's MIDPOINT: a bar owns the span [i, i+1], so a
              // vertex on its left edge would draw every line half a bucket early.
              <polyline
                key={`${line.label}:${i}`}
                points={line.buckets
                  .map((b, x) => `${x + 0.5},${H - (b.requests / peak) * (H - 2)}`)
                  .join(' ')}
                fill="none"
                stroke={LINE_COLORS[i % LINE_COLORS.length]!}
                strokeWidth={1.5}
                strokeLinejoin="round"
                vectorEffect="non-scaling-stroke"
              >
                <title>{line.label}</title>
              </polyline>
            ))
          : buckets.map((b, i) => {
              const total = (b.requests / peak) * (H - 2);
              const classes = b.green !== undefined && b.yellow !== undefined ? { green: b.green, yellow: b.yellow } : null;
              const label = classes
                ? `${fmt(b.start)} — ${b.requests.toLocaleString()} req, ${classes.green.toLocaleString()} 2xx/3xx, ${classes.yellow.toLocaleString()} 4xx, ${b.errors.toLocaleString()} 5xx`
                : `${fmt(b.start)} — ${b.requests.toLocaleString()} req, ${b.errors.toLocaleString()} err`;
              // Stacked bottom-up: green (no complaint), yellow (a no), red (5xx) on top —
              // so the eye reads severity climbing toward the top of the bar. A class with
              // nothing in it draws no segment at all (#1693 acceptance).
              const segments =
                classes && b.requests > 0
                  ? [
                      { count: classes.green, color: 'var(--status-success-fg, #16a34a)' },
                      { count: classes.yellow, color: 'var(--status-warning-fg, #b45309)' },
                      { count: b.errors, color: 'var(--status-danger-fg, #dc2626)' },
                    ]
                  : null;
              const errs = b.requests === 0 ? 0 : (b.errors / peak) * (H - 2);
              return (
                <g
                  key={b.start}
                  {...(onBucket
                    ? {
                        role: 'button',
                        tabIndex: 0,
                        'aria-label': `Show ${label}`,
                        style: { cursor: 'pointer' },
                        onFocus: () => onInspect?.(i),
                        onBlur: () => onInspect?.(null),
                        onClick: () => onBucket(b.start, bucketMinutes),
                        onKeyDown: (e: KeyboardEvent<SVGGElement>) => {
                          if (e.key !== 'Enter' && e.key !== ' ') return;
                          e.preventDefault();
                          onBucket(b.start, bucketMinutes);
                        },
                      }
                    : {})}
                >
                  {/* The hit area is the whole column, not the bar: a quiet bucket draws a
                      0.6-unit tick, and asking a reader to hit that is asking them not to
                      use the cursor on exactly the buckets an outage produces. */}
                  {onBucket && <rect x={i} y={0} width={1} height={H} fill="transparent" />}
                  {segments ? (
                    (() => {
                      let yCursor = H;
                      return segments.map((s) => {
                        const h = (s.count / peak) * (H - 2);
                        if (h <= 0) return null;
                        const rect = (
                          <rect key={s.color} x={i + 0.1} y={yCursor - h} width={0.8} height={h} fill={s.color} opacity={0.85} />
                        );
                        yCursor -= h;
                        return rect;
                      });
                    })()
                  ) : (
                    <>
                      {/* The baseline tick keeps an empty bucket visible as a bucket. */}
                      <rect
                        x={i + 0.1}
                        y={H - Math.max(total, 0.6)}
                        width={0.8}
                        height={Math.max(total, 0.6)}
                        fill="var(--brand-500, #6366f1)"
                        opacity={0.55}
                      />
                      {errs > 0 && (
                        <rect x={i + 0.1} y={H - errs} width={0.8} height={errs} fill="var(--status-danger-fg, #dc2626)" opacity={0.9} />
                      )}
                    </>
                  )}
                  <title>{label}</title>
                </g>
              );
            })}
        {lines && onBucket && buckets.map((b, i) => <rect key={b.start} x={i} y={0} width={1} height={H} fill="transparent" role="button" tabIndex={0} aria-label={`Inspect ${fmt(b.start)}`} onFocus={() => onInspect?.(i)} onBlur={() => onInspect?.(null)} onClick={() => onBucket(b.start, bucketMinutes)} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onBucket(b.start, bucketMinutes); } }} />)}
        {markers.map((m) => (
          <line
            key={`${m.kind}:${m.versionId}:${m.at}`}
            x1={xOf(m.at)}
            x2={xOf(m.at)}
            y1={0}
            y2={H}
            stroke={m.kind === 'went-live' ? 'var(--status-success-fg, #16a34a)' : 'var(--text-tertiary, #6b7280)'}
            strokeWidth={0.12}
            strokeDasharray={m.kind === 'pushed' ? '1 1' : undefined}
            vectorEffect="non-scaling-stroke"
          >
            <title>{`${m.version} ${m.kind === 'went-live' ? 'promoted to prod' : 'version registered'} — ${fmt(m.at)}`}</title>
          </line>
        ))}
      </svg>
      {/* The glyph row is its OWN svg, in px and with no viewBox, because the chart above
          is scaled non-uniformly (`preserveAspectRatio="none"`): a circle drawn in bucket
          units would arrive as a flat ellipse whose width depends on the container. The
          x mapping is the same one — as a percentage of the plot — so a glyph sits under
          the instant it names. */}
      {overlayMarkers.length > 0 && (
        <svg
          width="100%"
          height={stackRows * HIT + (anyCounted ? 12 : 0)}
          role="group"
          aria-label={`Overlay markers: ${overlayWords.join(', ')}`}
          style={{ display: 'block', overflow: 'visible', marginTop: -2 }}
        >
          {[...stacks.entries()].map(([slot, group]) => (
            <g key={slot}>
              {group.slice(0, STACK_CAP).map((m, row) => {
                const kind = OVERLAY_KINDS[m.kind];
                const y = row * HIT + HIT / 2;
                const title = [m.label, m.detail, fmt(m.at)].filter(Boolean).join(' — ');
                const glyph = kind.round ? (
                  <circle
                    cx={pctOf(m.at)}
                    cy={y}
                    r={3.2}
                    fill={kind.filled ? kind.color : 'none'}
                    stroke={kind.color}
                    strokeWidth={1.2}
                  />
                ) : (
                  // The percentage resolves against the viewport first; the translate then
                  // centres the square on it, which no single attribute can express.
                  <rect x={pctOf(m.at)} y={y - 3} width={6} height={6} fill={kind.color} transform="translate(-3,0)" />
                );
                return (
                  <g
                    key={`${m.kind}:${m.at}:${m.label}`}
                    {...(onMarker
                      ? {
                          role: 'button',
                          'aria-label': title,
                          tabIndex: 0,
                          style: { cursor: 'pointer' },
                          onClick: () => onMarker(m),
                          onKeyDown: (e: KeyboardEvent<SVGGElement>) => {
                            if (e.key !== 'Enter' && e.key !== ' ') return;
                            e.preventDefault();
                            onMarker(m);
                          },
                        }
                      : {})}
                  >
                    {/* The pad: painted nothing, but it is what the pointer hits. First
                        in the group so the mark draws over it; `fill="transparent"`
                        rather than `none`, because `none` is not hit-tested. */}
                    <rect
                      x={pctOf(m.at)}
                      y={y - HIT / 2}
                      width={HIT}
                      height={HIT}
                      fill="transparent"
                      transform={`translate(${-HIT / 2},0)`}
                    />
                    {glyph}
                    <title>{title}</title>
                  </g>
                );
              })}
              {/* Counted, never dropped silently — the same rule the line legend follows. */}
              {group.length > STACK_CAP && (
                <text
                  x={pctOf(group[0]!.at)}
                  y={STACK_CAP * HIT + 9}
                  fontSize={9}
                  fill="var(--text-tertiary)"
                  textAnchor="middle"
                >
                  {`+${group.length - STACK_CAP}`}
                </text>
              )}
            </g>
          ))}
        </svg>
      )}
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', fontSize: 11, color: 'var(--text-tertiary)', fontFamily: 'var(--font-mono)' }}>
        <span>{fmt(plotWindow?.since ?? buckets[0]!.start)}</span>
        <span>{fmt(plotWindow?.until ?? buckets[buckets.length - 1]!.start)}</span>
      </div>
      {classTotals && (
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', fontSize: 11.5, color: 'var(--text-tertiary)' }}>
          <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
            <span aria-hidden style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--status-success-fg)', display: 'inline-block' }} />
            <span>{classTotals.green.toLocaleString()} 2xx/3xx</span>
          </span>
          <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
            <span aria-hidden style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--status-warning-fg)', display: 'inline-block' }} />
            <span>{classTotals.yellow.toLocaleString()} 4xx</span>
          </span>
          <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
            <span aria-hidden style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--status-danger-fg)', display: 'inline-block' }} />
            <span>{classTotals.red.toLocaleString()} 5xx</span>
          </span>
        </div>
      )}
      {lines && lines.length > 0 && (
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', fontSize: 11.5, color: 'var(--text-tertiary)' }}>
          {shownLines.map((line, i) => (
            <span key={`${line.label}:${i}`} style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
              <span aria-hidden style={{ width: 10, height: 2, background: LINE_COLORS[i % LINE_COLORS.length], display: 'inline-block' }} />
              <span>{line.label}</span>
            </span>
          ))}
          {/* Named, then counted. A legend that simply stopped would let a reader take the
              lines it names for all of them, and the extra lines are still drawn. */}
          {hiddenLines > 0 && <span>+{hiddenLines} more</span>}
        </div>
      )}
      {markers.length > 0 && (
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', fontSize: 11.5, color: 'var(--text-tertiary)' }}>
          {markers.slice(-6).map((m) => (
            <span key={`${m.kind}:${m.versionId}:${m.at}`} style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
              <span
                aria-hidden
                style={{
                  width: 8,
                  height: 2,
                  background: m.kind === 'went-live' ? 'var(--status-success-fg)' : 'var(--text-tertiary)',
                  display: 'inline-block',
                }}
              />
              <span style={{ fontFamily: 'var(--font-mono)' }}>{m.version}</span>
              <span>{m.kind === 'went-live' ? 'promoted to prod' : 'registered'}</span>
            </span>
          ))}
        </div>
      )}
      {/* Its own row, beneath the releases': a deploy line and an overlay glyph are
          different claims, and one legend mixing them would invite reading them as one
          series. Only the kinds actually on the chart are named. */}
      {overlayWords.length > 0 && (
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', fontSize: 11.5, color: 'var(--text-tertiary)' }}>
          {present.map((k) => (
            <span key={k} style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
              <span
                aria-hidden
                style={{
                  width: OVERLAY_KINDS[k].round ? 8 : 7,
                  height: OVERLAY_KINDS[k].round ? 8 : 7,
                  borderRadius: OVERLAY_KINDS[k].round ? '50%' : 0,
                  background: OVERLAY_KINDS[k].filled ? OVERLAY_KINDS[k].color : 'transparent',
                  border: OVERLAY_KINDS[k].filled ? 0 : `1.5px solid ${OVERLAY_KINDS[k].color}`,
                  display: 'inline-block',
                }}
              />
              <span>
                {counts[k]} {OVERLAY_KINDS[k].noun}
                {counts[k] === 1 ? '' : 's'}
              </span>
            </span>
          ))}
          {overlaySpans.length > 0 && (
            <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
              <span
                aria-hidden
                style={{ width: 14, height: 8, background: 'var(--status-warning-fg)', opacity: 0.25, display: 'inline-block' }}
              />
              <span>
                {overlaySpans.length} stale window{overlaySpans.length === 1 ? '' : 's'}
              </span>
            </span>
          )}
          {/* The cap admits itself. A chart that quietly drew 300 of 900 failures would
              be read as the whole record. */}
          {overlays?.truncated && <span>+ more markers not drawn</span>}
        </div>
      )}
    </div>
  );
}
