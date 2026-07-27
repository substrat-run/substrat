import { useEffect, useState } from 'react';
import { Button, Dialog, Input, Select, Tabs } from '@substrat-run/ui';
import { api, type AppRow, type AppEvent, type Deployment, type ScopeTable, type ScopeTablePage, type ScopeQueryResult, type AppEnvView, type SnapshotRow } from '../lib/api';
import { verticalMeta, APP_TABS, INTEGRATIONS, MOCK_SCOPE_TABLES, MOCK_SCOPE_TABLE_PAGES, MOCK_APP_ENV } from '../lib/demo';
import { DEV_MOCK, MOCK_DEPLOYMENTS, MOCK_SNAPSHOTS } from '../lib/mock';
import { relativeTime, shortDate, shortId } from '../lib/format';
import { Ic } from '../lib/icons';
import { Page } from '../components/layout';
import { card, CopyButton, Eyebrow, HonestyBanner, MonoTag, Pill, RowActions } from '../components/ui';
import { IntegrationCard } from './Integrations';

/**
 * App detail (screens 1i, 1j, 1k, 1l + Domains/Integrations tabs). The header and
 * the Overview tab render REAL fields from the app row; the other tabs (env vars,
 * domains, integrations, deployments, settings) run on demo data behind the
 * design's honesty framing, since the platform does not back them yet.
 */
export function AppDetail({
  app,
  tab,
  onTab,
  onDeleted,
}: {
  app: AppRow;
  tab: string;
  onTab: (t: string) => void;
  onDeleted: () => void;
}) {
  const meta = verticalMeta(app.vertical_slug);
  const statusKind = app.status === 'provisioning' ? 'info' : app.status === 'failed' ? 'danger' : 'success';
  const statusLabel = app.status === 'provisioning' ? 'Provisioning' : app.status === 'failed' ? 'Failed' : 'Active';

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
        {app.hostname && <Button onClick={() => window.open(`https://${app.hostname}`, '_blank')}>Visit ↗</Button>}
        <button type="button" aria-label="More actions" style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 32, height: 32, borderRadius: 6, border: '1px solid var(--border-default)', background: 'var(--surface-card)', color: 'var(--text-secondary)', cursor: 'pointer' }}>
          <Ic name="dots" size={16} />
        </button>
      </div>

      <Tabs
        tabs={APP_TABS.map((t) => ({ value: t.value, label: t.label, ...(t.count !== undefined ? { count: t.count } : {}) }))}
        value={tab}
        onChange={onTab}
      />

      {tab === 'overview' && <Overview app={app} meta={meta} statusKind={statusKind} statusLabel={statusLabel} />}
      {tab === 'data' && <DataBrowser app={app} />}
      {tab === 'deployments' && <Deployments app={app} />}
      {tab === 'snapshots' && <Snapshots app={app} />}
      {tab === 'env' && <EnvVars app={app} />}
      {tab === 'domains' && <AppDomains />}
      {tab === 'integrations' && <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2,1fr)', gap: 16 }}>{INTEGRATIONS.slice(0, 2).map((i) => <IntegrationCard key={i.name} integ={i} />)}</div>}
      {tab === 'settings' && <Settings app={app} onDeleted={onDeleted} />}
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

function Overview({ app, meta, statusKind, statusLabel }: { app: AppRow; meta: { label: string; accent: string }; statusKind: 'success' | 'info' | 'danger'; statusLabel: string }) {
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
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 8, height: 32, padding: '0 10px', background: 'var(--surface-inset)', border: '1px solid var(--border-subtle)', borderRadius: 6, ...mono, color: 'var(--text-primary)' }}>{app.hostname}</span>
                <IconBox label="Copy hostname"><CopyButton text={app.hostname} size={14} /></IconBox>
                <Button variant="secondary" onClick={() => window.open(`https://${app.hostname}`, '_blank')}>Visit ↗</Button>
              </div>
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
      {note && <div style={{ ...card, padding: '10px 16px', fontSize: 12.5, color: 'var(--text-secondary)' }}>{note}</div>}
      <HonestyBanner>Read live from the registry. “Running” is the version this app’s scope is pinned to — what the router serves. Versions are managed by the Substrat team; promotion to prod is a staff action, and updating rebinds this app to the current prod version.</HonestyBanner>
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
 * The Snapshots tab (preview-and-snapshots.md §3): create a test copy of the app's
 * data, watch its expiry, delete it. A copy is unmistakably NOT the live app — it
 * never receives traffic, integrations are off, and it expires unless kept; the
 * banner says so in words.
 */
function Snapshots({ app }: { app: AppRow }) {
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
        setNote('Test copy created (preview).');
      } else {
        const days = Number(ttl);
        await api.createSnapshot(app.app_scope_id, days > 0 ? { ttlDays: days } : {});
        setNote('Test copy created.');
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

  if (err) return <div style={{ ...card, padding: 20, fontSize: 13, color: 'var(--status-danger-fg)' }}>Couldn’t load snapshots — {err}</div>;
  if (!snaps) return <div style={{ ...card, padding: 20, fontSize: 13, color: 'var(--text-tertiary)' }}>Loading snapshots…</div>;

  const COLS = '1.2fr 2fr 1fr 1.2fr 1fr';
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ ...card, padding: 20, display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <Eyebrow>Test copies</Eyebrow>
        <span style={{ fontSize: 12.5, color: 'var(--text-tertiary)' }}>
          A snapshot is a full copy of this app’s data at a moment in time — try things on it without touching the live app.
        </span>
        <div style={{ flex: 1 }} />
        <Select size="sm" value={ttl} onChange={(e) => setTtl(e.target.value)} options={TTL_CHOICES.map((t) => ({ value: t.value, label: t.label }))} style={{ width: 170 }} />
        <Button onClick={doCreate} disabled={creating}>{creating ? 'Creating…' : 'Create test copy'}</Button>
      </div>
      {note && <div style={{ ...card, padding: '10px 16px', fontSize: 12.5, color: 'var(--text-secondary)' }}>{note}</div>}
      <HonestyBanner>A copy is not the live app: it receives no traffic, integrations are off, and it is deleted automatically when it expires. Copies contain real data — the same access rules apply.</HonestyBanner>
      {snaps.length === 0 ? (
        <div style={{ ...card, padding: 20, fontSize: 13, color: 'var(--text-tertiary)' }}>No test copies yet.</div>
      ) : (
        <div style={{ ...card, overflow: 'hidden' }}>
          <div style={{ display: 'grid', gridTemplateColumns: COLS, alignItems: 'center', height: 36, padding: '0 16px', fontSize: 11, fontWeight: 500, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--text-tertiary)', borderBottom: '1px solid var(--border-subtle)' }}>
            <span>Copy</span><span>URL</span><span>Taken</span><span>Retention</span><span />
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
 * The Env tab — a REAL settings form driven by the vertical's declared env-spec
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

function AppDomains() {
  const COLS = '2.4fr 1.4fr 1fr 40px';
  return (
    <div style={{ ...card, overflow: 'hidden' }}>
      <div style={{ display: 'grid', gridTemplateColumns: COLS, alignItems: 'center', height: 36, padding: '0 16px', fontSize: 11, fontWeight: 500, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--text-tertiary)', borderBottom: '1px solid var(--border-subtle)' }}>
        <span>Hostname</span><span>Status</span><span>Added</span><span />
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: COLS, alignItems: 'center', height: 40, padding: '0 16px', fontSize: 13 }}>
        <a href="#" style={{ fontFamily: 'var(--font-mono)', fontSize: 12.5, display: 'inline-flex', alignItems: 'center', gap: 5 }}>hr.acme.com<Ic name="external" size={11} /></a>
        <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}><Pill kind="success">Active</Pill><MonoTag color="var(--text-tertiary)">primary</MonoTag></span>
        <span style={{ color: 'var(--text-tertiary)', fontSize: 12 }}>Jul 21, 2026</span>
        <RowActions />
      </div>
    </div>
  );
}

function Settings({ app, onDeleted }: { app: AppRow; onDeleted: () => void }) {
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

const iconBtn = { border: 0, background: 'none', padding: 0, cursor: 'pointer', color: 'var(--text-tertiary)', display: 'inline-flex' } as const;
function IconBox({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <span aria-label={label} style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 32, height: 32, borderRadius: 6, border: '1px solid var(--border-default)', background: 'var(--surface-card)', color: 'var(--text-secondary)' }}>{children}</span>
  );
}
