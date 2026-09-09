import type { ReleaseMarker, TrafficBucket } from '../lib/api';

/**
 * Traffic over time with the deploys drawn on it (#1236) — hand-rolled SVG
 * rather than a charting dependency: the shape is bars plus vertical rules, and
 * a library would be more bytes than the drawing.
 *
 * The reading rules this encodes, because a chart is where an honest record
 * most easily becomes a dishonest picture:
 *
 * - **Errors are drawn inside their bucket's bar**, not beside it: the eye
 *   compares heights, and a separate error series invites reading a tall error
 *   bar next to a short request bar as "more errors than requests".
 * - **A zero bucket is a visible baseline tick**, never a gap — the series is
 *   already zero-filled worker-side, and skipping empties would let neighbours
 *   join and hide an outage as a narrower peak.
 * - **A marker with no traffic still draws.** Markers are registry facts; a push
 *   that produced nothing is the most interesting push on the chart.
 */
export function TrafficChart({
  buckets,
  markers,
  bucketMinutes,
  height = 96,
}: {
  buckets: TrafficBucket[];
  markers: ReleaseMarker[];
  /** The series' bucket width — the unit the x axis is drawn in. */
  bucketMinutes: number;
  height?: number;
}) {
  if (buckets.length === 0) return null;

  // A viewBox in bucket units: the SVG scales to its container, so the chart is
  // responsive without measuring anything.
  const W = buckets.length;
  const H = 100;
  const peak = Math.max(1, ...buckets.map((b) => b.requests));
  const first = Date.parse(buckets[0]!.start);
  // One bucket IS one x unit, so elapsed-over-width converts an instant straight
  // into the axis. Scaling by the span between the first and LAST bucket's starts
  // instead would be short by one bucket: the last bar occupies [W-1, W], so its
  // start would land on the right edge and anything later in that bucket — the
  // common case, since the newest bucket is the one still filling — would be drawn
  // outside the viewBox entirely.
  const widthMs = Math.max(1, bucketMinutes * 60_000);
  const xOf = (iso: string): number => Math.min(W, Math.max(0, (Date.parse(iso) - first) / widthMs));

  const fmt = (iso: string) =>
    new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

  return (
    <div style={{ display: 'grid', gap: 6 }}>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        style={{ width: '100%', height, display: 'block', overflow: 'visible' }}
        role="img"
        aria-label={`Traffic over ${buckets.length} buckets with ${markers.length} deploy markers`}
      >
        {buckets.map((b, i) => {
          const total = (b.requests / peak) * (H - 2);
          const errs = b.requests === 0 ? 0 : (b.errors / peak) * (H - 2);
          return (
            <g key={b.start}>
              {/* The baseline tick keeps an empty bucket visible as a bucket. */}
              <rect x={i + 0.1} y={H - Math.max(total, 0.6)} width={0.8} height={Math.max(total, 0.6)} fill="var(--brand-500, #6366f1)" opacity={0.55}>
                <title>{`${fmt(b.start)} — ${b.requests.toLocaleString()} req, ${b.errors.toLocaleString()} err`}</title>
              </rect>
              {errs > 0 && (
                <rect x={i + 0.1} y={H - errs} width={0.8} height={errs} fill="var(--status-danger-fg, #dc2626)" opacity={0.9} />
              )}
            </g>
          );
        })}
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
            <title>{`${m.version} ${m.kind === 'went-live' ? 'went live' : 'pushed'} — ${fmt(m.at)}`}</title>
          </line>
        ))}
      </svg>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--text-tertiary)', fontFamily: 'var(--font-mono)' }}>
        <span>{fmt(buckets[0]!.start)}</span>
        <span>{fmt(buckets[buckets.length - 1]!.start)}</span>
      </div>
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
              <span>{m.kind === 'went-live' ? 'live' : 'pushed'}</span>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
