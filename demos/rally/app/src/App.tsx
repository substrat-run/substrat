import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ApiError,
  acceptInvite,
  api,
  auth,
  dayLabel,
  getVenue,
  hhmm,
  setVenue,
  type Venue,
  type WhoAmI,
  COVER_SV,
  type Club,
  type Cover,
  type MatchLanding,
  type PlayedWith,
  type RosterEntry,
  type VenueSlot,
  type Money,
  type OpenMatch,
  type Reservation,
} from './api';

type Tab = 'book' | 'matches' | 'mine' | 'me';
const STORE = 'rally-player-principal';
const todayISO = () => new Date().toISOString().slice(0, 10);
const kr = (m: Money) => `${m.amount} kr`;

/**
 * A shared match link. It MUST carry the venue: a reservation id alone cannot be
 * resolved, because each club is its own scope and nothing indexes across them.
 * Older links without a venue fall back to the saved one, which is right often
 * enough for a demo and wrong in general — a real link would carry a token that
 * encodes the club.
 */
const linkParams = (): { match: string | null; venue: string | null; join: string | null } => {
  const q = new URLSearchParams(location.search);
  return { match: q.get('match'), venue: q.get('venue'), join: q.get('join') };
};
export const matchLink = (venue: string, id: string): string =>
  `${location.origin}/?venue=${venue}&match=${id}`;

/**
 * Screen state lives in the URL, so a refresh lands you where you were and a
 * link points at something specific. It is written with replaceState rather
 * than pushState: these are not navigation steps a back button should walk
 * through one at a time — except the booking step, which genuinely is.
 */
const urlParam = (key: string): string | null => new URLSearchParams(location.search).get(key);

function setUrl(patch: Record<string, string | null>, push = false): void {
  const q = new URLSearchParams(location.search);
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) q.delete(k);
    else q.set(k, v);
  }
  const url = `${location.pathname}${q.toString() ? `?${q}` : ''}`;
  if (push) history.pushState({}, '', url);
  else history.replaceState({}, '', url);
}

export default function App() {
  const [me, setMe] = useState<WhoAmI | null>(null);
  const [signedOut, setSignedOut] = useState(false);
  const [venues, setVenues] = useState<Venue[]>([]);
  const [venue, setVenueState] = useState(
    () => localStorage.getItem(`${STORE}-venue`) ?? 'solna',
  );
  const [tab, setTab] = useState<Tab>(() => (urlParam('tab') as Tab) ?? 'book');
  const [tz, setTz] = useState('Europe/Stockholm');

  // The venue has to be applied BEFORE the state update that mounts the screens: React
  // runs child effects before parent effects, so a screen mounted in the same commit
  // would otherwise fire its first fetch against the wrong club.
  useEffect(() => {
    // A link's venue wins over the remembered one — you are being sent somewhere
    // specific.
    const v = linkParams().venue ?? localStorage.getItem(`${STORE}-venue`) ?? 'solna';
    setVenue(v);
    setVenueState(v);
    setUrl({ venue: v });
    void (async () => {
      try {
        setVenues(await api.myVenues());
        // Both reads are per venue, which is the whole of rally's shape: the same login
        // is a different principal — and a different member — at each club.
        setMe(await api.whoami());
        setTz((await api.venue()).venue.timezone);
      } catch {
        setSignedOut(true);
      }
    })();
  }, []);

  const pickVenue = useCallback((key: string) => {
    setVenue(key);
    localStorage.setItem(`${STORE}-venue`, key);
    setVenueState(key);
    // The club is part of what the URL identifies — a slot means nothing
    // without knowing which club's slot it is.
    setUrl({ venue: key, slot: null });
    // Re-ask BOTH questions: switching club changes which principal you are and which
    // member record is yours. Carrying the old member id across would read another
    // club's rows under your own name.
    void api.whoami().then(setMe).catch(() => setMe(null));
    void api.venue().then((v) => setTz(v.venue.timezone)).catch(() => {});
  }, []);

  const goTab = useCallback((next: Tab) => {
    setTab(next);
    setUrl({ tab: next, slot: null });
  }, []);

  // A member record is per club — the same human, a different row in each. It comes
  // from `rally/whoami` now: the login's own row, found through `principal_ref`. It used
  // to come from a hardcoded persona → member map the dev server shipped in `/api/cast`,
  // which is why the player app worked here and nowhere else.
  const memberId = me?.memberId ?? '';
  const ready = me !== null;
  const [invite, setInvite] = useState<string | null>(() => linkParams().match);
  const [join, setJoin] = useState<string | null>(() => linkParams().join);

  // A club invitation takes over the whole screen, before any persona exists:
  // the recipient is by definition not yet a member (#35 / #564).
  if (join) {
    return (
      <div className="phone">
        <AcceptClubInvite
          invitationId={join}
          onDone={() => {
            setUrl({ join: null });
            setJoin(null);
          }}
        />
      </div>
    );
  }

  // Signed out: the whole app is behind the issuer. The join-by-link screens above are
  // deliberately NOT — a recipient is by definition not a member yet.
  if (signedOut) {
    return (
      <div className="phone">
        <div className="empty">
          <p>Logga in för att fortsätta.</p>
          <button className="pill on" onClick={() => auth.login('/')}>
            Logga in
          </button>
        </div>
      </div>
    );
  }

  // An invite takes over the whole screen: someone sent you here for one reason.
  if (invite) {
    return (
      <div className="phone">
        <JoinByLink
          reservationId={invite}
          tz={tz}
          memberId={memberId}
          ready={ready}
          onDone={() => {
            setUrl({ match: null, tab: 'mine' });
            setInvite(null);
            setTab('mine');
          }}
        />
      </div>
    );
  }

  return (
    <div className="phone">
      <div className="topbar">
        <span className="brand-mark" />
        <span className="wordmark">RALLYPOINT</span>
        <button className="who" onClick={() => auth.logout()}>
          Logga ut
        </button>
      </div>

      {venues.length > 1 && (
        <div className="row" style={{ padding: '0 16px 8px' }}>
          {venues.map((v) => (
            <button
              key={v.key}
              className={`pill ${v.key === venue ? 'on' : ''}`}
              onClick={() => pickVenue(v.key)}
            >
              {v.label}
            </button>
          ))}
        </div>
      )}

      <div className="scroll">
        {!ready && <div className="empty">Laddar…</div>}
        {ready && !memberId && (
          <div className="empty">
            Du är inte medlem i den här klubben.
            <br />
            Att gå med är en tilldelning per klubb — inte en global flagga.
          </div>
        )}
        {ready && memberId && tab === 'book' && <Book key={venue} tz={tz} memberId={memberId} />}
        {ready && memberId && tab === 'matches' && (
          <Matches key={venue} tz={tz} memberId={memberId} />
        )}
        {ready && memberId && tab === 'mine' && <Mine key={venue} tz={tz} />}
        {ready && tab === 'me' && <Me role={me.role} memberId={memberId} />}
      </div>

      <nav className="nav" style={{ gridTemplateColumns: 'repeat(4, 1fr)' }}>
        {(
          [
            ['book', 'Boka'],
            ['matches', 'Matcher'],
            ['mine', 'Mina tider'],
            ['me', 'Profil'],
          ] as const
        ).map(([k, label]) => (
          <button key={k} className={tab === k ? 'on' : ''} onClick={() => goTab(k)}>
            {label}
          </button>
        ))}
      </nav>
    </div>
  );
}

// ---------------------------------------------------------------------------

function Book({ tz, memberId }: { tz: string; memberId: string }) {
  const [date, setDate] = useState(() => urlParam('date') ?? todayISO());
  const [cover, setCover] = useState<Cover[]>([]);
  /** A duration filter on step 1 — it narrows WHICH TIMES show, nothing else. */
  const [only, setOnly] = useState<number | null>(null);
  const [slots, setSlots] = useState<VenueSlot[]>([]);
  const [picked, setPicked] = useState<VenueSlot | null>(null); // → step 2
  const [err, setErr] = useState('');
  const [taken, setTaken] = useState<string | null>(null);
  const [mode, setMode] = useState<'solo' | 'match'>('solo');
  const [done, setDone] = useState<{ time: string; price: Money; match?: string } | null>(null);

  const loadSlots = useCallback(() => {
    void api
      .venueAvailability(date, cover)
      .then(setSlots)
      .catch((e) => setErr(e.message));
  }, [date, cover]);
  useEffect(loadSlots, [loadSlots]);

  const shown = only ? slots.filter((s) => s.fits.includes(only)) : slots;

  // Step 2 is a real place: it survives a refresh and the back button leaves it.
  useEffect(() => {
    const wanted = urlParam('slot');
    if (!wanted) {
      setPicked(null);
      return;
    }
    const found = slots.find((s) => s.startsAt === wanted);
    if (found) setPicked(found);
  }, [slots]);

  useEffect(() => {
    const onPop = () => {
      const wanted = urlParam('slot');
      setPicked(wanted ? (slots.find((s) => s.startsAt === wanted) ?? null) : null);
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [slots]);

  const openStep2 = (s: VenueSlot) => {
    setPicked(s);
    setUrl({ slot: s.startsAt, date }, true); // a step worth a back button
  };
  const closeStep2 = () => {
    setPicked(null);
    setUrl({ slot: null });
  };

  if (picked) {
    return (
      <Step2
        tz={tz}
        date={date}
        slot={picked}
        cover={cover}
        memberId={memberId}
        mode={mode}
        onBack={closeStep2}
        onTaken={(t) => {
          closeStep2();
          setTaken(t);
          loadSlots();
        }}
        onDone={(d) => {
          closeStep2();
          setDone(d);
          loadSlots();
        }}
      />
    );
  }

  return (
    <>
      <h1>{mode === 'match' ? 'Öppna en match' : 'Boka bana'}</h1>

      <div className="seg" style={{ marginBottom: 12 }}>
        <button className={mode === 'solo' ? 'on' : ''} onClick={() => setMode('solo')}>
          Boka själv
        </button>
        <button className={mode === 'match' ? 'on' : ''} onClick={() => setMode('match')}>
          Öppen match
        </button>
      </div>

      {done && (
        <div className="banner">
          <strong>Klart — {done.time}, {done.price.amount} kr.</strong>
          {done.match ? 'Matchen är öppen. Dela länken så fyller den sig själv.' : 'Bokningen är bekräftad.'}
          <div className="row" style={{ marginTop: 8 }}>
            {done.match && (
              <button
                className="pill on"
                onClick={() =>
                  void navigator.clipboard?.writeText(matchLink(getVenue(), done.match!)).catch(() => {})
                }
              >
                Kopiera länk
              </button>
            )}
            <button className="pill" onClick={() => setDone(null)}>Klart</button>
          </div>
        </div>
      )}

      {taken && (
        <div className="banner">
          <strong>{taken} blev precis bokad.</strong>
          Inget är debiterat — välj en annan tid.
        </div>
      )}
      {err && <div className="banner bad">{err}</div>}

      <div className="card">
        <input
          type="date"
          value={date}
          onChange={(e) => {
            setDate(e.target.value);
            setUrl({ date: e.target.value, slot: null });
          }}
          style={{
            width: '100%', minHeight: 44, border: '1px solid var(--border-strong)',
            borderRadius: 12, padding: '0 10px', font: 'inherit',
          }}
        />
        {/* Filters. Both narrow WHICH TIMES are offered — neither is a choice
            about the booking itself, which is why they live on step 1. */}
        <div className="row" style={{ marginTop: 10 }}>
          {(['indoor', 'covered', 'open'] as Cover[]).map((k) => (
            <button
              key={k}
              className={`pill ${cover.includes(k) ? 'on' : ''}`}
              onClick={() =>
                setCover((cur) => (cur.includes(k) ? cur.filter((x) => x !== k) : [...cur, k]))
              }
            >
              {COVER_SV[k]}
            </button>
          ))}
        </div>
        <div className="row" style={{ marginTop: 8 }}>
          <button className={`pill ${only === null ? 'on' : ''}`} onClick={() => setOnly(null)}>
            Alla längder
          </button>
          {[60, 90, 120].map((d) => (
            <button
              key={d}
              className={`pill ${only === d ? 'on' : ''}`}
              onClick={() => setOnly(only === d ? null : d)}
            >
              {d} min
            </button>
          ))}
        </div>
      </div>

      {shown.length === 0 && (
        <div className="empty">
          Inga lediga tider{only ? ` för ${only} min` : ''} den här dagen.
        </div>
      )}

      {shown.length > 0 && (
        <>
          <div className="slots">
            {shown.map((s) => {
              const t = hhmm(s.startsAt, tz);
              return (
                <button key={s.startsAt} className="slot" onClick={() => openStep2(s)}>
                  <span className="t">{t}</span>
                  <span className="dots">
                    {[60, 90, 120].map((d) => (
                      <i key={d} className={s.fits.includes(d) ? 'on' : ''} />
                    ))}
                  </span>
                  <span className="legend" style={{ margin: 0, fontSize: 9 }}>
                    {s.courts.length} {s.courts.length === 1 ? 'bana' : 'banor'}
                  </span>
                </button>
              );
            })}
          </div>
          <p className="legend">● 60 · ●● 90 · ●●● 120 min ryms · välj en tid för att fortsätta</p>
        </>
      )}
    </>
  );
}

/**
 * Step 2 — everything that is a decision about THIS booking: how long, which
 * court, what it costs, and paying. Step 1 only chose a time, and its filters
 * only decided which times to show.
 *
 * Nothing is held while you are here. That is honest today: a hold exists to
 * protect a slot across an ASYNCHRONOUS payment, and there is no payment rail
 * yet — so the hold and the confirm happen together on the button. When Stripe
 * lands, this screen gains the countdown the design already specifies.
 */
function Step2({
  tz, date, slot, cover, memberId, mode, onBack, onTaken, onDone,
}: {
  tz: string;
  date: string;
  slot: VenueSlot;
  cover: Cover[];
  memberId: string;
  mode: 'solo' | 'match';
  onBack: () => void;
  onTaken: (time: string) => void;
  onDone: (d: { time: string; price: Money; match?: string }) => void;
}) {
  const time = hhmm(slot.startsAt, tz);
  // 90 is the padel default; fall back only when the gap cannot take it.
  const [duration, setDuration] = useState(
    slot.fits.includes(90) ? 90 : slot.fits[slot.fits.length - 1]!,
  );
  const [courtId, setCourtId] = useState<string | null>(null);
  const [quote, setQuote] = useState<{
    price: Money; label: string; courts: { id: string; name: string; cover: Cover }[];
  } | null>(null);
  const [spots, setSpots] = useState(3);
  const [band, setBand] = useState<[string, string]>(['3.0', '4.5']);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setQuote(null);
    void api
      .quote(date, time, duration, cover)
      .then((q) => {
        setQuote(q);
        setCourtId((c) => (c && q.courts.some((x) => x.id === c) ? c : (q.courts[0]?.id ?? null)));
      })
      .catch((e) => setErr(e instanceof Error ? e.message : String(e)));
  }, [date, time, duration, cover]);

  const pay = async () => {
    if (!memberId || !quote) return;
    setBusy(true);
    setErr('');
    try {
      if (mode === 'match') {
        const m = await api.createMatch({
          memberId, date, time, duration,
          ...(courtId ? { resourceId: courtId } : {}),
          fillTarget: spots + 1, levelMin: band[0], levelMax: band[1],
        });
        onDone({ time, price: m.sharePerPlayer, match: m.reservation.id });
      } else {
        const b = await api.book({
          memberId, date, time, duration,
          ...(courtId ? { resourceId: courtId } : {}),
        });
        await api.confirm(b.reservation.id);
        onDone({ time, price: b.price });
      }
    } catch (e) {
      if (e instanceof ApiError && e.isSlotTaken) onTaken(time);
      else setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button className="pill" onClick={onBack} style={{ marginBottom: 12 }}>
        ← Andra tider
      </button>
      <h1>
        {dayLabel(slot.startsAt, tz)} {time}
      </h1>

      {err && <div className="banner bad">{err}</div>}

      <div className="card">
        <h2>Hur länge?</h2>
        <div className="seg" style={{ marginTop: 8 }}>
          {[60, 90, 120].map((d) => (
            <button
              key={d}
              className={duration === d ? 'on' : ''}
              disabled={!slot.fits.includes(d)}
              onClick={() => setDuration(d)}
            >
              {d} min
            </button>
          ))}
        </div>
      </div>

      <div className="card">
        <h2>Bana</h2>
        {!quote && <p className="meta">Söker lediga banor…</p>}
        <div className="row" style={{ marginTop: 8 }}>
          {quote?.courts.map((c) => (
            <button
              key={c.id}
              className={`pill ${courtId === c.id ? 'on' : ''}`}
              onClick={() => setCourtId(c.id)}
            >
              {c.name} · {COVER_SV[c.cover]}
            </button>
          ))}
        </div>
        {quote && quote.courts.length > 1 && (
          <p className="legend">Vi valde åt dig — byt om du har en favorit.</p>
        )}
      </div>

      {mode === 'match' && (
        <div className="card">
          <h2>Hur många platser öppnar du?</h2>
          <div className="seg" style={{ marginTop: 8 }}>
            {[1, 2, 3].map((n) => (
              <button key={n} className={spots === n ? 'on' : ''} onClick={() => setSpots(n)}>
                {n} {n === 1 ? 'plats' : 'platser'}
              </button>
            ))}
          </div>
          <div className="row" style={{ marginTop: 10 }}>
            {(
              [
                ['Nybörjare', '1.0', '3.0'],
                ['Medel', '3.0', '4.5'],
                ['Avancerad', '4.5', '7.0'],
              ] as const
            ).map(([label, lo, hi]) => (
              <button
                key={label}
                className={`pill ${band[0] === lo ? 'on' : ''}`}
                onClick={() => setBand([lo, hi])}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="card">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span className="meta">{quote?.label ?? '—'}</span>
          <span className="mono" style={{ fontSize: 20, color: 'var(--ink)', fontWeight: 600 }}>
            {quote ? kr(quote.price) : '…'}
          </span>
        </div>
        {mode === 'match' && quote && (
          <p className="legend">
            Din andel blir {Math.round(Number(quote.price.amount) / (spots + 1))} kr när matchen är
            full.
          </p>
        )}
      </div>

      <button className="cta" disabled={busy || !quote || !memberId} onClick={() => void pay()}>
        {mode === 'match' ? 'Öppna matchen' : `Betala ${quote ? kr(quote.price) : ''}`}
      </button>
    </>
  );
}

function Mine({ tz }: { tz: string }) {
  const [rows, setRows] = useState<Reservation[] | null>(null);
  const [err, setErr] = useState('');
  const load = useCallback(() => {
    api
      .myBookings()
      .then(setRows)
      .catch((e) => setErr(e.message));
  }, []);
  useEffect(load, [load]);

  const live = useMemo(
    () =>
      (rows ?? []).filter(
        (r) => r.effectiveState === 'held' || r.effectiveState === 'confirmed',
      ),
    [rows],
  );
  const past = useMemo(
    () => (rows ?? []).filter((r) => !live.includes(r)),
    [rows, live],
  );

  return (
    <>
      <h1>Mina tider</h1>
      {err && <div className="banner bad">{err}</div>}
      {rows === null && <div className="empty">Laddar…</div>}
      {rows !== null && live.length === 0 && (
        <div className="empty">Inga kommande bokningar.</div>
      )}

      {live.map((r) => (
        <div className="card" key={r.id}>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <h2>{dayLabel(r.startsAt, tz)}</h2>
            {r.effectiveState === 'held' ? (
              <span className="pill amber">HÅLLEN</span>
            ) : (
              <span className="pill green">BOKAD ✓</span>
            )}
          </div>
          <p className="meta mono" style={{ fontSize: 13 }}>
            {hhmm(r.startsAt, tz)}–{hhmm(r.endsAt, tz)}
          </p>
          <button
            className="cta ghost"
            style={{ marginTop: 10 }}
            onClick={() => {
              void api.cancel(r.id).then(load).catch((e) => setErr(e.message));
            }}
          >
            Avboka
          </button>
        </div>
      ))}

      {past.length > 0 && (
        <>
          <h2 style={{ marginTop: 18, marginBottom: 8 }}>Tidigare</h2>
          {past.map((r) => (
            <div className="card" key={r.id} style={{ opacity: 0.7 }}>
              <p className="meta mono">
                {dayLabel(r.startsAt, tz)} · {hhmm(r.startsAt, tz)} — {r.effectiveState}
              </p>
            </div>
          ))}
        </>
      )}
    </>
  );
}

function Matches({ tz, memberId }: { tz: string; memberId: string }) {
  const [rows, setRows] = useState<OpenMatch[] | null>(null);
  const [err, setErr] = useState('');
  const [ok, setOk] = useState('');
  // Default to every club the player can reach: an open match is worth finding
  // wherever it is, and the club is a filter rather than a precondition.
  const [allClubs, setAllClubs] = useState(true);

  const load = useCallback(() => {
    api
      .openMatches(allClubs)
      .then(setRows)
      .catch((e) => setErr(e.message));
  }, [allClubs]);
  useEffect(load, [load]);

  const join = (m: OpenMatch) => {
    setErr('');
    setOk('');
    api
      .joinMatch(m.reservationId, memberId)
      .then((r) => {
        setOk(`Du är med — din andel är ${r.share.amount} kr.`);
        load();
      })
      .catch((e) => setErr(e instanceof Error ? e.message : String(e)));
  };

  const share = async (m: OpenMatch) => {
    const url = matchLink(getVenue(), m.reservationId);
    try {
      await navigator.clipboard.writeText(url);
      setOk('Länk kopierad — klistra in i WhatsApp-gruppen.');
    } catch {
      setOk(url);
    }
  };

  return (
    <>
      <h1>Öppna matcher</h1>

      <div className="seg" style={{ marginBottom: 12 }}>
        <button className={allClubs ? 'on' : ''} onClick={() => setAllClubs(true)}>
          Alla klubbar
        </button>
        <button className={!allClubs ? 'on' : ''} onClick={() => setAllClubs(false)}>
          Den här klubben
        </button>
      </div>

      {err && <div className="banner bad">{err}</div>}
      {ok && <div className="banner">{ok}</div>}
      {rows === null && <div className="empty">Laddar…</div>}
      {rows !== null && rows.length === 0 && (
        <div className="empty">
          Inga öppna matcher just nu.
          <br />
          Skapa en från en bokning så syns den här.
        </div>
      )}

      {(rows ?? []).map((m) => (
        <div className="card" key={m.reservationId}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start' }}>
            <div>
              <h2>{dayLabel(m.startsAt, tz)}</h2>
              <p className="meta mono" style={{ fontSize: 13 }}>
                {hhmm(m.startsAt, tz)}–{hhmm(m.endsAt, tz)} · {m.courtName}
              </p>
            </div>
            <span className="pill">
              {m.fillTarget - m.joined}{' '}
              {m.fillTarget - m.joined === 1 ? 'plats' : 'platser'} kvar
            </span>
          </div>
          {m.venueLabel && <p className="meta">{m.venueLabel}</p>}

          {/* Fill meter — momentum, not identities. Who is already in is a
              player-tier fact; the club scope reports counts only. */}
          <div className="row" style={{ gap: 4, marginTop: 10 }}>
            {Array.from({ length: m.fillTarget }, (_, i) => (
              <i
                key={i}
                style={{
                  flex: 1,
                  height: 4,
                  borderRadius: 99,
                  background: i < m.joined ? 'var(--lime-deep)' : 'var(--alt-2)',
                }}
              />
            ))}
          </div>

          <Roster players={m.players} fillTarget={m.fillTarget} />

          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              marginTop: 10,
            }}
          >
            <span className="pill green">
              nivå {m.levelMin}–{m.levelMax}
            </span>
            <span className="mono" style={{ fontSize: 15, color: 'var(--ink)', fontWeight: 600 }}>
              {m.share.amount} kr
            </span>
          </div>

          <button className="cta" style={{ marginTop: 10 }} onClick={() => join(m)}>
            Gå med · {m.share.amount} kr
          </button>
          <button className="cta ghost" style={{ marginTop: 8 }} onClick={() => void share(m)}>
            Dela länk
          </button>
        </div>
      ))}
    </>
  );
}

/**
 * The screen a shared link lands on. Per the handover (1m/2f): the match is
 * shown FIRST — you decide whether you care before you are asked who you are —
 * and a link that can no longer be taken says so plainly instead of failing.
 */
/**
 * A club invitation, opened from the link the desk copied. No persona picker
 * here: the whole point is that the recipient is not a member yet. The email
 * field is the proof — the engine re-hashes it against what the club entered,
 * so the invitation id alone opens nothing. (With a real login session the
 * server uses the session's verified email and the field is belt-and-braces.)
 */
function AcceptClubInvite({
  invitationId,
  onDone,
}: {
  invitationId: string;
  onDone: () => void;
}) {
  const [state, setState] = useState<'asking' | 'accepted' | 'refused'>('asking');

  const shell = (body: React.ReactNode) => (
    <div className="scroll" style={{ background: 'var(--ink)', minHeight: '100%' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 0 20px' }}>
        <span className="brand-mark" />
        <span className="wordmark" style={{ color: '#fff' }}>
          RALLYPOINT
        </span>
      </div>
      {body}
    </div>
  );

  if (state === 'accepted')
    return shell(
      <div className="card">
        <h2>Välkommen till klubben!</h2>
        <p className="meta">
          Du är nu medlem. Klubben ser dig i medlemsregistret och kan boka in dig direkt.
        </p>
        <button className="cta" style={{ marginTop: 12 }} onClick={onDone}>
          Till klubben →
        </button>
      </div>,
    );

  if (state === 'refused')
    return shell(
      <div className="card">
        <h2>Inbjudan kan inte användas</h2>
        <p className="meta">
          Fel e-postadress, återkallad eller utgången — länken avslöjar inte vilket. Kontrollera
          adressen eller be klubben om en ny inbjudan.
        </p>
        <button
          className="cta ghost"
          style={{ marginTop: 12, background: 'transparent', color: '#fff', borderColor: '#4a5050' }}
          onClick={() => setState('asking')}
        >
          Försök igen
        </button>
      </div>,
    );

  return shell(
    <div className="card">
      <h2>Du är inbjuden</h2>
      {/*
        No email field any more, and its absence is the point. What the club checks the
        acceptance against is the address in your OWN verified token — so typing one here
        could only ever be a second, ignorable answer to a question the issuer already
        settled. It used to be the field the check actually ran on.
      */}
      <p className="meta">
        En klubb har bjudit in dig som spelare. Logga in med den adress inbjudan skickades
        till — det är den klubben kontrollerar.
      </p>
      <button
        className="cta"
        style={{ marginTop: 10 }}
        onClick={() =>
          acceptInvite(invitationId).then(
            () => setState('accepted'),
            () => setState('refused'),
          )
        }
      >
        Acceptera inbjudan
      </button>
    </div>,
  );
}

function JoinByLink({
  reservationId,
  tz,
  memberId,
  ready,
  onDone,
}: {
  reservationId: string;
  tz: string;
  memberId: string;
  ready: boolean;
  onDone: () => void;
}) {
  // `null` from the API is mapped straight to 'missing', so it never lands here.
  const [m, setM] = useState<MatchLanding | 'loading' | 'missing'>('loading');
  const [err, setErr] = useState('');
  const [joined, setJoined] = useState<Money | null>(null);

  useEffect(() => {
    if (!ready) return;
    api
      .match(reservationId)
      .then((r) => setM(r ?? 'missing'))
      .catch((e) => {
        setErr(e instanceof Error ? e.message : String(e));
        setM('missing');
      });
  }, [reservationId, ready]);

  const shell = (body: React.ReactNode) => (
    <div className="scroll" style={{ background: 'var(--ink)', minHeight: '100%' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 0 20px' }}>
        <span className="brand-mark" />
        <span className="wordmark" style={{ color: '#fff' }}>
          RALLYPOINT
        </span>
      </div>
      {body}
      <button
        className="cta ghost"
        style={{ marginTop: 12, background: 'transparent', color: '#fff', borderColor: '#4a5050' }}
        onClick={onDone}
      >
        Bara nyfiken? Titta på klubben →
      </button>
    </div>
  );

  if (m === 'loading') return shell(<p style={{ color: '#8A938C' }}>Laddar inbjudan…</p>);

  if (m === 'missing')
    return shell(
      <div className="card">
        <h2>Matchen finns inte</h2>
        <p className="meta">Länken kan höra till en annan klubb. {err}</p>
      </div>,
    );

  if (joined)
    return shell(
      <div className="card">
        <h2>Du är med!</h2>
        <p className="meta">Din andel är {joined.amount} kr. Matchen syns under Mina tider.</p>
      </div>,
    );

  const dead = m.status !== 'open';
  return shell(
    <>
      <p style={{ color: '#D7F34F', fontWeight: 700, marginTop: 0 }}>
        Du är inbjuden till en match
      </p>

      <div className="card">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start' }}>
          <div>
            <h2>{dayLabel(m.startsAt, tz)}</h2>
            <p className="meta mono" style={{ fontSize: 15 }}>
              {hhmm(m.startsAt, tz)}–{hhmm(m.endsAt, tz)}
            </p>
            <p className="meta">
              {m.venueName} · {m.courtName}
            </p>
          </div>
          <span className={`pill ${m.status === 'full' ? 'amber' : ''}`}>
            {m.joined}/{m.fillTarget}
          </span>
        </div>
        <Roster players={m.players} fillTarget={m.fillTarget} />
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginTop: 12,
          }}
        >
          <span className="pill green">
            nivå {m.levelMin}–{m.levelMax}
          </span>
          <span className="mono" style={{ fontSize: 16, color: 'var(--ink)', fontWeight: 600 }}>
            din andel {m.share.amount} kr
          </span>
        </div>
      </div>

      {m.status === 'full' && (
        <div className="banner">
          <strong>Matchen blev full.</strong>
          Ingenting har debiterats. Titta på klubbens övriga tider i stället.
        </div>
      )}
      {m.status === 'expired' && (
        <div className="banner">
          <strong>Länken har gått ut.</strong>
          Matchen har redan börjat — länkar dör vid starttid.
        </div>
      )}
      {m.status === 'gone' && (
        <div className="banner bad">
          <strong>Matchen är avbokad.</strong>
        </div>
      )}
      {err && <div className="banner bad">{err}</div>}

      {!dead && (
        <>
          {/* Sign-in comes AFTER the landing, deliberately: you see what you are being
              asked to join before you are asked who you are. The picker that used to sit
              here was the persona list, which is not a sign-in — it was a way to become
              anybody. */}
          {!ready && (
            <div className="card">
              <h2>Vem är du?</h2>
              <button className="cta" style={{ marginTop: 8 }} onClick={() => auth.login(location.pathname + location.search)}>
                Logga in för att gå med
              </button>
            </div>
          )}
          {ready && !memberId && (
            <div className="card">
              <p className="legend">Du är inte medlem i {m.venueName}.</p>
            </div>
          )}

          <button
            className="cta"
            disabled={!memberId}
            onClick={() => {
              setErr('');
              api
                .joinMatch(m.reservationId, memberId)
                .then((r) => setJoined(r.share))
                .catch((e) => setErr(e instanceof Error ? e.message : String(e)));
            }}
          >
            Ta platsen · {m.share.amount} kr
          </button>
        </>
      )}
    </>,
  );
}

/**
 * Who is on a match, by name. The club's roster is shut to players — but a
 * published match is the deliberate exception (spec §4.4): nobody commits 90
 * minutes and a payment to three anonymous slots.
 */
function Roster({ players, fillTarget }: { players: RosterEntry[]; fillTarget: number }) {
  const empty = Math.max(0, fillTarget - players.length);
  return (
    <div style={{ marginTop: 10, display: 'grid', gap: 6 }}>
      {players.map((p) => (
        <div key={p.partyRef} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span
            style={{
              width: 26, height: 26, borderRadius: 99, background: 'var(--lime)',
              border: '1.5px solid var(--ink)', display: 'grid', placeItems: 'center',
              fontSize: 11, fontWeight: 700, color: 'var(--ink)',
            }}
          >
            {p.name.slice(0, 1)}
          </span>
          <span style={{ fontWeight: 600, color: 'var(--ink)' }}>{p.name}</span>
          {p.level && <span className="pill mono" style={{ marginLeft: 'auto' }}>{p.level}</span>}
        </div>
      ))}
      {Array.from({ length: empty }, (_, i) => (
        <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, opacity: 0.55 }}>
          <span
            style={{
              width: 26, height: 26, borderRadius: 99,
              border: '1.5px dashed var(--border-strong)',
            }}
          />
          <span className="meta">Ledig plats</span>
        </div>
      ))}
    </div>
  );
}

function Me({ role, memberId }: { role: WhoAmI['role']; memberId: string }) {
  const [people, setPeople] = useState<PlayedWith[]>([]);
  const [clubs, setClubs] = useState<Club[]>([]);

  useEffect(() => {
    if (memberId) api.playedWith(memberId).then(setPeople).catch(() => setPeople([]));
    api.clubs().then(setClubs).catch(() => setClubs([]));
  }, [memberId]);

  return (
    <>
      <h1>Profil</h1>
      <div className="card">
        {/* The role comes from the KERNEL now — probed from this login's own grants at
            this club — rather than from a persona table that said the same thing
            everywhere. `none` is a real answer: a login with no standing here. */}
        <p className="meta">Roll i klubben: {role}</p>
      </div>

      <div className="card">
        <h2>Spelare du mött</h2>
        {people.length === 0 && (
          <p className="meta">
            Ingen än. Personer dyker upp här automatiskt när ni spelat ihop — det finns ingen
            spelarsökning.
          </p>
        )}
        {people.map((p) => (
          <div
            key={p.name}
            style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}
          >
            <span
              style={{
                width: 30, height: 30, borderRadius: 99, background: 'var(--lime)',
                border: '1.5px solid var(--ink)', display: 'grid', placeItems: 'center',
                fontWeight: 700, color: 'var(--ink)',
              }}
            >
              {p.name.slice(0, 1)}
            </span>
            <div>
              <div style={{ fontWeight: 700, color: 'var(--ink)' }}>{p.name}</div>
              <div className="meta">spelat ihop ×{p.times}</div>
            </div>
            {p.level && <span className="pill mono" style={{ marginLeft: 'auto' }}>{p.level}</span>}
          </div>
        ))}
        <p className="legend" style={{ marginTop: 10 }}>
          Bara den här klubben. Listan över alla du spelat med, oavsett klubb, hör hemma i
          spelarlagret — en klubbs databas kan inte svara på den frågan.
        </p>
      </div>

      <div className="card">
        <h2>Klubbar</h2>
        {clubs.map((c) => (
          <div
            key={c.key}
            style={{ display: 'flex', justifyContent: 'space-between', marginTop: 8 }}
          >
            <span style={{ fontWeight: 600, color: 'var(--ink)' }}>{c.label}</span>
            <span className="meta mono">{c.slug}</span>
          </div>
        ))}
        <p className="legend" style={{ marginTop: 10 }}>
          Alla klubbar, från katalogen — även de du inte gått med i. Vad du får göra i dem är en
          annan fråga. En karta kräver koordinater, som hör hemma på katalogposten.
        </p>
      </div>

      <div className="card">
        <p className="meta">
          Den här spelaren har <strong>ingen roll</strong> i klubben. Att se lediga tider och ta en
          ledig bana är scope-breda rättigheter; att läsa en bokning är smalnat till den egna
          medlemsposten.
        </p>
      </div>
    </>
  );
}
