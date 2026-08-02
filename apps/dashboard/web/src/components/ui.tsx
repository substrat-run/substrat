import { useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { Ic } from '../lib/icons';

/** The card surface every screen composes with. */
export const card: CSSProperties = {
  background: 'var(--surface-card)',
  border: '1px solid var(--border-default)',
  borderRadius: 12,
  boxSizing: 'border-box',
};

export type PillKind = 'success' | 'warning' | 'danger' | 'info' | 'neutral';

const PILL: Record<PillKind, { bg: string; fg: string; dot: string }> = {
  success: { bg: 'var(--status-success-bg)', fg: 'var(--status-success-fg)', dot: 'var(--status-success-dot)' },
  warning: { bg: 'var(--status-warning-bg)', fg: 'var(--status-warning-fg)', dot: 'var(--status-warning-dot)' },
  danger: { bg: 'var(--status-danger-bg)', fg: 'var(--status-danger-fg)', dot: 'var(--status-danger-dot)' },
  info: { bg: 'var(--status-info-bg)', fg: 'var(--status-info-fg)', dot: 'var(--status-info-dot)' },
  neutral: { bg: 'var(--status-neutral-bg)', fg: 'var(--status-neutral-fg)', dot: 'var(--status-neutral-dot)' },
};

/** A status pill with a leading dot (optionally pulsing, for in-flight states). */
export function Pill({ kind, children, pulse, style }: { kind: PillKind; children: ReactNode; pulse?: boolean; style?: CSSProperties }) {
  const c = PILL[kind];
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding: '2px 8px',
        borderRadius: 999,
        background: c.bg,
        color: c.fg,
        fontSize: 12,
        fontWeight: 500,
        whiteSpace: 'nowrap',
        flexShrink: 0,
        ...style,
      }}
    >
      <span
        style={{
          width: 6,
          height: 6,
          borderRadius: '50%',
          background: c.dot,
          animation: pulse ? 'sub-pulse 1.6s ease-in-out infinite' : undefined,
        }}
      />
      {children}
    </span>
  );
}

/** The uppercase, letter-spaced section label used for eyebrows and table captions. */
export function Eyebrow({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return (
    <div
      style={{
        fontSize: 11,
        fontWeight: 500,
        letterSpacing: '0.06em',
        textTransform: 'uppercase',
        color: 'var(--text-tertiary)',
        ...style,
      }}
    >
      {children}
    </div>
  );
}

/** A page title + optional subtitle. */
export function PageTitle({ title, subtitle }: { title: string; subtitle?: ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <div style={{ fontSize: 22, fontWeight: 600, letterSpacing: '-0.02em', color: 'var(--text-primary)' }}>{title}</div>
      {subtitle && <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>{subtitle}</div>}
    </div>
  );
}

/** A small mono chip, e.g. a role tag or `main` branch tag. */
export function MonoTag({ children, color }: { children: ReactNode; color?: string }) {
  return (
    <span
      style={{
        fontFamily: 'var(--font-mono)',
        fontSize: 11,
        border: '1px solid var(--border-default)',
        borderRadius: 4,
        padding: '1px 6px',
        color: color ?? 'var(--text-secondary)',
      }}
    >
      {children}
    </span>
  );
}

/** An inset honesty banner — the "nothing here is faked" strip on future screens. */
export function HonestyBanner({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        background: 'var(--surface-inset)',
        border: '1px solid var(--border-subtle)',
        borderRadius: 6,
        padding: '8px 12px',
        fontSize: 12.5,
        lineHeight: 1.5,
        color: 'var(--text-secondary)',
      }}
    >
      {children}
    </div>
  );
}

/** An icon button that copies text and flips to a check for a moment. */
export function CopyButton({ text, size = 13, label = 'Copy' }: { text: string; size?: number; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={() => {
        void navigator.clipboard?.writeText(text);
        setDone(true);
        setTimeout(() => setDone(false), 1200);
      }}
      style={{
        display: 'inline-flex',
        border: 0,
        background: 'none',
        padding: 0,
        cursor: 'pointer',
        color: done ? 'var(--status-success-fg)' : 'var(--text-tertiary)',
      }}
    >
      <Ic name={done ? 'check' : 'copy'} size={size} />
    </button>
  );
}

/** The row-end ⋯ affordance (visual only — a menu is a later concern). */
export function RowActions() {
  return (
    <button
      type="button"
      aria-label="Row actions"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 24,
        height: 24,
        border: 0,
        borderRadius: 6,
        background: 'none',
        color: 'var(--text-tertiary)',
        cursor: 'pointer',
      }}
    >
      <Ic name="dots" size={16} />
    </button>
  );
}
