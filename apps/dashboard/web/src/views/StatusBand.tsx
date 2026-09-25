import type { ReactNode } from 'react';
import { useMediaQuery } from '@substrat-run/ui';
import type { AppRow, AppSchedulesView, OwnerSeatView, TenantMetricsRow } from '../lib/api';
import type { MetricsState } from '../lib/use-tenant-metrics';
import type { SchedulesState } from '../lib/use-app-schedules';
import { MonoTag, Pill, type PillKind } from '../components/ui';
import { navigate, obsPath, teamPath } from '../lib/router';

/**
 * The four stats an app's Overview opens with (#1447): is anything overdue, how many
 * requests failed today, which version is running, and has anyone claimed the seat.
 *
 * This band is what let Observability and Audit leave the tab bar for the left menu.
 * The answer to "is this app OK?" never leaves the app page — only the deep dive does —
 * so every tile is a LINK to the page that explains it. A stat a reader cannot walk into
 * is a dead end, and the band would quietly become the record instead of the way in.
 *
 * No new reads: each tile composes a route that already exists. A read still in flight
 * renders "…", and an unavailable one renders "—" rather than a confident zero — the rule
 * ReleaseComparisonCard spells out for this tab, where a fabricated 0 and a real 0 would
 * be the same picture.
 */
export function StatusBand({
  app,
  versionLabel,
  updateAvailable,
  seat,
  metrics,
  schedules,
}: {
  app: AppRow;
  /** The running version as Overview already resolved it ('…' loading, '—' nothing bound). */
  versionLabel: string;
  updateAvailable: boolean;
  /** `undefined` = still asking, `null` = the platform cannot answer for this instance. */
  seat: OwnerSeatView | null | undefined;
  /** The Overview's one 24h metrics read, shared with the traffic card. */
  metrics: MetricsState;
  /** The Overview's one schedules read, shared with the Schedules card. */
  schedules: SchedulesState;
}) {
  const scopeId = app.app_scope_id;
  // Two columns below 720px: four tiles side by side stop being a glance long before
  // they stop fitting. An inline-styled app has no `@media` block to say it in.
  const narrow = useMediaQuery('(max-width: 720px)');

  const health = schedules.state === 'ok' ? healthOf(schedules.view) : null;
  const errors = metrics.state === 'ok' ? errorsOf(metrics.rows) : null;

  return (
    <div style={{ display: 'grid', gridTemplateColumns: narrow ? 'repeat(2, 1fr)' : 'repeat(4, 1fr)', gap: 10 }}>
      <Tile label="Health" to={health && health.text === NO_SCHEDULES ? undefined : obsPath({ app: scopeId, view: 'schedules' })}>
        {schedules.state === 'loading' ? (
          <Waiting />
        ) : health === null ? (
          <Pill kind="neutral">—</Pill>
        ) : (
          <Pill kind={health.kind}>{health.text}</Pill>
        )}
      </Tile>
      <Tile label="Errors · 24h" to={obsPath({ app: scopeId })}>
        {metrics.state === 'loading' ? (
          <Waiting />
        ) : metrics.state === 'absent' ? (
          <Pill kind="neutral">not configured</Pill>
        ) : errors === null ? (
          <Pill kind="neutral">—</Pill>
        ) : (
          <>
            <Pill kind={errors.kind}>{errors.text}</Pill>
            {errors.requests > 0 && <MonoTag>{errors.requests.toLocaleString()} req</MonoTag>}
          </>
        )}
      </Tile>
      <Tile label="Running" to={`/apps/${scopeId}/deployments`}>
        {versionLabel === '…' ? (
          <Waiting />
        ) : (
          <>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12.5 }}>{versionLabel}</span>
            {versionLabel !== '—' && (
              <Pill kind={updateAvailable ? 'info' : 'success'}>{updateAvailable ? 'update available' : 'latest'}</Pill>
            )}
          </>
        )}
      </Tile>
      {/* Not a link: the owner-seat card, with the claim link on it, is a few hundred
          pixels below — a tile that navigated away from it would be a detour. */}
      <Tile label="Owner seat">
        {seat === undefined ? (
          <Waiting />
        ) : seat === null || seat.state === 'unknown' ? (
          <Pill kind="neutral">—</Pill>
        ) : seat.state === 'claimed' ? (
          <Pill kind="success">claimed</Pill>
        ) : (
          <>
            <Pill kind="warning">unclaimed</Pill>
            {seat.firstSignIn?.open && <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>first sign-in open</span>}
          </>
        )}
      </Tile>
    </div>
  );
}

/** The app declares neither a schedule nor a freshness expectation — nothing to walk into. */
const NO_SCHEDULES = 'No schedules';

function Waiting() {
  return <span style={{ color: 'var(--text-tertiary)' }}>…</span>;
}

function Tile({ label, to, children }: { label: string; to?: string; children: ReactNode }) {
  const style = {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 6,
    padding: '10px 12px',
    background: 'var(--surface-inset)',
    border: '1px solid var(--border-subtle)',
    borderRadius: 8,
    textDecoration: 'none',
    color: 'inherit',
  };
  const body = (
    <>
      <span style={{ fontSize: 10.5, letterSpacing: '0.07em', textTransform: 'uppercase', color: 'var(--text-tertiary)' }}>{label}</span>
      <span style={{ display: 'flex', alignItems: 'center', gap: 8, minHeight: 22, fontSize: 13, color: 'var(--text-primary)' }}>{children}</span>
    </>
  );
  if (!to) return <div style={style}>{body}</div>;
  return (
    <a href={teamPath(to)} onClick={(e) => { e.preventDefault(); navigate(to); }} style={style}>
      {body}
    </a>
  );
}

/**
 * The worst verdict across every declared schedule and freshness expectation — the band
 * reports the thing that is wrong, never the average. A count comes with the word, because
 * "2 stale" and "1 stale" are different mornings.
 */
function healthOf(view: AppSchedulesView): { kind: PillKind; text: string } {
  const schedules = view.schedules ?? [];
  const freshness = view.freshness ?? [];
  if (view.schedules === null && view.freshness === null) return { kind: 'neutral', text: NO_SCHEDULES };
  const n = (v: string) => schedules.filter((s) => s.health === v).length + freshness.filter((f) => f.health === v).length;
  const overdue = n('overdue');
  const stale = n('stale');
  if (overdue + stale > 0) {
    const words = [overdue > 0 ? `${overdue} overdue` : null, stale > 0 ? `${stale} stale` : null].filter(Boolean);
    return { kind: 'danger', text: words.join(' · ') };
  }
  if (n('sweeper-silent') > 0) return { kind: 'warning', text: 'No sweep data' };
  if (n('never-run') > 0) return { kind: 'neutral', text: 'Never run' };
  if (n('never-seen') > 0) return { kind: 'neutral', text: 'Never seen' };
  if (schedules.length + freshness.length === 0) return { kind: 'neutral', text: NO_SCHEDULES };
  return { kind: 'success', text: 'On schedule' };
}

/** The day's error rate across every surface that answered — one app, all its doors. */
function errorsOf(rows: TenantMetricsRow[]): { kind: PillKind; text: string; requests: number } {
  const requests = rows.reduce((n, r) => n + r.requests, 0);
  const errors = rows.reduce((n, r) => n + r.errors, 0);
  if (requests === 0) return { kind: 'neutral', text: 'no traffic', requests };
  const rate = (errors / requests) * 100;
  return { kind: rate > 1 ? 'danger' : errors > 0 ? 'warning' : 'success', text: `${rate.toFixed(1)}%`, requests };
}
