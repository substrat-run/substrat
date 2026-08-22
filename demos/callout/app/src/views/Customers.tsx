import { useEffect, useState } from 'react';
import { api, type CustomerWithFacilities } from '../api';

/**
 * CustomerWithFacilities & facility management (spec/views.md §1.3, v0 slice): list with
 * facilities, create customer, add facility. Access notes are internal-only
 * master data, so they carry the visibility badge ("shared register" honesty).
 */
export function CustomersView() {
  const [customers, setCustomers] = useState<CustomerWithFacilities[] | null>(null);
  const [error, setError] = useState('');
  const [showNew, setShowNew] = useState(false);
  const [number, setNumber] = useState('');
  const [name, setName] = useState('');
  const [orgRef, setOrgRef] = useState('');
  // One inline "add facility" form at a time, keyed by customer id.
  const [addingFor, setAddingFor] = useState('');
  const [facName, setFacName] = useState('');
  const [facAddress, setFacAddress] = useState('');
  const [facAccessNote, setFacAccessNote] = useState('');

  const load = () => {
    api.listCustomers().then((page) => setCustomers(page.entries)).catch((e: Error) => setError(e.message));
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
    await api.createCustomer({ number, name, ...(orgRef ? { orgRef } : {}) });
    setShowNew(false);
    setNumber('');
    setName('');
    setOrgRef('');
  });

  const openAddFacility = (customerId: string) => {
    setAddingFor(addingFor === customerId ? '' : customerId);
    setFacName('');
    setFacAddress('');
    setFacAccessNote('');
  };

  const addFacility = (customerId: string) =>
    act(async () => {
      await api.createFacility({ customerId: customerId, name: facName,
        ...(facAddress ? { address: facAddress } : {}),
        ...(facAccessNote ? { accessNote: facAccessNote } : {}), });
      setAddingFor('');
    })();

  if (error && !customers) return <div className="alert error">{error}</div>;
  if (!customers) return <p className="muted">Laddar…</p>;

  return (
    <>
      <div className="row" style={{ marginBottom: 16 }}>
        <div className="grow">
          <h1>Kunder</h1>
          <p className="sub">{customers.length} kunder · anläggningar och portkoder</p>
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
              style={{ width: 180 }}
              placeholder="Org-referens (valfri)"
              value={orgRef}
              onChange={(e) => setOrgRef(e.target.value)}
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
              {c.org_ref && (
                <span className="muted" style={{ marginLeft: 8, fontWeight: 400 }}>
                  {c.org_ref}
                </span>
              )}
            </strong>
            <button className="btn" onClick={() => openAddFacility(c.id)}>
              {addingFor === c.id ? 'Avbryt' : '+ Anläggning'}
            </button>
          </div>

          {addingFor === c.id && (
            <div className="row" style={{ marginTop: 12 }}>
              <input
                style={{ width: 200 }}
                placeholder="Anläggningens namn"
                value={facName}
                onChange={(e) => setFacName(e.target.value)}
              />
              <input
                className="grow"
                placeholder="Adress (valfri)"
                value={facAddress}
                onChange={(e) => setFacAddress(e.target.value)}
              />
              <input
                className="grow"
                placeholder="Åtkomstnotering, t.ex. portkod (intern)"
                value={facAccessNote}
                onChange={(e) => setFacAccessNote(e.target.value)}
              />
              <button className="btn primary" disabled={!facName} onClick={() => addFacility(c.id)}>
                Lägg till
              </button>
            </div>
          )}

          <table className="grid" style={{ marginTop: 12 }}>
            <thead>
              <tr>
                <th>Anläggning</th>
                <th>Adress</th>
                <th>Åtkomst</th>
              </tr>
            </thead>
            <tbody>
              {c.facilities.map((f) => (
                <tr key={f.id}>
                  <td>{f.name}</td>
                  <td className="muted">{f.address ?? '—'}</td>
                  <td>
                    {f.access_note ? (
                      <>
                        {f.access_note} <span className="pill planned">intern</span>
                      </>
                    ) : (
                      <span className="muted">—</span>
                    )}
                  </td>
                </tr>
              ))}
              {c.facilities.length === 0 && (
                <tr>
                  <td className="muted" colSpan={3}>
                    Inga anläggningar
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
