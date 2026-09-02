import { useCallback, useEffect, useState } from 'react';
import { api, auth, setVenue, type Venue, type WhoAmI } from './api';
import Calendar from './views/Calendar';
import Admin from './views/Admin';

type View = 'calendar' | 'courts' | 'pricing' | 'members' | 'reports' | 'staff' | 'settings';

const NAV: { key: View; label: string }[] = [
  { key: 'calendar', label: 'Kalender' },
  { key: 'courts', label: 'Banor' },
  { key: 'pricing', label: 'Priser' },
  { key: 'members', label: 'Medlemmar' },
  { key: 'reports', label: 'Rapporter' },
  { key: 'staff', label: 'Personal & roller' },
  { key: 'settings', label: 'Inställningar' },
];

// Vertical-specific key so the demos can coexist in one browser profile.
const STORE = 'rally-console-principal';

const todayISO = (): string => new Date().toISOString().slice(0, 10);

export default function App() {
  const [me, setMe] = useState<WhoAmI | null>(null);
  const [signedOut, setSignedOut] = useState(false);
  const [venues, setVenues] = useState<Venue[]>([]);
  const [venue, setVenueState] = useState<string>(
    () => localStorage.getItem(`${STORE}-venue`) ?? 'solna',
  );
  const [view, setView] = useState<View>('calendar');
  const [date, setDate] = useState(todayISO);
  const [newBooking, setNewBooking] = useState(0); // bumped to open the drawer

  // The venue is applied BEFORE the state update that mounts the views: React runs child
  // effects before parent effects, so a view mounted in this same commit would otherwise
  // fire its first fetch against the wrong club.
  useEffect(() => {
    setVenue(localStorage.getItem(`${STORE}-venue`) ?? 'solna');
    void (async () => {
      try {
        // Reachable venues are per LOGIN and resolved per club server-side — a
        // receptionist pinned to one venue gets no switcher.
        const vs = await api.myVenues();
        setVenues(vs);
        if (vs.length > 0 && !vs.some((v) => v.key === venue)) pickVenue(vs[0]!.key);
        setMe(await api.whoami());
      } catch {
        setSignedOut(true);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Same synchronous-before-render discipline as the principal picker.
  const pickVenue = useCallback((key: string) => {
    setVenue(key);
    localStorage.setItem(`${STORE}-venue`, key);
    setVenueState(key);
  }, []);

  const shiftDay = useCallback((delta: number) => {
    setDate((d) => {
      const next = new Date(`${d}T12:00:00Z`);
      next.setUTCDate(next.getUTCDate() + delta);
      return next.toISOString().slice(0, 10);
    });
  }, []);

  // Keyboard-first, per the handover: N new booking, T today, ←/→ day pager.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (el.tagName === 'INPUT' || el.tagName === 'SELECT' || el.tagName === 'TEXTAREA') return;
      if (e.key === 'n' || e.key === 'N') setNewBooking((n) => n + 1);
      if (e.key === 't' || e.key === 'T') setDate(todayISO());
      if (e.key === 'ArrowLeft') shiftDay(-1);
      if (e.key === 'ArrowRight') shiftDay(1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [shiftDay]);

  const ready = me !== null;

  if (signedOut) {
    return (
      <div className="shell">
        <div className="card" style={{ margin: 'auto', textAlign: 'center' }}>
          <p>Logga in för att fortsätta.</p>
          <button className="btn lime" onClick={() => auth.login('/')}>
            Logga in
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark" />
          <span className="wordmark">RALLYPOINT</span>
          <span className="tag">MGR</span>
        </div>
        <nav className="nav">
          {NAV.map((n) => (
            <button
              key={n.key}
              className={view === n.key ? 'on' : ''}
              onClick={() => setView(n.key)}
            >
              {n.label}
            </button>
          ))}
        </nav>
        <div className="side-foot">
          {/* One venue = no switcher, per handover 2a. Staff pinned to a single
              club should not be offered a control that can only fail. */}
          {venues.length > 1 ? (
            <>
              <label style={{ marginBottom: 4 }}>Klubb</label>
              <select
                value={venue}
                onChange={(e) => pickVenue(e.target.value)}
                style={{ width: '100%', fontSize: 11.5, border: '2px solid var(--ink)' }}
              >
                {venues.map((v) => (
                  <option key={v.key} value={v.key}>
                    {v.label}
                  </option>
                ))}
              </select>
            </>
          ) : (
            <span style={{ fontWeight: 700, color: 'var(--ink)' }}>
              {venues[0]?.label ?? '—'}
            </span>
          )}
          <span className="mono" style={{ fontSize: 10, display: 'block', marginTop: 6 }}>
            {me?.role ?? '—'}
          </span>
        </div>
      </aside>

      <main className="main">
        <div className="topbar">
          <button className="btn" onClick={() => shiftDay(-1)} title="Föregående dag">
            ‹
          </button>
          <button className="btn" onClick={() => setDate(todayISO())}>
            Idag<span className="kbd">T</span>
          </button>
          <button className="btn" onClick={() => shiftDay(1)} title="Nästa dag">
            ›
          </button>
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />

          <span className="spacer" />

          <button className="btn" onClick={() => auth.logout()} title="Logga ut">
            Logga ut
          </button>
          <button className="btn lime" onClick={() => setNewBooking((n) => n + 1)}>
            + Ny bokning<span className="kbd">N</span>
          </button>
        </div>

        <div className="content">
          {!ready && <div className="card">Laddar…</div>}
          {ready && view === 'calendar' && (
            <Calendar
              key={venue} /* switching club remounts: a new scope, a new world */
              date={date}
              openDrawer={newBooking}
            />
          )}
          {ready && view !== 'calendar' && <Admin key={venue} view={view} />}
        </div>
      </main>
    </div>
  );
}
