import { useCallback, useEffect, useState } from 'react';
import { api, auth, extra, type Me } from './api';
import { RepairsView } from './views/Repairs';
import { RepairDetailView } from './views/RepairDetail';
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

export default function App() {
  const [me, setMe] = useState<Me | null>(null);
  const [role, setRole] = useState<string | null>(null);
  const route = useHashRoute();

  // Two reads, because they answer different questions. `/api/me` is the RP's — WHO is
  // signed in, and 401 while nobody is. `bike-shop/whoami` is the kernel's — what that
  // principal may do IN THIS SCOPE, probed from their own grants. The persona table this
  // replaced answered both, and answered them only locally.
  useEffect(() => {
    void extra
      .me()
      .then(async (m) => {
        setMe(m);
        setRole((await api.whoami()).role);
      })
      .catch(() => setMe(null));
  }, []);

  // Portal by EXCLUSION: a portal login is entity-narrowed and holds no node-level
  // permission to probe, so `whoami` calls it `none`. That is true whoever is asking,
  // which the persona table's `role: 'portal'` never was.
  const isPortal = role !== null && role !== 'workshop-admin' && role !== 'mechanic';

  if (me === null) {
    return (
      <div className="page">
        <h1>CykelService</h1>
        <p>Logga in för att fortsätta.</p>
        <button className="btn" onClick={() => auth.login('/')}>
          Logga in
        </button>
      </div>
    );
  }

  let view = <RepairsView />;
  if (route.startsWith('/repairs/')) view = <RepairDetailView repairId={route.split('/')[2] ?? ''} />;
  else if (route.startsWith('/invoicing')) view = <InvoicingView />;
  else if (route.startsWith('/customers')) view = <CustomersView />;
  else if (route.startsWith('/prices')) view = <PricesView />;
  else if (route.startsWith('/portal')) view = <PortalView />;

  return (
    <>
      <header className="topbar">
        <div className="brand">
          Cykel<span>Service</span> <span className="muted" style={{ fontSize: 11 }}>on Substrat</span>
        </div>
        <nav>
          {!isPortal && (
            <>
              <a href="#/" className={route === '/' || route.startsWith('/repairs') ? 'active' : ''}>
                Reparationer
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
              Mina reparationer
            </a>
          )}
        </nav>
        <div className="persona">
          <span className="muted">{me.display}</span>
          <button className="btn" onClick={() => auth.logout()}>
            Logga ut
          </button>
        </div>
      </header>
      <main className="page" key={`${me.principal}:${route}`}>
        {view}
      </main>
    </>
  );
}
