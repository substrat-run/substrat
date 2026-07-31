import { useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import {
  api,
  ApiError,
  capsFromRole,
  getPrincipal,
  setPrincipal,
  getSite,
  setSite,
  type ContentTypeDef,
  type EntryDetail,
  type EntryListItem,
  type EntryStatus,
  type Me,
  type Persona,
  type Site,
} from './api';
import { Button, Card, ColHead, Empty, Mono, Pill, StatusBadge } from './ui';
import { SignIn, AcceptInvite } from './Auth';
import { EntryForm } from './EntryForm';
import { DeliveryPreview } from './Delivery';
import { ModelsView, ModelEditorView, RelationshipMap, MigrationsView } from './ModelBuilder';
import { MembersView, AssetLibrary } from './Workspace';

const TYPE_ORDER = ['post', 'page', 'snippet', 'author'];

type View =
  | { kind: 'home' }
  | { kind: 'list'; typeKey: string }
  | { kind: 'create'; typeKey: string }
  | { kind: 'entry'; id: string }
  | { kind: 'review' }
  | { kind: 'models' }
  | { kind: 'model-edit'; key: string | null }
  | { kind: 'relationships' }
  | { kind: 'migrations' }
  | { kind: 'media' }
  | { kind: 'members' };

// State lives in the URL hash, so a refresh restores the view instead of dropping to root.
// (Site + persona persist in localStorage.)
function parseHash(): View {
  const [a, b, c] = location.hash.replace(/^#\/?/, '').split('/');
  if (!a || a === 'home') return { kind: 'home' };
  if (a === 'type' && b && c === 'new') return { kind: 'create', typeKey: b };
  if (a === 'type' && b) return { kind: 'list', typeKey: b };
  if (a === 'entry' && b) return { kind: 'entry', id: b };
  if (a === 'review') return { kind: 'review' };
  if (a === 'models' && b === 'new') return { kind: 'model-edit', key: null };
  if (a === 'models' && b) return { kind: 'model-edit', key: b };
  if (a === 'models') return { kind: 'models' };
  if (a === 'relationships' || a === 'migrations' || a === 'media' || a === 'members') return { kind: a } as View;
  return { kind: 'home' };
}

function viewToHash(v: View): string {
  switch (v.kind) {
    case 'list': return `#/type/${v.typeKey}`;
    case 'create': return `#/type/${v.typeKey}/new`;
    case 'entry': return `#/entry/${v.id}`;
    case 'model-edit': return v.key ? `#/models/${v.key}` : '#/models/new';
    default: return `#/${v.kind === 'home' ? '' : v.kind}`;
  }
}

function useHashRoute(): [View, (v: View) => void] {
  const [view, setView] = useState<View>(parseHash());
  useEffect(() => {
    const on = () => setView(parseHash());
    window.addEventListener('hashchange', on);
    if (!location.hash) location.hash = '#/';
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return [view, (v: View) => { location.hash = viewToHash(v); }];
}

export default function App() {
  const [personas, setPersonas] = useState<Persona[]>([]);
  const [sites, setSites] = useState<Site[]>([]);
  const [me, setMe] = useState<Me | null>(null);
  const [types, setTypes] = useState<ContentTypeDef[]>([]);
  const [theme, setTheme] = useState<'light' | 'dark'>('light');
  const [view, navigate] = useHashRoute();
  const [tick, setTick] = useState(0); // bump to refetch after a mutation
  const [booted, setBooted] = useState(false);

  // Bootstrap: personas + sites once (both 404 on the deployed worker → []). Pick a default
  // persona if none stored (dev only), then load.
  useEffect(() => {
    (async () => {
      const [ps, ss] = await Promise.all([api.personas().catch(() => []), api.sites().catch(() => [])]);
      setPersonas(ps);
      setSites(ss);
      if (!getPrincipal() && ps.length) setPrincipal(ps.find((p) => p.name.startsWith('Emil'))?.id ?? ps[0].id);
      setBooted(true);
      setTick((t) => t + 1);
    })().catch(() => setBooted(true));
  }, []);

  // Resolve "me" + the content model whenever the persona/site changes (each site is a scope).
  useEffect(() => {
    api.me().then(setMe).catch(() => setMe({ mode: 'anon' }));
    api.listTypes().then((t) => setTypes(t.map((x) => x.def))).catch(() => undefined);
  }, [tick]);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);

  const refresh = () => setTick((t) => t + 1);
  const caps = me?.mode === 'authed' ? me.can : capsFromRole(null);

  // Auth gate. Deployed worker: needs-setup → create the admin; anon → sign in. Dev server:
  // /api/me always resolves a persona, so this only shows the brief loading splash.
  const splash = <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', color: 'var(--muted)', background: 'var(--bg)' }}>Loading…</div>;
  if (!booted || !me) return splash;
  if (me.mode !== 'authed') {
    const inviteToken = new URLSearchParams(location.search).get('invite');
    if (inviteToken) return <AcceptInvite token={inviteToken} />;
    if (personas.length > 0) return splash; // dev: persona still resolving, don't flash sign-in
    return <SignIn firstRun={me.mode === 'needs-setup'} />;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
      <TopBar
        sites={sites}
        personas={personas}
        role={me.role}
        showPersona={personas.length > 0}
        showSites={sites.length > 0}
        canManageSites={caps.admin}
        theme={theme}
        onSite={(slug) => { setSite(slug); navigate({ kind: 'home' }); refresh(); }}
        onCreated={(slug) => { setSite(slug); navigate({ kind: 'home' }); refresh(); }}
        onArchived={async () => {
          const remaining = await api.sites().catch(() => []);
          if (remaining[0]) setSite(remaining[0].slug);
          navigate({ kind: 'home' });
          refresh();
        }}
        onPersona={(id) => { setPrincipal(id); refresh(); }}
        onTheme={() => setTheme((t) => (t === 'light' ? 'dark' : 'light'))}
      />
      <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
        <Nav types={types} view={view} onNav={navigate} />
        <main style={{ flex: 1, overflow: 'auto', padding: '28px 32px' }}>
          {view.kind === 'home' && <ContentHome types={types} tick={tick} onOpen={(v) => navigate(v)} />}
          {view.kind === 'list' && (
            <EntryList
              key={view.typeKey}
              typeKey={view.typeKey}
              types={types}
              canAuthor={caps.author}
              onOpen={(id) => navigate({ kind: 'entry', id })}
              onCreate={() => navigate({ kind: 'create', typeKey: view.typeKey })}
            />
          )}
          {view.kind === 'create' && (
            <CreateEntry
              key={view.typeKey}
              typeKey={view.typeKey}
              types={types}
              onDone={(id) => { refresh(); navigate({ kind: 'entry', id }); }}
              onCancel={() => navigate({ kind: 'list', typeKey: view.typeKey })}
            />
          )}
          {view.kind === 'review' && <ReviewQueue onOpen={(id) => navigate({ kind: 'entry', id })} />}
          {view.kind === 'models' && (
            <ModelsView canAdmin={caps.admin} onOpen={(key) => navigate({ kind: 'model-edit', key })} onNew={() => navigate({ kind: 'model-edit', key: null })} />
          )}
          {view.kind === 'model-edit' && (
            <ModelEditorView
              key={view.key ?? 'new'}
              typeKey={view.key}
              canAdmin={caps.admin}
              onSaved={() => { refresh(); navigate({ kind: 'models' }); }}
              onCancel={() => navigate({ kind: 'models' })}
            />
          )}
          {view.kind === 'relationships' && <RelationshipMap />}
          {view.kind === 'migrations' && <MigrationsView />}
          {view.kind === 'media' && <AssetLibrary />}
          {view.kind === 'members' && <MembersView personas={personas} sites={sites} devMode={personas.length > 0} meName={me.display} canAdmin={caps.admin} />}
          {view.kind === 'entry' && (
            <EntryEditor key={view.id} id={view.id} types={types} caps={caps} onChanged={refresh} onBack={() => navigate({ kind: 'home' })} />
          )}
        </main>
      </div>
    </div>
  );
}

function slugify(name: string): string {
  return name.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/**
 * Create a new site (multi-scope-manyfold.md M3). Admin-only. The vertical can't provision a scope
 * itself, so `createSite` enqueues a platform intent the control plane drains; the new site appears
 * in `sites()` once provisioned — so we poll until it shows up, then switch to it. The wait is the
 * platform drain (seconds with the router kick, up to a sweep cycle without it).
 */
function NewSite({ onCreated }: { onCreated: (slug: string) => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const create = async () => {
    const trimmed = name.trim();
    const slug = slugify(trimmed);
    if (!slug || busy) return;
    setBusy(true);
    setNote('Creating…');
    try {
      await api.createSite(slug, trimmed);
      for (let i = 0; i < 40; i++) {
        await new Promise((r) => setTimeout(r, 3000));
        if ((await api.sites().catch(() => [])).some((s) => s.slug === slug)) {
          setBusy(false);
          setOpen(false);
          setName('');
          setNote(null);
          onCreated(slug);
          return;
        }
        if (i === 2) setNote('Provisioning your site — this can take a minute…');
      }
      setNote('Still provisioning — it will appear in the switcher shortly.');
      setBusy(false);
    } catch (e) {
      setNote(e instanceof Error ? e.message : 'Could not create the site.');
      setBusy(false);
    }
  };

  if (!open)
    return (
      <Button size="sm" onClick={() => setOpen(true)}>
        + New site
      </Button>
    );
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <input
        autoFocus
        placeholder="Site name"
        value={name}
        disabled={busy}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void create();
        }}
        style={{ height: 28, padding: '0 8px', fontSize: 13, borderRadius: 6, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)' }}
      />
      <Button size="sm" variant="primary" disabled={busy || !name.trim()} onClick={() => void create()}>
        Create
      </Button>
      {!busy && (
        <Button size="sm" onClick={() => { setOpen(false); setNote(null); }}>
          Cancel
        </Button>
      )}
      {note && <span style={{ fontSize: 11, color: 'var(--muted)' }}>{note}</span>}
    </div>
  );
}

/** Archive the current site (admin-only). Retires the scope on the platform and drops it from the
 *  switcher; the app switches away afterwards. Hidden when it's the tenant's only site. */
function ArchiveSite({ slug, name, onArchived }: { slug: string; name: string; onArchived: () => void }) {
  const [busy, setBusy] = useState(false);
  const archive = async () => {
    if (busy || !window.confirm(`Archive "${name}"? It leaves the switcher and the site is retired.`)) return;
    setBusy(true);
    try {
      await api.archiveSite(slug);
      onArchived();
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Could not archive the site.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Button size="sm" disabled={busy} title="Archive this site" onClick={() => void archive()}>
      {busy ? 'Archiving…' : 'Archive'}
    </Button>
  );
}

function TopBar(props: {
  sites: Site[];
  personas: Persona[];
  role: string | null;
  showPersona: boolean;
  showSites: boolean;
  canManageSites: boolean;
  theme: 'light' | 'dark';
  onSite: (slug: string) => void;
  onCreated: (slug: string) => void;
  onArchived: () => void;
  onPersona: (id: string) => void;
  onTheme: () => void;
}) {
  const activeSite = getSite();
  const activePrincipal = getPrincipal();
  return (
    <header
      style={{
        height: 54,
        display: 'flex',
        alignItems: 'center',
        gap: 16,
        padding: '0 20px',
        borderBottom: '1px solid var(--border)',
        background: 'var(--surface)',
        flex: '0 0 auto',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 9, fontWeight: 700, fontSize: 15 }}>
        <span style={{ width: 20, height: 20, borderRadius: 6, background: 'var(--accent)', display: 'inline-block' }} />
        Manyfold
      </div>

      {/* Site switcher — the load-bearing multi-scope control (dev has many; a hosted install is one site). */}
      {props.showSites && (
        <Select value={activeSite} onChange={props.onSite} options={props.sites.map((s) => ({ value: s.slug, label: s.name }))} accent />
      )}
      {props.canManageSites && <NewSite onCreated={props.onCreated} />}
      {props.canManageSites && props.sites.length > 1 && (
        <ArchiveSite slug={activeSite} name={props.sites.find((s) => s.slug === activeSite)?.name ?? activeSite} onArchived={props.onArchived} />
      )}

      {props.role && (
        <span style={{ fontSize: 11, fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--muted)' }}>
          {props.role} · in this site
        </span>
      )}

      <div style={{ flex: 1 }} />
      {props.showPersona && (
        <>
          <Mono style={{ fontSize: 11 }}>dev persona</Mono>
          <Select value={activePrincipal} onChange={props.onPersona} options={props.personas.map((p) => ({ value: p.id, label: p.name }))} />
        </>
      )}
      <Button size="sm" onClick={props.onTheme}>{props.theme === 'light' ? '☾' : '☀'}</Button>
    </header>
  );
}

function Select(props: { value: string; onChange: (v: string) => void; options: { value: string; label: string }[]; accent?: boolean }) {
  return (
    <select
      value={props.value}
      onChange={(e) => props.onChange(e.target.value)}
      style={{
        font: 'inherit',
        fontSize: 13,
        fontWeight: props.accent ? 600 : 500,
        padding: '5px 10px',
        borderRadius: 'var(--r-pill)',
        border: '1px solid var(--border2)',
        background: props.accent ? 'var(--accent-soft)' : 'var(--surface)',
        color: props.accent ? 'var(--accent)' : 'var(--ink)',
        cursor: 'pointer',
      }}
    >
      {props.options.map((o) => (
        <option key={o.value} value={o.value}>{o.label}</option>
      ))}
    </select>
  );
}

function Nav({ types, view, onNav }: { types: ContentTypeDef[]; view: View; onNav: (v: View) => void }) {
  const ordered = [...types].sort((a, b) => TYPE_ORDER.indexOf(a.key) - TYPE_ORDER.indexOf(b.key));
  const item = (label: string, active: boolean, onClick: () => void, extra?: ReactNode) => (
    <button
      key={label}
      onClick={onClick}
      style={{
        font: 'inherit',
        fontSize: 13,
        textAlign: 'left',
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        padding: '7px 10px',
        borderRadius: 'var(--r-input)',
        border: 'none',
        cursor: 'pointer',
        background: active ? 'var(--wash)' : 'transparent',
        color: active ? 'var(--ink)' : 'var(--muted)',
        fontWeight: active ? 600 : 500,
      }}
    >
      <span>{label}</span>
      {extra}
    </button>
  );
  return (
    <nav
      style={{
        width: 216,
        flex: '0 0 auto',
        borderRight: '1px solid var(--border)',
        background: 'var(--surface)',
        padding: 12,
        display: 'flex',
        flexDirection: 'column',
        gap: 2,
        overflow: 'auto',
      }}
    >
      <SectionLabel>Content</SectionLabel>
      {item('Overview', view.kind === 'home', () => onNav({ kind: 'home' }))}
      {ordered.map((t) =>
        item(t.title + 's', view.kind === 'list' && view.typeKey === t.key, () => onNav({ kind: 'list', typeKey: t.key })),
      )}
      {item('Review queue', view.kind === 'review', () => onNav({ kind: 'review' }))}
      <SectionLabel>Model · tenant-wide</SectionLabel>
      {item('Models', view.kind === 'models', () => onNav({ kind: 'models' }))}
      {item('Relationships', view.kind === 'relationships', () => onNav({ kind: 'relationships' }))}
      {item('Migrations', view.kind === 'migrations', () => onNav({ kind: 'migrations' }))}
      <SectionLabel>Workspace</SectionLabel>
      {item('Media', view.kind === 'media', () => onNav({ kind: 'media' }))}
      {item('Members & roles', view.kind === 'members', () => onNav({ kind: 'members' }))}
      <div style={{ flex: 1 }} />
      <Mono style={{ fontSize: 10.5, padding: '8px 10px' }}>VITE_DEV_MOCK · dev-header auth</Mono>
    </nav>
  );
}

function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <div style={{ fontSize: 10.5, fontWeight: 600, letterSpacing: '0.07em', textTransform: 'uppercase', color: 'var(--faint)', padding: '12px 10px 4px' }}>
      {children}
    </div>
  );
}

function PageTitle({ children, sub }: { children: ReactNode; sub?: ReactNode }) {
  return (
    <div style={{ marginBottom: 20 }}>
      <h1 style={{ fontSize: 26, fontWeight: 600, margin: 0 }}>{children}</h1>
      {sub && <div style={{ color: 'var(--muted)', marginTop: 4 }}>{sub}</div>}
    </div>
  );
}

function ErrorNote({ err }: { err: string }) {
  return (
    <div style={{ padding: '10px 14px', borderRadius: 'var(--r-input)', background: 'var(--st-danger-bg)', color: 'var(--st-danger-fg)', fontSize: 13 }}>
      {err}
    </div>
  );
}

// ── Content home ────────────────────────────────────────────────────────────

function ContentHome({ types, tick, onOpen }: { types: ContentTypeDef[]; tick: number; onOpen: (v: View) => void }) {
  const [counts, setCounts] = useState<Record<string, EntryListItem[]>>({});
  const [review, setReview] = useState<EntryListItem[]>([]);
  const [err, setErr] = useState('');
  useEffect(() => {
    (async () => {
      setErr('');
      const all = await api.listEntries();
      const byType: Record<string, EntryListItem[]> = {};
      for (const e of all) (byType[e.type_key] ??= []).push(e);
      setCounts(byType);
      setReview(await api.reviewQueue().catch(() => []));
    })().catch((e) => setErr(e instanceof ApiError ? e.message : String(e)));
  }, [tick]);
  const ordered = [...types].sort((a, b) => TYPE_ORDER.indexOf(a.key) - TYPE_ORDER.indexOf(b.key));
  return (
    <div>
      <PageTitle sub={`Content across ${getSite()}`}>Overview</PageTitle>
      {err && <ErrorNote err={err} />}
      {review.length > 0 && (
        <Card style={{ background: 'var(--st-review-bg)', borderColor: 'transparent', marginBottom: 18 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ color: 'var(--st-review-fg)', fontWeight: 600 }}>{review.length} entr{review.length === 1 ? 'y' : 'ies'} need review</span>
            <Button size="sm" onClick={() => onOpen({ kind: 'review' })}>Open review queue</Button>
          </div>
        </Card>
      )}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(230px, 1fr))', gap: 14 }}>
        {ordered.map((t) => {
          const list = counts[t.key] ?? [];
          const pub = list.filter((e) => e.status === 'published').length;
          return (
            <Card key={t.key} style={{ cursor: 'pointer' }}>
              <div onClick={() => onOpen({ kind: 'list', typeKey: t.key })}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                  <div style={{ fontSize: 16, fontWeight: 600 }}>{t.title}s</div>
                  <div style={{ fontSize: 22, fontWeight: 600 }}>{list.length}</div>
                </div>
                <Mono style={{ display: 'block', marginTop: 6 }}>ct_{t.key}_v{t.version}</Mono>
                <div style={{ marginTop: 10, fontSize: 12.5, color: 'var(--muted)' }}>{pub} published · {list.length - pub} in progress</div>
              </div>
            </Card>
          );
        })}
      </div>
    </div>
  );
}

// ── Entry list ──────────────────────────────────────────────────────────────

const STATUSES: EntryStatus[] = ['draft', 'in_review', 'approved', 'published', 'unpublished', 'archived'];

function EntryList({ typeKey, types, canAuthor, onOpen, onCreate }: { typeKey: string; types: ContentTypeDef[]; canAuthor: boolean; onOpen: (id: string) => void; onCreate: () => void }) {
  const def = types.find((t) => t.key === typeKey);
  const [rows, setRows] = useState<EntryListItem[]>([]);
  const [filter, setFilter] = useState<EntryStatus | 'all'>('all');
  const [err, setErr] = useState('');
  useEffect(() => {
    api.listEntries({ typeKey }).then(setRows).catch((e) => setErr(e instanceof ApiError ? e.message : String(e)));
  }, [typeKey]);
  const shown = filter === 'all' ? rows : rows.filter((r) => r.status === filter);
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <PageTitle sub={<Mono>ct_{typeKey}_v{def?.version ?? 1}</Mono>}>{def?.title ?? typeKey}s</PageTitle>
        <Button variant="primary" disabled={!canAuthor} title={canAuthor ? '' : 'Disabled: needs the author permission in this site.'} onClick={onCreate}>
          New {def?.title ?? typeKey}
        </Button>
      </div>
      {err && <ErrorNote err={err} />}
      <div style={{ display: 'flex', gap: 6, marginBottom: 14, flexWrap: 'wrap' }}>
        <Pill active={filter === 'all'} onClick={() => setFilter('all')}>All</Pill>
        {STATUSES.map((s) => (
          <Pill key={s} active={filter === s} onClick={() => setFilter(s)}>{s.replace('_', ' ')}</Pill>
        ))}
      </div>
      <Card style={{ padding: 0, overflow: 'hidden' }}>
        {shown.length === 0 ? (
          <Empty title={`No ${def?.title.toLowerCase() ?? typeKey} entries`} hint="Nothing here for this site yet." />
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr><ColHead>Title</ColHead><ColHead>Status</ColHead><ColHead>Slug</ColHead><ColHead>Updated</ColHead></tr>
            </thead>
            <tbody>
              {shown.map((r) => (
                <tr key={r.id} onClick={() => onOpen(r.id)} style={{ cursor: 'pointer', opacity: r.status === 'archived' ? 0.65 : 1 }}>
                  <td style={td}>{r.title}</td>
                  <td style={td}><StatusBadge status={r.status} /></td>
                  <td style={td}><Mono>{r.slug ?? '—'}</Mono></td>
                  <td style={{ ...td, color: 'var(--muted)', fontSize: 12.5 }}>{new Date(r.updated_at).toLocaleDateString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}

const td: CSSProperties = { padding: '10px 12px', borderBottom: '1px solid var(--border)', fontSize: 13.5 };

// ── Review queue ────────────────────────────────────────────────────────────

function ReviewQueue({ onOpen }: { onOpen: (id: string) => void }) {
  const [rows, setRows] = useState<EntryListItem[]>([]);
  const [err, setErr] = useState('');
  useEffect(() => {
    api.reviewQueue().then(setRows).catch((e) => setErr(e instanceof ApiError ? e.message : String(e)));
  }, []);
  return (
    <div>
      <PageTitle sub="Entries awaiting approval across all types">Review queue</PageTitle>
      {err && <ErrorNote err={err} />}
      <Card style={{ padding: 0, overflow: 'hidden' }}>
        {rows.length === 0 ? (
          <Empty title="Nothing to review" hint="No entries are in review for this site." />
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead><tr><ColHead>Entry</ColHead><ColHead>Type</ColHead><ColHead>Updated</ColHead></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} onClick={() => onOpen(r.id)} style={{ cursor: 'pointer' }}>
                  <td style={td}>{r.title}</td>
                  <td style={td}><Mono>{r.type_key}</Mono></td>
                  <td style={{ ...td, color: 'var(--muted)', fontSize: 12.5 }}>{new Date(r.updated_at).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}

// ── Entry editor (read + the workflow bar; field editing is the next iteration) ──

function EntryEditor(props: {
  id: string;
  types: ContentTypeDef[];
  caps: { author: boolean; review: boolean; publish: boolean };
  onChanged: () => void;
  onBack: () => void;
}) {
  const [detail, setDetail] = useState<EntryDetail | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<'view' | 'edit' | 'preview'>('view');

  const load = () => api.getEntry(props.id).then(setDetail).catch((e) => setErr(e instanceof ApiError ? e.message : String(e)));
  useEffect(() => { load(); }, [props.id]);

  const act = async (fn: () => Promise<unknown>) => {
    setErr('');
    setBusy(true);
    try {
      await fn();
      await load();
      props.onChanged();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (!detail) return <div style={{ color: 'var(--muted)' }}>{err ? <ErrorNote err={err} /> : 'Loading…'}</div>;
  const def = props.types.find((t) => t.key === detail.entry.type_key);
  const status = detail.entry.status;
  const c = props.caps;

  return (
    <div>
      <button onClick={props.onBack} style={{ font: 'inherit', fontSize: 12.5, color: 'var(--muted)', background: 'none', border: 'none', cursor: 'pointer', padding: 0, marginBottom: 10 }}>
        ← back
      </button>
      <PageTitle sub={<Mono>{def?.title} · {detail.entry.slug ?? detail.entry.id}</Mono>}>
        {String(detail.body[def?.titleField ?? 'title'] ?? detail.entry.slug ?? 'Untitled')}
      </PageTitle>

      {/* Workflow bar */}
      <Card style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
        <StatusBadge status={status} />
        <Mono>{['draft', 'in_review', 'approved', 'published'].join('  →  ')}</Mono>
        <div style={{ flex: 1 }} />
        {busy && <Mono>working…</Mono>}
        <WorkflowActions status={status} caps={c} act={act} id={props.id} />
      </Card>

      {err && <ErrorNote err={err} />}

      <div style={{ display: 'flex', gap: 8, margin: '4px 0 14px' }}>
        {(status === 'draft' || status === 'unpublished') && (
          <Button disabled={!c.author} title={c.author ? '' : 'Disabled: needs the author permission in this site.'} onClick={() => setMode(mode === 'edit' ? 'view' : 'edit')}>
            {mode === 'edit' ? 'Cancel edit' : 'Edit fields'}
          </Button>
        )}
        {status === 'published' && detail.entry.slug && (
          <Button onClick={() => setMode(mode === 'preview' ? 'view' : 'preview')}>
            {mode === 'preview' ? 'Hide delivery' : 'Delivery preview'}
          </Button>
        )}
      </div>

      {mode === 'edit' && def && (
        <EntryForm
          def={def}
          initial={detail.body}
          submitLabel="Save draft"
          error={err}
          onCancel={() => setMode('view')}
          onSubmit={(b) => act(async () => { await api.saveDraft(props.id, b); setMode('view'); })}
        />
      )}

      {mode === 'preview' && detail.entry.slug && <DeliveryPreview typeKey={detail.entry.type_key} slug={detail.entry.slug} />}

      {mode === 'view' && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 260px', gap: 16, marginTop: 4 }}>
          <Card>
            <SectionLabel>Fields</SectionLabel>
            {def &&
              Object.entries(def.fields).map(([name, f]) => (
                <div key={name} style={{ padding: '8px 0', borderBottom: '1px solid var(--border)' }}>
                  <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 2 }}>
                    {name} <Mono style={{ fontSize: 11 }}>{f.type}{f.target ? `(${f.target})` : ''}{f.required ? ' · required' : ''}</Mono>
                  </div>
                  <div style={{ fontSize: 13.5 }}>{renderValue(detail.body[name])}</div>
                </div>
              ))}
          </Card>
          <Card>
            <SectionLabel>Revisions</SectionLabel>
            {detail.revisions.slice().reverse().map((r) => (
              <div key={r.rev_no} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '7px 0', borderBottom: '1px solid var(--border)' }}>
                <span style={{ fontSize: 13, fontWeight: r.rev_no === detail.entry.draft_rev ? 600 : 400 }}>
                  rev {r.rev_no}{r.rev_no === detail.entry.published_rev ? ' · published' : ''}
                </span>
                {r.frozen ? <Mono title={r.hash ?? ''}>❄ frozen</Mono> : (c.author && (status === 'draft' || status === 'unpublished') && r.rev_no !== detail.entry.draft_rev) ? (
                  <Button size="sm" onClick={() => act(() => api.restore(props.id, r.rev_no))}>Restore</Button>
                ) : null}
              </div>
            ))}
          </Card>
        </div>
      )}
    </div>
  );
}

function CreateEntry({ typeKey, types, onDone, onCancel }: { typeKey: string; types: ContentTypeDef[]; onDone: (id: string) => void; onCancel: () => void }) {
  const def = types.find((t) => t.key === typeKey);
  const [err, setErr] = useState('');
  if (!def) return null;
  return (
    <div>
      <PageTitle sub={<Mono>ct_{typeKey}_v{def.version}</Mono>}>New {def.title}</PageTitle>
      <EntryForm
        def={def}
        submitLabel={`Create ${def.title}`}
        error={err}
        onCancel={onCancel}
        onSubmit={async (body) => {
          setErr('');
          try {
            const entry = await api.createEntry(typeKey, body);
            onDone(entry.id);
          } catch (e) {
            setErr(e instanceof ApiError ? e.message : String(e));
          }
        }}
      />
    </div>
  );
}

function WorkflowActions(props: {
  status: EntryStatus;
  caps: { author: boolean; review: boolean; publish: boolean };
  act: (fn: () => Promise<unknown>) => void;
  id: string;
}) {
  const { status, caps, act, id } = props;
  const reason = (need: string) => `Disabled: needs the ${need} permission in this site.`;
  if (status === 'draft' || status === 'unpublished')
    return <Button variant="primary" disabled={!caps.author} title={caps.author ? '' : reason('author')} onClick={() => act(() => api.submit(id))}>Submit for review</Button>;
  if (status === 'in_review')
    return (
      <>
        <Button disabled={!caps.review} title={caps.review ? '' : reason('review')} onClick={() => { const note = prompt('Reason for rejection?'); if (note) act(() => api.reject(id, note)); }}>Reject</Button>
        <Button variant="primary" disabled={!caps.review} title={caps.review ? '' : reason('review')} onClick={() => act(() => api.approve(id))}>Approve</Button>
      </>
    );
  if (status === 'approved')
    return <Button variant="primary" disabled={!caps.publish} title={caps.publish ? '' : reason('publish')} onClick={() => act(() => api.publish(id))}>Publish</Button>;
  if (status === 'published')
    return (
      <>
        <Button disabled={!caps.publish} title={caps.publish ? '' : reason('publish')} onClick={() => act(() => api.archive(id))}>Archive</Button>
        <Button variant="primary" disabled={!caps.publish} title={caps.publish ? '' : reason('publish')} onClick={() => act(() => api.unpublish(id))}>Unpublish</Button>
      </>
    );
  return <Mono>no actions</Mono>;
}

function renderValue(v: unknown): ReactNode {
  if (v === undefined || v === null || v === '') return <span style={{ color: 'var(--faint)' }}>—</span>;
  if (Array.isArray(v)) return <Mono>{v.length ? `[${v.length}] ${v.join(', ')}` : '[]'}</Mono>;
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  return String(v);
}
