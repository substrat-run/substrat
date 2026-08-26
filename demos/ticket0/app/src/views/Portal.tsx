/**
 * Artboards 13–14 — the customer portal.
 *
 * 680px, chat-bubble layout, **public messages only**. There is no internal-note
 * rendering path in this file at all, and that is deliberate: the surface that must
 * never show one is the surface that should not know how.
 */
import { useCallback, useEffect, useState } from 'react';
import type { View } from '../App.js';
import { Brand } from '../App.js';
import { api, type Conversation, type Session } from '../api.js';
import { Avatar, Empty, EventDivider, StateBadge, ago, clock } from '../ui.js';

/** What the portal reads — the customer-facing shape, with no author principal. */
interface PublicMessage {
  id: string;
  author_kind: 'contact' | 'agent' | 'assistant' | 'system';
  visibility: 'public' | 'internal';
  body_text: string;
  created_at: string;
  delivered_at: string | null;
}

export function Portal({
  view,
  go,
  session,
}: {
  view: View;
  go: (v: View) => void;
  session: Session;
}) {
  return (
    <div style={{ width: 680, maxWidth: '100%' }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          marginBottom: 16,
          padding: '0 2px',
        }}
      >
        <Brand size={24} label="Substrat support" />
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 9 }}>
          <span className="t-small">{session.display}</span>
          <Avatar name={session.display} size={24} />
        </div>
      </div>
      {view.name === 'portal-conversation' ? (
        <One id={view.id} go={go} />
      ) : (
        <List go={go} />
      )}
    </div>
  );
}

function List({ go }: { go: (v: View) => void }) {
  const [items, setItems] = useState<Conversation[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void api
      .myConversations()
      .then((p) => setItems(p.entries))
      .catch((e: Error) => setError(e.message));
  }, []);

  return (
    <div className="frame" style={{ background: 'var(--surface)' }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'baseline',
          justifyContent: 'space-between',
          padding: '14px 18px',
          borderBottom: '1px solid var(--hairline)',
        }}
      >
        <div className="t-title">Your conversations</div>
        <span className="t-small">Public replies only</span>
      </div>
      {error ? (
        <Empty title="Could not load your conversations" note={error} />
      ) : !items ? (
        <Empty title="Loading…" />
      ) : items.length === 0 ? (
        <Empty title="Nothing here yet" note="Ask us something from the chat bubble on the site." />
      ) : (
        items.map((c) => (
          <div
            key={c.id}
            onClick={() => go({ name: 'portal-conversation', id: c.id })}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 12,
              padding: '13px 18px',
              borderTop: '1px solid var(--row-line)',
              cursor: 'pointer',
              background: c.first_public_reply_at ? 'var(--surface)' : '#fbf8f4',
            }}
          >
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{ font: "500 13px 'Geist', sans-serif" }}>{c.subject}</div>
              <div className="t-small">
                {c.channel === 'widget' ? 'Started in the chat widget' : 'By email'}
              </div>
            </div>
            <StateBadge state={c.state} />
            <span className="t-small" style={{ width: 40, textAlign: 'right' }}>
              {ago(c.updated_at)}
            </span>
          </div>
        ))
      )}
    </div>
  );
}

function One({ id, go }: { id: string; go: (v: View) => void }) {
  const [conv, setConv] = useState<Conversation | null>(null);
  const [messages, setMessages] = useState<PublicMessage[]>([]);
  const [score, setScore] = useState<number | null>(null);
  const [comment, setComment] = useState('');
  const [rated, setRated] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /**
   * Kept apart from `error`, which the early return uses.
   *
   * A failed CSAT submission is a problem with the rating, not with the conversation
   * — writing it to the conversation-level error unmounted the whole thread and left
   * the customer looking at an error page instead of the exchange they were rating.
   */
  const [ratingError, setRatingError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [c, m] = await Promise.all([
        api.getConversation({ conversationId: id }).catch(() => null),
        api.myMessages({ conversationId: id }),
      ]);
      if (c) setConv(c);
      setMessages(m.entries as PublicMessage[]);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  if (error) return <Empty title="Could not open this conversation" note={error} />;

  return (
    <div className="frame" style={{ background: 'var(--surface)' }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '13px 18px',
          borderBottom: '1px solid var(--hairline)',
        }}
      >
        <button className="btn btn-ghost" onClick={() => go({ name: 'portal' })}>
          ←
        </button>
        <div className="t-title" style={{ flex: 1, minWidth: 0 }}>
          {conv?.subject ?? 'Conversation'}
        </div>
        {conv ? <StateBadge state={conv.state} /> : null}
      </div>

      <div
        style={{
          padding: 18,
          display: 'flex',
          flexDirection: 'column',
          gap: 12,
          background: 'var(--app-bg)',
        }}
      >
        {messages.map((m) => {
          const mine = m.author_kind === 'contact';
          return (
            <div key={m.id} style={{ display: 'flex', justifyContent: mine ? 'flex-end' : 'flex-start' }}>
              <div style={{ maxWidth: '78%' }}>
                {!mine ? (
                  <div className="t-small" style={{ marginBottom: 4, marginLeft: 3 }}>
                    {m.author_kind === 'assistant' ? 'Assistant' : 'Support'} · {clock(m.created_at)}
                  </div>
                ) : null}
                <div
                  style={{
                    background: mine ? 'var(--customer-bubble)' : 'var(--surface)',
                    border: mine ? 'none' : '1px solid var(--hairline)',
                    borderRadius: mine ? '10px 10px 3px 10px' : '10px 10px 10px 3px',
                    padding: '10px 13px',
                    font: "400 13px/1.65 'Geist', sans-serif",
                    whiteSpace: 'pre-wrap',
                  }}
                >
                  {m.body_text}
                </div>
              </div>
            </div>
          );
        })}

        {conv && (conv.state === 'resolved' || conv.state === 'closed') ? (
          <>
            <EventDivider tone="resolved" label={conv.state} />
            <RatingCard
              rated={rated}
              error={ratingError}
              score={score}
              comment={comment}
              setScore={setScore}
              setComment={setComment}
              onSubmit={() => {
                if (score === null) return;
                setRatingError(null);
                void api
                  .submitCsat({ conversationId: id, score, comment: comment || null })
                  .then(() => setRated(true))
                  .catch((e: Error) => setRatingError(e.message));
              }}
            />
          </>
        ) : null}
      </div>

      <div
        style={{
          padding: '11px 18px',
          borderTop: '1px solid var(--hairline)',
          background: 'var(--surface)',
        }}
      >
        <span className="t-small">Replying reopens this conversation.</span>
      </div>
    </div>
  );
}

function RatingCard({
  rated,
  error,
  score,
  comment,
  setScore,
  setComment,
  onSubmit,
}: {
  rated: boolean;
  error: string | null;
  score: number | null;
  comment: string;
  setScore: (n: number) => void;
  setComment: (s: string) => void;
  onSubmit: () => void;
}) {
  if (rated)
    return (
      <div className="card" style={{ padding: 14, textAlign: 'center' }}>
        <div className="t-strong">Thanks — noted.</div>
      </div>
    );
  return (
    <div className="card" style={{ padding: 14 }}>
      <div className="t-strong" style={{ marginBottom: 10 }}>
        How did we do?
      </div>
      <div style={{ display: 'flex', gap: 7, marginBottom: 11 }}>
        {[1, 2, 3, 4, 5].map((n) => {
          const on = score === n;
          return (
            <button
              key={n}
              onClick={() => setScore(n)}
              style={{
                width: 34,
                height: 34,
                borderRadius: 6,
                cursor: 'pointer',
                border: `1px solid ${on ? 'var(--action)' : 'var(--frame)'}`,
                background: on ? 'var(--tint)' : 'var(--surface)',
                color: on ? '#a8500f' : 'var(--secondary)',
                font: "600 13px 'Geist Mono', monospace",
              }}
            >
              {n}
            </button>
          );
        })}
      </div>
      <textarea
        className="textarea"
        rows={2}
        placeholder="Anything you'd like to add? (optional)"
        value={comment}
        onChange={(e) => setComment(e.target.value)}
        style={{ marginBottom: 10 }}
      />
      <button className="btn btn-primary" disabled={score === null} onClick={onSubmit}>
        Send rating
      </button>
      {error ? (
        <div className="t-small" style={{ marginTop: 8, color: 'var(--danger-2)' }}>
          {error}
        </div>
      ) : null}
    </div>
  );
}
