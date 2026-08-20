import { useEffect, useState } from 'react';
import { api, type CustomerWithFacilities, type WorkOrder } from '../api';

export function StatusPill({ status }: { status: string }) {
  const label: Record<string, string> = {
    planned: 'Planerad',
    in_progress: 'Pågår',
    completed: 'Åtgärdad',
    closed: 'Avslutad',
    open: 'Öppen',
    exported: 'Exporterad',
  };
  return <span className={`pill ${status}`}>{label[status] ?? status}</span>;
}

export function OrdersView() {
  const [orders, setOrders] = useState<WorkOrder[] | null>(null);
  const [customers, setCustomers] = useState<CustomerWithFacilities[]>([]);
  const [error, setError] = useState('');
  const [showNew, setShowNew] = useState(false);
  const [facilityId, setFacilityId] = useState('');
  const [kind, setKind] = useState('service');
  const [title, setTitle] = useState('');

  const load = () => {
    api.workorderList({}).then(setOrders).catch((e: Error) => setError(e.message));
    api.listCustomers().then(setCustomers).catch(() => setCustomers([]));
  };
  useEffect(load, []);

  const facilityName = (id: string) => {
    for (const c of customers) {
      const f = c.facilities.find((f) => f.id === id);
      if (f) return `${f.name} · ${c.name}`;
    }
    return id.slice(0, 8);
  };

  const create = async () => {
    try {
      const order = await api.createWorkorder({ facilityId, kind, title });
      location.hash = `#/orders/${order.id}`;
    } catch (e) {
      setError((e as Error).message);
    }
  };

  if (error) return <div className="alert error">{error}</div>;
  if (!orders) return <p className="muted">Laddar…</p>;

  return (
    <>
      <div className="row" style={{ marginBottom: 16 }}>
        <div className="grow">
          <h1>Work order</h1>
          <p className="sub">{orders.length} order · alla status</p>
        </div>
        <button className="btn primary" onClick={() => setShowNew(!showNew)}>
          + Ny work order
        </button>
      </div>

      {showNew && (
        <div className="card">
          <h2>Ny work order</h2>
          <div className="row">
            <select value={facilityId} onChange={(e) => setFacilityId(e.target.value)}>
              <option value="">Välj anläggning…</option>
              {customers.flatMap((c) =>
                c.facilities.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.name} — {c.name}
                  </option>
                )),
              )}
            </select>
            <select value={kind} onChange={(e) => setKind(e.target.value)}>
              <option value="service">Service</option>
              <option value="akut">Akut</option>
              <option value="montage">Montage</option>
            </select>
            <input
              className="grow"
              placeholder="Arbetsbeskrivning"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
            <button className="btn primary" disabled={!facilityId || !title} onClick={create}>
              Skapa
            </button>
          </div>
        </div>
      )}

      <div className="card">
        <table className="grid">
          <thead>
            <tr>
              <th>Nr</th>
              <th>Beskrivning</th>
              <th>Anläggning</th>
              <th>Kategori</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {orders.map((o) => (
              <tr key={o.id} className="click" onClick={() => (location.hash = `#/orders/${o.id}`)}>
                <td className="num">{o.number}</td>
                <td>{o.title}</td>
                <td className="muted">{facilityName(o.facility.entityId)}</td>
                <td>
                  <span className={`pill ${o.kind}`}>{o.kind}</span>
                </td>
                <td>
                  <StatusPill status={o.status} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
