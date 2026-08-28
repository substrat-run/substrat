import { useEffect, useMemo, useRef, useState } from 'react';
import { Badge, Button, Dialog, Input, Select, Table, Tabs, type TableColumn } from '@substrat-run/ui';
import { api, ApiError, type AppRow, type AppDeployments, type AppEvent, type AppAuthChoice, type AppAuthView, type AppHostnameRow, type AppHostnamesView, type AuditEntry, type DeclaredSurface, type AppPermissionsView, type AppScope, type AssetEntry, type DeployAssets, type Deployment, type DeploymentVersion, type DumpTable, type MigrationBookmark, type PermissionRegistry, type PermissionRegistryEntry, type ScopeTable, type ScopeTablePage, type ScopeQueryResult, type AppEnvView, type SnapshotRow, type VerticalPreview, type OwnerSeatView, type OwnerClaimLinkView } from '../lib/api';
import { verticalMeta, APP_TABS, MOCK_SCOPE_TABLES, MOCK_SCOPE_TABLE_PAGES, MOCK_APP_ENV, MOCK_APP_SCOPES } from '../lib/demo';
import { DEV_MOCK, MOCK_APP_HOSTNAMES, MOCK_APP_PERMISSIONS, MOCK_AUDIT_ENTRIES, MOCK_DEPLOYMENTS, MOCK_SNAPSHOTS } from '../lib/mock';
import { relativeTime, shortDate, shortId, untilTime } from '../lib/format';
import { Ic } from '../lib/icons';
import { Page } from '../components/layout';
import { card, CopyButton, Eyebrow, HonestyBanner, MonoTag, OriginTag, Pill, RowActions } from '../components/ui';
import { AppIntegrations } from './Integrations';
import { navigate } from '../lib/router';
import { DnsRecords } from './Domains';
import { AppObservability } from './AppObservability';

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
      {main === 'observability' && <AppObservability app={app} />}
      {main === 'permissions' && <Permissions app={app} />}
      {main === 'audit' && <Audit app={app} />}
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

/**
 * The OWNER SEAT (#925) of one scope: whether anyone has signed in to claim the instance,
 * and the claim link that binds its owner once the first-sign-in window has closed. Read
 * live from the app's own identity directory — the fact that used to be invisible, a
 * provisioned instance with an empty seat and nothing saying so. Keyed by scope: the
 * production app and its test environment are two seats, so this renders on both, and a
 * link minted for one scope must never survive navigation to another (every async result
 * is checked against the scope it was asked for). `seat === null` ⇒ the platform cannot
 * answer (embedded mode, an app deployment that keeps no seat) — shown as nothing, never
 * as a fabricated "claimed".
 */
function OwnerSeatCard({ scopeId, active, mockOwner }: { scopeId: string; active: boolean; mockOwner?: string }) {
  const mono = { fontFamily: 'var(--font-mono)', fontSize: 12.5 } as const;
  const [seat, setSeat] = useState<OwnerSeatView | null | undefined>(undefined);
  const [claim, setClaim] = useState<OwnerClaimLinkView | null>(null);
  const [claimErr, setClaimErr] = useState<string | null>(null);
  const [minting, setMinting] = useState(false);
  // The scope this instance is currently showing — a late answer for a previous one is dropped.
  const shown = useRef(scopeId);
  useEffect(() => {
    shown.current = scopeId;
    setSeat(undefined);
    setClaim(null);
    setClaimErr(null);
    setMinting(false);
    if (DEV_MOCK) {
      setSeat({ state: 'claimed', owner: mockOwner ?? null, firstSignIn: null, claimLink: null });
      return;
    }
    if (!active) {
      setSeat(null);
      return;
    }
    api
      .appOwnerSeat(scopeId)
      .then((s) => shown.current === scopeId && setSeat(s))
      .catch(() => shown.current === scopeId && setSeat(null));
  }, [scopeId, active, mockOwner]);

  const mintClaimLink = async () => {
    if (DEV_MOCK || minting) return;
    const forScope = scopeId;
    setMinting(true);
    setClaimErr(null);
    try {
      const link = await api.appOwnerClaim(forScope);
      if (shown.current !== forScope) return;
      setClaim(link);
      // The seat now carries a live link; re-read so the card says so.
      api.appOwnerSeat(forScope).then((s) => shown.current === forScope && setSeat(s)).catch(() => {});
    } catch (e) {
      if (shown.current === forScope) setClaimErr(e instanceof ApiError ? e.message : String(e));
    } finally {
      if (shown.current === forScope) setMinting(false);
    }
  };

  if (seat === null) return null;
  return (
    <div style={{ ...card, padding: 20, display: 'flex', flexDirection: 'column', gap: 12 }}>
      <Eyebrow>Owner seat</Eyebrow>
      {seat === undefined ? (
        <div style={{ fontSize: 12.5, color: 'var(--text-tertiary)' }}>Checking who owns this instance…</div>
      ) : seat.state === 'claimed' ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 13 }}>
          <Pill kind="success">claimed</Pill>
          <span style={{ color: 'var(--text-secondary)' }}>Someone has signed in as this instance's owner.</span>
        </div>
      ) : seat.state === 'unknown' ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 13 }}>
          <Pill kind="neutral">unknown</Pill>
          <span style={{ color: 'var(--text-secondary)' }}>This app's deployment keeps no record of an owner seat for this instance.</span>
        </div>
      ) : (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 13, flexWrap: 'wrap' }}>
            <Pill kind={seat.firstSignIn?.open ? 'warning' : 'info'} pulse={seat.firstSignIn?.open}>unclaimed</Pill>
            <span style={{ color: 'var(--text-secondary)' }}>
              {seat.firstSignIn?.open
                ? `Nobody has signed in yet. Until ${seat.firstSignIn.until ? untilTime(seat.firstSignIn.until) : 'the window closes'}, the first person to sign in at its address becomes the owner — open it now, or mint a claim link that only its holder can use.`
                : 'Nobody has signed in yet, and the first-sign-in window has closed — a plain sign-in no longer claims it. Mint a claim link and open it (or send it to the person who should own this instance).'}
            </span>
          </div>
          {claim ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <a href={claim.claimUrl} target="_blank" rel="noreferrer" style={{ ...mono, wordBreak: 'break-all', color: 'var(--accent)' }}>{claim.claimUrl}</a>
                <CopyButton text={claim.claimUrl} label="Copy claim link" />
              </div>
              <div style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>
                Valid {untilTime(claim.expiresAt)}; shown once and stored nowhere — mint again if it is lost, which also retires this one.
              </div>
            </div>
          ) : (
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <Button size="sm" onClick={mintClaimLink} disabled={minting}>{minting ? 'Minting…' : seat.claimLink ? 'Mint a new claim link' : 'Get claim link'}</Button>
              {seat.claimLink && (
                <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>A claim link is already out, valid {untilTime(seat.claimLink.expiresAt)}; minting again retires it.</span>
              )}
            </div>
          )}
          {claimErr && <div style={{ fontSize: 12.5, color: 'var(--status-danger-fg)' }}>{claimErr}</div>}
        </>
      )}
    </div>
  );
}

function Overview({ app, meta, statusKind, statusLabel, surfaceUrls }: { app: AppRow; meta: { label: string; accent: string }; statusKind: 'success' | 'info' | 'danger'; statusLabel: string; surfaceUrls: SurfaceUrl[] }) {
  const mono = { fontFamily: 'var(--font-mono)', fontSize: 12.5 } as const;
  // The app's REAL audit trail (created / active / failed+reason / deleted), one page
  // newest-first; `eventsCursor` walks older activity. Dev-preview shows a sample.
  const [events, setEvents] = useState<AppEvent[] | null>(null);
  const [eventsCursor, setEventsCursor] = useState<string | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
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
      .then((p) => {
        if (!live) return;
        setEvents(p.entries);
        setEventsCursor(p.nextCursor);
      })
      .catch(() => live && setEvents([]));
    api
      .appDeployments(app.app_scope_id)
      .then((d) => live && setDep(d))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [app.app_scope_id]);


  const loadOlderEvents = async () => {
    if (DEV_MOCK || loadingOlder || !eventsCursor) return;
    setLoadingOlder(true);
    try {
      const p = await api.appEvents(app.app_scope_id, { cursor: eventsCursor });
      setEvents((prev) => [...(prev ?? []), ...p.entries.filter((e) => !prev?.some((x) => x.id === e.id))]);
      setEventsCursor(p.nextCursor);
    } finally {
      setLoadingOlder(false);
    }
  };
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
  // The vertical's provision result (#426): the non-secret first-run facts it reported
  // when the instance was created (a minted client id, migrations applied). Absent for
  // verticals that return only the bare ack.
  const provisionResult: Record<string, string> | null = (() => {
    if (!app.provision_result) return null;
    try {
      const parsed = JSON.parse(app.provision_result) as Record<string, string>;
      return Object.keys(parsed).length > 0 ? parsed : null;
    } catch {
      return null;
    }
  })();
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
                {updateAvailable && <> · <a href={`/apps/${app.app_scope_id}/deployments`} onClick={(e) => { e.preventDefault(); navigate(`/apps/${app.app_scope_id}/deployments`); }} style={{ color: 'var(--text-brand)' }}>update available →</a></>}
                {' · '}the API reference rides the app&rsquo;s own session — sign in to the app first.
              </div>
            </>
          ) : (
            <div style={{ fontSize: 12.5, color: 'var(--text-tertiary)' }}>A hostname is assigned once provisioning completes.</div>
          )}
        </div>
        <OwnerSeatCard key={app.app_scope_id} scopeId={app.app_scope_id} active={app.status === 'active'} mockOwner={app.created_by} />
        {provisionResult && (
          <div style={{ ...card, padding: 20, display: 'flex', flexDirection: 'column', gap: 12 }}>
            <Eyebrow>Provision result</Eyebrow>
            <div style={{ display: 'grid', gridTemplateColumns: '160px 1fr', fontSize: 13 }}>
              {Object.entries(provisionResult).map(([key, value], i, all) => (
                <KV key={key} label={key} last={i === all.length - 1}>
                  <span style={mono} title={value}>{value}</span>
                  <CopyButton text={value} label={`Copy ${key}`} />
                </KV>
              ))}
            </div>
            <div style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>
              Reported by the app when its instance was created — identifiers only, never credentials.
            </div>
          </div>
        )}
      </div>
      <div style={{ ...card, padding: 20, display: 'flex', flexDirection: 'column' }}>
        <Eyebrow style={{ paddingBottom: 12 }}>Activity</Eyebrow>
        {events === null ? (
          <div style={{ fontSize: 12.5, color: 'var(--text-tertiary)' }}>Loading activity…</div>
        ) : events.length === 0 ? (
          <div style={{ fontSize: 12.5, color: 'var(--text-tertiary)' }}>No activity recorded yet.</div>
        ) : (
          <>
            <Timeline items={events.map(toTimelineItem)} />
            {eventsCursor !== null && (
              <div style={{ display: 'flex', justifyContent: 'center', paddingTop: 12 }}>
                <Button variant="secondary" onClick={() => void loadOlderEvents()} disabled={loadingOlder}>
                  {loadingOlder ? 'Loading…' : 'Load older activity'}
                </Button>
              </div>
            )}
          </>
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
  const [dep, setDep] = useState<AppDeployments | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const [updating, setUpdating] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  // Which version's static-asset panel is open (#340) — one at a time, fetched on open
  // rather than with the versions list: an asset manifest is per version and most rows
  // are never expanded.
  const [openAssets, setOpenAssets] = useState<string | null>(null);
  // Fork-before-promote (default ON): snapshot the app's data before a migration-
  // crossing update, so a bad upgrade has a rollback point. A code-only update
  // snapshots nothing — the platform compares migration digests, not the checkbox.
  const [snapFirst, setSnapFirst] = useState(true);
  // #286: pre-migration rewind points, offered as a time-boxed backout. Fresh =
  // within the 24h window the platform will actually honor without force.
  const [bookmarks, setBookmarks] = useState<MigrationBookmark[]>([]);
  useEffect(() => {
    if (DEV_MOCK) {
      setDep(MOCK_DEPLOYMENTS[0] ? { ...MOCK_DEPLOYMENTS[0], nextCursor: null } : null);
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

  // Append the next (older) page of versions below the loaded ones.
  const loadOlderVersions = async () => {
    if (DEV_MOCK || loadingOlder || !dep?.nextCursor) return;
    setLoadingOlder(true);
    try {
      const p = await api.appDeployments(app.app_scope_id, { cursor: dep.nextCursor });
      setDep((d) =>
        d
          ? {
              ...d,
              versions: [...d.versions, ...p.versions.filter((v) => !d.versions.some((x) => x.id === v.id))],
              nextCursor: p.nextCursor,
            }
          : d,
      );
    } finally {
      setLoadingOlder(false);
    }
  };

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
  const COLS = '1fr 1fr 1.3fr 1.1fr 0.8fr';

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

  // Pin THIS scope to a specific version (#509 (c)) — the manual per-scope rollout: a
  // canary, or catching one app up ahead of the rest. `update` always chases prod; this
  // binds an exact version. A schema-crossing bind forks the data first (the rollback point).
  const doBind = async (v: DeploymentVersion) => {
    const snap = !!v.schemaChange;
    const ok = window.confirm(
      `Bind this app to ${v.version}?\n\n` +
        (snap
          ? 'This version changes the schema — a snapshot is taken first so the bind has a rollback point. '
          : '') +
        'The router will serve it for this app immediately.',
    );
    if (!ok) return;
    setUpdating(true);
    setNote(null);
    try {
      await api.bindAppVersion(app.app_scope_id, v.id, snap ? { snapshot: true } : undefined);
      setNote(`Bound this app to ${v.version}.`);
      setNonce((n) => n + 1);
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
            {/* Where the running code came from — the repo's deploy workflow vs a CLI push. */}
            <OriginTag origin={running.origin} />
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
              <> — <a href="/verticals" onClick={(e) => { e.preventDefault(); navigate('/verticals'); }} style={{ color: 'var(--text-brand)' }}>promote it on Verticals →</a></>
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
              <> Re-promote on <a href="/verticals" onClick={(e) => { e.preventDefault(); navigate('/verticals'); }} style={{ color: 'var(--text-brand)' }}>Verticals →</a> to retry the serve.</>
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
          <>Read live from the registry. “Running” is the version the router serves for this app. To ship a newer one, promote it to <b>prod</b> on the <a href="/verticals" onClick={(e) => { e.preventDefault(); navigate('/verticals'); }} style={{ color: 'inherit' }}>Verticals page</a>, then update here.</>
        ) : (
          <>Read live from the registry. “Running” is the version the router serves for this app. The Substrat team promotes versions to prod; updating here moves this app to the current prod version.</>
        )}
      </HonestyBanner>
      {dep.versions.length === 0 ? (
        <div style={{ ...card, padding: 20, fontSize: 13, color: 'var(--text-tertiary)' }}>No versions pushed to the registry yet.</div>
      ) : (
        <div style={{ ...card, overflow: 'hidden' }}>
          <div style={{ display: 'grid', gridTemplateColumns: COLS, alignItems: 'center', height: 36, padding: '0 16px', fontSize: 11, fontWeight: 500, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--text-tertiary)', borderBottom: '1px solid var(--border-subtle)' }}>
            <span>Version</span><span>Admission</span><span>Channels</span><span>Pushed</span><span style={{ textAlign: 'right' }}>Bind</span>
          </div>
          {dep.versions.map((v, i) => {
            const chans = channelsOf(v.id);
            return (
              <div key={v.id} style={{ borderBottom: i === dep.versions.length - 1 ? 'none' : '1px solid var(--border-subtle)', background: v.id === dep.boundVersionId ? 'var(--surface-brand-subtle)' : 'transparent' }}>
              <div style={{ display: 'grid', gridTemplateColumns: COLS, alignItems: 'center', minHeight: 40, padding: '8px 16px', fontSize: 13 }}>
                <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12.5 }}>{v.version}</span>
                  {v.id === dep.boundVersionId && <Pill kind="success">running</Pill>}
                  {v.schemaChange && <Pill kind="warning">schema change</Pill>}
                  <OriginTag origin={v.origin} />
                </span>
                <span><Pill kind={v.admission === 'admitted' ? 'success' : v.admission === 'rejected' ? 'danger' : 'warning'}>{v.admission}</Pill></span>
                <span style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  {chans.length === 0 ? <span style={{ color: 'var(--text-tertiary)' }}>—</span> : chans.map((ch) => <Pill key={ch} kind={ch === 'prod' ? 'success' : 'neutral'}>{ch}</Pill>)}
                </span>
                <span style={{ color: 'var(--text-tertiary)', fontSize: 12 }}>{v.createdAt ? relativeTime(v.createdAt) : '—'}</span>
                {/* Pin THIS scope to an exact version (#509 (c)) — a canary/rollback distinct from
                    "Update to latest". Only an admitted version that isn't already running. */}
                <span style={{ textAlign: 'right', display: 'flex', gap: 4, justifyContent: 'flex-end' }}>
                  {/* The static files this version ships (#340) — read from its retained manifest. */}
                  <Button variant="ghost" size="sm" onClick={() => setOpenAssets(openAssets === v.id ? null : v.id)}>
                    {openAssets === v.id ? 'Hide assets' : 'Assets'}
                  </Button>
                  {v.admission === 'admitted' && v.id !== dep.boundVersionId ? (
                    <Button variant="ghost" size="sm" disabled={updating} onClick={() => void doBind(v)}>Bind</Button>
                  ) : null}
                </span>
              </div>
              {openAssets === v.id && <VersionAssets scopeId={app.app_scope_id} versionId={v.id} />}
              </div>
            );
          })}
          {dep.nextCursor !== null && (
            <div style={{ display: 'flex', justifyContent: 'center', padding: '10px 16px', borderTop: '1px solid var(--border-subtle)' }}>
              <Button variant="secondary" onClick={() => void loadOlderVersions()} disabled={loadingOlder}>
                {loadingOlder ? 'Loading…' : 'Load older versions'}
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** Bytes as a short human size — asset lists are read for scale, not for exact counts. */
function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * The static files ONE version ships (#340) — served from the edge, versioned with the
 * code. Read from the version's retained deploy manifest, which is the same fact a promote
 * re-attaches the files from, so this panel cannot drift from what is actually served.
 *
 * A version that shipped no static files (or predates them) renders the empty state rather
 * than an error: "no manifest retained" and "no assets" are the same non-event to a reader.
 */
function VersionAssets({ scopeId, versionId }: { scopeId: string; versionId: string }) {
  const [assets, setAssets] = useState<DeployAssets | null | undefined>(undefined);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    api
      .appVersionAssets(scopeId, versionId)
      .then((a) => live && setAssets(a))
      .catch((e) => live && setErr(e instanceof Error ? e.message : String(e)));
    return () => {
      live = false;
    };
  }, [scopeId, versionId]);

  const pad = { padding: '10px 16px 14px', fontSize: 12.5 };
  if (err) return <div style={{ ...pad, color: 'var(--status-danger-fg)' }}>Couldn’t load assets — {err}</div>;
  if (assets === undefined) return <div style={{ ...pad, color: 'var(--text-tertiary)' }}>Loading assets…</div>;
  if (!assets || assets.files.length === 0) {
    return (
      <div style={{ ...pad, color: 'var(--text-tertiary)' }}>
        This version ships no static assets — its worker serves every response.
      </div>
    );
  }
  const total = assets.files.reduce((n, f) => n + f.size, 0);
  const routing = [
    assets.notFoundHandling ? `not-found: ${assets.notFoundHandling}` : null,
    assets.htmlHandling ? `html: ${assets.htmlHandling}` : null,
    assets.runWorkerFirst === undefined
      ? null
      : `worker first: ${Array.isArray(assets.runWorkerFirst) ? assets.runWorkerFirst.join(', ') : String(assets.runWorkerFirst)}`,
  ].filter(Boolean);

  return (
    <div style={pad}>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center', marginBottom: 8, color: 'var(--text-tertiary)' }}>
        <span>
          {assets.files.length} file{assets.files.length === 1 ? '' : 's'} · {fileSize(total)}
        </span>
        {routing.map((r) => (
          <MonoTag key={r as string}>{r as string}</MonoTag>
        ))}
      </div>
      <Table
        columns={
          [
            { key: 'path', header: 'Path', render: (f: AssetEntry) => <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>{f.path}</span> },
            { key: 'contentType', header: 'Type', render: (f: AssetEntry) => <span style={{ color: 'var(--text-tertiary)' }}>{f.contentType}</span> },
            { key: 'size', header: 'Size', render: (f: AssetEntry) => fileSize(f.size) },
            // The content address, which is also the runtime's dedup key — an unchanged
            // file keeps its hash across pushes, which is how a redeploy uploads nothing.
            { key: 'hash', header: 'Content hash', render: (f: AssetEntry) => <MonoTag>{f.hash.slice(0, 12)}</MonoTag> },
          ] as TableColumn<AssetEntry>[]
        }
        rows={assets.files}
      />
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
                <MonoTag>{view.running.version}</MonoTag> → <MonoTag>{update.version}</MonoTag> — review before updating on the <a href="/apps" onClick={(e) => { e.preventDefault(); navigate('/apps'); }} style={{ color: 'var(--text-brand)' }}>Deployments tab</a>
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
        The <b>declared</b> permission surface the vertical ships, read live from its running version. Approving a widened role happens when you update on the <a href="/apps" onClick={(e) => { e.preventDefault(); navigate('/apps'); }} style={{ color: 'inherit' }}>Deployments tab</a>, not here.
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

/** Which admin actions read as a status colour in the Audit table. Most are neutral
 *  record-keeping; destructive/terminal ones warn, provisioning/grants affirm. */
function auditStatus(action: string): 'success' | 'danger' | 'warning' | 'neutral' {
  if (/^(delete|reap|reject|unbind|revoke|remove|unassign|suspend|archive)/i.test(action)) return 'danger';
  if (/^(provision|activate|admit|grant|create|bind|promote|assign|restore|import|unsuspend|unarchive)/i.test(action)) return 'success';
  if (/^(set|rewind|publish|request)/i.test(action)) return 'warning';
  return 'neutral';
}

/** A compact one-line summary of what an entry changed, from its applied payload. */
function auditSummary(entry: AuditEntry): string {
  const after = entry.after;
  if (after && typeof after === 'object') {
    const s = Object.entries(after as Record<string, unknown>)
      .map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`)
      .join(' · ');
    return s.length > 80 ? `${s.slice(0, 79)}…` : s || '—';
  }
  return entry.vertical ?? '—';
}

/**
 * The Audit tab (#479): this app scope's slice of Substrat's control-plane admin log —
 * every privileged action against the scope, append-only, newest first. A pure READ of
 * the audit spine the platform already writes (control-plane.md §4.4); nothing here
 * mutates. `cursor` walks older entries; a row opens its full before/after. The control
 * plane serves this, so embedded mode has nothing to show and the tab says so.
 */
function Audit({ app }: { app: AppRow }) {
  const [entries, setEntries] = useState<AuditEntry[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const [selected, setSelected] = useState<AuditEntry | null>(null);

  useEffect(() => {
    if (DEV_MOCK) {
      setEntries(MOCK_AUDIT_ENTRIES);
      return;
    }
    let live = true;
    api
      .auditLog(app.app_scope_id)
      .then((p) => {
        if (!live) return;
        setEntries(p.entries);
        setCursor(p.nextCursor);
      })
      .catch((e) => {
        if (!live) return;
        if (e instanceof ApiError && e.status === 501) setUnavailable(true);
        setEntries([]);
      });
    return () => {
      live = false;
    };
  }, [app.app_scope_id]);

  const loadOlder = async () => {
    if (DEV_MOCK || loadingOlder || !cursor) return;
    setLoadingOlder(true);
    try {
      const p = await api.auditLog(app.app_scope_id, { cursor });
      setEntries((prev) => [...(prev ?? []), ...p.entries.filter((e) => !prev?.some((x) => x.id === e.id))]);
      setCursor(p.nextCursor);
    } finally {
      setLoadingOlder(false);
    }
  };

  const columns: TableColumn<AuditEntry>[] = [
    { header: 'When', width: 130, render: (e) => <span title={e.at}>{relativeTime(e.at)}</span> },
    { header: 'Action', width: 210, render: (e) => <Badge status={auditStatus(e.action)} dot={false}>{e.action}</Badge> },
    { header: 'Actor', mono: true, muted: true, render: (e) => <span title={e.actor}>{e.actor}</span> },
    { header: 'Change', muted: true, render: (e) => auditSummary(e) },
  ];

  return (
    <div style={{ ...card, padding: 0, overflow: 'hidden' }}>
      <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--border-subtle)' }}>
        <Eyebrow>Audit log</Eyebrow>
        <div style={{ fontSize: 12.5, color: 'var(--text-tertiary)', paddingTop: 4 }}>
          Every privileged action against this app&rsquo;s scope, newest first — the append-only record
          Substrat keeps of who changed what. Read-only.
        </div>
      </div>
      {entries === null ? (
        <div style={{ padding: 20, fontSize: 12.5, color: 'var(--text-tertiary)' }}>Loading audit log…</div>
      ) : unavailable ? (
        <div style={{ padding: 20, fontSize: 12.5, color: 'var(--text-tertiary)' }}>
          The audit log is served by the control plane, which isn&rsquo;t available in this environment.
        </div>
      ) : (
        <>
          <Table columns={columns} rows={entries} onRowClick={(e) => setSelected(e)} emptyText="No audited actions yet." />
          {cursor !== null && (
            <div style={{ display: 'flex', justifyContent: 'center', padding: 12 }}>
              <Button variant="secondary" onClick={() => void loadOlder()} disabled={loadingOlder}>
                {loadingOlder ? 'Loading…' : 'Load older entries'}
              </Button>
            </div>
          )}
        </>
      )}
      {selected && <AuditDetail entry={selected} onClose={() => setSelected(null)} />}
    </div>
  );
}

/** Read-only detail for one audit entry — the shared Dialog is confirm-shaped, so this
 *  is a plain overlay with a single Close. Shows before/after and the causing event. */
function AuditDetail({ entry, onClose }: { entry: AuditEntry; onClose: () => void }) {
  const mono = { fontFamily: 'var(--font-mono)' } as const;
  const field = (label: string, node: React.ReactNode) => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <span style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: 'var(--tracking-caps)', color: 'var(--text-tertiary)' }}>{label}</span>
      <div style={{ color: 'var(--text-primary)', fontSize: 13 }}>{node}</div>
    </div>
  );
  const json = (value: unknown) => (
    <pre style={{ margin: 0, padding: 10, background: 'var(--surface-inset)', border: '1px solid var(--border-subtle)', borderRadius: 6, ...mono, fontSize: 12, overflowX: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
      {JSON.stringify(value, null, 2)}
    </pre>
  );
  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(14,16,23,0.4)', zIndex: 100, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ width: 520, maxWidth: '100%', maxHeight: '80vh', overflowY: 'auto', background: 'var(--surface-raised)', borderRadius: 'var(--radius-lg)', boxShadow: 'var(--shadow-popover)', fontFamily: 'var(--font-sans)' }}>
        <div style={{ padding: '20px 20px 0', display: 'flex', alignItems: 'center', gap: 10 }}>
          <Badge status={auditStatus(entry.action)} dot={false}>{entry.action}</Badge>
        </div>
        <div style={{ padding: '16px 20px 0', display: 'flex', flexDirection: 'column', gap: 12 }}>
          {field('When', <span>{shortDate(entry.at)} · <span style={mono} title={entry.at}>{entry.at}</span></span>)}
          {field('Actor', <span style={mono}>{entry.actor}</span>)}
          {field('Entry id', <span style={mono}>{entry.id}</span>)}
          {entry.vertical && field('Vertical', entry.vertical)}
          {entry.causedBy && field('Caused by', <span><span style={mono} title={entry.causedBy}>{entry.causedBy}</span> <span style={{ color: 'var(--text-tertiary)' }}>(domain event)</span></span>)}
          {entry.before != null && field('Before', json(entry.before))}
          {entry.after != null && field('After', json(entry.after))}
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', padding: 20 }}>
          <Button variant="secondary" onClick={onClose}>Close</Button>
        </div>
      </div>
    </div>
  );
}

/**
 * Test environment (auto-follow main): a pinned, clean-room preview scope at your own
 * domain. Because it carries no `forkedFrom`, the prod-promote cascade advances it to
 * every newly promoted version (proven by api.test.ts "auto-follows prod across a
 * promote") — and since a merge to main promotes prod, the environment tracks main with
 * no per-push step. This is the persistent, addressable sibling of the ephemeral data-fork
 * Previews below: it runs the SAME code as production against its own isolated, empty data.
 *
 * Owner-only: the deployment-previews routes are narrowed to a vertical THIS team owns, so
 * for an installed-only app (or a host with no shared control plane) the panel renders
 * nothing and the snapshot Previews stand alone.
 */
/** Dev-preview sample: one pinned, prod-following test env + a pending custom domain. */
const MOCK_TEST_ENV: VerticalPreview[] = [
  {
    scopeId: '01J2Q8Z3V9K4W7X2M5N6P7ENV1',
    tag: 'test',
    versionId: '01J2Q8Z3V9K4W7X2M5N6P7V300',
    forkedFrom: null,
    expiresAt: null,
    hostname: 'helpdesk-acme--test.global.substrat.run',
    url: 'https://helpdesk-acme--test.global.substrat.run',
  },
];
const MOCK_TEST_ENV_HOSTS: AppHostnamesView = {
  defaultHostname: 'helpdesk-acme--test.global.substrat.run',
  surfaces: [{ name: 'app', label: 'App' }],
  bindings: [
    {
      hostname: 'crm-test.ahero.se',
      surface: 'app',
      status: 'verifying',
      statusNote: null,
      canonical: true,
      createdAt: '2026-08-05T10:00:00Z',
      validationRecords: [{ type: 'hostname', name: 'crm-test.ahero.se', value: 'cname.substrat.run', status: 'pending' }],
    },
  ],
};

function TestEnvironment({ app }: { app: AppRow }) {
  const [dep, setDep] = useState<Deployment | null>(null);
  const [envs, setEnvs] = useState<VerticalPreview[] | null>(null);
  const [hostView, setHostView] = useState<AppHostnamesView | null>(null);
  const [unavailable, setUnavailable] = useState(false); // 501 → no shared control plane
  const [nonce, setNonce] = useState(0);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [domain, setDomain] = useState('');
  const [checking, setChecking] = useState<string | null>(null);
  const [openRecords, setOpenRecords] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  // The single environment this panel manages: the pinned preview tagged `test`, else the
  // first pinned one. Ephemeral (expiring) previews belong to the snapshot Previews below.
  const env = useMemo(
    () =>
      (envs ?? [])
        .filter((p) => p.expiresAt === null && p.tag)
        .sort((a, b) => (a.tag === 'test' ? -1 : b.tag === 'test' ? 1 : 0))[0] ?? null,
    [envs],
  );

  useEffect(() => {
    if (DEV_MOCK) {
      setDep(MOCK_DEPLOYMENTS[0] ?? null);
      setEnvs(MOCK_TEST_ENV);
      return;
    }
    let live = true;
    api
      .appDeployments(app.app_scope_id)
      .then((d) => live && setDep(d))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [app.app_scope_id]);

  const slug = dep?.slug ?? null;
  useEffect(() => {
    if (DEV_MOCK || !slug) return;
    let live = true;
    api
      .listPreviews(slug)
      .then((p) => {
        if (!live) return;
        setEnvs(p);
        setUnavailable(false);
      })
      .catch((e) => {
        if (!live) return;
        // 501 = no shared control plane (embedded / self-host): the surface isn't available.
        if (e instanceof ApiError && e.status === 501) setUnavailable(true);
        else setNote(e instanceof Error ? e.message : String(e));
        setEnvs([]);
      });
    return () => {
      live = false;
    };
  }, [slug, nonce]);

  // The env's custom-domain bindings — status + the DNS records still to publish.
  useEffect(() => {
    if (DEV_MOCK) {
      setHostView(env ? MOCK_TEST_ENV_HOSTS : null);
      return;
    }
    if (!env) {
      setHostView(null);
      return;
    }
    let live = true;
    api
      .appHostnames(env.scopeId)
      .then((v) => live && setHostView(v))
      .catch(() => live && setHostView(null));
    return () => {
      live = false;
    };
  }, [env?.scopeId, nonce]);

  // Not this team's vertical, or no shared plane → nothing to manage; leave the snapshot
  // Previews to render alone. Still loading the deployment is the same: render nothing yet.
  if (unavailable || (dep && dep.owned === false) || !dep) return null;

  const prodVersionId = dep.channels?.find((c) => c.channel === 'prod')?.versionId ?? null;
  const seedVersion = prodVersionId ?? dep.versions.find((v) => v.admission === 'admitted')?.id ?? null;
  const runningVer = env ? dep.versions.find((v) => v.id === env.versionId)?.version ?? null : null;
  const customDomains = (hostView?.bindings ?? []).filter((h) => h.hostname !== hostView?.defaultHostname);
  const statusKind = (s: string) => (s === 'active' ? 'success' : s === 'failed' ? 'danger' : 'info');

  const create = async () => {
    if (!seedVersion) return;
    setBusy(true);
    setNote(null);
    try {
      // Clean-room + pinned: the shape that rides prod. Seeded at the current prod version,
      // it then follows every promote automatically.
      await api.createPreview(dep.slug, { tag: 'test', versionId: seedVersion, empty: true, ttlHours: null });
      setNote('Test environment created — it now tracks production. Attach a custom domain below.');
      setNonce((n) => n + 1);
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const attach = async () => {
    if (!env?.tag || !domain.trim()) return;
    setBusy(true);
    setNote(null);
    try {
      const bound = await api.addPreviewDomain(dep.slug, env.tag, {
        domain: domain.trim().toLowerCase(),
        surface: 'app',
        canonical: true,
      });
      setNote(
        bound.status === 'active'
          ? `${bound.hostname} is live.`
          : bound.status === 'failed'
            ? `${bound.hostname} was recorded, but issuance failed — ${bound.statusNote ?? 'unknown error'}`
            : `${bound.hostname} recorded — publish the DNS records below, then it goes live once validation completes.`,
      );
      setDomain('');
      setNonce((n) => n + 1);
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const checkAgain = async (hostname: string) => {
    setChecking(hostname);
    setNote(null);
    try {
      await api.verifyDomain(hostname);
      setNonce((n) => n + 1);
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e));
    } finally {
      setChecking(null);
    }
  };

  const removeDomain = async (hostname: string) => {
    if (!env) return;
    setBusy(true);
    try {
      await api.removeAppHostname(env.scopeId, hostname);
      setNonce((n) => n + 1);
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const destroy = async () => {
    if (!env?.tag) return;
    setBusy(true);
    setConfirmDelete(false);
    try {
      await api.deletePreview(dep.slug, env.tag);
      setNote('Test environment deleted.');
      setNonce((n) => n + 1);
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div style={{ ...card, padding: 20, display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <Eyebrow>Test environment</Eyebrow>
          {env && <Pill kind="success">tracks production</Pill>}
          <div style={{ flex: 1 }} />
          {env && (
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => setConfirmDelete(true)} style={{ color: 'var(--status-danger-fg)' }}>
              Delete
            </Button>
          )}
        </div>
        <div style={{ fontSize: 12.5, color: 'var(--text-secondary)', lineHeight: 1.6 }}>
          Runs your app’s <strong>production code</strong> — which tracks <span style={{ fontFamily: 'var(--font-mono)' }}>main</span> — against its own isolated,
          empty data, at your own domain. Every deploy to production flows to it automatically; there’s nothing to click per release.
        </div>

        {!env ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <Button disabled={busy || !seedVersion || DEV_MOCK} onClick={create}>
              {busy ? 'Creating…' : 'Create test environment'}
            </Button>
            {!seedVersion && (
              <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>Promote a version to production first — the environment tracks it.</span>
            )}
            {DEV_MOCK && <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>Available against a live control plane.</span>}
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', fontSize: 13 }}>
              {env.url ? (
                <a href={env.url} target="_blank" rel="noreferrer" style={{ fontFamily: 'var(--font-mono)', fontSize: 12.5, display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                  {env.hostname}
                  <Ic name="external" size={11} />
                </a>
              ) : (
                <span style={{ color: 'var(--text-tertiary)' }}>provisioning…</span>
              )}
              {env.url && <CopyButton text={env.url} size={12} />}
              {runningVer && (
                <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>
                  Running <MonoTag>{runningVer}</MonoTag>
                </span>
              )}
            </div>
            <HonestyBanner>
              A new environment starts empty — for a short window after it comes up, the first person to sign in at its address claims ownership (first-run setup), exactly like a fresh install; after that, the owner seat below mints a claim link.
              It runs the same code as production but never receives production traffic or data.
            </HonestyBanner>
            <OwnerSeatCard key={env.scopeId} scopeId={env.scopeId} active={!!env.url} />

            {customDomains.length > 0 && (
              <div style={{ ...card, overflow: 'hidden' }}>
                {customDomains.map((h) => {
                  const hasRecords = h.validationRecords.length > 0 && h.status !== 'active';
                  const chk = checking === h.hostname;
                  return (
                    <div key={h.hostname} style={{ borderBottom: '1px solid var(--border-subtle)' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', fontSize: 13, flexWrap: 'wrap' }}>
                        {h.status === 'active' ? (
                          <a href={`https://${h.hostname}`} target="_blank" rel="noreferrer" style={{ fontFamily: 'var(--font-mono)', fontSize: 12.5, display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                            {h.hostname}
                            <Ic name="external" size={11} />
                          </a>
                        ) : (
                          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12.5, color: 'var(--text-secondary)' }}>{h.hostname}</span>
                        )}
                        <Pill kind={statusKind(h.status)}>{h.status.charAt(0).toUpperCase() + h.status.slice(1)}</Pill>
                        {h.status !== 'active' && (
                          <span
                            onClick={chk ? undefined : () => void checkAgain(h.hostname)}
                            style={{ fontSize: 12, color: 'var(--text-brand)', cursor: chk ? 'default' : 'pointer', opacity: chk ? 0.5 : 1 }}
                          >
                            {chk ? 'Checking…' : 'Check again'}
                          </span>
                        )}
                        <div style={{ flex: 1 }} />
                        {hasRecords && (
                          <button
                            type="button"
                            aria-label={`Show DNS records for ${h.hostname}`}
                            onClick={() => setOpenRecords((o) => (o === h.hostname ? null : h.hostname))}
                            style={{ ...iconBtn, transform: openRecords === h.hostname ? 'rotate(180deg)' : 'none' }}
                          >
                            <Ic name="chevronDown" size={16} />
                          </button>
                        )}
                        <button type="button" aria-label={`Remove ${h.hostname}`} onClick={() => void removeDomain(h.hostname)} style={iconBtn}>
                          <Ic name="trash" size={14} />
                        </button>
                      </div>
                      {h.status === 'failed' && h.statusNote && (
                        <div style={{ margin: '0 14px 12px', background: 'var(--status-danger-bg)', borderRadius: 6, padding: '10px 14px', fontSize: 12.5, color: 'var(--status-danger-fg)', lineHeight: 1.6 }}>
                          {h.statusNote}
                        </div>
                      )}
                      {openRecords === h.hostname && hasRecords && (
                        <div style={{ margin: '0 14px 14px' }}>
                          <DnsRecords records={h.validationRecords} />
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}

            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <Input value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="crm-test.ahero.se" style={{ minWidth: 220 }} />
              <Button size="sm" disabled={busy || !domain.trim()} onClick={attach}>
                Add domain
              </Button>
              <span style={{ fontSize: 11.5, color: 'var(--text-tertiary)' }}>Lands pending — publish the DNS records it returns, then it goes live.</span>
            </div>
          </div>
        )}
        {note && <div style={{ fontSize: 12.5, color: 'var(--text-secondary)' }}>{note}</div>}
      </div>

      <Dialog
        open={confirmDelete}
        title="Delete test environment?"
        danger
        confirmLabel={busy ? 'Deleting…' : 'Delete environment'}
        confirmDisabled={busy}
        onCancel={() => setConfirmDelete(false)}
        onConfirm={destroy}
      >
        <div style={{ fontSize: 12.5, color: 'var(--text-secondary)', lineHeight: 1.6 }}>
          Removes the environment and all of its data, and releases its domain. Production is untouched.
        </div>
      </Dialog>
    </>
  );
}

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

  const COLS = '1.2fr 2fr 1fr 1.2fr 1fr';
  // The persistent, prod-following test environment renders first (owner-only, self-hiding);
  // the ephemeral data-fork Previews follow, even while they load or fail to load.
  const snapshotSection = err ? (
    <div style={{ ...card, padding: 20, fontSize: 13, color: 'var(--status-danger-fg)' }}>Couldn’t load previews — {err}</div>
  ) : !snaps ? (
    <div style={{ ...card, padding: 20, fontSize: 13, color: 'var(--text-tertiary)' }}>Loading previews…</div>
  ) : (
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

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <TestEnvironment app={app} />
      {snapshotSection}
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
  const [scopes, setScopes] = useState<AppScope[] | null>(null);
  const [activeScope, setActiveScope] = useState<string>(app.app_scope_id);
  const [tables, setTables] = useState<ScopeTable[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [page, setPage] = useState<ScopeTablePage | null>(null);
  const [offset, setOffset] = useState(0);
  const [pageErr, setPageErr] = useState<string | null>(null);

  // The scopes this app spans (M4). A multi-scope vertical (Manyfold: one site per scope) has
  // several; the switcher below picks which one's database to browse. On 404/empty — or a
  // single-scope app — this falls back to just the app scope, so no switcher shows and nothing
  // changes for the common case.
  const fallbackScopes: AppScope[] = [{ scopeId: app.app_scope_id, name: app.name, status: 'active', isDefault: true }];
  useEffect(() => {
    setActiveScope(app.app_scope_id);
    if (DEV_MOCK) {
      setScopes(MOCK_APP_SCOPES);
      return;
    }
    let live = true;
    api
      .appScopes(app.app_scope_id)
      .then((ss) => live && setScopes(ss.length ? ss : fallbackScopes))
      .catch(() => live && setScopes(fallbackScopes));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [app.app_scope_id, app.name]);

  // The table list for the ACTIVE scope. Auto-select the first non-system table (the vertical's
  // own data is what you usually want), falling back to the first table of any kind.
  useEffect(() => {
    if (DEV_MOCK) {
      setTables(MOCK_SCOPE_TABLES);
      setSelected(MOCK_SCOPE_TABLES.find((t) => !t.system)?.name ?? MOCK_SCOPE_TABLES[0]?.name ?? null);
      return;
    }
    let live = true;
    setTables(null);
    setErr(null);
    setSelected(null);
    api
      .appTables(activeScope)
      .then((ts) => {
        if (!live) return;
        setTables(ts);
        setSelected(ts.find((t) => !t.system)?.name ?? ts[0]?.name ?? null);
      })
      .catch((e) => live && setErr(e instanceof Error ? e.message : String(e)));
    return () => {
      live = false;
    };
  }, [activeScope]);

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
      .appTableRows(activeScope, selected, { limit: DATA_PAGE, offset })
      .then((p) => live && setPage(p))
      .catch((e) => live && setPageErr(e instanceof Error ? e.message : String(e)));
    return () => {
      live = false;
    };
  }, [activeScope, selected, offset, tables]);

  const pickTable = (name: string) => {
    setSelected(name);
    setOffset(0);
  };

  if (err) return <div style={{ ...card, padding: 20, fontSize: 13, color: 'var(--status-danger-fg)' }}>Couldn’t load the database — {err}</div>;
  if (!tables) return <div style={{ ...card, padding: 20, fontSize: 13, color: 'var(--text-tertiary)' }}>Loading database…</div>;

  const list = scopes ?? fallbackScopes;
  const multi = list.length > 1;
  const activeName = list.find((s) => s.scopeId === activeScope)?.name ?? 'this scope';

  const switcher = multi ? (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <span style={{ fontSize: 12.5, color: 'var(--text-secondary)' }}>Scope</span>
      <Select
        size="sm"
        value={activeScope}
        onChange={(e) => {
          setActiveScope(e.target.value);
          setOffset(0);
        }}
        options={list.map((s) => ({ value: s.scopeId, label: s.isDefault ? `${s.name} (app)` : s.name }))}
        style={{ maxWidth: 260 }}
      />
    </div>
  ) : null;

  const banner = (
    <HonestyBanner>
      Read-only. {multi ? <>Browsing the <strong>{activeName}</strong> scope — this app spans {list.length} scopes. </> : null}
      This is the app’s live database — one Durable Object per scope. Every read is audited. Rows can’t be edited here: writes go
      through the app’s operations so the event log and invariants stay intact.
    </HonestyBanner>
  );

  if (tables.length === 0)
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        {banner}
        {switcher}
        <div style={{ ...card, padding: 20, fontSize: 13, color: 'var(--text-tertiary)' }}>This scope’s database has no tables yet.</div>
      </div>
    );

  const own = tables.filter((t) => !t.system);
  const system = tables.filter((t) => t.system);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {banner}
      {switcher}
      <div style={{ display: 'grid', gridTemplateColumns: '240px 1fr', gap: 16, alignItems: 'start' }}>
        <div style={{ ...card, overflow: 'hidden' }}>
          <TableGroup label="Tables" tables={own} selected={selected} onPick={pickTable} />
          {system.length > 0 && <TableGroup label="System" tables={system} selected={selected} onPick={pickTable} />}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16, minWidth: 0 }}>
          <SqlConsole scopeId={activeScope} />
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
function SqlConsole({ scopeId }: { scopeId: string }) {
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
      .appQuery(scopeId, sql)
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
      setNote(
        r.delivered
          ? `Saved and applied to the running app (${r.saved} value${r.saved === 1 ? '' : 's'}).`
          : (r.note ?? `Saved ${r.saved} value${r.saved === 1 ? '' : 's'}.`),
      );
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
        Configuration is stored on your account and delivered to the running app immediately — a hosted vertical
        reads its per-scope config at runtime. Secret values are write-only — masked, never shown again; leave a
        secret blank to keep it. If a save can't reach the app, it says so rather than pretending it applied.
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
/** Sentinel option: reveal a free-text field for a surface the vertical didn't declare. */
const OTHER_SURFACE = '__other__';

function AppDomains({ app }: { app: AppRow }) {
  const [view, setView] = useState<AppHostnamesView | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const [surface, setSurface] = useState('');
  const [otherSurface, setOtherSurface] = useState(false);
  const [domain, setDomain] = useState('');
  const [adding, setAdding] = useState(false);
  const [toRemove, setToRemove] = useState<AppHostnameRow | null>(null);
  const [checking, setChecking] = useState<string | null>(null);
  const [openRecords, setOpenRecords] = useState<string | null>(null);

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
  // The picker's menu: the vertical's DECLARED surfaces when it names them (package.json
  // `substrat.surfaces`), else the surfaces already bound ∪ the conventional `app`, so a
  // vertical that declares none still gets a usable menu instead of a blank text box.
  const surfaceChoices: DeclaredSurface[] = view.surfaces.length > 0
    ? view.surfaces
    : [...new Set(['app', ...view.bindings.map((b) => b.surface)])].map((name) => ({ name, label: name }));

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
          : bound.status === 'failed'
            ? `${bound.hostname} was recorded, but issuance failed — ${bound.statusNote ?? 'unknown error'}`
            : `${bound.hostname} recorded — publish the DNS records below, then it goes live once validation and the certificate complete.`,
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

  // Re-poll a custom domain's issuance — a `failed` create is retried, a `verifying`
  // row re-checks DNS + cert state (same seam as the account-level Domains page).
  const checkAgain = async (hostname: string) => {
    if (DEV_MOCK) return;
    setChecking(hostname);
    try {
      await api.verifyDomain(hostname);
      setNonce((n) => n + 1);
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e));
    } finally {
      setChecking(null);
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
          const hasRecords = h.validationRecords.length > 0 && h.status !== 'active';
          const busy = checking === h.hostname;
          return (
            <div key={h.hostname} style={{ borderBottom: '1px solid var(--border-subtle)' }}>
              <div style={{ display: 'grid', gridTemplateColumns: COLS, alignItems: 'center', height: 44, padding: '0 16px', fontSize: 13 }}>
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
                  {h.status !== 'active' && (
                    <span
                      onClick={busy ? undefined : () => void checkAgain(h.hostname)}
                      style={{ fontSize: 12, color: 'var(--text-brand)', cursor: busy ? 'default' : 'pointer', opacity: busy ? 0.5 : 1 }}
                    >
                      {busy ? 'Checking…' : 'Check again'}
                    </span>
                  )}
                </span>
                <span style={{ color: 'var(--text-tertiary)', fontSize: 12 }}>{h.createdAt ? shortDate(h.createdAt) : '—'}</span>
                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 4 }}>
                  {hasRecords && (
                    <button
                      type="button"
                      aria-label={`Show DNS records for ${h.hostname}`}
                      onClick={() => setOpenRecords((o) => (o === h.hostname ? null : h.hostname))}
                      style={{ ...iconBtn, transform: openRecords === h.hostname ? 'rotate(180deg)' : 'none' }}
                    >
                      <Ic name="chevronDown" size={16} />
                    </button>
                  )}
                  {isDefault ? null : (
                    <button type="button" aria-label={`Remove ${h.hostname}`} onClick={() => setToRemove(h)} style={iconBtn}>
                      <Ic name="trash" size={14} />
                    </button>
                  )}
                </div>
              </div>
              {h.status === 'failed' && h.statusNote && (
                <div style={{ margin: '0 16px 12px', background: 'var(--status-danger-bg)', borderRadius: 6, padding: '10px 14px', fontSize: 12.5, color: 'var(--status-danger-fg)', lineHeight: 1.6 }}>
                  {h.statusNote}
                </div>
              )}
              {openRecords === h.hostname && hasRecords && (
                <div style={{ margin: '0 16px 14px' }}>
                  <DnsRecords records={h.validationRecords} />
                </div>
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
          {/* Always a picker: the vertical's DECLARED surfaces when it names them, else
              the surfaces already bound ∪ the conventional `app`, so a vertical that never
              declared surfaces still gets a menu instead of a blank box. "Other…" keeps the
              free-text escape hatch — declaration is UX, not contract (worker.ts §hostnames). */}
          <Select
            label="Surface"
            value={otherSurface ? OTHER_SURFACE : surface}
            onChange={(e) => {
              if (e.target.value === OTHER_SURFACE) {
                setOtherSurface(true);
                setSurface('');
              } else {
                setOtherSurface(false);
                setSurface(e.target.value);
              }
            }}
            options={[
              { value: '', label: 'Choose a surface…' },
              ...surfaceChoices.map((s) => ({ value: s.name, label: s.label === s.name ? s.name : `${s.label} (${s.name})` })),
              { value: OTHER_SURFACE, label: 'Other…' },
            ]}
            style={{ width: 260 }}
          />
          {otherSurface && (
            <Input label="Surface name" placeholder="e.g. eka" mono value={surface} onChange={(e) => setSurface(e.target.value)} style={{ width: 200 }} />
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
      {section === 'integrations' && <AppIntegrations app={app} />}
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
