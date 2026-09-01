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
import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import type { Capabilities, View } from '../App.js';
import type { Session } from '../api.js';
import { ApiError, api, type AgentProfile, type Contact, type Conversation, type Message, type SavedReply } from '../api.js';
import { agentName, agents } from '../agents.js';
import { contacts, isAnonymous, nameOf } from '../contacts.js';
import { useLiveReload } from '../live.js';
import { Avatar, EventDivider, OwnerPicker, StateBadge, Unassigned, clock } from '../ui.js';

interface Turn {
  id: string;
  message_id: string | null;
  model: string;
  confidence: number | null;
  outcome: 'drafted' | 'answered' | 'escalated' | 'failed';
  /** Why, when `outcome` is `failed`. */
  error: string | null;
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

/** What `widget-session` returns: the browser behind a widget conversation, or nothing. */
type WidgetSession = Awaited<ReturnType<typeof api.widgetSession>>['session'];

/** The tags on this conversation, and the desk's whole vocabulary behind the input. */
type ConversationTag = Awaited<ReturnType<typeof api.listConversationTags>>['tags'][number];
type DeskTag = Awaited<ReturnType<typeof api.listTags>>['tags'][number];

/** The rating the customer left, read back by the people it is about. */
type Csat = Awaited<ReturnType<typeof api.getCsat>>['csat'];

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
  const [visitor, setVisitor] = useState<WidgetSession>(null);
  const [tags, setTags] = useState<ConversationTag[]>([]);
  const [vocabulary, setVocabulary] = useState<DeskTag[]>([]);
  const [csat, setCsat] = useState<Csat>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [who, setWho] = useState<Contact | undefined>(undefined);
  /** The desk's staff — what the owner picker offers and what turns a ULID into a name. */
  const [staff, setStaff] = useState<Map<string, AgentProfile>>(new Map());

  const load = useCallback(async () => {
    try {
      const [c, m, t, tg, vocab, rating] = await Promise.all([
        api.getConversation({ conversationId: id }),
        api.listMessages({ conversationId: id }),
        api.listTurns({ conversationId: id }),
        api.listConversationTags({ conversationId: id }),
        api.listTags(),
        // The staff half of `submit-csat`. Null for an unrated conversation, which
        // is most of them — the card is simply absent rather than empty.
        api.getCsat({ conversationId: id }),
      ]);
      setConv(c);
      setWho((await contacts()).get(c.contact_id));
      setMessages(m.entries as MessageWithCitations[]);
      setTurns(t.entries as Turn[]);
      setTags(tg.tags);
      setVocabulary(vocab.tags);
      setCsat(rating.csat);
      // Only a widget conversation has a browser behind it; an email one is not asked.
      setVisitor(c.channel === 'widget' ? (await api.widgetSession({ conversationId: id })).session : null);
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

  // The directory, once. It is not part of `load()` because it does not change when
  // the conversation does, and a five-second poll re-reading the staff list would be
  // a request per tick for an answer that is the same every time.
  useEffect(() => {
    void agents().then(setStaff);
  }, []);

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
        <Rail
          conv={conv}
          who={who}
          staff={staff}
          visitor={visitor}
          usage={usage}
          tags={tags}
          vocabulary={vocabulary}
          csat={csat}
          busy={busy}
          act={act}
          go={go}
        />
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
        {/*
          Snooze and Resolve are the states the machine will still take from here;
          `resolved` has neither, since it is already past both.

          Close is beside them ALWAYS, and that is the point of it. `resolve` refuses
          a conversation the customer has never heard from, so an empty or abandoned
          thread can only ever leave the inbox this way — a Close that appeared only
          after Resolve had succeeded was a door locked from the inside.
        */}
        {conv.state === 'resolved' ? null : (
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
        <button
          className="btn"
          disabled={busy || conv.state === 'closed'}
          title="Close this conversation for good — it leaves the inbox and is not counted as answered"
          onClick={() => void act(() => api.close({ conversationId: conv.id }))}
        >
          Close
        </button>
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
            {turn && turn.outcome === 'failed' ? (
              <FailedCard message={m} turn={turn} />
            ) : turn && turn.outcome === 'drafted' && m.visibility === 'internal' ? (
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

/* ── The failure card ───────────────────────────────────────────────────── */

/**
 * The assistant did not answer, and this says why.
 *
 * A failed turn used to render as an ordinary internal note — "I could not answer
 * this one" — which told an agent the assistant had given up and nothing about what
 * had gone wrong. The reason is on the turn now (`error`), so it goes on the card, in
 * the words of whatever threw: a provider's status line, a refused permission, a
 * principal that was never minted. Same avatar and name as any other turn — the
 * assistant is staff, and staff are allowed to fail visibly.
 */
function FailedCard({ message, turn }: { message: MessageWithCitations; turn: Turn }) {
  return (
    <div
      style={{
        border: '1.5px dashed var(--danger-border-2)',
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
          background: 'var(--danger-bg)',
          borderBottom: '1px solid var(--danger-border-2)',
        }}
      >
        <Avatar name="Assistant" size={22} />
        <span style={{ font: "600 12px 'Geist', sans-serif" }}>Assistant</span>
        <span
          className="mono"
          style={{
            font: "600 10px 'Geist Mono', monospace",
            letterSpacing: '.07em',
            color: 'var(--danger-3)',
            background: 'var(--surface)',
            border: '1px solid var(--danger-border-2)',
            borderRadius: 4,
            padding: '2px 7px',
          }}
        >
          COULD NOT ANSWER
        </span>
        <span className="t-small" style={{ marginLeft: 'auto' }}>
          {clock(message.created_at)} · <span className="mono">{turn.model}</span>
        </span>
      </div>
      <div style={{ padding: '13px', font: "400 13px/1.65 'Geist', sans-serif", whiteSpace: 'pre-wrap' }}>
        {message.body_text}
      </div>
      <div style={{ padding: '0 13px 13px' }}>
        <div className="micro" style={{ marginBottom: 6 }}>
          Why
        </div>
        <div
          className="mono"
          style={{
            font: "400 11px/1.5 'Geist Mono', monospace",
            color: 'var(--danger-3)',
            background: 'var(--danger-bg)',
            border: '1px solid var(--danger-border-2)',
            borderRadius: 6,
            padding: '8px 10px',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
          }}
        >
          {turn.error ?? 'No reason was recorded.'}
        </div>
        <div className="t-small" style={{ marginTop: 7 }}>
          Nothing was sent and nothing was charged. The customer is waiting for a person — reply
          below.
        </div>
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
                // Naming the turn is what takes it off the "waiting for a person" list:
                // a draft a human sends has been sent, and the row has to say so or the
                // desk keeps offering it and keeps counting it as undelivered.
                api.postPublicReply({
                  conversationId: conv.id,
                  body: message.body_text,
                  turnId: turn.id,
                }),
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
  /** What the last insert could not fill in. Lives HERE rather than in the picker,
   *  which unmounts the moment the text lands. */
  const [insertNote, setInsertNote] = useState<string | null>(null);
  const ta = useRef<HTMLTextAreaElement>(null);

  const send = () => {
    const body = text.trim();
    if (!body) return;
    void act(async () => {
      await (internal
        ? api.postNote({ conversationId: conv.id, body })
        : api.postPublicReply({ conversationId: conv.id, body }));
      setText('');
      setInsertNote(null);
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
          conversationId={conv.id}
          onPick={(body, note) => {
            setText((t) => (t ? `${t}\n${body}` : body));
            setInsertNote(note);
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
        {insertNote ? (
          <div className="t-small" style={{ marginTop: 6, color: 'var(--internal-text)' }}>
            {insertNote}
          </div>
        ) : null}
        <div className="t-small" style={{ marginTop: 6, opacity: 0.75 }}>
          Signed in as {session.display}
        </div>
      </div>
    </div>
  );
}

/* ── Saved replies (07) ─────────────────────────────────────────────────── */

/**
 * A placeholder, for the preview's benefit only.
 *
 * The authoritative pattern is `savedReplyToken()` in `spec/model.ts` and the
 * substitution happens on the server — this exists so the preview can SAY a reply
 * has placeholders before the agent inserts it. A screen that highlights and a
 * renderer that replaces are allowed to be two pieces of code; a screen that
 * substituted would not be, because it would need the contact's name in the
 * browser and that read is what the server-side render exists to keep behind a
 * permission check.
 */
const TOKEN_HINT = /\{\{\s*[A-Za-z0-9_.]+\s*\}\}/;

function SavedReplies({
  conversationId,
  onPick,
  onClose,
}: {
  conversationId: string;
  onPick: (body: string, note: string | null) => void;
  onClose: () => void;
}) {
  const [items, setItems] = useState<SavedReply[]>([]);
  const [q, setQ] = useState('');
  const [i, setI] = useState(0);
  /** The reply being edited, as a draft — `null` means the list is just a list. */
  const [draft, setDraft] = useState<{ id: string; title: string; body: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** Which reply's Delete button is asking a second time. A deletion is not undoable
   *  and the button sits next to Edit, so one stray click must not be enough. */
  const [confirming, setConfirming] = useState<string | null>(null);

  /**
   * A failed load says so and keeps what it had.
   *
   * Emptying the list on a failure renders "Nothing saved yet." over a library that
   * exists — a wrong answer told confidently, and the worst kind after a save or a
   * delete, where it would read as the write having destroyed everything.
   */
  const reload = () =>
    api
      .listSavedReplies()
      .then((p) => {
        setItems(p.entries);
        setError(null);
      })
      .catch((e: unknown) =>
        setError(e instanceof ApiError ? e.message : 'Could not load the saved replies.'),
      );

  useEffect(() => {
    void reload();
  }, []);

  const shown = items.filter((r) => (r.title + r.body).toLowerCase().includes(q.toLowerCase()));
  const active = shown[Math.min(i, shown.length - 1)];

  // Moving off a row disarms its Delete. An armed confirmation that survives a walk
  // through the list is a trap: the second click lands on a row the person is no
  // longer thinking about.
  useEffect(() => {
    if (confirming !== null && confirming !== active?.id) setConfirming(null);
  }, [active?.id, confirming]);

  /**
   * Insert the SERVER's rendering, never the raw body.
   *
   * If the render fails the raw text still goes in: a desk that cannot paste a
   * canned answer because a placeholder could not be filled is worse than one that
   * pastes `{{contact.name}}` for a person to fix. The failure is said out loud
   * rather than swallowed.
   */
  const pick = (reply: SavedReply) => {
    setBusy(true);
    void api
      .renderSavedReply({ conversationId, savedReplyId: reply.id })
      .then((r) => {
        // The note goes UP rather than into this component's own error line: the
        // insert closes the picker, so anything said here is unmounted before it is
        // read. The composer outlives the insert and is where the text landed.
        const parts = [
          r.blank.length > 0 ? `nothing to put in ${r.blank.join(', ')}` : '',
          r.unresolved.length > 0 ? `left ${r.unresolved.join(', ')} as written` : '',
        ].filter(Boolean);
        onPick(r.body, parts.length > 0 ? `Inserted — ${parts.join('; ')}.` : null);
      })
      .catch(() =>
        onPick(reply.body, 'Inserted as written — the placeholders could not be filled in.'),
      )
      .finally(() => setBusy(false));
  };

  /**
   * Open the editor by READING the row, not by copying it out of the list.
   *
   * The read is what arms the concurrency guard: it hands back the entity tag the
   * generated client remembers and sends as `If-Match` on the save, so a colleague
   * who edited the same reply in the meantime causes a refusal rather than a silent
   * overwrite. Seeding the form from the list row would skip that and look identical
   * until the day it mattered.
   */
  const edit = (reply: SavedReply) => {
    setError(null);
    // An armed Delete must not survive the trip through the editor: click Delete,
    // click Edit, cancel, and the next single click would delete without asking.
    setConfirming(null);
    setBusy(true);
    void api
      .getSavedReply({ savedReplyId: reply.id })
      .then((r) => setDraft({ id: r.id, title: r.title, body: r.body }))
      .catch((e: unknown) => setError(e instanceof ApiError ? e.message : 'Could not open that reply.'))
      .finally(() => setBusy(false));
  };

  const save = () => {
    if (!draft) return;
    setBusy(true);
    void api
      .updateSavedReply({ savedReplyId: draft.id, title: draft.title, body: draft.body })
      .then(async () => {
        setDraft(null);
        setError(null);
        await reload();
      })
      .catch((e: unknown) =>
        setError(
          e instanceof ApiError && e.status === 412
            ? 'Somebody else changed this reply while you had it open. Close and reopen it to see theirs.'
            : e instanceof ApiError
              ? e.message
              : 'Could not save that reply.',
        ),
      )
      .finally(() => setBusy(false));
  };

  const remove = (reply: SavedReply) => {
    if (confirming !== reply.id) {
      setConfirming(reply.id);
      return;
    }
    setBusy(true);
    void api
      .deleteSavedReply({ savedReplyId: reply.id })
      .then(async () => {
        setDraft(null);
        setConfirming(null);
        setError(null);
        await reload();
      })
      .catch((e: unknown) => setError(e instanceof ApiError ? e.message : 'Could not delete that reply.'))
      .finally(() => setBusy(false));
  };

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
        if (e.key === 'Escape') {
          if (draft) setDraft(null);
          else onClose();
          return;
        }
        // While the editor is open the arrows belong to the textarea, not the list.
        if (draft) return;
        if (e.key === 'ArrowDown') setI((n) => Math.min(shown.length - 1, n + 1));
        if (e.key === 'ArrowUp') setI((n) => Math.max(0, n - 1));
        if (e.key === 'Enter' && active) pick(active);
      }}
    >
      <div style={{ padding: 10, borderBottom: '1px solid var(--hairline)' }}>
        <input
          autoFocus
          className="input"
          placeholder="Search saved replies…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          disabled={draft !== null}
        />
      </div>
      {error ? (
        <div
          className="t-small"
          style={{ padding: '7px 12px', borderBottom: '1px solid var(--hairline)', color: 'var(--secondary)' }}
        >
          {error}
        </div>
      ) : null}
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
                onMouseEnter={() => (draft ? undefined : setI(n))}
                onClick={() => (draft ? undefined : pick(r))}
                style={{
                  padding: '9px 12px',
                  cursor: draft ? 'default' : 'pointer',
                  opacity: draft && draft.id !== r.id ? 0.45 : 1,
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
        {draft ? (
          <div style={{ padding: 13, display: 'flex', flexDirection: 'column', gap: 8 }}>
            {/* Focused on open, and not only for convenience: the Edit button
                unmounts with the preview pane, so focus would otherwise fall back
                to the body and the container's keydown handler would never see
                Escape — leaving "esc cancels the edit" a hint that does nothing. */}
            <input
              autoFocus
              className="input"
              value={draft.title}
              onChange={(e) => setDraft({ ...draft, title: e.target.value })}
              placeholder="Title"
            />
            <textarea
              className="input"
              rows={6}
              value={draft.body}
              onChange={(e) => setDraft({ ...draft, body: e.target.value })}
              placeholder="The reply. {{contact.name}}, {{conversation.subject}}, {{agent.name}}, {{agent.signature}}"
              style={{ resize: 'vertical', font: "400 12px/1.6 'Geist', sans-serif" }}
            />
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                className="btn btn-primary"
                disabled={busy || draft.title.trim() === '' || draft.body.trim() === ''}
                onClick={save}
              >
                Save
              </button>
              <button className="btn btn-ghost" disabled={busy} onClick={() => setDraft(null)}>
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <div style={{ padding: 13, display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ font: "400 12px/1.65 'Geist', sans-serif", color: 'var(--secondary)', flex: 1 }}>
              {active ? active.body : <span className="t-small">Pick a reply to preview it.</span>}
            </div>
            {active && TOKEN_HINT.test(active.body) ? (
              <div className="t-small">Placeholders fill in when you insert.</div>
            ) : null}
            {active ? (
              <div style={{ display: 'flex', gap: 8 }}>
                <button className="btn" disabled={busy} onClick={() => edit(active)}>
                  Edit
                </button>
                <button className="btn btn-ghost" disabled={busy} onClick={() => remove(active)}>
                  {confirming === active.id ? 'Delete — click again' : 'Delete'}
                </button>
              </div>
            ) : null}
          </div>
        )}
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
        <span className="t-small mono">
          {draft ? 'esc cancels the edit' : '↑↓ browse · ↵ insert · esc'}
        </span>
        <span className="t-small">Inserted as editable text — nothing sends on insert.</span>
      </div>
    </div>
  );
}

/* ── Right rail (02 / 03) ───────────────────────────────────────────────── */

function Rail({
  conv,
  who,
  staff,
  visitor,
  usage,
  tags,
  vocabulary,
  csat,
  busy,
  act,
  go,
}: {
  conv: Conversation;
  who: Contact | undefined;
  staff: Map<string, AgentProfile>;
  visitor: WidgetSession;
  usage: Usage | null;
  tags: ConversationTag[];
  vocabulary: DeskTag[];
  csat: Csat;
  busy: boolean;
  act: (fn: () => Promise<unknown>) => Promise<void>;
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
        {/* The rail used to render the owner as read-only text over a ULID, and
            `assign` had no caller in the app at all (#1079). This is that caller: the
            options are the desk's own directory, so the avatar has a name behind it
            and handing the conversation over is one choice rather than a seed script.
            `closed` is terminal — the machine refuses the write there, so the control
            says so rather than letting the desk find out. */}
        {field(
          'Owner',
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
            {conv.assignee ? (
              <Avatar name={agentName(staff, conv.assignee) ?? ''} size={18} />
            ) : (
              <Unassigned size={18} />
            )}
            <OwnerPicker
              compact
              value={conv.assignee}
              staff={[...staff.values()]}
              disabled={busy || conv.state === 'closed'}
              onChange={(assignee) =>
                void act(() => api.assign({ conversationId: conv.id, assignee }))
              }
            />
          </div>,
        )}
        {/* The inbox has always sorted and filtered on priority; this is where a
            person picks one. `closed` is terminal, so the machine refuses the write
            there and the control says so rather than letting the desk find out. */}
        {field(
          'Priority',
          <select
            value={conv.priority}
            disabled={busy || conv.state === 'closed'}
            onChange={(e) =>
              void act(() =>
                api.setPriority({
                  conversationId: conv.id,
                  priority: e.target.value as Conversation['priority'],
                }),
              )
            }
            style={{
              border: '1px solid var(--frame)',
              borderRadius: 6,
              background: 'var(--surface)',
              font: "400 12px 'Geist Mono', monospace",
              color: 'inherit',
              padding: '2px 4px',
              cursor: busy || conv.state === 'closed' ? 'default' : 'pointer',
            }}
          >
            <option value="low">low</option>
            <option value="normal">normal</option>
            <option value="urgent">urgent</option>
          </select>,
        )}
      </div>

      {visitor ? <VisitorCard session={visitor} /> : null}

      {/* Tagging has existed since the first release and nothing ever read the table
          back, so this panel said "None yet" whatever the conversation carried
          (#1084). It now shows the tags, takes one off, and offers the desk's own
          vocabulary behind the input rather than inviting a fresh typo. */}
      <TagPanel conv={conv} tags={tags} vocabulary={vocabulary} busy={busy} act={act} />

      {/* The customer's rating, on the conversation it is about. Absent rather than
          empty when nobody rated: an unrated conversation is the normal case. */}
      {csat ? <CsatCard csat={csat} /> : null}

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

/* ── Tags ───────────────────────────────────────────────────────────────── */

/**
 * The tags on this conversation, plus one input to add another.
 *
 * The `<datalist>` is the desk's whole vocabulary and is why `list-tags` returns a
 * count: the browser offers the suggestions in the order given, so the tag five
 * conversations already carry comes first and a one-off typo comes last. Free text
 * stays free text — nothing here refuses a new tag, it only makes an existing one
 * easier to reach than to misspell.
 *
 * `closed` is terminal, so the machine refuses both writes there and the controls
 * say so rather than letting the desk find out from a red banner.
 *
 * Enter commits and nothing else does — deliberately. Committing on blur reads as
 * convenient and is not: a person who typed half a tag and clicked away into the
 * thread has just tagged the conversation `bil`, and the only way back is to notice
 * and remove it.
 */
function TagPanel({
  conv,
  tags,
  vocabulary,
  busy,
  act,
}: {
  conv: Conversation;
  tags: ConversationTag[];
  vocabulary: DeskTag[];
  busy: boolean;
  act: (fn: () => Promise<unknown>) => Promise<void>;
}) {
  const [draft, setDraft] = useState('');
  const frozen = busy || conv.state === 'closed';

  /**
   * Commit the draft. Trimmed, because ` billing` and `billing` are one tag to a
   * person and two rows to a composite key; empty is a no-op rather than a refusal,
   * since Enter on an empty box means nothing rather than meaning an error.
   */
  const add = () => {
    const tag = draft.trim();
    if (!tag) return;
    setDraft('');
    void act(() => api.tagConversation({ conversationId: conv.id, tag }));
  };

  return (
    <div>
      <div className="micro" style={{ marginBottom: 8 }}>
        Tags
      </div>
      {tags.length === 0 ? (
        <div className="t-small" style={{ marginBottom: 8 }}>
          None yet
        </div>
      ) : (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, marginBottom: 8 }}>
          {tags.map((t) => (
            <span
              key={t.tag}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 5,
                border: '1px solid var(--frame)',
                borderRadius: 999,
                padding: '2px 4px 2px 9px',
                font: "400 11px 'Geist Mono', monospace",
                color: 'var(--secondary)',
              }}
            >
              {t.tag}
              <button
                type="button"
                aria-label={`Remove tag ${t.tag}`}
                title={`Remove tag ${t.tag}`}
                disabled={frozen}
                onClick={() =>
                  void act(() => api.untagConversation({ conversationId: conv.id, tag: t.tag }))
                }
                style={{
                  border: 'none',
                  background: 'none',
                  padding: '0 3px',
                  font: "400 12px 'Geist', sans-serif",
                  color: 'var(--muted)',
                  cursor: frozen ? 'default' : 'pointer',
                }}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}
      <datalist id="ticket0-tag-vocabulary">
        {vocabulary.map((v) => (
          <option key={v.tag} value={v.tag}>
            {`${v.count}`}
          </option>
        ))}
      </datalist>
      <input
        list="ticket0-tag-vocabulary"
        value={draft}
        disabled={frozen}
        placeholder="Add a tag, then Enter…"
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key !== 'Enter') return;
          e.preventDefault();
          add();
        }}
        style={{
          width: '100%',
          border: '1px solid var(--frame)',
          borderRadius: 6,
          background: 'var(--surface)',
          font: "400 12px 'Geist Mono', monospace",
          color: 'inherit',
          padding: '3px 6px',
        }}
      />
    </div>
  );
}

/* ── The rating ─────────────────────────────────────────────────────────── */

/**
 * What the customer said about this conversation, to the person who handled it.
 *
 * The comment is erasable and so may be missing from a row that still has a score —
 * an erasure leaves the rating and takes the words, and this renders exactly that.
 */
function CsatCard({ csat }: { csat: NonNullable<Csat> }) {
  return (
    <div
      style={{
        background: '#fafaf8',
        border: '1px solid var(--hairline)',
        borderRadius: 8,
        padding: 12,
      }}
    >
      <div className="micro" style={{ marginBottom: 8 }}>
        Rating
      </div>
      <div style={{ font: "600 16px 'Geist Mono', monospace", letterSpacing: '-.01em' }}>
        {csat.score}
        <span className="t-small" style={{ marginLeft: 4 }}>
          / 5
        </span>
      </div>
      {csat.comment ? (
        <div
          className="t-small"
          style={{ marginTop: 8, whiteSpace: 'pre-wrap', color: 'var(--secondary)' }}
        >
          “{csat.comment}”
        </div>
      ) : null}
    </div>
  );
}

/* ── The visitor card ───────────────────────────────────────────────────── */

const DEVICE_LABEL: Record<string, string> = {
  desktop: 'desktop',
  mobile: 'phone',
  tablet: 'tablet',
  bot: 'bot',
  unknown: '',
};

/** `Sweden` for `SE`, in the agent's own language; the code itself if the browser cannot. */
function countryName(code: string): string {
  try {
    return new Intl.DisplayNames(undefined, { type: 'region' }).of(code) ?? code;
  } catch {
    return code;
  }
}

/** The visitor's wall clock right now — the fact behind "it is 3 am for them". */
function localTime(timezone: string): string | null {
  try {
    return new Intl.DateTimeFormat(undefined, { timeZone: timezone, hour: '2-digit', minute: '2-digit' }).format(
      new Date(),
    );
  } catch {
    return null;
  }
}

/**
 * What the visitor is holding and roughly where — the client context the host
 * attached when the session opened, stored on the session and read back here.
 *
 * Every line is conditional, because every column is nullable: a session opened on
 * the dev server has no geo, one opened before the columns existed has nothing at
 * all, and the card says only what it knows rather than showing "unknown" four times.
 */
function VisitorCard({ session }: { session: NonNullable<WidgetSession> }) {
  const major = (v: string | null) => (v ? v.split('.')[0] : null);
  const browser = session.browser
    ? [session.browser, major(session.browser_version)].filter(Boolean).join(' ')
    : null;
  const os = session.os ? [session.os, major(session.os_version)].filter(Boolean).join(' ') : null;
  const device = [browser, os].filter(Boolean).join(' on ') || null;
  const kind = session.device ? DEVICE_LABEL[session.device] ?? '' : '';
  const place = [session.city, session.country ? countryName(session.country) : null].filter(Boolean).join(', ') || null;
  const time = session.timezone ? localTime(session.timezone) : null;

  const rows: [string, React.ReactNode][] = [];
  if (device) rows.push(['Device', kind ? `${device} · ${kind}` : device]);
  if (place) rows.push(['Location', place]);
  if (time) rows.push(['Local time', <span title={session.timezone ?? undefined}>{time}</span>]);
  if (session.language) rows.push(['Language', <span className="mono">{session.language}</span>]);
  rows.push(['Page', <span className="mono" title={session.origin}>{session.origin.replace(/^https?:\/\//, '')}</span>]);

  return (
    <div>
      <div className="micro" style={{ marginBottom: 8 }}>
        Visitor
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '6px 10px', alignItems: 'baseline' }}>
        {rows.map(([k, v]) => (
          <Fragment key={k}>
            <div className="micro" style={{ color: 'var(--muted)' }}>
              {k}
            </div>
            <div
              style={{
                font: "400 12px 'Geist', sans-serif",
                color: 'var(--secondary)',
                minWidth: 0,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {v}
            </div>
          </Fragment>
        ))}
      </div>
    </div>
  );
}
