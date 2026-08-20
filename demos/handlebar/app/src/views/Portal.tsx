import { useEffect, useState } from 'react';
import { api, extra, type Repair, type TimelineEntry } from '../api';
import { ConditionReportPanel } from './ConditionReport';

const PLAIN: Record<string, string> = {
  planned: 'Inlämnad',
  in_progress: 'Pågår',
  completed: 'Klar för uthämtning',
  closed: 'Uthämtad',
};

const PORTAL_EVENTS: Record<string, string> = {
  'workorder.created': 'Cykeln lämnades in',
  'workorder.assigned': 'Mekaniker tilldelad',
  'workorder.started': 'Reparationen påbörjades',
  'workorder.completed': 'Reparationen klar',
  'workorder.closed': 'Cykeln uthämtad',
};

export function PortalView() {
  const [repairs, setRepairs] = useState<Repair[] | null>(null);
  const [openId, setOpenId] = useState('');
  const [timeline, setTimeline] = useState<TimelineEntry[]>([]);
  const [error, setError] = useState('');

  useEffect(() => {
    api.portalRepairs().then(setRepairs).catch((e: Error) => setError(e.message));
  }, []);

  const toggle = async (id: string) => {
    if (openId === id) return setOpenId('');
    const t = await extra.timeline(id);
    setTimeline(t.filter((e) => PORTAL_EVENTS[e.type]));
    setOpenId(id);
  };

  if (error) return <div className="alert error">{error}</div>;
  if (!repairs) return <p className="muted">Laddar…</p>;

  return (
    <>
      <h1>Mina reparationer</h1>
      <p className="sub">
        Du ser exakt de reparationer som hör till dina cyklar — inget annat. Isoleringen
        bevisas av kärnan vid varje läsning, inte av gränssnittet.
      </p>
      {repairs.map((r) => (
        <div className="card" key={r.id}>
          <div className="row">
            <strong>
              #{r.number} — {r.title}
            </strong>
            <span className={`pill ${r.status}`}>{PLAIN[r.status]}</span>
            <span className="grow" />
            <button className="btn" onClick={() => toggle(r.id)}>
              {openId === r.id ? 'Dölj förlopp' : 'Visa förlopp'}
            </button>
          </div>
          {openId === r.id && (
            <>
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
              {/* Pickup moment: the condition report the workshop signed —
                  frozen content the customer counter-signs, right here. */}
              <ConditionReportPanel repair={r} portal />
            </>
          )}
        </div>
      ))}
      {repairs.length === 0 && <p className="muted">Inga reparationer.</p>}
    </>
  );
}
