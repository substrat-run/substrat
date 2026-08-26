/**
 * Artboard 01 — the inbox list, and the agent's working surface.
 *
 * The filter row is the part worth reading. The design draws it as chips; the model
 * declares `filterable: ['state','assignee','channel','priority','contact_id']` and the
 * kernel composes the query and the indexes behind them. A chip that says
 * "State: Open" over an unfiltered list is worse than no chip — it is a promise the
 * screen is not keeping — so these are wired, and every one of them narrows the read on
 * the server rather than in the browser.
 *
 * Two more things from the handoff that are easy to lose:
 *
 *  - the state-badge legend, because `resolved → open` is a real edge and a reader has
 *    to be told a customer reply causes it;
 *  - the empty state, which for this product is a *good* outcome ("Zero open
 *    conversations") rather than an apology.
 */
import { useCallback, useEffect, useState } from 'react';
import type { Capabilities, View } from '../App.js';
import { api, type Contact, type Conversation, type Session } from '../api.js';
import { contacts, isAnonymous, nameOf } from '../contacts.js';
import { useLiveReload } from '../live.js';
import { Avatar, Empty, Priority, StateBadge, Unassigned, ago } from '../ui.js';

const COLUMNS = '220px 1fr 84px 96px 44px 72px 56px';

/**
 * Each chip is one declared filter column.
 *
 * `''` means "do not send it" — the operation's inputs are optional, and an undefined
 * column is the difference between "every state" and "no state at all".
 */
interface Filters {
  state: string;
  assignee: string;
  channel: string;
  priority: string;
}

/** Drop the empties; the rest is exactly the operation's declared input. */
const asked = (f: Filters) =>
  Object.fromEntries(Object.entries(f).filter(([, v]) => v !== '')) as Parameters<
    typeof api.listConversations
  >[0];

const EMPTY: Filters = { state: '', assignee: '', channel: '', priority: '' };

const OPTIONS: { key: keyof Filters; label: string; values: [string, string][] }[] = [
  {
    key: 'state',
    label: 'State',
    values: [
      ['', 'All'],
      ['new', 'New'],
      ['open', 'Open'],
      ['snoozed', 'Snoozed'],
      ['resolved', 'Resolved'],
      ['closed', 'Closed'],
    ],
  },
  {
    key: 'channel',
    label: 'Channel',
    values: [
      ['', 'All'],
      ['widget', 'Widget'],
      ['email', 'Email'],
    ],
  },
  {
    key: 'priority',
    label: 'Priority',
    values: [
      ['', 'All'],
      ['urgent', 'Urgent'],
      ['normal', 'Normal'],
      ['low', 'Low'],
    ],
  },
];

export function Inbox({
  caps,
  session,
  go,
}: {
  caps: Capabilities | null;
  session: Session;
  go: (v: View) => void;
}) {
  const [filters, setFilters] = useState<Filters>({ ...EMPTY });
  const [page, setPage] = useState<{ entries: Conversation[]; total: number | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cursor, setCursor] = useState(0);
  const [people, setPeople] = useState<Map<string, Contact>>(new Map());

  const load = useCallback(
    (fromFilters = false) => {
      if (fromFilters) setPage(null);
      api
        .listConversations(asked(filters))
        .then((p) => {
          setPage({ entries: p.entries, total: p.total });
          // Only a deliberate filter change moves the cursor. A background refresh
          // that reset it would drag the selection back to the top mid-keystroke.
          if (fromFilters) setCursor(0);
          // A success means whatever failed before is over; leaving the banner up
          // makes a working screen look broken.
          setError(null);
        })
        .catch((e: Error) => setError(e.message));
    },
    [filters],
  );

  // A filter change blanks the list; a background tick must not.
  useEffect(() => load(true), [load]);
  useLiveReload(load);
  useEffect(() => {
    void contacts().then(setPeople);
  }, []);

  // J/K/O, exactly as the footer advertises. A hint that does not work is worse than
  // no hint, so the keys are wired rather than drawn.
  useEffect(() => {
    const entries = page?.entries ?? [];
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLElement && /input|textarea|select/i.test(e.target.tagName)) return;
      if (e.key === 'j') setCursor((c) => Math.min(entries.length - 1, c + 1));
      if (e.key === 'k') setCursor((c) => Math.max(0, c - 1));
      if (e.key === 'o' && entries[cursor]) go({ name: 'conversation', id: entries[cursor]!.id });
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [page, cursor, go]);

  if (!caps?.inbox)
    return (
      <div className="frame" style={{ width: 720 }}>
        <Empty
          title="This desk's inbox is not yours to read"
          note="Your own conversations are under “My conversations”."
        />
      </div>
    );

  const mine = filters.assignee === session.principal;
  const active = Object.values(filters).some(Boolean);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 22, width: 1360, maxWidth: '100%' }}>
      <div className="frame">
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 16,
            padding: '14px 20px',
            background: 'var(--surface)',
            borderBottom: '1px solid var(--hairline)',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
            <div className="t-strong">Inbox</div>
            <div className="chip">{page?.total ?? page?.entries.length ?? '—'}</div>
          </div>

          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            {/* The agent's own queue. First, because it is the one most used. */}
            <Chip
              active={mine}
              onClick={() =>
                setFilters((f) => ({ ...f, assignee: mine ? '' : session.principal }))
              }
            >
              Assigned to me
            </Chip>
            {OPTIONS.map((o) => (
              <Select
                key={o.key}
                label={o.label}
                value={filters[o.key]}
                values={o.values}
                onChange={(v) => setFilters((f) => ({ ...f, [o.key]: v }))}
              />
            ))}
            {active ? (
              <button className="btn btn-ghost" onClick={() => setFilters({ ...EMPTY })}>
                Clear
              </button>
            ) : null}
          </div>
        </div>

        <div
          className="micro-6"
          style={{
            display: 'grid',
            gridTemplateColumns: COLUMNS,
            gap: '0 16px',
            padding: '8px 20px',
            color: 'var(--muted)',
          }}
        >
          <div>Contact</div>
          <div>Conversation</div>
          <div>Channel</div>
          <div>State</div>
          <div>Owner</div>
          <div>Priority</div>
          <div style={{ textAlign: 'right' }}>Active</div>
        </div>

        <div style={{ background: 'var(--surface)' }}>
          {error ? (
            <Empty title="Could not load the inbox" note={error} />
          ) : !page ? (
            <Empty title="Loading…" />
          ) : page.entries.length === 0 ? (
            active ? (
              <Empty title="Nothing matches those filters" note="Clear them to see the whole desk." />
            ) : (
              <Empty
                title="Zero open conversations"
                note="Everything that came in has been answered."
              />
            )
          ) : (
            page.entries.map((c, i) => (
              <Row
                key={c.id}
                c={c}
                who={people.get(c.contact_id)}
                focused={i === cursor}
                onOpen={() => go({ name: 'conversation', id: c.id })}
              />
            ))
          )}
        </div>

        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            padding: '10px 20px',
            background: 'var(--app-bg)',
            borderTop: '1px solid var(--hairline)',
          }}
        >
          <span className="t-small">
            Showing {page?.entries.length ?? 0} of {page?.total ?? page?.entries.length ?? 0}
            {active ? ' matching' : ''} · sorted by last activity
          </span>
          <span className="t-small mono" style={{ letterSpacing: '.02em' }}>
            J / K to move · O to open
          </span>
        </div>
      </div>

      <Legend />
    </div>
  );
}

function Chip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      style={{
        font: "500 12px 'Geist', sans-serif",
        cursor: 'pointer',
        color: active ? 'var(--text)' : 'var(--secondary)',
        background: active ? 'var(--tint)' : 'var(--surface)',
        border: `1px solid ${active ? 'var(--tint-border)' : 'var(--frame)'}`,
        borderRadius: 6,
        padding: '5px 10px',
      }}
    >
      {children}
    </button>
  );
}

/** A chip that is really a select — the design's shape, with the behaviour it implies. */
function Select({
  label,
  value,
  values,
  onChange,
}: {
  label: string;
  value: string;
  values: [string, string][];
  onChange: (v: string) => void;
}) {
  const on = value !== '';
  return (
    <label
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        font: "500 12px 'Geist', sans-serif",
        color: on ? 'var(--text)' : 'var(--secondary)',
        background: on ? 'var(--tint)' : 'var(--surface)',
        border: `1px solid ${on ? 'var(--tint-border)' : 'var(--frame)'}`,
        borderRadius: 6,
        padding: '4px 8px 4px 10px',
        cursor: 'pointer',
      }}
    >
      {label}
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        style={{
          border: 0,
          background: 'transparent',
          font: "500 12px 'Geist', sans-serif",
          color: 'inherit',
          cursor: 'pointer',
          outline: 'none',
        }}
      >
        {values.map(([v, l]) => (
          <option key={v} value={v}>
            {l}
          </option>
        ))}
      </select>
    </label>
  );
}

function Row({
  c,
  who,
  focused,
  onOpen,
}: {
  c: Conversation;
  who: Contact | undefined;
  focused: boolean;
  onOpen: () => void;
}) {
  // "Unread" in the design is a warm tint. Here it means nobody has replied yet, which
  // is the fact the colour is standing for.
  const unread = !c.first_public_reply_at;
  return (
    <div
      onClick={onOpen}
      style={{
        display: 'grid',
        gridTemplateColumns: COLUMNS,
        gap: '0 16px',
        alignItems: 'center',
        padding: '11px 20px',
        borderBottom: '1px solid var(--row-line)',
        background: focused ? '#f4f4f1' : unread ? '#fdf8f1' : 'var(--surface)',
        cursor: 'pointer',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 9, minWidth: 0 }}>
        <Avatar name={nameOf(who, c.channel)} size={24} anonymous={isAnonymous(who)} />
        <span
          style={{
            font: "500 13px 'Geist', sans-serif",
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {nameOf(who, c.channel)}
        </span>
      </div>
      <div style={{ minWidth: 0 }}>
        <span style={{ font: "600 13px 'Geist', sans-serif" }}>{c.subject}</span>{' '}
        <span
          className="t-meta"
          style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
        >
          — {c.priority === 'urgent' ? 'needs attention' : 'in the queue'}
        </span>
      </div>
      <div className="mono" style={{ fontSize: 11, color: 'var(--secondary-2)' }}>
        {c.channel}
      </div>
      <div>
        <StateBadge state={c.state} />
      </div>
      <div>{c.assignee ? <Avatar name={c.assignee} size={22} /> : <Unassigned size={22} />}</div>
      <div>
        <Priority value={c.priority} />
      </div>
      <div className="t-small" style={{ textAlign: 'right' }}>
        {ago(c.updated_at)}
      </div>
    </div>
  );
}

/**
 * The state legend. It is in the design because the lifecycle has an edge people do
 * not expect, and a badge nobody explained is a badge nobody trusts.
 */
function Legend() {
  const states = ['new', 'open', 'snoozed', 'resolved', 'closed'];
  return (
    <div className="card" style={{ padding: '14px 18px' }}>
      <div className="micro" style={{ marginBottom: 10 }}>
        Conversation states
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        {states.map((s, i) => (
          <span key={s} style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
            <StateBadge state={s} />
            {i < states.length - 1 ? <span style={{ color: 'var(--muted-2)' }}>→</span> : null}
          </span>
        ))}
      </div>
      <div className="t-small" style={{ marginTop: 10 }}>
        A customer reply moves <strong style={{ color: 'var(--secondary)' }}>resolved → open</strong>
        {' '}— same thread, back in the queue.
      </div>
    </div>
  );
}
