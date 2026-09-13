import { useEffect, useMemo, useState } from 'react';
import { Button, Select } from '@substrat-run/ui';
import { api, ApiError, type AppRow, type TeamTrafficSeries } from '../lib/api';
import { DEV_MOCK, MOCK_TEAM_TRAFFIC } from '../lib/mock';
import { Page, GridTable, Row } from '../components/layout';
import { card, MonoTag } from '../components/ui';
import { TrafficChart } from '../components/TrafficChart';
import { AppSchedules } from './AppSchedules';
import { FleetHealth } from './Apps';
import { Flow } from './Flow';
import { EventExplorer, TenantLogs, TenantTrafficTable } from './ObservabilityPanels';

/**
 * Observability (#1447) — every app on the team, on one chart, under ONE time range.
 *
 * It replaces two things at once. The left menu's Analytics page was a preview on demo
 * constants whose app filter filtered nothing, and the app page's Observability tab was
 * five cards in merge order with three different time controls and no time axis at all.
 * The rule that decides the shape: **the chart is the page**, and everything else is a
 * narrowing of it. A sub-view never carries its own window, because the moment two panels
 * answer about different slices the reader can no longer relate them.
 *
 * The app filter decides the mode rather than merely filtering rows:
 *
 * - **All apps** — one line per installation, then a row per app and the worst-first
 *   health list. The cross-app question, which had no home but the Apps list.
 * - **One app** — the same chart at tenant grain, plus that app's logs, events,
 *   schedules and flow map. This is where the app page links in, already narrowed.
 *
 * Tenant grain throughout, for a vertical's publisher too: an app is one installation,
 * and the fleet numbers for the code live on the Vertical page (the Traffic sub-view
 * links up to them). That is what retires the builder/installed fork the tab carried.
 *
 * The time range is local state and deliberately NOT in the URL: a shared link should
 * open on the thing that was worth sharing, which is the app and the sub-view, and the
 * window a reader wants is the window they are in now.
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

/** Whether a sub-view can answer in the mode the app filter selected. */
function available(view: (typeof VIEWS)[number], oneApp: boolean): boolean {
  return view.modes === 'both' || view.modes === (oneApp ? 'one-app' : 'all-apps');
}

export function Observability({
  apps,
  scopeId,
  view,
  focusEventType,
  onNav,
}: {
  apps: AppRow[];
  /** The app the page is narrowed to, or null for all of them. */
  scopeId: string | null;
  view: string | null;
  focusEventType: string | null;
  onNav: (q: { app?: string; view?: string; type?: string }) => void;
}) {
  const [hours, setHours] = useState<(typeof RANGES)[number]['hours']>(24);
  // One nonce for the whole page: Refresh re-asks every question on it, which the old tab
  // could not do — its button refreshed the one card it sat in.
  const [nonce, setNonce] = useState(0);
  const [series, setSeries] = useState<TeamTrafficSeries | null>(null);
  const [chartError, setChartError] = useState(false);

  const app = scopeId ? apps.find((a) => a.app_scope_id === scopeId) : undefined;
  const oneApp = scopeId !== null;
  // A sub-view the current mode cannot answer falls back to Traffic rather than rendering
  // blank: `?view=logs` with the filter back on All apps is a stale link, not an error.
  const active: ViewKey = useMemo(() => {
    const wanted = VIEWS.find((v) => v.key === view);
    return wanted && available(wanted, oneApp) ? wanted.key : 'traffic';
  }, [view, oneApp]);

  useEffect(() => {
    let live = true;
    // Cleared before the refetch: a chart drawn for one app under a heading that now
    // names another is the misreading the whole page exists to prevent.
    setSeries(null);
    setChartError(false);
    if (DEV_MOCK) {
      setSeries(
        scopeId
          ? { ...MOCK_TEAM_TRAFFIC, series: MOCK_TEAM_TRAFFIC.series.filter((s) => s.scopeId === scopeId) }
          : MOCK_TEAM_TRAFFIC,
      );
      return;
    }
    api
      .teamTraffic({ ...(scopeId ? { scopeIds: [scopeId] } : {}), hours })
      .then((s) => live && setSeries(s))
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
  }, [scopeId, hours, nonce]);

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

  return (
    <Page>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <span style={{ fontSize: 22, fontWeight: 600, letterSpacing: '-0.02em', color: 'var(--text-primary)' }}>Observability</span>
          <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
            {app
              ? <>Traffic, logs, events and schedules for <strong style={{ fontWeight: 550 }}>{app.name}</strong>.</>
              : 'Every app on this team, on one time axis.'}
          </div>
        </div>
        <div style={{ flex: 1 }} />
        <Select
          aria-label="App"
          options={[{ value: '', label: 'All apps' }, ...apps.map((a) => ({ value: a.app_scope_id, label: a.name }))]}
          value={scopeId ?? ''}
          // The sub-view is carried across a mode change only where it still means
          // something — narrowing from the all-apps Traffic view lands on that app's
          // traffic, and widening out of Logs drops it rather than leaving the URL
          // claiming a sub-view the page is not showing.
          onChange={(e) => {
            const next = e.target.value;
            const wanted = VIEWS.find((v) => v.key === active);
            onNav({
              ...(next ? { app: next } : {}),
              ...(wanted && available(wanted, next !== '') ? { view: active } : {}),
            });
          }}
          style={{ width: 200 }}
        />
        <Segmented
          label="Time range"
          options={RANGES.map((r) => ({ key: String(r.hours), label: r.label }))}
          value={String(hours)}
          onPick={(k) => setHours(Number(k) as (typeof RANGES)[number]['hours'])}
        />
        <Button variant="ghost" size="sm" onClick={() => setNonce((n) => n + 1)}>
          Refresh
        </Button>
      </div>

      <div style={{ ...card, padding: 16, display: 'grid', gap: 10 }}>
        <Chart series={series} error={chartError} oneApp={oneApp} nameOf={appName} />
        <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>
          Traffic to your installations — approximate, sampled at high volume.
        </span>
      </div>

      <Segmented
        label="Sub-view"
        options={VIEWS.map((v) => ({
          key: v.key,
          label: v.label,
          ...(available(v, oneApp) ? {} : { disabled: true, title: 'Pick an app' }),
        }))}
        value={active}
        // Disabled entries stay VISIBLE rather than disappearing: a control bar that
        // changes length with the filter reads as a page that lost something.
        onPick={(k) => onNav({ ...(scopeId ? { app: scopeId } : {}), view: k })}
      />

      {active === 'traffic' && !oneApp && <AppTrafficRows rows={totals} loading={series === null} onOpen={(s) => onNav({ app: s })} />}
      {active === 'health' && <FleetHealth onOpen={(s) => onNav({ app: s })} />}
      {scopeId && active === 'traffic' && <TenantTrafficTable scopeId={scopeId} hours={hours} nonce={nonce} />}
      {scopeId && active === 'logs' && (
        <TenantLogs
          scopeId={scopeId}
          hours={hours}
          nonce={nonce}
          // Straight off the chart above, so the log panel can tell "no traffic" from
          // "traffic whose lines are not attributed yet" without a second read.
          {...(series?.available && thisApp ? { hadTraffic: thisApp.requests > 0 } : {})}
        />
      )}
      {scopeId && active === 'events' && (
        <EventExplorer
          key={scopeId}
          scopeId={scopeId}
          hours={hours}
          {...(focusEventType ? { focusEventType } : {})}
        />
      )}
      {scopeId && active === 'schedules' && <AppSchedules scopeId={scopeId} />}
      {app && active === 'flow' && <Flow key={app.app_scope_id} app={app} />}
    </Page>
  );
}

/**
 * The chart, or the reason there isn't one. An unavailable plane says so in the chart's
 * place; zero traffic draws a flat zero line, because that IS information and an absent
 * chart is not.
 */
function Chart({
  series,
  error,
  oneApp,
  nameOf,
}: {
  series: TeamTrafficSeries | null;
  error: boolean;
  oneApp: boolean;
  nameOf: (scopeId: string) => string;
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
  // One app: the bar chart, errors inside their bucket, as the release chart draws it.
  // Markers are empty in this pass — a per-app deploy/migration marker is its own read,
  // and drawing a vertical's pushes on one installation's chart before that lands would
  // be a fact from the wrong grain.
  if (oneApp) return <TrafficChart buckets={axis} markers={[]} bucketMinutes={series.bucketMinutes} />;
  // All apps: one line each. The legend names them; the rows under the chart are the
  // same list made reachable, and each of those narrows the page to its app.
  return (
    <TrafficChart
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
            disabled={o.disabled ?? false}
            {...(o.title ? { title: o.title } : {})}
            aria-pressed={on}
            onClick={() => onPick(o.key)}
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
