import { useCallback, useEffect, useState, type ReactNode } from 'react';
import {
  api,
  extra,
  currentPrincipal,
  loginAt,
  me,
  setHeaderAuth,
  setPrincipal,
  signOut,
  type CastMember,
  type Session,
} from './api';
import { OrdersView } from './views/Orders';
import { OrderDetailView } from './views/OrderDetail';
import { InvoicingView } from './views/Invoicing';
import { CustomersView } from './views/Customers';
import { PricesView } from './views/Prices';
import { PortalView } from './views/Portal';

function useHashRoute(): string {
  const [route, setRoute] = useState(location.hash.slice(1) || '/');
  useEffect(() => {
    const onChange = () => setRoute(location.hash.slice(1) || '/');
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return route;
}

/**
 * The app is auth-mode-aware: the same UI runs against the node/sqlite dev server
 * (persona `<select>` + `x-principal` header) and the Cloudflare Worker (Better
 * Auth session cookie). On mount we probe `/api/me`:
 *   - header mode  → the node server (no /api/me) → persona picker, as before
 *   - better-auth  → the Worker → session present renders the app, absent shows login
 */
type AuthState =
  | { kind: 'loading' }
  | { kind: 'header' }
  | { kind: 'better-auth'; session: Session | null };

export default function App() {
  const [auth, setAuth] = useState<AuthState>({ kind: 'loading' });

  const probe = useCallback(async () => {
    const result = await me();
    if (result.mode === 'header') {
      setHeaderAuth(true);
      setAuth({ kind: 'header' });
    } else {
      setHeaderAuth(false);
      setAuth({ kind: 'better-auth', session: result.session });
    }
  }, []);

  useEffect(() => {
    void probe();
  }, [probe]);

  if (auth.kind === 'loading') {
    return (
      <main className="page">
        <p className="muted">Laddar…</p>
      </main>
    );
  }
  if (auth.kind === 'header') return <HeaderModeApp />;
  if (!auth.session) return <LoginScreen />;
  return <AuthedApp session={auth.session} onSignOut={() => signOut()} />;
}

/** The shared chrome (topbar + nav + routed view). `identity` is the right-hand slot. */
function AppShell({
  cast,
  isPortal,
  identity,
  sessionKey,
}: {
  cast: Record<string, CastMember>;
  isPortal: boolean;
  identity: ReactNode;
  sessionKey: string;
}) {
  const route = useHashRoute();

  let view = <OrdersView />;
  if (route.startsWith('/orders/')) view = <OrderDetailView orderId={route.split('/')[2] ?? ''} cast={cast} />;
  else if (route.startsWith('/invoicing')) view = <InvoicingView />;
  else if (route.startsWith('/customers')) view = <CustomersView />;
  else if (route.startsWith('/prices')) view = <PricesView />;
  else if (route.startsWith('/portal')) view = <PortalView />;

  return (
    <>
      <header className="topbar">
        <div className="brand">
          Service<span>Co</span> <span className="muted" style={{ fontSize: 11 }}>on Substrat</span>
        </div>
        <nav>
          {!isPortal && (
            <>
              <a href="#/" className={route === '/' || route.startsWith('/orders') ? 'active' : ''}>
                Work order
              </a>
              <a href="#/invoicing" className={route.startsWith('/invoicing') ? 'active' : ''}>
                Invoice basis
              </a>
              <a href="#/customers" className={route.startsWith('/customers') ? 'active' : ''}>
                Kunder
              </a>
              <a href="#/prices" className={route.startsWith('/prices') ? 'active' : ''}>
                Prislista
              </a>
            </>
          )}
          {isPortal && (
            <a href="#/portal" className={route.startsWith('/portal') ? 'active' : ''}>
              Mina ärenden
            </a>
          )}
        </nav>
        {identity}
      </header>
      <main className="page" key={`${sessionKey}:${route}`}>
        {view}
      </main>
    </>
  );
}

/** Node/sqlite dev server: the existing persona `<select>` + `x-principal` flow. */
function HeaderModeApp() {
  const [cast, setCast] = useState<Record<string, CastMember>>({});
  const [who, setWho] = useState<string>('');

  useEffect(() => {
    void extra.cast().then((c) => {
      setCast(c);
      const saved = currentPrincipal();
      const current = Object.entries(c).find(([, m]) => m.principal === saved)?.[0];
      const fallback = Object.keys(c)[0] ?? '';
      const pick = current ?? fallback;
      setWho(pick);
      const member = c[pick];
      if (member) setPrincipal(member.principal);
    });
  }, []);

  const switchTo = useCallback(
    (key: string) => {
      const member = cast[key];
      if (!member) return;
      setWho(key);
      setPrincipal(member.principal);
      const isPortal = member.role === 'portal';
      location.hash = isPortal ? '#/portal' : '#/';
    },
    [cast],
  );

  const role = cast[who]?.role ?? '';
  const isPortal = role === 'portal';

  const identity = (
    <label>
      <select value={who} onChange={(e) => switchTo(e.target.value)}>
        {Object.entries(cast).map(([key, m]) => (
          <option key={key} value={key}>
            {m.name}
          </option>
        ))}
      </select>
    </label>
  );

  return <AppShell cast={cast} isPortal={isPortal} identity={identity} sessionKey={who} />;
}

/** Cloudflare Worker: authenticated via a Better Auth session cookie. */
function AuthedApp({ session, onSignOut }: { session: Session; onSignOut: () => void | Promise<void> }) {
  const isPortal = session.role === 'portal';
  const identity = (
    <div className="row" style={{ gap: 10 }}>
      <span className="muted" style={{ fontSize: 13 }}>
        {session.display} · {session.role}
      </span>
      <button className="btn" onClick={() => void onSignOut()}>
        Logga ut
      </button>
    </div>
  );
  return <AppShell cast={{}} isPortal={isPortal} identity={identity} sessionKey={session.principal} />;
}

/**
 * Sign-in for a hosted instance (Worker mode, no active session). OIDC-only
 * (oidc-only-demos.md): accounts and passwords live at the identity provider, so the only
 * action here is to go there. The first sign-in on a fresh instance still claims the owner
 * seat (→ office-admin) via the worker's provider-agnostic sub→principal binding.
 */
function LoginScreen() {
  return (
    <>
      <header className="topbar">
        <div className="brand">
          Service<span>Co</span> <span className="muted" style={{ fontSize: 11 }}>on Substrat</span>
        </div>
      </header>
      <main className="page">
        <div className="card" style={{ maxWidth: 380, margin: '48px auto' }}>
          <h2>Logga in</h2>
          <p className="muted" style={{ marginBottom: 16 }}>
            Logga in med din identitetsleverantör för att komma åt din arbetsyta.
          </p>
          <button className="btn primary" onClick={() => loginAt('/')}>
            Fortsätt till inloggning
          </button>
        </div>
      </main>
    </>
  );
}
