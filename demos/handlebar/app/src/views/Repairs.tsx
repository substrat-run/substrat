import { useEffect, useState } from 'react';
import { api, type CustomerWithBikes, type Repair } from '../api';

export function StatusPill({ status }: { status: string }) {
  const label: Record<string, string> = {
    planned: 'Inlämnad',
    in_progress: 'Pågår',
    completed: 'Klar',
    closed: 'Uthämtad',
    open: 'Öppen',
    exported: 'Exporterad',
  };
  return <span className={`pill ${status}`}>{label[status] ?? status}</span>;
}

export function RepairsView() {
  const [repairs, setRepairs] = useState<Repair[] | null>(null);
  const [customers, setCustomers] = useState<CustomerWithBikes[]>([]);
  const [error, setError] = useState('');
  const [showNew, setShowNew] = useState(false);
  const [bikeId, setBikeId] = useState('');
  const [kind, setKind] = useState('service');
  const [title, setTitle] = useState('');

  const load = () => {
    api.workorderList({}).then(setRepairs).catch((e: Error) => setError(e.message));
    api.listCustomers().then(setCustomers).catch(() => setCustomers([]));
  };
  useEffect(load, []);

  const bikeName = (id: string) => {
    for (const c of customers) {
      const b = c.bikes.find((b) => b.id === id);
      if (b) return `${b.label} · ${c.name}`;
    }
    return id.slice(0, 8);
  };

  const create = async () => {
    try {
      const repair = await api.createRepair({ bikeId, kind, title });
      location.hash = `#/repairs/${repair.id}`;
    } catch (e) {
      setError((e as Error).message);
    }
  };

  if (error) return <div className="alert error">{error}</div>;
  if (!repairs) return <p className="muted">Laddar…</p>;

  return (
    <>
      <div className="row" style={{ marginBottom: 16 }}>
        <div className="grow">
          <h1>Reparationer</h1>
          <p className="sub">{repairs.length} reparationer · alla status</p>
        </div>
        <button className="btn primary" onClick={() => setShowNew(!showNew)}>
          + Ny reparation
        </button>
      </div>

      {showNew && (
        <div className="card">
          <h2>Ny reparation</h2>
          <div className="row">
            <select value={bikeId} onChange={(e) => setBikeId(e.target.value)}>
              <option value="">Välj cykel…</option>
              {customers.flatMap((c) =>
                c.bikes.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.label} — {c.name}
                  </option>
                )),
              )}
            </select>
            <select value={kind} onChange={(e) => setKind(e.target.value)}>
              <option value="service">Service</option>
              <option value="punktering">Punktering</option>
              <option value="vaxlar">Växlar</option>
              <option value="bromsar">Bromsar</option>
            </select>
            <input
              className="grow"
              placeholder="Felbeskrivning"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
            <button className="btn primary" disabled={!bikeId || !title} onClick={create}>
              Registrera
            </button>
          </div>
        </div>
      )}

      <div className="card">
        <table className="grid">
          <thead>
            <tr>
              <th>Nr</th>
              <th>Felbeskrivning</th>
              <th>Cykel</th>
              <th>Typ</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {repairs.map((r) => (
              <tr key={r.id} className="click" onClick={() => (location.hash = `#/repairs/${r.id}`)}>
                <td className="num">{r.number}</td>
                <td>{r.title}</td>
                <td className="muted">{bikeName(r.facility.entityId)}</td>
                <td>
                  <span className={`pill ${r.kind}`}>{r.kind}</span>
                </td>
                <td>
                  <StatusPill status={r.status} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
