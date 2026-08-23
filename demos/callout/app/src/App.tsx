import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { api, extra, loginAt, me, signOut, type Session } from './api';
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
 * One auth path, whichever backend is behind it: ask `/api/me` for the session the cookie
 * carries, show the app if there is one and the sign-in screen if there is not.
 *
 * This used to fork. A 404 from `/api/me` meant the node dev server, which put the app into
 * a second mode driven by a persona `<select>` and an `x-principal` header — a login no
 * deployment ran, and therefore one no amount of local use could exercise. The picker still
 * exists; it moved to the dev issuer, on the other side of a real OIDC redirect.
 */
type AuthState = { kind: 'loading' } | { kind: 'ready'; session: Session | null };

export default function App() {
  const [auth, setAuth] = useState<AuthState>({ kind: 'loading' });

  useEffect(() => {
    void me().then((session) => setAuth({ kind: 'ready', session }));
  }, []);

  if (auth.kind === 'loading') {
    return (
      <main className="page">
        <p className="muted">Laddar…</p>
      </main>
    );
  }
  if (!auth.session) return <LoginScreen />;
  return <AuthedApp session={auth.session} onSignOut={() => signOut()} />;
}

/** The shared chrome (topbar + nav + routed view). `identity` is the right-hand slot. */
function AppShell({
  isPortal,
  identity,
  sessionKey,
}: {
  isPortal: boolean;
  identity: ReactNode;
  sessionKey: string;
}) {
  const route = useHashRoute();

  let view = <OrdersView />;
  if (route.startsWith('/orders/')) view = <OrderDetailView orderId={route.split('/')[2] ?? ''} />;
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

/** Signed in: the session cookie is the identity, and `/api/me` resolved it. */
function AuthedApp({ session, onSignOut }: { session: Session; onSignOut: () => void | Promise<void> }) {
  // Portal chrome is what's left when neither staff role applies. `callout/whoami` derives the
  // role by probing node-level permissions, and a portal customer holds none — their access is
  // entity-narrowed grants per customer — so it can only ever answer `none` for them. The dev
  // cast used to paper over that by declaring `role: 'portal'` itself, which is precisely the
  // kind of fact that existed in one environment only. Deciding it by exclusion is true in both.
  const isPortal = session.role !== 'office-admin' && session.role !== 'technician';
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
  return <AppShell isPortal={isPortal} identity={identity} sessionKey={session.principal} />;
}

/**
 * Sign-in: no active session. OIDC-only (oidc-only-demos.md): accounts and passwords live at
 * the identity provider, so the only action here is to go there — locally that is the dev
 * issuer's picker, hosted it is the tenant's own issuer. On a fresh hosted instance the first
 * sign-in also claims the owner seat (→ office-admin) via the provider-agnostic sub→principal
 * binding.
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
