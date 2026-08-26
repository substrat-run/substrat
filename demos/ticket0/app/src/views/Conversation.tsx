/**
 * Artboards 02–08 — the conversation.
 *
 * This one screen carries all three of the handoff's product constraints, so each is
 * marked where it lives:
 *
 *   1. public vs internal — `Composer`, which restyles its ENTIRE surface by mode;
 *   2. agents never see cost — `Rail`, where the usage card is absent rather than
 *      disabled, and absent because the API refused, not because a flag said so;
 *   3. the assistant is staff — `MessageRow` treats it like a person, and only its
 *      DRAFT gets the special card (`DraftCard`).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Capabilities, View } from '../App.js';
import type { Session } from '../api.js';
import { ApiError, api, type Contact, type Conversation, type Message, type SavedReply } from '../api.js';
import { contacts, isAnonymous, nameOf } from '../contacts.js';
import { useLiveReload } from '../live.js';
import { Avatar, EventDivider, StateBadge, clock } from '../ui.js';

interface Turn {
  id: string;
  message_id: string | null;
  model: string;
  confidence: number | null;
  outcome: 'drafted' | 'answered' | 'escalated' | 'failed';
  citations: { id: string; title: string; url: string; headingPath: string }[];
}

/** What `list-messages` actually returns: the row plus its resolved citations. */
type MessageWithCitations = Message & {
  citations: { id: string; title: string; url: string; headingPath: string }[];
};

interface Usage {
  total: string;
  currency: string;
  lines: { meterKey: string; qty: string; unitPrice: string; amount: string }[];
}

export function ConversationView({
  id,
  caps,
  session,
  go,
}: {
  id: string;
  caps: Capabilities | null;
  session: Session;
  go: (v: View) => void;
}) {
  const [conv, setConv] = useState<Conversation | null>(null);
  const [messages, setMessages] = useState<MessageWithCitations[]>([]);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [usage, setUsage] = useState<Usage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [who, setWho] = useState<Contact | undefined>(undefined);

  const load = useCallback(async () => {
    try {
      const [c, m, t] = await Promise.all([
        api.getConversation({ conversationId: id }),
        api.listMessages({ conversationId: id }),
        api.listTurns({ conversationId: id }),
      ]);
      setConv(c);
      setWho((await contacts()).get(c.contact_id));
      setMessages(m.entries as MessageWithCitations[]);
      setTurns(t.entries as Turn[]);
      // Constraint 2: the cost read is only attempted when the caller holds the key,
      // and a refusal leaves `usage` null — which is what makes the card absent.
      if (caps?.money) {
        setUsage((await api.usageSummary({ conversationId: id })) as Usage);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [id, caps?.money]);

  useEffect(() => {
    void load();
  }, [load]);

  // Faster than the inbox: somebody reading one conversation is waiting on this one.
  useLiveReload(() => void load(), 5000);

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (error && !conv)
    return (
      <div className="frame" style={{ width: 720, padding: 40 }}>
        <div className="t-title">Could not open this conversation</div>
        <div className="t-meta" style={{ marginTop: 6 }}>
          {error}
        </div>
      </div>
    );
  if (!conv) return <div className="t-meta">Loading…</div>;

  const turnFor = (messageId: string) => turns.find((t) => t.message_id === messageId);

  return (
    <div style={{ width: 1120, maxWidth: '100%' }}>
      <div className="frame" style={{ display: 'grid', gridTemplateColumns: '1fr 272px' }}>
        <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
          <Header conv={conv} busy={busy} act={act} go={go} />
          {error ? (
            <div
              style={{
                margin: '10px 20px 0',
                padding: '9px 12px',
                background: 'var(--danger-bg)',
                border: '1px solid var(--danger-border)',
                borderRadius: 6,
                font: "400 12px 'Geist', sans-serif",
                color: 'var(--danger-2)',
              }}
            >
              {error}
            </div>
          ) : null}
          <Thread messages={messages} turnFor={turnFor} conv={conv} busy={busy} act={act} />
          <Composer conv={conv} busy={busy} act={act} session={session} />
        </div>
        <Rail conv={conv} who={who} usage={usage} go={go} />
      </div>
    </div>
  );
}

/* ── Header (02/03) ─────────────────────────────────────────────────────── */

function Header({
  conv,
  busy,
  act,
  go,
}: {
  conv: Conversation;
  busy: boolean;
  act: (fn: () => Promise<unknown>) => Promise<void>;
  go: (v: View) => void;
}) {
  const tomorrow = () => new Date(Date.now() + 86400000).toISOString();
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '13px 20px',
        background: 'var(--surface)',
        borderBottom: '1px solid var(--hairline)',
      }}
    >
      <button className="btn btn-ghost" onClick={() => go({ name: 'inbox' })} title="Back to inbox">
        ←
      </button>
      <div className="t-strong" style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>
        {conv.subject}
      </div>
      <StateBadge state={conv.state} />
      <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
        {conv.state === 'resolved' ? (
          <button className="btn" disabled={busy} onClick={() => void act(() => api.close({ conversationId: conv.id }))}>
            Close
          </button>
        ) : (
          <>
            <button
              className="btn"
              disabled={busy || conv.state === 'closed'}
              onClick={() => void act(() => api.snooze({ conversationId: conv.id, until: tomorrow() }))}
            >
              Snooze
            </button>
            <button
              className="btn"
              disabled={busy || conv.state === 'closed'}
              onClick={() => void act(() => api.resolve({ conversationId: conv.id }))}
            >
              Resolve
            </button>
          </>
        )}
      </div>
    </div>
  );
}

/* ── Thread (02, 04, 05, 08) ────────────────────────────────────────────── */

function Thread({
  messages,
  turnFor,
  conv,
  busy,
  act,
}: {
  messages: MessageWithCitations[];
  turnFor: (id: string) => Turn | undefined;
  conv: Conversation;
  busy: boolean;
  act: (fn: () => Promise<unknown>) => Promise<void>;
}) {
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' });
  }, [messages.length]);

  return (
    <div
      className="scroll"
      style={{
        flex: 1,
        minHeight: 380,
        maxHeight: 560,
        overflowY: 'auto',
        background: 'var(--app-bg)',
        padding: '18px 20px',
        display: 'flex',
        flexDirection: 'column',
        gap: 14,
      }}
    >
      {messages.map((m, i) => {
        const turn = turnFor(m.id);
        // Artboard 08: the resolution and the reply that undid it are events in the
        // timeline, not states you have to infer from a badge that already moved on.
        // The FIRST contact message after the resolution is the one that reopened it.
        // Marking every later one too would draw the same event over and over.
        const reopened =
          conv.resolved_at &&
          m.author_kind === 'contact' &&
          new Date(m.created_at) > new Date(conv.resolved_at) &&
          !messages
            .slice(0, i)
            .some(
              (e) =>
                e.author_kind === 'contact' &&
                new Date(e.created_at) > new Date(conv.resolved_at!),
            );
        return (
          <div key={m.id} style={{ display: 'contents' }}>
            {reopened && i > 0 ? (
              <EventDivider tone="reopened" label="reopened" meta="customer replied · back in the queue, same thread" />
            ) : null}
            {turn && turn.outcome === 'drafted' && m.visibility === 'internal' ? (
              <DraftCard message={m} turn={turn} busy={busy} act={act} conv={conv} />
            ) : (
              <MessageRow message={m} />
            )}
          </div>
        );
      })}
      {conv.state === 'resolved' || conv.state === 'closed' ? (
        <EventDivider
          tone="resolved"
          label={conv.state}
          meta={conv.resolved_at ? new Date(conv.resolved_at).toLocaleString() : undefined}
        />
      ) : null}
      <div ref={end} />
    </div>
  );
}

const AUTHOR: Record<string, string> = {
  contact: 'Customer',
  agent: 'Support',
  assistant: 'Assistant',
  system: 'System',
};

/**
 * Constraint 3: the assistant gets the same avatar, the same name line, the same
 * meta treatment as a human. No robot chrome anywhere.
 */
function MessageRow({ message }: { message: MessageWithCitations }) {
  const internal = message.visibility === 'internal';
  return (
    <div style={{ display: 'flex', gap: 10 }}>
      <Avatar name={AUTHOR[message.author_kind] ?? '?'} size={26} anonymous={message.author_kind === 'contact'} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 4 }}>
          <span style={{ font: "600 12px 'Geist', sans-serif" }}>{AUTHOR[message.author_kind]}</span>
          <span className="t-small">· {clock(message.created_at)}</span>
          {internal ? (
            <span
              className="mono"
              style={{
                font: "600 10px 'Geist Mono', monospace",
                letterSpacing: '.06em',
                color: 'var(--internal-text)',
                background: 'var(--internal-tab)',
                border: '1px solid var(--internal-border-soft)',
                borderRadius: 4,
                padding: '1px 6px',
              }}
            >
              INTERNAL
            </span>
          ) : null}
        </div>
        <div
          style={{
            background: internal ? 'var(--internal-bg)' : 'var(--surface)',
            border: `1px solid ${internal ? 'var(--internal-border-soft)' : 'var(--hairline)'}`,
            borderRadius: 8,
            padding: '10px 13px',
            font: "400 13px/1.65 'Geist', sans-serif",
            whiteSpace: 'pre-wrap',
            color: internal ? 'var(--internal-text-3)' : 'var(--text)',
          }}
        >
          {message.body_text}
        </div>
        {message.citations.length > 0 ? (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 7 }}>
            {message.citations.map((c) => (
              <a
                key={c.id}
                href={c.url}
                target="_blank"
                rel="noreferrer"
                style={{
                  font: "500 11px 'Geist Mono', monospace",
                  color: 'var(--accent-text)',
                  background: 'var(--tint)',
                  border: '1px solid var(--tint-border)',
                  borderRadius: 4,
                  padding: '2px 7px',
                }}
              >
                {c.title}
              </a>
            ))}
          </div>
        ) : null}
        {!internal && message.author_kind !== 'contact' ? (
          <div className="t-small" style={{ marginTop: 5 }}>
            public · {message.delivered_at ? 'delivered by email' : 'shown in widget'}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/* ── The draft card (04) ────────────────────────────────────────────────── */

function DraftCard({
  message,
  turn,
  conv,
  busy,
  act,
}: {
  message: MessageWithCitations;
  turn: Turn;
  conv: Conversation;
  busy: boolean;
  act: (fn: () => Promise<unknown>) => Promise<void>;
}) {
  const confidence = turn.confidence ?? 0;
  return (
    <div
      style={{
        border: '1.5px dashed #b9b9b2',
        borderRadius: 8,
        background: 'var(--surface)',
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '9px 13px',
          background: '#f4f4f1',
          borderBottom: '1px solid #e7e7e3',
        }}
      >
        <Avatar name="Assistant" size={22} />
        <span style={{ font: "600 12px 'Geist', sans-serif" }}>Assistant</span>
        <span
          className="mono"
          style={{
            font: "600 10px 'Geist Mono', monospace",
            letterSpacing: '.07em',
            color: 'var(--secondary)',
            background: '#eaeae6',
            border: '1px solid #dcdcd8',
            borderRadius: 4,
            padding: '2px 7px',
          }}
        >
          DRAFT · NOT SENT
        </span>
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ width: 64, height: 4, borderRadius: 2, background: '#e4e4e0' }}>
            <span
              style={{
                display: 'block',
                width: `${Math.round(confidence * 64)}px`,
                height: 4,
                borderRadius: 2,
                background: 'var(--green)',
              }}
            />
          </span>
          <span className="t-small mono">{confidence.toFixed(2)} confidence</span>
        </div>
      </div>

      <div
        style={{
          padding: '13px',
          font: "400 13px/1.65 'Geist', sans-serif",
          whiteSpace: 'pre-wrap',
        }}
      >
        {message.body_text}
      </div>

      {turn.citations.length > 0 ? (
        <div style={{ padding: '0 13px 13px' }}>
          <div className="micro" style={{ marginBottom: 8 }}>
            Cites {turn.citations.length} source{turn.citations.length === 1 ? '' : 's'}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {turn.citations.map((c) => (
              <div
                key={c.id}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  border: '1px solid var(--hairline)',
                  borderRadius: 6,
                  padding: '8px 10px',
                  background: 'var(--app-bg)',
                }}
              >
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ font: "500 12px 'Geist', sans-serif" }}>{c.title}</div>
                  <div
                    className="mono"
                    style={{
                      font: "400 11px 'Geist Mono', monospace",
                      color: 'var(--muted)',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {c.url}
                  </div>
                </div>
                <a href={c.url} target="_blank" rel="noreferrer" style={{ font: "500 11px 'Geist', sans-serif" }}>
                  Open ↗
                </a>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '10px 13px',
          borderTop: '1px solid var(--hairline)',
          background: 'var(--app-bg)',
        }}
      >
        <span className="t-small">Nothing reaches the customer until a person decides.</span>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
          {/* Disabled until they do something — the same treatment as “Merge into
              another…”, so a control that does nothing looks like one. */}
          <button className="btn btn-ghost" disabled title="Not implemented yet">
            Discard
          </button>
          <button className="btn" disabled title="Not implemented yet">
            Edit
          </button>
          <button
            className="btn btn-primary"
            disabled={busy}
            onClick={() =>
              void act(() =>
                api.postPublicReply({ conversationId: conv.id, body: message.body_text }),
              )
            }
          >
            Send reply
          </button>
        </div>
      </div>
    </div>
  );
}

/* ── Composer (06, 07) — constraint 1 ───────────────────────────────────── */

function Composer({
  conv,
  busy,
  act,
  session,
}: {
  conv: Conversation;
  busy: boolean;
  act: (fn: () => Promise<unknown>) => Promise<void>;
  session: Session;
}) {
  const [internal, setInternal] = useState(false);
  const [text, setText] = useState('');
  const [picker, setPicker] = useState(false);
  const ta = useRef<HTMLTextAreaElement>(null);

  const send = () => {
    const body = text.trim();
    if (!body) return;
    void act(async () => {
      await (internal
        ? api.postNote({ conversationId: conv.id, body })
        : api.postPublicReply({ conversationId: conv.id, body }));
      setText('');
    });
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // ⇥ toggles Reply ↔ Internal note. The handoff makes this the primary gesture,
    // so it takes Tab away from focus movement inside the composer deliberately.
    if (e.key === 'Tab') {
      e.preventDefault();
      setInternal((v) => !v);
      return;
    }
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      send();
      return;
    }
    if (e.key === ';' && text === '') {
      e.preventDefault();
      setPicker(true);
    }
  };

  return (
    <div style={{ position: 'relative', borderTop: '1px solid var(--hairline)', background: 'var(--surface)' }}>
      {picker ? (
        <SavedReplies
          onPick={(body) => {
            setText((t) => (t ? `${t}\n${body}` : body));
            setPicker(false);
            ta.current?.focus();
          }}
          onClose={() => setPicker(false)}
        />
      ) : null}

      <div style={{ padding: 12 }}>
        {/* The mode label is persistent and names the person, per the handoff. */}
        <div
          className="mono"
          style={{
            font: "600 10px 'Geist Mono', monospace",
            letterSpacing: '.07em',
            textTransform: 'uppercase',
            color: internal ? 'var(--internal-text)' : 'var(--secondary-2)',
            marginBottom: 7,
          }}
        >
          {internal
            ? '● INTERNAL — the customer will never see this'
            : '○ PUBLIC — the customer receives this by email'}
        </div>

        <div
          style={{
            position: 'relative',
            borderRadius: 6,
            // Constraint 1: the ENTIRE surface changes, not a corner of it.
            background: internal ? 'var(--internal-bg)' : 'var(--surface)',
            border: internal ? '1.5px solid var(--internal-border)' : '1px solid var(--frame)',
            boxShadow: internal ? 'inset 3px 0 0 var(--internal-stripe)' : 'none',
          }}
        >
          <textarea
            ref={ta}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKeyDown}
            rows={3}
            placeholder={internal ? 'A note for colleagues…' : `Reply to the customer…`}
            style={{
              width: '100%',
              resize: 'vertical',
              border: 0,
              outline: 'none',
              background: 'transparent',
              padding: '10px 12px',
              font: "400 13px/1.6 'Geist', sans-serif",
              color: internal ? 'var(--internal-text-3)' : 'var(--text)',
              caretColor: internal ? 'var(--internal-stripe)' : 'var(--text)',
            }}
          />
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 9 }}>
          <span className="t-small mono">
            ⇥ switches to {internal ? 'Reply' : 'Internal note'} · ⌘↵ sends · ; saved replies
          </span>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
            <button
              className={internal ? 'btn btn-internal' : 'btn btn-primary'}
              disabled={busy || !text.trim()}
              onClick={send}
            >
              {internal ? 'Add internal note' : 'Send reply'}
            </button>
          </div>
        </div>
        <div className="t-small" style={{ marginTop: 6, opacity: 0.75 }}>
          Signed in as {session.display}
        </div>
      </div>
    </div>
  );
}

/* ── Saved replies (07) ─────────────────────────────────────────────────── */

function SavedReplies({ onPick, onClose }: { onPick: (body: string) => void; onClose: () => void }) {
  const [items, setItems] = useState<SavedReply[]>([]);
  const [q, setQ] = useState('');
  const [i, setI] = useState(0);

  useEffect(() => {
    void api
      .listSavedReplies()
      .then((p) => setItems(p.entries))
      .catch(() => setItems([]));
  }, []);

  const shown = items.filter((r) => (r.title + r.body).toLowerCase().includes(q.toLowerCase()));
  const active = shown[Math.min(i, shown.length - 1)];

  return (
    <div
      style={{
        position: 'absolute',
        bottom: 'calc(100% + 8px)',
        left: 12,
        width: 576,
        maxWidth: 'calc(100% - 24px)',
        background: 'var(--surface)',
        border: '1px solid var(--frame)',
        borderRadius: 8,
        boxShadow: 'var(--shadow-popover)',
        overflow: 'hidden',
        zIndex: 10,
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') onClose();
        if (e.key === 'ArrowDown') setI((n) => Math.min(shown.length - 1, n + 1));
        if (e.key === 'ArrowUp') setI((n) => Math.max(0, n - 1));
        if (e.key === 'Enter' && active) onPick(active.body);
      }}
    >
      <div style={{ padding: 10, borderBottom: '1px solid var(--hairline)' }}>
        <input
          autoFocus
          className="input"
          placeholder="Search saved replies…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '224px 1fr', minHeight: 180 }}>
        <div style={{ borderRight: '1px solid var(--hairline)', overflowY: 'auto', maxHeight: 260 }}>
          {shown.length === 0 ? (
            <div className="t-small" style={{ padding: 14 }}>
              Nothing saved yet.
            </div>
          ) : (
            shown.map((r, n) => (
              <div
                key={r.id}
                onMouseEnter={() => setI(n)}
                onClick={() => onPick(r.body)}
                style={{
                  padding: '9px 12px',
                  cursor: 'pointer',
                  background: n === i ? 'var(--tint)' : 'transparent',
                  boxShadow: n === i ? 'inset 2px 0 0 var(--action)' : 'none',
                }}
              >
                <div style={{ font: "500 12px 'Geist', sans-serif" }}>{r.title}</div>
                <div className="t-small mono">;{r.title.toLowerCase().replace(/\s+/g, '-')}</div>
              </div>
            ))
          )}
        </div>
        <div style={{ padding: 13, font: "400 12px/1.65 'Geist', sans-serif", color: 'var(--secondary)' }}>
          {active ? active.body : <span className="t-small">Pick a reply to preview it.</span>}
        </div>
      </div>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          padding: '8px 12px',
          borderTop: '1px solid var(--hairline)',
          background: 'var(--app-bg)',
        }}
      >
        <span className="t-small mono">↑↓ browse · ↵ insert · esc</span>
        <span className="t-small">Inserted as editable text — nothing sends on insert.</span>
      </div>
    </div>
  );
}

/* ── Right rail (02 / 03) ───────────────────────────────────────────────── */

function Rail({
  conv,
  who,
  usage,
  go,
}: {
  conv: Conversation;
  who: Contact | undefined;
  usage: Usage | null;
  go: (v: View) => void;
}) {
  const field = (k: string, v: React.ReactNode) => (
    <>
      <div className="micro" style={{ color: 'var(--muted)' }}>
        {k}
      </div>
      <div style={{ font: "400 12px 'Geist', sans-serif", color: 'var(--secondary)' }}>{v}</div>
    </>
  );

  return (
    <aside
      style={{
        borderLeft: '1px solid var(--hairline)',
        background: 'var(--surface)',
        padding: 16,
        display: 'flex',
        flexDirection: 'column',
        gap: 18,
      }}
    >
      <div>
        <div className="micro" style={{ marginBottom: 8 }}>
          Contact
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
          <Avatar name={nameOf(who, conv.channel)} size={28} anonymous={isAnonymous(who)} />
          <div style={{ minWidth: 0 }}>
            <div style={{ font: "500 12px 'Geist', sans-serif" }}>{nameOf(who, conv.channel)}</div>
            <div className="t-small mono" style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {who?.email ?? conv.contact_id.slice(-8)}
            </div>
          </div>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px 8px', alignItems: 'center' }}>
        {field('Channel', <span className="mono">{conv.channel}</span>)}
        {field('State', <StateBadge state={conv.state} />)}
        {field('Owner', conv.assignee ? <Avatar name={conv.assignee} size={20} /> : '—')}
        {field('Priority', <span className="mono">{conv.priority}</span>)}
      </div>

      <div>
        <div className="micro" style={{ marginBottom: 8 }}>
          Tags
        </div>
        <div className="t-small">None yet</div>
      </div>

      {/**
       * Constraint 2, and the whole of it: when the caller does not hold `usage:read`
       * this element does not exist. There is no lock icon and no greyed placeholder,
       * because either of those would tell an agent what they are not allowed to know.
       */}
      {usage ? (
        <div
          style={{
            background: '#fafaf8',
            border: '1px solid var(--hairline)',
            borderRadius: 8,
            padding: 12,
          }}
        >
          <div className="micro" style={{ marginBottom: 8 }}>
            Assistant usage
          </div>
          <div style={{ font: "600 16px 'Geist Mono', monospace", letterSpacing: '-.01em' }}>
            ${Number(usage.total).toFixed(4)}
          </div>
          <div className="t-small" style={{ marginBottom: 9 }}>
            this conversation
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
            {usage.lines.map((l) => (
              <div key={l.meterKey} style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                <span className="t-small mono">{l.meterKey.replace('ai.tokens.', '')}</span>
                <span className="t-small mono">{Number(l.qty).toLocaleString()}</span>
              </div>
            ))}
          </div>
          <div
            style={{
              marginTop: 10,
              paddingTop: 9,
              borderTop: '1px solid var(--hairline-soft)',
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
            }}
          >
            <span className="micro" style={{ color: 'var(--muted-2)' }}>
              admin only
            </span>
            <a
              href="#/settings/usage"
              onClick={(e) => {
                e.preventDefault();
                go({ name: 'settings', tab: 'usage' });
              }}
              style={{ font: "500 11px 'Geist', sans-serif" }}
            >
              Usage &amp; cost ↗
            </a>
          </div>
        </div>
      ) : null}

      <div style={{ marginTop: 'auto' }}>
        <button className="btn" style={{ width: '100%' }} disabled>
          Merge into another…
        </button>
      </div>
    </aside>
  );
}
