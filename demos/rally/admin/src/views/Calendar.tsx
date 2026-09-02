import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ApiError,
  api,
  type Court,
  type Member,
  type Money,
  type Reservation,
  type SlotFit,
  type VenueSnapshot,
} from '../api';

const HOUR = 48; // px per hour — matches --hour in ui.css
const COVER_SV: Record<string, string> = { indoor: 'inomhus', covered: 'tak', open: 'ute' };
const PEAK = [17, 21];

/** Render an instant in the club's zone. The API speaks instants; staff read wall clock. */
function hhmm(instant: string, tz: string): string {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: tz,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(instant));
}
function minutesOfDay(instant: string, tz: string): number {
  const [h, m] = hhmm(instant, tz).split(':');
  return Number(h) * 60 + Number(m);
}
const money = (m: Money): string => `${m.amount} ${m.currency === 'SEK' ? 'kr' : m.currency}`;

interface Props {
  date: string;
  openDrawer: number;
}

export default function Calendar({ date, openDrawer }: Props) {
  const [venue, setVenue] = useState<VenueSnapshot | null>(null);
  const [courts, setCourts] = useState<Court[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [rows, setRows] = useState<Reservation[]>([]);
  const [error, setError] = useState('');
  const [drawer, setDrawer] = useState(false);
  const [inspect, setInspect] = useState<Reservation | null>(null);
  const [tick, setTick] = useState(0); // 1s tick drives live hold countdowns

  const reload = useCallback(async () => {
    setError('');
    try {
      const [v, c, r] = await Promise.all([api.venue(), api.courts(), loadDay(date)]);
      setVenue(v);
      setCourts(c);
      setRows(r);
      try {
        setMembers(await api.members());
      } catch {
        setMembers([]); // a coach may read the calendar but not the member list
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [date]);

  useEffect(() => {
    void reload();
  }, [reload]);
  useEffect(() => {
    if (openDrawer > 0) setDrawer(true);
  }, [openDrawer]);
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);

  const tz = venue?.venue.timezone ?? 'Europe/Stockholm';
  const weekday = new Date(`${date}T12:00:00Z`).getUTCDay();
  const dayHours = venue?.hours.find((h) => h.weekday === weekday);
  const openH = dayHours?.opens_at ? Number(dayHours.opens_at.slice(0, 2)) : 7;
  const closeH = dayHours?.closes_at ? Number(dayHours.closes_at.slice(0, 2)) : 23;
  const closedToday = !dayHours || dayHours.closed === 1;
  const hours = useMemo(
    () => Array.from({ length: Math.max(1, closeH - openH) }, (_, i) => openH + i),
    [openH, closeH],
  );

  const nowMin = (() => {
    const n = new Date();
    if (n.toISOString().slice(0, 10) !== date) return null;
    return minutesOfDay(n.toISOString(), tz);
  })();

  const grid = { gridTemplateColumns: `54px repeat(${Math.max(1, courts.length)}, 1fr)` };

  return (
    <>
      {error && <div className="banner">{error}</div>}

      <div className="cal">
        <div className="cal-head" style={grid}>
          <div />
          {courts.map((c) => {
            const cfg = venue?.courts.find((x) => x.resource_id === c.id);
            return (
              <div key={c.id}>
                <div className="court-name">
                  {c.name} {!c.active && <span className="chip">⊘ inaktiv</span>}
                </div>
                <div className="court-meta mono">
                  {cfg?.durations ?? '60,90,120'} min · {COVER_SV[cfg?.cover ?? 'indoor']}
                </div>
              </div>
            );
          })}
        </div>

        <div className="cal-body" style={grid}>
          <div className="gutter">
            {hours.map((h) => (
              <div key={h} className="hour-label mono">
                {String(h).padStart(2, '0')}:00
              </div>
            ))}
          </div>

          {courts.map((c) => (
            <div key={c.id} className="col">
              {hours.map((h) => (
                <div key={h} className="hour-line" />
              ))}

              {/* Peak window — tinted, dashed, and labelled. */}
              {PEAK[0]! < closeH && (
                <div
                  className="peak-band"
                  style={{
                    top: (Math.max(PEAK[0]!, openH) - openH) * HOUR,
                    height: (Math.min(PEAK[1]!, closeH) - Math.max(PEAK[0]!, openH)) * HOUR,
                  }}
                />
              )}

              {(closedToday || !c.active) && (
                <div className="closed-col" style={{ top: 0, height: hours.length * HOUR }} />
              )}

              {rows
                .filter((r) => r.resourceId === c.id)
                .map((r) => {
                  const top = ((minutesOfDay(r.startsAt, tz) - openH * 60) / 60) * HOUR;
                  const height = Math.max(
                    18,
                    ((minutesOfDay(r.endsAt, tz) - minutesOfDay(r.startsAt, tz)) / 60) * HOUR - 2,
                  );
                  return (
                    <CalCell
                      key={r.id + String(tick % 2)}
                      r={r}
                      tz={tz}
                      top={top}
                      height={height}
                      nowMin={nowMin}
                      onClick={() => setInspect(r)}
                    />
                  );
                })}

              {nowMin !== null && nowMin >= openH * 60 && nowMin <= closeH * 60 && (
                <div className="now-line" style={{ top: ((nowMin - openH * 60) / 60) * HOUR }}>
                  <span className="now-bubble mono">
                    {String(Math.floor(nowMin / 60)).padStart(2, '0')}:
                    {String(nowMin % 60).padStart(2, '0')}
                  </span>
                </div>
              )}
            </div>
          ))}
        </div>

        <div className="legend">
          <span>
            <i className="sw" style={{ borderLeft: '3px solid #256B3E' }} /> bekräftad
          </span>
          <span>
            <i
              className="sw"
              style={{ background: '#FDF6EE', border: '1.5px dashed #C2510F' }}
            />{' '}
            ⏱ hållen (släpps automatiskt)
          </span>
          <span>
            <i className="sw" style={{ background: '#FAFCEF', borderLeft: '3px solid #9DBB2A' }} />{' '}
            ◐ öppen match
          </span>
          <span>
            <i
              className="sw"
              style={{
                background:
                  'repeating-linear-gradient(45deg,#ECEEE6 0 4px,#F4F5EF 4px 8px)',
              }}
            />{' '}
            ▨ underhåll
          </span>
          <span>
            <i className="sw" style={{ background: '#F0F1EA', borderStyle: 'dashed' }} /> utgången
          </span>
          <span>
            <i className="sw" style={{ background: '#F9ECEA', borderColor: '#A33328' }} /> ✕ precis
            tagen
          </span>
        </div>
      </div>

      {inspect && (
        <Inspector
          r={inspect}
          tz={tz}
          onClose={() => setInspect(null)}
          onDone={() => {
            setInspect(null);
            void reload();
          }}
        />
      )}

      {drawer && (
        <BookingDrawer
          date={date}
          tz={tz}
          courts={courts}
          members={members}
          venue={venue}
          onClose={() => setDrawer(false)}
          onCreated={() => {
            setDrawer(false);
            void reload();
          }}
        />
      )}
    </>
  );
}

async function loadDay(date: string): Promise<Reservation[]> {
  // Generous bounds: the server filters by instant, the grid by local hour.
  return api.reservations(`${date}T00:00:00.000Z`, `${date}T23:59:59.999Z`);
}

// ---------------------------------------------------------------------------

function CalCell({
  r,
  tz,
  top,
  height,
  nowMin,
  onClick,
}: {
  r: Reservation;
  tz: string;
  top: number;
  height: number;
  nowMin: number | null;
  onClick: () => void;
}) {
  // effectiveState, never state: a lapsed hold must not render as live.
  const s = r.effectiveState;
  if (s === 'cancelled' || s === 'completed') return null;

  const maintenance = (r.note ?? '').startsWith('maintenance:');
  const isMatch = r.fillTarget !== null && !maintenance;
  const cls = maintenance
    ? 'maintenance'
    : s === 'held'
      ? isMatch
        ? 'match'
        : 'held'
      : s === 'expired'
        ? 'expired'
        : s === 'no_show'
          ? 'taken'
          : 'confirmed';

  const past = nowMin !== null && minutesOfDay(r.endsAt, tz) < nowMin;
  const countdown =
    s === 'held' && r.expiresAt
      ? Math.max(0, Math.round((Date.parse(r.expiresAt) - Date.now()) / 1000))
      : null;

  return (
    <div
      className={`cell ${cls}${past ? ' past' : ''}`}
      style={{ top, height }}
      onClick={onClick}
      title={r.id}
    >
      <div className="who">
        {maintenance
          ? '▨ Underhåll'
          : isMatch
            ? `◐ Öppen match`
            : s === 'expired'
              ? 'Utgången hållning'
              : s === 'no_show'
                ? '✕ Uteblev'
                : 'Bokad ✓'}
      </div>
      <div className="meta mono">
        {hhmm(r.startsAt, tz)}–{hhmm(r.endsAt, tz)}
        {countdown !== null && (
          <>
            {' · ⏱ '}
            {Math.floor(countdown / 60)}:{String(countdown % 60).padStart(2, '0')}
          </>
        )}
      </div>
      {maintenance && <div className="meta">internt · ej fakturerbart</div>}
      {s === 'held' && !isMatch && <div className="meta">släpps automatiskt</div>}
      {isMatch && (
        <div className="meter">
          {Array.from({ length: r.fillTarget ?? 4 }, (_, i) => (
            <i key={i} className={i === 0 ? 'on' : ''} />
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

function Inspector({
  r,
  tz,
  onClose,
  onDone,
}: {
  r: Reservation;
  tz: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const [err, setErr] = useState('');
  const run = async (fn: () => Promise<unknown>) => {
    setErr('');
    try {
      await fn();
      onDone();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <>
      <div className="scrim" onClick={onClose} />
      <aside className="drawer">
        <header>
          <h2 style={{ margin: 0 }}>
            {hhmm(r.startsAt, tz)}–{hhmm(r.endsAt, tz)}
          </h2>
          <div className="mono hint">{r.id}</div>
          <div style={{ marginTop: 6 }}>
            <span className={`chip ${r.effectiveState === 'confirmed' ? 'green' : 'amber'}`}>
              {r.effectiveState}
            </span>
            {r.state !== r.effectiveState && (
              <span className="chip" style={{ marginLeft: 6 }}>
                lagrat: {r.state}
              </span>
            )}
          </div>
        </header>
        <div className="fields">
          {err && <div className="banner">{err}</div>}
          {r.effectiveState === 'held' && (
            <button className="btn lime" onClick={() => run(() => api.confirm(r.id))}>
              Bekräfta bokning
            </button>
          )}
          <button
            className="btn"
            onClick={() =>
              run(() =>
                api.move(r.id, {
                  startsAt: new Date(Date.parse(r.startsAt) + 30 * 60000).toISOString(),
                }),
              )
            }
          >
            Flytta 30 min framåt
          </button>
          <button className="btn" onClick={() => run(() => api.noShow(r.id))}>
            Markera uteblev
          </button>
          <button className="btn danger" onClick={() => run(() => api.cancel(r.id, 'reception'))}>
            Avboka
          </button>
        </div>
        <footer>
          <button className="btn" onClick={onClose}>
            Stäng<span className="kbd">esc</span>
          </button>
        </footer>
      </aside>
    </>
  );
}

// ---------------------------------------------------------------------------

function BookingDrawer({
  date,
  tz,
  courts,
  members,
  venue,
  onClose,
  onCreated,
}: {
  date: string;
  tz: string;
  courts: Court[];
  members: Member[];
  venue: VenueSnapshot | null;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [resourceId, setResourceId] = useState(courts[0]?.id ?? '');
  const [memberId, setMemberId] = useState(members[0]?.id ?? '');
  const [start, setStart] = useState('');
  const [duration, setDuration] = useState(90);
  const [slots, setSlots] = useState<SlotFit[]>([]);
  const [taken, setTaken] = useState<string | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!resourceId) return;
    void api
      .availability(resourceId, date)
      .then(setSlots)
      .catch(() => setSlots([]));
  }, [resourceId, date]);

  const cfg = venue?.courts.find((c) => c.resource_id === resourceId);
  const offered = (cfg?.durations ?? '60,90,120').split(',').map(Number);
  const chosen = slots.find((s) => hhmm(s.startsAt, tz) === start);
  const fits = chosen?.fits ?? [];

  const create = async () => {
    if (!resourceId || !memberId || !start) return;
    setBusy(true);
    setErr('');
    setTaken(null);
    try {
      await api.book({ resourceId, memberId, date, time: start, duration });
      onCreated();
    } catch (e) {
      // The one interaction the handover insists on: a lost race must keep
      // everything the receptionist typed and offer a way forward.
      if (e instanceof ApiError && e.isSlotTaken) setTaken(start);
      else setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const alternatives = slots.filter((s) => s.fits.includes(duration)).slice(0, 3);

  return (
    <>
      <div className="scrim" onClick={onClose} />
      <aside className="drawer">
        <header>
          <h2 style={{ margin: 0 }}>Ny bokning</h2>
          <div className="hint">{date}</div>
        </header>

        <div className="fields">
          {taken && (
            <div className="banner">
              <strong>{taken} blev precis bokad.</strong>
              Allt du skrivit är kvar. Välj en annan tid:
              <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
                {alternatives.map((a, i) => (
                  <button
                    key={a.startsAt}
                    className={`btn ${i === 0 ? 'lime' : ''}`}
                    onClick={() => {
                      setStart(hhmm(a.startsAt, tz));
                      setTaken(null);
                    }}
                  >
                    {hhmm(a.startsAt, tz)}
                  </button>
                ))}
              </div>
            </div>
          )}
          {err && <div className="banner">{err}</div>}

          <div>
            <label>Bana</label>
            <select
              value={resourceId}
              onChange={(e) => setResourceId(e.target.value)}
              style={{ width: '100%' }}
            >
              {courts.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label>Medlem</label>
            <select
              value={memberId}
              onChange={(e) => setMemberId(e.target.value)}
              style={{ width: '100%' }}
            >
              {members.length === 0 && <option value="">(ingen behörighet)</option>}
              {members.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label>Starttid — {slots.length} lediga</label>
            <select value={start} onChange={(e) => setStart(e.target.value)} style={{ width: '100%' }}>
              <option value="">välj…</option>
              {slots.map((s) => (
                <option key={s.startsAt} value={hhmm(s.startsAt, tz)}>
                  {hhmm(s.startsAt, tz)} — ryms {s.fits.join('/')} min
                </option>
              ))}
            </select>
          </div>

          <div>
            <label>Längd</label>
            <div className="seg">
              {offered.map((d) => {
                const ok = !start || fits.includes(d);
                return (
                  <button
                    key={d}
                    className={duration === d ? 'on' : ''}
                    disabled={!ok}
                    onClick={() => setDuration(d)}
                    title={ok ? '' : `${d} min ryms inte vid ${start}`}
                  >
                    {d}
                  </button>
                );
              })}
            </div>
            {start && !fits.includes(duration) && (
              <div className="hint" style={{ marginTop: 5 }}>
                {duration} min ryms inte vid {start} — nästa lucka som rymmer det:{' '}
                <span className="mono">
                  {slots.find((s) => s.fits.includes(duration))
                    ? hhmm(slots.find((s) => s.fits.includes(duration))!.startsAt, tz)
                    : 'ingen idag'}
                </span>
              </div>
            )}
          </div>

          <div className="price-box">
            <div className="hint">Pris sätts av prisregeln + medlemsnivån vid bokning.</div>
            <div className="mono" style={{ fontSize: 13, color: 'var(--ink)', marginTop: 4 }}>
              {venue?.priceRules.map((r) => `${r.label}: ${r.amount} kr`).join('  ·  ')}
            </div>
          </div>
        </div>

        <footer>
          <button
            className="btn lime"
            disabled={busy || !start || !memberId || (start !== '' && !fits.includes(duration))}
            onClick={() => void create()}
          >
            Skapa bokning<span className="kbd">⏎</span>
          </button>
          <button className="btn" onClick={onClose}>
            Avbryt<span className="kbd">esc</span>
          </button>
        </footer>
      </aside>
    </>
  );
}

export { money };
