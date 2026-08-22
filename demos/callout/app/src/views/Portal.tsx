import { useEffect, useState } from 'react';
import { api, extra, type TimelineEntry, type WorkOrder } from '../api';

const PLAIN: Record<string, string> = {
  planned: 'Planerad',
  in_progress: 'Pågår',
  completed: 'Utförd',
  closed: 'Avslutad',
};

const PORTAL_EVENTS: Record<string, string> = {
  'workorder.created': 'Ärendet registrerades',
  'workorder.assigned': 'Tekniker tilldelad',
  'workorder.started': 'Arbetet påbörjades',
  'workorder.completed': 'Arbetet utfört',
  'workorder.closed': 'Ärendet avslutat',
};

export function PortalView() {
  const [orders, setOrders] = useState<WorkOrder[] | null>(null);
  const [openId, setOpenId] = useState('');
  const [timeline, setTimeline] = useState<TimelineEntry[]>([]);
  const [error, setError] = useState('');

  useEffect(() => {
    api.portalOrders().then((page) => setOrders(page.entries)).catch((e: Error) => setError(e.message));
  }, []);

  const toggle = async (id: string) => {
    if (openId === id) return setOpenId('');
    const t = await extra.timeline(id);
    setTimeline(t.filter((e) => PORTAL_EVENTS[e.type]));
    setOpenId(id);
  };

  if (error) return <div className="alert error">{error}</div>;
  if (!orders) return <p className="muted">Laddar…</p>;

  return (
    <>
      <h1>Mina ärenden</h1>
      <p className="sub">
        Du ser exakt de ärenden som hör till din organisation — inget annat. Isoleringen
        bevisas av kärnan vid varje läsning, inte av gränssnittet.
      </p>
      {orders.map((o) => (
        <div className="card" key={o.id}>
          <div className="row">
            <strong>
              #{o.number} — {o.title}
            </strong>
            <span className={`pill ${o.status}`}>{PLAIN[o.status]}</span>
            <span className="grow" />
            <button className="btn" onClick={() => toggle(o.id)}>
              {openId === o.id ? 'Dölj förlopp' : 'Visa förlopp'}
            </button>
          </div>
          {openId === o.id && (
            <ul className="timeline" style={{ marginTop: 12 }}>
              {timeline.map((e, i) => (
                <li key={i}>
                  {PORTAL_EVENTS[e.type]}
                  <span className="when">
                    {new Date(e.occurred_at).toLocaleString('sv-SE')}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      ))}
      {orders.length === 0 && <p className="muted">Inga ärenden.</p>}
    </>
  );
}
