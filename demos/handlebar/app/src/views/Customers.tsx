import { useEffect, useState } from 'react';
import { api, type CustomerWithBikes } from '../api';

/**
 * CustomerWithBikes & bike management (fsm spec/views.md §1.3 in Handlebar
 * vocabulary): list with bikes, create customer, register bike. A bike is
 * this vertical's facility-shaped entity — the repair's permission walk is
 * workorder → bike → customer.
 */
export function CustomersView() {
  const [customers, setCustomers] = useState<CustomerWithBikes[] | null>(null);
  const [error, setError] = useState('');
  const [showNew, setShowNew] = useState(false);
  const [number, setNumber] = useState('');
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  // One inline "register bike" form at a time, keyed by customer id.
  const [addingFor, setAddingFor] = useState('');
  const [bikeLabel, setBikeLabel] = useState('');
  const [bikeFrameNo, setBikeFrameNo] = useState('');

  const load = () => {
    api.listCustomers().then(setCustomers).catch((e: Error) => setError(e.message));
  };
  useEffect(load, []);

  const act = (fn: () => Promise<unknown>) => async () => {
    setError('');
    try {
      await fn();
      load();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const createCustomer = act(async () => {
    await api.createCustomer({ number, name, ...(phone ? { phone } : {}) });
    setShowNew(false);
    setNumber('');
    setName('');
    setPhone('');
  });

  const openRegisterBike = (customerId: string) => {
    setAddingFor(addingFor === customerId ? '' : customerId);
    setBikeLabel('');
    setBikeFrameNo('');
  };

  const registerBike = (customerId: string) =>
    act(async () => {
      await api.registerBike({ customerId: customerId, label: bikeLabel,
        ...(bikeFrameNo ? { frameNo: bikeFrameNo } : {}), });
      setAddingFor('');
    })();

  if (error && !customers) return <div className="alert error">{error}</div>;
  if (!customers) return <p className="muted">Laddar…</p>;

  return (
    <>
      <div className="row" style={{ marginBottom: 16 }}>
        <div className="grow">
          <h1>Kunder</h1>
          <p className="sub">{customers.length} kunder · deras cyklar</p>
        </div>
        <button className="btn primary" onClick={() => setShowNew(!showNew)}>
          + Ny kund
        </button>
      </div>

      {error && <div className="alert error">{error}</div>}

      {showNew && (
        <div className="card">
          <h2>Ny kund</h2>
          <div className="row">
            <input
              style={{ width: 90 }}
              placeholder="Kundnr"
              value={number}
              onChange={(e) => setNumber(e.target.value)}
            />
            <input
              className="grow"
              placeholder="Namn"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <input
              style={{ width: 160 }}
              placeholder="Telefon (valfri)"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
            />
            <button className="btn primary" disabled={!number || !name} onClick={createCustomer}>
              Skapa
            </button>
          </div>
        </div>
      )}

      {customers.map((c) => (
        <div className="card" key={c.id}>
          <div className="row">
            <strong className="grow">
              {c.number} · {c.name}
              {c.phone && (
                <span className="muted" style={{ marginLeft: 8, fontWeight: 400 }}>
                  {c.phone}
                </span>
              )}
            </strong>
            <button className="btn" onClick={() => openRegisterBike(c.id)}>
              {addingFor === c.id ? 'Avbryt' : '+ Cykel'}
            </button>
          </div>

          {addingFor === c.id && (
            <div className="row" style={{ marginTop: 12 }}>
              <input
                className="grow"
                placeholder='Cykel, t.ex. "Crescent Elina 3-vxl"'
                value={bikeLabel}
                onChange={(e) => setBikeLabel(e.target.value)}
              />
              <input
                style={{ width: 160 }}
                placeholder="Ramnummer (valfritt)"
                value={bikeFrameNo}
                onChange={(e) => setBikeFrameNo(e.target.value)}
              />
              <button
                className="btn primary"
                disabled={!bikeLabel}
                onClick={() => registerBike(c.id)}
              >
                Registrera
              </button>
            </div>
          )}

          <table className="grid" style={{ marginTop: 12 }}>
            <thead>
              <tr>
                <th>Cykel</th>
                <th>Ramnummer</th>
              </tr>
            </thead>
            <tbody>
              {c.bikes.map((b) => (
                <tr key={b.id}>
                  <td>{b.label}</td>
                  <td className="muted">{b.frame_no ?? '—'}</td>
                </tr>
              ))}
              {c.bikes.length === 0 && (
                <tr>
                  <td className="muted" colSpan={2}>
                    Inga cyklar registrerade
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      ))}
      {customers.length === 0 && <p className="muted">Inga kunder ännu.</p>}
    </>
  );
}
