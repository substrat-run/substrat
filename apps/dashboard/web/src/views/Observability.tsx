import { useEffect, useMemo, useState } from 'react';
import { api, type AppRow, type TenantMetricsBucket } from '../lib/api';
import { Page } from '../components/layout';
import { card } from '../components/ui';
import { TrafficChart as BucketChart } from '../components/TrafficChart';
import { deriveTrafficChart, type TrafficChartView } from '../lib/traffic-chart';

/**
 * Observability at team level (#1447 step 3) — one time axis for the whole team.
 *
 * Replaces Analytics, which was a Preview page on estimated figures whose `All apps`
 * select filtered nothing. This is the same shape the field settled on — Sentry,
 * Cloudflare Workers Observability, Vercel Activity all put the cross-project view at
 * account level with a project chip — and it is where the app page links into,
 * pre-narrowed, rather than every app carrying a copy of the machinery.
 *
 * The grain is the reason it can exist at all. Per-script metrics answer a question
 * about the CODE across every team that installed it; `tenantMetricsSeries` (#1451)
 * carries the scope dimension, so these are this team's own numbers.
 *
 * ## What this first cut does not have yet
 *
 * #1447 asks for overlays — deploy markers, migrations applied, failed schedule runs,
 * stale freshness windows — and for a marker to be a link that sets the time cursor.
 * Those are a second pass. What is here is the axis they hang off, and the chip that
 * decides the mode; the sub-views keep their own reads meanwhile.
 */
const RANGES: Array<{ label: string; hours: number }> = [
  { label: '1h', hours: 1 },
  { label: '24h', hours: 24 },
  { label: '7d', hours: 168 },
];

export function Observability({
  apps,
  appsComplete,
  scopeId,
  onScope,
}: {
  apps: AppRow[];
  /** False while the app list is still paging — the chip cannot claim to be complete. */
  appsComplete: boolean;
  /** The app the chip names, or null for all of them. */
  scopeId: string | null;
  onScope: (s: string | null) => void;
}) {
  const [hours, setHours] = useState(24);
  /** The read, with the instant it landed — the axis ends there, not at each re-render. */
  const [read, setRead] = useState<{ buckets: TenantMetricsBucket[]; at: Date } | null>(null);
  /**
   * Why the read failed, or null. NOT folded into an empty bucket list: a control
   * plane with no bucketed tenant-grain reader answers 501, and drawing that as a flat
   * zero would report an app as idle when nobody actually asked about it. This surface
   * has shipped that exact bug before.
   */
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setRead(null);
    setErr(null);
    // "All apps" names no scope: the worker resolves the team's own list, complete, so
    // the read neither waits on the browser's paged app index nor grows a query string
    // with it. The index is still needed for labels and silent rows, and App walks it to
    // exhaustion while this page is open, as it does for Audit.
    api
      .tenantMetricsSeries({ scopeIds: scopeId ? [scopeId] : undefined, hours })
      .then((b) => live && setRead({ buckets: b, at: new Date() }))
      .catch((e) => live && setErr(e instanceof Error ? e.message : String(e)));
    return () => {
      live = false;
    };
  }, [scopeId, hours]);

  const view: TrafficChartView | null = useMemo(
    () =>
      read === null
        ? null
        : deriveTrafficChart({
            buckets: read.buckets,
            apps: apps.map((a) => ({ scopeId: a.app_scope_id, label: a.name ?? a.app_scope_id })),
            focus: scopeId,
            hours,
            now: read.at,
          }),
    [read, apps, scopeId, hours],
  );

  return (
    <Page>
      {/* The header shape the Audit page uses — `Page` is a layout box and carries no
          title of its own. */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        <span style={{ fontSize: 22, fontWeight: 600, letterSpacing: '-0.02em', color: 'var(--text-primary)' }}>
          Observability
        </span>
        <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
          Requests, errors and latency across this team&rsquo;s apps.
        </div>
      </div>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <select
          value={scopeId ?? ''}
          onChange={(e) => onScope(e.target.value || null)}
          style={chrome}
          aria-label="App"
        >
          <option value="">All apps{appsComplete ? '' : ' (still loading)'}</option>
          {apps.map((a) => (
            <option key={a.app_scope_id} value={a.app_scope_id}>
              {a.name ?? a.app_scope_id}
            </option>
          ))}
        </select>
        {RANGES.map((r) => (
          <button
            key={r.label}
            type="button"
            onClick={() => setHours(r.hours)}
            style={{ ...chrome, fontWeight: hours === r.hours ? 600 : 400 }}
          >
            {r.label}
          </button>
        ))}
      </div>

      {err && (
        <div style={{ ...card, padding: 14, fontSize: 12.5, color: 'var(--status-danger-fg)' }}>
          {/* Said, not swallowed: "we could not ask" and "nothing happened" are
              different answers, and only one of them is about the apps. */}
          Traffic could not be read: {err}
        </div>
      )}

      {!err && view === null && (
        <div style={{ ...card, padding: 14, fontSize: 12.5, color: 'var(--text-tertiary)' }}>Reading…</div>
      )}

      {!err && view !== null && <TrafficChart view={view} hours={hours} />}
    </Page>
  );
}

const chrome = {
  font: 'inherit',
  fontSize: 12.5,
  padding: '4px 10px',
  borderRadius: 6,
  border: '1px solid var(--border-default)',
  background: 'var(--surface-card)',
  color: 'var(--text-primary)',
} as const;

/**
 * The chart. One line per app over a shared axis, stacked as sparklines rather than
 * overlaid: overlaying a busy app and a quiet one on a shared y-axis makes the quiet
 * one a flat line at the bottom, which is exactly the app somebody is looking for.
 */
function TrafficChart({ view, hours }: { view: TrafficChartView; hours: number }) {
  // The axis always spans the window now, so "nothing ran" is read off the rows: every
  // app silent (or no app at all) is the one case with no bar worth drawing.
  if (view.series.every((s) => s.silent)) {
    return (
      <div style={{ ...card, padding: 14, fontSize: 12.5, color: 'var(--text-tertiary)' }}>
        No requests recorded in the last {hours === 1 ? 'hour' : hours === 24 ? '24 hours' : '7 days'}.
      </div>
    );
  }

  return (
    <div style={{ ...card, padding: 14, display: 'grid', gap: 12 }}>
      <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', fontSize: 12.5 }}>
        <Stat label="Requests" value={view.requests.toLocaleString()} />
        <Stat
          label="Errors"
          value={view.errors.toLocaleString()}
          tone={view.errors > 0 ? 'var(--status-danger-fg)' : undefined}
        />
        {/* The PEAK, and labelled as such: an average of P95s is not a percentile. */}
        <Stat label="Peak P95" value={`${Math.round(view.peakP95)} ms`} />
        <Stat label="Bucket" value={`${view.bucketMinutes} min`} />
      </div>

      <div style={{ display: 'grid', gap: 8 }}>
        {view.series.map((s) => {
          return (
            <div key={s.scopeId} style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
              <span
                style={{
                  fontSize: 12.5,
                  flex: '0 0 160px',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  color: s.silent ? 'var(--text-tertiary)' : 'var(--text-primary)',
                }}
              >
                {s.label}
              </span>
              {s.silent ? (
                <span style={{ flex: 1, fontSize: 11.5, color: 'var(--text-tertiary)' }}>
                  {/* A fact, not an empty row: nothing ran here in this window. */}
                  no requests in this window
                </span>
              ) : (
                <span style={{ flex: 1 }}>
                  {/* #1236's chart, not a second one. It already encodes the reading
                      rules this page needs — errors drawn INSIDE their bucket's bar so
                      the eye cannot read them as outnumbering requests, and a zero
                      bucket as a visible tick rather than a gap that would let
                      neighbours join and hide an outage as a narrower peak. Markers are
                      empty here until the overlays land; the component draws none. */}
                  <BucketChart
                    buckets={s.points.map((p) => ({ start: p.start, requests: p.requests, errors: p.errors }))}
                    markers={[]}
                    bucketMinutes={view.bucketMinutes}
                    height={34}
                  />
                </span>
              )}
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11.5, color: 'var(--text-tertiary)', minWidth: 72, textAlign: 'right' }}>
                {s.requests.toLocaleString()}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <span style={{ display: 'grid', gap: 2 }}>
      <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>{label}</span>
      <span style={{ fontFamily: 'var(--font-mono)', color: tone ?? 'var(--text-primary)' }}>{value}</span>
    </span>
  );
}
