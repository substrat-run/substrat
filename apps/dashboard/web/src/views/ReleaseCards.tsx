import { useEffect, useState } from 'react';
import { api, type AppMigrationsView, type AppRow, type ReleaseComparison } from '../lib/api';
import { DEV_MOCK, MOCK_APP_MIGRATIONS, MOCK_RELEASE_COMPARISON } from '../lib/mock';
import { card } from '../components/ui';

/**
 * The two cards a release leaves behind, on the Deployments tab (#1447). Neither was
 * ever observability: the comparison is the last question before pressing Update, and
 * a schema history is a deployment fact — both belong beside the button that causes
 * them, not on a page about how the app is behaving right now.
 */

/**
 * Running vs the version an update would move this app to (#1236), on Deployments:
 * the last question before pressing Update, from the same 24h version-stamped traffic
 * the release ledger reads.
 *
 * Renders whenever there IS a running version — including when the app is
 * already current, which it then says. It used to hide in that case ("an empty
 * comparison is not information"), and production showed why that was wrong:
 * being up to date is the common GOOD state, and hiding made it identical to a
 * broken panel — three self-hiding cards on this tab composed into a page that
 * looked like nothing had shipped. Do not restore the hiding.
 *
 * An error rate that IMPROVES is the green story. Unavailable metrics render as
 * em dashes, never zeros — and for an app whose vertical another team publishes
 * the traffic is absent rather than zero (`owned: false`), while the version
 * pair still renders, because the registry is not telemetry.
 */
export function ReleaseComparisonCard({ app }: { app: AppRow }) {
  const [cmp, setCmp] = useState<ReleaseComparison | null>(DEV_MOCK ? MOCK_RELEASE_COMPARISON : null);

  useEffect(() => {
    if (DEV_MOCK) return;
    let live = true;
    // Same reason as the schema-history card below: unkeyed, so clear before refetching.
    setCmp(null);
    api
      .releaseComparison(app.app_scope_id)
      // Tolerated to nothing: a worker or plane predating the route costs the card, not the tab.
      .then((r) => live && setCmp(r))
      .catch(() => live && setCmp(null));
    return () => {
      live = false;
    };
  }, [app.app_scope_id]);

  // Renders whenever there IS a running version. Hiding on "no update" made the
  // common, GOOD state — you are current — indistinguishable from a broken panel,
  // and on this tab three self-hiding cards added up to a page that looked like
  // nothing shipped. "You are on the latest" is information; silence is not.
  if (!cmp || !cmp.running) return null;

  const rate = (side: { requests: number | null; errors: number | null }): string => {
    if (side.requests === null || side.errors === null) return '—';
    if (side.requests === 0) return 'no traffic';
    return `${((side.errors / side.requests) * 100).toFixed(1)}%`;
  };
  // Traffic is the builder's to see. For an installed app the numbers are absent,
  // not zero, and the row says so in words rather than showing a confident 0.
  const trafficLine = (side: NonNullable<ReleaseComparison['running']>) =>
    cmp.owned ? (
      <div style={{ display: 'flex', gap: 14, fontSize: 12.5, fontFamily: 'var(--font-mono)' }}>
        <span>{side.requests === null ? '—' : `${side.requests.toLocaleString()} req`}</span>
        <span style={{ color: side.errors ? 'var(--status-danger-fg)' : undefined }}>{rate(side)} err</span>
        <span title="CPU p50 / p99, busiest script">{ms(side.cpuTimeP50)} / {ms(side.cpuTimeP99)}</span>
      </div>
    ) : null;
  const ms = (v: number | null): string => (v === null ? '—' : `${v.toFixed(1)}ms`);
  const sideCell = (label: string, side: NonNullable<ReleaseComparison['running']>) => (
    <div style={{ display: 'grid', gap: 4 }}>
      <div style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>
        {label} · <span style={{ fontFamily: 'var(--font-mono)' }}>{side.version ?? side.versionId.slice(-6)}</span>
      </div>
      {trafficLine(side)}
    </div>
  );

  return (
    <div style={{ ...card, padding: 14, display: 'grid', gap: 10 }}>
      <div>
        <h3 style={{ margin: 0, fontSize: 15 }}>{cmp.update ? 'Update comparison' : 'Version'}</h3>
        <p style={{ margin: '4px 0 0', fontSize: 12.5, color: 'var(--text-tertiary)' }}>
          {!cmp.owned
            ? 'The version this app runs. Its traffic belongs to the team that publishes the vertical, so the numbers stay with them.'
            : cmp.update
              ? `The version this app runs beside the one an update would move it to — last 24h of traffic, fleet-wide per version${cmp.metricsAvailable ? '' : ' (metrics unavailable on this plane)'}.`
              : `Running the latest version — nothing to update to${cmp.metricsAvailable ? '' : ' (metrics unavailable on this plane)'}.`}
        </p>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: cmp.update ? '1fr 1fr' : '1fr', gap: 16 }}>
        {sideCell('Running', cmp.running)}
        {cmp.update && sideCell('Update target', cmp.update)}
      </div>
    </div>
  );
}


/**
 * The app's schema history (#1236): when each migration actually ran, from
 * `_substrat_migrations.applied_at` — written since the table shipped, read by
 * nothing until now, because every reader wanted only the frontier.
 *
 * A list rather than markers on the traffic chart, deliberately: a migration
 * applies to ONE scope while traffic is measured per script and a script serves
 * many scopes, so a per-scope line on a fleet-wide axis would draw a claim the
 * telemetry cannot support. A null instant is a fact — the row predates the
 * platform recording one — and reads as "before we recorded", never as unknown
 * noise.
 */
export function SchemaHistoryCard({ app }: { app: AppRow }) {
  // Availability comes from the SERVER, never inferred from emptiness here: a
  // module may register `migrations: []`, so an empty list is a fact about the app,
  // while `available: false` is a fact about the read (a deployment that does not
  // serve the endpoint, or a plane fault). Collapsing those was the bug this card
  // shipped with — and then, briefly, its inverse.
  const [view, setView] = useState<AppMigrationsView | null>(DEV_MOCK ? MOCK_APP_MIGRATIONS : null);

  useEffect(() => {
    if (DEV_MOCK) return;
    let live = true;
    // Cleared first: this card is not keyed on the app, so switching apps reruns the
    // effect with last app's rows still mounted — and a schema history attributed to
    // the wrong app is worse than an empty card for the moment the request is in flight.
    setView(null);
    api
      .appMigrations(app.app_scope_id)
      .then((r) => live && setView(r))
      // A worker predating the route: the card cannot say anything true, so it says nothing.
      .catch(() => live && setView(null));
    return () => {
      live = false;
    };
  }, [app.app_scope_id]);

  if (view === null) return null;
  const shown = view.migrations.slice(0, 8);

  return (
    <div style={{ ...card, padding: 14, display: 'grid', gap: 10 }}>
      <div>
        <h3 style={{ margin: 0, fontSize: 15 }}>Schema history</h3>
        <p style={{ margin: '4px 0 0', fontSize: 12.5, color: 'var(--text-tertiary)' }}>
          When this app&rsquo;s migrations ran, newest first — the other thing that changes
          under a release.
        </p>
      </div>
      {!view.available && (
        <p style={{ margin: 0, fontSize: 12.5, color: 'var(--text-tertiary)' }}>
          Could not be read. The history is served by the deployment itself, so a version
          that predates the endpoint cannot answer — it appears after the next push.
        </p>
      )}
      {view.available && view.migrations.length === 0 && (
        <p style={{ margin: 0, fontSize: 12.5, color: 'var(--text-tertiary)' }}>
          No migrations — this app&rsquo;s modules declare no schema of their own.
        </p>
      )}
      <div style={{ display: 'grid', gap: 6 }}>
        {shown.map((m) => (
          <div
            key={`${m.moduleId}:${m.version}`}
            style={{ display: 'flex', justifyContent: 'space-between', gap: 12, fontSize: 12.5 }}
          >
            <span style={{ fontFamily: 'var(--font-mono)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {m.moduleId} <span style={{ color: 'var(--text-tertiary)' }}>{m.version}</span>
            </span>
            <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-tertiary)', whiteSpace: 'nowrap' }}>
              {m.appliedAt ? new Date(m.appliedAt).toLocaleString() : 'before we recorded'}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
