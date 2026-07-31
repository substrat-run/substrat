import type { CSSProperties, ReactNode } from 'react';
import type { EntryStatus } from './api';

// Manyfold UI primitives — token-driven inline styles, no external CSS beyond tokens.css.
// Kept local (the demo-app convention) rather than depending on @substrat-run/ui.

export function Button(props: {
  children: ReactNode;
  onClick?: () => void;
  variant?: 'primary' | 'ghost';
  disabled?: boolean;
  title?: string;
  size?: 'sm' | 'md';
  tone?: 'default' | 'onDark';
}) {
  const { variant = 'ghost', disabled, size = 'md', tone = 'default' } = props;
  const pad = size === 'sm' ? '5px 10px' : '8px 15px';
  const base: CSSProperties = {
    font: 'inherit',
    fontSize: size === 'sm' ? 12.5 : 13,
    fontWeight: 600,
    padding: pad,
    borderRadius: 'var(--r-btn)',
    cursor: disabled ? 'not-allowed' : 'pointer',
    border: '1px solid transparent',
    transition: 'background 160ms ease, border-color 160ms ease',
  };
  // On the inverted (product-level) bar, ghost buttons read against --ink using --bg ink.
  const ghost: CSSProperties = tone === 'onDark'
    ? { ...base, background: 'transparent', color: 'var(--bg)', borderColor: 'var(--faint)' }
    : { ...base, background: 'transparent', color: 'var(--ink)', borderColor: 'var(--border2)' };
  const style: CSSProperties = disabled
    ? { ...base, background: 'var(--wash)', color: 'var(--faint)', borderColor: 'transparent' }
    : variant === 'primary'
      ? { ...base, background: 'var(--accent)', color: 'var(--on-accent)' }
      : ghost;
  return (
    <button style={style} onClick={disabled ? undefined : props.onClick} disabled={disabled} title={props.title}>
      {props.children}
    </button>
  );
}

const STATUS_LABEL: Record<EntryStatus, string> = {
  draft: 'draft',
  in_review: 'in review',
  approved: 'approved',
  published: 'published',
  unpublished: 'unpublished',
  archived: 'archived',
};
const STATUS_VAR: Record<EntryStatus, string> = {
  draft: 'draft',
  in_review: 'review',
  approved: 'approved',
  published: 'published',
  unpublished: 'archived',
  archived: 'archived',
};

export function StatusBadge({ status }: { status: EntryStatus }) {
  const v = STATUS_VAR[status];
  return (
    <span
      style={{
        fontSize: 11.5,
        fontWeight: 600,
        padding: '2px 9px',
        borderRadius: 'var(--r-pill)',
        color: `var(--st-${v}-fg)`,
        background: `var(--st-${v}-bg)`,
        whiteSpace: 'nowrap',
      }}
    >
      {STATUS_LABEL[status]}
    </span>
  );
}

export function Pill({ children, active, onClick }: { children: ReactNode; active?: boolean; onClick?: () => void }) {
  return (
    <button
      onClick={onClick}
      style={{
        font: 'inherit',
        fontSize: 12.5,
        fontWeight: 500,
        padding: '4px 12px',
        borderRadius: 'var(--r-pill)',
        cursor: 'pointer',
        border: '1px solid var(--border)',
        background: active ? 'var(--accent-soft)' : 'transparent',
        color: active ? 'var(--accent)' : 'var(--muted)',
      }}
    >
      {children}
    </button>
  );
}

export function Card({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return (
    <div
      style={{
        background: 'var(--surface)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--r-card)',
        padding: 16,
        ...style,
      }}
    >
      {children}
    </div>
  );
}

export function Mono({ children, style, title }: { children: ReactNode; style?: CSSProperties; title?: string }) {
  return <span title={title} style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--muted)', ...style }}>{children}</span>;
}

export function ColHead({ children }: { children: ReactNode }) {
  return (
    <th
      style={{
        fontSize: 11,
        fontWeight: 600,
        letterSpacing: '0.06em',
        textTransform: 'uppercase',
        color: 'var(--faint)',
        textAlign: 'left',
        padding: '8px 12px',
        borderBottom: '1px solid var(--border)',
      }}
    >
      {children}
    </th>
  );
}

export function Empty({ title, hint }: { title: string; hint?: string }) {
  return (
    <div style={{ textAlign: 'center', padding: '48px 16px', color: 'var(--muted)' }}>
      <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--ink)', marginBottom: 6 }}>{title}</div>
      {hint && <div style={{ fontSize: 13 }}>{hint}</div>}
    </div>
  );
}

// ── Small helpers shared across screens ──────────────────────────────────────

/** Relative time, matching the mock's "4h ago · 2d ago · Mar 2" vocabulary. */
export function relativeTime(iso: string | number): string {
  const t = typeof iso === 'number' ? iso : Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 45) return 'just now';
  const m = s / 60;
  if (m < 60) return `${Math.round(m)}m ago`;
  const h = m / 60;
  if (h < 24) return `${Math.round(h)}h ago`;
  const d = h / 24;
  if (d < 7) return `${Math.round(d)}d ago`;
  return new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/** Initials avatar — accent-soft disc, mono-ish caps. */
export function Avatar({ name, size = 26 }: { name: string; size?: number }) {
  return (
    <span
      title={name}
      style={{
        width: size,
        height: size,
        flex: `0 0 ${size}px`,
        borderRadius: 'var(--r-pill)',
        background: 'var(--accent-soft)',
        color: 'var(--accent)',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: size * 0.42,
        fontWeight: 600,
        letterSpacing: '0.02em',
        userSelect: 'none',
      }}
    >
      {initials(name)}
    </span>
  );
}

const DIST_ORDER: { key: EntryStatus; v: string }[] = [
  { key: 'published', v: 'published' },
  { key: 'approved', v: 'approved' },
  { key: 'in_review', v: 'review' },
  { key: 'draft', v: 'draft' },
  { key: 'unpublished', v: 'archived' },
  { key: 'archived', v: 'archived' },
];

/** The mini status-distribution bar under a type's count on the overview cards. */
export function DistBar({ counts, height = 6 }: { counts: Partial<Record<EntryStatus, number>>; height?: number }) {
  const total = DIST_ORDER.reduce((n, s) => n + (counts[s.key] ?? 0), 0);
  return (
    <div style={{ display: 'flex', height, borderRadius: 'var(--r-pill)', overflow: 'hidden', background: 'var(--wash)', gap: total ? 1.5 : 0 }}>
      {total > 0 &&
        DIST_ORDER.filter((s) => (counts[s.key] ?? 0) > 0).map((s) => (
          <span key={s.key} title={`${s.key}: ${counts[s.key]}`} style={{ flex: counts[s.key], background: `var(--st-${s.v}-fg)` }} />
        ))}
    </div>
  );
}

/** The green "PUBLISHER in this site" chip (uses the published status pair). */
export function RolePill({ children }: { children: ReactNode }) {
  return (
    <span
      style={{
        fontSize: 11,
        fontWeight: 600,
        letterSpacing: '0.04em',
        textTransform: 'uppercase',
        padding: '3px 10px',
        borderRadius: 'var(--r-pill)',
        color: 'var(--st-published-fg)',
        background: 'var(--st-published-bg)',
        whiteSpace: 'nowrap',
      }}
    >
      {children}
    </span>
  );
}

/** A small count pill for nav rows (amber when it wants attention, e.g. review queue). */
export function CountPill({ n, tone = 'faint' }: { n: number; tone?: 'faint' | 'review' }) {
  const attn = tone === 'review' && n > 0;
  return (
    <span
      style={{
        fontSize: 11,
        fontWeight: 600,
        minWidth: 18,
        textAlign: 'center',
        padding: '1px 7px',
        borderRadius: 'var(--r-pill)',
        color: attn ? 'var(--st-review-fg)' : 'var(--faint)',
        background: attn ? 'var(--st-review-bg)' : 'transparent',
      }}
    >
      {n}
    </span>
  );
}
