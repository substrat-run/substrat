import { Fragment, useCallback, useEffect, useState } from 'react';
import { useAutoRefresh } from '@substrat-run/ui';
import { api, ApiError, kr, type OrderRow, type OrderLineRow } from '../api';

export function Portal({ reloadKey }: { reloadKey: number }) {
  const [orders, setOrders] = useState<OrderRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [lines, setLines] = useState<OrderLineRow[]>([]);

  // Revalidate-and-deny: an answer the server just refused does not stay on the
  // screen under the notice — the wall replaces it (#801). Both reads of this
  // screen land here: the order list and the lines of one order.
  const refused = useCallback((e: unknown) => {
    setError((e as Error).message);
    if (e instanceof ApiError && e.status === 403) {
      setOrders(null);
      setOpen(null);
      setLines([]);
    }
  }, []);

  const load = useCallback(async () => {
    try {
      setOrders(await api.portalOrders());
      setError(null);
    } catch (e) {
      refused(e);
    }
  }, [refused]);
  // `reloadKey` is the app's "something changed" counter — a checkout, a login, a
  // click on the tab already open.
  useEffect(() => {
    void load();
  }, [load, reloadKey]);
  // The screen outlives the grant: focus, visibility and a slow poll re-ask.
  useAutoRefresh(load);

  const expand = async (id: string) => {
    if (open === id) { setOpen(null); return; }
    try {
      const detail = await api.order(id);
      setLines(detail.lines);
      setOpen(id);
    } catch (e) {
      refused(e);
    }
  };

  if (error) return <div className="wrap page"><div className="notice deny">{error}</div></div>;
  if (!orders) return <div className="wrap page"><div className="notice">Laddar dina ordrar…</div></div>;

  return (
    <div className="wrap page">
      <div className="sec-head">
        <div className="eyebrow">Mitt konto</div>
        <h1>Mina beställningar</h1>
        <p>Du ser exakt dina egna ordrar — grannens är osynliga (behörighetsgången order → kund).</p>
      </div>
      <div className="panel">
        <table>
          <thead>
            <tr>
              <th className="num">Nr</th>
              <th>Status</th>
              <th>Betalning</th>
              <th className="num">Summa</th>
            </tr>
          </thead>
          <tbody>
            {orders.length === 0 && (
              <tr><td colSpan={4}><div className="notice">Du har inga beställningar ännu.</div></td></tr>
            )}
            {orders.map((o) => (
              <Fragment key={o.id}>
                <tr className="clickable" onClick={() => expand(o.id)}>
                  <td className="num">#{o.number}</td>
                  <td><span className={`pill ${o.status}`}>{o.status}</span></td>
                  <td>{o.payment_method === 'invoice' ? 'Mot faktura' : 'Kort'}</td>
                  <td className="num">{kr(o.total_amount)}</td>
                </tr>
                {open === o.id &&
                  lines.map((l) => (
                    <tr key={l.id}>
                      <td />
                      <td colSpan={2}>
                        <span className="muted num">{l.qty} ×</span> {l.name} — {l.grind}, {l.size_label}
                      </td>
                      <td className="num">{kr(l.line_total_amount)}</td>
                    </tr>
                  ))}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
