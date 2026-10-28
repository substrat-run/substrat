import type { ReactNode } from 'react';
import { NOTIFICATIONS } from '../lib/demo';
import { DEV_MOCK } from '../lib/mock';

const DOT: Record<string, string> = {
  success: 'var(--status-success-dot)',
  warning: 'var(--status-warning-dot)',
  neutral: 'var(--status-neutral-dot)',
};

/** Render a tiny **bold** / `mono` markup subset used in notification bodies. */
function richText(s: string): ReactNode[] {
  return s.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).map((part, i) => {
    if (part.startsWith('**')) return <strong key={i}>{part.slice(2, -2)}</strong>;
    if (part.startsWith('`')) return <span key={i} style={{ fontFamily: 'var(--font-mono)', fontSize: 11 }}>{part.slice(1, -1)}</span>;
    return <span key={i}>{part}</span>;
  });
}

/** The bell popover (screen 1x): 360px, under the bell, unread rows tinted. */
export function NotificationsPopover({ onClose, onMarkRead }: { onClose: () => void; onMarkRead: () => void }) {
  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 150 }}>
      <div
        onClick={(e) => e.stopPropagation()}
        style={{ position: 'absolute', top: 60, right: 16, width: 360, background: 'var(--surface-card)', border: '1px solid var(--border-default)', borderRadius: 12, boxShadow: 'var(--shadow-popover)', overflow: 'hidden' }}
      >
        <div style={{ display: 'flex', alignItems: 'center', height: 44, padding: '0 16px', borderBottom: '1px solid var(--border-subtle)' }}>
          <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>Notifications</span>
          <div style={{ flex: 1 }} />
          {DEV_MOCK && <button type="button" onClick={onMarkRead} style={{ border: 0, background: 'transparent', fontSize: 12, color: 'var(--text-brand)', cursor: 'pointer' }}>Mark all read</button>}
        </div>
        {!DEV_MOCK && <div style={{ padding: 16, fontSize: 12.5, color: 'var(--text-secondary)' }}>Notifications are not available yet.</div>}
        {DEV_MOCK && NOTIFICATIONS.map((n, i) => (
          <div
            key={i}
            style={{ display: 'flex', gap: 10, padding: '12px 16px', borderBottom: '1px solid var(--border-subtle)', background: n.unread ? 'var(--surface-brand-subtle)' : 'transparent' }}
          >
            <span style={{ width: 7, height: 7, borderRadius: '50%', background: DOT[n.dot], marginTop: 5, flexShrink: 0 }} />
            <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
              <span style={{ fontSize: 12.5, color: 'var(--text-primary)' }}>{richText(n.body)}</span>
              <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>{n.time}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
