import type { TrafficSeries } from '../lib/api';

/**
 * A day of traffic as one small shape (#1447) — the Overview's glance, not the
 * Observability chart: no axis, no legend, no tooltips per bucket. `TrafficChart` is the
 * page you open when the shape is interesting; this is what makes it interesting.
 *
 * It shares that chart's two honesty rules and nothing else. Errors are drawn INSIDE the
 * request area, off the same baseline and the same scale, so a tall error band can never
 * read as more errors than requests. A plane that cannot bucket says so in words rather
 * than drawing a flat line, which would read as an app nobody used.
 */
export function Sparkline({ series }: { series: TrafficSeries }) {
  if (!series.available || series.buckets.length === 0) {
    return (
      <div style={{ fontSize: 12.5, color: 'var(--text-tertiary)' }}>
        Traffic over time is not available on this plane.
      </div>
    );
  }
  const buckets = series.buckets;
  // A viewBox in bucket units, stretched to the container — the same trick the full chart
  // uses to be responsive without measuring anything.
  const W = buckets.length;
  const H = 48;
  const peak = Math.max(1, ...buckets.map((b) => b.requests));
  const y = (v: number) => H - (v / peak) * (H - 2);
  // Plotted at each bucket's MIDPOINT, and closed down to the baseline at both ends, so
  // the fill is a band under the line rather than a wedge pulled to the corners.
  const path = (pick: (b: TrafficSeries['buckets'][number]) => number) =>
    `M0,${H} L${buckets.map((b, i) => `${i + 0.5},${y(pick(b))}`).join(' L')} L${W},${H} Z`;
  const first = Date.parse(buckets[0]!.start);
  const widthMs = Math.max(1, series.bucketMinutes * 60_000);
  const xOf = (iso: string) => Math.min(W, Math.max(0, (Date.parse(iso) - first) / widthMs));
  const requests = buckets.reduce((n, b) => n + b.requests, 0);
  const errors = buckets.reduce((n, b) => n + b.errors, 0);

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      style={{ width: '100%', height: H, display: 'block', overflow: 'visible' }}
      role="img"
    >
      <title>{`Requests over the last 24 hours — ${requests.toLocaleString()} req, ${errors.toLocaleString()} err, ${series.markers.length} deploys`}</title>
      <path d={path((b) => b.requests)} fill="var(--brand-500, #6366f1)" opacity={0.25} />
      {errors > 0 && <path d={path((b) => b.errors)} fill="var(--status-danger-fg, #dc2626)" opacity={0.7} />}
      <polyline
        points={buckets.map((b, i) => `${i + 0.5},${y(b.requests)}`).join(' ')}
        fill="none"
        stroke="var(--brand-500, #6366f1)"
        strokeWidth={1.5}
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
      {series.markers.map((m) => (
        <line
          key={`${m.kind}:${m.versionId}:${m.at}`}
          x1={xOf(m.at)}
          x2={xOf(m.at)}
          y1={0}
          y2={H}
          stroke={m.kind === 'went-live' ? 'var(--status-success-fg, #16a34a)' : 'var(--text-tertiary, #6b7280)'}
          strokeWidth={1}
          // Dashed for a push, solid for a go-live — the treatment `TrafficChart` uses,
          // so the two kinds are told apart by shape and not only by hue.
          strokeDasharray={m.kind === 'pushed' ? '3 3' : undefined}
          vectorEffect="non-scaling-stroke"
        >
          <title>{`${m.version} ${m.kind === 'went-live' ? 'went live' : 'pushed'}`}</title>
        </line>
      ))}
    </svg>
  );
}
