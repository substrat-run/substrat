import { useCallback, useEffect, useMemo, useState } from 'react';
import type { EntitlementGrant, HostnameBinding, Scope, ScopeId, Tenant, TenantId } from '@substrat-run/contracts';
import { Card, Toast, useAutoRefresh } from './components';
import { scopeHandle } from './lib/fleet';
import { ConsoleShell } from './ConsoleShell';
import type { ViewKey } from './ConsoleShell';
import type { BreadcrumbItem } from './components';
import { createApi, walkAll } from './lib/api';
import type { PlatformRuntime } from './lib/cf-links';
import { getSession, signIn, signOut, type StaffSession } from './lib/auth';
import { AdminLog } from './views/AdminLog';
import { Domains } from './views/Domains';
import { Meters } from './views/Meters';
import { Observability } from './views/Observability';
import { Login } from './views/Login';
import { Members } from './views/Members';
import { OpsFailures } from './views/OpsFailures';
import { Permissions } from './views/Permissions';
import { ScopeDetail } from './views/ScopeDetail';
import { Scopes } from './views/Scopes';
import { Settings } from './views/Settings';
import { TenantDetail } from './views/TenantDetail';
import { Tenants } from './views/Tenants';
import { Verticals } from './views/Verticals';

/**
 * The dev actor. Read from a query param, localStorage, or a build-time default
 * (`VITE_DEV_ACTOR`, set by the root `pnpm dev` stack) so the console can be
 * pointed at whatever the local API printed on boot — or just work out of the
 * box against the shared-host dev stack with no copy-paste.
 *
 * This is the stub end of §6's identity seam. It is not authentication and is
 * not pretending to be: the API is what refuses an unknown actor, and real staff
 * auth (SSO/MFA, short sessions) gates EXPOSING any of this — nothing with
 * cross-tenant reach goes anywhere non-local on a stub.
 */
function useDevActor(): [string, (v: string) => void] {
  const [actor, setActor] = useState(() => {
    const fromUrl = new URLSearchParams(window.location.search).get('actor');
    if (fromUrl) localStorage.setItem('substrat.actor', fromUrl);
    const envDefault = import.meta.env.VITE_DEV_ACTOR as string | undefined;
    return fromUrl ?? localStorage.getItem('substrat.actor') ?? envDefault ?? '';
  });
  return [
    actor,
    (v: string) => {
      localStorage.setItem('substrat.actor', v);
      setActor(v);
    },
  ];
}

interface Toast {
  title: string;
  detail?: string;
  status: 'success' | 'danger';
}

const VIEWS: ViewKey[] = [
  'tenants',
  'scopes',
  'domains',
  'verticals',
  'observability',
  'meters',
  'admin-log',
  'permissions',
  'members',
  'failures',
  'settings',
];

/**
 * Navigation lives in the URL path — `/scopes`, `/verticals`, and one drilled-in
 * segment (`/scopes/<id>`, `/tenants/<id>`, `/verticals/<slug>`) — so a refresh or
 * a shared link lands where you were, not back on the start page. Clean paths, not
 * `?view=` query params (the control-plane worker serves the SPA with
 * `not_found_handling: single-page-application`, so a deep path resolves on refresh).
 * The `actor` search param is left untouched (useDevActor owns it). Per-view state
 * (a filter tab, a text query) is not encoded, yet.
 *
 * Detail identifier per view: id for tenant and scope, slug for vertical.
 */
interface Nav {
  view: ViewKey;
  tenant?: TenantId;
  scope?: ScopeId;
  vertical?: string;
}

function readNav(): Nav {
  const segments = window.location.pathname.split('/').filter(Boolean);
  const first = segments[0];
  // Back-compat: an old `?view=` link (or a bare `/`) still resolves; writeNav
  // then normalizes it to the path form on the next reflect.
  const legacy = new URLSearchParams(window.location.search).get('view');
  const candidate = first ?? legacy ?? undefined;
  const view = candidate && (VIEWS as string[]).includes(candidate) ? (candidate as ViewKey) : 'tenants';
  const detail = segments[1];
  const nav: Nav = { view };
  if (detail) {
    if (view === 'tenants') nav.tenant = detail as TenantId;
    else if (view === 'scopes') nav.scope = detail as ScopeId;
    else if (view === 'verticals') nav.vertical = detail;
  }
  return nav;
}

function writeNav(view: ViewKey, detail?: string): void {
  const path = `/${view}${detail ? `/${detail}` : ''}`;
  // Preserve the search so the dev `?actor=` override survives — but drop a legacy
  // `?view=` once we've read it into the path, so a back-compat link normalizes fully
  // to `/scopes` rather than lingering as `/scopes?view=scopes`.
  const p = new URLSearchParams(window.location.search);
  p.delete('view');
  const search = p.toString();
  const url = `${path}${search ? `?${search}` : ''}`;
  // Push when the path actually changes so Back returns to the previous view
  // instead of leaving the console. Replace when it doesn't: the initial mount
  // (normalizing a legacy `?view=` link) and the reflect that runs after a
  // popstate — pushing there would re-stack the entry Back just popped.
  if (window.location.pathname === path) {
    window.history.replaceState(null, '', url);
  } else {
    window.history.pushState(null, '', url);
  }
}

// Co-located quick path: a build-time dev actor (set by `pnpm dev`) means the
// UNSAFE header stub is in play and no login is needed. Absent it (the standalone
// control plane, `pnpm dev:connected`, and deploys), the console runs in session
// mode and requires real staff sign-in.
const DEV_ACTOR = import.meta.env.VITE_DEV_ACTOR as string | undefined;
const devMode = !!DEV_ACTOR;

export function App() {
  const [actor, setActor] = useDevActor();
  // undefined = checking session; null = signed out; StaffSession = signed in.
  // Dev mode short-circuits to "always in".
  const [session, setSession] = useState<StaffSession | null | undefined>(
    devMode ? { email: 'dev-actor' } : undefined,
  );
  const [view, setView] = useState<ViewKey>(() => readNav().view);
  const [openTenant, setOpenTenant] = useState<TenantId | undefined>(() => readNav().tenant);
  const [openScope, setOpenScope] = useState<ScopeId | undefined>(() => readNav().scope);
  const [openVertical, setOpenVertical] = useState<string | undefined>(() => readNav().vertical);
  // A vertical's "view failures" jump pre-narrows the Failures view; sidebar nav clears it.
  const [failuresVertical, setFailuresVertical] = useState<string | undefined>();
  const [dark, setDark] = useState(false);
  const [toast, setToast] = useState<Toast>();
  const [error, setError] = useState<string>();

  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [scopes, setScopes] = useState<Scope[]>([]);
  const [entitlements, setEntitlements] = useState<Map<TenantId, EntitlementGrant[]>>(new Map());
  const [hostnames, setHostnames] = useState<HostnameBinding[]>([]);
  // Where this platform's scripts and stores live, so the detail views can link into the
  // Cloudflare dashboard. Deployment-wide and immutable, so it is fetched once here rather
  // than per view; null (unconfigured, or the read failed) simply means no links.
  const [runtime, setRuntime] = useState<PlatformRuntime | null>(null);

  // Dev mode authenticates with the actor header; session mode with the cookie.
  const api = useMemo(() => createApi(devMode ? actor : null), [actor]);
  const authed = devMode ? !!actor : !!session;

  // Check for an existing staff session on load (session mode only). Signed out →
  // hand straight off to the IdP (there is no local sign-in page). The one exception
  // is a failed login round-trip (`?error=auth`), where redirecting again would
  // loop — that renders the retry card instead.
  useEffect(() => {
    if (devMode) return;
    void getSession().then((s) => {
      if (s === null && new URLSearchParams(window.location.search).get('error') !== 'auth') {
        const here = `${window.location.pathname}${window.location.search}`;
        signIn(here !== '/' ? { returnTo: here } : {});
        return; // session stays undefined → blank page while the browser navigates
      }
      setSession(s);
    });
  }, []);

  useEffect(() => {
    document.documentElement.dataset['theme'] = dark ? 'dark' : 'light';
  }, [dark]);

  // The drilled-in segment for the current view (each view carries at most one).
  const openDetail = view === 'tenants' ? openTenant : view === 'scopes' ? openScope : view === 'verticals' ? openVertical : undefined;

  // Reflect nav into the URL so a refresh restores it.
  useEffect(() => {
    writeNav(view, openDetail);
  }, [view, openDetail]);

  // Honour browser back/forward.
  useEffect(() => {
    const onPop = () => {
      const n = readNav();
      setView(n.view);
      setOpenTenant(n.tenant);
      setOpenScope(n.scope);
      setOpenVertical(n.vertical);
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(undefined), 4500);
    return () => clearTimeout(t);
  }, [toast]);

  const load = useCallback(async () => {
    if (!authed) return;
    try {
      // Walked to exhaustion, not one page: everything the console COMPUTES —
      // cascade status, fleet counts, portal links, the bindable-scope dropdown,
      // a deep-linked tenant detail — needs the whole directory, and a silent
      // first page would make those aggregates lie. The list VIEWS page their
      // own tables (use-paged-list.ts); these arrays feed the computations.
      const [ts, ss, hs] = await Promise.all([
        walkAll((p) => api.listTenants(p)),
        walkAll((p) => api.listScopes(p)),
        walkAll((p) => api.listHostnames(p)),
      ]);
      // No batch read for entitlements — one call per tenant. Fine at fleet
      // sizes the console handles today; a real N+1 to revisit if it isn't.
      const keys = await Promise.all(ts.map((t) => api.listEntitlements(t.id)));
      setTenants(ts);
      setScopes(ss);
      setHostnames(hs);
      setEntitlements(new Map(ts.map((t, i) => [t.id, keys[i] ?? []])));
      setError(undefined);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [api, authed]);

  useEffect(() => {
    void load();
  }, [load]);

  // Keep the directory live without a manual browser reload: refetch when the tab
  // regains focus, plus a slow poll while it stays visible. 60s (not the hook's 30s
  // default) because each load() is a full directory walk plus the per-tenant
  // entitlements N+1 — cheap at today's fleet size, but not something to double.
  useAutoRefresh(load, { enabled: authed, intervalMs: 60_000 });

  // Fetched alongside the directory, but never with it: a control plane with no runtime
  // configured is a normal deployment, so a failure here must not surface as a console-wide
  // error — it costs links, nothing else.
  useEffect(() => {
    if (!authed) return;
    let cancelled = false;
    api
      .platformRuntime()
      .then((r) => {
        if (!cancelled) setRuntime(r);
      })
      .catch(() => {
        if (!cancelled) setRuntime(null);
      });
    return () => {
      cancelled = true;
    };
  }, [api, authed]);

  const tenantMap = useMemo(() => new Map(tenants.map((t) => [t.id, t])), [tenants]);
  const notify = useCallback(
    (title: string, detail?: string, status: 'success' | 'danger' = 'success') =>
      setToast({ title, detail, status }),
    [],
  );

  const tenantDetail = openTenant ? tenantMap.get(openTenant) : undefined;
  const scopeDetail = view === 'scopes' && openScope ? scopes.find((s) => s.id === openScope) : undefined;

  // Clear whichever drill-in the current view owns — the view-name crumb returns to its list.
  const clearDetail = () => {
    setOpenTenant(undefined);
    setOpenScope(undefined);
    setOpenVertical(undefined);
  };
  const detailCrumb: BreadcrumbItem | undefined = tenantDetail
    ? { label: tenantDetail.slug, mono: true }
    : scopeDetail
      ? { label: scopeHandle(scopeDetail, tenantMap), mono: true }
      : view === 'verticals' && openVertical
        ? { label: openVertical, mono: true }
        : undefined;

  const crumbs: BreadcrumbItem[] = [
    { label: view === 'settings' || view === 'members' ? 'Console' : view === 'failures' ? 'Operations' : 'Fleet' },
    { label: view === 'admin-log' ? 'Admin log' : view[0]!.toUpperCase() + view.slice(1), onClick: clearDetail },
    ...(detailCrumb ? [detailCrumb] : []),
  ];

  // Session mode: checking → blank (also covers the redirect to the IdP); signed out
  // → the login-failed retry card (only reachable via `?error=auth`). (Dev mode keeps
  // session pinned to a placeholder, so it never reaches here without an actor.)
  if (!devMode && session === undefined) {
    return <div style={{ height: '100vh', background: 'var(--surface-page)' }} />;
  }
  if (!devMode && session === null) {
    return <Login />;
  }

  // Dev mode with no actor yet: paste one (the quick co-located path).
  if (devMode && !actor) {
    return (
      <div style={{ display: 'grid', placeItems: 'center', height: '100vh', background: 'var(--surface-page)' }}>
        <Card title="Dev actor required" description="The control-plane API refuses any request without one (§4.4).">
          <p style={{ margin: '0 0 12px', fontSize: 13, color: 'var(--text-secondary)', maxWidth: 460, lineHeight: '19px' }}>
            Start the API with <code style={{ fontFamily: 'var(--font-mono)' }}>pnpm --filter @substrat-run/control-plane-api dev</code>{' '}
            and open this console with the actor it prints:
          </p>
          <code style={{ fontFamily: 'var(--font-mono)', fontSize: 12.5, color: 'var(--text-tertiary)' }}>
            ?actor=&lt;PlatformActorId&gt;
          </code>
          <div style={{ marginTop: 12 }}>
            <input
              placeholder="Paste the PlatformActorId"
              onKeyDown={(e) => e.key === 'Enter' && setActor((e.target as HTMLInputElement).value.trim())}
              style={{
                width: 380,
                height: 32,
                padding: '0 10px',
                borderRadius: 'var(--radius-sm)',
                border: '1px solid var(--border-default)',
                background: 'var(--surface-card)',
                color: 'var(--text-primary)',
                fontFamily: 'var(--font-mono)',
                fontSize: 12.5,
              }}
            />
          </div>
        </Card>
      </div>
    );
  }

  return (
    <ConsoleShell
      active={view}
      onNav={(v) => {
        setView(v);
        setFailuresVertical(undefined);
        clearDetail();
      }}
      onToggleDark={() => setDark((d) => !d)}
      crumbs={crumbs}
      tenantCount={tenants.length}
      scopeCount={scopes.length}
      hostnameCount={hostnames.length}
      identityLabel={devMode ? undefined : session?.email}
      onSignOut={devMode ? undefined : () => signOut()}
    >
      {error && (
        <Card style={{ marginBottom: 16 }}>
          <span style={{ fontSize: 13, color: 'var(--status-danger-fg)' }}>{error}</span>
        </Card>
      )}

      {view === 'tenants' &&
        (tenantDetail ? (
          <TenantDetail
            api={api}
            tenant={tenantDetail}
            scopes={scopes.filter((s) => s.tenantId === tenantDetail.id)}
            entitlements={entitlements.get(tenantDetail.id) ?? []}
            hostnames={hostnames}
            runtime={runtime}
            provisionedByName={
              tenantDetail.provisionedByTenant ? tenantMap.get(tenantDetail.provisionedByTenant)?.name : undefined
            }
            onOpen={setOpenTenant}
            onBack={() => setOpenTenant(undefined)}
            onChanged={() => void load()}
            onToast={notify}
          />
        ) : (
          <Tenants
            api={api}
            tenants={tenants}
            scopes={scopes}
            entitlements={entitlements}
            onOpen={setOpenTenant}
            onChanged={() => void load()}
            onToast={notify}
          />
        ))}

      {view === 'scopes' &&
        (scopeDetail ? (
          <ScopeDetail
            api={api}
            scope={scopeDetail}
            tenants={tenantMap}
            hostnames={hostnames}
            runtime={runtime}
            onBack={() => setOpenScope(undefined)}
            onChanged={() => void load()}
            onToast={notify}
          />
        ) : (
          <Scopes
            api={api}
            scopes={scopes}
            tenants={tenantMap}
            entitlements={entitlements}
            hostnames={hostnames}
            onOpen={setOpenScope}
            onChanged={() => void load()}
            onToast={notify}
          />
        ))}
      {view === 'domains' && (
        <Domains
          api={api}
          scopes={scopes}
          tenants={tenantMap}
          hostnames={hostnames}
          onChanged={() => void load()}
          onToast={notify}
        />
      )}
      {view === 'verticals' && (
        <Verticals
          api={api}
          openSlug={openVertical}
          onOpen={setOpenVertical}
          onBack={() => setOpenVertical(undefined)}
          onOpenFailures={(slug) => {
            setFailuresVertical(slug);
            setView('failures');
            clearDetail();
          }}
          onToast={notify}
        />
      )}
      {view === 'observability' && <Observability api={api} />}
      {view === 'meters' && (
        <Meters
          api={api}
          tenants={tenantMap}
          onOpenTenant={(id) => {
            setView('tenants');
            setOpenTenant(id);
          }}
          onToast={notify}
        />
      )}
      {view === 'admin-log' && <AdminLog api={api} tenants={tenantMap} />}
      {view === 'failures' && <OpsFailures api={api} tenants={tenantMap} initialVertical={failuresVertical} />}
      {view === 'permissions' && <Permissions api={api} tenants={tenantMap} />}
      {view === 'members' && <Members api={api} onToast={notify} />}
      {view === 'settings' && <Settings api={api} onToast={notify} />}

      {toast && (
        <div style={{ position: 'fixed', right: 24, bottom: 24, zIndex: 50 }}>
          <Toast status={toast.status} title={toast.title} detail={toast.detail} />
        </div>
      )}
    </ConsoleShell>
  );
}
