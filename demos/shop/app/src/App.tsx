import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, kr, type Cart, type Me, type Quote } from './api';
import { Storefront } from './views/Storefront';
import { Portal } from './views/Portal';
import { Login } from './views/Login';
import { bagColor } from './components';

function useHashRoute(): string {
  const [route, setRoute] = useState(location.hash.slice(1) || '/');
  useEffect(() => {
    const onChange = () => setRoute(location.hash.slice(1) || '/');
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return route;
}

// This app is the storefront only — browse, cart, checkout, "Mina ordrar". The
// back-office is a separate app on :5274 (demos/shop/admin), against this same
// API. Staff who land here are just shoppers with no cart.
const canShop = (r: string) => r === 'customer'; // only logged-in customers get a cart
const isStaff = (r: string) => r === 'shop-admin' || r === 'warehouse';

// Injected by vite.config.ts from ADMIN_PORT, so the hand-off follows the admin
// app if its port moves.
declare const __ADMIN_ORIGIN__: string;

export default function App() {
  const [me, setMe] = useState<Me | null>(null);
  const [loginOpen, setLoginOpen] = useState(false);
  const route = useHashRoute();
  const [theme, setTheme] = useState<'light' | 'dark'>('light');

  const [cartId, setCartId] = useState<string | null>(null);
  const [cart, setCart] = useState<Cart | null>(null);
  const [quote, setQuote] = useState<Quote | null>(null);
  const [drawer, setDrawer] = useState(false);
  const [code, setCode] = useState('');
  const [pay, setPay] = useState<'invoice' | 'card'>('invoice');
  const appliedCode = useRef<string | undefined>(undefined);
  const [toast, setToast] = useState<{ msg: string; ok: boolean } | null>(null);
  const [reload, setReload] = useState(0);

  const notify = useCallback((msg: string, ok = false) => {
    setToast({ msg, ok });
    window.setTimeout(() => setToast(null), 2600);
  }, []);

  useEffect(() => {
    void api.me().then(setMe).catch(() => setMe(null));
  }, []);

  const session = me?.authenticated ? me : null;
  const role = me?.role ?? 'public';
  const display = session?.display ?? '';
  const activeCustomerId = session?.customerId ?? undefined;

  const refreshCart = useCallback(async (id: string) => {
    try {
      setCart(await api.cart(id));
    } catch {
      setCart(null);
    }
  }, []);

  useEffect(() => {
    appliedCode.current = quote?.discountValid ? quote.discountCode ?? undefined : undefined;
  }, [quote]);

  const reprice = useCallback(async (id: string) => {
    try {
      setQuote(await api.quote(id, appliedCode.current));
    } catch {
      setQuote(null);
    }
  }, []);

  const applyCode = useCallback(async () => {
    if (!cartId) return;
    setQuote(await api.quote(cartId, code.trim() || undefined));
  }, [cartId, code]);

  const changeQty = useCallback(
    async (lineId: string, qty: number) => {
      if (!cartId) return;
      try {
        await api.setLineQty(cartId, lineId, qty);
        await refreshCart(cartId);
        await reprice(cartId);
        setReload((n) => n + 1);
      } catch (e) {
        notify((e as Error).message);
      }
    },
    [cartId, refreshCart, reprice, notify],
  );

  const addToCart = useCallback(
    async (variantId: string) => {
      // Only a logged-in customer can build a cart; everyone else logs in first.
      if (role !== 'customer') {
        setLoginOpen(true);
        return;
      }
      try {
        let id = cartId;
        if (!id) {
          id = (await api.createCart()).id;
          setCartId(id);
        }
        await api.addToCart(id, variantId, 1);
        await refreshCart(id);
        await reprice(id);
        setReload((n) => n + 1); // availability drops live
        setDrawer(true);
      } catch (e) {
        notify((e as Error).message);
      }
    },
    [role, cartId, refreshCart, reprice, notify],
  );

  const removeLine = useCallback(
    async (lineId: string) => {
      if (!cartId) return;
      try {
        await api.removeLine(cartId, lineId);
        await refreshCart(cartId);
        await reprice(cartId);
        setReload((n) => n + 1);
      } catch (e) {
        notify((e as Error).message);
      }
    },
    [cartId, refreshCart, reprice, notify],
  );

  const checkout = useCallback(async () => {
    if (!cartId || !activeCustomerId) return;
    try {
      const { order } = await api.checkout(cartId, {
        customerId: activeCustomerId,
        paymentMethod: pay,
        ...(quote?.discountValid && quote.discountCode ? { discountCode: quote.discountCode } : {}),
      });
      notify(`Order #${order.number} lagd — ${kr(order.total_amount)}`, true);
      setCartId(null);
      setCart(null);
      setQuote(null);
      setDrawer(false);
      setCode('');
      setReload((n) => n + 1);
      location.hash = '#/portal';
    } catch (e) {
      notify((e as Error).message);
    }
  }, [cartId, activeCustomerId, pay, quote, notify]);

  const onLoggedIn = useCallback(async () => {
    const m = await api.me();
    setMe(m);
    setLoginOpen(false);
    setCartId(null);
    setCart(null);
    setQuote(null);
    setReload((n) => n + 1);
    location.hash = '#/';
    notify(isStaff(m.role ?? '') ? 'Inloggad — back-office finns i menyn' : 'Inloggad', true);
  }, [notify]);

  const onLogout = useCallback(async () => {
    try {
      await api.signOut();
    } catch {
      /* ignore */
    }
    setMe(await api.me()); // now anonymous
    setCartId(null);
    setCart(null);
    setQuote(null);
    setReload((n) => n + 1);
    location.hash = '#/';
  }, []);

  const count = useMemo(() => cart?.lines.reduce((a, l) => a + l.qty, 0) ?? 0, [cart]);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);

  let view = <Storefront onAdd={addToCart} reloadKey={reload} />;
  if (route.startsWith('/portal')) view = <Portal reloadKey={reload} />;

  const tab = (to: string, label: string, on: boolean) => {
    if (!on) return null;
    const active = route === to || (to !== '/' && route.startsWith(to));
    return (
      <a
        href={`#${to}`}
        className={active ? 'active' : ''}
        // A click on the tab already open is the one someone makes when they suspect
        // the screen is stale — and it changes no hash, so nothing else would refetch.
        // Re-ask the server instead of doing nothing (#801).
        onClick={active ? () => setReload((n) => n + 1) : undefined}
      >
        {label}
      </a>
    );
  };

  return (
    <>
      <header className="bar">
        <div className="wrap bar-in">
          <a className="brand" href="#/">
            <span className="drop" aria-hidden="true" />
            <span className="mark">Kallkälla</span>
          </a>
          <nav className="main">
            {tab('/', 'Butik', true)}
            {tab('/portal', 'Mina ordrar', role === 'customer')}
            {isStaff(role) && (
              <a href={__ADMIN_ORIGIN__}>Back-office ↗</a>
            )}
          </nav>
          <div className="bar-right">
            {session ? (
              <div className="persona">
                <span className="role-badge">🔑 {display}</span>
                <button className="icon-btn" onClick={onLogout}>
                  Logga ut
                </button>
              </div>
            ) : (
              <button className="icon-btn" onClick={() => setLoginOpen(true)}>
                Logga in
              </button>
            )}
            <button className="icon-btn sq" onClick={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))} aria-label="Växla tema">
              ◐
            </button>
            {canShop(role) && (
              <button className="icon-btn" onClick={() => setDrawer(true)} aria-label="Öppna varukorg">
                Varukorg <span className="cart-count">{count}</span>
              </button>
            )}
          </div>
        </div>
      </header>

      {view}

      <div className={`overlay${drawer ? ' open' : ''}`} onClick={() => setDrawer(false)} />
      <aside className={`cart${drawer ? ' open' : ''}`} aria-hidden={!drawer}>
        <div className="cart-h">
          <h3>Din varukorg</h3>
          <button className="x" onClick={() => setDrawer(false)} aria-label="Stäng">
            ×
          </button>
        </div>
        <div className="lines">
          {!cart || cart.lines.length === 0 ? (
            <div className="empty">Din varukorg är tom.<br />Lägg till en påse färskrostat.</div>
          ) : (
            cart.lines.map((l) => (
              <div className="line" key={l.lineId}>
                <div className="thumb" style={{ ['--bag' as string]: bagColor(l.sku.slice(0, 4).toLowerCase()) }} />
                <div>
                  <div className="l-name">{l.name}</div>
                  <div className="l-var">{l.grind} · {l.sizeLabel}</div>
                  <div className="qty">
                    <button aria-label="Minska antal" onClick={() => changeQty(l.lineId, l.qty - 1)}>
                      −
                    </button>
                    <span className="num">{l.qty}</span>
                    <button aria-label="Öka antal" onClick={() => changeQty(l.lineId, l.qty + 1)}>
                      +
                    </button>
                  </div>
                </div>
                <div>
                  <div className="l-price">{kr(l.lineTotal.amount)}</div>
                  <button className="rm" onClick={() => removeLine(l.lineId)}>
                    Ta bort
                  </button>
                </div>
              </div>
            ))
          )}
        </div>
        <div className="cart-f">
          {cart && cart.lines.length > 0 && (
            <div className="faktura-note">Varorna är reserverade i 15 minuter.</div>
          )}
          <div className="code">
            <input
              placeholder="Rabattkod"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void applyCode();
              }}
              aria-label="Rabattkod"
            />
            <button onClick={applyCode}>Använd</button>
          </div>
          {quote?.message && <div className="code-msg err">{quote.message}</div>}
          {quote?.discountValid && (
            <div className="code-msg ok">Rabattkod {quote.discountCode} tillämpad</div>
          )}
          <div className="field">
            <label>Betalsätt</label>
            <select value={pay} onChange={(e) => setPay(e.target.value as 'invoice' | 'card')}>
              <option value="invoice">Mot faktura (skapar underlag)</option>
              <option value="card">Kort (ingen faktura)</option>
            </select>
          </div>
          <div className="totals">
            <div className="r">
              <span>Delsumma</span>
              <span>{kr(quote?.subtotal.amount ?? cart?.subtotal.amount ?? '0')}</span>
            </div>
            {quote?.discountValid && (
              <div className="r disc">
                <span>Rabatt {quote.discountCode}</span>
                <span>−{kr(quote.discount.amount)}</span>
              </div>
            )}
            <div className="r tot">
              <span>Att betala</span>
              <span>{kr(quote?.total.amount ?? cart?.subtotal.amount ?? '0')}</span>
            </div>
          </div>
          <button className="btn" style={{ width: '100%' }} disabled={!cart || cart.lines.length === 0} onClick={checkout}>
            Slutför köp
          </button>
          <div className="faktura-note">Rabatt räknas av i kassan; summan bekräftas på ordern.</div>
        </div>
      </aside>

      {loginOpen && <Login onDone={onLoggedIn} onCancel={() => setLoginOpen(false)} />}
      {toast && <div className={`toast ${toast.ok ? 'ok' : 'err'}`}>{toast.msg}</div>}
    </>
  );
}
