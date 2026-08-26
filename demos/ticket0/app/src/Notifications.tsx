/**
 * The notifications tray.
 *
 * The desk has been writing these all along — assign, reply, escalate — and nothing
 * read them. A row nobody can see is a row that may as well not be written, so this is
 * less a feature than the other half of one that already existed.
 *
 * Scoped by the API, not by the view: `my-notifications` filters on the caller's own
 * principal server-side, so there is nothing here that could accidentally show somebody
 * else's.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { View } from './App.js';
import { api, type Notification } from './api.js';
import { ago } from './ui.js';

const WORDING: Record<Notification['kind'], string> = {
  assigned: 'assigned to you',
  replied: 'the customer replied',
  mentioned: 'a note mentions you',
  'snooze-woke': 'came back from snooze',
  escalated: 'the assistant escalated',
};

export function Notifications({ go }: { go: (v: View) => void }) {
  const [items, setItems] = useState<Notification[]>([]);
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  const load = useCallback(() => {
    void api
      .myNotifications()
      .then((p) => setItems(p.entries))
      .catch(() => setItems([]));
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 15000);
    return () => clearInterval(t);
  }, [load]);

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    addEventListener('mousedown', away);
    return () => removeEventListener('mousedown', away);
  }, [open]);

  const unread = items.filter((n) => !n.read_at);

  return (
    <div ref={box} style={{ position: 'relative' }}>
      <button
        className="btn btn-ghost"
        onClick={() => setOpen((v) => !v)}
        title="Notifications"
        style={{ position: 'relative', padding: '6px 9px' }}
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
          <path d="M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 0 1-3.4 0" />
        </svg>
        {unread.length > 0 ? (
          <span
            style={{
              position: 'absolute',
              top: 1,
              right: 1,
              minWidth: 15,
              height: 15,
              borderRadius: 8,
              background: 'var(--action)',
              color: '#fff',
              font: "600 9px/15px 'Geist', sans-serif",
              textAlign: 'center',
              padding: '0 4px',
            }}
          >
            {unread.length}
          </span>
        ) : null}
      </button>

      {open ? (
        <div
          style={{
            position: 'absolute',
            right: 0,
            top: 'calc(100% + 8px)',
            width: 320,
            background: 'var(--surface)',
            border: '1px solid var(--frame)',
            borderRadius: 8,
            boxShadow: 'var(--shadow-popover)',
            overflow: 'hidden',
            zIndex: 20,
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '10px 12px',
              borderBottom: '1px solid var(--hairline)',
            }}
          >
            <span className="micro">Notifications</span>
            {unread.length > 0 ? (
              <button
                className="btn btn-ghost"
                style={{ padding: '2px 6px', fontSize: 11 }}
                onClick={() => {
                  void Promise.all(
                    unread.map((n) => api.markNotificationRead({ notificationId: n.id })),
                  ).then(load);
                }}
              >
                Mark all read
              </button>
            ) : null}
          </div>

          <div style={{ maxHeight: 320, overflowY: 'auto' }} className="scroll">
            {items.length === 0 ? (
              <div className="t-small" style={{ padding: 16, textAlign: 'center' }}>
                Nothing waiting for you.
              </div>
            ) : (
              items.map((n) => (
                <button
                  key={n.id}
                  onClick={() => {
                    void api.markNotificationRead({ notificationId: n.id }).then(load);
                    if (n.conversation_id) {
                      setOpen(false);
                      go({ name: 'conversation', id: n.conversation_id });
                    }
                  }}
                  style={{
                    display: 'block',
                    width: '100%',
                    textAlign: 'left',
                    border: 0,
                    borderTop: '1px solid var(--row-line)',
                    background: n.read_at ? 'var(--surface)' : '#fdf8f1',
                    padding: '10px 12px',
                    cursor: n.conversation_id ? 'pointer' : 'default',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                    <span style={{ font: "500 12px 'Geist', sans-serif" }}>{WORDING[n.kind]}</span>
                    <span className="t-small" style={{ marginLeft: 'auto' }}>
                      {ago(n.created_at)}
                    </span>
                  </div>
                  {n.conversation_id ? (
                    <div className="t-small mono" style={{ marginTop: 2 }}>
                      {n.conversation_id.slice(-8)}
                    </div>
                  ) : null}
                </button>
              ))
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
