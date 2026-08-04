import { useEffect, useState } from 'react';
import { api, type Underlag, type UnderlagLine } from '../api';
import { StatusPill } from './Orders';

export function InvoicingView() {
  const [underlag, setUnderlag] = useState<Underlag[] | null>(null);
  const [openId, setOpenId] = useState<string>('');
  const [lines, setLines] = useState<UnderlagLine[]>([]);
  const [error, setError] = useState('');

  const load = () => {
    void api.invoicing().then(setUnderlag).catch((e: Error) => setError(e.message));
  };
  useEffect(load, []);

  const toggle = async (id: string) => {
    if (openId === id) return setOpenId('');
    const detail = await api.underlag(id);
    setLines(detail.lines);
    setOpenId(id);
  };

  const doExport = async (id: string) => {
    setError('');
    try {
      await api.exportUnderlag(id);
      load();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  if (error && !underlag) return <div className="alert error">{error}</div>;
  if (!underlag) return <p className="muted">Laddar…</p>;

  return (
    <>
      <h1>Fakturaunderlag</h1>
      <p className="sub">
        Byggs automatiskt av invoicing-motorn när arbetsorder slutförs — snapshot, aldrig join.
      </p>
      {error && <div className="alert error">{error}</div>}
      {underlag.map((u) => (
        <div className="card" key={u.id}>
          <div className="row">
            <strong>Underlag #{u.number}</strong>
            <StatusPill status={u.status} />
            <span className="grow" />
            <strong>{u.total} SEK</strong>
            <button className="btn" onClick={() => toggle(u.id)}>
              {openId === u.id ? 'Dölj rader' : 'Visa rader'}
            </button>
            {u.status === 'open' && (
              <button className="btn primary" onClick={() => doExport(u.id)}>
                Exportera
              </button>
            )}
          </div>
          {openId === u.id && (
            <table className="grid" style={{ marginTop: 12 }}>
              <thead>
                <tr>
                  <th>Artikel</th>
                  <th>Beskrivning</th>
                  <th className="right">Antal</th>
                  <th className="right">À-pris</th>
                  <th className="right">Summa</th>
                  <th>Källa</th>
                </tr>
              </thead>
              <tbody>
                {lines.map((l) => (
                  <tr key={l.id}>
                    <td>{l.article}</td>
                    <td>{l.description}</td>
                    <td className="num">
                      {l.qty} {l.unit}
                    </td>
                    <td className="num">{l.unit_price_amount}</td>
                    <td className="num">{l.line_total_amount}</td>
                    <td>
                      <a href={`#/orders/${l.document_id}`}>
                        {l.document_type}:{l.document_id.slice(0, 8)}…
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      ))}
      {underlag.length === 0 && <p className="muted">Inga underlag ännu — slutför en arbetsorder.</p>}
    </>
  );
}
