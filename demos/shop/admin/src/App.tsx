import { useCallback, useEffect, useState } from 'react';
import { api, auth, type Me } from './api';
import { Overview } from './views/Overview';
import { Orders } from './views/Orders';
import { OrderDetail } from './views/OrderDetail';
import { Catalog } from './views/Catalog';
import { Invoicing } from './views/Invoicing';
import { Login } from './views/Login';

function useHashRoute(): string {
  const [route, setRoute] = useState(location.hash.slice(1) || '/');
  useEffect(() => {
    const onChange = () => setRoute(location.hash.slice(1) || '/');
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return route;
}

// Nav hints only — these mirror the roles in PERMISSIONS.md, but the kernel is
// what actually enforces them. Hiding a link is convenience; the operation still
// says no. `warehouse` holds stock:manage and order:fulfil without
// catalog:manage or invoicing:read, so it reaches the catalogue screen but not
// its publish control, and never sees Invoice basis at all.
const STAFF = ['shop-admin', 'warehouse'];
const isStaff = (r: string) => STAFF.includes(r);
const canManageCatalog = (r: string) => r === 'shop-admin';
const canSeeInvoicing = (r: string) => r === 'shop-admin';

// Injected by vite.config.ts from WEB_PORT, so the "Butiken" link follows the
// storefront if its port moves.
declare const __STOREFRONT_ORIGIN__: string;

export default function App() {
  const [me, setMe] = useState<Me | null>(null);
  const [theme, setTheme] = useState<'light' | 'dark'>('light');
  const [toast, setToast] = useState<{ msg: string; ok: boolean } | null>(null);
  const route = useHashRoute();

  const notify = useCallback((msg: string, ok = false) => {
    setToast({ msg, ok });
    window.setTimeout(() => setToast(null), 2600);
  }, []);

  useEffect(() => {
    void api.me().then(setMe).catch(() => setMe({ authenticated: false }));
  }, []);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);

  // Both are navigations to the RP endpoints; the browser returns and the mount effect
  // above re-reads `/api/me`, so there is no local session state to unwind.
  const onLogout = useCallback(() => auth.logout(), []);

  if (!me) return <div className="notice">Laddar…</div>;

  const role = me.role ?? 'public';

  // The gate: unauthenticated, or authenticated as someone with no back-office
  // business here (a shopper). The kernel would deny every call anyway — this
  // just refuses to render a dashboard that could only show errors.
  if (!me.authenticated) return <Login />;
  if (!isStaff(role)) {
    return (
      <Login
        denied={`Inloggad som ${me.display} (${role}) — det här kontot har ingen behörighet till back-office. Logga in som personal.`}
      />
    );
  }

  const orderMatch = /^\/orders\/([^/]+)$/.exec(route);
  let view = <Overview />;
  if (orderMatch) view = <OrderDetail orderId={orderMatch[1]!} notify={notify} />;
  else if (route.startsWith('/orders')) view = <Orders notify={notify} />;
  else if (route.startsWith('/catalog')) view = <Catalog notify={notify} canManageCatalog={canManageCatalog(role)} />;
  else if (route.startsWith('/invoicing')) view = <Invoicing notify={notify} />;

  const link = (to: string, ico: string, label: string, on = true) => {
    if (!on) return null;
    const active = to === '/' ? route === '/' : route.startsWith(to);
    return (
      <a href={`#${to}`} className={active ? 'active' : ''}>
        <span className="ico" aria-hidden="true">{ico}</span>
        {label}
      </a>
    );
  };

  return (
    <div className="shell">
      <aside className="side">
        <div className="brand">
          <span className="drop" aria-hidden="true" />
          <span className="mark">
            Kallkälla
            <small>Back-office</small>
          </span>
        </div>

        <nav>
          {link('/', '◧', 'Översikt')}
          {link('/orders', '▤', 'Ordrar')}
          {link('/catalog', '◍', 'Katalog')}
          {link('/invoicing', '❋', 'Invoice basis', canSeeInvoicing(role))}
        </nav>

        <div className="foot">
          <div className="who">
            <div className="name">{me.display}</div>
            <div className="role">{role}</div>
          </div>
          <div className="foot-row">
            <button onClick={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))} aria-label="Växla tema">
              ◐
            </button>
            <button onClick={() => { window.location.href = __STOREFRONT_ORIGIN__; }}>Butiken</button>
            <button onClick={onLogout}>Logga ut</button>
          </div>
        </div>
      </aside>

      <main className="main">{view}</main>

      {toast && <div className={`toast ${toast.ok ? 'ok' : 'err'}`}>{toast.msg}</div>}
    </div>
  );
}
