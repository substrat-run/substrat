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
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Capabilities, View } from '../App.js';
import { api, type AgentProfile, type Contact, type Conversation, type Session } from '../api.js';
import { agentName, agents } from '../agents.js';
import { contacts, isAnonymous, nameOf } from '../contacts.js';
import { useLiveReload } from '../live.js';
import { Avatar, Empty, OwnerPicker, Priority, StateBadge, Unassigned, ago } from '../ui.js';

// Owner is 150px rather than the 44px an avatar needed: since #1079 the cell is a
// control, and a picker crushed to an avatar's width is one nobody can read.
const COLUMNS = '220px 1fr 84px 96px 150px 72px 56px';

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
  /** Not a chip — set by picking a person out of the search results (#1081). */
  contact_id: string;
}

/**
 * The floor the two search operations declare (`q: z.string().min(2)`).
 *
 * Below it the box is a box and nothing is asked for, rather than a request that
 * comes back 400 on every second keystroke.
 */
const SEARCH_MIN = 2;

/** How long the box waits for typing to stop. A request per keystroke is not a search. */
const SEARCH_DEBOUNCE_MS = 200;

/** Drop the empties; the rest is exactly the operation's declared input. */
const asked = (f: Filters) =>
  Object.fromEntries(Object.entries(f).filter(([, v]) => v !== '')) as Parameters<
    typeof api.listConversations
  >[0];

/**
 * The same narrowings, minus the one the search read does not declare.
 *
 * `contact_id` is a filter on the WALK — one person's history — and the search is
 * free text across the desk. Picking a person clears the box and typing clears the
 * person, so the two never both apply; this cast is what keeps that true at the
 * type level rather than by hoping.
 */
const askedForSearch = (f: Filters, q: string) => {
  const { contact_id: _person, ...rest } = f;
  return { q, ...asked({ ...rest, contact_id: '' }) } as Parameters<
    typeof api.searchConversations
  >[0];
};

const EMPTY: Filters = { state: '', assignee: '', channel: '', priority: '', contact_id: '' };

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
  /** What is in the box, and what has been asked for — not the same thing mid-word. */
  const [q, setQ] = useState('');
  const [term, setTerm] = useState('');
  /**
   * People whose email or name matches the term — the "who is this" half of #1081,
   * stamped with the term they answer.
   *
   * Stamped rather than a bare array, because the term moves faster than the request:
   * without it, the previous term's people stay on screen and stay CLICKABLE while
   * the new ones are in flight, and picking one narrows the inbox to somebody the
   * search no longer matches. A stale list is dropped by rendering, not by hoping the
   * response is quick.
   */
  const [matches, setMatches] = useState<{ term: string; entries: Contact[] }>({
    term: '',
    entries: [],
  });
  const [page, setPage] = useState<{ entries: Conversation[]; total: number | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cursor, setCursor] = useState(0);
  const [people, setPeople] = useState<Map<string, Contact>>(new Map());
  /** The desk's staff — the owner column's names, and what its picker may offer. */
  const [staff, setStaff] = useState<Map<string, AgentProfile>>(new Map());
  /** A failed assignment, said out loud. A row that silently snaps back is worse. */
  const [assignError, setAssignError] = useState<string | null>(null);
  /**
   * The row whose assignment is in flight.
   *
   * Two choices on one row are two requests and nothing orders them, so the earlier
   * one can land last and set an owner the person had already moved off. The list's
   * own reads solve that with a sequence number; a write cannot, because the loser
   * would still have been written. So the picker is closed until its write settles.
   */
  const [assigning, setAssigning] = useState<string | null>(null);

  /**
   * The newest request wins.
   *
   * Two filter changes in quick succession are two requests, and nothing orders their
   * responses — so the slower first one could land last and repaint the list with the
   * filter the user had already moved off. A sequence number is enough: a response
   * that is not the latest is dropped rather than applied.
   */
  const latest = useRef(0);

  const load = useCallback(
    (fromFilters = false) => {
      if (fromFilters) setPage(null);
      const seq = ++latest.current;
      const searching = term.length >= SEARCH_MIN;
      (searching
        ? api.searchConversations(askedForSearch(filters, term))
        : api.listConversations(asked(filters))
      )
        .then((p) => {
          if (seq !== latest.current) return;
          setPage({ entries: p.entries, total: p.total });
          // Only a deliberate filter change moves the cursor. A background refresh
          // that reset it would drag the selection back to the top mid-keystroke.
          if (fromFilters) setCursor(0);
          // A success means whatever failed before is over; leaving the banner up
          // makes a working screen look broken.
          setError(null);
        })
        .catch((e: Error) => {
          if (seq !== latest.current) return;
          setError(e.message);
        });
    },
    [filters, term],
  );

  // A filter change blanks the list; a background tick must not.
  useEffect(() => load(true), [load]);
  useLiveReload(load);
  useEffect(() => {
    void contacts().then(setPeople);
    void agents().then(setStaff);
  }, []);

  /** Typing settles into a term. Everything downstream hangs off `term`, never `q`. */
  useEffect(() => {
    const trimmed = q.trim();
    const id = setTimeout(() => setTerm(trimmed), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [q]);

  /**
   * The people half of the search, kept beside the conversations rather than behind a
   * tab: "what did this customer write last time" is one question, and answering it
   * in two places is how a support agent ends up in the database.
   */
  useEffect(() => {
    if (term.length < SEARCH_MIN) {
      setMatches({ term: '', entries: [] });
      return;
    }
    let live = true;
    api
      .searchContacts({ q: term })
      .then((p) => {
        if (live) setMatches({ term, entries: p.entries });
      })
      // A desk whose agent cannot read contacts still gets the conversation search.
      // A banner about the half that is not theirs would be noise.
      .catch(() => {
        if (live) setMatches({ term, entries: [] });
      });
    return () => {
      live = false;
    };
  }, [term]);

  /**
   * Hand one conversation over from the list — the bulk control, in the sense that
   * matters: a triage pass reassigns a dozen rows without opening any of them.
   *
   * It reloads rather than patching the row in place, because assignment can move
   * the conversation's state (`new → open`) and a row showing the new owner beside
   * the old badge would be half true.
   */
  const reassign = useCallback(
    (conversationId: string, assignee: string | null) => {
      setAssignError(null);
      setAssigning(conversationId);
      api
        .assign({ conversationId, assignee })
        .then(() => load())
        // The client already turns this vertical's problem+json into `message`, so a
        // refusal reads as the sentence the handler wrote rather than a status code.
        .catch((e: Error) => setAssignError(e.message))
        .finally(() => setAssigning(null));
    },
    [load],
  );

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
  const active = Object.values(filters).some(Boolean) || term.length >= SEARCH_MIN;
  const searching = term.length >= SEARCH_MIN;
  const person = filters.contact_id ? people.get(filters.contact_id) : undefined;

  /** Typing is a desk-wide search; it and one person's history are not both true. */
  const type = (value: string) => {
    setQ(value);
    if (filters.contact_id) setFilters((f) => ({ ...f, contact_id: '' }));
  };

  /** Picking a person is the other question, so it puts the box down. */
  const pick = (contactId: string) => {
    setQ('');
    setTerm('');
    setFilters((f) => ({ ...f, contact_id: contactId }));
  };

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

          {/*
            The primary navigation, not a refinement of the list — which is why it sits
            in the header beside the count rather than under the chips. It searches the
            subject and every message body on the server; two characters is the floor
            the operation declares.
          */}
          <input
            value={q}
            onChange={(e) => type(e.target.value)}
            placeholder="Search conversations and people…"
            aria-label="Search conversations and people"
            style={{
              flex: '1 1 240px',
              maxWidth: 360,
              font: "400 13px 'Geist', sans-serif",
              color: 'var(--text)',
              background: 'var(--app-bg)',
              border: '1px solid var(--frame)',
              borderRadius: 6,
              padding: '6px 10px',
              outline: 'none',
            }}
          />

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
            {/* A picked person is a filter with no chip of its own, so it gets one —
                otherwise the list is narrowed and the screen never says by whom. */}
            {filters.contact_id ? (
              <Chip active onClick={() => setFilters((f) => ({ ...f, contact_id: '' }))}>
                {person ? nameOf(person) : 'One person'} ✕
              </Chip>
            ) : null}
            {active ? (
              <button
                className="btn btn-ghost"
                onClick={() => {
                  setFilters({ ...EMPTY });
                  setQ('');
                  setTerm('');
                }}
              >
                Clear
              </button>
            ) : null}
          </div>
        </div>

        {/*
          The "who is this" half. A match on a person is not a conversation, so it is
          not smuggled into the list — it is its own strip, and picking one narrows the
          inbox to that person's history through the walk's own `contact_id` filter.
        */}
        {searching && matches.term === term && matches.entries.length > 0 ? (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              flexWrap: 'wrap',
              padding: '10px 20px',
              background: 'var(--surface)',
              borderBottom: '1px solid var(--hairline)',
            }}
          >
            <span className="micro-6" style={{ color: 'var(--muted)' }}>
              People
            </span>
            {matches.entries.map((c) => (
              <Chip key={c.id} active={false} onClick={() => pick(c.id)}>
                {nameOf(c)}
                {c.email ? <span style={{ color: 'var(--muted)' }}> · {c.email}</span> : null}
              </Chip>
            ))}
          </div>
        ) : null}

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
              <Empty
                title={searching ? `Nothing matches “${term}”` : 'Nothing matches those filters'}
                note={
                  searching
                    ? 'Subjects and message bodies were both searched.'
                    : 'Clear them to see the whole desk.'
                }
              />
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
                staff={staff}
                focused={i === cursor}
                assigning={assigning === c.id}
                onOpen={() => go({ name: 'conversation', id: c.id })}
                onAssign={(assignee) => reassign(c.id, assignee)}
              />
            ))
          )}
        </div>

        {assignError ? (
          <div
            style={{
              padding: '9px 20px',
              background: 'var(--danger-bg)',
              borderTop: '1px solid var(--danger-border)',
              font: "400 12px 'Geist', sans-serif",
              color: 'var(--danger-2)',
            }}
          >
            {assignError}
          </div>
        ) : null}

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
            {active ? ' matching' : ''} · sorted by {searching ? 'newest first' : 'last activity'}
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
  staff,
  focused,
  assigning,
  onOpen,
  onAssign,
}: {
  c: Conversation;
  who: Contact | undefined;
  staff: Map<string, AgentProfile>;
  focused: boolean;
  assigning: boolean;
  onOpen: () => void;
  onAssign: (assignee: string | null) => void;
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
      {/* The owner cell, which used to be an avatar over a raw ULID and nothing else
          (#1079). The click must not open the conversation: the whole point of
          reassigning from the list is not having to. */}
      <div
        style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}
        onClick={(e) => e.stopPropagation()}
      >
        {c.assignee ? (
          <Avatar name={agentName(staff, c.assignee) ?? ''} size={22} />
        ) : (
          <Unassigned size={22} />
        )}
        <OwnerPicker
          compact
          value={c.assignee}
          staff={[...staff.values()]}
          disabled={assigning || c.state === 'closed'}
          onChange={onAssign}
        />
      </div>
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
