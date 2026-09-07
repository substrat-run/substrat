/**
 * The lists — who is waiting for an invite, and who gets the changelog.
 *
 * One read for the counts and one for the rows, both `signup:read`, which desk-admin
 * holds and an agent does not. That is not a UI decision made here: the nav item is
 * absent for anyone without the key, and this screen would get a 403 if they reached
 * it by typing the hash. What it renders is a table of real email addresses, which is
 * why the key sits with the money rather than with the inbox.
 *
 * ## What this screen deliberately cannot do
 *
 * There is no "add", no "import" and no "resend". Every row here got here because a
 * person typed their own address into a form and then clicked a link in their own
 * inbox, and a button on this screen that could produce a row any other way would make
 * the whole double opt-in decorative. Removing somebody is the one write worth having
 * and it is not here either — the unsubscribe link in their mail is theirs, and staff
 * pasting a token would be acting as them.
 *
 * So it is a read, and the write it exists to serve happens somewhere else: copy the
 * confirmed addresses out on a Monday and send the changelog.
 */
import { useEffect, useMemo, useState } from 'react';
import type { Capabilities } from '../App.js';
import { api } from '../api.js';
import { Empty, ago } from '../ui.js';

type Signup = Awaited<ReturnType<typeof api.listSignups>>['entries'][number];
type Counts = Awaited<ReturnType<typeof api.signupCounts>>['counts'];

type Kind = 'waitlist' | 'newsletter';
type State = 'pending' | 'confirmed' | 'unsubscribed';

const KINDS: { value: Kind; label: string }[] = [
  { value: 'waitlist', label: 'Waiting list' },
  { value: 'newsletter', label: 'Changelog' },
];

/**
 * The three states, in the order they happen, with the words a person would use.
 *
 * `pending` is the one worth naming carefully: those addresses are NOT on the list and
 * must never be sent to. Calling the column "unconfirmed" rather than "pending" makes
 * the row say what it means to somebody about to copy addresses out of this table.
 */
const STATES: { value: State; label: string; hint: string }[] = [
  { value: 'pending', label: 'Unconfirmed', hint: 'asked, has not clicked the link — do not send to these' },
  { value: 'confirmed', label: 'Confirmed', hint: 'on the list' },
  { value: 'unsubscribed', label: 'Left', hint: 'asked to be taken off' },
];

function badge(state: string) {
  const tone =
    state === 'confirmed'
      ? { bg: 'var(--ok-bg, #e7f6ec)', fg: 'var(--ok-fg, #166534)' }
      : state === 'pending'
        ? { bg: 'var(--warn-bg, #fdf3e0)', fg: 'var(--warn-fg, #92400e)' }
        : { bg: 'var(--nav-active)', fg: 'var(--secondary-2)' };
  const label = STATES.find((s) => s.value === state)?.label ?? state;
  return (
    <span
      style={{
        background: tone.bg,
        color: tone.fg,
        borderRadius: 999,
        padding: '1px 8px',
        fontSize: 12,
        fontWeight: 600,
        whiteSpace: 'nowrap',
      }}
    >
      {label}
    </span>
  );
}

export function Signups({ caps }: { caps: Capabilities | null }) {
  const [kind, setKind] = useState<Kind>('waitlist');
  const [state, setState] = useState<State | ''>('confirmed');
  const [rows, setRows] = useState<Signup[] | null>(null);
  const [total, setTotal] = useState<number | null>(null);
  const [counts, setCounts] = useState<Counts | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!caps?.signups) return;
    let live = true;
    setRows(null);
    setFailed(false);
    void api
      .listSignups({ kind, ...(state ? { state } : {}) })
      .then((page) => {
        if (!live) return;
        setRows(page.entries);
        setTotal(page.total);
      })
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, [caps?.signups, kind, state]);

  useEffect(() => {
    if (!caps?.signups) return;
    let live = true;
    void api
      .signupCounts()
      .then((c) => live && setCounts(c.counts))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [caps?.signups]);

  /** One read gives every pair; the header wants the three for the list on screen. */
  const forKind = useMemo(
    () => (s: State) => counts?.find((c) => c.kind === kind && c.state === s)?.count ?? 0,
    [counts, kind],
  );

  if (!caps?.signups)
    return (
      <div className="frame" style={{ width: 720 }}>
        <Empty
          title="The lists are the desk admin's"
          note="Your account does not hold `signup:read`. It is a table of real email addresses, so it has one door — the same one the money has."
        />
      </div>
    );

  return (
    <div
      className="frame"
      style={{ width: 960, maxWidth: '100%', padding: 22, background: 'var(--surface)' }}
    >
      <div className="t-page">Signups</div>
      <div className="t-meta" style={{ marginTop: 4, marginBottom: 18 }}>
        Everybody here typed their own address and confirmed it from their own inbox
      </div>

      <div style={{ display: 'flex', gap: 6, marginBottom: 14, flexWrap: 'wrap' }}>
        {KINDS.map((k) => (
          <button
            key={k.value}
            className="btn btn-ghost"
            onClick={() => setKind(k.value)}
            style={{
              background: kind === k.value ? 'var(--nav-active)' : 'transparent',
              fontWeight: kind === k.value ? 600 : 500,
            }}
          >
            {k.label}
          </button>
        ))}
      </div>

      {/* The counts, and the unconfirmed one carries its warning rather than sitting
          next to the others as if it were a subscriber count. */}
      <div style={{ display: 'flex', gap: 22, marginBottom: 18, flexWrap: 'wrap' }}>
        {STATES.map((s) => (
          <div key={s.value} title={s.hint}>
            <div style={{ fontSize: 22, fontWeight: 600 }}>{forKind(s.value)}</div>
            <div className="t-meta">{s.label}</div>
          </div>
        ))}
      </div>

      <div style={{ display: 'flex', gap: 6, marginBottom: 12, flexWrap: 'wrap' }}>
        <button
          className="btn btn-ghost"
          onClick={() => setState('')}
          style={{ background: state === '' ? 'var(--nav-active)' : 'transparent' }}
        >
          All
        </button>
        {STATES.map((s) => (
          <button
            key={s.value}
            className="btn btn-ghost"
            onClick={() => setState(s.value)}
            style={{ background: state === s.value ? 'var(--nav-active)' : 'transparent' }}
          >
            {s.label}
          </button>
        ))}
      </div>

      {failed ? (
        <Empty title="That did not load" note="Try again in a moment." />
      ) : rows === null ? (
        <div className="t-meta">Loading…</div>
      ) : rows.length === 0 ? (
        <Empty
          title="Nobody here yet"
          note="A signup arrives when somebody submits the form on a page this desk lists as an allowed origin."
        />
      ) : (
        <>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
            <thead>
              <tr className="t-meta" style={{ textAlign: 'left' }}>
                <th style={{ padding: '6px 8px' }}>Address</th>
                <th style={{ padding: '6px 8px' }}>State</th>
                <th style={{ padding: '6px 8px' }}>Asked</th>
                <th style={{ padding: '6px 8px' }}>What they said</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id} style={{ borderTop: '1px solid var(--hairline)' }}>
                  {/*
                    An erased signup keeps its row and loses its address, which is what
                    `erasable` means — so the column has to render the absence rather
                    than an empty cell that reads as a bug.
                  */}
                  <td style={{ padding: '8px' }}>{row.email ?? <span className="t-meta">erased</span>}</td>
                  <td style={{ padding: '8px' }}>{badge(row.state)}</td>
                  <td style={{ padding: '8px' }} className="t-meta">{ago(row.requested_at)}</td>
                  <td style={{ padding: '8px' }} className="t-meta">
                    {row.note ?? '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {total !== null && total > rows.length ? (
            <div className="t-meta" style={{ marginTop: 12 }}>
              Showing {rows.length} of {total}. The rest are on the next page of the
              declared read — narrow with the filters above, or walk it from the API.
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
