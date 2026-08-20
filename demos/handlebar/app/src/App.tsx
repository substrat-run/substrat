import { useCallback, useEffect, useState } from 'react';
import { api, extra, currentPrincipal, setPrincipal, type CastMember } from './api';
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
  const [cast, setCast] = useState<Record<string, CastMember>>({});
  const [who, setWho] = useState<string>('');
  const route = useHashRoute();

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

  let view = <RepairsView />;
  if (route.startsWith('/repairs/')) view = <RepairDetailView repairId={route.split('/')[2] ?? ''} cast={cast} />;
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
        <label>
          <select value={who} onChange={(e) => switchTo(e.target.value)}>
            {Object.entries(cast).map(([key, m]) => (
              <option key={key} value={key}>
                {m.name}
              </option>
            ))}
          </select>
        </label>
      </header>
      <main className="page" key={`${who}:${route}`}>
        {view}
      </main>
    </>
  );
}
