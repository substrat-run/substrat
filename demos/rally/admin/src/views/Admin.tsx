import { useCallback, useEffect, useState } from 'react';
import {
  api,
  getVenue,
  inviteLink,
  newPartyRef,
  type ClubInvitation,
  type Court,
  type Member,
  type Occupancy,
  type PriceMatrixRow,
  type TenantRole,
  type VenueSnapshot,
} from '../api';

const DAYS = ['Sön', 'Mån', 'Tis', 'Ons', 'Tor', 'Fre', 'Lör'];
const COVER_SV: Record<string, string> = { indoor: 'inomhus', covered: 'tak', open: 'ute' };
// Monday-first display over a Sunday-indexed store.
const ORDER = [1, 2, 3, 4, 5, 6, 0];

export default function Admin({
  view,
}: {
  view: 'courts' | 'pricing' | 'members' | 'reports' | 'staff' | 'settings';
}) {
  const [venue, setVenue] = useState<VenueSnapshot | null>(null);
  const [courts, setCourts] = useState<Court[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [invites, setInvites] = useState<ClubInvitation[]>([]);
  const [err, setErr] = useState('');

  const reload = useCallback(async () => {
    setErr('');
    try {
      const [v, c] = await Promise.all([api.venue(), api.courts()]);
      setVenue(v);
      setCourts(c);
      try {
        setMembers(await api.members());
      } catch {
        setMembers([]);
      }
      try {
        setInvites(await api.invites());
      } catch {
        setInvites([]);
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const guard = async (fn: () => Promise<unknown>) => {
    setErr('');
    try {
      await fn();
      await reload();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <>
      {err && <div className="banner">{err}</div>}

      {view === 'courts' && (
        <div className="card">
          <h2>Banor</h2>
          <table>
            <thead>
              <tr>
                <th>Bana</th>
                <th>Längder</th>
                <th>Tak</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {courts.map((c) => {
                const cfg = venue?.courts.find((x) => x.resource_id === c.id);
                return (
                  <tr key={c.id}>
                    <td style={{ fontWeight: 700, color: 'var(--ink)' }}>{c.name}</td>
                    <td className="mono">{cfg?.durations ?? '—'}</td>
                    <td>{COVER_SV[cfg?.cover ?? 'indoor']}</td>
                    <td>
                      {c.active ? (
                        <span className="chip green">aktiv</span>
                      ) : (
                        <span className="chip">⊘ inaktiv</span>
                      )}
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      <button
                        className="btn"
                        onClick={() => void guard(() => api.setCourtActive(c.id, !c.active))}
                      >
                        {c.active ? 'Inaktivera' : 'Aktivera'}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p className="hint" style={{ marginTop: 10 }}>
            Tar du bort en längd döljs den i spelarappen för just den banan.
          </p>
          <NewCourt onCreate={(name, durations) => guard(() => api.addCourt({ name, durations }))} />
        </div>
      )}

      {view === 'pricing' && (
        <>
          <div className="card">
            <h2>Prisregler</h2>
            <p className="hint" style={{ marginTop: -4, marginBottom: 10 }}>
              Mest specifik vinner: bana &gt; längd &gt; säsong &gt; tid &gt; veckodag &gt; bas.
            </p>
            <table>
              <thead>
                <tr>
                  <th>Regel</th>
                  <th>Tid</th>
                  <th>Säsong</th>
                  <th>Längd</th>
                  <th style={{ textAlign: 'right' }}>Pris</th>
                </tr>
              </thead>
              <tbody>
                {venue?.priceRules.map((r) => (
                  <tr key={r.id}>
                    <td style={{ fontWeight: 700, color: 'var(--ink)' }}>{r.label}</td>
                    <td className="mono">
                      {r.from_time ? `${r.from_time}–${r.to_time}` : 'hela dagen'}
                    </td>
                    <td className="mono">
                      {r.from_date ? `${r.from_date} → ${r.to_date}` : 'hela året'}
                    </td>
                    <td className="mono">{r.duration ?? 'alla'}</td>
                    <td className="mono" style={{ textAlign: 'right' }}>
                      {r.amount} kr
                    </td>
                  </tr>
                ))}
                {venue?.priceRules.length === 0 && (
                  <tr>
                    <td colSpan={5} className="hint">
                      Inga regler — bokning kommer att avvisas.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          <PriceMatrix />
          <div className="card">
            <h3>Klippkort &amp; månadskort</h3>
            <table>
              <thead>
                <tr>
                  <th>Produkt</th>
                  <th>Betalar</th>
                  <th style={{ textAlign: 'right' }}>Får</th>
                </tr>
              </thead>
              <tbody>
                {venue?.creditPacks.map((t) => (
                  <tr key={t.key}>
                    <td style={{ fontWeight: 700, color: 'var(--ink)' }}>{t.title}</td>
                    <td className="mono">{(t.price_ore / 100).toFixed(0)} kr</td>
                    <td className="mono" style={{ textAlign: 'right' }}>
                      {(t.credit_ore / 100).toFixed(0)} kr
                    </td>
                  </tr>
                ))}
                {venue?.plans.map((t) => (
                  <tr key={t.key}>
                    <td style={{ fontWeight: 700, color: 'var(--ink)' }}>{t.title}</td>
                    <td className="mono">{(t.monthly_ore / 100).toFixed(0)} kr/mån</td>
                    <td className="mono" style={{ textAlign: 'right' }}>
                      {(t.monthly_credit_ore / 100).toFixed(0)} kr/mån
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {view === 'members' && (
        <div className="card">
          <h2>Medlemmar</h2>
          {members.length === 0 && (
            <p className="hint">
              Ingen behörighet att läsa medlemsregistret med den valda rollen.
            </p>
          )}
          {members.length > 0 && (
            <table>
              <thead>
                <tr>
                  <th>Namn</th>
                  <th>Rating</th>
                  <th>Spelar-ID</th>
                </tr>
              </thead>
              <tbody>
                {members.map((m) => (
                  <tr key={m.id}>
                    <td style={{ fontWeight: 700, color: 'var(--ink)' }}>{m.name}</td>
                    <td className="mono">{m.level ?? '—'}</td>
                    <td className="mono hint">{m.party_ref}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <NewMember
            onCreate={(name) => guard(() => api.addMember({ partyRef: newPartyRef(), name }))}
          />
        </div>
      )}

      {view === 'members' && (
        <div className="card">
          <h2>Inbjudningar</h2>
          <p className="hint" style={{ marginTop: -4, marginBottom: 10 }}>
            Att bjuda in är vägen in i klubben: inbjudan ger ingenting förrän spelaren själv
            accepterar den i spelarappen. Ingen e-post skickas i demot — kopiera länken och skicka
            den själv.
          </p>
          <NewInvite
            onCreate={(name, identifier) => guard(() => api.invitePlayer({ name, identifier }))}
          />
          {invites.length > 0 && (
            <table style={{ marginTop: 12 }}>
              <thead>
                <tr>
                  <th>Namn</th>
                  <th>Status</th>
                  <th>Går ut</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {invites.map((i) => (
                  <tr key={i.id}>
                    <td style={{ fontWeight: 700, color: 'var(--ink)' }}>{i.name ?? '—'}</td>
                    <td className="mono">{INVITE_STATE_SV[i.state] ?? i.state}</td>
                    <td className="mono hint">{i.expires_at.slice(0, 10)}</td>
                    <td style={{ textAlign: 'right' }}>
                      {i.state === 'invited' && (
                        <>
                          <button
                            className="btn"
                            onClick={() =>
                              void navigator.clipboard.writeText(inviteLink(getVenue(), i.id))
                            }
                          >
                            Kopiera länk
                          </button>{' '}
                          <button className="btn" onClick={() => guard(() => api.revokeInvite(i.id))}>
                            Återkalla
                          </button>
                        </>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {view === 'reports' && <Reports />}
      {view === 'staff' && <Staff />}

      {view === 'settings' && (
        <>
          <div className="card">
            <h2>Öppettider</h2>
            <p className="hint" style={{ marginTop: -4, marginBottom: 10 }}>
              Tider är lokal väggklocka i {venue?.venue.timezone}. Banornas egna tider kan bara
              smalna av klubbens, aldrig vidga dem.
            </p>
            <table>
              <thead>
                <tr>
                  <th>Dag</th>
                  <th>Öppnar</th>
                  <th>Stänger</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {ORDER.map((wd) => {
                  const h = venue?.hours.find((x) => x.weekday === wd);
                  return (
                    <tr key={wd}>
                      <td style={{ fontWeight: 700, color: 'var(--ink)' }}>{DAYS[wd]}</td>
                      <td className="mono">{h?.closed ? '—' : (h?.opens_at ?? '—')}</td>
                      <td className="mono">{h?.closed ? '—' : (h?.closes_at ?? '—')}</td>
                      <td style={{ textAlign: 'right' }}>
                        <button
                          className="btn"
                          onClick={() =>
                            void guard(() =>
                              api.setHours({ weekday: wd, closed: !h?.closed, opensAt: h?.opens_at ?? '08:00', closesAt: h?.closes_at ?? '22:00' }),
                            )
                          }
                        >
                          {h?.closed ? 'Öppna' : 'Stäng dagen'}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="card">
            <h3>Avvikelser</h3>
            {venue?.closures.length === 0 && <p className="hint">Inga registrerade.</p>}
            <table>
              <tbody>
                {venue?.closures.map((c) => (
                  <tr key={c.id}>
                    <td className="mono">{c.on_date}</td>
                    <td>{c.reason}</td>
                    <td>
                      {c.opens_at ? (
                        <span className="chip gold">
                          BLOCKERAD {c.opens_at}–{c.closes_at}
                        </span>
                      ) : (
                        <span className="chip amber">STÄNGT HELA DAGEN</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <NewClosure
              onCreate={(onDate, reason) => guard(() => api.addClosure({ onDate, reason }))}
            />
            <p className="hint" style={{ marginTop: 8 }}>
              En avvikelse gråar kalendern automatiskt. Redan lagda bokningar den dagen ligger kvar
              och måste flyttas för hand.
            </p>
          </div>
        </>
      )}
    </>
  );
}

const DAY_ORDER = [1, 2, 3, 4, 5, 6, 0];

function Reports() {
  const [data, setData] = useState<Occupancy | null>(null);
  const [err, setErr] = useState('');
  const [from, setFrom] = useState(() => {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - 13);
    return d.toISOString().slice(0, 10);
  });
  const [to, setTo] = useState(() => new Date().toISOString().slice(0, 10));

  useEffect(() => {
    api
      .occupancy(from, to)
      .then(setData)
      .catch((e) => setErr(e.message));
  }, [from, to]);

  const peak = Math.max(1, ...(data?.heat.flat() ?? [1]));
  const rate = data && data.openHours > 0 ? Math.round((data.bookedHours / data.openHours) * 100) : 0;

  return (
    <>
      {err && <div className="banner">{err}</div>}
      <div className="card">
        <h2>Rapporter</h2>
        <div className="row" style={{ gap: 8, marginBottom: 12 }}>
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10 }}>
          <Kpi label="Beläggning" value={`${rate}%`} sub={`${data?.bookedHours ?? 0} av ${data?.openHours ?? 0} h`} />
          <Kpi label="Intäkt" value={`${data?.revenue.amount ?? '0'} kr`} sub="bekräftade bokningar" />
          <Kpi label="Avbokningar" value={String(data?.cancellations ?? 0)} sub={`${data?.noShows ?? 0} uteblivna`} />
          <Kpi
            label="Lågtrafik-luckor"
            value={`${data?.offPeakGapHours ?? 0} h`}
            sub="utanför 17–21"
            amber
          />
        </div>
      </div>

      <div className="card">
        <h3>Beläggning per timme</h3>
        <table>
          <thead>
            <tr>
              <th>Dag</th>
              {Array.from({ length: 17 }, (_, i) => i + 7).map((h) => (
                <th key={h} className="mono" style={{ textAlign: 'center', padding: '4px 2px' }}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {DAY_ORDER.map((wd) => (
              <tr key={wd}>
                <td style={{ fontWeight: 700, color: 'var(--ink)' }}>{DAYS[wd]}</td>
                {Array.from({ length: 17 }, (_, i) => i + 7).map((h) => {
                  const n = data?.heat[wd]?.[h] ?? 0;
                  const pct = n / peak;
                  return (
                    <td
                      key={h}
                      className="mono"
                      title={`${n} bokningar`}
                      style={{
                        textAlign: 'center',
                        padding: '4px 2px',
                        fontSize: 9.5,
                        // Lime ramp; the number is always present so the cell is
                        // never colour-only.
                        background:
                          n === 0 ? 'var(--alt-3)' : `color-mix(in srgb, #7E9A15 ${pct * 70}%, #EFF1EA)`,
                        color: pct > 0.6 ? '#fff' : 'var(--muted)',
                      }}
                    >
                      {n || '·'}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
        <p className="hint" style={{ marginTop: 8 }}>
          Ljusa rutor utanför 17–21 är de timmar en öppen match fyller billigast.
        </p>
      </div>
    </>
  );
}

function Kpi({
  label,
  value,
  sub,
  amber,
}: {
  label: string;
  value: string;
  sub: string;
  amber?: boolean;
}) {
  return (
    <div
      style={{
        border: '1px solid var(--border)',
        borderRadius: 12,
        padding: 10,
        background: amber ? 'var(--amber-bg)' : 'var(--alt-3)',
      }}
    >
      <div style={{ fontSize: 9.5, letterSpacing: '.06em', textTransform: 'uppercase', color: 'var(--muted-2)' }}>
        {label}
      </div>
      <div
        className="mono"
        style={{ fontSize: 20, color: amber ? 'var(--amber)' : 'var(--ink)', fontWeight: 600 }}
      >
        {value}
      </div>
      <div className="hint">{sub}</div>
    </div>
  );
}

function Staff() {
  const [roles, setRoles] = useState<TenantRole[] | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    api
      .roles()
      .then(setRoles)
      .catch((e) => setErr(e.message));
  }, []);

  const keys = [...new Set((roles ?? []).flatMap((r) => r.permissions))].sort();

  return (
    <>
      {err && <div className="banner">{err}</div>}
      <div className="card">
        <h2>Personal &amp; roller</h2>
        <p className="hint" style={{ marginTop: -4, marginBottom: 10 }}>
          Rollerna kommer från katalogen (kontrollplanet), inte från klubbens databas — det här är
          vad den körande installationen faktiskt håller, vilket inte är samma fråga som vad koden
          deklarerar.
        </p>
        {roles === null && <p className="hint">Laddar…</p>}
        {roles !== null && (
          <div style={{ overflowX: 'auto' }}>
            <table>
              <thead>
                <tr>
                  <th>Rättighet</th>
                  {roles.map((r) => (
                    <th key={r.key} style={{ textAlign: 'center' }}>
                      {r.key}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {keys.map((k) => (
                  <tr key={k}>
                    <td className="mono" style={{ fontSize: 11 }}>
                      {k}
                    </td>
                    {roles.map((r) => (
                      <td key={r.key} style={{ textAlign: 'center' }}>
                        {r.permissions.includes(k) ? (
                          <span className="chip green">✓</span>
                        ) : (
                          <span style={{ color: 'var(--disabled)' }}>·</span>
                        )}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="hint" style={{ marginTop: 10 }}>
          Spelare syns inte här: en spelare har <strong>ingen roll</strong>. Deras åtkomst är
          tilldelningar per entitet, som per definition inte kan ritas som en rollmatris.
        </p>
      </div>
    </>
  );
}

/**
 * What the rules RESOLVE to, hour by hour and length by length.
 *
 * A price table's failure mode is a hole in the matrix, not a wrong number: miss
 * a (window × duration) combination and the specificity ladder quietly falls
 * back to a broader rule. Reading the rule list will not show you that; reading
 * the resolved grid will, because a row where all three lengths cost the same is
 * visible instantly.
 */
function PriceMatrix() {
  const [rows, setRows] = useState<PriceMatrixRow[]>([]);
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [err, setErr] = useState('');

  useEffect(() => {
    api
      .priceMatrix(date)
      .then(setRows)
      .catch((e) => setErr(e.message));
  }, [date]);

  return (
    <div className="card">
      <h3>Vad reglerna faktiskt ger</h3>
      <div className="row" style={{ marginBottom: 10 }}>
        <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
      </div>
      {err && <div className="banner">{err}</div>}
      <table>
        <thead>
          <tr>
            <th>Tid</th>
            <th style={{ textAlign: 'right' }}>60 min</th>
            <th style={{ textAlign: 'right' }}>90 min</th>
            <th style={{ textAlign: 'right' }}>120 min</th>
            <th>Regel</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const flat = new Set(r.cells.map((c) => c.amount)).size === 1;
            return (
              <tr key={r.time}>
                <td className="mono" style={{ fontWeight: 700, color: 'var(--ink)' }}>{r.time}</td>
                {r.cells.map((c) => (
                  <td
                    key={c.duration}
                    className="mono"
                    style={{ textAlign: 'right', color: flat ? 'var(--gold-ink)' : undefined }}
                  >
                    {c.amount}
                  </td>
                ))}
                <td className="hint">
                  {r.cells[1]?.label}
                  {flat && <span className="chip gold" style={{ marginLeft: 6 }}>samma pris</span>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="hint" style={{ marginTop: 8 }}>
        Rader märkta <strong>samma pris</strong> kostar lika mycket oavsett speltid — nästan
        alltid en lucka i prismatrisen, inte ett beslut.
      </p>
    </div>
  );
}

function NewCourt({ onCreate }: { onCreate: (n: string, d: string) => void }) {
  const [name, setName] = useState('');
  const [durations, setDurations] = useState('60,90,120');
  return (
    <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
      <input type="text" placeholder="Bana 3" value={name} onChange={(e) => setName(e.target.value)} />
      <input type="text" value={durations} onChange={(e) => setDurations(e.target.value)} />
      <button className="btn lime" disabled={!name} onClick={() => { onCreate(name, durations); setName(''); }}>
        Lägg till bana
      </button>
    </div>
  );
}

const INVITE_STATE_SV: Record<string, string> = {
  invited: 'väntar',
  accepted: 'accepterad',
  revoked: 'återkallad',
  expired: 'utgången',
};

function NewInvite({ onCreate }: { onCreate: (name: string, identifier: string) => void }) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  return (
    <div style={{ display: 'flex', gap: 8 }}>
      <input type="text" placeholder="Namn" value={name} onChange={(e) => setName(e.target.value)} />
      <input
        type="email"
        placeholder="E-post"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
      />
      <button
        className="btn lime"
        disabled={!name || !email}
        onClick={() => {
          onCreate(name, email);
          setName('');
          setEmail('');
        }}
      >
        Bjud in spelare
      </button>
    </div>
  );
}

function NewMember({ onCreate }: { onCreate: (n: string) => void }) {
  const [name, setName] = useState('');
  return (
    <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
      <input type="text" placeholder="Namn" value={name} onChange={(e) => setName(e.target.value)} />
      <button className="btn lime" disabled={!name} onClick={() => { onCreate(name); setName(''); }}>
        Lägg till medlem
      </button>
    </div>
  );
}

function NewClosure({ onCreate }: { onCreate: (d: string, r: string) => void }) {
  const [date, setDate] = useState('');
  const [reason, setReason] = useState('');
  return (
    <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
      <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
      <input type="text" placeholder="Orsak" value={reason} onChange={(e) => setReason(e.target.value)} />
      <button className="btn" disabled={!date || !reason} onClick={() => { onCreate(date, reason); setDate(''); setReason(''); }}>
        Lägg till avvikelse
      </button>
    </div>
  );
}
