import type { CSSProperties, ReactNode } from 'react';

export interface CardProps {
  title?: string;
  description?: string;
  /** Header-right action nodes (buttons). */
  actions?: ReactNode;
  /** Inset footer strip (meta text, links). */
  footer?: ReactNode;
  /** Body padding in px. Default 16. Use 0 for tables. */
  padding?: number | string;
  children?: ReactNode;
  style?: CSSProperties;
}

export function Card({
  title,
  description,
  actions,
  footer,
  padding = 16,
  children,
  style,
}: CardProps) {
  return (
    <div
      style={{
        background: 'var(--surface-card)',
        border: '1px solid var(--border-default)',
        borderRadius: 'var(--radius-md)',
        boxShadow: 'var(--shadow-xs)',
        fontFamily: 'var(--font-sans)',
        overflow: 'hidden',
        ...style,
      }}
    >
      {(title || actions) && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            // Wrap rather than overflow: the actions here are the card's primary buttons,
            // and the card clips (`overflow: hidden`, for the rounded corners), so a row
            // too wide for a narrow viewport did not just look cramped — the trailing
            // buttons were cut off with nothing able to scroll to them. Once there is no
            // room beside the title, the whole action group drops to its own line.
            flexWrap: 'wrap',
            gap: 12,
            padding: '12px 16px',
            borderBottom: '1px solid var(--border-subtle)',
          }}
        >
          <div style={{ minWidth: 0, flex: '1 1 auto' }}>
            <div
              style={{
                fontSize: 'var(--text-md)',
                fontWeight: 'var(--weight-semibold)',
                color: 'var(--text-primary)',
                letterSpacing: 'var(--tracking-tight)',
              }}
            >
              {title}
            </div>
            {description && (
              <div
                style={{
                  fontSize: 'var(--text-sm)',
                  color: 'var(--text-tertiary)',
                  marginTop: 2,
                }}
              >
                {description}
              </div>
            )}
          </div>
          {/* No `flexShrink: 0` here: the row above wraps, so the group already gets its own
              line before it has to give up width — and pinning the width instead made a
              group wider than the card overflow the clip, which is what put a button
              off-screen with no way to reach it. Shrinking lets a grouped set of buttons
              wrap within itself. */}
          {actions && <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, minWidth: 0, maxWidth: '100%' }}>{actions}</div>}
        </div>
      )}
      <div style={{ padding }}>{children}</div>
      {footer && (
        <div
          style={{
            padding: '10px 16px',
            borderTop: '1px solid var(--border-subtle)',
            background: 'var(--surface-inset)',
            fontSize: 'var(--text-sm)',
            color: 'var(--text-tertiary)',
          }}
        >
          {footer}
        </div>
      )}
    </div>
  );
}
