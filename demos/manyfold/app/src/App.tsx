import { Fragment, useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import {
  api,
  ApiError,
  auth,
  capsFromRole,
  getSite,
  setSite,
  type ContentTypeDef,
  type EntryDetail,
  type EntryListItem,
  type EntryStatus,
  type Me,
  type Site,
} from './api';
import { Avatar, Button, Card, ColHead, CountPill, DistBar, Empty, Mono, Pill, RolePill, StatusBadge, relativeTime } from './ui';
import { AcceptInvite, ClaimOwner, SignIn } from './Auth';
import { EntryForm } from './EntryForm';
import { DeliveryPreview } from './Delivery';
import { renderMarkdown } from './Markdown';
import { ModelsView, ModelEditorView, RelationshipMap, MigrationsView } from './ModelBuilder';
import { MembersView } from './Workspace';
import { AssetLibrary } from './AssetsView';

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
  const [sites, setSites] = useState<Site[]>([]);
  const [me, setMe] = useState<Me | null>(null);
  const [types, setTypes] = useState<ContentTypeDef[]>([]);
  const [navCounts, setNavCounts] = useState<Record<string, number>>({});
  const [reviewCount, setReviewCount] = useState(0);
  const [theme, setTheme] = useState<'light' | 'dark'>('light');
  const [view, navigate] = useHashRoute();
  const [tick, setTick] = useState(0); // bump to refetch after a mutation
  const [booted, setBooted] = useState(false);

  // Bootstrap: the tenant's sites (the switcher's options). Coerce to an array — a missing
  // route resolving 200-with-HTML would otherwise slip a non-array through the `.catch`.
  useEffect(() => {
    (async () => {
      const ss = await api.sites().catch(() => []);
      setSites(Array.isArray(ss) ? ss : []);
      setBooted(true);
      setTick((t) => t + 1);
    })().catch(() => setBooted(true));
  }, []);

  // Resolve "me" + the content model whenever the persona/site changes (each site is a scope).
  useEffect(() => {
    api.me().then(setMe).catch(() => setMe({ mode: 'anon' }));
    api.listTypes().then((t) => setTypes(t.map((x) => x.def))).catch(() => undefined);
    // Sidebar counts (per type + review queue), so the nav mirrors the mock's count column.
    api.listEntries().then((all) => {
      const by: Record<string, number> = {};
      for (const e of all) by[e.type_key] = (by[e.type_key] ?? 0) + 1;
      setNavCounts(by);
    }).catch(() => setNavCounts({}));
    api.reviewQueue().then((r) => setReviewCount(r.length)).catch(() => setReviewCount(0));
  }, [tick]);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);

  const refresh = () => setTick((t) => t + 1);
  const caps = me?.mode === 'authed' ? me.can : capsFromRole(null);
  // The tenant-wide (product-level) views sit ABOVE the site switcher; the mock signals that by
  // inverting the top bar to --ink. Everything site-scoped keeps the light chrome.
  const productLevel = view.kind === 'models' || view.kind === 'model-edit' || view.kind === 'relationships' || view.kind === 'migrations';

  // Auth gate — the same in dev and prod: needs-setup → create the admin; anon → sign in.
  const splash = <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', color: 'var(--muted)', background: 'var(--bg)' }}>Loading…</div>;
  if (!booted || !me) return splash;
  if (me.mode !== 'authed') {
    const inviteToken = new URLSearchParams(location.search).get('invite');
    if (inviteToken) return <AcceptInvite token={inviteToken} />;
    // Arrived by a dashboard-minted claim link (#925) → bind this login to the owner seat.
    const claimToken = new URLSearchParams(location.search).get('claim');
    if (claimToken) return <ClaimOwner token={claimToken} />;
    return <SignIn firstRun={me.mode === 'needs-setup'} firstSignInOpen={me.mode === 'needs-setup' ? me.firstSignInOpen : true} />;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
      <TopBar
        sites={sites}
        role={me.role}
        meName={me.display}
        inverted={productLevel}
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
        onSignOut={() => auth.logout()}
        onSwitchUser={() => auth.switchUser(location.pathname)}
        onTheme={() => setTheme((t) => (t === 'light' ? 'dark' : 'light'))}
      />
      <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
        <Nav types={types} counts={navCounts} reviewCount={reviewCount} view={view} onNav={navigate} />
        <main style={{ flex: 1, overflow: 'auto', padding: '28px 32px' }}>
          {view.kind === 'home' && (
            <ContentHome
              types={types}
              tick={tick}
              siteName={sites.find((s) => s.slug === getSite())?.name ?? getSite()}
              onOpen={(v) => navigate(v)}
            />
          )}
          {view.kind === 'list' && (
            <EntryList
              key={view.typeKey}
              typeKey={view.typeKey}
              types={types}
              caps={caps}
              onOpen={(id) => navigate({ kind: 'entry', id })}
              onCreate={() => navigate({ kind: 'create', typeKey: view.typeKey })}
              onChanged={refresh}
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
          {view.kind === 'review' && <ReviewQueue caps={caps} types={types} onOpen={(id) => navigate({ kind: 'entry', id })} onChanged={refresh} />}
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
          {view.kind === 'relationships' && <RelationshipMap onOpen={(key) => navigate({ kind: 'model-edit', key })} />}
          {view.kind === 'migrations' && <MigrationsView />}
          {view.kind === 'media' && <AssetLibrary types={types} />}
          {view.kind === 'members' && <MembersView meName={me.display} meRole={me.role} canAdmin={caps.admin} />}
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
  role: string | null;
  meName: string;
  inverted: boolean;
  showSites: boolean;
  canManageSites: boolean;
  theme: 'light' | 'dark';
  onSite: (slug: string) => void;
  onCreated: (slug: string) => void;
  onArchived: () => void;
  onSignOut: () => void;
  onSwitchUser: () => void;
  onTheme: () => void;
}) {
  const activeSite = getSite();
  const inv = props.inverted;
  // On the inverted bar, foreground flips to --bg (a true inversion that holds in both themes).
  const fg = inv ? 'var(--bg)' : 'var(--ink)';
  return (
    <header
      style={{
        height: 54,
        display: 'flex',
        alignItems: 'center',
        gap: 14,
        padding: '0 20px',
        borderBottom: `1px solid ${inv ? 'var(--ink)' : 'var(--border)'}`,
        background: inv ? 'var(--ink)' : 'var(--surface)',
        color: fg,
        flex: '0 0 auto',
        transition: 'background 160ms ease',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 9, fontWeight: 700, fontSize: 15, color: fg }}>
        <span style={{ width: 20, height: 20, borderRadius: 6, background: 'var(--accent)', display: 'inline-block' }} />
        Manyfold
      </div>

      {inv ? (
        // Product level: tenant identity + the builder role, not the site switcher.
        <>
          <span style={{ opacity: 0.4 }}>|</span>
          <span style={{ fontSize: 13, fontWeight: 600, color: fg }}>Tenant · builder</span>
          <span style={{ fontSize: 11, fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase', padding: '3px 10px', borderRadius: 'var(--r-pill)', background: 'var(--bg)', color: 'var(--ink)' }}>
            BUILDER · tenant-wide
          </span>
        </>
      ) : (
        <>
          {/* Site switcher — the load-bearing multi-scope control (dev has many; a hosted install is one site). */}
          {props.showSites && (
            <SitePill value={activeSite} onChange={props.onSite} options={props.sites.map((s) => ({ value: s.slug, label: s.name }))} />
          )}
          {props.canManageSites && <NewSite onCreated={props.onCreated} />}
          {props.canManageSites && props.sites.length > 1 && (
            <ArchiveSite slug={activeSite} name={props.sites.find((s) => s.slug === activeSite)?.name ?? activeSite} onArchived={props.onArchived} />
          )}
          {props.role && <RolePill>{props.role} · in this site</RolePill>}
        </>
      )}

      <div style={{ flex: 1 }} />
      <Button size="sm" tone={inv ? 'onDark' : 'default'} onClick={props.onTheme}>{props.theme === 'light' ? '☾' : '☀'}</Button>
      <Button size="sm" tone={inv ? 'onDark' : 'default'} title="Sign in as somebody else" onClick={props.onSwitchUser}>Switch user</Button>
      <Button size="sm" tone={inv ? 'onDark' : 'default'} title={`Signed in as ${props.meName} — sign out`} onClick={props.onSignOut}>Sign out</Button>
      <Avatar name={props.meName} size={28} />
    </header>
  );
}

/** The site switcher rendered as the mock's pill: accent square glyph + name + native ▾. */
function SitePill(props: { value: string; onChange: (v: string) => void; options: { value: string; label: string }[] }) {
  return (
    <div
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 8,
        padding: '4px 6px 4px 10px',
        borderRadius: 'var(--r-pill)',
        border: '1px solid var(--border2)',
        background: 'var(--accent-soft)',
      }}
    >
      <span style={{ width: 12, height: 12, borderRadius: 3, background: 'var(--accent)', flex: '0 0 12px' }} />
      <select
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
        style={{ font: 'inherit', fontSize: 13, fontWeight: 600, border: 'none', background: 'transparent', color: 'var(--accent)', cursor: 'pointer', outline: 'none' }}
      >
        {props.options.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
    </div>
  );
}

function Nav({ types, counts, reviewCount, view, onNav }: { types: ContentTypeDef[]; counts: Record<string, number>; reviewCount: number; view: View; onNav: (v: View) => void }) {
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
        item(
          t.title + 's',
          view.kind === 'list' && view.typeKey === t.key,
          () => onNav({ kind: 'list', typeKey: t.key }),
          <CountPill n={counts[t.key] ?? 0} />,
        ),
      )}
      {item('Review queue', view.kind === 'review', () => onNav({ kind: 'review' }), <CountPill n={reviewCount} tone="review" />)}
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

function statusDist(list: EntryListItem[]): Partial<Record<EntryStatus, number>> {
  const d: Partial<Record<EntryStatus, number>> = {};
  for (const e of list) d[e.status] = (d[e.status] ?? 0) + 1;
  return d;
}

// A compact, human breakdown for a card ("4 published · 1 in review · 1 draft").
function distSummary(d: Partial<Record<EntryStatus, number>>): string {
  const label: Record<EntryStatus, string> = {
    published: 'published', approved: 'approved', in_review: 'in review',
    draft: 'draft', unpublished: 'unpublished', archived: 'archived',
  };
  const order: EntryStatus[] = ['published', 'approved', 'in_review', 'draft', 'unpublished', 'archived'];
  const parts = order.filter((s) => (d[s] ?? 0) > 0).map((s) => `${d[s]} ${label[s]}`);
  return parts.length ? parts.join(' · ') : 'no entries yet';
}

function ContentHome({ types, tick, siteName, onOpen }: { types: ContentTypeDef[]; tick: number; siteName: string; onOpen: (v: View) => void }) {
  const [counts, setCounts] = useState<Record<string, EntryListItem[]>>({});
  const [recent, setRecent] = useState<EntryListItem[]>([]);
  const [review, setReview] = useState<EntryListItem[]>([]);
  const [err, setErr] = useState('');
  useEffect(() => {
    (async () => {
      setErr('');
      const all = await api.listEntries();
      const byType: Record<string, EntryListItem[]> = {};
      for (const e of all) (byType[e.type_key] ??= []).push(e);
      setCounts(byType);
      setRecent([...all].sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at)).slice(0, 5));
      setReview(await api.reviewQueue().catch(() => []));
    })().catch((e) => setErr(e instanceof ApiError ? e.message : String(e)));
  }, [tick]);
  const ordered = [...types].sort((a, b) => TYPE_ORDER.indexOf(a.key) - TYPE_ORDER.indexOf(b.key));
  const all = Object.values(counts).flat();
  const totalEntries = all.length;
  const lastPublish = all.filter((e) => e.status === 'published').map((e) => Date.parse(e.updated_at)).sort((a, b) => b - a)[0];
  const typeTitle = (key: string) => types.find((t) => t.key === key)?.title ?? key;

  return (
    <div>
      <PageTitle
        sub={
          <span>
            {types.length} content type{types.length === 1 ? '' : 's'} · {totalEntries} entr{totalEntries === 1 ? 'y' : 'ies'}
            {lastPublish ? <> · last publish {relativeTime(lastPublish)}</> : null}
          </span>
        }
      >
        {siteName}
      </PageTitle>
      {err && <ErrorNote err={err} />}

      {review.length > 0 && (
        <Card style={{ background: 'var(--st-review-bg)', borderColor: 'transparent', marginBottom: 18 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16 }}>
            <div style={{ minWidth: 0 }}>
              <div style={{ color: 'var(--st-review-fg)', fontWeight: 600, marginBottom: 6 }}>
                {review.length} entr{review.length === 1 ? 'y' : 'ies'} need review
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 14px', fontSize: 12.5, color: 'var(--st-review-fg)' }}>
                {review.slice(0, 4).map((e) => (
                  <button
                    key={e.id}
                    onClick={() => onOpen({ kind: 'entry', id: e.id })}
                    style={{ font: 'inherit', fontSize: 12.5, background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: 'inherit' }}
                  >
                    {e.title} <span style={{ opacity: 0.75 }}>· {typeTitle(e.type_key)} · {relativeTime(e.updated_at)}</span>
                  </button>
                ))}
              </div>
            </div>
            <Button size="sm" onClick={() => onOpen({ kind: 'review' })}>Open review queue</Button>
          </div>
        </Card>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(230px, 1fr))', gap: 14 }}>
        {ordered.map((t) => {
          const list = counts[t.key] ?? [];
          const dist = statusDist(list);
          return (
            <Card key={t.key} style={{ cursor: 'pointer', transition: 'border-color 160ms ease' }}>
              <div onClick={() => onOpen({ kind: 'list', typeKey: t.key })}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }}>
                  <div style={{ fontSize: 16, fontWeight: 600 }}>{t.title}s</div>
                  <Mono style={{ fontSize: 11.5 }}>ct_{t.key}_v{t.version}</Mono>
                </div>
                <div style={{ fontSize: 30, fontWeight: 600, margin: '6px 0 12px', letterSpacing: '-0.01em' }}>{list.length}</div>
                <DistBar counts={dist} />
                <div style={{ marginTop: 10, fontSize: 12.5, color: 'var(--muted)' }}>{distSummary(dist)}</div>
              </div>
            </Card>
          );
        })}
      </div>

      {recent.length > 0 && (
        <div style={{ marginTop: 28 }}>
          <h2 style={{ fontSize: 18, fontWeight: 600, margin: '0 0 12px' }}>Recent activity</h2>
          <Card style={{ padding: '4px 0' }}>
            {recent.map((e, i) => (
              <button
                key={e.id}
                onClick={() => onOpen({ kind: 'entry', id: e.id })}
                style={{
                  width: '100%',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 12,
                  padding: '11px 16px',
                  font: 'inherit',
                  textAlign: 'left',
                  background: 'none',
                  border: 'none',
                  borderTop: i === 0 ? 'none' : '1px solid var(--border)',
                  cursor: 'pointer',
                  color: 'var(--ink)',
                }}
              >
                <StatusBadge status={e.status} />
                <span style={{ flex: 1, fontSize: 13.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e.title}</span>
                <Mono style={{ fontSize: 11.5 }}>{typeTitle(e.type_key)}</Mono>
                <span style={{ fontSize: 12, color: 'var(--faint)', minWidth: 64, textAlign: 'right' }}>{relativeTime(e.updated_at)}</span>
              </button>
            ))}
          </Card>
        </div>
      )}
    </div>
  );
}

// ── Entry list ──────────────────────────────────────────────────────────────

const STATUSES: EntryStatus[] = ['draft', 'in_review', 'approved', 'published', 'unpublished', 'archived'];

function EntryList({ typeKey, types, caps, onOpen, onCreate, onChanged }: { typeKey: string; types: ContentTypeDef[]; caps: { author: boolean; review: boolean; publish: boolean }; onOpen: (id: string) => void; onCreate: () => void; onChanged: () => void }) {
  const def = types.find((t) => t.key === typeKey);
  const [rows, setRows] = useState<EntryListItem[]>([]);
  const [filter, setFilter] = useState<EntryStatus | 'all'>('all');
  const [query, setQuery] = useState('');
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const load = () => api.listEntries({ typeKey }).then(setRows).catch((e) => setErr(e instanceof ApiError ? e.message : String(e)));
  useEffect(() => { load(); setSel(new Set()); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [typeKey]);

  const shown = rows
    .filter((r) => (filter === 'all' ? true : r.status === filter))
    .filter((r) => (query ? (r.title + ' ' + (r.slug ?? '')).toLowerCase().includes(query.toLowerCase()) : true));

  const toggle = (id: string) => setSel((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const selected = shown.filter((r) => sel.has(r.id));
  const allSubmittable = selected.length > 0 && selected.every((r) => r.status === 'draft' || r.status === 'unpublished');
  const allArchivable = selected.length > 0 && selected.every((r) => r.status === 'published');

  const bulk = async (fn: (id: string) => Promise<unknown>) => {
    setBusy(true);
    setErr('');
    try {
      for (const r of selected) await fn(r.id);
      await load();
      setSel(new Set());
      onChanged();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <PageTitle sub={<Mono>ct_{typeKey}_v{def?.version ?? 1}</Mono>}>{def?.title ?? typeKey}s</PageTitle>
        <Button variant="primary" disabled={!caps.author} title={caps.author ? '' : 'Disabled: needs the author permission in this site.'} onClick={onCreate}>
          New {def?.title ?? typeKey}
        </Button>
      </div>
      {err && <ErrorNote err={err} />}

      <div style={{ display: 'flex', gap: 10, marginBottom: 14, flexWrap: 'wrap', alignItems: 'center' }}>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={`⌕  Search ${def?.title.toLowerCase() ?? typeKey}s…`}
          style={{ font: 'inherit', fontSize: 13, padding: '7px 12px', width: 260, borderRadius: 'var(--r-input)', border: '1px solid var(--border2)', background: 'var(--surface)', color: 'var(--ink)' }}
        />
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          <Pill active={filter === 'all'} onClick={() => setFilter('all')}>All</Pill>
          {STATUSES.map((s) => (
            <Pill key={s} active={filter === s} onClick={() => setFilter(s)}>{s.replace('_', ' ')}</Pill>
          ))}
        </div>
      </div>

      {selected.length > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '9px 16px', marginBottom: 12, borderRadius: 'var(--r-input)', background: 'var(--accent-soft)', color: 'var(--accent)', fontSize: 13 }}>
          <span style={{ fontWeight: 600 }}>{selected.length} selected</span>
          {allSubmittable && caps.author && <button style={bulkBtn} disabled={busy} onClick={() => void bulk((id) => api.submit(id))}>Submit for review</button>}
          {allArchivable && caps.publish && <button style={bulkBtn} disabled={busy} onClick={() => void bulk((id) => api.archive(id))}>Archive</button>}
          <div style={{ flex: 1 }} />
          <button style={bulkBtn} onClick={() => setSel(new Set())}>Clear</button>
        </div>
      )}

      <Card style={{ padding: 0, overflow: 'hidden' }}>
        {shown.length === 0 ? (
          <Empty title={`No ${def?.title.toLowerCase() ?? typeKey} entries`} hint={query || filter !== 'all' ? 'No entries match this filter.' : 'Nothing here for this site yet.'} />
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <ColHead>{''}</ColHead><ColHead>Title</ColHead><ColHead>Status</ColHead><ColHead>Slug</ColHead><ColHead>Updated</ColHead>
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => {
                const on = sel.has(r.id);
                return (
                  <tr key={r.id} style={{ cursor: 'pointer', opacity: r.status === 'archived' ? 0.65 : 1, background: on ? 'var(--wash)' : 'transparent' }}>
                    <td style={{ ...td, width: 34 }} onClick={(e) => { e.stopPropagation(); toggle(r.id); }}>
                      <input type="checkbox" checked={on} readOnly />
                    </td>
                    <td style={td} onClick={() => onOpen(r.id)}>{r.title}</td>
                    <td style={td} onClick={() => onOpen(r.id)}><StatusBadge status={r.status} /></td>
                    <td style={td} onClick={() => onOpen(r.id)}><Mono>{r.slug ?? '—'}</Mono></td>
                    <td style={{ ...td, color: 'var(--muted)', fontSize: 12.5 }} onClick={() => onOpen(r.id)}>{relativeTime(r.updated_at)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Card>
      {rows.length > 0 && (
        <div style={{ marginTop: 12, fontSize: 12.5, color: 'var(--faint)' }}>
          Showing {shown.length} of {rows.length}
        </div>
      )}
    </div>
  );
}

const bulkBtn: CSSProperties = { font: 'inherit', fontSize: 13, fontWeight: 600, color: 'var(--accent)', background: 'none', border: 'none', cursor: 'pointer', padding: 0 };

const td: CSSProperties = { padding: '10px 12px', borderBottom: '1px solid var(--border)', fontSize: 13.5 };

// ── Review queue ────────────────────────────────────────────────────────────

function ReviewQueue({ caps, types, onOpen, onChanged }: { caps: { review: boolean }; types: ContentTypeDef[]; onOpen: (id: string) => void; onChanged: () => void }) {
  const [rows, setRows] = useState<EntryListItem[]>([]);
  const [rejecting, setRejecting] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const load = () => api.reviewQueue().then(setRows).catch((e) => setErr(e instanceof ApiError ? e.message : String(e)));
  useEffect(() => { load(); }, []);
  const typeTitle = (key: string) => types.find((t) => t.key === key)?.title ?? key;

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setErr('');
    try { await fn(); setRejecting(null); setNote(''); await load(); onChanged(); }
    catch (e) { setErr(e instanceof ApiError ? e.message : String(e)); }
    finally { setBusy(false); }
  };
  const reason = caps.review ? '' : 'Disabled: needs the review permission in this site.';

  return (
    <div>
      <PageTitle sub={`${rows.length} entr${rows.length === 1 ? 'y' : 'ies'} awaiting review · all types`}>Review queue</PageTitle>
      {err && <ErrorNote err={err} />}
      <Card style={{ padding: 0, overflow: 'hidden' }}>
        {rows.length === 0 ? (
          <Empty title="Nothing to review" hint="No entries are in review for this site." />
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead><tr><ColHead>Entry</ColHead><ColHead>Type</ColHead><ColHead>Waiting</ColHead><ColHead>{''}</ColHead></tr></thead>
            <tbody>
              {rows.map((r) => {
                const waited = Date.now() - Date.parse(r.updated_at);
                const stale = waited > 24 * 3600 * 1000;
                const isRejecting = rejecting === r.id;
                return (
                  <Fragment key={r.id}>
                    <tr style={{ borderTop: '1px solid var(--border)' }}>
                      <td style={{ ...td, borderBottom: 'none' }}><button onClick={() => onOpen(r.id)} style={{ font: 'inherit', fontSize: 13.5, color: 'var(--link)', background: 'none', border: 'none', padding: 0, cursor: 'pointer' }}>{r.title}</button></td>
                      <td style={{ ...td, borderBottom: 'none' }}><Mono>{typeTitle(r.type_key)}</Mono></td>
                      <td style={{ ...td, borderBottom: 'none', fontSize: 12.5, color: stale ? 'var(--st-review-fg)' : 'var(--muted)', fontWeight: stale ? 600 : 400 }}>{relativeTime(r.updated_at)}</td>
                      <td style={{ ...td, borderBottom: 'none', textAlign: 'right', whiteSpace: 'nowrap' }}>
                        <span style={{ display: 'inline-flex', gap: 8 }}>
                          <Button size="sm" disabled={!caps.review || busy} title={reason} onClick={() => { setRejecting(isRejecting ? null : r.id); setNote(''); }}>{isRejecting ? 'Rejecting…' : 'Reject…'}</Button>
                          <Button size="sm" variant="primary" disabled={!caps.review || busy} title={reason} onClick={() => act(() => api.approve(r.id))}>Approve</Button>
                        </span>
                      </td>
                    </tr>
                    {isRejecting && (
                      <tr>
                        <td colSpan={4} style={{ padding: '4px 12px 14px', background: 'var(--wash)' }}>
                          <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--st-danger-fg)', margin: '6px 0' }}>Reject with a note (required)</div>
                          <textarea
                            autoFocus
                            value={note}
                            onChange={(e) => setNote(e.target.value)}
                            placeholder="What needs to change before this can be approved?"
                            style={{ width: '100%', maxWidth: 620, minHeight: 64, font: 'inherit', fontSize: 13, padding: '8px 10px', borderRadius: 'var(--r-input)', border: '1px solid var(--st-danger-fg)', background: 'var(--surface)', color: 'var(--ink)', resize: 'vertical' }}
                          />
                          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                            <Button size="sm" variant="primary" disabled={!note.trim() || busy} onClick={() => act(() => api.reject(r.id, note.trim()))}>Reject → back to draft</Button>
                            <Button size="sm" onClick={() => { setRejecting(null); setNote(''); }}>Cancel</Button>
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        )}
      </Card>
      <div style={{ marginTop: 12, fontSize: 12, color: 'var(--faint)' }}>
        Approve moves in_review → approved; reject returns it to draft with the note in the status log — both are audit-logged, no skipping.
      </div>
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
  // Revision authors are stored as principal ids; show a short id (no principal→name directory here).
  const nameOf = (id: string) => `${id.slice(0, 6)}…`;
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

      {/* Workflow bar — status, the state-machine breadcrumb, autosave note, transitions. */}
      <Card style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 16, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 12, color: 'var(--muted)' }}>Status</span>
        <StatusBadge status={status} />
        <StateBreadcrumb status={status} />
        <div style={{ flex: 1 }} />
        <Mono style={{ fontSize: 11.5 }}>rev {detail.entry.draft_rev} · {busy ? 'working…' : `autosaved ${relativeTime(detail.entry.updated_at)}`}</Mono>
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
          types={props.types}
          entryId={props.id}
          initial={detail.body}
          submitLabel="Save draft"
          error={err}
          onCancel={() => setMode('view')}
          onSubmit={(b) => act(async () => { await api.saveDraft(props.id, b); setMode('view'); })}
        />
      )}

      {mode === 'preview' && detail.entry.slug && (
        <DeliveryPreview typeKey={detail.entry.type_key} slug={detail.entry.slug} rev={detail.entry.published_rev} def={def} />
      )}

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
                  <div style={{ fontSize: 13.5 }}>
                    {f.type === 'richText' && typeof detail.body[name] === 'string' && (detail.body[name] as string).trim()
                      ? renderMarkdown(detail.body[name] as string)
                      : renderValue(detail.body[name])}
                  </div>
                </div>
              ))}
          </Card>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <Card>
              <SectionLabel>Revisions</SectionLabel>
              {detail.revisions.slice().reverse().map((r) => {
                const working = r.rev_no === detail.entry.draft_rev;
                const published = r.rev_no === detail.entry.published_rev;
                const canRestore = c.author && (status === 'draft' || status === 'unpublished') && !working;
                return (
                  <div
                    key={r.rev_no}
                    style={{
                      padding: '9px 0 9px 10px',
                      borderBottom: '1px solid var(--border)',
                      borderLeft: working ? '2px solid var(--accent)' : '2px solid transparent',
                      marginLeft: -2,
                    }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }}>
                      <span style={{ fontSize: 13, fontWeight: working || published ? 600 : 400 }}>rev {r.rev_no}</span>
                      {working ? (
                        <span style={{ fontSize: 10.5, fontWeight: 600, letterSpacing: '0.05em', color: 'var(--accent)' }}>WORKING DRAFT</span>
                      ) : published ? (
                        <span style={{ fontSize: 10.5, fontWeight: 600, letterSpacing: '0.05em', color: 'var(--st-published-fg)' }}>PUBLISHED · FROZEN ❄</span>
                      ) : r.frozen ? (
                        <Mono style={{ fontSize: 10.5 }}>❄ frozen</Mono>
                      ) : canRestore ? (
                        <Button size="sm" onClick={() => act(() => api.restore(props.id, r.rev_no))}>Restore</Button>
                      ) : null}
                    </div>
                    <div style={{ marginTop: 3, fontSize: 11.5, color: 'var(--faint)', display: 'flex', gap: 8 }}>
                      <span>{nameOf(r.author)} · {relativeTime(r.created_at)}</span>
                      {r.hash && <Mono style={{ fontSize: 11 }} title={r.hash}>hash {r.hash.slice(0, 4)}…{r.hash.slice(-2)}</Mono>}
                    </div>
                  </div>
                );
              })}
              <div style={{ marginTop: 10, fontSize: 11.5, color: 'var(--muted)', lineHeight: 1.5 }}>
                Revisions are append-only rows in <Mono style={{ fontSize: 11 }}>ct_{detail.entry.type_key}_v{def?.version}</Mono>. Restoring copies a prior row into a new revision — history is never rewritten.
              </div>
            </Card>
            <Card>
              <SectionLabel>Entry</SectionLabel>
              {[
                ['id', <Mono key="id" title={detail.entry.id}>{detail.entry.id.slice(0, 6)}…{detail.entry.id.slice(-4)}</Mono>],
                ['type', <Mono key="t">{detail.entry.type_key} · v{def?.version}</Mono>],
                ['scope', <Mono key="s">{getSite()}</Mono>],
              ].map(([k, v]) => (
                <div key={k as string} style={{ display: 'flex', justifyContent: 'space-between', padding: '5px 0', fontSize: 12.5 }}>
                  <span style={{ color: 'var(--muted)' }}>{k}</span>
                  {v as ReactNode}
                </div>
              ))}
            </Card>
          </div>
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
        types={types}
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

// The draft → in_review → approved → published state machine, current state emphasized,
// already-passed states in ink, future states faint — the mock's persistent workflow breadcrumb.
function StateBreadcrumb({ status }: { status: EntryStatus }) {
  const chain: EntryStatus[] = ['draft', 'in_review', 'approved', 'published'];
  const reached = status === 'unpublished' || status === 'archived' ? 3 : chain.indexOf(status);
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontFamily: 'var(--mono)', fontSize: 12 }}>
      {chain.map((s, i) => (
        <span key={s} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          {i > 0 && <span style={{ color: 'var(--faint)' }}>→</span>}
          <span style={{ color: i === reached ? 'var(--ink)' : i < reached ? 'var(--muted)' : 'var(--faint)', fontWeight: i === reached ? 600 : 400 }}>{s}</span>
        </span>
      ))}
    </span>
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
