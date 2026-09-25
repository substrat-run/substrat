import { useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import { api, type AppDeployments, type AppMigrationsView, type AppRow, type DeploymentVersion, type ReleaseComparison, type ReleaseSide } from '../lib/api';
import { DEV_MOCK, MOCK_APP_MIGRATIONS, MOCK_APP_PERMISSIONS } from '../lib/mock';
import { MOCK_APP_MODEL_UPDATE, MOCK_APP_RELEASES, MOCK_APP_RELEASE_COMPARISON, MOCK_PROD_HISTORY } from '../lib/mock-deployments';
import { diffRegistries } from '../lib/registry-diff';
import {
  DIFF_TAG,
  instant,
  ledgerRows,
  migrationDiffItems,
  permissionDiffItems,
  registryLedgerRows,
  schemaDiffItems,
  span,
  type DiffItem,
  type DiffKind,
  type LedgerRow,
} from '../lib/release-ledger';

/**
 * The three cards a release leaves behind, on the Deployments tab (#1447, #1767). None
 * was ever observability: the comparison is the last question before pressing Update,
 * and the release list and schema history are deployment facts — they belong beside the
 * button that causes them, not on a page about how the app is behaving right now.
 */

const panel: CSSProperties = {
  border: '1px solid var(--border-default)',
  borderRadius: 12,
  background: 'var(--surface-card)',
  boxShadow: 'var(--shadow-sm)',
  overflow: 'hidden',
};
const mono: CSSProperties = { fontFamily: 'var(--font-mono)' };
const tertiary: CSSProperties = { fontSize: 12, color: 'var(--text-tertiary)' };
const columnHead: CSSProperties = { fontSize: 10.5, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--text-tertiary)' };

/** What the comparison compares the running version WITH: prod's head, or a newer push not yet in prod. */
export interface ComparisonTarget {
  version: DeploymentVersion;
  /** `update`: prod serves it and this app does not. `unpromoted`: admitted, not in prod yet. */
  state: 'update' | 'unpromoted';
}

/** The release ledger as the tab reads it — shared by the comparison's "went live" and the Releases list. */
export interface Ledger {
  rows: LedgerRow[];
  /** `ledger` = this team publishes the vertical, so go-live and installs are readable. */
  source: 'ledger' | 'registry';
  /** The releases read failed and the rows fell back to the registry's version list. */
  failed: boolean;
}

/**
 * The ledger for this app's vertical. A vertical this team publishes gets the releases read
 * joined to prod's move history; one installed from another team gets only the registry's
 * version list, because the go-live record is the publisher's (the worker refuses it).
 */
export function useLedger(dep: AppDeployments | null): Ledger | null {
  const [ledger, setLedger] = useState<Ledger | null>(null);
  const prodId = dep?.channels.find((c) => c.channel === 'prod')?.versionId ?? null;
  useEffect(() => {
    if (!dep) return;
    if (DEV_MOCK) {
      setLedger({ rows: ledgerRows(MOCK_APP_RELEASES, MOCK_PROD_HISTORY), source: 'ledger', failed: false });
      return;
    }
    const registry = (failed: boolean): Ledger => ({ rows: registryLedgerRows(dep.versions, prodId), source: 'registry', failed });
    if (!dep.owned) {
      setLedger(registry(false));
      return;
    }
    let live = true;
    setLedger(null);
    Promise.all([api.listReleases(dep.slug), api.channelHistory(dep.slug, 'prod').catch(() => null)])
      .then(([view, history]) => live && setLedger({ rows: ledgerRows(view, history), source: 'ledger', failed: false }))
      .catch(() => live && setLedger(registry(true)));
    return () => {
      live = false;
    };
    // The versions list only matters for the registry fallback; a refetch after Update
    // hands a new `dep` whose prod pointer or version count is what actually moved.
  }, [dep?.slug, dep?.owned, prodId, dep?.versions.length]);
  return ledger;
}

/** A column of the comparison: its rows, or the sentence saying why there are none to show. */
type DiffColumn = { items: DiffItem[] } | { unavailable: string } | null;

const OPERATIONS_UNREAD: DiffColumn = {
  unavailable: 'Not compared yet — no read lists the operations a version declares.',
};

function tagStyle(kind: DiffKind): CSSProperties {
  const tone = kind === 'removed' ? 'var(--status-danger-fg)' : kind === 'changed' ? 'var(--status-warning-fg)' : null;
  return {
    fontSize: 11,
    lineHeight: '18px',
    textAlign: 'center',
    borderRadius: 4,
    border: `1px solid ${tone ?? 'var(--border-strong)'}`,
    color: tone ?? 'var(--text-secondary)',
    whiteSpace: 'nowrap',
  };
}

/**
 * Running vs the version it could move to (#1236, #1767), as the three things that change
 * under a release — operations, permissions, schema — tagged added / changed / removed,
 * with the action that makes the move in its header.
 *
 * Renders whenever there IS a running version — including when the app is already
 * current, which it then says. It used to hide in that case, and production showed why
 * that was wrong: being up to date is the common GOOD state, and hiding made it
 * identical to a broken panel. Do not restore the hiding.
 *
 * The per-version traffic under it keeps the older card's rules: unavailable metrics are
 * em dashes, never zeros, and for a vertical another team publishes the traffic is
 * absent rather than zero (`owned: false`), because the registry is not telemetry.
 */
export function ReleaseComparisonCard({
  app,
  dep,
  running,
  target,
  ledger,
  actions,
}: {
  app: AppRow;
  dep: AppDeployments;
  running: DeploymentVersion | undefined;
  target: ComparisonTarget | null;
  ledger: Ledger | null;
  actions?: ReactNode;
}) {
  const [cmp, setCmp] = useState<ReleaseComparison | null>(DEV_MOCK ? MOCK_APP_RELEASE_COMPARISON : null);
  const [perms, setPerms] = useState<DiffColumn>(null);
  const [schema, setSchema] = useState<DiffColumn>(null);
  const targetId = target?.version.id ?? null;
  const targetState = target?.state ?? null;
  const targetMigrates = !!target?.version.schemaChange;

  useEffect(() => {
    if (DEV_MOCK) return;
    let live = true;
    // Unkeyed on the app, so clear before refetching: last app's numbers must not linger.
    setCmp(null);
    api
      .releaseComparison(app.app_scope_id)
      // Tolerated to nothing: a worker or plane predating the route costs the traffic line, not the card.
      .then((r) => live && setCmp(r))
      .catch(() => live && setCmp(null));
    return () => {
      live = false;
    };
  }, [app.app_scope_id, running?.id, targetId]);

  useEffect(() => {
    setPerms(null);
    setSchema(null);
    if (!targetId || !targetState) return;
    let live = true;
    const unreadRegistry = { unavailable: 'One of the two versions kept no permission registry (pushed before manifests were retained).' };
    if (targetState === 'update') {
      const migrationsRow: DiffItem[] = targetMigrates
        ? [{ kind: 'added', name: 'migrations', note: 'this update runs new migrations — a snapshot is offered first' }]
        : [];
      const permsRead = DEV_MOCK ? Promise.resolve(MOCK_APP_PERMISSIONS) : api.appPermissions(app.app_scope_id);
      const modelRead = DEV_MOCK ? Promise.resolve(MOCK_APP_MODEL_UPDATE) : api.appModel(app.app_scope_id);
      permsRead
        .then((v) => {
          if (!live) return;
          const from = v.running.registry;
          const to = v.update?.registry;
          setPerms(from && to ? { items: permissionDiffItems(diffRegistries(from, to), from, to) } : unreadRegistry);
        })
        .catch(() => live && setPerms({ unavailable: 'Could not be read.' }));
      modelRead
        .then((v) => {
          if (!live) return;
          const items = schemaDiffItems(v.running.model, v.update?.model);
          setSchema(
            items
              ? { items: [...items, ...migrationsRow] }
              : migrationsRow.length
                ? { items: migrationsRow }
                : { unavailable: 'One of the two versions recorded no entity model.' },
          );
        })
        .catch(() => live && setSchema({ unavailable: 'Could not be read.' }));
    } else if (!dep.owned) {
      const theirs = { unavailable: 'The publishing team reviews this before it reaches prod; the review is theirs to read.' };
      setPerms(theirs);
      setSchema(theirs);
    } else {
      // Not in prod yet: the promote review is the one read that compares it with what
      // prod serves — and prod IS what this app runs, or an update would be on offer.
      api
        .promoteReview(dep.slug, targetId)
        .then((r) => {
          if (!live) return;
          const from = r.servingRegistry;
          const to = r.incomingRegistry;
          setPerms(from && to ? { items: permissionDiffItems(diffRegistries(from, to), from, to) } : unreadRegistry);
          setSchema(
            r.migrations
              ? { items: migrationDiffItems(r.migrations) }
              : { unavailable: 'This version’s manifest carries no migrations to compare.' },
          );
        })
        .catch(() => {
          if (!live) return;
          setPerms({ unavailable: 'Could not be read.' });
          setSchema({ unavailable: 'Could not be read.' });
        });
    }
    return () => {
      live = false;
    };
  }, [app.app_scope_id, dep.slug, dep.owned, targetId, targetState, targetMigrates]);

  if (!running && !target) return null;
  const wentLive = (id: string) => ledger?.rows.find((r) => r.versionId === id)?.wentLiveAt ?? null;
  const runningLive = running ? wentLive(running.id) : null;
  const columns: Array<[string, DiffColumn]> = [
    ['Operations', OPERATIONS_UNREAD],
    ['Permissions', perms],
    ['Schema', schema],
  ];

  return (
    <div style={panel}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', padding: '14px 16px', borderBottom: '1px solid var(--border-default)' }}>
        <span style={{ fontSize: 14, fontWeight: 600 }}>Release comparison</span>
        {running ? (
          <>
            <span style={{ ...mono, fontSize: 13 }}>{running.version}</span>
            <span style={tertiary}>running{runningLive ? ` · went live ${instant(runningLive)}` : ''}</span>
          </>
        ) : (
          <span style={tertiary}>nothing running yet</span>
        )}
        {target && (
          <>
            <span style={{ color: 'var(--text-tertiary)' }}>→</span>
            <span style={{ ...mono, fontSize: 13 }}>{target.version.version}</span>
            <span style={tertiary}>
              {target.version.createdAt ? `pushed ${instant(target.version.createdAt)} · ` : ''}
              {target.state === 'update' ? 'in prod, not on this app' : 'not live'}
            </span>
          </>
        )}
        <span style={{ flex: 1 }} />
        {actions}
      </div>
      {target ? (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))' }}>
          {columns.map(([title, col], i) => (
            <div key={title} data-diff-column={title} style={{ padding: '12px 16px 14px', borderRight: i < 2 ? '1px solid var(--border-subtle)' : 'none', display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0 }}>
              <div style={{ ...columnHead, fontSize: 11 }}>{title}</div>
              {col === null ? (
                <span style={tertiary}>Loading…</span>
              ) : 'unavailable' in col ? (
                <span style={{ ...tertiary, lineHeight: '17px' }}>{col.unavailable}</span>
              ) : col.items.length === 0 ? (
                <span style={tertiary}>No change.</span>
              ) : (
                col.items.map((d) => (
                  <div key={`${d.kind}:${d.name}`} style={{ display: 'grid', gridTemplateColumns: '62px minmax(0, 1fr)', gap: 8, alignItems: 'start' }}>
                    <span style={tagStyle(d.kind)}>{DIFF_TAG[d.kind]}</span>
                    <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                      <span style={{ ...mono, fontSize: 12.5, overflowWrap: 'anywhere' }}>{d.name}</span>
                      <span style={{ fontSize: 12, lineHeight: '17px', color: 'var(--text-secondary)' }}>{d.note}</span>
                    </span>
                  </div>
                ))
              )}
            </div>
          ))}
        </div>
      ) : (
        <div style={{ padding: '12px 16px', fontSize: 12.5, color: 'var(--text-secondary)' }}>
          Running the latest version — nothing to update to.
        </div>
      )}
      <TrafficLine cmp={cmp} ids={[running?.id, target?.version.id]} />
    </div>
  );
}

/** The last 24h per version under the comparison — the numbers the older card led with. */
function TrafficLine({ cmp, ids }: { cmp: ReleaseComparison | null; ids: Array<string | undefined> }) {
  if (!cmp) return null;
  const foot: CSSProperties = { padding: '10px 16px', borderTop: '1px solid var(--border-subtle)', fontSize: 12, color: 'var(--text-tertiary)' };
  // Traffic is the builder's to see. For an installed app the numbers are absent, not
  // zero, and the line says so in words rather than showing a confident 0.
  if (!cmp.owned) return <div style={foot}>Traffic per version belongs to the team that publishes this vertical, so the numbers stay with them.</div>;
  if (!cmp.metricsAvailable) return <div style={foot}>Traffic per version is unavailable on this plane.</div>;
  const sides = [cmp.running, cmp.update].filter((s): s is ReleaseSide => !!s && ids.includes(s.versionId));
  if (sides.length === 0) return null;
  const ms = (v: number | null) => (v === null ? '—' : `${v.toFixed(1)} ms`);
  const rate = (s: ReleaseSide) => {
    if (s.requests === null || s.errors === null) return '—';
    if (s.requests === 0) return 'no traffic';
    return `${((s.errors / s.requests) * 100).toFixed(1)}%`;
  };
  return (
    <div style={{ ...foot, display: 'flex', gap: 20, flexWrap: 'wrap', alignItems: 'baseline' }}>
      <span>Last 24h, fleet-wide per version</span>
      {sides.map((s) => (
        <span key={s.versionId} style={{ ...mono, color: 'var(--text-secondary)', display: 'flex', gap: 10 }}>
          <span style={{ color: 'var(--text-primary)' }}>{s.version ?? s.versionId.slice(-6)}</span>
          <span>{s.requests === null ? '—' : `${s.requests.toLocaleString()} req`}</span>
          <span style={{ color: s.errors ? 'var(--status-danger-fg)' : undefined }}>{rate(s)} err</span>
          <span title="CPU p50 / p99, busiest script">{ms(s.cpuTimeP50)} / {ms(s.cpuTimeP99)}</span>
        </span>
      ))}
    </div>
  );
}

const RELEASE_COLS = '96px 96px minmax(172px, 1.6fr) minmax(0, 1fr) 56px';

/**
 * The Releases list (#1767): pushed and went live as two columns, because they are two
 * instants — a version can be pushed and never go live, or go live and be rolled back
 * minutes later, and a single "deployed at" hides both. A row opens its entry in the
 * version table below, where the Bind and Assets actions live.
 */
export function ReleasesCard({ ledger, onPick }: { ledger: Ledger | null; onPick: (versionId: string) => void }) {
  const shown = ledger?.rows.slice(0, 8) ?? [];
  const note: CSSProperties = { padding: '10px 16px', borderTop: '1px solid var(--border-subtle)', ...tertiary, lineHeight: '17px' };
  return (
    <div style={panel}>
      <div style={{ padding: '12px 16px', fontSize: 14, fontWeight: 600 }}>
        Releases <span style={{ fontWeight: 400, ...tertiary }}>· pushed and went live are separate instants</span>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: RELEASE_COLS, gap: '0 10px', alignItems: 'center', height: 30, padding: '0 16px', borderTop: '1px solid var(--border-subtle)', ...columnHead }}>
        <span>Version</span><span>Pushed</span><span>Went live</span><span>By</span><span style={{ textAlign: 'right' }}>Installs</span>
      </div>
      {ledger === null && <div style={note}>Loading…</div>}
      {ledger &&
        shown.map((r) => {
          const { text, color } = liveCell(r, ledger.source);
          return (
            <a
              key={r.versionId}
              href={`#version-${r.versionId}`}
              data-release={r.version}
              onClick={(e) => {
                e.preventDefault();
                onPick(r.versionId);
              }}
              className="release-row"
              style={{ display: 'grid', gridTemplateColumns: RELEASE_COLS, gap: '0 10px', alignItems: 'center', height: 40, padding: '0 16px', borderTop: '1px solid var(--border-subtle)', color: 'var(--text-primary)', textDecoration: 'none', cursor: 'pointer' }}
            >
              <span style={{ ...mono, fontSize: 12.5, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={r.version}>{r.version}</span>
              <span style={{ ...mono, fontSize: 12, color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>{r.pushedAt ? instant(r.pushedAt) : '—'}</span>
              <span data-live style={{ ...mono, fontSize: 12, color, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{text}</span>
              <span style={{ ...mono, fontSize: 12, color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={r.actor ?? undefined}>{r.actor ?? '—'}</span>
              <span data-installs style={{ ...mono, fontSize: 12, textAlign: 'right' }}>{r.installs ? `${r.installs.on} / ${r.installs.total}` : '—'}</span>
            </a>
          );
        })}
      {ledger && ledger.rows.length === 0 && <div style={note}>No versions pushed yet.</div>}
      {ledger && ledger.source === 'registry' && (
        <div style={note}>
          {ledger.failed
            ? 'The release record could not be read, so go-live instants, who moved prod and installs are unknown here.'
            : 'Go-live instants, who moved prod and installs are the publishing team’s record; this app sees the pushes.'}
        </div>
      )}
      <style>{'.release-row:hover { background: var(--surface-hover); }'}</style>
    </div>
  );
}

/** The went-live cell: an instant, a rollback in words, or why there is no instant. */
export function liveCell(r: LedgerRow, source: Ledger['source']): { text: string; color: string } {
  if (r.rolledBackAfterMs !== null) return { text: `rolled back after ${span(r.rolledBackAfterMs)}`, color: 'var(--status-warning-fg)' };
  if (r.wentLiveAt) {
    const suffix = r.restored ? ' · restored' : r.liveAfterMs !== null ? ` · +${span(r.liveAfterMs)}` : '';
    return { text: `${instant(r.wentLiveAt)}${suffix}`, color: r.isProd ? 'var(--text-primary)' : 'var(--text-secondary)' };
  }
  // The registry view knows WHICH version prod points at, only not since when.
  if (source === 'registry') return { text: r.isProd ? 'in prod' : '—', color: 'var(--text-secondary)' };
  return { text: 'not live', color: 'var(--text-tertiary)' };
}

const SCHEMA_COLS = 'minmax(0, 1fr) 40px 60px 128px';

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
 * noise. Rows touched and duration have columns because the design asks what a
 * migration cost; nothing records either yet (#1763), so both read "—".
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
  const note: CSSProperties = { padding: '10px 16px', borderTop: '1px solid var(--border-subtle)', ...tertiary, lineHeight: '17px' };

  return (
    <div style={panel}>
      <div style={{ padding: '12px 16px', fontSize: 14, fontWeight: 600 }}>
        Schema history <span style={{ fontWeight: 400, ...tertiary }}>· migrations applied to this app, newest first</span>
      </div>
      {!view.available && (
        <div style={note}>
          Could not be read. The history is served by the deployment itself, so a version
          that predates the endpoint cannot answer — it appears after the next push.
        </div>
      )}
      {view.available && view.migrations.length === 0 && (
        <div style={note}>No migrations — this app&rsquo;s modules declare no schema of their own.</div>
      )}
      {shown.length > 0 && (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: SCHEMA_COLS, gap: '0 10px', alignItems: 'center', height: 30, padding: '0 16px', borderTop: '1px solid var(--border-subtle)', ...columnHead }}>
            <span>Migration</span>
            <span style={{ textAlign: 'right' }}>Rows</span>
            <span style={{ textAlign: 'right' }}>Duration</span>
            <span style={{ textAlign: 'right' }}>Applied</span>
          </div>
          {shown.map((m) => (
            <div
              key={`${m.moduleId}:${m.version}`}
              style={{ display: 'grid', gridTemplateColumns: SCHEMA_COLS, gap: '0 10px', alignItems: 'center', minHeight: 44, padding: '4px 16px', borderTop: '1px solid var(--border-subtle)' }}
            >
              <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                <span style={{ ...mono, fontSize: 12.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={m.version}>{m.version}</span>
                <span style={{ ...mono, fontSize: 11.5, color: 'var(--text-tertiary)' }}>{m.moduleId}</span>
              </span>
              <span style={{ ...mono, fontSize: 12, textAlign: 'right', color: 'var(--text-tertiary)' }}>—</span>
              <span style={{ ...mono, fontSize: 12, textAlign: 'right', color: 'var(--text-tertiary)' }}>—</span>
              <span style={{ ...mono, fontSize: 12, textAlign: 'right', color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>
                {m.appliedAt ? instant(m.appliedAt) : 'before we recorded'}
              </span>
            </div>
          ))}
          <div style={note}>Rows touched and duration are not recorded yet, so both read &ldquo;—&rdquo;.</div>
        </>
      )}
    </div>
  );
}
