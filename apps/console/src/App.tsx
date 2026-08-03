import { useCallback, useEffect, useMemo, useState } from 'react';
import type { EntitlementGrant, HostnameBinding, Scope, Tenant, TenantId } from '@substrat-run/contracts';
import { Card, Toast } from './components';
import { ConsoleShell } from './ConsoleShell';
import type { ViewKey } from './ConsoleShell';
import type { BreadcrumbItem } from './components';
import { createApi, walkAll } from './lib/api';
import { getSession, signIn, signOut, type StaffSession } from './lib/auth';
import { AdminLog } from './views/AdminLog';
import { Domains } from './views/Domains';
import { Observability } from './views/Observability';
import { Login } from './views/Login';
import { Permissions } from './views/Permissions';
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

const VIEWS: ViewKey[] = ['tenants', 'scopes', 'domains', 'verticals', 'observability', 'admin-log', 'permissions', 'settings'];

/**
 * Navigation lives in the URL — which view, and any drilled-into tenant — so a
 * refresh or a shared link lands where you were, not back on the start page. The
 * `actor` param is left untouched (useDevActor owns it). Only top-level nav is
 * encoded; per-view state (a selected scope, a filter tab) is not, yet.
 */
function readNav(): { view: ViewKey; tenant?: TenantId } {
  const p = new URLSearchParams(window.location.search);
  const v = p.get('view');
  const view = v && (VIEWS as string[]).includes(v) ? (v as ViewKey) : 'tenants';
  return { view, tenant: (p.get('tenant') as TenantId | null) ?? undefined };
}

function writeNav(view: ViewKey, tenant?: TenantId): void {
  const p = new URLSearchParams(window.location.search);
  p.set('view', view);
  if (tenant) p.set('tenant', tenant);
  else p.delete('tenant');
  // replaceState, not push: a refresh should restore state without every nav
  // click stacking a history entry. Back/forward still works via popstate below.
  window.history.replaceState(null, '', `${window.location.pathname}?${p.toString()}`);
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
  const [dark, setDark] = useState(false);
  const [toast, setToast] = useState<Toast>();
  const [error, setError] = useState<string>();

  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [scopes, setScopes] = useState<Scope[]>([]);
  const [entitlements, setEntitlements] = useState<Map<TenantId, EntitlementGrant[]>>(new Map());
  const [hostnames, setHostnames] = useState<HostnameBinding[]>([]);

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

  // Reflect nav into the URL so a refresh restores it.
  useEffect(() => {
    writeNav(view, openTenant);
  }, [view, openTenant]);

  // Honour browser back/forward.
  useEffect(() => {
    const onPop = () => {
      const n = readNav();
      setView(n.view);
      setOpenTenant(n.tenant);
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

  const tenantMap = useMemo(() => new Map(tenants.map((t) => [t.id, t])), [tenants]);
  const notify = useCallback(
    (title: string, detail?: string, status: 'success' | 'danger' = 'success') =>
      setToast({ title, detail, status }),
    [],
  );

  const detail = openTenant ? tenantMap.get(openTenant) : undefined;

  const crumbs: BreadcrumbItem[] = [
    { label: view === 'settings' ? 'Console' : 'Fleet' },
    { label: view === 'admin-log' ? 'Admin log' : view[0]!.toUpperCase() + view.slice(1), onClick: () => setOpenTenant(undefined) },
    ...(detail ? [{ label: detail.slug, mono: true }] : []),
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
        setOpenTenant(undefined);
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
        (detail ? (
          <TenantDetail
            api={api}
            tenant={detail}
            scopes={scopes.filter((s) => s.tenantId === detail.id)}
            entitlements={entitlements.get(detail.id) ?? []}
            hostnames={hostnames}
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

      {view === 'scopes' && (
        <Scopes api={api} scopes={scopes} tenants={tenantMap} entitlements={entitlements} hostnames={hostnames} onChanged={() => void load()} onToast={notify} />
      )}
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
      {view === 'verticals' && <Verticals api={api} onToast={notify} />}
      {view === 'observability' && <Observability api={api} />}
      {view === 'admin-log' && <AdminLog api={api} tenants={tenantMap} />}
      {view === 'permissions' && <Permissions api={api} tenants={tenantMap} />}
      {view === 'settings' && <Settings />}

      {toast && (
        <div style={{ position: 'fixed', right: 24, bottom: 24, zIndex: 50 }}>
          <Toast status={toast.status} title={toast.title} detail={toast.detail} />
        </div>
      )}
    </ConsoleShell>
  );
}
