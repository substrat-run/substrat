import { useEffect, useRef, useState } from 'react';
import { Button, Dialog, Input, Select, Tabs } from '@substrat-run/ui';
import { api, type AppRow, type AppEvent, type AppAuthChoice, type AppAuthView, type AppHostnameRow, type AppHostnamesView, type AppPermissionsView, type Deployment, type DumpTable, type MigrationBookmark, type PermissionRegistry, type PermissionRegistryEntry, type ScopeTable, type ScopeTablePage, type ScopeQueryResult, type AppEnvView, type SnapshotRow } from '../lib/api';
import { verticalMeta, APP_TABS, INTEGRATIONS, MOCK_SCOPE_TABLES, MOCK_SCOPE_TABLE_PAGES, MOCK_APP_ENV } from '../lib/demo';
import { DEV_MOCK, MOCK_APP_HOSTNAMES, MOCK_APP_PERMISSIONS, MOCK_DEPLOYMENTS, MOCK_SNAPSHOTS } from '../lib/mock';
import { relativeTime, shortDate, shortId } from '../lib/format';
import { Ic } from '../lib/icons';
import { Page } from '../components/layout';
import { card, CopyButton, Eyebrow, HonestyBanner, MonoTag, Pill, RowActions } from '../components/ui';
import { IntegrationCard } from './Integrations';

/**
 * App detail (screens 1i, 1j, 1k, 1l). The header and the Overview tab render REAL
 * fields from the app row; screens the platform does not back yet run on demo data
 * behind the design's honesty framing. Environment / Domains / Integrations are
 * sections inside Settings, so the tab bar stays five real nouns.
 */

/** Old tab URLs → their new home, so bookmarks and in-flight links keep working. */
const TAB_ALIASES: Record<string, string> = {
  snapshots: 'previews',
  env: 'settings/environment',
  domains: 'settings/domains',
  integrations: 'settings/integrations',
};

/** One visitable public URL — a surface the app fronts (K-26), or the lone default. */
type SurfaceUrl = { surface: string | null; label: string | null; hostname: string };

/**
 * One visitable URL per surface the app fronts (K-26): a vertical can serve several
 * surfaces, each with its own canonical hostname. Prefers the full binding set — each
 * surface's canonical active hostname — and falls back to the app row's single default
 * hostname while that's loading / when the endpoint isn't backed. The default surface
 * sorts first (it's the primary "Visit" target); the rest follow the vertical's declared
 * surface order.
 */
function deriveSurfaceUrls(hostnames: AppHostnamesView | null, fallbackHostname: string | null): SurfaceUrl[] {
  const active = (hostnames?.bindings ?? []).filter((b) => b.status === 'active');
  if (hostnames && active.length > 0) {
    const bySurface = new Map<string, AppHostnameRow[]>();
    for (const b of active) bySurface.set(b.surface, [...(bySurface.get(b.surface) ?? []), b]);
    const labelOf = (name: string) => hostnames.surfaces.find((s) => s.name === name)?.label ?? null;
    const defaultSurface = hostnames.bindings.find((b) => b.hostname === hostnames.defaultHostname)?.surface;
    const order = (name: string) => {
      if (name === defaultSurface) return -1;
      const i = hostnames.surfaces.findIndex((s) => s.name === name);
      return i < 0 ? Number.MAX_SAFE_INTEGER : i;
    };
    return [...bySurface.entries()]
      .sort(([a], [b]) => order(a) - order(b))
      .map(([name, list]) => ({
        surface: name as string | null,
        label: labelOf(name),
        hostname: (list.find((b) => b.canonical) ?? list[0]!).hostname,
      }));
  }
  return fallbackHostname ? [{ surface: null, label: null, hostname: fallbackHostname }] : [];
}

/**
 * The header's "Visit" control: a plain button for a single-surface app, a dropdown of
 * every surface's public URL when the vertical fronts more than one. Follows the popover
 * pattern used elsewhere (a fixed backdrop closes on outside click; the menu is anchored
 * to the button).
 */
function VisitControl({ surfaces }: { surfaces: SurfaceUrl[] }) {
  const [open, setOpen] = useState(false);
  if (surfaces.length === 0) return null;
  if (surfaces.length === 1) {
    const only = surfaces[0]!;
    return <Button onClick={() => window.open(`https://${only.hostname}`, '_blank')}>Visit ↗</Button>;
  }
  return (
    <div style={{ position: 'relative', display: 'inline-flex' }}>
      <Button onClick={() => setOpen((o) => !o)}>Visit ▾</Button>
      {open && (
        <>
          <div onClick={() => setOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 150 }} />
          <div style={{ position: 'absolute', top: 'calc(100% + 6px)', right: 0, zIndex: 151, minWidth: 260, background: 'var(--surface-card)', border: '1px solid var(--border-default)', borderRadius: 10, boxShadow: 'var(--shadow-popover)', overflow: 'hidden', padding: 4 }}>
            {surfaces.map((s) => (
              <button
                key={s.hostname}
                type="button"
                onClick={() => {
                  window.open(`https://${s.hostname}`, '_blank');
                  setOpen(false);
                }}
                style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', padding: '8px 10px', border: 0, borderRadius: 6, background: 'none', cursor: 'pointer', textAlign: 'left' }}
                onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--surface-inset)')}
                onMouseLeave={(e) => (e.currentTarget.style.background = 'none')}
              >
                <div style={{ display: 'flex', flexDirection: 'column', gap: 1, flex: 1, minWidth: 0 }}>
                  <span style={{ fontSize: 13, color: 'var(--text-primary)' }}>{s.label ?? s.surface}</span>
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11.5, color: 'var(--text-tertiary)', overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>{s.hostname}</span>
                </div>
                <Ic name="external" size={12} />
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

export function AppDetail({
  app,
  tab,
  onTab,
  onDeleted,
  authServers = [],
}: {
  app: AppRow;
  tab: string;
  onTab: (t: string) => void;
  onDeleted: () => void;
  /** The team's active Auth Server apps — offered as issuers on the Settings Identity card. */
  authServers?: AppRow[];
}) {
  const meta = verticalMeta(app.vertical_slug);
  const statusKind = app.status === 'provisioning' ? 'info' : app.status === 'failed' ? 'danger' : 'success';
  const statusLabel = app.status === 'provisioning' ? 'Provisioning' : app.status === 'failed' ? 'Failed' : 'Active';
  const [main, sub] = (TAB_ALIASES[tab] ?? tab).split('/');

  // The app's surface hostnames (K-26): the header's Visit control and the Overview
  // Production card both list a URL per surface, so the fetch lives here — one source,
  // shared down. Null while loading / when the endpoint isn't backed → the derivation
  // falls back to the app row's single default hostname.
  const [hostnames, setHostnames] = useState<AppHostnamesView | null>(null);
  useEffect(() => {
    if (DEV_MOCK) {
      setHostnames(MOCK_APP_HOSTNAMES);
      return;
    }
    let live = true;
    setHostnames(null);
    api
      .appHostnames(app.app_scope_id)
      .then((v) => live && setHostnames(v))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [app.app_scope_id]);
  const surfaceUrls = deriveSurfaceUrls(hostnames, app.hostname);

  return (
    <Page>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <span style={{ width: 10, height: 10, borderRadius: '50%', background: meta.accent }} />
        <span style={{ fontSize: 22, fontWeight: 600, letterSpacing: '-0.02em', color: 'var(--text-primary)' }}>{app.name}</span>
        <button type="button" aria-label="Rename" style={{ border: 0, background: 'none', color: 'var(--text-tertiary)', cursor: 'pointer', display: 'inline-flex', padding: 0 }}>
          <Ic name="pencil" size={14} />
        </button>
        <Pill kind={statusKind} pulse={app.status === 'provisioning'}>{statusLabel}</Pill>
        <div style={{ flex: 1 }} />
        <VisitControl surfaces={surfaceUrls} />
        <button type="button" aria-label="More actions" style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 32, height: 32, borderRadius: 6, border: '1px solid var(--border-default)', background: 'var(--surface-card)', color: 'var(--text-secondary)', cursor: 'pointer' }}>
          <Ic name="dots" size={16} />
        </button>
      </div>

      <Tabs
        tabs={APP_TABS.map((t) => ({ value: t.value, label: t.label, ...(t.count !== undefined ? { count: t.count } : {}) }))}
        value={main}
        onChange={onTab}
      />

      {main === 'overview' && <Overview app={app} meta={meta} statusKind={statusKind} statusLabel={statusLabel} surfaceUrls={surfaceUrls} />}
      {main === 'data' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <DataBrowser app={app} />
          <ExportImport app={app} />
        </div>
      )}
      {main === 'deployments' && <Deployments app={app} />}
      {main === 'permissions' && <Permissions app={app} />}
      {main === 'previews' && <Previews app={app} />}
      {main === 'settings' && (
        <Settings
          app={app}
          section={sub ?? 'general'}
          onSection={(s) => onTab(s === 'general' ? 'settings' : `settings/${s}`)}
          onDeleted={onDeleted}
          authServers={authServers}
        />
      )}
    </Page>
  );
}

function KV({ label, children, last }: { label: string; children: React.ReactNode; last?: boolean }) {
  const cell = { padding: '8px 0', borderBottom: last ? 'none' : '1px solid var(--border-subtle)' } as const;
  return (
    <>
      <span style={{ ...cell, color: 'var(--text-tertiary)' }}>{label}</span>
      <span style={{ ...cell, color: 'var(--text-primary)', display: 'flex', alignItems: 'center', gap: 8 }}>{children}</span>
    </>
  );
}

function Overview({ app, meta, statusKind, statusLabel, surfaceUrls }: { app: AppRow; meta: { label: string; accent: string }; statusKind: 'success' | 'info' | 'danger'; statusLabel: string; surfaceUrls: SurfaceUrl[] }) {
  const mono = { fontFamily: 'var(--font-mono)', fontSize: 12.5 } as const;
  // The app's REAL audit trail (created / active / failed+reason / deleted). Dev-preview
  // shows a representative sample; a live deploy reads it from the worker.
  const [events, setEvents] = useState<AppEvent[] | null>(null);
  // The app's REAL running version (the version its scope is bound to — what the router
  // serves), not a hardcoded label. Same source as the Deployments tab.
  const [dep, setDep] = useState<Deployment | null>(null);
  useEffect(() => {
    if (DEV_MOCK) {
      setEvents(mockEventsFor(app));
      setDep(MOCK_DEPLOYMENTS[0] ?? null);
      return;
    }
    let live = true;
    api
      .appEvents(app.app_scope_id)
      .then((e) => live && setEvents(e))
      .catch(() => live && setEvents([]));
    api
      .appDeployments(app.app_scope_id)
      .then((d) => live && setDep(d))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [app.app_scope_id]);
  // The version the app actually runs: its scope's bound version (fall back to the prod
  // channel only when unpinned). '…' while loading; '—' when nothing is deployed.
  const prodVersionId = dep?.channels.find((c) => c.channel === 'prod')?.versionId;
  const runningVersion = dep
    ? dep.versions.find((v) => v.id === (dep.boundVersionId ?? prodVersionId))
    : undefined;
  const versionLabel = runningVersion ? `v${runningVersion.version}` : dep ? '—' : '…';
  const updateAvailable = !!dep && !!prodVersionId && prodVersionId !== dep.boundVersionId;
  // One visitable URL per surface (K-26), derived once by the parent and shared with the
  // header's Visit control — see deriveSurfaceUrls.
  const multiSurface = surfaceUrls.length > 1;
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 320px', gap: 16, alignItems: 'start' }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div style={{ ...card, padding: 20 }}>
          <div style={{ display: 'grid', gridTemplateColumns: '140px 1fr', fontSize: 13 }}>
            <KV label="Vertical"><span>{meta.label}</span><MonoTag color="var(--layer-vertical)">vertical</MonoTag></KV>
            <KV label="Version">
              <span style={mono}>{versionLabel}</span>
              {updateAvailable && <Pill kind="info">update available</Pill>}
            </KV>
            <KV label="Status"><Pill kind={statusKind}>{statusLabel}</Pill></KV>
            <KV label="Created"><span>{shortDate(app.created_at)}</span></KV>
            <KV label="Created by"><span style={mono}>{app.created_by}</span></KV>
            <KV label="Scope id" last>
              <span style={mono} title={app.app_scope_id}>{shortId(app.app_scope_id)}</span>
              <CopyButton text={app.app_scope_id} label="Copy scope id" />
            </KV>
          </div>
        </div>
        <div style={{ ...card, padding: 20, display: 'flex', flexDirection: 'column', gap: 12 }}>
          <Eyebrow>Production</Eyebrow>
          {app.hostname ? (
            <>
              {surfaceUrls.map((s) => (
                <div key={s.hostname} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 8, height: 32, padding: '0 10px', background: 'var(--surface-inset)', border: '1px solid var(--border-subtle)', borderRadius: 6, ...mono, color: 'var(--text-primary)', overflow: 'hidden' }}>
                    {multiSurface && s.surface && <MonoTag color="var(--text-tertiary)">{s.surface}</MonoTag>}
                    <span style={{ overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>{s.hostname}</span>
                    {multiSurface && s.label && <span style={{ fontSize: 12, fontFamily: 'var(--font-sans)', color: 'var(--text-tertiary)' }}>{s.label}</span>}
                  </span>
                  <IconBox label={`Copy ${s.surface ?? 'hostname'} URL`}><CopyButton text={s.hostname} size={14} /></IconBox>
                  <Button variant="secondary" onClick={() => window.open(`https://${s.hostname}`, '_blank')}>Visit ↗</Button>
                </div>
              ))}
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 8, height: 32, padding: '0 10px', background: 'var(--surface-inset)', border: '1px solid var(--border-subtle)', borderRadius: 6, ...mono, color: 'var(--text-primary)', overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>{`https://${app.hostname}/openapi.json`}</span>
                <IconBox label="Copy OpenAPI URL"><CopyButton text={`https://${app.hostname}/openapi.json`} size={14} /></IconBox>
                <Button variant="secondary" onClick={() => window.open(`https://${app.hostname}/api/docs`, '_blank')}>API docs ↗</Button>
              </div>
              <div style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>
                Running <span style={{ fontFamily: 'var(--font-mono)' }}>{versionLabel}</span>
                {updateAvailable && <> · <a href={`#/apps/${app.app_scope_id}/deployments`} style={{ color: 'var(--text-brand)' }}>update available →</a></>}
                {' · '}the API reference rides the app&rsquo;s own session — sign in to the app first.
              </div>
            </>
          ) : (
            <div style={{ fontSize: 12.5, color: 'var(--text-tertiary)' }}>A hostname is assigned once provisioning completes.</div>
          )}
        </div>
      </div>
      <div style={{ ...card, padding: 20, display: 'flex', flexDirection: 'column' }}>
        <Eyebrow style={{ paddingBottom: 12 }}>Activity</Eyebrow>
        {events === null ? (
          <div style={{ fontSize: 12.5, color: 'var(--text-tertiary)' }}>Loading activity…</div>
        ) : events.length === 0 ? (
          <div style={{ fontSize: 12.5, color: 'var(--text-tertiary)' }}>No activity recorded yet.</div>
        ) : (
          <Timeline items={events.map(toTimelineItem)} />
        )}
      </div>
    </div>
  );
}

type TimelineDot = 'success' | 'info' | 'neutral' | 'danger';

/** An app-event → a timeline row. `failed` carries the reason (the whole point of the audit trail). */
function toTimelineItem(e: AppEvent): { dot: TimelineDot; body: React.ReactNode; time: string } {
  const time = relativeTime(e.created_at);
  switch (e.kind) {
    case 'active':
      return { dot: 'success', body: <>App active{e.detail ? <> · <span style={{ fontFamily: 'var(--font-mono)' }}>{e.detail}</span></> : null}</>, time };
    case 'failed':
      return { dot: 'danger', body: <>Provisioning failed{e.detail ? <> — {e.detail}</> : null}</>, time };
    case 'deleted':
      return { dot: 'neutral', body: <>Deleted</>, time };
    case 'updated':
      return { dot: 'success', body: <>Updated{e.detail ? <> · <span style={{ fontFamily: 'var(--font-mono)' }}>{e.detail}</span></> : null}</>, time };
    case 'snapshotted':
      return { dot: 'info', body: <>Test copy taken{e.detail ? <> · {e.detail}</> : null}</>, time };
    case 'snapshot-deleted':
      return { dot: 'neutral', body: <>Test copy deleted{e.detail ? <> · <span style={{ fontFamily: 'var(--font-mono)' }}>{e.detail}</span></> : null}</>, time };
    case 'data-exported':
      return { dot: 'info', body: <>Data exported{e.detail ? <> · {e.detail}</> : null}</>, time };
    case 'data-restored':
      return { dot: 'danger', body: <>Data replaced by import{e.detail ? <> · {e.detail}</> : null}</>, time };
    case 'created':
    default:
      return { dot: 'info', body: <>Provisioning started{e.detail ? <> · <span style={{ fontFamily: 'var(--font-mono)' }}>{e.detail}</span></> : null}</>, time };
  }
}

/** Dev-preview sample so the panel isn't empty without a backend. */
function mockEventsFor(app: AppRow): AppEvent[] {
  const base = { app_scope_id: app.app_scope_id, actor: app.created_by };
  const events: AppEvent[] = [{ ...base, id: 'e1', kind: 'created', detail: app.vertical_slug, created_at: app.created_at }];
  if (app.status === 'active') events.unshift({ ...base, id: 'e2', kind: 'active', detail: app.hostname, created_at: app.created_at });
  if (app.status === 'failed') events.unshift({ ...base, id: 'e2', kind: 'failed', detail: 'no deployment is bound for vertical', created_at: app.created_at });
  return events;
}

function Timeline({ items }: { items: Array<{ dot: TimelineDot; body: React.ReactNode; time: string }> }) {
  const dotColor = { success: 'var(--status-success-dot)', info: 'var(--status-info-dot)', neutral: 'var(--status-neutral-dot)', danger: 'var(--status-danger-dot)' };
  return (
    <>
      {items.map((it, i) => (
        <div key={i} style={{ display: 'flex', gap: 10 }}>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
            <span style={{ width: 7, height: 7, borderRadius: '50%', background: dotColor[it.dot], marginTop: 5 }} />
            {i < items.length - 1 && <span style={{ width: 1, flex: 1, background: 'var(--border-default)' }} />}
          </div>
          <div style={{ paddingBottom: i < items.length - 1 ? 14 : 0 }}>
            <div style={{ fontSize: 12.5, color: 'var(--text-primary)' }}>{it.body}</div>
            <div style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>{it.time}</div>
          </div>
        </div>
      ))}
    </>
  );
}

function Deployments({ app }: { app: AppRow }) {
  const [dep, setDep] = useState<Deployment | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const [updating, setUpdating] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  // Fork-before-promote (default ON): snapshot the app's data before a migration-
  // crossing update, so a bad upgrade has a rollback point. A code-only update
  // snapshots nothing — the platform compares migration digests, not the checkbox.
  const [snapFirst, setSnapFirst] = useState(true);
  // #286: pre-migration rewind points, offered as a time-boxed backout. Fresh =
  // within the 24h window the platform will actually honor without force.
  const [bookmarks, setBookmarks] = useState<MigrationBookmark[]>([]);
  useEffect(() => {
    if (DEV_MOCK) {
      setDep(MOCK_DEPLOYMENTS[0] ?? null);
      return;
    }
    let live = true;
    api
      .appDeployments(app.app_scope_id)
      .then((d) => live && setDep(d))
      .catch((e) => live && setErr(e instanceof Error ? e.message : String(e)));
    api
      .appBookmarks(app.app_scope_id)
      .then((b) => live && setBookmarks(b))
      .catch(() => undefined); // no bookmarks surface (embedded/dev) → simply no backout offer
    return () => {
      live = false;
    };
  }, [app.app_scope_id, nonce]);

  if (err) return <div style={{ ...card, padding: 20, fontSize: 13, color: 'var(--status-danger-fg)' }}>Couldn’t load deployments — {err}</div>;
  if (!dep) return <div style={{ ...card, padding: 20, fontSize: 13, color: 'var(--text-tertiary)' }}>Loading deployments…</div>;

  const channelsOf = (versionId: string) => dep.channels.filter((c) => c.versionId === versionId).map((c) => c.channel);
  const prod = dep.channels.find((c) => c.channel === 'prod');
  const prodVersion = prod ? dep.versions.find((v) => v.id === prod.versionId) : undefined;
  // What the app ACTUALLY runs is the version its scope is pinned to (the router dispatches
  // on it), NOT the vertical's prod channel — they diverge when prod moved after install.
  // Fall back to the prod version only when the scope is unpinned (static binding).
  const bound = dep.boundVersionId ? dep.versions.find((v) => v.id === dep.boundVersionId) : undefined;
  const running = bound ?? (dep.boundVersionId == null ? prodVersion : undefined);
  // An update is offered when prod points somewhere other than where this scope is pinned.
  const updateAvailable = !!prod && prod.versionId !== dep.boundVersionId;
  // Owned + private ⇒ prod promotion is self-serve (Verticals page); listed hands prod
  // back to staff, and someone else's vertical was never this team's to promote.
  const selfServe = !!dep.owned && !dep.listed;
  // The stuck state this tab must not leave unexplained: the newest admitted version
  // isn't what prod points at, so no update can be offered until someone promotes it.
  const newestAdmitted = dep.versions.find((v) => v.admission === 'admitted');
  const awaitingPromotion = !updateAvailable && !!newestAdmitted && newestAdmitted.id !== prod?.versionId;
  // Prod was promoted but its in-place serve failed (#321): the channel points at a version
  // the scopes are NOT running. Surface it — this is exactly the silent state the field
  // report spent a migration-journal diff to uncover.
  const serveStalled = !!prod && prod.servingVersionId != null && prod.servingVersionId !== prod.versionId;
  const promotedVersion = serveStalled ? dep.versions.find((v) => v.id === prod!.versionId) : undefined;
  const servingVersion = serveStalled ? dep.versions.find((v) => v.id === prod!.servingVersionId) : undefined;
  const COLS = '1fr 1.2fr 1.6fr 1.4fr';

  const doUpdate = async () => {
    setUpdating(true);
    setNote(null);
    try {
      const r = await api.updateApp(app.app_scope_id, { snapshot: snapFirst });
      setNote(r.updated ? `Updated ${r.previousVersion ?? '—'} → ${r.version ?? ''}` : 'Already on the latest version.');
      setNonce((n) => n + 1); // refetch so Running + the table reflect the rebind
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e));
    } finally {
      setUpdating(false);
    }
  };

  const doRewind = async (bookmark: MigrationBookmark) => {
    // The honest contract, spelled out at the moment of choice (#286): PITR rewinds
    // the WHOLE database, so everything written since the bookmark is discarded.
    const ok = window.confirm(
      `Rewind this app's data to before its last migration (${relativeTime(bookmark.takenAt)})?\n\n` +
        `EVERY change made since then will be discarded — schema and data. ` +
        `This is a first-hours backout for a bad update; for anything older, restore a snapshot instead.`,
    );
    if (!ok) return;
    setUpdating(true);
    setNote(null);
    try {
      await api.rewindApp(app.app_scope_id, bookmark.bookmark);
      setNote('Rewinding — the app restarts on its pre-migration data in a few seconds.');
      setBookmarks([]);
      setNonce((n) => n + 1);
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e));
    } finally {
      setUpdating(false);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ ...card, padding: 20, display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <Eyebrow>Running</Eyebrow>
        {running ? (
          <>
            <MonoTag>{running.version}</MonoTag>
            <span style={{ fontSize: 12.5, color: 'var(--text-tertiary)' }}>
              {bound ? <>this app is pinned to it</> : <>via the <b>prod</b> channel</>} of <MonoTag>{dep.displaySlug}</MonoTag>
            </span>
          </>
        ) : (
          <span style={{ fontSize: 12.5, color: 'var(--text-tertiary)' }}>Not serving a registry version yet — a pushed version must be admitted and promoted.</span>
        )}
        <div style={{ flex: 1 }} />
        {awaitingPromotion && (
          <span style={{ fontSize: 12, color: 'var(--status-info-fg)' }}>
            <MonoTag>{newestAdmitted.version}</MonoTag> is admitted but not in <b>prod</b>
            {selfServe ? (
              <> — <a href="#/verticals" style={{ color: 'var(--text-brand)' }}>promote it on Verticals →</a></>
            ) : (
              <> — the Substrat team promotes it</>
            )}
          </span>
        )}
        {updateAvailable && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            {prodVersion && <span style={{ fontSize: 12, color: 'var(--status-info-fg)' }}>Update available → <MonoTag>{prodVersion.version}</MonoTag></span>}
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--text-secondary)', cursor: 'pointer' }}>
              <input type="checkbox" checked={snapFirst} onChange={(e) => setSnapFirst(e.target.checked)} />
              Snapshot data first
            </label>
            <Button onClick={doUpdate} disabled={updating}>{updating ? 'Updating…' : 'Update to latest'}</Button>
          </div>
        )}
      </div>
      {serveStalled && (
        <div style={{ ...card, padding: '12px 16px', display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', borderColor: 'var(--status-danger-fg)' }}>
          <Pill kind="warning">serve failed</Pill>
          <span style={{ fontSize: 12.5, color: 'var(--text-secondary)' }}>
            <b>prod</b> was promoted to <MonoTag>{promotedVersion?.version ?? prod!.versionId}</MonoTag> but its in-place
            serve failed — your app still runs <MonoTag>{servingVersion?.version ?? prod!.servingVersionId}</MonoTag>.
            {selfServe ? (
              <> Re-promote on <a href="#/verticals" style={{ color: 'var(--text-brand)' }}>Verticals →</a> to retry the serve.</>
            ) : (
              <> The Substrat team can re-promote it to retry.</>
            )}
          </span>
        </div>
      )}
      {note && <div style={{ ...card, padding: '10px 16px', fontSize: 12.5, color: 'var(--text-secondary)' }}>{note}</div>}
      {(() => {
        // The time-boxed backout offer (#286): shown only while the newest
        // pre-migration bookmark is inside the 24h window the platform honors.
        const fresh = bookmarks.find((b) => Date.now() - Date.parse(b.takenAt) < 24 * 60 * 60 * 1000);
        if (!fresh) return null;
        return (
          <div style={{ ...card, padding: '12px 16px', display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <Pill kind="warning">migrated {relativeTime(fresh.takenAt)}</Pill>
            <span style={{ fontSize: 12.5, color: 'var(--text-secondary)' }}>
              A migration ran {relativeTime(fresh.takenAt)} ({fresh.pending.length} step{fresh.pending.length === 1 ? '' : 's'}).
              If the update went wrong you can rewind to just before it — every change since is discarded.
            </span>
            <div style={{ flex: 1 }} />
            <Button onClick={() => doRewind(fresh)} disabled={updating}>Back out</Button>
          </div>
        );
      })()}
      <HonestyBanner>
        {selfServe ? (
          <>Read live from the registry. “Running” is the version this app’s scope is pinned to — what the router serves. This vertical is yours: promote a version to <b>prod</b> on the <a href="#/verticals" style={{ color: 'inherit' }}>Verticals page</a>, then updating here rebinds this app to it.</>
        ) : (
          <>Read live from the registry. “Running” is the version this app’s scope is pinned to — what the router serves. Versions are managed by the Substrat team; promotion to prod is a staff action, and updating rebinds this app to the current prod version.</>
        )}
      </HonestyBanner>
      {dep.versions.length === 0 ? (
        <div style={{ ...card, padding: 20, fontSize: 13, color: 'var(--text-tertiary)' }}>No versions pushed to the registry yet.</div>
      ) : (
        <div style={{ ...card, overflow: 'hidden' }}>
          <div style={{ display: 'grid', gridTemplateColumns: COLS, alignItems: 'center', height: 36, padding: '0 16px', fontSize: 11, fontWeight: 500, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--text-tertiary)', borderBottom: '1px solid var(--border-subtle)' }}>
            <span>Version</span><span>Admission</span><span>Channels</span><span>Pushed</span>
          </div>
          {dep.versions.map((v, i) => {
            const chans = channelsOf(v.id);
            return (
              <div key={v.id} style={{ display: 'grid', gridTemplateColumns: COLS, alignItems: 'center', minHeight: 40, padding: '8px 16px', fontSize: 13, borderBottom: i === dep.versions.length - 1 ? 'none' : '1px solid var(--border-subtle)', background: v.id === dep.boundVersionId ? 'var(--surface-brand-subtle)' : 'transparent' }}>
                <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12.5 }}>{v.version}</span>
                  {v.id === dep.boundVersionId && <Pill kind="success">running</Pill>}
                  {v.schemaChange && <Pill kind="warning">schema change</Pill>}
                </span>
                <span><Pill kind={v.admission === 'admitted' ? 'success' : v.admission === 'rejected' ? 'danger' : 'warning'}>{v.admission}</Pill></span>
                <span style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  {chans.length === 0 ? <span style={{ color: 'var(--text-tertiary)' }}>—</span> : chans.map((ch) => <Pill key={ch} kind={ch === 'prod' ? 'success' : ch === 'staging' ? 'info' : 'neutral'}>{ch}</Pill>)}
                </span>
                <span style={{ color: 'var(--text-tertiary)', fontSize: 12 }}>{v.createdAt ? relativeTime(v.createdAt) : '—'}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** The role keys in one version's registry that hold a given permission key. */
function rolesHolding(reg: PermissionRegistry, key: string): string[] {
  return reg.roles.filter((r) => r.permissions.includes(key)).map((r) => r.key);
}

interface RegistryDiff {
  addedKeys: string[];
  removedKeys: string[];
  changedKeys: string[];
  /** Only roles that actually changed: gained/lost permissions, or appeared/vanished. */
  roleChanges: Array<{ key: string; added: string[]; removed: string[]; isNew: boolean; isGone: boolean }>;
}

/**
 * The version-to-version permission diff (#336): what the declared surface would gain, lose,
 * or re-describe if this app updated from `from` to `to`. The security-relevant signal is a
 * WIDENED role (one that gains permissions) or a genuinely new permission key — the reasons
 * the promotion checkpoint asks a human to look before an update lands.
 */
function diffRegistries(from: PermissionRegistry, to: PermissionRegistry): RegistryDiff {
  const fromKeys = new Map(from.permissions.map((p) => [p.key, p.description]));
  const toKeys = new Map(to.permissions.map((p) => [p.key, p.description]));
  const fromRoles = new Map(from.roles.map((r) => [r.key, r.permissions]));
  const toRoles = new Map(to.roles.map((r) => [r.key, r.permissions]));
  const roleChanges: RegistryDiff['roleChanges'] = [];
  for (const key of new Set([...fromRoles.keys(), ...toRoles.keys()])) {
    const before = fromRoles.get(key);
    const after = toRoles.get(key);
    const added = (after ?? []).filter((p) => !(before ?? []).includes(p));
    const removed = (before ?? []).filter((p) => !(after ?? []).includes(p));
    const isNew = !before && !!after;
    const isGone = !!before && !after;
    if (added.length || removed.length || isNew || isGone) roleChanges.push({ key, added, removed, isNew, isGone });
  }
  return {
    addedKeys: [...toKeys.keys()].filter((k) => !fromKeys.has(k)),
    removedKeys: [...fromKeys.keys()].filter((k) => !toKeys.has(k)),
    changedKeys: [...toKeys.entries()].filter(([k, d]) => fromKeys.has(k) && fromKeys.get(k) !== d).map(([k]) => k),
    roleChanges,
  };
}

/**
 * The Permissions tab (#336, D-39). The declared permission surface — keys, roles, and
 * entity-grant shapes — of the version this app RUNS, read live from the manifest registry;
 * plus, when an update is available, the version-to-version diff the permission-diff human
 * checkpoint exists to surface. It only DISPLAYS: approving a widened role stays a human
 * decision (the update itself is confirmed on the Deployments tab).
 */
function Permissions({ app }: { app: AppRow }) {
  const [view, setView] = useState<AppPermissionsView | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    if (DEV_MOCK) {
      setView(MOCK_APP_PERMISSIONS);
      return;
    }
    let live = true;
    setView(null);
    setErr(null);
    api
      .appPermissions(app.app_scope_id)
      .then((v) => live && setView(v))
      .catch((e) => live && setErr(e instanceof Error ? e.message : String(e)));
    return () => {
      live = false;
    };
  }, [app.app_scope_id]);

  if (err) return <div style={{ ...card, padding: 20, fontSize: 13, color: 'var(--status-danger-fg)' }}>Couldn’t load permissions — {err}</div>;
  if (!view) return <div style={{ ...card, padding: 20, fontSize: 13, color: 'var(--text-tertiary)' }}>Loading permissions…</div>;

  const reg = view.running.registry;
  const update = view.update;
  const diff = update?.registry && reg ? diffRegistries(reg, update.registry) : null;
  const diffChanged = !!diff && (diff.addedKeys.length > 0 || diff.removedKeys.length > 0 || diff.changedKeys.length > 0 || diff.roleChanges.length > 0);

  // Group the keys by declaring engine (declaredBy) — the console's §1 grouping, so a reader
  // sees "what does workorder let this app do" without re-deriving ownership from prefixes.
  const groups = new Map<string, PermissionRegistryEntry[]>();
  for (const p of reg?.permissions ?? []) {
    const label = p.declaredBy.join(', ') || '—';
    groups.set(label, [...(groups.get(label) ?? []), p]);
  }
  const COLS = '1.5fr 1.9fr 1fr';
  const mono = { fontFamily: 'var(--font-mono)', fontSize: 12 } as const;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ ...card, padding: 20, display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <Eyebrow>Declared permissions</Eyebrow>
        {view.running.version ? <MonoTag>{view.running.version}</MonoTag> : <span style={{ fontSize: 12.5, color: 'var(--text-tertiary)' }}>no running version</span>}
        <span style={{ fontSize: 12.5, color: 'var(--text-tertiary)' }}>the surface this app runs</span>
        <div style={{ flex: 1 }} />
        {update && <span style={{ fontSize: 12, color: 'var(--status-info-fg)' }}>Update available → <MonoTag>{update.version}</MonoTag></span>}
      </div>

      {update && (
        diffChanged ? (
          <div style={{ ...card, padding: 16, display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <Eyebrow>If you update</Eyebrow>
              <span style={{ fontSize: 12.5, color: 'var(--text-tertiary)' }}>
                <MonoTag>{view.running.version}</MonoTag> → <MonoTag>{update.version}</MonoTag> — review before updating on the <a href="#/apps" style={{ color: 'var(--text-brand)' }}>Deployments tab</a>
              </span>
            </div>
            {diff!.addedKeys.length > 0 && <DiffRow label="New permissions" kind="info">{diff!.addedKeys.map((k) => <MonoTag key={k}>{k}</MonoTag>)}</DiffRow>}
            {diff!.removedKeys.length > 0 && <DiffRow label="Removed" kind="danger">{diff!.removedKeys.map((k) => <MonoTag key={k}>{k}</MonoTag>)}</DiffRow>}
            {diff!.changedKeys.length > 0 && <DiffRow label="Description changed" kind="warning">{diff!.changedKeys.map((k) => <MonoTag key={k}>{k}</MonoTag>)}</DiffRow>}
            {diff!.roleChanges.map((rc) => (
              <div key={rc.key} style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <Pill kind={rc.isGone ? 'neutral' : rc.added.length > 0 ? 'warning' : rc.isNew ? 'info' : 'neutral'}>
                  {rc.isNew ? 'new role' : rc.isGone ? 'role removed' : rc.added.length > 0 ? 'role widened' : 'role narrowed'}
                </Pill>
                <MonoTag>{rc.key}</MonoTag>
                <span style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  {rc.added.map((p) => <span key={p} style={{ ...mono, color: 'var(--status-info-fg)' }}>+{p}</span>)}
                  {rc.removed.map((p) => <span key={p} style={{ ...mono, color: 'var(--status-danger-fg)' }}>−{p}</span>)}
                </span>
              </div>
            ))}
          </div>
        ) : (
          <div style={{ ...card, padding: '12px 16px', fontSize: 12.5, color: 'var(--text-secondary)' }}>
            Update to <MonoTag>{update.version}</MonoTag> available — {update.registry ? 'no change to the declared permission surface.' : 'its permission surface couldn’t be read (pushed before manifests were retained).'}
          </div>
        )
      )}

      {!reg ? (
        <div style={{ ...card, padding: 20, fontSize: 13, color: 'var(--text-tertiary)' }}>
          This version declares no permission surface{view.running.version ? '' : ' — no version is running yet'}. Verticals pushed before D-39, or those that declare no keys, ship no registry here.
        </div>
      ) : (
        <>
          {[...groups.entries()].map(([engine, perms]) => (
            <div key={engine} style={{ ...card, overflow: 'hidden' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, height: 40, padding: '0 16px', borderBottom: '1px solid var(--border-subtle)' }}>
                <Eyebrow>{engine}</Eyebrow>
                <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>{perms.length} permission{perms.length === 1 ? '' : 's'}</span>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: COLS, alignItems: 'center', height: 32, padding: '0 16px', fontSize: 11, fontWeight: 500, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--text-tertiary)', borderBottom: '1px solid var(--border-subtle)' }}>
                <span>Key</span><span>Description</span><span>Roles</span>
              </div>
              {perms.map((p, i) => {
                const holders = rolesHolding(reg, p.key);
                return (
                  <div key={p.key} style={{ display: 'grid', gridTemplateColumns: COLS, alignItems: 'center', minHeight: 40, padding: '8px 16px', fontSize: 13, borderBottom: i === perms.length - 1 ? 'none' : '1px solid var(--border-subtle)' }}>
                    <span style={mono}>{p.key}</span>
                    <span style={{ color: 'var(--text-secondary)', fontSize: 12.5 }}>{p.description}</span>
                    <span style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                      {holders.length === 0 ? <span style={{ color: 'var(--text-tertiary)' }}>grant only</span> : holders.map((r) => <Pill key={r} kind="neutral">{r}</Pill>)}
                    </span>
                  </div>
                );
              })}
            </div>
          ))}

          <div style={{ ...card, overflow: 'hidden' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, height: 40, padding: '0 16px', borderBottom: '1px solid var(--border-subtle)' }}>
              <Eyebrow>Roles</Eyebrow>
              <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>who holds what</span>
            </div>
            {reg.roles.length === 0 ? (
              <div style={{ padding: '14px 16px', fontSize: 12.5, color: 'var(--text-tertiary)' }}>This vertical declares no role templates.</div>
            ) : (
              reg.roles.map((r, i) => (
                <div key={r.key} style={{ display: 'flex', alignItems: 'flex-start', gap: 12, padding: '10px 16px', borderBottom: i === reg.roles.length - 1 ? 'none' : '1px solid var(--border-subtle)' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 140 }}>
                    <MonoTag>{r.key}</MonoTag>
                    {r.source !== 'vertical' && <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>{r.source}</span>}
                  </div>
                  <span style={{ display: 'flex', gap: 6, flexWrap: 'wrap', flex: 1 }}>
                    {r.permissions.map((p) => <span key={p} style={{ ...mono, color: 'var(--text-secondary)' }}>{p}</span>)}
                  </span>
                </div>
              ))
            )}
          </div>

          {reg.entityGrants.length > 0 && (
            <div style={{ ...card, overflow: 'hidden' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, height: 40, padding: '0 16px', borderBottom: '1px solid var(--border-subtle)' }}>
                <Eyebrow>Entity grant shapes</Eyebrow>
                <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>per-entity, minted at runtime</span>
              </div>
              {reg.entityGrants.map((g, i) => (
                <div key={g.entityType} style={{ display: 'flex', alignItems: 'flex-start', gap: 12, padding: '10px 16px', borderBottom: i === reg.entityGrants.length - 1 ? 'none' : '1px solid var(--border-subtle)' }}>
                  <div style={{ minWidth: 140 }}><MonoTag>{g.entityType}</MonoTag></div>
                  <span style={{ display: 'flex', gap: 6, flexWrap: 'wrap', flex: 1 }}>
                    {g.permissions.map((p) => <span key={p} style={{ ...mono, color: 'var(--text-secondary)' }}>{p}</span>)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      <HonestyBanner>
        Read live from the version’s manifest registry (D-39). This is the app’s <b>declared</b> permission surface — the keys and role templates the vertical ships. The per-entity <b>grants</b> themselves are minted at runtime and are not shown here (only their shapes). Approving a widened role is a human decision: it happens when you update on the <a href="#/apps" style={{ color: 'inherit' }}>Deployments tab</a>, not here.
      </HonestyBanner>
    </div>
  );
}

/** One labelled row of the update diff — a coloured pill and its affected keys. */
function DiffRow({ label, kind, children }: { label: string; kind: 'info' | 'danger' | 'warning'; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
      <Pill kind={kind}>{label}</Pill>
      <span style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>{children}</span>
    </div>
  );
}

/** "expires in 5d" / "expires today" — the countdown a TTL'd copy shows. */
function expiresIn(expiresAt: string | null): string {
  if (!expiresAt) return 'kept until deleted';
  const days = Math.ceil((Date.parse(expiresAt) - Date.now()) / 86_400_000);
  if (days <= 0) return 'expiring now';
  if (days === 1) return 'expires in 1 day';
  return `expires in ${days} days`;
}

const TTL_CHOICES = [
  { value: '1', label: '1 day' },
  { value: '7', label: '7 days' },
  { value: '30', label: '30 days' },
  { value: '0', label: 'Keep until deleted' },
] as const;

/**
 * The Previews tab (preview-and-snapshots.md §3): create a preview — a full copy of
 * the app's data to try things on — watch its expiry, delete it. A preview is
 * unmistakably NOT the live app — it never receives traffic, integrations are off,
 * and it expires unless kept; the banner says so in words. ("Snapshot" stays the
 * backend word for the data artifact; the user-facing instance is a preview.)
 */
function Previews({ app }: { app: AppRow }) {
  const [snaps, setSnaps] = useState<SnapshotRow[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const [creating, setCreating] = useState(false);
  const [ttl, setTtl] = useState('7');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    if (DEV_MOCK) {
      setSnaps(MOCK_SNAPSHOTS.filter((s) => s.forkedFrom === app.app_scope_id));
      return;
    }
    let live = true;
    api
      .appSnapshots(app.app_scope_id)
      .then((s) => live && setSnaps(s))
      .catch((e) => live && setErr(e instanceof Error ? e.message : String(e)));
    return () => {
      live = false;
    };
  }, [app.app_scope_id, nonce]);

  const doCreate = async () => {
    setCreating(true);
    setNote(null);
    try {
      if (DEV_MOCK) {
        setNote('Preview created (mock).');
      } else {
        const days = Number(ttl);
        await api.createSnapshot(app.app_scope_id, days > 0 ? { ttlDays: days } : {});
        setNote('Preview created.');
        setNonce((n) => n + 1);
      }
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e));
    } finally {
      setCreating(false);
    }
  };

  const doDelete = async (id: string) => {
    setBusyId(id);
    setNote(null);
    try {
      if (!DEV_MOCK) {
        await api.deleteSnapshot(app.app_scope_id, id);
        setNonce((n) => n + 1);
      }
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  };

  if (err) return <div style={{ ...card, padding: 20, fontSize: 13, color: 'var(--status-danger-fg)' }}>Couldn’t load previews — {err}</div>;
  if (!snaps) return <div style={{ ...card, padding: 20, fontSize: 13, color: 'var(--text-tertiary)' }}>Loading previews…</div>;

  const COLS = '1.2fr 2fr 1fr 1.2fr 1fr';
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ ...card, padding: 20, display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <Eyebrow>Previews</Eyebrow>
        <span style={{ fontSize: 12.5, color: 'var(--text-tertiary)' }}>
          A preview is a full copy of this app’s data at a moment in time — try things on it without touching the live app.
        </span>
        <div style={{ flex: 1 }} />
        <Select size="sm" value={ttl} onChange={(e) => setTtl(e.target.value)} options={TTL_CHOICES.map((t) => ({ value: t.value, label: t.label }))} style={{ width: 170 }} />
        <Button onClick={doCreate} disabled={creating}>{creating ? 'Creating…' : 'Create preview'}</Button>
      </div>
      {note && <div style={{ ...card, padding: '10px 16px', fontSize: 12.5, color: 'var(--text-secondary)' }}>{note}</div>}
      <HonestyBanner>A preview is not the live app: it receives no traffic, integrations are off, and it is deleted automatically when it expires. Previews contain real data — the same access rules apply.</HonestyBanner>
      {snaps.length === 0 ? (
        <div style={{ ...card, padding: 20, fontSize: 13, color: 'var(--text-tertiary)' }}>No previews yet.</div>
      ) : (
        <div style={{ ...card, overflow: 'hidden' }}>
          <div style={{ display: 'grid', gridTemplateColumns: COLS, alignItems: 'center', height: 36, padding: '0 16px', fontSize: 11, fontWeight: 500, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--text-tertiary)', borderBottom: '1px solid var(--border-subtle)' }}>
            <span>Preview</span><span>URL</span><span>Taken</span><span>Retention</span><span />
          </div>
          {snaps.map((s, i) => (
            <div key={s.id} style={{ display: 'grid', gridTemplateColumns: COLS, alignItems: 'center', minHeight: 44, padding: '8px 16px', fontSize: 13, borderBottom: i === snaps.length - 1 ? 'none' : '1px solid var(--border-subtle)' }}>
              <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <MonoTag>{shortId(s.id)}</MonoTag>
                <Pill kind="neutral">{s.kind}</Pill>
              </span>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {s.url ? (
                  <a href={`https://${s.url}`} target="_blank" rel="noreferrer" style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text-brand)', textDecoration: 'none' }}>
                    {s.url} ↗
                  </a>
                ) : (
                  <span style={{ color: 'var(--text-tertiary)', fontSize: 12 }}>—</span>
                )}
              </span>
              <span style={{ color: 'var(--text-tertiary)', fontSize: 12 }}>{s.forkedAt ? relativeTime(s.forkedAt) : '—'}</span>
              <span style={{ fontSize: 12 }}>
                <Pill kind={s.expiresAt ? 'warning' : 'neutral'}>{expiresIn(s.expiresAt)}</Pill>
              </span>
              <span style={{ display: 'flex', justifyContent: 'flex-end' }}>
                <Button variant="ghost" onClick={() => doDelete(s.id)} disabled={busyId === s.id}>
                  {busyId === s.id ? 'Deleting…' : 'Delete'}
                </Button>
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Export & import (preview-and-snapshots.md §8 — the dashboard half of the CLI's
 * `scope pull`/`scope restore`). Export downloads the app's data as a `.dump.json`
 * the CLI accepts; Import replaces the app's data with an uploaded dump — behind a
 * danger dialog, and always after the platform forks a safety preview (visible in
 * the Previews tab).
 */
function ExportImport({ app }: { app: AppRow }) {
  const [exporting, setExporting] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [pending, setPending] = useState<{ name: string; tables: DumpTable[]; rows: number } | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const doExport = async () => {
    setExporting(true);
    setNote(null);
    try {
      if (DEV_MOCK) {
        setNote('Export is not available in the preview.');
        return;
      }
      const dump = await api.exportAppData(app.app_scope_id);
      const blob = new Blob([JSON.stringify(dump, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `${dump.tenantId}__${dump.scopeId}.dump.json`;
      a.click();
      URL.revokeObjectURL(a.href);
      const rows = dump.tables.reduce((n, t) => n + t.rows.length, 0);
      setNote(
        dump.masked
          ? `Exported ${dump.tables.length} tables (${rows} rows). Personal data is redacted in this file — full-fidelity export is a CLI/staff affordance.`
          : `Exported ${dump.tables.length} tables (${rows} rows), full fidelity — treat the file as production data.`,
      );
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e));
    } finally {
      setExporting(false);
    }
  };

  const onFile = async (file: File | undefined) => {
    setNote(null);
    if (!file) return;
    try {
      const parsed = JSON.parse(await file.text()) as { tables?: DumpTable[] };
      if (!Array.isArray(parsed.tables) || parsed.tables.length === 0) {
        throw new Error(`${file.name} is not a scope dump (no tables) — expected a .dump.json export`);
      }
      const rows = parsed.tables.reduce((n, t) => n + (Array.isArray(t.rows) ? t.rows.length : 0), 0);
      setPending({ name: file.name, tables: parsed.tables, rows });
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e));
    } finally {
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const doRestore = async () => {
    if (!pending) return;
    setRestoring(true);
    setNote(null);
    try {
      if (DEV_MOCK) {
        setNote('Import is not available in the preview.');
      } else {
        const r = await api.restoreAppData(app.app_scope_id, pending.tables);
        setNote(`Imported ${r.tables} tables — the app now serves the uploaded data. The previous data lives on as preview ${shortId(r.safetyCopyId)} in the Previews tab.`);
      }
      setPending(null);
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e));
    } finally {
      setRestoring(false);
    }
  };

  return (
    <div style={{ ...card, padding: 20, display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <Eyebrow>Export &amp; import</Eyebrow>
        <span style={{ fontSize: 12.5, color: 'var(--text-tertiary)' }}>
          Download this app’s data, or replace it with a dump — an export from here, <span style={{ fontFamily: 'var(--font-mono)' }}>substrat scope pull</span>, or a local dev world (<span style={{ fontFamily: 'var(--font-mono)' }}>.dump.json</span>; for <span style={{ fontFamily: 'var(--font-mono)' }}>.sqlite</span> files use <span style={{ fontFamily: 'var(--font-mono)' }}>substrat scope restore</span>).
        </span>
        <div style={{ flex: 1 }} />
        <Button onClick={doExport} disabled={exporting}>{exporting ? 'Exporting…' : 'Export data'}</Button>
        <Button variant="secondary" onClick={() => fileRef.current?.click()} disabled={restoring}>Import data…</Button>
        <input ref={fileRef} type="file" accept=".json,application/json" style={{ display: 'none' }} onChange={(e) => onFile(e.target.files?.[0])} />
      </div>
      {note && <div style={{ fontSize: 12.5, color: 'var(--text-secondary)', lineHeight: 1.6 }}>{note}</div>}
      <Dialog
        open={pending !== null}
        title={`Replace ${app.name}’s data?`}
        danger
        confirmLabel={restoring ? 'Importing…' : 'Replace data'}
        confirmDisabled={restoring}
        onCancel={() => setPending(null)}
        onConfirm={doRestore}
      >
        <div style={{ background: 'var(--status-danger-bg)', borderRadius: 6, padding: '12px 14px', fontSize: 12.5, color: 'var(--status-danger-fg)', lineHeight: 1.6 }}>
          Importing <span style={{ fontFamily: 'var(--font-mono)' }}>{pending?.name}</span> ({pending?.tables.length} tables, {pending?.rows} rows):
          <div>→ ALL current data in {app.name} is replaced by the file’s</div>
          <div>→ a preview of today’s data is created first (kept 7 days)</div>
          <div>→ a PII-masked export restores <span style={{ fontFamily: 'var(--font-mono)' }}>[masked]</span> over real values</div>
        </div>
      </Dialog>
    </div>
  );
}

const DATA_PAGE = 50;

/**
 * The Data tab — a read-only browser of the app's OWN database (kernel-design §5.4's
 * admin-query RPC). Left: the tables of this scope's DB (the vertical's own, plus the
 * `_substrat_*` spine grouped apart). Right: a paged view of the selected table.
 * Read-only by design — raw writes would bypass the event log and forge invariants.
 */
function DataBrowser({ app }: { app: AppRow }) {
  const [tables, setTables] = useState<ScopeTable[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [page, setPage] = useState<ScopeTablePage | null>(null);
  const [offset, setOffset] = useState(0);
  const [pageErr, setPageErr] = useState<string | null>(null);

  // The table list. Auto-select the first non-system table (the vertical's own data
  // is what you usually want), falling back to the first table of any kind.
  useEffect(() => {
    if (DEV_MOCK) {
      setTables(MOCK_SCOPE_TABLES);
      setSelected(MOCK_SCOPE_TABLES.find((t) => !t.system)?.name ?? MOCK_SCOPE_TABLES[0]?.name ?? null);
      return;
    }
    let live = true;
    api
      .appTables(app.app_scope_id)
      .then((ts) => {
        if (!live) return;
        setTables(ts);
        setSelected(ts.find((t) => !t.system)?.name ?? ts[0]?.name ?? null);
      })
      .catch((e) => live && setErr(e instanceof Error ? e.message : String(e)));
    return () => {
      live = false;
    };
  }, [app.app_scope_id]);

  // A page of the selected table. Refetch on table change (offset reset) or paging.
  useEffect(() => {
    if (!selected) return;
    setPageErr(null);
    if (DEV_MOCK) {
      const mock = MOCK_SCOPE_TABLE_PAGES[selected];
      const rowCount = tables?.find((t) => t.name === selected)?.rowCount ?? mock?.rows.length ?? 0;
      setPage(
        mock
          ? { table: selected, columns: mock.columns, rows: mock.rows, rowCount, limit: DATA_PAGE, offset: 0 }
          : { table: selected, columns: [], rows: [], rowCount, limit: DATA_PAGE, offset: 0 },
      );
      return;
    }
    let live = true;
    setPage(null);
    api
      .appTableRows(app.app_scope_id, selected, { limit: DATA_PAGE, offset })
      .then((p) => live && setPage(p))
      .catch((e) => live && setPageErr(e instanceof Error ? e.message : String(e)));
    return () => {
      live = false;
    };
  }, [app.app_scope_id, selected, offset, tables]);

  const pickTable = (name: string) => {
    setSelected(name);
    setOffset(0);
  };

  if (err) return <div style={{ ...card, padding: 20, fontSize: 13, color: 'var(--status-danger-fg)' }}>Couldn’t load the database — {err}</div>;
  if (!tables) return <div style={{ ...card, padding: 20, fontSize: 13, color: 'var(--text-tertiary)' }}>Loading database…</div>;
  if (tables.length === 0) return <div style={{ ...card, padding: 20, fontSize: 13, color: 'var(--text-tertiary)' }}>This app’s database has no tables yet.</div>;

  const own = tables.filter((t) => !t.system);
  const system = tables.filter((t) => t.system);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <HonestyBanner>Read-only. This is the app’s live database — the one Durable Object backing this scope. Every read is audited. Rows can’t be edited here: writes go through the app’s operations so the event log and invariants stay intact.</HonestyBanner>
      <div style={{ display: 'grid', gridTemplateColumns: '240px 1fr', gap: 16, alignItems: 'start' }}>
        <div style={{ ...card, overflow: 'hidden' }}>
          <TableGroup label="Tables" tables={own} selected={selected} onPick={pickTable} />
          {system.length > 0 && <TableGroup label="System" tables={system} selected={selected} onPick={pickTable} />}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16, minWidth: 0 }}>
          <SqlConsole app={app} />
          <div style={{ ...card, overflow: 'hidden' }}>
            {!selected ? (
              <div style={{ padding: 20, fontSize: 13, color: 'var(--text-tertiary)' }}>Select a table.</div>
            ) : pageErr ? (
              <div style={{ padding: 20, fontSize: 13, color: 'var(--status-danger-fg)' }}>Couldn’t load {selected} — {pageErr}</div>
            ) : !page ? (
              <div style={{ padding: 20, fontSize: 13, color: 'var(--text-tertiary)' }}>Loading {selected}…</div>
            ) : (
              <TablePage page={page} onPrev={() => setOffset((o) => Math.max(0, o - DATA_PAGE))} onNext={() => setOffset((o) => o + DATA_PAGE)} />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * The SQL console (#219) — one read-only statement against the app's live database.
 * Collapsed by default: the table browser answers most questions; the console is for
 * the join or filter it can't. Read-only is ENFORCED below the seam (the platform
 * rejects any write shape and rolls back regardless), so the worst a query can do here
 * is come back truncated or refused with the gate's message.
 */
function SqlConsole({ app }: { app: AppRow }) {
  const [open, setOpen] = useState(false);
  const [sql, setSql] = useState('');
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<ScopeQueryResult | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const run = () => {
    if (!sql.trim() || running) return;
    if (DEV_MOCK) {
      setErr(null);
      setResult({ columns: ['note'], rows: [['The mock preview has no live database — run against a real app.']], truncated: false });
      return;
    }
    setRunning(true);
    setErr(null);
    api
      .appQuery(app.app_scope_id, sql)
      .then((r) => setResult(r))
      .catch((e) => {
        setResult(null);
        setErr(e instanceof Error ? e.message : String(e));
      })
      .finally(() => setRunning(false));
  };

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        style={{ ...card, border: '1px dashed var(--border-default)', background: 'transparent', padding: '10px 14px', fontSize: 12.5, color: 'var(--text-secondary)', cursor: 'pointer', textAlign: 'left', fontFamily: 'var(--font-mono)' }}
      >
        &gt;_ SQL console — run a read-only SELECT…
      </button>
    );
  }

  return (
    <div style={{ ...card, overflow: 'hidden' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', borderBottom: '1px solid var(--border-subtle)' }}>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12.5, color: 'var(--text-primary)' }}>SQL console</span>
        <span style={{ fontSize: 11.5, color: 'var(--text-tertiary)' }}>read-only · one SELECT · audited</span>
        <div style={{ flex: 1 }} />
        <button type="button" onClick={() => setOpen(false)} style={pagerBtn(true)}>Hide</button>
      </div>
      <div style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
        <textarea
          value={sql}
          onChange={(e) => setSql(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
              e.preventDefault();
              run();
            }
          }}
          placeholder="SELECT … FROM … WHERE …"
          rows={3}
          spellCheck={false}
          style={{ width: '100%', resize: 'vertical', border: '1px solid var(--border-default)', borderRadius: 6, background: 'var(--surface-card)', color: 'var(--text-primary)', fontFamily: 'var(--font-mono)', fontSize: 12.5, padding: '8px 10px', boxSizing: 'border-box' }}
        />
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <button type="button" onClick={run} disabled={!sql.trim() || running} style={{ ...pagerBtn(Boolean(sql.trim()) && !running), fontWeight: 600 }}>
            {running ? 'Running…' : 'Run'}
          </button>
          <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>⌘⏎ to run</span>
          {result?.truncated && (
            <span style={{ fontSize: 11.5, color: 'var(--status-warning-fg, var(--text-secondary))' }}>Showing the first {result.rows.length} rows — narrow the query for the rest.</span>
          )}
        </div>
        {err && <div style={{ fontSize: 12.5, color: 'var(--status-danger-fg)', fontFamily: 'var(--font-mono)' }}>{err}</div>}
      </div>
      {result && !err && (
        result.columns.length === 0 || result.rows.length === 0 ? (
          <div style={{ padding: '0 14px 14px', fontSize: 13, color: 'var(--text-tertiary)' }}>No rows.</div>
        ) : (
          <div style={{ overflowX: 'auto', borderTop: '1px solid var(--border-subtle)' }}>
            <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 12 }}>
              <thead>
                <tr>
                  {result.columns.map((col, ci) => (
                    <th key={ci} style={{ textAlign: 'left', padding: '8px 12px', fontWeight: 500, letterSpacing: '0.04em', textTransform: 'uppercase', fontSize: 10.5, color: 'var(--text-tertiary)', borderBottom: '1px solid var(--border-subtle)', whiteSpace: 'nowrap' }}>{col}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {result.rows.map((row, i) => (
                  <tr key={i}>
                    {row.map((cell, j) => (
                      <td key={j} style={{ padding: '7px 12px', borderBottom: '1px solid var(--border-subtle)', fontFamily: 'var(--font-mono)', color: cell == null ? 'var(--text-tertiary)' : 'var(--text-primary)', whiteSpace: 'nowrap', maxWidth: 280, overflow: 'hidden', textOverflow: 'ellipsis' }} title={cell == null ? 'null' : String(cell)}>
                        {cell == null ? 'null' : String(cell)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      )}
    </div>
  );
}

function TableGroup({ label, tables, selected, onPick }: { label: string; tables: ScopeTable[]; selected: string | null; onPick: (name: string) => void }) {
  return (
    <div>
      <div style={{ padding: '10px 14px 6px', fontSize: 10.5, fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--text-tertiary)' }}>{label}</div>
      {tables.map((t) => (
        <button
          key={t.name}
          type="button"
          onClick={() => onPick(t.name)}
          style={{
            display: 'flex', alignItems: 'center', gap: 8, width: '100%', border: 0, cursor: 'pointer', textAlign: 'left',
            padding: '7px 14px', fontSize: 12.5,
            background: selected === t.name ? 'var(--surface-brand-subtle)' : 'transparent',
            color: selected === t.name ? 'var(--text-brand)' : 'var(--text-secondary)',
          }}
        >
          <span style={{ flex: 1, fontFamily: 'var(--font-mono)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.name}</span>
          <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>{t.rowCount}</span>
        </button>
      ))}
    </div>
  );
}

function TablePage({ page, onPrev, onNext }: { page: ScopeTablePage; onPrev: () => void; onNext: () => void }) {
  const from = page.rowCount === 0 ? 0 : page.offset + 1;
  const to = page.offset + page.rows.length;
  const hasPrev = page.offset > 0;
  const hasNext = to < page.rowCount;
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', borderBottom: '1px solid var(--border-subtle)' }}>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12.5, color: 'var(--text-primary)' }}>{page.table}</span>
        <span style={{ fontSize: 11.5, color: 'var(--text-tertiary)' }}>{from}–{to} of {page.rowCount}</span>
        <div style={{ flex: 1 }} />
        <button type="button" onClick={onPrev} disabled={!hasPrev} style={pagerBtn(hasPrev)}>← Prev</button>
        <button type="button" onClick={onNext} disabled={!hasNext} style={pagerBtn(hasNext)}>Next →</button>
      </div>
      {page.columns.length === 0 ? (
        <div style={{ padding: 20, fontSize: 13, color: 'var(--text-tertiary)' }}>This table is empty.</div>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 12 }}>
            <thead>
              <tr>
                {page.columns.map((col) => (
                  <th key={col} style={{ textAlign: 'left', padding: '8px 12px', fontWeight: 500, letterSpacing: '0.04em', textTransform: 'uppercase', fontSize: 10.5, color: 'var(--text-tertiary)', borderBottom: '1px solid var(--border-subtle)', whiteSpace: 'nowrap' }}>{col}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {page.rows.map((row, i) => (
                <tr key={i}>
                  {row.map((cell, j) => (
                    <td key={j} style={{ padding: '7px 12px', borderBottom: '1px solid var(--border-subtle)', fontFamily: 'var(--font-mono)', color: cell == null ? 'var(--text-tertiary)' : 'var(--text-primary)', whiteSpace: 'nowrap', maxWidth: 280, overflow: 'hidden', textOverflow: 'ellipsis' }} title={cell == null ? 'null' : String(cell)}>
                      {cell == null ? 'null' : String(cell)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

const pagerBtn = (enabled: boolean): React.CSSProperties => ({
  border: '1px solid var(--border-default)', background: 'var(--surface-card)', borderRadius: 6,
  padding: '4px 10px', fontSize: 12, cursor: enabled ? 'pointer' : 'default',
  color: enabled ? 'var(--text-secondary)' : 'var(--text-tertiary)', opacity: enabled ? 1 : 0.5,
});

/**
 * The Environment section (under Settings) — a REAL settings form driven by the vertical's declared env-spec
 * (placeholder + description per key) plus this app's stored values. Secret values are
 * write-only: never sent back, shown as "set" and left blank to keep. Values are stored
 * on the account; the honesty banner names that delivery to the running app is on its next
 * deploy (a hosted vertical reads its per-scope config then).
 */
function EnvVars({ app }: { app: AppRow }) {
  const [view, setView] = useState<AppEnvView | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [inputs, setInputs] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (DEV_MOCK) {
      setView(MOCK_APP_ENV);
      return;
    }
    let live = true;
    setView(null);
    setErr(null);
    api
      .appEnv(app.app_scope_id)
      .then((v) => live && setView(v))
      .catch((e) => live && setErr(e instanceof Error ? e.message : String(e)));
    return () => {
      live = false;
    };
  }, [app.app_scope_id, nonce]);

  // Seed the inputs when a fresh view loads: non-secrets prefill their current value (or
  // the spec default); secrets start blank (write-only — the value is never returned).
  useEffect(() => {
    if (!view) return;
    const byKey = new Map(view.values.map((v) => [v.key, v]));
    const next: Record<string, string> = {};
    for (const s of view.spec) next[s.key] = s.secret ? '' : byKey.get(s.key)?.value ?? s.default ?? '';
    for (const v of view.values) if (!view.spec.some((s) => s.key === v.key)) next[v.key] = v.isSecret ? '' : v.value ?? '';
    setInputs(next);
  }, [view]);

  if (err) return <div style={{ ...card, padding: 20, fontSize: 13, color: 'var(--status-danger-fg)' }}>Couldn’t load configuration — {err}</div>;
  if (!view) return <div style={{ ...card, padding: 20, fontSize: 13, color: 'var(--text-tertiary)' }}>Loading configuration…</div>;

  const specKeys = new Set(view.spec.map((s) => s.key));
  const valueByKey = new Map(view.values.map((v) => [v.key, v]));
  const custom = view.values.filter((v) => !specKeys.has(v.key));
  const groups = new Map<string, typeof view.spec>();
  for (const s of view.spec) {
    const g = s.group ?? 'General';
    (groups.get(g) ?? groups.set(g, []).get(g)!).push(s);
  }

  const set = (key: string, val: string) => setInputs((m) => ({ ...m, [key]: val }));

  const save = async () => {
    const entries: Array<{ key: string; value: string; secret: boolean }> = [];
    for (const s of view.spec) {
      const val = inputs[s.key] ?? '';
      if (val !== '') entries.push({ key: s.key, value: val, secret: s.secret });
    }
    for (const v of custom) {
      const val = inputs[v.key] ?? '';
      if (val !== '') entries.push({ key: v.key, value: val, secret: v.isSecret });
    }
    if (entries.length === 0) {
      setNote('Nothing to save — enter a value (blank leaves a secret unchanged).');
      return;
    }
    setSaving(true);
    setNote(null);
    try {
      const r = await api.setAppEnv(app.app_scope_id, entries);
      setNote(`Saved ${r.saved} value${r.saved === 1 ? '' : 's'}. Applies to the app on its next deploy.`);
      setNonce((n) => n + 1);
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const remove = async (key: string) => {
    if (DEV_MOCK) return;
    await api.deleteAppEnv(app.app_scope_id, key).catch(() => {});
    setNonce((n) => n + 1);
  };

  const field = (
    key: string,
    opts: { label?: string; description?: string; placeholder?: string; required?: boolean; secret: boolean; hasValue: boolean },
  ) => (
    <div key={key} style={{ padding: '14px 16px', borderBottom: '1px solid var(--border-subtle)' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 4 }}>
        <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-primary)' }}>{opts.label ?? key}</span>
        <MonoTag color="var(--text-tertiary)">{key}</MonoTag>
        {opts.required && <span style={{ fontSize: 11, color: 'var(--status-danger-fg)' }}>required</span>}
        {opts.secret && <Pill kind={opts.hasValue ? 'success' : 'neutral'}>{opts.hasValue ? 'secret · set' : 'secret'}</Pill>}
        <div style={{ flex: 1 }} />
        {opts.hasValue && (
          <button type="button" aria-label="Remove" onClick={() => remove(key)} style={iconBtn}><Ic name="trash" size={14} /></button>
        )}
      </div>
      {opts.description && <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginBottom: 8, lineHeight: 1.5 }}>{opts.description}</div>}
      <input
        type={opts.secret ? 'password' : 'text'}
        value={inputs[key] ?? ''}
        onChange={(e) => set(key, e.target.value)}
        placeholder={opts.secret && opts.hasValue ? '•••••••• (set — leave blank to keep)' : opts.placeholder ?? ''}
        style={{
          width: '100%', maxWidth: 460, height: 34, padding: '0 11px', fontSize: 13,
          fontFamily: opts.secret ? 'inherit' : 'var(--font-mono)',
          background: 'var(--surface-inset)', border: '1px solid var(--border-default)', borderRadius: 6, color: 'var(--text-primary)',
        }}
      />
    </div>
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <HonestyBanner>
        Configuration is stored on your account and applied to the app on its next deploy. Secret values are
        write-only — masked, never shown again; leave a secret blank to keep it. (Delivery to the running app
        reads its per-scope config at runtime; that step lands next.)
      </HonestyBanner>

      {view.spec.length === 0 && custom.length === 0 ? (
        <div style={{ ...card, padding: 20, fontSize: 13, color: 'var(--text-tertiary)' }}>
          This vertical declares no configuration.
        </div>
      ) : (
        <>
          {[...groups.entries()].map(([group, specs]) => (
            <div key={group} style={{ ...card, overflow: 'hidden' }}>
              <div style={{ padding: '10px 16px', fontSize: 11, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--text-tertiary)', borderBottom: '1px solid var(--border-subtle)' }}>{group}</div>
              {specs.map((s) =>
                field(s.key, {
                  ...(s.label !== undefined ? { label: s.label } : {}),
                  description: s.description,
                  ...(s.placeholder !== undefined ? { placeholder: s.placeholder } : {}),
                  required: s.required,
                  secret: s.secret,
                  hasValue: valueByKey.get(s.key)?.hasValue ?? false,
                }),
              )}
            </div>
          ))}
          {custom.length > 0 && (
            <div style={{ ...card, overflow: 'hidden' }}>
              <div style={{ padding: '10px 16px', fontSize: 11, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--text-tertiary)', borderBottom: '1px solid var(--border-subtle)' }}>Other</div>
              {custom.map((v) => field(v.key, { secret: v.isSecret, hasValue: v.hasValue }))}
            </div>
          )}
        </>
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        {note && <span style={{ fontSize: 12.5, color: 'var(--text-secondary)' }}>{note}</span>}
        <div style={{ flex: 1 }} />
        <Button onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save configuration'}</Button>
      </div>
    </div>
  );
}

/**
 * Domains (K-26 multi-surface): one scope can front several apps — the hostname
 * decides which surface the vertical serves, so this tab is where a second surface
 * (or a custom domain) gets its URL. A platform hostname is minted from the app's
 * own label and is live immediately (it rides the wildcard cert); a custom domain
 * lands `pending` and walks the DNS-validation lifecycle. The default hostname can't
 * be removed here — deleting the app retires it.
 */
function AppDomains({ app }: { app: AppRow }) {
  const [view, setView] = useState<AppHostnamesView | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const [surface, setSurface] = useState('');
  const [domain, setDomain] = useState('');
  const [adding, setAdding] = useState(false);
  const [toRemove, setToRemove] = useState<AppHostnameRow | null>(null);

  useEffect(() => {
    if (DEV_MOCK) {
      setView(MOCK_APP_HOSTNAMES);
      return;
    }
    let live = true;
    setView(null);
    setErr(null);
    api
      .appHostnames(app.app_scope_id)
      .then((v) => live && setView(v))
      .catch((e) => live && setErr(e instanceof Error ? e.message : String(e)));
    return () => {
      live = false;
    };
  }, [app.app_scope_id, nonce]);

  if (err) return <div style={{ ...card, padding: 20, fontSize: 13, color: 'var(--status-danger-fg)' }}>Couldn’t load hostnames — {err}</div>;
  if (!view) return <div style={{ ...card, padding: 20, fontSize: 13, color: 'var(--text-tertiary)' }}>Loading hostnames…</div>;

  const surfaceLabel = (name: string) => view.surfaces.find((s) => s.name === name)?.label;
  const statusKind = (s: string) => (s === 'active' ? 'success' : s === 'failed' ? 'danger' : 'info');

  const add = async () => {
    const chosen = surface.trim();
    if (!chosen) {
      setNote('Name the surface the hostname should serve — e.g. app, or a second surface your vertical renders.');
      return;
    }
    setAdding(true);
    setNote(null);
    try {
      const bound = await api.addAppHostname(app.app_scope_id, {
        surface: chosen,
        ...(domain.trim() ? { domain: domain.trim() } : {}),
      });
      setNote(
        bound.status === 'active'
          ? `${bound.hostname} is live.`
          : `${bound.hostname} recorded — it goes live once DNS validation and the certificate complete.`,
      );
      setSurface('');
      setDomain('');
      setNonce((n) => n + 1);
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e));
    } finally {
      setAdding(false);
    }
  };

  const remove = async () => {
    if (!toRemove) return;
    try {
      if (!DEV_MOCK) await api.removeAppHostname(app.app_scope_id, toRemove.hostname);
      setNote(`${toRemove.hostname} unbound.`);
      setNonce((n) => n + 1);
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e));
    } finally {
      setToRemove(null);
    }
  };

  const COLS = '2.4fr 1fr 1.4fr 1fr 40px';
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ ...card, overflow: 'hidden' }}>
        <div style={{ display: 'grid', gridTemplateColumns: COLS, alignItems: 'center', height: 36, padding: '0 16px', fontSize: 11, fontWeight: 500, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--text-tertiary)', borderBottom: '1px solid var(--border-subtle)' }}>
          <span>Hostname</span><span>Surface</span><span>Status</span><span>Added</span><span />
        </div>
        {view.bindings.length === 0 && (
          <div style={{ padding: 20, fontSize: 13, color: 'var(--text-tertiary)' }}>No hostnames bound yet.</div>
        )}
        {view.bindings.map((h) => {
          const isDefault = view.defaultHostname !== null && h.hostname === view.defaultHostname;
          return (
            <div key={h.hostname} style={{ display: 'grid', gridTemplateColumns: COLS, alignItems: 'center', height: 44, padding: '0 16px', fontSize: 13, borderBottom: '1px solid var(--border-subtle)' }}>
              {h.status === 'active' ? (
                <a href={`https://${h.hostname}`} target="_blank" rel="noreferrer" style={{ fontFamily: 'var(--font-mono)', fontSize: 12.5, display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                  {h.hostname}<Ic name="external" size={11} />
                </a>
              ) : (
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12.5, color: 'var(--text-secondary)' }}>{h.hostname}</span>
              )}
              <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <MonoTag color="var(--text-secondary)">{h.surface}</MonoTag>
                {surfaceLabel(h.surface) && <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>{surfaceLabel(h.surface)}</span>}
              </span>
              <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <Pill kind={statusKind(h.status)}>{h.status.charAt(0).toUpperCase() + h.status.slice(1)}</Pill>
                {h.canonical && <MonoTag color="var(--text-tertiary)">canonical</MonoTag>}
                {isDefault && <MonoTag color="var(--text-tertiary)">default</MonoTag>}
              </span>
              <span style={{ color: 'var(--text-tertiary)', fontSize: 12 }}>{h.createdAt ? shortDate(h.createdAt) : '—'}</span>
              {isDefault ? <span /> : (
                <button type="button" aria-label={`Remove ${h.hostname}`} onClick={() => setToRemove(h)} style={iconBtn}>
                  <Ic name="trash" size={14} />
                </button>
              )}
            </div>
          );
        })}
      </div>

      <div style={{ ...card, padding: 20, display: 'flex', flexDirection: 'column', gap: 14 }}>
        <Eyebrow>Add hostname</Eyebrow>
        <div style={{ fontSize: 12.5, color: 'var(--text-secondary)', lineHeight: 1.6 }}>
          Pick the surface the hostname should serve. Leave the domain blank to mint a platform
          hostname (live immediately — <span style={{ fontFamily: 'var(--font-mono)' }}>{view.defaultHostname ? `${view.defaultHostname.split('.')[0]}-<surface>.${view.defaultHostname.split('.').slice(1).join('.')}` : '<app>-<surface>.global.substrat.run'}</span>),
          or enter your own domain to start DNS validation.
        </div>
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 12, flexWrap: 'wrap' }}>
          {view.surfaces.length > 0 ? (
            <Select
              label="Surface"
              value={surface}
              onChange={(e) => setSurface(e.target.value)}
              options={[
                { value: '', label: 'Choose a surface…' },
                ...view.surfaces.map((s) => ({ value: s.name, label: `${s.label} (${s.name})` })),
              ]}
              style={{ width: 260 }}
            />
          ) : (
            <Input label="Surface" placeholder="e.g. eka" mono value={surface} onChange={(e) => setSurface(e.target.value)} style={{ width: 200 }} />
          )}
          <Input label="Custom domain (optional)" placeholder="eka.example.com" mono value={domain} onChange={(e) => setDomain(e.target.value)} style={{ width: 260 }} />
          <Button onClick={add} disabled={adding}>{adding ? 'Binding…' : 'Add hostname'}</Button>
        </div>
        {note && <span style={{ fontSize: 12.5, color: 'var(--text-secondary)' }}>{note}</span>}
      </div>

      <Dialog
        open={toRemove !== null}
        title={`Remove ${toRemove?.hostname ?? ''}?`}
        danger
        confirmLabel="Remove hostname"
        onCancel={() => setToRemove(null)}
        onConfirm={remove}
      >
        <div style={{ fontSize: 12.5, color: 'var(--text-secondary)', lineHeight: 1.6 }}>
          Requests to <span style={{ fontFamily: 'var(--font-mono)' }}>{toRemove?.hostname}</span> stop
          resolving the moment you confirm.
          {toRemove?.canonical && (
            <>
              {' '}This is the <span style={{ fontFamily: 'var(--font-mono)' }}>canonical</span> hostname for
              surface <span style={{ fontFamily: 'var(--font-mono)' }}>{toRemove.surface}</span> — removing it
              leaves that surface without a canonical name until you bind another (binding a new canonical
              demotes any existing one automatically).
            </>
          )}
        </div>
      </Dialog>
    </div>
  );
}

const SETTINGS_SECTIONS = [
  { value: 'general', label: 'General' },
  { value: 'environment', label: 'Environment' },
  { value: 'domains', label: 'Domains' },
  { value: 'integrations', label: 'Integrations' },
];

/**
 * The Settings tab — configuration, not daily-driver surfaces: General (name +
 * identity + danger zone), Environment (the env-spec form), Domains, Integrations.
 * Each section keeps its own URL (settings/environment …) so deep links survive.
 */
function Settings({ app, section, onSection, onDeleted, authServers }: { app: AppRow; section: string; onSection: (s: string) => void; onDeleted: () => void; authServers: AppRow[] }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <Tabs tabs={SETTINGS_SECTIONS} value={section} onChange={onSection} />
      {section === 'general' && <GeneralSettings app={app} onDeleted={onDeleted} authServers={authServers} />}
      {section === 'environment' && <EnvVars app={app} />}
      {section === 'domains' && <AppDomains app={app} />}
      {section === 'integrations' && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2,1fr)', gap: 16 }}>
          {INTEGRATIONS.slice(0, 2).map((i) => <IntegrationCard key={i.name} integ={i} />)}
        </div>
      )}
    </div>
  );
}

function GeneralSettings({ app, onDeleted, authServers }: { app: AppRow; onDeleted: () => void; authServers: AppRow[] }) {
  const meta = verticalMeta(app.vertical_slug);
  const [name, setName] = useState(app.name);
  const [confirm, setConfirm] = useState('');
  const [open, setOpen] = useState(false);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 720 }}>
      <div style={{ ...card, padding: 20, display: 'flex', flexDirection: 'column', gap: 14 }}>
        <Input label="App name" value={name} onChange={(e) => setName(e.target.value)} style={{ width: 320 }} />
        <div style={{ display: 'grid', gridTemplateColumns: '140px 1fr', fontSize: 13 }}>
          <span style={{ color: 'var(--text-tertiary)', padding: '8px 0' }}>Kind</span>
          <span style={{ padding: '8px 0', color: 'var(--text-primary)', display: 'flex', alignItems: 'center', gap: 8 }}>{meta.label} <MonoTag color="var(--layer-vertical)">vertical</MonoTag> <span style={{ color: 'var(--text-tertiary)' }}>— read-only</span></span>
        </div>
        <div><Button variant="secondary">Save</Button></div>
      </div>
      {app.vertical_slug !== 'auth-server' && <IdentityCard app={app} authServers={authServers} />}
      <div style={{ ...card, border: '1px solid var(--status-danger-fg)', padding: 20, display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--status-danger-fg)' }}>Danger zone</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          <div style={{ fontSize: 12.5, color: 'var(--text-secondary)', lineHeight: 1.5, flex: 1 }}>
            Deleting {app.name} deprovisions its scope and takes {app.hostname ? <span style={{ fontFamily: 'var(--font-mono)' }}>{app.hostname}</span> : 'its hostname'} offline. The audit history is retained.
          </div>
          <Button variant="danger" onClick={() => setOpen(true)}>Delete app</Button>
        </div>
      </div>
      <Dialog
        open={open}
        title={`Delete ${app.name}?`}
        danger
        confirmLabel="Delete app"
        onCancel={() => { setOpen(false); setConfirm(''); }}
        confirmDisabled={confirm !== app.name}
        onConfirm={onDeleted}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div style={{ background: 'var(--status-danger-bg)', borderRadius: 6, padding: '12px 14px', fontSize: 12.5, color: 'var(--status-danger-fg)', lineHeight: 1.6 }}>
            This deprovisions the scope the moment you confirm:
            <div>→ {app.hostname ? <span style={{ fontFamily: 'var(--font-mono)' }}>{app.hostname}</span> : 'the app hostname'} goes dark</div>
            <div>→ members lose access to this app</div>
            <div>→ App data is archived, then deleted after 30 days</div>
          </div>
          <Input label="Type the app name to confirm" placeholder={app.name} mono value={confirm} onChange={(e) => setConfirm(e.target.value)} />
        </div>
      </Dialog>
    </div>
  );
}

/**
 * The Identity card (Settings tab): the `substrat:auth` choice made at install,
 * readable and editable after the fact. The clientSecret is write-only — blank keeps
 * the stored one — and the save reports honestly whether the running app received the
 * change (`delivered`) or only the account's record did (its deployment may have no
 * live-config support).
 */
function IdentityCard({ app, authServers }: { app: AppRow; authServers: AppRow[] }) {
  const [view, setView] = useState<AppAuthView | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  // 'builtin' | 'external' | an Auth Server app's scope id.
  const [identity, setIdentity] = useState('builtin');
  const [issuer, setIssuer] = useState('');
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [audience, setAudience] = useState('');
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    if (DEV_MOCK) {
      setView({ auth: null, callbackUrl: app.hostname ? `https://${app.hostname}/api/auth/callback` : null });
      return;
    }
    let live = true;
    setView(null);
    setErr(null);
    api
      .appAuth(app.app_scope_id)
      .then((v) => live && setView(v))
      .catch((e) => live && setErr(e instanceof Error ? e.message : String(e)));
    return () => {
      live = false;
    };
  }, [app.app_scope_id, nonce]);

  // Seed the form from a fresh view: a stored issuer that matches one of the team's
  // Auth Servers selects that server; any other issuer is an external one.
  useEffect(() => {
    if (!view) return;
    if (!view.auth) {
      setIdentity('builtin');
      return;
    }
    const server = authServers.find((a) => a.hostname && `https://${a.hostname}` === view.auth!.issuer);
    setIdentity(server ? server.app_scope_id : 'external');
    setIssuer(view.auth.issuer);
    setClientId(view.auth.clientId);
    setAudience(view.auth.audience ?? '');
    setClientSecret(''); // write-only — never echoed back
  }, [view, authServers]);

  if (err) return <div style={{ ...card, padding: 20, fontSize: 13, color: 'var(--status-danger-fg)' }}>Couldn’t load the identity settings — {err}</div>;
  if (!view) return <div style={{ ...card, padding: 20, fontSize: 13, color: 'var(--text-tertiary)' }}>Loading identity settings…</div>;

  const options = [
    { value: 'builtin', label: 'Builtin — the app handles sign-in itself' },
    { value: 'external', label: 'External OIDC issuer' },
    ...authServers.filter((a) => a.app_scope_id !== app.app_scope_id).map((a) => ({ value: a.app_scope_id, label: `Auth Server — ${a.name}` })),
  ];
  // Once an issuer is wired, "builtin" is display-only: there is no un-deliver verb yet,
  // so offering a save that silently couldn't reach the app would be dishonest.
  const revertingToBuiltin = view.auth !== null && identity === 'builtin';
  const externalIncomplete = identity === 'external' && (!issuer.trim() || !clientId.trim());

  const save = async () => {
    const choice: AppAuthChoice | null =
      identity === 'external'
        ? {
            source: 'external',
            issuer: issuer.trim(),
            clientId: clientId.trim(),
            ...(clientSecret ? { clientSecret } : {}),
            ...(audience.trim() ? { audience: audience.trim() } : {}),
          }
        : identity !== 'builtin'
          ? { source: 'auth-server', scopeId: identity }
          : null;
    if (!choice) return;
    setSaving(true);
    setNote(null);
    try {
      const r = await api.setAppAuth(app.app_scope_id, choice);
      setNote(r.delivered ? 'Saved and applied to the running app.' : r.note ?? 'Saved.');
      setNonce((n) => n + 1);
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{ ...card, padding: 20, display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>Identity</div>
      <div style={{ fontSize: 12.5, color: 'var(--text-secondary)', lineHeight: 1.5 }}>
        {view.auth ? (
          <>Users sign in via <span style={{ fontFamily: 'var(--font-mono)' }}>{view.auth.issuer}</span> (client <span style={{ fontFamily: 'var(--font-mono)' }}>{view.auth.clientId}</span>{view.auth.hasClientSecret ? ', secret set' : ''}).</>
        ) : (
          <>No issuer is wired — the app’s builtin sign-in is in use.</>
        )}
      </div>
      <Select label="Issuer" options={options} value={identity} onChange={(e) => setIdentity(e.target.value)} style={{ maxWidth: 420 }} />
      {revertingToBuiltin && (
        <div style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>
          Switching back to builtin isn’t supported yet — the wired issuer stays until you save a different one.
        </div>
      )}
      {identity === 'external' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <Input
            label="Issuer URL"
            value={issuer}
            onChange={(e) => setIssuer(e.target.value)}
            placeholder="https://auth.example.com"
            {...(view.callbackUrl ? { hint: `Register the redirect URL ${view.callbackUrl} at your issuer.` } : {})}
          />
          <div style={{ display: 'flex', gap: 10 }}>
            <Input label="Client ID" mono value={clientId} onChange={(e) => setClientId(e.target.value)} style={{ flex: 1 }} />
            <Input
              label="Client secret"
              value={clientSecret}
              onChange={(e) => setClientSecret(e.target.value)}
              placeholder={view.auth?.hasClientSecret ? '•••••••• (set — leave blank to keep)' : ''}
              style={{ flex: 1 }}
            />
          </div>
          <Input label="Audience (optional)" value={audience} onChange={(e) => setAudience(e.target.value)} style={{ maxWidth: 420 }} />
        </div>
      )}
      {identity !== 'builtin' && identity !== 'external' && (
        <div style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>
          The app is re-registered at this Auth Server when you save — users sign in there.
        </div>
      )}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        {note && <span style={{ fontSize: 12.5, color: 'var(--text-secondary)' }}>{note}</span>}
        <div style={{ flex: 1 }} />
        <Button onClick={save} disabled={saving || revertingToBuiltin || identity === 'builtin' || externalIncomplete}>
          {saving ? 'Saving…' : 'Save identity'}
        </Button>
      </div>
    </div>
  );
}

const iconBtn = { border: 0, background: 'none', padding: 0, cursor: 'pointer', color: 'var(--text-tertiary)', display: 'inline-flex' } as const;
function IconBox({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <span aria-label={label} style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 32, height: 32, borderRadius: 6, border: '1px solid var(--border-default)', background: 'var(--surface-card)', color: 'var(--text-secondary)' }}>{children}</span>
  );
}
